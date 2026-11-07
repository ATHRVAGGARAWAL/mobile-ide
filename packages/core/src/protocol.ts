/**
 * Wire protocol between the phone/browser client and the mobile-ide daemon.
 *
 * Design rules (see docs/PLAN.md):
 *  - Every persisted event carries a per-session monotonic `seq`. The server appends to
 *    SQLite BEFORE broadcasting; clients resume with `subscribe { afterSeq }`.
 *  - The client never speaks ACP. The daemon normalizes ACP `session/update` into
 *    `TimelineEvent`s so any agent renders identically.
 *  - Permission requests are persisted and stay pending until answered. `cancelled`
 *    aborts the whole turn and is only sent on an explicit user action.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Content blocks (subset of ACP ContentBlock that the phone can produce/render)
// ---------------------------------------------------------------------------
export const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
export const ImageBlock = z.object({
  type: z.literal('image'),
  mimeType: z.string(),
  /** base64 payload */
  data: z.string(),
});
export const ResourceLinkBlock = z.object({
  type: z.literal('resource_link'),
  uri: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
});
export const ContentBlock = z.discriminatedUnion('type', [TextBlock, ImageBlock, ResourceLinkBlock]);
export type ContentBlock = z.infer<typeof ContentBlock>;

// ---------------------------------------------------------------------------
// Agents, sessions
// ---------------------------------------------------------------------------
export const AgentId = z.string().min(1); // 'claude' | 'codex' | 'opencode' | custom id from config
export type AgentId = z.infer<typeof AgentId>;

export const SessionStatus = z.enum(['starting', 'idle', 'running', 'needs_you', 'error', 'closed']);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionMode = z.object({ id: z.string(), name: z.string(), description: z.string().optional() });
export type SessionMode = z.infer<typeof SessionMode>;

export const SlashCommand = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** hint for the argument, e.g. "<file>" */
  input: z.string().optional(),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

export const SessionSummary = z.object({
  id: z.string(),
  agent: AgentId,
  agentName: z.string(),
  cwd: z.string(),
  projectName: z.string(),
  title: z.string(),
  status: SessionStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
  lastSeq: z.number(),
  lastMessagePreview: z.string().optional(),
  /** items waiting for the user in this session: permission requests plus elicitations (questions, URL hand-offs) */
  pendingPermissions: z.number(),
  /** how many of `pendingPermissions` are elicitations (absent = 0) */
  pendingElicitations: z.number().optional(),
  modeId: z.string().optional(),
  availableModes: z.array(SessionMode).optional(),
  model: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const AgentInfo = z.object({
  id: AgentId,
  name: z.string(),
  available: z.boolean(),
  /** why unavailable, if so */
  reason: z.string().optional(),
  models: z.array(z.string()).optional(),
  defaultModel: z.string().optional(),
  supportsImages: z.boolean().optional(),
  supportsLoadSession: z.boolean().optional(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const ProjectInfo = z.object({
  root: z.string(),
  name: z.string(),
  isGit: z.boolean(),
  branch: z.string().optional(),
  sessionCount: z.number(),
  lastUsedAt: z.number().optional(),
});
export type ProjectInfo = z.infer<typeof ProjectInfo>;

// ---------------------------------------------------------------------------
// Tool calls (normalized from ACP)
// ---------------------------------------------------------------------------
export const ToolKind = z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
export type ToolKind = z.infer<typeof ToolKind>;
export const ToolStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);
export type ToolStatus = z.infer<typeof ToolStatus>;

export const DiffContent = z.object({
  type: z.literal('diff'),
  path: z.string(),
  oldText: z.string().nullable(),
  newText: z.string(),
});
export const TerminalContent = z.object({
  type: z.literal('terminal'),
  terminalId: z.string(),
  /** captured output, if the daemon could collect it */
  output: z.string().optional(),
  exitCode: z.number().nullable().optional(),
});
export const BlockContent = z.object({ type: z.literal('content'), content: ContentBlock });
export const ToolContent = z.discriminatedUnion('type', [DiffContent, TerminalContent, BlockContent]);
export type ToolContent = z.infer<typeof ToolContent>;

export const ToolLocation = z.object({ path: z.string(), line: z.number().optional() });
export type ToolLocation = z.infer<typeof ToolLocation>;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------
export const PermissionOptionKind = z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']);
export const PermissionOption = z.object({ optionId: z.string(), name: z.string(), kind: PermissionOptionKind });
export type PermissionOption = z.infer<typeof PermissionOption>;

export const PermissionRequest = z.object({
  permissionId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  toolCallId: z.string().optional(),
  title: z.string(),
  kind: ToolKind.optional(),
  /** the literal input the agent wants to run with — ALWAYS shown to the user */
  rawInput: z.unknown().optional(),
  content: z.array(ToolContent).optional(),
  locations: z.array(ToolLocation).optional(),
  options: z.array(PermissionOption),
  createdAt: z.number(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

// ---------------------------------------------------------------------------
// Elicitation (ACP `elicitation/create`): the agent asks the user a question (form mode — Claude Code's
// AskUserQuestion, MCP servers) or hands off to a URL (url mode — OAuth flows). Durable like permissions:
// persisted before the phone hears about it, pending until answered, cancelled by the daemon on shutdown/restart.
// ---------------------------------------------------------------------------
/** One choice of a single- or multi-select field. `value` is what the agent receives (JSON-schema `const`/`enum`). */
export const ElicitationEnumOption = z.object({ value: z.string(), title: z.string(), description: z.string().optional() });
export type ElicitationEnumOption = z.infer<typeof ElicitationEnumOption>;

const elicitationField = { title: z.string().optional(), description: z.string().optional() };

/**
 * A form field: the MCP/ACP elicitation JSON-schema subset (flat objects of primitives), normalized by the daemon —
 * `enum` and titled `oneOf`/`anyOf` both arrive as `options`; unknown property types are rendered as free text.
 */
export const ElicitationProperty = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('string'),
    ...elicitationField,
    default: z.string().optional(),
    /** single-select choices; absent = free text */
    options: z.array(ElicitationEnumOption).optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    pattern: z.string().optional(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
  }),
  z.object({
    type: z.literal('number'),
    ...elicitationField,
    default: z.number().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  }),
  z.object({
    type: z.literal('integer'),
    ...elicitationField,
    default: z.number().int().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  }),
  z.object({ type: z.literal('boolean'), ...elicitationField, default: z.boolean().optional() }),
  z.object({
    type: z.literal('array'),
    ...elicitationField,
    /** multi-select choices */
    options: z.array(ElicitationEnumOption),
    default: z.array(z.string()).optional(),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
  }),
]);
export type ElicitationProperty = z.infer<typeof ElicitationProperty>;

export const ElicitationSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  /** field name → field; the form renders fields in this order */
  properties: z.record(z.string(), ElicitationProperty),
  required: z.array(z.string()),
});
export type ElicitationSchema = z.infer<typeof ElicitationSchema>;

export const ElicitationValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
export type ElicitationValue = z.infer<typeof ElicitationValue>;
/** An accepted form's answers, keyed by field name. */
export const ElicitationContent = z.record(z.string(), ElicitationValue);
export type ElicitationContent = z.infer<typeof ElicitationContent>;

/** accept = answered (form) / opened (url); decline = explicitly refused ("skip"); cancel = dismissed without choosing. */
export const ElicitationAction = z.enum(['accept', 'decline', 'cancel']);
export type ElicitationAction = z.infer<typeof ElicitationAction>;

export const ElicitationRequest = z.object({
  elicitationId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  /** the tool call this question belongs to (Claude Code's AskUserQuestion, an MCP tool), when the agent said */
  toolCallId: z.string().optional(),
  mode: z.enum(['form', 'url']),
  /** what the agent is asking, verbatim */
  message: z.string(),
  /** form mode: the fields to render */
  schema: ElicitationSchema.optional(),
  /** url mode: where the user is sent — shown in full before it is opened */
  url: z.string().optional(),
  createdAt: z.number(),
});
export type ElicitationRequest = z.infer<typeof ElicitationRequest>;

/** Field name → problem. Empty = valid. Shared by the daemon (before answering the agent) and the form (inline errors). */
export type ElicitationFieldErrors = Record<string, string>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function elicitationValueProblem(prop: ElicitationProperty, value: unknown): string | null {
  switch (prop.type) {
    case 'string': {
      if (typeof value !== 'string') return 'Must be text';
      if (prop.options && !prop.options.some((o) => o.value === value)) return 'Must be one of the offered options';
      if (prop.minLength !== undefined && value.length < prop.minLength) return `At least ${prop.minLength} characters`;
      if (prop.maxLength !== undefined && value.length > prop.maxLength) return `At most ${prop.maxLength} characters`;
      if (prop.pattern !== undefined) {
        try {
          if (!new RegExp(prop.pattern).test(value)) return 'Does not match the expected format';
        } catch {
          /* an invalid pattern from the agent is not the user's problem */
        }
      }
      if (prop.format === 'email' && !EMAIL_RE.test(value)) return 'Must be an email address';
      if (prop.format === 'date' && !DATE_RE.test(value)) return 'Must be a date (YYYY-MM-DD)';
      if (prop.format === 'date-time' && Number.isNaN(Date.parse(value))) return 'Must be a date and time';
      if (prop.format === 'uri') {
        try {
          new URL(value);
        } catch {
          return 'Must be a URL';
        }
      }
      return null;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Must be a number';
      if (prop.type === 'integer' && !Number.isInteger(value)) return 'Must be a whole number';
      if (prop.minimum !== undefined && value < prop.minimum) return `Must be at least ${prop.minimum}`;
      if (prop.maximum !== undefined && value > prop.maximum) return `Must be at most ${prop.maximum}`;
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Must be yes or no';
    case 'array': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return 'Must be a selection';
      if (value.some((v) => !prop.options.some((o) => o.value === v))) return 'Must be among the offered options';
      if (prop.minItems !== undefined && value.length < prop.minItems) return `Choose at least ${prop.minItems}`;
      if (prop.maxItems !== undefined && value.length > prop.maxItems) return `Choose at most ${prop.maxItems}`;
      return null;
    }
  }
}

/**
 * Validate an `accept` payload against a form schema: required fields present, every value of the right type and
 * within the field's constraints, no fields the schema does not define. An empty string or empty selection counts
 * as "not answered" (fine for optional fields, `Required` otherwise).
 */
export function validateElicitationContent(schema: ElicitationSchema, content: Record<string, unknown>): ElicitationFieldErrors {
  const errors: ElicitationFieldErrors = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    const value = content[name];
    const blank = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (blank) {
      if (schema.required.includes(name)) errors[name] = 'Required';
      continue;
    }
    const problem = elicitationValueProblem(prop, value);
    if (problem) errors[name] = problem;
  }
  for (const name of Object.keys(content)) if (!(name in schema.properties)) errors[name] = 'Not a field of this form';
  return errors;
}

/**
 * Initial answers for a form: the schema's defaults, plus `false` for booleans (a toggle always has a value).
 * Fields without a default are left unanswered so an optional field the user never touched is not sent.
 */
export function elicitationDefaults(schema: ElicitationSchema): ElicitationContent {
  const out: ElicitationContent = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (prop.type === 'boolean') out[name] = prop.default ?? false;
    else if (prop.default !== undefined) out[name] = prop.default;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timeline events (persisted, seq-ordered per session)
// ---------------------------------------------------------------------------
export const TimelineEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.created'),
    agent: AgentId,
    cwd: z.string(),
    title: z.string(),
    modeId: z.string().optional(),
    availableModes: z.array(SessionMode).optional(),
    model: z.string().optional(),
  }),
  z.object({ type: z.literal('session.status'), status: SessionStatus, detail: z.string().optional() }),
  z.object({ type: z.literal('session.renamed'), title: z.string() }),
  z.object({ type: z.literal('session.error'), message: z.string(), code: z.string().optional(), fatal: z.boolean().optional() }),
  /** the user's prompt; starts a turn */
  z.object({ type: z.literal('turn.started'), turnId: z.string(), blocks: z.array(ContentBlock) }),
  z.object({
    type: z.literal('turn.ended'),
    turnId: z.string(),
    stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'error']),
    usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().optional() }).optional(),
  }),
  z.object({ type: z.literal('message.delta'), turnId: z.string(), text: z.string() }),
  z.object({ type: z.literal('thought.delta'), turnId: z.string(), text: z.string() }),
  z.object({
    type: z.literal('tool.call'),
    turnId: z.string(),
    toolCallId: z.string(),
    title: z.string(),
    kind: ToolKind,
    status: ToolStatus,
    content: z.array(ToolContent).optional(),
    locations: z.array(ToolLocation).optional(),
    rawInput: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('tool.update'),
    turnId: z.string(),
    toolCallId: z.string(),
    title: z.string().optional(),
    kind: ToolKind.optional(),
    status: ToolStatus.optional(),
    /** replaces previous content when present (ACP semantics) */
    content: z.array(ToolContent).optional(),
    locations: z.array(ToolLocation).optional(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('plan'),
    turnId: z.string(),
    entries: z.array(
      z.object({
        content: z.string(),
        priority: z.enum(['high', 'medium', 'low']),
        status: z.enum(['pending', 'in_progress', 'completed']),
      }),
    ),
  }),
  z.object({ type: z.literal('permission.requested'), request: PermissionRequest }),
  z.object({
    type: z.literal('permission.resolved'),
    permissionId: z.string(),
    outcome: z.enum(['selected', 'cancelled']),
    optionId: z.string().optional(),
    /** who resolved it: device id or 'server' (e.g. on restart) */
    by: z.string().optional(),
  }),
  z.object({ type: z.literal('elicitation.requested'), request: ElicitationRequest }),
  z.object({
    type: z.literal('elicitation.resolved'),
    elicitationId: z.string(),
    action: ElicitationAction,
    /** the answers, for `accept` in form mode */
    content: ElicitationContent.optional(),
    /** who resolved it: device id, 'server' (restart, shutdown, cancel) or 'agent' (url flow completed on its side) */
    by: z.string().optional(),
  }),
  z.object({ type: z.literal('mode.changed'), modeId: z.string() }),
  z.object({ type: z.literal('commands.updated'), commands: z.array(SlashCommand) }),
]);
export type TimelineEvent = z.infer<typeof TimelineEvent>;

export const EventEnvelope = z.object({
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  event: TimelineEvent,
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

// ---------------------------------------------------------------------------
// Live filesystem (side channel: not part of a session's event log — replay reproduces the timeline, not the disk)
// ---------------------------------------------------------------------------
/**
 * Entries that changed inside one watched directory (`fs.watch`), coalesced over a few milliseconds. `names` are entry
 * names inside `dir` (files or sub-directories; the kind is not known — stat if it matters). `gone` means the watched
 * directory itself disappeared (or the watcher failed) and the watch is over; watch again once it exists.
 */
export const FsChange = z.object({
  root: z.string(),
  /** directory relative to `root`, forward slashes, '' for the root itself */
  dir: z.string(),
  names: z.array(z.string()),
  gone: z.boolean().optional(),
  ts: z.number(),
});
export type FsChange = z.infer<typeof FsChange>;

// ---------------------------------------------------------------------------
// WebSocket frames: client -> server
// ---------------------------------------------------------------------------
export const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocolVersion: z.number(), clientName: z.string(), clientVersion: z.string() }),
  /** `afterSeq` -1 = from the start (a fresh TimelineState sits at lastSeq -1); servers also treat 0 as inclusive. */
  z.object({ type: z.literal('subscribe'), sessionId: z.string(), afterSeq: z.number().int().min(-1) }),
  z.object({ type: z.literal('unsubscribe'), sessionId: z.string() }),
  z.object({
    type: z.literal('prompt'),
    requestId: z.string(),
    sessionId: z.string(),
    blocks: z.array(ContentBlock).min(1),
  }),
  z.object({ type: z.literal('cancel'), requestId: z.string(), sessionId: z.string() }),
  z.object({
    type: z.literal('permission.respond'),
    requestId: z.string(),
    sessionId: z.string(),
    permissionId: z.string(),
    outcome: z.enum(['selected', 'cancelled']),
    optionId: z.string().optional(),
  }),
  z.object({ type: z.literal('set_mode'), requestId: z.string(), sessionId: z.string(), modeId: z.string() }),
  /** answer an elicitation; `content` is the form's answers for `accept` (validated against the schema by the daemon) */
  z.object({
    type: z.literal('elicitation.respond'),
    requestId: z.string(),
    sessionId: z.string(),
    elicitationId: z.string(),
    action: ElicitationAction,
    content: ElicitationContent.optional(),
  }),
  z.object({ type: z.literal('sessions.watch') }),
  /**
   * Live filesystem: watch one directory (non-recursive) under a project root for changes to its entries — the folder an
   * open file lives in, an expanded explorer folder. `dir` is relative to `root` ('' = the root itself). Acked; the daemon
   * then sends `fs.changed` frames until `fs.unwatch` or the socket closes. Directories, not files: agents and editors
   * replace files by rename, which a per-file watcher silently loses.
   */
  z.object({ type: z.literal('fs.watch'), requestId: z.string(), root: z.string(), dir: z.string() }),
  z.object({ type: z.literal('fs.unwatch'), requestId: z.string(), root: z.string(), dir: z.string() }),
  z.object({ type: z.literal('ping'), ts: z.number() }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ---------------------------------------------------------------------------
// WebSocket frames: server -> client
// ---------------------------------------------------------------------------
export const ServerFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    protocolVersion: z.number(),
    serverVersion: z.string(),
    serverName: z.string(),
    deviceId: z.string(),
  }),
  z.object({ type: z.literal('event'), envelope: EventEnvelope }),
  /** sent after a subscribe's replay completes; live events follow */
  z.object({ type: z.literal('replay.done'), sessionId: z.string(), lastSeq: z.number() }),
  z.object({ type: z.literal('ack'), requestId: z.string(), ok: z.boolean(), error: z.string().optional() }),
  z.object({ type: z.literal('sessions.changed'), sessions: z.array(SessionSummary) }),
  z.object({ type: z.literal('fs.changed'), change: FsChange }),
  z.object({ type: z.literal('pong'), ts: z.number() }),
  z.object({ type: z.literal('error'), message: z.string(), code: z.string().optional() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

// ---------------------------------------------------------------------------
// REST bodies
// ---------------------------------------------------------------------------
export const PairRequest = z.object({ code: z.string().min(4), deviceName: z.string().min(1).max(80), platform: z.string().optional() });
export const PairResponse = z.object({ token: z.string(), deviceId: z.string(), serverName: z.string() });
export const CreateSessionRequest = z.object({
  agent: AgentId,
  cwd: z.string(),
  title: z.string().optional(),
  modeId: z.string().optional(),
  model: z.string().optional(),
  /** first prompt to send immediately after creation */
  initialPrompt: z.array(ContentBlock).optional(),
});
export const RenameSessionRequest = z.object({ title: z.string().min(1).max(200) });
export const RegisterPushRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('expo'), token: z.string() }),
  z.object({ kind: z.literal('ntfy'), server: z.string().url().optional(), topic: z.string() }),
  z.object({
    kind: z.literal('webpush'),
    subscription: z.object({ endpoint: z.string(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }),
  }),
]);

/** Public VAPID key for Web Push; `publicKey` is null when the daemon has none configured. */
export const PushVapidResponse = z.object({ publicKey: z.string().nullable() });
export type PushVapidResponse = z.infer<typeof PushVapidResponse>;

export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['file', 'dir', 'symlink', 'other']),
  size: z.number().optional(),
  mtime: z.number().optional(),
  gitStatus: z.string().optional(),
});
export type FsEntry = z.infer<typeof FsEntry>;
export const FileContent = z.object({
  path: z.string(),
  content: z.string(),
  language: z.string(),
  size: z.number(),
  truncated: z.boolean(),
  binary: z.boolean(),
  /** last modification time (ms since epoch, integer) — the optimistic-concurrency token for PUT /api/fs/file */
  mtime: z.number().optional(),
});
export type FileContent = z.infer<typeof FileContent>;

/** POST /api/studio/open — ask the daemon's machine to show the Studio (a window per request unless one is connected). */
export const StudioOpenRequest = z.object({ sessionId: z.string().optional() });
export type StudioOpenRequest = z.infer<typeof StudioOpenRequest>;
export const StudioOpenResponse = z.object({
  /** a browser window was spawned */
  opened: z.boolean(),
  /** a Studio window is already connected (it follows the session on its own) */
  connected: z.boolean(),
  url: z.string(),
  reason: z.string().optional(),
  browser: z.string().optional(),
});
export type StudioOpenResponse = z.infer<typeof StudioOpenResponse>;

/** PUT /api/fs/file — write a text file under a project root (the Studio editor's save). */
export const WriteFileRequest = z.object({
  root: z.string(),
  path: z.string().min(1),
  content: z.string(),
  /** the `mtime` the client last read; a different value on disk fails with 409 `conflict` so nobody's work is overwritten blindly */
  expectedMtime: z.number().optional(),
  /** create missing parent directories */
  createDirs: z.boolean().optional(),
});
export type WriteFileRequest = z.infer<typeof WriteFileRequest>;
export const WriteFileResponse = z.object({ path: z.string(), size: z.number(), mtime: z.number(), created: z.boolean() });
export type WriteFileResponse = z.infer<typeof WriteFileResponse>;
export const MAX_UPLOAD_IMAGE_BYTES = 5 * 1024 * 1024;
export const UploadImageRequest = z.object({
  root: z
    .string()
    .min(1)
    .regex(/^[^\x00-\x1f\x7f]+$/),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  data: z
    .string()
    .min(4)
    .max(4 * Math.ceil(MAX_UPLOAD_IMAGE_BYTES / 3)),
});
export type UploadImageRequest = z.infer<typeof UploadImageRequest>;
export const UploadImageResponse = z.object({ path: z.string(), absolutePath: z.string(), size: z.number() });
export type UploadImageResponse = z.infer<typeof UploadImageResponse>;
export const SearchMatch = z.object({ path: z.string(), line: z.number(), column: z.number(), text: z.string() });
export type SearchMatch = z.infer<typeof SearchMatch>;
export const GitStatusEntry = z.object({ path: z.string(), index: z.string(), worktree: z.string(), renamedFrom: z.string().optional() });
export const GitStatus = z.object({
  branch: z.string().optional(),
  ahead: z.number().optional(),
  behind: z.number().optional(),
  entries: z.array(GitStatusEntry),
});
export type GitStatus = z.infer<typeof GitStatus>;
export const GitDiff = z.object({ path: z.string().optional(), staged: z.boolean(), patch: z.string(), truncated: z.boolean() });
export type GitDiff = z.infer<typeof GitDiff>;
export const GitLogEntry = z.object({ hash: z.string(), shortHash: z.string(), author: z.string(), date: z.number(), subject: z.string() });
export type GitLogEntry = z.infer<typeof GitLogEntry>;

/** One of the user's tmux-backed shells (`/ws/terminal?id=`), as listed by GET /api/terminals. */
export const TerminalInfo = z.object({
  id: z.string(),
  cwd: z.string(),
  /** live `/ws/terminal` attachments to this shell */
  attached: z.number().int().nonnegative(),
});
export type TerminalInfo = z.infer<typeof TerminalInfo>;

export const HealthResponse = z.object({
  ok: z.boolean(),
  serverName: z.string(),
  version: z.string(),
  uptimeSec: z.number(),
  agents: z.array(
    z.object({
      id: AgentId,
      state: z.enum(['stopped', 'starting', 'ready', 'error']),
      sessions: z.number(),
      detail: z.string().optional(),
    }),
  ),
  sessions: z.object({ total: z.number(), running: z.number(), needsYou: z.number() }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
/** Laptop activity is a read-only snapshot, separate from durable Mobile IDE chat events. */
export const LaptopSession = z.object({
  id: z.string(),
  source: z.enum(['codex', 'claude']),
  title: z.string(),
  cwd: z.string(),
  updatedAt: z.number(),
});
export type LaptopSession = z.infer<typeof LaptopSession>;
export const LiveLaptopWork = z.object({
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  command: z.string(),
  terminalId: z.string().optional(),
  updatedAt: z.number(),
});
export type LiveLaptopWork = z.infer<typeof LiveLaptopWork>;
export const LaptopActivity = z.object({
  live: z.array(LiveLaptopWork),
  recent: z.array(LaptopSession),
  warnings: z.array(z.string()),
});
export type LaptopActivity = z.infer<typeof LaptopActivity>;
export const LaptopHistory = z.object({
  session: LaptopSession,
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })),
  note: z.string(),
});
export type LaptopHistory = z.infer<typeof LaptopHistory>;
