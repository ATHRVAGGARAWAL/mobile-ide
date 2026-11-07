/**
 * WebSocket endpoints. Owns BOTH upgrades on the shared http.Server:
 *
 *   /ws           the ClientFrame/ServerFrame protocol — hello → welcome; subscribe → replay from the
 *                 event log in batches, `replay.done`, then live fan-out; sessions.watch → sessions.changed;
 *                 prompt / cancel / permission.respond / elicitation.respond / set_mode → ack {requestId}.
 *   /ws/terminal  a tmux-backed pty — binary frames ⇄ pty bytes, JSON text frames for control
 *                 ({type:'resize',cols,rows}; also {type:'input',data} and {type:'ping'}). Non-JSON text is
 *                 treated as raw input for attach-addon style clients. Scrollback is sent first.
 *
 * Auth happens on the upgrade: bearer token as the `mide.bearer.<token>` subprotocol (echoed back so
 * browsers accept the handshake) or `?token=`. No token → HTTP 401 before the handshake. Token present
 * but rejected → the handshake completes, then close 4401 so clients can tell "unauthorized" from
 * "network" (core's MideClient stops retrying on 4401). Origin, when present, must be the request host,
 * loopback, or under the configured publicUrl host.
 *
 * Liveness: server pings every 25 s and drops a socket after 2 missed pongs; revoked devices are cut.
 */
import fs from 'node:fs';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { API, ClientFrame, PROTOCOL_VERSION, type EventEnvelope, type ServerFrame } from '@mobile-ide/core';
import { authenticate, credentialsFromRequest, extractToken, selectedSubprotocol } from './authn.js';
import type { AttachWebSockets, ServerContext, TerminalSession, UpgradeHandler } from './context.js';
import type { DeviceRow } from './db.js';
import type { Unsubscribe } from './events.js';
import { DirWatchRegistry, MAX_WATCHES_PER_CLIENT, WatchLimitError } from './fswatch.js';
import { errorInfo, type Logger } from './log.js';
import { displayPath, resolveRoot, resolveUnder } from './paths.js';
import { originAllowed as httpOriginAllowed } from './routes/origin.js';

// ------------------------------------------------------------------ tunables
const PING_INTERVAL_MS = 25_000;
const MAX_MISSED_PONGS = 2;
const SESSIONS_THROTTLE_MS = 200;
/** prompts may carry base64 images; the same server handles both paths */
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
/** pause a replay while this much is still unsent to the peer */
const REPLAY_HIGH_WATER_BYTES = 1024 * 1024;
/**
 * Drop a /ws client whose live feed backs up this far. Safe because every event is persisted: the client
 * reconnects and resumes with `subscribe {afterSeq}`, which is far cheaper than holding the backlog in RAM
 * (the heartbeat alone needs 50–75 s to notice a stalled peer, and its ping queues behind the backlog).
 */
const LIVE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** drop a terminal viewer that cannot keep up with its pty */
const TERMINAL_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** bytes of keystrokes accepted before the pty is attached */
const TERMINAL_INPUT_QUEUE_BYTES = 64 * 1024;
const SHUTDOWN_GRACE_MS = 2_000;
const TERMINAL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Application close codes (4xxx). 4401 is the one core's clients look for. */
const CLOSE_BAD_REQUEST = 4400;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_NOT_FOUND = 4404;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_INTERNAL = 1011;

// ------------------------------------------------------------------ helpers
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function rawToString(data: RawData): string {
  return rawToBuffer(data).toString('utf8');
}

/** RFC 6455 caps close reasons at 123 bytes of UTF-8. */
function closeReason(reason: string): string {
  let out = reason.replace(/[\r\n]+/g, ' ');
  while (Buffer.byteLength(out, 'utf8') > 123) out = out.slice(0, -1);
  return out;
}

function zodIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '$'}: ${i.message}`)
    .join('; ');
}

/** Human message for an ack/error frame. HttpError subclasses already carry a user-facing message. */
function describeError(err: unknown): string {
  if (err instanceof z.ZodError) return `invalid request: ${zodIssues(err)}`;
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function watchKey(root: string, dir: string): string {
  return `${root}\0${dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
}

function requestIdOf(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const rid = (json as { requestId?: unknown }).requestId;
  return typeof rid === 'string' && rid.length > 0 ? rid : null;
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(',')[0]?.trim() || undefined;
}

/**
 * Parse the request target of an upgrade as a path. llhttp accepts targets such as `//[` or `/\[`, which
 * `new URL(target, base)` treats as protocol-relative and then throws on (bad IPv6 authority) — inside
 * the 'upgrade' listener that would be an uncaught exception, i.e. a remotely triggerable daemon crash.
 */
function parseTarget(raw: string | undefined): URL | null {
  const target = raw ?? '/';
  if (!target.startsWith('/') || /^\/[/\\]/.test(target)) return null;
  try {
    return new URL(target, 'http://localhost');
  } catch {
    return null;
  }
}

/**
 * Browsers always send Origin on WebSocket upgrades; native apps and Node clients usually do not.
 * No Origin → allowed. Otherwise the same allowlist as the REST CORS layer (routes/origin.ts) — the
 * request's own host (or X-Forwarded-Host behind tailscale serve), loopback / private / tailnet hosts
 * and the configured publicUrl host — so a browser that may call the API may also open the socket.
 */
function originAllowed(req: http.IncomingMessage, publicUrl: string | null): boolean {
  const origin = firstHeader(req.headers.origin);
  if (!origin) return true;
  for (const requestHost of [firstHeader(req.headers.host), firstHeader(req.headers['x-forwarded-host'])]) {
    if (httpOriginAllowed(origin, { requestHost: requestHost ?? null, publicUrl })) return true;
  }
  return false;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
};

/** Answer a raw upgrade socket with an HTTP error and hang up (mirrors ws's own abortHandshake). */
function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
  if (socket.destroyed) return;
  try {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const body = JSON.stringify({ error: message, code });
    const lines = [
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
      'Connection: close',
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
    ];
    if (status === 401) lines.push('WWW-Authenticate: Bearer realm="mobile-ide"');
    const fallback = setTimeout(() => socket.destroy(), 2_000);
    fallback.unref?.();
    socket.once('finish', () => {
      clearTimeout(fallback);
      socket.destroy();
    });
    socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
  } catch {
    socket.destroy();
  }
}

// ------------------------------------------------------------------ liveness
/** One interval for every socket: ping each OPEN client, terminate after MAX_MISSED_PONGS silent rounds. */
class Heartbeat {
  private readonly clients = new Map<WebSocket, { missed: number; deviceId: string }>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly ctx: ServerContext,
    private readonly log: Logger,
  ) {
    this.timer = setInterval(() => this.tick(), PING_INTERVAL_MS);
    this.timer.unref?.();
  }

  add(ws: WebSocket, deviceId: string): void {
    this.clients.set(ws, { missed: 0, deviceId });
    ws.on('pong', () => this.touch(ws));
    ws.on('close', () => this.clients.delete(ws));
  }

  /** Any inbound traffic proves the peer is alive, not just pongs. */
  touch(ws: WebSocket): void {
    const c = this.clients.get(ws);
    if (c) c.missed = 0;
  }

  private tick(): void {
    for (const [ws, c] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (c.missed >= MAX_MISSED_PONGS) {
        this.log.info('ws.timeout', { device: c.deviceId, missed: c.missed });
        ws.terminate();
        continue;
      }
      if (this.deviceRevoked(c.deviceId)) {
        this.log.info('ws.device_revoked', { device: c.deviceId });
        ws.close(CLOSE_UNAUTHORIZED, 'device revoked');
        continue;
      }
      c.missed++;
      try {
        ws.ping();
      } catch (err) {
        this.log.warn('ws.ping_failed', { device: c.deviceId, ...errorInfo(err) });
        ws.terminate();
      }
    }
  }

  private deviceRevoked(deviceId: string): boolean {
    try {
      const d = this.ctx.db.getDevice(deviceId);
      return !d || d.revokedAt !== null;
    } catch {
      return false; // never drop a client because of a transient DB hiccup
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.clients.clear();
  }
}

// ------------------------------------------------------------------ /ws hub
/**
 * Server-side state shared by every /ws connection: the bus subscriptions (one per process, not per
 * socket), a sessionId → connections index for live fan-out, and the throttled sessions.changed broadcast.
 */
class EventsHub {
  readonly connections = new Set<EventsConnection>();
  /** shared, reference-counted directory watchers behind `fs.watch` frames */
  readonly dirWatches = new DirWatchRegistry();
  private readonly bySession = new Map<string, Set<EventsConnection>>();
  private readonly unsubs: Unsubscribe[] = [];
  private sessionsTimer: NodeJS.Timeout | null = null;
  private lastSessionsBroadcast = 0;

  constructor(
    private readonly ctx: ServerContext,
    private readonly log: Logger,
  ) {
    this.unsubs.push(ctx.bus.onEvent((env) => this.onEvent(env)));
    this.unsubs.push(ctx.bus.onSessionsChanged(() => this.scheduleSessionsBroadcast()));
  }

  add(conn: EventsConnection): void {
    this.connections.add(conn);
  }

  remove(conn: EventsConnection): void {
    this.connections.delete(conn);
    for (const [sessionId, set] of this.bySession) {
      set.delete(conn);
      if (set.size === 0) this.bySession.delete(sessionId);
    }
  }

  watch(sessionId: string, conn: EventsConnection): void {
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    set.add(conn);
  }

  unwatch(sessionId: string, conn: EventsConnection): void {
    const set = this.bySession.get(sessionId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.bySession.delete(sessionId);
  }

  /** Persisted → broadcast. Serialize once per event, not once per socket. */
  private onEvent(env: EventEnvelope): void {
    const set = this.bySession.get(env.sessionId);
    if (!set || set.size === 0) return;
    let json: string | null = null;
    for (const conn of set) {
      try {
        json ??= JSON.stringify({ type: 'event', envelope: env } satisfies ServerFrame);
        conn.onLiveEvent(env, json);
      } catch (err) {
        this.log.warn('ws.fanout_failed', { sessionId: env.sessionId, seq: env.seq, ...errorInfo(err) });
      }
    }
  }

  /** Coalesce bursts to one sessions.changed per SESSIONS_THROTTLE_MS, first one goes out promptly. */
  private scheduleSessionsBroadcast(): void {
    if (this.sessionsTimer) return;
    const wait = Math.max(0, SESSIONS_THROTTLE_MS - (Date.now() - this.lastSessionsBroadcast));
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = null;
      this.broadcastSessions();
    }, wait);
    this.sessionsTimer.unref?.();
  }

  private broadcastSessions(): void {
    this.lastSessionsBroadcast = Date.now();
    const watchers = [...this.connections].filter((c) => c.watching);
    if (watchers.length === 0) return;
    const json = this.sessionsFrame();
    if (!json) return;
    for (const c of watchers) c.sendRaw(json);
  }

  sessionsFrame(): string | null {
    try {
      return JSON.stringify({ type: 'sessions.changed', sessions: this.ctx.sessions.listSummaries() } satisfies ServerFrame);
    } catch (err) {
      this.log.error('ws.sessions_frame_failed', errorInfo(err));
      return null;
    }
  }

  /** Who is connected: the `hello.clientName` of every /ws socket (null before its hello). */
  clients(): { clientName: string | null; deviceId: string }[] {
    return [...this.connections].map((c) => ({ clientName: c.clientName, deviceId: c.device.id }));
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    this.sessionsTimer = null;
    this.dirWatches.closeAll();
    this.connections.clear();
    this.bySession.clear();
  }
}

// ------------------------------------------------------------------ /ws connection
interface Subscription {
  sessionId: string;
  /** highest seq this socket has been sent for the session */
  cursor: number;
  /** live events are ignored while replaying; the post-replay lastSeq check picks them up */
  replaying: boolean;
}

class EventsConnection {
  watching = false;
  /** from the client's hello (`mide-studio`, `mobile-ide-app/ios`, …) */
  clientName: string | null = null;
  readonly log: Logger;
  private readonly subs = new Map<string, Subscription>();
  /** `${root}\0${dir}` → end this connection's share of the directory watch */
  private readonly fsWatches = new Map<string, Unsubscribe>();
  private helloSeen = false;

  constructor(
    readonly ws: WebSocket,
    readonly device: DeviceRow,
    private readonly ctx: ServerContext,
    private readonly hub: EventsHub,
    private readonly heartbeat: Heartbeat,
    log: Logger,
  ) {
    this.log = log.child({ device: device.id });
    hub.add(this);
    heartbeat.add(ws, device.id);
    ws.on('message', (data, isBinary) => {
      this.heartbeat.touch(ws);
      this.onMessage(data, isBinary);
    });
    ws.on('error', (err) => this.log.warn('ws.socket_error', errorInfo(err)));
    ws.on('close', (code, reason) => {
      this.hub.remove(this);
      this.subs.clear();
      this.watching = false;
      for (const end of this.fsWatches.values()) end();
      this.fsWatches.clear();
      this.log.info('ws.closed', { code, reason: reason.toString() });
    });
    this.log.info('ws.connected', { deviceName: device.name });
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try {
        this.ws.close(code, closeReason(reason));
      } catch {
        this.ws.terminate();
      }
    }
  }

  // ------------------------------------------------------------ outbound
  send(frame: ServerFrame): void {
    this.sendRaw(JSON.stringify(frame));
  }

  sendRaw(json: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > LIVE_MAX_BUFFERED_BYTES) {
      this.log.warn('ws.slow_client', { buffered: this.ws.bufferedAmount });
      this.ws.terminate();
      return;
    }
    try {
      this.ws.send(json);
    } catch (err) {
      this.log.warn('ws.send_failed', errorInfo(err));
    }
  }

  private ack(requestId: string, ok: boolean, error?: string): void {
    this.send(error === undefined ? { type: 'ack', requestId, ok } : { type: 'ack', requestId, ok, error });
  }

  private sendError(message: string, code?: string): void {
    this.send(code === undefined ? { type: 'error', message } : { type: 'error', message, code });
  }

  // ------------------------------------------------------------ inbound
  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.sendError('binary frames are not accepted on /ws', 'bad_frame');
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(rawToString(data));
    } catch {
      this.sendError('frame is not valid JSON', 'bad_frame');
      return;
    }
    // Core's TimelineState starts at lastSeq -1 but the schema says afterSeq >= 0; accept -1 as "from the start".
    if (
      typeof json === 'object' &&
      json !== null &&
      (json as { type?: unknown }).type === 'subscribe' &&
      (json as { afterSeq?: unknown }).afterSeq === -1
    ) {
      (json as { afterSeq: number }).afterSeq = 0;
    }
    const parsed = ClientFrame.safeParse(json);
    if (!parsed.success) {
      const message = `invalid frame: ${zodIssues(parsed.error)}`;
      const rid = requestIdOf(json);
      // A request-shaped frame gets a failed ack so the client's promise settles now, not at its timeout.
      if (rid) this.ack(rid, false, message);
      else this.sendError(message, 'bad_frame');
      return;
    }
    try {
      const out = this.dispatch(parsed.data);
      if (out) out.catch((err) => this.log.error('ws.dispatch_failed', { type: parsed.data.type, ...errorInfo(err) }));
    } catch (err) {
      this.log.error('ws.dispatch_failed', { type: parsed.data.type, ...errorInfo(err) });
    }
  }

  private dispatch(frame: ClientFrame): Promise<void> | void {
    switch (frame.type) {
      case 'hello': {
        this.helloSeen = true;
        this.clientName = frame.clientName;
        this.send({
          type: 'welcome',
          protocolVersion: PROTOCOL_VERSION,
          serverVersion: this.ctx.version,
          serverName: this.ctx.serverName,
          deviceId: this.device.id,
        });
        this.log.info('ws.hello', {
          clientName: frame.clientName,
          clientVersion: frame.clientVersion,
          protocolVersion: frame.protocolVersion,
        });
        if (frame.protocolVersion !== PROTOCOL_VERSION) {
          this.sendError(`server speaks protocol ${PROTOCOL_VERSION}, client sent ${frame.protocolVersion}`, 'protocol_version');
        }
        return;
      }
      case 'ping':
        this.send({ type: 'pong', ts: frame.ts });
        return;
      case 'subscribe':
        return this.subscribe(frame.sessionId, frame.afterSeq);
      case 'unsubscribe':
        this.subs.delete(frame.sessionId); // an in-flight replay notices and stops
        this.hub.unwatch(frame.sessionId, this);
        return;
      case 'sessions.watch': {
        this.watching = true;
        const json = this.hub.sessionsFrame();
        if (json) this.sendRaw(json);
        else this.sendError('could not list sessions', 'internal');
        return;
      }
      case 'prompt':
        return this.request(frame.requestId, async () => {
          await this.ctx.sessions.prompt(frame.sessionId, frame.blocks);
        });
      case 'cancel':
        return this.request(frame.requestId, () => this.ctx.sessions.cancel(frame.sessionId, this.device.id));
      case 'permission.respond':
        return this.request(frame.requestId, () => {
          this.ctx.sessions.respondPermission(frame.sessionId, frame.permissionId, frame.outcome, frame.optionId, this.device.id);
        });
      case 'elicitation.respond':
        return this.request(frame.requestId, () => {
          this.ctx.sessions.respondElicitation(frame.sessionId, frame.elicitationId, frame.action, frame.content, this.device.id);
        });
      case 'set_mode':
        return this.request(frame.requestId, () => this.ctx.sessions.setMode(frame.sessionId, frame.modeId));
      case 'fs.watch':
        return this.request(frame.requestId, () => this.watchDir(frame.root, frame.dir));
      case 'fs.unwatch':
        return this.request(frame.requestId, () => {
          const end = this.fsWatches.get(watchKey(frame.root, frame.dir));
          if (end) {
            end();
            this.fsWatches.delete(watchKey(frame.root, frame.dir));
          }
        });
    }
  }

  // ------------------------------------------------------------ live filesystem
  /**
   * Start (or keep) a directory watch for this socket. The path goes through the same policy as /api/fs; the
   * notification echoes the client's own `root`/`dir` so it can key its state by them. Idempotent per (root, dir).
   */
  private watchDir(root: string, dir: string): void {
    const key = watchKey(root, dir);
    if (this.fsWatches.has(key)) return;
    if (this.fsWatches.size >= MAX_WATCHES_PER_CLIENT)
      throw new WatchLimitError(`too many watched directories for one client (${MAX_WATCHES_PER_CLIENT})`);
    const rootReal = resolveRoot(this.ctx.policy, root);
    const realDir = resolveUnder(this.ctx.policy, rootReal, dir);
    const shownDir = displayPath(rootReal, realDir);
    const end = this.hub.dirWatches.watch(realDir, root, shownDir, (change) => {
      if (change.gone) this.fsWatches.delete(key);
      this.send({ type: 'fs.changed', change });
    });
    this.fsWatches.set(key, end);
    this.log.debug('ws.fs_watch', { root, dir: shownDir, watches: this.fsWatches.size });
  }

  private async request(requestId: string, fn: () => Promise<void> | void): Promise<void> {
    if (!this.helloSeen) this.log.debug('ws.request_before_hello', { requestId });
    try {
      await fn();
      this.ack(requestId, true);
    } catch (err) {
      this.log.warn('ws.request_failed', { requestId, ...errorInfo(err) });
      this.ack(requestId, false, describeError(err));
    }
  }

  // ------------------------------------------------------------ subscribe / replay
  /**
   * Replay `seq > afterSeq` from the log in batches (yielding between batches so one long history
   * neither starves other sockets nor buffers unboundedly), close the gap with whatever was committed
   * meanwhile, send replay.done, then go live. Live events for this session are ignored while the
   * replay runs — every event is persisted before it is broadcast, so the final lastSeq check sees them.
   *
   * `afterSeq` 0 is inclusive: the log starts at seq 0 (`session.created`, which carries the modes the
   * chat header needs) while the schema forbids -1, so the app sends max(0, lastSeq) for a fresh
   * timeline. A client that really has seq 0 receives one duplicate, which the core reducer drops.
   */
  private async subscribe(sessionId: string, afterSeq: number): Promise<void> {
    const start = afterSeq === 0 ? -1 : afterSeq;
    const sub: Subscription = { sessionId, cursor: start, replaying: true };
    this.subs.set(sessionId, sub);
    this.hub.watch(sessionId, this);
    const batch = Math.max(1, this.ctx.config.config.limits.eventReplayBatch);
    const active = () => this.subs.get(sessionId) === sub && this.ws.readyState === WebSocket.OPEN;
    try {
      const known = this.ctx.db.lastSeq(sessionId);
      if (known < start) {
        // client is ahead of the log (restored backup?) — resume from what we have rather than stall forever
        this.log.warn('ws.subscribe_ahead', { sessionId, afterSeq, lastSeq: known });
        sub.cursor = known;
      }
      let more = true;
      while (more && active()) {
        const rows = this.ctx.sessions.events(sessionId, sub.cursor, batch);
        for (const env of rows) this.deliver(sub, env);
        more = rows.length === batch;
        if (more) await this.yieldForDrain();
      }
      // Gap guard: anything appended while we were yielding.
      while (active() && this.ctx.db.lastSeq(sessionId) > sub.cursor) {
        const rows = this.ctx.sessions.events(sessionId, sub.cursor, batch);
        if (rows.length === 0) break;
        for (const env of rows) this.deliver(sub, env);
        if (rows.length === batch) await this.yieldForDrain();
      }
      if (!active()) return;
      sub.replaying = false;
      this.send({ type: 'replay.done', sessionId, lastSeq: sub.cursor });
      this.log.debug('ws.replay_done', { sessionId, afterSeq, lastSeq: sub.cursor });
    } catch (err) {
      if (this.subs.get(sessionId) === sub) {
        this.subs.delete(sessionId);
        this.hub.unwatch(sessionId, this);
      }
      this.log.warn('ws.subscribe_failed', { sessionId, afterSeq, ...errorInfo(err) });
      this.sendError(`subscribe ${sessionId}: ${describeError(err)}`, errorCode(err) ?? 'subscribe_failed');
    }
  }

  /** Let other work run and wait for the peer to drain before pushing the next batch. */
  private async yieldForDrain(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    while (this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount > REPLAY_HIGH_WATER_BYTES) {
      await sleep(25); // a stalled peer is eventually terminated by the heartbeat, which ends this loop
    }
  }

  /** Live path. Called by the hub for every persisted event of a watched session. */
  onLiveEvent(env: EventEnvelope, json: string): void {
    const sub = this.subs.get(env.sessionId);
    if (!sub || sub.replaying) return;
    this.deliver(sub, env, json);
  }

  private deliver(sub: Subscription, env: EventEnvelope, json?: string): void {
    if (env.seq <= sub.cursor) return; // duplicate (replay/live overlap)
    if (!sub.replaying && env.seq > sub.cursor + 1) this.fillGap(sub, env.seq);
    this.sendRaw(json ?? JSON.stringify({ type: 'event', envelope: env } satisfies ServerFrame));
    if (env.seq > sub.cursor) sub.cursor = env.seq;
  }

  /** Live delivery skipped some seqs (should not happen: single writer, emit-after-commit). Heal from the log. */
  private fillGap(sub: Subscription, upTo: number): void {
    try {
      const missing = this.ctx.sessions.events(sub.sessionId, sub.cursor, upTo - sub.cursor - 1);
      for (const env of missing) {
        if (env.seq >= upTo) break;
        this.send({ type: 'event', envelope: env });
        sub.cursor = env.seq;
      }
      if (missing.length) this.log.warn('ws.gap_filled', { sessionId: sub.sessionId, count: missing.length, upTo });
    } catch (err) {
      this.log.warn('ws.gap_fill_failed', { sessionId: sub.sessionId, ...errorInfo(err) });
    }
  }
}

// ------------------------------------------------------------------ /ws/terminal connection
const TerminalControl = z.discriminatedUnion('type', [
  z.object({ type: z.literal('resize'), cols: z.number(), rows: z.number() }),
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({ type: z.literal('ping'), ts: z.number().optional() }),
]);
type TerminalControl = z.infer<typeof TerminalControl>;
const TERMINAL_CONTROL_TYPES = new Set<string>(TerminalControl.options.map((o) => o.shape.type.value));

/**
 * Text frames: a JSON object whose `type` is one of ours is a control message (`'invalid'` when its
 * fields are malformed); anything else — including pasted JSON — is raw input. Swallowing keystrokes
 * is the worse failure, so only known control types are intercepted.
 */
function parseTerminalControl(text: string): TerminalControl | 'invalid' | null {
  if (!text.trimStart().startsWith('{')) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const type = (json as { type?: unknown }).type;
  if (typeof type !== 'string' || !TERMINAL_CONTROL_TYPES.has(type)) return null;
  const parsed = TerminalControl.safeParse(json);
  return parsed.success ? parsed.data : 'invalid';
}

function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  const c = Number.isFinite(cols) ? Math.round(cols) : 80;
  const r = Number.isFinite(rows) ? Math.round(rows) : 24;
  return { cols: Math.min(500, Math.max(2, c)), rows: Math.min(300, Math.max(2, r)) };
}

class TerminalConnection {
  private log: Logger;
  private term: TerminalSession | null = null;
  private readonly unsubs: Unsubscribe[] = [];
  private closed = false;
  /** keystrokes and the latest resize that arrived before the pty was attached */
  private readonly inputQueue: Buffer[] = [];
  private inputQueued = 0;
  private pendingResize: { cols: number; rows: number } | null = null;

  constructor(
    private readonly ws: WebSocket,
    readonly device: DeviceRow,
    private readonly ctx: ServerContext,
    heartbeat: Heartbeat,
    log: Logger,
  ) {
    this.log = log.child({ device: device.id });
    heartbeat.add(ws, device.id);
    ws.on('message', (data, isBinary) => {
      heartbeat.touch(ws);
      this.onMessage(data, isBinary);
    });
    ws.on('error', (err) => this.log.warn('ws.terminal.socket_error', errorInfo(err)));
    ws.on('close', (code, reason) => this.teardown(code, reason.toString()));
  }

  /** Validate the query, resolve cwd through the path policy, attach, send scrollback, then go live. */
  async start(url: URL): Promise<void> {
    const id = url.searchParams.get('id') ?? '';
    if (!TERMINAL_ID_RE.test(id)) {
      this.fail(CLOSE_BAD_REQUEST, 'terminal id must match ^[a-zA-Z0-9_-]{1,64}$');
      return;
    }
    const { cols, rows } = clampSize(intParam(url, 'cols', 80, 2, 500), intParam(url, 'rows', 24, 2, 300));
    const requested = url.searchParams.get('cwd')?.trim() || this.ctx.policy.roots[0];
    if (!requested) {
      this.fail(CLOSE_BAD_REQUEST, 'cwd required');
      return;
    }
    let cwd: string;
    try {
      cwd = resolveRoot(this.ctx.policy, requested);
    } catch (err) {
      this.fail(CLOSE_FORBIDDEN, describeError(err));
      return;
    }
    const st = await fs.promises.stat(cwd).catch(() => null);
    if (!st?.isDirectory()) {
      this.fail(CLOSE_NOT_FOUND, `cwd is not a directory: ${requested}`);
      return;
    }
    if (this.closed) return;
    this.log = this.log.child({ terminal: id });

    let term: TerminalSession;
    try {
      term = await this.ctx.terminals.attach({ id, cwd, cols, rows });
    } catch (err) {
      this.log.warn('ws.terminal.attach_failed', errorInfo(err));
      this.fail(CLOSE_INTERNAL, `could not attach terminal: ${describeError(err)}`);
      return;
    }
    if (this.closed) {
      term.detach();
      return;
    }
    this.term = term;

    // Hold live output until the scrollback is on the wire so history lands above tmux's redraw.
    let holding: Buffer[] | null = [];
    this.unsubs.push(
      term.onData((chunk) => {
        if (holding) holding.push(chunk);
        else this.sendBinary(chunk);
      }),
    );
    this.unsubs.push(term.onExit((code) => this.close(1000, code === null ? 'terminal exited' : `terminal exited (${code})`)));
    try {
      const scrollback = await term.scrollback();
      if (scrollback && !this.closed) this.sendBinary(Buffer.from(scrollback, 'utf8'));
    } catch (err) {
      this.log.warn('ws.terminal.scrollback_failed', errorInfo(err));
    }
    if (this.closed) return;
    const held = holding;
    holding = null;
    for (const chunk of held) this.sendBinary(chunk);

    if (this.pendingResize) {
      this.resize(this.pendingResize.cols, this.pendingResize.rows);
      this.pendingResize = null;
    }
    for (const buf of this.inputQueue.splice(0)) this.input(buf);
    this.inputQueued = 0;
    this.log.info('ws.terminal.attached', { cwd, cols, rows });
  }

  // ------------------------------------------------------------ inbound
  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.input(rawToBuffer(data));
      return;
    }
    const text = rawToString(data);
    const ctl = parseTerminalControl(text);
    if (ctl === null) {
      this.input(Buffer.from(text, 'utf8')); // attach-addon style clients send keystrokes as text
      return;
    }
    if (ctl === 'invalid') {
      this.sendJson({ type: 'error', message: 'invalid control frame' });
      return;
    }
    switch (ctl.type) {
      case 'resize':
        this.resize(ctl.cols, ctl.rows);
        break;
      case 'input':
        this.input(Buffer.from(ctl.data, 'utf8'));
        break;
      case 'ping':
        this.sendJson({ type: 'pong', ts: ctl.ts ?? Date.now() });
        break;
    }
  }

  private input(buf: Buffer): void {
    if (this.closed || buf.length === 0) return;
    if (!this.term) {
      if (this.inputQueued + buf.length <= TERMINAL_INPUT_QUEUE_BYTES) {
        this.inputQueue.push(buf);
        this.inputQueued += buf.length;
      }
      return;
    }
    try {
      this.term.write(buf);
    } catch (err) {
      this.log.warn('ws.terminal.write_failed', errorInfo(err));
      this.close(CLOSE_INTERNAL, 'terminal write failed');
    }
  }

  private resize(cols: number, rows: number): void {
    const size = clampSize(cols, rows);
    if (!this.term) {
      this.pendingResize = size;
      return;
    }
    try {
      this.term.resize(size.cols, size.rows);
    } catch (err) {
      this.log.warn('ws.terminal.resize_failed', errorInfo(err));
    }
  }

  // ------------------------------------------------------------ outbound
  private sendBinary(chunk: Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > TERMINAL_MAX_BUFFERED_BYTES) {
      this.log.warn('ws.terminal.slow_client', { buffered: this.ws.bufferedAmount });
      this.ws.terminate();
      return;
    }
    this.ws.send(chunk, { binary: true }, (err) => {
      if (err) this.log.debug('ws.terminal.send_failed', errorInfo(err));
    });
  }

  private sendJson(msg: Record<string, unknown>): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.log.debug('ws.terminal.send_failed', errorInfo(err));
    }
  }

  /** Tell the viewer why (it prints {type:'error'} in red), then close with an application code. */
  private fail(code: number, message: string): void {
    this.log.warn('ws.terminal.rejected', { code, message });
    this.sendJson({ type: 'error', message });
    this.close(code, message);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.teardown(code, reason);
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try {
        this.ws.close(code, closeReason(reason));
      } catch {
        this.ws.terminate();
      }
    }
  }

  /** Detach from the pty (the tmux session lives on) and drop listeners. Idempotent. */
  private teardown(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const u of this.unsubs) {
      try {
        u();
      } catch {
        /* listener already gone */
      }
    }
    this.unsubs.length = 0;
    if (this.term) {
      try {
        this.term.detach();
      } catch (err) {
        this.log.warn('ws.terminal.detach_failed', errorInfo(err));
      }
      this.term = null;
    }
    this.inputQueue.length = 0;
    this.log.info('ws.terminal.closed', { code, reason });
  }
}

// ------------------------------------------------------------------ attach
export const attachWebSockets: AttachWebSockets = (server, ctx) => {
  const log = ctx.log.child({ mod: 'ws' });
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_PAYLOAD_BYTES,
    // Echo the bearer subprotocol (or the first offer) — browsers fail the handshake otherwise.
    handleProtocols: (protocols) => selectedSubprotocol([...protocols]) ?? [...protocols][0] ?? false,
  });
  wss.on('error', (err) => log.error('ws.server_error', errorInfo(err)));
  const heartbeat = new Heartbeat(ctx, log);
  const hub = new EventsHub(ctx, log);
  const terminals = new Set<TerminalConnection>();
  let closing = false;

  const onUpgrade: UpgradeHandler = (req, socket, head) => {
    socket.on('error', () => {
      /* a reset before the handshake completes is not an error worth surfacing */
    });
    // Total: nothing a peer sends may throw out of the 'upgrade' listener (that would take the daemon down).
    try {
      handleUpgrade(req, socket, head);
    } catch (err) {
      // path only: a `?token=` client would otherwise put its bearer token into the journal
      log.warn('ws.upgrade_failed', { path: parseTarget(req.url)?.pathname ?? 'unparseable', ...errorInfo(err) });
      rejectUpgrade(socket, 400, 'bad_request', 'malformed upgrade request');
    }
  };

  const handleUpgrade: UpgradeHandler = (req, socket, head) => {
    const url = parseTarget(req.url);
    if (!url) {
      rejectUpgrade(socket, 400, 'bad_request', 'malformed request target');
      return;
    }
    const kind = url.pathname === API.ws ? 'events' : url.pathname === API.wsTerminal ? 'terminal' : null;
    if (!kind) {
      rejectUpgrade(socket, 404, 'not_found', `no websocket endpoint at ${url.pathname}`);
      return;
    }
    if (closing) {
      rejectUpgrade(socket, 503, 'unavailable', 'server is shutting down');
      return;
    }
    if (!originAllowed(req, ctx.config.config.publicUrl)) {
      log.warn('ws.origin_rejected', { origin: req.headers.origin, host: req.headers.host, path: url.pathname });
      rejectUpgrade(socket, 403, 'forbidden', 'origin not allowed');
      return;
    }
    const creds = credentialsFromRequest(req);
    if (!extractToken(creds)) {
      rejectUpgrade(socket, 401, 'unauthorized', 'bearer token required (subprotocol mide.bearer.<token> or ?token=)');
      return;
    }
    let device: DeviceRow | null = null;
    try {
      device = authenticate(ctx.db, creds);
    } catch (err) {
      log.error('ws.auth_failed', errorInfo(err));
      rejectUpgrade(socket, 503, 'unavailable', 'authentication unavailable');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!device) {
        // Handshake done, so the client observes 4401 (vs. an opaque network failure) and stops retrying.
        log.warn('ws.unauthorized', { path: url.pathname, remote: req.socket.remoteAddress });
        ws.close(CLOSE_UNAUTHORIZED, 'invalid or revoked token');
        return;
      }
      const connLog = log.child({ path: url.pathname, remote: req.socket.remoteAddress });
      if (kind === 'events') {
        new EventsConnection(ws, device, ctx, hub, heartbeat, connLog);
        return;
      }
      const conn = new TerminalConnection(ws, device, ctx, heartbeat, connLog);
      terminals.add(conn);
      ws.on('close', () => terminals.delete(conn));
      conn.start(url).catch((err) => {
        connLog.error('ws.terminal.start_failed', errorInfo(err));
        conn.close(CLOSE_INTERNAL, `terminal failed: ${describeError(err)}`);
      });
    });
  };

  server.on('upgrade', onUpgrade);
  log.info('ws.attached', { paths: [API.ws, API.wsTerminal] });

  return {
    clients: () => hub.clients(),
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      server.off('upgrade', onUpgrade);
      hub.dispose();
      heartbeat.stop();
      const clients = [...wss.clients];
      // Detach ptys synchronously (tmux keeps the shells), then say goodbye to everyone.
      for (const t of terminals) t.close(CLOSE_GOING_AWAY, 'server shutting down');
      terminals.clear();
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close(CLOSE_GOING_AWAY, 'server shutting down');
          } catch {
            ws.terminate();
          }
        }
      }
      const deadline = Date.now() + SHUTDOWN_GRACE_MS;
      while (Date.now() < deadline && clients.some((w) => w.readyState !== WebSocket.CLOSED)) await sleep(50);
      for (const ws of clients) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      await new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 1_000);
        wss.close(() => {
          clearTimeout(fallback);
          resolve();
        });
      });
      log.info('ws.closed', { clients: clients.length });
    },
  };
};
