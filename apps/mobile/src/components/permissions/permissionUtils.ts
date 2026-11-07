/**
 * Pure helpers for rendering permission requests: option ordering/colours, tool-kind
 * icons, and a structured view of `rawInput` so the literal command is always shown first.
 */
import type React from 'react';
import type { Ionicons } from '@expo/vector-icons';
import type { PermissionOption, PermissionRequest, ToolContent, ToolKind, ToolLocation } from '@mobile-ide/core';
import { diffLines } from 'diff';
import { commandOf, stringifyInput } from '../../lib/format';
import type { ButtonVariant } from '../ui/Button';

export type IoniconName = React.ComponentProps<typeof Ionicons>['name'];
export type PermissionOptionKind = PermissionOption['kind'];
export interface ResolvedInfo {
  outcome: 'selected' | 'cancelled';
  optionId?: string;
}

const OPTION_ORDER: Record<PermissionOptionKind, number> = { allow_once: 0, allow_always: 1, reject_once: 2, reject_always: 3 };

const DEFAULT_OPTION_LABEL: Record<PermissionOptionKind, string> = {
  allow_once: 'Allow once',
  allow_always: 'Always allow',
  reject_once: 'Reject',
  reject_always: 'Always reject',
};

/** allow_once, allow_always, reject_once, reject_always — stable within a kind. */
export function sortOptions(options: readonly PermissionOption[]): PermissionOption[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => OPTION_ORDER[a.option.kind] - OPTION_ORDER[b.option.kind] || a.index - b.index)
    .map((x) => x.option);
}

export function isAllowKind(kind: PermissionOptionKind): boolean {
  return kind === 'allow_once' || kind === 'allow_always';
}

export function optionLabel(option: PermissionOption): string {
  const name = option.name.trim();
  return name || DEFAULT_OPTION_LABEL[option.kind];
}

/** Distinct colour per option kind so the four buttons are never confused. */
export function optionVariant(kind: PermissionOptionKind): ButtonVariant {
  switch (kind) {
    case 'allow_once':
      return 'success';
    case 'allow_always':
      return 'warning';
    case 'reject_once':
      return 'secondary';
    case 'reject_always':
      return 'dangerSoft';
  }
}

export function optionIcon(kind: PermissionOptionKind): IoniconName {
  switch (kind) {
    case 'allow_once':
      return 'checkmark';
    case 'allow_always':
      return 'checkmark-done-outline';
    case 'reject_once':
      return 'close';
    case 'reject_always':
      return 'ban-outline';
  }
}

export function kindIcon(kind: ToolKind | undefined): IoniconName {
  switch (kind) {
    case 'read':
      return 'reader-outline';
    case 'edit':
      return 'pencil-outline';
    case 'delete':
      return 'trash-outline';
    case 'move':
      return 'swap-horizontal-outline';
    case 'search':
      return 'search-outline';
    case 'execute':
      return 'terminal-outline';
    case 'think':
      return 'bulb-outline';
    case 'fetch':
      return 'globe-outline';
    case 'switch_mode':
      return 'options-outline';
    default:
      return 'construct-outline';
  }
}

export function kindLabel(kind: ToolKind | undefined): string {
  switch (kind) {
    case 'read':
      return 'Read file';
    case 'edit':
      return 'Edit file';
    case 'delete':
      return 'Delete';
    case 'move':
      return 'Move';
    case 'search':
      return 'Search';
    case 'execute':
      return 'Run command';
    case 'think':
      return 'Think';
    case 'fetch':
      return 'Fetch URL';
    case 'switch_mode':
      return 'Switch mode';
    default:
      return 'Tool call';
  }
}

export interface PermissionInput {
  /** literal command for execute-style tools; shown first and never truncated */
  command: string | null;
  /** primary file path for read/edit/delete style tools */
  path: string | null;
  /** everything else the agent sent, pretty-printed (or the raw string) */
  details: string;
  /** the complete input, verbatim — what "Show full input" reveals; never filtered */
  full: string;
  /** keys were left out of `details` because the request's diff already shows them */
  hidden: boolean;
  /** the agent sent no input at all */
  empty: boolean;
}

const COMMAND_KEYS = new Set(['command', 'cmd', 'script']);
/** claude-agent-acp: file_path / notebook_path · OpenCode: filePath on the tool call, filepath on the permission request */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filepath', 'file', 'filename', 'notebook_path', 'target', 'uri', 'url'];
/** Keys whose value IS the change (a patch string, old/new text): redundant next to a rendered diff. */
const CHANGE_KEYS = new Set(['diff', 'patch', 'content', 'old_string', 'new_string', 'old_str', 'new_str', 'oldText', 'newText']);

export interface DescribeInputOptions {
  /** the request carries a rendered diff: leave the change text out of `details` (it would repeat the diff as escaped JSON) */
  hasDiff?: boolean;
}

/** Split rawInput into "the thing to approve" and "the rest", without ever truncating. */
export function describeInput(raw: unknown, opts: DescribeInputOptions = {}): PermissionInput {
  if (raw === undefined || raw === null) return { command: null, path: null, details: '', full: '', hidden: false, empty: true };
  if (typeof raw === 'string') return { command: null, path: null, details: raw, full: raw, hidden: false, empty: raw.trim() === '' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    const full = stringifyInput(raw, Number.POSITIVE_INFINITY);
    return { command: null, path: null, details: full, full, hidden: false, empty: false };
  }
  const rec = raw as Record<string, unknown>;
  const command = commandOf(raw);
  let path: string | null = null;
  let pathKey: string | null = null;
  if (command === null) {
    for (const key of PATH_KEYS) {
      const v = rec[key];
      if (typeof v === 'string' && v.trim()) {
        path = v;
        pathKey = key;
        break;
      }
    }
  }
  const rest: Record<string, unknown> = {};
  let hidden = false;
  for (const [key, value] of Object.entries(rec)) {
    if (command !== null && COMMAND_KEYS.has(key)) continue;
    if (pathKey !== null && key === pathKey) continue;
    if (opts.hasDiff && CHANGE_KEYS.has(key)) {
      hidden = true;
      continue;
    }
    rest[key] = value;
  }
  const details = Object.keys(rest).length ? stringifyInput(rest, Number.POSITIVE_INFINITY) : '';
  const keys = Object.keys(rec).length;
  return { command, path, details, full: keys ? stringifyInput(rec, Number.POSITIVE_INFINITY) : '', hidden, empty: command === null && path === null && keys === 0 };
}

/**
 * A unified-diff string the agent put in its input (OpenCode's permission `diff`) — rendered as a diff when the
 * request has no structured diff block to show instead. Detected by its markers, never by key alone.
 */
export function patchOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const v = r.diff ?? r.patch;
  return typeof v === 'string' && /^(?:Index: |diff |--- |\+\+\+ |@@ )/m.test(v) ? v : null;
}

/** A path shown relative to the session cwd when it lies inside it; absolute titles otherwise wrap over two lines and repeat. */
export function relativePath(p: string, cwd: string | undefined): string {
  if (!cwd) return p;
  const root = cwd.replace(/\/+$/, '');
  if (root && (p === root || p.startsWith(root + '/'))) return p.slice(root.length + 1) || '.';
  return p;
}

/** Directory part of a path ('' when there is none). */
export function parentDir(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '' : p.slice(0, i);
}

export type DiffToolContent = Extract<ToolContent, { type: 'diff' }>;
export type TerminalToolContent = Extract<ToolContent, { type: 'terminal' }>;

export function diffContents(request: Pick<PermissionRequest, 'content'>): DiffToolContent[] {
  return (request.content ?? []).filter((c): c is DiffToolContent => c.type === 'diff');
}

/** ACP marks a new file with `oldText: null`; OpenCode sends `''` instead, and an empty file gaining content reads the same. */
export function isNewFile(d: Pick<DiffToolContent, 'oldText'>): boolean {
  return d.oldText === null || d.oldText === '';
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** Line counts behind a "+3 −1" summary. */
export function diffStats(d: Pick<DiffToolContent, 'oldText' | 'newText'>): DiffStats {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(d.oldText ?? '', d.newText)) {
    if (part.added) added += part.count;
    else if (part.removed) removed += part.count;
  }
  return { added, removed };
}

export function formatDiffStats(s: DiffStats): string {
  return `+${s.added} −${s.removed}`;
}

export function terminalContents(request: Pick<PermissionRequest, 'content'>): TerminalToolContent[] {
  return (request.content ?? []).filter((c): c is TerminalToolContent => c.type === 'terminal');
}

export function textContents(request: Pick<PermissionRequest, 'content'>): string[] {
  const out: string[] = [];
  for (const c of request.content ?? []) {
    if (c.type === 'content' && c.content.type === 'text' && c.content.text.trim()) out.push(c.content.text);
    if (c.type === 'content' && c.content.type === 'resource_link') out.push(`${c.content.name}: ${c.content.uri}`);
  }
  return out;
}

export interface ResolutionLabel {
  label: string;
  tone: 'success' | 'danger' | 'neutral';
  icon: IoniconName;
}

export function resolutionLabel(request: Pick<PermissionRequest, 'options'>, resolved: ResolvedInfo): ResolutionLabel {
  if (resolved.outcome === 'cancelled') return { label: 'Turn stopped', tone: 'neutral', icon: 'stop-circle-outline' };
  const option = request.options.find((o) => o.optionId === resolved.optionId);
  if (!option) return { label: 'Answered', tone: 'neutral', icon: 'checkmark-circle' };
  switch (option.kind) {
    case 'allow_once':
      return { label: 'Allowed once', tone: 'success', icon: 'checkmark-circle' };
    case 'allow_always':
      return { label: 'Always allowed', tone: 'success', icon: 'checkmark-done-outline' };
    case 'reject_once':
      return { label: 'Rejected', tone: 'danger', icon: 'close-circle' };
    case 'reject_always':
      return { label: 'Always rejected', tone: 'danger', icon: 'ban-outline' };
  }
}

export interface FileTarget {
  root: string;
  path: string;
  line?: number;
}

/** Map a tool location onto file-viewer params when it lies inside the session's project. */
export function locationTarget(loc: ToolLocation, cwd: string | undefined): FileTarget | null {
  if (!cwd) return null;
  const root = cwd.replace(/\/+$/, '');
  if (!root) return null;
  const p = loc.path;
  if (p.startsWith('/')) {
    if (!p.startsWith(root + '/')) return null;
    const rel = p.slice(root.length + 1);
    return rel ? { root, path: rel, line: loc.line } : null;
  }
  const rel = p.replace(/^\.\//, '');
  if (!rel || rel === '..' || rel.startsWith('../')) return null;
  return { root, path: rel, line: loc.line };
}

export function locationLabel(loc: ToolLocation, cwd: string | undefined): string {
  const target = locationTarget(loc, cwd);
  const shown = target ? target.path : loc.path;
  return loc.line ? `${shown}:${loc.line}` : shown;
}
