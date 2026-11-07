/** Isolated, token-free browser coverage of the exported mobile app. See README.md. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

process.env.MIDE_LOG ??= 'error';
const { startServer, generatePairingCode } = await import('../../server/src/index.ts');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mide-mobile-qa-'));
const out = process.env.MIDE_QA_OUT || path.join(scratch, 'screenshots');
const home = path.join(scratch, 'daemon');
const alpha = path.join(scratch, 'alpha-workspace');
const beta = path.join(scratch, 'beta-workspace');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(home);
const checks = [];
const errors = [];
let running;
let browser;
let page;
let failure;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}
function project(cwd, name) {
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'src/app.ts'),
    'export function hello(name: string) {\n  return `hello ${name}`;\n}\n\nexport const answer = 42;\n',
  );
  fs.writeFileSync(path.join(cwd, 'README.md'), `# ${name} workspace\n\nA project for local UI checks.\n`);
  fs.writeFileSync(path.join(cwd, '.hidden-note'), `Hidden ${name} note.\n`);
  git(cwd, 'init', '-q');
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=UI QA', '-c', 'user.email=qa@example.test', 'commit', '-qm', `Initialize ${name} workspace`);
}
function check(name, passed) {
  assert.ok(passed, name);
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function until(fn, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return;
    await delay(100);
  }
  throw new Error(`Condition timed out: ${String(fn).slice(0, 170)}`);
}
const button = (name) => page.getByRole('button', { name, exact: true });
const tab = (name) => page.getByRole('tab', { name, exact: true });
const tid = (id) => page.locator(`[data-testid=${JSON.stringify(id)}]:not([aria-hidden="true"] *):visible`);
const shot = async (name) => {
  // Native Animated also runs in the web build; let sheet and route motion settle.
  await delay(350);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};
const closeSheet = () => button('Close').last().click();
async function noOverflow(name) {
  check(name, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
}
async function chooseProject(name) {
  await tid('workspace-project').click();
  await tid(`project-${name}`).click();
  await until(async () => !(await page.getByRole('heading', { name: 'Your projects', exact: true }).isVisible()));
}
function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  const builds = fs
    .readdirSync(cache)
    .filter((name) => name.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse();
  const found = builds.map((name) => path.join(cache, name, 'chrome-headless-shell-linux64/chrome-headless-shell')).find(fs.existsSync);
  if (!found) throw new Error('Set CHROME to an installed Chromium executable.');
  return found;
}

try {
  assert.ok(fs.existsSync(path.join(repo, 'apps/mobile/dist/index.html')), 'Export the web app before running QA.');
  project(alpha, 'Alpha');
  project(beta, 'Beta');
  fs.appendFileSync(path.join(alpha, 'README.md'), '\nSTAGED_ALPHA_NOTE\n');
  git(alpha, 'add', 'README.md');
  fs.appendFileSync(path.join(beta, 'README.md'), '\nSECOND_PROJECT_ONLY\n');
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      host: '127.0.0.1',
      serverName: 'UI review workspace',
      projects: { roots: [alpha, beta] },
      agents: {
        stub: {
          name: 'Stub Agent',
          command: path.join(repo, 'node_modules/.bin/tsx'),
          args: [path.join(repo, 'apps/server/test/fixtures/stub-agent.ts')],
          enabled: true,
        },
      },
      webApp: { dir: path.join(repo, 'apps/mobile/dist') },
      studio: { autoOpen: false },
      terminal: { shell: '/bin/bash', tmuxPrefix: `mide-ui-${path.basename(scratch)}` },
    }),
  );
  running = await startServer({ home, overrides: { port: 0 } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${running.url}/pair?server=${encodeURIComponent(running.url)}`);
  await page.getByPlaceholder('ABCD-1234').waitFor();
  await shot('01-pair-dark');
  await button('Get a pairing code').click();
  await page.getByText('mide pair', { exact: true }).waitFor();
  check('pairing help expands on request', (await button('Get a pairing code').getAttribute('aria-expanded')) === 'true');
  await button('Get a pairing code').click();
  await page.getByPlaceholder('ABCD-1234').fill('NOPE-0000');
  await button('Connect to workspace').click();
  await until(async () => /invalid|expire|rejected/i.test(await page.locator('body').innerText()));
  check('invalid pairing code has an inline retryable error', !(await button('Connect to workspace').isDisabled()));
  const code = generatePairingCode();
  running.ctx.db.createPairingCode(code);
  await page.getByPlaceholder('ABCD-1234').fill(code);
  await button('Connect to workspace').click();
  await tab('Settings').waitFor();
  check('pairing reaches the workspace', await page.getByRole('tablist').isVisible());
  await shot('02-sessions-empty');

  await tab('Settings').click();
  await button('Notifications').click();
  await button('Set up ntfy notifications').click();
  await page.getByRole('textbox', { name: 'Topic', exact: true }).fill('my-unfinished-topic');
  await button('Connection').click();
  await button('Test connection').click();
  await until(async () => /latency|reachable|round.trip|ms\b/i.test(await page.locator('body').innerText()));
  await button('Notifications').click();
  check(
    'settings keeps unfinished notification fields across categories',
    (await page.getByRole('textbox', { name: 'Topic', exact: true }).inputValue()) === 'my-unfinished-topic',
  );
  await button('Appearance').click();
  await shot('03-settings-dark');
  await button('Light theme').click();
  await shot('04-settings-light');
  await page.reload();
  await button('Light theme').waitFor();
  await until(async () => (await button('Light theme').getAttribute('aria-pressed')) === 'true');
  check('theme preference survives reload', (await button('Light theme').getAttribute('aria-pressed')) === 'true');
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot('05-settings-desktop');
  await noOverflow('desktop layout fits the viewport');
  await page.setViewportSize({ width: 320, height: 740 });
  await shot('06-settings-narrow');
  await noOverflow('320px settings fits the viewport');
  await page.setViewportSize({ width: 390, height: 844 });
  await button('Dark theme').click();
  await tab('Sessions').click();
  await button('New session').first().click();
  await page.getByRole('textbox', { name: 'First prompt', exact: true }).fill('ask question slow');
  await shot('07-new-session');
  await button('Start session and send the first prompt').click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  const sessionId = new URL(page.url()).pathname.split('/').at(-1);
  await until(
    () => running.ctx.db.pendingPermissions(sessionId).length === 1 && running.ctx.db.pendingElicitations(sessionId).length === 1,
  );
  check(
    'task creation starts a turn with simultaneous action and question',
    running.ctx.sessions.summary(sessionId).status === 'needs_you',
  );
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this follow-up draft');
  check('a pending turn allows drafting but disables another send', await button('Send when the current turn ends').isDisabled());
  await shot('08-chat-attention');
  await button('Back to sessions').click();
  await button(/^Needs you\s+\d+$/).click();
  await button('Action needs review: Edit src/app.ts').waitFor();
  check(
    'the attention inbox includes approvals and questions',
    await button('A question for you: Which greeting style should I use?').isVisible(),
  );
  await shot('09-attention-inbox');
  await page.getByRole('textbox', { name: 'Search sessions', exact: true }).fill('no-such-session');
  await page.getByText('No matching sessions', { exact: true }).waitFor();
  check('session search filters cards and their attention items', !(await button('Action needs review: Edit src/app.ts').isVisible()));
  await button('Clear search').click();
  await button('Action needs review: Edit src/app.ts').click();
  await page.getByRole('heading', { name: 'Review action', exact: true }).waitFor();
  check('permission submit requires an explicit choice', await button('Select an option').isDisabled());
  await button('Show full input').click();
  check('literal permission input remains inspectable', (await page.locator('body').innerText()).includes('old_string'));
  await page.getByRole('radio', { name: 'Always allow edits', exact: true }).click();
  await button('Send decision').click();
  await button('Always allow').waitFor();
  check(
    'always allow asks for explicit confirmation before sending',
    (await button('Always allow').isVisible()) && running.ctx.db.pendingPermissions(sessionId).length === 1,
  );
  await button('Back').click();
  await page.getByRole('radio', { name: 'Allow', exact: true }).click();
  await shot('10-review-action');
  await button('Send decision').click();
  await until(() => running.ctx.db.pendingPermissions(sessionId).length === 0);
  await until(async () => !(await page.getByRole('heading', { name: 'Review action', exact: true }).isVisible()));
  await button('Back to sessions').click();
  await button('A question for you: Which greeting style should I use?').click();
  await page.getByRole('heading', { name: 'A question for you', exact: true }).waitFor();
  await button('Send answer').click();
  await page.getByText('Required', { exact: true }).waitFor();
  check('question validates a required answer before submission', running.ctx.db.pendingElicitations(sessionId).length === 1);
  await page.getByRole('radio', { name: 'Friendly', exact: true }).click();
  await shot('11-answer-question');
  await button('Send answer').click();
  await until(() => running.ctx.sessions.summary(sessionId).status === 'idle', 40000);
  check(
    'approved turn writes the expected project files',
    fs.readFileSync(path.join(alpha, 'src/app.ts'), 'utf8').includes('greet(name') && fs.existsSync(path.join(alpha, 'src/greet.ts')),
  );
  check(
    'follow-up draft survives inbox and request navigation',
    (await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue()) === 'Keep this follow-up draft',
  );
  await shot('12-chat-complete');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('ask slow');
  await button('Send').click();
  await until(() => running.ctx.sessions.summary(sessionId).status === 'running');
  await button('Stop the current turn').click();
  await until(() => running.ctx.sessions.summary(sessionId).status === 'idle');
  check('stop returns a running turn to ready', running.ctx.db.pendingPermissions(sessionId).length === 0);
  await button('Back to sessions').click();
  await button(/^All\s+\d+$/).click();
  await page
    .getByRole('button', { name: /^Start .* workflow$/ })
    .first()
    .click();
  check(
    'workflow starters create an editable draft without starting work',
    (await page.getByRole('textbox', { name: 'First prompt', exact: true }).inputValue()).length > 0 &&
      running.ctx.sessions.listSummaries({}).length === 1,
  );
  await page.goBack();

  await tab('Files').click();
  await chooseProject('alpha-workspace');
  await tid('fs-entry-src').click();
  await tid('fs-entry-src/app.ts').click();
  await until(async () => (await page.locator('.mide-code').innerText()).includes('greet(name'));
  check('file browser opens the agent edit as code', await button('File options').isVisible());
  fs.appendFileSync(path.join(alpha, 'src/app.ts'), '\n// LIVE_QA_MARKER\n');
  await until(async () => (await page.locator('.mide-code').innerText()).includes('LIVE_QA_MARKER'));
  check('open file updates when the computer writes to disk', await page.getByText('Updated', { exact: true }).isVisible());
  await shot('13-file-live');
  await button('Open in Changes').click();
  await tid('diff-body').waitFor();
  await until(async () => (await page.locator('.mide-diff').innerText()).includes('greet'));
  check('file review shortcut opens its current diff', (await tid('diff-body').innerText()).includes('Unstaged'));
  await shot('14-diff-dark');
  await closeSheet();
  await tid('change-staged-README.md').click();
  await until(async () => (await page.locator('.mide-diff').innerText()).includes('STAGED_ALPHA_NOTE'));
  check('staged changes open the staged patch', (await tid('diff-body').innerText()).includes('Staged'));
  await closeSheet();
  await button('History').click();
  await page.getByRole('button', { name: /Commit .*Initialize Alpha workspace/ }).waitFor();
  check('history shows the selected project commit', await page.getByText('Initialize Alpha workspace', { exact: true }).isVisible());
  await button('Review').click();
  await chooseProject('beta-workspace');
  await tid('change-unstaged-README.md').click();
  await until(async () => (await page.locator('.mide-diff').innerText()).includes('SECOND_PROJECT_ONLY'));
  check('project switching isolates the diff contents', !(await page.locator('.mide-diff').innerText()).includes('STAGED_ALPHA_NOTE'));
  await closeSheet();
  await tab('Files').click();
  check('files follows the shared project selection', (await tid('workspace-project').innerText()).includes('beta-workspace'));
  await button('Search').click();
  await page.getByPlaceholder('Search file contents…').fill('SECOND_PROJECT_ONLY');
  await until(async () => (await page.locator('body').innerText()).includes('SECOND_PROJECT_ONLY'));
  await shot('15-files-search');
  await page.getByText('SECOND_PROJECT_ONLY', { exact: true }).last().click();
  await until(async () => (await page.locator('.mide-code:not([aria-hidden="true"] *)').innerText()).includes('SECOND_PROJECT_ONLY'));
  check(
    'content search opens the matching file and line',
    (await page.locator('.mide-code:not([aria-hidden="true"] *)').innerText()).includes('Beta workspace'),
  );
  await button('Back').click();
  await button('Browse').click();
  check('hidden files start hidden', (await tid('fs-entry-.hidden-note').count()) === 0);
  await button('Show hidden files').click();
  await tid('fs-entry-.hidden-note').waitFor();
  check('hidden file preference reveals dotfiles without exposing git metadata', (await tid('fs-entry-.git').count()) === 0);
  await shot('16-files-browse');

  await tab('Terminal').click();
  await until(async () => (await tid('terminal-status').innerText()).includes('Connected'));
  check(
    'terminal connects in the selected project',
    running.ctx.terminals.list().some((entry) => entry.cwd === beta && entry.attached > 0),
  );
  const input = page.locator('.xterm-helper-textarea');
  await input.focus();
  await page.keyboard.type('printf UI_QA_SHELL_OK');
  await page.keyboard.press('Enter');
  await until(async () => {
    const terminal = running.ctx.terminals.list().find((entry) => entry.cwd === beta);
    return (
      terminal &&
      execFileSync('tmux', ['capture-pane', '-p', '-t', `${running.ctx.config.config.terminal.tmuxPrefix}-${terminal.id}`], {
        encoding: 'utf8',
      }).includes('UI_QA_SHELL_OK')
    );
  });
  check('terminal accepts keyboard input', true);
  await shot('17-terminal');
  await button('Terminal options').click();
  await button('Larger text').click();
  await shot('18-terminal-options');
  await page.getByText('Close shell', { exact: true }).click();
  await page.getByRole('heading', { name: 'Close this shell?', exact: true }).waitFor();
  check('shell closure has a focused confirmation', await button('Cancel').isVisible());
  await button('Cancel').click();
  await closeSheet();

  await tab('Settings').click();
  await button('Light theme').click();
  await tab('Changes').click();
  await tid('change-unstaged-README.md').click();
  await page.locator('.mide-diff').waitFor();
  await shot('19-diff-light');
  await noOverflow('390px diff sheet fits the viewport');
  await closeSheet();
  await page.setViewportSize({ width: 1280, height: 900 });
  await tab('Files').click();
  await shot('20-files-desktop');
  await noOverflow('desktop workspace stays inside the viewport');
  check('no browser page exceptions', errors.length === 0);
} catch (error) {
  failure = String(error.stack || error);
  console.error(failure);
  if (page) {
    await shot('99-failure').catch(() => {});
    fs.writeFileSync(
      path.join(out, 'failure-page.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  }
} finally {
  await browser?.close();
  if (running) {
    await running.ctx.terminals.refresh();
    for (const terminal of running.ctx.terminals.list()) await running.ctx.terminals.kill(terminal.id);
    await running.close({ cancelTurns: true, drainMs: 1500 });
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ checks, errors, failure, scratch }, null, 2));
}
console.log(`${checks.length} checks passed. Artifacts: ${out}`);
process.exitCode = failure || errors.length ? 1 : 0;
