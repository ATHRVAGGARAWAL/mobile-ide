/**
 * Safe-area insets that are trustworthy on every platform.
 *
 * Native: `useSafeAreaInsets()` as is.
 *
 * Web (iOS home-screen web app): `env(safe-area-inset-*)` says how far the screen's unsafe bands reach into the page.
 * Measured on iOS 26.x (iPhone 390×844): the page is 390×797, env reports 47/34. The page still starts at the very top
 * — under the status bar, so the 47 pt top inset is real — while iOS keeps the missing 47 pt at the *bottom* for the
 * home-indicator band, yet still reports a 34 pt bottom inset. Padding by it doubled the space under the composer.
 * Rule: trust the top value (iOS reports 0 when it insets the top itself); drop the bottom value when the height iOS
 * kept (`screen.height − innerHeight`) already covers it. Settings → Appearance can force a layout (`safeArea` mode)
 * when a future iOS moves the bands again. In a browser tab env is 0/0, so nothing changes there.
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings, type SafeAreaMode } from '../state/settings';

export interface SafeInsets {
  top: number;
  bottom: number;
}

/** Raw numbers behind the decision, for the Settings → About readout. */
export interface WebViewportInfo {
  innerWidth: number;
  innerHeight: number;
  screenWidth: number;
  screenHeight: number;
  envTop: number;
  envBottom: number;
  standalone: boolean;
  reserved: number;
  mode: SafeAreaMode;
  applied: SafeInsets;
}

type Doc = Document & { documentElement: HTMLElement };
type Win = Window & typeof globalThis & { navigator: Navigator & { standalone?: boolean } };

let probe: HTMLElement | null = null;

function ensureProbe(doc: Doc): HTMLElement {
  if (probe && probe.isConnected) return probe;
  const el = doc.createElement('div');
  const s = el.style;
  s.position = 'fixed';
  s.top = '0';
  s.left = '0';
  s.width = '0';
  s.height = '0';
  s.visibility = 'hidden';
  s.pointerEvents = 'none';
  s.zIndex = '-1';
  s.paddingTop = 'env(safe-area-inset-top)';
  s.paddingBottom = 'env(safe-area-inset-bottom)';
  doc.body.appendChild(el);
  probe = el;
  return el;
}

function px(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function isStandalone(win: Win): boolean {
  if (win.navigator.standalone === true) return true;
  try {
    return win.matchMedia?.('(display-mode: standalone), (display-mode: fullscreen)').matches === true;
  } catch {
    return false;
  }
}

/** Tolerance when comparing the reserved height against an env band (rounding, 1 px borders). */
const SLACK = 4;

export function measureWebViewport(mode: SafeAreaMode = 'auto'): WebViewportInfo | null {
  const g = globalThis as unknown as Partial<Win>;
  if (Platform.OS !== 'web' || !g.document || !g.getComputedStyle) return null;
  const win = g as Win;
  let envTop = 0;
  let envBottom = 0;
  try {
    const cs = win.getComputedStyle(ensureProbe(win.document as Doc));
    envTop = px(cs.paddingTop);
    envBottom = px(cs.paddingBottom);
  } catch {
    /* no probe: env values stay 0 */
  }
  const innerWidth = win.innerWidth;
  const innerHeight = win.innerHeight;
  const screenWidth = win.screen?.width ?? innerWidth;
  const screenHeight = win.screen?.height ?? innerHeight;
  const standalone = isStandalone(win);
  const portrait = innerHeight >= innerWidth;
  const reserved = Math.max(0, screenHeight - innerHeight);

  let top = envTop;
  let bottom = envBottom;
  if (mode === 'none') {
    top = 0;
    bottom = 0;
  } else if (mode === 'top') {
    bottom = 0;
  } else if (mode === 'auto' && standalone && portrait && reserved > 0 && envBottom > 0 && reserved >= envBottom - SLACK) {
    // iOS keeps a band at least as tall as the home-indicator inset for itself: the page never reaches under it
    bottom = 0;
  }
  return { innerWidth, innerHeight, screenWidth, screenHeight, envTop, envBottom, standalone, reserved, mode, applied: { top, bottom } };
}

function useWebInsets(): SafeInsets | null {
  const mode = useSettings((s) => s.safeArea);
  const [state, setState] = useState<SafeInsets | null>(() => measureWebViewport(mode)?.applied ?? null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const win = globalThis as unknown as Win;
    const update = () => {
      const next = measureWebViewport(mode)?.applied ?? null;
      setState((prev) => (prev && next && prev.top === next.top && prev.bottom === next.bottom ? prev : next));
    };
    update();
    // standalone iOS settles env() and the viewport a few frames after first paint
    const t1 = setTimeout(update, 120);
    const t2 = setTimeout(update, 700);
    win.addEventListener('resize', update);
    win.addEventListener('orientationchange', update);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      win.removeEventListener('resize', update);
      win.removeEventListener('orientationchange', update);
    };
  }, [mode]);
  return state;
}

/**
 * Top/bottom safe-area padding to apply. On web the measured values win outright (react-native-safe-area-context
 * reads env() once at mount and does not know which bands the OS reserved); on native they are the library's.
 */
export function useSafeInsets(): SafeInsets {
  const insets = useSafeAreaInsets();
  const web = useWebInsets();
  if (Platform.OS === 'web' && web) return web;
  return { top: insets.top, bottom: insets.bottom };
}

export function useSafeTop(): number {
  return useSafeInsets().top;
}
