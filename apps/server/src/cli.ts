/**
 * `mide` command line: serve | pair | devices | vapid | terminals | studio | doctor.
 * Entry point of bin/mide.js (via dist/cli.js) and of `pnpm --filter @mobile-ide/server dev`.
 */
import { Command, InvalidArgumentError } from 'commander';
import qrcode from 'qrcode-terminal';
import { ZodError } from 'zod';
import { generatePairingCode, PAIRING_CODE_TTL_MS } from './auth.js';
import { loadConfig, publicOrLocalUrl, resolveShell, type Config } from './config.js';
import type { RunningServer } from './context.js';
import { Db, type DeviceRow } from './db.js';
import { DEFAULT_AGENT_TIMEOUT_MS, formatCheck, formatSummary, runDoctor } from './doctor.js';
import { errorMessage } from './errors.js';
import { createLogger, errorInfo, log, setLogLevel } from './log.js';
import { openStudio } from './studio.js';
import { SERVER_VERSION } from './version.js';

const out = (line = ''): void => {
  process.stdout.write(line + '\n');
};
const err = (line = ''): void => {
  process.stderr.write(line + '\n');
};
const useColor = (stream: NodeJS.WriteStream): boolean => stream.isTTY && !process.env.NO_COLOR;

/** Human-readable message for startup failures (config validation errors arrive as ZodError). */
function describeFailure(e: unknown): string {
  if (e instanceof ZodError) return `invalid config: ${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`;
  return errorMessage(e);
}

function parseIntInRange(label: string, min: number, max: number): (v: string) => number {
  return (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new InvalidArgumentError(`${label} must be an integer between ${min} and ${max}`);
    return n;
  };
}

function fmtWhen(ts: number | null): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtAgo(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

// ---------------------------------------------------------------------------- serve
interface ServeOptions {
  port?: number;
  host?: string;
  config?: string;
}

/** Keep one bad promise or agent from taking the daemon down; systemd restarts us only on a true crash. */
function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled_rejection', errorInfo(reason));
  });
  process.on('uncaughtException', (error) => {
    log.error('uncaught_exception', errorInfo(error));
    // State may be inconsistent: stop quickly but cleanly (short drain), then let systemd bring us back.
    void forceShutdown('uncaught_exception', 1, { drainMs: 5_000, cancelTurns: true });
  });
}

let running: RunningServer | null = null;
let shuttingDown = false;

async function forceShutdown(reason: string, exitCode: number, opts: { drainMs: number; cancelTurns: boolean }): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown.requested', { reason, ...opts });
  const hardDeadline = setTimeout(() => {
    log.error('shutdown.deadline', { reason, ms: opts.drainMs + 25_000 });
    process.exit(1);
  }, opts.drainMs + 25_000);
  hardDeadline.unref();
  try {
    if (running) await running.close(opts);
  } catch (e) {
    log.error('shutdown.failed', errorInfo(e));
    exitCode = exitCode || 1;
  }
  clearTimeout(hardDeadline);
  process.exit(exitCode);
}

async function runServe(o: ServeOptions): Promise<void> {
  installProcessGuards();
  // Loaded lazily so `pair`, `devices` and `doctor` never pull in the full server graph (pty, ws, hono).
  const { DEFAULT_DRAIN_MS, startServer } = await import('./app.js');
  const overrides: Partial<Config> = {};
  if (o.port !== undefined) overrides.port = o.port;
  if (o.host) overrides.host = o.host;
  try {
    running = await startServer(o.config ? { configPath: o.config, overrides } : { overrides });
  } catch (e) {
    const code = (e as { code?: string }).code;
    err(`mide: failed to start: ${describeFailure(e)}`);
    if (code === 'EADDRINUSE')
      err(
        `mide: port ${o.port ?? 'from config'} is taken — is another \`mide serve\` (or the systemd unit) already running? Try \`mide doctor\`.`,
      );
    process.exitCode = 1;
    return;
  }
  const { config } = running.ctx.config;
  if (process.stderr.isTTY) {
    err(`mide v${SERVER_VERSION} listening on ${running.url}${config.publicUrl ? ` (public: ${config.publicUrl})` : ''}`);
    err('pair a phone with `mide pair`; stop with Ctrl-C (running turns get up to 60 s to finish)');
  }
  const drainMs = Number(process.env.MIDE_DRAIN_MS) > 0 ? Number(process.env.MIDE_DRAIN_MS) : DEFAULT_DRAIN_MS;
  const cancelTurns = process.env.MIDE_DRAIN === 'cancel';
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      if (shuttingDown) {
        log.warn('shutdown.forced', { signal });
        process.exit(130);
      }
      void forceShutdown(signal, 0, { drainMs, cancelTurns });
    });
  }
}

// ---------------------------------------------------------------------------- pair
interface PairOptions {
  name: string;
  ttl: number;
  config?: string;
  qr: boolean;
}

function renderQr(text: string): Promise<string> {
  return new Promise((resolve) => qrcode.generate(text, { small: true }, (q) => resolve(q)));
}

async function runPair(o: PairOptions): Promise<void> {
  const loaded = loadConfig(o.config ? { configPath: o.config } : {});
  const db = new Db(loaded.dbPath);
  let code: string;
  let expiresAt: number;
  try {
    code = generatePairingCode();
    ({ expiresAt } = db.createPairingCode(code, o.ttl * 60_000));
  } finally {
    db.close();
  }
  const base = publicOrLocalUrl(loaded.config).replace(/\/+$/, '');
  const url = `${base}/pair#${code}`;
  const deepLink = `mobileide://pair?server=${encodeURIComponent(base)}&code=${code}`;
  const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
  out();
  out(`  Pairing code for ${o.name}:   ${pretty}`);
  out(`  Valid until:                ${fmtWhen(expiresAt)} (${o.ttl} min, single use)`);
  out();
  out(`  Open on the phone:          ${url}`);
  out(`  Native app link:            ${deepLink}`);
  out();
  if (o.qr) {
    out((await renderQr(url)).replace(/^/gm, '  '));
    out();
  }
  out('  Safari: open the link → Share → Add to Home Screen → open the new icon → the code is prefilled.');
  out('  Native app: Pair → scan the QR or type the code.');
  if (!loaded.config.publicUrl) {
    out();
    out(`  Note: "publicUrl" is not set in ${loaded.configPath}, so the link uses the loopback address.`);
    out('        The phone cannot open that. Set publicUrl to your `tailscale serve` URL (mide doctor shows it).');
  }
  out();
}

// ---------------------------------------------------------------------------- devices
interface DevicesOptions {
  revoke?: string;
  json?: boolean;
  config?: string;
}

function resolveDevice(devices: DeviceRow[], idOrPrefix: string): DeviceRow {
  const exact = devices.find((d) => d.id === idOrPrefix);
  if (exact) return exact;
  const matches = devices.filter((d) => d.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no device with id ${idOrPrefix}`);
  throw new Error(`ambiguous id prefix ${idOrPrefix}: ${matches.map((d) => `${d.id} (${d.name})`).join(', ')}`);
}

async function runDevices(o: DevicesOptions): Promise<void> {
  const loaded = loadConfig(o.config ? { configPath: o.config } : {});
  const db = new Db(loaded.dbPath);
  try {
    if (o.revoke) {
      const device = resolveDevice(db.listDevices(), o.revoke);
      if (device.revokedAt) {
        out(`${device.name} (${device.id}) was already revoked ${fmtAgo(device.revokedAt)}.`);
      } else if (db.revokeDevice(device.id)) {
        out(
          `Revoked ${device.name} (${device.id}). Its token and push subscriptions are gone; open WebSockets drop at their next reconnect.`,
        );
      } else {
        throw new Error(`could not revoke ${device.id}`);
      }
      return;
    }
    const devices = db.listDevices();
    if (o.json) {
      out(JSON.stringify(devices, null, 2));
      return;
    }
    if (devices.length === 0) {
      out('No paired devices. Run `mide pair` to get a code.');
      return;
    }
    const rows: string[][] = [['ID', 'NAME', 'PLATFORM', 'PAIRED', 'LAST SEEN', 'STATUS']];
    for (const d of devices) {
      rows.push([
        d.id.slice(0, 8),
        d.name,
        d.platform ?? '-',
        fmtWhen(d.createdAt),
        fmtAgo(d.lastSeen),
        d.revokedAt ? `revoked ${fmtAgo(d.revokedAt)}` : 'active',
      ]);
    }
    out(table(rows));
    out();
    out('Revoke with `mide devices --revoke <id>` (an unambiguous prefix is enough); `--json` prints full ids.');
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------- vapid
interface VapidOptions {
  rotate?: boolean;
  json?: boolean;
  config?: string;
}

/**
 * Web Push (VAPID) keys: create them in config.json when missing and print the public key.
 * The daemon does the same at startup, so this is for rotating a pair, for a config it cannot
 * write, or for seeing the key without starting anything. The private key never leaves the file.
 */
async function runVapid(o: VapidOptions): Promise<void> {
  const loaded = loadConfig(o.config ? { configPath: o.config } : {});
  // Lazy: pulls in `web-push`, which `pair`/`devices`/`doctor` do not need.
  const { ensureVapidKeys, vapidState } = await import('./notify.js');
  const before = vapidState(loaded.config).state;
  const result = ensureVapidKeys(loaded.config, { configPath: loaded.configPath, rotate: o.rotate === true });
  if (!result.persisted) throw new Error(`could not store the keys in ${loaded.configPath}: ${result.persistError ?? 'unknown error'}`);
  const subject = loaded.config.notifications.webpush.subject;
  const rotated = o.rotate === true && before !== 'missing';
  if (o.json) {
    out(
      JSON.stringify(
        { publicKey: result.keys.publicKey, subject, configPath: loaded.configPath, created: result.created, rotated },
        null,
        2,
      ),
    );
    return;
  }
  out();
  if (result.created) out(`  ${rotated ? 'Rotated' : 'Generated'} the Web Push (VAPID) key pair and saved it to ${loaded.configPath}`);
  else out(`  Web Push (VAPID) keys are already in ${loaded.configPath}`);
  out();
  out(`  Public key:  ${result.keys.publicKey}`);
  out(`  Subject:     ${subject}`);
  out();
  out('  The installed web app fetches this key from GET /api/push/vapid by itself; paste it into');
  out('  Settings → Notifications → Web Push only when the app cannot get it from the daemon.');
  if (result.created) {
    out();
    out('  If the daemon is running, restart it (systemctl --user restart mobile-ide) so it signs pushes with this pair.');
    if (rotated)
      out(
        '  Browsers subscribed with the old key stop receiving pushes until they re-enable Web Push (the app re-subscribes on its next launch).',
      );
  }
  out();
}

// ---------------------------------------------------------------------------- terminals
interface TerminalsOptions {
  kill?: string;
  killAll?: boolean;
  json?: boolean;
  config?: string;
}

/**
 * The tmux sessions behind the Terminal tab (`<tmuxPrefix>-<id>`). They outlive the daemon on purpose, so a shell
 * the app stopped using ("New shell") keeps running until someone kills it — here, or from the app's terminal menu.
 */
async function runTerminals(o: TerminalsOptions): Promise<void> {
  const loaded = loadConfig(o.config ? { configPath: o.config } : {});
  // Lazy: the terminal manager pulls in node-pty, which pair/devices/doctor never need.
  const { TerminalManager } = await import('./terminal.js');
  const manager = new TerminalManager({
    shell: resolveShell(loaded.config),
    tmuxPrefix: loaded.config.terminal.tmuxPrefix,
    log: createLogger({ mod: 'terminal' }),
  });
  try {
    await manager.refresh();
    const shells = manager.list();
    if (o.kill) {
      if (await manager.kill(o.kill)) out(`Killed tmux session ${manager.sessionName(o.kill)}.`);
      else throw new Error(`no shell with id ${o.kill} (run \`mide terminals\` to list them)`);
      return;
    }
    if (o.killAll) {
      let n = 0;
      for (const s of shells) if (await manager.kill(s.id)) n++;
      out(n === 0 ? 'No shells to kill.' : `Killed ${n} tmux session${n === 1 ? '' : 's'}.`);
      return;
    }
    if (o.json) {
      out(
        JSON.stringify(
          shells.map((s) => ({ id: s.id, session: manager.sessionName(s.id), cwd: s.cwd })),
          null,
          2,
        ),
      );
      return;
    }
    if (shells.length === 0) {
      out(`No ${loaded.config.terminal.tmuxPrefix}-* tmux sessions.`);
      return;
    }
    const rows: string[][] = [['ID', 'TMUX SESSION', 'DIRECTORY']];
    for (const s of shells) rows.push([s.id, manager.sessionName(s.id), s.cwd]);
    out(table(rows));
    out();
    out('Join one: `tmux attach -t <session>`. Kill: `mide terminals --kill <id>` or `--kill-all` (stops whatever runs inside).');
  } finally {
    await manager.shutdown();
  }
}

// ---------------------------------------------------------------------------- doctor
interface DoctorCliOptions {
  json?: boolean;
  config?: string;
  agentTimeout: number;
}

async function runDoctorCommand(o: DoctorCliOptions): Promise<void> {
  const color = useColor(process.stdout);
  const stream = !o.json;
  if (stream) {
    out(`mide doctor v${SERVER_VERSION} · ${process.version}`);
    out();
  }
  const report = await runDoctor({
    ...(o.config ? { configPath: o.config } : {}),
    agentTimeoutMs: o.agentTimeout * 1000,
    onCheck: (check) => {
      if (stream) out(formatCheck(check, { color }));
    },
  });
  if (o.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out();
    out(formatSummary(report, { color }));
    if (!report.ok) out('Fix the FAIL rows before enabling the service; WARN rows matter once the phone is involved.');
  }
  process.exitCode = report.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------- studio
interface StudioCliOptions {
  session?: string;
  open: boolean;
  config?: string;
}

/** Open the Studio window from a shell: mints the one-time code straight into the DB, so it works with the daemon running as a service. */
async function runStudio(o: StudioCliOptions): Promise<void> {
  const loaded = loadConfig(o.config ? { configPath: o.config } : {});
  const health = await fetch(`${publicOrLocalUrl(loaded.config).replace(/\/+$/, '')}/api/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!health)
    err(`mide: no daemon answers on ${publicOrLocalUrl(loaded.config)} — start it first (mide serve / systemctl --user start mobile-ide)`);
  const db = new Db(loaded.dbPath);
  try {
    const result = await openStudio(loaded, db, o.session ? { sessionId: o.session, dryRun: !o.open } : { dryRun: !o.open });
    if (result.opened) out(`Studio opened in ${result.browser ?? 'the browser'}: ${result.url.replace(/#.*$/, '')}`);
    else if (o.open) {
      err(`mide: could not open the Studio: ${result.reason ?? 'unknown reason'}`);
      out(`Open it yourself: ${result.url}`);
      process.exitCode = 1;
    } else out(result.url);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------- program
export function buildProgram(): Command {
  const program = new Command('mide')
    .description('mobile-ide daemon: drive Claude Code, Codex, OpenCode (any ACP agent) from your phone')
    .version(SERVER_VERSION, '-v, --version')
    .showHelpAfterError('(run with --help for usage)');

  program
    .command('serve')
    .description('run the daemon in the foreground (structured JSON logs on stdout; MIDE_LOG=debug for more)')
    .option('-p, --port <n>', 'listen port (overrides config)', parseIntInRange('port', 0, 65_535))
    .option('-H, --host <host>', 'bind address (overrides config, default 127.0.0.1)')
    .option('-c, --config <path>', 'config file (default: $MIDE_HOME/config.json, ~/.mobile-ide/config.json)')
    .addHelpText(
      'after',
      '\nStop: SIGINT/SIGTERM let running turns finish for up to 60 s (MIDE_DRAIN=cancel cancels them, MIDE_DRAIN_MS overrides the wait).',
    )
    .action((o: ServeOptions) => runServe(o));

  program
    .command('pair')
    .description('mint a one-time pairing code and print it with its URL and a QR code')
    .option('-n, --name <name>', 'what you are pairing (label only)', 'iPhone')
    .option('-t, --ttl <minutes>', 'how long the code stays valid', parseIntInRange('ttl', 1, 24 * 60), PAIRING_CODE_TTL_MS / 60_000)
    .option('--no-qr', 'do not print the QR code')
    .option('-c, --config <path>', 'config file')
    .action((o: PairOptions) => runPair(o));

  program
    .command('devices')
    .description('list paired devices, or revoke one')
    .option('--revoke <id>', 'revoke this device (full id or unique prefix)')
    .option('--json', 'machine-readable output with full ids')
    .option('-c, --config <path>', 'config file')
    .action((o: DevicesOptions) => runDevices(o));

  program
    .command('vapid')
    .description('create the Web Push (VAPID) key pair in config.json if it is missing, and print the public key')
    .option('--rotate', 'replace the existing pair (browsers must re-enable Web Push afterwards)')
    .option('--json', 'machine-readable output (public key only; the private key stays in the config file)')
    .option('-c, --config <path>', 'config file')
    .action((o: VapidOptions) => runVapid(o));

  program
    .command('terminals')
    .description('list the tmux sessions behind the Terminal tab, or kill one / all of them')
    .option('--kill <id>', 'kill the shell with this id (its tmux session and everything running in it)')
    .option('--kill-all', 'kill every <tmuxPrefix>-* session')
    .option('--json', 'machine-readable output')
    .option('-c, --config <path>', 'config file')
    .action((o: TerminalsOptions) => runTerminals(o));

  program
    .command('studio')
    .description('open the Studio (the live editor for this machine) in a browser app-window; --no-open only prints the URL')
    .option('-s, --session <id>', 'follow this session first')
    .option('--no-open', 'print a launch URL (with a fresh one-time code) instead of opening a window')
    .option('-c, --config <path>', 'config file')
    .action((o: StudioCliOptions) => runStudio(o));

  program
    .command('doctor')
    .description('check node, agents (ACP initialize), tmux/rg/git, node-pty, tailscale, linger, systemd, DB; exit 1 on failures')
    .option('--json', 'print the report as JSON')
    .option(
      '--agent-timeout <seconds>',
      'how long each agent gets to answer initialize',
      parseIntInRange('agent-timeout', 1, 600),
      DEFAULT_AGENT_TIMEOUT_MS / 1000,
    )
    .option('-c, --config <path>', 'config file')
    .action((o: DoctorCliOptions) => runDoctorCommand(o));

  return program;
}

/** `mide pair | head` must not die with a stack trace when the reader goes away. */
function tolerateClosedPipes(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EPIPE') process.exit(0);
      throw e;
    });
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  tolerateClosedPipes();
  const program = buildProgram();
  // Only the daemon wants the JSON log stream on stdout; the other commands print for a human.
  if (argv[2] !== 'serve' && !process.env.MIDE_LOG) setLogLevel('warn');
  try {
    await program.parseAsync(argv);
  } catch (e) {
    err(`mide: ${describeFailure(e)}`);
    process.exitCode = 1;
  }
}

void main();
