/**
 * ⌘K: fuzzy file finder over the folders the explorer has loaded plus a bounded crawl of the rest, sessions to follow,
 * and the Studio's commands. Arrow keys move, Enter runs, Esc closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { basename, joinPath } from '../lib/paths';
import { useDialog } from '../lib/useDialog';
import {
  closeTab,
  followSession,
  openFile,
  openNewSession,
  openPalette,
  setAutoSwitch,
  setFollow,
  togglePanel,
  toggleTheme,
} from '../state/controller';
import { useStudio } from '../state/store';
import { Icon, type IconName } from './Icons';

interface Item {
  id: string;
  kind: 'file' | 'session' | 'command';
  title: string;
  subtitle?: string;
  icon: IconName;
  keys?: string;
  run: () => void;
}

const SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.expo',
  '.cache',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
]);
const CRAWL_LIMIT = 4000;

/** File names under `root`, breadth-first, bounded — cached per root for the life of the page. */
const crawlCache = new Map<string, Promise<string[]>>();
function crawl(root: string): Promise<string[]> {
  let p = crawlCache.get(root);
  if (!p) {
    p = (async () => {
      const out: string[] = [];
      const queue = [''];
      while (queue.length && out.length < CRAWL_LIMIT) {
        const dir = queue.shift()!;
        let entries;
        try {
          entries = await api.fsTree(root, dir);
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.kind === 'dir') {
            if (!SKIP.has(e.name) && !e.name.startsWith('.')) queue.push(joinPath(dir, e.name));
          } else if (e.kind === 'file' || e.kind === 'symlink') out.push(joinPath(dir, e.name));
          if (out.length >= CRAWL_LIMIT) break;
        }
      }
      return out;
    })();
    crawlCache.set(root, p);
  }
  return p;
}

/** Subsequence match with a score favouring word starts, the basename and compactness. 0 = no match. */
function fuzzy(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    const prev = t[i - 1];
    score += 3;
    if (i === 0 || prev === '/' || prev === '-' || prev === '_' || prev === '.' || prev === ' ') score += 6;
    if (i === last + 1) score += 4;
    last = i;
    qi++;
  }
  if (qi < q.length) return 0;
  const base = basename(text).toLowerCase();
  if (base.includes(q)) score += 20;
  if (base.startsWith(q)) score += 15;
  return score - Math.min(t.length, 200) / 40;
}

export function CommandPalette() {
  const open = useStudio((s) => s.paletteOpen);
  const root = useStudio((s) => s.root);
  const sessions = useStudio((s) => s.sessions);
  const follow = useStudio((s) => s.follow);
  const autoSwitch = useStudio((s) => s.autoSwitch);
  const theme = useStudio((s) => s.theme);
  const activeKey = useStudio((s) => s.activeKey);
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useDialog(open, dialogRef, () => openPalette(false));

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    setFiles([]);
    let current = true;
    input.current?.focus();
    if (root)
      void crawl(root).then((f) => {
        if (current) setFiles(f);
      });
    return () => {
      current = false;
    };
  }, [open, root]);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const q = query.trim();
    const commands: Item[] = [
      {
        id: 'c:new',
        kind: 'command',
        title: 'New session',
        subtitle: 'Build, fix, or review with an agent',
        icon: 'plus',
        run: () => openNewSession(true),
      },
      {
        id: 'c:follow',
        kind: 'command',
        title: follow ? 'Stop following the agent’s files' : 'Follow the agent’s files',
        subtitle: 'open and reveal what the agent edits',
        icon: 'crosshair',
        run: () => setFollow(!follow),
      },
      {
        id: 'c:switch',
        kind: 'command',
        title: autoSwitch ? 'Stay on this session' : 'Jump to new sessions',
        subtitle: 'when a session starts on the phone',
        icon: 'zap',
        run: () => setAutoSwitch(!autoSwitch),
      },
      {
        id: 'c:theme',
        kind: 'command',
        title: theme === 'dark' ? 'Light theme' : 'Dark theme',
        icon: theme === 'dark' ? 'sun' : 'moon',
        run: toggleTheme,
      },
      { id: 'c:explorer', kind: 'command', title: 'Toggle explorer', icon: 'panel-left', keys: '⌘B', run: () => togglePanel('explorer') },
      { id: 'c:rail', kind: 'command', title: 'Toggle session panel', icon: 'panel-right', keys: '⌘J', run: () => togglePanel('rail') },
      ...(activeKey
        ? [{ id: 'c:close', kind: 'command' as const, title: 'Close file', icon: 'x' as const, keys: '⌘W', run: () => closeTab(activeKey) }]
        : []),
    ];
    const sessionItems: Item[] = sessions.map((s) => ({
      id: `s:${s.id}`,
      kind: 'session',
      title: s.title,
      subtitle: `${s.agentName} · ${s.projectName} · ${s.status.replace('_', ' ')}`,
      icon: 'sparkles',
      run: () => followSession(s.id),
    }));
    const fileItems: Item[] = root
      ? files.map((p) => ({
          id: `f:${p}`,
          kind: 'file',
          title: basename(p),
          subtitle: p,
          icon: 'file',
          run: () => void openFile(root, p, { by: 'user' }),
        }))
      : [];
    if (!q) return [...commands, ...sessionItems, ...fileItems.slice(0, 12)];
    const scored = [...commands, ...sessionItems, ...fileItems]
      .map((it) => ({
        it,
        score: Math.max(
          fuzzy(q, it.subtitle && it.kind === 'file' ? it.subtitle : it.title),
          it.kind !== 'file' ? fuzzy(q, `${it.title} ${it.subtitle ?? ''}`) * 0.9 : 0,
        ),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
    return scored.map((x) => x.it);
  }, [open, query, files, sessions, follow, autoSwitch, theme, root, activeKey]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  const run = (it: Item | undefined) => {
    if (!it) return;
    openPalette(false);
    it.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={() => openPalette(false)}>
      <div
        ref={dialogRef}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            aria-label="Search files, sessions and commands"
            value={query}
            placeholder={root ? 'Search files, sessions and commands…' : 'Search sessions and commands…'}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(items.length - 1, c + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(items[cursor]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                openPalette(false);
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {items.length === 0 ? <div className="palette-empty">Nothing matches “{query}”</div> : null}
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              className={`palette-item ${i === cursor ? 'active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => run(it)}
            >
              <span className={`palette-icon kind-${it.kind}`}>
                <Icon name={it.icon} size={14} />
              </span>
              <span className="palette-text">
                <span className="palette-title">{it.title}</span>
                {it.subtitle ? <span className="palette-sub">{it.subtitle}</span> : null}
              </span>
              {it.keys ? <kbd>{it.keys}</kbd> : <span className="palette-kind">{it.kind}</span>}
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>{files.length ? `${files.length} files indexed` : ''}</span>
        </div>
      </div>
    </div>
  );
}
