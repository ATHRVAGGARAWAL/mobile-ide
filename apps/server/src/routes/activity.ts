import { Hono } from 'hono';
import { API } from '@mobile-ide/core';
import type { AuthedEnv, ServerContext } from '../context.js';
import { LaptopActivityReader } from '../laptop-activity.js';

export function activityRoutes(ctx: ServerContext): Hono<AuthedEnv> {
  const app = new Hono<AuthedEnv>();
  const reader = new LaptopActivityReader({ policy: ctx.policy, prefix: ctx.config.config.terminal.tmuxPrefix });
  // Coalesce concurrent phones and avoid repeatedly scanning local indexes during refresh bursts.
  let snapshot: ReturnType<LaptopActivityReader['snapshot']> | undefined;
  let expires = 0;
  app.get(API.activity, async (c) => {
    if (!snapshot || Date.now() >= expires) {
      expires = Date.now() + 4000;
      snapshot = reader.snapshot();
    }
    return c.json(await snapshot);
  });
  app.get(API.laptopHistory, (c) => c.json(reader.history(c.req.query('source') ?? '', c.req.query('id') ?? '')));
  return app;
}
