/**
 * Shared scaffolding for the durability proofs (e2e-permissions, e2e-restart, e2e-crash).
 * Not a test file: the runner only picks up `test/*.test.ts`.
 *
 * Every proof boots the real daemon in-process on a temporary MIDE_HOME, pairs a device over HTTP and
 * drives it with core's `MideClient` — the same client the phone uses — so the assertions hold for the
 * wire contract rather than for internals. The only internals touched are `RunningServer.ctx.db` (to
 * verify persistence and to forge crash leftovers) and the agent host (to find the adapter's pid).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import { API, EventEnvelope, MideClient, PairResponse, PermissionRequest, SessionSummary } from '@mobile-ide/core';
import { z } from 'zod';
import { startServer } from '../src/app.js';
import { generatePairingCode } from '../src/auth.js';
import { defaultAgents, type AgentConfig } from '../src/config.js';
import type { RunningServer } from '../src/context.js';
import { setLogSink } from '../src/log.js';
import { api, Collector, qs, REPO, which } from './helpers.js';

// ------------------------------------------------------------------ agent gate
export const AGENT_ID = process.env.MIDE_TEST_AGENT?.trim() || 'opencode';
/** the binary each built-in adapter ultimately needs on PATH */
const AGENT_BINARY: Record<string, string> = { opencode: 'opencode', claude: 'claude', codex: 'codex' };
/** the cheapest possible real turn */
export const PONG_PROMPT = 'Reply with exactly the word PONG and nothing else.';

/** Why the agent-backed proofs cannot run here, or undefined when they can. */
export function agentSkipReason(): string | undefined {
  if (process.env.MIDE_SKIP_AGENT_TESTS === '1') return 'MIDE_SKIP_AGENT_TESTS=1';
  const cfg = defaultAgents()[AGENT_ID];
  if (!cfg) return `MIDE_TEST_AGENT=${AGENT_ID} is not a built-in agent (opencode|claude|codex)`;
  const bin = AGENT_BINARY[AGENT_ID] ?? cfg.command;
  if (!which(bin)) return `'${bin}' is not on PATH — install it, or set MIDE_SKIP_AGENT_TESTS=1 to silence this`;
  if (cfg.command !== bin && !which(cfg.command)) return `'${cfg.command}' (needed to launch the ${cfg.name} adapter) is not on PATH`;
  return undefined;
}

// ------------------------------------------------------------------ daemon log capture
export interface DaemonLog {
  readonly lines: string[];
  tail(n?: number): string;
}

/** Redirect the daemon's structured log into memory (streamed to stderr with MIDE_E2E_VERBOSE=1). */
export function captureDaemonLog(): DaemonLog {
  const lines: string[] = [];
  setLogSink((line) => {
    if (process.env.MIDE_E2E_VERBOSE === '1') process.stderr.write(`${line}\n`);
    lines.push(line);
    if (lines.length > 600) lines.shift();
  });
  return { lines, tail: (n = 40) => lines.slice(-n).join('\n') };
}

export type StepFn = (name: string, opts: { timeout?: number; skip?: string | undefined }, fn: (t: TestContext) => Promise<void>) => void;

/** `it` that dumps the daemon log tail as a diagnostic when the step fails. */
export function stepFactory(log: DaemonLog): StepFn {
  return (name, opts, fn) => {
    it(name, { timeout: opts.timeout ?? 30_000, ...(opts.skip ? { skip: opts.skip } : {}) }, async (t) => {
      try {
        await fn(t);
      } catch (err) {
        const tail = log.tail(40);
        if (tail) t.diagnostic(`daemon log tail:\n${tail}`);
        throw err;
      }
    });
  };
}

// ------------------------------------------------------------------ daemon lifecycle
export interface BootOptions {
  home: string;
  repo: string;
  port: number;
  serverName: string;
  /** extra environment for the agent adapter (merged over the built-in agent config) */
  agentEnv?: Record<string, string>;
  agentId?: string;
}

/** Boot the daemon on `home` with exactly one agent configured and `repo` as the only project root. */
export async function bootDaemon(o: BootOptions): Promise<RunningServer> {
  const agentId = o.agentId ?? AGENT_ID;
  const builtIn = defaultAgents()[agentId];
  if (!builtIn) throw new Error(`unknown agent '${agentId}'`);
  const cfg: AgentConfig = { ...builtIn, env: { ...builtIn.env, ...(o.agentEnv ?? {}) } };
  process.env.MIDE_HOME = o.home;
  const running = await startServer({
    home: o.home,
    overrides: {
      port: o.port,
      host: '127.0.0.1',
      serverName: o.serverName,
      publicUrl: null,
      projects: { roots: [o.repo], denylist: [path.join(o.repo, REPO.secretDir)] },
      agents: { [agentId]: cfg },
      terminal: { shell: '$SHELL', tmuxPrefix: `mide-dur-${process.pid}`, autoOpen: false },
    },
  });
  assert.equal(running.port, o.port, 'RunningServer.port is the requested port');
  return running;
}

export function baseUrl(running: RunningServer): string {
  return `http://127.0.0.1:${running.port}`;
}

/** Mint a pairing code through the daemon's own DB and redeem it over HTTP, like `mide pair` + the app. */
export async function pairDevice(running: RunningServer, deviceName: string): Promise<{ token: string; deviceId: string }> {
  const code = generatePairingCode();
  running.ctx.db.createPairingCode(code);
  const r = await api(baseUrl(running), 'POST', API.pair, { body: { code, deviceName, platform: 'node' } });
  assert.ok(r.status === 200 || r.status === 201, `pair: ${r.status} ${r.text}`);
  const pr = PairResponse.parse(r.body);
  return { token: pr.token, deviceId: pr.deviceId };
}

// ------------------------------------------------------------------ live client
export interface LiveClient {
  client: MideClient;
  col: Collector;
}

/** A connected `MideClient` recording everything into a `Collector`. */
export async function openClient(base: string, token: string, clientName: string): Promise<LiveClient> {
  const col = new Collector();
  const client = new MideClient({
    baseUrl: base,
    token,
    clientName,
    clientVersion: '0.0.0',
    onEvent: col.onEvent,
    onReplayDone: col.onReplayDone,
    onSessions: col.onSessions,
    onState: col.onState,
  });
  client.connect();
  await col.state('open', 10_000);
  return { client, col };
}

/** Subscribe from the start of the log and wait for the replay to finish; returns the replayed lastSeq. */
export async function subscribeFromStart(live: LiveClient, sessionId: string): Promise<number> {
  live.client.subscribe(sessionId, 0);
  const done = await live.col.until(() => live.col.replays.find((r) => r.sessionId === sessionId), `replay.done for ${sessionId}`, 15_000);
  return done.lastSeq;
}

export function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`${what} is not set — an earlier step failed`);
  return v;
}

/** seq of the last event the collector received (-1 when none). */
export function lastSeqOf(col: Collector): number {
  const last = col.events[col.events.length - 1];
  return last ? last.seq : -1;
}

/** Concatenated assistant text of one turn. */
export function assistantText(col: Collector, turnId: string): string {
  return col.events.map((e) => (e.event.type === 'message.delta' && e.event.turnId === turnId ? e.event.text : '')).join('');
}

/** Messages of every session.error in the collector (for failure diagnostics). */
export function errorMessages(events: EventEnvelope[]): string {
  return events.flatMap((e) => (e.event.type === 'session.error' ? [e.event.message] : [])).join(' | ');
}

// ------------------------------------------------------------------ REST reads
export async function createSession(
  base: string,
  token: string,
  body: { agent: string; cwd: string; title: string },
  t?: TestContext,
): Promise<SessionSummary> {
  const t0 = Date.now();
  const r = await api(base, 'POST', API.sessions, { token, body });
  assert.equal(r.status, 201, r.text);
  const summary = SessionSummary.parse(r.body);
  t?.diagnostic(`session '${body.title}' created in ${((Date.now() - t0) / 1000).toFixed(1)} s (status ${summary.status})`);
  if (summary.status !== 'idle') {
    const events = await sessionEvents(base, token, summary.id);
    const errors = events.flatMap((e) =>
      e.event.type === 'session.error' ? [e.event.message] : e.event.type === 'session.status' && e.event.detail ? [e.event.detail] : [],
    );
    assert.fail(`session status is '${summary.status}', expected 'idle': ${errors.join(' | ') || 'no error events'}`);
  }
  return summary;
}

export async function sessionSummary(base: string, token: string, sessionId: string): Promise<SessionSummary> {
  const r = await api(base, 'GET', API.session(sessionId), { token });
  assert.equal(r.status, 200, r.text);
  return SessionSummary.parse(r.body);
}

/** The persisted log over HTTP (`after` defaults to the whole log). */
export async function sessionEvents(base: string, token: string, sessionId: string, after?: number): Promise<EventEnvelope[]> {
  const r = await api(base, 'GET', `${API.sessionEvents(sessionId)}${qs({ after, limit: 5000 })}`, { token });
  assert.equal(r.status, 200, r.text);
  return z.array(EventEnvelope).parse(r.body);
}

export async function pendingPermissions(base: string, token: string, sessionId?: string): Promise<PermissionRequest[]> {
  const r = await api(base, 'GET', `${API.pendingPermissions}${qs({ sessionId })}`, { token });
  assert.equal(r.status, 200, r.text);
  return z.array(PermissionRequest).parse(r.body);
}

// ------------------------------------------------------------------ seq invariants
/** Every event's seq is exactly the previous one plus one. */
export function assertDense(events: EventEnvelope[], what: string): void {
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const cur = events[i];
    assert.ok(prev && cur);
    assert.equal(cur.seq, prev.seq + 1, `${what}: seq must be dense and increasing (${prev.seq} then ${cur.seq} at index ${i})`);
  }
}

// ------------------------------------------------------------------ adapter process
/**
 * Pid of the agent's adapter process. The daemon runs in this process, so the adapter is one of our
 * direct children; the host's private `proc` is consulted first (that is what the daemon itself
 * signals), the /proc tree is the fallback.
 */
export function adapterPid(running: RunningServer, agentId = AGENT_ID): number | undefined {
  const host = running.ctx.sessions.hosts.get(agentId);
  const proc = (host as unknown as { proc?: { pid?: number } | null } | undefined)?.proc;
  if (proc && typeof proc.pid === 'number') return proc.pid;
  const command = host?.cfg.command ?? agentId;
  return childProcesses(process.pid).find((c) => c.cmdline.includes(command))?.pid;
}

/** Direct children of `ppid` on Linux (/proc). */
export function childProcesses(ppid: number): { pid: number; cmdline: string }[] {
  const out: { pid: number; cmdline: string }[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const fields = statFields(Number(entry));
      if (!fields || Number(fields[1]) !== ppid) continue;
      out.push({ pid: Number(entry), cmdline: cmdlineOf(Number(entry)) });
    } catch {
      /* raced with an exit */
    }
  }
  return out;
}

/** `/proc/<pid>/stat` fields after the command name: [state, ppid, pgrp, ...]. */
function statFields(pid: number): string[] | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ');
  } catch {
    return null;
  }
}

export function cmdlineOf(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

/** True while the process exists and is not a zombie. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  const fields = statFields(pid);
  return fields !== null && fields[0] !== 'Z';
}

/**
 * SIGKILL the adapter the way a crash or the OOM killer would: the whole process group (the daemon
 * spawns adapters detached, so pid == pgid), which also takes an `npx`-wrapped adapter's real process
 * and leaves no orphan behind. Falls back to the pid alone when the group is already gone.
 */
export function killAdapter(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
