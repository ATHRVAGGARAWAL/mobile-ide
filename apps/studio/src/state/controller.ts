/**
 * Everything that changes the store: the daemon connection (core's MideClient), session following, the workspace
 * tree, open files, and the live path — an agent's tool call names a file → the file opens → its folder is watched →
 * the write lands → the document is patched in place with the changed lines lit up.
 */
import {
  applyEnvelope,
  createTimeline,
  MideClient,
  STUDIO_CLIENT_NAME,
  type ElicitationAction,
  type ElicitationContent,
  type EventEnvelope,
  type FsChange,
  type SessionSummary,
  type TimelineItem,
  type TimelineState,
  type ToolContent,
} from '@mobile-ide/core';
import { api, ApiError, errorMessage, setApiToken } from '../lib/api';
import { BASE_URL, clearAuth, loadAuth, pairWithCode, readLaunchParams } from '../lib/auth';
import { computeLiveDiff } from '../lib/diff';
import { newlyRunningSession } from '../lib/session-follow';
import { dirname, fileKey, joinPath, relativeTo, splitKey } from '../lib/paths';
import { editors } from '../editor/registry';
import { currentSession, savePrefs, toast, useStudio, type Doc, type PendingEdit, type Tab } from './store';

const STUDIO_VERSION = '0.1.0';
const MAX_TABS = 24;
/** a pending (ghost) edit older than this is dropped even if the disk never reported it */
const PENDING_EDIT_TTL_MS = 90_000;

let client: MideClient | null = null;
let launchSession: string | null = null;
/** dirs currently watched, `${root}\0${dir}` */
const watched = new Set<string>();
const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
const treeTimers = new Map<string, ReturnType<typeof setTimeout>>();
let switchedAt = 0;
/** sessions whose replay finished — only then do tool events count as *live* activity (files open, ghosts appear) */
const liveSessions = new Set<string>();
/** an event this fresh is treated as live even during a replay (a subscribe in the middle of a turn) */
const LIVE_EVENT_MAX_AGE_MS = 15_000;

const set = useStudio.setState;
const get = useStudio.getState;

// ---------------------------------------------------------------------------- boot + auth
export async function boot(): Promise<void> {
  const params = readLaunchParams();
  launchSession = params.session;
  let auth = loadAuth();
  if (params.pair) {
    set({ auth: 'pairing' });
    try {
      auth = await pairWithCode(params.pair);
    } catch (err) {
      // the code may have been spent by an earlier load of this very window — a stored token still works then
      if (!auth) {
        set({ auth: 'unpaired', authError: errorMessage(err) });
        return;
      }
    }
  }
  if (!auth) {
    set({ auth: 'unpaired', authError: null });
    return;
  }
  setApiToken(auth.token);
  try {
    await api.me();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearAuth();
      setApiToken(null);
      set({ auth: 'unpaired', authError: 'This window is no longer paired with the daemon.' });
      return;
    }
    set({ auth: 'error', authError: errorMessage(err) });
    return;
  }
  set({ auth: 'ready', authError: null, serverName: auth.serverName ?? '' });
  connect(auth.token);
  void loadProjects();
}

function connect(token: string): void {
  client?.close();
  client = new MideClient({
    baseUrl: BASE_URL,
    token,
    clientName: STUDIO_CLIENT_NAME,
    clientVersion: STUDIO_VERSION,
    onEvent: onEvent,
    onReplayDone: (sessionId) => {
      liveSessions.add(sessionId);
      set({ tick: get().tick + 1 });
    },
    onSessions: onSessions,
    onFsChanged: onFsChanged,
    onState: (state, detail) => {
      const prev = get().conn;
      set({ conn: state, connDetail: detail ?? null });
      if (state === 'open' && prev !== 'open') onConnected();
      if (detail === 'unauthorized') {
        clearAuth();
        set({
          auth: 'unpaired',
          authError: 'The daemon rejected this window’s token. Open the Studio again from the daemon (mide studio).',
        });
      }
    },
    onServerError: (message, code) => {
      if (code === 'protocol_version') toast('error', `Protocol mismatch: ${message}`);
      else if (!/^subscribe /.test(message)) toast('error', message);
    },
    maxBackoffMs: 10_000,
    pingIntervalMs: 20_000,
  });
  client.connect();
  client.watchSessionList();
}

function onConnected(): void {
  void api
    .health()
    .then((h) => set({ serverName: h.serverName, serverVersion: h.version }))
    .catch(() => undefined);
  // Files may have changed while we were away: reload every open document once.
  for (const key of Object.keys(get().docs)) scheduleReload(key, 'disk');
}

// ---------------------------------------------------------------------------- sessions
function onSessions(sessions: SessionSummary[]): void {
  const previous = get().sessions;
  const open = sessions.filter((s) => s.status !== 'closed').sort((a, b) => b.updatedAt - a.updatedAt);
  set({ sessions: open });
  const s = get();
  if (launchSession && open.some((x) => x.id === launchSession)) {
    const id = launchSession;
    launchSession = null;
    followSession(id);
    return;
  }
  if (s.followSessionId && !open.some((x) => x.id === s.followSessionId)) {
    // the followed session was closed: move to the most recent one
    const next = open[0];
    if (next) followSession(next.id);
    else set({ followSessionId: null });
    return;
  }
  if (!s.followSessionId) {
    const first = open[0];
    if (first) followSession(first.id);
    return;
  }
  if (s.autoSwitch) {
    const started = newlyRunningSession(open, previous, switchedAt);
    if (started && started.id !== s.followSessionId) {
      followSession(started.id);
      toast('info', `Following “${started.title}”`);
      return;
    }
    const newest = open.reduce<SessionSummary | null>((acc, x) => (acc === null || x.createdAt > acc.createdAt ? x : acc), null);
    if (newest && newest.id !== s.followSessionId && newest.createdAt > switchedAt && newest.status !== 'error') {
      followSession(newest.id);
      toast('info', `Following the new session “${newest.title}”`);
    }
  }
}

export function followSession(id: string): void {
  const s = get();
  const summary = s.sessions.find((x) => x.id === id);
  if (!summary) return;
  switchedAt = Math.max(switchedAt, summary.createdAt, Date.now());
  const timeline = s.timelines[id] ?? createTimeline(id);
  set({ followSessionId: id, timelines: { ...s.timelines, [id]: timeline } });
  if (timeline.lastSeq < 0) liveSessions.delete(id); // a brand-new subscription starts with history
  client?.subscribe(id, Math.max(0, timeline.lastSeq));
  if (summary.cwd !== s.root) setRoot(summary.cwd);
}

function onEvent(env: EventEnvelope): void {
  const s = get();
  let tl = s.timelines[env.sessionId];
  if (!tl) {
    tl = createTimeline(env.sessionId);
    set({ timelines: { ...s.timelines, [env.sessionId]: tl } });
  }
  const before = tl.lastSeq;
  applyEnvelope(tl, env);
  if (tl.lastSeq === before) return;
  set({ tick: get().tick + 1 });
  if (env.sessionId !== get().followSessionId) return;
  // History is for the feed only: opening files and drawing ghosts for edits made an hour ago would be noise.
  if (!liveSessions.has(env.sessionId) && Date.now() - env.ts > LIVE_EVENT_MAX_AGE_MS) return;
  const e = env.event;
  if (e.type === 'tool.call' || e.type === 'tool.update') {
    const item = toolItem(tl, e.toolCallId);
    if (item) onToolActivity(item, env.ts);
  } else if (e.type === 'permission.requested' && e.request.toolCallId) {
    const item = toolItem(tl, e.request.toolCallId);
    if (item) onToolActivity(item, env.ts);
  } else if (e.type === 'permission.resolved') {
    // the gated tool is running now; a rejected one never writes, so drop its ghost
    if (e.outcome === 'cancelled' || (e.optionId && /reject/i.test(e.optionId))) {
      const perm = tl.items.find((it) => it.kind === 'permission' && it.request.permissionId === e.permissionId);
      const toolCallId = perm && perm.kind === 'permission' ? perm.request.toolCallId : undefined;
      if (toolCallId) dropPendingForTool(toolCallId);
    }
  }
}

function toolItem(tl: TimelineState, toolCallId: string): Extract<TimelineItem, { kind: 'tool' }> | undefined {
  const idx = tl.toolIndex[toolCallId];
  const it = idx === undefined ? undefined : tl.items[idx];
  return it && it.kind === 'tool' ? it : undefined;
}

/** Files named by a tool call: diff blocks, locations and the usual rawInput keys, made root-relative. */
export function toolFiles(
  item: Extract<TimelineItem, { kind: 'tool' }>,
  root: string,
  projectRoots: string[],
): { path: string; root: string; line?: number }[] {
  const out = new Map<string, { path: string; root: string; line?: number }>();
  const add = (raw: unknown, line?: number): void => {
    if (typeof raw !== 'string' || !raw) return;
    const resolved = resolvePath(raw, root, projectRoots);
    if (!resolved) return;
    const key = fileKey(resolved.root, resolved.path);
    if (!out.has(key)) out.set(key, line !== undefined ? { ...resolved, line } : resolved);
  };
  for (const c of item.content) if (c.type === 'diff') add(c.path);
  for (const loc of item.locations) add(loc.path, loc.line);
  const ri = item.rawInput;
  if (ri && typeof ri === 'object') {
    const r = ri as Record<string, unknown>;
    for (const k of ['file_path', 'filePath', 'filepath', 'path', 'file', 'notebook_path']) add(r[k]);
  }
  return [...out.values()].filter((f) => f.path !== '');
}

function resolvePath(raw: string, root: string, projectRoots: string[]): { root: string; path: string } | null {
  const p = raw.replace(/\\/g, '/');
  if (!p.startsWith('/')) return { root, path: p.replace(/^\.\//, '') };
  const rel = relativeTo(root, p);
  if (rel !== null) return { root, path: rel };
  for (const r of projectRoots) {
    const alt = relativeTo(r, p);
    if (alt !== null) return { root: r, path: alt };
  }
  return null;
}

function onToolActivity(item: Extract<TimelineItem, { kind: 'tool' }>, ts: number): void {
  const s = get();
  const root = s.root;
  if (!root) return;
  const files = toolFiles(
    item,
    root,
    s.projects.map((p) => p.root),
  );
  if (files.length === 0) return;
  const writes =
    item.toolKind === 'edit' || item.toolKind === 'delete' || item.toolKind === 'move' || item.content.some((c) => c.type === 'diff');
  const diffs = item.content.filter((c): c is Extract<ToolContent, { type: 'diff' }> => c.type === 'diff');
  // ghost edits for the files a diff names
  if (writes && diffs.length) {
    const pending = { ...get().pendingEdits };
    for (const d of diffs) {
      const resolved = resolvePath(
        d.path,
        root,
        s.projects.map((p) => p.root),
      );
      if (!resolved) continue;
      const key = fileKey(resolved.root, resolved.path);
      const entry: PendingEdit = {
        key,
        toolCallId: item.toolCallId,
        oldText: d.oldText,
        newText: d.newText,
        status: item.status,
        awaitingPermission: !!item.awaitingPermission,
        title: item.title,
        ts,
      };
      const list = (pending[key] ?? []).filter((p) => p.toolCallId !== item.toolCallId && ts - p.ts < PENDING_EDIT_TTL_MS);
      // a finished edit whose result is already in the document we hold needs no ghost (the reducer keeps the diff on
      // the completed card, so completion updates arrive with the diff still attached)
      const doc = s.docs[key];
      const landed =
        item.status === 'completed' &&
        doc !== undefined &&
        !doc.loading &&
        d.newText !== '' &&
        doc.content.includes(d.newText.replace(/\n$/, ''));
      if (item.status !== 'failed' && !landed) list.push(entry);
      if (list.length) pending[key] = list;
      else delete pending[key];
    }
    set({ pendingEdits: pending });
  } else if (item.status === 'failed') dropPendingForTool(item.toolCallId);
  if (writes) {
    const agent = currentSession(get()).summary?.agentName ?? 'the agent';
    const first = files[0]!;
    set({ lastActivity: { text: `${agent} ${item.status === 'completed' ? 'edited' : 'is editing'} ${first.path}`, ts } });
    // the write may already be on disk (completion often arrives after the inotify burst) — make sure we saw it
    if (item.status === 'completed') for (const f of files) scheduleReload(fileKey(f.root, f.path), 'agent', 250);
  }
  if (s.follow && (writes || item.toolKind === 'read')) {
    const first = files[0]!;
    void openFile(first.root, first.path, { by: 'agent', line: first.line, activate: writes || !get().activeKey });
  }
}

function dropPendingForTool(toolCallId: string): void {
  const pending = { ...get().pendingEdits };
  let changed = false;
  for (const [key, list] of Object.entries(pending)) {
    const next = list.filter((p) => p.toolCallId !== toolCallId);
    if (next.length !== list.length) {
      changed = true;
      if (next.length) pending[key] = next;
      else delete pending[key];
    }
  }
  if (changed) set({ pendingEdits: pending });
}

// ---------------------------------------------------------------------------- workspace
async function loadProjects(): Promise<void> {
  try {
    set({ projects: await api.projects() });
  } catch (err) {
    toast('error', `Projects: ${errorMessage(err)}`);
  }
}

export function setRoot(root: string): void {
  const s = get();
  if (s.root === root) return;
  set({ root, tree: {}, expanded: [], gitBranch: null, gitStatus: {} });
  void loadDir(root, '');
  void refreshGit(root);
  syncWatches();
}

export async function loadDir(root: string, dir: string): Promise<void> {
  set((s) => ({ tree: { ...s.tree, [dir]: { loading: true } } }));
  try {
    const entries = await api.fsTree(root, dir);
    if (get().root !== root) return;
    set((s) => ({ tree: { ...s.tree, [dir]: { entries, loadedAt: Date.now() } } }));
  } catch (err) {
    if (get().root !== root) return;
    set((s) => ({ tree: { ...s.tree, [dir]: { error: errorMessage(err) } } }));
  }
}

export function toggleDir(dir: string): void {
  const s = get();
  const root = s.root;
  if (!root) return;
  if (s.expanded.includes(dir)) {
    set({ expanded: s.expanded.filter((d) => d !== dir && !d.startsWith(dir + '/')) });
  } else {
    set({ expanded: [...s.expanded, dir] });
    if (!s.tree[dir]) void loadDir(root, dir);
  }
  syncWatches();
}

/** Expand every ancestor of `path` so it is visible in the explorer. */
export function revealInTree(path: string): void {
  const s = get();
  const root = s.root;
  if (!root) return;
  const parts = dirname(path).split('/').filter(Boolean);
  const dirs: string[] = [];
  let acc = '';
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    dirs.push(acc);
  }
  const missing = dirs.filter((d) => !s.expanded.includes(d));
  if (missing.length) {
    set({ expanded: [...s.expanded, ...missing] });
    for (const d of missing) if (!get().tree[d]) void loadDir(root, d);
    syncWatches();
  }
}

async function refreshGit(root: string): Promise<void> {
  try {
    const st = await api.gitStatus(root);
    if (get().root !== root) return;
    const map: Record<string, string> = {};
    for (const e of st.entries) map[e.path] = `${e.index}${e.worktree}`.replace(/\s/g, '').slice(0, 2) || 'M';
    set({ gitBranch: st.branch ?? null, gitStatus: map });
  } catch {
    if (get().root === root) set({ gitBranch: null, gitStatus: {} });
  }
}

let gitTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleGitRefresh(): void {
  if (gitTimer) return;
  gitTimer = setTimeout(() => {
    gitTimer = null;
    const root = get().root;
    if (root) void refreshGit(root);
  }, 600);
}

// ---------------------------------------------------------------------------- watches
/** The set of directories worth watching: the root, every open file's folder, every expanded folder. */
function syncWatches(): void {
  const s = get();
  const root = s.root;
  const wanted = new Set<string>();
  if (root) {
    wanted.add(`${root}\0`);
    for (const d of s.expanded) wanted.add(`${root}\0${d}`);
  }
  for (const tab of s.tabs) wanted.add(`${tab.root}\0${dirname(tab.path)}`);
  for (const key of [...watched]) {
    if (!wanted.has(key)) {
      const { root: r, path } = splitKey(key);
      client?.unwatchDir(r, path);
      watched.delete(key);
    }
  }
  for (const key of wanted) {
    if (watched.has(key)) continue;
    watched.add(key);
    const { root: r, path } = splitKey(key);
    client?.watchDir(r, path).catch((err) => {
      watched.delete(key);
      const msg = errorMessage(err);
      if (!/not found|ENOENT/i.test(msg)) toast('error', `Live watch for ${path || '/'} failed: ${msg}`);
    });
  }
}

function onFsChanged(change: FsChange): void {
  const s = get();
  if (change.gone) {
    watched.delete(`${change.root}\0${change.dir}`);
    if (s.root === change.root && s.tree[change.dir]) scheduleTreeRefresh(change.root, change.dir);
    return;
  }
  const now = change.ts;
  const recent = { ...s.recentChanges };
  for (const name of change.names) {
    const path = joinPath(change.dir, name);
    const key = fileKey(change.root, path);
    const byAgent =
      (s.pendingEdits[key]?.length ?? 0) > 0 ||
      (s.lastActivity !== null && now - s.lastActivity.ts < 4000 && s.lastActivity.text.endsWith(path));
    recent[key] = { key, ts: now, by: byAgent ? 'agent' : 'disk' };
    if (s.docs[key]) scheduleReload(key, byAgent ? 'agent' : 'disk');
  }
  // keep the map small
  const keys = Object.keys(recent);
  if (keys.length > 200) for (const k of keys.sort((a, b) => recent[a]!.ts - recent[b]!.ts).slice(0, keys.length - 200)) delete recent[k];
  set({ recentChanges: recent });
  if (s.root === change.root && s.tree[change.dir]) scheduleTreeRefresh(change.root, change.dir);
  if (change.names.some((n) => n === '.git' || n.startsWith('.git'))) scheduleGitRefresh();
  else if (s.root === change.root) scheduleGitRefresh();
}

function scheduleTreeRefresh(root: string, dir: string): void {
  const key = `${root}\0${dir}`;
  const existing = treeTimers.get(key);
  if (existing) clearTimeout(existing);
  treeTimers.set(
    key,
    setTimeout(() => {
      treeTimers.delete(key);
      if (get().root !== root) return;
      void api
        .fsTree(root, dir)
        .then((entries) => {
          if (get().root !== root) return;
          set((s) => ({ tree: { ...s.tree, [dir]: { entries, loadedAt: Date.now() } } }));
        })
        .catch(() => {
          // the folder is gone: drop it and its children from the tree
          set((s) => {
            const tree = { ...s.tree };
            for (const k of Object.keys(tree)) if (k === dir || k.startsWith(dir + '/')) delete tree[k];
            return { tree, expanded: s.expanded.filter((d) => d !== dir && !d.startsWith(dir + '/')) };
          });
          syncWatches();
        });
    }, 120),
  );
}

// ---------------------------------------------------------------------------- files
export interface OpenOptions {
  by?: 'user' | 'agent';
  line?: number;
  /** make it the active tab (default true) */
  activate?: boolean;
  view?: 'code' | 'diff';
}

export async function openFile(root: string, path: string, opts: OpenOptions = {}): Promise<void> {
  const key = fileKey(root, path);
  const s = get();
  const activate = opts.activate ?? true;
  let tabs = s.tabs;
  if (!tabs.some((t) => t.key === key)) {
    const tab: Tab = { key, root, path, openedBy: opts.by ?? 'user' };
    tabs = [...tabs, tab];
    // agent-opened, untouched tabs are the first to go when the strip fills up
    while (tabs.length > MAX_TABS) {
      const victim =
        tabs.find((t) => t.key !== key && t.openedBy === 'agent' && !s.docs[t.key]?.dirty && t.key !== s.activeKey) ??
        tabs.find((t) => t.key !== key && !s.docs[t.key]?.dirty);
      if (!victim) break;
      tabs = tabs.filter((t) => t !== victim);
    }
  }
  const patch: Partial<typeof s> = { tabs };
  if (activate) patch.activeKey = key;
  if (opts.view) patch.editorView = opts.view;
  if (opts.by === 'user' && activate) patch.workspaceView = 'editor';
  set(patch);
  if (root === s.root) revealInTree(path);
  syncWatches();
  if (opts.line !== undefined) editors.requestReveal(key, opts.line);
  if (!s.docs[key]) await loadDoc(key);
}

async function loadDoc(key: string): Promise<void> {
  const { root, path } = splitKey(key);
  set((s) => ({
    docs: {
      ...s.docs,
      [key]: s.docs[key] ?? {
        root,
        path,
        content: '',
        language: 'text',
        size: 0,
        truncated: false,
        binary: false,
        loading: true,
        dirty: false,
        version: 0,
      },
    },
  }));
  try {
    const file = await api.fsFile(root, path);
    set((s) => {
      const prev = s.docs[key];
      if (!prev) return {};
      const doc: Doc = { ...prev, ...file, root, path, loading: false, error: undefined, missing: false, version: prev.version + 1 };
      return { docs: { ...s.docs, [key]: doc } };
    });
    settlePending(key, file.content);
  } catch (err) {
    set((s) => {
      const prev = s.docs[key];
      if (!prev) return {};
      const missing = err instanceof ApiError && err.status === 404;
      return { docs: { ...s.docs, [key]: { ...prev, loading: false, error: missing ? undefined : errorMessage(err), missing } } };
    });
  }
}

function scheduleReload(key: string, by: 'agent' | 'disk', delay = 60): void {
  const existing = reloadTimers.get(key);
  if (existing) clearTimeout(existing);
  reloadTimers.set(
    key,
    setTimeout(() => {
      reloadTimers.delete(key);
      void reloadDoc(key, by);
    }, delay),
  );
}

/** Re-read a file from disk and patch the document (or raise a conflict when the editor holds unsaved edits). */
export async function reloadDoc(key: string, by: 'agent' | 'disk'): Promise<void> {
  const before = get().docs[key];
  if (!before || before.loading) return;
  const { root, path } = splitKey(key);
  let file;
  try {
    file = await api.fsFile(root, path);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      set((s) => {
        const d = s.docs[key];
        return d ? { docs: { ...s.docs, [key]: { ...d, missing: true } } } : {};
      });
    }
    return;
  }
  const s = get();
  const doc = s.docs[key];
  if (!doc) return;
  if (file.binary || file.content === doc.content) {
    if (file.mtime !== doc.mtime) set({ docs: { ...s.docs, [key]: { ...doc, mtime: file.mtime, size: file.size, missing: false } } });
    settlePending(key, file.content);
    return;
  }
  if (doc.dirty) {
    set({ docs: { ...s.docs, [key]: { ...doc, conflict: file, missing: false } } });
    toast('info', `${path} changed on disk while you were editing it`);
    return;
  }
  const stats = computeLiveDiff(doc.content, file.content);
  const agentName = currentSession(s).summary?.agentName ?? 'the agent';
  set({
    docs: {
      ...s.docs,
      [key]: {
        ...doc,
        ...file,
        loading: false,
        missing: false,
        error: undefined,
        version: doc.version + 1,
        lastChange: { ts: Date.now(), by, added: stats.addedLines, removed: stats.removedLines },
      },
    },
    lastActivity: {
      text: `${by === 'agent' ? agentName : 'Disk'} changed ${path} (+${stats.addedLines} −${stats.removedLines})`,
      ts: Date.now(),
    },
  });
  settlePending(key, file.content);
}

/** Ghost edits whose result is now on disk (or that are long stale) disappear. */
function settlePending(key: string, content: string): void {
  const s = get();
  const list = s.pendingEdits[key];
  if (!list || list.length === 0) return;
  const now = Date.now();
  const keep = list.filter((p) => {
    if (now - p.ts > PENDING_EDIT_TTL_MS) return false;
    if (p.newText !== '' && content.includes(p.newText.replace(/\n$/, ''))) return false;
    if (p.oldText !== null && p.oldText !== '' && !content.includes(p.oldText.replace(/\n$/, '')) && p.status === 'completed') return false;
    return true;
  });
  if (keep.length !== list.length) {
    const pending = { ...s.pendingEdits };
    if (keep.length) pending[key] = keep;
    else delete pending[key];
    set({ pendingEdits: pending });
  }
}

export function activateTab(key: string): void {
  set({ activeKey: key });
}

export function closeTab(key: string): void {
  const s = get();
  const doc = s.docs[key];
  if (doc?.dirty && !confirm(`${doc.path} has unsaved changes. Close anyway?`)) return;
  const idx = s.tabs.findIndex((t) => t.key === key);
  const tabs = s.tabs.filter((t) => t.key !== key);
  let activeKey = s.activeKey;
  if (activeKey === key) activeKey = tabs[Math.min(idx, tabs.length - 1)]?.key ?? null;
  const docs = { ...s.docs };
  delete docs[key];
  set({ tabs, activeKey, docs });
  editors.dispose(key);
  syncWatches();
}

export function closeOtherTabs(key: string): void {
  for (const t of get().tabs) if (t.key !== key) closeTab(t.key);
}

/** Editor → store: the buffer differs from disk (or not). */
export function markDirty(key: string, dirty: boolean): void {
  const doc = get().docs[key];
  if (!doc || doc.dirty === dirty) return;
  set((s) => ({ docs: { ...s.docs, [key]: { ...s.docs[key]!, dirty } } }));
}

export function setCursor(line: number, col: number): void {
  const c = get().cursor;
  if (c && c.line === line && c.col === col) return;
  set({ cursor: { line, col } });
}

export async function saveDoc(key: string): Promise<void> {
  const s = get();
  const doc = s.docs[key];
  if (!doc || doc.saving || doc.binary) return;
  const text = editors.text(key);
  if (text === null) return;
  set({ docs: { ...s.docs, [key]: { ...doc, saving: true } } });
  try {
    const res = await api.fsWrite({
      root: doc.root,
      path: doc.path,
      content: text,
      expectedMtime: doc.missing ? undefined : doc.mtime,
      createDirs: true,
    });
    const stats = computeLiveDiff(doc.content, text);
    set((st) => ({
      docs: {
        ...st.docs,
        [key]: {
          ...st.docs[key]!,
          content: text,
          mtime: res.mtime,
          size: res.size,
          saving: false,
          dirty: false,
          conflict: undefined,
          missing: false,
          lastChange: { ts: Date.now(), by: 'you', added: stats.addedLines, removed: stats.removedLines },
        },
      },
      lastActivity: { text: `Saved ${doc.path}`, ts: Date.now() },
    }));
  } catch (err) {
    set((st) => ({ docs: { ...st.docs, [key]: { ...st.docs[key]!, saving: false } } }));
    if (err instanceof ApiError && err.status === 409) {
      toast('error', `${doc.path} changed on disk — reload it, then save again`);
      void reloadDoc(key, 'disk');
    } else toast('error', `Save failed: ${errorMessage(err)}`);
  }
}

/** Conflict banner: take what is on disk (drops the local edits). */
export function acceptRemote(key: string): void {
  const s = get();
  const doc = s.docs[key];
  if (!doc?.conflict) return;
  const file = doc.conflict;
  const stats = computeLiveDiff(doc.content, file.content);
  set({
    docs: {
      ...s.docs,
      [key]: {
        ...doc,
        ...file,
        dirty: false,
        conflict: undefined,
        version: doc.version + 1,
        lastChange: { ts: Date.now(), by: 'disk', added: stats.addedLines, removed: stats.removedLines },
      },
    },
  });
  editors.replaceAll(key, file.content);
}

/** Conflict banner: keep the editor's text; the next save overwrites the disk version. */
export function keepMine(key: string): void {
  const s = get();
  const doc = s.docs[key];
  if (!doc?.conflict) return;
  set({ docs: { ...s.docs, [key]: { ...doc, mtime: doc.conflict.mtime, conflict: undefined } } });
}

// ---------------------------------------------------------------------------- session actions
export async function sendPrompt(text: string, sessionId?: string): Promise<void> {
  const id = sessionId ?? get().followSessionId;
  if (!client || !id) throw new Error('no session');
  if (get().conn !== 'open') throw new Error('Reconnect to send your message. Your draft is kept here.');
  const timeline = get().timelines[id];
  if (timeline?.status === 'running' || timeline?.status === 'needs_you' || timeline?.status === 'starting') {
    throw new Error('Wait for this turn to finish before sending your next message.');
  }
  await client.prompt(id, [{ type: 'text', text }]);
}

export async function cancelTurn(sessionId?: string): Promise<void> {
  const id = sessionId ?? get().followSessionId;
  if (!client || !id) return;
  await client.cancel(id);
}

export async function respondPermission(permissionId: string, optionId: string | null, sessionId?: string): Promise<void> {
  const id = sessionId ?? get().followSessionId;
  if (!client || !id) return;
  if (optionId === null) await client.respondPermission(id, permissionId, 'cancelled');
  else await client.respondPermission(id, permissionId, 'selected', optionId);
}

export async function respondElicitation(
  elicitationId: string,
  action: ElicitationAction,
  content?: ElicitationContent,
  sessionId?: string,
): Promise<void> {
  const id = sessionId ?? get().followSessionId;
  if (!client || !id) return;
  await client.respondElicitation(id, elicitationId, action, content);
}

export async function setMode(modeId: string, sessionId?: string): Promise<void> {
  const id = sessionId ?? get().followSessionId;
  if (!client || !id) return;
  await client.setMode(id, modeId);
}

export async function closeSession(id: string): Promise<void> {
  await api.closeSession(id);
}

export async function createStudioSession(input: Parameters<typeof api.createSession>[0]): Promise<SessionSummary> {
  const summary = await api.createSession(input);
  set((s) => ({
    sessions: [summary, ...s.sessions.filter((item) => item.id !== summary.id)],
    newSessionOpen: false,
    railOpen: true,
    workspaceView: 'session',
  }));
  followSession(summary.id);
  void loadProjects();
  return summary;
}

export function setDraft(sessionId: string, text: string): void {
  set((s) => ({ drafts: { ...s.drafts, [sessionId]: text } }));
}

export function setElicitationDraft(elicitationId: string, content: ElicitationContent): void {
  set((s) => ({ elicitationDrafts: { ...s.elicitationDrafts, [elicitationId]: content } }));
}

export function setEditorView(editorView: 'code' | 'diff'): void {
  set({ editorView });
}

export function setWorkspaceView(workspaceView: 'files' | 'editor' | 'session'): void {
  set({ workspaceView });
}

export function openNewSession(open: boolean): void {
  set({ newSessionOpen: open });
}

// ---------------------------------------------------------------------------- ui
export function setTheme(theme: 'dark' | 'light'): void {
  set({ theme });
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('mide.studio.theme', theme);
  } catch {
    /* ignore */
  }
}

export function toggleTheme(): void {
  setTheme(get().theme === 'dark' ? 'light' : 'dark');
}

export function setFollow(on: boolean): void {
  set({ follow: on });
  savePrefs();
}

export function setAutoSwitch(on: boolean): void {
  set({ autoSwitch: on });
  savePrefs();
}

export function togglePanel(which: 'explorer' | 'rail'): void {
  set((s) => (which === 'explorer' ? { explorerOpen: !s.explorerOpen } : { railOpen: !s.railOpen }));
  savePrefs();
}

export function setPanelWidth(which: 'explorer' | 'rail', width: number): void {
  set(which === 'explorer' ? { explorerWidth: Math.min(480, Math.max(180, width)) } : { railWidth: Math.min(640, Math.max(300, width)) });
}

export function openPalette(open: boolean): void {
  set({ paletteOpen: open });
}

export function repair(): void {
  clearAuth();
  setApiToken(null);
  client?.close();
  set({ auth: 'unpaired' });
}
