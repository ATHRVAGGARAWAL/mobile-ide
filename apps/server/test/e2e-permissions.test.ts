/**
 * Durability proof (a): permission round-trip against a REAL agent in a restrictive permission mode.
 *
 * OpenCode is launched with OPENCODE_CONFIG_CONTENT — a final local-scope config merge, so it wins over
 * the user's global `"permission": "allow"` — requiring approval for shell and edit tools. The daemon
 * must surface the agent's `session/request_permission` as a persisted `permission.requested` event
 * carrying the literal command in `rawInput`, park the turn (status `needs_you`, push notification,
 * `/api/permissions/pending`) until the phone answers over /ws, and then resume it. Both answers are
 * proven: allow once (the command runs, the turn completes) and reject once (the command never runs,
 * the turn still completes). Every permission row ends up resolved in SQLite with who answered.
 *
 * Costs real tokens: two tiny prompts. Gates:
 *   MIDE_SKIP_AGENT_TESTS=1   skip everything
 *   MIDE_TEST_AGENT=<id>      the permission-config injection is OpenCode-specific; other agents skip
 *   MIDE_E2E_VERBOSE=1        stream daemon logs to stderr (otherwise only the tail on failure)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, type TestContext } from 'node:test';
import { API, PermissionRequest, type EventEnvelope, type PermissionOption } from '@mobile-ide/core';
import type { RunningServer } from '../src/context.js';
import { api, Collector, makeTmpRepo, pickFreePort, rmrf, tmpDir, waitFor, wire } from './helpers.js';
import {
  AGENT_ID,
  agentSkipReason,
  assertDense,
  assistantText,
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
  sessionEvents,
  sessionSummary,
  stepFactory,
  subscribeFromStart,
  type LiveClient,
} from './durability-helpers.js';

/** OpenCode 1.18 `permission` config: per-tool 'ask' | 'allow' | 'deny' (https://opencode.ai/config.json). */
const OPENCODE_PERMISSIONS = { $schema: 'https://opencode.ai/config.json', permission: { bash: 'ask', edit: 'ask' } };
const ALLOW_COMMAND = 'echo hi';
const REJECT_COMMAND = 'echo bye';
const ALLOW_PROMPT = `Run the shell command \`${ALLOW_COMMAND}\` and tell me its output.`;
const REJECT_PROMPT = `Run the shell command \`${REJECT_COMMAND}\` and tell me its output. If you are not permitted to run it, say so and stop.`;
/** how many follow-up permission requests one turn may make before the test cancels it (token guard) */
const MAX_EXTRA_REQUESTS = 3;
const NTFY_TOPIC = 'mide-perm';

const SKIP = agentSkipReason() ?? (AGENT_ID === 'opencode' ? undefined : `permission-config injection is OpenCode-specific (MIDE_TEST_AGENT=${AGENT_ID})`);
const daemonLog = captureDaemonLog();
const step = stepFactory(daemonLog);

// ------------------------------------------------------------------ shared state (steps run in order)
let running: RunningServer | undefined;
let base = '';
let home: string | undefined;
let repo = '';
let token = '';
let deviceId = '';
let sessionId = '';
let live: LiveClient | undefined;
let stub: http.Server | undefined;
let stubUrl = '';
const pushes: { title: string; body: string }[] = [];

function server(): RunningServer {
  return must(running, 'daemon');
}

/** Everything the permission sheet shows about a request, for substring checks. */
function requestText(req: PermissionRequest): string {
  return `${req.title}\n${JSON.stringify(req.rawInput ?? null)}`;
}

function option(req: PermissionRequest, kind: PermissionOption['kind']): PermissionOption {
  const o = req.options.find((x) => x.kind === kind);
  assert.ok(o, `the agent offers a ${kind} option: ${JSON.stringify(req.options)}`);
  return o;
}

/** The next permission request or turn end after `afterSeq`. */
function nextPermissionOrEnd(col: Collector, afterSeq: number, timeoutMs: number): Promise<EventEnvelope> {
  return col.event(
    (e) => e.seq > afterSeq && (e.event.type === 'permission.requested' || e.event.type === 'turn.ended'),
    `permission.requested or turn.ended after seq ${afterSeq}`,
    timeoutMs,
  );
}

/**
 * Answer any further permission requests until the turn ends: allow only requests naming `allowIf`,
 * reject everything else, and cancel the turn if the agent keeps asking (never burn tokens in a loop).
 */
async function settleTurn(liveClient: LiveClient, afterSeq: number, opts: { allowIf?: string; t: TestContext }): Promise<EventEnvelope> {
  let cursor = afterSeq;
  let extra = 0;
  for (;;) {
    const next = await nextPermissionOrEnd(liveClient.col, cursor, 180_000);
    if (next.event.type !== 'permission.requested') return next;
    const req = next.event.request;
    extra++;
    if (extra > MAX_EXTRA_REQUESTS) {
      await liveClient.client.cancel(sessionId).catch(() => undefined);
      assert.fail(`the agent asked for permission ${extra} more times (${requestText(req)}); cancelled the turn`);
    }
    const allowed = opts.allowIf !== undefined && requestText(req).includes(opts.allowIf) ? req.options.find((o) => o.kind === 'allow_once') : undefined;
    const choice = allowed ?? req.options.find((o) => o.kind === 'reject_once') ?? req.options[0];
    assert.ok(choice, 'a permission request always offers at least one option');
    opts.t.diagnostic(`follow-up permission request "${req.title}" ${JSON.stringify(req.rawInput)} -> ${choice.optionId}`);
    await liveClient.client.respondPermission(sessionId, req.permissionId, 'selected', choice.optionId);
    cursor = next.seq;
  }
}

/** Final status of a tool call as seen on the wire (tool.call, then tool.update overrides). */
function toolStatus(col: Collector, toolCallId: string): string | undefined {
  let status: string | undefined;
  for (const e of col.events) {
    if ((e.event.type === 'tool.call' || e.event.type === 'tool.update') && e.event.toolCallId === toolCallId && e.event.status) status = e.event.status;
  }
  return status;
}

describe('durability: permission round-trip with a real agent', { skip: SKIP }, () => {
  before(
    async () => {
      if (SKIP) return;
      home = tmpDir('mide-perm-home-');
      repo = makeTmpRepo();
      running = await bootDaemon({
        home,
        repo,
        port: await pickFreePort(),
        serverName: 'mide-perm',
        agentEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_PERMISSIONS) },
      });
      base = baseUrl(running);
      ({ token, deviceId } = await pairDevice(running, 'permission tester'));
      // a fake ntfy server: proves the phone would be woken up for the permission
      stub = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => {
          body += c.toString('utf8');
        });
        req.on('end', () => {
          const title = req.headers.title;
          pushes.push({ title: typeof title === 'string' ? title : '', body });
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        });
      });
      await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', resolve));
      stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
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
      if (stub) await new Promise<void>((resolve) => stub!.close(() => resolve()));
      rmrf(home);
      rmrf(repo);
    },
    { timeout: 60_000 },
  );

  step('a session in the temp repo, a live /ws subscription and an ntfy channel', { timeout: 150_000 }, async (t) => {
    const s = await createSession(base, token, { agent: AGENT_ID, cwd: repo, title: 'permission proof' }, t);
    sessionId = s.id;
    assert.equal(s.pendingPermissions, 0);
    live = await openClient(base, token, 'mide-perm');
    live.client.watchSessionList();
    const lastSeq = await subscribeFromStart(live, sessionId);
    assert.ok(lastSeq >= 1, `session.created + session.status replayed (lastSeq ${lastSeq})`);
    assert.deepEqual(await pendingPermissions(base, token), []);
    const reg = await api(base, 'POST', API.pushRegister, { token, body: { kind: 'ntfy', server: stubUrl, topic: NTFY_TOPIC } });
    assert.ok(reg.status >= 200 && reg.status < 300, `push/register: ${reg.status} ${reg.text}`);
  });

  step(`allow_once: the agent asks before \`${ALLOW_COMMAND}\`; the phone's answer resumes the turn (costs ${AGENT_ID} tokens)`, { timeout: 300_000 }, async (t) => {
    const { client, col } = must(live, 'live client');
    const from = lastSeqOf(col);
    const t0 = Date.now();
    await client.prompt(sessionId, [{ type: 'text', text: ALLOW_PROMPT }]);
    const started = await col.event((e) => e.seq > from && e.event.type === 'turn.started', 'turn.started', 30_000);
    assert.ok(started.event.type === 'turn.started');
    const turnId = started.event.turnId;

    // ---- the agent must ask, and the request must show the literal command
    const asked = await nextPermissionOrEnd(col, started.seq, 180_000);
    if (asked.event.type !== 'permission.requested') {
      const types = col.events.filter((e) => e.seq > started.seq).map((e) => e.event.type);
      const reason = asked.event.type === 'turn.ended' ? asked.event.stopReason : asked.event.type;
      assert.fail(`the turn ended (${reason}) without a permission request — OPENCODE_CONFIG_CONTENT permissions were not honoured. Events: ${types.join(',')}`);
    }
    const req = PermissionRequest.parse(asked.event.request);
    t.diagnostic(
      `permission requested after ${((Date.now() - t0) / 1000).toFixed(1)} s: title=${JSON.stringify(req.title)} kind=${req.kind} rawInput=${JSON.stringify(req.rawInput)} options=${req.options.map((o) => `${o.optionId}:${o.kind}`).join(',')}`,
    );
    assert.equal(req.sessionId, sessionId);
    assert.equal(req.turnId, turnId, 'the request belongs to the running turn');
    assert.ok(req.createdAt >= t0 && req.createdAt <= Date.now(), 'createdAt is epoch ms of the request');
    assert.ok(JSON.stringify(req.rawInput ?? null).includes(ALLOW_COMMAND), `rawInput carries the literal command: ${JSON.stringify(req.rawInput)}`);
    assert.ok(req.title.length > 0);
    const allow = option(req, 'allow_once');
    const reject = option(req, 'reject_once');
    assert.notEqual(allow.optionId, reject.optionId);
    assert.ok(req.options.length >= 2 && new Set(req.options.map((o) => o.optionId)).size === req.options.length, 'option ids are unique');

    // ---- parked: needs_you everywhere it can be observed, and the phone is notified
    await col.event((e) => e.seq > asked.seq && e.event.type === 'session.status' && e.event.status === 'needs_you', "session.status 'needs_you' after the request", 10_000);
    const parked = await sessionSummary(base, token, sessionId);
    assert.equal(parked.status, 'needs_you');
    assert.equal(parked.pendingPermissions, 1);
    assert.deepEqual(wire(await pendingPermissions(base, token)), wire([req]), 'GET /api/permissions/pending lists the request verbatim');
    assert.deepEqual(wire(await pendingPermissions(base, token, sessionId)), wire([req]), '...also filtered by sessionId');
    await col.until(
      () => (col.sessionLists.some((l) => l.some((s) => s.id === sessionId && s.status === 'needs_you' && s.pendingPermissions === 1)) ? true : undefined),
      "sessions.changed with status 'needs_you' and pendingPermissions 1",
      10_000,
    );
    const pendingRow = server().ctx.db.getPermission(req.permissionId);
    assert.equal(pendingRow?.status, 'pending');
    assert.equal(pendingRow?.turnId, turnId);
    const push = await waitFor(() => pushes.find((p) => /needs you/i.test(p.title)), { what: 'ntfy push for the permission', timeoutMs: 10_000 });
    assert.ok(push.body.includes(ALLOW_COMMAND), `the push shows the literal command: ${JSON.stringify(push.body)}`);

    // ---- bad answers are refused without consuming the request
    await assert.rejects(client.respondPermission(sessionId, req.permissionId, 'selected', 'not-an-offered-option'), /option/i, 'an optionId outside the offered options is rejected');
    await assert.rejects(client.respondPermission(sessionId, 'no-such-permission', 'selected', allow.optionId), /not found/i);
    assert.equal(server().ctx.db.getPermission(req.permissionId)?.status, 'pending', 'still pending after the refused answers');

    // ---- the real answer
    await client.respondPermission(sessionId, req.permissionId, 'selected', allow.optionId);
    const resolved = await col.event((e) => e.event.type === 'permission.resolved' && e.event.permissionId === req.permissionId, 'permission.resolved', 10_000);
    assert.ok(resolved.event.type === 'permission.resolved');
    assert.equal(resolved.event.outcome, 'selected');
    assert.equal(resolved.event.optionId, allow.optionId);
    assert.equal(resolved.event.by, deviceId, 'the resolving device is recorded');
    const row = server().ctx.db.getPermission(req.permissionId);
    assert.equal(row?.status, 'selected');
    assert.equal(row?.optionId, allow.optionId);
    assert.equal(row?.resolvedBy, deviceId);
    assert.ok(row?.resolvedAt && row.resolvedAt >= row.createdAt, 'resolvedAt is set');
    await col.event((e) => e.seq > resolved.seq && e.event.type === 'session.status' && e.event.status === 'running', "session.status back to 'running' after approval", 10_000);

    // ---- the turn resumes: the command runs and the agent answers
    const ended = await settleTurn(must(live, 'live client'), resolved.seq, { allowIf: ALLOW_COMMAND, t });
    assert.ok(ended.event.type === 'turn.ended');
    assert.equal(ended.event.turnId, turnId);
    assert.equal(ended.event.stopReason, 'end_turn', errorMessages(col.events) || 'turn did not end normally');
    t.diagnostic(`allow turn finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (req.toolCallId) assert.equal(toolStatus(col, req.toolCallId), 'completed', `the approved tool call ran to completion`);
    const text = assistantText(col, turnId);
    assert.ok(text.trim().length > 0, 'the agent answered');
    if (!/\bhi\b/i.test(text)) t.diagnostic(`assistant text did not quote the output literally: ${JSON.stringify(text.slice(0, 200))}`);

    const idle = await col.event((e) => e.seq > ended.seq && e.event.type === 'session.status' && e.event.status === 'idle', "session.status 'idle' after the turn", 15_000);
    const summary = await sessionSummary(base, token, sessionId);
    assert.equal(summary.status, 'idle');
    assert.equal(summary.pendingPermissions, 0);
    assert.equal(summary.lastSeq, idle.seq);
    assert.ok(summary.lastMessagePreview && summary.lastMessagePreview.length > 0, 'the answered turn leaves a sessions-list preview');
    assert.deepEqual(await pendingPermissions(base, token), []);
    await assert.rejects(client.respondPermission(sessionId, req.permissionId, 'selected', allow.optionId), /already/i, 'a resolved permission cannot be answered twice');
    assertDense(col.events, 'live stream');
  });

  step(`reject_once: the phone refuses \`${REJECT_COMMAND}\`; the command never runs and the turn still completes (costs ${AGENT_ID} tokens)`, { timeout: 300_000 }, async (t) => {
    const { client, col } = must(live, 'live client');
    const from = lastSeqOf(col);
    const t0 = Date.now();
    await client.prompt(sessionId, [{ type: 'text', text: REJECT_PROMPT }]);
    const started = await col.event((e) => e.seq > from && e.event.type === 'turn.started', 'turn.started', 30_000);
    assert.ok(started.event.type === 'turn.started');
    const turnId = started.event.turnId;

    const asked = await nextPermissionOrEnd(col, started.seq, 180_000);
    if (asked.event.type !== 'permission.requested') {
      const reason = asked.event.type === 'turn.ended' ? asked.event.stopReason : asked.event.type;
      assert.fail(`the turn ended (${reason}) without a permission request`);
    }
    const req = PermissionRequest.parse(asked.event.request);
    t.diagnostic(`permission requested after ${((Date.now() - t0) / 1000).toFixed(1)} s: title=${JSON.stringify(req.title)} rawInput=${JSON.stringify(req.rawInput)}`);
    assert.equal(req.turnId, turnId);
    assert.ok(JSON.stringify(req.rawInput ?? null).includes(REJECT_COMMAND), `rawInput carries the literal command: ${JSON.stringify(req.rawInput)}`);
    const reject = option(req, 'reject_once');
    assert.equal((await sessionSummary(base, token, sessionId)).status, 'needs_you');

    await client.respondPermission(sessionId, req.permissionId, 'selected', reject.optionId);
    const resolved = await col.event((e) => e.event.type === 'permission.resolved' && e.event.permissionId === req.permissionId, 'permission.resolved', 10_000);
    assert.ok(resolved.event.type === 'permission.resolved');
    assert.equal(resolved.event.outcome, 'selected');
    assert.equal(resolved.event.optionId, reject.optionId);
    assert.equal(resolved.event.by, deviceId);
    const row = server().ctx.db.getPermission(req.permissionId);
    assert.equal(row?.status, 'selected');
    assert.equal(row?.optionId, reject.optionId);
    assert.equal(row?.resolvedBy, deviceId);

    const ended = await settleTurn(must(live, 'live client'), resolved.seq, { t });
    assert.ok(ended.event.type === 'turn.ended');
    assert.equal(ended.event.turnId, turnId);
    t.diagnostic(`reject turn finished in ${((Date.now() - t0) / 1000).toFixed(1)} s with stopReason ${ended.event.stopReason}`);
    assert.equal(ended.event.stopReason, 'end_turn', errorMessages(col.events) || 'a rejected permission must not error the turn');
    if (req.toolCallId) {
      assert.notEqual(toolStatus(col, req.toolCallId), 'completed', 'the rejected tool call never completed');
      t.diagnostic(`rejected tool call ended with status ${toolStatus(col, req.toolCallId) ?? 'unknown'}`);
    }
    assert.ok(!col.events.some((e) => e.event.type === 'session.error' && e.seq > started.seq), `no session.error during the rejected turn: ${errorMessages(col.events)}`);
    const text = assistantText(col, turnId);
    t.diagnostic(`assistant after rejection: ${JSON.stringify(text.slice(0, 200))}`);

    const idle = await col.event((e) => e.seq > ended.seq && e.event.type === 'session.status' && e.event.status === 'idle', "session.status 'idle' after the rejected turn", 15_000);
    const summary = await sessionSummary(base, token, sessionId);
    assert.equal(summary.status, 'idle');
    assert.equal(summary.pendingPermissions, 0);
    assert.equal(summary.lastSeq, idle.seq);
    // OpenCode ends a rejected turn without any assistant text; the sessions list must not lose its preview over it
    assert.ok(summary.lastMessagePreview && summary.lastMessagePreview.length > 0, 'a turn without assistant text keeps the previous preview');
    assert.deepEqual(await pendingPermissions(base, token), []);
    assert.equal(server().ctx.db.pendingPermissions().length, 0, 'no pending permission rows remain');
    await col.until(
      () => (col.sessionLists.some((l) => l.some((s) => s.id === sessionId && s.status === 'idle' && s.pendingPermissions === 0 && s.lastSeq >= idle.seq)) ? true : undefined),
      'sessions.changed reflecting the idle session',
      10_000,
    );

    // the persisted log is exactly what streamed live
    const log = await sessionEvents(base, token, sessionId);
    assertDense(log, 'persisted log');
    assert.deepEqual(wire(log), wire(col.events), 'HTTP log == live stream (replay from 0 + live events)');
  });
});
