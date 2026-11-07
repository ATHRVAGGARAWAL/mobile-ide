/**
 * Typed fetch wrapper over the REST routes in @mobile-ide/core.
 * Every response is zod-parsed; every failure becomes an ApiError with a human message.
 */
import {
  API,
  LaptopActivity,
  LaptopHistory,
  AgentInfo,
  CreateSessionRequest,
  EventEnvelope,
  FileContent,
  FsEntry,
  GitDiff,
  GitLogEntry,
  GitStatus,
  HealthResponse,
  PairRequest,
  PairResponse,
  PermissionRequest,
  ProjectInfo,
  PushVapidResponse,
  RegisterPushRequest,
  SearchMatch,
  SessionSummary,
  StudioOpenResponse,
  TerminalInfo,
  UploadImageRequest,
  UploadImageResponse,
} from '@mobile-ide/core';
import { z } from 'zod';
import { normalizeServerUrl, useSettings } from './settings';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'network' | 'timeout' | 'unauthorized' | 'forbidden' | 'not_found' | 'server' | 'invalid_response' | 'not_configured',
    /** the daemon's own `code` from its `{ error, code }` body (e.g. `no_subscriptions`), when it sent one */
    readonly serverCode: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Something went wrong';
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  timeoutMs?: number;
  /** override base url + token (used by pairing before settings are saved) */
  auth?: { baseUrl: string; token?: string | null };
}

function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const u = new URL(basePath + path, base.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
  }
  return u.toString();
}

const ErrorBody = z.object({ error: z.string().optional(), message: z.string().optional(), code: z.string().optional() }).loose();

async function request<T>(path: string, schema: z.ZodType<T>, opts: RequestOptions = {}): Promise<T> {
  const settings = useSettings.getState();
  const baseUrl = opts.auth?.baseUrl ?? settings.serverUrl;
  const token = opts.auth ? opts.auth.token : settings.token;
  if (!baseUrl) throw new ApiError('No server configured. Pair with your daemon first.', 0, 'not_configured');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await fetch(buildUrl(baseUrl, path, opts.query), {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') throw new ApiError('The server took too long to respond.', 0, 'timeout');
    throw new ApiError(
      `Can't reach ${hostOf(baseUrl)}. Check your connection and that Mobile IDE is running on your computer.`,
      0,
      'network',
    );
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    let serverCode: string | null = null;
    try {
      const parsed = ErrorBody.safeParse(await res.json());
      if (parsed.success) {
        detail = parsed.data.error ?? parsed.data.message ?? '';
        serverCode = parsed.data.code ?? null;
      }
    } catch {
      /* non-JSON error body */
    }
    switch (res.status) {
      case 401:
        throw new ApiError(detail || 'This device is no longer authorized. Pair again.', 401, 'unauthorized', serverCode);
      case 403:
        throw new ApiError(detail || 'Not allowed.', 403, 'forbidden', serverCode);
      case 404:
        throw new ApiError(detail || 'Not found.', 404, 'not_found', serverCode);
      case 429:
        throw new ApiError(detail || 'Too many attempts. Wait a minute and try again.', 429, 'server', serverCode);
      default:
        throw new ApiError(detail || `Server error (${res.status}).`, res.status, 'server', serverCode);
    }
  }

  if (res.status === 204) {
    const empty = schema.safeParse(undefined);
    if (empty.success) return empty.data;
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    const empty = schema.safeParse(undefined);
    if (empty.success) return empty.data;
    throw new ApiError('The server returned an unreadable response.', res.status, 'invalid_response');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.warn('[api] response failed validation', path, parsed.error.issues.slice(0, 3));
    throw new ApiError(
      'The server returned an unexpected response. Update the daemon and the app to matching versions.',
      res.status,
      'invalid_response',
    );
  }
  return parsed.data;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const Ok = z.unknown().transform(() => true as const);

/** Loose shape for GET /api/me (the daemon's device summary). */
export const MeResponse = z
  .object({
    id: z.string().optional(),
    deviceId: z.string().optional(),
    name: z.string().optional(),
    platform: z.string().optional(),
    createdAt: z.number().optional(),
    lastSeen: z.number().optional(),
  })
  .loose();
export type MeResponse = z.infer<typeof MeResponse>;

const PublicHealth = z.object({ ok: z.boolean(), serverName: z.string(), version: z.string() }).loose();

export const api = {
  activity: () => request(API.activity, LaptopActivity),
  laptopHistory: (source: string, id: string) => request(API.laptopHistory, LaptopHistory, { query: { source, id } }),
  /** Unauthenticated health probe; works before pairing. */
  probe: (baseUrl: string) =>
    request(API.health, PublicHealth, { auth: { baseUrl: normalizeServerUrl(baseUrl), token: null }, timeoutMs: 8_000 }),
  health: () => request(API.health, HealthResponse),
  pair: (baseUrl: string, body: z.infer<typeof PairRequest>) =>
    request(API.pair, PairResponse, { auth: { baseUrl: normalizeServerUrl(baseUrl), token: null }, body, timeoutMs: 15_000 }),
  me: () => request(API.me, MeResponse),
  agents: () => request(API.agents, z.array(AgentInfo)),
  projects: () => request(API.projects, z.array(ProjectInfo)),
  sessions: (all = false) => request(API.sessions, z.array(SessionSummary), { query: { all } }),
  session: (id: string) => request(API.session(id), SessionSummary),
  createSession: (body: z.infer<typeof CreateSessionRequest>) => request(API.sessions, SessionSummary, { body, timeoutMs: 60_000 }),
  renameSession: (id: string, title: string) => request(API.session(id), SessionSummary.or(Ok), { method: 'PATCH', body: { title } }),
  closeSession: (id: string) => request(API.session(id), Ok, { method: 'DELETE' }),
  events: (id: string, after: number, limit = 500) => request(API.sessionEvents(id), z.array(EventEnvelope), { query: { after, limit } }),
  pendingPermissions: () => request(API.pendingPermissions, z.array(PermissionRequest)),
  fsTree: (root: string, path = '') => request(API.fsTree, z.array(FsEntry), { query: { root, path } }),
  fsFile: (root: string, path: string) => request(API.fsFile, FileContent, { query: { root, path }, timeoutMs: 30_000 }),
  uploadImage: (body: z.infer<typeof UploadImageRequest>) => request(API.fsImage, UploadImageResponse, { body, timeoutMs: 60_000 }),
  fsSearch: (root: string, q: string, limit = 200) => request(API.fsSearch, z.array(SearchMatch), { query: { root, q, limit } }),
  gitStatus: (root: string) => request(API.gitStatus, GitStatus, { query: { root } }),
  gitDiff: (root: string, path: string | undefined, staged: boolean) =>
    request(API.gitDiff, GitDiff, { query: { root, path, staged }, timeoutMs: 30_000 }),
  gitLog: (root: string, limit = 30) => request(API.gitLog, z.array(GitLogEntry), { query: { root, limit } }),
  pushRegister: (body: z.infer<typeof RegisterPushRequest>) => request(API.pushRegister, Ok, { body }),
  pushTest: () => request(API.pushTest, Ok, { method: 'POST', body: {} }),
  pushVapid: () => request(API.pushVapid, PushVapidResponse),
  /** the tmux-backed shells behind the Terminal tab (all projects) */
  terminals: () => request(API.terminals, z.array(TerminalInfo)),
  /** kill one shell's tmux session (and whatever runs in it) */
  killTerminal: (id: string) => request(API.terminal(id), Ok, { method: 'DELETE' }),
  /** open (or focus) the Studio — the live editor window on the daemon's machine — following `sessionId` */
  studioOpen: (sessionId?: string) =>
    request(API.studioOpen, StudioOpenResponse, { body: sessionId ? { sessionId } : {}, timeoutMs: 15_000 }),
};
