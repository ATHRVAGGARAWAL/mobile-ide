/**
 * Terminal manager tests. Pure helpers are always tested; the tmux-backed flow runs against a
 * real tmux on a dedicated socket directory (TMUX_TMPDIR) so it never touches your own sessions,
 * and is skipped with a message when tmux is not installed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BadRequestError } from '../src/errors.js';
import { createLogger, setLogSink } from '../src/log.js';
import { prepareMirroredTerminal } from '../src/terminal-mirror.js';
import {
  AltScreenFilter,
  TMUX_SESSION_ENV,
  TMUX_SESSION_OPTIONS,
  TerminalManager,
  clampSize,
  formatScrollback,
  isValidTerminalId,
  sessionOptionCommands,
} from '../src/terminal.js';

const ESC = '\x1b';
const quiet = process.env.MIDE_LOG !== 'debug';
if (quiet) setLogSink(() => {});
const log = createLogger({ test: 'terminal' });

function text(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8');
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('isValidTerminalId', () => {
  it('accepts [a-zA-Z0-9_-] up to 64 chars', () => {
    for (const ok of ['a', 'abc', 'A-Z_09', 'x'.repeat(64), 'proj_home-1']) assert.equal(isValidTerminalId(ok), true, ok);
  });
  it('rejects anything tmux or a shell could misread', () => {
    for (const bad of ['', 'x'.repeat(65), 'a.b', 'a:b', 'a b', '../x', 'a/b', "a'b", 'ä', 42, null, undefined]) {
      assert.equal(isValidTerminalId(bad), false, String(bad));
    }
  });
});

describe('clampSize', () => {
  it('falls back to 80x24 for garbage and clamps to sane bounds', () => {
    assert.deepEqual(clampSize(NaN, undefined), { cols: 80, rows: 24 });
    assert.deepEqual(clampSize('120', '40'), { cols: 120, rows: 40 });
    assert.deepEqual(clampSize(0, -5), { cols: 2, rows: 2 });
    assert.deepEqual(clampSize(99999, 99999), { cols: 1000, rows: 500 });
    assert.deepEqual(clampSize(80.6, 24.2), { cols: 81, rows: 24 });
    assert.deepEqual(clampSize('', 'abc'), { cols: 80, rows: 24 });
  });
});

describe('AltScreenFilter', () => {
  it('drops the alternate-screen switch and keeps everything else byte for byte', () => {
    const f = new AltScreenFilter();
    const input = `${ESC}[?1049h${ESC}[22;0;0t${ESC}[?1h${ESC}=${ESC}[H${ESC}[2J${ESC}[31mred${ESC}[0m`;
    const out = f.push(Buffer.from(input, 'latin1')).toString('latin1');
    assert.equal(out, `${ESC}[22;0;0t${ESC}[?1h${ESC}=${ESC}[H${ESC}[2J${ESC}[31mred${ESC}[0m`);
    assert.equal(f.holding, false);
  });

  it('removes all smcup/rmcup variants', () => {
    const f = new AltScreenFilter();
    const input = `a${ESC}[?1049lb${ESC}[?47hc${ESC}[?47ld${ESC}[?1047he${ESC}[?1047lf`;
    assert.equal(f.push(Buffer.from(input, 'latin1')).toString('latin1'), 'abcdef');
  });

  it('handles a sequence split across chunks', () => {
    const f = new AltScreenFilter();
    const first = f.push(Buffer.from(`abc${ESC}[?10`, 'latin1'));
    assert.equal(first.toString('latin1'), 'abc');
    assert.equal(f.holding, true);
    const second = f.push(Buffer.from('49hdef', 'latin1'));
    assert.equal(second.toString('latin1'), 'def');
    assert.equal(f.holding, false);
  });

  it('holds a bare ESC at a chunk end and releases it when the sequence turns out to be unrelated', () => {
    const f = new AltScreenFilter();
    assert.equal(f.push(Buffer.from(`abc${ESC}`, 'latin1')).toString('latin1'), 'abc');
    assert.equal(f.holding, true);
    assert.equal(f.push(Buffer.from('[31mX', 'latin1')).toString('latin1'), `${ESC}[31mX`);
  });

  it('flush() returns a partial that never completed', () => {
    const f = new AltScreenFilter();
    assert.equal(f.push(Buffer.from(`x${ESC}[?1`, 'latin1')).toString('latin1'), 'x');
    assert.equal(f.flush().toString('latin1'), `${ESC}[?1`);
    assert.equal(f.holding, false);
    assert.equal(f.flush().length, 0);
  });

  it('passes look-alike sequences through untouched', () => {
    const f = new AltScreenFilter();
    const input = `${ESC}[?1050h${ESC}[?104h${ESC}[?2004h${ESC}[?1049x`;
    assert.equal(f.push(Buffer.from(input, 'latin1')).toString('latin1'), input);
  });

  it('is byte-safe for UTF-8 payloads and empty chunks', () => {
    const f = new AltScreenFilter();
    const payload = Buffer.from(`héllo → wörld ${ESC}[?1049h✓`, 'utf8');
    assert.equal(f.push(payload).toString('utf8'), 'héllo → wörld ✓');
    assert.equal(f.push(Buffer.alloc(0)).length, 0);
  });
});

describe('formatScrollback', () => {
  it('trims trailing blank rows, uses CRLF, and resets attributes at the end', () => {
    const out = formatScrollback(`one\n${ESC}[32mtwo${ESC}[0m\n\n${ESC}[0m\n   \n`);
    assert.equal(out, `one\r\n${ESC}[32mtwo${ESC}[0m\r\n${ESC}[0m`);
  });

  it('returns an empty string for an empty pane', () => {
    assert.equal(formatScrollback(''), '');
    assert.equal(formatScrollback('\n\n\n'), '');
  });

  it('keeps the newest lines when over budget, cutting on a line boundary', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(97)}`);
    const out = formatScrollback(lines.join('\n'), 1000);
    assert.ok(Buffer.byteLength(out) <= 1000, `size ${Buffer.byteLength(out)}`);
    const kept = out.slice(0, out.lastIndexOf('\r\n')).split('\r\n');
    assert.equal(kept.length, 9);
    assert.equal(kept[0], lines[91]);
    assert.equal(kept[kept.length - 1], lines[99]);
    assert.ok(out.endsWith(`\r\n${ESC}[0m`));
  });

  it('keeps the tail of a single oversized line without splitting code points', () => {
    const out = formatScrollback('a'.repeat(5000), 100);
    assert.equal(Buffer.byteLength(out), 100);
    assert.ok(out.endsWith(`\r\n${ESC}[0m`));
    const multi = formatScrollback('é'.repeat(3000) + '✓', 101);
    assert.ok(Buffer.byteLength(multi) <= 101, `size ${Buffer.byteLength(multi)}`);
    assert.ok(!multi.includes('�'), 'no broken characters');
    assert.ok(multi.startsWith('é') && multi.includes('✓'));
    const emoji = formatScrollback('😀'.repeat(50), 20);
    assert.ok(Buffer.byteLength(emoji) <= 20);
    assert.equal(emoji.slice(0, -6), '😀😀😀'); // 14 bytes budget → 3 × 4-byte code points
  });
});

describe('sessionOptionCommands', () => {
  it('emits one `; set-option -t =<name>:` per session option (pane-style exact target)', () => {
    const argv = sessionOptionCommands('mide-abc');
    assert.equal(argv.length, TMUX_SESSION_OPTIONS.length * 6);
    for (let i = 0; i < TMUX_SESSION_OPTIONS.length; i++) {
      const [k, v] = TMUX_SESSION_OPTIONS[i]!;
      assert.deepEqual(argv.slice(i * 6, i * 6 + 6), [';', 'set-option', '-t', '=mide-abc:', k, v]);
    }
    assert.ok(TMUX_SESSION_OPTIONS.some(([k, v]) => k === 'status' && v === 'off'), 'the status bar is turned off per session');
    assert.ok(TMUX_SESSION_OPTIONS.some(([k, v]) => k === 'mouse' && v === 'on'), 'mouse reporting is turned on per session');
    assert.ok(!argv.includes('-g'), 'never touches the global options of the shared tmux server');
  });
});

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

describe('TerminalManager with a real tmux', { skip: tmuxAvailable ? false : 'tmux is not installed; skipping tmux-backed terminal tests' }, () => {
  const prefix = `mt${process.pid}`;
  let tmp = '';
  let tmuxEnv: NodeJS.ProcessEnv = {};
  let mgr: TerminalManager;

  const hasSession = (name: string): boolean => spawnSync('tmux', ['has-session', '-t', `=${name}`], { env: tmuxEnv, stdio: 'ignore' }).status === 0;
  const tmuxOut = (args: string[]): string => spawnSync('tmux', args, { env: tmuxEnv, encoding: 'utf8' }).stdout.trim();
  /** `show-options` prints nothing for an option left at its default, so a value here proves it was set on the session. */
  const sessionOption = (name: string, opt: string): string => tmuxOut(['show-options', '-t', `=${name}:`, opt]);
  const assertPhoneOptions = (name: string): void => {
    for (const [k, v] of TMUX_SESSION_OPTIONS) assert.equal(sessionOption(name, k), `${k} ${v}`, `${name}: ${k}`);
    // a global default must not have been changed
    for (const [k] of TMUX_SESSION_OPTIONS) assert.equal(tmuxOut(['show-options', '-g', k]), k === 'status' ? 'status on' : 'mouse off', `global ${k}`);
  };

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mide-term-')));
    // a private tmux server for this test run
    process.env.TMUX_TMPDIR = tmp;
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    tmuxEnv = { ...process.env };
    mgr = new TerminalManager({ shell: '$SHELL', tmuxPrefix: prefix, log });
  });

  after(async () => {
    await mgr.shutdown();
    spawnSync('tmux', ['kill-server'], { env: tmuxEnv, stdio: 'ignore' });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects invalid ids and a cwd that is not a directory', async () => {
    await assert.rejects(mgr.attach({ id: 'bad id', cwd: tmp, cols: 80, rows: 24 }), BadRequestError);
    await assert.rejects(mgr.attach({ id: 'nodir', cwd: path.join(tmp, 'missing'), cols: 80, rows: 24 }), BadRequestError);
    assert.equal(hasSession(`${prefix}-nodir`), false);
    await assert.rejects(mgr.kill('bad id'), BadRequestError);
  });

  it('refuses a tmux prefix that tmux or a shell could misread', () => {
    assert.throws(() => new TerminalManager({ shell: '$SHELL', tmuxPrefix: 'bad prefix', log }), /tmuxPrefix/);
  });

  it('desktop mirror fills the laptop, survives phone resize/reconnect, and shrinks after desktop detach', async () => {
    const id = 'mirror-size';
    const target = `=${prefix}-${id}:`;
    const phone = await mgr.attach({ id, cwd: tmp, cols: 47, rows: 18 });
    const phoneClients = tmuxOut(['list-clients', '-t', target, '-F', '#{client_name}']).split('\n');
    const desktop = await mgr.attach({ id, cwd: tmp, cols: 212, rows: 49 });
    let reconnected: Awaited<ReturnType<typeof mgr.attach>> | undefined;
    const size = () => tmuxOut(['display-message', '-p', '-t', target, '#{window_width}x#{window_height}']);
    try {
      // Reproduce the original broken laptop flag, then exercise the in-place upgrade.
      const desktopName = tmuxOut(['list-clients', '-t', target, '-F', '#{client_name}'])
        .split('\n').find((name) => !phoneClients.includes(name));
      assert.ok(desktopName);
      tmuxOut(['refresh-client', '-t', desktopName, '-f', 'ignore-size']);
      await prepareMirroredTerminal(`${prefix}-${id}`);
      await waitFor(() => size() === '212x49', 3000, 'desktop fills its viewport');
      phone.resize(52, 20);
      await waitFor(() => size() === '212x49', 3000, 'phone resize keeps desktop size');
      phone.detach();
      reconnected = await mgr.attach({ id, cwd: tmp, cols: 47, rows: 18 });
      assert.equal(size(), '212x49', 'phone reconnect must not shrink the laptop');
      const exited = new Promise<void>((resolve) => desktop.onExit(() => resolve()));
      desktop.detach();
      await exited;
      await waitFor(() => size() === '47x18', 3000, 'phone regains its layout after desktop closes');
    } finally {
      phone.detach();
      desktop.detach();
      reconnected?.detach();
      await mgr.kill(id);
    }
  });

  it('creates the tmux session, streams both ways, shares it between attaches, survives detach, and kills', async () => {
    const t1 = await mgr.attach({ id: 't1', cwd: tmp, cols: 100, rows: 30 });
    assert.equal(t1.id, 't1');
    const out1: Buffer[] = [];
    t1.onData((c) => out1.push(c));
    await waitFor(() => out1.length > 0, 5000, 'the initial tmux redraw');
    assert.equal(hasSession(`${prefix}-t1`), true);
    assert.deepEqual(mgr.list(), [{ id: 't1', cwd: tmp, attached: 1 }]);
    assertPhoneOptions(`${prefix}-t1`);
    for (const [k, v] of TMUX_SESSION_ENV) {
      assert.equal(tmuxOut(['show-environment', '-t', `=${prefix}-t1`, k]), `${k}=${v}`, `session environment ${k}`);
    }
    // the window keeps every row for the shell: no status line
    assert.equal(tmuxOut(['display-message', '-p', '-t', `=${prefix}-t1:`, '#{window_height}']), '30');

    t1.write("printf 'MARK-%s\\n' alpha\r");
    await waitFor(() => text(out1).includes('MARK-alpha'), 5000, 'command output on the first attach');
    assert.ok(!text(out1).includes(`${ESC}[?1049h`), 'the alternate-screen switch is removed from the stream');

    const t2 = await mgr.attach({ id: 't1', cwd: tmp, cols: 100, rows: 30 });
    const out2: Buffer[] = [];
    t2.onData((c) => out2.push(c));
    await waitFor(() => text(out2).includes('MARK-alpha'), 5000, 'the second attach to see the shared screen');
    assert.equal(mgr.list()[0]?.attached, 2);

    t2.write(Buffer.from("printf 'MARK-%s\\n' beta\r", 'utf8'));
    await waitFor(() => text(out1).includes('MARK-beta'), 5000, 'input typed on the second attach to show on the first');

    const scrollback = await t1.scrollback();
    assert.ok(scrollback.includes('MARK-alpha') && scrollback.includes('MARK-beta'), `scrollback: ${JSON.stringify(scrollback)}`);
    assert.ok(scrollback.includes('\r\n'), 'scrollback uses CRLF');
    assert.ok(Buffer.byteLength(scrollback) <= 20 * 1024);
    assert.ok(scrollback.endsWith(`${ESC}[0m`));

    t1.resize(60, 20);
    t1.resize(NaN, -1);

    const exit2 = new Promise<number | null>((res) => t2.onExit(res));
    t2.detach();
    await exit2;
    assert.equal(hasSession(`${prefix}-t1`), true, 'detaching keeps the tmux session');
    await waitFor(() => mgr.list()[0]?.attached === 1, 2000, 'attach count to drop');
    t2.detach();
    t2.write('ignored after detach');
    assert.equal(await new Promise((res) => t2.onExit(res)), await exit2, 'late onExit subscribers get the code');

    const exit1 = new Promise<number | null>((res) => t1.onExit(res));
    assert.equal(await mgr.kill('t1'), true);
    assert.equal(hasSession(`${prefix}-t1`), false);
    await exit1;
    assert.equal(await mgr.kill('t1'), false);
    assert.deepEqual(mgr.list(), []);
  });

  it('adopts sessions that already exist (daemon restart) instead of recreating them', async () => {
    const other = fs.mkdtempSync(path.join(tmp, 'other-'));
    const r = spawnSync('tmux', ['new-session', '-d', '-s', `${prefix}-old`, '-c', other], { env: tmuxEnv, stdio: 'ignore' });
    assert.equal(r.status, 0);
    await mgr.refresh();
    assert.deepEqual(mgr.list(), [{ id: 'old', cwd: other, attached: 0 }]);

    // cwd is only needed for creation; an existing session is attached as-is
    const t = await mgr.attach({ id: 'old', cwd: path.join(tmp, 'does-not-exist'), cols: 80, rows: 24 });
    const out: Buffer[] = [];
    t.onData((c) => out.push(c));
    await waitFor(() => out.length > 0, 5000, 'redraw of the adopted session');
    assert.deepEqual(mgr.list(), [{ id: 'old', cwd: other, attached: 1 }]);
    // a session we did not create still gets the phone-friendly options on attach
    assertPhoneOptions(`${prefix}-old`);
    const exited = new Promise<number | null>((res) => t.onExit(res));
    t.detach();
    await exited;
    assert.equal(await mgr.kill('old'), true);
  });

  it('delivers output that arrived before the first onData subscriber', async () => {
    const t = await mgr.attach({ id: 'buffered', cwd: tmp, cols: 80, rows: 24 });
    await new Promise((r) => setTimeout(r, 400));
    const out: Buffer[] = [];
    t.onData((c) => out.push(c));
    assert.ok(out.length > 0, 'the initial redraw was buffered and replayed');
    const exited = new Promise<number | null>((res) => t.onExit(res));
    t.detach();
    await exited;
    assert.equal(await mgr.kill('buffered'), true);
  });

  it('doctor reports tmux and the pty backend', async () => {
    const d = await mgr.doctor();
    assert.equal(d.ok, true, d.detail);
    assert.match(d.detail, /tmux \d/);
    assert.match(d.detail, /pty: (@lydell\/node-pty|FALLBACK)/);
    assert.match(d.detail, new RegExp(`${prefix}-\\* session`));
  });

  it('shutdown detaches clients but keeps tmux sessions alive', async () => {
    const t = await mgr.attach({ id: 'keep', cwd: tmp, cols: 80, rows: 24 });
    const exited = new Promise<number | null>((res) => t.onExit(res));
    await mgr.shutdown();
    await exited;
    assert.equal(hasSession(`${prefix}-keep`), true, 'the shell outlives the manager');
    await assert.rejects(mgr.attach({ id: 'keep', cwd: tmp, cols: 80, rows: 24 }), /shut down/);
    spawnSync('tmux', ['kill-session', '-t', `=${prefix}-keep`], { env: tmuxEnv, stdio: 'ignore' });
  });
});
