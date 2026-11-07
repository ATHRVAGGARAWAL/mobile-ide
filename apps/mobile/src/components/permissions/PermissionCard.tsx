/**
 * Inline "Needs your approval" card used in the chat timeline and the Sessions inbox.
 * Shows the literal command/input in monospace; tapping opens the PermissionSheet.
 */
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PermissionRequest } from '@mobile-ide/core';
import { basename, relativeTime } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { useSessions } from '../../state/sessions';
import { useTheme } from '../../theme/ThemeProvider';
import { Card } from '../ui/Card';
import { Chip } from '../ui/Chip';
import { Tap } from '../ui/Tap';
import { T } from '../ui/Text';
import {
  describeInput,
  diffContents,
  diffStats,
  formatDiffStats,
  isNewFile,
  kindIcon,
  kindLabel,
  relativePath,
  resolutionLabel,
  type ResolvedInfo,
} from './permissionUtils';

export interface PermissionCardProps {
  request: PermissionRequest;
  /** set once the request was answered (by this device or another) */
  resolved?: ResolvedInfo;
  /** shown when the card is rendered outside its session (inbox) */
  sessionTitle?: string;
  onPress: () => void;
  /** tighter layout for lists: fewer input lines, no chips */
  compact?: boolean;
}

const MAX_CHIPS = 3;

export function PermissionCard({ request, resolved, sessionTitle, onPress, compact }: PermissionCardProps) {
  const t = useTheme();
  const c = t.colors;
  const now = useNow();
  const submit = useSessions((s) => s.permissionSubmit[request.permissionId]);
  const cwd = useSessions((s) => s.sessions.find((x) => x.id === request.sessionId)?.cwd);
  const diffs = useMemo(() => diffContents(request), [request]);
  const input = useMemo(() => describeInput(request.rawInput, { hasDiff: diffs.length > 0 }), [request.rawInput, diffs.length]);
  // one line per file — "hello.txt  +1 −0  new file" — instead of the change as escaped JSON
  const changes = useMemo(
    () => diffs.map((d) => ({ key: d.path, label: relativePath(d.path, cwd), stats: formatDiffStats(diffStats(d)), isNew: isNewFile(d) })),
    [diffs, cwd],
  );
  const title = relativePath(request.title, cwd);
  const resolution = resolved ? resolutionLabel(request, resolved) : null;
  const pending = !resolved;

  const accent = pending ? c.warning : resolution?.tone === 'success' ? c.success : resolution?.tone === 'danger' ? c.danger : c.textMuted;
  let statusText = 'Action needs review';
  let statusColor = accent;
  let statusIcon: React.ComponentProps<typeof Ionicons>['name'] = 'hand-left-outline';
  if (resolution) {
    statusText = resolution.label;
    statusIcon = resolution.icon;
    if (submit === 'sending') statusText += ' · sending…';
    else if (submit === 'queued') statusText += ' · queued until reconnected';
  } else if (submit === 'error') {
    statusText = "Couldn't send your answer — tap to answer again";
    statusColor = c.danger;
    statusIcon = 'alert-circle-outline';
  }

  // the literal command first; a request with a diff is summarized per file (the sheet renders the diff itself)
  const primary = input.command ?? (changes.length ? null : (input.path ?? input.details));
  const primaryLines = compact ? 3 : input.command !== null || input.path !== null ? undefined : 30;

  const chips: { key: string; label: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [];
  if (!compact && changes.length === 0) {
    for (const loc of request.locations ?? []) {
      chips.push({
        key: `l:${loc.path}:${loc.line ?? ''}`,
        label: loc.line ? `${basename(loc.path)}:${loc.line}` : basename(loc.path),
        icon: 'document-text-outline',
      });
    }
  }
  const extraChips = Math.max(0, chips.length - MAX_CHIPS);

  return (
    <Tap
      onPress={onPress}
      haptics
      pressedColor={null}
      pressedStyle={{ opacity: 0.85 }}
      accessibilityRole="button"
      accessibilityLabel={`${statusText}: ${title}`}
      accessibilityHint="Opens the permission details"
    >
      <Card padded={false} style={[styles.card, { borderLeftColor: accent }]}>
        <View style={[styles.header, { paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md }]}>
          <View style={[styles.iconBox, { backgroundColor: pending ? c.warningSoft : c.surfaceAlt, borderColor: c.border }]}>
            <Ionicons name={kindIcon(request.kind)} size={16} color={pending ? c.warning : c.textMuted} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={styles.statusRow}>
              <Ionicons name={statusIcon} size={13} color={statusColor} />
              <T variant="caption" weight="600" style={{ color: statusColor, flexShrink: 1 }} numberOfLines={2}>
                {statusText}
              </T>
            </View>
            <T
              variant="subheading"
              numberOfLines={compact ? 2 : undefined}
              style={{ marginTop: 5, opacity: pending ? 1 : 0.85, lineHeight: 22 }}
            >
              {title}
            </T>
          </View>
          {pending ? <Ionicons name="chevron-forward" size={18} color={c.textFaint} style={{ marginTop: 4 }} /> : null}
        </View>

        {primary ? (
          <View
            style={[
              styles.code,
              { backgroundColor: c.codeBg, borderColor: c.border, marginHorizontal: t.spacing.md, marginTop: t.spacing.sm },
            ]}
          >
            <T variant="mono" numberOfLines={primaryLines} style={{ color: c.codeText, opacity: pending ? 1 : 0.8 }}>
              {primary}
            </T>
          </View>
        ) : changes.length ? (
          <View
            style={[
              styles.code,
              styles.changes,
              { backgroundColor: c.codeBg, borderColor: c.border, marginHorizontal: t.spacing.md, marginTop: t.spacing.sm },
            ]}
          >
            {changes.slice(0, compact ? 2 : 6).map((ch) => (
              <View key={ch.key} style={styles.changeRow}>
                <Ionicons name={ch.isNew ? 'document-attach-outline' : 'pencil-outline'} size={13} color={c.textMuted} />
                <T variant="monoSmall" numberOfLines={1} style={{ color: c.codeText, flexShrink: 1, opacity: pending ? 1 : 0.8 }}>
                  {ch.label}
                </T>
                <T variant="caption" weight="600" style={{ color: c.success }}>
                  {ch.stats}
                </T>
                {ch.isNew ? (
                  <T variant="caption" color="textFaint">
                    new file
                  </T>
                ) : null}
              </View>
            ))}
            {changes.length > (compact ? 2 : 6) ? (
              <T variant="caption" color="textFaint">
                +{changes.length - (compact ? 2 : 6)} more files
              </T>
            ) : null}
          </View>
        ) : input.empty && !compact ? (
          <T variant="caption" color="textFaint" style={{ marginHorizontal: t.spacing.md, marginTop: t.spacing.sm }}>
            No input details were provided for this call.
          </T>
        ) : null}

        {chips.length ? (
          <View style={[styles.chips, { paddingHorizontal: t.spacing.md, marginTop: t.spacing.sm }]}>
            {chips.slice(0, MAX_CHIPS).map((chip) => (
              <Chip key={chip.key} label={chip.label} icon={chip.icon} mono maxWidth={220} />
            ))}
            {extraChips > 0 ? <Chip label={`+${extraChips} more`} /> : null}
          </View>
        ) : null}

        <View style={[styles.footer, { paddingHorizontal: t.spacing.md, paddingBottom: t.spacing.md, paddingTop: t.spacing.sm }]}>
          <T variant="caption" color="textFaint" numberOfLines={1} style={{ flex: 1 }}>
            {kindLabel(request.kind)} · {relativeTime(request.createdAt, now)}
            {sessionTitle ? ` · ${sessionTitle}` : ''}
          </T>
          {pending ? (
            <T variant="caption" weight="700" style={{ color: c.accent }}>
              Review
            </T>
          ) : null}
        </View>
      </Card>
    </Tap>
  );
}

const styles = StyleSheet.create({
  card: { borderLeftWidth: 2, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 1,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  code: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  changes: { gap: 4 },
  changeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
