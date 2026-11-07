/**
 * Owns the single MideClient (reconnecting WebSocket) for the paired daemon.
 * Wires events into the sessions store and exposes connection state for the UI.
 */
import { MideClient, type ConnectionState } from '@mobile-ide/core';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import { create } from 'zustand';
import { emitFsChange } from '../lib/liveFs';
import { isPaired, useSettings } from './settings';
import { useSessions } from './sessions';
import { toast } from './toast';

export const CLIENT_NAME = 'mobile-ide-app';
export const CLIENT_VERSION = '0.1.0';

interface ConnectionStore {
  state: ConnectionState;
  detail: string | null;
  /** token was rejected by the daemon (close code 4401) */
  unauthorized: boolean;
  client: MideClient | null;
  lastOpenAt: number | null;
  start: () => void;
  stop: () => void;
  restart: () => void;
}

export const useConnection = create<ConnectionStore>((set, get) => ({
  state: 'closed',
  detail: null,
  unauthorized: false,
  client: null,
  lastOpenAt: null,
  start: () => {
    const settings = useSettings.getState();
    get().stop();
    if (!isPaired(settings) || !settings.serverUrl || !settings.token) return;
    const client = new MideClient({
      baseUrl: settings.serverUrl,
      token: settings.token,
      clientName: `${CLIENT_NAME}/${Platform.OS}`,
      clientVersion: CLIENT_VERSION,
      onEvent: (env) => useSessions.getState().ingest(env),
      onReplayDone: (sessionId, lastSeq) => useSessions.getState().onReplayDone(sessionId, lastSeq),
      onSessions: (sessions) => useSessions.getState().setSessions(sessions),
      onFsChanged: emitFsChange,
      onState: (state, detail) => {
        const prev = get().state;
        set({
          state,
          detail: detail ?? null,
          unauthorized: detail === 'unauthorized' ? true : state === 'open' ? false : get().unauthorized,
        });
        // Connect-time work (refresh, outbox flush) runs once per genuine transition into 'open' only.
        if (state === 'open' && prev !== 'open') {
          set({ lastOpenAt: Date.now() });
          useSessions.getState().onConnected();
        } else if (state !== 'open' && prev === 'open') {
          useSessions.getState().onDisconnected();
        }
      },
      onServerError: (message, code) => {
        console.warn('[connection] server error', code ?? '', message);
        // `subscribe <id>: session not found` (purged elsewhere, DB swapped) would otherwise leave the chat spinning forever
        const failedSubscribe = /^subscribe (\S+): (.*)$/.exec(message);
        if (failedSubscribe) {
          useSessions.getState().onSubscribeFailed(failedSubscribe[1] ?? '', failedSubscribe[2] ?? message, code);
          return;
        }
        if (code === 'protocol_version') toast.error(`Server/app protocol mismatch: ${message}`);
        else toast.error(message);
      },
      maxBackoffMs: 15_000,
      pingIntervalMs: 20_000,
    });
    set({ client, unauthorized: false, detail: null });
    try {
      client.connect();
      client.watchSessionList();
    } catch (err) {
      console.warn('[connection] connect failed', err);
      set({ state: 'closed', detail: err instanceof Error ? err.message : 'connect failed' });
    }
  },
  stop: () => {
    const c = get().client;
    if (c) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    set({ client: null, state: 'closed', detail: null });
  },
  restart: () => get().start(),
}));

let bootstrapped = false;
/** Idempotent: call once from the root layout. Reacts to pairing changes and app foregrounding. */
export function bootstrapConnection(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  const startIfPaired = () => {
    const s = useSettings.getState();
    if (isPaired(s)) useConnection.getState().start();
    else useConnection.getState().stop();
  };

  if (useSettings.getState().hydrated) startIfPaired();
  let lastKey = keyOf();
  useSettings.subscribe((s) => {
    const k = keyOf();
    if (k !== lastKey || (s.hydrated && !useConnection.getState().client && isPaired(s))) {
      lastKey = k;
      startIfPaired();
    }
  });

  let backgroundedAt: number | null = null;
  AppState.addEventListener('change', (status: AppStateStatus) => {
    if (status === 'background' || status === 'inactive') {
      if (backgroundedAt === null) backgroundedAt = Date.now();
      return;
    }
    if (status === 'active') {
      const away = backgroundedAt ? Date.now() - backgroundedAt : 0;
      backgroundedAt = null;
      const conn = useConnection.getState();
      if (!conn.client) {
        startIfPaired();
        return;
      }
      // iOS silently kills sockets in the background; a fresh socket is cheaper than waiting for ping timeouts.
      if (conn.state !== 'open' || away > 20_000) conn.restart();
      else void useSessions.getState().refreshSessions();
    }
  });

  if (Platform.OS === 'web') {
    const g = globalThis as unknown as { addEventListener?: (t: string, cb: () => void) => void };
    g.addEventListener?.('online', () => {
      const conn = useConnection.getState();
      if (conn.client && conn.state !== 'open') conn.restart();
    });
  }
}

function keyOf(): string {
  const s = useSettings.getState();
  return `${s.hydrated ? 1 : 0}|${s.serverUrl ?? ''}|${s.token ?? ''}`;
}
