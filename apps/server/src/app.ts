/**
 * Bootstrap: wire every module into one ServerContext, listen, and shut down in order.
 * Used by `mide serve` and by the e2e tests (which pass `home` + `overrides`).
 *
 * Start order:  config → Db → EventBus/Git/Policy/Projects/Notifier → SessionManager →
 *               TerminalManager → sessions.boot() → HTTP listen → WebSockets → prewarm (background)
 * Stop order:   stop accepting → close sockets → drain sessions → detach terminals → close HTTP → close Db
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { loadConfig, resolveShell, type Config, type LoadedConfig } from './config.js';
import type { AuthedEnv, RunningServer, ServerContext, StartServer } from './context.js';
import { Db } from './db.js';
import { EventBus } from './events.js';
import { GitService } from './git.js';
import { createHttpApp } from './http.js';
import { createLogger, errorInfo } from './log.js';
import { Notifier } from './notify.js';
import { buildPolicy } from './paths.js';
import { ProjectScanner } from './projects.js';
import { SessionManager } from './sessions.js';
import { StudioLauncher } from './studio.js';
import { TerminalMirror } from './terminal-mirror.js';
import { TerminalManager } from './terminal.js';
import { SERVER_VERSION } from './version.js';
import { attachWebSockets } from './ws.js';

const log = createLogger({ mod: 'app' });

/** How long a graceful stop waits for running turns before SIGINT-ing the agents. */
export const DEFAULT_DRAIN_MS = 60_000;

/** `loadConfig` reads MIDE_HOME from the environment; scope an explicit `home` to that one call. */
function loadConfigIn(home: string | undefined, opts: { configPath?: string; overrides?: Partial<Config> }): LoadedConfig {
  if (home === undefined) return loadConfig(opts);
  const previous = process.env.MIDE_HOME;
  process.env.MIDE_HOME = home;
  try {
    return loadConfig(opts);
  } finally {
    if (previous === undefined) delete process.env.MIDE_HOME;
    else process.env.MIDE_HOME = previous;
  }
}

/** Host as it should appear in a URL: wildcard binds become loopback, IPv6 gets brackets. */
function urlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

/** Start listening; resolves with the underlying http.Server or rejects (e.g. EADDRINUSE) — never throws async. */
function listen(app: Hono<AuthedEnv>, port: number, hostname: string): Promise<http.Server> {
  return new Promise<http.Server>((resolve, reject) => {
    let settled = false;
    const server = serve({ fetch: app.fetch, port, hostname }, () => {
      if (settled) return;
      settled = true;
      server.off('error', onError);
      resolve(server as http.Server);
    });
    if (!(server instanceof http.Server)) {
      settled = true;
      reject(new Error('expected @hono/node-server to create an http.Server'));
      return;
    }
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    server.once('error', onError);
  });
}

/** Run one shutdown step with a deadline; log instead of throwing so later steps still run. */
async function step(name: string, fn: () => Promise<unknown> | unknown, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((res) => {
    timer = setTimeout(() => res('timeout'), timeoutMs);
    timer.unref?.();
  });
  const t0 = Date.now();
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(fn)
        .then(() => 'done' as const),
      deadline,
    ]);
    if (outcome === 'timeout') log.warn('shutdown.step.timeout', { step: name, timeoutMs });
    else log.debug('shutdown.step.done', { step: name, ms: Date.now() - t0 });
  } catch (err) {
    log.warn('shutdown.step.failed', { step: name, ...errorInfo(err) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const startServer: StartServer = async (opts = {}) => {
  // ConfigSchema requires port >= 1; `port: 0` in overrides means "any free port" (tests), so it is
  // applied after validation and replaced by the real port once the server is listening.
  const ephemeral = opts.overrides?.port === 0;
  const overrides = ephemeral ? { ...opts.overrides, port: undefined } : opts.overrides;
  const loaded = loadConfigIn(opts.home, { configPath: opts.configPath, overrides });
  const { config } = loaded;
  if (ephemeral) config.port = 0;
  const startedAt = Date.now();
  log.info('starting', {
    version: SERVER_VERSION,
    node: process.version,
    home: loaded.home,
    config: loaded.configPath,
    host: config.host,
    port: config.port,
  });

  const db = new Db(loaded.dbPath);
  let sessions: SessionManager | null = null;
  let terminals: TerminalManager | null = null;
  let server: http.Server | null = null;
  try {
    const bus = new EventBus();
    const git = new GitService(config.limits.maxDiffBytes);
    // The state directory is denylisted whatever MIDE_HOME points at: config.json holds the VAPID private key and
    // mide.db the device token hashes, and a home under a project root would otherwise be readable via /api/fs.
    const policy = buildPolicy(config.projects.roots, [...config.projects.denylist, loaded.home]);
    const projects = new ProjectScanner(policy, git);
    // Auto-generated VAPID keys must land in the config file that was actually loaded (`-c <path>`), or every
    // restart would mint a new pair and silently break every Web Push subscription.
    const notifier = new Notifier(db, config, { configPath: loaded.configPath });
    // Agent adapters are spawned in the user's home; they only see MIDE_HOME through config paths.
    sessions = new SessionManager(db, config, bus, notifier, policy, os.homedir());
    const terminalMirror = new TerminalMirror(config.terminal.tmuxPrefix);
    terminals = new TerminalManager({
      onAttach: config.terminal.autoOpen
        ? (id, cwd) => { void terminalMirror.open(id, cwd); }
        : undefined,
      shell: resolveShell(config),
      tmuxPrefix: config.terminal.tmuxPrefix,
      log: createLogger({ mod: 'terminal' }),
    });

    const ctx: ServerContext = {
      config: loaded,
      db,
      bus,
      sessions,
      projects,
      git,
      notifier,
      policy,
      terminals,
      studio: null,
      log,
      startedAt,
      version: SERVER_VERSION,
      serverName: config.serverName,
    };

    // Close out turns/permissions interrupted by the previous instance before anyone can connect.
    sessions.boot();

    const app = createHttpApp(ctx);
    server = await listen(app, config.port, config.host);
    server.on('error', (err) => log.error('http.server_error', errorInfo(err)));
    const address = server.address() as AddressInfo | null;
    const port = address?.port ?? config.port;
    if (config.port === 0) config.port = port; // ephemeral port (tests): let local URLs reflect reality
    const url = `http://${urlHost(config.host)}:${port}`;

    const sockets = attachWebSockets(server, ctx);
    // Pops the laptop editor open on session.created; needs the socket layer to know whether a Studio is already there.
    const studio = new StudioLauncher(loaded, db, bus, () => sockets.clients());
    ctx.studio = studio;
    const boundServer = server;
    const boundSessions = sessions;
    const boundTerminals = terminals;

    log.info('listening', {
      url,
      publicUrl: config.publicUrl,
      agents: Object.entries(config.agents)
        .filter(([, a]) => a.enabled)
        .map(([id]) => id),
      roots: policy.roots,
      studioAutoOpen: config.studio.autoOpen,
    });

    // Spawn + initialize every agent so the first session is fast. Never throws.
    void boundSessions.prewarm().then(() => log.info('prewarm.done', { agents: boundSessions.health().agents }));
    // Space reclaim after pruning runs with the port already bound, so a large database never delays "listening".
    setImmediate(() => boundSessions.maintain());

    let closing: Promise<void> | null = null;
    const close = (o: { drainMs?: number; cancelTurns?: boolean } = {}): Promise<void> => {
      closing ??= (async () => {
        const drainMs = o.drainMs ?? DEFAULT_DRAIN_MS;
        const cancelTurns = o.cancelTurns ?? false;
        const t0 = Date.now();
        log.info('shutdown.begin', { drainMs, cancelTurns });
        // 1. stop accepting new HTTP connections and upgrades; idle keep-alive sockets go now
        const serverClosed = new Promise<void>((resolve) => boundServer.close(() => resolve()));
        boundServer.closeIdleConnections();
        // 2. drop WebSocket clients (they replay from their last seq when the daemon is back); no more Studio launches
        studio.stop();
        await step('sockets', () => sockets.close(), 5_000);
        // 3. let running turns finish (or cancel them), then SIGINT the adapters
        await step('sessions', () => boundSessions.shutdown({ drainMs, cancelTurns }), drainMs + 20_000);
        // 4. detach ptys; the tmux sessions themselves stay alive
        await step('terminals', () => boundTerminals.shutdown(), 10_000);
        // 5. anything still connected over HTTP is cut, then wait for the server to report closed
        boundServer.closeAllConnections();
        await step('http', () => serverClosed, 5_000);
        // 6. the DB goes last: every step above may still append events
        db.close();
        log.info('shutdown.done', { ms: Date.now() - t0 });
      })();
      return closing;
    };

    const running: RunningServer = { ctx, server, port, url, close };
    return running;
  } catch (err) {
    log.error('start.failed', errorInfo(err));
    // Undo whatever got built so a failed start leaves no processes or open handles behind.
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve())).catch(() => {});
    if (sessions) await sessions.shutdown({ drainMs: 0, cancelTurns: true }).catch(() => {});
    if (terminals) await terminals.shutdown().catch(() => {});
    db.close();
    throw err;
  }
};
