/**
 * Unit tests for the round-2 review fixes that need no agent:
 *  - SessionManager title policy (agent suggestions persist + emit `session.renamed`; typed titles are locked)
 *  - boot() never ends a turn twice; shutdown() settles pending permissions before draining
 *  - Notifier dedupe: permissions always go out, a failed delivery does not start the window, Click carries the permission,
 *    overlapping notifications for one key collapse into one
 *  - ntfy server validation (incl. IPv4-mapped IPv6 link-local hosts), the static compression cache and HEAD negotiation,
 *    agent-terminal record cleanup, Db space reclaim, session-list previews
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { EventEnvelope, PermissionRequest } from '@mobile-ide/core';
import { AgentTerminals } from '../src/agents/agent-terminals.js';
import { defaultConfig, type Config, type LoadedConfig } from '../src/config.js';
import type { AuthedEnv, ServerContext } from '../src/context.js';
import { Db } from '../src/db.js';
import { EventBus } from '../src/events.js';
import { createLogger, setLogSink } from '../src/log.js';
import { Notifier } from '../src/notify.js';
import { buildPolicy } from '../src/paths.js';
import { ntfyServerProblem } from '../src/routes/push.js';
import { CompressionCache, webAppMiddleware } from '../src/routes/static.js';
import { SessionManager } from '../src/sessions.js';
import { rmrf, tmpDir } from './helpers.js';

setLogSink(() => {
  /* quiet */
});

/** A manager with no agent hosts: enough to exercise persistence, events and the title policy. */
function makeManager(home: string): { db: Db; bus: EventBus; events: EventEnvelope[]; sessions: SessionManager; config: Config } {
  const config: Config = { ...defaultConfig(), agents: {} };
  const db = new Db(`${home}/mide.db`);
  const bus = new EventBus();
  const events: EventEnvelope[] = [];
  bus.onEvent((env) => events.push(env));
  const notifier = new Notifier(db, config, { configPath: null });
  const sessions = new SessionManager(db, config, bus, notifier, buildPolicy([home], []), home);
  return { db, bus, events, sessions, config };
}

function permission(sessionId: string, id: string): PermissionRequest {
  return {
    permissionId: id,
    sessionId,
    turnId: 'turn-1',
    title: 'Run `echo hi`',
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    createdAt: Date.now(),
  };
}

describe('SessionManager title policy', () => {
  let home: string;
  before(() => {
    home = tmpDir('mide-sessions-');
  });
  after(() => rmrf(home));

  it('persists an agent-suggested title once, emits exactly one session.renamed, and never overrides a typed title', () => {
    const { db, events, sessions } = makeManager(home);
    db.createSession({ id: 's1', agent: 'x', cwd: home, title: 'repo', titleSource: 'default' });
    db.updateSession('s1', { status: 'idle' });

    sessions.patchSession('s1', { title: '  Fix the flaky auth test  ' });
    assert.equal(db.getSession('s1')?.title, 'Fix the flaky auth test');
    assert.equal(db.getSession('s1')?.titleSource, 'agent');
    const renamed = events.filter((e) => e.event.type === 'session.renamed');
    assert.equal(renamed.length, 1);
    assert.deepEqual(renamed[0]?.event, { type: 'session.renamed', title: 'Fix the flaky auth test' });

    // the same title again is a no-op
    sessions.patchSession('s1', { title: 'Fix the flaky auth test' });
    assert.equal(events.filter((e) => e.event.type === 'session.renamed').length, 1);

    // the user renames → locked against further agent suggestions
    sessions.rename('s1', 'mine');
    assert.equal(db.getSession('s1')?.titleSource, 'user');
    sessions.patchSession('s1', { title: 'Agent idea' });
    assert.equal(db.getSession('s1')?.title, 'mine');
    assert.equal(events.filter((e) => e.event.type === 'session.renamed').length, 2);

    // blank suggestions and closed sessions are ignored
    db.createSession({ id: 's2', agent: 'x', cwd: home, title: 'repo', titleSource: 'default' });
    db.updateSession('s2', { status: 'closed', closedAt: Date.now() });
    sessions.patchSession('s2', { title: 'late' });
    sessions.patchSession('s1', { title: '   ' });
    assert.equal(db.getSession('s2')?.title, 'repo');
    db.close();
  });

  it('backfills the title source of rows written before the column existed: folder names stay default, anything else is locked', () => {
    const file = `${home}/legacy.db`;
    let db = new Db(file);
    db.createSession({ id: 'a', agent: 'x', cwd: '/tmp/repo', title: 'repo' });
    db.createSession({ id: 'b', agent: 'x', cwd: '/tmp/repo', title: 'Payments refactor' });
    // simulate legacy rows: no title_source
    for (const id of ['a', 'b']) {
      (db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db.prepare('UPDATE sessions SET title_source = NULL WHERE id = ?').run(id);
    }
    db.close();
    // the next open migrates: a NULL never reaches the read-time fallback, and a pre-upgrade title cannot be taken by the agent
    db = new Db(file);
    assert.equal(db.getSession('a')?.titleSource, 'default');
    assert.equal(db.getSession('b')?.titleSource, 'user');
    const config: Config = { ...defaultConfig(), agents: {} };
    const sessions = new SessionManager(db, config, new EventBus(), new Notifier(db, config, { configPath: null }), buildPolicy([home], []), home);
    db.updateSession('b', { status: 'idle' });
    sessions.patchSession('b', { title: 'Agent idea' });
    assert.equal(db.getSession('b')?.title, 'Payments refactor', 'a title typed before the upgrade is never overwritten');
    db.close();
  });
});

describe('Db space reclaim', () => {
  let home: string;
  before(() => {
    home = tmpDir('mide-reclaim-');
  });
  after(() => rmrf(home));

  it('releases the pages a prune freed in place (incremental auto-vacuum), never a whole-file VACUUM', () => {
    const db = new Db(`${home}/reclaim.db`);
    db.createSession({ id: 'big', agent: 'x', cwd: home, title: 'big' });
    for (let i = 0; i < 400; i++) db.appendEvent('big', { type: 'message.delta', turnId: 't', text: 'x'.repeat(500) });
    db.checkpoint();
    assert.equal(db.freeBytes(), 0);
    db.deleteSessionData('big');
    assert.ok(db.freeBytes() > 0, 'deleting the log leaves free pages behind');
    const r = db.reclaimSpace();
    assert.equal(r.method, 'incremental');
    assert.ok(r.freedBytes > 0);
    assert.equal(db.freeBytes(), 0);
    assert.deepEqual(db.reclaimSpace(), { method: 'none', freedBytes: 0 }, 'nothing left to reclaim');
    db.close();
  });
});

describe('SessionManager previews', () => {
  let home: string;
  before(() => {
    home = tmpDir('mide-preview-');
  });
  after(() => rmrf(home));

  it('keeps assistant text parts apart when a tool call interrupts them, and stitches split words back together', () => {
    const { db, sessions } = makeManager(home);
    db.createSession({ id: 'pv', agent: 'x', cwd: home, title: 'repo' });
    db.appendEvent('pv', { type: 'session.created', agent: 'x', cwd: home, title: 'repo' });
    db.updateSession('pv', { status: 'running' });
    sessions.emit('pv', { type: 'turn.started', turnId: 't1', blocks: [{ type: 'text', text: 'go' }] });
    sessions.emit('pv', { type: 'message.delta', turnId: 't1', text: "I wasn't permitted to run `echo hi`, so I have no output for it." });
    sessions.emit('pv', { type: 'tool.call', turnId: 't1', toolCallId: 'c1', title: 'write', kind: 'edit', status: 'pending' });
    sessions.emit('pv', { type: 'tool.update', turnId: 't1', toolCallId: 'c1', status: 'completed' });
    sessions.emit('pv', { type: 'message.delta', turnId: 't1', text: 'Created `hello.txt`' });
    sessions.emit('pv', { type: 'message.delta', turnId: 't1', text: ' containing `hello`.' });
    sessions.emit('pv', { type: 'turn.ended', turnId: 't1', stopReason: 'end_turn' });
    assert.equal(sessions.summary('pv').lastMessagePreview, "I wasn't permitted to run `echo hi`, so I have no output for it. Created `hello.txt` containing `hello`.");
    // the next turn starts a fresh preview; deltas of one uninterrupted message are still glued together
    sessions.emit('pv', { type: 'turn.started', turnId: 't2', blocks: [{ type: 'text', text: 'again' }] });
    sessions.emit('pv', { type: 'message.delta', turnId: 't2', text: 'Hel' });
    sessions.emit('pv', { type: 'message.delta', turnId: 't2', text: 'lo' });
    sessions.emit('pv', { type: 'turn.ended', turnId: 't2', stopReason: 'end_turn' });
    assert.equal(sessions.summary('pv').lastMessagePreview, 'Hello');
    db.close();
  });
});

describe('SessionManager boot() and shutdown()', () => {
  let home: string;
  before(() => {
    home = tmpDir('mide-boot-');
  });
  after(() => rmrf(home));

  it('boot() marks an already-ended turn intent done instead of replaying a phantom interruption', () => {
    const { db, events, sessions } = makeManager(home);
    db.createSession({ id: 's', agent: 'x', cwd: home, title: 'repo' });
    db.appendEvent('s', { type: 'session.created', agent: 'x', cwd: home, title: 'repo' });
    db.updateSession('s', { status: 'idle' });
    // turn A finished but its intent update was lost; turn B was genuinely interrupted
    db.insertTurnIntent('s', 'hello', 'turn-A');
    db.appendEvent('s', { type: 'turn.started', turnId: 'turn-A', blocks: [{ type: 'text', text: 'hello' }] });
    db.appendEvent('s', { type: 'turn.ended', turnId: 'turn-A', stopReason: 'end_turn' });
    db.insertTurnIntent('s', 'again', 'turn-B');
    db.appendEvent('s', { type: 'turn.started', turnId: 'turn-B', blocks: [{ type: 'text', text: 'again' }] });
    db.updateSession('s', { status: 'running' });

    sessions.boot();

    assert.equal(db.runningTurnIntents().length, 0);
    const ended = events.filter((e) => e.event.type === 'turn.ended').map((e) => (e.event as { turnId: string }).turnId);
    assert.deepEqual(ended, ['turn-B'], 'only the interrupted turn gets a turn.ended from boot()');
    assert.equal(events.filter((e) => e.event.type === 'session.error').length, 1);
    assert.equal(db.getSession('s')?.status, 'idle');
    db.close();
  });

  it('shutdown() answers the permission requests it is still waiting on (cancelled, by server) so a parked turn cannot hold the drain', async () => {
    const { db, events, sessions } = makeManager(home);
    db.createSession({ id: 'p', agent: 'x', cwd: home, title: 'repo' });
    db.appendEvent('p', { type: 'session.created', agent: 'x', cwd: home, title: 'repo' });
    db.updateSession('p', { status: 'running' });
    // the real path: the agent asked, the daemon persisted the row and is awaiting the phone's answer
    const answer = sessions.requestPermission(
      'p',
      'turn-1',
      { sessionId: 'acp-1', toolCall: { toolCallId: 'tc-1', title: 'Run `echo hi`', kind: 'execute', rawInput: { command: 'echo hi' } }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
      new AbortController().signal,
    );
    const pending = db.pendingPermissions('p');
    assert.equal(pending.length, 1);
    const permissionId = pending[0]!.id;
    assert.equal(db.getSession('p')?.status, 'needs_you');
    // a row left behind by an earlier hard crash has no waiter in this process: boot() owns it, shutdown leaves it alone
    db.createSession({ id: 'q', agent: 'x', cwd: home, title: 'repo' });
    db.appendEvent('q', { type: 'session.created', agent: 'x', cwd: home, title: 'repo' });
    db.insertPermission(permission('q', 'perm-stale'));

    await sessions.shutdown({ drainMs: 10, cancelTurns: false });

    assert.deepEqual(await answer, { outcome: { outcome: 'cancelled' } }, 'the agent is told the request was cancelled');
    assert.equal(db.getPermission(permissionId)?.status, 'cancelled');
    assert.equal(db.getPermission(permissionId)?.resolvedBy, 'server');
    const resolved = events.find((e) => e.sessionId === 'p' && e.event.type === 'permission.resolved');
    assert.deepEqual(resolved?.event, { type: 'permission.resolved', permissionId, outcome: 'cancelled', by: 'server' });
    assert.equal(db.getPermission('perm-stale')?.status, 'pending');
    db.close();
  });

  it('prunes closed sessions past the retention window and keeps the rest', () => {
    const { db, sessions } = makeManager(home);
    const dayMs = 24 * 3600 * 1000;
    db.createSession({ id: 'old', agent: 'x', cwd: home, title: 'old' });
    db.appendEvent('old', { type: 'session.created', agent: 'x', cwd: home, title: 'old' });
    db.updateSession('old', { status: 'closed', closedAt: Date.now() - 40 * dayMs });
    db.createSession({ id: 'recent', agent: 'x', cwd: home, title: 'recent' });
    db.updateSession('recent', { status: 'closed', closedAt: Date.now() - dayMs });
    db.createSession({ id: 'open', agent: 'x', cwd: home, title: 'open' });
    db.updateSession('open', { status: 'idle' });

    sessions.boot(); // default retention: 30 days

    assert.equal(db.getSession('old'), null);
    assert.equal(db.eventsAfter('old', -1, 10).length, 0);
    assert.ok(db.getSession('recent'));
    assert.ok(db.getSession('open'));
    db.close();
  });
});

describe('Notifier dedupe and click targets', () => {
  let server: http.Server;
  let port: number;
  let statusToSend = 200;
  const received: { url: string; click: string | undefined }[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      received.push({ url: req.url ?? '', click: req.headers.click as string | undefined });
      req.resume();
      req.on('end', () => {
        res.statusCode = statusToSend;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  function makeNotifier(now: () => number): Notifier {
    const config: Config = { ...defaultConfig(), agents: {}, publicUrl: 'https://laptop.ts.net' };
    config.notifications = { ...config.notifications, ntfy: { server: `http://127.0.0.1:${port}`, topic: 'mide-test' } };
    return new Notifier(new Db(':memory:'), config, { configPath: null, now });
  }

  it('suppresses a repeated turn_done, never a permission, and carries the permission id in the Click URL', async () => {
    let clock = 1_000_000;
    const n = makeNotifier(() => clock);
    received.length = 0;
    statusToSend = 200;
    const a = await n.notify('all', { title: 't', body: 'b', sessionId: 's1', kind: 'turn_done' });
    clock += 1000;
    const b = await n.notify('all', { title: 't', body: 'b', sessionId: 's1', kind: 'turn_done' });
    assert.equal(a.sent, 1);
    assert.equal(b.suppressed, true);

    const p1 = await n.notify('all', { title: 't', body: 'b', sessionId: 's1', permissionId: 'perm-1', kind: 'permission' });
    clock += 1000;
    const p2 = await n.notify('all', { title: 't', body: 'b', sessionId: 's1', permissionId: 'perm-2', kind: 'permission' });
    assert.equal(p1.sent, 1);
    assert.equal(p2.sent, 1, 'a second permission request within the window still buzzes');
    const clicks = received.slice(-2).map((r) => r.click);
    assert.deepEqual(clicks, ['https://laptop.ts.net/session/s1?permission=perm-1', 'https://laptop.ts.net/session/s1?permission=perm-2']);
  });

  it('reserves the dedupe window before the fan-out, so overlapping notifications for one key buzz once', async () => {
    let clock = 7_000_000;
    const n = makeNotifier(() => clock);
    received.length = 0;
    statusToSend = 200;
    const results = await Promise.all([1, 2, 3].map(() => n.notify('all', { title: 't', body: 'b', sessionId: 's3', kind: 'turn_done' })));
    assert.equal(results.filter((r) => r.sent === 1).length, 1);
    assert.equal(results.filter((r) => r.suppressed).length, 2);
    assert.equal(received.length, 1, 'the phone was contacted once');
    clock += 1000;
    const d = await n.notify('all', { title: 't', body: 'b', sessionId: 's3', kind: 'turn_done' });
    assert.equal(d.suppressed, true, 'the window is anchored at the reservation');
  });

  it('does not start the dedupe window when every channel failed', async () => {
    let clock = 5_000_000;
    const n = makeNotifier(() => clock);
    statusToSend = 500;
    const failed = await n.notify('all', { title: 't', body: 'b', sessionId: 's2', kind: 'error' });
    assert.equal(failed.sent, 0);
    assert.equal(failed.failed, 1);
    statusToSend = 200;
    clock += 500;
    const retry = await n.notify('all', { title: 't', body: 'b', sessionId: 's2', kind: 'error' });
    assert.equal(retry.suppressed, false);
    assert.equal(retry.sent, 1);
    clock += 500;
    const again = await n.notify('all', { title: 't', body: 'b', sessionId: 's2', kind: 'error' });
    assert.equal(again.suppressed, true, 'the window starts with the first successful delivery');
  });
});

describe('ntfyServerProblem', () => {
  it('accepts https anywhere and http only on loopback / private / tailnet hosts', () => {
    assert.equal(ntfyServerProblem('https://ntfy.sh'), null);
    assert.equal(ntfyServerProblem('https://ntfy.example.com/base'), null);
    assert.equal(ntfyServerProblem('http://127.0.0.1:2586'), null);
    assert.equal(ntfyServerProblem('http://100.101.102.103'), null);
    assert.equal(ntfyServerProblem('http://ntfy.tail1234.ts.net'), null);
    assert.match(ntfyServerProblem('http://ntfy.example.com') ?? '', /https/);
  });
  it('rejects credentials, query/fragment, link-local addresses and non-http schemes', () => {
    assert.match(ntfyServerProblem('https://user:pw@ntfy.sh') ?? '', /credentials/);
    assert.match(ntfyServerProblem('https://ntfy.sh/?x=1') ?? '', /query/);
    assert.match(ntfyServerProblem('https://ntfy.sh/#frag') ?? '', /fragment/);
    assert.match(ntfyServerProblem('http://169.254.169.254/latest') ?? '', /link-local/);
    assert.match(ntfyServerProblem('http://[fe80::1]') ?? '', /link-local/);
    assert.match(ntfyServerProblem('http://[fe80:0:0:0:0:0:0:1]') ?? '', /link-local/);
    // IPv4-mapped IPv6: WHATWG URL serializes the tail in hex, so a string match on the dotted form never fired
    assert.match(ntfyServerProblem('http://[::ffff:169.254.169.254]/') ?? '', /link-local/);
    assert.match(ntfyServerProblem('http://[::ffff:a9fe:a9fe]/') ?? '', /link-local/);
    assert.match(ntfyServerProblem('https://[::ffff:169.254.169.254]/') ?? '', /link-local/);
    assert.equal(ntfyServerProblem('http://[::ffff:127.0.0.1]:2586'), null, 'mapped loopback is still a fine self-hosted ntfy');
    assert.match(ntfyServerProblem('ftp://ntfy.sh') ?? '', /http/);
    assert.match(ntfyServerProblem('not a url') ?? '', /http/);
  });
});

describe('CompressionCache', () => {
  it('shares one in-flight compression per key and evicts least-recently-used entries past the byte budget', async () => {
    const cache = new CompressionCache(10, 10);
    let produced = 0;
    const produce = async (): Promise<Buffer> => {
      produced++;
      await new Promise((r) => setTimeout(r, 5));
      return Buffer.from('abcd');
    };
    const [a, b] = await Promise.all([cache.compute('k1', produce), cache.compute('k1', produce)]);
    assert.equal(produced, 1);
    assert.equal(a, b);
    assert.equal(cache.get('k1')?.toString(), 'abcd');

    await cache.compute('k2', async () => Buffer.from('efgh'));
    await cache.compute('k3', async () => Buffer.from('ijkl')); // 12 bytes > budget 10 → k1 (oldest) goes
    assert.equal(cache.get('k1'), undefined);
    assert.ok(cache.get('k2'));
    assert.ok(cache.get('k3'));
    assert.equal(cache.size, 2);

    // an entry larger than the whole budget is served but never stored
    await cache.compute('big', async () => Buffer.alloc(11));
    assert.equal(cache.get('big'), undefined);
  });
});

describe('web app HEAD', () => {
  let dir: string;
  before(() => {
    dir = tmpDir('mide-webapp-');
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><body>${'<p>hello</p>'.repeat(600)}</body></html>`);
  });
  after(() => rmrf(dir));

  it('negotiates the same encoding and ETag as GET, and reports the compressed length once it is cached', async () => {
    const loaded = { config: { ...defaultConfig(), webApp: { dir } }, home: dir, configPath: `${dir}/config.json`, dbPath: `${dir}/mide.db`, adminSocketPath: `${dir}/admin.sock` } as LoadedConfig;
    const ctx = { log: createLogger({ mod: 'test' }), config: loaded } as unknown as ServerContext;
    const app = new Hono<AuthedEnv>().use(webAppMiddleware(ctx));
    const size = fs.statSync(path.join(dir, 'index.html')).size;
    const br = { 'accept-encoding': 'br' };

    const head = await app.request('/', { method: 'HEAD', headers: br });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-encoding'), 'br');
    assert.equal(head.headers.get('content-length'), null, 'not compressed yet: no length rather than the uncompressed one');
    const get = await app.request('/', { method: 'GET', headers: br });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-encoding'), 'br');
    assert.equal(get.headers.get('etag'), head.headers.get('etag'), 'HEAD and GET validate the same representation');
    assert.match(get.headers.get('etag') ?? '', /-br"$/);
    const again = await app.request('/', { method: 'HEAD', headers: br });
    assert.equal(again.headers.get('content-length'), get.headers.get('content-length'), 'the cached compressed length');
    // a HEAD ETag revalidates the GET
    const revalidate = await app.request('/', { method: 'GET', headers: { ...br, 'if-none-match': head.headers.get('etag') ?? '' } });
    assert.equal(revalidate.status, 304);
    // identity requests are unchanged
    const plain = await app.request('/', { method: 'HEAD' });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(plain.headers.get('content-length'), String(size));
    assert.doesNotMatch(plain.headers.get('etag') ?? '', /-br"$/);
  });
});

describe('AgentTerminals record cleanup', () => {
  it('killAll reaps commands and drops their records; killAllForSession keeps them only for the grace period', async () => {
    const terms = new AgentTerminals();
    const env = { ...process.env };
    const t1 = terms.create({ sessionId: 'a', command: 'sleep', args: ['30'] }, process.cwd(), env);
    const t2 = terms.create({ sessionId: 'b', command: 'sleep', args: ['30'] }, process.cwd(), env);
    assert.equal(terms.size(), 2);
    await terms.killAllForSession('a');
    assert.ok(t1.exit, 'the command was reaped');
    assert.ok(terms.get(t1.id), 'record survives briefly so a trailing tool_call_update can embed the output');
    await terms.killAll();
    assert.ok(t2.exit);
    assert.equal(terms.get(t2.id), undefined, 'shutdown keeps nothing');
    assert.equal(terms.size(), 0, 'shutdown also drops the graced record');
  });
});
