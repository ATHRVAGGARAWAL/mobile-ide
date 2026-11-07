import { Platform } from 'react-native';

export const isWeb = Platform.OS === 'web';
export const isNative = !isWeb;

/**
 * `keyboardDismissMode` for scroll views that should drop the keyboard when the user drags. react-native-web cannot
 * tell a drag from a layout scroll: it blurs the focused field on *every* scroll event in `on-drag` mode, so the
 * keyboard opening (which shrinks the viewport and emits a scroll) closed it again at once. Web therefore never
 * dismisses on scroll; native keeps the platform behaviour.
 */
export const KEYBOARD_DISMISS_ON_DRAG: 'none' | 'on-drag' | 'interactive' = isWeb ? 'none' : Platform.OS === 'ios' ? 'interactive' : 'on-drag';

/** True when running as an installed PWA (Add to Home Screen) rather than in a browser tab. */
export function isStandaloneWeb(): boolean {
  if (!isWeb) return false;
  try {
    const w = globalThis as unknown as { matchMedia?: (q: string) => { matches: boolean }; navigator?: { standalone?: boolean } };
    if (w.navigator?.standalone) return true;
    return !!w.matchMedia?.('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

export function isIosSafariWeb(): boolean {
  if (!isWeb) return false;
  const ua = (globalThis as unknown as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? '';
  return /iPhone|iPad|iPod/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua);
}

export function defaultDeviceName(): string {
  if (Platform.OS === 'ios') return 'iPhone';
  if (Platform.OS === 'android') return 'Android';
  const ua = (globalThis as unknown as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? '';
  if (/iPhone/.test(ua)) return 'iPhone (web)';
  if (/iPad/.test(ua)) return 'iPad (web)';
  if (/Android/.test(ua)) return 'Android (web)';
  if (/Mac/.test(ua)) return 'Mac browser';
  if (/Linux/.test(ua)) return 'Linux browser';
  if (/Windows/.test(ua)) return 'Windows browser';
  return 'Browser';
}
