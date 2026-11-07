import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionSummary } from '@mobile-ide/core';
import { newlyRunningSession } from '../src/lib/session-follow.js';

function session(status: SessionSummary['status'], updatedAt = 20): SessionSummary {
  return {
    id: 'old-session',
    agent: 'codex',
    agentName: 'Codex',
    cwd: '/project',
    projectName: 'project',
    title: 'Task',
    status,
    createdAt: 1,
    updatedAt,
    lastSeq: 3,
    pendingPermissions: 0,
  };
}

test('resuming an old idle or failed task is followed', () => {
  for (const state of ['idle', 'error'] as const) {
    assert.equal(newlyRunningSession([session('running')], [session(state)], 10)?.id, 'old-session');
  }
});

test('streaming, approval resolution and old updates do not steal the workspace', () => {
  for (const state of ['running', 'needs_you'] as const) {
    assert.equal(newlyRunningSession([session('running')], [session(state)], 10), undefined);
  }
  assert.equal(newlyRunningSession([session('running', 9)], [session('idle')], 10), undefined);
  assert.equal(newlyRunningSession([session('running')], [], 10), undefined);
});
