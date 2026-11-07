/**
 * Durability proof (c): the agent adapter dies under a live session.
 *
 *   - the adapter's process group is SIGKILLed (pid found through the agent host), the way a crash or
 *     the OOM killer would take it — no graceful exit, no flush
 *   - the daemon notices at once: `session.error {code:'agent_exited'}` + `session.status 'error'` are
 *     persisted and streamed, the summary/sessions.changed/health/agents all report the failure, and
 *     the log stays dense
 *   - the very next prompt respawns the adapter, restores the agent session (session/load, or a fresh
 *     one with an explicit note), runs the turn to completion and reports the agent ready again
 *
 * Costs real tokens: one tiny prompt. Gates: MIDE_SKIP_AGENT_TESTS=1, MIDE_TEST_AGENT=<id>, MIDE_E2E_VERBOSE=1.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe } from 'node:test';
import { AgentInfo, API, HealthResponse } from '@mobile-ide/core';
import { z } from 'zod';
import type { RunningServer } from '../src/context.js';
import { api, makeTmpRepo, pickFreePort, rmrf, tmpDir, waitFor, wire } from './helpers.js';
import {
  adapterPid,
  AGENT_ID,
  agentSkipReason,
  assertDense,
  assistantText,
  baseUrl,
  bootDaemon,
  captureDaemonLog,
  cmdlineOf,
  createSession,
  errorMessages,
  killAdapter,
  lastSeqOf,
  must,
  openClient,
  pairDevice,
  PONG_PROMPT,
  processAlive,
  sessionEvents,
  sessionSummary,
  stepFactory,
  subscribeFromStart,
  type LiveClient,
} from './durability-helpers.js';

const SKIP = agentSkipReason();
const daemonLog = captureDaemonLog();
const step = stepFactory(daemonLog);

// ------------------------------------------------------------------ shared state (steps run in order)
let running: RunningServer | undefined;
let base = '';
let home: string | undefined;
let repo = '';
let token = '';
let sessionId = '';
let live: LiveClient | undefined;
let pid = 0;

function server(): RunningServer {
  return must(running, 'daemon');
}

async function health(): Promise<HealthResponse> {
  const r = await api(base, 'GET', API.health, { token });
  assert.equal(r.status, 200, r.text);
  return HealthResponse.parse(r.body);
}

async function agentInfo(): Promise<AgentInfo> {
  const r = await api(base, 'GET', API.agents, { token });
  assert.equal(r.status, 200, r.text);
  const info = z.array(AgentInfo).parse(r.body).find((a) => a.id === AGENT_ID);
  assert.ok(info, `agent ${AGENT_ID} in /api/agents`);
  return info;
}

describe('durability: adapter crash', { skip: SKIP }, () => {
  before(
    async () => {
      if (SKIP) return;
      home = tmpDir('mide-crash-home-');
      repo = makeTmpRepo();
      running = await bootDaemon({ home, repo, port: await pickFreePort(), serverName: 'mide-crash' });
      base = baseUrl(running);
      ({ token } = await pairDevice(running, 'crash tester'));
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      live?.client.close();
      if (running) {
        await running.close({ drainMs: 5_000, cancelTurns: true });
        running = undefined;
      }
      // belt and braces: never leave an adapter behind if a step failed between kill and respawn
      if (pid && processAlive(pid)) killAdapter(pid);
      rmrf(home);
      rmrf(repo);
    },
    { timeout: 60_000 },
  );

  step('a session exists, the phone is subscribed, and the adapter pid is known through the host', { timeout: 150_000 }, async (t) => {
    const s = await createSession(base, token, { agent: AGENT_ID, cwd: repo, title: 'crash proof' }, t);
    sessionId = s.id;
    live = await openClient(base, token, 'mide-crash-phone');
    live.client.watchSessionList();
    const lastSeq = await subscribeFromStart(live, sessionId);
    assert.ok(lastSeq >= 1);

    const found = adapterPid(server());
    assert.ok(found, `the ${AGENT_ID} host exposes its adapter pid`);
    pid = found;
    assert.ok(processAlive(pid), `adapter pid ${pid} is alive`);
    const command = must(server().ctx.sessions.hosts.get(AGENT_ID), 'host').cfg.command;
    const cmdline = cmdlineOf(pid);
    assert.ok(cmdline.includes(path.basename(command)), `pid ${pid} runs the ${AGENT_ID} adapter (${JSON.stringify(cmdline)})`);
    t.diagnostic(`adapter pid ${pid}: ${cmdline}`);

    const h = await health();
    const agent = h.agents.find((a) => a.id === AGENT_ID);
    assert.equal(agent?.state, 'ready', agent?.detail);
    assert.ok((agent?.sessions ?? 0) >= 1);
    assert.equal((await agentInfo()).available, true);
  });

  step('SIGKILL: session.error + status error are persisted and streamed; health and agents report the failure', { timeout: 30_000 }, async (t) => {
    const { col } = must(live, 'live client');
    const from = lastSeqOf(col);
    const t0 = Date.now();
    killAdapter(pid);
    const errored = await col.event((e) => e.seq > from && e.event.type === 'session.error', 'session.error after the kill', 15_000);
    assert.ok(errored.event.type === 'session.error');
    t.diagnostic(`session.error streamed ${((Date.now() - t0) / 1000).toFixed(1)} s after SIGKILL: ${errored.event.message}`);
    assert.equal(errored.event.code, 'agent_exited');
    assert.equal(errored.event.fatal, false, 'an adapter crash is recoverable, not fatal');
    assert.match(errored.event.message, /SIGKILL/, 'the message names the signal');
    const status = await col.event((e) => e.seq > errored.seq && e.event.type === 'session.status' && e.event.status === 'error', "session.status 'error'", 10_000);
    assert.ok(status.event.type === 'session.status');
    assert.ok(status.event.detail && status.event.detail.length > 0, 'the status carries a human-readable detail');

    await waitFor(() => !processAlive(pid) || undefined, { what: `pid ${pid} to be reaped`, timeoutMs: 10_000 });
    const summary = await sessionSummary(base, token, sessionId);
    assert.equal(summary.status, 'error');
    assert.equal(summary.pendingPermissions, 0);
    await col.until(() => (col.sessionLists.some((l) => l.some((s) => s.id === sessionId && s.status === 'error')) ? true : undefined), "sessions.changed with status 'error'", 10_000);
    const h = await health();
    const agent = h.agents.find((a) => a.id === AGENT_ID);
    assert.equal(agent?.state, 'error', JSON.stringify(agent));
    assert.ok(agent?.detail && /exited/.test(agent.detail), `health explains the failure: ${agent?.detail}`);
    assert.equal(h.sessions.running, 0);
    const info = await agentInfo();
    assert.equal(info.available, false);
    assert.ok(info.reason && info.reason.length > 0, 'the agent list explains why the agent is unavailable');

    const log = await sessionEvents(base, token, sessionId);
    assertDense(log, 'log after the crash');
    assert.deepEqual(wire(log), wire(col.events), 'HTTP log == live stream after the crash');
  });

  step(`the next prompt respawns the adapter, restores the session and completes (costs ${AGENT_ID} tokens)`, { timeout: 300_000 }, async (t) => {
    const { client, col } = must(live, 'live client');
    const from = lastSeqOf(col);
    const t0 = Date.now();
    await client.prompt(sessionId, [{ type: 'text', text: PONG_PROMPT }]);
    t.diagnostic(`prompt accepted ${((Date.now() - t0) / 1000).toFixed(1)} s after sending (respawn + initialize + session restore inside)`);
    const ended = await col.event((e) => e.seq > from && e.event.type === 'turn.ended', 'turn.ended after the respawn', 200_000);
    assert.ok(ended.event.type === 'turn.ended');
    assert.equal(ended.event.stopReason, 'end_turn', errorMessages(col.events.filter((e) => e.seq > from)) || 'turn did not end normally');
    t.diagnostic(`turn finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const idle = await col.event((e) => e.seq > ended.seq && e.event.type === 'session.status' && e.event.status === 'idle', "session.status 'idle' after the turn", 15_000);

    const tail = col.events.filter((e) => e.seq > from);
    assert.equal(tail[0]?.seq, from + 1, 'seq continues densely after the crash');
    assertDense(tail, 'post-crash tail');
    const started = tail.find((e) => e.event.type === 'turn.started');
    assert.ok(started && started.event.type === 'turn.started');
    const note = tail.find((e) => e.seq < started.seq && e.event.type === 'session.status' && e.event.status === 'idle' && e.event.detail !== undefined);
    assert.ok(note && note.event.type === 'session.status', 'the recovery of the agent session is announced before the turn starts');
    assert.match(note.event.detail ?? '', /Reconnected to the agent session|Agent restarted/, 'session/load or a fresh session with a note');
    t.diagnostic(`recovery path: ${note.event.detail}`);
    assert.ok(!tail.some((e) => e.event.type === 'session.error'), `no error during the recovered turn: ${errorMessages(tail)}`);
    const text = assistantText(col, started.event.turnId);
    assert.ok(text.trim().length > 0, 'the agent answered');
    if (!/pong/i.test(text)) t.diagnostic(`model did not answer PONG literally: ${JSON.stringify(text.slice(0, 200))}`);

    const newPid = adapterPid(server());
    assert.ok(newPid, 'a new adapter process is running');
    assert.notEqual(newPid, pid, 'the adapter was respawned, not resurrected');
    assert.ok(processAlive(newPid));
    t.diagnostic(`new adapter pid ${newPid}: ${cmdlineOf(newPid)}`);
    const h = await health();
    const agent = h.agents.find((a) => a.id === AGENT_ID);
    assert.equal(agent?.state, 'ready', agent?.detail);
    assert.ok((agent?.sessions ?? 0) >= 1, 'the restored session is bound to the new process');
    assert.equal(h.sessions.running, 0);
    assert.equal((await agentInfo()).available, true);

    const summary = await sessionSummary(base, token, sessionId);
    assert.equal(summary.status, 'idle');
    assert.equal(summary.lastSeq, idle.seq);
    assert.equal(typeof summary.lastMessagePreview, 'string');
    await col.until(() => (col.sessionLists.some((l) => l.some((s) => s.id === sessionId && s.status === 'idle' && s.lastSeq >= idle.seq)) ? true : undefined), 'sessions.changed reflecting the idle session', 10_000);
    const log = await sessionEvents(base, token, sessionId);
    assert.deepEqual(wire(log), wire(col.events), 'HTTP log == live stream across crash and recovery');
  });
});
