/**
 * Reconnecting WebSocket client with per-session resume.
 * Works in browsers, React Native and Node (>=22, global WebSocket).
 */
import { API, WS_AUTH_SUBPROTOCOL_PREFIX, wsUrl } from './api.js';
import {
  PROTOCOL_VERSION,
  ServerFrame,
  type ClientFrame,
  type ContentBlock,
  type ElicitationAction,
  type ElicitationContent,
  type EventEnvelope,
  type FsChange,
  type SessionSummary,
} from './protocol.js';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'reconnecting';

export interface MideClientOptions {
  baseUrl: string;
  token: string;
  clientName: string;
  clientVersion: string;
  /** called when the server sends an event for a subscribed session */
  onEvent: (env: EventEnvelope) => void;
  onReplayDone?: (sessionId: string, lastSeq: number) => void;
  onSessions?: (sessions: SessionSummary[]) => void;
  /** entries changed in a directory this client watches (`watchDir`) */
  onFsChanged?: (change: FsChange) => void;
  onState?: (state: ConnectionState, detail?: string) => void;
  /**
   * A server `error` frame (e.g. `subscribe <id>: session not found`, a protocol-version mismatch).
   * These are not connection-state changes and are never reported through `onState`.
   */
  onServerError?: (message: string, code?: string) => void;
  /** override for environments where global WebSocket is not the one to use */
  WebSocketImpl?: typeof WebSocket;
  /** ms; exponential backoff cap */
  maxBackoffMs?: number;
  /** send a ping this often while open */
  pingIntervalMs?: number;
  /** Budget for opening a socket, or receiving a reply to a heartbeat (defaults: 10 s each). */
  connectionTimeoutMs?: number;
  pongTimeoutMs?: number;
  /**
   * ms before a request (prompt/cancel/permission.respond/set_mode) rejects with 'request timed out'.
   * Default 90 s: the daemon acks `prompt` only once the agent is running, and a cold adapter start
   * (respawn after a crash, `npx` downloading it) has a 60 s budget on the server side.
   */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

/** '' for the root, otherwise a relative path without leading/trailing slashes — the form the daemon echoes back. */
export function normalizeWatchDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function dirWatchKey(root: string, dir: string): string {
  return `${root}\0${normalizeWatchDir(dir)}`;
}

/** Every request-shaped client frame, minus the requestId the client assigns. */
type RequestFrame = Extract<ClientFrame, { requestId: string }>;
type RequestFrameBody = RequestFrame extends infer F ? (F extends RequestFrame ? Omit<F, 'requestId'> : never) : never;

interface Pending {
  resolve: (ok: true) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MideClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'closed';
  private backoff = 500;
  private closedByUser = false;
  private pending = new Map<string, Pending>();
  /** sessionId -> lastSeq the client has applied */
  private subscriptions = new Map<string, number>();
  private watchSessions = false;
  /** `${root}\0${dir}` of every directory watch to (re-)establish while open */
  private readonly dirWatches = new Set<string>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reqCounter = 0;

  constructor(private readonly opts: MideClientOptions) {}

  getState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.ws || this.reconnectTimer) return;
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.releaseSocket();
    this.setState('closed');
  }

  /** Retire immediately: a dead network may never finish the WebSocket close handshake. */
  private releaseSocket(): void {
    this.stopPing();
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'client closed');
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('connection closed'));
    }
    this.pending.clear();
  }

  /** Subscribe (or re-subscribe after reconnect) from the given seq. */
  subscribe(sessionId: string, afterSeq: number): void {
    this.subscriptions.set(sessionId, afterSeq);
    if (this.state === 'open') this.send({ type: 'subscribe', sessionId, afterSeq });
  }

  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    if (this.state === 'open') this.send({ type: 'unsubscribe', sessionId });
  }

  /** Tell the client the latest seq it has applied so reconnects resume correctly. */
  noteSeq(sessionId: string, seq: number): void {
    const cur = this.subscriptions.get(sessionId);
    if (cur !== undefined && seq > cur) this.subscriptions.set(sessionId, seq);
  }

  watchSessionList(): void {
    this.watchSessions = true;
    if (this.state === 'open') this.send({ type: 'sessions.watch' });
  }

  /**
   * Watch a directory (non-recursive) under `root` for `onFsChanged`; re-established on every reconnect until
   * `unwatchDir`. `dir` is relative to the root ('' = the root). Resolves when the daemon has the watch in place.
   */
  watchDir(root: string, dir: string): Promise<true> {
    const key = dirWatchKey(root, dir);
    const fresh = !this.dirWatches.has(key);
    this.dirWatches.add(key);
    if (this.state !== 'open' || !fresh) return Promise.resolve(true);
    return this.request({ type: 'fs.watch', root, dir: normalizeWatchDir(dir) });
  }

  unwatchDir(root: string, dir: string): void {
    if (!this.dirWatches.delete(dirWatchKey(root, dir))) return;
    if (this.state === 'open') void this.request({ type: 'fs.unwatch', root, dir: normalizeWatchDir(dir) }).catch(() => undefined);
  }

  /** every directory currently watched, as [root, dir] */
  watchedDirs(): [string, string][] {
    return [...this.dirWatches].map((k) => {
      const i = k.indexOf('\0');
      return [k.slice(0, i), k.slice(i + 1)];
    });
  }

  prompt(sessionId: string, blocks: ContentBlock[]): Promise<true> {
    return this.request({ type: 'prompt', sessionId, blocks });
  }

  cancel(sessionId: string): Promise<true> {
    return this.request({ type: 'cancel', sessionId });
  }

  respondPermission(sessionId: string, permissionId: string, outcome: 'selected' | 'cancelled', optionId?: string): Promise<true> {
    return this.request({ type: 'permission.respond', sessionId, permissionId, outcome, optionId });
  }

  setMode(sessionId: string, modeId: string): Promise<true> {
    return this.request({ type: 'set_mode', sessionId, modeId });
  }

  /** Answer an elicitation (agent question / URL hand-off); `content` carries the form answers for `accept`. */
  respondElicitation(sessionId: string, elicitationId: string, action: ElicitationAction, content?: ElicitationContent): Promise<true> {
    return this.request({ type: 'elicitation.respond', sessionId, elicitationId, action, content });
  }

  // ------------------------------------------------------------------ internals
  private open(): void {
    const Impl = this.opts.WebSocketImpl ?? (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
    if (!Impl) throw new Error('No WebSocket implementation available');
    this.setState(this.backoff > 500 ? 'reconnecting' : 'connecting');
    const url = wsUrl(this.opts.baseUrl, API.ws);
    // Token travels as a subprotocol so browsers can authenticate the upgrade.
    const ws = new Impl(url, [WS_AUTH_SUBPROTOCOL_PREFIX + this.opts.token]);
    this.ws = ws;
    this.connectionTimer = setTimeout(() => this.recover(ws), this.opts.connectionTimeoutMs ?? 10_000);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.connectionTimer) clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
      this.backoff = 500;
      this.setState('open');
      this.send({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        clientName: this.opts.clientName,
        clientVersion: this.opts.clientVersion,
      });
      for (const [sessionId, afterSeq] of this.subscriptions) this.send({ type: 'subscribe', sessionId, afterSeq });
      if (this.watchSessions) this.send({ type: 'sessions.watch' });
      for (const [root, dir] of this.watchedDirs()) void this.request({ type: 'fs.watch', root, dir }).catch(() => undefined);
      this.startPing();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws === ws) this.handleMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.releaseSocket();
      if (this.closedByUser) return;
      if (ev.code === 4401) {
        this.setState('closed', 'unauthorized');
        return; // token rejected; do not loop
      }
      this.scheduleReconnect();
    };
  }

  private recover(ws: WebSocket): void {
    if (this.ws !== ws || this.closedByUser) return;
    this.releaseSocket();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    const jitter = Math.random() * 250;
    const delay = Math.min(this.backoff, this.opts.maxBackoffMs ?? 15_000) + jitter;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private handleMessage(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = ServerFrame.parse(JSON.parse(raw));
    } catch {
      return; // ignore malformed frames
    }
    switch (frame.type) {
      case 'welcome':
        break;
      case 'event': {
        const env = frame.envelope;
        this.noteSeq(env.sessionId, env.seq);
        this.opts.onEvent(env);
        break;
      }
      case 'replay.done':
        this.noteSeq(frame.sessionId, frame.lastSeq);
        this.opts.onReplayDone?.(frame.sessionId, frame.lastSeq);
        break;
      case 'ack': {
        const p = this.pending.get(frame.requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(frame.requestId);
          frame.ok ? p.resolve(true) : p.reject(new Error(frame.error ?? 'request failed'));
        }
        break;
      }
      case 'sessions.changed':
        this.opts.onSessions?.(frame.sessions);
        break;
      case 'fs.changed':
        this.opts.onFsChanged?.(frame.change);
        break;
      case 'pong':
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        break;
      case 'error':
        this.opts.onServerError?.(frame.message, frame.code);
        break;
    }
  }

  private request(frame: RequestFrameBody): Promise<true> {
    const requestId = `r${++this.reqCounter}-${Date.now().toString(36)}`;
    const full = { ...frame, requestId } as ClientFrame;
    return new Promise<true>((resolve, reject) => {
      if (this.state !== 'open') {
        reject(new Error('not connected'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('request timed out'));
      }, this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(full);
    });
  }

  private send(frame: ClientFrame): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || this.pongTimer) return;
      this.pongTimer = setTimeout(() => this.recover(ws), this.opts.pongTimeoutMs ?? 10_000);
      this.send({ type: 'ping', ts: Date.now() });
    }, this.opts.pingIntervalMs ?? 20_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private setState(s: ConnectionState, detail?: string): void {
    this.state = s;
    this.opts.onState?.(s, detail);
  }
}
