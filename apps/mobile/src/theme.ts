/**
 * Design tokens. One file drives both themes; components never hard-code colours.
 */
import { Platform } from 'react-native';

export type ThemeName = 'light' | 'dark';
export type ThemePreference = 'system' | ThemeName;

import { darkColors, lightColors, type ThemeColors } from './theme/palette';
export type { ThemeColors } from './theme/palette';

export interface Theme {
  name: ThemeName;
  dark: boolean;
  colors: ThemeColors;
  spacing: typeof spacing;
  radius: typeof radius;
  font: typeof font;
}

export const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 20, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 18, xl: 24, pill: 999 } as const;

export const font = {
  sans: Platform.select({
    ios: 'System',
    android: 'sans-serif',
    default: 'system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
  }) as string,
  mono: Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  }) as string,
  size: { xs: 11, sm: 13, md: 15, lg: 18, xl: 24, xxl: 32 },
  weight: { regular: '400', medium: '500', semibold: '600', bold: '700' } as const,
} as const;

export const themes: Record<ThemeName, Theme> = {
  light: { name: 'light', dark: false, colors: lightColors, spacing, radius, font },
  dark: { name: 'dark', dark: true, colors: darkColors, spacing, radius, font },
};

/**
 * `boxShadow` value built from the theme's shadow token, with the token's alpha scaled by `opacity`
 * (the same result the deprecated shadowColor/shadowOpacity/shadowRadius/shadowOffset props gave).
 */
export function shadow(theme: Theme, offsetX: number, offsetY: number, blur: number, opacity: number): string {
  return `${offsetX}px ${offsetY}px ${blur}px ${withAlpha(theme.colors.shadow, opacity)}`;
}

function withAlpha(color: string, multiplier: number): string {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color.trim());
  if (!m) return color;
  const base = m[4] === undefined ? 1 : Number(m[4]);
  const alpha = Math.max(0, Math.min(1, base * multiplier));
  return `rgba(${m[1]},${m[2]},${m[3]},${Number(alpha.toFixed(3))})`;
}

/**
 * Agent badge tone. The UI is monochrome: every agent shares the same neutral chip (the name tells them apart), so
 * this returns one pair regardless of `agentId`. Add a branch here only if a badge genuinely must not be neutral.
 */
export function agentColor(_agentId: string, theme: Theme): { bg: string; fg: string } {
  return { bg: theme.colors.surfaceAlt, fg: theme.colors.textMuted };
}

/**
 * Status → colour triple. Only states that need the user's eye get the accent (running, needs_you); errors are
 * the one other chromatic state; everything else is a neutral grey.
 */
export function statusColor(status: string, theme: Theme): { bg: string; fg: string; dot: string } {
  const c = theme.colors;
  switch (status) {
    case 'running':
      return { bg: c.accentSoft, fg: c.accent, dot: c.accent };
    case 'needs_you':
      return { bg: c.accent, fg: c.onAccent, dot: c.accent };
    case 'error':
      return { bg: c.dangerSoft, fg: c.danger, dot: c.danger };
    case 'starting':
      return { bg: c.surfaceAlt, fg: c.textMuted, dot: c.textFaint };
    case 'closed':
      return { bg: c.surfaceAlt, fg: c.textFaint, dot: c.textFaint };
    default:
      return { bg: c.surfaceAlt, fg: c.textMuted, dot: c.success };
  }
}
