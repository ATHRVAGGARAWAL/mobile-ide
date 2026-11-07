/**
 * Terminals the *agent* asks the client to run (ACP `terminal/*`). These are plain child
 * processes with captured output so agents that rely on the terminal capability
 * (claude-agent-acp, codex-acp) work; they are unrelated to the user's tmux terminal tab.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { newId } from '../auth.js';
import { createLogger } from '../log.js';

const log = createLogger({ mod: 'agent-terminals' });

export interface AgentTerminal {
  id: string;
  sessionId: string;
  output: string;
  truncated: boolean;
  exit: { exitCode: number | null; signal: string | null } | null;
  exited: Promise<{ exitCode: number | null; signal: string | null }>;
  child: ChildProcess;
  released: boolean;
}

export interface CreateTerminalInput {
  sessionId: string;
  command: string;
  args?: string[];
  env?: { name: string; value: string }[];
  cwd?: string | null;
  outputByteLimit?: number | null;
}

const DEFAULT_LIMIT = 256 * 1024;
/** SIGTERM → SIGKILL escalation delay */
const KILL_GRACE_MS = 3_000;
/** after SIGKILL, how long kill() still waits for the exit to be observed before giving up */
const REAP_GRACE_MS = 2_000;
/** how long a finished terminal's record (and captured output) stays around for a trailing tool_call_update */
const FORGET_GRACE_MS = 60_000;
/**
 * Records per session, as a backstop against adapters that never release: beyond this the oldest finished
 * ones are dropped at once instead of after the grace period.
 */
const MAX_PER_SESSION = 64;

function delay(ms: number): Promise<'timeout'> {
  return new Promise((res) => setTimeout(() => res('timeout'), ms).unref());
}

/** Signal the command's whole process group (spawned detached); fall back to the direct child. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  try {
    if (pid) process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export class AgentTerminals {
  private readonly terminals = new Map<string, AgentTerminal>();

  create(input: CreateTerminalInput, defaultCwd: string, baseEnv: NodeJS.ProcessEnv): AgentTerminal {
    const id = `term_${newId()}`;
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    for (const e of input.env ?? []) env[e.name] = e.value;
    const limit = input.outputByteLimit && input.outputByteLimit > 0 ? input.outputByteLimit : DEFAULT_LIMIT;
    // Own process group so kill() reaches wrappers' children too (npm/pnpm scripts, shell -c, dev servers).
    const child = spawn(input.command, input.args ?? [], {
      cwd: input.cwd || defaultCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    let resolveExit: (v: { exitCode: number | null; signal: string | null }) => void = () => {};
    const exited = new Promise<{ exitCode: number | null; signal: string | null }>((res) => {
      resolveExit = res;
    });
    const term: AgentTerminal = { id, sessionId: input.sessionId, output: '', truncated: false, exit: null, exited, child, released: false };
    const append = (chunk: Buffer) => {
      term.output += chunk.toString('utf8');
      if (term.output.length > limit) {
        // keep the tail, cut at a char boundary
        term.output = term.output.slice(term.output.length - limit);
        term.truncated = true;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => {
      term.output += `\n[spawn error] ${err.message}\n`;
      term.exit = { exitCode: 127, signal: null };
      resolveExit(term.exit);
    });
    child.on('close', (code, signal) => {
      term.exit = { exitCode: code, signal: signal ?? null };
      resolveExit(term.exit);
    });
    this.terminals.set(id, term);
    this.trimSession(input.sessionId);
    log.debug('terminal.created', { id, command: input.command, args: input.args });
    return term;
  }

  /** Drop a record after `graceMs` (so late `terminal/output` and tool_call_update lookups still succeed). */
  private forget(id: string, graceMs: number): void {
    if (graceMs <= 0) {
      this.terminals.delete(id);
      return;
    }
    setTimeout(() => this.terminals.delete(id), graceMs).unref();
  }

  private trimSession(sessionId: string): void {
    const mine = [...this.terminals.values()].filter((t) => t.sessionId === sessionId);
    if (mine.length <= MAX_PER_SESSION) return;
    const finished = mine.filter((t) => t.exit !== null);
    for (const t of finished.slice(0, mine.length - MAX_PER_SESSION)) this.terminals.delete(t.id);
  }

  /** How many records are held (tests / diagnostics). */
  size(): number {
    return this.terminals.size;
  }

  get(id: string): AgentTerminal | undefined {
    return this.terminals.get(id);
  }

  output(id: string): { output: string; truncated: boolean; exitStatus: { exitCode: number | null; signal: string | null } | null } | null {
    const t = this.terminals.get(id);
    if (!t) return null;
    return { output: t.output, truncated: t.truncated, exitStatus: t.exit };
  }

  async waitForExit(id: string): Promise<{ exitCode: number | null; signal: string | null } | null> {
    const t = this.terminals.get(id);
    if (!t) return null;
    return t.exited;
  }

  /**
   * SIGTERM the command's process group, SIGKILL after KILL_GRACE_MS. Resolves once the exit has been
   * observed (or shortly after the SIGKILL when it cannot be) so shutdown can await it — an unref'd
   * timer alone would be beaten by process.exit(), leaving anything that ignores SIGTERM running.
   * Resolves false for an unknown terminal.
   */
  async kill(id: string): Promise<boolean> {
    const t = this.terminals.get(id);
    if (!t) return false;
    if (t.exit) return true;
    signalGroup(t.child, 'SIGTERM');
    if ((await Promise.race([t.exited, delay(KILL_GRACE_MS)])) === 'timeout' && !t.exit) {
      log.warn('terminal.kill.escalate', { id, pid: t.child.pid });
      signalGroup(t.child, 'SIGKILL');
      await Promise.race([t.exited, delay(REAP_GRACE_MS)]);
    }
    return true;
  }

  release(id: string): boolean {
    const t = this.terminals.get(id);
    if (!t) return false;
    t.released = true;
    void this.kill(id);
    // keep output around briefly so a trailing tool_call_update can still embed it
    this.forget(id, FORGET_GRACE_MS);
    return true;
  }

  /**
   * Reap every command of a session (its ACP session closed, or its adapter died) and drop the records after the
   * usual grace — adapters that announce terminals through `_meta` never call terminal/release, so this is the
   * only path that ever frees their captured output.
   */
  killAllForSession(sessionId: string): Promise<void> {
    const ids = [...this.terminals.values()].filter((t) => t.sessionId === sessionId).map((t) => t.id);
    return Promise.all(
      ids.map(async (id) => {
        await this.kill(id);
        this.forget(id, FORGET_GRACE_MS);
      }),
    ).then(() => undefined);
  }

  /** Resolves only once every live command has been reaped (bounded by KILL_GRACE_MS + REAP_GRACE_MS). Shutdown: nothing is kept. */
  killAll(): Promise<void> {
    const ids = [...this.terminals.keys()];
    return Promise.all(
      ids.map(async (id) => {
        await this.kill(id);
        this.forget(id, 0);
      }),
    ).then(() => undefined);
  }
}
