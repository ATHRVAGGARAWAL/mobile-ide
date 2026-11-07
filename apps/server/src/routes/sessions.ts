/** Agents, projects, sessions (CRUD + event replay) and pending permissions. */
import { Hono } from 'hono';
import { API, CreateSessionRequest, RenameSessionRequest, SessionStatus } from '@mobile-ide/core';
import { z } from 'zod';
import type { AuthedEnv, ServerContext } from '../context.js';
import { BadRequestError } from '../errors.js';
import { parseJsonBody, queryBool, queryInt, queryString } from './util.js';

/** PATCH body: the core rename shape, plus an optional mode switch (HTTP fallback for `set_mode`). */
const PatchSessionRequest = RenameSessionRequest.partial()
  .extend({ modeId: z.string().min(1).max(200).optional() })
  .refine((v) => v.title !== undefined || v.modeId !== undefined, { message: 'title or modeId is required' });

const MAX_EVENT_LIMIT = 5000;

export function sessionRoutes(ctx: ServerContext): Hono<AuthedEnv> {
  const app = new Hono<AuthedEnv>();
  const log = ctx.log.child({ mod: 'http.sessions' });

  app.get(API.agents, (c) => c.json(ctx.sessions.agentInfos()));

  app.get(API.projects, async (c) => c.json(await ctx.projects.list(ctx.db.sessionCwds())));

  /** `?status=<SessionStatus>` filters; closed sessions are excluded unless `?all=1`. */
  app.get(API.sessions, (c) => {
    const rawStatus = queryString(c, 'status');
    let status: SessionStatus | undefined;
    if (rawStatus !== undefined) {
      const parsed = SessionStatus.safeParse(rawStatus);
      if (!parsed.success) throw new BadRequestError(`status must be one of: ${SessionStatus.options.join(', ')}`);
      status = parsed.data;
    }
    const includeClosed = queryBool(c, 'all') || status === 'closed';
    return c.json(ctx.sessions.listSummaries({ includeClosed, status }));
  });

  app.post(API.sessions, async (c) => {
    const body = await parseJsonBody(c, CreateSessionRequest);
    const summary = await ctx.sessions.createSession(body);
    log.info('session.created', { id: summary.id, agent: summary.agent, device: c.get('device').id });
    return c.json(summary, 201);
  });

  app.get(`${API.sessions}/:id`, (c) => c.json(ctx.sessions.summary(c.req.param('id'))));

  app.patch(`${API.sessions}/:id`, async (c) => {
    const id = c.req.param('id');
    const body = await parseJsonBody(c, PatchSessionRequest);
    ctx.sessions.summary(id); // 404 before touching anything
    if (body.title !== undefined) {
      const title = body.title.trim();
      if (!title) throw new BadRequestError('title must not be blank');
      ctx.sessions.rename(id, title);
    }
    if (body.modeId !== undefined) await ctx.sessions.setMode(id, body.modeId);
    return c.json(ctx.sessions.summary(id));
  });

  /** Close the session (ACP session/close when supported). `?purge=1` also deletes its log. */
  app.delete(`${API.sessions}/:id`, async (c) => {
    const id = c.req.param('id');
    const purge = queryBool(c, 'purge');
    await ctx.sessions.closeSession(id, { purge });
    log.info('session.closed', { id, purge, device: c.get('device').id });
    return c.json({ ok: true, id, purged: purge });
  });

  /**
   * Replay/pagination fallback: events with seq > `after` (default -1 = from the start).
   * `after=0` is inclusive, exactly like the WebSocket `subscribe { afterSeq: 0 }`: the log starts at
   * seq 0 (`session.created`, which carries the modes) and a fresh client timeline sits at lastSeq -1
   * but sends max(0, lastSeq). A client that really has seq 0 gets one duplicate, which the core
   * reducer drops (`seq <= lastSeq`).
   */
  app.get(`${API.sessions}/:id/events`, (c) => {
    const id = c.req.param('id');
    const requested = queryInt(c, 'after', { def: -1, min: -1, max: Number.MAX_SAFE_INTEGER });
    const after = requested === 0 ? -1 : requested;
    const limit = queryInt(c, 'limit', { def: ctx.config.config.limits.eventReplayBatch, min: 1, max: MAX_EVENT_LIMIT });
    return c.json(ctx.sessions.events(id, after, limit));
  });

  /** Pending permission requests across sessions; `?sessionId=` narrows to one session. */
  app.get(API.pendingPermissions, (c) => {
    const sessionId = queryString(c, 'sessionId');
    if (sessionId !== undefined) {
      ctx.sessions.summary(sessionId); // 404 for unknown sessions
      return c.json(ctx.db.pendingPermissions(sessionId).map((p) => p.request));
    }
    return c.json(ctx.sessions.pendingPermissionRequests());
  });

  return app;
}
