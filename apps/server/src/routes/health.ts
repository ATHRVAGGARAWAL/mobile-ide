/** GET /api/health — public `{ok, serverName, version}`; the full HealthResponse when authed. */
import { Hono } from 'hono';
import { API, type HealthResponse } from '@mobile-ide/core';
import { authenticate, extractToken } from '../authn.js';
import type { AuthedEnv, ServerContext } from '../context.js';
import { HttpError } from '../errors.js';

export function healthRoutes(ctx: ServerContext): Hono<AuthedEnv> {
  const app = new Hono<AuthedEnv>();

  app.get(API.health, (c) => {
    const creds = { authorization: c.req.header('authorization') ?? null };
    const hasToken = extractToken(creds) !== null;
    const device = hasToken ? authenticate(ctx.db, creds) : null;
    // A token that is present but wrong must surface as 401 so a revoked device learns it
    // from its first request instead of failing response validation on the public subset.
    if (hasToken && !device) throw new HttpError(401, 'missing or invalid bearer token', 'unauthorized');

    let ok = true;
    try {
      ok = ctx.db.ping();
    } catch {
      ok = false;
    }
    const base = { ok, serverName: ctx.serverName, version: ctx.version };
    if (!device) return c.json(base);

    const h = ctx.sessions.health();
    const full: HealthResponse = {
      ...base,
      uptimeSec: Math.max(0, Math.round((Date.now() - ctx.startedAt) / 1000)),
      agents: h.agents,
      sessions: h.sessions,
    };
    return c.json(full);
  });

  return app;
}
