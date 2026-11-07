/**
 * Changes tab state: the persisted diff word-wrap preference and a one-shot "open this diff" handoff
 * used by the file viewer's "Open in Changes" (the tab consumes it when it mounts/focuses).
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { plainStorage } from '../../state/storage';

export interface RequestedDiff {
  root: string;
  /** path relative to root */
  path: string;
  staged: boolean;
  requestedAt: number;
}

interface ChangesState {
  diffWrap: boolean;
  setDiffWrap: (wrap: boolean) => void;
  requested: RequestedDiff | null;
  requestDiff: (r: Omit<RequestedDiff, 'requestedAt'>) => void;
  clearRequested: () => void;
}

export const useChangesState = create<ChangesState>()(
  persist(
    (set) => ({
      diffWrap: true,
      setDiffWrap: (diffWrap) => set({ diffWrap }),
      requested: null,
      requestDiff: (r) => set({ requested: { ...r, requestedAt: Date.now() } }),
      clearRequested: () => set({ requested: null }),
    }),
    {
      name: 'changes',
      version: 1,
      storage: createJSONStorage(() => plainStorage),
      partialize: (s) => ({ diffWrap: s.diffWrap }),
    },
  ),
);
