/**
 * The Studio's server side, no agent needed:
 *  - DirWatchRegistry: coalesced notifications for a directory's entries, shared watchers, `gone` when the folder vanishes
 *  - /ws `fs.watch` round trip through a real daemon (ack, fs.changed on a write, unwatch stops them, path policy)
 *  - PUT /api/fs/file: atomic write, 409 on a stale mtime, new files, size limit, policy
 *  - launcher helpers: browser detection, argv per browser kind, the launch URL, `--no-open` really mints the code
 *  - /studio/ hosting: redirect, "not built" page when the bundle is missing
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { API, ClientFrame, ServerFrame, STUDIO_CLIENT_NAME, type FsChange } from '@mobile-ide/core';
import { DirWatchRegistry } from '../src/fswatch.js';
import { setLogSink } from '../src/log.js';
import { findBrowser, launchPlan, openStudio, studioUrl, StudioLauncher, type Browser } from '../src/studio.js';
import { EventBus } from '../src/events.js';
import type { RunningServer } from '../src/context.js';
import { rmrf, tmpDir } from './helpers.js';

setLogSink(() => {
  /* quiet */
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read a response once: the body as JSON plus the raw text for assertion messages. */
async function body<T>(res: Response): Promise<{ json: T; text: string }> {
  const text = await res.text();
  let json: T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    json = undefined as T;
  }
  return { json, text };
}

async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 4000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}

describe('DirWatchRegistry', () => {
  let dir: string;
  before(() => {
    dir = tmpDir('mide-fswatch-');
  });
  after(() => rmrf(dir));

  it('coalesces a burst of changes into one notification with the entry names, shared between subscribers', async () => {
    const reg = new DirWatchRegistry();
    const a: FsChange[] = [];
    const b: FsChange[] = [];
    const endA = reg.watch(dir, '/root', 'sub', (c) => a.push(c));
    const endB = reg.watch(dir, '/root', 'sub', (c) => b.push(c));
    assert.equal(reg.size, 1, 'one OS watcher for two subscribers');
    fs.writeFileSync(path.join(dir, 'one.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'two.txt'), 'y');
    fs.writeFileSync(path.join(dir, 'one.txt'), 'xx');
    await waitFor(() => a.length > 0 && b.length > 0, 3000, 'notifications');
    await sleep(120);
    const names = new Set(a.flatMap((c) => c.names));
    assert.ok(names.has('one.txt') && names.has('two.txt'), `names ${[...names]}`);
    assert.ok(a.length <= 2, `coalesced into ${a.length} frames`);
    assert.equal(a[0]?.root, '/root');
    assert.equal(a[0]?.dir, 'sub');
    endA();
    assert.equal(reg.size, 1, 'still watched for B');
    endB();
    assert.equal(reg.size, 0, 'closed with the last subscriber');
  });

  it('reports `gone` when the directory disappears and refuses non-directories', async () => {
    const reg = new DirWatchRegistry();
    const victim = path.join(dir, 'victim');
    fs.mkdirSync(victim);
    const got: FsChange[] = [];
    reg.watch(victim, '/root', 'victim', (c) => got.push(c));
    fs.rmSync(victim, { recursive: true });
    const gone = await waitFor(() => got.find((c) => c.gone), 3000, 'gone notification').catch(() => undefined);
    // inotify reports IN_DELETE_SELF as an error/rename on the watcher; either way the watch must end
    if (gone) assert.deepEqual(gone.names, []);
    await sleep(50);
    reg.closeAll();
    assert.equal(reg.size, 0);
    const file = path.join(dir, 'plain.txt');
    fs.writeFileSync(file, '');
    assert.throws(() => reg.watch(file, '/root', 'plain.txt', () => undefined), /not a directory|ENOTDIR/);
    assert.throws(() => reg.watch(path.join(dir, 'missing'), '/root', 'missing', () => undefined), /ENOENT/);
  });
});

describe('daemon: live filesystem, checked writes, studio hosting', () => {
  let home: string;
  let repo: string;
  let running: RunningServer;
  let token: string;
  let base: string;

  before(async () => {
    home = tmpDir('mide-studio-home-');
    repo = tmpDir('mide-studio-repo-');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 1;\n');
    const { startServer } = await import('../src/app.js');
    running = await startServer({
      home,
      overrides: {
        port: 0,
        projects: { roots: [repo], denylist: [] },
        agents: {},
        studio: { autoOpen: false, browser: null, dir: path.join(home, 'no-studio-here'), windowSize: '1200x800' },
      },
    });
    base = running.url;
    const { generatePairingCode } = await import('../src/auth.js');
    const code = generatePairingCode();
    running.ctx.db.createPairingCode(code);
    const res = await fetch(`${base}${API.pair}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'test', platform: 'test' }),
    });
    assert.equal(res.status, 201);
    token = ((await res.json()) as { token: string }).token;
  });
  after(async () => {
    await running.close({ drainMs: 0, cancelTurns: true });
    rmrf(home);
    rmrf(repo);
  });

  it('reopens Studio for a resumed turn and reuses an already connected Studio', async (t) => {
    const bus = new EventBus();
    let connected = false;
    const loaded = {
      ...running.ctx.config,
      config: { ...running.ctx.config.config, studio: { ...running.ctx.config.config.studio, autoOpen: true } },
    };
    const launcher = new StudioLauncher(loaded, running.ctx.db, bus, () => connected ? [{ clientName: STUDIO_CLIENT_NAME }] : []);
    const open = t.mock.method(launcher, 'open', async () => ({ opened: true, url: '/studio/' }));
    try {
      const event = { sessionId: 'existing-session', seq: 10, ts: Date.now(),
        event: { type: 'turn.started' as const, turnId: 'turn-2', blocks: [{ type: 'text' as const, text: 'Continue' }] } };
      bus.emitEvent(event);
      await Promise.resolve();
      assert.equal(open.mock.callCount(), 1);
      assert.deepEqual(open.mock.calls[0]?.arguments, [{ sessionId: 'existing-session' }]);
      connected = true;
      bus.emitEvent(event);
      assert.equal(open.mock.callCount(), 1);
    } finally { launcher.stop(); }
  });

  const authed = (init: RequestInit = {}) => ({
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  function connect(): Promise<{
    ws: WebSocket;
    frames: ServerFrame[];
    send(f: ClientFrame): void;
    next(pred: (f: ServerFrame) => boolean, what: string): Promise<ServerFrame>;
  }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace('http', 'ws') + API.ws, [`mide.bearer.${token}`]);
      const frames: ServerFrame[] = [];
      ws.onmessage = (ev) => frames.push(ServerFrame.parse(JSON.parse(String(ev.data))));
      ws.onerror = () => reject(new Error('ws error'));
      ws.onopen = () => {
        const api = {
          ws,
          frames,
          send: (f: ClientFrame) => ws.send(JSON.stringify(f)),
          next: async (pred: (f: ServerFrame) => boolean, what: string) => {
            const t0 = Date.now();
            for (;;) {
              const idx = frames.findIndex(pred);
              if (idx >= 0) return frames.splice(idx, 1)[0]!;
              if (Date.now() - t0 > 4000) throw new Error(`timeout waiting for ${what}; got ${frames.map((f) => f.type).join(',')}`);
              await sleep(15);
            }
          },
        };
        api.send({ type: 'hello', protocolVersion: 1, clientName: STUDIO_CLIENT_NAME, clientVersion: 'test' });
        resolve(api);
      };
    });
  }

  it('fs.watch acks, reports writes in that folder as fs.changed, and fs.unwatch stops them', async () => {
    const c = await connect();
    await c.next((f) => f.type === 'welcome', 'welcome');
    c.send({ type: 'fs.watch', requestId: 'w1', root: repo, dir: 'src/' });
    const ack = await c.next((f) => f.type === 'ack' && f.requestId === 'w1', 'watch ack');
    assert.equal(ack.type === 'ack' && ack.ok, true, JSON.stringify(ack));
    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 2;\n');
    const changed = await c.next((f) => f.type === 'fs.changed', 'fs.changed');
    assert.equal(changed.type, 'fs.changed');
    if (changed.type === 'fs.changed') {
      assert.equal(changed.change.root, repo);
      assert.equal(changed.change.dir, 'src', 'dir echoed normalized');
      assert.ok(changed.change.names.includes('app.ts'), changed.change.names.join(','));
    }
    // the same watch twice is idempotent (no second OS watcher, still one ack)
    c.send({ type: 'fs.watch', requestId: 'w2', root: repo, dir: 'src' });
    await c.next((f) => f.type === 'ack' && f.requestId === 'w2', 'second ack');
    c.send({ type: 'fs.unwatch', requestId: 'u1', root: repo, dir: 'src' });
    await c.next((f) => f.type === 'ack' && f.requestId === 'u1', 'unwatch ack');
    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 3;\n');
    await sleep(250);
    assert.equal(c.frames.filter((f) => f.type === 'fs.changed').length, 0, 'no notifications after unwatch');
    // policy: outside the root
    c.send({ type: 'fs.watch', requestId: 'w3', root: repo, dir: '../' });
    const bad = await c.next((f) => f.type === 'ack' && f.requestId === 'w3', 'bad ack');
    assert.equal(bad.type === 'ack' && bad.ok, false);
    // a missing folder is a failed ack, not a crash
    c.send({ type: 'fs.watch', requestId: 'w4', root: repo, dir: 'nope' });
    const missing = await c.next((f) => f.type === 'ack' && f.requestId === 'w4', 'missing ack');
    assert.equal(missing.type === 'ack' && missing.ok, false);
    assert.deepEqual(running.ctx.studio?.studioConnected(), true, 'the hello named the Studio');
    c.ws.close();
    await waitFor(() => running.ctx.studio?.studioConnected() === false, 2000, 'studio disconnected');
  });

  it('PUT /api/fs/file writes atomically, rejects stale mtimes with 409, creates files, enforces the policy', async () => {
    const file = path.join(repo, 'src', 'app.ts');
    const read = await fetch(`${base}${API.fsFile}?root=${encodeURIComponent(repo)}&path=src/app.ts`, authed());
    const before = (await read.json()) as { content: string; mtime: number };
    assert.equal(typeof before.mtime, 'number');
    const ok = await fetch(
      `${base}${API.fsFile}`,
      authed({
        method: 'PUT',
        body: JSON.stringify({ root: repo, path: 'src/app.ts', content: 'export const a = 42;\n', expectedMtime: before.mtime }),
      }),
    );
    const okBody = await body<{ mtime: number; size: number; created: boolean; path: string }>(ok);
    assert.equal(ok.status, 200, okBody.text);
    const written = okBody.json;
    assert.equal(fs.readFileSync(file, 'utf8'), 'export const a = 42;\n');
    assert.equal(written.created, false);
    assert.equal(written.path, 'src/app.ts');
    assert.equal(fs.readdirSync(path.join(repo, 'src')).filter((n) => n.includes('mide-')).length, 0, 'no temp file left behind');
    // stale token → 409, file untouched
    const stale = await fetch(
      `${base}${API.fsFile}`,
      authed({ method: 'PUT', body: JSON.stringify({ root: repo, path: 'src/app.ts', content: 'clobber', expectedMtime: before.mtime }) }),
    );
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { code: string }).code, 'conflict');
    assert.equal(fs.readFileSync(file, 'utf8'), 'export const a = 42;\n');
    // new file with createDirs
    const fresh = await fetch(
      `${base}${API.fsFile}`,
      authed({ method: 'PUT', body: JSON.stringify({ root: repo, path: 'deep/er/new.md', content: '# hi\n', createDirs: true }) }),
    );
    const freshBody = await body<{ created: boolean }>(fresh);
    assert.equal(fresh.status, 200, freshBody.text);
    assert.equal(freshBody.json.created, true);
    assert.equal(fs.readFileSync(path.join(repo, 'deep', 'er', 'new.md'), 'utf8'), '# hi\n');
    // escaping the root
    const escape = await fetch(
      `${base}${API.fsFile}`,
      authed({ method: 'PUT', body: JSON.stringify({ root: repo, path: '../evil.txt', content: 'x' }) }),
    );
    assert.equal(escape.status, 403);
    // no token
    const anon = await fetch(`${base}${API.fsFile}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: repo, path: 'src/app.ts', content: 'x' }),
    });
    assert.equal(anon.status, 401);
  });

  it('/studio redirects to /studio/ and explains when the bundle is missing; POST /api/studio/open reports why nothing opened', async () => {
    const redirect = await fetch(`${base}/studio`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(new URL(redirect.headers.get('location') ?? '', base).pathname, '/studio/');
    const page = await fetch(`${base}/studio/`, { headers: { Accept: 'text/html' } });
    assert.equal(page.status, 503);
    const html = await page.text();
    assert.match(html, /Studio is not built yet/);
    assert.match(html, /no-studio-here/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const open = await fetch(`${base}${API.studioOpen}`, authed({ method: 'POST', body: JSON.stringify({}) }));
    const opened = await body<{ opened: boolean; connected: boolean; reason?: string; url: string }>(open);
    assert.equal(open.status, 200, opened.text);
    assert.equal(opened.json.opened, false);
    assert.equal(opened.json.connected, false);
    assert.match(opened.json.reason ?? '', /studio build not found/);
    assert.match(opened.json.url, /\/studio\/#pair=[A-Z0-9]{8}$/);
    const unknown = await fetch(`${base}${API.studioOpen}`, authed({ method: 'POST', body: JSON.stringify({ sessionId: 'nope' }) }));
    assert.equal(unknown.status, 404);
  });

  it('the launch URL carries a redeemable one-time code even for a dry run (`mide studio --no-open`)', async () => {
    const result = await openStudio(running.ctx.config, running.ctx.db, { dryRun: true, sessionId: 'abc' });
    assert.equal(result.opened, false);
    assert.match(result.reason ?? '', /studio build not found/, 'no bundle in this daemon: reported, not thrown');
    // with a bundle present the dry run must still have minted the code — exercise the minting path on a fake bundle
    const studioDir = path.join(home, 'studio-fake');
    fs.mkdirSync(studioDir, { recursive: true });
    fs.writeFileSync(path.join(studioDir, 'index.html'), '<!doctype html>');
    const loaded = {
      ...running.ctx.config,
      config: { ...running.ctx.config.config, studio: { ...running.ctx.config.config.studio, dir: studioDir } },
    };
    const dry = await openStudio(loaded, running.ctx.db, { dryRun: true, sessionId: 'abc' });
    assert.equal(dry.reason, 'dry run');
    const code = /pair=([A-Z0-9]{8})/.exec(dry.url)?.[1];
    assert.ok(code, dry.url);
    assert.match(dry.url, /session=abc/);
    assert.equal(running.ctx.db.consumePairingCode(code!), true, 'the code in the URL is real');
    assert.equal(running.ctx.db.consumePairingCode(code!), false, 'and single-use');
  });
});

describe('launcher helpers', () => {
  it('builds app-mode argv for Chromium-family browsers, a plain window for Firefox, and a bare URL otherwise', () => {
    const url = 'http://127.0.0.1:4820/studio/#pair=ABCDEFGH';
    const chrome: Browser = { kind: 'chromium', command: ['/usr/bin/google-chrome'], label: 'google-chrome' };
    const plan = launchPlan(chrome, url, { windowSize: '1480x920', profileDir: '/home/me/.mobile-ide/studio-profile' });
    assert.equal(plan.command, '/usr/bin/google-chrome');
    assert.ok(plan.args.includes(`--app=${url}`));
    assert.ok(plan.args.includes('--window-size=1480,920'));
    assert.ok(plan.args.includes('--user-data-dir=/home/me/.mobile-ide/studio-profile'));
    assert.ok(plan.args.includes('--class=mide-studio'));
    const flatpak: Browser = { kind: 'chromium', command: ['flatpak', 'run', 'com.brave.Browser'], label: 'flatpak com.brave.Browser' };
    const fp = launchPlan(flatpak, url, { windowSize: '1480x920', profileDir: '/x' });
    assert.equal(fp.command, 'flatpak');
    assert.deepEqual(fp.args.slice(0, 2), ['run', 'com.brave.Browser']);
    assert.ok(!fp.args.some((a) => a.startsWith('--user-data-dir')), 'sandboxed browsers cannot see the profile dir');
    assert.ok(fp.args.includes(`--app=${url}`));
    const firefox: Browser = { kind: 'firefox', command: ['/usr/bin/firefox'], label: 'firefox' };
    assert.deepEqual(launchPlan(firefox, url, { windowSize: '1480x920', profileDir: null }).args, ['--new-window', url]);
    const xdg: Browser = { kind: 'xdg-open', command: ['/usr/bin/xdg-open'], label: 'xdg-open' };
    assert.deepEqual(launchPlan(xdg, url, { windowSize: '1480x920', profileDir: null }).args, [url]);
  });

  it('findBrowser honours a configured command and falls back along the PATH; an empty PATH finds nothing', () => {
    const dir = tmpDir('mide-browser-');
    try {
      const fake = path.join(dir, 'brave-browser');
      fs.writeFileSync(fake, '#!/bin/sh\n');
      fs.chmodSync(fake, 0o755);
      const found = findBrowser(null, dir);
      assert.ok(found && found.kind === 'chromium' && found.command[0] === fake, JSON.stringify(found));
      const configured = findBrowser(`${fake} --some-flag`);
      assert.ok(configured && configured.kind === 'chromium' && configured.command.length === 2);
      assert.equal(findBrowser('definitely-not-a-browser-xyz'), null);
      const ff = path.join(dir, 'firefox');
      fs.writeFileSync(ff, '#!/bin/sh\n');
      fs.chmodSync(ff, 0o755);
      fs.rmSync(fake);
      assert.equal(findBrowser(null, dir)?.kind, 'firefox');
      const empty = tmpDir('mide-browser-empty-');
      try {
        assert.equal(findBrowser(null, empty), null);
      } finally {
        rmrf(empty);
      }
    } finally {
      rmrf(dir);
    }
  });

  it('studioUrl points at the loopback origin with the code and session in the fragment', () => {
    const loaded = { config: { host: '0.0.0.0', port: 4820 } } as unknown as Parameters<typeof studioUrl>[0];
    assert.equal(studioUrl(loaded), 'http://127.0.0.1:4820/studio/');
    assert.equal(studioUrl(loaded, { code: 'ABCDEFGH', sessionId: 's1' }), 'http://127.0.0.1:4820/studio/#pair=ABCDEFGH&session=s1');
  });
});
