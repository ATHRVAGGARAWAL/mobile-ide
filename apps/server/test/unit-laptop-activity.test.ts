import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { API, LaptopActivity, LaptopHistory } from '@mobile-ide/core';
import { LaptopActivityReader, readJsonTail } from '../src/laptop-activity.js';
import { startServer } from '../src/app.js';
import { generatePairingCode } from '../src/auth.js';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mide-activity-'));
  const root = path.join(dir, 'project'),
    codexHome = path.join(dir, '.codex'),
    claudeHome = path.join(dir, '.claude');
  const procRoot = path.join(dir, 'proc');
  for (const p of [root, codexHome, claudeHome, procRoot, path.join(codexHome, 'sessions')]) fs.mkdirSync(p, { recursive: true });
  const policy = { roots: [root], denylist: [path.join(root, 'private')] };
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, rollout_path TEXT, archived INTEGER, source TEXT)');
  const transcript = path.join(codexHome, 'sessions', `${id}.jsonl`);
  const add = (sessionId = id, cwd = root, source = 'cli', archived = 0, rollout = transcript) =>
    db
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, 'Fix the project', cwd, 1700000000, rollout, archived, source);
  const reader = (panes = '') =>
    new LaptopActivityReader({ policy, prefix: 'test', codexHome, claudeHome, procRoot, panes: async () => panes });
  return {
    dir,
    root,
    codexHome,
    claudeHome,
    procRoot,
    policy,
    transcript,
    add,
    reader,
    close: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('recent laptop index merges providers, filters project policy and internal/archived threads', async () => {
  const f = fixture();
  try {
    f.add();
    f.add(otherId, f.root, 'exec');
    f.add(otherId, path.join(f.root, 'private'));
    f.add(otherId, f.root, 'cli', 1);
    f.add(otherId, f.dir);
    fs.writeFileSync(
      path.join(f.claudeHome, 'history.jsonl'),
      [JSON.stringify({ sessionId: otherId, project: f.root, display: 'Claude task', timestamp: 1800000000000 }), '{in-flight'].join('\n'),
    );
    const result = LaptopActivity.parse(await f.reader().snapshot());
    assert.equal(result.recent.length, 2);
    assert.deepEqual(
      result.recent.map((s) => s.source),
      ['claude', 'codex'],
    );
    assert.equal(result.recent[1]?.updatedAt, 1700000000000);
    assert.deepEqual(result.warnings, []);
  } finally {
    f.close();
  }
});

test('shared terminals use selected pane cwd and original exact terminal id', async () => {
  const f = fixture();
  try {
    const panes = [
      ['test-original-folder', '100', f.root, 'codex', 'Current task', '1800000000', '1', '1'],
      ['test-original-folder', '101', f.dir, 'bash', '', '1800000000', '0', '1'],
      ['someone-else', '102', f.root, 'bash', '', '1800000000', '1', '1'],
      ['test-denied', '103', path.join(f.root, 'private'), 'bash', '', '1800000000', '1', '1'],
    ]
      .map((p) => p.join('\t'))
      .join('\n');
    const result = await f.reader(panes).snapshot();
    assert.equal(result.live.length, 1);
    assert.equal(result.live[0]?.terminalId, 'original-folder');
    assert.equal(result.live[0]?.cwd, f.root);
  } finally {
    f.close();
  }
});

test('native CLI detection deduplicates launchers and excludes shared descendants and background servers', async () => {
  const f = fixture();
  try {
    for (const [pid, parent, args] of [
      [100, 1, ['bash']],
      [101, 100, ['codex']],
      [200, 1, ['node', '/bin/codex.js']],
      [201, 200, ['/bin/codex']],
      [300, 1, ['codex', 'app-server']],
    ] as const) {
      const dir = path.join(f.procRoot, String(pid));
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'status'), `PPid:\t${parent}\n`);
      fs.writeFileSync(path.join(dir, 'cmdline'), args.join('\0'));
      fs.symlinkSync(f.root, path.join(dir, 'cwd'));
    }
    const result = await f.reader(['test-shared', '100', f.root, 'codex', '', '1800000000', '1', '1'].join('\t')).snapshot();
    assert.deepEqual(
      result.live.map((s) => s.id),
      ['terminal:shared', 'process:200'],
    );
    assert.equal(result.live[1]?.terminalId, undefined);
  } finally {
    f.close();
  }
});

test('saved messages omit tool payloads, reasoning and developer instructions; malformed lines are tolerated', () => {
  const f = fixture();
  try {
    f.add();
    fs.writeFileSync(
      f.transcript,
      [
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'private instruction' }] },
        }),
        ...['user', 'assistant'].map((role) =>
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'message', role, content: [{ type: 'output_text', text: `${role} text` }] },
          }),
        ),
        JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', content: 'reasoning' } }),
        '{partial',
      ].join('\n'),
    );
    const result = LaptopHistory.parse(f.reader().history('codex', id));
    assert.deepEqual(
      result.messages.map((m) => m.text),
      ['user text', 'assistant text'],
    );
    assert.throws(() => f.reader().history('codex', '../../private'));
  } finally {
    f.close();
  }
});

test('transcript paths cannot escape provider storage through a symlink', () => {
  const f = fixture();
  try {
    const outside = path.join(f.dir, 'outside.jsonl');
    fs.writeFileSync(
      outside,
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'must not leak' } }),
    );
    fs.symlinkSync(outside, f.transcript);
    f.add();
    assert.deepEqual(f.reader().history('codex', id).messages, []);
  } finally {
    f.close();
  }
});

test('Claude fallback shows prompts when transcripts are missing and deduplicates session cards', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      path.join(f.claudeHome, 'history.jsonl'),
      ['first', 'last']
        .map((display, i) =>
          JSON.stringify({
            sessionId: id,
            project: f.root,
            display,
            timestamp: 1700000000000 + i,
          }),
        )
        .join('\n'),
    );
    assert.equal((await f.reader().snapshot()).recent.length, 1);
    assert.deepEqual(
      f
        .reader()
        .history('claude', id)
        .messages.map((m) => m.text),
      ['first', 'last'],
    );
  } finally {
    f.close();
  }
});

test('bounded log tails recover complete messages after a very large record', () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      f.transcript,
      JSON.stringify({ large: 'x'.repeat(3 * 1024 * 1024) }) + '\n' + JSON.stringify({ good: true }) + '\n{partial',
    );
    assert.deepEqual(readJsonTail(f.transcript), [{ good: true }]);
  } finally {
    f.close();
  }
});

test('activity routes require auth and never include projects outside configured roots', async () => {
  const f = fixture();
  const server = await startServer({ home: path.join(f.dir, 'daemon'), overrides: {
    port: 0, agents: {}, projects: f.policy,
    terminal: { shell: '$SHELL', tmuxPrefix: `activity-test-${process.pid}`, autoOpen: false },
    studio: { autoOpen: false, browser: null, dir: null, windowSize: '1200x800' },
  } });
  try {
    assert.equal((await fetch(server.url + API.activity)).status, 401);
    assert.equal((await fetch(server.url + API.laptopHistory)).status, 401);
    const code = generatePairingCode();
    server.ctx.db.createPairingCode(code);
    const pair = await fetch(server.url + API.pair, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'activity test', platform: 'test' }),
    });
    const { token } = (await pair.json()) as { token: string };
    const response = await fetch(server.url + API.activity, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = LaptopActivity.parse(await response.json());
    assert.deepEqual(result.recent, []);
    assert.deepEqual(result.live, []);
  } finally {
    await server.close({ drainMs: 0, cancelTurns: true });
    f.close();
  }
});

test('Claude transcript includes text replies and excludes tool results and sidechains', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.claudeHome, 'history.jsonl'), JSON.stringify({ sessionId: id, project: f.root, display: 'prompt', timestamp: 1700000000000 }));
    const dir = path.join(f.claudeHome, 'projects', f.root.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
      { type: 'user', message: { role: 'user', content: 'question' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }, { type: 'thinking', text: 'omit' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'omit' }] } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: 'omit' } },
    ].map((r) => JSON.stringify(r)).join('\n'));
    assert.deepEqual(f.reader().history('claude', id).messages.map((m) => m.text), ['question', 'reply']);
  } finally { f.close(); }
});

test('one unsupported provider index does not prevent live terminals or other provider history', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.codexHome, 'state_99.sqlite'), 'invalid sqlite');
    fs.writeFileSync(path.join(f.claudeHome, 'history.jsonl'), JSON.stringify({ sessionId: id, project: f.root, display: 'prompt', timestamp: 1700000000000 }));
    const result = await f.reader(['test-shared', '100', f.root, 'bash', '', '1800000000', '1', '1'].join('\t')).snapshot();
    assert.equal(result.warnings.length, 1);
    assert.equal(result.recent[0]?.source, 'claude');
    assert.equal(result.live[0]?.terminalId, 'shared');
  } finally { f.close(); }
});
