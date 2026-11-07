// Minimal Chrome DevTools Protocol driver: launch a headless Chromium with remote debugging, navigate, evaluate, screenshot.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'));
const WebSocket = require('ws');

export async function launch(chrome, { port = 9333, width = 1480, height = 920, profile = process.env.QA_PROFILE ?? '/tmp/mide-studio-qa/profile' } = {}) {
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(chrome, [`--headless=new`, '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--window-size=${width},${height}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  let targets;
  for (let i = 0; i < 100; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const page = targets?.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target: ' + stderr.slice(-500));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && waiting.has(msg.id)) { const { res, rej } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method) events.push(msg);
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const api = {
    send,
    events,
    async goto(url) { await send('Page.navigate', { url }); },
    async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value; },
    async waitFor(expr, timeoutMs = 15000) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { try { if (await api.eval(expr)) return true; } catch {} await new Promise((r) => setTimeout(r, 120)); } throw new Error('timeout waiting for ' + expr); },
    async shot(file) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; },
    async type(text) { await send('Input.insertText', { text }); },
    async key(key, { code, keyCode, meta = false, ctrl = false, text } = {}) {
      const mods = (meta ? 4 : 0) | (ctrl ? 2 : 0);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers: mods, text });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers: mods });
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    consoleErrors: () => events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text),
    async close() { try { await send('Browser.close'); } catch {} proc.kill('SIGKILL'); },
  };
  return api;
}
