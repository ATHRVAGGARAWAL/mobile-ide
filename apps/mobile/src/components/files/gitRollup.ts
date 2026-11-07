/**
 * Folder git-status roll-up: turn the flat `/api/git/status` entry list into per-directory counts
 * ("2 modified · 1 untracked") so the tree shows what changed inside a folder, not just that it did.
 * Pure, no React.
 */
import type { GitStatus } from '@mobile-ide/core';

export interface FolderRollup {
  total: number;
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  untracked: number;
  conflicts: number;
  /** porcelain-style letters for `gitStatusMeta()` (colour + badge letter) */
  letters: string;
  /** e.g. "2 modified · 1 untracked" */
  label: string;
}

export type FolderRollupLookup = (dirPath: string) => FolderRollup | null;

type Bucket = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicts';

function classify(index: string, worktree: string): Bucket | null {
  const both = index + worktree;
  if (index === '!' || worktree === '!') return null; // ignored
  if (index === 'U' || worktree === 'U' || both === 'AA' || both === 'DD') return 'conflicts';
  if (index === '?' || worktree === '?') return 'untracked';
  if (both.includes('D')) return 'deleted';
  if (both.includes('R') || both.includes('C')) return 'renamed';
  if (both.includes('A')) return 'added';
  return 'modified';
}

type Counts = Record<Bucket, number>;

function emptyCounts(): Counts {
  return { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicts: 0 };
}

const ORDER: { key: Bucket; word: string }[] = [
  { key: 'conflicts', word: 'conflict' },
  { key: 'modified', word: 'modified' },
  { key: 'added', word: 'added' },
  { key: 'deleted', word: 'deleted' },
  { key: 'renamed', word: 'renamed' },
  { key: 'untracked', word: 'untracked' },
];

function finish(c: Counts): FolderRollup {
  const total = c.modified + c.added + c.deleted + c.renamed + c.untracked + c.conflicts;
  const parts: string[] = [];
  for (const { key, word } of ORDER) {
    const n = c[key];
    if (!n) continue;
    parts.push(key === 'conflicts' ? `${n} ${n === 1 ? 'conflict' : 'conflicts'}` : `${n} ${word}`);
  }
  const label = parts.length <= 2 ? parts.join(' · ') : `${total} changed`;
  let letters = 'M';
  if (c.conflicts) letters = 'UU';
  else if (c.untracked === total) letters = '??';
  else if (c.deleted === total) letters = 'D';
  else if (c.added === total) letters = 'A';
  else if (c.renamed === total) letters = 'R';
  return { total, ...c, letters, label };
}

/** Build a lookup from relative directory path ('' = root) to its roll-up. */
export function buildFolderRollups(status: GitStatus | undefined | null): FolderRollupLookup {
  if (!status || status.entries.length === 0) return () => null;
  const byDir = new Map<string, Counts>();
  for (const e of status.entries) {
    const bucket = classify(e.index, e.worktree);
    if (!bucket) continue;
    const parts = e.path.split('/').filter(Boolean);
    // every ancestor, including the root ('')
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      let c = byDir.get(dir);
      if (!c) {
        c = emptyCounts();
        byDir.set(dir, c);
      }
      c[bucket]++;
    }
  }
  const cache = new Map<string, FolderRollup | null>();
  return (dirPath: string) => {
    const key = dirPath.replace(/^\.?\/+|\/+$/g, '');
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const counts = byDir.get(key);
    const out = counts ? finish(counts) : null;
    cache.set(key, out);
    return out;
  };
}
