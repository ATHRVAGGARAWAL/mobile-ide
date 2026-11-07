/** Helpers shared by DOM components: palette lookup and a CSS variable block. No react-native imports. */
import { darkColors, lightColors, type ThemeColors } from '../theme/palette';

export type DomThemeName = 'light' | 'dark';

export function paletteFor(theme: DomThemeName): ThemeColors {
  return theme === 'light' ? lightColors : darkColors;
}

export const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
export const SANS_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export function cssVars(theme: DomThemeName): string {
  const c = paletteFor(theme);
  return `
    --bg: ${c.bg}; --surface: ${c.surface}; --surface-alt: ${c.surfaceAlt}; --surface-pressed: ${c.surfacePressed}; --border: ${c.border}; --border-strong: ${c.borderStrong};
    --text: ${c.text}; --text-muted: ${c.textMuted}; --text-faint: ${c.textFaint}; --accent: ${c.accent}; --accent-soft: ${c.accentSoft}; --on-accent: ${c.onAccent};
    --code-bg: ${c.codeBg}; --code-text: ${c.codeText}; --diff-add: ${c.diffAdd}; --diff-add-text: ${c.diffAddText};
    --diff-del: ${c.diffDel}; --diff-del-text: ${c.diffDelText}; --danger: ${c.danger}; --success: ${c.success}; --warning: ${c.warning};
    --mono: ${MONO_STACK}; --sans: ${SANS_STACK};
  `;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const nav = (globalThis as unknown as { navigator?: { clipboard?: { writeText: (s: string) => Promise<void> } } }).navigator;
    if (nav?.clipboard) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const doc = (globalThis as unknown as { document?: Document }).document;
    if (!doc) return false;
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    doc.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
