/**
 * Deep links and notification targets.
 *
 * URL shapes this app understands:
 *   mobileide://pair?server=<url>&code=<code>        native deep link
 *   https://<host>/pair?server=<url>#<code>          what `mide pair` prints / QR-encodes (fragment keeps the code out of logs)
 *   mobileide://session/<id>  |  https://<host>/session/<id>   notification Click URLs
 *
 * Expo Router already maps both shapes onto `app/(auth)/pair.tsx` and `app/session/[id].tsx`.
 * This module parses what the router does not (URL fragments, notification `data` payloads),
 * turns them into in-app hrefs, and queues navigation until the root navigator exists.
 */
import * as Linking from 'expo-linking';
import { router, type Href } from 'expo-router';
import { Platform } from 'react-native';

export const APP_SCHEME = 'mobileide';
export const PAIR_PATH = '/pair';

export interface PairLinkParams {
  server?: string;
  code?: string;
  /** `server` was not in the link itself but taken from the origin of a `/pair` URL */
  serverInferred?: boolean;
}

export interface NotificationTarget {
  sessionId?: string | null;
  /** a permission notification names its request so the tap opens the sheet, not just the chat */
  permissionId?: string | null;
  url?: string | null;
}

/** After normalisation a code is upper-case alphanumerics; 4..64 keeps us lenient about the daemon's alphabet. */
const CODE_RE = /^[A-Z0-9_]{4,64}$/;

export function first(v: string | string[] | undefined | null): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

/** Same normalisation the daemon applies (`auth.ts`): strip whitespace and dashes, upper-case. No validation. */
export function normalizeCodeInput(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/** Normalise a code found in a link and reject anything that cannot be one. */
export function cleanCode(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  s = normalizeCodeInput(s);
  return CODE_RE.test(s) ? s : undefined;
}

interface UrlParts {
  origin: string | null;
  path: string;
  params: URLSearchParams;
  http: boolean;
}

function parseHttp(u: string): UrlParts | null {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    return { origin: x.origin, path: x.pathname, params: x.searchParams, http: true };
  } catch {
    return null;
  }
}

/** `mobileide://pair?…` → { path: '/pair', params } via expo-linking's scheme-agnostic parser. */
function parseCustom(u: string): UrlParts | null {
  try {
    const p = Linking.parse(u);
    const path = '/' + [p.hostname, p.path].filter((s): s is string => !!s).join('/').replace(/^\/+/, '');
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(p.queryParams ?? {})) {
      const val = first(v as string | string[] | undefined);
      if (val !== undefined) params.set(k, val);
    }
    return { origin: null, path, params, http: false };
  } catch {
    return null;
  }
}

function parseAny(u: string): UrlParts | null {
  return parseHttp(u) ?? parseCustom(u);
}

function isPairPath(path: string): boolean {
  return /(^|\/)pair\/?$/.test(path);
}

const DEV_PORTS = new Set(['8081', '8082', '19000', '19006']);

/** Metro / Expo dev server origins are never the daemon. */
function isDevServerOrigin(origin: string): boolean {
  try {
    return DEV_PORTS.has(new URL(origin).port);
  } catch {
    return false;
  }
}

/** Extract pairing params from any URL we might be opened with. A bare code is accepted too. */
export function parsePairLink(url: string | null | undefined): PairLinkParams {
  if (!url) return {};
  const raw = url.trim();
  if (!raw) return {};
  if (!/[:/?#]/.test(raw)) {
    const bare = cleanCode(raw);
    return bare ? { code: bare } : {};
  }
  const hashIdx = raw.indexOf('#');
  const fragment = hashIdx >= 0 ? raw.slice(hashIdx + 1) : '';
  const withoutHash = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;

  const parts = parseAny(withoutHash);
  const out: PairLinkParams = {};
  if (parts) {
    const server = parts.params.get('server') ?? parts.params.get('url');
    if (server?.trim()) out.server = server.trim();
    const code = cleanCode(parts.params.get('code'));
    if (code) out.code = code;
  }
  if (!out.code && fragment) {
    const frag = fragment.replace(/^\/+/, '');
    if (frag.includes('=')) {
      const fp = new URLSearchParams(frag);
      out.code = cleanCode(fp.get('code')) ?? out.code;
      const fs = fp.get('server');
      if (fs && !out.server) out.server = fs;
    } else {
      out.code = cleanCode(frag) ?? out.code;
    }
  }
  // The daemon serves the pairing page itself, so its origin is the server (unless a dev server is involved).
  if (!out.server && parts?.http && parts.origin && isPairPath(parts.path) && !isDevServerOrigin(parts.origin)) {
    out.server = parts.origin;
    out.serverInferred = true;
  }
  return out;
}

/** Session id from `mobileide://session/<id>`, `https://host/session/<id>` or an Expo dev URL (`…/--/session/<id>`). */
export function sessionIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const path = parseAny(url.trim())?.path;
  if (!path) return null;
  const seg = /(?:^|\/)session\/([^/?#]+)/.exec(path)?.[1];
  if (!seg) return null;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export function sessionHref(id: string, permissionId?: string | null): string {
  const base = `/session/${encodeURIComponent(id)}`;
  return permissionId ? `${base}?permission=${encodeURIComponent(permissionId)}` : base;
}

/** `?permission=<id>` from a notification Click URL (`https://host/session/<id>?permission=<pid>`). */
export function permissionIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const q = /[?&]permission(?:Id)?=([^&#]+)/.exec(url)?.[1];
  if (!q) return null;
  try {
    return decodeURIComponent(q);
  } catch {
    return q;
  }
}

export function sessionDeepLink(id: string): string {
  return `${APP_SCHEME}://session/${encodeURIComponent(id)}`;
}

export function pairHref(p: PairLinkParams = {}): string {
  const q = new URLSearchParams();
  if (p.server) q.set('server', p.server);
  if (p.code) q.set('code', p.code);
  const s = q.toString();
  return s ? `${PAIR_PATH}?${s}` : PAIR_PATH;
}

/** In-app href for a notification payload (`data.sessionId` / `data.url`); null when there is nothing to open. */
export function hrefForNotification(t: NotificationTarget): string | null {
  const id = (t.sessionId ? String(t.sessionId) : null) || (t.url ? sessionIdFromUrl(t.url) : null);
  if (id) return sessionHref(id, (t.permissionId ? String(t.permissionId) : null) || permissionIdFromUrl(t.url));
  if (t.url) {
    const pair = parsePairLink(t.url);
    if (pair.code || pair.server) return pairHref(pair);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Navigation that tolerates being called before the root navigator has mounted
// ---------------------------------------------------------------------------
let navReady = false;
let pendingHref: string | null = null;

/** Called by the root layout once the navigator exists (and with `false` when it unmounts). */
export function setNavigationReady(ready: boolean): void {
  navReady = ready;
  if (ready && pendingHref) {
    const href = pendingHref;
    pendingHref = null;
    navigateTo(href);
  }
}

export function navigateTo(href: string, attempt = 0): void {
  if (!navReady) {
    pendingHref = href;
    return;
  }
  try {
    router.push(href as Href);
  } catch (err) {
    if (attempt < 8) {
      // The navigator can report "ready" a frame before it accepts actions; retry briefly.
      setTimeout(() => navigateTo(href, attempt + 1), 250);
    } else {
      console.warn('[links] navigation failed', href, err);
    }
  }
}

/** Open whatever a notification points at. Returns false when the payload had no target. */
export function openNotificationTarget(t: NotificationTarget): boolean {
  const href = hrefForNotification(t);
  if (!href) return false;
  navigateTo(href);
  return true;
}

// ---------------------------------------------------------------------------
// Web helpers (no-ops elsewhere)
// ---------------------------------------------------------------------------
interface WebLocation {
  href?: string;
  origin?: string;
  port?: string;
  hostname?: string;
  pathname?: string;
  search?: string;
  hash?: string;
}

function webLocation(): WebLocation | null {
  if (Platform.OS !== 'web') return null;
  try {
    return (globalThis as unknown as { location?: WebLocation }).location ?? null;
  } catch {
    return null;
  }
}

/**
 * The URL the web app was opened with, captured while this module evaluates (before the router mounts).
 * Expo Router rewrites the address bar as it settles, so a `#CODE` fragment can be gone by the time a
 * screen effect looks at `location`.
 */
const INITIAL_WEB_HREF: string | null = (() => {
  const loc = webLocation();
  return loc?.href ?? null;
})();

/** Pairing params carried by the browser location (`/pair?server=…#CODE`), falling back to the URL we started with. */
export function pairParamsFromLocation(): PairLinkParams {
  const loc = webLocation();
  const current = loc?.href ? parsePairLink(loc.href) : {};
  if (current.code || !INITIAL_WEB_HREF) return current;
  const initial = parsePairLink(INITIAL_WEB_HREF);
  return initial.code ? { ...current, code: initial.code, server: current.server ?? initial.server, serverInferred: current.server ? current.serverInferred : initial.serverInferred } : current;
}

/** The daemon URL when the web app is served by the daemon itself (never for the Metro dev server). */
export function serverUrlFromLocation(): string | null {
  const loc = webLocation();
  if (!loc?.origin || loc.origin === 'null') return null;
  if (isDevServerOrigin(loc.origin)) return null;
  return loc.origin;
}

/** Drop a consumed `#code` fragment from the address bar so a reload does not retry a burnt code. */
export function clearLocationHash(): void {
  const loc = webLocation();
  if (!loc?.hash) return;
  try {
    const h = (globalThis as unknown as { history?: { replaceState: (s: unknown, t: string, u: string) => void } }).history;
    h?.replaceState(null, '', `${loc.pathname ?? '/'}${loc.search ?? ''}`);
  } catch {
    /* ignore */
  }
}
