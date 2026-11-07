import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { SessionStatus } from '@mobile-ide/core';
import { statusColor } from '../../theme';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from './Text';

const LABEL: Record<SessionStatus, string> = {
  starting: 'Starting',
  idle: 'Idle',
  running: 'Running',
  needs_you: 'Needs you',
  error: 'Error',
  closed: 'Closed',
};

export function statusLabel(s: SessionStatus): string {
  return LABEL[s];
}

/**
 * Session status as a dot + word. Quiet states (idle, starting, closed) are plain text; the states that want a
 * glance (running, needs you, error) get a filled pill.
 */
export function StatusChip({ status, size = 'sm' }: { status: SessionStatus; size?: 'sm' | 'md' }) {
  const t = useTheme();
  const col = statusColor(status, t);
  const pill = status === 'needs_you' || status === 'running' || status === 'error';
  const h = size === 'sm' ? 22 : 28;
  const dot = status === 'needs_you' ? col.fg : col.dot;
  return (
    <View
      style={{
        height: h,
        paddingHorizontal: pill ? 8 : 0,
        borderRadius: t.radius.pill,
        backgroundColor: pill ? col.bg : 'transparent',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
      }}
    >
      {status === 'running' || status === 'starting' ? (
        <ActivityIndicator size={10} color={dot} style={{ transform: [{ scale: 0.8 }] }} />
      ) : (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot }} />
      )}
      <T style={{ color: col.fg, fontSize: size === 'sm' ? 11 : 12, fontWeight: '600' }}>{LABEL[status]}</T>
    </View>
  );
}

export function StatusDot({ status, size = 8 }: { status: SessionStatus; size?: number }) {
  const t = useTheme();
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: statusColor(status, t).dot }} />;
}
