/**
 * One ACP agent process: spawn the adapter, speak JSON-RPC (ndjson) over its stdio with
 * @agentclientprotocol/sdk, and expose typed agent-side requests. Client-side requests
 * (permissions, fs, terminals) are delegated to `AcpClientHandlers`.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream';
import { Readable, Writable } from 'node:stream';
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type ContentBlock as AcpContentBlock,
  type CreateElicitationResponse,
  type CreateTerminalRequest,
  type InitializeResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionResponse,
  type SetSessionConfigOptionResponse,
  type WriteTextFileRequest,
} from '@agentclientprotocol/sdk';
import type { AgentConfig } from '../config.js';
import { agentEnv } from '../config.js';
import { createLogger, errorInfo } from '../log.js';

export interface AcpClientHandlers {
  /** raw `session/update` params (not validated, so one odd notification cannot break the stream) */
  onSessionUpdate(params: unknown): void;
  onRequestPermission(params: unknown, signal: AbortSignal): Promise<RequestPermissionResponse>;
  /** raw `elicitation/create` params (form or url mode); the daemon answers once the phone has. Absent = dismissed. */
  onCreateElicitation?(params: unknown, signal: AbortSignal): Promise<CreateElicitationResponse>;
  /** raw `elicitation/complete` params: a url-mode flow finished on the agent's side */
  onCompleteElicitation?(params: unknown): void;
  onReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  onWriteTextFile(params: WriteTextFileRequest): Promise<void>;
  onCreateTerminal(params: CreateTerminalRequest): Promise<{ terminalId: string }>;
  onTerminalOutput(params: { sessionId: string; terminalId: string }): Promise<{
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
  }>;
  onWaitForTerminalExit(params: { sessionId: string; terminalId: string }): Promise<{ exitCode?: number | null; signal?: string | null }>;
  onKillTerminal(params: { sessionId: string; terminalId: string }): Promise<void>;
  onReleaseTerminal(params: { sessionId: string; terminalId: string }): Promise<void>;
}

export interface AcpProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** last stderr lines, for diagnostics */
  stderrTail: string;
}

/** An agent did not answer a request within its budget (see `AcpProcess.timed`). */
export class AcpTimeoutError extends Error {
  constructor(
    readonly op: string,
    readonly timeoutMs: number,
  ) {
    super(`${op}: no reply from the agent within ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

export class AcpProcess {
  private readonly log;
  private readonly child: ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable>;
  private readonly conn: ClientConnection;
  private readonly stderrLines: string[] = [];
  private exitInfo: AcpProcessExit | null = null;
  /** the JSON-RPC connection closed while the child was still running */
  private connectionClosed = false;
  private resolveExit: (e: AcpProcessExit) => void = () => {};
  readonly exited: Promise<AcpProcessExit>;
  readonly startedAt = Date.now();
  initResult: InitializeResponse | null = null;

  constructor(
    readonly agentId: string,
    readonly cfg: AgentConfig,
    handlers: AcpClientHandlers,
    opts: { cwd: string },
  ) {
    this.log = createLogger({ mod: 'acp', agent: agentId });
    this.exited = new Promise<AcpProcessExit>((res) => {
      this.resolveExit = res;
    });
    // Own process group: `npx -y <adapter>` is a wrapper around the real adapter, so signals must reach
    // the whole group (see `signalGroup`) or stop() would kill npx and orphan the node process behind it.
    this.child = spawn(cfg.command, cfg.args, {
      cwd: opts.cwd,
      env: agentEnv(cfg),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    this.log.info('spawn', { pid: this.child.pid, command: cfg.command, args: cfg.args });

    this.child.stdin.on('error', (err) => this.log.debug('stdin.error', errorInfo(err)));
    this.child.stdout.on('error', (err) => this.log.debug('stdout.error', errorInfo(err)));
    this.child.stderr.setEncoding('utf8');
    let partial = '';
    this.child.stderr.on('data', (chunk: string) => {
      partial += chunk;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        this.stderrLines.push(line);
        if (this.stderrLines.length > 60) this.stderrLines.shift();
        this.log.debug('stderr', { line: line.slice(0, 500) });
      }
    });
    this.child.on('error', (err) => {
      this.log.error('spawn.error', errorInfo(err));
      this.stderrLines.push(`spawn error: ${err.message}`);
      this.finishExit(null, null);
    });
    this.child.on('exit', (code, signal) => this.finishExit(code, signal));

    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
    );

    const app = client({ name: `mide:${agentId}` })
      .onNotification('session/update', (p: unknown) => p, (ctx) => {
        try {
          handlers.onSessionUpdate(ctx.params);
        } catch (err) {
          this.log.error('session_update.handler_failed', errorInfo(err));
        }
      })
      .onRequest('session/request_permission', (p: unknown) => p, (ctx) => handlers.onRequestPermission(ctx.params, ctx.signal))
      .onRequest('elicitation/create', (p: unknown) => p, (ctx): Promise<CreateElicitationResponse> => {
        if (!handlers.onCreateElicitation) return Promise.resolve({ action: 'cancel' });
        return handlers.onCreateElicitation(ctx.params, ctx.signal);
      })
      .onNotification('elicitation/complete', (p: unknown) => p, (ctx) => {
        try {
          handlers.onCompleteElicitation?.(ctx.params);
        } catch (err) {
          this.log.error('elicitation_complete.handler_failed', errorInfo(err));
        }
      })
      .onRequest('fs/read_text_file', (ctx) => handlers.onReadTextFile(ctx.params))
      .onRequest('fs/write_text_file', async (ctx) => {
        await handlers.onWriteTextFile(ctx.params);
        return {};
      })
      .onRequest('terminal/create', (ctx) => handlers.onCreateTerminal(ctx.params))
      .onRequest('terminal/output', (ctx) => handlers.onTerminalOutput(ctx.params))
      .onRequest('terminal/wait_for_exit', (ctx) => handlers.onWaitForTerminalExit(ctx.params))
      .onRequest('terminal/kill', async (ctx) => {
        await handlers.onKillTerminal(ctx.params);
        return {};
      })
      .onRequest('terminal/release', async (ctx) => {
        await handlers.onReleaseTerminal(ctx.params);
        return {};
      });

    this.conn = app.connect(stream);
    void this.conn.closed.then(() => {
      if (this.exitInfo) return; // closed by finishExit: the process is already gone
      // stdout EOF or a failed stdin write with the child still running: every request would now reject,
      // so treat the process as dead (alive=false) and reap it; the host respawns on next use.
      this.connectionClosed = true;
      this.log.warn('connection.closed', { pid: this.child.pid, stderrTail: this.stderrTail() });
      void this.stop(2000);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Usable for requests: the child runs and its JSON-RPC connection is open. */
  get alive(): boolean {
    return this.exitInfo === null && !this.connectionClosed;
  }

  get exit(): AcpProcessExit | null {
    return this.exitInfo;
  }

  stderrTail(): string {
    return this.stderrLines.slice(-15).join('\n');
  }

  private finishExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitInfo) return;
    this.exitInfo = { code, signal, stderrTail: this.stderrTail() };
    this.log.info('exit', { code, signal });
    try {
      this.conn.close(new Error(`agent process exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`));
    } catch {
      /* already closed */
    }
    this.resolveExit(this.exitInfo);
  }

  /**
   * Race a request against a real deadline. The SDK's `cancellationSignal` only sends `$/cancel_request`
   * and then keeps waiting for the agent's reply, so an adapter that never answers (npx still downloading
   * it, a wedged process) would otherwise hang the caller forever — e.g. POST /api/sessions. On timeout
   * the agent is still told to cancel and the caller gets an AcpTimeoutError.
   */
  private timed<T>(op: string, timeoutMs: number | undefined, run: (opts: { cancellationSignal?: AbortSignal }) => Promise<T>): Promise<T> {
    if (!timeoutMs) return run({});
    const ac = new AbortController();
    const request = run({ cancellationSignal: ac.signal });
    request.catch(() => undefined); // the loser of the race must not surface as an unhandled rejection
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        ac.abort();
        reject(new AcpTimeoutError(op, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      request.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  async initialize(timeoutMs = 60_000): Promise<InitializeResponse> {
    const res = await this.timed('initialize', timeoutMs, (opts) =>
      this.conn.agent.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            // Both elicitation modes: `form` is what claude-agent-acp gates AskUserQuestion on (the tool is disabled
            // without it) and how MCP servers ask questions; `url` covers OAuth hand-offs (the phone shows the
            // full URL before opening it). Requests are persisted and answered by the phone (see sessions.ts).
            elicitation: { form: {}, url: {} },
            // Zed's terminal-output extension, implemented by claude-agent-acp and codex-acp: with it a shell
            // command is announced as a `terminal` content block and its complete output + exit code arrive
            // once, in `_meta.terminal_output` / `_meta.terminal_exit` of the final tool_call_update (see
            // `terminalStream` in normalize.ts). Without it codex-acp streams `terminal_output_delta` chunks
            // and claude-agent-acp falls back to a fenced code block with no exit code.
            _meta: { terminal_output: true },
          },
          clientInfo: { name: 'mobile-ide', version: '0.1.0' },
        },
        opts,
      ),
    );
    this.initResult = res;
    return res;
  }

  get capabilities(): InitializeResponse['agentCapabilities'] {
    return this.initResult?.agentCapabilities ?? {};
  }

  newSession(cwd: string, timeoutMs = 120_000): Promise<NewSessionResponse> {
    return this.timed('session/new', timeoutMs, (opts) => this.conn.agent.request('session/new', { cwd, mcpServers: [] }, opts));
  }

  loadSession(sessionId: string, cwd: string, timeoutMs = 120_000): Promise<LoadSessionResponse> {
    return this.timed('session/load', timeoutMs, (opts) => this.conn.agent.request('session/load', { sessionId, cwd, mcpServers: [] }, opts));
  }

  /** No timeout: a turn may legitimately run for a long time (permission prompts wait for the phone). */
  prompt(sessionId: string, prompt: AcpContentBlock[], signal?: AbortSignal): Promise<PromptResponse> {
    return this.conn.agent.request('session/prompt', { sessionId, prompt }, signal ? { cancellationSignal: signal } : {});
  }

  cancel(sessionId: string): Promise<void> {
    return this.conn.agent.notify('session/cancel', { sessionId });
  }

  setMode(sessionId: string, modeId: string, timeoutMs = 30_000): Promise<unknown> {
    return this.timed('session/set_mode', timeoutMs, (opts) => this.conn.agent.request('session/set_mode', { sessionId, modeId }, opts));
  }

  setConfigOption(sessionId: string, configId: string, value: string, timeoutMs = 30_000): Promise<SetSessionConfigOptionResponse> {
    return this.timed('session/set_config_option', timeoutMs, (opts) => this.conn.agent.request('session/set_config_option', { sessionId, configId, value }, opts));
  }

  closeSession(sessionId: string, timeoutMs = 15_000): Promise<unknown> {
    return this.timed('session/close', timeoutMs, (opts) => this.conn.agent.request('session/close', { sessionId }, opts));
  }

  /**
   * Deliver a signal to the adapter's whole process group (the child was spawned `detached`, so its pid
   * is the group id). Falls back to the direct child when the group is already gone or the spawn failed.
   */
  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    try {
      if (pid) process.kill(-pid, signal);
      else this.child.kill(signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  /** SIGINT lets adapters finish/flush; escalate to SIGKILL after `graceMs`. */
  async stop(graceMs = 5000): Promise<AcpProcessExit> {
    if (this.exitInfo) return this.exitInfo;
    this.signalGroup('SIGINT');
    const timer = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), graceMs).unref());
    const outcome = await Promise.race([this.exited, timer]);
    if (outcome === 'timeout') {
      this.log.warn('stop.escalate', { pid: this.child.pid });
      this.signalGroup('SIGKILL');
      return this.exited;
    }
    return outcome;
  }
}

/** Human-friendly message for an ACP failure (auth-required gets a hint). */
export function describeAcpError(err: unknown): string {
  if (err instanceof RequestError) {
    const data = err.data;
    const detail = typeof data === 'string' ? data : data && typeof data === 'object' ? JSON.stringify(data) : '';
    if (err.code === -32000) return `Authentication required (${err.message})${detail ? ': ' + detail : ''}`;
    return `${err.message}${detail ? ': ' + detail.slice(0, 500) : ''}`;
  }
  if (err instanceof AcpTimeoutError) return `timed out waiting for the agent (${err.op}, ${Math.round(err.timeoutMs / 1000)} s)`;
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out waiting for the agent';
    return err.message;
  }
  return String(err);
}
