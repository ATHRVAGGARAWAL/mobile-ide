/**
 * Recently used daemons, so re-pairing (new phone, revoked token, second laptop) is one tap
 * instead of retyping a tailnet URL. Persisted in plain storage — it holds no secrets, only URLs
 * plus the server name/version we last saw there.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { normalizeServerUrl } from '../state/settings';
import { plainStorage } from '../state/storage';

export interface KnownServer {
  /** normalised base URL (see `normalizeServerUrl`) */
  url: string;
  /** `serverName` reported by the daemon, when we have seen one */
  name: string | null;
  /** daemon version from its last successful probe or pairing */
  version: string | null;
  lastUsedAt: number;
}

export const MAX_KNOWN_SERVERS = 6;

interface ServerHistoryState {
  hydrated: boolean;
  servers: KnownServer[];
  remember: (s: { url: string; name?: string | null; version?: string | null }) => void;
  /** update name/version of an entry we already know; never adds one */
  touch: (url: string, info: { name?: string | null; version?: string | null }) => void;
  forget: (url: string) => void;
  setHydrated: () => void;
}

function sortRecent(list: KnownServer[]): KnownServer[] {
  return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, MAX_KNOWN_SERVERS);
}

export const useServerHistory = create<ServerHistoryState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      servers: [],
      remember: ({ url, name, version }) => {
        const key = normalizeServerUrl(url);
        if (!key) return;
        const existing = get().servers.find((s) => s.url === key);
        const entry: KnownServer = {
          url: key,
          name: name ?? existing?.name ?? null,
          version: version ?? existing?.version ?? null,
          lastUsedAt: Date.now(),
        };
        set({ servers: sortRecent([entry, ...get().servers.filter((s) => s.url !== key)]) });
      },
      touch: (url, info) => {
        const key = normalizeServerUrl(url);
        if (!key) return;
        const list = get().servers;
        if (!list.some((s) => s.url === key)) return;
        set({
          servers: list.map((s) => (s.url === key ? { ...s, name: info.name ?? s.name, version: info.version ?? s.version } : s)),
        });
      },
      forget: (url) => {
        const key = normalizeServerUrl(url);
        set({ servers: get().servers.filter((s) => s.url !== key) });
      },
      setHydrated: () => set({ hydrated: true }),
    }),
    {
      name: 'servers',
      version: 1,
      storage: createJSONStorage(() => plainStorage),
      partialize: (s) => ({ servers: s.servers }),
      onRehydrateStorage: () => (state, error) => {
        if (error) console.warn('[serverHistory] rehydrate failed', error);
        queueMicrotask(() => useServerHistory.getState().setHydrated());
        void state;
      },
    },
  ),
);

export function rememberServer(s: { url: string; name?: string | null; version?: string | null }): void {
  useServerHistory.getState().remember(s);
}

export function touchKnownServer(url: string, info: { name?: string | null; version?: string | null }): void {
  useServerHistory.getState().touch(url, info);
}

export function forgetKnownServer(url: string): void {
  useServerHistory.getState().forget(url);
}

/** Short label for a chip: the daemon's name when known, else its host. */
export function knownServerLabel(s: KnownServer): string {
  if (s.name) return s.name;
  try {
    return new URL(s.url).host;
  } catch {
    return s.url;
  }
}
