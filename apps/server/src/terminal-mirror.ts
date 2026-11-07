/** Open the phone's existing tmux shell on the laptop without creating another shell. */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { desktopEnvironment } from './studio.js';
import { isValidTerminalId } from './terminal.js';
import { createLogger, errorInfo } from './log.js';

const exec = promisify(execFile);
const log = createLogger({ mod: 'terminal-mirror' });
const COOLDOWN_MS = 20_000;

export function terminalLaunchPlan(session: string, cwd: string, pathEnv = process.env.PATH ?? '') {
  const title = `Mobile IDE · ${path.basename(cwd)}`;
  // Keep each viewer's active pane independent; this flag also identifies our desktop client.
  const attach = ['tmux', '-u', 'attach-session', '-f', 'active-pane', '-t', `=${session}`];
  const candidates = [
    { name: 'ptyxis', args: ['--new-window', '--title', title, '--', ...attach] },
    { name: 'gnome-terminal', args: ['--window', '--title', title, '--', ...attach] },
    { name: 'konsole', args: ['--separate', '-e', ...attach] },
    { name: 'xterm', args: ['-T', title, '-e', ...attach] },
  ];
  for (const candidate of candidates) {
    for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
      const command = path.join(dir, candidate.name);
      try {
        fs.accessSync(command, fs.constants.X_OK);
        if (fs.statSync(command).isFile()) return { command, args: candidate.args };
      } catch {
        /* next candidate */
      }
    }
  }
  return null;
}

/** A mirrored shell uses the largest attached viewport and shrinks again when that viewer leaves. */
export async function prepareMirroredTerminal(session: string): Promise<void> {
  const { stdout } = await exec('tmux', ['list-clients', '-t', `=${session}`, '-F', '#{client_name}\t#{client_flags}'], { timeout: 3000 });
  for (const line of stdout.trim().split('\n')) {
    const [name, flags] = line.split('\t');
    if (name && flags?.split(',').includes('ignore-size')) {
      await exec('tmux', ['refresh-client', '-t', name, '-f', '!ignore-size,active-pane'], { timeout: 3000 });
    }
  }
  await exec('tmux', ['set-option', '-w', '-t', `=${session}:`, 'window-size', 'largest'], { timeout: 3000 });
}

const defaultActions = {
  desktop: desktopEnvironment,
  prepare: prepareMirroredTerminal,
  clients: async (session: string): Promise<string> => {
    const result = await exec('tmux', ['list-clients', '-t', `=${session}`, '-F', '#{client_flags}'], { timeout: 3000 });
    return result.stdout;
  },
  launch: async (session: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> => {
    const plan = terminalLaunchPlan(session, cwd, env.PATH);
    if (!plan) throw new Error('No supported desktop terminal found (Ptyxis, GNOME Terminal, Konsole or xterm)');
    const childEnv = { ...env };
    delete childEnv.TMUX;
    delete childEnv.TMUX_PANE;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(plan.command, plan.args, { env: childEnv, detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  },
};

export class TerminalMirror {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly launchedAt = new Map<string, number>();

  constructor(
    private readonly prefix: string,
    private readonly actions = defaultActions,
  ) {}

  open(id: string, cwd: string): Promise<void> {
    if (!isValidTerminalId(id) || !/^[a-zA-Z0-9_-]{1,32}$/.test(this.prefix)) return Promise.resolve();
    const pending = this.pending.get(id);
    if (pending) return pending;
    const task = this.openOnce(id, cwd)
      .catch((err: unknown) => log.warn('terminal.mirror_failed', { id, ...errorInfo(err) }))
      .finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }

  private async openOnce(id: string, cwd: string): Promise<void> {
    const now = Date.now();
    for (const [key, at] of this.launchedAt) if (now - at >= COOLDOWN_MS) this.launchedAt.delete(key);
    if (this.launchedAt.has(id)) return;
    const env = await this.actions.desktop();
    if (!env) return;
    const session = `${this.prefix}-${id}`;
    await this.actions.prepare(session);
    // This survives daemon restarts and prevents phone reconnects from opening duplicate windows.
    const clients = await this.actions.clients(session);
    if (clients.split(/[\s,]+/).includes('active-pane')) return;
    await this.actions.launch(session, cwd, env);
    this.launchedAt.set(id, Date.now());
    log.info('terminal.mirrored', { id, cwd });
  }
}
