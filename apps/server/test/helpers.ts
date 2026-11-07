/**
 * Shared helpers for the server test-suite (node:test + tsx). Not a test file itself:
 * the runner only picks up `test/*.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionState, EventEnvelope, SessionSummary } from '@mobile-ide/core';

// ------------------------------------------------------------------ environment
/** First executable named `bin` on PATH (regular files only — shell functions do not count). */
export function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next PATH entry */
    }
  }
  return null;
}

/** mkdtemp + realpath, so comparisons against the daemon's realpath'd roots are exact. */
export function tmpDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rmrf(p: string | undefined): void {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort */
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A currently free loopback port. The daemon's config schema rejects `port: 0`, so the
 * suite picks its own random port; the tiny race between probe and listen is acceptable
 * for a test that runs with concurrency 1.
 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ------------------------------------------------------------------ git fixtures
/** Run git with a hermetic identity (no gpg signing, deterministic default branch). */
export function git(cwd: string, args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8' } },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed (${res.status ?? 'signal'}): ${res.stderr}`);
  return res.stdout;
}

/** Layout of the repo `makeTmpRepo()` builds; tests assert against these constants. */
export const REPO = {
  branch: 'main',
  commitSubject: 'initial commit',
  author: 'e2e',
  /** committed, then modified in the worktree */
  modified: 'hello.txt',
  modifiedContent: 'hello\nsecond line\n',
  /** never added to git */
  untracked: 'new.txt',
  untrackedContent: 'untracked\n',
  /** committed TypeScript file containing `searchNeedle` at line 1, column 14 (1-based) */
  searchable: 'src/needle.ts',
  searchNeedle: 'needle',
  searchLine: 1,
  searchColumn: 14,
  /** committed file with NUL bytes */
  binary: 'blob.bin',
  /** directory the e2e config denylists */
  secretDir: 'secret',
  secretFile: 'secret/keys.txt',
} as const;

/** A throwaway git repo with one commit, one modified file and one untracked file. */
export function makeTmpRepo(): string {
  const dir = tmpDir('mide-e2e-repo-');
  fs.writeFileSync(path.join(dir, REPO.modified), 'hello\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, REPO.searchable), 'export const needle = 1;\n');
  fs.mkdirSync(path.join(dir, REPO.secretDir));
  fs.writeFileSync(path.join(dir, REPO.secretFile), 'top secret\n');
  fs.writeFileSync(path.join(dir, REPO.binary), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1, 0xff, 0xfe]));
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', REPO.commitSubject]);
  fs.appendFileSync(path.join(dir, REPO.modified), 'second line\n');
  fs.writeFileSync(path.join(dir, REPO.untracked), REPO.untrackedContent);
  return dir;
}

// ------------------------------------------------------------------ async helpers
type Probe<T> = () => T | undefined | null | false | Promise<T | undefined | null | false>;

/** Poll `probe` until it yields a value; fails with a message naming what was awaited. */
export async function waitFor<T>(probe: Probe<T>, opts: { what: string; timeoutMs?: number; intervalMs?: number }): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${opts.what}`);
    await sleep(opts.intervalMs ?? 50);
  }
}

/** JSON round-trip: the exact wire representation, so absent vs `undefined` fields never skew deep-equality. */
export function wire<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ------------------------------------------------------------------ HTTP
export interface ApiResult {
  status: number;
  /** parsed JSON when the body was JSON, the raw text otherwise, null when empty */
  body: unknown;
  text: string;
  headers: Headers;
}

export async function api(
  baseUrl: string,
  method: string,
  route: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(new URL(route, baseUrl), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text, headers: res.headers };
}

/** Query-string builder that skips undefined values. */
export function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

// ------------------------------------------------------------------ WebSocket collectors
/** Base class: `until()` re-evaluates its probe whenever `wake()` fires (and every 250 ms). */
class Wakeable {
  private waiters: (() => void)[] = [];

  protected wake(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const fn of pending) fn();
  }

  async until<T>(probe: () => T | undefined | null | false, what: string, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = probe();
      if (v !== undefined && v !== null && v !== false) return v;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(left, 250));
        function done(): void {
          clearTimeout(timer);
          resolve();
        }
        this.waiters.push(done);
      });
    }
  }
}

/** Callback sink for `MideClient` that records everything and lets tests await conditions. */
export class Collector extends Wakeable {
  readonly events: EventEnvelope[] = [];
  readonly replays: { sessionId: string; lastSeq: number }[] = [];
  readonly sessionLists: SessionSummary[][] = [];
  readonly states: { state: ConnectionState; detail?: string }[] = [];

  readonly onEvent = (env: EventEnvelope): void => {
    this.events.push(env);
    this.wake();
  };
  readonly onReplayDone = (sessionId: string, lastSeq: number): void => {
    this.replays.push({ sessionId, lastSeq });
    this.wake();
  };
  readonly onSessions = (sessions: SessionSummary[]): void => {
    this.sessionLists.push(sessions);
    this.wake();
  };
  readonly onState = (state: ConnectionState, detail?: string): void => {
    this.states.push(detail === undefined ? { state } : { state, detail });
    this.wake();
  };

  event(pred: (e: EventEnvelope) => boolean, what: string, timeoutMs?: number): Promise<EventEnvelope> {
    return this.until(() => this.events.find(pred), what, timeoutMs);
  }

  state(state: ConnectionState, timeoutMs?: number): Promise<true> {
    return this.until(() => (this.states.some((s) => s.state === state) ? true : undefined), `connection state '${state}'`, timeoutMs);
  }
}

export interface RawClose {
  code: number;
  reason: string;
  wasClean: boolean;
}

/** Thin wrapper over the global (undici) WebSocket for protocol-level assertions. */
export class RawSocket extends Wakeable {
  readonly ws: WebSocket;
  /** parsed JSON text frames, in arrival order */
  readonly frames: unknown[] = [];
  /** text frames that were not JSON */
  readonly texts: string[] = [];
  readonly binary: Buffer[] = [];
  /** resolves on open; rejects if the socket closes first (e.g. the upgrade was refused) */
  readonly opened: Promise<void>;
  readonly closed: Promise<RawClose>;
  private isOpen = false;

  constructor(url: string, protocols?: string[]) {
    super();
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let resolveOpen: () => void = () => {};
    let rejectOpen: (err: Error) => void = () => {};
    let resolveClose: (c: RawClose) => void = () => {};
    this.opened = new Promise<void>((res, rej) => {
      resolveOpen = res;
      rejectOpen = rej;
    });
    this.closed = new Promise<RawClose>((res) => {
      resolveClose = res;
    });
    this.opened.catch(() => {
      /* callers that care await `opened` themselves */
    });
    ws.onopen = () => {
      this.isOpen = true;
      resolveOpen();
      this.wake();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = (ev: CloseEvent) => {
      if (!this.isOpen) rejectOpen(new Error(`socket closed before open (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`));
      resolveClose({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      this.wake();
    };
    ws.onmessage = (ev: MessageEvent) => {
      const data: unknown = ev.data;
      if (typeof data === 'string') {
        try {
          this.frames.push(JSON.parse(data));
        } catch {
          this.texts.push(data);
        }
      } else if (data instanceof ArrayBuffer) {
        this.binary.push(Buffer.from(data));
      } else if (ArrayBuffer.isView(data)) {
        this.binary.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      }
      this.wake();
    };
  }

  get open(): boolean {
    return this.isOpen && this.ws.readyState === 1;
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  sendBinary(data: Buffer | string): void {
    this.ws.send(typeof data === 'string' ? Buffer.from(data) : data);
  }

  /** First JSON frame for which `pick` returns a value. */
  frame<T>(pick: (f: unknown) => T | undefined | null | false, what: string, timeoutMs?: number): Promise<T> {
    return this.until(
      () => {
        for (const f of this.frames) {
          const v = pick(f);
          if (v !== undefined && v !== null && v !== false) return v;
        }
        return undefined;
      },
      what,
      timeoutMs,
    );
  }

  binaryText(): string {
    return Buffer.concat(this.binary).toString('utf8');
  }

  close(code = 1000, reason = 'test done'): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}
