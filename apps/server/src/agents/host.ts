/**
 * AgentHost: one per configured agent id. Lazily spawns the ACP adapter process,
 * multiplexes N sessions over it, normalizes updates into timeline events, and
 * recovers (session/load or session/new) when the process dies or the daemon restarts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { RequestError, type ContentBlock as AcpContentBlock, type CreateElicitationResponse, type RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { AgentInfo, ContentBlock, SessionMode, SessionStatus, TimelineEvent } from '@mobile-ide/core';
import { newId } from '../auth.js';
import type { AgentConfig } from '../config.js';
import { agentEnv } from '../config.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { createLogger, errorInfo, type Logger } from '../log.js';
import { isInside, realpathLenient, type PathPolicy } from '../paths.js';
import { AcpProcess, describeAcpError, type AcpClientHandlers } from './acp.js';
import { AgentTerminals } from './agent-terminals.js';
import {
  agentTitle,
  attachTerminalCapture,
  findModelValue,
  foldTerminalStream,
  modelFromConfigOptions,
  normalizeUpdate,
  permissionRequest,
  stopReason,
  terminalStream,
  turnUsage,
  usageSemantics,
  usageUpdateCost,
  ZERO_USAGE,
  type TerminalCapture,
  type UsageTotals,
} from './normalize.js';

export type HostState = 'stopped' | 'starting' | 'ready' | 'error';

export interface HostSessionInfo {
  cwd: string;
  acpSessionId: string | null;
  modeId: string | null;
  model: string | null;
  status: SessionStatus;
}

/** What the host needs from the session manager (persistence + fan-out live there). */
export interface HostSink {
  emit(sessionId: string, event: TimelineEvent): void;
  setStatus(sessionId: string, status: SessionStatus, detail?: string): void;
  /**
   * `title` is a title the agent suggested (claude-agent-acp generates one after the first turn, codex-acp
   * mirrors Codex thread names). The manager owns the policy — persist it and emit `session.renamed`, unless
   * the user typed a title — so the sessions list and the timeline never disagree; the host never emits
   * `session.renamed` itself.
   */
  patchSession(
    sessionId: string,
    patch: { acpSessionId?: string | null; modeId?: string; availableModes?: SessionMode[]; model?: string; title?: string },
  ): void;
  requestPermission(sessionId: string, turnId: string, params: unknown, signal: AbortSignal): Promise<RequestPermissionResponse>;
  /** ACP `elicitation/create`: persist, show on the phone, resolve with its answer (or `cancel` when `signal` aborts). */
  requestElicitation(sessionId: string, turnId: string, params: unknown, signal: AbortSignal): Promise<CreateElicitationResponse>;
  /** ACP `elicitation/complete`: the agent finished a url-mode flow itself; `elicitationId` is the agent's own id. */
  completeElicitation(agentId: string, elicitationId: string): void;
  sessionInfo(sessionId: string): HostSessionInfo | null;
  hostChanged(agentId: string): void;
}

interface Runtime {
  id: string;
  cwd: string;
  acpSessionId: string | null;
  /** process generation the acp session belongs to */
  gen: number;
  turnId: string;
  running: boolean;
  loading: boolean;
  promptAbort: AbortController | null;
  turnDone: Promise<void> | null;
  /** first text block of the running (or last) prompt: agent titles that merely echo it are ignored */
  lastPromptText: string;
  /** `PromptResponse.usage` totals after the previous turn (cumulative agents); null = unknown after session/load */
  usageBaseline: UsageTotals | null;
  /** latest cumulative session cost from `usage_update.cost` (claude-agent-acp) and its value at the previous turn end */
  costUsd: number | null;
  costBaseline: number | null;
  /** output/exit of shell commands the agent runs itself, streamed through `_meta.terminal_*`, by terminal id */
  terminalCaptures: Map<string, TerminalCapture>;
}

export interface TurnResult {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error';
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export class AgentHost {
  readonly log: Logger;
  state: HostState = 'stopped';
  detail: string | undefined;
  private proc: AcpProcess | null = null;
  private gen = 0;
  private starting: Promise<AcpProcess> | null = null;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly byAcp = new Map<string, Runtime>();
  /** per-session recovery in flight (ensureSession): concurrent callers share one session/load or session/new */
  private readonly recovering = new Map<string, Promise<Runtime>>();
  private readonly knownModels = new Set<string>();
  private defaultModel: string | undefined;
  private readonly terminals = new AgentTerminals();
  private stopping = false;

  constructor(
    readonly id: string,
    readonly cfg: AgentConfig,
    private readonly sink: HostSink,
    private readonly opts: { homeDir: string; policy: PathPolicy },
  ) {
    this.log = createLogger({ mod: 'host', agent: id });
  }

  // ------------------------------------------------------------------ process lifecycle
  /** Spawn + initialize (deduplicated). Throws when the adapter cannot start. */
  ensureProcess(initTimeoutMs = 60_000): Promise<AcpProcess> {
    if (this.proc && this.proc.alive && this.proc.initResult) return Promise.resolve(this.proc);
    if (this.starting) return this.starting;
    if (this.stopping) return Promise.reject(new Error('daemon is shutting down'));
    this.setState('starting');
    const gen = ++this.gen;
    const p = (async () => {
      const proc = new AcpProcess(this.id, this.cfg, this.handlers(gen), { cwd: this.opts.homeDir });
      this.proc = proc;
      void proc.exited.then((exit) => this.onProcessExit(gen, exit.code, exit.signal, exit.stderrTail));
      try {
        const init = await proc.initialize(initTimeoutMs);
        if (!proc.alive) throw new Error(`agent exited during initialize: ${proc.stderrTail()}`);
        this.log.info('initialized', { agentInfo: init.agentInfo, loadSession: init.agentCapabilities?.loadSession });
        this.setState('ready');
        return proc;
      } catch (err) {
        const msg = describeAcpError(err);
        const tail = proc.stderrTail();
        this.setState('error', tail ? `${msg} — ${tail.split('\n').slice(-3).join(' | ')}`.slice(0, 600) : msg);
        void proc.stop(2000);
        if (this.proc === proc) this.proc = null;
        throw new Error(`${this.cfg.name} failed to start: ${msg}`);
      }
    })();
    this.starting = p;
    p.finally(() => {
      if (this.starting === p) this.starting = null;
    }).catch(() => {});
    return p;
  }

  private setState(state: HostState, detail?: string): void {
    const changed = this.state !== state || this.detail !== detail;
    this.state = state;
    this.detail = detail;
    if (changed) {
      this.log.info('state', { state, detail });
      this.sink.hostChanged(this.id);
    }
  }

  private onProcessExit(gen: number, code: number | null, signal: string | null, stderrTail: string): void {
    // Commands the dead process had running belong to the sessions still bound to its generation (a rebind moves
    // rt.gen forward), so they are reaped even when a newer generation has already replaced this one.
    for (const rt of this.runtimes.values()) if (rt.gen === gen) void this.terminals.killAllForSession(rt.id);
    if (gen !== this.gen) return; // an older generation; already replaced
    this.proc = null;
    const msg = `${this.cfg.name} process exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`;
    if (!this.stopping) this.setState('error', stderrTail ? `${msg}: ${stderrTail.split('\n').slice(-2).join(' | ')}`.slice(0, 600) : msg);
    else this.setState('stopped');
    for (const rt of this.runtimes.values()) {
      if (rt.gen !== gen) continue;
      if (this.stopping) continue;
      if (!rt.running) {
        // running turns report through the prompt() catch path
        this.sink.emit(rt.id, { type: 'session.error', message: msg, code: 'agent_exited', fatal: false });
        this.sink.setStatus(rt.id, 'error', msg);
      }
    }
  }

  // ------------------------------------------------------------------ client-side ACP handlers
  private handlers(gen: number): AcpClientHandlers {
    const rtFor = (acpSessionId: unknown): Runtime | undefined => {
      if (typeof acpSessionId !== 'string') return undefined;
      const rt = this.byAcp.get(acpSessionId);
      return rt && rt.gen === gen ? rt : undefined;
    };
    /**
     * fs/read_text_file and fs/write_text_file serve the session's project only: the path (relative ones
     * against the session cwd) must resolve — symlinks followed — inside the cwd and outside the denylist.
     * Without this an agent could read ~/.aws/credentials or write ~/.bashrc from any project.
     */
    const sessionPath = (acpSessionId: unknown, p: string): string => {
      const rt = rtFor(acpSessionId);
      if (!rt) throw RequestError.invalidParams(undefined, 'unknown session');
      const cwd = realpathLenient(rt.cwd);
      const real = realpathLenient(path.isAbsolute(p) ? p : path.join(cwd, p));
      if (!isInside(cwd, real)) throw RequestError.invalidParams(undefined, 'path is outside the session cwd');
      if (this.opts.policy.denylist.some((d) => isInside(d, real))) throw RequestError.invalidParams(undefined, 'path is denylisted');
      return real;
    };
    return {
      onSessionUpdate: (params) => {
        if (!isRec(params)) return;
        const rt = rtFor(params.sessionId);
        if (!rt) {
          this.log.debug('update.unknown_session', { acpSessionId: params.sessionId });
          return;
        }
        this.handleUpdate(rt, params.update);
      },
      onRequestPermission: async (params, signal) => {
        const rt = isRec(params) ? rtFor(params.sessionId) : undefined;
        if (!rt) return { outcome: { outcome: 'cancelled' } };
        return this.sink.requestPermission(rt.id, rt.turnId, params, signal);
      },
      onCreateElicitation: async (params, signal) => {
        // Only session-scoped elicitations have a phone to go to; a request-scoped one (`requestId`, auth flows
        // before any session) or an unknown session has no UI, so it is dismissed rather than left hanging.
        const rt = isRec(params) ? rtFor(params.sessionId) : undefined;
        if (!rt) {
          this.log.warn('elicitation.unroutable', { sessionId: isRec(params) ? params.sessionId : undefined, mode: isRec(params) ? params.mode : undefined });
          return { action: 'cancel' };
        }
        return this.sink.requestElicitation(rt.id, rt.turnId, params, signal);
      },
      onCompleteElicitation: (params) => {
        const elicitationId = isRec(params) && typeof params.elicitationId === 'string' ? params.elicitationId : undefined;
        if (elicitationId) this.sink.completeElicitation(this.id, elicitationId);
      },
      onReadTextFile: async (params) => {
        const real = sessionPath(params.sessionId, params.path);
        let content = await fs.promises.readFile(real, 'utf8');
        if (params.line != null || params.limit != null) {
          const lines = content.split('\n');
          const start = Math.max(0, (params.line ?? 1) - 1);
          const end = params.limit != null ? start + params.limit : lines.length;
          content = lines.slice(start, end).join('\n');
        }
        return { content };
      },
      onWriteTextFile: async (params) => {
        const real = sessionPath(params.sessionId, params.path);
        await fs.promises.mkdir(path.dirname(real), { recursive: true });
        await fs.promises.writeFile(real, params.content, 'utf8');
      },
      onCreateTerminal: async (params) => {
        const rt = rtFor(params.sessionId);
        const cwd = params.cwd || rt?.cwd || this.opts.homeDir;
        const term = this.terminals.create(
          { sessionId: rt?.id ?? params.sessionId, command: params.command, args: params.args, env: params.env, cwd, outputByteLimit: params.outputByteLimit },
          cwd,
          agentEnv(this.cfg),
        );
        return { terminalId: term.id };
      },
      onTerminalOutput: async (params) => {
        const out = this.terminals.output(params.terminalId);
        if (!out) throw RequestError.invalidParams(undefined, `unknown terminal ${params.terminalId}`);
        return { output: out.output, truncated: out.truncated, exitStatus: out.exitStatus };
      },
      onWaitForTerminalExit: async (params) => {
        const exit = await this.terminals.waitForExit(params.terminalId);
        if (!exit) throw RequestError.invalidParams(undefined, `unknown terminal ${params.terminalId}`);
        return exit;
      },
      onKillTerminal: async (params) => {
        // reply now; the agent observes the exit through terminal/wait_for_exit or terminal/output
        void this.terminals.kill(params.terminalId);
      },
      onReleaseTerminal: async (params) => {
        this.terminals.release(params.terminalId);
      },
    };
  }

  private handleUpdate(rt: Runtime, update: unknown): void {
    if (!isRec(update)) return;
    const kind = update.sessionUpdate;
    // Session-level bookkeeping first: these also matter during a session/load replay.
    if (kind === 'config_option_update') {
      const m = modelFromConfigOptions(update.configOptions);
      for (const name of m.all) this.knownModels.add(name);
      if (m.current) {
        this.sink.patchSession(rt.id, { model: m.current });
        this.defaultModel ??= m.current;
      }
      return;
    }
    if (kind === 'usage_update') {
      const cost = usageUpdateCost(update);
      if (cost !== undefined) rt.costUsd = cost;
      return;
    }
    if (kind === 'session_info_update') {
      const title = agentTitle(update.title, rt.lastPromptText);
      if (title) this.sink.patchSession(rt.id, { title });
      return;
    }
    if (rt.loading && kind !== 'current_mode_update' && kind !== 'available_commands_update') {
      // history replay from session/load: our own log already has it
      return;
    }
    const event = normalizeUpdate(update, { turnId: rt.turnId });
    if (!event) return;
    if (event.type === 'tool.call' || event.type === 'tool.update') {
      // Shell commands the agent runs itself (claude-agent-acp Bash, codex-acp exec): output and exit code
      // travel in `_meta`, never through terminal/create — materialize them into the terminal block.
      const stream = terminalStream(update);
      if (stream) attachTerminalCapture(event, stream.terminalId, foldTerminalStream(rt.terminalCaptures, stream));
      this.attachTerminalOutput(event);
    }
    if (event.type === 'mode.changed') this.sink.patchSession(rt.id, { modeId: event.modeId });
    this.sink.emit(rt.id, event);
  }

  /** Terminals the agent asked the daemon to run (ACP `terminal/*`): copy their captured output. */
  private attachTerminalOutput(event: Extract<TimelineEvent, { type: 'tool.call' | 'tool.update' }>): void {
    if (!event.content) return;
    for (const c of event.content) {
      if (c.type !== 'terminal') continue;
      const out = this.terminals.output(c.terminalId);
      if (!out) continue;
      c.output = out.output;
      c.exitCode = out.exitStatus?.exitCode ?? null;
    }
  }

  /** A brand-new agent session: nothing has been spent in it yet. */
  private resetAccounting(rt: Runtime): void {
    rt.usageBaseline = { ...ZERO_USAGE };
    rt.costUsd = null;
    rt.costBaseline = 0;
    rt.terminalCaptures.clear();
  }

  /**
   * Usage for `turn.ended`: this turn's share of the agent's counters (see `turnUsage` for the cumulative vs
   * per-turn semantics) plus the cost delta when the agent reports one. Never throws; may be undefined.
   */
  private turnAccounting(rt: Runtime, proc: AcpProcess, raw: unknown): { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined {
    const tokens = turnUsage(raw, usageSemantics(proc.initResult?.agentInfo), rt.usageBaseline);
    rt.usageBaseline = tokens.baseline;
    let costUsd: number | undefined;
    if (rt.costUsd !== null) {
      if (rt.costBaseline !== null && rt.costUsd > rt.costBaseline) costUsd = rt.costUsd - rt.costBaseline;
      rt.costBaseline = rt.costUsd;
    }
    if (!tokens.usage && costUsd === undefined) return undefined;
    return { ...(tokens.usage ?? {}), ...(costUsd !== undefined ? { costUsd } : {}) };
  }

  // ------------------------------------------------------------------ sessions
  private runtime(sessionId: string): Runtime {
    let rt = this.runtimes.get(sessionId);
    if (!rt) {
      const info = this.sink.sessionInfo(sessionId);
      if (!info) throw new NotFoundError(`unknown session ${sessionId}`);
      rt = {
        id: sessionId,
        cwd: info.cwd,
        acpSessionId: null,
        gen: -1,
        turnId: 'init',
        running: false,
        loading: false,
        promptAbort: null,
        turnDone: null,
        lastPromptText: '',
        usageBaseline: null,
        costUsd: null,
        costBaseline: null,
        terminalCaptures: new Map(),
      };
      this.runtimes.set(sessionId, rt);
    }
    return rt;
  }

  /** Create a brand-new agent session for an existing session row. */
  async openSession(sessionId: string, opts: { modeId?: string; model?: string } = {}): Promise<{ modeId?: string; availableModes?: SessionMode[]; model?: string }> {
    const proc = await this.ensureProcess();
    const rt = this.runtime(sessionId);
    const res = await proc.newSession(rt.cwd);
    this.bind(rt, res.sessionId);
    this.resetAccounting(rt);
    const meta = this.applySessionMeta(rt, res.modes, res.configOptions);
    if (opts.modeId && opts.modeId !== meta.modeId && meta.availableModes?.some((m) => m.id === opts.modeId)) {
      try {
        await proc.setMode(res.sessionId, opts.modeId);
        meta.modeId = opts.modeId;
        this.sink.patchSession(rt.id, { modeId: opts.modeId });
      } catch (err) {
        this.log.warn('set_mode.failed', { sessionId, ...errorInfo(err) });
      }
    }
    if (opts.model) {
      const found = findModelValue(res.configOptions, opts.model);
      if (found) {
        try {
          const out = await proc.setConfigOption(res.sessionId, found.configId, found.value);
          const m = modelFromConfigOptions(out.configOptions);
          if (m.current) meta.model = m.current;
          for (const name of m.all) this.knownModels.add(name);
        } catch (err) {
          this.log.warn('set_model.failed', { sessionId, model: opts.model, ...errorInfo(err) });
        }
      } else {
        meta.model = opts.model; // agent did not advertise a picker; remember what the user asked for
      }
      this.sink.patchSession(rt.id, { model: meta.model });
    }
    return meta;
  }

  private bind(rt: Runtime, acpSessionId: string): void {
    if (rt.acpSessionId) this.byAcp.delete(rt.acpSessionId);
    rt.acpSessionId = acpSessionId;
    rt.gen = this.gen;
    this.byAcp.set(acpSessionId, rt);
    this.sink.patchSession(rt.id, { acpSessionId });
  }

  private applySessionMeta(rt: Runtime, modes: unknown, configOptions: unknown): { modeId?: string; availableModes?: SessionMode[]; model?: string } {
    const meta: { modeId?: string; availableModes?: SessionMode[]; model?: string } = {};
    if (isRec(modes) && typeof modes.currentModeId === 'string' && Array.isArray(modes.availableModes)) {
      meta.modeId = modes.currentModeId;
      meta.availableModes = [];
      for (const m of modes.availableModes) {
        if (!isRec(m) || typeof m.id !== 'string') continue;
        const mode: SessionMode = { id: m.id, name: typeof m.name === 'string' ? m.name : m.id };
        if (typeof m.description === 'string') mode.description = m.description;
        meta.availableModes.push(mode);
      }
    }
    const model = modelFromConfigOptions(configOptions);
    for (const name of model.all) this.knownModels.add(name);
    if (model.current) {
      meta.model = model.current;
      this.defaultModel ??= model.current;
    }
    this.sink.patchSession(rt.id, meta);
    return meta;
  }

  /**
   * Make sure the session has a live agent-side counterpart, restoring it after a
   * process death or daemon restart (session/load when supported, else session/new).
   */
  ensureSession(sessionId: string): Promise<Runtime> {
    const rt = this.runtime(sessionId);
    if (rt.acpSessionId && rt.gen === this.gen && this.proc?.alive && this.proc.initResult) return Promise.resolve(rt);
    // Two callers recovering the same session at once (a prompt and a set_mode after a reconnect) must not each run
    // session/load: the second load fails and falls through to session/new, whose bind() unroutes the first's turn.
    const inflight = this.recovering.get(sessionId);
    if (inflight) return inflight;
    const p = this.recoverSession(sessionId, rt).finally(() => {
      if (this.recovering.get(sessionId) === p) this.recovering.delete(sessionId);
    });
    this.recovering.set(sessionId, p);
    return p;
  }

  private async recoverSession(sessionId: string, rt: Runtime): Promise<Runtime> {
    const proc = await this.ensureProcess();
    if (rt.acpSessionId && rt.gen === this.gen) return rt; // raced with another caller
    const info = this.sink.sessionInfo(sessionId);
    if (!info) throw new NotFoundError(`unknown session ${sessionId}`);
    rt.cwd = info.cwd;
    const previous = rt.acpSessionId ?? info.acpSessionId;
    if (previous && proc.capabilities?.loadSession) {
      rt.loading = true;
      try {
        // bind first so replayed updates are attributed (and dropped) correctly
        this.bind(rt, previous);
        rt.costUsd = null;
        const res = await proc.loadSession(previous, rt.cwd);
        rt.loading = false;
        // The agent's cumulative counters include history this daemon never observed: the first turn after a
        // load gets no token figure; the replay's cost (when the agent reports one) is the cost baseline.
        rt.usageBaseline = null;
        rt.costBaseline = rt.costUsd;
        this.applySessionMeta(rt, res?.modes, res?.configOptions);
        this.sink.setStatus(rt.id, 'idle', 'Reconnected to the agent session');
        return rt;
      } catch (err) {
        rt.loading = false;
        this.log.warn('load_session.failed', { sessionId, ...errorInfo(err) });
      }
    }
    const res = await proc.newSession(rt.cwd);
    this.bind(rt, res.sessionId);
    this.resetAccounting(rt);
    const meta = this.applySessionMeta(rt, res.modes, res.configOptions);
    if (info.modeId && meta.availableModes?.some((m) => m.id === info.modeId) && meta.modeId !== info.modeId) {
      try {
        await proc.setMode(res.sessionId, info.modeId);
        this.sink.patchSession(rt.id, { modeId: info.modeId });
      } catch (err) {
        this.log.warn('set_mode.failed', { sessionId, ...errorInfo(err) });
      }
    }
    this.sink.setStatus(rt.id, 'idle', 'Agent restarted: fresh context, earlier turns are not visible to the agent');
    return rt;
  }

  isRunning(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.running ?? false;
  }

  currentTurnId(sessionId: string): string | undefined {
    const rt = this.runtimes.get(sessionId);
    return rt?.running ? rt.turnId : undefined;
  }

  /**
   * Begin one prompt turn. Resolves once the turn is accepted (turn.started emitted);
   * `done` settles when the agent finishes (turn.ended emitted). Never rejects after acceptance.
   */
  async beginTurn(sessionId: string, blocks: ContentBlock[], turnId: string): Promise<{ turnId: string; done: Promise<TurnResult> }> {
    const rt = await this.ensureSession(sessionId);
    if (rt.running) throw new ConflictError('a turn is already running in this session');
    const proc = this.proc;
    if (!proc || !rt.acpSessionId) throw new Error('agent is not connected');
    const acpSessionId = rt.acpSessionId;
    rt.turnId = turnId;
    rt.running = true;
    rt.lastPromptText = blocks.find((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')?.text ?? '';
    rt.promptAbort = new AbortController();
    let finish: () => void = () => {};
    rt.turnDone = new Promise<void>((res) => {
      finish = res;
    });
    try {
      this.sink.emit(sessionId, { type: 'turn.started', turnId, blocks });
      this.sink.setStatus(sessionId, 'running');
    } catch (err) {
      // Persisting turn.started failed (SQLITE_FULL/BUSY, DB closed by a racing shutdown): the turn never started, so
      // the runtime must not stay marked running — that would wedge the session and hand shutdown() a promise that
      // never settles. The caller (SessionManager.prompt) closes the turn intent.
      rt.running = false;
      rt.promptAbort = null;
      rt.turnDone = null;
      finish();
      throw err;
    }
    const signal = rt.promptAbort.signal;
    const done = (async (): Promise<TurnResult> => {
      try {
        const res = await proc.prompt(acpSessionId, this.toAcpBlocks(blocks, proc), signal);
        const reason = stopReason(res.stopReason);
        const usage = this.turnAccounting(rt, proc, res.usage);
        this.sink.emit(sessionId, usage ? { type: 'turn.ended', turnId, stopReason: reason, usage } : { type: 'turn.ended', turnId, stopReason: reason });
        return { stopReason: reason };
      } catch (err) {
        const message = describeAcpError(err);
        this.log.warn('prompt.failed', { sessionId, message });
        try {
          this.sink.emit(sessionId, { type: 'session.error', message, code: 'prompt_failed', fatal: false });
          this.sink.emit(sessionId, { type: 'turn.ended', turnId, stopReason: 'error' });
        } catch (emitErr) {
          this.log.error('prompt.emit_failed', errorInfo(emitErr));
        }
        return { stopReason: 'error' };
      } finally {
        rt.running = false;
        rt.promptAbort = null;
        rt.turnDone = null;
        finish();
        if (!this.stopping) {
          try {
            this.sink.setStatus(sessionId, this.proc?.alive ? 'idle' : 'error');
          } catch (err) {
            this.log.error('prompt.status_failed', errorInfo(err));
          }
        }
      }
    })();
    return { turnId, done };
  }

  private toAcpBlocks(blocks: ContentBlock[], proc: AcpProcess): AcpContentBlock[] {
    const imagesOk = proc.capabilities?.promptCapabilities?.image === true;
    const out: AcpContentBlock[] = [];
    for (const b of blocks) {
      switch (b.type) {
        case 'text':
          out.push({ type: 'text', text: b.text });
          break;
        case 'image':
          if (imagesOk) out.push({ type: 'image', data: b.data, mimeType: b.mimeType });
          else out.push({ type: 'text', text: `[image omitted: ${this.cfg.name} does not accept images]` });
          break;
        case 'resource_link':
          out.push({ type: 'resource_link', uri: b.uri, name: b.name, ...(b.mimeType ? { mimeType: b.mimeType } : {}) });
          break;
      }
    }
    return out;
  }

  /** Ask the agent to stop the current turn. The prompt resolves with stopReason 'cancelled'. */
  async cancel(sessionId: string): Promise<boolean> {
    const rt = this.runtimes.get(sessionId);
    if (!rt || !rt.running || !rt.acpSessionId || !this.proc?.alive) return false;
    try {
      await this.proc.cancel(rt.acpSessionId);
    } catch (err) {
      this.log.warn('cancel.failed', { sessionId, ...errorInfo(err) });
      return false;
    }
    return true;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const rt = await this.ensureSession(sessionId);
    if (!this.proc || !rt.acpSessionId) throw new Error('agent is not connected');
    await this.proc.setMode(rt.acpSessionId, modeId);
    this.sink.patchSession(sessionId, { modeId });
    this.sink.emit(sessionId, { type: 'mode.changed', modeId });
  }

  /** session/close when the agent supports it; always forgets the runtime. */
  async closeSession(sessionId: string): Promise<void> {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    void this.terminals.killAllForSession(sessionId);
    if (rt.running) await this.cancel(sessionId);
    if (rt.acpSessionId && rt.gen === this.gen && this.proc?.alive && this.proc.capabilities?.sessionCapabilities?.close) {
      try {
        await this.proc.closeSession(rt.acpSessionId);
      } catch (err) {
        this.log.debug('close_session.failed', { sessionId, ...errorInfo(err) });
      }
    }
    if (rt.acpSessionId) this.byAcp.delete(rt.acpSessionId);
    this.runtimes.delete(sessionId);
  }

  // ------------------------------------------------------------------ introspection
  sessionCount(): number {
    let n = 0;
    for (const rt of this.runtimes.values()) if (rt.acpSessionId && rt.gen === this.gen) n++;
    return n;
  }

  runningTurns(): Promise<void>[] {
    const out: Promise<void>[] = [];
    for (const rt of this.runtimes.values()) if (rt.running && rt.turnDone) out.push(rt.turnDone);
    return out;
  }

  info(): AgentInfo {
    // Unknown until `initialize` answered: omit the capability flags rather than report them as false.
    const caps = this.proc?.initResult?.agentCapabilities;
    const models = new Set<string>([...(this.cfg.customModels ?? []), ...this.knownModels]);
    const info: AgentInfo = {
      id: this.id,
      name: this.cfg.name,
      available: this.state === 'ready' || this.state === 'starting',
    };
    if (this.state === 'error' && this.detail) info.reason = this.detail;
    if (this.state === 'stopped') info.reason = 'not started yet';
    if (models.size) info.models = [...models];
    if (this.defaultModel) info.defaultModel = this.defaultModel;
    if (caps) {
      info.supportsImages = caps.promptCapabilities?.image === true;
      info.supportsLoadSession = caps.loadSession === true;
    }
    return info;
  }

  health(): { id: string; state: HostState; sessions: number; detail?: string } {
    const h: { id: string; state: HostState; sessions: number; detail?: string } = { id: this.id, state: this.state, sessions: this.sessionCount() };
    if (this.detail) h.detail = this.detail;
    return h;
  }

  // ------------------------------------------------------------------ shutdown
  /**
   * Graceful stop: let running turns finish (up to `drainMs`), or cancel them when
   * `cancelTurns` is set; then SIGINT the adapter.
   */
  async shutdown(opts: { drainMs: number; cancelTurns: boolean }): Promise<void> {
    this.stopping = true;
    const running = this.runningTurns();
    if (running.length && opts.cancelTurns) {
      for (const rt of this.runtimes.values()) if (rt.running) await this.cancel(rt.id).catch(() => false);
    }
    if (running.length) {
      const timer = new Promise<void>((res) => setTimeout(res, opts.drainMs).unref());
      await Promise.race([Promise.allSettled(running), timer]);
    }
    // Reap agent-spawned commands before the adapter: awaited, so a process.exit() right after
    // shutdown cannot beat the SIGKILL escalation (app.ts bounds this step with drainMs + 20 s).
    await this.terminals.killAll();
    const proc = this.proc;
    this.proc = null;
    if (proc) await proc.stop(5000);
    this.setState('stopped');
  }
}
