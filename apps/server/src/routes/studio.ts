/** POST /api/studio/open: the phone's "Open on laptop" — spawn the Studio window (or report that one is connected). */
import { Hono } from 'hono';
import { API, StudioOpenRequest, type StudioOpenResponse } from '@mobile-ide/core';
import type { AuthedEnv, ServerContext } from '../context.js';
import { HttpError } from '../errors.js';
import { studioUrl } from '../studio.js';
import { parseJsonBody } from './util.js';

export function studioRoutes(ctx: ServerContext): Hono<AuthedEnv> {
  const app = new Hono<AuthedEnv>();

  app.post(API.studioOpen, async (c) => {
    const body = await parseJsonBody(c, StudioOpenRequest);
    const launcher = ctx.studio;
    if (!launcher) throw new HttpError(503, 'the Studio launcher is not available in this daemon', 'unavailable');
    if (body.sessionId) ctx.sessions.summary(body.sessionId); // 404 for an unknown session
    if (launcher.studioConnected()) {
      const res: StudioOpenResponse = { opened: false, connected: true, url: studioUrl(ctx.config, { sessionId: body.sessionId }) };
      return c.json(res);
    }
    const result = await launcher.open({ sessionId: body.sessionId });
    const res: StudioOpenResponse = { opened: result.opened, connected: false, url: result.url };
    if (result.reason) res.reason = result.reason;
    if (result.browser) res.browser = result.browser;
    return c.json(res);
  });

  return app;
}
