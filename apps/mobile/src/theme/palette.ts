/**
 * Colour palettes shared by native components and DOM components.
 * No react-native imports here so DOM bundles stay thin.
 *
 * Warm neutrals by design: every surface, border and text tone is a paper/graphite neutral and there is exactly one
 * accent hue (`ACCENT`). The semantic slots stay in the type so components keep working, but they resolve to
 * neutrals or the accent — `success`/`info` are neutral text tones, `warning` *is* the accent ("needs your
 * attention"), and `danger` is the only other chromatic value, reserved for errors and destructive actions.
 * Diff colours keep a muted green/red because that convention carries meaning of its own.
 */
export interface ThemeColors {
  bg: string;
  bgElevated: string;
  surface: string;
  surfaceAlt: string;
  surfacePressed: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentSoft: string;
  onAccent: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;
  userBubble: string;
  onUserBubble: string;
  codeBg: string;
  codeText: string;
  diffAdd: string;
  diffAddText: string;
  diffDel: string;
  diffDelText: string;
  overlay: string;
  tabBar: string;
  shadow: string;
}

/** The single accent hue. Change these two values to re-tint the whole app. */
export const ACCENT = { dark: '#e9ad52', light: '#96601b' } as const;

const neutral = {
  50: '#f5f4ef',
  100: '#eeeee7',
  200: '#dce0d4',
  300: '#c2cab9',
  400: '#b0b6a8',
  500: '#5b6453',
  600: '#525b49',
  700: '#454b40',
  800: '#30342c',
  900: '#22251f',
  950: '#121311',
} as const;

export const lightColors: ThemeColors = {
  bg: neutral[50],
  bgElevated: '#ffffff',
  surface: '#ffffff',
  surfaceAlt: neutral[100],
  surfacePressed: neutral[200],
  border: neutral[200],
  borderStrong: neutral[300],
  text: '#242722',
  textMuted: neutral[600],
  textFaint: neutral[500],
  accent: ACCENT.light,
  accentSoft: '#f6ebd7',
  onAccent: '#ffffff',
  success: neutral[700],
  successSoft: neutral[100],
  warning: ACCENT.light,
  warningSoft: '#f6ebd7',
  danger: '#b42318',
  dangerSoft: '#fde8e6',
  info: neutral[600],
  infoSoft: neutral[100],
  userBubble: '#eeeee7',
  onUserBubble: neutral[950],
  codeBg: neutral[100],
  codeText: neutral[800],
  diffAdd: '#e8f5ec',
  diffAddText: '#1f7a3a',
  diffDel: '#fbeaea',
  diffDelText: '#a83232',
  overlay: 'rgba(18,19,17,0.45)',
  tabBar: '#ffffff',
  shadow: 'rgba(36,39,34,0.14)',
};

export const darkColors: ThemeColors = {
  bg: neutral[950],
  bgElevated: '#181a17',
  surface: '#1a1c19',
  surfaceAlt: neutral[900],
  surfacePressed: '#2a2e27',
  border: neutral[800],
  borderStrong: neutral[700],
  text: '#f3f2ed',
  textMuted: neutral[400],
  textFaint: '#939b89',
  accent: ACCENT.dark,
  accentSoft: '#342a1b',
  onAccent: '#211b10',
  success: neutral[300],
  successSoft: neutral[900],
  warning: ACCENT.dark,
  warningSoft: '#342a1b',
  danger: '#ef6f6c',
  dangerSoft: '#2a1214',
  info: neutral[400],
  infoSoft: neutral[900],
  userBubble: '#252921',
  onUserBubble: neutral[50],
  codeBg: '#151713',
  codeText: neutral[300],
  diffAdd: '#0f1c14',
  diffAddText: '#86c79a',
  diffDel: '#261317',
  diffDelText: '#e08a8a',
  overlay: 'rgba(0,0,0,0.65)',
  tabBar: '#181a17',
  shadow: 'rgba(0,0,0,0.6)',
};
