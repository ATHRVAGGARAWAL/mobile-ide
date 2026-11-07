/**
 * The user's tmux-backed shells: GET /api/terminals lists them, DELETE /api/terminals/:id kills one.
 * Without this a shell the app stopped attaching to (Terminal → "New shell") lived on the laptop forever,
 * visible only to someone with a local terminal.
 */
import { Hono } from 'hono';
import { API, type TerminalInfo } from '@mobile-ide/core';
import type { AuthedEnv, ServerContext } from '../context.js';
import { NotFoundError } from '../errors.js';

export function terminalRoutes(ctx: ServerContext): Hono<AuthedEnv> {
  const app = new Hono<AuthedEnv>();
  const log = ctx.log.child({ mod: 'http.terminals' });

  app.get(API.terminals, async (c) => {
    await ctx.terminals.refresh();
    const list: TerminalInfo[] = ctx.terminals.list();
    return c.json(list);
  });

  app.delete(`${API.terminals}/:id`, async (c) => {
    const id = c.req.param('id');
    const killed = await ctx.terminals.kill(id); // BadRequestError for an id tmux could misread
    if (!killed) throw new NotFoundError('no such terminal');
    log.info('terminal.killed', { id, device: c.get('device').id });
    return c.json({ ok: true, id });
  });

  return app;
}
