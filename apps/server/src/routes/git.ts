/** Git views over the system `git`: GET /api/git/status, /api/git/diff, /api/git/log. */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { API } from '@mobile-ide/core';
import type { AuthedEnv, ServerContext } from '../context.js';
import { HttpError } from '../errors.js';
import { displayPath, resolveRoot, resolveUnder } from '../paths.js';
import { queryBool, queryInt, queryString, requireQuery } from './util.js';

const DEFAULT_LOG_LIMIT = 30;
const MAX_LOG_LIMIT = 500;

export function gitRoutes(ctx: ServerContext): Hono<AuthedEnv> {
  const app = new Hono<AuthedEnv>();

  /** Validated project root that is inside a git work tree (400 `not_git` otherwise). */
  async function gitRoot(c: Context): Promise<string> {
    const root = resolveRoot(ctx.policy, requireQuery(c, 'root'));
    const info = await ctx.git.repoInfo(root);
    if (!info.isGit) throw new HttpError(400, 'not a git repository', 'not_git');
    return root;
  }

  app.get(API.gitStatus, async (c) => {
    const root = await gitRoot(c);
    return c.json(await ctx.git.status(root));
  });

  /** `?path=` limits to one file (untracked files diff against /dev/null); `?staged=1` for the index. */
  app.get(API.gitDiff, async (c) => {
    const root = await gitRoot(c);
    const staged = queryBool(c, 'staged');
    const rawPath = queryString(c, 'path');
    let rel: string | undefined;
    if (rawPath !== undefined && rawPath !== '.' && rawPath !== '/') {
      rel = displayPath(root, resolveUnder(ctx.policy, root, rawPath)) || undefined;
    }
    return c.json(await ctx.git.diff(root, rel, staged));
  });

  app.get(API.gitLog, async (c) => {
    const root = await gitRoot(c);
    const limit = queryInt(c, 'limit', { def: DEFAULT_LOG_LIMIT, min: 1, max: MAX_LOG_LIMIT });
    return c.json(await ctx.git.log(root, limit));
  });

  return app;
}
