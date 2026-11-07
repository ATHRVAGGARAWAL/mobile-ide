/**
 * Pure rules for what the Files tab lists and in which order (no React):
 *  - `.git` is never shown; other dotfiles/dot-dirs only behind the "Show hidden" toggle
 *  - folders first, then a natural, case-insensitive order (file2 < file10)
 */
import type { FsEntry } from '@mobile-ide/core';

const ALWAYS_HIDDEN = new Set(['.git']);

export function isAlwaysHidden(name: string): boolean {
  return ALWAYS_HIDDEN.has(name);
}

export function isDotfile(name: string): boolean {
  return name.startsWith('.');
}

const CHUNK = /(\d+)|(\D+)/g;

function chunksOf(s: string): string[] {
  return s.match(CHUNK) ?? [];
}

/** ICU-like ordering of a chunk by its first character: punctuation < digits < letters. */
function classOf(chunk: string): number {
  const c = chunk.charCodeAt(0);
  if (c >= 48 && c <= 57) return 1;
  if (c > 127) return 2; // non-ASCII: treat as letters
  const ch = chunk.charAt(0);
  return ch.toLowerCase() !== ch.toUpperCase() ? 2 : 0;
}

/** Natural, case-insensitive comparison that behaves the same on Hermes, JSC and browsers (no Intl). */
export function compareNatural(a: string, b: string): number {
  if (a === b) return 0;
  const ca = chunksOf(a);
  const cb = chunksOf(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i] ?? '';
    const y = cb[i] ?? '';
    const cx = classOf(x);
    const cy = classOf(y);
    if (cx !== cy) return cx - cy; // ".env" < "_util" < "1.md" < "a.txt"
    const xd = cx === 1;
    const yd = cy === 1;
    if (xd && yd) {
      const xs = x.replace(/^0+(?=\d)/, '');
      const ys = y.replace(/^0+(?=\d)/, '');
      if (xs.length !== ys.length) return xs.length - ys.length;
      if (xs !== ys) return xs < ys ? -1 : 1;
      if (x.length !== y.length) return x.length - y.length; // fewer leading zeros first
      continue;
    }
    const xl = x.toLowerCase();
    const yl = y.toLowerCase();
    if (xl !== yl) return xl < yl ? -1 : 1;
  }
  if (ca.length !== cb.length) return ca.length - cb.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Folders first, natural order inside each group. Stable and non-mutating. */
export function sortEntries(entries: readonly FsEntry[]): FsEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ad = a.e.kind === 'dir' ? 0 : 1;
      const bd = b.e.kind === 'dir' ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return compareNatural(a.e.name, b.e.name) || a.i - b.i;
    })
    .map((x) => x.e);
}

export interface VisibleEntries {
  visible: FsEntry[];
  /** dotfiles hidden by the toggle (never counts `.git`, which is simply not a thing here) */
  hiddenCount: number;
  dirs: number;
  files: number;
}

/** Apply the hide rules; `.git` is dropped unconditionally. */
export function filterEntries(entries: readonly FsEntry[], showHidden: boolean): VisibleEntries {
  const visible: FsEntry[] = [];
  let hiddenCount = 0;
  let dirs = 0;
  let files = 0;
  for (const e of entries) {
    if (isAlwaysHidden(e.name)) continue;
    if (!showHidden && isDotfile(e.name)) {
      hiddenCount++;
      continue;
    }
    visible.push(e);
    if (e.kind === 'dir') dirs++;
    else files++;
  }
  return { visible, hiddenCount, dirs, files };
}

/** Sort + filter in one step, for the screen. */
export function prepareEntries(entries: readonly FsEntry[] | undefined, showHidden: boolean): VisibleEntries | undefined {
  if (!entries) return undefined;
  return filterEntries(sortEntries(entries), showHidden);
}
