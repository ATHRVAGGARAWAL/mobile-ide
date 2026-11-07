// Full Studio workflow checks against the isolated stub daemon. No real agents or accounts.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const CHROME = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
const QA_HOME = process.env.MIDE_QA_HOME ?? '/tmp/mide-studio-test';
const REPO = process.env.MIDE_QA_REPO ?? '/tmp/mide-studio-repo';
const OUT = process.env.OUT ?? '/tmp/mide-studio-qa/workflows';
const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
fs.mkdirSync(OUT, { recursive: true });
fs.appendFileSync(path.join(REPO, 'src', 'app.ts'), '\n// Studio review QA\n');
const url = execFileSync('node', ['--import', 'tsx', 'src/cli.ts', 'studio', '--no-open'], {
  cwd: SERVER_DIR,
  env: { ...process.env, MIDE_HOME: QA_HOME, MIDE_LOG: 'warn' },
})
  .toString()
  .trim()
  .split('\n')
  .pop();
const results = {};
const check = (name, ok, detail) => {
  results[name] = { ok: !!ok, detail };
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 140)}`);
};
const b = await launch(CHROME, { port: Number(process.env.QA_CDP_PORT ?? 9333) });
const click = (selector) => b.eval(`{const control=document.querySelector(${JSON.stringify(selector)});control.focus();control.click();}`);
const clickText = (selector, text) =>
  b.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`);
const input = async (selector, value) => {
  await b.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await b.key('a', { code: 'KeyA', keyCode: 65, ctrl: true });
  if (value) await b.type(value);
  else await b.key('Backspace', { code: 'Backspace', keyCode: 8 });
};
const shot = (name) => b.shot(`${OUT}/${name}.png`);
const paneCount = () =>
  b.eval(
    `document.querySelectorAll('.feed-wrap').length <= 1 && document.querySelectorAll('.composer').length === 1 && document.querySelectorAll('.session-header').length === 1`,
  );
const activity = () => clickText('.rail .panel-tabs button', 'Activity');
const review = () =>
  b.eval(`[...document.querySelectorAll('.rail .panel-tabs button')].find(e=>e.textContent.startsWith('Review')).click()`);
try {
  // Track real sockets so disconnect/reconnect can be exercised without killing the daemon.
  await b.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__qaSockets=[];const QAWebSocket=window.WebSocket;window.WebSocket=class extends QAWebSocket{constructor(...args){super(...args);window.__qaSockets.push(this);}};`,
  });
  await b.goto(url);
  await b.waitFor(`!!document.querySelector('.workspace')`);
  await click('.new-session-trigger');
  await b.waitFor(
    `document.querySelector('.new-session-dialog select')?.value === 'stub' && !document.querySelector('.new-session-dialog [type=submit]').disabled`,
  );
  check(
    'new session opens with project and agent',
    await b.eval(
      `document.querySelector('.new-session-dialog input').value === ${JSON.stringify(REPO)} && document.querySelector('.new-session-dialog').contains(document.activeElement)`,
    ),
  );
  await b.eval(`document.querySelector('[aria-label="Close new session"]').focus()`);
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  check(
    'dialog traps backward keyboard focus',
    await b.eval(`document.activeElement === document.querySelector('.new-session-dialog [type=submit]')`),
    await b.eval(
      `({focus:document.activeElement.outerHTML, disabled:document.querySelector('.new-session-dialog [type=submit]').disabled})`,
    ),
  );
  await b.eval(`[...document.querySelectorAll('.workflow-option')].find(e=>e.textContent.startsWith('Fix')).click()`);
  check(
    'fix workflow supplies useful starting prompt',
    await b.eval(`document.querySelector('.new-session-dialog textarea').value.includes('investigate')`),
  );
  await input('.new-session-dialog textarea', 'Keep my task while I explore');
  await b.eval(`[...document.querySelectorAll('.workflow-option')].find(e=>e.textContent.startsWith('Review')).click()`);
  check(
    'changing workflow preserves a custom task',
    await b.eval(`document.querySelector('.new-session-dialog textarea').value === 'Keep my task while I explore'`),
  );
  await input('.new-session-dialog textarea', '');
  await input('.new-session-dialog input', '/tmp/studio-not-an-allowed-project');
  await click('.new-session-dialog [type=submit]');
  await b.waitFor(`!!document.querySelector('.new-session-dialog .form-error')`);
  check(
    'creation failure remains inline and retryable',
    await b.eval(
      `!!document.querySelector('.new-session-dialog .form-error') && !document.querySelector('.new-session-dialog [type=submit]').disabled`,
    ),
  );
  await input('.new-session-dialog input', REPO);
  await input('.new-session-dialog textarea', `question ${Date.now()}`);
  await shot('01-new-session');
  await click('.new-session-dialog [type=submit]');
  await b.waitFor(`!document.querySelector('.new-session-dialog') && !!document.querySelector('.fi-elicitation.pending')`, 20000);
  const firstTitle = await b.eval(`document.querySelector('.session-pick-title').textContent`);
  check(
    'new session starts its initial task',
    await b.eval(`!!document.querySelector('.attention-banner') && document.querySelectorAll('.fi-elicitation.pending').length === 1`),
  );
  check('session panels render once after live updates', await paneCount());
  await input('.composer textarea', 'My next step');
  await b.key('Enter', { code: 'Enter', keyCode: 13, text: '\r' });
  await b.sleep(250);
  check(
    'Enter keeps draft while a request is pending',
    await b.eval(
      `document.querySelector('.composer textarea').value === 'My next step' && !!document.querySelector('.fi-elicitation.pending')`,
    ),
  );
  await review();
  await clickText('.fi-elicitation .perm-actions button', 'Send answer');
  check('question validates required answer', await b.eval(`!!document.querySelector('.elic-error')`));
  await clickText('.fi-elicitation .chip', 'Friendly');
  await activity();
  await review();
  check(
    'question draft survives Activity and Review navigation',
    await b.eval(
      `[...document.querySelectorAll('.fi-elicitation .chip')].some(e=>e.textContent==='Friendly' && e.getAttribute('aria-pressed')==='true')`,
    ),
  );
  await shot('02-review-question');
  await clickText('.fi-elicitation .perm-actions button', 'Send answer');
  await b.waitFor(`!document.querySelector('.fi-elicitation.pending')`);
  await activity();
  await b.waitFor(`document.querySelector('.session-header .status-chip')?.textContent.includes('Ready')`);
  check(
    'resolved question shows the recorded answer',
    await b.eval(
      `[...document.querySelectorAll('.fi-elicitation.done .chip')].some(e=>e.textContent==='Friendly' && e.getAttribute('aria-pressed')==='true')`,
    ),
  );
  await input('.composer textarea', 'ask question');
  await b.key('Enter', { code: 'Enter', keyCode: 13, text: '\r' });
  await b.waitFor(`!!document.querySelector('.fi-permission.pending') && !!document.querySelector('.fi-elicitation.pending')`);
  await review();
  check(
    'review groups simultaneous question and approval',
    await b.eval(`document.querySelectorAll('.review-panel .pending').length === 2`),
  );
  await clickText('.fi-permission .perm-actions button', 'Always allow edits');
  check(
    'always allow requires an explicit confirmation',
    await b.eval(`!!document.querySelector('.fi-permission .confirmation') && !!document.querySelector('.fi-permission.pending')`),
  );
  await clickText('.fi-permission .confirmation button', 'Go back');
  await click('.fi-permission .request-details summary');
  check(
    'literal permission input remains available',
    await b.eval(
      `document.querySelector('.fi-permission .request-details').open && document.querySelector('.fi-permission .raw').textContent.includes('old_string')`,
    ),
  );
  await shot('03-review-two-requests');
  await clickText('.fi-permission .perm-actions button', 'Reject');
  await clickText('.fi-elicitation .perm-actions button', 'Skip');
  await activity();
  await b.waitFor(`document.querySelector('.session-header .status-chip')?.textContent.includes('Ready')`);
  await input('.composer textarea', 'Draft for my first session');
  await click('.new-session-trigger');
  await b.waitFor(
    `document.querySelector('.new-session-dialog select')?.value === 'stub' && !document.querySelector('.new-session-dialog [type=submit]').disabled`,
  );
  await click('.new-session-dialog [type=submit]');
  await b.waitFor(
    `!document.querySelector('.new-session-dialog') && document.querySelector('.session-pick-title')?.textContent !== ${JSON.stringify(firstTitle)}`,
  );
  check('new session has its own empty composer', await b.eval(`document.querySelector('.composer textarea').value === ''`));
  await input('.composer textarea', 'Draft for my second session');
  await click('.session-pick');
  await b.eval(
    `[...document.querySelectorAll('.session-menu-title')].find(e=>e.textContent===${JSON.stringify(firstTitle)}).closest('button').click()`,
  );
  check(
    'switching sessions restores the right draft',
    await b.eval(`document.querySelector('.composer textarea').value === 'Draft for my first session'`),
  );
  check('session switching leaves one feed and composer', await paneCount());

  await b.eval(`[...document.querySelectorAll('.explorer .panel-tabs button')].find(e=>e.textContent.startsWith('Changes')).click()`);
  await b.waitFor(`!!document.querySelector('.changed-file')`);
  await b.eval(`[...document.querySelectorAll('.explorer .changed-file')].find(e=>e.textContent.includes('src/app.ts')).click()`);
  await b.waitFor(`!!document.querySelector('.diff-lines')`);
  check(
    'changed file opens readable saved diff',
    await b.eval(
      `document.querySelector('.diff-lines').textContent.includes('Studio review QA') && document.querySelector('.editor-toolbar [aria-pressed=true]').textContent==='Changes'`,
    ),
  );
  await shot('04-file-diff');

  await b.send('Network.enable');
  await b.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await b.eval(`window.__qaSockets.forEach(socket=>socket.close())`);
  await b.waitFor(`!!document.querySelector('.connection-banner')`);
  await input('.composer textarea', 'Offline draft stays here');
  await b.key('Enter', { code: 'Enter', keyCode: 13, text: '\r' });
  check(
    'offline banner preserves draft and disables send',
    await b.eval(
      `!!document.querySelector('.connection-banner') && document.querySelector('.composer .send').disabled && document.querySelector('.composer textarea').value==='Offline draft stays here'`,
    ),
  );
  await b.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await b.waitFor(`!document.querySelector('.connection-banner')`, 20000);
  check(
    'reconnect restores sending without losing draft',
    await b.eval(
      `!document.querySelector('.composer .send').disabled && document.querySelector('.composer textarea').value==='Offline draft stays here'`,
    ),
  );

  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await b.waitFor(`!!document.querySelector('.workspace-nav')`);
  await clickText('.workspace-nav button', 'Files');
  check(
    'narrow layout shows one selected panel',
    await b.eval(
      `document.querySelectorAll('.workspace-pane:not([hidden])').length===1 && !!document.querySelector('.workspace-pane:not([hidden]) .explorer') && document.documentElement.scrollWidth===390`,
    ),
  );
  await b.eval(`[...document.querySelectorAll('.explorer .changed-file')].find(e=>e.textContent.includes('src/app.ts')).click()`);
  check(
    'file selection opens editor on narrow screen',
    await b.eval(`!!document.querySelector('.workspace-pane:not([hidden]) .editor-pane')`),
  );
  await shot('05-narrow-editor');
  await clickText('.workspace-nav button', 'Agent');
  await shot('06-narrow-agent');
  await click('.new-session-trigger');
  await b.waitFor(`!!document.querySelector('.new-session-dialog')`);
  check(
    'new session dialog fits narrow viewport',
    await b.eval(
      `document.querySelector('.new-session-dialog').getBoundingClientRect().right <= 390 && document.querySelector('.new-session-dialog').getBoundingClientRect().left >= 0`,
    ),
  );
  await shot('07-narrow-new-session');
  await b.key('Escape', { code: 'Escape', keyCode: 27 });
  await b.waitFor(`!document.querySelector('.new-session-dialog')`);
  check(
    'Escape restores focus to launch control',
    await b.eval(`!document.querySelector('.new-session-dialog') && document.activeElement.classList.contains('new-session-trigger')`),
  );
  await click('.theme-toggle');
  await shot('08-narrow-light');
  check('no page exceptions', b.consoleErrors().length === 0, b.consoleErrors());
} catch (error) {
  console.error(error);
  results.__failed = String(error);
  await shot('99-failure').catch(() => {});
} finally {
  await b.close();
}
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = Object.values(results).filter((r) => r?.ok === false).length;
console.log(`${Object.keys(results).length} workflow checks, ${failed} failed`);
process.exit(failed || results.__failed ? 1 : 0);
