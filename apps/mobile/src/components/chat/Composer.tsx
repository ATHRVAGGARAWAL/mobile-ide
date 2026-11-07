import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
  type TextStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ContentBlock, SessionStatus, SlashCommand } from '@mobile-ide/core';
import { T, Tap } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';
import { basename } from '../../lib/format';
import { haptic } from '../../lib/haptics';
import type { SendState } from '../../state/sessions';
import { toast } from '../../state/toast';
import { MAX_IMAGES, pickPhotos, type PendingImage, type PhotoSource } from './attachments';
import { PhotoSources } from './PhotoSources';
import { absoluteInRoot, toFileUri } from './files';
import { ImageAttachments } from './ImageAttachments';
import { MentionSuggestions, useFileMentions, type MentionCandidate } from './MentionSuggestions';
import { filterCommands, SlashSuggestions } from './SlashSuggestions';

export interface ComposerProps {
  sessionId: string;
  cwd: string;
  status: SessionStatus;
  agentName: string;
  commands: SlashCommand[];
  imagesSupported: boolean;
  /** prompts for this session waiting in the offline outbox */
  queuedCount: number;
  /** last failed send for this session, if any */
  promptError?: string | null;
  onSend: (blocks: ContentBlock[]) => Promise<SendState>;
  onStop: () => Promise<void>;
  onDismissError: () => void;
  /** padding under the input row (home indicator when the keyboard is hidden) */
  bottomInset: number;
}

export interface ComposerHandle {
  /** Append an editable workflow without discarding an existing draft or sending it. */
  insertDraft: (text: string) => void;
}

interface Draft {
  text: string;
  images: PendingImage[];
  mentions: Record<string, string>;
}

/** Unsent drafts survive navigating away and back (module scope; not persisted to disk). */
const drafts = new Map<string, Draft>();

const LINE_HEIGHT = 20;
const MAX_LINES = 6;
/** react-native-web draws the browser's default focus ring on the textarea; the surrounding box shows focus instead. */
const webNoOutline: TextStyle | null = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null;
const PAD_V = Platform.OS === 'ios' ? 10 : 8;
const MIN_HEIGHT = 40;
/** The field grows to six lines of text (plus its vertical padding); beyond that it scrolls. */
export const COMPOSER_MAX_HEIGHT = LINE_HEIGHT * MAX_LINES + PAD_V * 2;
const SLASH_RE = /^\/([^\s/]*)$/;
const MENTION_RE = /(?:^|\s)@([^\s@]*)$/;

function clampHeight(contentHeight: number): number {
  return Math.min(COMPOSER_MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(contentHeight)));
}

function hasFinePointer(): boolean {
  try {
    const g = globalThis as unknown as { matchMedia?: (q: string) => { matches: boolean } };
    return !!g.matchMedia?.('(pointer: fine)').matches;
  } catch {
    return false;
  }
}

/** The DOM node react-native-web renders for a multiline TextInput. */
interface WebTextArea {
  scrollHeight?: number;
  style?: { height: string };
}

/**
 * Prompt input pinned above the keyboard: multiline (grows to six lines, then scrolls), `/` command
 * suggestions, `@` file mentions, image attachments, Send (queues while offline) and Stop while the
 * agent is running.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { sessionId, cwd, status, agentName, commands, imagesSupported, queuedCount, promptError, onSend, onStop, onDismissError, bottomInset },
  ref,
) {
  const t = useTheme();
  const c = t.colors;
  const inputRef = useRef<TextInput>(null);
  const initial = drafts.get(sessionId);
  const [text, setText] = useState(initial?.text ?? '');
  const [images, setImages] = useState<PendingImage[]>(initial?.images ?? []);
  const [mentions, setMentions] = useState<Record<string, string>>(initial?.mentions ?? {});
  const [selection, setSelection] = useState({ start: initial?.text.length ?? 0, end: initial?.text.length ?? 0 });
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [picking, setPicking] = useState(false);
  const [attachmentOptions, setAttachmentOptions] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      insertDraft: (draft) => {
        const next = [text.trimEnd(), draft].filter(Boolean).join('\n\n');
        setText(next);
        setSelection({ start: next.length, end: next.length });
        requestAnimationFrame(() => inputRef.current?.focus());
      },
    }),
    [text],
  );

  useEffect(() => {
    if (text || images.length || Object.keys(mentions).length) drafts.set(sessionId, { text, images, mentions });
    else drafts.delete(sessionId);
  }, [sessionId, text, images, mentions]);

  // Web: react-native-web measures `scrollHeight` against the field's current height, which can only ever grow.
  // While typing (text got longer) read `scrollHeight` as is — it already reports overflowing content, and touching
  // the textarea's height mid-keystroke makes iOS scroll the focused field into view (a visible jump). Only when text
  // was removed collapse the field for a moment (before paint) so it can shrink back.
  const prevTextLength = useRef(text.length);
  useLayoutEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = inputRef.current as unknown as WebTextArea | null;
    if (!el || typeof el.scrollHeight !== 'number' || !el.style) return;
    const shrank = text.length < prevTextLength.current;
    prevTextLength.current = text.length;
    let content = el.scrollHeight;
    if (shrank) {
      const prev = el.style.height;
      el.style.height = '0px';
      content = el.scrollHeight;
      el.style.height = prev;
    }
    const next = clampHeight(content);
    setHeight((cur) => (shrank || next > cur ? next : cur));
  }, [text]);

  const running = status === 'running';
  const turnActive = running || status === 'needs_you' || status === 'starting';
  const closed = status === 'closed';
  const caret = Math.min(selection.end, text.length);
  const before = text.slice(0, caret);
  const slashMatch = commands.length ? SLASH_RE.exec(before) : null;
  const mentionMatch = slashMatch ? null : MENTION_RE.exec(before);
  const slashQuery = slashMatch ? (slashMatch[1] ?? '') : null;
  const mentionQuery = mentionMatch ? (mentionMatch[1] ?? '') : null;
  const slashResults = useMemo(() => (slashQuery !== null ? filterCommands(commands, slashQuery) : []), [commands, slashQuery]);
  const mentionState = useFileMentions(cwd, mentionQuery);

  const hasContent = text.trim().length > 0 || images.length > 0;
  const canSend = hasContent && !sending && !picking && !closed && !turnActive;
  const [focused, setFocused] = useState(false);

  const onChangeText = (next: string) => {
    // Assume the caret follows the end when it was already there; onSelectionChange corrects the rest.
    if (selection.end >= text.length) setSelection({ start: next.length, end: next.length });
    setText(next);
  };

  const onSelectionChange = (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    setSelection(e.nativeEvent.selection);
  };

  const onContentSizeChange = (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
    setHeight(clampHeight(e.nativeEvent.contentSize.height));
  };

  const replaceRange = (start: number, end: number, insert: string) => {
    const next = text.slice(0, start) + insert + text.slice(end);
    setText(next);
    const pos = start + insert.length;
    setSelection({ start: pos, end: pos });
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const pickSlash = (cmd: SlashCommand) => {
    replaceRange(0, caret, `/${cmd.name} `);
  };

  const pickMention = (cand: MentionCandidate) => {
    if (!mentionMatch) return;
    const q = mentionMatch[1] ?? '';
    const start = caret - q.length - 1;
    if (cand.isDir) {
      replaceRange(start, caret, `@${cand.path.replace(/\/+$/, '')}/`);
      return;
    }
    replaceRange(start, caret, `@${cand.path} `);
    setMentions((m) => ({ ...m, [cand.path]: absoluteInRoot(cwd, cand.path) }));
  };

  const buildBlocks = (): ContentBlock[] => {
    const trimmed = text.trim();
    const blocks: ContentBlock[] = [];
    if (trimmed) blocks.push({ type: 'text', text: trimmed });
    for (const img of images) blocks.push({ type: 'image', mimeType: img.mimeType, data: img.data });
    for (const [rel, abs] of Object.entries(mentions)) {
      if (trimmed.includes(`@${rel}`))
        blocks.push({ type: 'resource_link', uri: toFileUri(abs), name: basename(rel), mimeType: undefined });
    }
    return blocks;
  };

  const send = async () => {
    if (!canSend) return;
    const blocks = buildBlocks();
    if (!blocks.length) return;
    const draft: Draft = { text, images, mentions };
    setText('');
    setImages([]);
    setMentions({});
    setSelection({ start: 0, end: 0 });
    setHeight(MIN_HEIGHT);
    setSending(true);
    void haptic.light();
    let result: SendState = 'error';
    try {
      result = await onSend(blocks);
    } finally {
      setSending(false);
    }
    if (result === 'error') {
      // Put the draft back so the user can edit and retry; the error row explains what happened.
      setText(draft.text);
      setImages(draft.images);
      setMentions(draft.mentions);
      setSelection({ start: draft.text.length, end: draft.text.length });
    }
  };

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await onStop();
    } finally {
      setStopping(false);
    }
  };

  const attach = async (source: PhotoSource) => {
    if (picking || sending || closed) return;
    if (!imagesSupported) {
      toast.info(`${agentName} doesn't accept images.`);
      return;
    }
    if (images.length >= MAX_IMAGES) {
      toast.info(`Up to ${MAX_IMAGES} images per message.`);
      return;
    }
    setPicking(true);
    try {
      const r = await pickPhotos(source, MAX_IMAGES - images.length);
      if (r.kind === 'ok') {
        setImages((cur) => [...cur, ...r.images].slice(0, MAX_IMAGES));
        setAttachmentOptions(false);
        if (r.failed) toast.error(`${r.failed} image${r.failed > 1 ? 's' : ''} couldn't be read.`);
      } else if (r.kind === 'error') {
        toast.error(r.message);
      }
    } finally {
      setPicking(false);
    }
  };

  const onKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (Platform.OS !== 'web') return;
    // On web RNW hands us the keydown event; Enter sends on keyboard-and-mouse setups, Shift+Enter inserts a newline.
    const ne = e.nativeEvent as TextInputKeyPressEventData & { shiftKey?: boolean; isComposing?: boolean };
    if (canSend && ne.key === 'Enter' && !ne.shiftKey && !ne.isComposing && hasFinePointer()) {
      e.preventDefault();
      void send();
    }
  };

  const placeholder = closed
    ? 'This session is closed'
    : status === 'starting'
      ? 'Starting the agent…'
      : status === 'needs_you'
        ? 'Draft your next message…' // short: the long form wrapped to two lines at 390 px and the second line was clipped
        : running
          ? 'Draft your next message…' // short: the status strip above already names the agent, and a long placeholder wrapped and clipped
          : `Message ${agentName}`;

  // One Stop control: the pill in the status strip. The send button stays a send button (disabled until there is text).
  const sendDisabled = !canSend;
  const sendLabel = closed
    ? 'Send (session closed)'
    : turnActive
      ? 'Send when the current turn ends'
      : hasContent
        ? 'Send'
        : 'Send (type a message first)';

  return (
    <View style={[styles.root, { backgroundColor: c.bg, paddingBottom: bottomInset }]}>
      <View style={styles.container}>
        {attachmentOptions ? <PhotoSources busy={picking} onPick={(source) => void attach(source)} /> : null}
        {slashQuery !== null && slashResults.length ? <SlashSuggestions commands={slashResults} onSelect={pickSlash} /> : null}
        {mentionQuery !== null ? <MentionSuggestions state={mentionState} onSelect={pickMention} /> : null}
        {promptError ? (
          <View style={[styles.hint, { backgroundColor: c.dangerSoft, borderRadius: t.radius.md }]}>
            <Ionicons name="alert-circle" size={16} color={c.danger} />
            <T variant="caption" numberOfLines={2} style={{ color: c.danger, flex: 1 }}>
              {promptError}
            </T>
            {canSend ? (
              <Tap onPress={send} accessibilityRole="button" accessibilityLabel="Retry sending" style={styles.hintAction}>
                <T variant="caption" weight="700" color="danger">
                  Retry
                </T>
              </Tap>
            ) : null}
            <Tap onPress={onDismissError} accessibilityRole="button" accessibilityLabel="Dismiss error" style={styles.iconBtn}>
              <Ionicons name="close" size={18} color={c.danger} />
            </Tap>
          </View>
        ) : queuedCount > 0 ? (
          <View style={styles.hint}>
            <Ionicons name="time-outline" size={15} color={c.textMuted} />
            <T variant="caption" color="textMuted" style={{ flex: 1 }}>
              {queuedCount === 1 ? '1 prompt' : `${queuedCount} prompts`} queued · sends when reconnected
            </T>
          </View>
        ) : turnActive ? (
          <View style={styles.hint}>
            {status === 'needs_you' ? (
              <Ionicons name="hand-left-outline" size={15} color={c.accent} />
            ) : (
              <ActivityIndicator size="small" color={c.accent} style={{ transform: [{ scale: 0.75 }] }} />
            )}
            <T variant="caption" color="textMuted" style={{ flex: 1 }} numberOfLines={1}>
              {status === 'needs_you'
                ? 'Review the request to continue'
                : status === 'starting'
                  ? `Starting ${agentName}…`
                  : `${agentName} is working`}
            </T>
            {status !== 'starting' ? (
              <Tap
                onPress={stop}
                disabled={stopping}
                accessibilityRole="button"
                accessibilityLabel="Stop the current turn"
                style={styles.stopPill}
              >
                {stopping ? (
                  <ActivityIndicator size="small" color={c.danger} />
                ) : (
                  <Ionicons name="stop-circle-outline" size={17} color={c.danger} />
                )}
                <T variant="caption" weight="600" color="danger">
                  Stop
                </T>
              </Tap>
            ) : null}
          </View>
        ) : null}
        <View
          style={[
            styles.inputBox,
            { backgroundColor: c.surface, borderColor: focused ? c.borderStrong : c.border, borderRadius: t.radius.lg },
          ]}
        >
          <ImageAttachments images={images} onRemove={(id) => setImages((cur) => cur.filter((i) => i.id !== id))} />
          <TextInput
            ref={inputRef}
            value={text}
            selection={selection}
            onChangeText={onChangeText}
            onSelectionChange={onSelectionChange}
            onKeyPress={onKeyPress}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onContentSizeChange={Platform.OS === 'web' ? undefined : onContentSizeChange}
            multiline
            scrollEnabled={height >= COMPOSER_MAX_HEIGHT}
            editable={!closed}
            placeholder={placeholder}
            placeholderTextColor={c.textFaint}
            blurOnSubmit={false}
            autoCapitalize="sentences"
            autoCorrect
            keyboardAppearance={t.dark ? 'dark' : 'light'}
            textAlignVertical="top"
            accessibilityLabel="Message"
            style={[styles.input, webNoOutline, { color: c.text, height }]}
          />
          <View style={styles.row}>
            <Tap
              onPress={() => {
                if (!imagesSupported) {
                  toast.info(`${agentName} doesn't accept images.`);
                  return;
                }
                setAttachmentOptions((open) => !open);
              }}
              disabled={picking || closed || sending}
              accessibilityRole="button"
              accessibilityLabel={imagesSupported ? 'Attach image' : 'Images not supported by this agent'}
              accessibilityState={{ expanded: attachmentOptions }}
              style={styles.iconBtn}
            >
              {picking ? (
                <ActivityIndicator size="small" color={c.textMuted} />
              ) : (
                <Ionicons name="add" size={23} color={imagesSupported && !closed ? c.textMuted : c.textFaint} />
              )}
            </Tap>
            <Tap
              onPress={() => replaceRange(caret, caret, `${caret && !/\s$/.test(before) ? ' ' : ''}@`)}
              disabled={closed}
              accessibilityRole="button"
              accessibilityLabel="Mention a file"
              style={styles.iconBtn}
            >
              <T style={{ color: c.textMuted, fontSize: 20 }}>@</T>
            </Tap>
            {commands.length && !text.trim() ? (
              <Tap
                onPress={() => replaceRange(0, caret, '/')}
                disabled={closed}
                accessibilityRole="button"
                accessibilityLabel="Browse agent commands"
                style={styles.iconBtn}
              >
                <T style={{ color: c.textMuted, fontSize: 20 }}>/</T>
              </Tap>
            ) : null}
            <View style={{ flex: 1 }} />
            {hasContent && turnActive ? (
              <T variant="caption" color="textFaint">
                Draft saved
              </T>
            ) : null}
            <Tap
              onPress={send}
              disabled={sendDisabled}
              accessibilityRole="button"
              accessibilityLabel={sendLabel}
              accessibilityState={{ disabled: sendDisabled, busy: sending }}
              style={[styles.sendBtn, { backgroundColor: canSend ? c.accent : c.surfaceAlt, borderRadius: t.radius.md }]}
            >
              {sending ? (
                <ActivityIndicator size="small" color={c.onAccent} />
              ) : (
                <Ionicons name="arrow-up" size={21} color={canSend ? c.onAccent : c.textFaint} />
              )}
            </Tap>
          </View>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { paddingTop: 8 },
  container: { width: '100%', maxWidth: 860, alignSelf: 'center', paddingHorizontal: 16, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 6, paddingBottom: 6 },
  iconBtn: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  inputBox: { borderWidth: 1, paddingTop: 6, overflow: 'hidden' },
  input: {
    paddingHorizontal: 16,
    paddingTop: PAD_V,
    paddingBottom: PAD_V,
    fontSize: 16,
    lineHeight: LINE_HEIGHT,
    maxHeight: COMPOSER_MAX_HEIGHT,
  },
  sendBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: 6 },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 4, minHeight: 36 },
  hintAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  stopPill: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, paddingHorizontal: 10, borderRadius: 12 },
});
