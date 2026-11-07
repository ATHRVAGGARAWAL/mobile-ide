/**
 * One CodeMirror view per open file, created on first show and kept in the registry across tab switches. Disk updates
 * (Doc.version) are applied as minimal changes with the live decorations; the agent's announced-but-unwritten edits are
 * mirrored into the ghost layer; local edits report dirty state and the cursor back to the store.
 */
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Text } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { computeLiveDiff } from '../lib/diff';
import { basename } from '../lib/paths';
import { markDirty, saveDoc, setCursor } from '../state/controller';
import { useStudio, type Doc, type PendingEdit } from '../state/store';
import { addLive, clearLive, liveChanges, setGhosts } from './liveChanges';
import { editors } from './registry';
import { studioHighlight, studioTheme } from './theme';

const LIVE_HOLD_MS = 2800;
/** do not steal the scroll position from someone who just scrolled or typed */
const USER_IDLE_MS = 1500;

interface Props {
  fileKey: string;
  doc: Doc;
  pending: PendingEdit[];
}

interface ViewMeta {
  language: Compartment;
  readOnly: Compartment;
  diskDoc: Text;
  lastUserActivity: number;
  liveSeq: number;
  langLoadedFor: string | null;
}

const metas = new Map<string, ViewMeta>();

function createView(key: string, doc: Doc): EditorView {
  const meta: ViewMeta = {
    language: new Compartment(),
    readOnly: new Compartment(),
    diskDoc: Text.of(doc.content.split('\n')),
    lastUserActivity: 0,
    liveSeq: 0,
    langLoadedFor: null,
  };
  metas.set(key, meta);
  const state = EditorState.create({
    doc: doc.content,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter({ openText: '⌵', closedText: '›' }),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            void saveDoc(key);
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      studioTheme,
      studioHighlight,
      liveChanges,
      meta.language.of([]),
      meta.readOnly.of(EditorState.readOnly.of(doc.truncated || doc.binary)),
      EditorView.updateListener.of((u) => {
        if (
          u.docChanged &&
          u.transactions.some(
            (tr) =>
              tr.isUserEvent('input') ||
              tr.isUserEvent('delete') ||
              tr.isUserEvent('move') ||
              tr.isUserEvent('undo') ||
              tr.isUserEvent('redo'),
          )
        ) {
          meta.lastUserActivity = Date.now();
          markDirty(key, !u.state.doc.eq(meta.diskDoc));
        } else if (u.docChanged) {
          markDirty(key, !u.state.doc.eq(meta.diskDoc));
        }
        if (u.selectionSet || u.docChanged) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          setCursor(line.number, head - line.from + 1);
        }
      }),
      EditorView.domEventHandlers({
        scroll: () => {
          meta.lastUserActivity = Date.now();
        },
        keydown: () => {
          meta.lastUserActivity = Date.now();
        },
        mousedown: () => {
          meta.lastUserActivity = Date.now();
        },
      }),
    ],
  });
  const view = new EditorView({ state });
  editors.register(key, view);
  editors.applied.set(key, doc.version);
  void loadLanguage(view, meta, doc.path);
  return view;
}

async function loadLanguage(view: EditorView, meta: ViewMeta, path: string): Promise<void> {
  const name = basename(path);
  if (meta.langLoadedFor === name) return;
  meta.langLoadedFor = name;
  const desc = LanguageDescription.matchFilename(languages, name) ?? matchByExtension(name);
  if (!desc) return;
  try {
    const support = await desc.load();
    if (editors.get(keyOf(view)) !== view) return;
    view.dispatch({ effects: meta.language.reconfigure(support) });
  } catch (err) {
    console.warn('[studio] language load failed', desc.name, err);
  }
}

/** language-data misses a few common names (Dockerfile without extension, .mjs, .cjs, .mts, .cts) */
function matchByExtension(name: string): LanguageDescription | null {
  const lower = name.toLowerCase();
  const pick = (n: string): LanguageDescription | null => languages.find((l) => l.name.toLowerCase() === n.toLowerCase()) ?? null;
  if (/\.(mjs|cjs)$/.test(lower)) return pick('JavaScript');
  if (/\.(mts|cts)$/.test(lower)) return pick('TypeScript');
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return pick('Dockerfile');
  if (
    lower === '.env' ||
    lower.startsWith('.env.') ||
    /\.(ini|cfg|conf)$/.test(lower) ||
    lower === '.gitignore' ||
    lower === '.editorconfig' ||
    lower === '.npmrc'
  )
    return pick('Properties files') ?? pick('INI');
  if (/\.(zsh|bash)$|\.zshrc$|\.bashrc$/.test(lower)) return pick('Shell');
  return null;
}

const viewKeys = new WeakMap<EditorView, string>();
function keyOf(view: EditorView): string {
  return viewKeys.get(view) ?? '';
}

export function Editor({ fileKey, doc, pending }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const follow = useStudio((s) => s.follow);

  // mount / swap the view into the host element
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let view = editors.get(fileKey);
    if (!view) {
      view = createView(fileKey, doc);
      viewKeys.set(view, fileKey);
    }
    el.replaceChildren(view.dom);
    view.requestMeasure();
    const reveal = editors.takeReveal(fileKey);
    if (reveal !== undefined) revealLine(view, reveal);
    return () => {
      // keep the view alive for the next activation; only detach its DOM
      if (view && view.dom.parentElement === el) el.removeChild(view.dom);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  // disk → editor: apply the new content as minimal changes and light them up
  useEffect(() => {
    const view = editors.get(fileKey);
    const meta = metas.get(fileKey);
    if (!view || !meta) return;
    const applied = editors.applied.get(fileKey) ?? -1;
    if (doc.version === applied || doc.loading) return;
    editors.applied.set(fileKey, doc.version);
    const current = view.state.doc.toString();
    meta.diskDoc = Text.of(doc.content.split('\n'));
    if (current === doc.content) {
      markDirty(fileKey, false);
      return;
    }
    if (doc.dirty && doc.conflict) return; // the banner decides
    const diff = computeLiveDiff(current, doc.content);
    const id = ++meta.liveSeq;
    view.dispatch({
      changes: diff.changes,
      effects: addLive.of({ id, added: diff.added, removedAt: diff.removedAt }),
      annotations: [],
    });
    markDirty(fileKey, false);
    // read-only follows truncation state
    view.dispatch({ effects: meta.readOnly.reconfigure(EditorState.readOnly.of(doc.truncated || doc.binary)) });
    void loadLanguage(view, meta, doc.path);
    const idle = Date.now() - meta.lastUserActivity > USER_IDLE_MS;
    if (diff.firstChangeAt !== null && follow && idle) {
      const pos = Math.min(diff.firstChangeAt, view.state.doc.length);
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    }
    const timer = setTimeout(() => {
      const v = editors.get(fileKey);
      if (v) v.dispatch({ effects: clearLive.of(id) });
    }, LIVE_HOLD_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, doc.version, doc.content, doc.loading]);

  // announced edits → ghosts
  useEffect(() => {
    const view = editors.get(fileKey);
    const meta = metas.get(fileKey);
    if (!view || !meta) return;
    view.dispatch({ effects: setGhosts.of(pending) });
    if (pending.length && follow && Date.now() - meta.lastUserActivity > USER_IDLE_MS) {
      const first = pending[0]!;
      const old = first.oldText?.replace(/\n$/, '') ?? '';
      const idx = old ? view.state.doc.toString().indexOf(old) : view.state.doc.length;
      if (idx >= 0) view.dispatch({ effects: EditorView.scrollIntoView(idx, { y: 'center' }) });
    }
  }, [fileKey, pending, follow]);

  return <div className="editor-host" ref={host} />;
}

function revealLine(view: EditorView, line: number): void {
  const n = Math.max(1, Math.min(line, view.state.doc.lines));
  const pos = view.state.doc.line(n).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
}
