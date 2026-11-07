/**
 * Inline "the agent asks you" card for the chat timeline: the question (or link target), its status and, once
 * answered, the answer. Tapping a pending one opens the ElicitationSheet.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ElicitationRequest } from '@mobile-ide/core';
import { relativeTime } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { useSessions } from '../../state/sessions';
import { useTheme } from '../../theme/ThemeProvider';
import { Card } from '../ui/Card';
import { Tap } from '../ui/Tap';
import { T } from '../ui/Text';
import { describeElicitation, elicitationIcon, resolutionInfo, urlHost, type ElicitationResolved } from './elicitationUtils';

export interface ElicitationCardProps {
  request: ElicitationRequest;
  /** set once the request was answered (by this device, another one, or the daemon) */
  resolved?: ElicitationResolved;
  /** shown when the card is rendered outside its session */
  sessionTitle?: string;
  onPress: () => void;
  /** tighter layout for lists */
  compact?: boolean;
}

export const ElicitationCard = React.memo(function ElicitationCard({
  request,
  resolved,
  sessionTitle,
  onPress,
  compact,
}: ElicitationCardProps) {
  const t = useTheme();
  const c = t.colors;
  const now = useNow();
  const submit = useSessions((s) => s.elicitationSubmit[request.elicitationId]);
  const resolution = resolved ? resolutionInfo(request, resolved) : null;
  const pending = !resolved;

  const accent = pending ? c.warning : resolution?.tone === 'success' ? c.success : resolution?.tone === 'danger' ? c.danger : c.textMuted;
  let statusText = request.mode === 'url' ? 'Open a link to continue' : 'A question for you';
  let statusColor = accent;
  let statusIcon: React.ComponentProps<typeof Ionicons>['name'] = 'chatbubble-ellipses-outline';
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
  const host = request.mode === 'url' && request.url ? urlHost(request.url) : null;

  return (
    <Tap
      onPress={onPress}
      haptics
      pressedColor={null}
      pressedStyle={{ opacity: 0.85 }}
      accessibilityRole="button"
      accessibilityLabel={`${statusText}: ${request.message}`}
      accessibilityHint={pending ? 'Opens the question' : undefined}
    >
      <Card padded={false} style={[styles.card, { borderLeftColor: accent }]}>
        <View style={[styles.header, { paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md }]}>
          <View style={[styles.iconBox, { backgroundColor: pending ? c.warningSoft : c.surfaceAlt, borderColor: c.border }]}>
            <Ionicons name={elicitationIcon(request)} size={16} color={pending ? c.warning : c.textMuted} />
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
              numberOfLines={compact ? 3 : undefined}
              selectable={!compact}
              style={{ marginTop: 5, opacity: pending ? 1 : 0.85, lineHeight: 22 }}
            >
              {request.message}
            </T>
            {host ? (
              <T variant="monoSmall" color="textMuted" numberOfLines={1} style={{ marginTop: 4 }}>
                {host}
              </T>
            ) : null}
          </View>
          {pending ? <Ionicons name="chevron-forward" size={18} color={c.textFaint} style={{ marginTop: 4 }} /> : null}
        </View>
        <View style={[styles.footer, { paddingHorizontal: t.spacing.md, paddingBottom: t.spacing.md, paddingTop: t.spacing.sm }]}>
          <T variant="caption" color="textFaint" numberOfLines={1} style={{ flex: 1 }}>
            {describeElicitation(request)} · {relativeTime(request.createdAt, now)}
            {sessionTitle ? ` · ${sessionTitle}` : ''}
          </T>
          {pending ? (
            <T variant="caption" weight="700" style={{ color: c.accent }}>
              {request.mode === 'url' ? 'Review' : 'Answer'}
            </T>
          ) : null}
        </View>
      </Card>
    </Tap>
  );
});

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
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
