import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEnvelope,
  ClientFrame,
  createTimeline,
  elicitationDefaults,
  EventEnvelope,
  TimelineEvent,
  validateElicitationContent,
  type ElicitationRequest,
  type ElicitationSchema,
} from '../src/index.js';

function env(seq: number, event: TimelineEvent, sessionId = 's1'): EventEnvelope {
  return { sessionId, seq, ts: 1000 + seq, event };
}

/** What claude-agent-acp sends for AskUserQuestion ("red or blue?"), after the daemon's normalization. */
const COLOUR_SCHEMA: ElicitationSchema = {
  properties: {
    question_0: {
      type: 'string',
      title: 'Colour',
      options: [
        { value: 'Red', title: 'Red', description: 'Warm' },
        { value: 'Blue', title: 'Blue', description: 'Cool' },
      ],
    },
    question_0_custom: { type: 'string', title: 'Other', description: 'Type your own answer instead of choosing an option above (optional).' },
  },
  required: [],
};

function request(id: string, over: Partial<ElicitationRequest> = {}): ElicitationRequest {
  return { elicitationId: id, sessionId: 's1', turnId: 'T1', mode: 'form', message: 'Red or blue?', schema: COLOUR_SCHEMA, createdAt: 1, ...over };
}

test('an elicitation parks the session in needs_you and its answer resumes the turn', () => {
  const st = createTimeline('s1');
  applyEnvelope(st, env(0, { type: 'session.created', agent: 'claude', cwd: '/tmp', title: 't' }));
  applyEnvelope(st, env(1, { type: 'turn.started', turnId: 'T1', blocks: [{ type: 'text', text: 'ask me' }] }));
  applyEnvelope(st, env(2, { type: 'tool.call', turnId: 'T1', toolCallId: 'c1', title: 'AskUserQuestion', kind: 'other', status: 'in_progress' }));
  applyEnvelope(st, env(3, { type: 'elicitation.requested', request: request('e1', { toolCallId: 'c1' }) }));
  assert.equal(st.status, 'needs_you');
  assert.equal(st.pendingElicitations.length, 1);
  assert.equal(st.pendingPermissions.length, 0);
  const item = st.items[st.elicitationIndex.e1 ?? -1];
  assert.ok(item && item.kind === 'elicitation' && item.resolved === undefined);

  applyEnvelope(st, env(4, { type: 'elicitation.resolved', elicitationId: 'e1', action: 'accept', content: { question_0: 'Blue' }, by: 'dev1' }));
  assert.equal(st.pendingElicitations.length, 0);
  assert.equal(st.status, 'running', 'the turn is still running once the question is answered');
  assert.ok(item.kind === 'elicitation');
  assert.deepEqual(item.resolved, { action: 'accept', content: { question_0: 'Blue' } });

  applyEnvelope(st, env(5, { type: 'message.delta', turnId: 'T1', text: 'You prefer blue.' }));
  applyEnvelope(st, env(6, { type: 'turn.ended', turnId: 'T1', stopReason: 'end_turn' }));
  assert.equal(st.status, 'idle');
});

test('needs_you persists while any permission or elicitation is still open; a resolution without content is recorded', () => {
  const st = createTimeline('s1');
  applyEnvelope(st, env(0, { type: 'turn.started', turnId: 'T1', blocks: [{ type: 'text', text: 'x' }] }));
  applyEnvelope(st, env(1, { type: 'elicitation.requested', request: request('e1') }));
  applyEnvelope(st, env(2, {
    type: 'permission.requested',
    request: { permissionId: 'p1', sessionId: 's1', turnId: 'T1', title: 'Run', options: [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }], createdAt: 1 },
  }));
  applyEnvelope(st, env(3, { type: 'permission.resolved', permissionId: 'p1', outcome: 'selected', optionId: 'y' }));
  assert.equal(st.status, 'needs_you', 'the elicitation is still open');
  // the turn ends while the question is unanswered (e.g. the agent gave up): the session stays parked on it
  applyEnvelope(st, env(4, { type: 'turn.ended', turnId: 'T1', stopReason: 'cancelled' }));
  assert.equal(st.status, 'needs_you');
  applyEnvelope(st, env(5, { type: 'elicitation.resolved', elicitationId: 'e1', action: 'cancel', by: 'server' }));
  assert.equal(st.status, 'idle');
  const item = st.items[st.elicitationIndex.e1 ?? -1];
  assert.ok(item && item.kind === 'elicitation');
  assert.deepEqual(item.resolved, { action: 'cancel' });
  // a resolution for an unknown id (replay window) is harmless
  applyEnvelope(st, env(6, { type: 'elicitation.resolved', elicitationId: 'nope', action: 'decline' }));
  assert.equal(st.items.filter((i) => i.kind === 'elicitation').length, 1);
});

test('url-mode requests carry the target and need no schema', () => {
  const st = createTimeline('s1');
  const req = request('u1', { mode: 'url', url: 'https://auth.example.com/connect?x=1', schema: undefined, message: 'Authorize the GitHub server' });
  applyEnvelope(st, env(0, { type: 'elicitation.requested', request: req }));
  const item = st.items[0];
  assert.ok(item && item.kind === 'elicitation' && item.request.mode === 'url' && item.request.url === req.url);
  assert.equal(st.status, 'needs_you');
});

test('validateElicitationContent enforces required fields, option membership, types and bounds', () => {
  const schema: ElicitationSchema = {
    properties: {
      colour: { type: 'string', options: [{ value: 'Red', title: 'Red' }, { value: 'Blue', title: 'Blue' }] },
      note: { type: 'string', maxLength: 5 },
      count: { type: 'integer', minimum: 1, maximum: 3 },
      ratio: { type: 'number' },
      ok: { type: 'boolean' },
      tags: { type: 'array', options: [{ value: 'a', title: 'A' }, { value: 'b', title: 'B' }], minItems: 1 },
      email: { type: 'string', format: 'email' },
    },
    required: ['colour', 'count', 'tags'],
  };
  assert.deepEqual(validateElicitationContent(schema, { colour: 'Blue', count: 2, tags: ['a'] }), {});
  assert.deepEqual(validateElicitationContent(schema, {}), { colour: 'Required', count: 'Required', tags: 'Required' });
  assert.deepEqual(validateElicitationContent(schema, { colour: 'Green', count: 2, tags: ['a'] }), { colour: 'Must be one of the offered options' });
  assert.deepEqual(validateElicitationContent(schema, { colour: 'Red', count: 2.5, tags: ['a'] }), { count: 'Must be a whole number' });
  assert.deepEqual(validateElicitationContent(schema, { colour: 'Red', count: 9, tags: ['a'] }), { count: 'Must be at most 3' });
  assert.deepEqual(validateElicitationContent(schema, { colour: 'Red', count: 1, tags: [] }), { tags: 'Required' });
  assert.deepEqual(validateElicitationContent(schema, { colour: 'Red', count: 1, tags: ['zzz'] }), { tags: 'Must be among the offered options' });
  assert.deepEqual(validateElicitationContent(schema, { colour: 'Red', count: 1, tags: ['a'], note: 'toolong' }), { note: 'At most 5 characters' });
  assert.deepEqual(validateElicitationContent(schema, { colour: 'Red', count: 1, tags: ['a'], ratio: 'x' }), { ratio: 'Must be a number' });
  assert.deepEqual(validateElicitationContent(schema, { colour: 'Red', count: 1, tags: ['a'], ok: 'yes' }), { ok: 'Must be yes or no' });
  assert.deepEqual(validateElicitationContent(schema, { colour: 'Red', count: 1, tags: ['a'], email: 'nope' }), { email: 'Must be an email address' });
  assert.deepEqual(validateElicitationContent(schema, { colour: 'Red', count: 1, tags: ['a'], extra: 1 }), { extra: 'Not a field of this form' });
  // an empty optional string is "not answered", not an error
  assert.deepEqual(validateElicitationContent(schema, { colour: 'Red', count: 1, tags: ['a'], note: '' }), {});
});

test('elicitationDefaults seeds schema defaults and gives every toggle a value', () => {
  const schema: ElicitationSchema = {
    properties: {
      a: { type: 'string', default: 'x' },
      b: { type: 'string' },
      c: { type: 'boolean' },
      d: { type: 'boolean', default: true },
      e: { type: 'array', options: [{ value: 'p', title: 'P' }], default: ['p'] },
      f: { type: 'integer', default: 2 },
    },
    required: [],
  };
  assert.deepEqual(elicitationDefaults(schema), { a: 'x', c: false, d: true, e: ['p'], f: 2 });
});

test('the wire schemas accept the new frame and events and reject malformed ones', () => {
  const frame = ClientFrame.parse({ type: 'elicitation.respond', requestId: 'r1', sessionId: 's1', elicitationId: 'e1', action: 'accept', content: { q: 'Blue', n: 2, ok: true, tags: ['a'] } });
  assert.equal(frame.type, 'elicitation.respond');
  assert.ok(!ClientFrame.safeParse({ type: 'elicitation.respond', requestId: 'r1', sessionId: 's1', elicitationId: 'e1', action: 'maybe' }).success);
  assert.ok(!ClientFrame.safeParse({ type: 'elicitation.respond', requestId: 'r1', sessionId: 's1', elicitationId: 'e1', action: 'accept', content: { q: { nested: 1 } } }).success);
  assert.ok(TimelineEvent.safeParse({ type: 'elicitation.requested', request: request('e1') }).success);
  assert.ok(!TimelineEvent.safeParse({ type: 'elicitation.requested', request: { ...request('e1'), mode: 'voice' } }).success);
  assert.ok(TimelineEvent.safeParse({ type: 'elicitation.resolved', elicitationId: 'e1', action: 'decline' }).success);
});
