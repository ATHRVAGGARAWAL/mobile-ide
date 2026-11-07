/**
 * Elicitation round-trip with a REAL Claude Code turn.
 *
 * claude-agent-acp only enables Claude Code's AskUserQuestion tool when the client advertises
 * `clientCapabilities.elicitation.form`; it then renders the tool's questions as an ACP `elicitation/create`
 * (form mode, titled `oneOf` options, one optional free-text "Other" field per question). The daemon must persist
 * that as an `elicitation.requested` event carrying an enum schema, park the turn (status `needs_you`, push
 * notification, pending count in the session summary) until the phone answers over /ws with `elicitation.respond`,
 * validate the answer against the schema, hand it to the agent, and let the turn end with the answer reflected.
 *
 * Costs real tokens: ONE tiny prompt. Gates:
 *   MIDE_SKIP_AGENT_TESTS=1   skip everything
 *   `claude` and `npx` on PATH — otherwise the suite skips and says why
 *   MIDE_E2E_VERBOSE=1        stream daemon logs to stderr (otherwise only the tail on failure)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, type TestContext } from 'node:test';
import { API, applyEnvelopes, createTimeline, ElicitationRequest, type ElicitationEnumOption, type EventEnvelope } from '@mobile-ide/core';
import { defaultAgents } from '../src/config.js';
import type { RunningServer } from '../src/context.js';
import { api, Collector, makeTmpRepo, pickFreePort, rmrf, tmpDir, waitFor, which, wire } from './helpers.js';
import {
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
  sessionEvents,
  sessionSummary,
  stepFactory,
  subscribeFromStart,
  type LiveClient,
} from './durability-helpers.js';

const AGENT_ID = 'claude';
const PROMPT = 'Use your AskUserQuestion tool to ask me whether I prefer red or blue, then reply with my answer.';
const ANSWER = /blue/i;
/** how many follow-up questions/permissions one turn may raise before the test cancels it (token guard) */
const MAX_EXTRA_REQUESTS = 3;
const NTFY_TOPIC = 'mide-elicit';

function skipReason(): string | undefined {
  if (process.env.MIDE_SKIP_AGENT_TESTS === '1') return 'MIDE_SKIP_AGENT_TESTS=1';
  const cfg = defaultAgents()[AGENT_ID];
  if (!cfg) return `'${AGENT_ID}' is not a built-in agent`;
  if (!which('claude')) return "'claude' is not on PATH — install Claude Code, or set MIDE_SKIP_AGENT_TESTS=1 to silence this";
  if (!which(cfg.command)) return `'${cfg.command}' (needed to launch ${cfg.name}'s adapter) is not on PATH`;
  return undefined;
}

const SKIP = skipReason();
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

/** The next event after `afterSeq` that needs the phone or ends the turn. */
function nextRequestOrEnd(col: Collector, afterSeq: number, timeoutMs: number): Promise<EventEnvelope> {
  return col.event(
    (e) =>
      e.seq > afterSeq &&
      (e.event.type === 'elicitation.requested' || e.event.type === 'permission.requested' || e.event.type === 'turn.ended'),
    `elicitation.requested, permission.requested or turn.ended after seq ${afterSeq}`,
    timeoutMs,
  );
}

/** The first select field whose options include the wanted answer. */
function findChoice(req: ElicitationRequest, wanted: RegExp): { field: string; option: ElicitationEnumOption } | null {
  for (const [field, prop] of Object.entries(req.schema?.properties ?? {})) {
    const options = prop.type === 'string' ? prop.options ?? [] : prop.type === 'array' ? prop.options : [];
    const option = options.find((o) => wanted.test(o.value) || wanted.test(o.title));
    if (option) return { field, option };
  }
  return null;
}

/**
 * Answer whatever else the turn asks for until it ends: further questions are skipped (`decline`), permission
 * requests rejected, and the turn is cancelled if the agent keeps asking (never burn tokens in a loop).
 */
async function settleTurn(liveClient: LiveClient, afterSeq: number, t: TestContext): Promise<EventEnvelope> {
  let cursor = afterSeq;
  let extra = 0;
  for (;;) {
    const next = await nextRequestOrEnd(liveClient.col, cursor, 240_000);
    if (next.event.type === 'turn.ended') return next;
    extra++;
    if (extra > MAX_EXTRA_REQUESTS) {
      await liveClient.client.cancel(sessionId).catch(() => undefined);
      assert.fail(`the agent asked ${extra} more times (${next.event.type}); cancelled the turn`);
    }
    if (next.event.type === 'elicitation.requested') {
      t.diagnostic(`follow-up question ${JSON.stringify(next.event.request.message)} -> decline`);
      await liveClient.client.respondElicitation(sessionId, next.event.request.elicitationId, 'decline');
    } else if (next.event.type === 'permission.requested') {
      const req = next.event.request;
      const choice = req.options.find((o) => o.kind === 'reject_once') ?? req.options[0];
      assert.ok(choice, 'a permission request always offers at least one option');
      t.diagnostic(`follow-up permission request "${req.title}" -> ${choice.optionId}`);
      await liveClient.client.respondPermission(sessionId, req.permissionId, 'selected', choice.optionId);
    }
    cursor = next.seq;
  }
}

describe('elicitation: Claude Code AskUserQuestion reaches the phone and its answer ends the turn', { skip: SKIP }, () => {
  before(
    async () => {
      if (SKIP) return;
      home = tmpDir('mide-elicit-home-');
      repo = makeTmpRepo();
      running = await bootDaemon({ home, repo, port: await pickFreePort(), serverName: 'mide-elicit', agentId: AGENT_ID });
      base = baseUrl(running);
      ({ token, deviceId } = await pairDevice(running, 'elicitation tester'));
      // a fake ntfy server: proves the phone would be woken up for the question
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

  step('the daemon advertises both elicitation modes and a Claude session opens in the temp repo', { timeout: 200_000 }, async (t) => {
    const s = await createSession(base, token, { agent: AGENT_ID, cwd: repo, title: 'elicitation proof' }, t);
    sessionId = s.id;
    assert.equal(s.pendingPermissions, 0);
    assert.equal(s.pendingElicitations, undefined, 'no pendingElicitations field while nothing is pending');
    live = await openClient(base, token, 'mide-elicit');
    live.client.watchSessionList();
    const lastSeq = await subscribeFromStart(live, sessionId);
    assert.ok(lastSeq >= 1, `session.created + session.status replayed (lastSeq ${lastSeq})`);
    const reg = await api(base, 'POST', API.pushRegister, { token, body: { kind: 'ntfy', server: stubUrl, topic: NTFY_TOPIC } });
    assert.ok(reg.status >= 200 && reg.status < 300, `push/register: ${reg.status} ${reg.text}`);
    // the capability is what makes claude-agent-acp enable AskUserQuestion at all
    const host = server().ctx.sessions.hosts.get(AGENT_ID);
    const proc = (host as unknown as { proc?: { initResult?: unknown } | null } | undefined)?.proc;
    assert.ok(proc?.initResult, 'the adapter answered initialize');
    t.diagnostic(`agent: ${JSON.stringify((proc.initResult as { agentInfo?: unknown }).agentInfo)}`);
  });

  step(`AskUserQuestion → elicitation.requested with an enum schema; the phone's "blue" ends the turn (costs ${AGENT_ID} tokens)`, { timeout: 480_000 }, async (t) => {
    const { client, col } = must(live, 'live client');
    const from = lastSeqOf(col);
    const t0 = Date.now();
    await client.prompt(sessionId, [{ type: 'text', text: PROMPT }]);
    const started = await col.event((e) => e.seq > from && e.event.type === 'turn.started', 'turn.started', 30_000);
    assert.ok(started.event.type === 'turn.started');
    const turnId = started.event.turnId;

    // ---- the agent must ask, through elicitation/create, with the two colours as options
    const asked = await nextRequestOrEnd(col, started.seq, 240_000);
    if (asked.event.type !== 'elicitation.requested') {
      const types = col.events.filter((e) => e.seq > started.seq).map((e) => e.event.type);
      const reason = asked.event.type === 'turn.ended' ? asked.event.stopReason : asked.event.type === 'permission.requested' ? `permission ${JSON.stringify(asked.event.request.title)}` : asked.event.type;
      assert.fail(`the turn produced ${reason} instead of an elicitation. Events: ${types.join(',')}. Assistant: ${JSON.stringify(assistantText(col, turnId).slice(0, 300))}`);
    }
    const req = ElicitationRequest.parse(asked.event.request);
    t.diagnostic(
      `elicitation after ${((Date.now() - t0) / 1000).toFixed(1)} s: mode=${req.mode} message=${JSON.stringify(req.message)} toolCallId=${req.toolCallId ?? '-'} schema=${JSON.stringify(req.schema)}`,
    );
    assert.equal(req.sessionId, sessionId);
    assert.equal(req.turnId, turnId, 'the question belongs to the running turn');
    assert.equal(req.mode, 'form');
    assert.ok(req.message.trim().length > 0, 'the question text is carried verbatim');
    assert.ok(req.createdAt >= t0 && req.createdAt <= Date.now(), 'createdAt is epoch ms of the request');
    assert.ok(req.schema && Object.keys(req.schema.properties).length > 0, 'a form schema with fields');
    const choice = findChoice(req, ANSWER);
    assert.ok(choice, `a select field offers "blue": ${JSON.stringify(req.schema)}`);
    const red = findChoice(req, /red/i);
    assert.ok(red && red.field === choice.field, 'red and blue are options of the same field');
    const field = req.schema.properties[choice.field];
    assert.ok(field && (field.type === 'string' || field.type === 'array'), 'the colour field is an enum (string with options) or a multi-select');
    if (req.toolCallId) {
      const toolCall = col.events.find((e) => e.event.type === 'tool.call' && e.event.toolCallId === req.toolCallId);
      t.diagnostic(toolCall ? `tool.call ${JSON.stringify(toolCall.event.type === 'tool.call' ? toolCall.event.title : '')} surfaced before the question` : 'no tool.call for the toolCallId yet');
    }

    // ---- parked: needs_you everywhere it can be observed, and the phone is notified
    await col.event((e) => e.seq > asked.seq && e.event.type === 'session.status' && e.event.status === 'needs_you', "session.status 'needs_you' after the question", 10_000);
    const parked = await sessionSummary(base, token, sessionId);
    assert.equal(parked.status, 'needs_you');
    assert.equal(parked.pendingPermissions, 1, 'the question counts as one pending item (the inbox badge)');
    assert.equal(parked.pendingElicitations, 1);
    await col.until(
      () => (col.sessionLists.some((l) => l.some((s) => s.id === sessionId && s.status === 'needs_you' && s.pendingPermissions === 1 && s.pendingElicitations === 1)) ? true : undefined),
      "sessions.changed with status 'needs_you' and the pending question",
      10_000,
    );
    const pendingRow = server().ctx.db.getElicitation(req.elicitationId);
    assert.equal(pendingRow?.status, 'pending');
    assert.equal(pendingRow?.turnId, turnId);
    assert.equal(pendingRow?.mode, 'form');
    assert.deepEqual(server().ctx.db.pendingElicitations(sessionId).map((e) => e.id), [req.elicitationId]);
    const push = await waitFor(() => pushes.find((p) => /asks you/i.test(p.title)), { what: 'ntfy push for the question', timeoutMs: 10_000 });
    assert.ok(push.body.includes(req.message.slice(0, 40)), `the push carries the question: ${JSON.stringify(push.body)}`);

    // ---- bad answers are refused without consuming the request
    await assert.rejects(client.respondElicitation(sessionId, req.elicitationId, 'accept', { [choice.field]: 'chartreuse' }), /option/i, 'a value outside the offered options is rejected');
    await assert.rejects(client.respondElicitation(sessionId, req.elicitationId, 'accept', { [choice.field]: choice.option.value, bogus: 'x' }), /not a field/i, 'an unknown field is rejected');
    await assert.rejects(client.respondElicitation(sessionId, 'no-such-elicitation', 'accept', {}), /not found/i);
    await assert.rejects(client.respondElicitation(sessionId, req.elicitationId, 'accept', { [choice.field]: 42 }), /text|option/i, 'a value of the wrong type is rejected');
    assert.equal(server().ctx.db.getElicitation(req.elicitationId)?.status, 'pending', 'still pending after the refused answers');

    // ---- the real answer
    const content = { [choice.field]: field?.type === 'array' ? [choice.option.value] : choice.option.value };
    await client.respondElicitation(sessionId, req.elicitationId, 'accept', content);
    const resolved = await col.event((e) => e.event.type === 'elicitation.resolved' && e.event.elicitationId === req.elicitationId, 'elicitation.resolved', 10_000);
    assert.ok(resolved.event.type === 'elicitation.resolved');
    assert.equal(resolved.event.action, 'accept');
    assert.deepEqual(resolved.event.content, content);
    assert.equal(resolved.event.by, deviceId, 'the answering device is recorded');
    const row = server().ctx.db.getElicitation(req.elicitationId);
    assert.equal(row?.status, 'accept');
    assert.deepEqual(row?.content, content);
    assert.equal(row?.resolvedBy, deviceId);
    assert.ok(row?.resolvedAt && row.resolvedAt >= row.createdAt, 'resolvedAt is set');
    await col.event((e) => e.seq > resolved.seq && e.event.type === 'session.status' && e.event.status === 'running', "session.status back to 'running' after the answer", 10_000);

    // ---- the turn resumes and the reply reflects the answer
    const ended = await settleTurn(must(live, 'live client'), resolved.seq, t);
    assert.ok(ended.event.type === 'turn.ended');
    assert.equal(ended.event.turnId, turnId);
    assert.equal(ended.event.stopReason, 'end_turn', errorMessages(col.events) || 'turn did not end normally');
    t.diagnostic(`turn finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const text = assistantText(col, turnId);
    t.diagnostic(`assistant: ${JSON.stringify(text.slice(0, 300))}`);
    assert.ok(ANSWER.test(text), `the reply reflects the answer "blue": ${JSON.stringify(text.slice(0, 300))}`);
    assert.ok(!col.events.some((e) => e.event.type === 'session.error' && e.seq > started.seq), `no session.error during the turn: ${errorMessages(col.events)}`);

    const idle = await col.event((e) => e.seq > ended.seq && e.event.type === 'session.status' && e.event.status === 'idle', "session.status 'idle' after the turn", 15_000);
    const summary = await sessionSummary(base, token, sessionId);
    assert.equal(summary.status, 'idle');
    assert.equal(summary.pendingPermissions, 0);
    assert.equal(summary.pendingElicitations, undefined);
    assert.equal(summary.lastSeq, idle.seq);
    assert.equal(server().ctx.db.pendingElicitations().length, 0, 'no pending elicitation rows remain');
    await assert.rejects(client.respondElicitation(sessionId, req.elicitationId, 'decline'), /already/i, 'an answered question cannot be answered twice');

    // ---- the persisted log is exactly what streamed live, and core's reducer renders it
    const log = await sessionEvents(base, token, sessionId);
    assertDense(log, 'persisted log');
    assert.deepEqual(wire(log), wire(col.events), 'HTTP log == live stream (replay from 0 + live events)');
    const tl = applyEnvelopes(createTimeline(sessionId), log);
    const item = tl.items[tl.elicitationIndex[req.elicitationId] ?? -1];
    assert.ok(item && item.kind === 'elicitation', 'the reducer renders the question as an elicitation item');
    assert.deepEqual(item.resolved, { action: 'accept', content });
    assert.deepEqual(tl.pendingElicitations, []);
    assert.equal(tl.status, 'idle');
    assertDense(col.events, 'live stream');
  });
});
