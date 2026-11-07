/**
 * The session panel: who is working (agent, status, elapsed, mode), the activity feed (tool calls with clickable files,
 * commands verbatim, assistant prose, thoughts, plan, permission and question cards with real buttons), and a composer
 * so you can talk to the agent from the laptop too.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ElicitationContent,
  ElicitationRequest,
  ElicitationSchema,
  PermissionRequest,
  SessionSummary,
  TimelineItem,
  TimelineState,
  ToolKind,
} from '@mobile-ide/core';
import { describeTool, elicitationDefaults, validateElicitationContent } from '@mobile-ide/core';
import { errorMessage } from '../lib/api';
import { diffStats } from '../lib/diff';
import { basename, shortenPath } from '../lib/paths';
import {
  cancelTurn,
  followSession,
  openFile,
  openNewSession,
  respondElicitation,
  respondPermission,
  sendPrompt,
  setFollow,
  setDraft,
  setElicitationDraft,
  setMode,
  toolFiles,
} from '../state/controller';
import { currentSession, useStudio } from '../state/store';
import { Icon, type IconName } from './Icons';
import { Markdownish } from './Markdownish';

const FEED_WINDOW = 160;

export function SessionRail() {
  const sessions = useStudio((s) => s.sessions);
  const followId = useStudio((s) => s.followSessionId);
  useStudio((s) => s.tick);
  const { summary, timeline } = currentSession(useStudio.getState());
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<'activity' | 'review'>('activity');
  const pending =
    timeline?.items.filter(
      (item) =>
        (item.kind === 'permission' &&
          !item.resolved &&
          timeline.pendingPermissions.some((p) => p.permissionId === item.request.permissionId)) ||
        (item.kind === 'elicitation' && !item.resolved),
    ) ?? [];
  useEffect(() => setView('activity'), [followId]);
  useEffect(() => {
    if (!pickerOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setPickerOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPickerOpen(false);
        pickerRef.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  return (
    <aside className="panel rail">
      <div ref={pickerRef} className="panel-head rail-head">
        <button type="button" className="session-pick" onClick={() => setPickerOpen((o) => !o)} aria-expanded={pickerOpen}>
          <StatusDot status={summary?.status ?? 'closed'} />
          <span className="session-pick-title">{summary?.title ?? 'No session'}</span>
          <Icon name="chevron-down" size={14} />
        </button>
        {pickerOpen ? (
          <div className="session-menu">
            <button
              type="button"
              className="session-menu-item"
              onClick={() => {
                setPickerOpen(false);
                openNewSession(true);
              }}
            >
              <Icon name="plus" size={16} />
              New session
            </button>
            {sessions.length === 0 ? <div className="session-menu-empty">Your sessions will appear here.</div> : null}
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`session-menu-item ${s.id === followId ? 'active' : ''}`}
                onClick={() => {
                  followSession(s.id);
                  setPickerOpen(false);
                }}
              >
                <StatusDot status={s.status} />
                <span className="session-menu-text">
                  <span className="session-menu-title">{s.title}</span>
                  <span className="session-menu-sub">
                    {s.agentName} · {s.projectName}
                  </span>
                </span>
                {s.pendingPermissions ? <span className="pill pill-accent">{s.pendingPermissions}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {summary && timeline ? (
        <>
          <SessionHeader key={`header:${summary.id}`} summary={summary} timeline={timeline} />
          <div className="panel-tabs" role="tablist" aria-label="Agent view">
            <button type="button" role="tab" aria-selected={view === 'activity'} onClick={() => setView('activity')}>
              Activity
            </button>
            <button type="button" role="tab" aria-selected={view === 'review'} onClick={() => setView('review')}>
              Review {pending.length ? <span className="count attention-count">{pending.length}</span> : null}
            </button>
          </div>
          {pending.length && view === 'activity' ? (
            <button type="button" className="attention-banner" onClick={() => setView('review')}>
              <Icon name="hand" size={15} />
              <span>
                {pending.length} request{pending.length === 1 ? '' : 's'} need your attention
              </span>
              <Icon name="chevron-right" size={14} />
            </button>
          ) : null}
          {view === 'activity' ? (
            <Feed key={`feed:${summary.id}`} timeline={timeline} summary={summary} />
          ) : (
            <Review timeline={timeline} summary={summary} pending={pending} />
          )}
          <Composer key={`composer:${summary.id}`} summary={summary} timeline={timeline} />
        </>
      ) : (
        <div className="panel-empty rail-empty">
          <div className="hero-mark small">
            <span className="hero-dot" />
          </div>
          <h3>A partner for the next idea</h3>
          <p>Start a session to plan, write, and review code together. Pick it up from your phone at any time.</p>
          <button type="button" className="btn btn-primary" onClick={() => openNewSession(true)}>
            <Icon name="plus" size={14} />
            New session
          </button>
        </div>
      )}
    </aside>
  );
}

function StatusDot({ status }: { status: SessionSummary['status'] }) {
  return <span className={`status-dot st-${status}`} />;
}

function useNow(everyMs: number, active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs, active]);
  return now;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

function SessionHeader({ summary, timeline }: { summary: SessionSummary; timeline: TimelineState }) {
  const follow = useStudio((s) => s.follow);
  const online = useStudio((s) => s.conn === 'open');
  const [modeBusy, setModeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = timeline.status === 'running' || timeline.status === 'needs_you';
  const now = useNow(1000, running);
  const turnStart = useMemo(() => {
    for (let i = timeline.items.length - 1; i >= 0; i--) {
      const it = timeline.items[i]!;
      if (it.kind === 'user' && it.turnId === timeline.currentTurnId) return it.ts;
    }
    return null;
  }, [timeline.items.length, timeline.currentTurnId]);
  const usage = useMemo(() => {
    let cost = 0;
    let turns = 0;
    for (const it of timeline.items) {
      if (it.kind === 'turn_end') {
        turns++;
        cost += it.usage?.costUsd ?? 0;
      }
    }
    return { cost, turns };
  }, [timeline.items.length]);
  const label =
    timeline.status === 'needs_you'
      ? 'Needs attention'
      : timeline.status === 'idle'
        ? 'Ready'
        : timeline.status === 'running'
          ? 'Working'
          : timeline.status.replace('_', ' ');
  return (
    <div className={`session-header ${running ? 'running' : ''} st-${timeline.status}`}>
      <div className="session-agent">
        <span className="agent-badge">{summary.agentName}</span>
        <span className={`status-chip st-${timeline.status}`}>
          <StatusDot status={timeline.status} />
          {label}
          {running && turnStart ? <span className="elapsed">{fmtDuration(now - turnStart)}</span> : null}
        </span>
      </div>
      <div className="session-meta">
        <span title={summary.cwd}>{summary.projectName}</span>
        {summary.model ? <span>· {summary.model}</span> : null}
        {usage.turns ? (
          <span>
            · {usage.turns} turn{usage.turns === 1 ? '' : 's'}
            {usage.cost ? ` · $${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}` : ''}
          </span>
        ) : null}
      </div>
      <div className="session-controls">
        {timeline.availableModes.length > 0 ? (
          <select
            className="mode-select"
            value={timeline.modeId ?? ''}
            disabled={modeBusy || !online || running || timeline.status === 'starting'}
            onChange={(e) => {
              setModeBusy(true);
              setError(null);
              void setMode(e.target.value, summary.id)
                .catch((err) => setError(errorMessage(err)))
                .finally(() => setModeBusy(false));
            }}
            title="Agent mode"
            aria-label="Agent mode"
          >
            {timeline.availableModes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className={`toggle ${follow ? 'on' : ''}`}
          aria-pressed={follow}
          onClick={() => setFollow(!follow)}
          title="Open and reveal the files the agent edits"
        >
          <Icon name="crosshair" size={13} />
          Follow files
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------- feed
function Feed({ timeline, summary }: { timeline: TimelineState; summary: SessionSummary }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const [count, setCount] = useState(FEED_WINDOW);
  const [away, setAway] = useState(false);
  const previousHeight = useRef<number | null>(null);
  const items = timeline.items.length > count ? timeline.items.slice(-count) : timeline.items;
  const last = timeline.items[timeline.items.length - 1];
  const lastKey = last
    ? `${last.id}:${last.kind === 'assistant' || last.kind === 'thought' ? last.text.length : last.kind === 'tool' ? last.status : ''}`
    : '';

  useEffect(() => {
    const el = ref.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lastKey, timeline.items.length]);
  useEffect(() => {
    if (previousHeight.current === null || !ref.current) return;
    ref.current.scrollTop += ref.current.scrollHeight - previousHeight.current;
    previousHeight.current = null;
  }, [count]);

  return (
    <div className="feed-wrap">
      <div
        className="feed"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          setAway(!stick.current);
        }}
      >
        {timeline.items.length > count ? (
          <button
            type="button"
            className="feed-older"
            onClick={() => {
              previousHeight.current = ref.current?.scrollHeight ?? null;
              stick.current = false;
              setCount((n) => n + FEED_WINDOW);
            }}
          >
            Load {Math.min(FEED_WINDOW, timeline.items.length - count)} earlier updates
          </button>
        ) : null}
        {items.length === 0 ? (
          <div className="feed-empty">
            <Icon name="sparkles" size={22} />
            <h3>Ready when you are</h3>
            <p>Share what you want to build, fix, or understand. Your conversation and progress will appear here.</p>
          </div>
        ) : null}
        {items.map((it) => (
          <FeedItem key={it.id} item={it} summary={summary} pending={timeline.pendingPermissions} />
        ))}
      </div>
      {away ? (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            stick.current = true;
            setAway(false);
            ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
          }}
        >
          <Icon name="chevron-down" size={13} />
          Latest updates
        </button>
      ) : null}
    </div>
  );
}

function Review({ timeline, summary, pending }: { timeline: TimelineState; summary: SessionSummary; pending: TimelineItem[] }) {
  const root = useStudio((s) => s.root);
  const changes = useStudio((s) => s.gitStatus);
  return (
    <div className="review-panel">
      <div className="review-heading">
        <h3>Needs attention</h3>
        <p>Requests stay here until you respond.</p>
      </div>
      {pending.length ? (
        pending.map((item) => <FeedItem key={item.id} item={item} summary={summary} pending={timeline.pendingPermissions} />)
      ) : (
        <div className="review-clear">
          <Icon name="check" size={18} />
          <span>You're all caught up.</span>
        </div>
      )}
      <div className="review-heading">
        <h3>
          Changed files <span className="count">{Object.keys(changes).length}</span>
        </h3>
        <p>Review changes saved on disk.</p>
      </div>
      {root && Object.keys(changes).length ? (
        Object.keys(changes).map((path) => (
          <button type="button" key={path} className="changed-file" onClick={() => void openFile(root, path, { by: 'user', view: 'diff' })}>
            <Icon name="file" size={14} />
            <span>{path}</span>
            <Icon name="chevron-right" size={13} />
          </button>
        ))
      ) : (
        <p className="section-hint">No file changes yet.</p>
      )}
    </div>
  );
}

function toolIcon(kind: ToolKind): IconName {
  switch (kind) {
    case 'read':
      return 'eye';
    case 'edit':
      return 'pencil';
    case 'delete':
      return 'trash';
    case 'move':
      return 'move';
    case 'search':
      return 'search';
    case 'execute':
      return 'terminal';
    case 'think':
      return 'brain';
    case 'fetch':
      return 'globe';
    case 'switch_mode':
      return 'zap';
    default:
      return 'sparkles';
  }
}

function FeedItem({ item, summary, pending }: { item: TimelineItem; summary: SessionSummary; pending: PermissionRequest[] }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="fi fi-user">
          <div className="fi-user-bubble">
            {item.blocks.map((b, i) => (b.type === 'text' ? <span key={i}>{b.text}</span> : <em key={i}>[{b.type}]</em>))}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className={`fi fi-assistant ${item.streaming ? 'streaming' : ''}`}>
          <Markdownish text={item.text} />
          {item.streaming ? <span className="caret" /> : null}
        </div>
      );
    case 'thought':
      return <Thought text={item.text} streaming={item.streaming} />;
    case 'tool':
      return <ToolRow item={item} summary={summary} />;
    case 'plan':
      return (
        <div className="fi fi-plan">
          <div className="fi-label">
            <Icon name="list" size={12} /> Plan
          </div>
          <ul>
            {item.entries.map((e, i) => (
              <li key={i} className={`plan-${e.status}`}>
                <span className="plan-box">{e.status === 'completed' ? <Icon name="check" size={10} /> : null}</span>
                {e.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case 'permission':
      return <PermissionCard item={item} stillPending={pending.some((p) => p.permissionId === item.request.permissionId)} />;
    case 'elicitation':
      return <ElicitationCard item={item} />;
    case 'turn_end':
      return (
        <div className={`fi fi-turnend ${item.stopReason === 'end_turn' ? '' : 'odd'}`}>
          <span>{item.stopReason === 'end_turn' ? 'Turn finished' : `Turn ended: ${item.stopReason.replace(/_/g, ' ')}`}</span>
          {item.usage?.costUsd ? <span>${item.usage.costUsd.toFixed(3)}</span> : null}
        </div>
      );
    case 'error':
      return (
        <div className="fi fi-error">
          <Icon name="alert" size={13} /> {item.message}
        </div>
      );
    default:
      return null;
  }
}

function Thought({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`fi fi-thought ${open ? 'open' : ''}`}>
      <button type="button" className="fi-thought-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="brain" size={12} />
        <span>{streaming ? 'Thinking…' : 'Thought'}</span>
        <span className="muted">{open ? 'hide' : `${Math.max(1, Math.round(text.length / 5))} words`}</span>
      </button>
      {open ? <div className="fi-thought-body">{text}</div> : null}
    </div>
  );
}

function ToolRow({ item, summary }: { item: Extract<TimelineItem, { kind: 'tool' }>; summary: SessionSummary }) {
  const [open, setOpen] = useState(false);
  const root = useStudio((s) => s.root) ?? summary.cwd;
  const projects = useStudio((s) => s.projects);
  const files = useMemo(
    () =>
      toolFiles(
        item,
        root,
        projects.map((p) => p.root),
      ),
    [item, item.status, item.content, root, projects],
  );
  const now = useNow(1000, item.status === 'in_progress' || item.status === 'pending');
  const diffs = item.content.filter((c) => c.type === 'diff');
  const stats = diffs.length
    ? diffs.reduce(
        (acc, d) =>
          d.type === 'diff'
            ? { added: acc.added + diffStats(d.oldText, d.newText).added, removed: acc.removed + diffStats(d.oldText, d.newText).removed }
            : acc,
        { added: 0, removed: 0 },
      )
    : null;
  const description = describeTool(item.title, item.toolKind, item.rawInput);
  const cmd = item.toolKind === 'execute' ? description : null;
  const started = item.startedTs ?? item.ts;
  const duration = item.endedTs ? item.endedTs - started : item.awaitingPermission ? null : now - started;
  const state = item.awaitingPermission ? 'waiting' : item.status;
  const terminal = item.content.find((c) => c.type === 'terminal');
  const textOut = item.content
    .filter((c) => c.type === 'content' && c.content.type === 'text')
    .map((c) => (c.type === 'content' && c.content.type === 'text' ? c.content.text : ''))
    .join('\n');
  return (
    <div className={`fi fi-tool tool-${state} kind-${item.toolKind}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tool-icon">
          <Icon name={toolIcon(item.toolKind)} size={13} />
        </span>
        <span className="tool-title">{cmd ? <code>{cmd}</code> : item.title}</span>
        {stats ? (
          <span className="tool-stats">
            <b className="add">+{stats.added}</b> <b className="del">−{stats.removed}</b>
          </span>
        ) : null}
        <span className={`tool-state`}>
          {state === 'waiting' ? (
            <>
              <Icon name="hand" size={12} /> approval
            </>
          ) : state === 'in_progress' || state === 'pending' ? (
            <span className="spinner" />
          ) : state === 'failed' ? (
            <Icon name="x" size={12} />
          ) : (
            <Icon name="check" size={12} />
          )}
          {duration !== null && (state === 'completed' || state === 'failed' || state === 'in_progress') ? (
            <span className="tool-time">{fmtDuration(duration)}</span>
          ) : null}
        </span>
      </button>
      {files.length ? (
        <div className="tool-files">
          {files.slice(0, 4).map((f) => (
            <button
              key={`${f.root}:${f.path}`}
              type="button"
              className="file-chip"
              onClick={() => void openFile(f.root, f.path, { by: 'user', line: f.line })}
              title={f.path}
            >
              <Icon name="file" size={11} /> {shortenPath(f.path, 40)}
              {f.line ? <span className="muted">:{f.line}</span> : null}
            </button>
          ))}
          {files.length > 4 ? <span className="muted">+{files.length - 4} more</span> : null}
        </div>
      ) : null}
      {open ? (
        <div className="tool-body">
          {item.rawInput !== undefined ? (
            <pre className="raw">
              <code>{typeof item.rawInput === 'string' ? item.rawInput : JSON.stringify(item.rawInput, null, 2)}</code>
            </pre>
          ) : null}
          {terminal && terminal.type === 'terminal' && terminal.output ? (
            <pre className="raw out">
              <code>{terminal.output.slice(-6000)}</code>
            </pre>
          ) : null}
          {textOut ? (
            <pre className="raw out">
              <code>{textOut.slice(0, 6000)}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------- permission
function PermissionCard({ item, stillPending }: { item: Extract<TimelineItem, { kind: 'permission' }>; stillPending: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ optionId: string } | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const online = useStudio((s) => s.conn === 'open');
  const req = item.request;
  const resolved = item.resolved;
  const answer = async (optionId: string | null) => {
    if (busy || !online) return;
    setBusy(optionId ?? 'cancel');
    setError(null);
    try {
      await respondPermission(req.permissionId, optionId, req.sessionId);
      setConfirm(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const chosen = resolved?.optionId ? req.options.find((o) => o.optionId === resolved.optionId) : undefined;
  const diffs = (req.content ?? []).filter((c) => c.type === 'diff');
  const sorted = [...req.options].sort(
    (a, b) =>
      (a.kind === 'allow_once' ? 0 : a.kind === 'allow_always' ? 1 : 2) - (b.kind === 'allow_once' ? 0 : b.kind === 'allow_always' ? 1 : 2),
  );
  return (
    <div className={`fi fi-permission ${stillPending && !resolved ? 'pending' : 'done'}`}>
      <div className="fi-label accent">
        <Icon name="hand" size={12} />
        {stillPending && !resolved
          ? 'Approval requested'
          : resolved?.outcome === 'cancelled'
            ? 'Dismissed'
            : `Answered: ${chosen?.name ?? resolved?.optionId ?? ''}`}
      </div>
      <div className="perm-title">{req.title}</div>
      {diffs.map((d, i) =>
        d.type === 'diff' ? (
          <div key={i} className="perm-diff">
            <div className="perm-diff-path">
              <Icon name="pencil" size={11} />
              {basename(d.path)}
              <span className="muted">{shortenPath(d.path, 50)}</span>
            </div>
            {d.oldText ? <pre className="del">{clip(d.oldText, 1200)}</pre> : null}
            <pre className="add">{clip(d.newText, 1600)}</pre>
          </div>
        ) : null,
      )}
      {req.rawInput !== undefined ? (
        <details className="request-details" open={!diffs.length}>
          <summary>Exact request</summary>
          <pre className="raw">
            <code>{typeof req.rawInput === 'string' ? req.rawInput : JSON.stringify(req.rawInput, null, 2)}</code>
          </pre>
        </details>
      ) : null}
      {stillPending && !resolved ? (
        <>
          {confirm ? (
            <div className="confirmation" role="group" aria-label="Confirm response">
              <p>
                {confirm === 'dismiss'
                  ? 'Dismiss this request and stop the current turn?'
                  : 'Allow future matching actions? Your agent may remember this choice and proceed without asking again.'}
              </p>
              <div className="perm-actions">
                <button
                  className="btn btn-primary btn-sm"
                  type="button"
                  disabled={busy !== null || !online}
                  onClick={() => void answer(confirm === 'dismiss' ? null : confirm.optionId)}
                >
                  {busy ? 'Sending…' : confirm === 'dismiss' ? 'Dismiss and stop' : 'Confirm always allow'}
                </button>
                <button className="btn btn-ghost btn-sm" type="button" disabled={busy !== null} onClick={() => setConfirm(null)}>
                  Go back
                </button>
              </div>
            </div>
          ) : (
            <div className="perm-actions">
              {sorted.map((option) => (
                <button
                  key={option.optionId}
                  type="button"
                  className={`btn btn-sm ${option.kind === 'allow_once' ? 'btn-primary' : option.kind === 'allow_always' ? 'btn-ghost' : 'btn-danger-ghost'}`}
                  disabled={busy !== null || !online}
                  onClick={() =>
                    option.kind === 'allow_always' ? setConfirm({ optionId: option.optionId }) : void answer(option.optionId)
                  }
                >
                  {busy === option.optionId ? 'Sending…' : option.name}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy !== null || !online}
                onClick={() => setConfirm('dismiss')}
              >
                Dismiss
              </button>
            </div>
          )}
          {!online ? <p className="form-help">Reconnect to send your response.</p> : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
}

// ---------------------------------------------------------------------------- elicitation
function ElicitationCard({ item }: { item: Extract<TimelineItem, { kind: 'elicitation' }> }) {
  const req = item.request;
  const savedAnswers = useStudio((s) => s.elicitationDrafts[req.elicitationId]);
  const defaults = useMemo(() => (req.schema ? elicitationDefaults(req.schema) : {}), [req.schema]);
  const answers = savedAnswers ?? defaults;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const online = useStudio((s) => s.conn === 'open');
  const done = !!item.resolved;
  let safeUrl: string | null = null;
  if (req.url) {
    try {
      const url = new URL(req.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') safeUrl = url.href;
    } catch {
      /* Invalid hand-off URL remains visible, never opened. */
    }
  }
  const submit = async (action: 'accept' | 'decline' | 'cancel') => {
    if (busy || !online) return;
    if (action === 'accept' && req.mode === 'form' && req.schema) {
      const errs = validateElicitationContent(req.schema, answers);
      setErrors(errs);
      if (Object.keys(errs).length) return;
    }
    if (action === 'accept' && req.mode === 'url' && !safeUrl) return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'accept' && req.mode === 'url' && safeUrl) window.open(safeUrl, '_blank', 'noopener,noreferrer');
      await respondElicitation(req.elicitationId, action, action === 'accept' && req.mode === 'form' ? answers : undefined, req.sessionId);
      setConfirm(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`fi fi-elicitation ${done ? 'done' : 'pending'}`}>
      <div className="fi-label accent">
        <Icon name={req.mode === 'url' ? 'link' : 'sparkles'} size={12} />
        {done
          ? `Question · ${item.resolved?.action === 'accept' ? 'answered' : item.resolved?.action === 'decline' ? 'skipped' : 'dismissed'}`
          : 'A question for you'}
      </div>
      <div className="perm-title">{req.message}</div>
      {req.mode === 'url' && req.url ? (
        <>
          <code className="url">{req.url}</code>
          <p className="form-help">
            {safeUrl
              ? 'Opens in a new tab. Return here when you have finished.'
              : 'This link cannot be opened. Only http and https links are supported.'}
          </p>
        </>
      ) : null}
      {req.mode === 'form' && req.schema ? (
        <ElicitationForm
          schema={req.schema}
          answers={item.resolved?.content ?? answers}
          errors={errors}
          disabled={done || busy}
          onChange={(content) => setElicitationDraft(req.elicitationId, content)}
        />
      ) : null}
      {!done ? (
        <>
          {confirm ? (
            <div className="confirmation">
              <p>Dismiss this question and stop the current turn?</p>
              <div className="perm-actions">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || !online} onClick={() => void submit('cancel')}>
                  Dismiss and stop
                </button>
                <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => setConfirm(false)}>
                  Go back
                </button>
              </div>
            </div>
          ) : (
            <div className="perm-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || !online || (req.mode === 'url' && !safeUrl)}
                onClick={() => void submit('accept')}
              >
                {busy ? 'Sending…' : req.mode === 'url' ? 'Open link' : 'Send answer'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !online} onClick={() => void submit('decline')}>
                Skip
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !online} onClick={() => setConfirm(true)}>
                Dismiss
              </button>
            </div>
          )}
          {!online ? <p className="form-help">Reconnect to send your response.</p> : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ElicitationForm({
  schema,
  answers,
  errors,
  disabled,
  onChange,
}: {
  schema: ElicitationSchema;
  answers: ElicitationContent;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (a: ElicitationContent) => void;
}) {
  const setField = (name: string, value: ElicitationContent[string] | undefined) => {
    const next = { ...answers };
    if (value === undefined || value === '') delete next[name];
    else next[name] = value;
    onChange(next);
  };
  return (
    <div className="elic-form">
      {Object.entries(schema.properties).map(([name, prop]) => {
        const required = schema.required.includes(name);
        const value = answers[name];
        const err = errors[name];
        return (
          <label key={name} className={`elic-field ${err ? 'invalid' : ''}`}>
            <span className="elic-title">
              {prop.title ?? name}
              {required ? <span className="accent"> *</span> : null}
            </span>
            {prop.description ? <span className="muted small">{prop.description}</span> : null}
            {prop.type === 'string' && prop.options ? (
              <div className="chips">
                {prop.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={`chip ${value === o.value ? 'on' : ''}`}
                    aria-pressed={value === o.value}
                    disabled={disabled}
                    onClick={() => setField(name, value === o.value ? undefined : o.value)}
                    title={o.description}
                  >
                    {o.title}
                  </button>
                ))}
              </div>
            ) : prop.type === 'string' ? (
              <input
                className="input"
                disabled={disabled}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => setField(name, e.target.value)}
              />
            ) : prop.type === 'number' || prop.type === 'integer' ? (
              <input
                className="input"
                type="number"
                disabled={disabled}
                value={typeof value === 'number' ? value : ''}
                onChange={(e) => setField(name, e.target.value === '' ? undefined : Number(e.target.value))}
              />
            ) : prop.type === 'boolean' ? (
              <button
                type="button"
                className={`toggle ${value === true ? 'on' : ''}`}
                aria-pressed={value === true}
                disabled={disabled}
                onClick={() => setField(name, !(value === true))}
              >
                {value === true ? 'Yes' : 'No'}
              </button>
            ) : (
              <div className="chips">
                {prop.options.map((o) => {
                  const arr = Array.isArray(value) ? value : [];
                  const on = arr.includes(o.value);
                  return (
                    <button
                      key={o.value}
                      type="button"
                      className={`chip ${on ? 'on' : ''}`}
                      aria-pressed={on}
                      disabled={disabled}
                      onClick={() => setField(name, on ? arr.filter((v) => v !== o.value) : [...arr, o.value])}
                      title={o.description}
                    >
                      {o.title}
                    </button>
                  );
                })}
              </div>
            )}
            {err ? <span className="elic-error">{err}</span> : null}
          </label>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------- composer
function Composer({ summary, timeline }: { summary: SessionSummary; timeline: TimelineState }) {
  const text = useStudio((s) => s.drafts[summary.id] ?? '');
  const online = useStudio((s) => s.conn === 'open');
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const running = timeline.status === 'running' || timeline.status === 'needs_you';
  const closed = summary.status === 'closed';
  const blocked = running || timeline.status === 'starting' || closed || !online;
  const send = async () => {
    const value = text.trim();
    if (!value || busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      await sendPrompt(value, summary.id);
      if (useStudio.getState().drafts[summary.id] === text) setDraft(summary.id, '');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };
  const stop = async () => {
    if (stopping || !online) return;
    setStopping(true);
    setError(null);
    try {
      await cancelTurn(summary.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStopping(false);
    }
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(180, el.scrollHeight)}px`;
  }, [text]);
  return (
    <div className={`composer ${running ? 'running' : ''}`}>
      <div className="composer-input">
        <textarea
          ref={ref}
          rows={2}
          value={text}
          disabled={closed}
          aria-label={`Message ${summary.agentName}`}
          placeholder={
            closed
              ? 'This session is closed'
              : timeline.status === 'needs_you'
                ? 'Draft your next message while you review…'
                : running
                  ? 'Plan your next step while the agent works…'
                  : 'What would you like to work on?'
          }
          onChange={(e) => setDraft(summary.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="composer-foot">
        <span>
          {!online
            ? 'Offline · draft kept'
            : timeline.status === 'needs_you'
              ? 'Review the pending request to continue'
              : running
                ? 'Working · draft your next message'
                : 'Enter to send · Shift Enter for a new line'}
        </span>
        {running ? (
          <button type="button" className="btn btn-danger-ghost btn-sm" disabled={stopping || !online} onClick={() => void stop()}>
            <Icon name="square" size={12} />
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm send"
            disabled={!text.trim() || busy || blocked}
            onClick={() => void send()}
            aria-label="Send message"
            title="Send (Enter)"
          >
            <Icon name="send" size={14} />
            {busy ? 'Sending…' : 'Send'}
          </button>
        )}
      </div>
    </div>
  );
}

export type { ElicitationRequest };
