/** File APIs: GET /api/fs/tree, GET|PUT /api/fs/file, GET /api/fs/search. Every path goes through PathPolicy. */
import { Hono } from 'hono';
import { API, UploadImageRequest, WriteFileRequest } from '@mobile-ide/core';
import { saveUploadedImage } from '../image-uploads.js';
import type { AuthedEnv, ServerContext } from '../context.js';
import { listTree, readFileCapped, searchFiles, writeFileChecked } from '../fsapi.js';
import { resolveRoot, resolveUnder } from '../paths.js';
import { parseJsonBody, queryInt, queryString, requireQuery } from './util.js';

const DEFAULT_SEARCH_LIMIT = 200;
const MAX_SEARCH_LIMIT = 1000;

export function fsRoutes(ctx: ServerContext): Hono<AuthedEnv> {
  const app = new Hono<AuthedEnv>();

  app.post(API.fsImage, async (c) => {
    const body = await parseJsonBody(c, UploadImageRequest);
    return c.json(await saveUploadedImage(ctx.policy, body), 201);
  });

  /** One directory level; dirs first; git status letters from the cached porcelain status. */
  app.get(API.fsTree, async (c) => {
    const root = resolveRoot(ctx.policy, requireQuery(c, 'root'));
    const dir = resolveUnder(ctx.policy, root, queryString(c, 'path'));
    return c.json(await listTree(root, dir, ctx.git));
  });

  /** Capped read with binary sniff and language detection. */
  app.get(API.fsFile, async (c) => {
    const root = resolveRoot(ctx.policy, requireQuery(c, 'root'));
    const file = resolveUnder(ctx.policy, root, requireQuery(c, 'path'));
    return c.json(await readFileCapped(root, file, ctx.config.config.limits.maxFileBytes));
  });

  /** The Studio's save: checked write (409 when `expectedMtime` is stale), atomic rename, same path policy as the read. */
  app.put(API.fsFile, async (c) => {
    const body = await parseJsonBody(c, WriteFileRequest);
    const root = resolveRoot(ctx.policy, body.root);
    const file = resolveUnder(ctx.policy, root, body.path);
    const res = await writeFileChecked(root, file, body, ctx.config.config.limits.maxFileBytes);
    ctx.log.info('fs.write', { root, path: res.path, size: res.size, created: res.created, device: c.get('device').id });
    return c.json(res);
  });

  /** ripgrep-backed content search under `root` (optionally narrowed to `path`). Blank `q` → []. */
  app.get(API.fsSearch, async (c) => {
    const root = resolveRoot(ctx.policy, requireQuery(c, 'root'));
    const q = queryString(c, 'q');
    if (q === undefined) return c.json([]);
    const limit = queryInt(c, 'limit', { def: DEFAULT_SEARCH_LIMIT, min: 1, max: MAX_SEARCH_LIMIT });
    const dir = resolveUnder(ctx.policy, root, queryString(c, 'path'));
    return c.json(await searchFiles(root, dir, q, limit, ctx.git));
  });

  return app;
}
