import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ElicitationRequest, PermissionRequest, SessionSummary } from '@mobile-ide/core';
import { pluralize } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import { PermissionCard } from '../permissions';
import { ElicitationCard } from '../elicitation';
import { Card, SectionHeader, T, Tap } from '../ui';

export interface NeedsYouSectionProps {
  pending: PermissionRequest[];
  questions: ElicitationRequest[];
  sessions: SessionSummary[];
  onOpenPermission: (request: PermissionRequest) => void;
  onOpenQuestion: (request: ElicitationRequest) => void;
  onOpenSession: (session: SessionSummary) => void;
}

/** A single queue of actions and questions. Missing replay details retain their own fallback count. */
export function NeedsYouSection({ pending, questions, sessions, onOpenPermission, onOpenQuestion, onOpenSession }: NeedsYouSectionProps) {
  const t = useTheme();
  const queue = useMemo(
    () =>
      [
        ...pending.map((request) => ({ kind: 'permission' as const, request, id: request.permissionId })),
        ...questions.map((request) => ({ kind: 'question' as const, request, id: request.elicitationId })),
      ].sort((a, b) => a.request.createdAt - b.request.createdAt),
    [pending, questions],
  );
  const missing = useMemo(
    () =>
      sessions.flatMap((session) => {
        const known = queue.filter((item) => item.request.sessionId === session.id).length;
        const count = Math.max(0, Math.max(session.pendingPermissions, session.status === 'needs_you' ? 1 : 0) - known);
        return count ? [{ session, count }] : [];
      }),
    [queue, sessions],
  );
  const count = queue.length + missing.reduce((total, item) => total + item.count, 0);
  if (!count) return null;
  const titleOf = (id: string) => sessions.find((session) => session.id === id)?.title;
  return (
    <View accessibilityRole="summary" accessibilityLabel={`${pluralize(count, 'request')} waiting for you`} style={{ paddingBottom: 8 }}>
      <SectionHeader
        title="Needs your input"
        right={
          <T variant="caption" color="accent">
            {count} waiting
          </T>
        }
      />
      <View style={{ paddingHorizontal: 20, gap: 10 }}>
        {queue.map((item) =>
          item.kind === 'permission' ? (
            <PermissionCard
              key={`${item.kind}:${item.id}`}
              request={item.request}
              sessionTitle={titleOf(item.request.sessionId)}
              compact
              onPress={() => onOpenPermission(item.request)}
            />
          ) : (
            <ElicitationCard
              key={`${item.kind}:${item.id}`}
              request={item.request}
              sessionTitle={titleOf(item.request.sessionId)}
              compact
              onPress={() => onOpenQuestion(item.request)}
            />
          ),
        )}
        {missing.map(({ session, count: remaining }) => (
          <Tap key={`session:${session.id}`} onPress={() => onOpenSession(session)} accessibilityRole="button">
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12, borderColor: t.colors.accent }}>
              <Ionicons
                name={(session.pendingElicitations ?? 0) > 0 ? 'chatbubble-ellipses-outline' : 'hand-left-outline'}
                size={20}
                color={t.colors.accent}
              />
              <View style={{ flex: 1, gap: 4 }}>
                <T variant="subheading" numberOfLines={1}>
                  {session.title || 'Untitled session'}
                </T>
                <T variant="caption" color="textMuted">
                  {pluralize(remaining, 'request')} waiting · {session.agentName}
                </T>
              </View>
              <Ionicons name="arrow-forward" size={18} color={t.colors.accent} />
            </Card>
          </Tap>
        ))}
      </View>
    </View>
  );
}
