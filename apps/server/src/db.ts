/**
 * SQLite storage (node:sqlite, WAL). All writes are synchronous; the event log append is
 * transactional so `seq` is dense and monotonic per session.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import {
  EventEnvelope,
  TimelineEvent,
  type ElicitationAction,
  type ElicitationContent,
  type ElicitationRequest,
  type PermissionRequest,
  type SessionMode,
  type SessionStatus,
} from '@mobile-ide/core';
import { hashesEqual, hashPairingCode, hashToken, newId, PAIRING_CODE_TTL_MS } from './auth.js';
import { log } from './log.js';

type Row = Record<string, SQLOutputValue>;

export interface DeviceRow {
  id: string;
  name: string;
  platform: string | null;
  tokenHash: string;
  createdAt: number;
  lastSeen: number | null;
  revokedAt: number | null;
}

/**
 * Where the current title came from. Only `user` titles are locked: an agent suggestion (`session_info_update`)
 * replaces a `default` or `prompt` title, and the first prompt replaces a `default` one.
 */
export type TitleSource = 'default' | 'prompt' | 'agent' | 'user';

export interface SessionRow {
  id: string;
  agent: string;
  cwd: string;
  title: string;
  titleSource: TitleSource;
  acpSessionId: string | null;
  status: SessionStatus;
  modeId: string | null;
  availableModes: SessionMode[] | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  closedAt: number | null;
  lastPreview: string | null;
}

export interface PermissionRow {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string | null;
  request: PermissionRequest;
  status: 'pending' | 'selected' | 'cancelled';
  optionId: string | null;
  resolvedBy: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

/** An agent's question / URL hand-off (ACP `elicitation/create`), durable like a permission request. */
export interface ElicitationRow {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string | null;
  mode: 'form' | 'url';
  request: ElicitationRequest;
  status: 'pending' | ElicitationAction;
  /** the answers, for an accepted form */
  content: ElicitationContent | null;
  resolvedBy: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface PushSubscriptionRow {
  id: string;
  deviceId: string;
  kind: 'expo' | 'ntfy' | 'webpush';
  payload: unknown;
  createdAt: number;
}

export interface TurnIntentRow {
  id: string;
  sessionId: string;
  prompt: string;
  startedAt: number;
  status: 'running' | 'done' | 'error';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT, token_hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, acp_session_id TEXT,
  status TEXT NOT NULL, mode_id TEXT, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT -1, closed_at INTEGER,
  available_modes TEXT, last_preview TEXT
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, tool_call_id TEXT, request TEXT NOT NULL,
  status TEXT NOT NULL, option_id TEXT, resolved_by TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS permissions_pending ON permissions(status, session_id);
CREATE TABLE IF NOT EXISTS elicitations (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, tool_call_id TEXT, mode TEXT NOT NULL, request TEXT NOT NULL,
  status TEXT NOT NULL, content TEXT, resolved_by TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS elicitations_pending ON elicitations(status, session_id);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_device ON push_subscriptions(device_id);
CREATE TABLE IF NOT EXISTS turn_intents (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, started_at INTEGER NOT NULL, status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS turn_intents_status ON turn_intents(status);
`;

function str(v: SQLOutputValue | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}
function strOrNull(v: SQLOutputValue | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}
function num(v: SQLOutputValue | undefined): number {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
}
function numOrNull(v: SQLOutputValue | undefined): number | null {
  return v === null || v === undefined ? null : num(v);
}
function json<T>(v: SQLOutputValue | undefined, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}

export class Db {
  private readonly db: DatabaseSync;

  constructor(public readonly file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // Incremental auto-vacuum lets `reclaimSpace()` hand freed pages back without rewriting the whole file. It only
    // binds before the first table exists; an older database keeps its mode until its next full VACUUM converts it.
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const cols = new Set(this.db.prepare('PRAGMA table_info(sessions)').all().map((r) => str(r.name)));
    if (!cols.has('available_modes')) this.db.exec('ALTER TABLE sessions ADD COLUMN available_modes TEXT');
    if (!cols.has('last_preview')) this.db.exec('ALTER TABLE sessions ADD COLUMN last_preview TEXT');
    if (!cols.has('title_source')) this.db.exec('ALTER TABLE sessions ADD COLUMN title_source TEXT');
    // Rows from before the column existed: a title equal to the folder name was the default (the first prompt may still
    // name the session); anything else was typed or derived before the policy existed and is locked like a typed title,
    // so the agent's first suggestion after the upgrade cannot overwrite it. Runs on every open (0 rows after the first).
    for (const r of this.db.prepare('SELECT id, cwd, title FROM sessions WHERE title_source IS NULL').all()) {
      const cwd = str(r.cwd);
      const source: TitleSource = str(r.title) === (path.basename(cwd) || cwd) ? 'default' : 'user';
      this.db.prepare('UPDATE sessions SET title_source = ? WHERE id = ?').run(source, str(r.id));
    }
  }

  /** Bytes on disk (main file + WAL); 0 for an in-memory database. */
  fileSize(): number {
    if (this.file === ':memory:') return 0;
    let total = 0;
    for (const f of [this.file, `${this.file}-wal`]) {
      try {
        total += fs.statSync(f).size;
      } catch {
        /* no such file */
      }
    }
    return total;
  }

  /** Fold the WAL back into the main file and truncate it; cheap when nothing is pending. Never throws. */
  checkpoint(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      log.warn('db.checkpoint.failed', { err: String(err) });
    }
  }

  /** Bytes held by free pages inside the main file — what reclaiming would give back. */
  freeBytes(): number {
    const pages = num(this.db.prepare('PRAGMA freelist_count').get()?.freelist_count);
    const pageSize = num(this.db.prepare('PRAGMA page_size').get()?.page_size);
    return pages * pageSize;
  }

  /**
   * Give freed pages (pruned sessions) back to the filesystem. Databases created by this daemon run
   * `auto_vacuum = INCREMENTAL`, so the free list is released in place (`PRAGMA incremental_vacuum`) without touching
   * the live sessions' logs; an older file (no auto_vacuum until its next VACUUM) is only rewritten when the waste is
   * worth a whole-file rewrite — at least `minBytes`, or a fifth of the file. Synchronous, so callers run it after
   * `listen()`, never on the boot path. Never throws.
   */
  reclaimSpace(minBytes = 16 * 1024 * 1024): { method: 'none' | 'incremental' | 'vacuum'; freedBytes: number } {
    try {
      const free = this.freeBytes();
      if (free === 0) return { method: 'none', freedBytes: 0 };
      const mode = num(this.db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum); // 0 none · 1 full · 2 incremental
      if (mode === 2) {
        this.db.exec('PRAGMA incremental_vacuum');
        return { method: 'incremental', freedBytes: free - this.freeBytes() };
      }
      if (free < minBytes && free < this.fileSize() / 5) return { method: 'none', freedBytes: 0 };
      this.db.exec('VACUUM');
      return { method: 'vacuum', freedBytes: free };
    } catch (err) {
      log.warn('db.reclaim.failed', { err: String(err) });
      return { method: 'none', freedBytes: 0 };
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      log.warn('db.close.failed', { err: String(err) });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------ devices
  private rowToDevice(r: Row): DeviceRow {
    return {
      id: str(r.id),
      name: str(r.name),
      platform: strOrNull(r.platform),
      tokenHash: str(r.token_hash),
      createdAt: num(r.created_at),
      lastSeen: numOrNull(r.last_seen),
      revokedAt: numOrNull(r.revoked_at),
    };
  }

  createDevice(name: string, platform: string | undefined, token: string): DeviceRow {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO devices (id, name, platform, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, platform ?? null, hashToken(token), now, now);
    return { id, name, platform: platform ?? null, tokenHash: hashToken(token), createdAt: now, lastSeen: now, revokedAt: null };
  }

  /** Find an active device by bearer token (constant-time on the hash). */
  deviceByToken(token: string): DeviceRow | null {
    const h = hashToken(token);
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(h);
    if (!row) return null;
    const dev = this.rowToDevice(row);
    if (!hashesEqual(dev.tokenHash, h)) return null;
    return dev;
  }

  touchDevice(id: string): void {
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), id);
  }

  listDevices(): DeviceRow[] {
    return this.db.prepare('SELECT * FROM devices ORDER BY created_at ASC').all().map((r) => this.rowToDevice(r));
  }

  getDevice(id: string): DeviceRow | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    return row ? this.rowToDevice(row) : null;
  }

  revokeDevice(id: string): boolean {
    const res = this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
    this.db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(id);
    return res.changes > 0;
  }

  // ------------------------------------------------------------------ pairing
  createPairingCode(code: string, ttlMs = PAIRING_CODE_TTL_MS): { expiresAt: number } {
    const now = Date.now();
    this.db.prepare('DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL').run(now - 60_000);
    this.db.prepare('INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)').run(hashPairingCode(code), now, now + ttlMs);
    return { expiresAt: now + ttlMs };
  }

  /** Burn a pairing code. Returns true when it was valid and unused. */
  consumePairingCode(code: string): boolean {
    const now = Date.now();
    const h = hashPairingCode(code);
    const res = this.db
      .prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?')
      .run(now, h, now);
    return res.changes > 0;
  }

  // ------------------------------------------------------------------ sessions
  private rowToSession(r: Row): SessionRow {
    const status = SessionStatusSafe(str(r.status));
    const cwd = str(r.cwd);
    const title = str(r.title);
    return {
      id: str(r.id),
      agent: str(r.agent),
      cwd,
      title,
      // migrate() backfills NULLs, so the column is the single source of truth; an unknown value is treated as locked
      titleSource: titleSourceSafe(strOrNull(r.title_source)) ?? 'user',
      acpSessionId: strOrNull(r.acp_session_id),
      status,
      modeId: strOrNull(r.mode_id),
      availableModes: json<SessionMode[] | null>(r.available_modes, null),
      model: strOrNull(r.model),
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
      lastSeq: num(r.last_seq),
      closedAt: numOrNull(r.closed_at),
      lastPreview: strOrNull(r.last_preview),
    };
  }

  createSession(input: { id: string; agent: string; cwd: string; title: string; titleSource?: TitleSource; modeId?: string; model?: string }): SessionRow {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO sessions (id, agent, cwd, title, title_source, acp_session_id, status, mode_id, model, created_at, updated_at, last_seq) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, -1)',
      )
      .run(input.id, input.agent, input.cwd, input.title, input.titleSource ?? 'prompt', 'starting', input.modeId ?? null, input.model ?? null, now, now);
    const row = this.getSession(input.id);
    if (!row) throw new Error('session insert failed');
    return row;
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? this.rowToSession(row) : null;
  }

  listSessions(opts: { includeClosed?: boolean; status?: SessionStatus } = {}): SessionRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!opts.includeClosed) where.push("status != 'closed'");
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`;
    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => this.rowToSession(r));
  }

  updateSession(
    id: string,
    patch: Partial<{
      title: string;
      titleSource: TitleSource;
      acpSessionId: string | null;
      status: SessionStatus;
      modeId: string | null;
      availableModes: SessionMode[] | null;
      model: string | null;
      closedAt: number | null;
      lastPreview: string | null;
      cwd: string;
    }>,
  ): void {
    const sets: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [Date.now()];
    const map: Record<string, string> = {
      title: 'title',
      titleSource: 'title_source',
      acpSessionId: 'acp_session_id',
      status: 'status',
      modeId: 'mode_id',
      model: 'model',
      closedAt: 'closed_at',
      lastPreview: 'last_preview',
      cwd: 'cwd',
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col} = ?`);
        const v = (patch as Record<string, unknown>)[k];
        params.push(v === undefined ? null : (v as string | number | null));
      }
    }
    if ('availableModes' in patch) {
      sets.push('available_modes = ?');
      params.push(patch.availableModes ? JSON.stringify(patch.availableModes) : null);
    }
    params.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /** Distinct cwds of non-closed sessions, most recent first, with counts. */
  sessionCwds(): { cwd: string; count: number; lastUsedAt: number }[] {
    return this.db
      .prepare("SELECT cwd, COUNT(*) AS n, MAX(updated_at) AS last FROM sessions WHERE status != 'closed' GROUP BY cwd ORDER BY last DESC")
      .all()
      .map((r) => ({ cwd: str(r.cwd), count: num(r.n), lastUsedAt: num(r.last) }));
  }

  // ------------------------------------------------------------------ events
  /**
   * Append an event, assigning the next seq. Runs in a transaction so seq is dense even
   * though several code paths append concurrently (same thread, but keeps the invariant obvious).
   */
  appendEvent(sessionId: string, event: TimelineEvent): EventEnvelope {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT last_seq FROM sessions WHERE id = ?').get(sessionId);
      if (!row) throw new Error(`unknown session ${sessionId}`);
      const seq = num(row.last_seq) + 1;
      const ts = Date.now();
      this.db
        .prepare('INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, seq, ts, event.type, JSON.stringify(event));
      this.db.prepare('UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?').run(seq, ts, sessionId);
      return { sessionId, seq, ts, event };
    });
  }

  eventsAfter(sessionId: string, afterSeq: number, limit: number): EventEnvelope[] {
    const rows = this.db
      .prepare('SELECT seq, ts, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(sessionId, afterSeq, limit);
    const out: EventEnvelope[] = [];
    for (const r of rows) {
      const parsed = TimelineEvent.safeParse(json<unknown>(r.payload, null));
      if (!parsed.success) {
        log.warn('event.corrupt', { sessionId, seq: num(r.seq) });
        continue;
      }
      out.push({ sessionId, seq: num(r.seq), ts: num(r.ts), event: parsed.data });
    }
    return out;
  }

  lastSeq(sessionId: string): number {
    const row = this.db.prepare('SELECT last_seq FROM sessions WHERE id = ?').get(sessionId);
    return row ? num(row.last_seq) : -1;
  }

  /** True when the session's log already holds `turn.ended` for `turnId` (boot() must not end a finished turn twice). */
  turnEnded(sessionId: string, turnId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS one FROM events WHERE session_id = ? AND type = 'turn.ended' AND json_extract(payload, '$.turnId') = ? LIMIT 1")
      .get(sessionId, turnId);
    return !!row;
  }

  deleteSessionData(sessionId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM permissions WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM elicitations WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM turn_intents WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    });
  }

  /**
   * Drop closed sessions (row, log, permissions, intents) whose `closed_at` is older than `olderThanMs`. A plain
   * `DELETE /api/sessions/:id` keeps the log so the transcript can still be read for a while; this is the only
   * path that ever reclaims that space. Returns how many sessions went.
   */
  pruneClosedSessions(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const ids = this.db
      .prepare("SELECT id FROM sessions WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at < ?")
      .all(cutoff)
      .map((r) => str(r.id));
    for (const id of ids) this.deleteSessionData(id);
    return ids.length;
  }

  // ------------------------------------------------------------------ permissions
  private rowToPermission(r: Row): PermissionRow | null {
    const req = json<unknown>(r.request, null);
    const parsed = req ? (req as PermissionRequest) : null;
    if (!parsed) return null;
    const status = str(r.status);
    return {
      id: str(r.id),
      sessionId: str(r.session_id),
      turnId: str(r.turn_id),
      toolCallId: strOrNull(r.tool_call_id),
      request: parsed,
      status: status === 'selected' || status === 'cancelled' ? status : 'pending',
      optionId: strOrNull(r.option_id),
      resolvedBy: strOrNull(r.resolved_by),
      createdAt: num(r.created_at),
      resolvedAt: numOrNull(r.resolved_at),
    };
  }

  insertPermission(req: PermissionRequest): void {
    this.db
      .prepare(
        'INSERT INTO permissions (id, session_id, turn_id, tool_call_id, request, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(req.permissionId, req.sessionId, req.turnId, req.toolCallId ?? null, JSON.stringify(req), 'pending', req.createdAt);
  }

  getPermission(id: string): PermissionRow | null {
    const row = this.db.prepare('SELECT * FROM permissions WHERE id = ?').get(id);
    return row ? this.rowToPermission(row) : null;
  }

  resolvePermission(id: string, outcome: 'selected' | 'cancelled', optionId: string | undefined, by: string): boolean {
    const res = this.db
      .prepare("UPDATE permissions SET status = ?, option_id = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(outcome, optionId ?? null, by, Date.now(), id);
    return res.changes > 0;
  }

  pendingPermissions(sessionId?: string): PermissionRow[] {
    const rows = sessionId
      ? this.db.prepare("SELECT * FROM permissions WHERE status = 'pending' AND session_id = ? ORDER BY created_at ASC").all(sessionId)
      : this.db.prepare("SELECT * FROM permissions WHERE status = 'pending' ORDER BY created_at ASC").all();
    return rows.map((r) => this.rowToPermission(r)).filter((p): p is PermissionRow => p !== null);
  }

  pendingPermissionCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.db.prepare("SELECT session_id, COUNT(*) AS n FROM permissions WHERE status = 'pending' GROUP BY session_id").all()) {
      out.set(str(r.session_id), num(r.n));
    }
    return out;
  }

  // ------------------------------------------------------------------ elicitations
  private rowToElicitation(r: Row): ElicitationRow | null {
    const request = json<ElicitationRequest | null>(r.request, null);
    if (!request) return null;
    const status = str(r.status);
    return {
      id: str(r.id),
      sessionId: str(r.session_id),
      turnId: str(r.turn_id),
      toolCallId: strOrNull(r.tool_call_id),
      mode: str(r.mode) === 'url' ? 'url' : 'form',
      request,
      status: status === 'accept' || status === 'decline' || status === 'cancel' ? status : 'pending',
      content: json<ElicitationContent | null>(r.content, null),
      resolvedBy: strOrNull(r.resolved_by),
      createdAt: num(r.created_at),
      resolvedAt: numOrNull(r.resolved_at),
    };
  }

  insertElicitation(req: ElicitationRequest): void {
    this.db
      .prepare(
        'INSERT INTO elicitations (id, session_id, turn_id, tool_call_id, mode, request, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(req.elicitationId, req.sessionId, req.turnId, req.toolCallId ?? null, req.mode, JSON.stringify(req), 'pending', req.createdAt);
  }

  getElicitation(id: string): ElicitationRow | null {
    const row = this.db.prepare('SELECT * FROM elicitations WHERE id = ?').get(id);
    return row ? this.rowToElicitation(row) : null;
  }

  /** Settle a pending elicitation; false when it was already answered. */
  resolveElicitation(id: string, action: ElicitationAction, content: ElicitationContent | undefined, by: string): boolean {
    const res = this.db
      .prepare("UPDATE elicitations SET status = ?, content = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(action, content === undefined ? null : JSON.stringify(content), by, Date.now(), id);
    return res.changes > 0;
  }

  pendingElicitations(sessionId?: string): ElicitationRow[] {
    const rows = sessionId
      ? this.db.prepare("SELECT * FROM elicitations WHERE status = 'pending' AND session_id = ? ORDER BY created_at ASC").all(sessionId)
      : this.db.prepare("SELECT * FROM elicitations WHERE status = 'pending' ORDER BY created_at ASC").all();
    return rows.map((r) => this.rowToElicitation(r)).filter((e): e is ElicitationRow => e !== null);
  }

  pendingElicitationCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.db.prepare("SELECT session_id, COUNT(*) AS n FROM elicitations WHERE status = 'pending' GROUP BY session_id").all()) {
      out.set(str(r.session_id), num(r.n));
    }
    return out;
  }

  // ------------------------------------------------------------------ push subscriptions
  private rowToPush(r: Row): PushSubscriptionRow {
    const kind = str(r.kind);
    return {
      id: str(r.id),
      deviceId: str(r.device_id),
      kind: kind === 'expo' || kind === 'ntfy' ? kind : 'webpush',
      payload: json<unknown>(r.payload, null),
      createdAt: num(r.created_at),
    };
  }

  upsertPushSubscription(deviceId: string, kind: PushSubscriptionRow['kind'], payload: unknown): PushSubscriptionRow {
    const serialized = JSON.stringify(payload);
    // one subscription per (device, kind, payload) — re-registering is idempotent
    const existing = this.db
      .prepare('SELECT * FROM push_subscriptions WHERE device_id = ? AND kind = ? AND payload = ?')
      .get(deviceId, kind, serialized);
    if (existing) return this.rowToPush(existing);
    if (kind === 'expo') this.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ? AND kind = 'expo'").run(deviceId);
    const id = newId();
    const now = Date.now();
    this.db.prepare('INSERT INTO push_subscriptions (id, device_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)').run(id, deviceId, kind, serialized, now);
    return { id, deviceId, kind, payload, createdAt: now };
  }

  listPushSubscriptions(deviceIds?: string[]): PushSubscriptionRow[] {
    if (deviceIds && deviceIds.length === 0) return [];
    if (!deviceIds) return this.db.prepare('SELECT * FROM push_subscriptions').all().map((r) => this.rowToPush(r));
    const marks = deviceIds.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM push_subscriptions WHERE device_id IN (${marks})`)
      .all(...deviceIds)
      .map((r) => this.rowToPush(r));
  }

  deletePushSubscription(id: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------------ turn intents
  /** `id` doubles as the turnId so an interrupted turn can be closed out on the next boot. */
  insertTurnIntent(sessionId: string, prompt: string, id: string = newId()): string {
    this.db
      .prepare("INSERT INTO turn_intents (id, session_id, prompt, started_at, status) VALUES (?, ?, ?, ?, 'running')")
      .run(id, sessionId, prompt.slice(0, 4000), Date.now());
    return id;
  }

  finishTurnIntent(id: string, status: 'done' | 'error'): void {
    this.db.prepare('UPDATE turn_intents SET status = ? WHERE id = ?').run(status, id);
  }

  runningTurnIntents(): TurnIntentRow[] {
    return this.db
      .prepare("SELECT * FROM turn_intents WHERE status = 'running'")
      .all()
      .map((r) => ({ id: str(r.id), sessionId: str(r.session_id), prompt: str(r.prompt), startedAt: num(r.started_at), status: 'running' as const }));
  }

  pruneTurnIntents(olderThanMs = 7 * 24 * 3600 * 1000): void {
    this.db.prepare("DELETE FROM turn_intents WHERE status != 'running' AND started_at < ?").run(Date.now() - olderThanMs);
  }

  /** Simple health probe used by `doctor`. */
  ping(): boolean {
    const row = this.db.prepare('SELECT 1 AS one').get();
    return !!row && num(row.one) === 1;
  }
}

function titleSourceSafe(s: string | null): TitleSource | null {
  switch (s) {
    case 'default':
    case 'prompt':
    case 'agent':
    case 'user':
      return s;
    default:
      return null;
  }
}

function SessionStatusSafe(s: string): SessionStatus {
  switch (s) {
    case 'starting':
    case 'idle':
    case 'running':
    case 'needs_you':
    case 'error':
    case 'closed':
      return s;
    default:
      return 'error';
  }
}
