// Scripted end-to-end QA of the Studio in a headless Chromium against a scratch daemon running the stub agent (see daemon.sh).
// Env: CHROME (a Chromium binary), MIDE_QA_HOME (scratch MIDE_HOME, default /tmp/mide-studio-test), MIDE_QA_REPO (the scratch
// repo, default /tmp/mide-studio-repo), MIDE_QA_PORT (default 4899), OUT (screenshot dir). Exit 1 when any check fails.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const CHROME = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
const HOME = process.env.MIDE_QA_HOME ?? '/tmp/mide-studio-test';
const BASE = `http://127.0.0.1:${process.env.MIDE_QA_PORT ?? '4899'}`;
const REPO = process.env.MIDE_QA_REPO ?? '/tmp/mide-studio-repo';
const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const OUT = process.env.OUT ?? '/tmp/mide-studio-qa/shots';
fs.mkdirSync(OUT, { recursive: true });
const run = (args) =>
  execFileSync('node', ['--import', 'tsx', ...args], { cwd: SERVER_DIR, env: { ...process.env, MIDE_HOME: HOME, MIDE_LOG: 'warn' } })
    .toString()
    .trim();
const results = {};
const check = (name, ok, detail) => {
  results[name] = { ok: !!ok, detail };
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' · ' + JSON.stringify(detail).slice(0, 160) : ''}`);
};

// fresh repo state
fs.writeFileSync(
  `${REPO}/src/app.ts`,
  'export function hello(name: string) {\n  return `hello ${name}`;\n}\n\nexport const answer = 42;\n',
);
fs.rmSync(`${REPO}/src/greet.ts`, { force: true });

const studioUrl = run(['src/cli.ts', 'studio', '--no-open']).split('\n').pop();
console.log('studio url', studioUrl.replace(/pair=[A-Z0-9]+/, 'pair=…'));
const code = run([
  '--input-type=module',
  '-e',
  "import { loadConfig, Db, generatePairingCode } from './src/index.ts'; const db = new Db(loadConfig().dbPath); const c = generatePairingCode(); db.createPairingCode(c); console.log(c); db.close();",
]);
const pair = await (
  await fetch(BASE + '/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'QA phone', platform: 'qa' }),
  })
).json();
const token = pair.token;
const api = (m, p, body) =>
  fetch(BASE + p, {
    method: m,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const b = await launch(CHROME, { port: Number(process.env.QA_CDP_PORT ?? 9333) });
const shot = async (name) => {
  const f = `${OUT}/${name}.png`;
  await b.shot(f);
  console.log('shot', f);
};
try {
  await b.goto(studioUrl);
  await b.waitFor(`!!document.querySelector('.workspace')`, 20000);
  await b.sleep(700);
  check(
    'paired and rendered',
    await b.eval(`document.querySelector('.machine-label .conn-open') !== null`),
    await b.eval(`document.querySelector('.titlebar')?.innerText`),
  );
  await shot('01-empty');

  const created = await api('POST', '/api/sessions', { agent: 'stub', cwd: REPO, title: 'Greeting helper' });
  check('session created', created.status === 201 || created.status === 200, created.body?.id);
  await b.waitFor(`document.querySelector('.session-pick-title')?.textContent.includes('Greeting')`, 15000);
  await b.sleep(600);
  check(
    'explorer shows repo',
    await b.eval(`[...document.querySelectorAll('.tree-name')].map(e=>e.textContent).includes('README.md')`),
    await b.eval(`[...document.querySelectorAll('.tree-name')].map(e=>e.textContent)`),
  );
  await shot('02-session');

  await b.eval(`document.querySelector('.composer textarea').focus()`);
  await b.type('Please ask before editing, then add a greeting helper');
  await b.sleep(150);
  await shot('03-composer');
  await b.key('Enter', { code: 'Enter', keyCode: 13, text: '\r' });
  await b.waitFor(`!!document.querySelector('.fi-permission.pending')`, 20000);
  await b.sleep(500);
  check(
    'file opened by agent',
    (await b.eval(`document.querySelector('.tab.active .tab-name')?.textContent`)) === 'app.ts',
    await b.eval(`[...document.querySelectorAll('.tab')].map(t=>t.textContent)`),
  );
  check(
    'ghost preview before approval',
    (await b.eval(`document.querySelectorAll('.cm-ghost').length`)) === 1,
    await b.eval(`document.querySelector('.cm-ghost-head')?.innerText`),
  );
  check('struck old text', (await b.eval(`document.querySelectorAll('.cm-ghost-old').length`)) > 0);
  check('tool card waiting', await b.eval(`!!document.querySelector('.fi-tool.tool-waiting')`));
  check('composer cleared', (await b.eval(`document.querySelector('.composer textarea').value`)) === '');
  await shot('04-approval');

  check('attention queue offers pending approval', await b.eval(`!!document.querySelector('.attention-banner')`));
  await b.eval(`document.querySelector('.attention-banner').click()`);
  check('review keeps approval actionable', await b.eval(`!!document.querySelector('.review-panel .fi-permission.pending')`));
  await shot('04-review');
  await b.eval(`document.querySelector('.fi-permission.pending .perm-actions .btn-primary').click()`);
  await b.eval(`[...document.querySelectorAll('.rail .panel-tabs button')].find(e=>e.textContent.includes('Activity')).click()`);
  await b.sleep(450);
  await shot('05-incoming');
  await b.waitFor(`document.querySelectorAll('.cm-live-added').length > 0`, 10000);
  await b.sleep(120);
  check(
    'live wash on new lines',
    (await b.eval(`document.querySelectorAll('.cm-live-added').length`)) >= 3,
    await b.eval(`document.querySelectorAll('.cm-live-added').length`),
  );
  check('ghost gone after write', (await b.eval(`document.querySelectorAll('.cm-ghost').length`)) === 0);
  check(
    'editor has new content',
    await b.eval(`document.querySelector('.cm-content').innerText.includes('greet(name, { excited: true })')`),
  );
  check(
    'statusline reports agent write',
    await b.eval(`document.querySelector('.statusline')?.innerText`).then((t) => /agent wrote|Stub Agent/i.test(t ?? '')),
    await b.eval(`document.querySelector('.statusline')?.innerText`),
  );
  await shot('06-live-wash');

  await b.waitFor(`[...document.querySelectorAll('.tab .tab-name')].some(t=>t.textContent==='greet.ts')`, 10000);
  await b.sleep(1300);
  check(
    'new file tab opened + content',
    await b.eval(
      `document.querySelector('.tab.active .tab-name')?.textContent === 'greet.ts' && document.querySelector('.cm-content').innerText.includes('GreetOptions')`,
    ),
    await b.eval(`document.querySelector('.tab.active .tab-name')?.textContent`),
  );
  await shot('07-newfile');

  await b.waitFor(`!!document.querySelector('.fi-turnend')`, 20000);
  await b.sleep(500);
  check(
    'feed shows command + output',
    await b.eval(`document.querySelector('.fi-tool.kind-execute .tool-title')?.innerText.includes('pnpm test')`),
  );
  check(
    'explorer marks fresh files',
    (await b.eval(`document.querySelectorAll('.tree-row.fresh').length`)) >= 1,
    await b.eval(`[...document.querySelectorAll('.tree-row.fresh .tree-name')].map(e=>e.textContent)`),
  );
  check('git badges on changed files', (await b.eval(`document.querySelectorAll('.git-badge').length`)) >= 1);
  await shot('08-done');

  await b.key('k', { code: 'KeyK', keyCode: 75, ctrl: true });
  await b.waitFor(`!!document.querySelector('.palette')`, 3000);
  await b.type('greet');
  await b.sleep(600);
  check(
    'palette finds file',
    await b.eval(`[...document.querySelectorAll('.palette-item .palette-sub')].some(e=>e.textContent==='src/greet.ts')`),
    await b.eval(`[...document.querySelectorAll('.palette-item .palette-title')].map(e=>e.textContent).slice(0,5)`),
  );
  await shot('09-palette');
  await b.key('Escape', { code: 'Escape', keyCode: 27 });
  await b.sleep(200);

  // edit in the Studio and save with Ctrl-S
  await b.eval(
    `[...document.querySelectorAll('.tab')].find(t=>t.textContent.includes('app.ts')).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`,
  );
  await b.sleep(250);
  await b.eval(`document.querySelector('.cm-content').focus()`);
  await b.type('// edited from the studio\n');
  await b.sleep(250);
  check('local edit marks tab dirty', await b.eval(`!!document.querySelector('.tab.active .tab-dirty')`));
  await shot('10-dirty');
  await b.key('s', { code: 'KeyS', keyCode: 83, ctrl: true });
  await b.waitFor(`!document.querySelector('.tab.active .tab-dirty')`, 6000);
  await b.sleep(200);
  check('ctrl-s saved to disk', fs.readFileSync(`${REPO}/src/app.ts`, 'utf8').startsWith('// edited from the studio'));

  // an external edit lands live in a clean buffer
  await b.eval(
    `[...document.querySelectorAll('.tab')].find(t=>t.textContent.includes('greet.ts')).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`,
  );
  await b.sleep(250);
  fs.appendFileSync(`${REPO}/src/greet.ts`, '\nexport const VERSION = 2;\n');
  await b.waitFor(`document.querySelector('.cm-content').innerText.includes('VERSION = 2')`, 6000);
  check('external disk change applied live', true);
  await b.sleep(150);
  await shot('11-external');

  // conflict: dirty buffer + disk change → banner
  await b.eval(`document.querySelector('.cm-content').focus()`);
  await b.type('// local\n');
  await b.sleep(200);
  fs.appendFileSync(`${REPO}/src/greet.ts`, 'export const CONFLICT = true;\n');
  await b.waitFor(`!!document.querySelector('.banner-warn')`, 6000);
  check('conflict banner', await b.eval(`document.querySelector('.banner-warn')?.innerText`).then((t) => /changed on disk/.test(t ?? '')));
  await shot('12-conflict');
  await b.eval(`document.querySelector('.banner-warn .btn-primary').click()`);
  await b.sleep(300);
  check(
    'take disk version resolves',
    await b.eval(`!document.querySelector('.banner-warn') && document.querySelector('.cm-content').innerText.includes('CONFLICT')`),
  );

  // light theme
  await b.eval(`document.querySelector('.theme-toggle').click()`);
  await b.sleep(350);
  check('light theme', (await b.eval(`document.documentElement.dataset.theme`)) === 'light');
  await shot('13-light');
  await b.eval(`document.querySelector('.theme-toggle').click()`);

  const errors = b.consoleErrors();
  check('no page exceptions', errors.length === 0, errors.slice(0, 3));
} catch (err) {
  console.error('DRIVE FAILED', err);
  await shot('99-failure').catch(() => {});
  results.__failed = String(err);
} finally {
  await b.close();
}
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const fails = Object.values(results).filter((r) => r && r.ok === false).length;
console.log(`\n${Object.keys(results).length} checks, ${fails} failed`);
process.exit(fails || results.__failed ? 1 : 0);
