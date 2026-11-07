/**
 * Adapter-level unit tests driven by real ACP traffic captured from claude-agent-acp 0.73.0 and codex-acp 1.8.0
 * (test/fixtures/*.json, recorded with test/fixtures/capture.ts — one prompt each: run `echo hi`, then write
 * hello.txt; Claude in its `default` mode so Bash asks for permission, Codex in `read-only`). No daemon and no
 * agent process here: each fixture is replayed through the normalizer the way AgentHost does it and then through
 * the core timeline reducer the way the phone does, and the result is checked against what the tool cards, the
 * permission sheet, the new-session sheet and the turn divider need.
 *
 * Findings these tests pin down:
 *  - both adapters run shell commands themselves and announce a `terminal` content block whose output and exit
 *    code only ever arrive in `_meta.terminal_output` / `_meta.terminal_exit` (the host advertises
 *    `clientCapabilities._meta.terminal_output`, so the output comes complete, in one frame);
 *  - `PromptResponse.usage` is cumulative for claude-agent-acp (as ACP specifies) but per turn for codex-acp;
 *  - claude-agent-acp titles the session after the first turn (a late `session_info_update`), codex-acp first
 *    publishes the prompt text as a placeholder title;
 *  - claude-agent-acp's permission `toolCall.title` is the model's description, not the command (the command is
 *    in `rawInput.command`, which the sheet always shows verbatim).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import {
  applyEnvelope,
  createTimeline,
  describeTool,
  PermissionRequest as PermissionRequestSchema,
  TimelineEvent as TimelineEventSchema,
  type ContentBlock,
  type TimelineEvent,
  type TimelineItem,
  type TimelineState,
  type ToolContent,
} from '@mobile-ide/core';
import { z } from 'zod';
import {
  agentTitle,
  attachTerminalCapture,
  contentBlock,
  findModelValue,
  foldTerminalStream,
  modelFromConfigOptions,
  normalizeUpdate,
  permissionOptionKind,
  permissionRequest,
  stopReason,
  TERMINAL_CAPTURE_LIMIT,
  TERMINAL_OUTPUT_LIMIT,
  terminalStream,
  turnUsage,
  usageSemantics,
  usageTotals,
  usageUpdateCost,
  ZERO_USAGE,
  type TerminalCapture,
  type ToolEvent,
} from '../src/agents/normalize.js';

// ------------------------------------------------------------------ fixtures
const Fixture = z.object({
  agentId: z.string(),
  adapter: z.object({ command: z.string(), args: z.array(z.string()) }),
  initialize: z.object({
    agentInfo: z.object({ name: z.string(), title: z.string().optional(), version: z.string().optional() }),
    agentCapabilities: z.record(z.string(), z.unknown()).optional(),
  }),
  newSession: z.object({
    response: z.object({
      sessionId: z.string(),
      modes: z.object({ currentModeId: z.string(), availableModes: z.array(z.object({ id: z.string(), name: z.string() })) }).optional(),
      configOptions: z.unknown().optional(),
    }),
  }),
  prompt: z.object({
    request: z.array(z.unknown()),
    response: z.object({ stopReason: z.string(), usage: z.unknown().optional() }),
  }),
  updates: z.array(z.object({ t: z.number(), params: z.object({ sessionId: z.string(), update: z.record(z.string(), z.unknown()) }) })),
  permissionRequests: z.array(z.object({ t: z.number(), params: z.unknown(), response: z.unknown() })),
});
type Fixture = z.infer<typeof Fixture>;

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TURN = 'turn-1';

function loadFixture(name: string): Fixture {
  return Fixture.parse(JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')));
}

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

interface Replay {
  events: TimelineEvent[];
  state: TimelineState;
  tools: ToolItem[];
  assistantText: string;
}

/** What AgentHost.handleUpdate does per update, then what the phone's reducer does per envelope. */
function replay(f: Fixture): Replay {
  const captures = new Map<string, TerminalCapture>();
  const blocks = f.prompt.request.map(contentBlock).filter((b): b is ContentBlock => b !== null);
  const events: TimelineEvent[] = [{ type: 'turn.started', turnId: TURN, blocks }];
  for (const { params } of f.updates) {
    const update = params.update;
    const ev = normalizeUpdate(update, { turnId: TURN });
    if (!ev) continue;
    if (ev.type === 'tool.call' || ev.type === 'tool.update') {
      const stream = terminalStream(update);
      if (stream) attachTerminalCapture(ev, stream.terminalId, foldTerminalStream(captures, stream));
    }
    assert.deepEqual(TimelineEventSchema.parse(JSON.parse(JSON.stringify(ev))), ev, `event from ${String(update.sessionUpdate)} must round-trip through the core schema`);
    events.push(ev);
  }
  events.push({ type: 'turn.ended', turnId: TURN, stopReason: stopReason(f.prompt.response.stopReason) });
  const state = createTimeline('s');
  events.forEach((event, seq) => applyEnvelope(state, { sessionId: 's', seq, ts: 1_000 + seq, event }));
  const tools = state.items.filter((it): it is ToolItem => it.kind === 'tool');
  const assistantText = state.items
    .filter((it): it is Extract<TimelineItem, { kind: 'assistant' }> => it.kind === 'assistant')
    .map((it) => it.text)
    .join('');
  return { events, state, tools, assistantText };
}

function terminalBlock(tool: ToolItem): Extract<ToolContent, { type: 'terminal' }> {
  const blocks = tool.content.filter((c): c is Extract<ToolContent, { type: 'terminal' }> => c.type === 'terminal');
  assert.equal(blocks.length, 1, `exactly one terminal block on "${tool.title}": ${JSON.stringify(tool.content)}`);
  const block = blocks[0];
  assert.ok(block);
  return block;
}

function updatesOf(f: Fixture, kind: string): Record<string, unknown>[] {
  return f.updates.map((u) => u.params.update).filter((u) => u.sessionUpdate === kind);
}

// ===================================================================== claude-agent-acp
describe('claude-agent-acp 0.73.0 (captured fixture)', () => {
  const f = loadFixture('claude-agent-acp.json');
  const r = replay(f);
  const configOptions = f.newSession.response.configOptions;

  it('identifies itself, accepts images and supports session/load', () => {
    assert.equal(f.initialize.agentInfo.name, '@agentclientprotocol/claude-agent-acp');
    assert.equal(f.adapter.args.at(-1), '@agentclientprotocol/claude-agent-acp@0.73.0', 'the fixture was captured with the pinned version');
    const caps = f.initialize.agentCapabilities ?? {};
    assert.equal(caps.loadSession, true);
    assert.deepEqual((caps.promptCapabilities as Record<string, unknown>).image, true);
    assert.equal(usageSemantics(f.initialize.agentInfo), 'cumulative');
  });

  it('exposes the Claude Code permission modes as session modes', () => {
    const modes = f.newSession.response.modes;
    assert.ok(modes);
    assert.deepEqual(
      modes.availableModes.map((m) => m.id),
      ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
    );
    assert.ok(modes.availableModes.every((m) => m.name.length > 0));
    assert.equal(modes.currentModeId, 'auto', "the user's settings.json defaultMode");
  });

  it('model picker: current model + the list the new-session sheet offers, resolvable by name or id', () => {
    const m = modelFromConfigOptions(configOptions);
    assert.equal(m.current, 'Fable 5.1');
    assert.ok(m.all.includes('Default (recommended)') && m.all.includes('Fable 5.1'), JSON.stringify(m.all));
    assert.equal(new Set(m.all).size, m.all.length, 'names are deduplicated (opus and sonnet both resolve to claude-opus-5 here)');
    assert.deepEqual(findModelValue(configOptions, 'Fable 5.1'), { configId: 'model', value: 'claude-fable-5-1' });
    assert.deepEqual(findModelValue(configOptions, 'haiku'), { configId: 'model', value: 'haiku' }, 'lookup by value id');
    assert.equal(findModelValue(configOptions, 'gpt-5'), null);
    const effort = (configOptions as Record<string, unknown>[]).find((o) => o.id === 'effort');
    assert.equal(effort?.category, 'thought_level', 'effort is a separate config option the model picker must not mix in');
    assert.ok(!m.all.includes('Xhigh'));
  });

  it('config_option_update / usage_update are not timeline events (the host consumes them)', () => {
    assert.ok(updatesOf(f, 'config_option_update').length >= 1);
    assert.ok(updatesOf(f, 'usage_update').length >= 3);
    for (const u of [...updatesOf(f, 'config_option_update'), ...updatesOf(f, 'usage_update')]) assert.equal(normalizeUpdate(u, { turnId: TURN }), null);
    const commands = r.events.filter((e) => e.type === 'commands.updated');
    assert.ok(commands.length >= 1 && commands[0]?.type === 'commands.updated' && commands[0].commands.length > 20, 'slash commands are published');
  });

  it('Bash: kind execute, the command is the label, output and exit code are materialized from _meta', () => {
    const echo = r.tools.find((t) => t.title === 'echo hi');
    assert.ok(echo, `tools seen: ${r.tools.map((t) => t.title).join(' | ')}`);
    assert.equal(echo.toolKind, 'execute');
    assert.equal(echo.status, 'completed');
    assert.equal(describeTool(echo.title, echo.toolKind, echo.rawInput), 'echo hi');
    assert.deepEqual(echo.rawInput, { command: 'echo hi', description: 'Print hi to stdout' }, 'the refined rawInput wins over the initial {}');
    const term = terminalBlock(echo);
    assert.equal(term.terminalId, echo.toolCallId, 'the adapter keys the terminal by the tool_use id');
    assert.equal(term.output, 'hi', 'Claude Code hands the adapter trimmed structured stdout');
    assert.equal(term.exitCode, 0);
    assert.ok(echo.endedTs !== undefined, 'completion stamps the end time for the duration chip');

    const diff = r.tools.find((t) => t.title.startsWith('git -C'));
    assert.ok(diff);
    const diffTerm = terminalBlock(diff);
    assert.ok(diffTerm.output?.includes('+second line'), diffTerm.output);
    assert.equal(diffTerm.exitCode, 0);
    assert.equal(diff.status, 'completed');
  });

  it('the output frame and the exit frame arrive separately and both land on the same block', () => {
    const frames = updatesOf(f, 'tool_call_update')
      .map((u) => terminalStream(u))
      .filter((s): s is NonNullable<typeof s> => s !== null);
    assert.ok(frames.length >= 4, `expected output+exit frames for two commands, got ${frames.length}`);
    const outputOnly = frames.filter((s) => s.output !== undefined && !s.exited);
    const exitOnly = frames.filter((s) => s.output === undefined && s.exited);
    assert.ok(outputOnly.length >= 2 && exitOnly.length >= 2, 'claude-agent-acp splits output and exit into two updates');
    const first = outputOnly[0];
    assert.ok(first);
    const update = updatesOf(f, 'tool_call_update').find((u) => terminalStream(u)?.output === first.output);
    assert.ok(update && update.content === undefined, 'the output frame carries no content of its own: the terminal block is synthesized');
  });

  it('Read: kind read, completed, with the numbered file content', () => {
    const read = r.tools.find((t) => t.toolKind === 'read');
    assert.ok(read);
    assert.equal(read.title, 'Read hello.txt');
    assert.equal(read.status, 'completed');
    assert.deepEqual(read.rawInput, { file_path: '/repo/hello.txt' });
    assert.ok(typeof read.rawOutput === 'string' && read.rawOutput.includes('hello'));
    assert.ok(read.content.some((c) => c.type === 'content' && c.content.type === 'text' && c.content.text.includes('second line')));
  });

  it('assistant text streams into bubbles and the turn closes them', () => {
    assert.ok(r.assistantText.includes('printed `hi`'), r.assistantText.slice(0, 200));
    const bubbles = r.state.items.filter((it) => it.kind === 'assistant');
    assert.ok(bubbles.length >= 2, 'text before and after the tool calls is separate bubbles');
    assert.ok(bubbles.every((b) => b.kind === 'assistant' && !b.streaming), 'turn.ended stops streaming');
    assert.equal(r.state.status, 'idle');
  });

  it('the late session_info_update is a title suggestion (session.renamed at normalize level)', () => {
    const late = updatesOf(f, 'session_info_update');
    assert.equal(late.length, 1);
    assert.deepEqual(normalizeUpdate(late[0], { turnId: TURN }), { type: 'session.renamed', title: 'Echo and hello.txt file' });
    const promptText = (f.prompt.request[0] as { text: string }).text;
    assert.equal(agentTitle(late[0]?.title, promptText), 'Echo and hello.txt file', 'a generated title is not a prompt echo');
    const lastUpdate = f.updates[f.updates.length - 1];
    assert.equal(lastUpdate?.params.update.sessionUpdate, 'session_info_update', 'it is the very last notification, after the prompt result');
  });

  it('usage_update carries the cumulative session cost in USD', () => {
    const costs = updatesOf(f, 'usage_update').map(usageUpdateCost).filter((c): c is number => c !== undefined);
    assert.equal(costs.length, 1);
    const cost = costs[0];
    assert.ok(cost !== undefined && cost > 0.1 && cost < 5, `cost ${cost}`);
    assert.equal(usageUpdateCost(updatesOf(f, 'usage_update')[0]), undefined, 'context-size-only updates have no cost');
  });

  it('permission request: Bash asks with allow_once / allow_always / reject_once and the literal command in rawInput', () => {
    assert.equal(f.permissionRequests.length, 1, 'echo is auto-allowed in default mode; git diff asked');
    const p = f.permissionRequests[0];
    assert.ok(p);
    const req = permissionRequest(p.params, { permissionId: 'perm-1', sessionId: 'our-session', turnId: TURN, createdAt: 1 });
    assert.deepEqual(PermissionRequestSchema.parse(JSON.parse(JSON.stringify(req))), req);
    assert.equal(req.kind, 'execute');
    assert.equal(req.toolCallId, 'toolu_01Vm1K1juRkJaxJYTuJMbNAQ');
    assert.deepEqual(req.rawInput, { command: 'git -C /repo diff hello.txt', description: 'Show uncommitted changes to hello.txt' });
    assert.equal(req.title, 'Show uncommitted changes to hello.txt', 'claude-agent-acp titles the request with the description; the sheet shows rawInput verbatim');
    assert.deepEqual(
      req.options.map((o) => [o.optionId, o.kind]),
      [
        ['allow-once', 'allow_once'],
        ['allow-with-updates', 'allow_always'],
        ['reject', 'reject_once'],
      ],
    );
    assert.ok(req.content?.some((c) => c.type === 'terminal'), 'the pending tool call already has its terminal block');
    assert.deepEqual(p.response, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
    const call = r.tools.find((t) => t.toolCallId === req.toolCallId);
    assert.ok(call && call.status === 'completed', 'the tool call was emitted before the permission request and completed after the approval');
  });

  it('prompt result: end_turn with cumulative usage -> this turn = total minus baseline, cached context included', () => {
    assert.equal(stopReason(f.prompt.response.stopReason), 'end_turn');
    const usage = f.prompt.response.usage as { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedWriteTokens: number };
    assert.equal(usageTotals(usage)?.inputTokens, usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens);
    const first = turnUsage(usage, 'cumulative', { ...ZERO_USAGE });
    assert.deepEqual(first, {
      usage: { inputTokens: 68 + 96_067 + 48_832, outputTokens: 1088 },
      baseline: { inputTokens: 68 + 96_067 + 48_832, outputTokens: 1088 },
    });
    const second = turnUsage(usage, 'cumulative', first.baseline);
    assert.deepEqual(second.usage, { inputTokens: 0, outputTokens: 0 }, 'an identical total means the next turn cost nothing');
  });
});

// ===================================================================== codex-acp
describe('codex-acp 1.8.0 (captured fixture)', () => {
  const f = loadFixture('codex-acp.json');
  const r = replay(f);
  const configOptions = f.newSession.response.configOptions;

  it('identifies itself, accepts images and supports session/load', () => {
    assert.equal(f.initialize.agentInfo.name, '@agentclientprotocol/codex-acp');
    assert.equal(f.adapter.args.at(-1), '@agentclientprotocol/codex-acp@1.8.0');
    const caps = f.initialize.agentCapabilities ?? {};
    assert.equal(caps.loadSession, true);
    assert.equal((caps.promptCapabilities as Record<string, unknown>).image, true);
    assert.equal(usageSemantics(f.initialize.agentInfo), 'per_turn');
  });

  it('exposes the Codex approval presets as session modes', () => {
    const modes = f.newSession.response.modes;
    assert.ok(modes);
    assert.deepEqual(
      modes.availableModes.map((m) => [m.id, m.name]),
      [
        ['read-only', 'Ask for approval'],
        ['agent', 'Approve for me'],
        ['agent-full-access', 'Full access'],
      ],
    );
    assert.equal(modes.currentModeId, 'agent');
  });

  it('model picker: the models Codex offers, current one from ~/.codex/config.toml', () => {
    const m = modelFromConfigOptions(configOptions);
    assert.equal(m.current, 'GPT-5.6-Sol');
    assert.equal(m.all.length, 5, JSON.stringify(m.all));
    assert.deepEqual(findModelValue(configOptions, 'GPT-5.5'), { configId: 'model', value: 'gpt-5.5' });
    assert.deepEqual(findModelValue(configOptions, 'gpt-5.2'), { configId: 'model', value: 'gpt-5.2' });
    assert.ok(!m.all.includes('Ultra') && !m.all.includes('Plan'), 'reasoning effort, collaboration mode and fast-mode stay out of the model list');
  });

  it('shell command: kind execute, output + exit code from one _meta frame, rawInput has command and cwd', () => {
    const echo = r.tools.find((t) => t.title === 'echo hi');
    assert.ok(echo, `tools seen: ${r.tools.map((t) => t.title).join(' | ')}`);
    assert.equal(echo.toolKind, 'execute');
    assert.equal(echo.status, 'completed');
    assert.equal(describeTool(echo.title, echo.toolKind, echo.rawInput), 'echo hi');
    assert.deepEqual(echo.rawInput, { command: 'echo hi', cwd: '/repo' });
    assert.deepEqual(echo.rawOutput, { formatted_output: 'hi\n', exit_code: 0 });
    const term = terminalBlock(echo);
    assert.equal(term.terminalId, echo.toolCallId);
    assert.equal(term.output, 'hi\n');
    assert.equal(term.exitCode, 0);

    const frames = updatesOf(f, 'tool_call_update')
      .map((u) => terminalStream(u))
      .filter((s): s is NonNullable<typeof s> => s !== null);
    assert.ok(frames.length >= 2 && frames.every((s) => s.output !== undefined && s.exited), 'codex-acp sends output and exit together (terminal_output mode)');
    const initial = updatesOf(f, 'tool_call').find((u) => u.title === 'echo hi');
    assert.ok(initial);
    assert.equal(terminalStream(initial), null, 'terminal_info alone carries nothing to render');
    assert.equal(initial.status, 'in_progress');
  });

  it('file changes: one "Editing files" call with a diff block per file', () => {
    const edit = r.tools.find((t) => t.toolKind === 'edit');
    assert.ok(edit);
    assert.equal(edit.title, 'Editing files');
    assert.equal(edit.status, 'completed');
    const diffs = edit.content.filter((c): c is Extract<ToolContent, { type: 'diff' }> => c.type === 'diff');
    assert.equal(diffs.length, 2);
    assert.deepEqual(diffs.map((d) => d.path).sort(), ['/repo/hello.txt', '/tmp/mide-capture-outside.txt']);
    assert.ok(diffs.every((d) => d.newText.includes('hi')));
    const outside = diffs.find((d) => d.path.startsWith('/tmp/'));
    assert.equal(outside?.oldText, null, 'a created file has no old text');
    assert.equal(edit.rawInput, undefined, 'codex-acp sends no rawInput for file changes; the diff is the input');
  });

  it('assistant text and the final DONE', () => {
    assert.ok(r.assistantText.startsWith('I’ll run the command'), r.assistantText.slice(0, 80));
    assert.ok(r.assistantText.endsWith('DONE'));
  });

  it('session_info_update: status-only updates are ignored, the placeholder title (the prompt itself) is not a title', () => {
    const infos = updatesOf(f, 'session_info_update');
    assert.ok(infos.length >= 2);
    const statusOnly = infos.filter((u) => u.title === null || u.title === undefined);
    assert.ok(statusOnly.length >= 1 && statusOnly.every((u) => normalizeUpdate(u, { turnId: TURN }) === null));
    const titled = infos.find((u) => typeof u.title === 'string');
    assert.ok(titled);
    const promptText = (f.prompt.request[0] as { text: string }).text;
    assert.equal(titled.title, promptText);
    assert.equal(agentTitle(titled.title, promptText), undefined, 'the host drops it: the daemon already derives its title from the prompt');
    assert.equal(agentTitle('Echo and write hello.txt', promptText), 'Echo and write hello.txt', 'a real thread name would pass');
  });

  it('prompt result: end_turn with per-turn usage reported as-is (cached context included)', () => {
    assert.equal(stopReason(f.prompt.response.stopReason), 'end_turn');
    const usage = f.prompt.response.usage as Record<string, number>;
    const r1 = turnUsage(usage, 'per_turn', null);
    assert.deepEqual(r1, { usage: { inputTokens: 164 + 12_591, outputTokens: 5 }, baseline: null });
    const r2 = turnUsage(usage, 'per_turn', { inputTokens: 5, outputTokens: 5 });
    assert.deepEqual(r2.usage, { inputTokens: 164 + 12_591, outputTokens: 5 }, 'per-turn agents never get delta math');
    assert.equal(updatesOf(f, 'usage_update').map(usageUpdateCost).filter((c) => c !== undefined).length, 0, 'codex-acp reports no cost');
  });

  it('a read-only Codex asks nothing for writes inside the workspace or /tmp (no permission requests captured)', () => {
    assert.equal(f.permissionRequests.length, 0);
  });
});

// ===================================================================== codex-acp approval shape (from its source)
describe('codex-acp approval requests (option shape from codex-acp 1.8.0 src/permissions)', () => {
  const params: RequestPermissionRequest = {
    sessionId: 'thread-1',
    toolCall: {
      toolCallId: 'exec-1',
      kind: 'execute',
      status: 'pending',
      title: 'rm -rf node_modules',
      rawInput: { command: 'rm -rf node_modules', cwd: '/repo' },
      content: [{ type: 'terminal', terminalId: 'exec-1' }],
    },
    options: [
      { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' },
      { optionId: 'allow_for_session', name: "Yes, and don't ask again for this command in this session", kind: 'allow_always' },
      { optionId: 'decline', name: 'No, continue without running it', kind: 'reject_once' },
      { optionId: 'cancel', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
    ],
  };

  it('maps all four options verbatim, two of them reject_once', () => {
    const req = permissionRequest(params, { permissionId: 'p', sessionId: 's', turnId: TURN, createdAt: 1 });
    PermissionRequestSchema.parse(JSON.parse(JSON.stringify(req)));
    assert.deepEqual(req.options, params.options);
    assert.equal(describeTool(req.title, req.kind ?? 'other', req.rawInput), 'rm -rf node_modules');
    assert.deepEqual(req.content, [{ type: 'terminal', terminalId: 'exec-1' }]);
  });

  it('non-spec kinds are inferred from the id and label instead of defaulting to allow', () => {
    assert.equal(permissionOptionKind(undefined, 'decline', 'No, continue without running it'), 'reject_once');
    assert.equal(permissionOptionKind('weird', 'cancel', 'No, and tell Codex what to do differently'), 'reject_once');
    assert.equal(permissionOptionKind(undefined, 'reject_permissions', 'Reject'), 'reject_once');
    assert.equal(permissionOptionKind(undefined, 'allow_for_session', "Yes, and don't ask again for this command in this session"), 'allow_always');
    assert.equal(permissionOptionKind(undefined, 'accept_execpolicy_amendment', "Yes, and don't ask again for commands that start with `git`"), 'allow_always');
    assert.equal(permissionOptionKind(undefined, 'allow_once', 'Yes, proceed'), 'allow_once');
    assert.equal(permissionOptionKind(undefined, 'allow-with-updates', "Yes, and don't ask again for npm commands"), 'allow_always');
    assert.equal(permissionOptionKind(undefined, 'never', 'Never allow'), 'reject_always');
    assert.equal(permissionOptionKind(undefined, 'y', 'y'), 'allow_once', 'nothing to go on: allow once');
    for (const k of ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const) assert.equal(permissionOptionKind(k, 'reject', 'No'), k, 'spec kinds always win');
  });
});

// ===================================================================== terminal stream folding
describe('terminal output carried in _meta', () => {
  it('terminal_output_delta frames accumulate, terminal_exit closes, the tail is kept past the limit', () => {
    const captures = new Map<string, TerminalCapture>();
    const frame = (meta: Record<string, unknown>) => terminalStream({ sessionUpdate: 'tool_call_update', toolCallId: 'c', _meta: meta });
    const d1 = frame({ terminal_output_delta: { terminal_id: 't1', data: 'hel' } });
    const d2 = frame({ terminal_output_delta: { terminal_id: 't1', data: 'lo\n' } });
    assert.ok(d1 && d2);
    assert.deepEqual(d1, { terminalId: 't1', delta: 'hel', exited: false });
    foldTerminalStream(captures, d1);
    const c = foldTerminalStream(captures, d2);
    assert.deepEqual(c, { output: 'hello\n', exitCode: null, exited: false, truncated: false });
    const ex = frame({ terminal_exit: { terminal_id: 't1', exit_code: 3, signal: null } });
    assert.ok(ex);
    assert.deepEqual(ex, { terminalId: 't1', exited: true, exitCode: 3 });
    assert.deepEqual(foldTerminalStream(captures, ex), { output: 'hello\n', exitCode: 3, exited: true, truncated: false });
    const killed = frame({ terminal_exit: { terminal_id: 't2', exit_code: null, signal: 'SIGKILL' } });
    assert.ok(killed && killed.exitCode === null && killed.signal === 'SIGKILL');
    assert.equal(foldTerminalStream(captures, killed).exitCode, null);

    const big = frame({ terminal_output: { terminal_id: 't3', data: 'x'.repeat(TERMINAL_OUTPUT_LIMIT + 10) } });
    assert.ok(big);
    const cap = foldTerminalStream(captures, big);
    assert.equal(cap.output.length, TERMINAL_OUTPUT_LIMIT);
    assert.equal(cap.truncated, true);
    foldTerminalStream(captures, { terminalId: 't3', delta: 'tail', exited: false });
    assert.ok(captures.get('t3')?.output.endsWith('tail'));
    assert.equal(captures.get('t3')?.output.length, TERMINAL_OUTPUT_LIMIT);
  });

  it('a full terminal_output frame replaces, ids come from any of the metas, terminal_info alone is nothing', () => {
    const captures = new Map<string, TerminalCapture>();
    const s = terminalStream({ sessionUpdate: 'tool_call_update', toolCallId: 'c', _meta: { terminal_output: { terminal_id: 'a', data: 'first' } } });
    assert.ok(s);
    foldTerminalStream(captures, s);
    foldTerminalStream(captures, { terminalId: 'a', output: 'second', exited: false });
    assert.equal(captures.get('a')?.output, 'second');
    assert.equal(terminalStream({ sessionUpdate: 'tool_call', toolCallId: 'c', _meta: { terminal_info: { terminal_id: 'a', cwd: '/repo' } } }), null);
    assert.equal(terminalStream({ sessionUpdate: 'tool_call_update', toolCallId: 'c' }), null);
    assert.equal(terminalStream({ sessionUpdate: 'tool_call_update', toolCallId: 'c', _meta: { terminal_output: { data: 'no id' } } }), null);
    assert.equal(terminalStream('garbage'), null);
    const viaInfo = terminalStream({ sessionUpdate: 'tool_call_update', toolCallId: 'c', _meta: { terminal_info: { terminal_id: 'b' }, terminal_exit: { exit_code: 0 } } });
    assert.deepEqual(viaInfo, { terminalId: 'b', exited: true, exitCode: 0 }, 'terminal_exit without its own id falls back to terminal_info');
  });

  it('attachTerminalCapture synthesizes the block on a content-less update and keeps other blocks', () => {
    const update: ToolEvent = { type: 'tool.update', turnId: TURN, toolCallId: 'c' };
    attachTerminalCapture(update, 't1', { output: 'out', exitCode: null, exited: false, truncated: false });
    assert.deepEqual(update.content, [{ type: 'terminal', terminalId: 't1', output: 'out' }]);
    assert.ok(update.content && !('exitCode' in (update.content[0] as object)), 'no exit code while still running');
    attachTerminalCapture(update, 't1', { output: 'out\ndone', exitCode: 0, exited: true, truncated: false });
    assert.deepEqual(update.content, [{ type: 'terminal', terminalId: 't1', output: 'out\ndone', exitCode: 0 }]);

    const call: ToolEvent = {
      type: 'tool.call',
      turnId: TURN,
      toolCallId: 'c',
      title: 'x',
      kind: 'execute',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'note' } }, { type: 'terminal', terminalId: 't9' }],
    };
    attachTerminalCapture(call, 't9', { output: 'tail', exitCode: 1, exited: true, truncated: true });
    assert.deepEqual(call.content, [
      { type: 'content', content: { type: 'text', text: 'note' } },
      { type: 'terminal', terminalId: 't9', output: '[earlier output truncated]\ntail', exitCode: 1 },
    ]);
    TimelineEventSchema.parse(JSON.parse(JSON.stringify(call)));
  });

  it('forgets the oldest terminals past the per-session cap', () => {
    const captures = new Map<string, TerminalCapture>();
    for (let i = 0; i < TERMINAL_CAPTURE_LIMIT + 5; i++) foldTerminalStream(captures, { terminalId: `t${i}`, output: 'x', exited: true, exitCode: 0 });
    assert.equal(captures.size, TERMINAL_CAPTURE_LIMIT);
    assert.equal(captures.has('t0'), false);
    assert.equal(captures.has(`t${TERMINAL_CAPTURE_LIMIT + 4}`), true);
  });
});

// ===================================================================== usage, titles, misc
describe('turn usage semantics', () => {
  const total = { inputTokens: 100, outputTokens: 50, cachedReadTokens: 900, cachedWriteTokens: 0, totalTokens: 1050 };

  it('cumulative: unknown baseline (after session/load) yields nothing and establishes one', () => {
    const r = turnUsage(total, 'cumulative', null);
    assert.deepEqual(r, { usage: undefined, baseline: { inputTokens: 1000, outputTokens: 50 } });
    const next = turnUsage({ ...total, outputTokens: 80, cachedReadTokens: 1900 }, 'cumulative', r.baseline);
    assert.deepEqual(next.usage, { inputTokens: 1000, outputTokens: 30 });
  });

  it('cumulative: a counter going backwards means per-turn numbers after all -> raw, and restart from them', () => {
    const r = turnUsage({ inputTokens: 10, outputTokens: 5 }, 'cumulative', { inputTokens: 1000, outputTokens: 50 });
    assert.deepEqual(r, { usage: { inputTokens: 10, outputTokens: 5 }, baseline: { inputTokens: 10, outputTokens: 5 } });
  });

  it('missing or malformed usage leaves the baseline alone', () => {
    assert.deepEqual(turnUsage(undefined, 'cumulative', { ...ZERO_USAGE }), { usage: undefined, baseline: { ...ZERO_USAGE } });
    assert.deepEqual(turnUsage({ inputTokens: 'x' }, 'per_turn', null), { usage: undefined, baseline: null });
    assert.equal(usageTotals({ inputTokens: 1 }), null, 'both counters are required');
    assert.deepEqual(usageTotals({ inputTokens: 1, outputTokens: 2, cachedReadTokens: null }), { inputTokens: 1, outputTokens: 2 });
  });

  it('only codex-acp is per turn; everything else follows the spec (cumulative)', () => {
    assert.equal(usageSemantics({ name: '@agentclientprotocol/codex-acp', version: '1.8.0' }), 'per_turn');
    assert.equal(usageSemantics({ name: '@agentclientprotocol/claude-agent-acp' }), 'cumulative');
    assert.equal(usageSemantics({ name: 'opencode' }), 'cumulative');
    assert.equal(usageSemantics(undefined), 'cumulative');
  });

  it('usageUpdateCost accepts USD amounts only', () => {
    assert.equal(usageUpdateCost({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 0.25, currency: 'USD' } }), 0.25);
    assert.equal(usageUpdateCost({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 0.25 } }), 0.25);
    assert.equal(usageUpdateCost({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 3, currency: 'EUR' } }), undefined);
    assert.equal(usageUpdateCost({ sessionUpdate: 'usage_update', used: 1, size: 2 }), undefined);
    assert.equal(usageUpdateCost({ sessionUpdate: 'agent_message_chunk', cost: { amount: 1 } }), undefined);
  });
});

describe('agent-suggested titles', () => {
  it('drops empties and prompt echoes, collapses whitespace, caps at 200 characters', () => {
    assert.equal(agentTitle(null, 'x'), undefined);
    assert.equal(agentTitle('   ', 'x'), undefined);
    assert.equal(agentTitle('Fix the login bug', 'Fix the login bug'), undefined);
    assert.equal(agentTitle('Fix the login bug', 'Fix the login bug in auth.ts and add a test'), undefined, 'a truncated echo is still an echo');
    assert.equal(agentTitle('Login bug fix', 'Fix the login bug'), 'Login bug fix');
    assert.equal(agentTitle('  Two\n\nlines  ', ''), 'Two lines');
    assert.equal(agentTitle('t'.repeat(300), '')?.length, 200);
  });
});

describe('content blocks from adapters', () => {
  it('a URL image (claude-agent-acp: empty data + uri) becomes a link instead of a broken data URI', () => {
    assert.deepEqual(contentBlock({ type: 'image', data: '', mimeType: '', uri: 'https://example.com/pic.png' }), { type: 'resource_link', uri: 'https://example.com/pic.png', name: 'pic.png' });
    assert.deepEqual(contentBlock({ type: 'image', data: 'AAAA', mimeType: 'image/png' }), { type: 'image', mimeType: 'image/png', data: 'AAAA' });
    assert.equal(contentBlock({ type: 'image', mimeType: 'image/png' }), null);
  });
});
