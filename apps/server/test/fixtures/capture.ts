/**
 * Capture real ACP traffic from one adapter into a fixture for `test/unit-adapters.test.ts`.
 *
 *   cd apps/server
 *   npx tsx test/fixtures/capture.ts claude --mode default --out test/fixtures/claude-agent-acp.json
 *   npx tsx test/fixtures/capture.ts codex  --mode read-only --out test/fixtures/codex-acp.json
 *
 * Spawns the adapter exactly as the daemon does (same `AcpProcess`, same `clientCapabilities`), creates a
 * session in a throwaway git repo, sends ONE prompt (this costs real tokens), auto-approves every permission
 * request with its first `allow_once` option, waits for late notifications (session titles arrive after the
 * prompt result) and writes the JSON with the temp paths, the home directory and any secret-looking env
 * values stripped. Not a test: the runner only picks up `test/*.test.ts`.
 *
 * Options: --mode <id> (session/set_mode before the prompt), --prompt "<text>", --out <file>,
 *          --settle <ms> (how long to wait for late notifications, default 6000).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RequestError, type RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { AcpProcess, type AcpClientHandlers } from '../../src/agents/acp.js';
import { AgentTerminals } from '../../src/agents/agent-terminals.js';
import { agentEnv, defaultAgents } from '../../src/config.js';
import { setLogSink } from '../../src/log.js';
import { makeTmpRepo, rmrf, sleep } from '../helpers.js';

const DEFAULT_PROMPT =
  'Run the shell command `echo hi` and then create a file named hello.txt in the current directory containing the single line `hi`. Reply with the word DONE when finished.';

interface Recorded {
  t: number;
  [key: string]: unknown;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string' },
      prompt: { type: 'string' },
      out: { type: 'string' },
      settle: { type: 'string' },
    },
  });
  const agentId = positionals[0];
  const cfg = agentId ? defaultAgents()[agentId] : undefined;
  if (!agentId || !cfg) {
    process.stderr.write(`usage: capture.ts <${Object.keys(defaultAgents()).join('|')}> [--mode id] [--prompt text] [--out file] [--settle ms]\n`);
    process.exit(2);
  }
  const promptText = values.prompt ?? DEFAULT_PROMPT;
  const settleMs = values.settle ? Number(values.settle) : 6000;
  const out = values.out ?? path.join('test', 'fixtures', `${agentId}.json`);

  const daemonLog: string[] = [];
  setLogSink((line) => {
    daemonLog.push(line);
    if (process.env.MIDE_CAPTURE_VERBOSE === '1') process.stderr.write(`${line}\n`);
  });

  const repo = makeTmpRepo();
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const updates: Recorded[] = [];
  const permissionRequests: Recorded[] = [];
  const clientRequests: Recorded[] = [];
  const terminals = new AgentTerminals();
  let sessionId = '';

  const under = (p: string): string => {
    const real = path.resolve(path.isAbsolute(p) ? p : path.join(repo, p));
    if (real !== repo && !real.startsWith(repo + path.sep)) throw RequestError.invalidParams(undefined, 'path is outside the capture repo');
    return real;
  };

  const handlers: AcpClientHandlers = {
    onSessionUpdate: (params) => {
      updates.push({ t: now(), params });
      const u = isRec(params) && isRec(params.update) ? params.update : undefined;
      process.stderr.write(`  update ${String(u?.sessionUpdate)}${u && typeof u.title === 'string' ? ` "${u.title}"` : ''}\n`);
    },
    onRequestPermission: async (params): Promise<RequestPermissionResponse> => {
      const options = isRec(params) && Array.isArray(params.options) ? (params.options as Record<string, unknown>[]) : [];
      const pick = options.find((o) => o.kind === 'allow_once') ?? options[0];
      const optionId = pick && typeof pick.optionId === 'string' ? pick.optionId : undefined;
      const response: RequestPermissionResponse = optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
      permissionRequests.push({ t: now(), params, response });
      process.stderr.write(`  permission requested -> ${optionId ?? 'cancelled'}\n`);
      return response;
    },
    onReadTextFile: async (params) => {
      clientRequests.push({ t: now(), method: 'fs/read_text_file', params });
      return { content: await fs.promises.readFile(under(params.path), 'utf8') };
    },
    onWriteTextFile: async (params) => {
      clientRequests.push({ t: now(), method: 'fs/write_text_file', params });
      const real = under(params.path);
      await fs.promises.mkdir(path.dirname(real), { recursive: true });
      await fs.promises.writeFile(real, params.content, 'utf8');
    },
    onCreateTerminal: async (params) => {
      clientRequests.push({ t: now(), method: 'terminal/create', params });
      const term = terminals.create({ sessionId, command: params.command, args: params.args, env: params.env, cwd: params.cwd ?? repo, outputByteLimit: params.outputByteLimit }, repo, agentEnv(cfg));
      return { terminalId: term.id };
    },
    onTerminalOutput: async (params) => {
      clientRequests.push({ t: now(), method: 'terminal/output', params });
      const o = terminals.output(params.terminalId);
      if (!o) throw RequestError.invalidParams(undefined, 'unknown terminal');
      return { output: o.output, truncated: o.truncated, exitStatus: o.exitStatus };
    },
    onWaitForTerminalExit: async (params) => {
      clientRequests.push({ t: now(), method: 'terminal/wait_for_exit', params });
      const exit = await terminals.waitForExit(params.terminalId);
      if (!exit) throw RequestError.invalidParams(undefined, 'unknown terminal');
      return exit;
    },
    onKillTerminal: async (params) => {
      clientRequests.push({ t: now(), method: 'terminal/kill', params });
      void terminals.kill(params.terminalId);
    },
    onReleaseTerminal: async (params) => {
      clientRequests.push({ t: now(), method: 'terminal/release', params });
      terminals.release(params.terminalId);
    },
  };

  process.stderr.write(`spawning ${cfg.command} ${cfg.args.join(' ')} (cwd for the session: ${repo})\n`);
  const proc = new AcpProcess(agentId, cfg, handlers, { cwd: os.homedir() });
  let exitCode = 0;
  try {
    const initialize = await proc.initialize(90_000);
    process.stderr.write(`initialized: ${JSON.stringify(initialize.agentInfo)} in ${now()} ms\n`);
    const newSession = await proc.newSession(repo);
    sessionId = newSession.sessionId;
    process.stderr.write(`session/new -> ${sessionId} in ${now()} ms; modes=${JSON.stringify(newSession.modes?.availableModes?.map((m) => m.id))}\n`);
    let setMode: unknown;
    if (values.mode) {
      setMode = await proc.setMode(sessionId, values.mode);
      process.stderr.write(`session/set_mode ${values.mode} -> ${JSON.stringify(setMode)}\n`);
    }
    const prompt = [{ type: 'text' as const, text: promptText }];
    const tPrompt = now();
    const response = await proc.prompt(sessionId, prompt);
    process.stderr.write(`session/prompt -> ${JSON.stringify(response)} after ${now() - tPrompt} ms\n`);
    process.stderr.write(`waiting ${settleMs} ms for late notifications…\n`);
    await sleep(settleMs);

    const fixture = {
      agentId,
      adapter: { command: cfg.command, args: cfg.args },
      capturedAt: new Date().toISOString(),
      initialize,
      newSession: { request: { cwd: repo, mcpServers: [] }, response: newSession },
      ...(values.mode ? { setMode: { modeId: values.mode, response: setMode } } : {}),
      prompt: { request: prompt, response, durationMs: now() - tPrompt - settleMs },
      updates,
      permissionRequests,
      clientRequests,
      stderrTail: proc.stderrTail(),
    };
    const json = sanitize(JSON.stringify(fixture, null, 2), repo);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json + '\n');
    process.stderr.write(`wrote ${out} (${updates.length} updates, ${permissionRequests.length} permission requests, ${clientRequests.length} client requests)\n`);
  } catch (err) {
    exitCode = 1;
    process.stderr.write(`capture failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.stderr.write(`adapter stderr tail:\n${proc.stderrTail()}\n`);
    process.stderr.write(`daemon log tail:\n${daemonLog.slice(-20).join('\n')}\n`);
  } finally {
    await terminals.killAll();
    await proc.stop(3000);
    rmrf(repo);
  }
  process.exit(exitCode);
}

/** Replace the temp repo, the home dir and secret-looking env values so the fixture is safe to commit. */
function sanitize(json: string, repo: string): string {
  let out = json.split(repo).join('/repo');
  const home = os.homedir();
  const realHome = fs.realpathSync.native(home);
  for (const h of new Set([home, realHome])) out = out.split(h).join('~');
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 8) continue;
    if (!/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i.test(k)) continue;
    out = out.split(v).join('<redacted>');
  }
  out = out.replace(/sk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, '<redacted>');
  out = out.replace(/Bearer [A-Za-z0-9._~+/=-]{12,}/g, 'Bearer <redacted>');
  return out;
}

void main();
