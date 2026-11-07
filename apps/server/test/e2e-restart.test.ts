/**
 * Durability proof (b): the daemon restarts and nothing is lost.
 *
 *   1. daemon #1: pair, create session A, run one tiny turn; snapshot A's log and summary
 *   2. create session B and forge the leftovers of a hard crash mid-turn (a `running` turn intent, a
 *      `pending` permission) straight in SQLite — the graceful path closes turns itself, only a kill
 *      leaves this state behind, and forging it costs no tokens
 *   3. stop daemon #1; the phone's MideClient stays up and starts reconnecting on its own
 *   4. daemon #2 on the same home AND port: the old device token still authenticates; sessions,
 *      summaries and logs are byte-identical; boot() closes out B (permission cancelled by 'server',
 *      turn ended with 'error', status idle 'Daemon restarted'); the client's automatic resume replays
 *      nothing new; a fresh subscribe replays A verbatim; a second tiny turn on A restores the agent
 *      session (session/load, or a fresh one with an explicit note) and continues `seq` densely
 *
 * Costs real tokens: two tiny prompts. Gates: MIDE_SKIP_AGENT_TESTS=1, MIDE_TEST_AGENT=<id>, MIDE_E2E_VERBOSE=1.
 */
import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { API, applyEnvelopes, createTimeline, SessionSummary, type EventEnvelope, type PermissionRequest, type TimelineEvent } from '@mobile-ide/core';
import { z } from 'zod';
import { newId } from '../src/auth.js';
import type { RunningServer } from '../src/context.js';
import { api, makeTmpRepo, pickFreePort, rmrf, sleep, tmpDir, wire } from './helpers.js';
import {
  AGENT_ID,
  agentSkipReason,
  assertDense,
  baseUrl,
  bootDaemon,
  captureDaemonLog,
  createSession,
  errorMessages,
  lastSeqOf,
  must,
  openClient,
  pairDevice,
  pendingPermissions,
  PONG_PROMPT,
  sessionEvents,
  sessionSummary,
  stepFactory,
  subscribeFromStart,
  type LiveClient,
} from './durability-helpers.js';

const SERVER_NAME = 'mide-restart';
const SKIP = agentSkipReason();
const daemonLog = captureDaemonLog();
const step = stepFactory(daemonLog);

// ------------------------------------------------------------------ shared state (steps run in order)
let running: RunningServer | undefined;
let base = '';
let home: string | undefined;
let repo = '';
let port = 0;
let token = '';
let sessionA = '';
let sessionB = '';
/** the phone: connected to daemon #1, kept alive across the restart */
let live1: LiveClient | undefined;
/** a second client that subscribes from scratch against daemon #2 */
let live2: LiveClient | undefined;
let logA1: EventEnvelope[] = [];
let summaryA1: SessionSummary | undefined;
let logB1: EventEnvelope[] = [];
let forged: { turnId: string; permissionId: string } | undefined;

function server(): RunningServer {
  return must(running, 'daemon');
}

/** Rebind the same port: retried briefly in case the kernel still holds it right after close(). */
async function bootSamePort(): Promise<RunningServer> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await bootDaemon({ home: must(home, 'home'), repo, port, serverName: SERVER_NAME });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 20) throw err;
      await sleep(250);
    }
  }
}

describe('durability: daemon restart', { skip: SKIP }, () => {
  before(
    async () => {
      if (SKIP) return;
      home = tmpDir('mide-restart-home-');
      repo = makeTmpRepo();
      port = await pickFreePort();
      running = await bootDaemon({ home, repo, port, serverName: SERVER_NAME });
      base = baseUrl(running);
      ({ token } = await pairDevice(running, 'restart tester'));
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      live1?.client.close();
      live2?.client.close();
      if (running) {
        await running.close({ drainMs: 5_000, cancelTurns: true });
        running = undefined;
      }
      rmrf(home);
      rmrf(repo);
    },
    { timeout: 60_000 },
  );

  step(`daemon #1: session A runs one turn; its log and summary are snapshotted (costs ${AGENT_ID} tokens)`, { timeout: 300_000 }, async (t) => {
    const s = await createSession(base, token, { agent: AGENT_ID, cwd: repo, title: 'restart proof A' }, t);
    sessionA = s.id;
    live1 = await openClient(base, token, 'mide-restart-phone');
    live1.client.watchSessionList();
    await subscribeFromStart(live1, sessionA);
    const { client, col } = live1;
    const from = lastSeqOf(col);
    const t0 = Date.now();
    await client.prompt(sessionA, [{ type: 'text', text: PONG_PROMPT }]);
    const ended = await col.event((e) => e.seq > from && e.event.type === 'turn.ended', 'turn.ended', 200_000);
    assert.ok(ended.event.type === 'turn.ended');
    assert.equal(ended.event.stopReason, 'end_turn', errorMessages(col.events) || 'turn did not end normally');
    t.diagnostic(`turn finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const idle = await col.event((e) => e.seq > ended.seq && e.event.type === 'session.status' && e.event.status === 'idle', "session.status 'idle'", 15_000);
    await col.until(
      () => (col.sessionLists.some((l) => l.some((x) => x.id === sessionA && x.status === 'idle' && x.lastSeq >= idle.seq)) ? true : undefined),
      'sessions.changed reflecting the idle session',
      10_000,
    );
    assert.ok(col.events.some((e) => e.event.type === 'message.delta'), 'the agent answered');

    logA1 = await sessionEvents(base, token, sessionA);
    assertDense(logA1, 'log A');
    assert.equal(logA1[0]?.seq, 0);
    assert.equal(logA1[logA1.length - 1]?.seq, idle.seq);
    assert.deepEqual(wire(logA1), wire(col.events), 'live stream == persisted log before the restart');
    summaryA1 = await sessionSummary(base, token, sessionA);
    assert.equal(summaryA1.status, 'idle');
    assert.equal(summaryA1.lastSeq, idle.seq);
    assert.equal(typeof summaryA1.lastMessagePreview, 'string', 'the finished turn leaves a preview');
  });

  step('daemon #1: session B is left the way a hard crash leaves it (running turn intent + pending permission)', { timeout: 150_000 }, async (t) => {
    const s = await createSession(base, token, { agent: AGENT_ID, cwd: repo, title: 'restart proof B' }, t);
    sessionB = s.id;
    const db = server().ctx.db;
    const turnId = newId();
    const permissionId = newId();
    // What the log looks like when the process dies between `permission.requested` and the phone's answer.
    db.insertTurnIntent(sessionB, 'simulated in-flight turn', turnId);
    db.appendEvent(sessionB, { type: 'turn.started', turnId, blocks: [{ type: 'text', text: 'simulated in-flight turn' }] });
    db.appendEvent(sessionB, { type: 'session.status', status: 'running' });
    const request: PermissionRequest = {
      permissionId,
      sessionId: sessionB,
      turnId,
      toolCallId: 'forged-call',
      title: 'Run a command',
      kind: 'execute',
      rawInput: { command: 'echo interrupted' },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
      createdAt: Date.now(),
    };
    db.insertPermission(request);
    db.appendEvent(sessionB, { type: 'permission.requested', request });
    db.appendEvent(sessionB, { type: 'session.status', status: 'needs_you' });
    db.updateSession(sessionB, { status: 'needs_you' });
    forged = { turnId, permissionId };

    assert.equal(db.runningTurnIntents().length, 1);
    assert.equal(db.pendingPermissions(sessionB).length, 1);
    assert.equal((await sessionSummary(base, token, sessionB)).status, 'needs_you');
    assert.equal((await pendingPermissions(base, token)).length, 1);
    logB1 = await sessionEvents(base, token, sessionB);
    assertDense(logB1, 'log B');
  });

  step('daemon #1 stops; daemon #2 boots on the same home and port', { timeout: 120_000 }, async (t) => {
    const phone = must(live1, 'phone client');
    const t0 = Date.now();
    await server().close({ drainMs: 5_000, cancelTurns: true });
    running = undefined;
    t.diagnostic(`daemon #1 closed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await phone.col.until(() => (phone.col.states.some((s) => s.state === 'reconnecting') ? true : undefined), 'the phone client noticed the drop and is reconnecting', 10_000);
    const t1 = Date.now();
    running = await bootSamePort();
    t.diagnostic(`daemon #2 listening in ${((Date.now() - t1) / 1000).toFixed(1)} s on the same port ${running.port}`);
    assert.equal(running.port, port);
    assert.equal(baseUrl(running), base);
  });

  step('daemon #2: the old token works; sessions, summaries and logs are intact; the crash leftovers on B are closed out', {}, async () => {
    const list = await api(base, 'GET', API.sessions, { token });
    assert.equal(list.status, 200, `the device paired before the restart still authenticates: ${list.status} ${list.text}`);
    const sessions = z.array(SessionSummary).parse(list.body);
    assert.ok(sessions.some((s) => s.id === sessionA), 'session A is listed');
    assert.ok(sessions.some((s) => s.id === sessionB), 'session B is listed');

    // A was idle: nothing about it may change
    const a2 = await sessionSummary(base, token, sessionA);
    assert.deepEqual(wire(a2), wire(must(summaryA1, 'summary A')), 'session A summary is identical after the restart');
    const logA2 = await sessionEvents(base, token, sessionA);
    assert.deepEqual(wire(logA2), wire(logA1), 'session A log is identical after the restart');

    // B: boot() resolved the stale permission, closed the interrupted turn, reset the status
    const { turnId, permissionId } = must(forged, 'forged state');
    const b2 = await sessionSummary(base, token, sessionB);
    assert.equal(b2.status, 'idle');
    assert.equal(b2.pendingPermissions, 0);
    const logB2 = await sessionEvents(base, token, sessionB);
    assertDense(logB2, 'log B after restart');
    assert.deepEqual(wire(logB2.slice(0, logB1.length)), wire(logB1), 'B keeps its pre-crash log verbatim');
    const added: TimelineEvent[] = logB2.slice(logB1.length).map((e) => e.event);
    assert.deepEqual(
      wire(added),
      wire([
        { type: 'permission.resolved', permissionId, outcome: 'cancelled', by: 'server' },
        { type: 'session.error', message: 'Turn interrupted by daemon restart', code: 'interrupted', fatal: false },
        { type: 'turn.ended', turnId, stopReason: 'error' },
        { type: 'session.status', status: 'idle', detail: 'Daemon restarted' },
      ] satisfies TimelineEvent[]),
      'boot() appends exactly the close-out events, permission first so no client ever sees a turn end with an open request',
    );
    const db = server().ctx.db;
    const perm = db.getPermission(permissionId);
    assert.equal(perm?.status, 'cancelled');
    assert.equal(perm?.resolvedBy, 'server');
    assert.ok(perm?.resolvedAt);
    assert.equal(db.runningTurnIntents().length, 0, 'no turn intent is left running');
    assert.deepEqual(await pendingPermissions(base, token), [], 'no permission is pending after the restart');

    // the phone's reducer reaches the same conclusion from the log alone
    const tl = applyEnvelopes(createTimeline(sessionB), logB2);
    assert.equal(tl.status, 'idle');
    assert.deepEqual(tl.pendingPermissions, []);
    assert.equal(tl.currentTurnId, undefined);
    const permItem = tl.items.find((i) => i.kind === 'permission');
    assert.ok(permItem && permItem.kind === 'permission');
    assert.equal(permItem.resolved?.outcome, 'cancelled');
    assert.ok(tl.items.some((i) => i.kind === 'turn_end' && i.stopReason === 'error'));
  });

  step('the phone client resumes by itself (same token, nothing new replayed); a fresh subscribe replays A verbatim', { timeout: 60_000 }, async (t) => {
    const phone = must(live1, 'phone client');
    const { col } = phone;
    const t0 = Date.now();
    await col.until(() => (col.states.filter((s) => s.state === 'open').length >= 2 ? true : undefined), 'the phone client reconnected', 40_000);
    t.diagnostic(`phone reconnected ${((Date.now() - t0) / 1000).toFixed(1)} s after daemon #2 came up`);
    const replays = await col.until(
      () => {
        const r = col.replays.filter((x) => x.sessionId === sessionA);
        return r.length >= 2 ? r : undefined;
      },
      'replay.done after the automatic re-subscribe',
      15_000,
    );
    assert.equal(replays[replays.length - 1]?.lastSeq, must(summaryA1, 'summary A').lastSeq, 'the resume replay ends where the client already was');
    assert.deepEqual(wire(col.events), wire(logA1), 'nothing new arrived for A across the restart');
    await col.until(
      () => (col.sessionLists.some((l) => l.some((s) => s.id === sessionA) && l.some((s) => s.id === sessionB && s.status === 'idle')) ? true : undefined),
      'sessions.changed from daemon #2 (re-sent sessions.watch)',
      15_000,
    );

    live2 = await openClient(base, token, 'mide-restart-fresh');
    const lastSeq = await subscribeFromStart(live2, sessionA);
    assert.equal(lastSeq, must(summaryA1, 'summary A').lastSeq);
    assert.deepEqual(wire(live2.col.events), wire(logA1), 'replay from 0 against daemon #2 == the pre-restart log');
  });

  step(`a new turn on A works after the restart and continues seq densely (costs ${AGENT_ID} tokens)`, { timeout: 300_000 }, async (t) => {
    const phone = must(live1, 'phone client');
    const fresh = must(live2, 'fresh client');
    const { client, col } = phone;
    const from = must(summaryA1, 'summary A').lastSeq;
    const t0 = Date.now();
    await client.prompt(sessionA, [{ type: 'text', text: PONG_PROMPT }]);
    t.diagnostic(`prompt accepted ${((Date.now() - t0) / 1000).toFixed(1)} s after sending (adapter session restored inside)`);
    const ended = await col.event((e) => e.seq > from && e.event.type === 'turn.ended', 'turn.ended after the restart', 200_000);
    assert.ok(ended.event.type === 'turn.ended');
    assert.equal(ended.event.stopReason, 'end_turn', errorMessages(col.events.filter((e) => e.seq > from)) || 'turn did not end normally');
    t.diagnostic(`turn finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const idle = await col.event((e) => e.seq > ended.seq && e.event.type === 'session.status' && e.event.status === 'idle', "session.status 'idle' after the turn", 15_000);

    const tail = col.events.filter((e) => e.seq > from);
    assert.equal(tail[0]?.seq, from + 1, 'seq continues right after the pre-restart lastSeq');
    assertDense(tail, 'post-restart tail');
    const started = tail.find((e) => e.event.type === 'turn.started');
    assert.ok(started && started.event.type === 'turn.started');
    const turnId = started.event.turnId;
    const note = tail.find((e) => e.seq < started.seq && e.event.type === 'session.status' && e.event.detail !== undefined);
    assert.ok(note && note.event.type === 'session.status', 'the recovery of the agent session is announced before the turn starts');
    assert.match(note.event.detail ?? '', /Reconnected to the agent session|Agent restarted/, 'session/load or a fresh session with a note');
    t.diagnostic(`recovery path: ${note.event.detail}`);
    assert.ok(tail.some((e) => e.event.type === 'message.delta' && e.event.turnId === turnId), 'the agent answered');

    const httpTail = await sessionEvents(base, token, sessionA, from);
    assert.deepEqual(wire(httpTail), wire(tail), 'HTTP log tail == the live tail the resumed client received');
    const a3 = await sessionSummary(base, token, sessionA);
    assert.equal(a3.status, 'idle');
    assert.equal(a3.lastSeq, idle.seq);
    await fresh.col.until(() => (fresh.col.events.some((e) => e.seq === idle.seq) ? true : undefined), 'the fresh client received the live tail too', 10_000);
    assert.deepEqual(wire(fresh.col.events), wire([...logA1, ...tail]), 'fresh client: replay from 0 + live tail == the whole log');
  });
});
