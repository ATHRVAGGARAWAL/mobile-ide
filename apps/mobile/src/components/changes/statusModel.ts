/**
 * Pure helpers that turn `GitStatus` porcelain codes into the rows the Changes screen renders.
 * `index` / `worktree` are the two porcelain v1 columns; untracked files are `??`, ignored `!!`.
 */
import type { GitStatus } from '@mobile-ide/core';
import type { Theme } from '../../theme';

/** Core exports the zod schema only; derive the row type from `GitStatus`. */
export type GitStatusEntry = GitStatus['entries'][number];

export type ChangeArea = 'staged' | 'unstaged' | 'conflict';
export type ChangeTone = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflict' | 'other';

export interface ChangeItem {
  key: string;
  entry: GitStatusEntry;
  area: ChangeArea;
  /** single porcelain letter shown in the badge */
  code: string;
  label: string;
  tone: ChangeTone;
}

export interface SplitStatus {
  staged: ChangeItem[];
  unstaged: ChangeItem[];
  conflicts: ChangeItem[];
  total: number;
}

const CLEAN = new Set([' ', '', '.']);

export function isUntracked(e: GitStatusEntry): boolean {
  return e.index === '?' || e.worktree === '?';
}

export function isIgnored(e: GitStatusEntry): boolean {
  return e.index === '!' || e.worktree === '!';
}

export function isConflict(e: GitStatusEntry): boolean {
  const both = e.index + e.worktree;
  return e.index === 'U' || e.worktree === 'U' || both === 'AA' || both === 'DD';
}

/** True when the index differs from HEAD for this path (shows under "Staged"). */
export function hasStaged(e: GitStatusEntry): boolean {
  return !isUntracked(e) && !isIgnored(e) && !isConflict(e) && !CLEAN.has(e.index);
}

/** True when the worktree differs from the index (shows under "Unstaged"; untracked counts). */
export function hasUnstaged(e: GitStatusEntry): boolean {
  return !isIgnored(e) && !isConflict(e) && (isUntracked(e) || !CLEAN.has(e.worktree));
}

export function describeCode(code: string, area: ChangeArea): { label: string; tone: ChangeTone } {
  if (area === 'conflict') return { label: 'conflict', tone: 'conflict' };
  switch (code) {
    case 'M':
      return { label: 'modified', tone: 'modified' };
    case 'A':
      return { label: 'added', tone: 'added' };
    case 'D':
      return { label: 'deleted', tone: 'deleted' };
    case 'R':
      return { label: 'renamed', tone: 'renamed' };
    case 'C':
      return { label: 'copied', tone: 'copied' };
    case 'T':
      return { label: 'type changed', tone: 'typechange' };
    case '?':
      return { label: 'untracked', tone: 'untracked' };
    case 'U':
      return { label: 'conflict', tone: 'conflict' };
    default:
      return { label: area === 'staged' ? 'staged' : 'changed', tone: 'other' };
  }
}

function makeItem(entry: GitStatusEntry, area: ChangeArea, rawCode: string): ChangeItem {
  const code = rawCode.trim();
  const d = describeCode(code, area);
  return { key: `${area}:${entry.path}`, entry, area, code: code || '•', label: d.label, tone: d.tone };
}

export function splitStatus(status: GitStatus | undefined): SplitStatus {
  const staged: ChangeItem[] = [];
  const unstaged: ChangeItem[] = [];
  const conflicts: ChangeItem[] = [];
  for (const e of status?.entries ?? []) {
    if (isIgnored(e)) continue;
    if (isConflict(e)) {
      conflicts.push(makeItem(e, 'conflict', 'U'));
      continue;
    }
    if (hasStaged(e)) staged.push(makeItem(e, 'staged', e.index));
    if (hasUnstaged(e)) unstaged.push(makeItem(e, 'unstaged', isUntracked(e) ? '?' : e.worktree));
  }
  const byPath = (a: ChangeItem, b: ChangeItem) => a.entry.path.localeCompare(b.entry.path);
  staged.sort(byPath);
  unstaged.sort(byPath);
  conflicts.sort(byPath);
  return { staged, unstaged, conflicts, total: staged.length + unstaged.length + conflicts.length };
}

export function toneColors(tone: ChangeTone, t: Theme): { bg: string; fg: string } {
  const c = t.colors;
  switch (tone) {
    case 'added':
      return { bg: c.successSoft, fg: c.success };
    case 'untracked':
      return { bg: c.accentSoft, fg: c.accent };
    case 'deleted':
    case 'conflict':
      return { bg: c.dangerSoft, fg: c.danger };
    case 'renamed':
    case 'copied':
      return { bg: c.infoSoft, fg: c.info };
    case 'modified':
    case 'typechange':
      return { bg: c.warningSoft, fg: c.warning };
    default:
      return { bg: c.surfaceAlt, fg: c.textMuted };
  }
}

export function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf('/');
  return i === -1 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

export interface PatchStats {
  added: number;
  removed: number;
  files: number;
  /** content rows (added + removed + context + "no newline" notes) — what the diff view renders, headers excluded */
  lines: number;
}

/** +/− line counts, file count and renderable row count of a unified patch (file headers excluded). */
export function patchStats(patch: string): PatchStats {
  let added = 0;
  let removed = 0;
  let files = 0;
  let lines = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) {
      files++;
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('+++') || line.startsWith('---')) continue;
    const c = line.charAt(0);
    if (c === '+') added++;
    else if (c === '-') removed++;
    else if (c !== ' ' && c !== '\\') continue; // not a content row (e.g. a trailing blank line)
    lines++;
  }
  return { added, removed, files, lines };
}

/** "main · ↑2 ↓1" style summary; empty string when nothing is known. */
export function describeBranch(status: GitStatus | undefined): string {
  if (!status) return '';
  const parts: string[] = [];
  if (status.branch) parts.push(status.branch);
  const sync: string[] = [];
  if (status.ahead) sync.push(`↑${status.ahead}`);
  if (status.behind) sync.push(`↓${status.behind}`);
  if (sync.length) parts.push(sync.join(' '));
  return parts.join(' · ');
}

/** git log dates may arrive in seconds or milliseconds; normalise to ms. */
export function commitDateMs(date: number): number {
  return date < 1e12 ? date * 1000 : date;
}

/** The status row for a relative path (as the daemon reports it), if the file changed. */
export function findStatusEntry(status: GitStatus | undefined, path: string): GitStatusEntry | undefined {
  if (!status) return undefined;
  const p = path.replace(/^\.?\/+/, '');
  return status.entries.find((e) => e.path === p);
}

export interface EntryChange {
  code: string;
  label: string;
  tone: ChangeTone;
  staged: boolean;
  unstaged: boolean;
  conflict: boolean;
  untracked: boolean;
}

/** One-line summary of a file's change for the viewer ("modified", "untracked", …); null when clean/ignored. */
export function summarizeEntry(e: GitStatusEntry | undefined): EntryChange | null {
  if (!e || isIgnored(e)) return null;
  if (isConflict(e)) return { code: 'U', label: 'conflict', tone: 'conflict', staged: false, unstaged: false, conflict: true, untracked: false };
  const staged = hasStaged(e);
  const unstaged = hasUnstaged(e);
  if (!staged && !unstaged) return null;
  const untracked = isUntracked(e);
  const raw = unstaged ? (untracked ? '?' : e.worktree) : e.index;
  const code = raw.trim();
  const d = describeCode(code, unstaged ? 'unstaged' : 'staged');
  return { code: code || '•', label: d.label, tone: d.tone, staged, unstaged, conflict: false, untracked };
}

/** Number of lines in a text (a trailing newline does not start an extra line). */
export function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n - 1 : n;
}
