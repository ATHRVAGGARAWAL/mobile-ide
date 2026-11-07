/**
 * Unit tests (no daemon, no agent):
 *  - ACP `session/update` normalization on realistic payloads (typed against the SDK schema)
 *  - permission request mapping
 *  - path policy: traversal, symlink escapes, denylist, prefix collisions
 *  - token / pairing-code hashing and constant-time compare, incl. the Db round-trip
 *  - bearer token extraction from headers, query and WebSocket subprotocols
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { RequestPermissionRequest, SessionUpdate, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';
import {
  PermissionRequest as PermissionRequestSchema,
  TimelineEvent as TimelineEventSchema,
  WS_AUTH_SUBPROTOCOL_PREFIX,
  type TimelineEvent,
} from '@mobile-ide/core';
import {
  contentBlock,
  findModelValue,
  modelFromConfigOptions,
  normalizeUpdate,
  permissionRequest,
  stopReason,
  toolContent,
  usageFromPrompt,
} from '../src/agents/normalize.js';
import {
  generatePairingCode,
  generateToken,
  hashPairingCode,
  hashToken,
  hashesEqual,
  normalizePairingCode,
  PAIRING_CODE_TTL_MS,
} from '../src/auth.js';
import { authenticate, credentialsFromRequest, extractToken, selectedSubprotocol } from '../src/authn.js';
import { Db } from '../src/db.js';
import { ForbiddenError, HttpError } from '../src/errors.js';
import { setLogSink } from '../src/log.js';
import { buildPolicy, displayPath, isInside, realpathLenient, resolveRoot, resolveUnder } from '../src/paths.js';
import { rmrf, tmpDir } from './helpers.js';

setLogSink(() => {
  /* keep test output clean; nothing here should log anyway */
});

const TURN = { turnId: 'turn-1' };

/** Normalize and, when an event comes back, prove it is a valid core TimelineEvent on the wire. */
function norm(update: SessionUpdate | unknown): TimelineEvent | null {
  const ev = normalizeUpdate(update, TURN);
  if (ev !== null) assert.deepEqual(TimelineEventSchema.parse(JSON.parse(JSON.stringify(ev))), ev, 'normalized event must round-trip through the core schema');
  return ev;
}

function expectForbidden(fn: () => unknown, messagePart?: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ForbiddenError, `expected ForbiddenError, got ${String(err)}`);
    assert.ok(err instanceof HttpError && err.status === 403);
    assert.equal(err.code, 'forbidden');
    if (messagePart) assert.match(err.message, messagePart);
    return true;
  });
}

// ===================================================================== normalization
describe('normalizeUpdate: streaming chunks', () => {
  it('agent_message_chunk text -> message.delta', () => {
    const update: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello, ' } };
    assert.deepEqual(norm(update), { type: 'message.delta', turnId: 'turn-1', text: 'Hello, ' });
  });

  it('drops empty text chunks (they would only churn the client)', () => {
    const update: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } };
    assert.equal(norm(update), null);
  });

  it('agent_message_chunk image -> inline markdown image', () => {
    const update: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } };
    const ev = norm(update);
    assert.ok(ev && ev.type === 'message.delta');
    assert.match(ev.text, /!\[image\]\(data:image\/png;base64,AAAA\)/);
  });

  it('agent_message_chunk resource_link / audio become short markers', () => {
    const link: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', uri: 'file:///repo/a.ts', name: 'a.ts' } };
    assert.deepEqual(norm(link), { type: 'message.delta', turnId: 'turn-1', text: '[a.ts](file:///repo/a.ts)' });
    const audio: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' } };
    assert.deepEqual(norm(audio), { type: 'message.delta', turnId: 'turn-1', text: '[audio]' });
  });

  it('agent_thought_chunk -> thought.delta', () => {
    const update: SessionUpdate = { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' }, messageId: 'm1' };
    assert.deepEqual(norm(update), { type: 'thought.delta', turnId: 'turn-1', text: 'thinking…' });
  });

  it('user_message_chunk (session/load replay) -> synthesized turn.started', () => {
    const update: SessionUpdate = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fix the bug' } };
    assert.deepEqual(norm(update), { type: 'turn.started', turnId: 'turn-1', blocks: [{ type: 'text', text: 'fix the bug' }] });
  });

  it('embedded text resources are flattened into a text block', () => {
    const block = contentBlock({ type: 'resource', resource: { uri: 'file:///repo/README.md', text: '# hi', mimeType: 'text/markdown' } });
    assert.deepEqual(block, { type: 'text', text: '`file:///repo/README.md`\n\n# hi' });
  });
});

describe('normalizeUpdate: tool calls', () => {
  it('tool_call with a diff (claude-agent-acp Edit) -> tool.call with DiffContent, locations and rawInput', () => {
    const rawInput = { file_path: '/repo/src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' };
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'toolu_01',
      title: 'Edit src/a.ts',
      kind: 'edit',
      status: 'pending',
      content: [{ type: 'diff', path: '/repo/src/a.ts', oldText: 'const a = 1;\n', newText: 'const a = 2;\n' }],
      locations: [{ path: '/repo/src/a.ts', line: 1 }],
      rawInput,
    };
    const ev = norm(update);
    assert.deepEqual(ev, {
      type: 'tool.call',
      turnId: 'turn-1',
      toolCallId: 'toolu_01',
      title: 'Edit src/a.ts',
      kind: 'edit',
      status: 'pending',
      content: [{ type: 'diff', path: '/repo/src/a.ts', oldText: 'const a = 1;\n', newText: 'const a = 2;\n' }],
      locations: [{ path: '/repo/src/a.ts', line: 1 }],
      rawInput,
    });
  });

  it('diff without oldText is a new file (oldText: null)', () => {
    assert.deepEqual(toolContent({ type: 'diff', path: '/repo/new.ts', newText: 'x' }), { type: 'diff', path: '/repo/new.ts', oldText: null, newText: 'x' });
    assert.deepEqual(toolContent({ type: 'diff', path: '/repo/new.ts', oldText: null, newText: 'x' }), { type: 'diff', path: '/repo/new.ts', oldText: null, newText: 'x' });
    assert.equal(toolContent({ type: 'diff', path: '/repo/new.ts' }), null, 'a diff without newText is unusable');
  });

  it('tool_call defaults: unknown kind -> other, missing status -> pending, name used when title is absent', () => {
    const minimal: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Run tests' };
    const ev = norm(minimal);
    assert.deepEqual(ev, { type: 'tool.call', turnId: 'turn-1', toolCallId: 'c1', title: 'Run tests', kind: 'other', status: 'pending' });
    assert.ok(ev && !('content' in ev) && !('locations' in ev) && !('rawInput' in ev), 'optional keys must be absent, not undefined');

    const odd = norm({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'x', kind: 'teleport' as ToolKind, status: 'weird' as ToolCallStatus });
    assert.ok(odd && odd.type === 'tool.call' && odd.kind === 'other' && odd.status === 'pending');

    const named = norm({ sessionUpdate: 'tool_call', toolCallId: 'c3', name: 'bash' } as unknown);
    assert.ok(named && named.type === 'tool.call' && named.title === 'bash');
    const untitled = norm({ sessionUpdate: 'tool_call', toolCallId: 'c4' } as unknown);
    assert.ok(untitled && untitled.type === 'tool.call' && untitled.title === 'Tool call');
  });

  it('tool_call terminal + content blocks are kept, malformed content entries are dropped', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'c5',
      title: 'pnpm test',
      kind: 'execute',
      status: 'in_progress',
      content: [
        { type: 'terminal', terminalId: 'term_1' },
        { type: 'content', content: { type: 'text', text: 'running…' } },
        { type: 'content', content: { type: 'audio', mimeType: 'audio/wav', data: '' } },
        { type: 'diff', path: '/x' } as unknown as { type: 'diff'; path: string; newText: string },
      ],
      locations: [{ path: '/repo/a.ts', line: null }, { path: '/repo/b.ts', line: 7 }, { line: 3 } as unknown as { path: string }],
      rawInput: { command: 'pnpm test' },
    };
    const ev = norm(update);
    assert.ok(ev && ev.type === 'tool.call');
    assert.deepEqual(ev.content, [
      { type: 'terminal', terminalId: 'term_1' },
      { type: 'content', content: { type: 'text', text: 'running…' } },
      { type: 'content', content: { type: 'text', text: '[audio]' } },
    ]);
    assert.deepEqual(ev.locations, [{ path: '/repo/a.ts' }, { path: '/repo/b.ts', line: 7 }]);
    assert.equal(ev.kind, 'execute');
    assert.equal(ev.status, 'in_progress');
  });

  it('tool_call without toolCallId is unusable -> null', () => {
    assert.equal(norm({ sessionUpdate: 'tool_call', title: 'no id' } as unknown), null);
  });

  it('tool_call_update carries only the changed fields; null raw values are dropped', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_01',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      rawOutput: { stdout: 'ok\n', exitCode: 0 },
    };
    const ev = norm(update);
    assert.deepEqual(ev, {
      type: 'tool.update',
      turnId: 'turn-1',
      toolCallId: 'toolu_01',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      rawOutput: { stdout: 'ok\n', exitCode: 0 },
    });
    assert.ok(ev && !('title' in ev) && !('kind' in ev) && !('rawInput' in ev));

    const nulls: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_01', rawInput: null, rawOutput: null, content: null, locations: null, title: null, kind: null, status: null };
    assert.deepEqual(norm(nulls), { type: 'tool.update', turnId: 'turn-1', toolCallId: 'toolu_01' });

    const odd = norm({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_01', title: 'Edit', kind: 'teleport' as ToolKind, status: 'weird' as ToolCallStatus });
    assert.deepEqual(odd, { type: 'tool.update', turnId: 'turn-1', toolCallId: 'toolu_01', title: 'Edit', kind: 'other', status: 'in_progress' });

    assert.equal(norm({ sessionUpdate: 'tool_call_update', status: 'completed' } as unknown), null);
  });
});

describe('normalizeUpdate: plans, commands, modes, misc', () => {
  it('plan -> plan with every entry; malformed entries are sanitized or skipped', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the failing test', priority: 'high', status: 'completed' },
        { content: 'Patch the reducer', priority: 'medium', status: 'in_progress' },
        { content: 'Run the suite', priority: 'low', status: 'pending' },
      ],
    };
    assert.deepEqual(norm(update), {
      type: 'plan',
      turnId: 'turn-1',
      entries: [
        { content: 'Read the failing test', priority: 'high', status: 'completed' },
        { content: 'Patch the reducer', priority: 'medium', status: 'in_progress' },
        { content: 'Run the suite', priority: 'low', status: 'pending' },
      ],
    });
    const messy = norm({ sessionUpdate: 'plan', entries: [{ content: 'ok', priority: 'urgent', status: 'done' }, 'nope', { priority: 'high' }, null] } as unknown);
    assert.deepEqual(messy, { type: 'plan', turnId: 'turn-1', entries: [{ content: 'ok', priority: 'medium', status: 'pending' }] });
    assert.deepEqual(norm({ sessionUpdate: 'plan' } as unknown), { type: 'plan', turnId: 'turn-1', entries: [] });
  });

  it('plan_update (items / markdown) and plan_removed', () => {
    const items: SessionUpdate = {
      sessionUpdate: 'plan_update',
      plan: { type: 'items', planId: 'p1', entries: [{ content: 'step', priority: 'high', status: 'pending' }] },
    };
    assert.deepEqual(norm(items), { type: 'plan', turnId: 'turn-1', entries: [{ content: 'step', priority: 'high', status: 'pending' }] });
    const md: SessionUpdate = { sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'p1', content: '# Plan\n- do it' } };
    assert.deepEqual(norm(md), { type: 'plan', turnId: 'turn-1', entries: [{ content: '# Plan\n- do it', priority: 'medium', status: 'in_progress' }] });
    const removed: SessionUpdate = { sessionUpdate: 'plan_removed', planId: 'p1' };
    assert.deepEqual(norm(removed), { type: 'plan', turnId: 'turn-1', entries: [] });
  });

  it('available_commands_update -> commands.updated (input hint flattened)', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'compact', description: 'Compact the conversation', input: null },
        { name: 'model', description: 'Switch model', input: { hint: '<model>' } },
      ],
    };
    assert.deepEqual(norm(update), {
      type: 'commands.updated',
      commands: [
        { name: 'compact', description: 'Compact the conversation' },
        { name: 'model', description: 'Switch model', input: '<model>' },
      ],
    });
    assert.deepEqual(norm({ sessionUpdate: 'available_commands_update' } as unknown), { type: 'commands.updated', commands: [] });
  });

  it('current_mode_update -> mode.changed; session_info_update title -> session.renamed', () => {
    const mode: SessionUpdate = { sessionUpdate: 'current_mode_update', currentModeId: 'plan' };
    assert.deepEqual(norm(mode), { type: 'mode.changed', modeId: 'plan' });
    const renamed: SessionUpdate = { sessionUpdate: 'session_info_update', title: 'Fix flaky test', updatedAt: '2026-09-03T00:00:00Z' };
    assert.deepEqual(norm(renamed), { type: 'session.renamed', title: 'Fix flaky test' });
    const noTitle: SessionUpdate = { sessionUpdate: 'session_info_update', title: null, updatedAt: '2026-09-03T00:00:00Z' };
    assert.equal(norm(noTitle), null);
  });

  it('updates the timeline does not display are ignored, as is garbage', () => {
    const usage: SessionUpdate = { sessionUpdate: 'usage_update', used: 1200, size: 200_000 };
    assert.equal(norm(usage), null);
    const config: SessionUpdate = { sessionUpdate: 'config_option_update', configOptions: [] };
    assert.equal(norm(config), null);
    assert.equal(norm({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'started' } as unknown), null);
    assert.equal(norm({ sessionUpdate: 'something_new' } as unknown), null);
    assert.equal(norm('garbage'), null);
    assert.equal(norm(null), null);
    assert.equal(norm(undefined), null);
    assert.equal(norm([]), null);
  });
});

describe('permission requests, stop reasons, usage, model options', () => {
  it('maps a RequestPermissionRequest with all four option kinds, keeping rawInput verbatim', () => {
    const rawInput = { command: 'rm -rf dist', description: 'Clean build output' };
    const params: RequestPermissionRequest = {
      sessionId: 'acp-session-9',
      toolCall: {
        toolCallId: 'toolu_02',
        title: 'Run rm -rf dist',
        kind: 'execute',
        status: 'pending',
        rawInput,
        content: [{ type: 'content', content: { type: 'text', text: 'rm -rf dist' } }],
        locations: [{ path: '/repo/dist' }],
      },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        { optionId: 'reject_always', name: 'Never', kind: 'reject_always' },
      ],
    };
    const req = permissionRequest(params, { permissionId: 'perm-1', sessionId: 'our-session', turnId: 'turn-1', createdAt: 1234 });
    assert.deepEqual(PermissionRequestSchema.parse(JSON.parse(JSON.stringify(req))), req);
    assert.deepEqual(req, {
      permissionId: 'perm-1',
      sessionId: 'our-session',
      turnId: 'turn-1',
      title: 'Run rm -rf dist',
      options: params.options,
      createdAt: 1234,
      toolCallId: 'toolu_02',
      kind: 'execute',
      rawInput,
      content: [{ type: 'content', content: { type: 'text', text: 'rm -rf dist' } }],
      locations: [{ path: '/repo/dist' }],
    });
    assert.equal(req.sessionId, 'our-session', 'the daemon session id, never the ACP one');
  });

  it('synthesizes allow/reject when the agent offers no options; sanitizes odd options', () => {
    const none = permissionRequest({ sessionId: 'x', toolCall: { toolCallId: 't' }, options: [] }, { permissionId: 'p', sessionId: 's', turnId: 't', createdAt: 1 });
    assert.deepEqual(none.options, [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ]);
    const odd = permissionRequest(
      { sessionId: 'x', toolCall: { toolCallId: 't', rawInput: null, content: [] }, options: [{ optionId: 'y', kind: 'maybe' }, { name: 'no id' }, 42] },
      { permissionId: 'p', sessionId: 's', turnId: 't', createdAt: 1 },
    );
    assert.deepEqual(odd.options, [{ optionId: 'y', name: 'y', kind: 'allow_once' }]);
    assert.ok(!('rawInput' in odd) && !('content' in odd) && !('locations' in odd) && !('kind' in odd));
    const empty = permissionRequest({}, { permissionId: 'p', sessionId: 's', turnId: 't', createdAt: 1 });
    assert.equal(empty.title, 'Permission required');
    assert.ok(!('toolCallId' in empty));
    PermissionRequestSchema.parse(JSON.parse(JSON.stringify(empty)));
  });

  it('stopReason maps every ACP value and defaults to end_turn', () => {
    for (const r of ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const) assert.equal(stopReason(r), r);
    assert.equal(stopReason('something_else'), 'end_turn');
    assert.equal(stopReason(undefined), 'end_turn');
  });

  it('usageFromPrompt keeps only finite numbers', () => {
    assert.deepEqual(usageFromPrompt({ inputTokens: 10, outputTokens: 5 }), { inputTokens: 10, outputTokens: 5 });
    assert.deepEqual(usageFromPrompt({ inputTokens: 10 }), { inputTokens: 10 });
    assert.equal(usageFromPrompt({ inputTokens: Number.NaN }), undefined);
    assert.equal(usageFromPrompt({}), undefined);
    assert.equal(usageFromPrompt('x'), undefined);
  });

  it('model config options: current model, flattened groups, lookup by id or name', () => {
    const configOptions = [
      {
        type: 'select',
        id: 'model',
        category: 'model',
        currentValue: 'anthropic/claude-opus-5',
        options: [
          { name: 'Anthropic', options: [{ value: 'anthropic/claude-opus-5', name: 'Claude Opus 5' }, { value: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5' }] },
          { value: 'openai/gpt-5', name: 'GPT-5' },
        ],
      },
      { type: 'boolean', id: 'thinking', currentValue: true },
    ];
    assert.deepEqual(
      modelFromConfigOptions(configOptions),
      { current: 'Claude Opus 5', all: ['Claude Opus 5', 'Claude Haiku 4.5', 'GPT-5'] },
      'flat (ungrouped) select options must be listed too — in normalize.ts the `else flat.push(o)` binds to the inner `if (isRec(g))`, so wrap the flattening `for` in braces',
    );
    assert.deepEqual(modelFromConfigOptions([]), { all: [] });
    assert.deepEqual(modelFromConfigOptions('nope'), { all: [] });
    assert.deepEqual(findModelValue(configOptions, 'Claude Haiku 4.5'), { configId: 'model', value: 'anthropic/claude-haiku-4-5' });
    assert.deepEqual(findModelValue(configOptions, 'openai/gpt-5'), { configId: 'model', value: 'openai/gpt-5' }, 'flat options are found by value id (same dangling-else bug as modelFromConfigOptions)');
    assert.equal(findModelValue(configOptions, 'nonexistent'), null);
  });
});

// ===================================================================== path policy
describe('path policy', () => {
  let base: string;
  let allowed: string;
  let repo: string;
  let outside: string;
  let policy: ReturnType<typeof buildPolicy>;

  before(() => {
    base = tmpDir('mide-paths-');
    allowed = path.join(base, 'projects');
    repo = path.join(allowed, 'repo');
    outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export {};\n');
    fs.mkdirSync(path.join(repo, 'private'));
    fs.writeFileSync(path.join(repo, 'private', 'notes.txt'), 'private\n');
    fs.mkdirSync(path.join(allowed, '.secrets'));
    fs.writeFileSync(path.join(allowed, '.secrets', 'key'), 'k\n');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'file.txt'), 'outside\n');
    fs.mkdirSync(`${allowed}-evil`);
    fs.symlinkSync(path.join(outside, 'file.txt'), path.join(repo, 'link-out'));
    fs.symlinkSync(path.join(repo, 'src'), path.join(repo, 'link-in'));
    policy = buildPolicy([allowed], [path.join(allowed, '.secrets'), path.join(repo, 'private')]);
  });

  after(() => rmrf(base));

  it('isInside is a real ancestor test, not a string prefix test', () => {
    assert.equal(isInside('/a/b', '/a/b'), true);
    assert.equal(isInside('/a/b', '/a/b/c/d'), true);
    assert.equal(isInside('/a/b', '/a/bc'), false);
    assert.equal(isInside('/a/b', '/a'), false);
    assert.equal(isInside('/a/b', '/a/b/../c'), false);
    assert.equal(isInside('/a/b', '/x/y'), false);
    assert.equal(isInside('/a/b', '/a/b/..foo'), true, "a child literally named '..foo' is inside — compare against '..' and '../', not the string prefix '..'");
    assert.equal(isInside('/a/b', '/a/b/..'), false);
  });

  it('buildPolicy realpaths and expands ~', () => {
    assert.deepEqual(policy.roots, [fs.realpathSync(allowed)]);
    assert.equal(policy.denylist.length, 2);
    const home = buildPolicy(['~/'], ['~/.ssh']);
    assert.ok(path.isAbsolute(home.roots[0] ?? ''));
    assert.ok(!home.roots[0]?.includes('~'));
    assert.ok(home.denylist[0]?.endsWith('.ssh'));
  });

  it('resolveRoot accepts roots inside the allowed set', () => {
    assert.equal(resolveRoot(policy, repo), fs.realpathSync(repo));
    assert.equal(resolveRoot(policy, allowed), fs.realpathSync(allowed), 'the allowed root itself is a valid project root');
    assert.equal(resolveRoot(policy, `${repo}/src/..`), fs.realpathSync(repo), 'normalized before checking');
    assert.equal(resolveRoot(policy, `  ${repo}  `), fs.realpathSync(repo), 'whitespace trimmed');
  });

  it('resolveRoot rejects outside, sibling-prefix, denylisted, traversal and empty roots', () => {
    expectForbidden(() => resolveRoot(policy, outside), /outside the allowed/);
    expectForbidden(() => resolveRoot(policy, `${allowed}-evil`), /outside the allowed/);
    expectForbidden(() => resolveRoot(policy, path.join(allowed, '.secrets')), /denylisted/);
    expectForbidden(() => resolveRoot(policy, path.join(repo, 'private')), /denylisted/);
    expectForbidden(() => resolveRoot(policy, `${repo}/../../outside`), /outside the allowed/);
    expectForbidden(() => resolveRoot(policy, '/'), /outside the allowed/);
    expectForbidden(() => resolveRoot(policy, ''), /root required/);
    expectForbidden(() => resolveRoot(policy, '   '), /root required/);
    expectForbidden(() => resolveRoot(policy, undefined as unknown as string), /root required/);
  });

  it('resolveUnder keeps paths inside the root', () => {
    const root = resolveRoot(policy, repo);
    assert.equal(resolveUnder(policy, root, 'src/index.ts'), path.join(root, 'src', 'index.ts'));
    assert.equal(resolveUnder(policy, root, '/src/index.ts'), path.join(root, 'src', 'index.ts'), 'leading slashes are stripped, not treated as absolute');
    assert.equal(resolveUnder(policy, root, '///src/index.ts'), path.join(root, 'src', 'index.ts'));
    assert.equal(resolveUnder(policy, root, undefined), root);
    assert.equal(resolveUnder(policy, root, ''), root);
    assert.equal(resolveUnder(policy, root, '.'), root);
    assert.equal(resolveUnder(policy, root, 'src/../src/./index.ts'), path.join(root, 'src', 'index.ts'));
    assert.equal(resolveUnder(policy, root, 'does/not/exist.txt'), path.join(root, 'does', 'not', 'exist.txt'), 'missing leaves are tolerated');
    assert.equal(resolveUnder(policy, root, 'link-in/index.ts'), path.join(root, 'src', 'index.ts'), 'symlinks inside the root resolve to their target');
  });

  it('resolveUnder rejects traversal, symlink escapes and denylisted paths', () => {
    const root = resolveRoot(policy, repo);
    expectForbidden(() => resolveUnder(policy, root, '../outside/file.txt'), /escapes root/);
    expectForbidden(() => resolveUnder(policy, root, 'src/../../../outside/file.txt'), /escapes root/);
    expectForbidden(() => resolveUnder(policy, root, '..'), /escapes root/);
    expectForbidden(() => resolveUnder(policy, root, 'link-out'), /symlink/);
    expectForbidden(() => resolveUnder(policy, root, 'private/notes.txt'), /denylisted/);
    expectForbidden(() => resolveUnder(policy, root, 'private'), /denylisted/);
    expectForbidden(() => resolveUnder(policy, root, '../.secrets/key'), /escapes root/);
  });

  it('percent-encoded traversal is not decoded here (that is the HTTP layer): it is an odd file name inside the root', () => {
    const root = resolveRoot(policy, repo);
    const p = resolveUnder(policy, root, '..%2F..%2Foutside');
    assert.equal(p, path.join(root, '..%2F..%2Foutside'), "a name starting with '..' is not a traversal — see the isInside prefix check");
  });

  it('displayPath and realpathLenient', () => {
    const root = resolveRoot(policy, repo);
    assert.equal(displayPath(root, path.join(root, 'src', 'index.ts')), 'src/index.ts');
    assert.equal(displayPath(root, root), '');
    assert.equal(realpathLenient(path.join(repo, 'missing', 'leaf.txt')), path.join(fs.realpathSync(repo), 'missing', 'leaf.txt'));
    assert.equal(realpathLenient(path.join(repo, 'link-in', 'nope.ts')), path.join(fs.realpathSync(repo), 'src', 'nope.ts'), 'follows existing symlinked ancestors');
  });
});

// ===================================================================== tokens & hashing
describe('tokens, pairing codes, hashing', () => {
  it('generateToken: 32 random bytes as base64url', () => {
    const t = generateToken();
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(t, 'base64url').length, 32);
    assert.notEqual(generateToken(), t);
  });

  it('hashToken is SHA-256 hex', () => {
    assert.equal(hashToken('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
    assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(hashToken('abc').length, 64);
    assert.notEqual(hashToken('abc'), hashToken('abd'));
  });

  it('hashesEqual compares digests without throwing on length mismatch', () => {
    const a = hashToken('a');
    const b = hashToken('b');
    assert.equal(hashesEqual(a, a), true);
    assert.equal(hashesEqual(a, b), false);
    assert.equal(hashesEqual(a, a.slice(0, -2)), false);
    assert.equal(hashesEqual(a, `${a.slice(0, -1)}${a.endsWith('0') ? '1' : '0'}`), false, 'single-nibble difference');
    assert.equal(hashesEqual(a.toUpperCase(), a), true, 'hex case does not matter for the underlying bytes');
  });

  it('pairing codes avoid ambiguous glyphs and normalize dashes/spaces/case', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/, `code ${code} uses only the unambiguous alphabet`);
    }
    assert.equal(generatePairingCode(12).length, 12);
    assert.equal(normalizePairingCode(' ab-cd ef-gh '), 'ABCDEFGH');
    assert.equal(hashPairingCode('abcd-efgh'), hashPairingCode('ABCDEFGH'));
    assert.notEqual(hashPairingCode('ABCDEFGH'), hashToken('ABCDEFGH'), 'pairing hashes are namespaced away from device tokens');
    assert.equal(PAIRING_CODE_TTL_MS, 10 * 60 * 1000);
  });
});

describe('Db: device tokens and pairing codes round-trip through hashes', () => {
  let db: Db;
  before(() => {
    db = new Db(':memory:');
  });
  after(() => db.close());

  it('stores only the hash and finds the device by the raw token', () => {
    const token = generateToken();
    const dev = db.createDevice('iPhone', 'ios', token);
    assert.equal(dev.tokenHash, hashToken(token));
    assert.equal(db.deviceByToken(token)?.id, dev.id);
    assert.equal(db.deviceByToken(`${token}x`), null);
    assert.equal(db.deviceByToken(generateToken()), null);
    assert.equal(db.deviceByToken(''), null);
    assert.equal(db.getDevice(dev.id)?.revokedAt, null);
    assert.equal(db.revokeDevice(dev.id), true);
    assert.equal(db.deviceByToken(token), null, 'revoked devices never authenticate');
    assert.equal(db.revokeDevice(dev.id), false, 'revoking twice is a no-op');
    assert.equal(typeof db.getDevice(dev.id)?.revokedAt, 'number');
  });

  it('pairing codes burn on first use and expire', () => {
    const code = generatePairingCode();
    const { expiresAt } = db.createPairingCode(code);
    assert.ok(expiresAt > Date.now() + PAIRING_CODE_TTL_MS - 5000);
    assert.equal(db.consumePairingCode(code.toLowerCase()), true, 'normalized input is accepted');
    assert.equal(db.consumePairingCode(code), false, 'a code can only be used once');
    assert.equal(db.consumePairingCode(generatePairingCode()), false);
    const expired = generatePairingCode();
    db.createPairingCode(expired, -1);
    assert.equal(db.consumePairingCode(expired), false, 'expired codes are rejected');
  });
});

// ===================================================================== authn
describe('extractToken / credentialsFromRequest / authenticate', () => {
  it('Authorization: Bearer wins, case-insensitively and whitespace-tolerant', () => {
    assert.equal(extractToken({ authorization: 'Bearer abc' }), 'abc');
    assert.equal(extractToken({ authorization: 'bearer abc' }), 'abc');
    assert.equal(extractToken({ authorization: '  BEARER    abc   ' }), 'abc');
    assert.equal(extractToken({ authorization: 'Bearer h1', queryToken: 'q1', protocols: [`${WS_AUTH_SUBPROTOCOL_PREFIX}p1`] }), 'h1');
  });

  it('non-bearer or empty Authorization falls through to query and subprotocol', () => {
    assert.equal(extractToken({ authorization: 'Basic dXNlcjpwYXNz', queryToken: 'q1' }), 'q1');
    assert.equal(extractToken({ authorization: 'Bearer ', queryToken: 'q1' }), 'q1');
    assert.equal(extractToken({ authorization: 'Bearer' }), null);
    assert.equal(extractToken({ authorization: 'Basic dXNlcjpwYXNz' }), null);
  });

  it('?token= comes before the subprotocol; the subprotocol prefix is stripped', () => {
    assert.equal(extractToken({ queryToken: 'q1', protocols: [`${WS_AUTH_SUBPROTOCOL_PREFIX}p1`] }), 'q1');
    assert.equal(extractToken({ protocols: ['json', ` ${WS_AUTH_SUBPROTOCOL_PREFIX}p1 `] }), 'p1');
    assert.equal(extractToken({ protocols: [WS_AUTH_SUBPROTOCOL_PREFIX] }), null, 'prefix without a token is not a token');
    assert.equal(extractToken({ protocols: ['json'] }), null);
    assert.equal(extractToken({ protocols: [] }), null);
    assert.equal(extractToken({}), null);
    assert.equal(extractToken({ authorization: null, queryToken: null, protocols: null }), null);
    assert.equal(extractToken({ queryToken: '' }), null);
  });

  it('credentialsFromRequest reads header, query and Sec-WebSocket-Protocol', () => {
    const req = {
      url: '/ws?token=q1&x=1',
      headers: { authorization: 'Bearer h1', 'sec-websocket-protocol': `${WS_AUTH_SUBPROTOCOL_PREFIX}p1, other` },
    } as unknown as http.IncomingMessage;
    assert.deepEqual(credentialsFromRequest(req), { authorization: 'Bearer h1', queryToken: 'q1', protocols: [`${WS_AUTH_SUBPROTOCOL_PREFIX}p1`, 'other'] });
    const bare = { url: '/ws', headers: {} } as unknown as http.IncomingMessage;
    assert.deepEqual(credentialsFromRequest(bare), { authorization: null, queryToken: null, protocols: null });
    const noUrl = { headers: { 'sec-websocket-protocol': ['a', 'b'] } } as unknown as http.IncomingMessage;
    assert.deepEqual(credentialsFromRequest(noUrl).protocols, ['a', 'b']);
  });

  it('selectedSubprotocol echoes exactly the mide.bearer offer', () => {
    assert.equal(selectedSubprotocol(['other', ` ${WS_AUTH_SUBPROTOCOL_PREFIX}p1`]), `${WS_AUTH_SUBPROTOCOL_PREFIX}p1`);
    assert.equal(selectedSubprotocol(['other']), undefined);
    assert.equal(selectedSubprotocol(null), undefined);
    assert.equal(selectedSubprotocol(undefined), undefined);
  });

  it('authenticate resolves devices, touches last_seen and rejects revoked/missing tokens', async () => {
    const db = new Db(':memory:');
    try {
      const token = generateToken();
      const dev = db.createDevice('iPad', 'ios', token);
      const before = db.getDevice(dev.id)?.lastSeen ?? 0;
      await new Promise((r) => setTimeout(r, 5));
      const authed = authenticate(db, { authorization: `Bearer ${token}` });
      assert.equal(authed?.id, dev.id);
      assert.ok((db.getDevice(dev.id)?.lastSeen ?? 0) >= before, 'last_seen is touched');
      assert.equal(authenticate(db, { protocols: [`${WS_AUTH_SUBPROTOCOL_PREFIX}${token}`] })?.id, dev.id);
      assert.equal(authenticate(db, { queryToken: token })?.id, dev.id);
      assert.equal(authenticate(db, { authorization: 'Bearer nope' }), null);
      assert.equal(authenticate(db, {}), null);
      db.revokeDevice(dev.id);
      assert.equal(authenticate(db, { authorization: `Bearer ${token}` }), null);
    } finally {
      db.close();
    }
  });
});
