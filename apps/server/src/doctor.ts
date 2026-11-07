/**
 * `mide doctor`: is this machine ready to run the daemon and reach it from the phone?
 *
 * Every check yields one row. FAIL rows make the command exit 1 (the daemon or a core
 * feature cannot work); WARN rows are advice (the daemon runs, but something the phone
 * needs is missing, e.g. tailscale, linger, publicUrl). Checks never throw.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';
import { AcpProcess, AcpTimeoutError, describeAcpError, type AcpClientHandlers } from './agents/acp.js';
import { expandHome, loadConfig, localUrl, type AgentConfig, type Config, type LoadedConfig } from './config.js';
import { Db } from './db.js';
import { errorMessage } from './errors.js';
import { resolveStudio, resolveWebApp, WEB_APP_SOURCE_LABEL } from './routes/static.js';
import { desktopEnvironment, findBrowser } from './studio.js';
import { SERVER_VERSION } from './version.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  /** stable machine id, e.g. `agent:claude` */
  id: string;
  /** label shown in the table */
  name: string;
  status: DoctorStatus;
  detail: string;
  /** how to fix it (only meaningful when status is not ok) */
  hint?: string;
  /** how long the check took */
  ms: number;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** true when there are no FAIL rows */
  ok: boolean;
  failures: number;
  warnings: number;
  ms: number;
  node: string;
  version: string;
}

export interface DoctorOptions {
  configPath?: string;
  /** budget for each agent's ACP `initialize` (default 20 s) */
  agentTimeoutMs?: number;
  /** called as each check completes (quick checks first, agents last) */
  onCheck?: (check: DoctorCheck) => void;
}

type CheckResult = { status: DoctorStatus; detail: string; hint?: string };

export const DEFAULT_AGENT_TIMEOUT_MS = 20_000;
/** PATH the systemd unit runs with (keep in sync with deploy/systemd/mobile-ide.service). */
export const SERVICE_PATH = ['~/.local/bin', '~/bin', '/usr/local/bin', '/usr/bin', '/bin'];
/** Optional environment file the systemd unit loads (EnvironmentFile=-%h/.mobile-ide/env). */
export const SERVICE_ENV_FILE = '~/.mobile-ide/env';
const UNIT_NAME = 'mobile-ide.service';

const ok = (detail: string): CheckResult => ({ status: 'ok', detail });
const warn = (detail: string, hint?: string): CheckResult => (hint ? { status: 'warn', detail, hint } : { status: 'warn', detail });
const fail = (detail: string, hint?: string): CheckResult => (hint ? { status: 'fail', detail, hint } : { status: 'fail', detail });

// ---------------------------------------------------------------------------- helpers
interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Run a command and collect its output; never throws (ENOENT and timeouts become results). */
export function runCommand(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: opts.env ?? process.env, cwd: opts.cwd });
    } catch (err) {
      resolve({ code: null, stdout, stderr, error: errorMessage(err) });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 8_000);
    timer.unref?.();
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < 65_536) stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 65_536) stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Resolve an executable on a PATH string (defaults to the current process PATH). */
export function whichSync(cmd: string, pathEnv: string | undefined = process.env.PATH): string | null {
  if (!cmd) return null;
  const candidates = cmd.includes('/')
    ? [path.resolve(expandHome(cmd))]
    : (pathEnv ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(expandHome(dir), cmd));
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

function firstLine(s: string): string {
  return (
    s
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? ''
  );
}

function lastLines(s: string, n: number): string {
  return s
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .join(' | ');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Coarse "how long ago" for file ages: `40 s`, `12 min`, `3 h`, `5 d`. */
function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${(s / 3600).toFixed(s < 36_000 ? 1 : 0)} h`;
  return `${Math.round(s / 86_400)} d`;
}

function tilde(p: string): string {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

/** KEY=VALUE lines as systemd's EnvironmentFile reads them (comments, blanks, simple quotes). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------- checks
export function checkNode(): CheckResult {
  const version = process.versions.node;
  const [maj = 0, min = 0] = version.split('.').map((n) => Number(n));
  if (maj < 22 || (maj === 22 && min < 5)) {
    return fail(
      `v${version} — node:sqlite needs Node 22.5+ (24 LTS recommended)`,
      'install Node 24: nvm install 24 && nvm alias default 24',
    );
  }
  if ((maj === 22 && min < 13) || (maj === 23 && min < 4)) {
    return warn(
      `v${version} — node:sqlite is behind --experimental-sqlite on this version`,
      'use Node 22.13+ or 24 so `mide serve` needs no flags',
    );
  }
  return ok(`v${version} (${process.platform}-${process.arch})`);
}

export async function checkBinary(cmd: string, versionArgs: string[], onMissing: CheckResult): Promise<CheckResult> {
  const exe = whichSync(cmd);
  if (!exe) return onMissing;
  const res = await runCommand(cmd, versionArgs, { timeoutMs: 5_000 });
  const version = firstLine(res.stdout || res.stderr);
  return ok(version ? `${version} (${exe})` : exe);
}

function checkDb(loaded: LoadedConfig, db: Db): CheckResult {
  if (!db.ping()) return fail(`${loaded.dbPath}: SELECT 1 failed`);
  // BEGIN IMMEDIATE takes the write lock: proves the file and its WAL are writable without changing data.
  db.transaction(() => undefined);
  const devices = db.listDevices().filter((d) => !d.revokedAt).length;
  const sessions = db.listSessions().length;
  const size = db.fileSize(); // main file + WAL
  const retention = loaded.config.limits.closedSessionRetentionDays;
  return ok(
    `${tilde(loaded.dbPath)} (${fmtBytes(size)}, ${devices} device${devices === 1 ? '' : 's'}, ${sessions} open session${sessions === 1 ? '' : 's'}; closed sessions kept ${retention > 0 ? `${retention} d` : 'forever'})`,
  );
}

/** The doctor never serves files or terminals; anything an agent asks for during `initialize` is refused. */
const doctorHandlers: AcpClientHandlers = {
  onSessionUpdate: () => undefined,
  onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  onReadTextFile: async () => {
    throw RequestError.internalError(undefined, 'not available during mide doctor');
  },
  onWriteTextFile: async () => {
    throw RequestError.internalError(undefined, 'not available during mide doctor');
  },
  onCreateTerminal: async () => {
    throw RequestError.internalError(undefined, 'not available during mide doctor');
  },
  onTerminalOutput: async () => {
    throw RequestError.internalError(undefined, 'not available during mide doctor');
  },
  onWaitForTerminalExit: async () => {
    throw RequestError.internalError(undefined, 'not available during mide doctor');
  },
  onKillTerminal: async () => {
    throw RequestError.internalError(undefined, 'not available during mide doctor');
  },
  onReleaseTerminal: async () => {
    throw RequestError.internalError(undefined, 'not available during mide doctor');
  },
};

class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

/**
 * Race a promise against a deadline. The ACP SDK's cancellationSignal only sends `$/cancel_request`
 * and keeps waiting for the agent to answer — while npx is still downloading an adapter nothing reads
 * stdin, so a request can hang far past its "timeout". The doctor enforces the budget itself.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  promise.catch(() => undefined); // the loser of the race must not surface as an unhandled rejection
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Spawn the adapter exactly as the daemon would and require an ACP `initialize` reply within the budget. */
export async function checkAgent(id: string, cfg: AgentConfig, timeoutMs: number): Promise<CheckResult> {
  const exe = whichSync(cfg.command);
  if (!exe) {
    return fail(
      `'${cfg.command}' not found on PATH`,
      `install it or fix "agents.${id}.command" in config.json (set "enabled": false to skip this agent)`,
    );
  }
  const t0 = Date.now();
  let proc: AcpProcess | null = null;
  try {
    proc = new AcpProcess(id, cfg, doctorHandlers, { cwd: os.homedir() });
    const init = await withDeadline(proc.initialize(timeoutMs), timeoutMs, `no ACP initialize reply within ${fmtMs(timeoutMs)}`);
    const caps = init.agentCapabilities ?? {};
    const who = init.agentInfo?.title ?? init.agentInfo?.name ?? cfg.name;
    const version = init.agentInfo?.version ? ` ${init.agentInfo.version}` : '';
    const parts = [
      `${who}${version}`,
      `ACP ${init.protocolVersion}`,
      fmtMs(Date.now() - t0),
      `load_session ${caps.loadSession ? 'yes' : 'no'}`,
      `images ${caps.promptCapabilities?.image ? 'yes' : 'no'}`,
    ];
    if (init.authMethods?.length) parts.push(`auth: ${init.authMethods.map((m) => m.id).join(', ')}`);
    return ok(parts.join(' · '));
  } catch (err) {
    // AcpProcess now enforces the same budget itself; either way it is a timeout, keep the npx hint.
    const timedOut = err instanceof DeadlineError || err instanceof AcpTimeoutError;
    const message = timedOut ? `no ACP initialize reply within ${fmtMs(timeoutMs)}` : describeAcpError(err);
    const tail = proc ? lastLines(proc.stderrTail(), 2) : '';
    const detail = `${message}${tail ? ` — ${tail}` : ''}`.slice(0, 600);
    const invocation = [cfg.command, ...cfg.args].join(' ');
    const hint =
      timedOut && cfg.command === 'npx'
        ? `the first run downloads the adapter through npx and can take minutes — run \`mide doctor\` again once it is cached, or raise --agent-timeout`
        : timedOut
          ? `run \`${invocation}\` by hand and check it answers ACP initialize on stdio`
          : `run \`${invocation}\` by hand; set "agents.${id}.enabled": false to skip this agent`;
    return fail(detail, hint);
  } finally {
    if (proc) await proc.stop(2_000).catch(() => undefined);
  }
}

interface PtyModuleLike {
  spawn?: (
    file: string,
    args: string[],
    options: Record<string, unknown>,
  ) => { onExit(cb: (e: { exitCode: number }) => void): unknown; kill(): void };
}

/** Load @lydell/node-pty and actually fork a pty (a load that succeeds can still fail at spawn on a glibc mismatch). */
export async function checkNodePty(): Promise<CheckResult> {
  const fallback = whichSync('script');
  let failure: string;
  try {
    const mod = (await import('@lydell/node-pty')) as PtyModuleLike & { default?: PtyModuleLike };
    const ptySpawn = mod.spawn ?? mod.default?.spawn;
    if (typeof ptySpawn !== 'function') throw new Error('module loaded but exports no spawn()');
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pty did not exit within 5 s')), 5_000);
      try {
        const pty = ptySpawn('/bin/sh', ['-c', 'exit 0'], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: os.homedir(),
          env: process.env,
        });
        pty.onExit((e) => {
          clearTimeout(timer);
          resolve(e.exitCode);
        });
        setTimeout(() => {
          try {
            pty.kill();
          } catch {
            /* already gone */
          }
        }, 4_500).unref();
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return ok(`@lydell/node-pty spawns a pty (test shell exited ${exitCode})`);
  } catch (err) {
    failure = errorMessage(err).split('\n')[0] ?? 'unknown error';
  }
  if (fallback)
    return warn(
      `@lydell/node-pty failed (${failure}); the terminal falls back to \`script\` (${fallback})`,
      'pnpm rebuild @lydell/node-pty, or check the platform package @lydell/node-pty-linux-x64 is installed',
    );
  return fail(
    `@lydell/node-pty failed (${failure}) and \`script\` is missing: the terminal tab cannot work`,
    'pnpm rebuild @lydell/node-pty; or install util-linux for the `script` fallback',
  );
}

function parseServeStatus(out: string): { urls: string[]; ports: number[] } {
  const urls = [...new Set([...out.matchAll(/https?:\/\/[^\s|]+/g)].map((m) => m[0].replace(/[),.]+$/, '')))];
  const ports = new Set<number>();
  for (const m of out.matchAll(/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/g)) ports.add(Number(m[1]));
  return { urls, ports: [...ports] };
}

interface TailscaleResult {
  rows: { id: string; name: string; result: CheckResult }[];
  /** URL tailscale serve forwards to our port, when detected */
  serveUrl?: string;
  /** the machine's HTTPS-capable name, when known */
  certUrl?: string;
}

export async function checkTailscale(config: Config): Promise<TailscaleResult> {
  const rows: TailscaleResult['rows'] = [];
  const exe = whichSync('tailscale');
  if (!exe) {
    rows.push({
      id: 'tailscale',
      name: 'Tailscale',
      result: warn(
        'not installed — the phone has no path to the daemon',
        'docs/RUNBOOK.md step 1: install tailscale, `sudo tailscale up`, enable MagicDNS + HTTPS certificates',
      ),
    });
    rows.push({ id: 'tailscale-serve', name: 'tailscale serve', result: warn('skipped (tailscale not installed)') });
    return { rows };
  }
  const versionRes = await runCommand('tailscale', ['version'], { timeoutMs: 5_000 });
  const version = firstLine(versionRes.stdout);
  const statusRes = await runCommand('tailscale', ['status', '--json'], { timeoutMs: 8_000 });
  let backend = 'unknown';
  let dnsName: string | undefined;
  let certUrl: string | undefined;
  if (statusRes.code === 0) {
    try {
      const parsed = JSON.parse(statusRes.stdout) as {
        BackendState?: string;
        Self?: { DNSName?: string; Online?: boolean };
        CertDomains?: string[];
      };
      backend = parsed.BackendState ?? backend;
      dnsName = parsed.Self?.DNSName?.replace(/\.$/, '');
      const cert = parsed.CertDomains?.[0];
      if (cert) certUrl = `https://${cert}`;
    } catch {
      /* fall through with what we have */
    }
  }
  if (backend === 'Running') {
    rows.push({
      id: 'tailscale',
      name: 'Tailscale',
      result: ok(
        `${version || 'installed'} · ${dnsName ?? 'connected'}${certUrl ? '' : ' · no HTTPS cert domain (enable HTTPS certificates in the admin console)'}`,
      ),
    });
  } else {
    const why = statusRes.code === 0 ? backend : lastLines(statusRes.stderr || statusRes.stdout, 1) || `exit ${statusRes.code}`;
    rows.push({
      id: 'tailscale',
      name: 'Tailscale',
      result: warn(`${version || 'installed'} but not running (${why})`, 'sudo systemctl enable --now tailscaled && sudo tailscale up'),
    });
  }

  const serveRes = await runCommand('tailscale', ['serve', 'status'], { timeoutMs: 8_000 });
  const fix = `sudo tailscale serve --bg ${config.port}`;
  let serveUrl: string | undefined;
  if (serveRes.code !== 0) {
    rows.push({
      id: 'tailscale-serve',
      name: 'tailscale serve',
      result: warn(
        `could not read serve status: ${lastLines(serveRes.stderr || serveRes.stdout, 1) || serveRes.error || `exit ${serveRes.code}`}`,
        fix,
      ),
    });
  } else {
    const { urls, ports } = parseServeStatus(serveRes.stdout);
    if (ports.includes(config.port)) {
      serveUrl = urls[0];
      rows.push({ id: 'tailscale-serve', name: 'tailscale serve', result: ok(`${serveUrl ?? 'HTTPS'} → 127.0.0.1:${config.port}`) });
    } else if (ports.length) {
      rows.push({
        id: 'tailscale-serve',
        name: 'tailscale serve',
        result: warn(`forwards to port ${ports.join(', ')}, not ${config.port}`, fix),
      });
    } else {
      rows.push({
        id: 'tailscale-serve',
        name: 'tailscale serve',
        result: warn('no serve configuration — the daemon is not exposed on the tailnet', fix),
      });
    }
  }
  const out: TailscaleResult = { rows };
  if (serveUrl) out.serveUrl = serveUrl;
  if (certUrl) out.certUrl = certUrl;
  return out;
}

export function checkPublicUrl(loaded: LoadedConfig, ts: { serveUrl?: string; certUrl?: string }): CheckResult {
  const { publicUrl } = loaded.config;
  const suggestion = ts.serveUrl ?? ts.certUrl ?? 'https://<laptop>.<tailnet>.ts.net';
  if (!publicUrl) {
    return warn(
      `not set — pairing QR codes and notification links point at ${localUrl(loaded.config)}, which the phone cannot open`,
      `set "publicUrl": "${suggestion}" in ${tilde(loaded.configPath)} and restart the daemon`,
    );
  }
  let host: string;
  let protocol: string;
  try {
    const u = new URL(publicUrl);
    host = u.host;
    protocol = u.protocol;
  } catch {
    return fail(`"${publicUrl}" is not a valid URL`, `fix "publicUrl" in ${tilde(loaded.configPath)}`);
  }
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  if (protocol !== 'https:' && !loopback)
    return warn(
      `${publicUrl} is not HTTPS — the installed PWA (service worker, Web Push) needs a secure origin`,
      'expose the daemon through `tailscale serve` or a Cloudflare tunnel (scripts/cloudflare-tunnel.sh) and use its https:// URL',
    );
  if (ts.serveUrl) {
    try {
      const serveHost = new URL(ts.serveUrl).host;
      if (serveHost !== host) {
        // A different *.ts.net host is almost certainly a stale value. Any other https host is a deliberate tunnel
        // (Cloudflare quick/named tunnel, own reverse proxy) — tell the operator, do not nag.
        if (/\.ts\.net$/i.test(host))
          return warn(
            `${publicUrl} but tailscale serve answers at ${ts.serveUrl}`,
            `set "publicUrl": "${ts.serveUrl}" in ${tilde(loaded.configPath)}`,
          );
        return ok(`${publicUrl} (tunnel / reverse proxy; tailscale serve also answers at ${ts.serveUrl})`);
      }
    } catch {
      /* ignore odd serve output */
    }
  }
  return ok(publicUrl);
}

/**
 * Is there an exported web app for the daemon to serve at `/`? Without one the phone gets the plain landing page
 * instead of the app (same resolution order as routes/static.ts: webApp.dir → repo apps/mobile/dist → MIDE_HOME/www).
 */
export async function checkWebApp(loaded: LoadedConfig): Promise<CheckResult> {
  const { location, candidates } = await resolveWebApp(loaded);
  if (location) {
    const age = Date.now() - location.builtAt;
    return ok(`${tilde(location.dir)} (${WEB_APP_SOURCE_LABEL[location.source]}) · index.html exported ${fmtAge(age)} ago`);
  }
  const consequence = 'the phone gets the plain landing page instead of the app';
  if (loaded.config.webApp.dir) {
    return warn(
      `"webApp.dir" ${tilde(candidates[0]?.dir ?? loaded.config.webApp.dir)} has no index.html — ${consequence}`,
      `run \`pnpm build\` (exports apps/mobile/dist) and point "webApp.dir" at that folder in ${tilde(loaded.configPath)}, or remove the key to auto-detect`,
    );
  }
  return warn(
    `no web build in ${candidates.map((c) => tilde(c.dir)).join(' or ')} — ${consequence}`,
    'run `pnpm build` (exports the app to apps/mobile/dist); outside the checkout copy that folder to ~/.mobile-ide/www or set "webApp.dir" in config.json',
  );
}

export async function checkLinger(): Promise<CheckResult> {
  const user = os.userInfo().username;
  const fix = `loginctl enable-linger ${user}`;
  if (!whichSync('loginctl')) return warn('loginctl not found — cannot tell whether user services survive logout', fix);
  const res = await runCommand('loginctl', ['show-user', user, '-p', 'Linger', '--value'], { timeoutMs: 5_000 });
  if (res.code === 0) {
    const value = res.stdout.trim().replace(/^Linger=/, '');
    if (value === 'yes') return ok(`enabled for ${user} — user services keep running after logout`);
    if (value === 'no') return warn(`disabled for ${user} — the daemon dies when you log out`, fix);
    return warn(`unexpected loginctl answer "${value}"`, fix);
  }
  return warn(`could not query logind (${lastLines(res.stderr, 1) || res.error || `exit ${res.code}`})`, fix);
}

export function checkServicePath(config: Config): CheckResult {
  const envFile = expandHome(SERVICE_ENV_FILE);
  let servicePath = SERVICE_PATH.map((p) => expandHome(p)).join(path.delimiter);
  let source = 'the unit default';
  if (fs.existsSync(envFile)) {
    try {
      const vars = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
      if (vars.PATH) {
        servicePath = vars.PATH;
        source = tilde(envFile);
      }
    } catch {
      /* unreadable: judge by the default */
    }
  }
  const needed = new Set<string>(['node', 'tmux', 'git']);
  for (const agent of Object.values(config.agents)) if (agent.enabled) needed.add(agent.command);
  const missing = [...needed].filter((cmd) => !whichSync(cmd, servicePath));
  if (missing.length === 0) return ok(`${[...needed].join(', ')} all resolve on the service PATH (${source})`);
  return warn(
    `${missing.join(', ')} not on the systemd service PATH (${source}) — the unit would fail to start ${missing.includes('node') ? 'at all' : 'those agents'}`,
    `echo "PATH=$PATH" >> ${SERVICE_ENV_FILE} && systemctl --user restart mobile-ide   (add ANTHROPIC_*/OPENAI_* exports there too)`,
  );
}

export async function checkSystemdUnit(): Promise<{ result: CheckResult; active: string }> {
  const unitFile = path.join(os.homedir(), '.config', 'systemd', 'user', UNIT_NAME);
  const install = `cp deploy/systemd/${UNIT_NAME} ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now mobile-ide`;
  if (!whichSync('systemctl'))
    return { result: warn('systemctl not found — run `mide serve` under your own supervisor', ''), active: 'unknown' };
  const enabled = (await runCommand('systemctl', ['--user', 'is-enabled', UNIT_NAME], { timeoutMs: 5_000 })).stdout.trim();
  const active = (await runCommand('systemctl', ['--user', 'is-active', UNIT_NAME], { timeoutMs: 5_000 })).stdout.trim() || 'unknown';
  const installed = fs.existsSync(unitFile) || (enabled !== '' && enabled !== 'not-found');
  if (!installed) return { result: warn('not installed — the daemon will not start at boot or restart after a crash', install), active };
  if (active === 'failed')
    return {
      result: fail(
        `installed (${enabled || 'static'}) but the unit is in the failed state`,
        'journalctl --user -u mobile-ide -n 100 --no-pager',
      ),
      active,
    };
  if (enabled === 'enabled' && active === 'active') return { result: ok(`enabled, ${active}`), active };
  if (enabled === 'enabled') return { result: warn(`enabled but ${active}`, 'systemctl --user start mobile-ide'), active };
  return { result: warn(`installed but ${enabled || 'not enabled'} (${active})`, 'systemctl --user enable --now mobile-ide'), active };
}

export async function checkDaemon(config: Config, unitActive: string): Promise<CheckResult> {
  const base = localUrl(config);
  const url = `${base}/api/health`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(2_500) });
  } catch (err) {
    const msg = errorMessage(err);
    if (unitActive === 'active')
      return fail(
        `systemd reports the unit active but ${url} does not answer (${msg})`,
        'journalctl --user -u mobile-ide -n 100 --no-pager',
      );
    return warn(`not running at ${base}`, 'systemctl --user start mobile-ide, or mide serve');
  }
  type HealthBody = { ok?: unknown; serverName?: unknown; version?: unknown };
  let body: HealthBody | null = null;
  try {
    body = (await res.json()) as HealthBody;
  } catch {
    /* not JSON */
  }
  if (!res.ok || !body || typeof body.version !== 'string') {
    return fail(
      `something else answers on ${base} (HTTP ${res.status})`,
      `change "port" in config.json or stop the other program on port ${config.port}`,
    );
  }
  const stale = body.version !== SERVER_VERSION ? ` — this CLI is v${SERVER_VERSION}; restart the daemon to update` : '';
  return ok(`running v${body.version} "${typeof body.serverName === 'string' ? body.serverName : '?'}" at ${base}${stale}`);
}

export function checkRoots(config: Config): CheckResult {
  const roots = config.projects.roots.map((r) => expandHome(r));
  const missing = roots.filter((r) => {
    try {
      return !fs.statSync(r).isDirectory();
    } catch {
      return true;
    }
  });
  if (roots.length === 0)
    return fail('no project roots configured — no directory can be opened from the phone', 'set "projects.roots" in config.json');
  if (missing.length) return warn(`missing: ${missing.map(tilde).join(', ')}`, 'fix "projects.roots" in config.json');
  return ok(`${roots.length} root${roots.length === 1 ? '' : 's'}: ${roots.map(tilde).join(', ')}`);
}

export function checkNotifications(config: Config, db: Db | null): CheckResult {
  const n = config.notifications;
  const configured: string[] = [];
  if (n.ntfy.topic) configured.push(`ntfy topic on ${n.ntfy.server.replace(/^https?:\/\//, '')}`);
  if (n.webpush.vapidPublicKey && n.webpush.vapidPrivateKey) configured.push('Web Push VAPID keys');
  if (n.expo.enabled) configured.push('Expo push enabled');
  const subs = db ? db.listPushSubscriptions() : [];
  const byKind = new Map<string, number>();
  for (const s of subs) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
  const subsText = subs.length
    ? `${subs.length} device subscription${subs.length === 1 ? '' : 's'} (${[...byKind].map(([k, c]) => `${k} ${c}`).join(', ')})`
    : 'no device subscriptions yet';
  const detail = `${configured.join(', ') || 'nothing configured'}; ${subsText}`;
  if (subs.length === 0 && !n.ntfy.topic) {
    return warn(
      detail,
      'nothing can buzz the phone yet: in the app open Settings → Notifications (ntfy topic or push), or set notifications.ntfy.topic in config.json',
    );
  }
  return ok(detail);
}

/** The Studio: is the bundle there, is there a browser to open it with, is a display reachable from this process? */
export async function checkStudio(loaded: LoadedConfig): Promise<CheckResult> {
  const built = await resolveStudio(loaded);
  const browser = findBrowser(loaded.config.studio.browser);
  const env = await desktopEnvironment();
  const display = env ? (env.WAYLAND_DISPLAY ? `wayland ${env.WAYLAND_DISPLAY}` : `x11 ${env.DISPLAY}`) : null;
  const parts: string[] = [];
  const problems: string[] = [];
  if (built.location)
    parts.push(
      `${tilde(built.location.dir)} (${WEB_APP_SOURCE_LABEL[built.location.source]}, built ${fmtAge(Date.now() - built.location.builtAt)} ago)`,
    );
  else problems.push('not built');
  if (browser) parts.push(browser.kind === 'chromium' ? `${browser.label} (app window)` : browser.label);
  else problems.push('no browser');
  if (display) parts.push(display);
  else problems.push('no display');
  parts.push(loaded.config.studio.autoOpen ? 'auto-open on' : 'auto-open off');
  const detail = [...problems, ...parts].join(' · ');
  if (!built.location) return warn(detail, 'run `pnpm build` (bundles apps/studio/dist) or set "studio.dir" in config.json');
  if (!browser)
    return warn(detail, 'install Chrome/Chromium/Brave (best: app-mode window) or Firefox, or set "studio.browser" in config.json');
  if (!display)
    return warn(
      detail,
      'the daemon cannot see your desktop: add DISPLAY/WAYLAND_DISPLAY to ~/.mobile-ide/env, or run `systemctl --user import-environment DISPLAY WAYLAND_DISPLAY` at login',
    );
  return ok(detail);
}

// ---------------------------------------------------------------------------- runner
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const t0 = Date.now();
  const agentTimeoutMs = opts.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const checks: DoctorCheck[] = [];
  const emit = (id: string, name: string, result: CheckResult, startedAt: number): void => {
    const check: DoctorCheck = { id, name, status: result.status, detail: result.detail, ms: Date.now() - startedAt };
    if (result.hint) check.hint = result.hint;
    checks.push(check);
    opts.onCheck?.(check);
  };
  const row = async (id: string, name: string, fn: () => CheckResult | Promise<CheckResult>): Promise<void> => {
    const started = Date.now();
    let result: CheckResult;
    try {
      result = await fn();
    } catch (err) {
      result = fail(`check crashed: ${errorMessage(err)}`);
    }
    emit(id, name, result, started);
  };
  const finish = (): DoctorReport => {
    const failures = checks.filter((c) => c.status === 'fail').length;
    const warnings = checks.filter((c) => c.status === 'warn').length;
    return { checks, ok: failures === 0, failures, warnings, ms: Date.now() - t0, node: process.version, version: SERVER_VERSION };
  };

  await row('node', 'Node.js', checkNode);

  let loaded: LoadedConfig | null = null;
  {
    const started = Date.now();
    try {
      loaded = loadConfig(opts.configPath ? { configPath: opts.configPath } : {});
      const agents = Object.entries(loaded.config.agents)
        .filter(([, a]) => a.enabled)
        .map(([id]) => id);
      emit(
        'config',
        'Config',
        ok(`${tilde(loaded.configPath)} · ${loaded.config.host}:${loaded.config.port} · agents: ${agents.join(', ') || 'none'}`),
        started,
      );
    } catch (err) {
      emit('config', 'Config', fail(errorMessage(err), 'fix the JSON (or move the file away to regenerate defaults)'), started);
      return finish();
    }
  }
  const config = loaded.config;

  let db: Db | null = null;
  {
    const started = Date.now();
    try {
      fs.accessSync(loaded.home, fs.constants.W_OK);
      db = new Db(loaded.dbPath);
      emit('db', 'Database', checkDb(loaded, db), started);
    } catch (err) {
      emit(
        'db',
        'Database',
        fail(
          `${tilde(loaded.dbPath)}: ${errorMessage(err)}`,
          `check permissions on ${tilde(loaded.home)} (the daemon needs to create and write mide.db and its -wal file)`,
        ),
        started,
      );
    }
  }

  await row('tmux', 'tmux', () =>
    checkBinary('tmux', ['-V'], fail('not installed — the terminal tab and shell survival depend on it', 'sudo dnf install tmux')),
  );
  await row('rg', 'ripgrep', () =>
    checkBinary('rg', ['--version'], warn('not installed — file search falls back to a slower built-in scan', 'sudo dnf install ripgrep')),
  );
  await row('git', 'git', () =>
    checkBinary('git', ['--version'], fail('not installed — project discovery, status and diffs need it', 'sudo dnf install git')),
  );
  await row('node-pty', 'node-pty', checkNodePty);

  const ts = await checkTailscale(config);
  for (const r of ts.rows) emit(r.id, r.name, r.result, Date.now());
  await row('public-url', 'publicUrl', () => checkPublicUrl(loaded!, ts));
  await row('web-app', 'Web app', () => checkWebApp(loaded!));
  await row('studio', 'Studio', () => checkStudio(loaded!));
  await row('linger', 'Linger', checkLinger);
  await row('service-path', 'systemd PATH', () => checkServicePath(config));
  const unit = await checkSystemdUnit();
  emit('systemd-unit', 'systemd unit', unit.result, Date.now());
  await row('daemon', 'Daemon', () => checkDaemon(config, unit.active));
  await row('roots', 'Project roots', () => checkRoots(config));
  await row('notifications', 'Notifications', () => checkNotifications(config, db));
  db?.close();

  const agents = Object.entries(config.agents).filter(([, cfg]) => cfg.enabled);
  if (agents.length === 0) {
    emit('agents', 'Agents', fail('no agents enabled in config.json', 'enable at least one entry under "agents"'), Date.now());
  } else {
    // In parallel: each may take the full budget, and they are independent processes.
    await Promise.all(agents.map(([id, cfg]) => row(`agent:${id}`, `Agent: ${cfg.name}`, () => checkAgent(id, cfg, agentTimeoutMs))));
  }
  return finish();
}

// ---------------------------------------------------------------------------- formatting
export const DOCTOR_NAME_WIDTH = 20;
const LABEL: Record<DoctorStatus, string> = { ok: 'OK', warn: 'WARN', fail: 'FAIL' };
const COLOR: Record<DoctorStatus, string> = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[1;31m' };

export function formatCheck(check: DoctorCheck, opts: { color?: boolean; nameWidth?: number } = {}): string {
  const width = opts.nameWidth ?? DOCTOR_NAME_WIDTH;
  const label = LABEL[check.status].padEnd(4);
  const status = opts.color ? `${COLOR[check.status]}${label}\x1b[0m` : label;
  const lines = [`  ${status}  ${check.name.padEnd(width)}  ${check.detail}`];
  if (check.hint && check.status !== 'ok') lines.push(`${' '.repeat(8 + width + 2)}→ ${check.hint}`);
  return lines.join('\n');
}

export function formatSummary(report: DoctorReport, opts: { color?: boolean } = {}): string {
  const n = report.checks.length;
  const verdict = report.failures > 0 ? `${report.failures} failure${report.failures === 1 ? '' : 's'}` : 'no failures';
  const warnings = report.warnings > 0 ? `, ${report.warnings} warning${report.warnings === 1 ? '' : 's'}` : '';
  const text = `${n} checks: ${verdict}${warnings} (${fmtMs(report.ms)})`;
  if (!opts.color) return text;
  return `${report.failures > 0 ? COLOR.fail : report.warnings > 0 ? COLOR.warn : COLOR.ok}${text}\x1b[0m`;
}

export function formatDoctorReport(report: DoctorReport, opts: { color?: boolean } = {}): string {
  const width = Math.max(DOCTOR_NAME_WIDTH, ...report.checks.map((c) => c.name.length));
  const lines = [`mide doctor v${report.version} · ${report.node}`, ''];
  for (const c of report.checks) lines.push(formatCheck(c, { color: opts.color ?? false, nameWidth: width }));
  lines.push('', formatSummary(report, opts));
  return lines.join('\n');
}
