/**
 * Line-level diff between what the editor shows and what just landed on disk. Produces (a) a CodeMirror change set so
 * the document is patched in place — cursor, scroll and undo history survive — and (b) the ranges to light up.
 */
import { diffLines } from 'diff';

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface LiveDiff {
  /** changes expressed against the OLD text, sorted, non-overlapping (CodeMirror accepts them in one transaction) */
  changes: TextChange[];
  /** [from, to) ranges in the NEW text that were inserted or replaced */
  added: { from: number; to: number }[];
  /** offsets in the NEW text where lines were removed (a marker is drawn there) */
  removedAt: number[];
  addedLines: number;
  removedLines: number;
  /** the first change, in NEW text offsets, for scrolling */
  firstChangeAt: number | null;
}

export function computeLiveDiff(oldText: string, newText: string): LiveDiff {
  const out: LiveDiff = { changes: [], added: [], removedAt: [], addedLines: 0, removedLines: 0, firstChangeAt: null };
  if (oldText === newText) return out;
  const parts = diffLines(oldText, newText);
  let oldPos = 0;
  let newPos = 0;
  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      oldPos += part.value.length;
      newPos += part.value.length;
      i++;
      continue;
    }
    // a removed run directly followed by an added run is one replacement
    let removed = '';
    let added = '';
    let removedCount = 0;
    let addedCount = 0;
    while (i < parts.length && (parts[i]!.added || parts[i]!.removed)) {
      const p = parts[i]!;
      if (p.removed) {
        removed += p.value;
        removedCount += p.count ?? countLines(p.value);
      } else {
        added += p.value;
        addedCount += p.count ?? countLines(p.value);
      }
      i++;
    }
    out.changes.push({ from: oldPos, to: oldPos + removed.length, insert: added });
    if (out.firstChangeAt === null) out.firstChangeAt = newPos;
    if (added.length) out.added.push({ from: newPos, to: newPos + added.length });
    if (removed.length && !added.length) out.removedAt.push(newPos);
    out.addedLines += addedCount;
    out.removedLines += removedCount;
    oldPos += removed.length;
    newPos += added.length;
  }
  return out;
}

function countLines(s: string): number {
  if (!s) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  if (s.charCodeAt(s.length - 1) !== 10) n++;
  return n;
}

/** +N −M of a unified old/new pair (for tool cards and tab badges). */
export function diffStats(oldText: string | null, newText: string): { added: number; removed: number } {
  if (oldText === null || oldText === '') return { added: countLines(newText), removed: 0 };
  const parts = diffLines(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    if (p.added) added += p.count ?? countLines(p.value);
    else if (p.removed) removed += p.count ?? countLines(p.value);
  }
  return { added, removed };
}
