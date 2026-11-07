/**
 * Sessions + timelines. Envelopes are applied with core's pure reducer to a mutable
 * "live" timeline per session and published to React as snapshots once per frame,
 * so a burst of message.delta events costs one render.
 */
import {
  applyEnvelope,
  createTimeline,
  type ContentBlock,
  type ElicitationAction,
  type ElicitationContent,
  type EventEnvelope,
  type MideClient,
  type PermissionRequest,
  type SessionSummary,
  type TimelineState,
} from '@mobile-ide/core';
import { create } from 'zustand';
import { haptic } from '../lib/haptics';
import { uid } from '../lib/ids';
import { api, ApiError, errorMessage } from './api';
import { useConnection } from './connection';
import { useReadState } from './readState';
import { toast } from './toast';

export type OutboxItem =
  | { id: string; sessionId: string; kind: 'prompt'; blocks: ContentBlock[]; createdAt: number }
  | { id: string; sessionId: string; kind: 'permission'; permissionId: string; outcome: 'selected' | 'cancelled'; optionId?: string; createdAt: number }
  | { id: string; sessionId: string; kind: 'elicitation'; elicitationId: string; action: ElicitationAction; content?: ElicitationContent; createdAt: number };

export type SendState = 'idle' | 'sending' | 'queued' | 'error';

interface SessionsState {
  sessions: SessionSummary[];
  sessionsLoaded: boolean;
  sessionsLoading: boolean;
  sessionsError: string | null;
  /** immutable snapshots for rendering; the live copies live in `live` below */
  timelines: Record<string, TimelineState>;
  replayDone: Record<string, boolean>;
  /** sessionId -> why the daemon refused `subscribe` (e.g. not found); cleared by a retry or a successful replay */
  subscribeError: Record<string, { message: string; code?: string } | undefined>;
  /** cross-session inbox */
  pending: PermissionRequest[];
  pendingLoaded: boolean;
  outbox: OutboxItem[];
  /** permissionId -> local submission state */
  permissionSubmit: Record<string, SendState>;
  /** elicitationId -> local submission state */
  elicitationSubmit: Record<string, SendState>;
  /** sessionId -> last prompt send error */
  promptError: Record<string, string | undefined>;

  refreshSessions: () => Promise<void>;
  refreshPending: () => Promise<void>;
  setSessions: (list: SessionSummary[]) => void;
  upsertSession: (s: SessionSummary) => void;
  removeSession: (id: string) => void;
  ingest: (env: EventEnvelope) => void;
  onReplayDone: (sessionId: string, lastSeq: number) => void;
  /** the daemon answered a `subscribe` with an error frame: end the loading state and remember why */
  onSubscribeFailed: (sessionId: string, message: string, code?: string) => void;
  /** clear the error and subscribe again (a chat screen's Retry) */
  retrySubscribe: (sessionId: string) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  retainSession: (id: string) => void;
  releaseSession: (id: string) => void;
  markSeen: (id: string) => void;
  /** HTTP backfill when the socket is unavailable but REST works */
  backfill: (id: string) => Promise<void>;

  sendPrompt: (sessionId: string, blocks: ContentBlock[]) => Promise<SendState>;
  cancelTurn: (sessionId: string) => Promise<void>;
  respondPermission: (sessionId: string, permissionId: string, outcome: 'selected' | 'cancelled', optionId?: string) => Promise<SendState>;
  /** answer an agent question / URL hand-off; `content` = the form's answers for `accept` */
  respondElicitation: (sessionId: string, elicitationId: string, action: ElicitationAction, content?: ElicitationContent) => Promise<SendState>;
  setMode: (sessionId: string, modeId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  dropOutbox: (id: string) => void;
  flushOutbox: () => Promise<void>;
  /** Forget everything about the current daemon (used by "Forget this server"); also clears the module-private live timelines. */
  reset: () => void;
}

/** Mutable timelines (source of truth for the reducer). */
const live = new Map<string, TimelineState>();
const retainCounts = new Map<string, number>();
/** sessions subscribed on `subscribedClient`; meaningless for any other MideClient instance */
const subscribed = new Set<string>();
let subscribedClient: MideClient | null = null;
let queue: EventEnvelope[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushingOutbox = false;

function getLive(sessionId: string): TimelineState {
  let t = live.get(sessionId);
  if (!t) {
    t = createTimeline(sessionId);
    live.set(sessionId, t);
  }
  return t;
}

/**
 * Rendering snapshot. Items are shallow-cloned, not shared: the reducer mutates them in place (a tool card's status,
 * a permission's resolution), and a memoized component that received the same object twice could never see the
 * change — `React.memo` compares the previous props with the next ones, and both would point at the mutated object.
 * ToolCard's comparator relies on this (it compares fields, and the arrays/objects the reducer replaces).
 */
function snapshot(t: TimelineState): TimelineState {
  return {
    ...t,
    items: t.items.map((it) => ({ ...it })),
    pendingPermissions: t.pendingPermissions.slice(),
    pendingElicitations: t.pendingElicitations.slice(),
    availableModes: t.availableModes.slice(),
    commands: t.commands.slice(),
  };
}

function afterSeqFor(sessionId: string): number {
  return Math.max(0, live.get(sessionId)?.lastSeq ?? -1);
}

/**
 * `connection.restart()` (app foregrounded after >20 s, pairing changes) discards the MideClient and its
 * subscription map; the bookkeeping here must follow, or the `!subscribed.has()` guards would keep
 * permission-bearing sessions unsubscribed on the new socket forever.
 */
function bindSubscriptionsTo(client: MideClient): void {
  if (client === subscribedClient) return;
  subscribed.clear();
  subscribedClient = client;
  // Chat screens (and anything else holding a retain) stay subscribed across the swap; a reconnect of the
  // *same* client needs nothing here because MideClient replays its own subscription map.
  for (const id of retainCounts.keys()) {
    subscribed.add(id);
    client.subscribe(id, afterSeqFor(id));
  }
}

function subscribeNow(sessionId: string): void {
  const client = useConnection.getState().client;
  if (!client) return;
  bindSubscriptionsTo(client);
  subscribed.add(sessionId);
  client.subscribe(sessionId, afterSeqFor(sessionId));
}

function unsubscribeNow(sessionId: string): void {
  subscribed.delete(sessionId);
  useConnection.getState().client?.unsubscribe(sessionId);
}

function shouldStaySubscribed(sessionId: string, state: SessionsState): boolean {
  if ((retainCounts.get(sessionId) ?? 0) > 0) return true;
  if (state.pending.some((p) => p.sessionId === sessionId)) return true;
  const summary = state.sessions.find((s) => s.id === sessionId);
  return !!summary && summary.pendingPermissions > 0;
}

export const useSessions = create<SessionsState>((set, get) => {
  const publish = (ids: Iterable<string>) => {
    const timelines = { ...get().timelines };
    for (const id of ids) {
      const t = live.get(id);
      if (t) timelines[id] = snapshot(t);
    }
    set({ timelines });
  };

  const flush = () => {
    flushTimer = null;
    const batch = queue;
    queue = [];
    if (!batch.length) return;
    const touched = new Set<string>();
    let pending = get().pending;
    let pendingChanged = false;
    let sessions = get().sessions;
    let sessionsChanged = false;
    const replayDone = get().replayDone;

    for (const env of batch) {
      const t = getLive(env.sessionId);
      const before = t.lastSeq;
      try {
        applyEnvelope(t, env);
      } catch (err) {
        console.warn('[sessions] reducer failed on event', env.event.type, err);
        continue;
      }
      if (t.lastSeq === before) continue; // duplicate/out-of-order, ignored by reducer
      touched.add(env.sessionId);
      const liveEvent = replayDone[env.sessionId] === true;
      const e = env.event;
      switch (e.type) {
        case 'permission.requested':
          if (!pending.some((p) => p.permissionId === e.request.permissionId)) {
            pending = [...pending, e.request];
            pendingChanged = true;
          }
          if (liveEvent) void haptic.warning();
          break;
        case 'permission.resolved':
          if (pending.some((p) => p.permissionId === e.permissionId)) {
            pending = pending.filter((p) => p.permissionId !== e.permissionId);
            pendingChanged = true;
          }
          break;
        case 'elicitation.requested':
          if (liveEvent) void haptic.warning();
          break;
        case 'turn.ended':
          if (liveEvent) void haptic.success();
          break;
        case 'session.error':
          if (liveEvent && e.fatal) void haptic.error();
          break;
        default:
          break;
      }
      // Mirror status/title into the list so it updates even before sessions.changed lands.
      const idx = sessions.findIndex((s) => s.id === env.sessionId);
      if (idx >= 0) {
        const cur = sessions[idx]!;
        const patch: Partial<SessionSummary> = {};
        if (e.type === 'session.renamed') patch.title = e.title;
        if (t.status !== cur.status) patch.status = t.status;
        if (env.seq > cur.lastSeq) patch.lastSeq = env.seq;
        if (Object.keys(patch).length) {
          sessions = sessions.slice();
          // the summary's count is everything waiting for the user (the daemon counts questions in it too)
          sessions[idx] = {
            ...cur,
            ...patch,
            updatedAt: Math.max(cur.updatedAt, env.ts),
            pendingPermissions: t.pendingPermissions.length + t.pendingElicitations.length,
            pendingElicitations: t.pendingElicitations.length,
          };
          sessionsChanged = true;
        }
      }
    }
    const patch: Partial<SessionsState> = {};
    if (pendingChanged) patch.pending = pending;
    if (sessionsChanged) patch.sessions = sessions;
    if (Object.keys(patch).length) set(patch);
    if (touched.size) publish(touched);
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 16);
  };

  return {
    sessions: [],
    sessionsLoaded: false,
    sessionsLoading: false,
    sessionsError: null,
    timelines: {},
    replayDone: {},
    subscribeError: {},
    pending: [],
    pendingLoaded: false,
    outbox: [],
    permissionSubmit: {},
    elicitationSubmit: {},
    promptError: {},

    refreshSessions: async () => {
      if (get().sessionsLoading) return;
      set({ sessionsLoading: true });
      try {
        const list = await api.sessions();
        get().setSessions(list);
        set({ sessionsError: null, sessionsLoaded: true, sessionsLoading: false });
      } catch (err) {
        set({ sessionsError: errorMessage(err), sessionsLoaded: true, sessionsLoading: false });
      }
    },

    refreshPending: async () => {
      try {
        const pending = await api.pendingPermissions();
        set({ pending, pendingLoaded: true });
        for (const p of pending) if (!subscribed.has(p.sessionId)) subscribeNow(p.sessionId);
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'not_found')) console.warn('[sessions] pending permissions failed', err);
        set({ pendingLoaded: true });
      }
    },

    setSessions: (list) => {
      const sorted = list.slice().sort((a, b) => b.updatedAt - a.updatedAt);
      set({ sessions: sorted, sessionsLoaded: true, sessionsError: null });
      // keep sockets open for sessions that need attention so the inbox stays accurate
      for (const s of sorted) if (s.pendingPermissions > 0 && !subscribed.has(s.id)) subscribeNow(s.id);
      // and drop stale pending entries for sessions the server says are clean
      const known = new Set(sorted.map((s) => s.id));
      const pending = get().pending.filter((p) => {
        const s = sorted.find((x) => x.id === p.sessionId);
        return !known.has(p.sessionId) || (s && s.pendingPermissions > 0);
      });
      if (pending.length !== get().pending.length) set({ pending });
    },

    upsertSession: (s) => {
      const list = get().sessions.filter((x) => x.id !== s.id);
      list.unshift(s);
      set({ sessions: list.sort((a, b) => b.updatedAt - a.updatedAt) });
    },

    removeSession: (id) => {
      unsubscribeNow(id);
      live.delete(id);
      retainCounts.delete(id);
      const timelines = { ...get().timelines };
      delete timelines[id];
      set({
        sessions: get().sessions.filter((s) => s.id !== id),
        pending: get().pending.filter((p) => p.sessionId !== id),
        timelines,
      });
    },

    ingest: (env) => {
      queue.push(env);
      if (queue.length > 400) flush();
      else scheduleFlush();
    },

    onReplayDone: (sessionId, lastSeq) => {
      flush();
      const t = getLive(sessionId);
      if (t.lastSeq < lastSeq && lastSeq >= 0) t.lastSeq = Math.max(t.lastSeq, lastSeq);
      const errors = get().subscribeError;
      set({
        replayDone: { ...get().replayDone, [sessionId]: true },
        ...(errors[sessionId] ? { subscribeError: { ...errors, [sessionId]: undefined } } : {}),
      });
      publish([sessionId]);
    },

    onSubscribeFailed: (sessionId, message, code) => {
      if (!sessionId) return;
      subscribed.delete(sessionId);
      set({
        replayDone: { ...get().replayDone, [sessionId]: true },
        subscribeError: { ...get().subscribeError, [sessionId]: code ? { message, code } : { message } },
      });
      // a purged session is gone for good: drop it from the list and the inbox too
      if (code === 'not_found') {
        set({ sessions: get().sessions.filter((s) => s.id !== sessionId), pending: get().pending.filter((p) => p.sessionId !== sessionId) });
      }
    },

    retrySubscribe: (sessionId) => {
      set({
        replayDone: { ...get().replayDone, [sessionId]: false },
        subscribeError: { ...get().subscribeError, [sessionId]: undefined },
      });
      subscribeNow(sessionId);
    },

    onConnected: () => {
      // Called from inside the socket's onopen, before the client has sent `hello`; bind a tick later so a
      // fresh client's re-subscriptions follow it (and are not sent twice by the client's own replay loop).
      void Promise.resolve().then(() => {
        const client = useConnection.getState().client;
        if (client) bindSubscriptionsTo(client);
      });
      void get().refreshSessions();
      void get().refreshPending();
      void get().flushOutbox();
    },

    onDisconnected: () => {
      // Replay will run again on reconnect; suppress haptics until it completes.
      const rd: Record<string, boolean> = {};
      for (const k of Object.keys(get().replayDone)) rd[k] = false;
      set({ replayDone: rd });
    },

    retainSession: (id) => {
      retainCounts.set(id, (retainCounts.get(id) ?? 0) + 1);
      if (!get().timelines[id]) publish([id]);
      subscribeNow(id);
    },

    releaseSession: (id) => {
      const n = (retainCounts.get(id) ?? 1) - 1;
      if (n <= 0) retainCounts.delete(id);
      else retainCounts.set(id, n);
      if (n <= 0 && subscribed.has(id) && !shouldStaySubscribed(id, get())) unsubscribeNow(id);
    },

    markSeen: (id) => {
      const t = live.get(id);
      const summary = get().sessions.find((s) => s.id === id);
      const seq = Math.max(t?.lastSeq ?? -1, summary?.lastSeq ?? -1);
      if (seq >= 0) useReadState.getState().markSeen(id, seq);
    },

    backfill: async (id) => {
      try {
        const t = getLive(id);
        const envs = await api.events(id, Math.max(0, t.lastSeq), 500);
        for (const env of envs) applyEnvelope(t, env);
        publish([id]);
      } catch (err) {
        console.warn('[sessions] backfill failed', err);
      }
    },

    sendPrompt: async (sessionId, blocks) => {
      const client = useConnection.getState().client;
      set({ promptError: { ...get().promptError, [sessionId]: undefined } });
      if (!client || useConnection.getState().state !== 'open') {
        const item: OutboxItem = { id: uid('o'), sessionId, kind: 'prompt', blocks, createdAt: Date.now() };
        set({ outbox: [...get().outbox, item] });
        return 'queued';
      }
      try {
        await client.prompt(sessionId, blocks);
        return 'idle';
      } catch (err) {
        const msg = errorMessage(err);
        if (/not connected|connection closed/i.test(msg)) {
          const item: OutboxItem = { id: uid('o'), sessionId, kind: 'prompt', blocks, createdAt: Date.now() };
          set({ outbox: [...get().outbox, item] });
          return 'queued';
        }
        set({ promptError: { ...get().promptError, [sessionId]: msg } });
        return 'error';
      }
    },

    cancelTurn: async (sessionId) => {
      const client = useConnection.getState().client;
      if (!client) throw new Error('Not connected');
      await client.cancel(sessionId);
    },

    respondPermission: async (sessionId, permissionId, outcome, optionId) => {
      const t = getLive(sessionId);
      // optimistic: hide from the inbox and mark the card
      const idx = t.permissionIndex[permissionId];
      const item = idx !== undefined ? t.items[idx] : undefined;
      const prevResolved = item && item.kind === 'permission' ? item.resolved : undefined;
      if (item && item.kind === 'permission') item.resolved = { outcome, optionId };
      const prevPending = t.pendingPermissions;
      const prevInbox = get().pending;
      // known-pending here (timeline or REST inbox) → this answer retires exactly one of the summary's count
      const wasPending = prevPending.some((p) => p.permissionId === permissionId) || prevInbox.some((p) => p.permissionId === permissionId);
      t.pendingPermissions = t.pendingPermissions.filter((p) => p.permissionId !== permissionId);
      // Keep the list summary in step too: offline there is no permission.resolved round trip to correct
      // it, and a stale count would leave a phantom "Needs you" card, tab badge and pinned subscription.
      const prevSessions = get().sessions;
      const sessions = wasPending
        ? prevSessions.map((s) => (s.id === sessionId ? { ...s, pendingPermissions: Math.max(0, s.pendingPermissions - 1) } : s))
        : prevSessions;
      set({ pending: prevInbox.filter((p) => p.permissionId !== permissionId), sessions, permissionSubmit: { ...get().permissionSubmit, [permissionId]: 'sending' } });
      publish([sessionId]);

      const revert = () => {
        if (item && item.kind === 'permission') item.resolved = prevResolved;
        t.pendingPermissions = prevPending;
        set({ pending: prevInbox, sessions: prevSessions });
        publish([sessionId]);
      };

      const client = useConnection.getState().client;
      if (!client || useConnection.getState().state !== 'open') {
        const o: OutboxItem = { id: uid('o'), sessionId, kind: 'permission', permissionId, outcome, optionId, createdAt: Date.now() };
        set({ outbox: [...get().outbox, o], permissionSubmit: { ...get().permissionSubmit, [permissionId]: 'queued' } });
        return 'queued';
      }
      try {
        await client.respondPermission(sessionId, permissionId, outcome, optionId);
        set({ permissionSubmit: { ...get().permissionSubmit, [permissionId]: 'idle' } });
        return 'idle';
      } catch (err) {
        const msg = errorMessage(err);
        if (/not connected|connection closed/i.test(msg)) {
          const o: OutboxItem = { id: uid('o'), sessionId, kind: 'permission', permissionId, outcome, optionId, createdAt: Date.now() };
          set({ outbox: [...get().outbox, o], permissionSubmit: { ...get().permissionSubmit, [permissionId]: 'queued' } });
          return 'queued';
        }
        revert();
        set({ permissionSubmit: { ...get().permissionSubmit, [permissionId]: 'error' } });
        toast.error(`Couldn't send your answer: ${msg}`);
        return 'error';
      }
    },

    respondElicitation: async (sessionId, elicitationId, action, content) => {
      const t = getLive(sessionId);
      // optimistic: mark the card and take the question out of the pending set (mirrors respondPermission)
      const idx = t.elicitationIndex[elicitationId];
      const item = idx !== undefined ? t.items[idx] : undefined;
      const prevResolved = item && item.kind === 'elicitation' ? item.resolved : undefined;
      if (item && item.kind === 'elicitation') item.resolved = content !== undefined ? { action, content } : { action };
      const prevPending = t.pendingElicitations;
      const wasPending = prevPending.some((p) => p.elicitationId === elicitationId);
      t.pendingElicitations = prevPending.filter((p) => p.elicitationId !== elicitationId);
      const prevSessions = get().sessions;
      const sessions = wasPending
        ? prevSessions.map((s) =>
            s.id === sessionId
              ? { ...s, pendingPermissions: Math.max(0, s.pendingPermissions - 1), pendingElicitations: Math.max(0, (s.pendingElicitations ?? 1) - 1) }
              : s,
          )
        : prevSessions;
      set({ sessions, elicitationSubmit: { ...get().elicitationSubmit, [elicitationId]: 'sending' } });
      publish([sessionId]);

      const revert = () => {
        if (item && item.kind === 'elicitation') item.resolved = prevResolved;
        t.pendingElicitations = prevPending;
        set({ sessions: prevSessions });
        publish([sessionId]);
      };

      const client = useConnection.getState().client;
      const queue = (): SendState => {
        const o: OutboxItem = { id: uid('o'), sessionId, kind: 'elicitation', elicitationId, action, content, createdAt: Date.now() };
        set({ outbox: [...get().outbox, o], elicitationSubmit: { ...get().elicitationSubmit, [elicitationId]: 'queued' } });
        return 'queued';
      };
      if (!client || useConnection.getState().state !== 'open') return queue();
      try {
        await client.respondElicitation(sessionId, elicitationId, action, content);
        set({ elicitationSubmit: { ...get().elicitationSubmit, [elicitationId]: 'idle' } });
        return 'idle';
      } catch (err) {
        const msg = errorMessage(err);
        if (/not connected|connection closed/i.test(msg)) return queue();
        revert();
        set({ elicitationSubmit: { ...get().elicitationSubmit, [elicitationId]: 'error' } });
        toast.error(`Couldn't send your answer: ${msg}`);
        return 'error';
      }
    },

    setMode: async (sessionId, modeId) => {
      const client = useConnection.getState().client;
      if (!client) throw new Error('Not connected');
      await client.setMode(sessionId, modeId);
      const t = getLive(sessionId);
      t.modeId = modeId;
      publish([sessionId]);
    },

    renameSession: async (sessionId, title) => {
      await api.renameSession(sessionId, title);
      const t = getLive(sessionId);
      t.title = title;
      set({ sessions: get().sessions.map((s) => (s.id === sessionId ? { ...s, title } : s)) });
      publish([sessionId]);
    },

    closeSession: async (sessionId) => {
      await api.closeSession(sessionId);
      get().removeSession(sessionId);
      useReadState.getState().forget(sessionId);
    },

    dropOutbox: (id) => set({ outbox: get().outbox.filter((o) => o.id !== id) }),

    reset: () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      queue = [];
      live.clear();
      retainCounts.clear();
      subscribed.clear();
      subscribedClient = null;
      set({
        sessions: [],
        sessionsLoaded: false,
        sessionsLoading: false,
        sessionsError: null,
        timelines: {},
        replayDone: {},
        subscribeError: {},
        pending: [],
        pendingLoaded: false,
        outbox: [],
        permissionSubmit: {},
        elicitationSubmit: {},
        promptError: {},
      });
    },

    flushOutbox: async () => {
      // Never concurrently: a second pass would re-send items the first is still awaiting.
      if (flushingOutbox) return;
      flushingOutbox = true;
      try {
        for (;;) {
          const client = useConnection.getState().client;
          if (!client || useConnection.getState().state !== 'open') return;
          const o = get().outbox[0];
          if (!o) return;
          try {
            if (o.kind === 'prompt') await client.prompt(o.sessionId, o.blocks);
            else if (o.kind === 'permission') await client.respondPermission(o.sessionId, o.permissionId, o.outcome, o.optionId);
            else await client.respondElicitation(o.sessionId, o.elicitationId, o.action, o.content);
            get().dropOutbox(o.id);
            if (o.kind === 'permission') set({ permissionSubmit: { ...get().permissionSubmit, [o.permissionId]: 'idle' } });
            else if (o.kind === 'elicitation') set({ elicitationSubmit: { ...get().elicitationSubmit, [o.elicitationId]: 'idle' } });
          } catch (err) {
            const msg = errorMessage(err);
            if (/not connected|connection closed/i.test(msg)) return; // try again on next connect
            get().dropOutbox(o.id);
            if (o.kind === 'prompt') set({ promptError: { ...get().promptError, [o.sessionId]: msg } });
            else if (o.kind === 'permission') set({ permissionSubmit: { ...get().permissionSubmit, [o.permissionId]: 'error' } });
            else set({ elicitationSubmit: { ...get().elicitationSubmit, [o.elicitationId]: 'error' } });
            toast.error(
              o.kind === 'prompt' ? `Queued prompt failed: ${msg}` : o.kind === 'permission' ? `Queued permission answer failed: ${msg}` : `Queued answer failed: ${msg}`,
            );
          }
        }
      } finally {
        flushingOutbox = false;
      }
    },
  };
});

/** Selector helpers */
export function selectTimeline(id: string) {
  return (s: SessionsState): TimelineState | undefined => s.timelines[id];
}
export function selectSession(id: string) {
  return (s: SessionsState): SessionSummary | undefined => s.sessions.find((x) => x.id === id);
}
export function selectOutboxCount(id: string) {
  return (s: SessionsState): number => s.outbox.filter((o) => o.sessionId === id && o.kind === 'prompt').length;
}
