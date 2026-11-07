/**
 * A fake ACP agent for driving the daemon and the Studio without spending tokens: stdio ndjson JSON-RPC that answers
 * `initialize` / `session/new` / `session/prompt` and, per prompt, plays a scripted turn of realistic `session/update`
 * notifications — text chunks, a read, an Edit with a diff (gated by `session/request_permission` when the prompt
 * contains "ask"), which it then really applies to the file on disk, a new-file Write, and a shell command.
 *
 *   config.json:  "stub": { "name": "Stub Agent", "command": "node", "args": ["--import", "tsx", "<repo>/apps/server/test/fixtures/stub-agent.ts"] }
 *
 * Prompt words steer it: "ask" gates the edit behind a permission request; "question" asks for a greeting style;
 * "ask question" raises both requests; "slow" doubles every pause; "fail" refuses the turn after the read.
 * Supports session/cancel. Everything else runs the default script. Not a test file (the runner only
 * picks up test/*.test.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

interface Rpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const out = (msg: Rpc): void => {
  process.stdout.write(JSON.stringify(msg) + '\n');
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let nextId = 1000;
const pending = new Map<number, (result: unknown) => void>();
const requestSessions = new Map<number, string>();
const cancelled = new Set<string>();
function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const sessionId = (params as { sessionId?: string }).sessionId;
    if (sessionId) requestSessions.set(id, sessionId);
    out({ jsonrpc: '2.0', id, method, params });
  });
}
function notify(method: string, params: unknown): void {
  out({ jsonrpc: '2.0', method, params });
}

const sessions = new Map<string, { cwd: string }>();
let toolSeq = 0;

async function runTurn(sessionId: string, text: string): Promise<{ stopReason: string }> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('unknown session');
  cancelled.delete(sessionId);
  const slow = /slow/i.test(text) ? 2 : 1;
  const gate = /ask/i.test(text);
  const checkCancelled = () => {
    if (cancelled.has(sessionId)) throw new Error('QA_TURN_CANCELLED');
  };
  const pause = async (ms: number) => {
    await sleep(ms * slow);
    checkCancelled();
  };
  const update = (update: Record<string, unknown>) => notify('session/update', { sessionId, update });
  const appPath = path.join(s.cwd, 'src', 'app.ts');
  const greetPath = path.join(s.cwd, 'src', 'greet.ts');

  // Opt-in form coverage for browser QA; default Studio scenarios retain their original timing.
  const askQuestion = () =>
    request('elicitation/create', {
      sessionId,
      mode: 'form',
      message: 'Which greeting style should I use?',
      requestedSchema: {
        type: 'object',
        properties: { style: { type: 'string', title: 'Greeting style', enum: ['Friendly', 'Formal'] } },
        required: ['style'],
      },
    });
  if (/question/i.test(text) && !gate) {
    const answer = (await askQuestion()) as { action?: string; content?: { style?: string } };
    checkCancelled();
    update({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text:
          answer.action === 'accept'
            ? `You chose ${answer.content?.style ?? 'a greeting'}. Ready for the next task.`
            : 'Question skipped. Ready for the next task.',
      },
    });
    return { stopReason: 'end_turn' };
  }

  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I’ll add a greeting helper and wire it into ' } });
  await pause(250);
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '`src/app.ts`. First let me read the file.' } });
  await pause(400);

  const readId = `call_${++toolSeq}`;
  update({
    sessionUpdate: 'tool_call',
    toolCallId: readId,
    title: 'Read src/app.ts',
    kind: 'read',
    status: 'in_progress',
    locations: [{ path: appPath }],
    rawInput: { file_path: appPath },
  });
  await pause(500);
  const before = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '';
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: readId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: before } }],
  });
  if (/fail/i.test(text)) {
    await pause(300);
    return { stopReason: 'refusal' };
  }
  await pause(500);

  // edit 1: replace the greeting line
  const oldText = 'export function hello(name: string) {\n  return `hello ${name}`;\n}';
  const newText = "import { greet } from './greet';\n\nexport function hello(name: string) {\n  return greet(name, { excited: true });\n}";
  const editId = `call_${++toolSeq}`;
  const diff = { type: 'diff', path: appPath, oldText, newText };
  update({
    sessionUpdate: 'tool_call',
    toolCallId: editId,
    title: 'Edit src/app.ts',
    kind: 'edit',
    status: 'pending',
    content: [diff],
    locations: [{ path: appPath, line: 1 }],
    rawInput: { file_path: appPath, old_string: oldText, new_string: newText },
  });
  if (gate) {
    const question = /question/i.test(text) ? askQuestion() : null;
    const res = (await request('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId: editId,
        title: 'Edit src/app.ts',
        kind: 'edit',
        status: 'pending',
        content: [diff],
        locations: [{ path: appPath }],
        rawInput: { file_path: appPath, old_string: oldText, new_string: newText },
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow edits', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    })) as { outcome?: { outcome?: string; optionId?: string } };
    if (question) await question;
    checkCancelled();
    if (res.outcome?.outcome !== 'selected' || !res.outcome.optionId?.startsWith('allow')) {
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: editId,
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'Edit rejected by the user' } }],
      });
      await pause(200);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Okay, I left the file alone.' } });
      return { stopReason: 'end_turn' };
    }
  }
  update({ sessionUpdate: 'tool_call_update', toolCallId: editId, status: 'in_progress' });
  await pause(900);
  if (before.includes(oldText)) fs.writeFileSync(appPath, before.replace(oldText, newText));
  await pause(150);
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: editId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'The file has been updated.' } }],
  });
  await pause(700);

  // edit 2: a brand-new file
  const greetText =
    'export interface GreetOptions {\n  excited?: boolean;\n}\n\nexport function greet(name: string, opts: GreetOptions = {}): string {\n  const base = `Hello, ${name}`;\n  return opts.excited ? `${base}!` : `${base}.`;\n}\n';
  const writeId = `call_${++toolSeq}`;
  update({
    sessionUpdate: 'tool_call',
    toolCallId: writeId,
    title: 'Write src/greet.ts',
    kind: 'edit',
    status: 'in_progress',
    content: [{ type: 'diff', path: greetPath, oldText: null, newText: greetText }],
    locations: [{ path: greetPath }],
    rawInput: { file_path: greetPath, content: greetText },
  });
  await pause(900);
  fs.mkdirSync(path.dirname(greetPath), { recursive: true });
  fs.writeFileSync(greetPath, greetText);
  await pause(150);
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: writeId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'File created successfully.' } }],
  });
  await pause(500);

  // a shell command with output
  const shId = `call_${++toolSeq}`;
  update({
    sessionUpdate: 'tool_call',
    toolCallId: shId,
    title: 'Run tests',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: 'pnpm test -- --filter greet', description: 'Run the greet tests' },
  });
  await pause(1100);
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: shId,
    status: 'completed',
    content: [
      {
        type: 'content',
        content: {
          type: 'text',
          text: '> greet\n\n✓ greet adds punctuation (2 ms)\n✓ hello is excited (1 ms)\n\nTests: 2 passed, 2 total',
        },
      },
    ],
    rawOutput: { exitCode: 0 },
  });
  await pause(400);
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Done. `hello()` now delegates to the new `greet()` helper in **src/greet.ts**, and the tests pass.' },
  });
  return { stopReason: 'end_turn' };
}

async function handle(msg: Rpc): Promise<void> {
  if (msg.id !== undefined && msg.method === undefined) {
    const r = pending.get(Number(msg.id));
    if (r) {
      pending.delete(Number(msg.id));
      requestSessions.delete(Number(msg.id));
      r(msg.result ?? msg.error);
    }
    return;
  }
  const reply = (result: unknown) => {
    if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, result });
  };
  const params = (msg.params ?? {}) as Record<string, unknown>;
  switch (msg.method) {
    case 'initialize':
      reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: [],
        agentInfo: { name: 'stub-agent', version: '0.1.0' },
      });
      return;
    case 'authenticate':
      reply({});
      return;
    case 'session/new': {
      const sessionId = `stub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      sessions.set(sessionId, { cwd: String(params.cwd ?? process.cwd()) });
      reply({
        sessionId,
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default', description: 'Asks before edits when told to' },
            { id: 'yolo', name: 'Auto', description: 'Never asks' },
          ],
        },
      });
      return;
    }
    case 'session/set_mode':
      reply({});
      return;
    case 'session/prompt': {
      const sessionId = String(params.sessionId);
      const blocks = (params.prompt as { type: string; text?: string }[] | undefined) ?? [];
      const text = blocks.map((b) => b.text ?? '').join('\n');
      try {
        reply(await runTurn(sessionId, text));
      } catch (err) {
        if (cancelled.has(sessionId)) {
          reply({ stopReason: 'cancelled' });
          return;
        }
        if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: (err as Error).message } });
      }
      return;
    }
    case 'session/cancel': {
      const sessionId = String(params.sessionId);
      cancelled.add(sessionId);
      for (const [id, target] of requestSessions) {
        if (target !== sessionId) continue;
        const resolve = pending.get(id);
        pending.delete(id);
        requestSessions.delete(id);
        resolve?.({ action: 'cancel', outcome: { outcome: 'cancelled' } });
      }
      return;
    }
    default:
      if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  let msg: Rpc;
  try {
    msg = JSON.parse(line) as Rpc;
  } catch {
    return;
  }
  void handle(msg);
});
process.stdin.on('end', () => process.exit(0));
