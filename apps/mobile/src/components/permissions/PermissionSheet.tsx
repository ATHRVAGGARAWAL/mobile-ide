/**
 * Bottom sheet for answering a permission request. Always shows the raw input verbatim in
 * monospace, previews diffs, and offers the agent's options in a fixed order with distinct
 * colours. allow_always and "stop the turn" go through a confirm step. Optimistic via the
 * sessions store (which also queues the answer while offline).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { PermissionOption, PermissionRequest } from '@mobile-ide/core';
import DiffView, { type DiffSource } from '../../dom/DiffView';
import { relativeTime, stripAnsi } from '../../lib/format';
import { haptic } from '../../lib/haptics';
import { useNow } from '../../lib/useNow';
import { useConnection } from '../../state/connection';
import { useSessions } from '../../state/sessions';
import { toast } from '../../state/toast';
import { useTheme } from '../../theme/ThemeProvider';
import { AgentBadge } from '../ui/AgentBadge';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Chip } from '../ui/Chip';
import { CodeBlock } from '../ui/CodeBlock';
import { Sheet } from '../ui/Sheet';
import { Tap } from '../ui/Tap';
import { T } from '../ui/Text';
import {
  describeInput,
  diffContents,
  isNewFile,
  kindIcon,
  kindLabel,
  locationLabel,
  locationTarget,
  optionIcon,
  optionLabel,
  optionVariant,
  parentDir,
  patchOf,
  relativePath,
  resolutionLabel,
  sortOptions,
  terminalContents,
  textContents,
  type FileTarget,
} from './permissionUtils';

export interface PermissionSheetProps {
  /** null hides the sheet (the last request stays mounted for the exit animation) */
  request: PermissionRequest | null;
  onClose: () => void;
}

const CANCEL_KEY = '__cancel_turn__';

type Pending = { kind: 'option'; option: PermissionOption } | { kind: 'cancel' };

export function PermissionSheet({ request, onClose }: PermissionSheetProps) {
  const t = useTheme();
  const c = t.colors;
  const router = useRouter();
  const now = useNow();

  // Show the live request immediately; keep the last one mounted while the sheet animates out.
  const [lastShown, setLastShown] = useState<PermissionRequest | null>(request);
  useEffect(() => {
    if (request) setLastShown(request);
  }, [request]);
  const shown = request ?? lastShown;
  const permissionId = shown?.permissionId;

  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PermissionOption | 'cancel' | null>(null);
  const [selectedOption, setSelectedOption] = useState<PermissionOption | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<Pending | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [answeredHere, setAnsweredHere] = useState(false);
  useEffect(() => {
    setBusy(null);
    setConfirm(null);
    setSelectedOption(null);
    setError(null);
    setLastAttempt(null);
    setShowDetails(false);
    setAnsweredHere(false);
  }, [permissionId]);

  const session = useSessions((s) => (shown ? s.sessions.find((x) => x.id === shown.sessionId) : undefined));
  const resolved = useSessions((s) => {
    if (!shown) return undefined;
    const tl = s.timelines[shown.sessionId];
    if (!tl) return undefined;
    const idx = tl.permissionIndex[shown.permissionId];
    if (idx === undefined) return undefined;
    const item = tl.items[idx];
    return item && item.kind === 'permission' ? item.resolved : undefined;
  });
  const submit = useSessions((s) => (shown ? s.permissionSubmit[shown.permissionId] : undefined));
  const connState = useConnection((s) => s.state);

  const cwd = session?.cwd ?? undefined;
  const options = useMemo(() => (shown ? sortOptions(shown.options) : []), [shown]);
  const diffs = useMemo(() => (shown ? diffContents(shown) : []), [shown]);
  // OpenCode also puts the change into rawInput as a unified diff; it is rendered, not printed as escaped JSON
  const patch = useMemo(() => (shown && diffs.length === 0 ? patchOf(shown.rawInput) : null), [shown, diffs]);
  const hasDiff = diffs.length > 0 || patch !== null;
  const input = useMemo(() => (shown ? describeInput(shown.rawInput, { hasDiff }) : null), [shown, hasDiff]);
  const diffSources = useMemo<DiffSource[]>(
    () => diffs.map((d) => ({ kind: 'texts' as const, path: relativePath(d.path, cwd), oldText: d.oldText, newText: d.newText })),
    [diffs, cwd],
  );
  const patchSource = useMemo<DiffSource | null>(() => (patch ? { kind: 'patch', patch } : null), [patch]);
  const terminals = useMemo(() => (shown ? terminalContents(shown) : []), [shown]);
  const texts = useMemo(() => (shown ? textContents(shown) : []), [shown]);

  const finish = useCallback(
    (result: 'idle' | 'queued' | 'error' | 'sending', attempt: Pending) => {
      setBusy(null);
      if (result === 'error') {
        setAnsweredHere(false);
        setLastAttempt(attempt);
        setError("Your answer didn't reach the daemon. Check the connection and try again.");
        void haptic.error();
        return;
      }
      if (result === 'queued') toast.info('Offline — your answer is queued and will be sent when the connection returns.');
      void (attempt.kind === 'cancel' ? haptic.warning() : haptic.success());
      onClose();
    },
    [onClose],
  );

  const respond = useCallback(
    async (option: PermissionOption) => {
      if (!shown || busy) return;
      setError(null);
      setBusy(option.optionId);
      setAnsweredHere(true);
      const result = await useSessions.getState().respondPermission(shown.sessionId, shown.permissionId, 'selected', option.optionId);
      finish(result, { kind: 'option', option });
    },
    [shown, busy, finish],
  );

  const cancelTurn = useCallback(async () => {
    if (!shown || busy) return;
    setError(null);
    setBusy(CANCEL_KEY);
    setAnsweredHere(true);
    const result = await useSessions.getState().respondPermission(shown.sessionId, shown.permissionId, 'cancelled');
    finish(result, { kind: 'cancel' });
  }, [shown, busy, finish]);

  const retry = useCallback(() => {
    if (!lastAttempt) return;
    if (lastAttempt.kind === 'cancel') void cancelTurn();
    else void respond(lastAttempt.option);
  }, [lastAttempt, cancelTurn, respond]);

  const openFile = useCallback(
    (target: FileTarget) => {
      onClose();
      router.push({
        pathname: '/file',
        params: { root: target.root, path: target.path, ...(target.line ? { line: String(target.line) } : {}) },
      });
    },
    [onClose, router],
  );

  if (!shown || !input) return null;

  const answeredElsewhere = !!resolved && !answeredHere;
  const resolution = resolved ? resolutionLabel(shown, resolved) : null;
  const inputLabel = input.command !== null ? 'Command' : input.path !== null ? 'Path' : 'Input';
  const primaryText = input.command ?? input.path;
  // an absolute path as title (OpenCode's edit requests) wraps over two lines: show it relative to the project, the folder as a caption
  const title = relativePath(shown.title, cwd);
  const titleDir = title !== shown.title ? parentDir(shown.title) : '';
  // with a rendered diff the raw JSON only repeats it: it stays behind "Show full input", which always reveals the
  // complete literal input (the rule: the app may add to rawInput, never drop it)
  const showInputSection = input.empty || primaryText !== null || (input.details !== '' && !hasDiff);
  const showFullToggle = !input.empty && input.full !== '' && (hasDiff || input.full !== (primaryText ?? input.details));

  let footer: React.ReactNode;
  if (answeredElsewhere && resolution) {
    footer = <Button title="Done" variant="secondary" size="lg" full onPress={onClose} />;
  } else if (confirm && confirm !== 'cancel') {
    footer = (
      <View style={styles.footer}>
        {error ? <Banner tone="danger" message={error} compact /> : null}
        <Card tone="warning">
          <T variant="subheading">Always allow this action?</T>
          <T variant="bodySmall" color="textMuted" style={{ marginTop: 4 }}>
            Confirm the selected permission: “{optionLabel(confirm)}”.
          </T>
        </Card>
        <View style={styles.row}>
          <Button
            title="Back"
            variant="secondary"
            size="lg"
            style={styles.grow}
            disabled={busy !== null}
            onPress={() => setConfirm(null)}
          />
          <Button
            title="Always allow"
            icon="checkmark-done-outline"
            variant="warning"
            size="lg"
            style={styles.grow}
            loading={busy === confirm.optionId}
            onPress={() => void respond(confirm)}
          />
        </View>
      </View>
    );
  } else if (confirm === 'cancel') {
    footer = (
      <View style={styles.footer}>
        {error ? <Banner tone="danger" message={error} compact /> : null}
        <Card tone="danger">
          <T variant="subheading">Stop the whole turn?</T>
          <T variant="bodySmall" color="textMuted" style={{ marginTop: 4 }}>
            This stops the current turn. To decline this action and let the agent continue, go back and choose a reject option.
          </T>
        </Card>
        <View style={styles.row}>
          <Button
            title="Back"
            variant="secondary"
            size="lg"
            style={styles.grow}
            disabled={busy !== null}
            onPress={() => setConfirm(null)}
          />
          <Button
            title="Stop turn"
            icon="stop-circle-outline"
            variant="danger"
            size="lg"
            style={styles.grow}
            loading={busy === CANCEL_KEY}
            onPress={() => void cancelTurn()}
          />
        </View>
      </View>
    );
  } else {
    footer = (
      <View style={styles.footer}>
        {error ? (
          <Banner
            tone="danger"
            message={error}
            actionLabel={lastAttempt ? 'Retry' : undefined}
            onAction={lastAttempt ? retry : undefined}
            compact
          />
        ) : null}
        <Button
          title={selectedOption ? 'Send decision' : 'Select an option'}
          icon={selectedOption ? optionIcon(selectedOption.kind) : 'checkmark-circle-outline'}
          variant={selectedOption ? optionVariant(selectedOption.kind) : 'secondary'}
          size="lg"
          full
          disabled={!selectedOption || busy !== null}
          loading={busy !== null && busy !== CANCEL_KEY}
          onPress={() => {
            if (!selectedOption) return;
            if (selectedOption.kind === 'allow_always') setConfirm(selectedOption);
            else void respond(selectedOption);
          }}
        />
        <Tap
          onPress={() => setConfirm('cancel')}
          disabled={busy !== null}
          pressedColor={null}
          style={styles.cancelLink}
          accessibilityRole="button"
          accessibilityLabel="Stop the whole turn instead"
        >
          <T variant="bodySmall" color="textMuted">
            Stop the turn
          </T>
        </Tap>
      </View>
    );
  }

  return (
    <Sheet
      visible={request !== null}
      onClose={onClose}
      title={answeredElsewhere ? 'Action reviewed' : 'Review action'}
      subtitle={session ? `${session.agentName} · ${session.title}` : kindLabel(shown.kind)}
      footer={footer}
      maxHeightRatio={0.92}
    >
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <View style={[styles.kindBox, { backgroundColor: answeredElsewhere ? c.surfaceAlt : c.warningSoft }]}>
            <Ionicons name={kindIcon(shown.kind)} size={20} color={answeredElsewhere ? c.textMuted : c.warning} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="subheading" selectable>
              {title}
            </T>
            {titleDir ? (
              <T variant="monoSmall" color="textFaint" numberOfLines={1} selectable>
                in {titleDir}
              </T>
            ) : null}
            <View style={styles.metaRow}>
              {session ? <AgentBadge agent={session.agent} name={session.agentName} /> : null}
              <T variant="caption">
                {kindLabel(shown.kind)} · asked {relativeTime(shown.createdAt, now)}
              </T>
            </View>
          </View>
        </View>

        {answeredElsewhere && resolution ? (
          <Banner
            tone={resolution.tone === 'success' ? 'success' : resolution.tone === 'danger' ? 'danger' : 'neutral'}
            icon={resolution.icon}
            message={`Already answered: ${resolution.label}${submit === 'queued' ? ' (queued until reconnected)' : ''}`}
          />
        ) : connState !== 'open' ? (
          <Banner tone="warning" message="Offline — your answer will be queued and sent when the connection returns." compact />
        ) : null}

        {diffs.map((d, i) => {
          const source = diffSources[i];
          if (!source) return null;
          return (
            <View key={`${d.path}:${i}`} style={styles.section}>
              <T variant="label">{isNewFile(d) ? 'New file' : 'Changes'}</T>
              <T variant="monoSmall" color="textMuted" selectable>
                {relativePath(d.path, cwd)}
              </T>
              <View style={{ borderRadius: t.radius.md, overflow: 'hidden' }}>
                <DiffView
                  source={source}
                  theme={t.name}
                  wrap
                  dom={{ matchContents: true, scrollEnabled: false, style: { backgroundColor: 'transparent' } }}
                />
              </View>
            </View>
          );
        })}

        {patchSource ? (
          <View style={styles.section}>
            <T variant="label">Changes</T>
            <View style={{ borderRadius: t.radius.md, overflow: 'hidden' }}>
              <DiffView
                source={patchSource}
                theme={t.name}
                wrap
                dom={{ matchContents: true, scrollEnabled: false, style: { backgroundColor: 'transparent' } }}
              />
            </View>
          </View>
        ) : null}

        {showInputSection ? (
          <View style={styles.section}>
            <T variant="label">{inputLabel}</T>
            {input.empty ? (
              <Banner
                tone="neutral"
                icon="alert-circle-outline"
                message="The agent did not include the raw input for this call. Review the title and any changes above before allowing."
                compact
              />
            ) : primaryText !== null ? (
              <CodeBlock code={primaryText} wrap />
            ) : (
              <CodeBlock code={input.details} wrap />
            )}
          </View>
        ) : null}
        {showFullToggle ? (
          <View style={styles.section}>
            <Tap
              onPress={() => setShowDetails((v) => !v)}
              pressedColor={null}
              style={styles.detailsToggle}
              accessibilityRole="button"
              accessibilityLabel={showDetails ? 'Hide full input' : 'Show full input'}
              aria-expanded={showDetails}
            >
              <Ionicons name={showDetails ? 'chevron-up' : 'chevron-down'} size={14} color={c.accent} />
              <T variant="bodySmall" weight="600" color="accent">
                {showDetails ? 'Hide full input' : 'Show full input'}
              </T>
            </Tap>
            {showDetails ? <CodeBlock code={input.full} wrap label="Everything the agent sent" /> : null}
          </View>
        ) : null}

        {terminals.map((term, i) =>
          term.output ? (
            <View key={`${term.terminalId}:${i}`} style={styles.section}>
              <T variant="label">Output{term.exitCode != null ? ` · exit ${term.exitCode}` : ''}</T>
              <CodeBlock code={stripAnsi(term.output)} wrap maxHeight={220} tone={term.exitCode ? 'danger' : 'default'} />
            </View>
          ) : null,
        )}

        {texts.length ? (
          <View style={styles.section}>
            <T variant="label">From the agent</T>
            {texts.map((txt, i) => (
              <T key={i} variant="bodySmall" color="textMuted" selectable>
                {txt}
              </T>
            ))}
          </View>
        ) : null}

        {shown.locations?.length ? (
          <View style={styles.section}>
            <T variant="label">Files involved</T>
            <View style={styles.chips}>
              {shown.locations.map((loc, i) => {
                const target = locationTarget(loc, cwd);
                return (
                  <Chip
                    key={`${loc.path}:${loc.line ?? ''}:${i}`}
                    label={locationLabel(loc, cwd)}
                    icon={target ? 'document-text-outline' : 'lock-closed-outline'}
                    mono
                    size="md"
                    maxWidth={320}
                    onPress={target ? () => openFile(target) : undefined}
                  />
                );
              })}
            </View>
          </View>
        ) : null}

        {!answeredElsewhere ? (
          <View style={styles.section}>
            <T variant="label">Your decision</T>
            {options.length ? (
              options.map((option) => {
                const selected = selectedOption?.optionId === option.optionId;
                const color =
                  option.kind === 'allow_once'
                    ? c.success
                    : option.kind === 'allow_always'
                      ? c.warning
                      : option.kind === 'reject_always'
                        ? c.danger
                        : c.textMuted;
                return (
                  <Tap
                    key={option.optionId}
                    onPress={() => setSelectedOption(option)}
                    disabled={busy !== null || confirm !== null}
                    accessibilityRole="radio"
                    accessibilityLabel={optionLabel(option)}
                    accessibilityState={{ checked: selected, disabled: busy !== null || confirm !== null }}
                    style={[
                      styles.option,
                      {
                        borderColor: selected ? color : c.border,
                        backgroundColor: selected ? c.surfaceAlt : c.surface,
                        borderRadius: t.radius.md,
                      },
                    ]}
                  >
                    <Ionicons name={optionIcon(option.kind)} size={20} color={color} />
                    <T variant="bodySmall" weight={selected ? '600' : '400'} style={{ flex: 1 }}>
                      {optionLabel(option)}
                    </T>
                    <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={20} color={selected ? color : c.textFaint} />
                  </Tap>
                );
              })
            ) : (
              <Banner tone="neutral" message="The agent offered no options for this request." compact />
            )}
          </View>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 20, paddingBottom: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  kindBox: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  section: { gap: 10 },
  detailsToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 44 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  footer: { gap: 10 },
  row: { flexDirection: 'row', gap: 10 },
  grow: { flex: 1 },
  cancelLink: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, minHeight: 56, borderWidth: 1 },
});
