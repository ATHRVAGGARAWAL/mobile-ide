/**
 * Daemon configuration: ~/.mobile-ide/config.json (or $MIDE_HOME/config.json).
 * Created with defaults on first run; unknown keys are preserved on disk but ignored.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { log } from './log.js';

const AgentConfig = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).prefault({}),
  /** extra model ids offered in the new-session sheet */
  customModels: z.array(z.string()).optional(),
  /** disable without deleting */
  enabled: z.boolean().default(true),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const ConfigSchema = z.object({
  serverName: z
    .string()
    .min(1)
    .default(() => os.hostname()),
  port: z.number().int().min(1).max(65535).default(4820),
  host: z.string().min(1).default('127.0.0.1'),
  publicUrl: z.string().url().nullable().default(null),
  /**
   * Honour `X-Forwarded-For` from a loopback peer (the daemon sits behind `tailscale serve` or another
   * reverse proxy on the same machine). Off by default: with it on, a proxy-less loopback caller could
   * forge the address the pairing rate limit is keyed on.
   */
  trustProxy: z.boolean().default(false),
  /**
   * The exported web app (`expo export -p web` output: index.html, _expo/, manifest, sw.js) the daemon serves at `/`,
   * so the phone opens the app at the tailnet URL. `dir` null (default) = auto-detect: `<repo>/apps/mobile/dist`
   * when the daemon runs from the checkout, else `<MIDE_HOME>/www`. Set an absolute or `~/` path to override.
   */
  webApp: z.object({ dir: z.string().min(1).nullable().default(null) }).prefault({}),
  /**
   * The Studio: the laptop-side live editor (`apps/studio`, served at `/studio/`). `autoOpen` pops it up in a dedicated
   * browser app-window the moment a session is created — when a display is reachable and no Studio window is connected
   * yet. `browser` names the executable to use (`google-chrome`, `brave-browser`, `flatpak run com.brave.Browser`, …);
   * null = auto-detect a Chromium-family browser, then Firefox, then `xdg-open`. `dir` overrides where the build lives
   * (default: `<repo>/apps/studio/dist` from a checkout, else `<MIDE_HOME>/studio`).
   */
  studio: z
    .object({
      autoOpen: z.boolean().default(true),
      browser: z.string().min(1).nullable().default(null),
      dir: z.string().min(1).nullable().default(null),
      /** window size for the app-mode window, `WIDTHxHEIGHT` */
      windowSize: z
        .string()
        .regex(/^\d{3,5}x\d{3,5}$/)
        .default('1480x920'),
    })
    .prefault({}),
  projects: z
    .object({
      roots: z.array(z.string()).default(['~/']),
      denylist: z.array(z.string()).default(['~/.ssh', '~/.gnupg', '~/.mobile-ide']),
    })
    .prefault({}),
  agents: z.record(z.string(), AgentConfig).prefault({}),
  notifications: z
    .object({
      ntfy: z.object({ server: z.string().url().default('https://ntfy.sh'), topic: z.string().nullable().default(null) }).prefault({}),
      expo: z.object({ enabled: z.boolean().default(true) }).prefault({}),
      webpush: z
        .object({
          vapidPublicKey: z.string().nullable().default(null),
          vapidPrivateKey: z.string().nullable().default(null),
          subject: z.string().default('mailto:me@example.com'),
        })
        .prefault({}),
    })
    .prefault({}),
  terminal: z.object({
    shell: z.string().default('$SHELL'),
    tmuxPrefix: z.string().min(1).default('mide'),
    /** Mirror phone shells in a desktop terminal attached to the same tmux session. */
    autoOpen: z.boolean().default(false),
  }).prefault({}),
  limits: z
    .object({
      maxFileBytes: z.number().int().positive().default(1048576),
      maxDiffBytes: z.number().int().positive().default(2097152),
      eventReplayBatch: z.number().int().positive().default(500),
      /**
       * Closed sessions (and their event logs) are deleted this many days after they were closed, at daemon start.
       * 0 keeps them forever. Open sessions are never pruned.
       */
      closedSessionRetentionDays: z.number().int().nonnegative().default(30),
    })
    .prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export function defaultAgents(): Record<string, AgentConfig> {
  return {
    opencode: { name: 'OpenCode', command: 'opencode', args: ['acp'], env: {}, enabled: true },
    claude: { name: 'Claude Code', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.73.0'], env: {}, enabled: true },
    codex: { name: 'Codex', command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@1.8.0'], env: { CODEX_PATH: '' }, enabled: true },
  };
}

export function defaultConfig(): Config {
  return ConfigSchema.parse({ agents: defaultAgents() });
}

export function mideHome(): string {
  const env = process.env.MIDE_HOME;
  if (env && env.trim()) return path.resolve(expandHome(env.trim()));
  return path.join(os.homedir(), '.mobile-ide');
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface LoadedConfig {
  config: Config;
  home: string;
  configPath: string;
  dbPath: string;
  adminSocketPath: string;
}

/**
 * Load config from disk, creating the directory and a default file on first run.
 * `overrides` win over the file (used by CLI flags and tests).
 */
export function loadConfig(opts: { configPath?: string; overrides?: Partial<Config> } = {}): LoadedConfig {
  const home = mideHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = opts.configPath ? path.resolve(expandHome(opts.configPath)) : path.join(home, 'config.json');
  let raw: unknown = {};
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    } catch (err) {
      throw new Error(`Could not parse ${configPath}: ${(err as Error).message}`);
    }
  } else {
    const def = { ...defaultConfig(), agents: defaultAgents() };
    fs.writeFileSync(configPath, JSON.stringify(def, null, 2) + '\n', { mode: 0o600 });
    log.info('config.created', { path: configPath });
    raw = def;
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${configPath}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  let config = parsed.data;
  if (Object.keys(config.agents).length === 0) config = { ...config, agents: defaultAgents() };
  if (opts.overrides) config = ConfigSchema.parse({ ...config, ...opts.overrides });
  return {
    config,
    home,
    configPath,
    dbPath: path.join(home, 'mide.db'),
    adminSocketPath: path.join(home, 'admin.sock'),
  };
}

/** Effective environment for an agent child: daemon env + per-agent env, empty strings dropped. */
export function agentEnv(agent: AgentConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(agent.env)) {
    if (v === '') delete env[k];
    else env[k] = v;
  }
  return env;
}

export function resolveShell(config: Config): string {
  const s = config.terminal.shell;
  if (s === '$SHELL' || s === '') return process.env.SHELL || '/bin/bash';
  return s;
}

export function localUrl(config: Config): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host}:${config.port}`;
}

export function publicOrLocalUrl(config: Config): string {
  return config.publicUrl ?? localUrl(config);
}
