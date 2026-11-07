'use dom';
/**
 * Unified diff renderer (DOM component, shared by tool cards, the permission sheet and the Changes
 * diff sheet). Files and hunks collapse on tap; `maxLines` caps one file until "Show more" is tapped;
 * `maxTotalLines` is a hard budget across files (the host shows the notice and a "Load full" action).
 */
import React, { useMemo, useState } from 'react';
import { parsePatch, structuredPatch, type StructuredPatch } from 'diff';
import { IS_DOM, type DOMProps } from 'expo/dom';
import { cssVars, type DomThemeName } from './domTheme';

export type DiffSource = { kind: 'texts'; path: string; oldText: string | null; newText: string } | { kind: 'patch'; patch: string };

export interface DiffViewProps {
  source: DiffSource;
  theme: DomThemeName;
  wrap?: boolean;
  /** per file: collapse to at most this many lines until tapped */
  maxLines?: number;
  /** across all files: never render more than this many lines; the host explains and offers "Load full" */
  maxTotalLines?: number;
  dom?: DOMProps;
}

const CSS = `
  .mide-diff, .mide-diff * { box-sizing: border-box; }
  .mide-diff { font-family: var(--mono); font-size: 12.5px; line-height: 1.65; color: var(--code-text); background: var(--code-bg); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; -webkit-tap-highlight-color: transparent; }
  .mide-diff .file + .file { border-top: 1px solid var(--border); }
  .mide-diff .fhead { display: flex; align-items: center; gap: 8px; min-height: 46px; padding: 10px 12px; background: var(--surface-alt); color: var(--text); font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--border); cursor: pointer; user-select: none; -webkit-user-select: none; }
  .mide-diff .file.collapsed .fhead { border-bottom: 0; }
  .mide-diff .fhead .name { overflow-wrap: anywhere; min-width: 0; }
  .mide-diff .fhead .stat { margin-left: auto; font-weight: 500; white-space: nowrap; flex-shrink: 0; }
  .mide-diff .add { color: var(--diff-add-text); }
  .mide-diff .del { color: var(--diff-del-text); }
  .mide-diff .chev { display: inline-block; width: 10px; flex-shrink: 0; font-size: 9px; color: var(--text-muted); transition: transform .15s ease; text-align: center; }
  .mide-diff .chev.r { transform: rotate(-90deg); }
  .mide-diff .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .mide-diff table { border-collapse: collapse; width: 100%; min-width: 100%; }
  .mide-diff td { padding: 0 8px; vertical-align: top; white-space: pre; }
  .mide-diff.wrap td.code { white-space: pre-wrap; overflow-wrap: anywhere; }
  .mide-diff td.ln { width: 1%; min-width: 34px; text-align: right; color: var(--text-faint); user-select: none; -webkit-user-select: none; padding: 0 6px; font-size: 11px; }
  .mide-diff td.mark { width: 1%; padding: 0 2px 0 6px; user-select: none; -webkit-user-select: none; }
  .mide-diff tr.add td { background: var(--diff-add); }
  .mide-diff tr.add td.code, .mide-diff tr.add td.mark { color: var(--diff-add-text); }
  .mide-diff tr.del td { background: var(--diff-del); }
  .mide-diff tr.del td.code, .mide-diff tr.del td.mark { color: var(--diff-del-text); }
  .mide-diff tr.hunk td { background: var(--surface-alt); color: var(--text-muted); font-size: 11px; height: 44px; padding: 10px 12px; cursor: pointer; user-select: none; -webkit-user-select: none; white-space: normal; }
  .mide-diff tr.hunk:active td { opacity: .7; }
  .mide-diff .hh { display: flex; align-items: center; gap: 8px; }
  .mide-diff .hh .hdr { overflow-wrap: anywhere; min-width: 0; }
  .mide-diff .hh .hstat { margin-left: auto; white-space: nowrap; flex-shrink: 0; }
  .mide-diff tr.meta td { color: var(--text-faint); font-style: italic; white-space: normal; padding: 2px 10px; }
  .mide-diff tr.more td { color: var(--accent); padding: 8px 10px; cursor: pointer; text-align: center; font-family: var(--sans); font-size: 12px; user-select: none; -webkit-user-select: none; }
  .mide-diff tr.cut td { color: var(--text-faint); padding: 8px 10px; text-align: center; font-family: var(--sans); font-size: 12px; white-space: normal; }
  .mide-diff .empty, .mide-diff .binary { padding: 14px; color: var(--text-muted); font-family: var(--sans); font-size: 13px; }

  .mide-diff [role=button]:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
`;
const DOCUMENT_CSS = IS_DOM ? 'html, body { margin: 0; background: transparent; }' : '';

function activate(e: React.KeyboardEvent, action: () => void): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    action();
  }
}

interface Row {
  kind: 'add' | 'del' | 'ctx' | 'meta';
  oldNo?: number;
  newNo?: number;
  text: string;
}

interface Hunk {
  header: string;
  rows: Row[];
  added: number;
  removed: number;
}

interface FileDiff {
  name: string;
  hunks: Hunk[];
  /** total rows across hunks (headers excluded) */
  lines: number;
  added: number;
  removed: number;
  binary: boolean;
  /** replaces the table when set (parse failure) */
  note?: string;
}

function hunksFromPatch(p: StructuredPatch): Hunk[] {
  const hunks: Hunk[] = [];
  for (const h of p.hunks) {
    const rows: Row[] = [];
    let added = 0;
    let removed = 0;
    let o = h.oldStart;
    let n = h.newStart;
    for (const line of h.lines) {
      const c = line[0];
      const text = line.slice(1);
      if (c === '+') {
        rows.push({ kind: 'add', newNo: n++, text });
        added++;
      } else if (c === '-') {
        rows.push({ kind: 'del', oldNo: o++, text });
        removed++;
      } else if (c === '\\') rows.push({ kind: 'meta', text: line });
      else rows.push({ kind: 'ctx', oldNo: o++, newNo: n++, text });
    }
    hunks.push({ header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, rows, added, removed });
  }
  return hunks;
}

function fileName(p: StructuredPatch): string {
  const clean = (s: string | undefined) => (s ?? '').replace(/^[ab]\//, '');
  const n = clean(p.newFileName);
  const o = clean(p.oldFileName);
  if (n && n !== '/dev/null') return n;
  if (o && o !== '/dev/null') return o;
  return 'file';
}

/** DOM components always run in a browser engine, so the locale formatter is available. */
const fmt = (n: number): string => n.toLocaleString('en-US');

function finish(name: string, hunks: Hunk[], binary = false): FileDiff {
  let lines = 0;
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    lines += h.rows.length;
    added += h.added;
    removed += h.removed;
  }
  return { name, hunks, lines, added, removed, binary };
}

function build(source: DiffSource): FileDiff[] {
  try {
    if (source.kind === 'texts') {
      const p = structuredPatch(source.path, source.path, source.oldText ?? '', source.newText, '', '', { context: 3 });
      return [finish(source.path, hunksFromPatch(p))];
    }
    const patches = parsePatch(source.patch);
    const binaryMentioned = /^Binary files .* differ$/m.test(source.patch);
    return patches.map((p) => {
      const hunks = hunksFromPatch(p);
      return finish(fileName(p), hunks, hunks.length === 0 && binaryMentioned);
    });
  } catch (err) {
    console.warn('[diff] parse failed', err);
    return [{ name: 'diff', hunks: [], lines: 0, added: 0, removed: 0, binary: false, note: 'Could not parse this diff.' }];
  }
}

interface FileBlockProps {
  file: FileDiff;
  /** collapse to this many lines until "Show more" (per file) */
  maxLines: number;
  /** hard budget for this file from the global cap (rows beyond it are cut, not expandable here) */
  allowed: number;
}

function FileBlock({ file, maxLines, allowed }: FileBlockProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(file.lines <= maxLines);
  const [hiddenHunks, setHiddenHunks] = useState<ReadonlySet<number>>(() => new Set());
  const toggleHunk = (i: number) =>
    setHiddenHunks((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const fileLimit = expanded ? Number.POSITIVE_INFINITY : maxLines;
  const limit = Math.min(file.lines, fileLimit, allowed);
  const cutByBudget = allowed < file.lines && allowed <= fileLimit;

  const body: React.ReactNode[] = [];
  let used = 0;
  for (let i = 0; i < file.hunks.length && used < limit; i++) {
    const h = file.hunks[i];
    if (!h) continue;
    const hidden = hiddenHunks.has(i);
    const take = Math.min(h.rows.length, limit - used);
    body.push(
      <tr
        key={`h${i}`}
        className="hunk"
        role="button"
        tabIndex={0}
        aria-expanded={!hidden}
        onKeyDown={(e) => activate(e, () => toggleHunk(i))}
        onClick={() => toggleHunk(i)}
        data-hunk={i}
      >
        <td colSpan={4}>
          <div className="hh">
            <span className={`chev${hidden ? ' r' : ''}`} aria-hidden>
              ▼
            </span>
            <span className="hdr">{h.header}</span>
            <span className="hstat">
              {hidden ? (
                `${fmt(h.rows.length)} lines`
              ) : (
                <>
                  <span className="add">+{h.added}</span> <span className="del">−{h.removed}</span>
                </>
              )}
            </span>
          </div>
        </td>
      </tr>,
    );
    if (!hidden) {
      for (let j = 0; j < take; j++) {
        const r = h.rows[j];
        if (!r) continue;
        body.push(
          r.kind === 'meta' ? (
            <tr key={`${i}:${j}`} className="meta">
              <td colSpan={4}>{r.text}</td>
            </tr>
          ) : (
            <tr key={`${i}:${j}`} className={r.kind}>
              <td className="ln">{r.oldNo ?? ''}</td>
              <td className="ln">{r.newNo ?? ''}</td>
              <td className="mark">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</td>
              <td className="code">{r.text || ' '}</td>
            </tr>
          ),
        );
      }
    }
    used += take; // collapsed hunks still consume budget so the cut point never moves
  }
  const remaining = file.lines - limit;
  if (remaining > 0) {
    body.push(
      cutByBudget ? (
        <tr key="cut" className="cut" data-cut={remaining}>
          <td colSpan={4}>{fmt(remaining)} more lines not shown — use “Load full” above</td>
        </tr>
      ) : (
        <tr
          key="more"
          className="more"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => activate(e, () => setExpanded(true))}
          onClick={() => setExpanded(true)}
        >
          <td colSpan={4}>Show {fmt(remaining)} more lines</td>
        </tr>
      ),
    );
  }

  return (
    <div className={`file${collapsed ? ' collapsed' : ''}`} data-file={file.name}>
      <div
        className="fhead"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => activate(e, () => setCollapsed((c) => !c))}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className={`chev${collapsed ? ' r' : ''}`} aria-hidden>
          ▼
        </span>
        <span className="name">{file.name}</span>
        <span className="stat">
          {collapsed ? (
            `${fmt(file.lines)} lines`
          ) : (
            <>
              <span className="add">+{file.added}</span> <span className="del">-{file.removed}</span>
            </>
          )}
        </span>
      </div>
      {collapsed ? null : file.note ? (
        <div className="empty">{file.note}</div>
      ) : file.binary ? (
        <div className="binary">Binary file changed</div>
      ) : file.lines === 0 ? (
        <div className="empty">No textual changes</div>
      ) : (
        <div className="scroll">
          <table>
            <tbody>{body}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function DiffView({ source, theme, wrap = true, maxLines = 400, maxTotalLines }: DiffViewProps) {
  const files = useMemo(() => build(source), [source]);
  let remaining = maxTotalLines ?? Number.POSITIVE_INFINITY;
  return (
    <div className={`mide-diff${wrap ? ' wrap' : ''}`}>
      <style>{`.mide-diff{${cssVars(theme)}}${DOCUMENT_CSS}${CSS}`}</style>
      {files.length === 0 ? (
        <div className="empty">No changes</div>
      ) : (
        files.map((f, i) => {
          const allowed = Math.max(0, Math.min(f.lines, remaining));
          remaining -= allowed;
          return <FileBlock key={`${f.name}-${i}`} file={f} maxLines={maxLines} allowed={allowed} />;
        })
      )}
    </div>
  );
}
