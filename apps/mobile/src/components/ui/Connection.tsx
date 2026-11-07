import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useConnection } from '../../state/connection';
import { useSessions } from '../../state/sessions';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from './Text';
import { Banner } from './Banner';

export function connectionLabel(state: string, detail: string | null): string {
  if (detail === 'unauthorized') return 'Not authorized';
  switch (state) {
    case 'open':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    default:
      return 'Offline';
  }
}

/** Small coloured dot + label used in headers. */
export function ConnectionDot({ showLabel = true }: { showLabel?: boolean }) {
  const t = useTheme();
  const state = useConnection((s) => s.state);
  const detail = useConnection((s) => s.detail);
  const color =
    state === 'open' ? t.colors.success : state === 'connecting' || state === 'reconnecting' ? t.colors.warning : t.colors.danger;
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
      accessibilityLabel={`Connection: ${connectionLabel(state, detail)}`}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      {showLabel ? (
        <T variant="caption" color="textMuted">
          {connectionLabel(state, detail)}
        </T>
      ) : null}
    </View>
  );
}

/** Thin banner shown under headers while the socket is down. */
export function ConnectionBanner() {
  const state = useConnection((s) => s.state);
  const unauthorized = useConnection((s) => s.unauthorized);
  const restart = useConnection((s) => s.restart);
  const outbox = useSessions((s) => s.outbox.length);
  const router = useRouter();
  if (unauthorized) {
    return (
      <Banner
        tone="danger"
        message="This device was revoked or the token expired. Pair again."
        actionLabel="Pair"
        onAction={() => router.push('/pair')}
        compact
      />
    );
  }
  if (state === 'open') {
    if (outbox > 0) return <Banner tone="info" message={`Sending ${outbox} queued ${outbox === 1 ? 'item' : 'items'}…`} compact />;
    return null;
  }
  const msg =
    state === 'connecting'
      ? 'Connecting…'
      : state === 'reconnecting'
        ? 'Connection lost. Retrying automatically…'
        : 'Offline. Check that your computer is awake and Mobile IDE is running.';
  const canRetry = state === 'closed' || state === 'reconnecting';
  return (
    <Banner
      tone={state === 'closed' ? 'danger' : 'warning'}
      message={outbox > 0 ? `${msg} ${outbox} queued ${outbox === 1 ? 'item' : 'items'} will send when back.` : msg}
      actionLabel={canRetry ? 'Retry now' : undefined}
      onAction={canRetry ? restart : undefined}
      compact
    />
  );
}
