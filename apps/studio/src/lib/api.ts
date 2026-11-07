/** Typed fetch over the daemon's REST routes (zod-parsed responses, human errors), bound to a bearer token. */
import {
  AgentInfo,
  API,
  CreateSessionRequest,
  FileContent,
  FsEntry,
  GitDiff,
  GitStatus,
  HealthResponse,
  ProjectInfo,
  SearchMatch,
  SessionSummary,
  WriteFileResponse,
  type WriteFileRequest,
} from '@mobile-ide/core';
import { z } from 'zod';
import { BASE_URL } from './auth';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

let currentToken: string | null = null;
export function setApiToken(token: string | null): void {
  currentToken = token;
}

const ErrorBody = z.object({ error: z.string().optional(), message: z.string().optional(), code: z.string().optional() }).loose();

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  opts: { method?: string; body?: unknown; query?: Query; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') throw new ApiError('The daemon took too long to answer.', 0, 'timeout');
    throw new ApiError('Cannot reach the daemon.', 0, 'network');
  }
  clearTimeout(timer);
  if (!res.ok) {
    let detail = '';
    let code: string | null = null;
    try {
      const parsed = ErrorBody.safeParse(await res.json());
      if (parsed.success) {
        detail = parsed.data.error ?? parsed.data.message ?? '';
        code = parsed.data.code ?? null;
      }
    } catch {
      /* not JSON */
    }
    throw new ApiError(detail || `${res.status} ${res.statusText}`, res.status, code);
  }
  const json: unknown = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError('Unexpected response from the daemon.', res.status, 'invalid_response');
  return parsed.data;
}

const Ok = z.object({}).loose();
const Me = z.object({ id: z.string(), name: z.string() }).loose();

export const api = {
  me: () => request(API.me, Me),
  health: () => request(API.health, HealthResponse),
  agents: () => request(API.agents, z.array(AgentInfo)),
  projects: () => request(API.projects, z.array(ProjectInfo)),
  sessions: () => request(API.sessions, z.array(SessionSummary)),
  createSession: (body: z.infer<typeof CreateSessionRequest>) => request(API.sessions, SessionSummary, { body, timeoutMs: 90_000 }),
  closeSession: (id: string) => request(API.session(id), Ok, { method: 'DELETE' }),
  fsTree: (root: string, path = '') => request(API.fsTree, z.array(FsEntry), { query: { root, path } }),
  fsFile: (root: string, path: string) => request(API.fsFile, FileContent, { query: { root, path }, timeoutMs: 30_000 }),
  fsWrite: (body: WriteFileRequest) => request(API.fsFile, WriteFileResponse, { method: 'PUT', body, timeoutMs: 30_000 }),
  fsSearch: (root: string, q: string, limit = 60) => request(API.fsSearch, z.array(SearchMatch), { query: { root, q, limit } }),
  gitStatus: (root: string) => request(API.gitStatus, GitStatus, { query: { root } }),
  gitDiff: (root: string, path: string, staged = false) => request(API.gitDiff, GitDiff, { query: { root, path, staged } }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
