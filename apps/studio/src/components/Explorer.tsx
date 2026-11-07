/** Project tree: lazy folders, git status letters, a pulse on entries the agent just changed, click to open. */
import { useMemo, useState } from 'react';
import type { FsEntry } from '@mobile-ide/core';
import { extname, fileKey, joinPath } from '../lib/paths';
import { loadDir, openFile, openNewSession, openPalette, toggleDir } from '../state/controller';
import { useStudio } from '../state/store';
import { Icon } from './Icons';

const HIDE = new Set(['.git', '.DS_Store']);

function fileGlyph(name: string): string {
  const e = extname(name);
  if (/^(ts|tsx|mts|cts)$/.test(e)) return 'TS';
  if (/^(js|jsx|mjs|cjs)$/.test(e)) return 'JS';
  if (e === 'json' || e === 'jsonc') return '{}';
  if (e === 'md' || e === 'mdx') return 'MD';
  if (e === 'css' || e === 'scss' || e === 'less') return '#';
  if (e === 'html' || e === 'htm' || e === 'xml' || e === 'svg') return '<>';
  if (e === 'py') return 'PY';
  if (e === 'rs') return 'RS';
  if (e === 'go') return 'GO';
  if (e === 'sh' || e === 'bash' || e === 'zsh') return '$';
  if (e === 'yml' || e === 'yaml' || e === 'toml') return '≡';
  if (/^(png|jpe?g|gif|webp|ico|pdf)$/.test(e)) return '▣';
  if (name.toLowerCase().startsWith('dockerfile')) return '⛁';
  if (name === 'package.json' || name === 'pnpm-lock.yaml' || name === 'pnpm-workspace.yaml') return 'pkg';
  return '·';
}

export function Explorer({ onOpen }: { onOpen?: () => void }) {
  const [view, setView] = useState<'files' | 'changes'>('files');
  const root = useStudio((s) => s.root);
  const tree = useStudio((s) => s.tree);
  const expanded = useStudio((s) => s.expanded);
  const gitStatus = useStudio((s) => s.gitStatus);
  const recent = useStudio((s) => s.recentChanges);
  const activeKey = useStudio((s) => s.activeKey);
  const projects = useStudio((s) => s.projects);
  const project = projects.find((p) => p.root === root);
  const rootState = root ? tree[''] : undefined;
  const changes = Object.entries(gitStatus);

  if (!root) {
    return (
      <aside className="panel explorer">
        <div className="panel-head">
          <span className="panel-title">Workspace</span>
        </div>
        <div className="panel-empty">
          <Icon name="folder" size={20} />
          <h3>Your project, right here</h3>
          <p>Create a session to browse files and follow your agent's changes.</p>
          <button type="button" className="btn btn-ghost" onClick={() => openNewSession(true)}>
            <Icon name="plus" size={14} />
            New session
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="panel explorer">
      <div className="panel-head">
        <span className="panel-title" title={root}>
          {project?.name ?? root.split('/').filter(Boolean).pop()}
        </span>
        <button type="button" className="icon-btn" title="Find a file" aria-label="Find a file" onClick={() => openPalette(true)}>
          <Icon name="search" size={14} />
        </button>
        <button type="button" className="icon-btn" title="Refresh files" aria-label="Refresh files" onClick={() => void loadDir(root, '')}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <div className="panel-tabs" role="tablist" aria-label="Project view">
        <button type="button" role="tab" aria-selected={view === 'files'} onClick={() => setView('files')}>
          Files
        </button>
        <button type="button" role="tab" aria-selected={view === 'changes'} onClick={() => setView('changes')}>
          Changes <span className="count">{changes.length}</span>
        </button>
      </div>
      {view === 'changes' ? (
        <div className="change-list" role="tabpanel" aria-label="Changed files">
          <p className="section-hint">Changes on disk in this project</p>
          {changes.length ? (
            changes.map(([path, status]) => (
              <button
                type="button"
                className="changed-file"
                key={path}
                onClick={() => {
                  void openFile(root, path, { by: 'user', view: 'diff' });
                  onOpen?.();
                }}
              >
                <Icon name="file" size={14} />
                <span>{path}</span>
                <span className="git-badge">{badgeLetter(status)}</span>
              </button>
            ))
          ) : (
            <div className="panel-empty">
              <Icon name="check" size={20} />
              <h3>All clear</h3>
              <p>Your working tree has no changes.</p>
            </div>
          )}
        </div>
      ) : (
        <div className="tree" role="tree" aria-label="Project files">
          {rootState && 'error' in rootState ? <div className="tree-error">{rootState.error}</div> : null}
          {rootState && 'loading' in rootState ? <TreeSkeleton /> : null}
          {rootState && 'entries' in rootState ? (
            <TreeLevel
              root={root}
              dir=""
              entries={rootState.entries}
              depth={0}
              tree={tree}
              expanded={expanded}
              gitStatus={gitStatus}
              recent={recent}
              activeKey={activeKey}
              onOpen={onOpen}
            />
          ) : null}
          {rootState && 'entries' in rootState && !rootState.entries.length ? (
            <p className="section-hint">This folder is empty. Your agent can add the first file.</p>
          ) : null}
        </div>
      )}
    </aside>
  );
}

function TreeSkeleton() {
  return (
    <div className="tree-skeleton">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="skeleton-row" style={{ width: `${60 + ((i * 17) % 35)}%`, marginLeft: i % 3 === 1 ? 16 : 0 }} />
      ))}
    </div>
  );
}

interface LevelProps {
  root: string;
  dir: string;
  entries: FsEntry[];
  depth: number;
  tree: ReturnType<typeof useStudio.getState>['tree'];
  expanded: string[];
  gitStatus: Record<string, string>;
  recent: Record<string, { ts: number; by: 'agent' | 'disk' }>;
  activeKey: string | null;
  onOpen?: () => void;
}

function TreeLevel({ root, dir, entries, depth, tree, expanded, gitStatus, recent, activeKey, onOpen }: LevelProps) {
  const now = Date.now();
  const visible = useMemo(() => entries.filter((e) => !HIDE.has(e.name)), [entries]);
  return (
    <>
      {visible.map((e) => {
        const path = joinPath(dir, e.name);
        const isDir = e.kind === 'dir';
        const open = isDir && expanded.includes(path);
        const key = fileKey(root, path);
        const change = recent[key];
        const fresh = change && now - change.ts < 60_000;
        const status = gitStatus[path] ?? (isDir ? dirStatus(gitStatus, path) : undefined);
        const sub = tree[path];
        return (
          <div key={path} role="treeitem" aria-expanded={isDir ? open : undefined}>
            <button
              type="button"
              className={`tree-row ${activeKey === key ? 'active' : ''} ${fresh ? `fresh fresh-${change.by}` : ''}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => {
                if (isDir) toggleDir(path);
                else {
                  void openFile(root, path, { by: 'user', view: 'code' });
                  onOpen?.();
                }
              }}
              title={path}
            >
              <span className="tree-chevron">{isDir ? <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} /> : null}</span>
              <span className={`tree-icon ${isDir ? 'dir' : 'file'}`}>
                {isDir ? <Icon name={open ? 'folder-open' : 'folder'} size={14} /> : <span className="glyph">{fileGlyph(e.name)}</span>}
              </span>
              <span className="tree-name">{e.name}</span>
              {status ? <span className={`git-badge git-${badgeLetter(status).toLowerCase()}`}>{badgeLetter(status)}</span> : null}
              {fresh ? <span className="fresh-dot" /> : null}
            </button>
            {open ? (
              sub && 'entries' in sub ? (
                <TreeLevel
                  root={root}
                  dir={path}
                  entries={sub.entries}
                  depth={depth + 1}
                  tree={tree}
                  expanded={expanded}
                  gitStatus={gitStatus}
                  recent={recent}
                  activeKey={activeKey}
                  onOpen={onOpen}
                />
              ) : sub && 'error' in sub ? (
                <div className="tree-error" style={{ paddingLeft: 24 + depth * 14 }}>
                  {sub.error}
                </div>
              ) : (
                <div className="tree-loading" style={{ paddingLeft: 24 + depth * 14 }}>
                  …
                </div>
              )
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/** One letter per entry: porcelain `??` → U (untracked), otherwise the first status code (index first, then worktree). */
function badgeLetter(status: string): string {
  if (status === '•') return '•';
  if (status.startsWith('?')) return 'U';
  const ch = status.replace(/\s/g, '')[0] ?? 'M';
  return ch === '?' ? 'U' : ch.toUpperCase();
}

/** A folder shows a dot when anything below it has a status. */
function dirStatus(gitStatus: Record<string, string>, dir: string): string | undefined {
  const prefix = dir + '/';
  for (const p of Object.keys(gitStatus)) if (p.startsWith(prefix)) return '•';
  return undefined;
}
