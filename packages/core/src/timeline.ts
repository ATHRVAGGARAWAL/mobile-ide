/**
 * Pure reducer: EventEnvelope stream -> renderable timeline items.
 * Framework-free so the Expo app, the web client and server tests share it.
 */
import type {
  ContentBlock,
  ElicitationAction,
  ElicitationContent,
  ElicitationRequest,
  EventEnvelope,
  PermissionRequest,
  SessionMode,
  SessionStatus,
  SlashCommand,
  ToolContent,
  ToolKind,
  ToolLocation,
  ToolStatus,
} from './protocol.js';

type DiffBlock = Extract<ToolContent, { type: 'diff' }>;

export type TimelineItem =
  | { kind: 'user'; id: string; turnId: string; blocks: ContentBlock[]; ts: number }
  | { kind: 'assistant'; id: string; turnId: string; text: string; ts: number; streaming: boolean }
  | { kind: 'thought'; id: string; turnId: string; text: string; ts: number; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      turnId: string;
      toolCallId: string;
      title: string;
      toolKind: ToolKind;
      status: ToolStatus;
      content: ToolContent[];
      locations: ToolLocation[];
      rawInput?: unknown;
      rawOutput?: unknown;
      ts: number;
      endedTs?: number;
      /**
       * A permission request for this call is still open: the agent has not started it, so the card shows
       * "waiting for approval" instead of a running spinner and a ticking timer.
       */
      awaitingPermission?: boolean;
      /** when the call actually began running — at its approval when one was needed; `ts` otherwise */
      startedTs?: number;
      /**
       * Diff blocks the agent attached to this call's permission request. OpenCode never puts the diff on the
       * tool call itself (its completion update replaces `content` with "Wrote file successfully."), so they are
       * kept here and re-applied whenever an update replaces `content` without a diff of its own.
       */
      approvalDiffs?: DiffBlock[];
    }
  | { kind: 'plan'; id: string; turnId: string; entries: { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }[]; ts: number }
  | { kind: 'permission'; id: string; request: PermissionRequest; resolved?: { outcome: 'selected' | 'cancelled'; optionId?: string }; ts: number }
  /** the agent's question (form) or URL hand-off; `resolved` once answered from any device (or by the daemon) */
  | { kind: 'elicitation'; id: string; request: ElicitationRequest; resolved?: { action: ElicitationAction; content?: ElicitationContent }; ts: number }
  | { kind: 'turn_end'; id: string; turnId: string; stopReason: string; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }; ts: number }
  | { kind: 'error'; id: string; message: string; fatal: boolean; ts: number }
  | { kind: 'system'; id: string; text: string; ts: number };

export interface TimelineState {
  sessionId: string;
  lastSeq: number;
  status: SessionStatus;
  title: string;
  modeId?: string;
  availableModes: SessionMode[];
  commands: SlashCommand[];
  items: TimelineItem[];
  /** toolCallId -> index in items */
  toolIndex: Record<string, number>;
  /** permissionId -> index in items */
  permissionIndex: Record<string, number>;
  pendingPermissions: PermissionRequest[];
  /** elicitationId -> index in items */
  elicitationIndex: Record<string, number>;
  pendingElicitations: ElicitationRequest[];
  currentTurnId?: string;
}

export function createTimeline(sessionId: string): TimelineState {
  return {
    sessionId,
    lastSeq: -1,
    status: 'starting',
    title: '',
    availableModes: [],
    commands: [],
    items: [],
    toolIndex: {},
    permissionIndex: {},
    pendingPermissions: [],
    elicitationIndex: {},
    pendingElicitations: [],
  };
}

/** Something is waiting for the user: a permission request or an elicitation. */
function needsYou(state: TimelineState): boolean {
  return state.pendingPermissions.length > 0 || state.pendingElicitations.length > 0;
}

/** Status once a request is answered: still `needs_you` while others wait, else back to the turn's state. */
function statusAfterAnswer(state: TimelineState): SessionStatus {
  return needsYou(state) ? 'needs_you' : state.currentTurnId ? 'running' : 'idle';
}

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

function toolItem(state: TimelineState, toolCallId: string): ToolItem | undefined {
  const idx = state.toolIndex[toolCallId];
  const it = idx === undefined ? undefined : state.items[idx];
  return it && it.kind === 'tool' ? it : undefined;
}

/**
 * Show the diff a permission request carried on the tool card as well, and keep showing it after an update
 * replaced `content` (ACP semantics) with something that has no diff. A tool call that brought its own diff
 * (claude-agent-acp Edit) is left alone.
 */
function attachApprovalDiffs(it: ToolItem, request?: PermissionRequest): void {
  if (request) {
    const diffs = (request.content ?? []).filter((c): c is DiffBlock => c.type === 'diff');
    if (diffs.length) it.approvalDiffs = diffs;
  }
  if (it.approvalDiffs?.length && !it.content.some((c) => c.type === 'diff')) it.content = [...it.approvalDiffs, ...it.content];
}

/**
 * Apply one envelope. Returns the same state object mutated (callers that need
 * immutability should clone first). Out-of-order or duplicate seqs are ignored,
 * which makes replay + live overlap safe.
 */
export function applyEnvelope(state: TimelineState, env: EventEnvelope): TimelineState {
  if (env.sessionId !== state.sessionId) return state;
  if (env.seq <= state.lastSeq) return state; // duplicate / replayed
  state.lastSeq = env.seq;
  const e = env.event;
  const ts = env.ts;
  const id = `${env.sessionId}:${env.seq}`;

  switch (e.type) {
    case 'session.created':
      state.title = e.title;
      state.modeId = e.modeId;
      state.availableModes = e.availableModes ?? [];
      state.status = 'idle';
      break;
    case 'session.status':
      state.status = e.status;
      break;
    case 'session.renamed':
      state.title = e.title;
      break;
    case 'session.error':
      state.items.push({ kind: 'error', id, message: e.message, fatal: !!e.fatal, ts });
      if (e.fatal) state.status = 'error';
      break;
    case 'turn.started':
      state.currentTurnId = e.turnId;
      state.status = 'running';
      state.items.push({ kind: 'user', id, turnId: e.turnId, blocks: e.blocks, ts });
      break;
    case 'turn.ended': {
      // close any streaming bubbles for this turn
      for (const it of state.items) {
        if ((it.kind === 'assistant' || it.kind === 'thought') && it.turnId === e.turnId) it.streaming = false;
      }
      state.items.push({ kind: 'turn_end', id, turnId: e.turnId, stopReason: e.stopReason, usage: e.usage, ts });
      if (state.currentTurnId === e.turnId) state.currentTurnId = undefined;
      state.status = needsYou(state) ? 'needs_you' : 'idle';
      break;
    }
    case 'message.delta': {
      const last = state.items[state.items.length - 1];
      if (last && last.kind === 'assistant' && last.turnId === e.turnId && last.streaming) {
        last.text += e.text;
      } else {
        state.items.push({ kind: 'assistant', id, turnId: e.turnId, text: e.text, ts, streaming: true });
      }
      break;
    }
    case 'thought.delta': {
      const last = state.items[state.items.length - 1];
      if (last && last.kind === 'thought' && last.turnId === e.turnId && last.streaming) {
        last.text += e.text;
      } else {
        state.items.push({ kind: 'thought', id, turnId: e.turnId, text: e.text, ts, streaming: true });
      }
      break;
    }
    case 'tool.call': {
      // a new tool call ends the current streaming text bubble
      const last = state.items[state.items.length - 1];
      if (last && (last.kind === 'assistant' || last.kind === 'thought')) last.streaming = false;
      // a permission request naming this call may have arrived first (adapters differ in the order)
      const pendingFor = state.pendingPermissions.find((p) => p.toolCallId === e.toolCallId);
      const existing = toolItem(state, e.toolCallId);
      if (existing) {
        existing.title = e.title;
        existing.toolKind = e.kind;
        existing.status = e.status;
        if (e.content) existing.content = e.content;
        if (e.locations) existing.locations = e.locations;
        if (e.rawInput !== undefined) existing.rawInput = e.rawInput;
        if (pendingFor) existing.awaitingPermission = true;
        attachApprovalDiffs(existing, pendingFor);
        break;
      }
      state.toolIndex[e.toolCallId] = state.items.length;
      const created: ToolItem = {
        kind: 'tool',
        id,
        turnId: e.turnId,
        toolCallId: e.toolCallId,
        title: e.title,
        toolKind: e.kind,
        status: e.status,
        content: e.content ?? [],
        locations: e.locations ?? [],
        rawInput: e.rawInput,
        ts,
      };
      if (pendingFor) {
        created.awaitingPermission = true;
        attachApprovalDiffs(created, pendingFor);
      }
      state.items.push(created);
      break;
    }
    case 'tool.update': {
      const idx = state.toolIndex[e.toolCallId];
      if (idx === undefined) {
        // update for a call we never saw (e.g. replay window) — synthesize
        state.toolIndex[e.toolCallId] = state.items.length;
        state.items.push({
          kind: 'tool',
          id,
          turnId: e.turnId,
          toolCallId: e.toolCallId,
          title: e.title ?? 'Tool call',
          toolKind: e.kind ?? 'other',
          status: e.status ?? 'in_progress',
          content: e.content ?? [],
          locations: e.locations ?? [],
          rawInput: e.rawInput,
          rawOutput: e.rawOutput,
          ts,
        });
        break;
      }
      const it = state.items[idx];
      if (it && it.kind === 'tool') {
        if (e.title !== undefined) it.title = e.title;
        if (e.kind !== undefined) it.toolKind = e.kind;
        if (e.status !== undefined) {
          it.status = e.status;
          if (e.status === 'completed' || e.status === 'failed') it.endedTs = ts;
        }
        if (e.content !== undefined) {
          it.content = e.content;
          attachApprovalDiffs(it);
        }
        if (e.locations !== undefined) it.locations = e.locations;
        if (e.rawInput !== undefined) it.rawInput = e.rawInput;
        if (e.rawOutput !== undefined) it.rawOutput = e.rawOutput;
      }
      break;
    }
    case 'plan': {
      // keep a single plan item per turn, replaced in place
      const idx = state.items.findIndex((it) => it.kind === 'plan' && it.turnId === e.turnId);
      if (idx >= 0) {
        const it = state.items[idx];
        if (it && it.kind === 'plan') it.entries = e.entries;
      } else {
        state.items.push({ kind: 'plan', id, turnId: e.turnId, entries: e.entries, ts });
      }
      break;
    }
    case 'permission.requested': {
      state.permissionIndex[e.request.permissionId] = state.items.length;
      state.items.push({ kind: 'permission', id, request: e.request, ts });
      state.pendingPermissions.push(e.request);
      state.status = 'needs_you';
      // the gated call is not running while the question is open; its diff (if only the request has one) shows on the card
      const gated = e.request.toolCallId !== undefined ? toolItem(state, e.request.toolCallId) : undefined;
      if (gated) {
        gated.awaitingPermission = true;
        attachApprovalDiffs(gated, e.request);
      }
      break;
    }
    case 'permission.resolved': {
      const idx = state.permissionIndex[e.permissionId];
      const item = idx !== undefined ? state.items[idx] : undefined;
      const answered = item && item.kind === 'permission' ? item : undefined;
      if (answered) answered.resolved = { outcome: e.outcome, optionId: e.optionId };
      state.pendingPermissions = state.pendingPermissions.filter((p) => p.permissionId !== e.permissionId);
      // the tool is looked up through the permission item, not `pendingPermissions`: an optimistic client answer
      // (state/sessions.ts) has already taken the request out of that list by the time this event arrives
      const toolCallId = answered?.request.toolCallId;
      const gated = toolCallId !== undefined ? toolItem(state, toolCallId) : undefined;
      if (gated && !state.pendingPermissions.some((p) => p.toolCallId === toolCallId)) {
        gated.awaitingPermission = false;
        // an approved call starts running now (a rejected one fails right away, so its run time is ~0 either way)
        if (gated.status === 'pending' || gated.status === 'in_progress') gated.startedTs = ts;
      }
      if (state.status === 'needs_you') state.status = statusAfterAnswer(state);
      break;
    }
    case 'elicitation.requested':
      state.elicitationIndex[e.request.elicitationId] = state.items.length;
      state.items.push({ kind: 'elicitation', id, request: e.request, ts });
      state.pendingElicitations.push(e.request);
      state.status = 'needs_you';
      break;
    case 'elicitation.resolved': {
      const idx = state.elicitationIndex[e.elicitationId];
      if (idx !== undefined) {
        const it = state.items[idx];
        if (it && it.kind === 'elicitation') it.resolved = e.content !== undefined ? { action: e.action, content: e.content } : { action: e.action };
      }
      state.pendingElicitations = state.pendingElicitations.filter((p) => p.elicitationId !== e.elicitationId);
      if (state.status === 'needs_you') state.status = statusAfterAnswer(state);
      break;
    }
    case 'mode.changed':
      state.modeId = e.modeId;
      break;
    case 'commands.updated':
      state.commands = e.commands;
      break;
  }
  return state;
}

export function applyEnvelopes(state: TimelineState, envs: Iterable<EventEnvelope>): TimelineState {
  for (const env of envs) applyEnvelope(state, env);
  return state;
}

/** Short human label for a tool call, used in collapsed cards and notifications. */
export function describeTool(title: string, kind: ToolKind, rawInput: unknown): string {
  if (kind === 'execute' && rawInput && typeof rawInput === 'object') {
    const r = rawInput as Record<string, unknown>;
    const cmd = r.command ?? r.cmd ?? r.script;
    if (typeof cmd === 'string') return cmd.length > 120 ? cmd.slice(0, 117) + '…' : cmd;
    if (Array.isArray(cmd)) return cmd.join(' ');
  }
  return title;
}
