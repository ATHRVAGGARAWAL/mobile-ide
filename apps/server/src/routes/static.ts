/**
 * Web app hosting. Serves the exported Expo web build (`pnpm --filter @mobile-ide/app run export:web`, i.e.
 * `apps/mobile/dist`) from the daemon itself, so `https://<laptop>.<tailnet>.ts.net/` opens the app and
 * "Add to Home Screen" installs it — one origin for the app, the API and the WebSockets.
 *
 * Where the build comes from (first hit wins; re-checked on every request, so a rebuild is picked up live):
 *   1. `config.webApp.dir` when set — used exclusively; a wrong path is reported by `mide doctor`, not papered over
 *   2. `<repo>/apps/mobile/dist` when the daemon runs from the repository checkout (detected via import.meta.url)
 *   3. `<MIDE_HOME>/www` (~/.mobile-ide/www) for installs that copy the export next to the config
 *
 * Behaviour:
 *   - GET/HEAD only; `/api/*` and `/ws*` are never touched (JSON 404s and the WebSocket upgrades stay as they are).
 *   - Files stream with their MIME type, a weak ETag + Last-Modified (conditional requests → 304), on-the-fly
 *     brotli/gzip for compressible types, and a cache policy: hashed `_expo/` bundles and content-hashed assets
 *     are `immutable`; `index.html`, `manifest.webmanifest`, `sw.js` and everything else unhashed is `no-cache`.
 *     HEAD negotiates the same representation as GET (same ETag and Content-Encoding; Content-Length once cached).
 *   - SPA fallback: a GET for a path with no file that accepts `text/html` gets `index.html`, so `/pair#CODE`,
 *     `/session/<id>` and every other Expo Router route open directly. Non-HTML misses fall through to the JSON 404.
 *   - No build anywhere → every request falls through and http.ts's round-1 landing pages answer `/` and `/pair`.
 *
 * Mounted in http.ts *before* the response-hygiene middleware (which forces `Cache-Control: no-store`, right for
 * API responses) so the cache headers set here survive; the hygiene headers are set here explicitly instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { MiddlewareHandler } from 'hono';
import { getMimeType } from 'hono/utils/mime';
import { API } from '@mobile-ide/core';
import { expandHome, type LoadedConfig } from '../config.js';
import type { AuthedEnv, ServerContext } from '../context.js';
import { errorInfo, type Logger } from '../log.js';
import { isInside } from '../paths.js';

// ---------------------------------------------------------------------------- locating the build
export type WebAppSource = 'config' | 'repo' | 'home';

export interface WebAppCandidate {
  dir: string;
  source: WebAppSource;
}

export interface WebAppLocation extends WebAppCandidate {
  indexPath: string;
  /** mtime of index.html: when the build was exported */
  builtAt: number;
}

export interface WebAppResolution {
  location: WebAppLocation | null;
  /** every directory that was considered, in order */
  candidates: WebAppCandidate[];
}

export const WEB_APP_SOURCE_LABEL: Record<WebAppSource, string> = {
  config: 'webApp.dir',
  repo: 'repo checkout',
  home: 'MIDE_HOME/www',
};

let repoRootCache: string | null | undefined;

/**
 * The repository root when this module runs from a checkout (`apps/server/{src,dist}/routes/static.*`), else null.
 * A copy installed elsewhere (e.g. under node_modules/@mobile-ide/server) fails the sanity checks and gets null.
 */
export function repoRoot(): string | null {
  if (repoRootCache === undefined) repoRootCache = detectRepoRoot();
  return repoRootCache;
}

function detectRepoRoot(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(here, '..', '..', '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'server', 'package.json'), 'utf8')) as { name?: unknown };
    if (pkg.name !== '@mobile-ide/server') return null;
    if (!fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))) return null;
    return root;
  } catch {
    return null;
  }
}

/**
 * A static site the daemon hosts: the phone app at `/` and the Studio at `/studio/`. Both are single-page apps built into
 * a folder with an index.html; they differ in where the build is looked for and in the config key that overrides it.
 */
export interface StaticSite {
  /** short name for logs and the doctor */
  name: string;
  /** URL prefix without a trailing slash ('' for the root site) */
  prefix: string;
  /** configured override directory, or null */
  configuredDir: string | null;
  /** label of the config key, for messages */
  configKey: string;
  /** directory under the repo checkout holding the build */
  repoDir: string[];
  /** directory under MIDE_HOME for installs that copy the build next to the config */
  homeDir: string;
}

export function webAppSite(loaded: LoadedConfig): StaticSite {
  return {
    name: 'web app',
    prefix: '',
    configuredDir: loaded.config.webApp.dir,
    configKey: 'webApp.dir',
    repoDir: ['apps', 'mobile', 'dist'],
    homeDir: 'www',
  };
}

export function studioSite(loaded: LoadedConfig): StaticSite {
  return {
    name: 'studio',
    prefix: '/studio',
    configuredDir: loaded.config.studio.dir,
    configKey: 'studio.dir',
    repoDir: ['apps', 'studio', 'dist'],
    homeDir: 'studio',
  };
}

/** Directories that may hold a site's build, most specific first. Relative configured values resolve against the cwd. */
export function siteCandidates(loaded: LoadedConfig, site: StaticSite): WebAppCandidate[] {
  if (site.configuredDir) return [{ dir: path.resolve(expandHome(site.configuredDir)), source: 'config' }];
  const out: WebAppCandidate[] = [];
  const repo = repoRoot();
  if (repo) out.push({ dir: path.join(repo, ...site.repoDir), source: 'repo' });
  out.push({ dir: path.join(loaded.home, site.homeDir), source: 'home' });
  return out;
}

/** Directories that may hold the web app build (kept for callers that predate `siteCandidates`). */
export function webAppCandidates(loaded: LoadedConfig): WebAppCandidate[] {
  return siteCandidates(loaded, webAppSite(loaded));
}

/** First candidate that holds an index.html. One stat per candidate — cheap enough to run per request. */
export async function resolveWebApp(loaded: LoadedConfig): Promise<WebAppResolution> {
  return resolveSite(loaded, webAppSite(loaded));
}

/** Where the Studio build is served from (`mide doctor`, the launcher). */
export async function resolveStudio(loaded: LoadedConfig): Promise<WebAppResolution> {
  return resolveSite(loaded, studioSite(loaded));
}

export async function resolveSite(loaded: LoadedConfig, site: StaticSite): Promise<WebAppResolution> {
  const candidates = siteCandidates(loaded, site);
  for (const candidate of candidates) {
    const indexPath = path.join(candidate.dir, 'index.html');
    try {
      const st = await fs.promises.stat(indexPath);
      if (st.isFile()) return { location: { ...candidate, indexPath, builtAt: st.mtimeMs }, candidates };
    } catch {
      /* not here */
    }
  }
  return { location: null, candidates };
}

/** Logs where a site is served from — once, and again only when that changes (new build, dir appeared/vanished). */
class ResolutionTracker {
  private lastKey: string | null = null;

  constructor(
    private readonly log: Logger,
    private readonly site: StaticSite,
  ) {}

  observe(r: WebAppResolution): void {
    const key = r.location ? `${r.location.dir}|${Math.floor(r.location.builtAt)}` : 'missing';
    if (key === this.lastKey) return;
    const previous = this.lastKey;
    this.lastKey = key;
    if (r.location) {
      this.log.info(previous === null ? 'webapp.serving' : 'webapp.changed', {
        site: this.site.name,
        dir: r.location.dir,
        source: r.location.source,
        builtAt: new Date(r.location.builtAt).toISOString(),
      });
    } else {
      this.log.warn('webapp.missing', {
        site: this.site.name,
        lookedIn: r.candidates.map((c) => c.dir),
        hint:
          this.site.prefix === ''
            ? 'run `pnpm build` (exports apps/mobile/dist) or set "webApp.dir" in config.json; the plain landing page is served meanwhile'
            : 'run `pnpm build` (bundles apps/studio/dist) or set "studio.dir" in config.json; /studio/ shows a "not built" page meanwhile',
      });
    }
  }
}

// ---------------------------------------------------------------------------- request → file
const RESERVED_PREFIXES = ['/api', API.ws] as const;

function isReservedPath(pathname: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Split a URL path into safe relative segments. null for anything that must never reach the filesystem:
 * undecodable escapes, dot segments, hidden entries (except `.well-known`), embedded slashes/backslashes/NULs.
 */
export function safeSegments(pathname: string): string[] | null {
  const out: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (seg.startsWith('.') && !(seg === '.well-known' && out.length === 0)) return null;
    if (seg.includes('/') || seg.includes('\\') || seg.includes('\0')) return null;
    out.push(seg);
  }
  return out;
}

function acceptsHtml(accept: string | undefined): boolean {
  return (accept ?? '').toLowerCase().includes('text/html');
}

interface OpenFile {
  handle: fs.promises.FileHandle;
  size: number;
  mtimeMs: number;
}

/** Open a regular file below `rootReal` (symlinks resolved and re-checked). null when absent or not a plain file. */
async function openUnder(rootReal: string, segments: string[]): Promise<OpenFile | null> {
  const joined = path.join(rootReal, ...segments);
  if (!isInside(rootReal, joined)) return null;
  let real: string;
  try {
    real = await fs.promises.realpath(joined);
  } catch {
    return null;
  }
  if (!isInside(rootReal, real)) return null;
  return openRegular(real);
}

async function openRegular(file: string): Promise<OpenFile | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      await handle.close();
      return null;
    }
    return { handle, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    await handle.close().catch(() => undefined);
    return null;
  }
}

// ---------------------------------------------------------------------------- caching + encoding
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';
/** Expo's content-addressed asset names: `name.<md5>.png`, `icon.<md5>@2x.png`. */
const HASHED_ASSET = /\.[0-9a-f]{32}(?:@\d+x)?\.[a-z0-9]+$/i;

/** esbuild's `[name]-[hash]` output names (8 base-32 chars) under the Studio's assets/ folder. */
const HASHED_BUNDLE = /-[A-Z0-9]{8}\.(?:js|css|map|woff2?|ttf|svg|png)$/;

/** `relPath` is posix, relative to the web root. */
export function cachePolicyFor(relPath: string): string {
  if (relPath.startsWith('_expo/')) return IMMUTABLE;
  if (HASHED_ASSET.test(path.posix.basename(relPath))) return IMMUTABLE;
  if (relPath.startsWith('assets/') && HASHED_BUNDLE.test(path.posix.basename(relPath))) return IMMUTABLE;
  return REVALIDATE;
}

export type ContentEncoding = 'br' | 'gzip';
const MIN_COMPRESS_BYTES = 1024;

export function isCompressible(mime: string): boolean {
  const base = (mime.split(';', 1)[0] ?? '').trim().toLowerCase();
  if (base.startsWith('text/')) return true;
  if (base === 'font/ttf' || base === 'font/otf' || base === 'image/svg+xml' || base === 'application/wasm') return true;
  return /^application\/(javascript|x-javascript|ecmascript|json|ld\+json|manifest\+json|xml|xhtml\+xml)$/.test(base);
}

/** br, then gzip, from Accept-Encoding (q=0 and `*` honoured); null means identity. */
export function negotiateEncoding(acceptEncoding: string | undefined): ContentEncoding | null {
  if (!acceptEncoding) return null;
  const q = new Map<string, number>();
  for (const part of acceptEncoding.split(',')) {
    const [rawName, ...params] = part.split(';');
    const name = (rawName ?? '').trim().toLowerCase();
    if (!name) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) weight = Number(m[1]);
    }
    q.set(name, Number.isFinite(weight) ? weight : 0);
  }
  const allowed = (enc: string): boolean => {
    const weight = q.get(enc) ?? q.get('*');
    return weight !== undefined && weight > 0;
  };
  if (allowed('br')) return 'br';
  if (allowed('gzip')) return 'gzip';
  return null;
}

function encoder(enc: ContentEncoding, sizeHint: number): zlib.BrotliCompress | zlib.Gzip {
  if (enc === 'br') {
    return zlib.createBrotliCompress({
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: sizeHint },
    });
  }
  return zlib.createGzip({ level: 6 });
}

const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

function compressBuffer(enc: ContentEncoding, raw: Buffer): Promise<Buffer> {
  if (enc === 'br') {
    return brotliCompress(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
    });
  }
  return gzipCompress(raw, { level: 6 });
}

/** Files above this are streamed uncompressed rather than held in memory for the cache. */
export const MAX_CACHED_SOURCE_BYTES = 24 * 1024 * 1024;
/** Total compressed bytes the cache may hold (a whole Expo export compresses to a few MB). */
export const COMPRESSION_CACHE_BYTES = 64 * 1024 * 1024;
const COMPRESSION_CACHE_ENTRIES = 256;

/**
 * Compressed representations, keyed by path + size + mtime + encoding, so a rebuild invalidates for free and the
 * second and every later request is a buffer write instead of a fresh brotli pass over a multi-MB bundle. The
 * middleware is unauthenticated, so without this a loop of `curl -H 'Accept-Encoding: br'` would keep one
 * compressor per request busy on the event loop. Concurrent misses for one key share a single compression.
 */
export class CompressionCache {
  private readonly ready = new Map<string, Buffer>();
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private bytes = 0;

  constructor(
    private readonly maxBytes = COMPRESSION_CACHE_BYTES,
    private readonly maxEntries = COMPRESSION_CACHE_ENTRIES,
  ) {}

  static key(relPath: string, file: { size: number; mtimeMs: number }, enc: ContentEncoding): string {
    return `${relPath}|${file.size}|${Math.floor(file.mtimeMs)}|${enc}`;
  }

  get size(): number {
    return this.ready.size;
  }

  get(key: string): Buffer | undefined {
    const hit = this.ready.get(key);
    if (hit) {
      // refresh LRU position
      this.ready.delete(key);
      this.ready.set(key, hit);
    }
    return hit;
  }

  /** Compress via `produce` once per key; callers arriving while it runs await the same promise. */
  compute(key: string, produce: () => Promise<Buffer>): Promise<Buffer> {
    const hit = this.get(key);
    if (hit) return Promise.resolve(hit);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = produce()
      .then((buf) => {
        this.store(key, buf);
        return buf;
      })
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  private store(key: string, buf: Buffer): void {
    if (buf.length > this.maxBytes) return;
    const prev = this.ready.get(key);
    if (prev) {
      this.bytes -= prev.length;
      this.ready.delete(key);
    }
    this.ready.set(key, buf);
    this.bytes += buf.length;
    while ((this.bytes > this.maxBytes || this.ready.size > this.maxEntries) && this.ready.size > 0) {
      const oldest = this.ready.keys().next().value as string;
      const gone = this.ready.get(oldest);
      this.ready.delete(oldest);
      if (gone) this.bytes -= gone.length;
    }
  }
}

/** Weak validator from size + mtime; the encoding is part of it because the bytes differ per representation. */
export function etagFor(file: { size: number; mtimeMs: number }, enc: ContentEncoding | null): string {
  return `W/"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}${enc ? `-${enc}` : ''}"`;
}

export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const strip = (t: string): string => t.trim().replace(/^W\//i, '');
  const want = strip(etag);
  return ifNoneMatch.split(',').some((t) => {
    const s = strip(t);
    return s === '*' || s === want;
  });
}

export function notModifiedSince(ifModifiedSince: string | undefined, mtimeMs: number): boolean {
  if (!ifModifiedSince) return false;
  const since = Date.parse(ifModifiedSince);
  if (Number.isNaN(since)) return false;
  return Math.floor(mtimeMs / 1000) * 1000 <= since;
}

// ---------------------------------------------------------------------------- middleware
/** The exported Expo web app at `/` (index.html, _expo/, SPA fallback). */
export function webAppMiddleware(ctx: ServerContext): MiddlewareHandler<AuthedEnv> {
  return staticSiteMiddleware(ctx, webAppSite(ctx.config), null);
}

/** The Studio at `/studio/`; without a build every /studio request gets a small "not built yet" page instead of the phone app. */
export function studioMiddleware(ctx: ServerContext): MiddlewareHandler<AuthedEnv> {
  return staticSiteMiddleware(ctx, studioSite(ctx.config), studioMissingPage);
}

const CSP_PLAIN = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function studioMissingPage(ctx: ServerContext, candidates: WebAppCandidate[]): string {
  const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
  const looked = candidates.map((c) => `<li><code>${esc(c.dir)}</code></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio · ${esc(ctx.serverName)}</title>
<style>html{background:#121311;color:#f3f2ed;font:15px/1.5 -apple-system,Inter,"Segoe UI",system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center}
main{max-width:560px;padding:32px;border:1px solid #30342c;border-radius:24px;background:#1a1c19}h1{font-size:18px;margin:0 0 8px}p{color:#b0b6a8;margin:8px 0}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:#e9ad52}ul{padding-left:18px;color:#b0b6a8}</style></head>
<body><main><h1>Studio is not built yet</h1><p>The daemon looked for <code>index.html</code> in:</p><ul>${looked}</ul>
<p>Run <code>pnpm build</code> in the checkout (it bundles <code>apps/studio/dist</code>), or set <code>"studio": { "dir": "…" }</code> in <code>config.json</code>, then reload.</p></main></body></html>`;
}

function staticSiteMiddleware(
  ctx: ServerContext,
  site: StaticSite,
  missingPage: ((ctx: ServerContext, candidates: WebAppCandidate[]) => string) | null,
): MiddlewareHandler<AuthedEnv> {
  const log = ctx.log.child({ mod: 'webapp', site: site.name });
  const tracker = new ResolutionTracker(log, site);
  const compressed = new CompressionCache();
  // One line at boot saying where the site is served from (or that it is missing), before any request arrives.
  void resolveSite(ctx.config, site).then((r) => tracker.observe(r));

  return async (c, next) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') return next();
    const fullPath = new URL(c.req.url).pathname.replace(/\/{2,}/g, '/');
    if (isReservedPath(fullPath)) return next();
    // Sites below a prefix only see their own subtree. `/studio` (no slash) redirects to `/studio/` so the page's
    // relative asset URLs resolve inside the prefix.
    if (site.prefix !== '' && fullPath !== site.prefix && !fullPath.startsWith(`${site.prefix}/`)) return next();
    if (site.prefix !== '' && fullPath === site.prefix) {
      const search = new URL(c.req.url).search;
      return c.redirect(`${site.prefix}/${search}`, 301);
    }
    const pathname = site.prefix === '' ? fullPath : fullPath.slice(site.prefix.length) || '/';
    const segments = safeSegments(pathname);
    if (!segments) return next();

    const started = performance.now();
    const resolution = await resolveSite(ctx.config, site);
    tracker.observe(resolution);
    const app = resolution.location;
    if (!app) {
      if (missingPage && acceptsHtml(c.req.header('accept'))) {
        return c.html(missingPage(ctx, resolution.candidates), 503, {
          'Content-Security-Policy': CSP_PLAIN,
          'X-Frame-Options': 'DENY',
          'Cache-Control': 'no-store',
        });
      }
      return next();
    }
    let rootReal: string;
    try {
      rootReal = await fs.promises.realpath(app.dir);
    } catch {
      return next();
    }

    let rel = segments.length === 0 ? ['index.html'] : segments;
    let file = await openUnder(rootReal, rel);
    let fallback = false;
    if (!file) {
      // SPA fallback: only for navigations (Accept: text/html); fetch()/asset misses keep the JSON 404.
      if (!acceptsHtml(c.req.header('accept'))) return next();
      rel = ['index.html'];
      file = await openUnder(rootReal, rel);
      if (!file) return next();
      fallback = true;
    }

    const relPath = rel.join('/');
    const finish = (status: number, encoding: ContentEncoding | null): void => {
      log.debug('webapp.request', {
        method,
        path: pathname,
        file: relPath,
        status,
        fallback,
        encoding,
        ms: Math.round((performance.now() - started) * 10) / 10,
      });
    };

    try {
      const mime = getMimeType(relPath) ?? 'application/octet-stream';
      const compressible = isCompressible(mime);
      const encoding = compressible && file.size >= MIN_COMPRESS_BYTES ? negotiateEncoding(c.req.header('accept-encoding')) : null;
      const etag = etagFor(file, encoding);
      const headers: Record<string, string> = {
        'Content-Type': mime,
        'Cache-Control': fallback ? REVALIDATE : cachePolicyFor(relPath),
        ETag: etag,
        'Last-Modified': new Date(file.mtimeMs).toUTCString(),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        // The signed-in app (bearer token in localStorage) must never be framed by another page: an iframe of
        // /session/<id> would let that page clickjack the permission sheet's Allow button or the Terminal tab.
        'Content-Security-Policy': "frame-ancestors 'none'",
        'X-Frame-Options': 'DENY',
      };
      if (compressible) headers.Vary = 'Accept-Encoding';

      const ifNoneMatch = c.req.header('if-none-match');
      const fresh =
        ifNoneMatch !== undefined ? etagMatches(ifNoneMatch, etag) : notModifiedSince(c.req.header('if-modified-since'), file.mtimeMs);
      if (fresh) {
        await file.handle.close();
        finish(304, null);
        return c.body(null, 304, headers);
      }
      if (method === 'HEAD') {
        // Describe the representation the matching GET would send: a HEAD that ignored Accept-Encoding advertised an
        // ETag the GET never answers with (every revalidation missed) and the uncompressed length of a compressed body.
        if (encoding) {
          headers['Content-Encoding'] = encoding;
          const cached = file.size <= MAX_CACHED_SOURCE_BYTES ? compressed.get(CompressionCache.key(relPath, file, encoding)) : undefined;
          if (cached) headers['Content-Length'] = String(cached.length);
        } else {
          headers['Content-Length'] = String(file.size);
        }
        await file.handle.close();
        finish(200, encoding);
        return c.body(null, 200, headers);
      }

      if (encoding && file.size <= MAX_CACHED_SOURCE_BYTES) {
        // Compress once per (file, mtime, encoding) and serve the cached bytes from then on.
        const handle = file.handle;
        const key = CompressionCache.key(relPath, file, encoding);
        let buf: Buffer;
        try {
          buf = await compressed.compute(key, async () => compressBuffer(encoding, await handle.readFile()));
        } finally {
          await handle.close().catch(() => undefined);
        }
        headers['Content-Encoding'] = encoding;
        headers['Content-Length'] = String(buf.length);
        finish(200, encoding);
        return c.body(new Uint8Array(buf), 200, headers);
      }

      // autoClose: the handle goes with the stream — on end, on error, and when the client hangs up (cancel → destroy).
      const source = file.handle.createReadStream({ autoClose: true });
      let body: Readable = source;
      if (encoding) {
        headers['Content-Encoding'] = encoding;
        body = pipeline(source, encoder(encoding, file.size), (err) => {
          if (err && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE')
            log.debug('webapp.stream_failed', { file: relPath, ...errorInfo(err) });
        });
      } else {
        headers['Content-Length'] = String(file.size);
        source.on('error', (err) => log.debug('webapp.stream_failed', { file: relPath, ...errorInfo(err) }));
      }
      finish(200, encoding);
      return c.body(Readable.toWeb(body) as ReadableStream, 200, headers);
    } catch (err) {
      await file.handle.close().catch(() => undefined);
      throw err;
    }
  };
}
