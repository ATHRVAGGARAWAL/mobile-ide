/**
 * Pure helpers for the Sessions home: bucket summaries into the four display groups
 * and flatten them into FlashList rows (header + session rows) so one virtualized list
 * renders everything without nested lists.
 */
import type { SessionStatus, SessionSummary } from '@mobile-ide/core';

export type SessionGroupKey = 'running' | 'needs_you' | 'idle' | 'error';

export interface SessionGroup {
  key: SessionGroupKey;
  title: string;
  sessions: SessionSummary[];
}

/**
 * Display order. Pending permissions get their own "Needs you" inbox above the list, so the status group for
 * those sessions is titled differently to avoid two identical headers back to back.
 */
export const GROUP_ORDER: readonly SessionGroupKey[] = ['running', 'needs_you', 'idle', 'error'];

export const GROUP_TITLE: Record<SessionGroupKey, string> = {
  running: 'In progress',
  needs_you: 'Waiting for you',
  idle: 'Ready to continue',
  error: 'Needs a look',
};

export function groupKeyFor(status: SessionStatus): SessionGroupKey {
  switch (status) {
    case 'running':
    case 'starting':
      return 'running';
    case 'needs_you':
      return 'needs_you';
    case 'error':
      return 'error';
    case 'idle':
    case 'closed':
    default:
      return 'idle';
  }
}

/** Buckets and sorts (newest activity first) — empty groups are omitted. */
export function groupSessions(sessions: readonly SessionSummary[]): SessionGroup[] {
  const buckets = new Map<SessionGroupKey, SessionSummary[]>();
  for (const s of sessions) {
    const k = groupKeyFor(s.status);
    const arr = buckets.get(k);
    if (arr) arr.push(s);
    else buckets.set(k, [s]);
  }
  const out: SessionGroup[] = [];
  for (const key of GROUP_ORDER) {
    const list = buckets.get(key);
    if (!list?.length) continue;
    list.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
    out.push({ key, title: GROUP_TITLE[key], sessions: list });
  }
  return out;
}

export type SessionListRow =
  | { type: 'header'; key: string; group: SessionGroupKey; title: string; count: number }
  | { type: 'session'; key: string; session: SessionSummary; first: boolean; last: boolean };

/** Flattens groups into a single list of rows with first/last markers for inset-grouped styling. */
export function flattenGroups(groups: readonly SessionGroup[]): SessionListRow[] {
  const rows: SessionListRow[] = [];
  for (const g of groups) {
    rows.push({ type: 'header', key: `h:${g.key}`, group: g.key, title: g.title, count: g.sessions.length });
    g.sessions.forEach((s, i) => {
      rows.push({ type: 'session', key: s.id, session: s, first: i === 0, last: i === g.sessions.length - 1 });
    });
  }
  return rows;
}

/** Whitespace-collapsed single-line preview for a list row. */
export function cleanPreview(preview: string | undefined): string {
  if (!preview) return '';
  return preview.replace(/\s+/g, ' ').trim();
}

/** Number of sessions that currently want the user's attention (used for badges/subtitles). */
export function countNeedsYou(sessions: readonly SessionSummary[]): number {
  return sessions.reduce((n, s) => n + (s.status === 'needs_you' || s.pendingPermissions > 0 ? 1 : 0), 0);
}

export type SessionFilter = 'all' | 'running' | 'needs_you' | 'idle';

/** Search stays local so recent work remains discoverable through a connection drop. */
export function filterSessions(sessions: readonly SessionSummary[], query: string, filter: SessionFilter): SessionSummary[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    if (filter === 'running' && session.status !== 'running' && session.status !== 'starting') return false;
    if (filter === 'needs_you' && session.status !== 'needs_you' && session.pendingPermissions === 0) return false;
    if (filter === 'idle' && session.status !== 'idle' && session.status !== 'error') return false;
    const haystack = [session.title, session.projectName, session.cwd, session.agentName, session.lastMessagePreview ?? '']
      .join(' ')
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
