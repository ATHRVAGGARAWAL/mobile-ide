/**
 * Two decoration layers on top of a document:
 *  - live changes: the lines a disk update just inserted (accent wash + bar) and where lines were removed (thin red rule).
 *    Added with `addLive`, mapped through later edits, cleared with `clearLive` after the animation.
 *  - ghosts: edits the agent announced but that have not landed yet. The text it will replace is struck through in
 *    place, the replacement is drawn below it in a dashed accent card — so the change is visible *before* the write.
 */
import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { PendingEdit } from '../state/store';

export interface LiveRanges {
  id: number;
  added: { from: number; to: number }[];
  removedAt: number[];
}

export const addLive = StateEffect.define<LiveRanges>({
  map: (v, mapping) => ({
    id: v.id,
    added: v.added.map((r) => ({ from: mapping.mapPos(r.from), to: mapping.mapPos(r.to) })),
    removedAt: v.removedAt.map((p) => mapping.mapPos(p)),
  }),
});
export const clearLive = StateEffect.define<number>();

const addedLine = Decoration.line({ class: 'cm-live-added' });
const removedLine = Decoration.line({ class: 'cm-live-removed' });

interface LiveState {
  ranges: LiveRanges[];
  deco: DecorationSet;
}

function buildLive(
  state: {
    doc: {
      lineAt(pos: number): { from: number; to: number; number: number };
      lines: number;
      line(n: number): { from: number };
      length: number;
    };
  },
  ranges: LiveRanges[],
): DecorationSet {
  const lines = new Map<number, 'added' | 'removed'>();
  for (const r of ranges) {
    for (const a of r.added) {
      const from = Math.min(a.from, state.doc.length);
      const to = Math.min(Math.max(a.from, a.to - 1), state.doc.length);
      const first = state.doc.lineAt(from).number;
      const last = state.doc.lineAt(to).number;
      for (let n = first; n <= last; n++) lines.set(n, 'added');
    }
    for (const p of r.removedAt) {
      const n = state.doc.lineAt(Math.min(p, state.doc.length)).number;
      if (!lines.has(n)) lines.set(n, 'removed');
    }
  }
  const builder = new RangeSetBuilder<Decoration>();
  for (const n of [...lines.keys()].sort((a, b) => a - b)) {
    const from = state.doc.line(n).from;
    builder.add(from, from, lines.get(n) === 'added' ? addedLine : removedLine);
  }
  return builder.finish();
}

const liveField = StateField.define<LiveState>({
  create: () => ({ ranges: [], deco: Decoration.none }),
  update(value, tr) {
    let ranges = value.ranges;
    let changed = false;
    if (tr.docChanged) {
      ranges = ranges.map((r) => addLive.map(r, tr.changes)!).filter(Boolean);
      changed = true;
    }
    for (const e of tr.effects) {
      if (e.is(addLive)) {
        ranges = [...ranges, e.value];
        changed = true;
      } else if (e.is(clearLive)) {
        ranges = ranges.filter((r) => r.id !== e.value);
        changed = true;
      }
    }
    if (!changed) return value;
    return { ranges, deco: ranges.length ? buildLive(tr.state, ranges) : Decoration.none };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// ---------------------------------------------------------------------------- ghosts
export const setGhosts = StateEffect.define<PendingEdit[]>();

const GHOST_MAX_LINES = 60;

class GhostWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly title: string,
    readonly awaiting: boolean,
    readonly note: string | null,
  ) {
    super();
  }

  override eq(other: GhostWidget): boolean {
    return other.text === this.text && other.title === this.title && other.awaiting === this.awaiting && other.note === this.note;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-ghost';
    const head = document.createElement('div');
    head.className = 'cm-ghost-head';
    const dot = document.createElement('span');
    dot.className = 'cm-ghost-dot';
    const label = document.createElement('span');
    label.textContent = this.awaiting ? 'incoming · waiting for approval' : 'incoming edit';
    const title = document.createElement('span');
    title.className = 'cm-ghost-title';
    title.textContent = this.note ?? this.title;
    head.append(dot, label, title);
    const pre = document.createElement('pre');
    const lines = this.text.replace(/\n$/, '').split('\n');
    pre.textContent = lines.slice(0, GHOST_MAX_LINES).join('\n');
    if (lines.length > GHOST_MAX_LINES) {
      const more = document.createElement('span');
      more.className = 'cm-ghost-more';
      more.textContent = `\n… ${lines.length - GHOST_MAX_LINES} more lines`;
      pre.appendChild(more);
    }
    wrap.append(head, pre);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

interface GhostState {
  edits: PendingEdit[];
  deco: DecorationSet;
}

function buildGhosts(
  doc: { toString(): string; length: number; lineAt(pos: number): { to: number; from: number } },
  edits: PendingEdit[],
): DecorationSet {
  if (edits.length === 0) return Decoration.none;
  const text = doc.toString();
  const marks: { from: number; to: number; deco: Decoration }[] = [];
  for (const e of edits) {
    const old = e.oldText === null ? '' : e.oldText.replace(/\n$/, '');
    if (old !== '') {
      const idx = text.indexOf(old);
      if (idx >= 0) {
        const end = idx + old.length;
        marks.push({ from: idx, to: end, deco: Decoration.mark({ class: 'cm-ghost-old' }) });
        const lineEnd = doc.lineAt(Math.min(end, doc.length)).to;
        marks.push({
          from: lineEnd,
          to: lineEnd,
          deco: Decoration.widget({ widget: new GhostWidget(e.newText, e.title, e.awaitingPermission, null), block: true, side: 1 }),
        });
        continue;
      }
      // target text not in this document (already changed, or a different revision): still show what is coming
      marks.push({
        from: 0,
        to: 0,
        deco: Decoration.widget({
          widget: new GhostWidget(e.newText, e.title, e.awaitingPermission, 'target text not found in the current file'),
          block: true,
          side: -1,
        }),
      });
      continue;
    }
    // pure insertion / new file: shown at the end
    const at = doc.length;
    marks.push({
      from: at,
      to: at,
      deco: Decoration.widget({
        widget: new GhostWidget(e.newText, e.title, e.awaitingPermission, text.length === 0 ? 'new file' : 'appended'),
        block: true,
        side: 1,
      }),
    });
  }
  marks.sort((a, b) => a.from - b.from || a.to - b.to || (a.deco.spec.block ? 1 : -1));
  const builder = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const m of marks) {
    // RangeSetBuilder wants sorted, non-overlapping marks; skip a mark that starts inside the previous one
    if (m.to > m.from && m.from < last) continue;
    builder.add(m.from, m.to, m.deco);
    if (m.to > m.from) last = m.to;
  }
  return builder.finish();
}

const ghostField = StateField.define<GhostState>({
  create: () => ({ edits: [], deco: Decoration.none }),
  update(value, tr) {
    let edits = value.edits;
    let touched = false;
    for (const e of tr.effects) {
      if (e.is(setGhosts)) {
        edits = e.value;
        touched = true;
      }
    }
    if (!touched && !tr.docChanged) return value;
    if (!touched && edits.length === 0) return value;
    return { edits, deco: buildGhosts(tr.state.doc, edits) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export const liveChanges: Extension = [liveField, ghostField];
