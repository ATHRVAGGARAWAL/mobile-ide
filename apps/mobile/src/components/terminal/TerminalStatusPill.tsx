import { ActivityIndicator, View } from 'react-native';
import type { TerminalStatus } from '../../dom/TerminalView';
import { useTheme } from '../../theme/ThemeProvider';
import { T, Tap } from '../ui';

export function terminalStatusLabel(status: TerminalStatus): string {
  switch (status) {
    case 'open':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'unauthorized':
      return 'Not authorized';
    default:
      return 'Disconnected';
  }
}

export interface TerminalStatusPillProps {
  status: TerminalStatus;
  /** shown by the banner instead — kept in the accessibility label only */
  detail?: string | null;
  onPress?: () => void;
  /** Retained for callers; every state is now described in text. */
  compact?: boolean;
}

/** Pill for the terminal socket state; tap = reconnect when not connected. */
export function TerminalStatusPill({ status, detail, onPress }: TerminalStatusPillProps) {
  const t = useTheme();
  const c = t.colors;
  const pal =
    status === 'open'
      ? { bg: c.surfaceAlt, fg: c.textMuted }
      : status === 'connecting' || status === 'reconnecting'
        ? { bg: c.warningSoft, fg: c.warning }
        : { bg: c.dangerSoft, fg: c.danger };
  const busy = status === 'connecting' || status === 'reconnecting';
  const label = terminalStatusLabel(status);
  const a11y = detail && status !== 'open' ? `${label} ${detail}` : label;

  const tappable = !!onPress && status !== 'open';
  const body = (
    <View
      accessibilityRole={tappable ? undefined : 'text'}
      accessibilityLabel={tappable ? `${a11y}. Reconnect` : a11y}
      testID="terminal-status"
      style={{
        minHeight: 32,
        paddingHorizontal: 10,
        borderRadius: t.radius.sm,
        backgroundColor: pal.bg,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        flexShrink: 1,
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={pal.fg} style={{ transform: [{ scale: 0.7 }], width: 12, height: 12 }} />
      ) : (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: pal.fg }} />
      )}
      <T style={{ color: pal.fg, fontSize: 12, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>
        {label}
      </T>
    </View>
  );
  if (!tappable) return body;
  return (
    <Tap
      onPress={onPress}
      pressedColor={null}
      accessibilityRole="button"
      accessibilityLabel={`${a11y}. Reconnect`}
      style={{ flexShrink: 1, minHeight: 44, justifyContent: 'center' }}
    >
      {body}
    </Tap>
  );
}
