/**
 * Files tab state: the folder open per project and the "show hidden files" toggle (both persisted, so
 * reopening the app lands where you left off) plus an in-memory listing cache so walking back up the
 * tree is instant.
 */
import type { FsEntry } from '@mobile-ide/core';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { plainStorage } from '../../state/storage';

interface FilesState {
  /** project root -> relative folder path ('' = project root) */
  pathByRoot: Record<string, string>;
  /** list dotfiles and dot-directories (`.git` stays hidden regardless) */
  showHidden: boolean;
  setPath: (root: string, path: string) => void;
  setShowHidden: (show: boolean) => void;
  toggleShowHidden: () => void;
}

const MAX_ROOTS = 50;

export const useFilesState = create<FilesState>()(
  persist(
    (set) => ({
      pathByRoot: {},
      showHidden: false,
      setPath: (root, path) =>
        set((s) => {
          if ((s.pathByRoot[root] ?? '') === path) return s;
          const next = { ...s.pathByRoot, [root]: path };
          const keys = Object.keys(next);
          if (keys.length > MAX_ROOTS) for (const k of keys.slice(0, keys.length - MAX_ROOTS)) delete next[k];
          return { pathByRoot: next };
        }),
      setShowHidden: (showHidden) => set({ showHidden }),
      toggleShowHidden: () => set((s) => ({ showHidden: !s.showHidden })),
    }),
    {
      name: 'files',
      version: 2,
      storage: createJSONStorage(() => plainStorage),
      partialize: (s) => ({ pathByRoot: s.pathByRoot, showHidden: s.showHidden }),
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Partial<Pick<FilesState, 'pathByRoot' | 'showHidden'>>;
        return { pathByRoot: p.pathByRoot ?? {}, showHidden: p.showHidden ?? false };
      },
    },
  ),
);

const treeCache = new Map<string, FsEntry[]>();
const MAX_CACHED_TREES = 60;
/** NUL never appears in a filesystem path, so it is a safe root/path separator. */
const SEP = String.fromCharCode(0);

function treeKey(root: string, path: string): string {
  return root + SEP + path;
}

export function getCachedTree(root: string, path: string): FsEntry[] | undefined {
  return treeCache.get(treeKey(root, path));
}

export function setCachedTree(root: string, path: string, entries: FsEntry[]): void {
  const key = treeKey(root, path);
  treeCache.delete(key); // re-insert so Map order == recency
  treeCache.set(key, entries);
  if (treeCache.size > MAX_CACHED_TREES) {
    const oldest = treeCache.keys().next();
    if (!oldest.done) treeCache.delete(oldest.value);
  }
}

export function clearTreeCache(root?: string): void {
  if (root === undefined) {
    treeCache.clear();
    return;
  }
  for (const key of Array.from(treeCache.keys())) if (key.startsWith(root + SEP)) treeCache.delete(key);
}
