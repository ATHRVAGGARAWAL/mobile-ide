/** Per-session "last seen seq" markers; drive unread badges. Persisted in plain storage. */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { plainStorage } from './storage';

interface ReadState {
  lastSeen: Record<string, number>;
  markSeen: (sessionId: string, seq: number) => void;
  forget: (sessionId: string) => void;
}

export const useReadState = create<ReadState>()(
  persist(
    (set) => ({
      lastSeen: {},
      markSeen: (sessionId, seq) =>
        set((s) => {
          const cur = s.lastSeen[sessionId] ?? -1;
          if (seq <= cur) return s;
          const next = { ...s.lastSeen, [sessionId]: seq };
          // keep the map bounded
          const keys = Object.keys(next);
          if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete next[k];
          return { lastSeen: next };
        }),
      forget: (sessionId) =>
        set((s) => {
          if (!(sessionId in s.lastSeen)) return s;
          const next = { ...s.lastSeen };
          delete next[sessionId];
          return { lastSeen: next };
        }),
    }),
    { name: 'read-state', version: 1, storage: createJSONStorage(() => plainStorage) },
  ),
);

export function isUnread(lastSeen: Record<string, number>, sessionId: string, lastSeq: number): boolean {
  const seen = lastSeen[sessionId];
  if (seen === undefined) return lastSeq > 0;
  return lastSeq > seen;
}
