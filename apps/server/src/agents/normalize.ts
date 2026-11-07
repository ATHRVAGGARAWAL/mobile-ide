/**
 * ACP `session/update` → core `TimelineEvent`. Pure and lenient: malformed payloads
 * yield `null` (or a best-effort event) instead of throwing, so one odd notification
 * never takes down a session.
 *
 * Adapter-specific shapes this file knows about (fixtures in test/fixtures/, captured from the real adapters):
 *  - claude-agent-acp: Bash → kind `execute`, `rawInput {command, description}`; Edit/Write → kind `edit` with a
 *    `diff` block and `rawInput {file_path, old_string, new_string | content}`; thoughts as `agent_thought_chunk`;
 *    permission options `allow-once` / `allow-with-updates` / `reject`; session titles via `session_info_update`.
 *  - codex-acp: shell commands → kind `execute`, `rawInput {command, cwd}`, output only in `_meta.terminal_output`
 *    / `_meta.terminal_exit` (see `terminalStream`); file changes → "Editing files" with `diff` blocks; options
 *    `allow_once` / `allow_for_session` / `decline` / `cancel`; `PromptResponse.usage` is per turn, not cumulative.
 */
import type {
  ContentBlock,
  ElicitationEnumOption,
  ElicitationProperty,
  ElicitationRequest,
  ElicitationSchema,
  PermissionOption,
  PermissionRequest,
  TimelineEvent,
  ToolContent,
  ToolKind,
  ToolLocation,
  ToolStatus,
} from '@mobile-ide/core';

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const TOOL_KINDS: ReadonlySet<string> = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
const TOOL_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'failed']);
const OPTION_KINDS: ReadonlySet<string> = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

export function toolKind(v: unknown): ToolKind {
  return typeof v === 'string' && TOOL_KINDS.has(v) ? (v as ToolKind) : 'other';
}
export function toolStatus(v: unknown, fallback: ToolStatus): ToolStatus {
  return typeof v === 'string' && TOOL_STATUSES.has(v) ? (v as ToolStatus) : fallback;
}

/** ACP ContentBlock (text/image/audio/resource_link/resource) → the phone-renderable subset. */
export function contentBlock(v: unknown): ContentBlock | null {
  if (!isRec(v)) return null;
  switch (v.type) {
    case 'text': {
      const text = asString(v.text);
      return text === undefined ? null : { type: 'text', text };
    }
    case 'image': {
      const data = asString(v.data);
      const mimeType = asString(v.mimeType) ?? 'image/png';
      const uri = asString(v.uri);
      // claude-agent-acp forwards URL images as `data: ""` + `uri`; an empty data URI would render as a broken image
      if (!data && uri) return { type: 'resource_link', uri, name: uri.split('/').pop() || uri, ...(asString(v.mimeType) ? { mimeType } : {}) };
      if (data === undefined) return null;
      return { type: 'image', mimeType, data };
    }
    case 'resource_link': {
      const uri = asString(v.uri);
      if (uri === undefined) return null;
      const name = asString(v.name) ?? uri.split('/').pop() ?? uri;
      const mimeType = asString(v.mimeType);
      return mimeType ? { type: 'resource_link', uri, name, mimeType } : { type: 'resource_link', uri, name };
    }
    case 'resource': {
      const res = isRec(v.resource) ? v.resource : null;
      if (!res) return null;
      const text = asString(res.text);
      const uri = asString(res.uri) ?? 'resource';
      if (text !== undefined) return { type: 'text', text: `\`${uri}\`\n\n${text}` };
      return { type: 'resource_link', uri, name: uri.split('/').pop() ?? uri };
    }
    case 'audio':
      return { type: 'text', text: '[audio]' };
    default:
      return null;
  }
}

/** Text a chunk contributes to a streaming bubble. Non-text blocks become short markers. */
export function chunkText(content: unknown): string | null {
  const block = contentBlock(content);
  if (!block) return null;
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return `\n![image](data:${block.mimeType};base64,${block.data})\n`;
    case 'resource_link':
      return `[${block.name}](${block.uri})`;
  }
}

export function toolContent(v: unknown): ToolContent | null {
  if (!isRec(v)) return null;
  switch (v.type) {
    case 'diff': {
      const path = asString(v.path);
      const newText = asString(v.newText);
      if (path === undefined || newText === undefined) return null;
      const oldText = asString(v.oldText);
      return { type: 'diff', path, oldText: oldText ?? null, newText };
    }
    case 'terminal': {
      const terminalId = asString(v.terminalId);
      if (terminalId === undefined) return null;
      return { type: 'terminal', terminalId };
    }
    case 'content': {
      const block = contentBlock(v.content);
      return block ? { type: 'content', content: block } : null;
    }
    default:
      return null;
  }
}

export function toolContents(v: unknown): ToolContent[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(toolContent).filter((c): c is ToolContent => c !== null);
}

export function toolLocations(v: unknown): ToolLocation[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ToolLocation[] = [];
  for (const item of v) {
    if (!isRec(item)) continue;
    const path = asString(item.path);
    if (path === undefined) continue;
    const line = asNumber(item.line);
    out.push(line === undefined ? { path } : { path, line });
  }
  return out;
}

/**
 * The kind decides the button colour on the phone, so an option with a non-spec kind must not default to
 * "allow": infer it from the id and label instead (codex-acp: `decline` / `cancel`; claude-agent-acp:
 * `reject`, "Yes, and don't ask again…").
 */
export function permissionOptionKind(kind: unknown, optionId: string, name: string): PermissionOption['kind'] {
  if (typeof kind === 'string' && OPTION_KINDS.has(kind)) return kind as PermissionOption['kind'];
  const text = `${optionId} ${name}`.toLowerCase();
  const negative = /(^|[^a-z])(reject|deny|denied|decline|cancel|refuse|never|abort|no)([^a-z]|$)/.test(text);
  const persistent = /(always|never|session|forever|don'?t ask|do not ask|remember|for this)/.test(text);
  if (negative) return persistent ? 'reject_always' : 'reject_once';
  return persistent ? 'allow_always' : 'allow_once';
}

export function permissionOptions(v: unknown): PermissionOption[] {
  if (!Array.isArray(v)) return [];
  const out: PermissionOption[] = [];
  for (const item of v) {
    if (!isRec(item)) continue;
    const optionId = asString(item.optionId);
    if (optionId === undefined) continue;
    const name = asString(item.name) ?? optionId;
    out.push({ optionId, name, kind: permissionOptionKind(item.kind, optionId, name) });
  }
  return out;
}

export interface NormalizeContext {
  /** the turn the update belongs to */
  turnId: string;
}

export type PlanEntry = { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' };

function planEntries(v: unknown): PlanEntry[] {
  if (!Array.isArray(v)) return [];
  const out: PlanEntry[] = [];
  for (const item of v) {
    if (!isRec(item)) continue;
    const content = asString(item.content);
    if (content === undefined) continue;
    const priority = item.priority === 'high' || item.priority === 'low' ? item.priority : 'medium';
    const status = item.status === 'in_progress' || item.status === 'completed' ? item.status : 'pending';
    out.push({ content, priority, status });
  }
  return out;
}

/**
 * Normalize one ACP session update. Returns `null` for updates the timeline does not
 * display (usage, compaction, unknown variants).
 *
 * `session_info_update` becomes `session.renamed` here, but the host routes agent-suggested titles through
 * the session manager instead of emitting that event, so the persisted title and the timeline never disagree.
 */
export function normalizeUpdate(update: unknown, ctx: NormalizeContext): TimelineEvent | null {
  if (!isRec(update)) return null;
  const kind = asString(update.sessionUpdate);
  switch (kind) {
    case 'agent_message_chunk': {
      const text = chunkText(update.content);
      return text === null || text === '' ? null : { type: 'message.delta', turnId: ctx.turnId, text };
    }
    case 'agent_thought_chunk': {
      const text = chunkText(update.content);
      return text === null || text === '' ? null : { type: 'thought.delta', turnId: ctx.turnId, text };
    }
    case 'user_message_chunk': {
      // only seen while an agent replays history during session/load; the host decides whether to keep it
      const block = contentBlock(update.content);
      return block ? { type: 'turn.started', turnId: ctx.turnId, blocks: [block] } : null;
    }
    case 'tool_call': {
      const toolCallId = asString(update.toolCallId);
      if (toolCallId === undefined) return null;
      const ev: TimelineEvent = {
        type: 'tool.call',
        turnId: ctx.turnId,
        toolCallId,
        title: asString(update.title) ?? asString(update.name) ?? 'Tool call',
        kind: toolKind(update.kind),
        status: toolStatus(update.status, 'pending'),
      };
      const content = toolContents(update.content);
      if (content) ev.content = content;
      const locations = toolLocations(update.locations);
      if (locations) ev.locations = locations;
      if (update.rawInput !== undefined) ev.rawInput = update.rawInput;
      return ev;
    }
    case 'tool_call_update': {
      const toolCallId = asString(update.toolCallId);
      if (toolCallId === undefined) return null;
      const ev: TimelineEvent = { type: 'tool.update', turnId: ctx.turnId, toolCallId };
      const title = asString(update.title);
      if (title !== undefined) ev.title = title;
      if (typeof update.kind === 'string') ev.kind = toolKind(update.kind);
      if (typeof update.status === 'string') ev.status = toolStatus(update.status, 'in_progress');
      const content = toolContents(update.content);
      if (content) ev.content = content;
      const locations = toolLocations(update.locations);
      if (locations) ev.locations = locations;
      if (update.rawInput !== undefined && update.rawInput !== null) ev.rawInput = update.rawInput;
      if (update.rawOutput !== undefined && update.rawOutput !== null) ev.rawOutput = update.rawOutput;
      return ev;
    }
    case 'plan':
      return { type: 'plan', turnId: ctx.turnId, entries: planEntries(update.entries) };
    case 'plan_update': {
      const plan = isRec(update.plan) ? update.plan : null;
      if (!plan) return null;
      if (plan.type === 'items') return { type: 'plan', turnId: ctx.turnId, entries: planEntries(plan.entries) };
      if (plan.type === 'markdown') {
        const md = asString(plan.markdown) ?? asString(plan.content);
        return md ? { type: 'plan', turnId: ctx.turnId, entries: [{ content: md, priority: 'medium', status: 'in_progress' }] } : null;
      }
      return null;
    }
    case 'plan_removed':
      return { type: 'plan', turnId: ctx.turnId, entries: [] };
    case 'available_commands_update': {
      const cmds = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      const commands = [];
      for (const c of cmds) {
        if (!isRec(c)) continue;
        const name = asString(c.name);
        if (name === undefined) continue;
        const description = asString(c.description);
        const input = isRec(c.input) ? asString(c.input.hint) : undefined;
        commands.push({ name, ...(description !== undefined ? { description } : {}), ...(input !== undefined ? { input } : {}) });
      }
      return { type: 'commands.updated', commands };
    }
    case 'current_mode_update': {
      const modeId = asString(update.currentModeId);
      return modeId === undefined ? null : { type: 'mode.changed', modeId };
    }
    case 'session_info_update': {
      const title = asString(update.title)?.trim();
      return title ? { type: 'session.renamed', title } : null;
    }
    default:
      return null; // usage_update, compaction_*, config_option_update (handled by the host), unknown
  }
}

// ---------------------------------------------------------------------------
// Terminal output carried in `_meta` (Zed's terminal-output extension)
// ---------------------------------------------------------------------------
/**
 * claude-agent-acp and codex-acp announce a shell command as `content: [{ type: "terminal", terminalId }]`
 * without ever calling `terminal/create`: the output and exit status travel in `_meta.terminal_output`
 * (complete text; negotiated with `clientCapabilities._meta.terminal_output`), `_meta.terminal_output_delta`
 * (increments) and `_meta.terminal_exit` of the tool_call_update — which itself usually carries no `content`.
 */
export interface TerminalStream {
  terminalId: string;
  /** complete output (`terminal_output`) */
  output?: string;
  /** increment to append (`terminal_output_delta`) */
  delta?: string;
  /** present once `terminal_exit` arrived (null = killed by a signal / unknown) */
  exitCode?: number | null;
  signal?: string | null;
  exited: boolean;
}

export function terminalStream(update: unknown): TerminalStream | null {
  if (!isRec(update) || !isRec(update._meta)) return null;
  const meta = update._meta;
  const info = isRec(meta.terminal_info) ? meta.terminal_info : null;
  const out = isRec(meta.terminal_output) ? meta.terminal_output : null;
  const delta = isRec(meta.terminal_output_delta) ? meta.terminal_output_delta : null;
  const exit = isRec(meta.terminal_exit) ? meta.terminal_exit : null;
  if (!out && !delta && !exit) return null; // `terminal_info` alone carries nothing renderable
  const terminalId = asString(out?.terminal_id) ?? asString(delta?.terminal_id) ?? asString(exit?.terminal_id) ?? asString(info?.terminal_id);
  if (terminalId === undefined) return null;
  const stream: TerminalStream = { terminalId, exited: exit !== null };
  const data = asString(out?.data);
  if (data !== undefined) stream.output = data;
  const inc = asString(delta?.data);
  if (inc !== undefined) stream.delta = inc;
  if (exit) {
    stream.exitCode = asNumber(exit.exit_code) ?? null;
    const signal = asString(exit.signal);
    if (signal !== undefined) stream.signal = signal;
  }
  return stream;
}

export interface TerminalCapture {
  output: string;
  exitCode: number | null;
  exited: boolean;
  truncated: boolean;
}

/** Per-terminal output cap (tail is kept), matching the daemon's own agent terminals. */
export const TERMINAL_OUTPUT_LIMIT = 256 * 1024;
/** Terminals remembered per session before the oldest is forgotten. */
export const TERMINAL_CAPTURE_LIMIT = 200;

/** Fold one frame into the per-session captures (creating the entry), keeping only the tail past the limit. */
export function foldTerminalStream(captures: Map<string, TerminalCapture>, stream: TerminalStream): TerminalCapture {
  let capture = captures.get(stream.terminalId);
  if (!capture) {
    capture = { output: '', exitCode: null, exited: false, truncated: false };
    captures.set(stream.terminalId, capture);
    while (captures.size > TERMINAL_CAPTURE_LIMIT) {
      const oldest = captures.keys().next().value;
      if (oldest === undefined) break;
      captures.delete(oldest);
    }
  }
  if (stream.output !== undefined) capture.output = stream.output;
  if (stream.delta !== undefined) capture.output += stream.delta;
  if (capture.output.length > TERMINAL_OUTPUT_LIMIT) {
    capture.output = capture.output.slice(capture.output.length - TERMINAL_OUTPUT_LIMIT);
    capture.truncated = true;
  }
  if (stream.exited) {
    capture.exited = true;
    capture.exitCode = stream.exitCode ?? null;
  }
  return capture;
}

export type ToolEvent = Extract<TimelineEvent, { type: 'tool.call' | 'tool.update' }>;

/**
 * Stamp the captured output/exit onto the event's `terminal` block for that id. A tool_call_update that only
 * carries `_meta` gets the block synthesized: the client replaces content on update, and both adapters'
 * initial content for a shell command is exactly that one block.
 */
export function attachTerminalCapture(event: ToolEvent, terminalId: string, capture: TerminalCapture): void {
  const content = event.content ?? [];
  let block = content.find((b): b is Extract<ToolContent, { type: 'terminal' }> => b.type === 'terminal' && b.terminalId === terminalId);
  if (!block) {
    block = { type: 'terminal', terminalId };
    content.push(block);
    event.content = content;
  }
  block.output = capture.truncated ? `[earlier output truncated]\n${capture.output}` : capture.output;
  if (capture.exited) block.exitCode = capture.exitCode;
}

// ---------------------------------------------------------------------------
// Turn results
// ---------------------------------------------------------------------------
export type NormalizedStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error';

export function stopReason(v: unknown): NormalizedStopReason {
  switch (v) {
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
    case 'cancelled':
      return v;
    default:
      return 'end_turn';
  }
}

export function usageFromPrompt(v: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!isRec(v)) return undefined;
  const inputTokens = asNumber(v.inputTokens);
  const outputTokens = asNumber(v.outputTokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}
export const ZERO_USAGE: Readonly<UsageTotals> = { inputTokens: 0, outputTokens: 0 };

/**
 * What a `PromptResponse.usage` counts. ACP defines it as the session total ("across all turns"), which is
 * what claude-agent-acp reports; codex-acp reports the turn's own count (Codex's `last` token usage).
 */
export type UsageSemantics = 'cumulative' | 'per_turn';

export function usageSemantics(agentInfo: unknown): UsageSemantics {
  const name = isRec(agentInfo) ? asString(agentInfo.name) : undefined;
  return name === '@agentclientprotocol/codex-acp' ? 'per_turn' : 'cumulative';
}

/**
 * Token totals of a `PromptResponse.usage`. `inputTokens` is the whole context the model processed — fresh
 * input plus cache reads and writes, which both adapters report separately (Claude: 68 fresh vs 145k cached
 * on a typical turn) — because the phone shows context size on the turn divider, not a billing breakdown.
 */
export function usageTotals(raw: unknown): UsageTotals | null {
  if (!isRec(raw)) return null;
  const input = asNumber(raw.inputTokens);
  const output = asNumber(raw.outputTokens);
  if (input === undefined || output === undefined) return null;
  return { inputTokens: input + (asNumber(raw.cachedReadTokens) ?? 0) + (asNumber(raw.cachedWriteTokens) ?? 0), outputTokens: output };
}

/**
 * Per-turn usage for `turn.ended` plus the baseline to carry to the next turn. Cumulative agents report the
 * difference to the previous total; a `null` baseline (after session/load the history's total is unknown)
 * yields no usage for that turn and establishes one. A counter going backwards means the agent is not
 * cumulative after all: report the raw numbers and start over from them.
 */
export function turnUsage(
  raw: unknown,
  semantics: UsageSemantics,
  baseline: UsageTotals | null,
): { usage: { inputTokens: number; outputTokens: number } | undefined; baseline: UsageTotals | null } {
  const current = usageTotals(raw);
  if (!current) return { usage: undefined, baseline };
  if (semantics === 'per_turn') return { usage: current, baseline };
  if (baseline === null) return { usage: undefined, baseline: current };
  const delta = { inputTokens: current.inputTokens - baseline.inputTokens, outputTokens: current.outputTokens - baseline.outputTokens };
  if (delta.inputTokens < 0 || delta.outputTokens < 0) return { usage: current, baseline: current };
  return { usage: delta, baseline: current };
}

/** claude-agent-acp reports the session's cumulative cost in `usage_update.cost {amount, currency}` (USD). */
export function usageUpdateCost(update: unknown): number | undefined {
  if (!isRec(update) || update.sessionUpdate !== 'usage_update' || !isRec(update.cost)) return undefined;
  const amount = asNumber(update.cost.amount);
  const currency = asString(update.cost.currency) ?? 'USD';
  return amount !== undefined && amount >= 0 && currency.toUpperCase() === 'USD' ? amount : undefined;
}

/**
 * Agent-suggested session title, or undefined when it carries no information: codex-acp publishes the prompt
 * text itself as a placeholder until Codex names the thread, and the daemon already derives its default
 * title from the prompt. Whitespace is collapsed and the result capped like user titles (200 chars).
 */
export function agentTitle(raw: unknown, lastPromptText: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const title = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!title) return undefined;
  const prompt = lastPromptText.replace(/\s+/g, ' ').trim();
  if (prompt && (prompt === title || prompt.startsWith(title))) return undefined;
  return title;
}

/** Build the persisted PermissionRequest from an ACP `session/request_permission`. */
export function permissionRequest(
  params: unknown,
  ids: { permissionId: string; sessionId: string; turnId: string; createdAt: number },
): PermissionRequest {
  const p = isRec(params) ? params : {};
  const tc = isRec(p.toolCall) ? p.toolCall : {};
  const req: PermissionRequest = {
    permissionId: ids.permissionId,
    sessionId: ids.sessionId,
    turnId: ids.turnId,
    title: asString(tc.title) ?? asString(tc.name) ?? 'Permission required',
    options: permissionOptions(p.options),
    createdAt: ids.createdAt,
  };
  const toolCallId = asString(tc.toolCallId);
  if (toolCallId !== undefined) req.toolCallId = toolCallId;
  if (typeof tc.kind === 'string') req.kind = toolKind(tc.kind);
  if (tc.rawInput !== undefined && tc.rawInput !== null) req.rawInput = tc.rawInput;
  const content = toolContents(tc.content);
  if (content && content.length) req.content = content;
  const locations = toolLocations(tc.locations);
  if (locations && locations.length) req.locations = locations;
  if (req.options.length === 0) {
    // an agent that offers no options still needs an answer; synthesize the standard pair
    req.options = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ];
  }
  return req;
}

// ---------------------------------------------------------------------------
// Elicitation (ACP `elicitation/create`)
// ---------------------------------------------------------------------------
/** Titled options (`oneOf` / `anyOf` of `{const, title, description}`) or bare `enum` strings → one shape. */
function enumOptions(titled: unknown, plain: unknown): ElicitationEnumOption[] | undefined {
  const out: ElicitationEnumOption[] = [];
  if (Array.isArray(titled)) {
    for (const o of titled) {
      if (!isRec(o)) continue;
      const value = asString(o.const) ?? asString(o.value);
      if (value === undefined) continue;
      const description = asString(o.description);
      out.push({ value, title: asString(o.title) ?? value, ...(description ? { description } : {}) });
    }
  }
  if (out.length === 0 && Array.isArray(plain)) {
    for (const v of plain) if (typeof v === 'string') out.push({ value: v, title: v });
  }
  return out.length ? out : undefined;
}

function fieldBase(p: Rec): { title?: string; description?: string } {
  const title = asString(p.title)?.trim();
  const description = asString(p.description)?.trim();
  return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

/** One JSON-schema property → a form field. Unknown/custom types degrade to free text; never null. */
export function elicitationProperty(v: unknown): ElicitationProperty {
  const p = isRec(v) ? v : {};
  const base = fieldBase(p);
  switch (p.type) {
    case 'number':
    case 'integer': {
      const integer = p.type === 'integer';
      const out: Extract<ElicitationProperty, { type: 'number' | 'integer' }> = { type: integer ? 'integer' : 'number', ...base };
      const def = asNumber(p.default);
      if (def !== undefined && (!integer || Number.isInteger(def))) out.default = def;
      const minimum = asNumber(p.minimum);
      if (minimum !== undefined) out.minimum = minimum;
      const maximum = asNumber(p.maximum);
      if (maximum !== undefined) out.maximum = maximum;
      return out;
    }
    case 'boolean': {
      const out: ElicitationProperty = { type: 'boolean', ...base };
      if (typeof p.default === 'boolean') out.default = p.default;
      return out;
    }
    case 'array': {
      const items = isRec(p.items) ? p.items : {};
      const options = enumOptions(items.anyOf ?? items.oneOf, items.enum) ?? [];
      const out: ElicitationProperty = { type: 'array', ...base, options };
      if (Array.isArray(p.default)) out.default = p.default.filter((d): d is string => typeof d === 'string');
      const minItems = asNumber(p.minItems);
      if (minItems !== undefined && minItems >= 0) out.minItems = Math.floor(minItems);
      const maxItems = asNumber(p.maxItems);
      if (maxItems !== undefined && maxItems >= 0) out.maxItems = Math.floor(maxItems);
      return out;
    }
    default: {
      const out: ElicitationProperty = { type: 'string', ...base };
      const options = enumOptions(p.oneOf ?? p.anyOf, p.enum);
      if (options) out.options = options;
      const def = asString(p.default);
      if (def !== undefined) out.default = def;
      const minLength = asNumber(p.minLength);
      if (minLength !== undefined && minLength >= 0) out.minLength = Math.floor(minLength);
      const maxLength = asNumber(p.maxLength);
      if (maxLength !== undefined && maxLength >= 0) out.maxLength = Math.floor(maxLength);
      const pattern = asString(p.pattern);
      if (pattern) out.pattern = pattern;
      const format = asString(p.format);
      if (format === 'email' || format === 'uri' || format === 'date' || format === 'date-time') out.format = format;
      return out;
    }
  }
}

/** The `requestedSchema` of a form elicitation → the phone's flat form. A missing schema is an empty form (a confirm). */
export function elicitationSchema(v: unknown): ElicitationSchema {
  const s = isRec(v) ? v : {};
  const schema: ElicitationSchema = { properties: {}, required: [] };
  const title = asString(s.title)?.trim();
  if (title) schema.title = title;
  const description = asString(s.description)?.trim();
  if (description) schema.description = description;
  if (isRec(s.properties)) {
    for (const [name, prop] of Object.entries(s.properties)) schema.properties[name] = elicitationProperty(prop);
  }
  if (Array.isArray(s.required)) schema.required = s.required.filter((r): r is string => typeof r === 'string' && r in schema.properties);
  return schema;
}

/**
 * Build the persisted ElicitationRequest from an ACP `elicitation/create`. Returns null when the daemon cannot
 * present it (a mode it did not advertise, a url-mode request without a URL): the caller declines it.
 */
export function elicitationRequest(
  params: unknown,
  ids: { elicitationId: string; sessionId: string; turnId: string; createdAt: number },
): ElicitationRequest | null {
  const p = isRec(params) ? params : {};
  const message = asString(p.message)?.trim() || 'The agent needs your input';
  const base = { elicitationId: ids.elicitationId, sessionId: ids.sessionId, turnId: ids.turnId, message, createdAt: ids.createdAt };
  const toolCallId = asString(p.toolCallId);
  if (p.mode === 'form') {
    const req: ElicitationRequest = { ...base, mode: 'form', schema: elicitationSchema(p.requestedSchema) };
    if (toolCallId !== undefined) req.toolCallId = toolCallId;
    return req;
  }
  if (p.mode === 'url') {
    const url = asString(p.url)?.trim();
    if (!url) return null;
    const req: ElicitationRequest = { ...base, mode: 'url', url };
    if (toolCallId !== undefined) req.toolCallId = toolCallId;
    return req;
  }
  return null;
}

/** Select options of the config option in category "model" (or with id "model"), groups flattened. */
function modelSelectOptions(v: unknown): { configId: string | undefined; current: string | undefined; options: Rec[] }[] {
  const out: { configId: string | undefined; current: string | undefined; options: Rec[] }[] = [];
  if (!Array.isArray(v)) return out;
  for (const opt of v) {
    if (!isRec(opt) || opt.type !== 'select') continue;
    const category = asString(opt.category) ?? (asString(opt.id) === 'model' ? 'model' : undefined);
    if (category !== 'model') continue;
    const options = Array.isArray(opt.options) ? opt.options : [];
    const flat: Rec[] = [];
    for (const o of options) {
      if (!isRec(o)) continue;
      if (Array.isArray(o.options)) {
        for (const g of o.options) if (isRec(g)) flat.push(g); // a group: its members
      } else {
        flat.push(o); // an ungrouped option
      }
    }
    out.push({ configId: asString(opt.id), current: asString(opt.currentValue), options: flat });
  }
  return out;
}

/** Extract the current model name from ACP config options (category "model"). */
export function modelFromConfigOptions(v: unknown): { current?: string; all: string[] } {
  const all: string[] = [];
  let current: string | undefined;
  for (const select of modelSelectOptions(v)) {
    for (const o of select.options) {
      const value = asString(o.value);
      const name = asString(o.name) ?? value;
      if (name && !all.includes(name)) all.push(name);
      if (select.current !== undefined && value === select.current) current = name;
    }
    if (current === undefined && select.current !== undefined) current = select.current;
  }
  return current !== undefined ? { current, all } : { all };
}

/** Find the config option value id for a requested model (by value id or display name). */
export function findModelValue(v: unknown, wanted: string): { configId: string; value: string } | null {
  for (const select of modelSelectOptions(v)) {
    if (select.configId === undefined) continue;
    for (const o of select.options) {
      const value = asString(o.value);
      if (value === undefined) continue;
      if (value === wanted || asString(o.name) === wanted) return { configId: select.configId, value };
    }
  }
  return null;
}
