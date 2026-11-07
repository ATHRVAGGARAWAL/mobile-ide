/** The Studio's state: one zustand store, mutated only by the controller (state/controller.ts) and the editor bridge. */
import type {
  ConnectionState,
  ElicitationContent,
  FileContent,
  FsEntry,
  ProjectInfo,
  SessionSummary,
  TimelineState,
  ToolStatus,
} from '@mobile-ide/core';
import { create } from 'zustand';

export type ThemeName = 'dark' | 'light';

export interface Doc {
  root: string;
  path: string;
  /** what is on disk as far as we know */
  content: string;
  mtime?: number;
  language: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  loading: boolean;
  error?: string;
  /** the file vanished from disk */
  missing?: boolean;
  /** the editor holds edits not yet saved */
  dirty: boolean;
  saving?: boolean;
  /** disk changed while the editor was dirty: the user decides */
  conflict?: FileContent;
  /** bumps every time `content` was replaced from disk — the editor applies the difference */
  version: number;
  lastChange?: { ts: number; by: 'agent' | 'disk' | 'you'; added: number; removed: number };
}

export interface Tab {
  key: string;
  root: string;
  path: string;
  openedBy: 'user' | 'agent';
}

/** An edit the agent announced (tool call with a diff) that has not been seen on disk yet — drawn as a ghost. */
export interface PendingEdit {
  key: string;
  toolCallId: string;
  oldText: string | null;
  newText: string;
  status: ToolStatus;
  awaitingPermission: boolean;
  title: string;
  ts: number;
}

export interface RecentChange {
  key: string;
  ts: number;
  by: 'agent' | 'disk';
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export type TreeState = { entries: FsEntry[]; loadedAt: number } | { loading: true } | { error: string };

export type AuthPhase = 'booting' | 'pairing' | 'ready' | 'unpaired' | 'error';

export interface StudioState {
  // --- daemon
  auth: AuthPhase;
  authError: string | null;
  conn: ConnectionState;
  connDetail: string | null;
  serverName: string;
  serverVersion: string;
  // --- sessions
  sessions: SessionSummary[];
  timelines: Record<string, TimelineState>;
  /** bumps on every applied event (timelines mutate in place) */
  tick: number;
  followSessionId: string | null;
  /** open files the agent touches, reveal its edits */
  follow: boolean;
  /** jump to the newest session when one starts */
  autoSwitch: boolean;
  // --- workspace
  root: string | null;
  projects: ProjectInfo[];
  tree: Record<string, TreeState>;
  expanded: string[];
  gitBranch: string | null;
  gitStatus: Record<string, string>;
  // --- files
  tabs: Tab[];
  activeKey: string | null;
  docs: Record<string, Doc>;
  pendingEdits: Record<string, PendingEdit[]>;
  recentChanges: Record<string, RecentChange>;
  // --- ui
  theme: ThemeName;
  paletteOpen: boolean;
  newSessionOpen: boolean;
  editorView: 'code' | 'diff';
  workspaceView: 'files' | 'editor' | 'session';
  drafts: Record<string, string>;
  elicitationDrafts: Record<string, ElicitationContent>;
  explorerOpen: boolean;
  railOpen: boolean;
  explorerWidth: number;
  railWidth: number;
  toasts: Toast[];
  /** for the status bar: "app.ts changed by Claude Code · 2 s ago" */
  lastActivity: { text: string; ts: number } | null;
  cursor: { line: number; col: number } | null;
}

const PREF_KEY = 'mide.studio.prefs';

interface Prefs {
  follow?: boolean;
  autoSwitch?: boolean;
  explorerOpen?: boolean;
  railOpen?: boolean;
  explorerWidth?: number;
  railWidth?: number;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? (JSON.parse(raw) as Prefs) : {};
  } catch {
    return {};
  }
}

export function savePrefs(): void {
  const s = useStudio.getState();
  const prefs: Prefs = {
    follow: s.follow,
    autoSwitch: s.autoSwitch,
    explorerOpen: s.explorerOpen,
    railOpen: s.railOpen,
    explorerWidth: s.explorerWidth,
    railWidth: s.railWidth,
  };
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

function initialTheme(): ThemeName {
  const t = document.documentElement.dataset.theme;
  return t === 'light' ? 'light' : 'dark';
}

const prefs = loadPrefs();

export const useStudio = create<StudioState>()(() => ({
  auth: 'booting',
  authError: null,
  conn: 'closed',
  connDetail: null,
  serverName: '',
  serverVersion: '',
  sessions: [],
  timelines: {},
  tick: 0,
  followSessionId: null,
  follow: prefs.follow ?? true,
  autoSwitch: prefs.autoSwitch ?? true,
  root: null,
  projects: [],
  tree: {},
  expanded: [],
  gitBranch: null,
  gitStatus: {},
  tabs: [],
  activeKey: null,
  docs: {},
  pendingEdits: {},
  recentChanges: {},
  theme: initialTheme(),
  paletteOpen: false,
  newSessionOpen: false,
  editorView: 'code',
  workspaceView: 'editor',
  drafts: {},
  elicitationDrafts: {},
  explorerOpen: prefs.explorerOpen ?? true,
  railOpen: prefs.railOpen ?? true,
  explorerWidth: clamp(prefs.explorerWidth ?? 248, 180, 480),
  railWidth: clamp(prefs.railWidth ?? 380, 300, 640),
  toasts: [],
  lastActivity: null,
  cursor: null,
}));

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

let toastSeq = 0;
export function toast(kind: Toast['kind'], text: string, ms = 4200): void {
  const id = ++toastSeq;
  useStudio.setState((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-4) }));
  setTimeout(() => useStudio.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

/** The followed session's summary and timeline, if any. */
export function currentSession(s: StudioState): { summary: SessionSummary | undefined; timeline: TimelineState | undefined } {
  const id = s.followSessionId;
  if (!id) return { summary: undefined, timeline: undefined };
  return { summary: s.sessions.find((x) => x.id === id), timeline: s.timelines[id] };
}
