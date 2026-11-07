/**
 * One shape for "how is this notification channel doing", shared by the Expo push, Web Push
 * and ntfy helpers so Settings can render every channel the same way.
 */
import type { Theme } from '../theme';

export type ChannelTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface ChannelStatus {
  /** short chip text, e.g. "Registered", "Blocked", "Native app only" */
  label: string;
  tone: ChannelTone;
  /** one sentence explaining the state and what to do next */
  detail: string;
  /** what the primary button should do, if anything */
  action: 'enable' | 'reregister' | 'settings' | 'disable' | null;
}

export function channelToneColors(tone: ChannelTone, t: Theme): { bg: string; fg: string } {
  const c = t.colors;
  switch (tone) {
    case 'success':
      return { bg: c.successSoft, fg: c.success };
    case 'warning':
      return { bg: c.warningSoft, fg: c.warning };
    case 'danger':
      return { bg: c.dangerSoft, fg: c.danger };
    case 'info':
      return { bg: c.infoSoft, fg: c.info };
    default:
      return { bg: c.surfaceAlt, fg: c.textMuted };
  }
}

/** Last characters of a token/endpoint for display without leaking the whole thing. */
export function tailOf(value: string, n = 8): string {
  const s = value.trim();
  return s.length <= n ? s : `…${s.slice(-n)}`;
}
