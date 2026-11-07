/**
 * SessionManager: the single writer of the event log. Owns session rows, permissions,
 * turn intents, agent hosts, notifications and the fan-out of persisted events.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CreateElicitationResponse, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import {
  validateElicitationContent,
  type AgentInfo,
  type ContentBlock,
  type CreateSessionRequest,
  type ElicitationAction,
  type ElicitationContent,
  type ElicitationRequest,
  type EventEnvelope,
  type HealthResponse,
  type PermissionRequest,
  type SessionMode,
  type SessionStatus,
  type SessionSummary,
  type TimelineEvent,
} from '@mobile-ide/core';
import { z } from 'zod';
import { newId } from './auth.js';
import { AgentHost, type HostSessionInfo, type HostSink } from './agents/host.js';
import { elicitationRequest, permissionRequest } from './agents/normalize.js';
import type { Config } from './config.js';
import type { Db, SessionRow, TitleSource } from './db.js';
import { BadRequestError, ConflictError, NotFoundError } from './errors.js';
import type { EventBus } from './events.js';
import { createLogger, errorInfo } from './log.js';
import type { Notifier } from './notify.js';
import { resolveRoot, type PathPolicy } from './paths.js';

const log = createLogger({ mod: 'sessions' });

type CreateSessionInput = z.infer<typeof CreateSessionRequest>;

interface TurnStats {
  turnId: string;
  startedAt: number;
  toolCalls: number;
  assistantText: string;
}

interface PendingPermission {
  sessionId: string;
  resolve: (r: RequestPermissionResponse) => void;
}

interface PendingElicitation {
  sessionId: string;
  agentId: string;
  /** url mode: the agent's own id, which its `elicitation/complete` names */
  agentElicitationId?: string;
  resolve: (r: CreateElicitationResponse) => void;
}

const SESSIONS_DEBOUNCE_MS = 200;
const TURN_DONE_NOTIFY_MS = 20_000;

export class SessionManager implements HostSink {
  readonly hosts = new Map<string, AgentHost>();
  private readonly pending = new Map<string, PendingPermission>();
  /** elicitations this process is awaiting an answer to (durable rows live in `elicitations`) */
  private readonly pendingElicitations = new Map<string, PendingElicitation>();
  private readonly turnStats = new Map<string, TurnStats>();
  private readonly previews = new Map<string, string>();
  /** sessions whose assistant text was interrupted (tool call, thought, question): the next delta starts a new part */
  private readonly previewBreaks = new Set<string>();
  /** sessions still being created: events are held until session.created is written */
  private readonly creating = new Map<string, TimelineEvent[]>();
  private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly bus: EventBus,
    private readonly notifier: Notifier,
    private readonly policy: PathPolicy,
    private readonly homeDir: string,
  ) {
    for (const [id, cfg] of Object.entries(config.agents)) {
      if (!cfg.enabled) continue;
      this.hosts.set(id, new AgentHost(id, cfg, this, { homeDir, policy }));
    }
  }

  // ------------------------------------------------------------------ boot
  /**
   * Recover state left by a previous daemon instance. Synchronous; runs before listen().
   * Order matters for clients reducing the log: stale permissions are resolved BEFORE the interrupted
   * turn is ended, so no timeline ever shows a turn ending while one of its requests is still open.
   */
  boot(): void {
    for (const perm of this.db.pendingPermissions()) {
      this.db.resolvePermission(perm.id, 'cancelled', undefined, 'server');
      const row = this.db.getSession(perm.sessionId);
      if (!row || row.status === 'closed') continue;
      log.warn('boot.stale_permission', { sessionId: row.id, permissionId: perm.id });
      this.append(row.id, { type: 'permission.resolved', permissionId: perm.id, outcome: 'cancelled', by: 'server' });
    }
    for (const el of this.db.pendingElicitations()) {
      // same reasoning as permissions: no process holds the ACP request any more, so nobody could deliver an answer
      this.db.resolveElicitation(el.id, 'cancel', undefined, 'server');
      const row = this.db.getSession(el.sessionId);
      if (!row || row.status === 'closed') continue;
      log.warn('boot.stale_elicitation', { sessionId: row.id, elicitationId: el.id });
      this.append(row.id, { type: 'elicitation.resolved', elicitationId: el.id, action: 'cancel', by: 'server' });
    }
    for (const intent of this.db.runningTurnIntents()) {
      // The turn may have finished and only the intent update was lost (a crash in the window between the persisted
      // `turn.ended` and finishTurnIntent, or a DB closed under a late callback): never end a finished turn twice.
      if (this.db.turnEnded(intent.sessionId, intent.id)) {
        this.db.finishTurnIntent(intent.id, 'done');
        continue;
      }
      this.db.finishTurnIntent(intent.id, 'error');
      const row = this.db.getSession(intent.sessionId);
      if (!row || row.status === 'closed') continue;
      log.warn('boot.interrupted_turn', { sessionId: row.id, turnId: intent.id });
      this.append(row.id, { type: 'session.error', message: 'Turn interrupted by daemon restart', code: 'interrupted', fatal: false });
      this.append(row.id, { type: 'turn.ended', turnId: intent.id, stopReason: 'error' });
    }
    for (const row of this.db.listSessions()) {
      if (row.status === 'running' || row.status === 'needs_you' || row.status === 'starting') {
        this.db.updateSession(row.id, { status: 'idle' });
        this.append(row.id, { type: 'session.status', status: 'idle', detail: 'Daemon restarted' });
      }
    }
    this.db.pruneTurnIntents();
    const retentionDays = this.config.limits.closedSessionRetentionDays;
    if (retentionDays > 0) {
      const pruned = this.db.pruneClosedSessions(retentionDays * 24 * 3600 * 1000);
      if (pruned > 0) log.info('boot.pruned_closed_sessions', { pruned, retentionDays });
    }
    // Space is given back in maintain(), after listen(): a VACUUM here would rewrite every live session's log with
    // the port still unbound (`mide serve` looks hung; systemd's Restart=always turns a crash loop into a rewrite loop).
    this.db.checkpoint();
  }

  /**
   * Housekeeping that must not delay `listen()`: hand pages freed by pruning back to the filesystem — an in-place
   * release for databases this daemon created, a whole-file VACUUM only when an older file wastes real space
   * (`Db.reclaimSpace`). app.ts schedules it right after the port is bound; a no-op while shutting down.
   */
  maintain(): void {
    if (this.stopping) return;
    const t0 = Date.now();
    const r = this.db.reclaimSpace();
    if (r.method === 'none') return;
    this.db.checkpoint();
    log.info('maintenance.reclaimed', { method: r.method, freedBytes: r.freedBytes, ms: Date.now() - t0 });
  }

  /** Spawn + initialize every agent in parallel so the first session is fast. Never throws. */
  async prewarm(): Promise<void> {
    await Promise.allSettled(
      [...this.hosts.values()].map((h) =>
        h.ensureProcess().catch((err) => {
          log.warn('prewarm.failed', { agent: h.id, message: (err as Error).message });
        }),
      ),
    );
  }

  // ------------------------------------------------------------------ HostSink
  private append(sessionId: string, event: TimelineEvent): EventEnvelope {
    const env = this.db.appendEvent(sessionId, event);
    this.bus.emitEvent(env);
    return env;
  }

  emit(sessionId: string, event: TimelineEvent): void {
    const held = this.creating.get(sessionId);
    if (held) {
      held.push(event);
      return;
    }
    this.track(sessionId, event);
    this.append(sessionId, event);
    if (event.type === 'turn.ended' || event.type === 'session.renamed' || event.type === 'turn.started') this.scheduleSessionsChanged();
  }

  /** Side effects that hang off the event stream: previews, turn stats, notifications. */
  private track(sessionId: string, event: TimelineEvent): void {
    // Anything between two message parts (a tool call, a thought, a question, a status change) ends the current
    // part: the preview must not glue "…no output for it." to "Created `hello.txt`…".
    if (event.type !== 'message.delta' && event.type !== 'turn.started' && this.previews.get(sessionId)) this.previewBreaks.add(sessionId);
    switch (event.type) {
      case 'turn.started':
        this.turnStats.set(sessionId, { turnId: event.turnId, startedAt: Date.now(), toolCalls: 0, assistantText: '' });
        this.previews.set(sessionId, '');
        this.previewBreaks.delete(sessionId);
        break;
      case 'tool.call': {
        const s = this.turnStats.get(sessionId);
        if (s) s.toolCalls++;
        break;
      }
      case 'message.delta': {
        const s = this.turnStats.get(sessionId);
        if (s && s.assistantText.length < 2000) s.assistantText += event.text;
        let prev = this.previews.get(sessionId) ?? '';
        if (this.previewBreaks.delete(sessionId) && prev && !/\s$/.test(prev) && !/^\s/.test(event.text)) prev += ' ';
        prev += event.text;
        this.previews.set(sessionId, prev.length > 400 ? prev.slice(0, 400) : prev);
        break;
      }
      case 'turn.ended': {
        const s = this.turnStats.get(sessionId);
        this.turnStats.delete(sessionId);
        const preview = this.previewText(sessionId);
        // A turn without assistant text (rejected permission, cancelled at once) keeps the previous preview
        // instead of blanking the sessions list.
        if (preview !== undefined) this.db.updateSession(sessionId, { lastPreview: preview });
        if (!s || this.stopping) break;
        const long = Date.now() - s.startedAt > TURN_DONE_NOTIFY_MS;
        if (event.stopReason !== 'error' && (long || s.toolCalls > 0)) {
          const row = this.db.getSession(sessionId);
          const title = row?.title ?? 'Session';
          const body = preview || (event.stopReason === 'cancelled' ? 'Turn cancelled' : `Finished (${event.stopReason})`);
          void this.notifier.notify('all', { title: `${title} — done`, body, sessionId, kind: 'turn_done' });
        }
        break;
      }
      case 'session.error': {
        if (this.stopping) break;
        const row = this.db.getSession(sessionId);
        void this.notifier.notify('all', { title: `${row?.title ?? 'Session'} — error`, body: event.message, sessionId, kind: 'error' });
        break;
      }
      default:
        break;
    }
  }

  private previewText(sessionId: string): string | undefined {
    const raw = this.previews.get(sessionId);
    if (!raw) return undefined;
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    return collapsed ? (collapsed.length > 200 ? collapsed.slice(0, 197) + '...' : collapsed) : undefined;
  }

  setStatus(sessionId: string, status: SessionStatus, detail?: string): void {
    const row = this.db.getSession(sessionId);
    if (!row || row.status === 'closed') return;
    let next = status;
    if ((status === 'idle' || status === 'running') && this.needsYou(sessionId)) next = 'needs_you';
    if (row.status === next && !detail) return;
    this.db.updateSession(sessionId, { status: next });
    this.emit(sessionId, detail ? { type: 'session.status', status: next, detail } : { type: 'session.status', status: next });
    this.scheduleSessionsChanged();
  }

  patchSession(
    sessionId: string,
    patch: { acpSessionId?: string | null; modeId?: string; availableModes?: SessionMode[]; model?: string; title?: string },
  ): void {
    const p: Parameters<Db['updateSession']>[1] = {};
    if ('acpSessionId' in patch) p.acpSessionId = patch.acpSessionId ?? null;
    if (patch.modeId !== undefined) p.modeId = patch.modeId;
    if (patch.availableModes !== undefined) p.availableModes = patch.availableModes;
    if (patch.model !== undefined) p.model = patch.model;
    let renamed: string | null = null;
    if (patch.title !== undefined) {
      // An agent-suggested title replaces a default/derived one, never a title the user typed (create or rename).
      const title = patch.title.trim().slice(0, 200);
      const row = this.db.getSession(sessionId);
      if (title && row && row.status !== 'closed' && row.titleSource !== 'user' && row.title !== title) {
        p.title = title;
        p.titleSource = 'agent';
        renamed = title;
      }
    }
    if (Object.keys(p).length === 0) return;
    this.db.updateSession(sessionId, p);
    if (renamed !== null) {
      log.info('session.agent_title', { sessionId, title: renamed });
      this.emit(sessionId, { type: 'session.renamed', title: renamed }); // also schedules sessions.changed
      return;
    }
    this.scheduleSessionsChanged();
  }

  sessionInfo(sessionId: string): HostSessionInfo | null {
    const row = this.db.getSession(sessionId);
    if (!row || row.status === 'closed') return null;
    return { cwd: row.cwd, acpSessionId: row.acpSessionId, modeId: row.modeId, model: row.model, status: row.status };
  }

  hostChanged(agentId: string): void {
    this.bus.emitHostChanged(agentId);
  }

  requestPermission(sessionId: string, turnId: string, params: unknown, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const permissionId = newId();
    const req = permissionRequest(params, { permissionId, sessionId, turnId, createdAt: Date.now() });
    this.db.insertPermission(req);
    this.emit(sessionId, { type: 'permission.requested', request: req });
    this.setStatus(sessionId, 'needs_you');
    const row = this.db.getSession(sessionId);
    const detail = describeRawInput(req.rawInput) ?? req.title;
    void this.notifier.notify('all', {
      title: `${row?.title ?? 'Session'} needs you`,
      body: `${req.title}${detail && detail !== req.title ? `\n${detail}` : ''}`.slice(0, 1000),
      sessionId,
      permissionId,
      kind: 'permission',
    });
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pending.set(permissionId, { sessionId, resolve });
      signal.addEventListener(
        'abort',
        () => {
          // the agent withdrew the request (e.g. after session/cancel)
          if (!this.pending.has(permissionId)) return;
          this.finishPermission(permissionId, 'cancelled', undefined, 'server');
        },
        { once: true },
      );
    });
  }

  private finishPermission(permissionId: string, outcome: 'selected' | 'cancelled', optionId: string | undefined, by: string): boolean {
    const waiter = this.pending.get(permissionId);
    const changed = this.db.resolvePermission(permissionId, outcome, optionId, by);
    if (!changed && !waiter) return false;
    this.pending.delete(permissionId);
    const sessionId = waiter?.sessionId ?? this.db.getPermission(permissionId)?.sessionId;
    if (sessionId) {
      const ev: TimelineEvent = { type: 'permission.resolved', permissionId, outcome, by };
      if (optionId !== undefined) ev.optionId = optionId;
      this.emit(sessionId, ev);
    }
    waiter?.resolve(outcome === 'selected' && optionId !== undefined ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
    if (sessionId) {
      const host = this.hostForSession(sessionId);
      this.setStatus(sessionId, host?.isRunning(sessionId) ? 'running' : 'idle');
    }
    return true;
  }

  /** A permission request or an elicitation of this session is still waiting for the user. */
  private needsYou(sessionId: string): boolean {
    return this.db.pendingPermissions(sessionId).length > 0 || this.db.pendingElicitations(sessionId).length > 0;
  }

  // ------------------------------------------------------------------ elicitations (ACP elicitation/create)
  /**
   * The agent asks the user something (Claude Code's AskUserQuestion, an MCP server's form) or hands off to a URL.
   * Durable like a permission: the row is written before the phone hears about it, the JSON-RPC request stays open
   * until `respondElicitation` (hours later is fine), and the notifier buzzes every time (`permission` semantics).
   */
  requestElicitation(sessionId: string, turnId: string, params: unknown, signal: AbortSignal): Promise<CreateElicitationResponse> {
    const elicitationId = newId();
    const req = elicitationRequest(params, { elicitationId, sessionId, turnId, createdAt: Date.now() });
    if (!req) {
      // a mode this daemon did not advertise, or a url-mode request without a URL: nothing to show
      log.warn('elicitation.unsupported', { sessionId, params: safeJson(params) });
      return Promise.resolve({ action: 'decline' });
    }
    const row = this.db.getSession(sessionId);
    if (!row || row.status === 'closed') return Promise.resolve({ action: 'cancel' });
    this.db.insertElicitation(req);
    this.emit(sessionId, { type: 'elicitation.requested', request: req });
    this.setStatus(sessionId, 'needs_you');
    const body = req.mode === 'url' ? `${req.message}
${req.url ?? ''}` : req.message;
    void this.notifier.notify('all', {
      title: `${row.title} asks you`,
      body: body.slice(0, 1000),
      sessionId,
      // the Click URL's request id: the chat screen opens the matching elicitation sheet (see app/session/[id].tsx)
      permissionId: elicitationId,
      kind: 'permission',
    });
    const agentElicitationId = isRec(params) && typeof params.elicitationId === 'string' ? params.elicitationId : undefined;
    return new Promise<CreateElicitationResponse>((resolve) => {
      this.pendingElicitations.set(elicitationId, { sessionId, agentId: row.agent, resolve, ...(agentElicitationId ? { agentElicitationId } : {}) });
      signal.addEventListener(
        'abort',
        () => {
          // the agent withdrew the request (session/cancel, tool aborted)
          if (!this.pendingElicitations.has(elicitationId)) return;
          this.finishElicitation(elicitationId, 'cancel', undefined, 'server');
        },
        { once: true },
      );
    });
  }

  private finishElicitation(elicitationId: string, action: ElicitationAction, content: ElicitationContent | undefined, by: string): boolean {
    const waiter = this.pendingElicitations.get(elicitationId);
    const changed = this.db.resolveElicitation(elicitationId, action, content, by);
    if (!changed && !waiter) return false;
    this.pendingElicitations.delete(elicitationId);
    const sessionId = waiter?.sessionId ?? this.db.getElicitation(elicitationId)?.sessionId;
    if (sessionId) {
      const ev: TimelineEvent = { type: 'elicitation.resolved', elicitationId, action, by };
      if (content !== undefined) ev.content = content;
      this.emit(sessionId, ev);
    }
    waiter?.resolve(action === 'accept' ? (content !== undefined ? { action: 'accept', content } : { action: 'accept' }) : { action });
    if (sessionId) {
      const host = this.hostForSession(sessionId);
      this.setStatus(sessionId, host?.isRunning(sessionId) ? 'running' : 'idle');
    }
    return true;
  }

  /** The phone's answer. `accept` on a form is validated against the schema the agent sent; `decline`/`cancel` carry no content. */
  respondElicitation(sessionId: string, elicitationId: string, action: ElicitationAction, content: ElicitationContent | undefined, by: string): void {
    const row = this.db.getElicitation(elicitationId);
    if (!row || row.sessionId !== sessionId) throw new NotFoundError('elicitation not found');
    if (row.status !== 'pending') throw new ConflictError(`elicitation already answered (${row.status})`);
    let answers: ElicitationContent | undefined;
    if (action === 'accept' && row.request.mode === 'form') {
      answers = content ?? {};
      const problems = validateElicitationContent(row.request.schema ?? { properties: {}, required: [] }, answers);
      const names = Object.keys(problems);
      if (names.length) {
        throw new BadRequestError(`invalid answers: ${names.map((n) => `${n}: ${problems[n]}`).join('; ')}`);
      }
    }
    if (!this.finishElicitation(elicitationId, action, answers, by)) throw new ConflictError('elicitation already answered');
  }

  /**
   * ACP `elicitation/complete` (url mode): the agent finished the external flow on its own, so a request the phone
   * has not answered yet is closed as accepted (`by: 'agent'`). Unknown or already-answered ids are ignored, as the
   * spec asks. `agentElicitationId` is the agent's id, unique per connection — hence matched per agent.
   */
  completeElicitation(agentId: string, agentElicitationId: string): void {
    for (const [id, waiter] of this.pendingElicitations) {
      if (waiter.agentId !== agentId || waiter.agentElicitationId !== agentElicitationId) continue;
      log.info('elicitation.completed_by_agent', { sessionId: waiter.sessionId, elicitationId: id });
      this.finishElicitation(id, 'accept', undefined, 'agent');
      return;
    }
    log.debug('elicitation.complete_unknown', { agentId, agentElicitationId });
  }

  pendingElicitationRequests(): ElicitationRequest[] {
    return this.db.pendingElicitations().map((e) => e.request);
  }

  // ------------------------------------------------------------------ queries
  private hostForSession(sessionId: string): AgentHost | undefined {
    const row = this.db.getSession(sessionId);
    return row ? this.hosts.get(row.agent) : undefined;
  }

  private requireHost(agent: string): AgentHost {
    const host = this.hosts.get(agent);
    if (!host) throw new BadRequestError(`unknown agent '${agent}'`);
    return host;
  }

  private requireSession(sessionId: string): SessionRow {
    const row = this.db.getSession(sessionId);
    if (!row) throw new NotFoundError('session not found');
    return row;
  }

  summarize(row: SessionRow, pendingCounts?: Map<string, number>, elicitationCounts?: Map<string, number>): SessionSummary {
    const host = this.hosts.get(row.agent);
    const permissions = pendingCounts ? (pendingCounts.get(row.id) ?? 0) : this.db.pendingPermissions(row.id).length;
    const elicitations = elicitationCounts ? (elicitationCounts.get(row.id) ?? 0) : this.db.pendingElicitations(row.id).length;
    const s: SessionSummary = {
      id: row.id,
      agent: row.agent,
      agentName: host?.cfg.name ?? row.agent,
      cwd: row.cwd,
      projectName: path.basename(row.cwd) || row.cwd,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastSeq: row.lastSeq,
      // everything waiting for the user, so the inbox badge and the "Needs you" rows count questions too
      pendingPermissions: permissions + elicitations,
    };
    if (elicitations > 0) s.pendingElicitations = elicitations;
    const preview = this.previewText(row.id) ?? row.lastPreview ?? undefined;
    if (preview) s.lastMessagePreview = preview;
    if (row.modeId) s.modeId = row.modeId;
    if (row.availableModes) s.availableModes = row.availableModes;
    if (row.model) s.model = row.model;
    return s;
  }

  listSummaries(opts: { includeClosed?: boolean; status?: SessionStatus } = {}): SessionSummary[] {
    const counts = this.db.pendingPermissionCounts();
    const elicitations = this.db.pendingElicitationCounts();
    return this.db.listSessions(opts).map((r) => this.summarize(r, counts, elicitations));
  }

  summary(sessionId: string): SessionSummary {
    return this.summarize(this.requireSession(sessionId));
  }

  events(sessionId: string, afterSeq: number, limit: number): EventEnvelope[] {
    this.requireSession(sessionId);
    return this.db.eventsAfter(sessionId, afterSeq, limit);
  }

  pendingPermissionRequests(): PermissionRequest[] {
    return this.db.pendingPermissions().map((p) => p.request);
  }

  agentInfos(): AgentInfo[] {
    return [...this.hosts.values()].map((h) => h.info());
  }

  health(): Pick<HealthResponse, 'agents' | 'sessions'> {
    const rows = this.db.listSessions();
    return {
      agents: [...this.hosts.values()].map((h) => h.health()),
      sessions: {
        total: rows.length,
        running: rows.filter((r) => r.status === 'running').length,
        needsYou: rows.filter((r) => r.status === 'needs_you').length,
      },
    };
  }

  // ------------------------------------------------------------------ commands
  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    const host = this.requireHost(input.agent);
    const cwd = resolveRoot(this.policy, input.cwd);
    const st = await fs.promises.stat(cwd).catch(() => null);
    if (!st?.isDirectory()) throw new BadRequestError('cwd is not a directory');
    const firstText = input.initialPrompt?.find((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')?.text;
    const userTitle = input.title?.trim();
    const promptTitle = titleFromPrompt(firstText);
    const title = (userTitle || promptTitle || path.basename(cwd) || 'Session').slice(0, 200);
    const titleSource: TitleSource = userTitle ? 'user' : promptTitle ? 'prompt' : 'default';
    const id = newId();
    this.db.createSession({ id, agent: input.agent, cwd, title, titleSource, modeId: input.modeId, model: input.model });
    this.creating.set(id, []);
    log.info('session.create', { id, agent: input.agent, cwd });
    let meta: { modeId?: string; availableModes?: SessionMode[]; model?: string } = {};
    let failure: string | null = null;
    try {
      meta = await host.openSession(id, { modeId: input.modeId, model: input.model });
    } catch (err) {
      failure = (err as Error).message;
      log.warn('session.open_failed', { id, agent: input.agent, ...errorInfo(err) });
    }
    const created: TimelineEvent = { type: 'session.created', agent: input.agent, cwd, title };
    if (meta.modeId ?? input.modeId) created.modeId = meta.modeId ?? input.modeId;
    if (meta.availableModes) created.availableModes = meta.availableModes;
    if (meta.model ?? input.model) created.model = meta.model ?? input.model;
    const held = this.creating.get(id) ?? [];
    this.creating.delete(id);
    this.append(id, created);
    for (const ev of held) this.emit(id, ev);
    if (failure) {
      this.emit(id, { type: 'session.error', message: failure, code: 'open_failed', fatal: false });
      this.setStatus(id, 'error', failure.slice(0, 200));
    } else {
      this.setStatus(id, 'idle');
      if (input.initialPrompt?.length) {
        this.prompt(id, input.initialPrompt).catch((err) => log.warn('session.initial_prompt_failed', { id, ...errorInfo(err) }));
      }
    }
    this.scheduleSessionsChanged();
    return this.summary(id);
  }

  /** Accept a prompt; resolves once the turn has started. The turn itself runs in the background. */
  async prompt(sessionId: string, blocks: ContentBlock[]): Promise<{ turnId: string }> {
    const row = this.requireSession(sessionId);
    if (row.status === 'closed') throw new ConflictError('session is closed');
    const host = this.requireHost(row.agent);
    if (host.isRunning(sessionId)) throw new ConflictError('a turn is already running');
    const turnId = newId();
    const promptText = blocks.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
    this.db.insertTurnIntent(sessionId, promptText, turnId);
    let turn: { done: Promise<{ stopReason: string }> };
    try {
      turn = await host.beginTurn(sessionId, blocks, turnId);
    } catch (err) {
      this.db.finishTurnIntent(turnId, 'error');
      throw err;
    }
    // A session started without a title or first prompt was named after its folder; the first prompt names it now
    // (what the new-session sheet promises). Agent titles and typed titles are left alone — judged on the row as it is
    // NOW: beginTurn() may have taken seconds (adapter spawn), and a rename or an agent title that landed meanwhile
    // must not be overwritten from the snapshot read before the await.
    const fresh = this.db.getSession(sessionId);
    if (fresh?.titleSource === 'default') {
      const derived = titleFromPrompt(blocks.find((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')?.text);
      if (derived && derived !== fresh.title) {
        this.db.updateSession(sessionId, { title: derived, titleSource: 'prompt' });
        this.emit(sessionId, { type: 'session.renamed', title: derived });
      }
    }
    turn.done
      .then((res) => {
        this.db.finishTurnIntent(turnId, res.stopReason === 'error' ? 'error' : 'done');
        this.scheduleSessionsChanged();
      })
      .catch((err: unknown) => {
        // e.g. the DB was closed by a shutdown that ran out of drain time; boot() reconciles the intent next start
        log.warn('turn.intent_finish_failed', { sessionId, turnId, ...errorInfo(err) });
      });
    return { turnId };
  }

  async cancel(sessionId: string, by: string): Promise<void> {
    const row = this.requireSession(sessionId);
    const host = this.requireHost(row.agent);
    // ACP: a cancelled turn must see its outstanding permission requests answered `cancelled` (and its questions dismissed)
    for (const p of this.db.pendingPermissions(sessionId)) this.finishPermission(p.id, 'cancelled', undefined, by);
    for (const e of this.db.pendingElicitations(sessionId)) this.finishElicitation(e.id, 'cancel', undefined, by);
    const ok = await host.cancel(sessionId);
    if (!ok) throw new ConflictError('no running turn to cancel');
  }

  respondPermission(sessionId: string, permissionId: string, outcome: 'selected' | 'cancelled', optionId: string | undefined, by: string): void {
    const row = this.db.getPermission(permissionId);
    if (!row || row.sessionId !== sessionId) throw new NotFoundError('permission not found');
    if (row.status !== 'pending') throw new ConflictError(`permission already ${row.status}`);
    if (outcome === 'selected') {
      if (!optionId || !row.request.options.some((o) => o.optionId === optionId)) throw new BadRequestError('optionId must be one of the offered options');
    }
    if (!this.finishPermission(permissionId, outcome, outcome === 'selected' ? optionId : undefined, by)) throw new ConflictError('permission already resolved');
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const row = this.requireSession(sessionId);
    if (row.status === 'closed') throw new ConflictError('session is closed');
    await this.requireHost(row.agent).setMode(sessionId, modeId);
    this.scheduleSessionsChanged();
  }

  rename(sessionId: string, title: string): SessionSummary {
    const row = this.requireSession(sessionId);
    if (row.status === 'closed') throw new ConflictError('session is closed');
    this.db.updateSession(sessionId, { title, titleSource: 'user' });
    this.emit(sessionId, { type: 'session.renamed', title });
    return this.summary(sessionId);
  }

  async closeSession(sessionId: string, opts: { purge?: boolean } = {}): Promise<void> {
    const row = this.requireSession(sessionId);
    const host = this.hosts.get(row.agent);
    for (const p of this.db.pendingPermissions(sessionId)) this.finishPermission(p.id, 'cancelled', undefined, 'server');
    for (const e of this.db.pendingElicitations(sessionId)) this.finishElicitation(e.id, 'cancel', undefined, 'server');
    if (host) await host.closeSession(sessionId).catch((err) => log.warn('session.close_failed', { sessionId, ...errorInfo(err) }));
    if (opts.purge) {
      this.db.deleteSessionData(sessionId);
    } else if (row.status !== 'closed') {
      this.db.updateSession(sessionId, { status: 'closed', closedAt: Date.now() });
      this.append(sessionId, { type: 'session.status', status: 'closed' });
    }
    this.previews.delete(sessionId);
    this.previewBreaks.delete(sessionId);
    this.turnStats.delete(sessionId);
    this.scheduleSessionsChanged();
  }

  // ------------------------------------------------------------------ fan-out
  private scheduleSessionsChanged(): void {
    if (this.sessionsTimer || this.stopping) return;
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = null;
      this.bus.emitSessionsChanged();
    }, SESSIONS_DEBOUNCE_MS);
    this.sessionsTimer.unref?.();
  }

  // ------------------------------------------------------------------ shutdown
  async shutdown(opts: { drainMs: number; cancelTurns: boolean }): Promise<void> {
    this.stopping = true;
    // Every client is already disconnected, so nobody can answer a permission request this process is still waiting
    // on; a turn parked on one would otherwise hold the drain for its full length. Cancel them like cancel() does: the
    // agent aborts the tool call and ends the turn inside the drain. Only in-flight requests (with a waiter here) —
    // rows left by an earlier hard crash have no waiter and are boot()'s to reconcile.
    for (const permissionId of [...this.pending.keys()]) {
      try {
        this.finishPermission(permissionId, 'cancelled', undefined, 'server');
      } catch (err) {
        log.warn('shutdown.permission_cancel_failed', { permissionId, ...errorInfo(err) });
      }
    }
    for (const elicitationId of [...this.pendingElicitations.keys()]) {
      try {
        this.finishElicitation(elicitationId, 'cancel', undefined, 'server');
      } catch (err) {
        log.warn('shutdown.elicitation_cancel_failed', { elicitationId, ...errorInfo(err) });
      }
    }
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    this.sessionsTimer = null;
    await Promise.allSettled([...this.hosts.values()].map((h) => h.shutdown(opts)));
  }
}

/** First line of a prompt, trimmed to a title-sized length; undefined when there is no text. */
function titleFromPrompt(text: string | undefined): string | undefined {
  const line = text?.trim().split('\n')[0]?.trim();
  return line ? line.slice(0, 80) : undefined;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Log-safe rendering of an agent payload (bounded, never throws). */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)?.slice(0, 500) ?? String(v);
  } catch {
    return String(v);
  }
}

function describeRawInput(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw.slice(0, 500);
  if (typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const cmd = r.command ?? r.cmd ?? r.script;
    if (typeof cmd === 'string') return cmd.slice(0, 500);
    if (Array.isArray(cmd)) return cmd.map(String).join(' ').slice(0, 500);
    const p = r.file_path ?? r.path ?? r.filePath;
    if (typeof p === 'string') return p;
    try {
      return JSON.stringify(raw).slice(0, 500);
    } catch {
      return undefined;
    }
  }
  return String(raw);
}
