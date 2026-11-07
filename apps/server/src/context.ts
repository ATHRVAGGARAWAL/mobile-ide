/**
 * Integration contract shared by every server module. Modules are built in parallel
 * against these types; app.ts constructs the concrete ServerContext.
 */
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import type { Hono } from 'hono';
import type { LoadedConfig } from './config.js';
import type { Db, DeviceRow } from './db.js';
import type { EventBus, Unsubscribe } from './events.js';
import type { GitService } from './git.js';
import type { Logger } from './log.js';
import type { Notifier } from './notify.js';
import type { PathPolicy } from './paths.js';
import type { ProjectScanner } from './projects.js';
import type { SessionManager } from './sessions.js';
import type { StudioLauncher } from './studio.js';

/** One attached terminal (tmux-backed pty). Detaching keeps the tmux session alive. */
export interface TerminalSession {
  readonly id: string;
  onData(cb: (chunk: Buffer) => void): Unsubscribe;
  onExit(cb: (code: number | null) => void): Unsubscribe;
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  /** last N bytes of scrollback for a fresh attach */
  scrollback(): Promise<string>;
  detach(): void;
}

export interface TerminalManagerLike {
  attach(opts: { id: string; cwd: string; cols: number; rows: number }): Promise<TerminalSession>;
  /** registry as of the last refresh(); `attached` counts live /ws/terminal clients */
  list(): { id: string; cwd: string; attached: number }[];
  /** sync the registry with tmux (adopt sessions from before a restart, drop vanished ones) */
  refresh(): Promise<void>;
  /** kill the tmux session; false when it did not exist */
  kill(id: string): Promise<boolean>;
  shutdown(): Promise<void>;
  /** for `mide doctor` */
  doctor(): Promise<{ ok: boolean; detail: string }>;
}

export interface ServerContext {
  config: LoadedConfig;
  db: Db;
  bus: EventBus;
  sessions: SessionManager;
  projects: ProjectScanner;
  git: GitService;
  notifier: Notifier;
  policy: PathPolicy;
  terminals: TerminalManagerLike;
  /** set once the WebSocket layer is up (it needs the connected-client list); null in unit tests that build a bare context */
  studio: StudioLauncher | null;
  log: Logger;
  startedAt: number;
  version: string;
  serverName: string;
}

/** Variables set by the auth middleware on authenticated Hono routes. */
export type AuthedEnv = { Variables: { device: DeviceRow } };

/** http.ts */
export type CreateHttpApp = (ctx: ServerContext) => Hono<AuthedEnv>;

/** ws.ts — owns BOTH upgrades: /ws (events) and /ws/terminal (pty). `clients()` lists the connected /ws peers by hello name. */
export type AttachWebSockets = (
  server: http.Server,
  ctx: ServerContext,
) => { clients(): { clientName: string | null; deviceId: string }[]; close(): Promise<void> };

export interface RunningServer {
  ctx: ServerContext;
  server: http.Server;
  port: number;
  url: string;
  close(opts?: { drainMs?: number; cancelTurns?: boolean }): Promise<void>;
}
/** app.ts */
export type StartServer = (opts?: {
  configPath?: string;
  overrides?: Partial<LoadedConfig['config']>;
  home?: string;
}) => Promise<RunningServer>;

export type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
