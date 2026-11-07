import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { TerminalMirror, terminalLaunchPlan } from '../src/terminal-mirror.js';
import { rmrf, tmpDir } from './helpers.js';

function fixture() {
  const launches: string[] = [];
  let flags = '';
  const mirror = new TerminalMirror('mide', {
    desktop: async () => ({ DISPLAY: ':0' }),
    prepare: async () => {},
    clients: async () => flags,
    launch: async (session) => {
      launches.push(session);
    },
  });
  return {
    mirror,
    launches,
    clients: (value: string) => {
      flags = value;
    },
  };
}

test('terminal mirror coalesces simultaneous attachments and phone reconnects', async () => {
  const { mirror, launches } = fixture();
  await Promise.all([mirror.open('project-1', '/project'), mirror.open('project-1', '/project')]);
  await mirror.open('project-1', '/project');
  assert.deepEqual(launches, ['mide-project-1']);
  await mirror.open('project-2', '/project');
  assert.deepEqual(launches, ['mide-project-1', 'mide-project-2']);
});

test('existing desktop attachment suppresses a duplicate after daemon restart', async () => {
  const { mirror, launches, clients } = fixture();
  clients('attached,focused,active-pane\nattached');
  await mirror.open('project', '/project');
  assert.equal(launches.length, 0);
  clients('attached');
  await mirror.open('project', '/project');
  assert.deepEqual(launches, ['mide-project']);
});

test('closed laptop window can reopen after the startup cooldown', async (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const { mirror, launches } = fixture();
  await mirror.open('project', '/project');
  now += 20_001;
  await mirror.open('project', '/project');
  assert.equal(launches.length, 2);
});

test('missing display and invalid ids never launch a terminal', async () => {
  let launched = false;
  const mirror = new TerminalMirror('mide', {
    desktop: async () => null,
    prepare: async () => {},
    clients: async () => '',
    launch: async () => {
      launched = true;
    },
  });
  await mirror.open('valid', '/project');
  await mirror.open('bad;command', '/project');
  assert.equal(launched, false);
});

test('launch failures leave the phone working and can be retried', async () => {
  let attempts = 0;
  const mirror = new TerminalMirror('mide', {
    desktop: async () => ({ DISPLAY: ':0' }),
    prepare: async () => {},
    clients: async () => '',
    launch: async () => {
      if (++attempts === 1) throw new Error('test failure');
    },
  });
  await mirror.open('project', '/project');
  await mirror.open('project', '/project');
  assert.equal(attempts, 2);
});

test('desktop terminal attaches the exact existing shell, with paths passed as literal arguments', () => {
  const dir = tmpDir('mide-terminal-plan-');
  try {
    fs.writeFileSync(path.join(dir, 'ptyxis'), '#!/bin/sh\n', { mode: 0o755 });
    const plan = terminalLaunchPlan('mide-project', '/home/me/project $(echo nope)', dir);
    assert.ok(plan);
    assert.deepEqual(plan.args, [
      '--new-window',
      '--title',
      'Mobile IDE · project $(echo nope)',
      '--',
      'tmux',
      '-u',
      'attach-session',
      '-f',
      'active-pane',
      '-t',
      '=mide-project',
    ]);
    assert.equal(terminalLaunchPlan('mide-project', '/project', ''), null);
  } finally {
    rmrf(dir);
  }
});
