import type { SessionSummary } from '@mobile-ide/core';

/** Follow a newly started turn, but don't jump around as existing turns stream or approvals resolve. */
export function newlyRunningSession(current: SessionSummary[], previous: SessionSummary[], after: number): SessionSummary | undefined {
  const states = new Map(previous.map((s) => [s.id, s.status]));
  return current
    .filter((s) => s.status === 'running' && s.updatedAt > after && (states.get(s.id) === 'idle' || states.get(s.id) === 'error'))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
