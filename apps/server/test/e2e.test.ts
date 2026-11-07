/**
 * End-to-end: boots the real daemon (`startServer`) on a random port with MIDE_HOME in a
 * temp dir, pairs a device over HTTP, exercises the REST + WebSocket contracts, and — when
 * the agent binary is available — runs ONE tiny OpenCode turn (this costs real tokens).
 *
 *   MIDE_SKIP_AGENT_TESTS=1     skip the agent turn (every server-only check still runs)
 *   MIDE_TEST_AGENT=claude      run the turn against claude-agent-acp instead of opencode
 *   MIDE_SKIP_TERMINAL_TESTS=1  skip the tmux-backed /ws/terminal check
 *   MIDE_E2E_VERBOSE=1          stream daemon logs to stderr (otherwise only the tail on failure)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import {
  AgentInfo,
  API,
  EventEnvelope,
  FileContent,
  FsEntry,
  GitDiff,
  GitLogEntry,
  GitStatus,
  HealthResponse,
  MideClient,
  PairResponse,
  ProjectInfo,
  PROTOCOL_VERSION,
  PushVapidResponse,
  SearchMatch,
  ServerFrame,
  SessionSummary,
  WS_AUTH_SUBPROTOCOL_PREFIX,
  wsUrl,
} from '@mobile-ide/core';
import { z } from 'zod';
import { startServer } from '../src/app.js';
import { generatePairingCode, hashToken } from '../src/auth.js';
import { defaultAgents, type AgentConfig } from '../src/config.js';
import type { RunningServer } from '../src/context.js';
import { setLogSink } from '../src/log.js';
import { api, Collector, makeTmpRepo, pickFreePort, qs, RawSocket, REPO, rmrf, tmpDir, waitFor, which, wire } from './helpers.js';

// ------------------------------------------------------------------ environment gates
const AGENT_ID = process.env.MIDE_TEST_AGENT?.trim() || 'opencode';
/** the binary each built-in adapter ultimately needs on PATH */
const AGENT_BINARY: Record<string, string> = { opencode: 'opencode', claude: 'claude', codex: 'codex' };
const PROMPT = 'Reply with exactly the word PONG and nothing else.';
const PREFIX = WS_AUTH_SUBPROTOCOL_PREFIX;
const SERVER_NAME = 'mide-e2e';

function agentSkipReason(): string | undefined {
  if (process.env.MIDE_SKIP_AGENT_TESTS === '1') return 'MIDE_SKIP_AGENT_TESTS=1';
  const cfg = defaultAgents()[AGENT_ID];
  if (!cfg) return `MIDE_TEST_AGENT=${AGENT_ID} is not a built-in agent (opencode|claude|codex)`;
  const bin = AGENT_BINARY[AGENT_ID] ?? cfg.command;
  if (!which(bin)) return `'${bin}' is not on PATH — install it, or set MIDE_SKIP_AGENT_TESTS=1 to silence this`;
  if (cfg.command !== bin && !which(cfg.command)) return `'${cfg.command}' (needed to launch the ${cfg.name} adapter) is not on PATH`;
  return undefined;
}

const AGENT_SKIP = agentSkipReason();
const TERMINAL_SKIP = process.env.MIDE_SKIP_TERMINAL_TESTS === '1' ? 'MIDE_SKIP_TERMINAL_TESTS=1' : which('tmux') ? undefined : "'tmux' is not on PATH";

// ------------------------------------------------------------------ daemon log capture
const daemonLog: string[] = [];
setLogSink((line) => {
  if (process.env.MIDE_E2E_VERBOSE === '1') process.stderr.write(`${line}\n`);
  daemonLog.push(line);
  if (daemonLog.length > 400) daemonLog.shift();
});

/** `it` that dumps the daemon log tail when the step fails. */
function step(name: string, opts: { timeout?: number; skip?: string | undefined }, fn: (t: TestContext) => Promise<void>): void {
  it(name, { timeout: opts.timeout ?? 30_000, ...(opts.skip ? { skip: opts.skip } : {}) }, async (t) => {
    try {
      await fn(t);
    } catch (err) {
      const tail = daemonLog.slice(-40);
      if (tail.length) t.diagnostic(`daemon log tail (${tail.length} lines):\n${tail.join('\n')}`);
      throw err;
    }
  });
}

const ErrorBody = z.object({ error: z.string(), code: z.string().optional() });

// ------------------------------------------------------------------ shared state (steps run in order)
let running: RunningServer | undefined;
let base = '';
let home: string | undefined;
let repo = '';
let token = '';
let deviceId = '';

function server(): RunningServer {
  if (!running) throw new Error('daemon not started — see the before() hook failure');
  return running;
}

function fsRoute(route: string, params: Record<string, string | number | undefined>): string {
  return `${route}${qs(params)}`;
}

describe('mobile-ide daemon e2e', () => {
  before(async () => {
    home = tmpDir('mide-e2e-home-');
    repo = makeTmpRepo();
    process.env.MIDE_HOME = home;
    const agents: Record<string, AgentConfig> = {};
    const cfg = defaultAgents()[AGENT_ID];
    if (!AGENT_SKIP && cfg) agents[AGENT_ID] = cfg;
    const port = await pickFreePort();
    running = await startServer({
      home,
      overrides: {
        port,
        host: '127.0.0.1',
        serverName: SERVER_NAME,
        publicUrl: null,
        projects: { roots: [repo], denylist: [path.join(repo, REPO.secretDir)] },
        agents,
        terminal: { shell: '$SHELL', tmuxPrefix: `mide-e2e-${process.pid}`, autoOpen: false },
      },
    });
    assert.equal(running.port, port, 'RunningServer.port is the bound port');
    base = `http://127.0.0.1:${running.port}`;
    assert.equal(new URL(running.url).port, String(running.port), 'RunningServer.url must point at the bound port');
  }, { timeout: 120_000 });

  after(async () => {
    if (running) {
      await running.close({ drainMs: 5_000, cancelTurns: true });
      running = undefined;
    }
    rmrf(home);
    rmrf(repo);
  }, { timeout: 60_000 });

  // ================================================================ health & auth
  step('GET /api/health without a token returns only {ok, serverName, version}', {}, async () => {
    const r = await api(base, 'GET', API.health);
    assert.equal(r.status, 200, r.text);
    const body = z.object({ ok: z.boolean(), serverName: z.string(), version: z.string() }).strict().parse(r.body);
    assert.equal(body.ok, true);
    assert.equal(body.serverName, SERVER_NAME);
    assert.equal(body.version, server().ctx.version);
  });

  step('every other route rejects missing, malformed and unknown bearer tokens with 401', {}, async () => {
    for (const [route, headers] of [
      [API.me, {}],
      [API.sessions, { authorization: 'Bearer nope' }],
      [API.agents, { authorization: 'Basic dXNlcjpwYXNz' }],
      [API.projects, { authorization: 'Bearer' }],
      [API.pendingPermissions, { authorization: 'Bearer ' }],
    ] as const) {
      const r = await api(base, 'GET', route, { headers: { ...headers } });
      assert.equal(r.status, 401, `${route} with ${JSON.stringify(headers)}: ${r.text}`);
      ErrorBody.parse(r.body);
    }
    const q = await api(base, 'GET', `${API.me}?token=nope`);
    assert.equal(q.status, 401, 'a bogus ?token= is still unauthorized');
  });

  // ================================================================ pairing
  step('POST /api/pair burns a one-time code and returns a device token', {}, async () => {
    const code = generatePairingCode();
    server().ctx.db.createPairingCode(code);
    const r = await api(base, 'POST', API.pair, { body: { code: code.toLowerCase(), deviceName: 'e2e device', platform: 'node' } });
    assert.ok(r.status === 200 || r.status === 201, `pair: ${r.status} ${r.text}`);
    const pr = PairResponse.parse(r.body);
    assert.equal(pr.serverName, SERVER_NAME);
    assert.match(pr.token, /^[A-Za-z0-9_-]{43}$/, 'token is 32 random bytes base64url');
    token = pr.token;
    deviceId = pr.deviceId;

    const again = await api(base, 'POST', API.pair, { body: { code, deviceName: 'replay attempt' } });
    assert.ok(again.status >= 400 && again.status < 500, `a burned code must be rejected: ${again.status} ${again.text}`);
    ErrorBody.parse(again.body);

    const invalid = await api(base, 'POST', API.pair, { body: { deviceName: 'no code' } });
    assert.equal(invalid.status, 400, `schema violations map to 400: ${invalid.text}`);
    ErrorBody.parse(invalid.body);
  });

  step('pairing is rate-limited to 5/min per IP', {}, async () => {
    let limited: number | undefined;
    for (let i = 0; i < 8 && limited === undefined; i++) {
      const r = await api(base, 'POST', API.pair, { body: { code: 'ZZZZZZZZ', deviceName: 'brute force' } });
      if (r.status === 429) limited = i;
      else assert.ok(r.status >= 400 && r.status < 500, `bogus code attempt ${i}: ${r.status}`);
    }
    assert.notEqual(limited, undefined, 'expected a 429 within 8 bogus attempts after 3 earlier calls');
  });

  // ================================================================ authed reads
  step('GET /api/me, /api/devices never leak the token hash; health and agents validate', {}, async () => {
    const me = await api(base, 'GET', API.me, { token });
    assert.equal(me.status, 200, me.text);
    const meBody = z.object({ id: z.string(), name: z.string() }).parse(me.body);
    assert.equal(meBody.id, deviceId);
    assert.equal(meBody.name, 'e2e device');
    const hash = hashToken(token);
    assert.ok(!me.text.includes(hash) && !me.text.includes(token), '/api/me must not expose the token or its hash');

    const devices = await api(base, 'GET', API.devices, { token });
    assert.equal(devices.status, 200, devices.text);
    const list = z.array(z.object({ id: z.string(), name: z.string() })).parse(devices.body);
    assert.ok(list.some((d) => d.id === deviceId));
    assert.ok(!devices.text.includes(hash) && !devices.text.includes(token), '/api/devices must not expose token hashes');

    const health = await api(base, 'GET', API.health, { token });
    assert.equal(health.status, 200, health.text);
    const h = HealthResponse.parse(health.body);
    assert.equal(h.ok, true);
    assert.equal(h.serverName, SERVER_NAME);
    assert.ok(h.uptimeSec >= 0);
    if (!AGENT_SKIP) assert.ok(h.agents.some((a) => a.id === AGENT_ID), `health lists the configured agent: ${JSON.stringify(h.agents)}`);

    const agents = await api(base, 'GET', API.agents, { token });
    assert.equal(agents.status, 200, agents.text);
    const infos = z.array(AgentInfo).parse(agents.body);
    if (!AGENT_SKIP) assert.ok(infos.some((a) => a.id === AGENT_ID));
    else assert.equal(infos.length, 0);

    const pending = await api(base, 'GET', API.pendingPermissions, { token });
    assert.equal(pending.status, 200, pending.text);
    assert.deepEqual(pending.body, []);

    const vapid = await api(base, 'GET', API.pushVapid, { token });
    assert.equal(vapid.status, 200, vapid.text);
    // the daemon generates a VAPID pair at its first start (see notify.test.ts for the full behaviour)
    const { publicKey } = PushVapidResponse.parse(vapid.body);
    assert.match(publicKey ?? '', /^[A-Za-z0-9_-]{87}$/, 'a freshly generated P-256 public key in base64url');
  });

  step('GET /api/projects discovers the git repo under the configured root', {}, async () => {
    const r = await api(base, 'GET', API.projects, { token });
    assert.equal(r.status, 200, r.text);
    const projects = z.array(ProjectInfo).parse(r.body);
    const mine = projects.find((p) => p.root === repo);
    assert.ok(mine, `expected ${repo} in ${JSON.stringify(projects.map((p) => p.root))}`);
    assert.equal(mine.isGit, true);
    assert.equal(mine.branch, REPO.branch);
    assert.equal(mine.name, path.basename(repo));
  });

  step('session routes: unknown id -> 404, unknown agent -> 400', {}, async () => {
    const missing = await api(base, 'GET', API.session('does-not-exist'), { token });
    assert.equal(missing.status, 404, missing.text);
    ErrorBody.parse(missing.body);
    const events = await api(base, 'GET', API.sessionEvents('does-not-exist'), { token });
    assert.equal(events.status, 404, events.text);
    const badAgent = await api(base, 'POST', API.sessions, { token, body: { agent: 'nonexistent-agent', cwd: repo } });
    assert.equal(badAgent.status, 400, badAgent.text);
    ErrorBody.parse(badAgent.body);
    const badBody = await api(base, 'POST', API.sessions, { token, body: { cwd: repo } });
    assert.equal(badBody.status, 400, badBody.text);
    const list = await api(base, 'GET', API.sessions, { token });
    assert.equal(list.status, 200, list.text);
    z.array(SessionSummary).parse(list.body);
  });

  // ================================================================ files
  step('GET /api/fs/tree lists one level, dirs first, with git status letters', {}, async () => {
    const r = await api(base, 'GET', fsRoute(API.fsTree, { root: repo }), { token });
    assert.equal(r.status, 200, r.text);
    const entries = z.array(FsEntry).parse(r.body);
    const names = entries.map((e) => e.name);
    for (const expected of [REPO.modified, REPO.untracked, REPO.binary, 'src']) assert.ok(names.includes(expected), `${expected} in ${names.join(',')}`);
    const firstFileIdx = entries.findIndex((e) => e.kind !== 'dir');
    const lastDirIdx = entries.map((e) => e.kind).lastIndexOf('dir');
    assert.ok(lastDirIdx < firstFileIdx || firstFileIdx === -1, 'directories are listed before files');
    const modified = entries.find((e) => e.name === REPO.modified);
    assert.ok(modified && modified.kind === 'file');
    assert.equal(modified.path, REPO.modified);
    assert.equal(modified.size, Buffer.byteLength(REPO.modifiedContent));
    assert.equal(modified.gitStatus, 'M');
    assert.ok(typeof modified.mtime === 'number' && modified.mtime > 0);
    const untracked = entries.find((e) => e.name === REPO.untracked);
    assert.equal(untracked?.gitStatus, '??');
    const src = entries.find((e) => e.name === 'src');
    assert.equal(src?.kind, 'dir');
    assert.equal(src?.gitStatus, undefined, 'a clean committed dir has no status letters');

    const sub = await api(base, 'GET', fsRoute(API.fsTree, { root: repo, path: 'src' }), { token });
    assert.equal(sub.status, 200, sub.text);
    const subEntries = z.array(FsEntry).parse(sub.body);
    assert.deepEqual(subEntries.map((e) => e.path), [REPO.searchable]);
  });

  step('fs routes refuse traversal, denylisted paths and foreign roots with 403', {}, async () => {
    for (const [route, params] of [
      [API.fsTree, { root: repo, path: '../' }],
      [API.fsTree, { root: repo, path: '../../etc' }],
      [API.fsTree, { root: repo, path: REPO.secretDir }],
      [API.fsFile, { root: repo, path: REPO.secretFile }],
      [API.fsFile, { root: repo, path: '../../../etc/passwd' }],
      [API.fsTree, { root: '/etc' }],
      [API.fsFile, { root: '/etc', path: 'passwd' }],
      [API.fsSearch, { root: '/etc', q: 'root' }],
      [API.gitStatus, { root: path.dirname(repo) }],
      [API.gitLog, { root: '/' }],
    ] as const) {
      const r = await api(base, 'GET', fsRoute(route, { ...params }), { token });
      assert.equal(r.status, 403, `${route}${qs({ ...params })} -> ${r.status} ${r.text}`);
      assert.equal(ErrorBody.parse(r.body).code, 'forbidden');
    }
    const noRoot = await api(base, 'GET', API.fsTree, { token });
    assert.ok(noRoot.status === 400 || noRoot.status === 403, `missing root -> ${noRoot.status}`);
  });

  step('GET /api/fs/file reads text (with language) and flags binaries; missing -> 404', {}, async () => {
    const txt = await api(base, 'GET', fsRoute(API.fsFile, { root: repo, path: REPO.modified }), { token });
    assert.equal(txt.status, 200, txt.text);
    const file = FileContent.parse(txt.body);
    const { mtime, ...rest } = file;
    assert.deepEqual(rest, { path: REPO.modified, content: REPO.modifiedContent, language: 'text', size: Buffer.byteLength(REPO.modifiedContent), truncated: false, binary: false });
    assert.ok(typeof mtime === 'number' && Number.isInteger(mtime) && mtime > 0, 'mtime is the integer ms token the Studio saves with');

    const ts = await api(base, 'GET', fsRoute(API.fsFile, { root: repo, path: `/${REPO.searchable}` }), { token });
    assert.equal(ts.status, 200, ts.text);
    assert.equal(FileContent.parse(ts.body).language, 'typescript');
    assert.equal(FileContent.parse(ts.body).path, REPO.searchable, 'leading slash is not an absolute path');

    const bin = await api(base, 'GET', fsRoute(API.fsFile, { root: repo, path: REPO.binary }), { token });
    assert.equal(bin.status, 200, bin.text);
    const blob = FileContent.parse(bin.body);
    assert.equal(blob.binary, true);
    assert.equal(blob.content, '');
    assert.equal(blob.size, 14);

    const missing = await api(base, 'GET', fsRoute(API.fsFile, { root: repo, path: 'nope.txt' }), { token });
    assert.equal(missing.status, 404, missing.text);
    ErrorBody.parse(missing.body);
  });

  step('GET /api/fs/search finds the needle with 1-based line and column', {}, async () => {
    const r = await api(base, 'GET', fsRoute(API.fsSearch, { root: repo, q: REPO.searchNeedle }), { token });
    assert.equal(r.status, 200, r.text);
    const matches = z.array(SearchMatch).parse(r.body);
    const hit = matches.find((m) => m.path === REPO.searchable);
    assert.ok(hit, `expected a match in ${REPO.searchable}: ${JSON.stringify(matches)}`);
    assert.equal(hit.line, REPO.searchLine);
    assert.equal(hit.column, REPO.searchColumn);
    assert.ok(hit.text.includes(REPO.searchNeedle));
    assert.ok(!matches.some((m) => m.path.startsWith('.git/')), 'search never descends into .git');

    const limited = await api(base, 'GET', fsRoute(API.fsSearch, { root: repo, q: 'e', limit: 1 }), { token });
    assert.equal(limited.status, 200, limited.text);
    assert.equal(z.array(SearchMatch).parse(limited.body).length, 1);

    const empty = await api(base, 'GET', fsRoute(API.fsSearch, { root: repo, q: '' }), { token });
    assert.ok(empty.status === 200 || empty.status === 400, `empty query -> ${empty.status}`);
    if (empty.status === 200) assert.deepEqual(empty.body, []);
  });

  // ================================================================ git
  step('GET /api/git/status reports branch, modified and untracked entries', {}, async () => {
    const r = await api(base, 'GET', fsRoute(API.gitStatus, { root: repo }), { token });
    assert.equal(r.status, 200, r.text);
    const status = GitStatus.parse(r.body);
    assert.equal(status.branch, REPO.branch);
    const modified = status.entries.find((e) => e.path === REPO.modified);
    assert.deepEqual(modified, { path: REPO.modified, index: ' ', worktree: 'M' });
    const untracked = status.entries.find((e) => e.path === REPO.untracked);
    assert.deepEqual(untracked, { path: REPO.untracked, index: '?', worktree: '?' });
    assert.equal(status.entries.length, 2, JSON.stringify(status.entries));
  });

  step('GET /api/git/diff for a file, the whole tree, staged, and an untracked file', {}, async () => {
    const one = await api(base, 'GET', fsRoute(API.gitDiff, { root: repo, path: REPO.modified }), { token });
    assert.equal(one.status, 200, one.text);
    const d1 = GitDiff.parse(one.body);
    assert.equal(d1.path, REPO.modified);
    assert.equal(d1.staged, false);
    assert.equal(d1.truncated, false);
    assert.ok(d1.patch.includes('+second line'), d1.patch);
    assert.ok(d1.patch.includes(`diff --git a/${REPO.modified} b/${REPO.modified}`), d1.patch);

    const all = await api(base, 'GET', fsRoute(API.gitDiff, { root: repo }), { token });
    assert.equal(all.status, 200, all.text);
    const dAll = GitDiff.parse(all.body);
    assert.equal(dAll.path, undefined);
    assert.ok(dAll.patch.includes('+second line'));

    const staged = await api(base, 'GET', fsRoute(API.gitDiff, { root: repo, staged: 1 }), { token });
    assert.equal(staged.status, 200, staged.text);
    const dStaged = GitDiff.parse(staged.body);
    assert.equal(dStaged.staged, true);
    assert.equal(dStaged.patch, '', 'nothing is staged in the fixture repo');

    const untracked = await api(base, 'GET', fsRoute(API.gitDiff, { root: repo, path: REPO.untracked }), { token });
    assert.equal(untracked.status, 200, untracked.text);
    assert.ok(GitDiff.parse(untracked.body).patch.includes('+untracked'), 'untracked files diff against /dev/null');
  });

  step('GET /api/git/log returns the commit', {}, async () => {
    const r = await api(base, 'GET', fsRoute(API.gitLog, { root: repo, limit: 30 }), { token });
    assert.equal(r.status, 200, r.text);
    const log = z.array(GitLogEntry).parse(r.body);
    assert.equal(log.length, 1);
    const [c] = log;
    assert.ok(c);
    assert.equal(c.subject, REPO.commitSubject);
    assert.equal(c.author, REPO.author);
    assert.match(c.hash, /^[0-9a-f]{40}$/);
    assert.ok(c.hash.startsWith(c.shortHash));
    assert.ok(c.date > Date.UTC(2020, 0, 1) && c.date <= Date.now() + 60_000, `date is epoch ms: ${c.date}`);
  });

  // ================================================================ push
  step('POST /api/push/register + /api/push/test deliver an ntfy notification', {}, async () => {
    const received: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
    const stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString('utf8');
      });
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    try {
      const port = (stub.address() as AddressInfo).port;
      const reg = await api(base, 'POST', API.pushRegister, { token, body: { kind: 'ntfy', server: `http://127.0.0.1:${port}`, topic: 'mide-e2e' } });
      assert.ok(reg.status >= 200 && reg.status < 300, `register: ${reg.status} ${reg.text}`);
      const subs = server().ctx.db.listPushSubscriptions([deviceId]);
      assert.ok(subs.some((s) => s.kind === 'ntfy'), 'subscription persisted for the calling device');

      const bad = await api(base, 'POST', API.pushRegister, { token, body: { kind: 'carrier-pigeon' } });
      assert.equal(bad.status, 400, bad.text);

      const test = await api(base, 'POST', API.pushTest, { token });
      assert.ok(test.status >= 200 && test.status < 300, `push/test: ${test.status} ${test.text}`);
      const hit = await waitFor(() => received.find((r) => r.url === '/mide-e2e'), { what: 'ntfy POST to the stub', timeoutMs: 10_000 });
      assert.ok(typeof hit.headers.title === 'string' && hit.headers.title.length > 0, 'ntfy Title header');
      assert.ok(hit.body.length > 0, 'ntfy body');
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  // ================================================================ websocket protocol
  step('/ws completes the handshake then closes 4401 for an invalid token; refuses without one', {}, async () => {
    const bad = new RawSocket(wsUrl(base), [`${PREFIX}not-a-real-token`]);
    const closed = await bad.closed;
    assert.equal(closed.code, 4401, `invalid token -> close 4401 (got ${closed.code} ${closed.reason})`);

    const none = new RawSocket(wsUrl(base));
    await assert.rejects(none.opened, /closed before open/);
    const noneClosed = await none.closed;
    assert.notEqual(noneClosed.code, 1000);

    const unknownPath = new RawSocket(wsUrl(base, '/ws/nope'), [`${PREFIX}${token}`]);
    await assert.rejects(unknownPath.opened, /closed before open/);
  });

  step('/ws: hello -> welcome, ping -> pong, bad frames -> error without dropping the socket, sessions.watch', {}, async () => {
    const raw = new RawSocket(wsUrl(base), [`${PREFIX}${token}`]);
    await raw.opened;
    assert.equal(raw.ws.protocol, `${PREFIX}${token}`, 'the auth subprotocol is echoed back');
    const frame = (f: unknown): ServerFrame | undefined => {
      const p = ServerFrame.safeParse(f);
      return p.success ? p.data : undefined;
    };

    raw.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, clientName: 'mide-e2e', clientVersion: '0.0.0' });
    const welcome = await raw.frame((f) => {
      const s = frame(f);
      return s?.type === 'welcome' ? s : undefined;
    }, 'welcome frame');
    assert.equal(welcome.protocolVersion, PROTOCOL_VERSION);
    assert.equal(welcome.serverName, SERVER_NAME);
    assert.equal(welcome.deviceId, deviceId);
    assert.equal(welcome.serverVersion, server().ctx.version);

    raw.send({ type: 'ping', ts: 1234 });
    await raw.frame((f) => {
      const s = frame(f);
      return s?.type === 'pong' && s.ts === 1234 ? s : undefined;
    }, 'pong 1234');

    raw.ws.send('this is not json');
    raw.send({ type: 'definitely-not-a-frame' });
    raw.send({ type: 'subscribe', sessionId: 'does-not-exist', afterSeq: 0 });
    const errors = await raw.until(() => {
      const errs = raw.frames.map(frame).filter((s): s is Extract<ServerFrame, { type: 'error' }> => s?.type === 'error');
      return errs.length >= 3 ? errs : undefined;
    }, 'three error frames (garbage, unknown type, unknown session)');
    assert.ok(errors.every((e) => e.message.length > 0));
    assert.ok(raw.open, 'protocol errors must not close the connection');

    raw.send({ type: 'ping', ts: 5678 });
    await raw.frame((f) => {
      const s = frame(f);
      return s?.type === 'pong' && s.ts === 5678 ? s : undefined;
    }, 'pong 5678 after errors');

    raw.send({ type: 'sessions.watch' });
    const sessions = await raw.frame((f) => {
      const s = frame(f);
      return s?.type === 'sessions.changed' ? s : undefined;
    }, 'sessions.changed');
    assert.ok(Array.isArray(sessions.sessions));

    raw.close();
    const closed = await raw.closed;
    assert.equal(closed.code, 1000);
    assert.ok(raw.texts.length === 0, 'the server only ever sends JSON text frames on /ws');
  });

  // ================================================================ terminal
  step('/ws/terminal attaches a tmux-backed pty: scrollback, bytes both ways, resize, detach', { timeout: 40_000, skip: TERMINAL_SKIP }, async (t) => {
    const termId = `e2e-${process.pid}`;
    const url = `${wsUrl(base, API.wsTerminal)}${qs({ id: termId, cwd: repo, cols: 80, rows: 24 })}`;
    const raw = new RawSocket(url, [`${PREFIX}${token}`]);
    await raw.opened;
    try {
      await raw.until(() => (raw.binary.length > 0 ? true : undefined), 'first bytes from the shell', 5_000).catch(() => t.diagnostic('no prompt bytes within 5 s; typing anyway'));
      raw.sendBinary("printf 'MIDE_%s\\n' READY\r");
      await raw.until(() => (raw.binaryText().includes('MIDE_READY') ? true : undefined), "the shell's output for the typed command", 20_000);
      const attached = server().ctx.terminals.list().find((x) => x.id === termId);
      assert.ok(attached, `terminal ${termId} listed while attached: ${JSON.stringify(server().ctx.terminals.list())}`);
      assert.ok(attached.attached >= 1);
      assert.equal(attached.cwd, repo);
      raw.send({ type: 'resize', cols: 100, rows: 30 });
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(raw.open, 'resize must not break the socket');
      raw.close();
      await raw.closed;
      await waitFor(() => (server().ctx.terminals.list().find((x) => x.id === termId)?.attached ?? 0) === 0 || undefined, { what: 'detach after socket close', timeoutMs: 5_000 });
    } finally {
      raw.close();
      const killed = await server().ctx.terminals.kill(termId);
      t.diagnostic(`tmux session for ${termId} killed: ${killed}`);
    }

    const forbidden = new RawSocket(`${wsUrl(base, API.wsTerminal)}${qs({ id: 'evil', cwd: '/etc', cols: 80, rows: 24 })}`, [`${PREFIX}${token}`]);
    const outcome = await Promise.race([forbidden.opened.then(() => 'opened' as const, () => 'refused' as const), forbidden.closed.then(() => 'closed' as const)]);
    if (outcome === 'opened') {
      const closed = await forbidden.closed;
      assert.notEqual(closed.code, 1000, 'a cwd outside the roots must be rejected');
    }
  });

  // ================================================================ agent flow (one real turn)
  describe(`agent flow (${AGENT_ID})`, () => {
    let sessionId = '';
    let client1: MideClient | undefined;
    let col1: Collector | undefined;
    let client2: MideClient | undefined;
    let col2: Collector | undefined;
    let firstRun: EventEnvelope[] = [];
    let lastSeq = -1;

    after(() => {
      client1?.close();
      client2?.close();
    });

    step('POST /api/sessions refuses a cwd outside the project roots', { skip: AGENT_SKIP }, async () => {
      const r = await api(base, 'POST', API.sessions, { token, body: { agent: AGENT_ID, cwd: '/etc', title: 'nope' } });
      assert.equal(r.status, 403, r.text);
      assert.equal(ErrorBody.parse(r.body).code, 'forbidden');
    });

    step('POST /api/sessions creates an idle session in the temp repo', { timeout: 150_000, skip: AGENT_SKIP }, async (t) => {
      const t0 = Date.now();
      const r = await api(base, 'POST', API.sessions, { token, body: { agent: AGENT_ID, cwd: repo, title: 'e2e session' } });
      assert.equal(r.status, 201, r.text);
      const summary = SessionSummary.parse(r.body);
      t.diagnostic(`session created in ${((Date.now() - t0) / 1000).toFixed(1)} s (status ${summary.status})`);
      sessionId = summary.id;
      assert.equal(summary.agent, AGENT_ID);
      assert.equal(summary.cwd, repo);
      assert.equal(summary.title, 'e2e session');
      assert.equal(summary.projectName, path.basename(repo));
      assert.equal(summary.pendingPermissions, 0);
      if (summary.status !== 'idle') {
        const ev = await api(base, 'GET', API.sessionEvents(sessionId), { token });
        const errors = z
          .array(EventEnvelope)
          .parse(ev.body)
          .flatMap((e) => (e.event.type === 'session.error' ? [e.event.message] : e.event.type === 'session.status' && e.event.detail ? [e.event.detail] : []));
        assert.fail(`session status is '${summary.status}', expected 'idle': ${errors.join(' | ') || 'no error events'}`);
      }
      const list = await api(base, 'GET', API.sessions, { token });
      assert.ok(z.array(SessionSummary).parse(list.body).some((s) => s.id === sessionId));
    });

    step(`streams one prompt turn over /ws (costs a few ${AGENT_ID} tokens)`, { timeout: 240_000, skip: AGENT_SKIP }, async (t) => {
      const col = new Collector();
      const client = new MideClient({
        baseUrl: base,
        token,
        clientName: 'mide-e2e',
        clientVersion: '0.0.0',
        onEvent: col.onEvent,
        onReplayDone: col.onReplayDone,
        onSessions: col.onSessions,
        onState: col.onState,
      });
      client1 = client;
      col1 = col;
      client.connect();
      await col.state('open', 10_000);
      client.watchSessionList();
      client.subscribe(sessionId, 0);
      const replay = await col.until(() => col.replays.find((r) => r.sessionId === sessionId), 'replay.done for the fresh session', 10_000);
      assert.ok(replay.lastSeq >= 1, `at least session.created + session.status exist (lastSeq ${replay.lastSeq})`);
      // The schema forbids afterSeq -1 and a fresh TimelineState sits at lastSeq -1, so afterSeq 0 is
      // inclusive: the replay must start with session.created at seq 0 (it carries the session modes).
      const created = col.events[0];
      assert.ok(created && created.seq === 0 && created.event.type === 'session.created', `afterSeq=0 replays from seq 0 (got ${JSON.stringify(created)})`);
      assert.ok(col.events.every((e) => e.sessionId === sessionId), 'only the subscribed session is streamed');
      assert.equal(col.events[col.events.length - 1]?.seq, replay.lastSeq, 'replay.done.lastSeq is the last replayed seq');
      const listed = await col.until(() => col.sessionLists.find((l) => l.some((s) => s.id === sessionId)), 'sessions.changed containing the session', 10_000);
      assert.equal(listed.find((s) => s.id === sessionId)?.agent, AGENT_ID);

      const t0 = Date.now();
      await client.prompt(sessionId, [{ type: 'text', text: PROMPT }]);
      const ended = await col.event((e) => e.event.type === 'turn.ended', 'turn.ended', 200_000);
      t.diagnostic(`turn finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

      const started = col.events.find((e) => e.event.type === 'turn.started');
      assert.ok(started && started.event.type === 'turn.started', 'turn.started was streamed');
      assert.ok(ended.event.type === 'turn.ended');
      const turnId = started.event.turnId;
      assert.equal(ended.event.turnId, turnId);
      assert.deepEqual(started.event.blocks, [{ type: 'text', text: PROMPT }]);
      const deltas = col.events.filter((e) => e.event.type === 'message.delta');
      assert.ok(deltas.length >= 1, `expected at least one message.delta, got event types ${col.events.map((e) => e.event.type).join(',')}`);
      const firstDelta = deltas[0];
      assert.ok(firstDelta);
      const iStart = col.events.indexOf(started);
      const iDelta = col.events.indexOf(firstDelta);
      const iEnd = col.events.indexOf(ended);
      assert.ok(iStart < iDelta && iDelta < iEnd, `order turn.started(${iStart}) < message.delta(${iDelta}) < turn.ended(${iEnd})`);
      for (const d of deltas) assert.ok(d.event.type === 'message.delta' && d.event.turnId === turnId, 'every delta belongs to the turn');
      for (let i = 1; i < col.events.length; i++) {
        const prev = col.events[i - 1];
        const cur = col.events[i];
        assert.ok(prev && cur && cur.seq > prev.seq, `seq must strictly increase in arrival order: ${prev?.seq} then ${cur?.seq} at index ${i}`);
      }
      if (ended.event.stopReason !== 'end_turn') {
        const errors = col.events.flatMap((e) => (e.event.type === 'session.error' ? [e.event.message] : []));
        assert.fail(`turn ended with '${ended.event.stopReason}'${errors.length ? `: ${errors.join(' | ')}` : ''}`);
      }
      const text = deltas.map((d) => (d.event.type === 'message.delta' ? d.event.text : '')).join('');
      assert.ok(text.trim().length > 0, 'assistant text must not be empty');
      if (!/pong/i.test(text)) t.diagnostic(`model did not answer PONG literally: ${JSON.stringify(text.slice(0, 200))}`);

      const idle = await col.event((e) => e.seq > ended.seq && e.event.type === 'session.status' && e.event.status === 'idle', "session.status 'idle' after turn.ended", 15_000);
      await col.until(
        () => (col.sessionLists.some((l) => l.some((s) => s.id === sessionId && s.status === 'idle' && s.lastSeq >= idle.seq)) ? true : undefined),
        'sessions.changed reflecting the idle session',
        10_000,
      );
      lastSeq = idle.seq;
      firstRun = col.events.slice();

      const r = await api(base, 'GET', API.session(sessionId), { token });
      assert.equal(r.status, 200, r.text);
      const summary = SessionSummary.parse(r.body);
      assert.equal(summary.status, 'idle');
      assert.equal(summary.lastSeq, lastSeq, 'the summary agrees with the last streamed seq');
      assert.equal(typeof summary.lastMessagePreview, 'string', 'the finished turn leaves a preview');
    });

    step('GET /api/sessions/:id/events matches the live stream exactly (dense seqs from 0)', { skip: AGENT_SKIP }, async () => {
      const all = await api(base, 'GET', API.sessionEvents(sessionId), { token });
      assert.equal(all.status, 200, all.text);
      const rows = z.array(EventEnvelope).parse(all.body);
      assert.ok(rows.length >= 5, `expected the full log (created, status, turn.started, delta, turn.ended, status), got ${rows.length} rows`);
      const first = rows[0];
      assert.ok(first && first.seq === 0 && first.event.type === 'session.created', 'the log starts with session.created at seq 0');
      if (first.event.type === 'session.created') {
        assert.equal(first.event.agent, AGENT_ID);
        assert.equal(first.event.cwd, repo);
        assert.equal(first.event.title, 'e2e session');
      }
      rows.forEach((row, i) => assert.equal(row.seq, i, 'seqs are dense'));
      assert.equal(rows[rows.length - 1]?.seq, lastSeq);
      assert.deepEqual(wire(rows), wire(firstRun), 'HTTP log == the live stream (replay from 0 + live events)');

      const explicit = await api(base, 'GET', `${API.sessionEvents(sessionId)}${qs({ after: -1 })}`, { token });
      assert.equal(explicit.status, 200, explicit.text);
      assert.deepEqual(wire(z.array(EventEnvelope).parse(explicit.body)), wire(rows), 'after=-1 is the explicit form of "from the start"');

      const after1 = await api(base, 'GET', `${API.sessionEvents(sessionId)}${qs({ after: 1 })}`, { token });
      assert.equal(after1.status, 200, after1.text);
      assert.deepEqual(wire(z.array(EventEnvelope).parse(after1.body)), wire(firstRun.filter((e) => e.seq >= 2)));

      const page = await api(base, 'GET', `${API.sessionEvents(sessionId)}${qs({ after: 1, limit: 2 })}`, { token });
      assert.equal(page.status, 200, page.text);
      assert.deepEqual(wire(z.array(EventEnvelope).parse(page.body)), wire(firstRun.filter((e) => e.seq >= 2).slice(0, 2)), 'limit paginates');
    });

    step('reconnecting with afterSeq=1 replays rows 2..lastSeq exactly', { skip: AGENT_SKIP }, async () => {
      assert.ok(client1 && col1);
      client1.close();
      await col1.state('closed', 5_000);

      const col = new Collector();
      const client = new MideClient({
        baseUrl: base,
        token,
        clientName: 'mide-e2e-2',
        clientVersion: '0.0.0',
        onEvent: col.onEvent,
        onReplayDone: col.onReplayDone,
        onSessions: col.onSessions,
        onState: col.onState,
      });
      client2 = client;
      col2 = col;
      client.subscribe(sessionId, 1);
      client.connect();
      const done = await col.until(() => col.replays.find((r) => r.sessionId === sessionId), 'replay.done after reconnect', 10_000);
      assert.equal(done.lastSeq, lastSeq);
      assert.equal(col.events[0]?.seq, 2, 'replay starts right after afterSeq');
      assert.deepEqual(wire(col.events), wire(firstRun.filter((e) => e.seq >= 2)), 'replay == rows 2..lastSeq');
    });

    step('cancel on an idle session is a clean ack error; rename is persisted and streamed live', { skip: AGENT_SKIP }, async () => {
      assert.ok(client2 && col2);
      await assert.rejects(client2.cancel(sessionId), /./, 'no running turn to cancel');

      const bad = await api(base, 'PATCH', API.session(sessionId), { token, body: { title: '' } });
      assert.equal(bad.status, 400, bad.text);

      const r = await api(base, 'PATCH', API.session(sessionId), { token, body: { title: 'renamed by e2e' } });
      assert.equal(r.status, 200, r.text);
      assert.equal(SessionSummary.parse(r.body).title, 'renamed by e2e');
      await col2.event((e) => e.event.type === 'session.renamed' && e.event.title === 'renamed by e2e', 'live session.renamed', 10_000);
      const get = await api(base, 'GET', API.session(sessionId), { token });
      assert.equal(SessionSummary.parse(get.body).title, 'renamed by e2e');
    });

    step('GET /api/health shows the agent ready after the turn', { skip: AGENT_SKIP }, async () => {
      const r = await api(base, 'GET', API.health, { token });
      assert.equal(r.status, 200, r.text);
      const h = HealthResponse.parse(r.body);
      const agent = h.agents.find((a) => a.id === AGENT_ID);
      assert.ok(agent, `agent ${AGENT_ID} in ${JSON.stringify(h.agents)}`);
      assert.equal(agent.state, 'ready', agent.detail);
      assert.ok(agent.sessions >= 1);
      assert.ok(h.sessions.total >= 1);
      assert.equal(h.sessions.running, 0);
      const infos = z.array(AgentInfo).parse((await api(base, 'GET', API.agents, { token })).body);
      assert.equal(infos.find((a) => a.id === AGENT_ID)?.available, true);
    });

    step('DELETE /api/sessions/:id closes the session and streams the final status', { timeout: 60_000, skip: AGENT_SKIP }, async () => {
      assert.ok(client2 && col2);
      const r = await api(base, 'DELETE', API.session(sessionId), { token });
      assert.ok(r.status >= 200 && r.status < 300, `delete: ${r.status} ${r.text}`);
      await col2.event((e) => e.event.type === 'session.status' && e.event.status === 'closed', "live session.status 'closed'", 15_000);
      const get = await api(base, 'GET', API.session(sessionId), { token });
      assert.equal(get.status, 200, get.text);
      assert.equal(SessionSummary.parse(get.body).status, 'closed');
      const open = z.array(SessionSummary).parse((await api(base, 'GET', API.sessions, { token })).body);
      assert.ok(!open.some((s) => s.id === sessionId), 'closed sessions are hidden by default');
      const all = z.array(SessionSummary).parse((await api(base, 'GET', `${API.sessions}?all=1`, { token })).body);
      assert.equal(all.find((s) => s.id === sessionId)?.status, 'closed');
      await assert.rejects(client2.prompt(sessionId, [{ type: 'text', text: 'should fail' }]), /./, 'prompting a closed session is rejected via ack');
      client2.close();
    });
  });
});
