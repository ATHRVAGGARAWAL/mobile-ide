/**
 * The Studio launcher: pops the laptop-side live editor (`/studio/`) open in a dedicated browser app-window.
 *
 * When: on `session.created` and `turn.started` (auto-open, unless a Studio window is already connected over /ws — it follows the
 * session by itself), from `mide studio`, and from POST /api/studio/open (the phone's "Open on laptop"). How: a
 * Chromium-family browser in `--app=` mode (no tabs, no URL bar, its own window class, so it behaves like an
 * application), else Firefox in a new window, else `xdg-open`. Auth: the URL carries a short-lived one-time pairing code
 * in its fragment; the Studio pairs itself once and keeps its device token in localStorage, so later launches simply
 * reuse it and the unused code expires. The daemon may run headless (systemd, SSH): the display is looked up in the
 * user's systemd environment when the process has none, and without one nothing is spawned.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { API, STUDIO_CLIENT_NAME } from '@mobile-ide/core';
import { generatePairingCode } from './auth.js';
import { localUrl, type LoadedConfig } from './config.js';
import type { Db } from './db.js';
import type { EventBus, Unsubscribe } from './events.js';
import { errorMessage } from './errors.js';
import { createLogger, errorInfo } from './log.js';
import { resolveStudio } from './routes/static.js';

const log = createLogger({ mod: 'studio' });

/** How long the one-time code in a launch URL stays valid — the browser needs seconds, not minutes. */
export const STUDIO_PAIR_TTL_MS = 3 * 60_000;
/** After a launch, no automatic second window for this long (the first one may still be starting and pairing). */
const RELAUNCH_COOLDOWN_MS = 20_000;

const CHROMIUM_BINARIES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'brave-browser',
  'brave',
  'microsoft-edge',
  'microsoft-edge-stable',
  'vivaldi',
  'thorium-browser',
];
const CHROMIUM_FLATPAKS = ['com.brave.Browser', 'com.google.Chrome', 'org.chromium.Chromium', 'com.microsoft.Edge', 'com.vivaldi.Vivaldi'];
const DESKTOP_ENV_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XAUTHORITY',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
] as const;

export type BrowserKind = 'chromium' | 'firefox' | 'xdg-open' | 'custom';

export interface Browser {
  kind: BrowserKind;
  /** argv prefix: the executable (and `flatpak run <app>` for sandboxed installs) */
  command: string[];
  /** how the doctor and logs name it */
  label: string;
}

function whichSync(cmd: string, pathEnv: string | undefined = process.env.PATH): string | null {
  if (!cmd) return null;
  if (cmd.includes('/')) return isExecutable(cmd) ? cmd : null;
  for (const dir of (pathEnv ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, cmd);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function flatpakInstalled(app: string): boolean {
  const dirs = ['/var/lib/flatpak/app', path.join(os.homedir(), '.local', 'share', 'flatpak', 'app')];
  return dirs.some((d) => fs.existsSync(path.join(d, app)));
}

/** Split a configured `studio.browser` value: a bare executable, a path, or a short command like `flatpak run com.brave.Browser`. */
function parseConfiguredBrowser(value: string): Browser | null {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const exe = parts[0];
  if (!exe) return null;
  if (!whichSync(exe)) return null;
  const base = path.basename(exe);
  const flatpakApp = base === 'flatpak' ? parts.find((p) => /^[a-z0-9_]+(\.[a-z0-9_-]+)+$/i.test(p)) : undefined;
  const chromiumLike =
    CHROMIUM_BINARIES.includes(base) ||
    (flatpakApp !== undefined && CHROMIUM_FLATPAKS.includes(flatpakApp)) ||
    /chrom|brave|edge|vivaldi/i.test(base);
  const kind: BrowserKind = chromiumLike
    ? 'chromium'
    : /firefox|librewolf|zen/i.test(base)
      ? 'firefox'
      : base === 'xdg-open'
        ? 'xdg-open'
        : 'custom';
  return { kind, command: parts, label: value.trim() };
}

/** The browser to open the Studio with: the configured one, else Chromium-family (native, then Flatpak), Firefox, xdg-open. */
export function findBrowser(configured: string | null, pathEnv: string | undefined = process.env.PATH): Browser | null {
  if (configured) return parseConfiguredBrowser(configured);
  for (const bin of CHROMIUM_BINARIES) {
    const exe = whichSync(bin, pathEnv);
    if (exe) return { kind: 'chromium', command: [exe], label: bin };
  }
  if (whichSync('flatpak', pathEnv)) {
    for (const app of CHROMIUM_FLATPAKS)
      if (flatpakInstalled(app)) return { kind: 'chromium', command: ['flatpak', 'run', app], label: `flatpak ${app}` };
  }
  for (const bin of ['firefox', 'librewolf']) {
    const exe = whichSync(bin, pathEnv);
    if (exe) return { kind: 'firefox', command: [exe], label: bin };
  }
  if (whichSync('flatpak', pathEnv) && flatpakInstalled('org.mozilla.firefox'))
    return { kind: 'firefox', command: ['flatpak', 'run', 'org.mozilla.firefox'], label: 'flatpak org.mozilla.firefox' };
  const xdg = whichSync('xdg-open', pathEnv);
  if (xdg) return { kind: 'xdg-open', command: [xdg], label: 'xdg-open' };
  return null;
}

/**
 * The environment a graphical child needs. The daemon's own environment when it has a display; otherwise the user's
 * systemd manager environment (desktops import DISPLAY / WAYLAND_DISPLAY into it at login), which is what a `systemd
 * --user` unit or an SSH session lacks. null when no display is known anywhere.
 */
export async function desktopEnvironment(base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv | null> {
  if (base.DISPLAY || base.WAYLAND_DISPLAY) return base;
  const imported = await systemdUserEnvironment();
  if (!imported.DISPLAY && !imported.WAYLAND_DISPLAY) return null;
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of DESKTOP_ENV_KEYS) if (imported[key] && !env[key]) env[key] = imported[key];
  return env;
}

function systemdUserEnvironment(): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const out: Record<string, string> = {};
    let child;
    try {
      child = spawn('systemctl', ['--user', 'show-environment'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(out);
      return;
    }
    let buf = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    timer.unref?.();
    child.stdout.on('data', (c: Buffer) => {
      if (buf.length < 65_536) buf += c.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.on('close', () => {
      clearTimeout(timer);
      for (const line of buf.split('\n')) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq);
        if ((DESKTOP_ENV_KEYS as readonly string[]).includes(key)) out[key] = line.slice(eq + 1);
      }
      resolve(out);
    });
  });
}

export interface LaunchPlan {
  command: string;
  args: string[];
  browser: Browser;
}

/** argv for opening `url` with `browser`; Chromium-family browsers get app mode and, when native, their own profile. */
export function launchPlan(browser: Browser, url: string, opts: { windowSize: string; profileDir: string | null }): LaunchPlan {
  const [head, ...rest] = browser.command;
  const command = head ?? 'xdg-open';
  const [w, h] = opts.windowSize.split('x');
  switch (browser.kind) {
    case 'chromium': {
      const args = [
        ...rest,
        `--app=${url}`,
        `--window-size=${w},${h}`,
        '--class=mide-studio',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=TranslateUI',
        '--hide-crash-restore-bubble',
      ];
      // A dedicated profile makes the Studio its own process and taskbar entry; Flatpak sandboxes cannot see it, so
      // those get an app window inside the default profile instead.
      if (opts.profileDir && command !== 'flatpak' && path.basename(command) !== 'flatpak')
        args.splice(rest.length, 0, `--user-data-dir=${opts.profileDir}`);
      return { command, args, browser };
    }
    case 'firefox':
      return { command, args: [...rest, '--new-window', url], browser };
    case 'xdg-open':
    case 'custom':
      return { command, args: [...rest, url], browser };
  }
}

export interface OpenResult {
  opened: boolean;
  url: string;
  /** why nothing was spawned */
  reason?: string;
  browser?: string;
}

export interface OpenOptions {
  /** follow this session first */
  sessionId?: string;
  /** mint a one-time pairing code into the URL (default true; false for a URL the user opens in an already-paired window) */
  pair?: boolean;
  /** skip spawning, just build the URL */
  dryRun?: boolean;
}

/** Studio URL on the loopback origin — the launcher is on the same machine as the daemon, TLS and tailnet not needed. */
export function studioUrl(loaded: LoadedConfig, opts: { code?: string; sessionId?: string } = {}): string {
  const base = localUrl(loaded.config).replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (opts.code) params.set('pair', opts.code);
  if (opts.sessionId) params.set('session', opts.sessionId);
  const hash = params.toString();
  return `${base}${API.studio}${hash ? `#${hash}` : ''}`;
}

/**
 * Mint the code, pick the browser, find a display, spawn detached. Never throws: every reason a window did not appear is
 * in the result (and the log), because "the Studio did not pop up" must be diagnosable from `mide doctor`/journal alone.
 */
export async function openStudio(loaded: LoadedConfig, db: Db, opts: OpenOptions = {}): Promise<OpenResult> {
  const pair = opts.pair ?? true;
  const code = pair ? generatePairingCode() : undefined;
  const url = studioUrl(loaded, { code, sessionId: opts.sessionId });
  const built = await resolveStudio(loaded);
  if (!built.location) {
    return {
      opened: false,
      url,
      reason: `studio build not found (looked in ${built.candidates.map((c) => c.dir).join(', ')}); run \`pnpm build\``,
    };
  }
  // From here the URL is real: the code it carries is redeemable for STUDIO_PAIR_TTL_MS (also for `mide studio --no-open`).
  if (code) db.createPairingCode(code, STUDIO_PAIR_TTL_MS);
  const browser = findBrowser(loaded.config.studio.browser);
  if (opts.dryRun) return { opened: false, url, reason: 'dry run', ...(browser ? { browser: browser.label } : {}) };
  if (!browser)
    return { opened: false, url, reason: 'no browser found (install Chrome/Chromium/Brave/Firefox or set studio.browser in config.json)' };
  const env = await desktopEnvironment();
  if (!env)
    return {
      opened: false,
      url,
      reason: 'no display: neither DISPLAY nor WAYLAND_DISPLAY is set for the daemon or in `systemctl --user show-environment`',
      browser: browser.label,
    };
  const plan = launchPlan(browser, url, {
    windowSize: loaded.config.studio.windowSize,
    profileDir: path.join(loaded.home, 'studio-profile'),
  });
  try {
    // Detached + its own stdio: the window outlives a daemon restart and never blocks the event loop.
    const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', env });
    child.on('error', (err) => log.warn('studio.spawn_failed', { command: plan.command, ...errorInfo(err) }));
    child.unref();
  } catch (err) {
    return { opened: false, url, reason: `could not start ${browser.label}: ${(err as Error).message}`, browser: browser.label };
  }
  log.info('studio.opened', { browser: browser.label, sessionId: opts.sessionId, paired: !!code });
  return { opened: true, url, browser: browser.label };
}

/**
 * Auto-open policy, wired in app.ts: open on session creation or a new turn, unless connected or just launched.
 * `connected()` reports the /ws hello names, so a Studio that is open (paired and connected) simply follows the new
 * session in place — the phone starting three sessions in a row does not produce three windows.
 */
export class StudioLauncher {
  private readonly unsubs: Unsubscribe[] = [];
  private lastLaunchAt = 0;
  private inflight: Promise<OpenResult> | null = null;

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly db: Db,
    bus: EventBus,
    private readonly connected: () => { clientName: string | null }[],
  ) {
    this.unsubs.push(
      bus.onEvent((env) => {
        if (env.event.type !== 'session.created' && env.event.type !== 'turn.started') return;
        void this.onSessionCreated(env.sessionId);
      }),
    );
  }

  /** true while a Studio window has a live /ws connection */
  studioConnected(): boolean {
    return this.connected().some((c) => c.clientName === STUDIO_CLIENT_NAME);
  }

  private async onSessionCreated(sessionId: string): Promise<void> {
    if (!this.loaded.config.studio.autoOpen) return;
    if (this.studioConnected()) {
      log.debug('studio.auto_open.skipped', { sessionId, reason: 'a studio is connected' });
      return;
    }
    if (Date.now() - this.lastLaunchAt < RELAUNCH_COOLDOWN_MS || this.inflight) {
      log.debug('studio.auto_open.skipped', { sessionId, reason: 'cooldown' });
      return;
    }
    const result = await this.open({ sessionId });
    if (!result.opened) log.info('studio.auto_open.not_opened', { sessionId, reason: result.reason });
  }

  /** Open a window now (REST / CLI path through the daemon). Serialized: two callers share one launch. */
  open(opts: OpenOptions = {}): Promise<OpenResult> {
    if (this.inflight) return this.inflight;
    this.inflight = openStudio(this.loaded, this.db, opts)
      .then((r) => {
        if (r.opened) this.lastLaunchAt = Date.now();
        return r;
      })
      .catch((err: unknown): OpenResult => ({ opened: false, url: studioUrl(this.loaded), reason: errorMessage(err) }))
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }
}
