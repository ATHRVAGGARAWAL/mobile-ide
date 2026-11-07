/**
 * User-facing terminals (the Terminal tab). Every terminal `id` maps to a tmux session
 * `<prefix>-<id>`, so the shell survives WebSocket drops and daemon restarts. Each attach
 * gets its own pty running `tmux attach-session`; several attaches to one id share the tmux
 * session. ptys come from `@lydell/node-pty`; when that native module fails to load we fall
 * back to util-linux `script(1)` driving tmux through a plain child process (logged, and
 * reported by `doctor()`).
 *
 * tmux notes that shaped this file (verified against tmux 3.7):
 * - `new-session -A` cannot be used from a process without a tty: when the session already
 *   exists it turns into `attach-session` and fails with "open terminal failed". We use
 *   `has-session` + `new-session -d` and treat "duplicate session" as success instead.
 * - `-t <name>` prefix-matches session names, so `mide-abc` could hit `mide-abc2`. Session
 *   targets use `=<name>` and pane targets `=<name>:` for exact matching.
 * - On attach tmux switches the outer terminal to the alternate screen (`\e[?1049h`), which
 *   would hide the scrollback we send first and disable finger scrolling in xterm.js. The
 *   attach stream therefore drops the alternate-screen switch (see `AltScreenFilter`); tmux
 *   redraws in place and older output stays in the client's scrollback.
 * - `status` and `mouse` are session options, so they are set per `<prefix>-*` session
 *   (`set-option -t =<name>:` — option commands take a pane-style target) and never with `-g`:
 *   the daemon shares the user's tmux server and must not restyle their own sessions.
 * - `default-terminal` is a server option and tmux always derives the inner TERM from it, so it
 *   is left alone (tmux ≥ 3.1 defaults to tmux-256color). `new-session -e` (tmux ≥ 3.2) seeds the
 *   session environment instead; older tmux gets the same command without `-e`.
 */
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as NodePty from '@lydell/node-pty';
import { expandHome } from './config.js';
import type { TerminalManagerLike, TerminalSession } from './context.js';
import { BadRequestError, errorMessage } from './errors.js';
import type { Unsubscribe } from './events.js';
import { errorInfo, type Logger } from './log.js';

export const TERMINAL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const TMUX_PREFIX_RE = /^[a-zA-Z0-9_-]{1,32}$/;

const SCROLLBACK_LINES = 2000;
export const SCROLLBACK_MAX_BYTES = 20 * 1024;
const CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
const TMUX_TIMEOUT_MS = 10_000;
/** Output buffered per attach until the first `onData` subscriber shows up. */
const PENDING_MAX_BYTES = 2 * 1024 * 1024;
/** How long a partial escape sequence may be held back before it is passed through as-is. */
const HELD_FLUSH_MS = 30;
const DETACH_FORCE_MS = 3000;
const SHUTDOWN_WAIT_MS = 2500;

export const DEFAULT_SIZE = { cols: 80, rows: 24 } as const;
const COLS_RANGE = [2, 1000] as const;
const ROWS_RANGE = [2, 500] as const;

/**
 * Session options applied to every `<prefix>-*` session we create or attach to (idempotent).
 * - `status off`: a phone screen has no row to spare, and the bar would duplicate the app header.
 * - `mouse on`: wheel/touch scrolling reaches tmux copy mode (the real history, not just the
 *   client's replay), taps land in mouse-aware programs, and a copy-mode selection is pushed to
 *   the client as OSC 52 — the app turns that into the phone clipboard.
 */
export const TMUX_SESSION_OPTIONS: ReadonlyArray<readonly [name: string, value: string]> = [
  ['status', 'off'],
  ['mouse', 'on'],
];

/**
 * Environment seeded into new sessions (`new-session -e`, tmux ≥ 3.2). The attach client
 * advertises truecolor (xterm-256color + COLORTERM), so programs inside may emit RGB: tmux passes
 * it through when the client supports it and rounds to the 256-colour cube otherwise.
 */
export const TMUX_SESSION_ENV: ReadonlyArray<readonly [name: string, value: string]> = [['COLORTERM', 'truecolor']];

/** Client-side terminal identity for the tmux clients we spawn. */
export const CLIENT_TERM = 'xterm-256color';

export interface TerminalManagerOptions {
  /** Optional desktop mirror; failure must never interrupt a phone terminal. */
  onAttach?: (id: string, cwd: string) => void;
  /** login shell for new tmux sessions; '' or '$SHELL' or the daemon's own $SHELL → tmux default */
  shell: string;
  /** tmux session name prefix (`<prefix>-<id>`) */
  tmuxPrefix: string;
  log: Logger;
}

export function isValidTerminalId(id: unknown): id is string {
  return typeof id === 'string' && TERMINAL_ID_RE.test(id);
}

export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const clamp = (v: unknown, range: readonly [number, number], fallback: number): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(range[1], Math.max(range[0], Math.round(n)));
  };
  return { cols: clamp(cols, COLS_RANGE, DEFAULT_SIZE.cols), rows: clamp(rows, ROWS_RANGE, DEFAULT_SIZE.rows) };
}

// ------------------------------------------------------------------------------------ scrollback

const SGR_ONLY_ROW = /^(?:\x1b\[[0-9;]*m)*\s*$/;
const RESET_ATTRS = '\x1b[0m';

/**
 * Turn `tmux capture-pane -p -e` output into bytes a terminal can replay: trailing blank rows
 * dropped, CRLF line endings, at most `maxBytes` (cut on a line boundary, oldest lines first),
 * attributes reset at the end so the live redraw starts clean.
 */
export function formatScrollback(captured: string, maxBytes: number = SCROLLBACK_MAX_BYTES): string {
  const lines = captured.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && SGR_ONLY_ROW.test(lines[lines.length - 1] ?? '')) lines.pop();
  if (lines.length === 0) return '';
  const budget = Math.max(0, maxBytes - RESET_ATTRS.length);
  let start = lines.length;
  let used = 0;
  while (start > 0) {
    const cost = Buffer.byteLength(lines[start - 1] ?? '', 'utf8') + 2;
    if (used + cost > budget) break;
    used += cost;
    start--;
  }
  if (start === lines.length) {
    // even the newest line alone exceeds the budget: keep its tail
    const last = lines[lines.length - 1] ?? '';
    return tailWithinBytes(last, Math.max(0, budget - 2)) + '\r\n' + RESET_ATTRS;
  }
  return lines.slice(start).join('\r\n') + '\r\n' + RESET_ATTRS;
}

/** Longest suffix of `s` that fits in `maxBytes` of UTF-8 without splitting a code point. */
function tailWithinBytes(s: string, maxBytes: number): string {
  let bytes = 0;
  let i = s.length;
  while (i > 0) {
    let j = i - 1;
    const code = s.charCodeAt(j);
    if (code >= 0xdc00 && code <= 0xdfff && j > 0) j--; // low surrogate: take the pair
    const len = Buffer.byteLength(s.slice(j, i), 'utf8');
    if (bytes + len > maxBytes) break;
    bytes += len;
    i = j;
  }
  return s.slice(i);
}

// ------------------------------------------------------------------------------ alt-screen filter

const ALT_SCREEN_SEQUENCES = ['\x1b[?1049h', '\x1b[?1049l', '\x1b[?1047h', '\x1b[?1047l', '\x1b[?47h', '\x1b[?47l'].map((s) =>
  Buffer.from(s, 'latin1'),
);
const EMPTY = Buffer.alloc(0);

/** -1 = the rest of `buf` is a proper prefix of a sequence; 0 = no match; n = matched length */
function matchAltScreenAt(buf: Buffer, at: number): number {
  const avail = buf.length - at;
  let partial = false;
  for (const seq of ALT_SCREEN_SEQUENCES) {
    const n = Math.min(avail, seq.length);
    let k = 0;
    while (k < n && buf[at + k] === seq[k]) k++;
    if (k === seq.length) return seq.length;
    if (k === n && avail < seq.length) partial = true;
  }
  return partial ? -1 : 0;
}

/**
 * Removes the alternate-screen switch sequences (smcup/rmcup) from a byte stream, safe across
 * chunk boundaries: a chunk ending in a prefix of one of them is held until the next chunk (or
 * `flush()`). Everything else passes through untouched.
 */
export class AltScreenFilter {
  private held: Buffer = EMPTY;

  get holding(): boolean {
    return this.held.length > 0;
  }

  push(chunk: Buffer): Buffer {
    const input = this.held.length > 0 ? Buffer.concat([this.held, chunk]) : chunk;
    this.held = EMPTY;
    const out: Buffer[] = [];
    let start = 0;
    let i = 0;
    while (i < input.length) {
      if (input[i] !== 0x1b) {
        i++;
        continue;
      }
      const m = matchAltScreenAt(input, i);
      if (m > 0) {
        if (i > start) out.push(input.subarray(start, i));
        i += m;
        start = i;
      } else if (m < 0) {
        if (i > start) out.push(input.subarray(start, i));
        this.held = Buffer.from(input.subarray(i));
        start = input.length;
        break;
      } else {
        i++;
      }
    }
    if (start < input.length) out.push(input.subarray(start));
    if (out.length === 0) return EMPTY;
    return out.length === 1 ? (out[0] ?? EMPTY) : Buffer.concat(out);
  }

  flush(): Buffer {
    const h = this.held;
    this.held = EMPTY;
    return h;
  }
}

// ----------------------------------------------------------------------------------- pty backends

interface PtyHandle {
  readonly pid: number;
  /** false for the script(1) fallback, whose pty size cannot be changed from outside */
  readonly supportsResize: boolean;
  onData(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code: number | null) => void): void;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal: 'SIGHUP' | 'SIGKILL'): void;
}

interface PtySpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

interface PtyBackend {
  readonly kind: 'node-pty' | 'script';
  readonly detail: string;
  spawn(file: string, args: string[], opts: PtySpawnOptions): PtyHandle;
}

type NodePtySpawn = typeof NodePty.spawn;

function nodePtyBackend(spawnPty: NodePtySpawn): PtyBackend {
  return {
    kind: 'node-pty',
    detail: '@lydell/node-pty',
    spawn(file, args, opts) {
      const pty = spawnPty(file, args, {
        name: CLIENT_TERM,
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
        // raw bytes in both directions; no re-encoding of what the client typed
        encoding: null,
      });
      return {
        pid: pty.pid,
        supportsResize: true,
        onData: (cb) =>
          pty.onData((d: string | Buffer) => {
            cb(Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf8'));
          }),
        onExit: (cb) => pty.onExit((e) => cb(e.signal ? null : e.exitCode)),
        write: (data) => pty.write(data),
        resize: (cols, rows) => pty.resize(cols, rows),
        kill: (signal) => pty.kill(signal),
      };
    },
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function scriptBackend(scriptPath: string, log: Logger): PtyBackend {
  return {
    kind: 'script',
    detail: `script(1) at ${scriptPath}`,
    spawn(file, args, opts) {
      const command = [file, ...args].map(shellQuote).join(' ');
      const child: ChildProcess = spawnChild(scriptPath, ['-qfc', command, '/dev/null'], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const dataListeners = new Set<(chunk: Buffer) => void>();
      const exitListeners = new Set<(code: number | null) => void>();
      let exited = false;
      const finish = (code: number | null): void => {
        if (exited) return;
        exited = true;
        for (const cb of exitListeners) cb(code);
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const cb of dataListeners) cb(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => log.debug('terminal.script.stderr', { text: chunk.toString('utf8').slice(0, 500) }));
      child.on('error', (err) => {
        log.error('terminal.script.spawn_failed', errorInfo(err));
        finish(null);
      });
      child.on('exit', (code, signal) => finish(signal ? null : code));
      return {
        pid: child.pid ?? -1,
        supportsResize: false,
        onData: (cb) => {
          dataListeners.add(cb);
        },
        onExit: (cb) => {
          exitListeners.add(cb);
        },
        write: (data) => {
          if (!exited) child.stdin?.write(data);
        },
        resize: () => {},
        kill: (signal) => {
          if (!exited) child.kill(signal);
        },
      };
    },
  };
}

interface BackendState {
  backend: PtyBackend | null;
  /** why node-pty is not in use (undefined when it is) */
  nodePtyError?: string;
}

async function loadNodePty(): Promise<NodePtySpawn> {
  const mod = (await import('@lydell/node-pty')) as unknown as { spawn?: unknown; default?: { spawn?: unknown } };
  const spawnPty = typeof mod.spawn === 'function' ? mod.spawn : mod.default?.spawn;
  if (typeof spawnPty !== 'function') throw new Error('@lydell/node-pty loaded but exports no spawn()');
  return spawnPty as NodePtySpawn;
}

async function loadBackend(log: Logger): Promise<BackendState> {
  try {
    const spawnPty = await loadNodePty();
    log.debug('terminal.backend', { backend: 'node-pty' });
    return { backend: nodePtyBackend(spawnPty) };
  } catch (err) {
    const nodePtyError = errorMessage(err);
    const scriptPath = findExecutable('script');
    if (scriptPath) {
      log.warn('terminal.node_pty.unavailable', { ...errorInfo(err), fallback: `script(1) at ${scriptPath}` });
      return { backend: scriptBackend(scriptPath, log), nodePtyError };
    }
    log.error('terminal.backend.unavailable', { ...errorInfo(err), hint: 'install util-linux script(1) or fix @lydell/node-pty' });
    return { backend: null, nodePtyError };
  }
}

// ---------------------------------------------------------------------------------------- helpers

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(name: string): string | null {
  if (name.includes('/')) {
    const abs = path.resolve(expandHome(name));
    return isExecutableFile(abs) ? abs : null;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Environment for tmux clients we spawn: never nested inside an enclosing tmux, UTF-8 by default. */
function tmuxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'C.UTF-8';
  return env;
}

/**
 * Window command for new tmux sessions. When the configured shell is tmux's own default we
 * pass nothing, so tmux starts its usual login shell and the user's `default-shell` /
 * `default-command` settings apply. Otherwise the shell is exec'd directly as a login shell.
 */
function resolveShellCommand(shell: string, log: Logger): string[] {
  const s = shell.trim();
  if (s === '' || s === '$SHELL' || s === (process.env.SHELL ?? '')) return [];
  const exe = findExecutable(s);
  if (!exe) {
    log.warn('terminal.shell.not_found', { shell: s, fallback: 'tmux default-shell' });
    return [];
  }
  return [exe, '-l'];
}

interface TmuxResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * `; set-option -t =<name>: <k> <v>` for each entry of `TMUX_SESSION_OPTIONS`, as tmux argv: a
 * bare `;` argument separates commands in one invocation. Callers drop the leading separator when
 * the sequence stands alone.
 */
export function sessionOptionCommands(name: string): string[] {
  return TMUX_SESSION_OPTIONS.flatMap(([k, v]) => [';', 'set-option', '-t', `=${name}:`, k, v]);
}

const TMUX_NOT_FOUND = /can't find (session|pane|window)|no server running|no sessions|error connecting to/i;

// ------------------------------------------------------------------------------- attached terminal

interface AttachOps {
  log: Logger;
  scrollback(): Promise<string>;
  resizeViaTmux(cols: number, rows: number): Promise<void>;
  onClosed(term: AttachedTerminal): void;
}

class AttachedTerminal implements TerminalSession {
  private readonly dataListeners = new Set<(chunk: Buffer) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();
  /** output seen before anyone subscribed (tmux redraws immediately on attach) */
  private pending: Buffer[] | null = [];
  private pendingBytes = 0;
  private readonly filter = new AltScreenFilter();
  private heldTimer: NodeJS.Timeout | null = null;
  private forceTimer: NodeJS.Timeout | null = null;
  private exitCode: number | null = null;
  private exited = false;
  private detaching = false;
  private lastSize: { cols: number; rows: number };
  private readonly exitedPromise: Promise<void>;
  private resolveExited: () => void = () => {};

  constructor(
    readonly id: string,
    readonly pid: number,
    private readonly handle: PtyHandle,
    private readonly ops: AttachOps,
    initialSize: { cols: number; rows: number },
  ) {
    this.lastSize = { ...initialSize };
    this.exitedPromise = new Promise<void>((res) => {
      this.resolveExited = res;
    });
    handle.onData((chunk) => this.ingest(chunk));
    handle.onExit((code) => this.finish(code));
  }

  get alive(): boolean {
    return !this.exited;
  }

  whenExited(): Promise<void> {
    return this.exitedPromise;
  }

  onData(cb: (chunk: Buffer) => void): Unsubscribe {
    this.dataListeners.add(cb);
    if (this.pending) {
      const buffered = this.pending;
      this.pending = null;
      this.pendingBytes = 0;
      for (const chunk of buffered) this.safeCall(cb, chunk);
    }
    return () => {
      this.dataListeners.delete(cb);
    };
  }

  onExit(cb: (code: number | null) => void): Unsubscribe {
    if (this.exited) {
      queueMicrotask(() => cb(this.exitCode));
      return () => {};
    }
    this.exitListeners.add(cb);
    return () => {
      this.exitListeners.delete(cb);
    };
  }

  write(data: Buffer | string): void {
    if (this.exited || this.detaching) return;
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (buf.length === 0) return;
    try {
      this.handle.write(buf);
    } catch (err) {
      this.ops.log.warn('terminal.write_failed', { id: this.id, ...errorInfo(err) });
    }
  }

  /**
   * Propagate the viewer's size to our tmux client (SIGWINCH → tmux re-lays out the window, which
   * follows the most recent client under the default `window-size latest`). Repeats of the current
   * size are dropped: viewers re-fit on every layout pass and a resize storm would make tmux redraw
   * for nothing.
   */
  resize(cols: number, rows: number): void {
    if (this.exited || this.detaching) return;
    const size = clampSize(cols, rows);
    if (size.cols === this.lastSize.cols && size.rows === this.lastSize.rows) return;
    this.lastSize = size;
    if (this.handle.supportsResize) {
      try {
        this.handle.resize(size.cols, size.rows);
      } catch (err) {
        this.ops.log.warn('terminal.resize_failed', { id: this.id, ...errorInfo(err) });
      }
      return;
    }
    void this.ops.resizeViaTmux(size.cols, size.rows).catch((err: unknown) => {
      this.ops.log.warn('terminal.resize_failed', { id: this.id, ...errorInfo(err) });
    });
  }

  scrollback(): Promise<string> {
    return this.ops.scrollback();
  }

  /** Kill our tmux client only; the tmux session (and the shell in it) keeps running. */
  detach(): void {
    if (this.exited || this.detaching) return;
    this.detaching = true;
    try {
      this.handle.kill('SIGHUP');
    } catch (err) {
      this.ops.log.debug('terminal.detach.kill_failed', { id: this.id, ...errorInfo(err) });
    }
    this.forceTimer = setTimeout(() => {
      this.forceTimer = null;
      if (this.exited) return;
      try {
        this.handle.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, DETACH_FORCE_MS);
    this.forceTimer.unref();
  }

  private ingest(chunk: Buffer): void {
    if (this.heldTimer) {
      clearTimeout(this.heldTimer);
      this.heldTimer = null;
    }
    const out = this.filter.push(chunk);
    if (out.length > 0) this.emit(out);
    if (this.filter.holding) {
      this.heldTimer = setTimeout(() => {
        this.heldTimer = null;
        const rest = this.filter.flush();
        if (rest.length > 0) this.emit(rest);
      }, HELD_FLUSH_MS);
    }
  }

  private emit(chunk: Buffer): void {
    if (this.pending) {
      while (this.pending.length > 0 && this.pendingBytes + chunk.length > PENDING_MAX_BYTES) {
        const dropped = this.pending.shift();
        this.pendingBytes -= dropped?.length ?? 0;
      }
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
      return;
    }
    for (const cb of this.dataListeners) this.safeCall(cb, chunk);
  }

  private safeCall(cb: (chunk: Buffer) => void, chunk: Buffer): void {
    try {
      cb(chunk);
    } catch (err) {
      this.ops.log.error('terminal.listener_failed', { id: this.id, ...errorInfo(err) });
    }
  }

  private finish(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    if (this.heldTimer) clearTimeout(this.heldTimer);
    if (this.forceTimer) clearTimeout(this.forceTimer);
    this.heldTimer = null;
    this.forceTimer = null;
    const rest = this.filter.flush();
    if (rest.length > 0) this.emit(rest);
    for (const cb of this.exitListeners) {
      try {
        cb(code);
      } catch (err) {
        this.ops.log.error('terminal.exit_listener_failed', { id: this.id, ...errorInfo(err) });
      }
    }
    this.exitListeners.clear();
    this.dataListeners.clear();
    this.pending = null;
    this.pendingBytes = 0;
    this.ops.onClosed(this);
    this.resolveExited();
  }
}

// -------------------------------------------------------------------------------- terminal manager

interface TerminalRecord {
  id: string;
  name: string;
  cwd: string;
  attaches: Set<AttachedTerminal>;
  touchedAt: number;
}

export class TerminalManager implements TerminalManagerLike {
  private readonly onAttach?: TerminalManagerOptions['onAttach'];
  private readonly log: Logger;
  private readonly prefix: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly shellCommand: string[];
  private readonly records = new Map<string, TerminalRecord>();
  private readonly ensuring = new Map<string, Promise<{ created: boolean; cwd: string }>>();
  private backendPromise: Promise<BackendState> | null = null;
  private closed = false;

  constructor(opts: TerminalManagerOptions) {
    this.onAttach = opts.onAttach;
    this.log = opts.log.child({ mod: 'terminal' });
    const prefix = opts.tmuxPrefix.trim();
    if (!TMUX_PREFIX_RE.test(prefix)) {
      throw new Error(`terminal.tmuxPrefix must match ${TMUX_PREFIX_RE.source} (got ${JSON.stringify(opts.tmuxPrefix)})`);
    }
    this.prefix = prefix;
    this.env = tmuxEnv();
    this.shellCommand = resolveShellCommand(opts.shell, this.log);
    // warm the pty backend and pick up tmux sessions that survived a daemon restart
    void this.backend();
    void this.refresh().catch((err: unknown) => this.log.debug('terminal.refresh_failed', errorInfo(err)));
  }

  /** tmux session name for a terminal id */
  sessionName(id: string): string {
    return `${this.prefix}-${id}`;
  }

  async attach(opts: { id: string; cwd: string; cols: number; rows: number }): Promise<TerminalSession> {
    if (this.closed) throw new Error('terminal manager is shut down');
    if (!isValidTerminalId(opts.id)) throw new BadRequestError('invalid terminal id (expected 1-64 chars of [a-zA-Z0-9_-])');
    if (typeof opts.cwd !== 'string' || opts.cwd.trim() === '') throw new BadRequestError('cwd required');
    const size = clampSize(opts.cols, opts.rows);
    const { backend } = await this.backend();
    if (!backend) {
      throw new Error('terminal unavailable: @lydell/node-pty failed to load and util-linux script(1) is not installed');
    }
    const name = this.sessionName(opts.id);
    const ensured = await this.ensureSession(name, path.resolve(opts.cwd), size);
    // Creation applies the options in the same tmux command sequence; sessions that already
    // existed (older daemon, user-made, adopted after a restart) get them here, before the
    // client attaches, so the status bar never appears in the first redraw.
    if (!ensured.created) await this.applySessionOptions(name);
    const rec = this.touch(opts.id, ensured.cwd);

    let handle: PtyHandle;
    try {
      handle = backend.spawn('tmux', ['-u', 'attach-session', '-t', `=${name}`], {
        cwd: fs.existsSync(rec.cwd) ? rec.cwd : os.homedir(),
        cols: size.cols,
        rows: size.rows,
        // tmux ≥ 3.2 reads the client's COLORTERM to enable RGB output for that client.
        env: { ...this.env, TERM: CLIENT_TERM, COLORTERM: 'truecolor' },
      });
    } catch (err) {
      this.log.error('terminal.attach.spawn_failed', { id: opts.id, backend: backend.kind, ...errorInfo(err) });
      throw new Error(`could not start terminal client: ${errorMessage(err)}`);
    }

    const term = new AttachedTerminal(
      opts.id,
      handle.pid,
      handle,
      {
        log: this.log,
        scrollback: () => this.captureScrollback(name),
        resizeViaTmux: (cols, rows) => this.resizeWindow(name, cols, rows),
        onClosed: (t) => {
          const r = this.records.get(t.id);
          if (r) {
            r.attaches.delete(t);
            r.touchedAt = Date.now();
          }
          this.log.info('terminal.detached', { id: t.id, pid: t.pid, attached: r?.attaches.size ?? 0 });
        },
      },
      size,
    );
    rec.attaches.add(term);
    try {
      this.onAttach?.(opts.id, rec.cwd);
    } catch (err) {
      this.log.warn('terminal.mirror_failed', errorInfo(err));
    }
    if (!handle.supportsResize) {
      // script(1) cannot size its pty from the outside; make tmux use the client's size directly
      void this.resizeWindow(name, size.cols, size.rows).catch((err: unknown) =>
        this.log.debug('terminal.resize_window_failed', { id: opts.id, ...errorInfo(err) }),
      );
    }
    this.log.info('terminal.attached', {
      id: opts.id,
      session: name,
      created: ensured.created,
      pid: handle.pid,
      backend: backend.kind,
      cols: size.cols,
      rows: size.rows,
      attached: rec.attaches.size,
    });
    return term;
  }

  list(): { id: string; cwd: string; attached: number }[] {
    return [...this.records.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({ id: r.id, cwd: r.cwd, attached: r.attaches.size }));
  }

  async kill(id: string): Promise<boolean> {
    if (!isValidTerminalId(id)) throw new BadRequestError('invalid terminal id');
    const name = this.sessionName(id);
    const rec = this.records.get(id);
    // drop our clients first so a `detach-on-destroy off` config cannot hop them to another session
    for (const t of rec?.attaches ?? []) t.detach();
    const r = await this.tmux(['kill-session', '-t', `=${name}`]);
    if (r.code === 0) {
      this.records.delete(id);
      this.log.info('terminal.killed', { id, session: name });
      return true;
    }
    if (TMUX_NOT_FOUND.test(r.stderr)) {
      if (rec && rec.attaches.size === 0) this.records.delete(id);
      return false;
    }
    throw new Error(`tmux kill-session failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  /** Detach every client we hold. tmux sessions are left running on purpose (they outlive the daemon). */
  async shutdown(): Promise<void> {
    this.closed = true;
    const live: AttachedTerminal[] = [];
    for (const rec of this.records.values()) for (const t of rec.attaches) if (t.alive) live.push(t);
    for (const t of live) t.detach();
    if (live.length > 0) {
      const timeout = new Promise<void>((res) => setTimeout(res, SHUTDOWN_WAIT_MS).unref());
      await Promise.race([Promise.all(live.map((t) => t.whenExited())).then(() => undefined), timeout]);
    }
    this.log.info('terminal.shutdown', { detached: live.length, sessionsKept: this.records.size });
  }

  async doctor(): Promise<{ ok: boolean; detail: string }> {
    const parts: string[] = [];
    const v = await this.tmux(['-V']);
    const tmuxOk = v.code === 0;
    parts.push(tmuxOk ? v.stdout.trim() : `tmux missing (${v.stderr.trim() || `exit ${v.code}`})`);
    const state = await this.backend();
    if (!state.backend) {
      parts.push(`pty: UNAVAILABLE — @lydell/node-pty failed to load (${state.nodePtyError ?? 'unknown error'}) and script(1) is not installed`);
    } else if (state.backend.kind === 'node-pty') {
      parts.push('pty: @lydell/node-pty');
    } else {
      parts.push(`pty: FALLBACK ${state.backend.detail} — @lydell/node-pty failed to load (${state.nodePtyError ?? 'unknown error'}); resize goes through tmux`);
    }
    if (tmuxOk) {
      await this.refresh();
      let attached = 0;
      for (const r of this.records.values()) attached += r.attaches.size;
      parts.push(`${this.records.size} ${this.prefix}-* session(s), ${attached} attached`);
    }
    return { ok: tmuxOk && state.backend !== null, detail: parts.join('; ') };
  }

  /** Sync the registry with tmux: adopt `<prefix>-*` sessions from before a restart, drop vanished ones. */
  async refresh(): Promise<void> {
    const startedAt = Date.now();
    const r = await this.tmux(['list-sessions', '-F', '#{session_name}\t#{session_path}']);
    const seen = new Set<string>();
    if (r.code === 0) {
      for (const line of r.stdout.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const name = line.slice(0, tab);
        const cwd = line.slice(tab + 1);
        if (!name.startsWith(`${this.prefix}-`)) continue;
        const id = name.slice(this.prefix.length + 1);
        if (!isValidTerminalId(id)) continue;
        seen.add(id);
        const rec = this.records.get(id);
        if (rec) {
          if (rec.attaches.size === 0 && cwd) rec.cwd = cwd;
        } else {
          this.records.set(id, { id, name, cwd: cwd || os.homedir(), attaches: new Set(), touchedAt: startedAt });
        }
      }
    } else if (!TMUX_NOT_FOUND.test(r.stderr)) {
      this.log.debug('terminal.list_sessions_failed', { stderr: r.stderr.trim(), code: r.code });
      return;
    }
    for (const [id, rec] of this.records) {
      if (!seen.has(id) && rec.attaches.size === 0 && rec.touchedAt <= startedAt) this.records.delete(id);
    }
  }

  // ------------------------------------------------------------------------------------ internals

  private backend(): Promise<BackendState> {
    if (!this.backendPromise) this.backendPromise = loadBackend(this.log);
    return this.backendPromise;
  }

  private touch(id: string, cwd: string): TerminalRecord {
    let rec = this.records.get(id);
    if (!rec) {
      rec = { id, name: this.sessionName(id), cwd, attaches: new Set(), touchedAt: Date.now() };
      this.records.set(id, rec);
    } else {
      rec.touchedAt = Date.now();
    }
    return rec;
  }

  /** Make sure the tmux session exists; concurrent attaches to the same id share one attempt. */
  private ensureSession(name: string, cwd: string, size: { cols: number; rows: number }): Promise<{ created: boolean; cwd: string }> {
    const inflight = this.ensuring.get(name);
    if (inflight) return inflight;
    const p = this.ensureSessionNow(name, cwd, size).finally(() => {
      this.ensuring.delete(name);
    });
    this.ensuring.set(name, p);
    return p;
  }

  private async ensureSessionNow(name: string, cwd: string, size: { cols: number; rows: number }): Promise<{ created: boolean; cwd: string }> {
    const has = await this.tmux(['has-session', '-t', `=${name}`]);
    if (has.code === 0) {
      const existing = await this.tmux(['display-message', '-p', '-t', `=${name}:`, '#{session_path}']);
      const sessionPath = existing.code === 0 ? existing.stdout.trim() : '';
      return { created: false, cwd: sessionPath || cwd };
    }
    if (has.code === null && /ENOENT/.test(has.stderr)) throw new Error('tmux is not installed (required for terminals)');
    const st = await fs.promises.stat(cwd).catch(() => null);
    if (!st?.isDirectory()) throw new BadRequestError(`cwd is not a directory: ${cwd}`);
    const base = ['new-session', '-d', '-s', name, '-c', cwd, '-x', String(size.cols), '-y', String(size.rows)];
    const envFlags = TMUX_SESSION_ENV.flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    // One tmux invocation: create, then set the session options — a client can only attach afterwards.
    const command = (create: string[]): string[] => [...create, ...this.shellCommand, ...sessionOptionCommands(name)];
    let created = await this.tmux(command([...base, ...envFlags]));
    if (created.code !== 0 && envFlags.length > 0 && /unknown flag|usage:/i.test(created.stderr)) {
      this.log.debug('terminal.new_session.no_env_flag', { stderr: created.stderr.trim() });
      created = await this.tmux(command(base));
    }
    if (created.code === 0) {
      this.log.info('terminal.session_created', { session: name, cwd, shell: this.shellCommand[0] ?? 'tmux default' });
      return { created: true, cwd };
    }
    if (/duplicate session/i.test(created.stderr)) return { created: false, cwd };
    throw new Error(`tmux new-session failed: ${created.stderr.trim() || `exit ${created.code}`}`);
  }

  /** `TMUX_SESSION_OPTIONS` on an existing session; failures are logged, never fatal for the attach. */
  private async applySessionOptions(name: string): Promise<void> {
    const r = await this.tmux(sessionOptionCommands(name).slice(1));
    if (r.code !== 0) this.log.warn('terminal.session_options_failed', { session: name, stderr: r.stderr.trim(), code: r.code });
  }

  private async captureScrollback(name: string): Promise<string> {
    // -e keeps colours, -J joins wrapped lines so history re-wraps at the viewer's own width.
    const r = await this.tmux(['capture-pane', '-p', '-e', '-J', '-S', `-${SCROLLBACK_LINES}`, '-t', `=${name}:`], { maxBytes: CAPTURE_MAX_BYTES });
    if (r.code !== 0) {
      this.log.debug('terminal.capture_failed', { session: name, stderr: r.stderr.trim() });
      return '';
    }
    return formatScrollback(r.stdout, SCROLLBACK_MAX_BYTES);
  }

  private async resizeWindow(name: string, cols: number, rows: number): Promise<void> {
    const r = await this.tmux(['resize-window', '-t', `=${name}:`, '-x', String(cols), '-y', String(rows)]);
    if (r.code !== 0) throw new Error(`tmux resize-window failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  private tmux(args: string[], opts: { maxBytes?: number } = {}): Promise<TmuxResult> {
    const maxBytes = opts.maxBytes ?? 1024 * 1024;
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnChild('tmux', args, { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ code: null, stdout: '', stderr: errorMessage(err) });
        return;
      }
      const out: Buffer[] = [];
      let size = 0;
      let stderr = '';
      let done = false;
      const finish = (code: number | null, err?: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: err ?? stderr });
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(null, `tmux ${args[0] ?? ''} timed out after ${TMUX_TIMEOUT_MS} ms`);
      }, TMUX_TIMEOUT_MS);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (size >= maxBytes) return;
        const room = maxBytes - size;
        out.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += Math.min(chunk.length, room);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => finish(null, err.message));
      child.on('close', (code) => finish(code));
    });
  }
}
