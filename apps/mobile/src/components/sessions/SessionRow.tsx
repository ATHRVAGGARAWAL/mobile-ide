import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { SessionStatus, SessionSummary } from '@mobile-ide/core';
import { relativeTime } from '../../lib/format';
import { isNative } from '../../lib/platform';
import { useTheme } from '../../theme/ThemeProvider';
import { IconButton, StatusChip, T, Tap, statusLabel } from '../ui';
import { cleanPreview } from './groupSessions';
import { SwipeableRow, type SwipeAction } from './SwipeableRow';

export interface SessionRowProps {
  session: SessionSummary;
  now: number;
  unread: boolean;
  first: boolean;
  last: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onRename: () => void;
  onClose: () => void;
  swipeEnabled?: boolean;
}

function placeholderPreview(status: SessionStatus): string {
  if (status === 'starting') return 'Getting the agent ready…';
  if (status === 'running') return 'Work is in progress. Open to follow along.';
  if (status === 'needs_you') return 'Your input will get things moving again.';
  if (status === 'error') return 'Open the conversation to review what happened.';
  if (status === 'closed') return 'This session is closed.';
  return 'Ready for your next idea.';
}

export const SessionRow = memo(function SessionRow({
  session: s,
  now,
  unread,
  onPress,
  onLongPress,
  onRename,
  onClose,
  swipeEnabled = isNative,
}: SessionRowProps) {
  const t = useTheme();
  const c = t.colors;
  const actions: SwipeAction[] = [
    { key: 'rename', label: 'Rename', icon: 'pencil-outline', bg: c.accent, fg: c.onAccent, onPress: onRename },
    { key: 'close', label: 'Close', icon: 'close-circle-outline', bg: c.danger, fg: c.bg, onPress: onClose },
  ];
  const a11y = [s.title || 'Untitled session', s.agentName, statusLabel(s.status), s.projectName, unread ? 'unread' : null]
    .filter(Boolean)
    .join(', ');
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: unread ? c.borderStrong : c.border, borderRadius: t.radius.lg }]}>
      <SwipeableRow actions={actions} enabled={swipeEnabled}>
        <View style={styles.top}>
          <View style={[styles.agentMark, { backgroundColor: c.surfaceAlt, borderColor: c.border }]}>
            <Ionicons name="sparkles-outline" size={13} color={c.textMuted} />
          </View>
          <T variant="caption" weight="600" color="textMuted" numberOfLines={1} style={{ flex: 1 }}>
            {s.agentName}
          </T>
          <T variant="caption" color="textFaint">
            {relativeTime(s.updatedAt, now)}
          </T>
          <IconButton name="ellipsis-horizontal" label={`Actions for ${s.title || 'Untitled session'}`} onPress={onLongPress} size={18} />
        </View>
        <Tap
          onPress={onPress}
          onLongPress={onLongPress}
          delayLongPress={400}
          accessibilityRole="button"
          accessibilityLabel={a11y}
          style={styles.body}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {unread ? <View style={[styles.unread, { backgroundColor: c.accent }]} /> : null}
            <T variant="heading" weight="600" numberOfLines={2} style={{ flex: 1 }}>
              {s.title || 'Untitled session'}
            </T>
            <Ionicons name="arrow-forward" size={18} color={c.textFaint} />
          </View>
          <T variant="bodySmall" color="textMuted" numberOfLines={2} style={{ lineHeight: 20 }}>
            {cleanPreview(s.lastMessagePreview) || placeholderPreview(s.status)}
          </T>
          <View style={[styles.footer, { borderTopColor: c.border }]}>
            <Ionicons name="folder-outline" size={13} color={c.textFaint} />
            <T variant="caption" color="textFaint" numberOfLines={1} style={{ flex: 1 }}>
              {s.projectName || s.cwd}
            </T>
            <StatusChip status={s.status} />
          </View>
        </Tap>
      </SwipeableRow>
    </View>
  );
});

const styles = StyleSheet.create({
  card: { marginHorizontal: 20, marginBottom: 10, borderWidth: 1, overflow: 'hidden' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 6, paddingTop: 4 },
  agentMark: { width: 24, height: 24, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: 16, paddingBottom: 14, gap: 8 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 12, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth },
  unread: { width: 6, height: 6, borderRadius: 3 },
});
