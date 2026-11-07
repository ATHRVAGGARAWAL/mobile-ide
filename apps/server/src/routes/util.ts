/**
 * Shared helpers for the REST routes: body/query parsing against the core zod schemas,
 * the error → `{ error, code }` mapping applied at the HTTP boundary, and the client IP.
 */
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError, type z } from 'zod';
import { BadRequestError, ForbiddenError, HttpError, NotFoundError } from '../errors.js';

export interface ErrorBody {
  error: string;
  code: string;
  issues?: { path: string; message: string }[];
}

/** 400 carrying the individual zod issues so the client can point at the offending field. */
export class ValidationError extends HttpError {
  readonly issues: { path: string; message: string }[];

  constructor(err: ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
    const first = issues[0];
    super(400, first ? `Invalid request${first.path ? ` at '${first.path}'` : ''}: ${first.message}` : 'Invalid request', 'validation');
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export class RateLimitError extends HttpError {
  constructor(
    message: string,
    public readonly retryAfterSec: number,
  ) {
    super(429, message, 'rate_limited');
    this.name = 'RateLimitError';
  }
}

// ---------------------------------------------------------------------------- bodies
/**
 * Read the JSON body and validate it. An empty body counts as `{}` so endpoints whose
 * schema has no required fields (e.g. POST /api/push/test) accept a bare POST.
 */
export async function parseJsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text.trim() === '' ? {} : (JSON.parse(text) as unknown);
  } catch {
    throw new BadRequestError('request body is not valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error);
  return parsed.data;
}

// ---------------------------------------------------------------------------- query params
/** Trimmed query value; `undefined` when absent or blank. */
export function queryString(c: Context, key: string): string | undefined {
  const v = c.req.query(key);
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

export function requireQuery(c: Context, key: string): string {
  const v = queryString(c, key);
  if (v === undefined) throw new BadRequestError(`query parameter '${key}' is required`);
  return v;
}

/**
 * Integer query parameter. Non-integers and values below `min` are rejected (400);
 * values above `max` are clamped so a generous client `limit` still works.
 */
export function queryInt(c: Context, key: string, opts: { def: number; min: number; max: number }): number {
  const v = queryString(c, key);
  if (v === undefined) return opts.def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new BadRequestError(`query parameter '${key}' must be an integer`);
  if (n < opts.min) throw new BadRequestError(`query parameter '${key}' must be >= ${opts.min}`);
  return Math.min(n, opts.max);
}

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

export function queryBool(c: Context, key: string, def = false): boolean {
  const raw = c.req.query(key);
  if (raw === undefined) return def;
  const v = raw.trim().toLowerCase();
  if (v === '') return true; // `?all` with no value means "yes"
  if (TRUE_WORDS.has(v)) return true;
  if (FALSE_WORDS.has(v)) return false;
  throw new BadRequestError(`query parameter '${key}' must be a boolean (1/0, true/false)`);
}

// ---------------------------------------------------------------------------- errors
const CODE_FOR_STATUS: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  500: 'internal',
  502: 'bad_gateway',
  503: 'unavailable',
};

/** Map anything thrown by a route to an HttpError. Unknown errors become an opaque 500. */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ZodError) return new ValidationError(err);
  if (err instanceof HTTPException) return new HttpError(err.status, err.message || `HTTP ${err.status}`, CODE_FOR_STATUS[err.status] ?? 'http_error');
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    switch (code) {
      case 'ENOENT':
        return new NotFoundError('no such file or directory');
      case 'EACCES':
      case 'EPERM':
        return new ForbiddenError('permission denied');
      case 'EISDIR':
        return new BadRequestError('path is a directory');
      case 'ENOTDIR':
        return new BadRequestError('path is not a directory');
      case 'ELOOP':
        return new BadRequestError('too many levels of symbolic links');
      case 'ENAMETOOLONG':
        return new BadRequestError('path is too long');
      case 'EMFILE':
      case 'ENFILE':
      case 'EAGAIN':
        return new HttpError(503, 'server is busy, try again', 'unavailable');
      default:
        break;
    }
    // fsapi's own guards
    if (err.message === 'not a directory' || err.message === 'not a file') return new BadRequestError(err.message);
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return new HttpError(504, 'operation timed out', 'timeout');
  }
  return new HttpError(500, 'internal server error', 'internal');
}

export function errorResponse(c: Context, err: HttpError): Response {
  const body: ErrorBody = { error: err.message, code: err.code ?? CODE_FOR_STATUS[err.status] ?? 'error' };
  if (err instanceof ValidationError) body.issues = err.issues;
  const headers: Record<string, string> = {};
  if (err.status === 401) headers['WWW-Authenticate'] = 'Bearer realm="mobile-ide"';
  if (err instanceof RateLimitError) headers['Retry-After'] = String(Math.max(1, err.retryAfterSec));
  return c.json(body, err.status as ContentfulStatusCode, headers);
}

// ---------------------------------------------------------------------------- client address
function isLoopback(addr: string | undefined): boolean {
  if (!addr) return true;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

/**
 * Peer address for rate limiting and logs. `X-Forwarded-For` is a client-supplied header, so it is
 * honoured only when `config.trustProxy` is set and the direct peer is loopback (the reverse proxy on
 * this machine, e.g. `tailscale serve`). Even then the *last* entry is used: that is the one the trusted
 * proxy appended, whereas the first is whatever the remote client chose to send.
 */
export function clientIp(c: Context, trustProxy = false): string {
  let addr: string | undefined;
  try {
    addr = getConnInfo(c).remote.address;
  } catch {
    addr = undefined; // not running under @hono/node-server (e.g. app.request() in tests)
  }
  if (trustProxy && isLoopback(addr)) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
    const last = forwarded[forwarded.length - 1];
    if (last) return last;
  }
  return addr ?? 'local';
}
