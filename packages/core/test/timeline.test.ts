import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEnvelope, createTimeline, EventEnvelope, TimelineEvent } from '../src/index.js';

function env(seq: number, event: TimelineEvent, sessionId = 's1'): EventEnvelope {
  return { sessionId, seq, ts: 1000 + seq, event };
}

test('streams text into one bubble and closes it on turn end', () => {
  const st = createTimeline('s1');
  applyEnvelope(st, env(0, { type: 'session.created', agent: 'opencode', cwd: '/tmp', title: 't' }));
  applyEnvelope(st, env(1, { type: 'turn.started', turnId: 'T1', blocks: [{ type: 'text', text: 'hi' }] }));
  applyEnvelope(st, env(2, { type: 'message.delta', turnId: 'T1', text: 'Hel' }));
  applyEnvelope(st, env(3, { type: 'message.delta', turnId: 'T1', text: 'lo' }));
  applyEnvelope(st, env(4, { type: 'turn.ended', turnId: 'T1', stopReason: 'end_turn' }));
  const a = st.items.find((i) => i.kind === 'assistant');
  assert.ok(a && a.kind === 'assistant');
  assert.equal(a.text, 'Hello');
  assert.equal(a.streaming, false);
  assert.equal(st.status, 'idle');
  assert.equal(st.lastSeq, 4);
});

test('ignores duplicate and out-of-order seqs (replay overlap)', () => {
  const st = createTimeline('s1');
  applyEnvelope(st, env(0, { type: 'turn.started', turnId: 'T1', blocks: [{ type: 'text', text: 'x' }] }));
  applyEnvelope(st, env(1, { type: 'message.delta', turnId: 'T1', text: 'a' }));
  applyEnvelope(st, env(1, { type: 'message.delta', turnId: 'T1', text: 'a' }));
  applyEnvelope(st, env(0, { type: 'message.delta', turnId: 'T1', text: 'zzz' }));
  const a = st.items.find((i) => i.kind === 'assistant');
  assert.ok(a && a.kind === 'assistant' && a.text === 'a');
});

test('tool call updates merge in place and permissions track status', () => {
  const st = createTimeline('s1');
  applyEnvelope(st, env(0, { type: 'turn.started', turnId: 'T1', blocks: [{ type: 'text', text: 'x' }] }));
  applyEnvelope(st, env(1, { type: 'tool.call', turnId: 'T1', toolCallId: 'c1', title: 'Run', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }));
  applyEnvelope(st, env(2, {
    type: 'permission.requested',
    request: { permissionId: 'p1', sessionId: 's1', turnId: 'T1', toolCallId: 'c1', title: 'Run', options: [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }], createdAt: 1 },
  }));
  assert.equal(st.status, 'needs_you');
  assert.equal(st.pendingPermissions.length, 1);
  applyEnvelope(st, env(3, { type: 'permission.resolved', permissionId: 'p1', outcome: 'selected', optionId: 'y' }));
  assert.equal(st.pendingPermissions.length, 0);
  assert.equal(st.status, 'running');
  applyEnvelope(st, env(4, { type: 'tool.update', turnId: 'T1', toolCallId: 'c1', status: 'completed', rawOutput: 'a\nb' }));
  const t = st.items.find((i) => i.kind === 'tool');
  assert.ok(t && t.kind === 'tool' && t.status === 'completed' && t.rawOutput === 'a\nb');
  assert.equal(st.items.filter((i) => i.kind === 'tool').length, 1);
});

test('a permission-gated tool waits for approval, starts at the approval, and keeps the diff only the request carried', () => {
  // the exact shapes OpenCode produces for `write` with permission.edit = 'ask' (recorded in the round-3 QA run)
  const st = createTimeline('s1');
  const file = '/tmp/repo/hello.txt';
  const diff = { type: 'diff' as const, path: file, oldText: '', newText: 'hello\n' };
  applyEnvelope(st, env(0, { type: 'turn.started', turnId: 'T1', blocks: [{ type: 'text', text: 'create hello.txt' }] }));
  applyEnvelope(st, env(1, { type: 'tool.call', turnId: 'T1', toolCallId: 'w1', title: 'write', kind: 'edit', status: 'pending', locations: [], rawInput: {} }));
  applyEnvelope(st, env(2, { type: 'tool.update', turnId: 'T1', toolCallId: 'w1', status: 'in_progress', locations: [{ path: file }], rawInput: { filePath: file, content: 'hello\n' } }));
  const tool = st.items.find((i) => i.kind === 'tool');
  assert.ok(tool && tool.kind === 'tool');
  assert.equal(tool.awaitingPermission, undefined, 'nothing gates the call yet');

  applyEnvelope(st, env(3, {
    type: 'permission.requested',
    request: { permissionId: 'p1', sessionId: 's1', turnId: 'T1', toolCallId: 'w1', title: file, kind: 'edit', rawInput: { filepath: file, diff: '@@ -0,0 +1,1 @@\n+hello\n' }, content: [diff], options: [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }], createdAt: 1 },
  }));
  assert.equal(tool.awaitingPermission, true, 'the card shows "waiting for approval" while the request is open');
  assert.deepEqual(tool.content, [diff], 'the diff that only the permission request carried shows on the tool card');
  assert.equal(tool.startedTs, undefined);

  applyEnvelope(st, env(4, { type: 'permission.resolved', permissionId: 'p1', outcome: 'selected', optionId: 'y' }));
  assert.equal(tool.awaitingPermission, false);
  assert.equal(tool.startedTs, 1004, 'the run time counts from the approval, not from the tool.call');

  // OpenCode's completion replaces `content` with a text block: the diff must survive that
  const done = { type: 'content' as const, content: { type: 'text' as const, text: 'Wrote file successfully.' } };
  applyEnvelope(st, env(5, { type: 'tool.update', turnId: 'T1', toolCallId: 'w1', title: 'hello.txt', status: 'completed', content: [done], rawOutput: 'Wrote file successfully.' }));
  assert.equal(tool.status, 'completed');
  assert.deepEqual(tool.content, [diff, done]);
  assert.equal(tool.endedTs, 1005);

  // a tool call that brings its own diff (claude-agent-acp Edit) is left alone, and a request that lands first still gates it
  applyEnvelope(st, env(6, {
    type: 'permission.requested',
    request: { permissionId: 'p2', sessionId: 's1', turnId: 'T1', toolCallId: 'e2', title: 'Edit', kind: 'edit', content: [diff], options: [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }], createdAt: 1 },
  }));
  const own = { type: 'diff' as const, path: file, oldText: 'hello\n', newText: 'hello world\n' };
  applyEnvelope(st, env(7, { type: 'tool.call', turnId: 'T1', toolCallId: 'e2', title: 'Edit', kind: 'edit', status: 'pending', content: [own] }));
  const edit = st.items[st.toolIndex.e2 ?? -1];
  assert.ok(edit && edit.kind === 'tool');
  assert.equal(edit.awaitingPermission, true, 'a request that arrived before the tool.call still marks it as waiting');
  assert.deepEqual(edit.content, [own], 'the call already carries a diff: nothing is borrowed');
  applyEnvelope(st, env(8, { type: 'permission.resolved', permissionId: 'p2', outcome: 'selected', optionId: 'y' }));
  assert.equal(edit.awaitingPermission, false);
  assert.equal(edit.startedTs, 1008);
});
