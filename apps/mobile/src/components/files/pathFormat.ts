/**
 * Pure helpers for showing paths on a phone-width screen (no React, no react-native imports so
 * they can be unit-tested with plain Node).
 */

/** Approximate advance width of one glyph in the app's monospace stacks, as a fraction of the font size. */
export const MONO_ADVANCE = 0.62;

/** How many monospace characters fit in `widthPx` at `fontSize`. Never negative. */
export function monoCharsThatFit(widthPx: number, fontSize: number): number {
  if (!(widthPx > 0) || !(fontSize > 0)) return 0;
  return Math.max(0, Math.floor(widthPx / (fontSize * MONO_ADVANCE)));
}

/** `abcdef…uvwxyz`: keep the start and the end, drop the middle. */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return '';
  if (max === 1) return '…';
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return s.slice(0, head) + '…' + (tail > 0 ? s.slice(s.length - tail) : '');
}

export interface DisplayPath {
  /** directory part including its trailing slash ('' when there is none) */
  dir: string;
  /** last segment */
  base: string;
  truncated: boolean;
}

export function splitPathParts(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/');
  return i === -1 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/**
 * Fit `path` into `max` characters. The file name survives whole whenever it can; the directory part
 * loses characters from its middle first (`src/comp…/files/FileViewer.tsx`). When even the name does
 * not fit, the whole path is squeezed from the middle so the extension stays visible.
 */
export function truncatePathMiddle(path: string, max: number): DisplayPath {
  const { dir, base } = splitPathParts(path);
  if (path.length <= max) return { dir, base, truncated: false };
  if (!(max > 0)) return { dir: '', base: '', truncated: true };
  if (!base) return { dir: truncateMiddle(path, max), base: '', truncated: true };
  // The name itself does not fit: squeeze the whole path from the middle (extension survives).
  if (!dir || base.length > max) return { dir: '', base: truncateMiddle(path, max), truncated: true };
  // Only the name fits: drop the directory entirely rather than cutting into the name.
  if (base.length + 3 > max) return { dir: base.length + 2 <= max ? '…/' : base.length + 1 <= max ? '…' : '', base, truncated: true };
  // room for the ellipsis + at least one char on each side of it, and the trailing slash always survives
  const keep = max - base.length - 1;
  const tail = Math.max(1, Math.floor(keep / 2));
  const head = keep - tail;
  const shortDir = dir.slice(0, head) + '…' + dir.slice(dir.length - tail);
  return { dir: shortDir, base, truncated: true };
}

/** Thousands-separated count that does not depend on Intl being present. */
export function formatCount(n: number): string {
  const s = Math.round(Math.abs(n)).toString();
  const out = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${out}` : out;
}
