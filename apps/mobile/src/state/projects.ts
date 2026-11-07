/** Project list from /api/projects plus the currently selected project root (shared by Files/Changes/Terminal). */
import type { ProjectInfo } from '@mobile-ide/core';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { api, errorMessage } from './api';
import { plainStorage } from './storage';

interface ProjectsState {
  projects: ProjectInfo[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  selectedRoot: string | null;
  /** stable per-project terminal ids so tmux sessions survive app restarts */
  terminalIds: Record<string, string>;
  load: () => Promise<void>;
  select: (root: string | null) => void;
  openTerminal: (root: string, id: string) => void;
  terminalIdFor: (root: string) => string;
  resetTerminal: (root: string) => void;
}

export const useProjects = create<ProjectsState>()(
  persist(
    (set, get) => ({
      projects: [],
      loading: false,
      loaded: false,
      error: null,
      selectedRoot: null,
      terminalIds: {},
      load: async () => {
        if (get().loading) return;
        set({ loading: true });
        try {
          const projects = await api.projects();
          const selected = get().selectedRoot;
          const stillThere = selected && projects.some((p) => p.root === selected);
          set({
            projects,
            loaded: true,
            error: null,
            loading: false,
            selectedRoot: stillThere || (selected && get().terminalIds[selected]) ? selected : (projects[0]?.root ?? selected),
          });
        } catch (err) {
          set({ error: errorMessage(err), loading: false, loaded: true });
        }
      },
      select: (selectedRoot) => set({ selectedRoot }),
      openTerminal: (root, id) => set((s) => ({ selectedRoot: root, terminalIds: { ...s.terminalIds, [root]: id } })),
      terminalIdFor: (root) => {
        const existing = get().terminalIds[root];
        if (existing) return existing;
        const slug =
          root
            .split('/')
            .filter(Boolean)
            .slice(-1)[0]
            ?.replace(/[^a-zA-Z0-9_-]/g, '-')
            .slice(0, 24) ?? 'term';
        const id = `${slug}-${Math.random().toString(36).slice(2, 8)}`;
        set((s) => ({ terminalIds: { ...s.terminalIds, [root]: id } }));
        return id;
      },
      resetTerminal: (root) =>
        set((s) => {
          const next = { ...s.terminalIds };
          delete next[root];
          return { terminalIds: next };
        }),
    }),
    {
      name: 'projects',
      version: 1,
      storage: createJSONStorage(() => plainStorage),
      partialize: (s) => ({ selectedRoot: s.selectedRoot, terminalIds: s.terminalIds }),
    },
  ),
);

export function useSelectedProject(): ProjectInfo | null {
  return useProjects((s) => s.projects.find((p) => p.root === s.selectedRoot) ?? (s.selectedRoot ? synthesize(s.selectedRoot) : null));
}

/**
 * Placeholder for a selected root the daemon has not listed (yet). Cached per root so the selector
 * above returns a stable snapshot — a fresh object per call makes useSyncExternalStore loop forever.
 */
const synthesized = new Map<string, ProjectInfo>();
function synthesize(root: string): ProjectInfo {
  let p = synthesized.get(root);
  if (!p) {
    p = { root, name: root.split('/').filter(Boolean).pop() ?? root, isGit: false, sessionCount: 0 };
    synthesized.set(root, p);
  }
  return p;
}
