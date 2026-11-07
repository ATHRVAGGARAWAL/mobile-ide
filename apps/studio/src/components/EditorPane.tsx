/** Tabs · editor · status line, plus the banners a file can carry (conflict, truncated, missing, binary). */
import { useEffect, useRef } from 'react';
import { Editor } from '../editor/Editor';
import { DiffPreview } from './DiffPreview';
import { basename, formatBytes, shortenPath } from '../lib/paths';
import {
  acceptRemote,
  activateTab,
  closeOtherTabs,
  closeTab,
  keepMine,
  openNewSession,
  openPalette,
  reloadDoc,
  saveDoc,
  setEditorView,
} from '../state/controller';
import { useStudio } from '../state/store';
import { Icon } from './Icons';

const EMPTY: never[] = [];

export function EditorPane() {
  const tabs = useStudio((s) => s.tabs);
  const activeKey = useStudio((s) => s.activeKey);
  const docs = useStudio((s) => s.docs);
  const recent = useStudio((s) => s.recentChanges);
  const pendingAll = useStudio((s) => s.pendingEdits);
  const editorView = useStudio((s) => s.editorView);
  const active = activeKey ? docs[activeKey] : undefined;
  const pending = activeKey ? (pendingAll[activeKey] ?? EMPTY) : EMPTY;
  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeKey) return;
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-key="${cssEscape(activeKey)}"]`);
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeKey]);

  return (
    <section className="panel editor-pane">
      <div className="tabs" ref={stripRef} role="tablist" aria-label="Open files">
        {tabs.map((t) => {
          const d = docs[t.key];
          const change = recent[t.key];
          const fresh = change && Date.now() - change.ts < 6000;
          const ghosts = (pendingAll[t.key] ?? EMPTY).length;
          return (
            <div
              key={t.key}
              data-key={t.key}
              role="tab"
              tabIndex={t.key === activeKey ? 0 : -1}
              aria-selected={t.key === activeKey}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  activateTab(t.key);
                }
                const index = tabs.findIndex((tab) => tab.key === t.key);
                const next =
                  e.key === 'ArrowRight'
                    ? tabs[(index + 1) % tabs.length]
                    : e.key === 'ArrowLeft'
                      ? tabs[(index - 1 + tabs.length) % tabs.length]
                      : e.key === 'Home'
                        ? tabs[0]
                        : e.key === 'End'
                          ? tabs[tabs.length - 1]
                          : undefined;
                if (next) {
                  e.preventDefault();
                  activateTab(next.key);
                  stripRef.current?.querySelector<HTMLElement>(`[data-key="${cssEscape(next.key)}"]`)?.focus();
                }
              }}
              className={`tab ${t.key === activeKey ? 'active' : ''} ${fresh ? 'fresh' : ''} ${ghosts ? 'ghosting' : ''}`}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(t.key);
                } else if (e.button === 0) activateTab(t.key);
              }}
              onAuxClick={(e) => e.preventDefault()}
              onDoubleClick={() => closeOtherTabs(t.key)}
              title={t.path}
            >
              {t.openedBy === 'agent' ? <Icon name="sparkles" size={12} className="tab-agent" /> : null}
              <span className="tab-name">{basename(t.path)}</span>
              {d?.dirty ? <span className="tab-dirty" title="Unsaved changes" /> : null}
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${basename(t.path)}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.key);
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          );
        })}
        {tabs.length === 0 ? (
          <div className="tabs-hint">
            <Icon name="terminal" size={14} /> Workspace
          </div>
        ) : null}
      </div>

      {active && activeKey ? (
        <>
          <div className="editor-toolbar">
            <span title={active.path}>{active.path}</span>
            <div className="segmented" aria-label="File view">
              <button type="button" aria-pressed={editorView === 'code'} onClick={() => setEditorView('code')}>
                Code
              </button>
              <button type="button" aria-pressed={editorView === 'diff'} onClick={() => setEditorView('diff')}>
                Changes
              </button>
            </div>
          </div>
          {active.conflict ? (
            <div className="banner banner-warn">
              <Icon name="alert" size={14} />
              <span>
                <strong>{basename(active.path)}</strong> changed on disk while you were editing it.
              </span>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => acceptRemote(activeKey)}>
                Take disk version
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => keepMine(activeKey)}>
                Keep mine
              </button>
            </div>
          ) : null}
          {active.missing ? (
            <div className="banner banner-warn">
              <Icon name="alert" size={14} />
              <span>This file no longer exists on disk. Saving recreates it.</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reloadDoc(activeKey, 'disk')}>
                Check again
              </button>
            </div>
          ) : null}
          {active.truncated ? (
            <div className="banner">
              <Icon name="alert" size={14} />
              <span>
                Large file: showing the first {formatBytes(active.content.length)} of {formatBytes(active.size)} read-only.
              </span>
            </div>
          ) : null}
          {active.error ? (
            <div className="banner banner-danger">
              <Icon name="alert" size={14} />
              <span>{active.error}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reloadDoc(activeKey, 'disk')}>
                Retry
              </button>
            </div>
          ) : null}
          {editorView === 'diff' ? (
            <DiffPreview key={activeKey} doc={active} />
          ) : active.binary ? (
            <div className="editor-empty">
              <Icon name="file" size={28} />
              <h3>Binary file</h3>
              <p>
                {basename(active.path)} · {formatBytes(active.size)}
              </p>
            </div>
          ) : active.loading && !active.content ? (
            <div className="editor-skeleton">
              {Array.from({ length: 14 }, (_, i) => (
                <div key={i} className="skeleton-row" style={{ width: `${30 + ((i * 37) % 55)}%` }} />
              ))}
            </div>
          ) : (
            <Editor fileKey={activeKey} doc={active} pending={pending} />
          )}
          <StatusLine />
        </>
      ) : (
        <EmptyEditor />
      )}
    </section>
  );
}

function cssEscape(s: string): string {
  return s.replace(/["\\\0]/g, (ch) => (ch === '\0' ? '\\0 ' : `\\${ch}`));
}

function StatusLine() {
  const activeKey = useStudio((s) => s.activeKey);
  const doc = useStudio((s) => (s.activeKey ? s.docs[s.activeKey] : undefined));
  const cursor = useStudio((s) => s.cursor);
  const branch = useStudio((s) => s.gitBranch);
  const lastActivity = useStudio((s) => s.lastActivity);
  const conn = useStudio((s) => s.conn);
  if (!doc || !activeKey) return null;
  const change = doc.lastChange;
  return (
    <div className="statusline">
      <span className="status-path" title={doc.path}>
        {shortenPath(doc.path, 64)}
      </span>
      {branch ? (
        <span className="status-item">
          <Icon name="git-branch" size={12} /> {branch}
        </span>
      ) : null}
      <span className="status-spacer" />
      {change && Date.now() - change.ts < 20_000 ? (
        <span className={`status-item status-change by-${change.by}`}>
          {change.by === 'you' ? 'saved' : change.by === 'agent' ? 'agent wrote' : 'changed on disk'} <b className="add">+{change.added}</b>{' '}
          <b className="del">−{change.removed}</b>
        </span>
      ) : lastActivity && Date.now() - lastActivity.ts < 20_000 ? (
        <span className="status-item status-activity">{lastActivity.text}</span>
      ) : null}
      {doc.dirty ? (
        <button type="button" className="status-item status-save" onClick={() => void saveDoc(activeKey)} title="Save (⌘S)">
          <Icon name="save" size={12} /> {doc.saving ? 'Saving…' : 'Unsaved · ⌘S'}
        </button>
      ) : null}
      <span className="status-item">{doc.language}</span>
      {cursor ? (
        <span className="status-item">
          Ln {cursor.line}, Col {cursor.col}
        </span>
      ) : null}
      <span className={`status-item status-conn conn-${conn}`}>
        <span className="dot" /> {conn === 'open' ? 'live' : conn}
      </span>
    </div>
  );
}

function EmptyEditor() {
  const session = useStudio((s) => s.sessions.find((x) => x.id === s.followSessionId));
  const follow = useStudio((s) => s.follow);
  return (
    <div className="editor-empty hero">
      <div className="welcome-mark">
        <Icon name="terminal" size={28} />
      </div>
      <span className="eyebrow">Your space to make things</span>
      <h2>{session ? 'See the work take shape.' : 'A little focus. A lot of possibility.'}</h2>
      <p className="muted">
        {session
          ? follow
            ? `${session.agentName} is ready. Files open here as the agent works, with every change yours to review.`
            : 'Open a file to explore your project. Turn on Follow files in the Agent panel to watch edits as they happen.'
          : 'Choose your project, give your agent a task, and build with your code and conversation side by side.'}
      </p>
      <div className="welcome-actions">
        <button type="button" className="btn btn-primary" onClick={() => openNewSession(true)}>
          <Icon name="plus" size={15} />
          New session
        </button>
        {session ? (
          <button type="button" className="btn btn-ghost" onClick={() => openPalette(true)}>
            <Icon name="search" size={15} />
            Find a file
          </button>
        ) : null}
      </div>
      <div className="welcome-steps">
        <div>
          <span>01</span>
          <strong>Set the direction</strong>
          <p>Build an idea, fix a bug, or review a change.</p>
        </div>
        <div>
          <span>02</span>
          <strong>Follow the work</strong>
          <p>See agent edits appear in your files live.</p>
        </div>
        <div>
          <span>03</span>
          <strong>Make it yours</strong>
          <p>Review requests, refine the code, and save.</p>
        </div>
      </div>
      <div className="hero-keys">
        <span>
          <kbd>⌘</kbd>
          <kbd>K</kbd> find anything
        </span>
        <span>
          <kbd>⌘</kbd>
          <kbd>S</kbd> save
        </span>
        <span>
          <kbd>⌘</kbd>
          <kbd>B</kbd> explorer
        </span>
        <span>
          <kbd>⌘</kbd>
          <kbd>J</kbd> session panel
        </span>
      </div>
    </div>
  );
}
