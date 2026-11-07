import React, { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import MarkdownView from '../../dom/MarkdownView';
import { copyText } from '../../lib/clipboard';
import { toast } from '../../state/toast';
import { agentColor } from '../../theme';
import { useTheme } from '../../theme/ThemeProvider';
import { T, Tap } from '../ui';
import { INLINE_DOM } from './domProps';
import { formatMessageTime } from './time';
import { useThrottledValue } from './useThrottledValue';

/** While streaming, hand the DOM component a new `text` at most this often (each hand-off marshals the whole message). */
export const STREAM_RENDER_MS = 120;

const COPIED_MS = 1400;

async function openLinkNative(href: string): Promise<void> {
  try {
    await WebBrowser.openBrowserAsync(href);
  } catch (err) {
    console.warn('[chat] could not open link', err);
  }
}

export interface AssistantMessageProps {
  /** timeline item id — keys the streaming throttle so a recycled cell never shows another item's text */
  id: string;
  text: string;
  streaming: boolean;
  /** when the first chunk of this message arrived */
  ts: number;
  agent: string;
  agentName: string;
  /** first assistant item of a response: show the subtle agent label above it */
  showLabel: boolean;
  /**
   * Details row (timestamp + Copy) shown. Controlled by the list: FlashList recycles cells across items
   * of the same type, so state kept inside the cell would follow the cell to an unrelated message.
   */
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
}

/**
 * Streaming-safe markdown from the agent. On web the DOM component renders inline; on native inside a
 * sized WebView. Long-press (or tap the agent label) for the timestamp and a Copy action.
 */
export const AssistantMessage = React.memo(function AssistantMessage({
  id,
  text,
  streaming,
  ts,
  agent,
  agentName,
  showLabel,
  open,
  onToggle,
}: AssistantMessageProps) {
  const t = useTheme();
  const c = t.colors;
  const shown = useThrottledValue(text, streaming ? STREAM_RENDER_MS : 0, id);
  const [copied, setCopied] = useState(false);
  const label = agentName.trim() || agent || 'Agent';
  const dot = agentColor(agent, t).fg;

  // `copied` is cell-local feedback; never let it survive a recycled cell showing another message.
  useEffect(() => setCopied(false), [id]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const toggle = useCallback(() => onToggle(id, !open), [id, open, onToggle]);
  const copy = useCallback(async () => {
    if (!text) return;
    if (await copyText(text)) {
      setCopied(true);
      toast.success('Message copied');
    } else {
      toast.error("Couldn't copy the message");
    }
  }, [text]);

  return (
    <Tap
      onLongPress={toggle}
      delayLongPress={400}
      pressedColor={null}
      accessibilityRole="text"
      accessibilityLabel={`${label} message`}
      accessibilityHint="Long press for time and copy"
      style={styles.root}
    >
      {showLabel ? (
        <Tap
          onPress={toggle}
          pressedColor={null}
          pressedStyle={{ opacity: 0.7 }}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          aria-expanded={open}
          accessibilityLabel={`${label}. ${open ? 'Hide' : 'Show'} message details`}
          style={styles.label}
        >
          <View style={[styles.dot, { backgroundColor: dot }]} />
          <T variant="bodySmall" color="textMuted" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
            {label}
          </T>
          <View style={{ flex: 1 }} />
          <Ionicons name={open ? 'chevron-up' : 'ellipsis-horizontal'} size={18} color={c.textFaint} />
        </Tap>
      ) : null}
      <View style={styles.body}>
        <MarkdownView
          text={shown}
          streaming={streaming}
          theme={t.name}
          onOpenLink={Platform.OS === 'web' ? undefined : openLinkNative}
          dom={INLINE_DOM}
        />
      </View>
      {open ? (
        <View style={[styles.details, { backgroundColor: c.surfaceAlt, borderRadius: t.radius.md }]}>
          <Ionicons name="time-outline" size={13} color={c.textFaint} />
          <T variant="caption" color="textMuted" numberOfLines={1} style={{ flexShrink: 1 }}>
            {formatMessageTime(ts)}
            {streaming ? ' · streaming' : ''}
          </T>
          <View style={{ flex: 1 }} />
          <Tap
            onPress={copy}
            pressedColor={null}
            pressedStyle={{ opacity: 0.7 }}
            accessibilityRole="button"
            accessibilityLabel="Copy message"
            style={styles.action}
          >
            <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={14} color={copied ? c.success : c.accent} />
            <T variant="caption" weight="700" style={{ color: copied ? c.success : c.accent }}>
              {copied ? 'Copied' : 'Copy'}
            </T>
          </Tap>
          <Tap
            onPress={() => onToggle(id, false)}
            pressedColor={null}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Hide message details"
            style={styles.close}
          >
            <Ionicons name="close" size={15} color={c.textFaint} />
          </Tap>
        </View>
      ) : null}
    </Tap>
  );
});

const styles = StyleSheet.create({
  root: { paddingHorizontal: 2, paddingVertical: 4 },
  label: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingRight: 4, marginBottom: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  body: {},
  details: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 10, paddingRight: 6, marginTop: 10, minHeight: 44 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, minHeight: 44 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
