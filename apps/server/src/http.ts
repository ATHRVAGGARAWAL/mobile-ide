/**
 * REST surface of the daemon (Hono). The returned app is served by @hono/node-server in app.ts;
 * the same http.Server also carries the WebSocket upgrades (ws.ts).
 *
 *  - Bearer auth on everything under /api except GET /api/health (public subset) and POST /api/pair.
 *  - Errors (HttpError, zod, Hono, fs errno) become JSON `{ error, code }`.
 *  - CORS for browser clients on the same host, loopback, the publicUrl host and tailnet/private origins.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { API } from '@mobile-ide/core';
import { authenticate } from './authn.js';
import type { AuthedEnv, ServerContext } from './context.js';
import { HttpError, NotFoundError } from './errors.js';
import { errorInfo } from './log.js';
import { fsRoutes } from './routes/fs.js';
import { gitRoutes } from './routes/git.js';
import { healthRoutes } from './routes/health.js';
import { originAllowed } from './routes/origin.js';
import { landingPage, pairPage } from './routes/pages.js';
import { pairingRoutes } from './routes/pairing.js';
import { pushRoutes } from './routes/push.js';
import { RateLimiter } from './routes/rate-limit.js';
import { sessionRoutes } from './routes/sessions.js';
import { studioMiddleware, webAppMiddleware } from './routes/static.js';
import { studioRoutes } from './routes/studio.js';
import { terminalRoutes } from './routes/terminals.js';
import { activityRoutes } from './routes/activity.js';
import { clientIp, errorResponse, toHttpError } from './routes/util.js';

export { originAllowed } from './routes/origin.js';

/** Pairing attempts per client IP per minute (spec: 5/min/IP). */
const PAIR_LIMIT = 5;
const PAIR_WINDOW_MS = 60_000;
/** Prompts may carry base64 images (downscaled on the phone), so allow a generous body. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function normalizePath(p: string): string {
  const stripped = p.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/** Routes that must work before a device has a token. */
function isAuthExempt(method: string, path: string): boolean {
  const p = normalizePath(path);
  if (method === 'OPTIONS') return true;
  if ((method === 'GET' || method === 'HEAD') && p === API.health) return true;
  if (method === 'POST' && p === API.pair) return true;
  return false;
}

function authMiddleware(ctx: ServerContext): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    if (isAuthExempt(c.req.method, c.req.path)) return next();
    const device = authenticate(ctx.db, { authorization: c.req.header('authorization') ?? null });
    if (!device) throw new HttpError(401, 'missing or invalid bearer token', 'unauthorized');
    c.set('device', device);
    await next();
  };
}

export function createHttpApp(ctx: ServerContext): Hono<AuthedEnv> {
  const app = new Hono<AuthedEnv>({ strict: false });
  const log = ctx.log.child({ mod: 'http' });
  const pairLimiter = new RateLimiter(PAIR_LIMIT, PAIR_WINDOW_MS);

  app.onError((err, c) => {
    const httpErr = toHttpError(err);
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status: httpErr.status,
      code: httpErr.code,
      ip: clientIp(c, ctx.config.config.trustProxy),
    };
    if (httpErr.status >= 500 && !(err instanceof HttpError)) log.error('http.error', { ...fields, ...errorInfo(err) });
    else if (httpErr.status >= 500 || httpErr.status === 401 || httpErr.status === 403 || httpErr.status === 429)
      log.warn('http.failed', { ...fields, message: httpErr.message });
    else log.debug('http.client_error', { ...fields, message: httpErr.message });
    return errorResponse(c, httpErr);
  });

  app.notFound((c) => {
    const path = normalizePath(c.req.path);
    const wantsHtml = (c.req.header('accept') ?? '').includes('text/html');
    if (wantsHtml && (c.req.method === 'GET' || c.req.method === 'HEAD')) {
      const csp =
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
      const headers = { 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY' };
      if (path === '/pair') return c.html(pairPage({ serverName: ctx.serverName }), 200, headers);
      if (path === '/') return c.html(landingPage({ serverName: ctx.serverName, version: ctx.version }), 200, headers);
    }
    return errorResponse(c, new NotFoundError(`no route for ${c.req.method} ${path}`));
  });

  // The exported web app (index.html, _expo/ bundles, SPA fallback for /pair and /session/<id>). Mounted ahead of the
  // hygiene middleware below so its per-file Cache-Control survives; it sets nosniff/referrer itself and never touches
  // /api or /ws. With no web build present every request falls through to the routes and the notFound landing pages.
  // The Studio (apps/studio/dist) at /studio/ first — its subtree must never fall through to the phone app's SPA fallback.
  app.use('*', studioMiddleware(ctx));
  app.use('*', webAppMiddleware(ctx));

  // Response hygiene + one debug line per request.
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    log.debug('http.request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round((performance.now() - started) * 10) / 10,
    });
  });

  app.use(
    '/api/*',
    cors({
      origin: (origin, c) =>
        originAllowed(origin, { requestHost: c.req.header('host'), publicUrl: ctx.config.config.publicUrl }) ? origin : null,
      allowMethods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Accept'],
      exposeHeaders: ['Retry-After', 'WWW-Authenticate'],
      maxAge: 600,
    }),
  );
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => errorResponse(c, new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`, 'payload_too_large')),
    }),
  );
  app.use('/api/*', authMiddleware(ctx));

  app.route('/', healthRoutes(ctx));
  app.route('/', pairingRoutes(ctx, pairLimiter));
  app.route('/', sessionRoutes(ctx));
  app.route('/', fsRoutes(ctx));
  app.route('/', gitRoutes(ctx));
  app.route('/', pushRoutes(ctx));
  app.route('/', terminalRoutes(ctx));
  app.route('/', activityRoutes(ctx));
  app.route('/', studioRoutes(ctx));

  return app;
}
