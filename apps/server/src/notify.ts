/**
 * Notifier: fan out to every push subscription of the target devices — ntfy, Expo Push,
 * Web Push — plus the config-level ntfy topic. Duplicates per (session, kind) are
 * suppressed for 10 s so a burst of events yields one buzz — except permission requests
 * (each one blocks the agent until answered, so every distinct request buzzes) and tests.
 *
 * Web Push needs a VAPID key pair. When the config has none, the daemon generates one at
 * startup, stores it in config.json (subscriptions are bound to the public key, so it must
 * survive restarts) and logs once; `mide vapid` does the same from the command line.
 *
 * The trigger rules (which events buzz the phone) live in sessions.ts: `permission.requested`
 * always, `turn.ended` only when the turn ran longer than 20 s or used a tool, `session.error`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type https from 'node:https';
import path from 'node:path';
import webpush from 'web-push';
import type { Config } from './config.js';
import { publicOrLocalUrl } from './config.js';
import type { Db, PushSubscriptionRow } from './db.js';
import { errorMessage } from './errors.js';
import { createLogger, errorInfo } from './log.js';

const log = createLogger({ mod: 'notify' });

export type NotifyKind = 'permission' | 'turn_done' | 'error' | 'test';
export type NotifyChannel = 'ntfy' | 'expo' | 'webpush';

export interface NotificationPayload {
  title: string;
  body: string;
  sessionId?: string;
  /** the request a `permission` notification is about: the tap opens its sheet */
  permissionId?: string;
  kind: NotifyKind;
}

/** Outcome for one addressed channel target (one ntfy topic, one Expo token, one Web Push endpoint). */
export interface ChannelResult {
  channel: NotifyChannel;
  /** ntfy `server/topic`, an elided Expo token, or a Web Push endpoint host — safe to show and log */
  target: string;
  ok: boolean;
  /** HTTP status from the push service when one was received */
  status?: number;
  error?: string;
  /** the subscription was deleted because the push service reported it gone */
  pruned?: boolean;
}

export interface NotifyResult {
  sent: number;
  failed: number;
  /** the same (session, kind) fired within the dedupe window; nothing was sent */
  suppressed: boolean;
  results: ChannelResult[];
}

export interface NotifierOptions {
  /**
   * Config file that receives auto-generated VAPID keys. Omitted: `config.json` next to the DB
   * (the default location `loadConfig` uses). `null`: never write to disk.
   */
  configPath?: string | null;
  /** Expo push API endpoint (tests point it at a stub). */
  expoPushUrl?: string;
  /** Agent for Web Push requests (tests trust a self-signed stub). */
  webPushAgent?: https.Agent;
  /** Clock (tests). */
  now?: () => number;
}

/** A second notification for the same (session, kind) within this window is dropped (`permission` and `test` are exempt). */
export const DEDUP_MS = 10_000;
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo accepts at most 100 messages per request. */
export const EXPO_BATCH_SIZE = 100;
/** ntfy turns messages over 4096 bytes into attachments; stay well under. */
export const NTFY_MAX_BODY_BYTES = 4000;
export const NTFY_MAX_TITLE_CHARS = 250;
/**
 * Expo rejects a message over 4096 bytes and Web Push payloads top out near 4 KB, so every channel
 * gets the same trimmed text (ntfy has its own, looser cap on top).
 */
export const MAX_TITLE_CHARS = 250;
export const MAX_BODY_BYTES = 3000;
/** How long a push service may hold an undelivered message (seconds). */
export const PUSH_TTL_S = 3600;
const HTTP_TIMEOUT_MS = 15_000;

const NTFY_TAGS: Record<NotifyKind, string> = { permission: 'bell,lock', turn_done: 'white_check_mark', error: 'warning', test: 'test_tube' };
/** ntfy priorities: min, low, default, high, max/urgent. A permission prompt blocks the agent, so it pops over. */
const NTFY_PRIORITY: Record<NotifyKind, string> = { permission: 'high', turn_done: 'default', error: 'high', test: 'default' };

// ---------------------------------------------------------------------------- VAPID keys
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export type VapidState =
  | { state: 'ready'; keys: VapidKeys }
  /** neither key configured */
  | { state: 'missing' }
  /** exactly one of the two keys configured */
  | { state: 'partial' }
  | { state: 'invalid'; reason: string };

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return { publicKey, privateKey };
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Strict base64url (no padding, url-safe alphabet) — what `web-push` requires for VAPID keys. */
function decodeBase64UrlStrict(s: string): Buffer | null {
  const clean = s.trim();
  if (!clean || !BASE64URL.test(clean)) return null;
  return Buffer.from(clean, 'base64url');
}

/** Lenient base64 (either alphabet, padding optional) — browsers differ in how they serialize subscription keys. */
function decodeBase64Lenient(s: string): Buffer | null {
  const clean = s.trim().replace(/=+$/, '');
  if (!clean || /[^A-Za-z0-9_\-+/]/.test(clean)) return null;
  return Buffer.from(clean, 'base64');
}

/** Why a pair cannot be used, or null when it is a matching P-256 pair in base64url. */
export function vapidKeysProblem(keys: VapidKeys): string | null {
  const pub = decodeBase64UrlStrict(keys.publicKey);
  if (!pub || pub.length !== 65 || pub[0] !== 0x04) return 'vapidPublicKey must be a 65-byte uncompressed P-256 point in unpadded base64url (87 characters)';
  const priv = decodeBase64UrlStrict(keys.privateKey);
  if (!priv || priv.length !== 32) return 'vapidPrivateKey must be a 32-byte P-256 scalar in unpadded base64url (43 characters)';
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    if (!ecdh.getPublicKey().equals(pub)) return 'vapidPublicKey does not belong to vapidPrivateKey (keys from two different pairs?)';
  } catch (err) {
    return `vapidPrivateKey is not a valid P-256 private key: ${errorMessage(err)}`;
  }
  return null;
}

export function vapidState(config: Config): VapidState {
  const wp = config.notifications.webpush;
  const publicKey = wp.vapidPublicKey?.trim() || null;
  const privateKey = wp.vapidPrivateKey?.trim() || null;
  if (!publicKey && !privateKey) return { state: 'missing' };
  if (!publicKey || !privateKey) return { state: 'partial' };
  const reason = vapidKeysProblem({ publicKey, privateKey });
  return reason ? { state: 'invalid', reason } : { state: 'ready', keys: { publicKey, privateKey } };
}

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The VAPID pair a config file holds, read as raw JSON (no schema, so unknown keys survive a rewrite). */
export function readVapidKeysFromFile(configPath: string): { keys: VapidKeys | null; raw: JsonObject } {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
  if (!isObject(raw)) throw new Error(`${configPath} does not contain a JSON object`);
  const notifications = isObject(raw.notifications) ? raw.notifications : {};
  const wp = isObject(notifications.webpush) ? notifications.webpush : {};
  const publicKey = typeof wp.vapidPublicKey === 'string' && wp.vapidPublicKey.trim() ? wp.vapidPublicKey.trim() : null;
  const privateKey = typeof wp.vapidPrivateKey === 'string' && wp.vapidPrivateKey.trim() ? wp.vapidPrivateKey.trim() : null;
  return { keys: publicKey && privateKey ? { publicKey, privateKey } : null, raw };
}

/**
 * Write the pair into `notifications.webpush` of the config file, leaving every other key
 * (including ones the schema does not know) untouched. Atomic: temp file + rename, mode 0600.
 */
export function persistVapidKeys(configPath: string, keys: VapidKeys): void {
  const { raw } = readVapidKeysFromFile(configPath);
  const notifications = isObject(raw.notifications) ? raw.notifications : {};
  const wp = isObject(notifications.webpush) ? notifications.webpush : {};
  notifications.webpush = { ...wp, vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey };
  raw.notifications = notifications;
  const tmp = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.renameSync(tmp, configPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export interface EnsureVapidResult {
  keys: VapidKeys;
  /** a new pair was generated by this call */
  created: boolean;
  /** the pair is stored in `configPath` (written now, or already there) */
  persisted: boolean;
  configPath: string | null;
  /** why the pair could not be stored, when `persisted` is false and a path was given */
  persistError?: string;
}

/**
 * Make sure `config` has a usable VAPID pair, generating and storing one when it has none.
 * Mutates `config.notifications.webpush` in place so the running daemon and the file agree.
 * A valid pair already present in the file wins over generating a fresh one (a daemon started
 * from a config that predates the write, or `mide vapid` racing the daemon).
 * `rotate` replaces whatever is there; browsers subscribed with the old key must re-enable
 * Web Push (the PWA does so on its next launch when it sees a different key).
 * Throws when the existing pair is unusable and `rotate` is not set.
 */
export function ensureVapidKeys(config: Config, opts: { configPath: string | null; rotate?: boolean }): EnsureVapidResult {
  const wp = config.notifications.webpush;
  const current = vapidState(config);
  let keys: VapidKeys | null = null;
  let created = false;
  if (!opts.rotate) {
    if (current.state === 'partial') {
      throw new Error('config has only one of notifications.webpush.vapidPublicKey / vapidPrivateKey — run `mide vapid --rotate` to replace the pair');
    }
    if (current.state === 'invalid') throw new Error(`config has an unusable VAPID pair (${current.reason}) — run \`mide vapid --rotate\` to replace it`);
    if (current.state === 'ready') keys = current.keys;
    if (!keys && opts.configPath) {
      try {
        const fromFile = readVapidKeysFromFile(opts.configPath).keys;
        if (fromFile && !vapidKeysProblem(fromFile)) keys = fromFile;
      } catch {
        /* unreadable or missing: generate below; persisting reports the problem */
      }
    }
  }
  if (!keys) {
    keys = generateVapidKeys();
    created = true;
  }
  wp.vapidPublicKey = keys.publicKey;
  wp.vapidPrivateKey = keys.privateKey;

  let persisted = false;
  let persistError: string | undefined;
  if (opts.configPath) {
    try {
      const onDisk = readVapidKeysFromFile(opts.configPath).keys;
      if (!(onDisk && onDisk.publicKey === keys.publicKey && onDisk.privateKey === keys.privateKey)) persistVapidKeys(opts.configPath, keys);
      persisted = true;
    } catch (err) {
      persistError = errorMessage(err);
    }
  }
  const result: EnsureVapidResult = { keys, created, persisted, configPath: opts.configPath };
  if (persistError !== undefined) result.persistError = persistError;
  return result;
}

// ---------------------------------------------------------------------------- registration checks
const EXPO_TOKEN = /^Expo(nent)?PushToken\[[^\]\s]{1,200}\]$/;

/** Expo push tokens look like `ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]`. */
export function isExpoPushToken(token: string): boolean {
  return EXPO_TOKEN.test(token.trim());
}

export interface WebPushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Why a browser subscription can never receive a message, or null when it is well-formed. */
export function webPushSubscriptionProblem(sub: WebPushSubscriptionInput): string | null {
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return 'endpoint is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'endpoint must be an https URL';
  const p256dh = decodeBase64Lenient(sub.keys.p256dh);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 0x04) return 'keys.p256dh must be a 65-byte uncompressed P-256 point in base64';
  const auth = decodeBase64Lenient(sub.keys.auth);
  if (!auth || auth.length < 16) return 'keys.auth must be at least 16 bytes in base64';
  return null;
}

// ---------------------------------------------------------------------------- text helpers
/**
 * HTTP header values are Latin-1; `fetch` rejects anything above U+00FF (an em dash in a session
 * title used to make every ntfy send fail). ntfy documents RFC 2047 encoded-words for exactly this,
 * so anything outside printable ASCII is sent as `=?UTF-8?B?…?=`. Control characters (CR/LF would
 * be header injection) are collapsed into spaces.
 */
export function ntfyHeaderValue(value: string, maxChars = NTFY_MAX_TITLE_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const capped = [...clean].slice(0, maxChars).join('');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(capped)) return capped;
  return encodeRfc2047(capped);
}

/** RFC 2047 base64 encoded-words, each within the 75-character limit; adjacent words decode as one string. */
export function encodeRfc2047(value: string): string {
  // "=?UTF-8?B?" + base64 + "?=" is 12 characters of framing: 63 base64 chars = 45 input bytes fit.
  const MAX_BYTES = 45;
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (chunk && Buffer.byteLength(chunk + ch, 'utf8') > MAX_BYTES) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ');
}

/** Cut at a character boundary so the result is at most `maxBytes` of UTF-8, marking the cut with an ellipsis. */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const ellipsis = '…';
  const budget = maxBytes - Buffer.byteLength(ellipsis, 'utf8');
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out + ellipsis;
}

/** One title/body for all channels: whitespace-collapsed title, CRLF-normalized body, both capped (see MAX_*). */
export function normalizePayload(n: NotificationPayload): NotificationPayload {
  const title = [...n.title.replace(/\s+/g, ' ').trim()].slice(0, MAX_TITLE_CHARS).join('') || 'Mobile IDE';
  const body = truncateUtf8(n.body.replace(/\r\n?/g, '\n').trim(), MAX_BODY_BYTES);
  const out: NotificationPayload = { title, body, kind: n.kind };
  if (n.sessionId) out.sessionId = n.sessionId;
  if (n.permissionId) out.permissionId = n.permissionId;
  return out;
}

function normalizeServer(server: string): string {
  return server.trim().replace(/\/+$/, '');
}

/** `ExponentPushToken[abcd…wxyz]` — enough to tell tokens apart in a log without leaking them. */
export function elideToken(token: string): string {
  const m = /^(\w+\[)(.+)(\])$/.exec(token);
  if (m && m[2] && m[2].length > 10) return `${m[1]}${m[2].slice(0, 4)}…${m[2].slice(-4)}${m[3]}`;
  return token.length > 12 ? `${token.slice(0, 8)}…` : token;
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint.slice(0, 40);
  }
}

// ---------------------------------------------------------------------------- notifier
interface NtfyTarget {
  server: string;
  topic: string;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}
interface ExpoResponse {
  data?: ExpoTicket[];
  errors?: { code?: string; message?: string }[];
}

/** Default config location for a DB at `<home>/mide.db`: `<home>/config.json` (what `loadConfig` uses). */
function defaultConfigPathFor(db: Db): string | null {
  if (db.file === ':memory:') return null;
  return path.join(path.dirname(db.file), 'config.json');
}

export class Notifier {
  private readonly recent = new Map<string, number>();
  private readonly now: () => number;
  private readonly expoPushUrl: string;
  private readonly webPushAgent: https.Agent | undefined;
  private readonly configPath: string | null;
  private vapid: VapidKeys | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    opts: NotifierOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.expoPushUrl = opts.expoPushUrl ?? EXPO_PUSH_URL;
    this.webPushAgent = opts.webPushAgent;
    this.configPath = opts.configPath === undefined ? defaultConfigPathFor(db) : opts.configPath;
    this.initVapid();
  }

  /** Public VAPID key browsers subscribe with; null only when the configured pair is broken. */
  get vapidPublicKey(): string | null {
    return this.vapid?.publicKey ?? null;
  }

  /** Runs once at construction: adopt configured keys, or generate + store a pair. Logs once. */
  private initVapid(): void {
    const subject = this.config.notifications.webpush.subject.trim();
    if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/i.test(subject)) {
      log.warn('webpush.subject_suspicious', {
        subject,
        hint: 'notifications.webpush.subject should be mailto:you@example.com or an https URL; push services may reject the VAPID token otherwise',
      });
    }
    const st = vapidState(this.config);
    switch (st.state) {
      case 'ready':
        this.vapid = st.keys;
        return;
      case 'partial':
        log.warn('webpush.vapid_incomplete', {
          hint: 'only one of notifications.webpush.vapidPublicKey / vapidPrivateKey is set; run `mide vapid --rotate` — Web Push is off until then',
        });
        return;
      case 'invalid':
        log.warn('webpush.vapid_invalid', { reason: st.reason, hint: 'run `mide vapid --rotate` — Web Push is off until then' });
        return;
      case 'missing':
        break;
    }
    try {
      const r = ensureVapidKeys(this.config, { configPath: this.configPath });
      this.vapid = r.keys;
      if (r.created) log.info('webpush.vapid_generated', { configPath: r.configPath, persisted: r.persisted });
      else log.info('webpush.vapid_loaded', { configPath: r.configPath });
      if (!r.persisted) {
        log.warn('webpush.vapid_not_persisted', {
          configPath: r.configPath,
          ...(r.persistError ? { error: r.persistError } : {}),
          hint: 'Web Push subscriptions made now break at the next restart; run `mide vapid` to store the keys in config.json',
        });
      }
    } catch (err) {
      log.warn('webpush.vapid_unavailable', errorInfo(err));
    }
  }

  /**
   * Where a tap lands: the session when there is one, else the app itself. Only meaningful when a
   * publicUrl the phone can open is configured (a loopback address would dead-end the tap).
   */
  private clickUrl(n: Pick<NotificationPayload, 'sessionId' | 'permissionId'>): string | undefined {
    if (!this.config.publicUrl) return undefined;
    const base = this.config.publicUrl.replace(/\/+$/, '');
    if (!n.sessionId) return `${base}/`;
    const url = `${base}/session/${encodeURIComponent(n.sessionId)}`;
    return n.permissionId ? `${url}?permission=${encodeURIComponent(n.permissionId)}` : url;
  }

  /** Dedupe key, or null for kinds that must always go out. */
  private dedupeKey(n: NotificationPayload): string | null {
    if (n.kind === 'test' || n.kind === 'permission') return null;
    return `${n.sessionId ?? '-'}:${n.kind}`;
  }

  private shouldSuppress(key: string | null): boolean {
    if (key === null) return false;
    const last = this.recent.get(key);
    return last !== undefined && this.now() - last < DEDUP_MS;
  }

  /**
   * Reserve the dedupe window. Called BEFORE the fan-out (so overlapping notifications for one key cannot all pass the
   * check while the first is still talking to a slow push service) and released again by `release()` when nothing
   * was delivered, so a total failure never silences the follow-up.
   */
  private markSent(key: string | null): void {
    if (key === null) return;
    const now = this.now();
    this.recent.set(key, now);
    if (this.recent.size > 500) {
      for (const [k, t] of this.recent) if (now - t >= DEDUP_MS) this.recent.delete(k);
    }
  }

  private release(key: string | null): void {
    if (key !== null) this.recent.delete(key);
  }

  /**
   * Deliver to every channel of `target` devices (`'all'` = every paired device) plus the
   * config-level ntfy topic. Never throws; per-target outcomes come back in `results`.
   */
  async notify(target: string[] | 'all', payload: NotificationPayload): Promise<NotifyResult> {
    const n = normalizePayload(payload);
    const key = this.dedupeKey(n);
    if (this.shouldSuppress(key)) {
      log.debug('notify.suppressed', { kind: n.kind, sessionId: n.sessionId });
      return { sent: 0, failed: 0, suppressed: true, results: [] };
    }
    this.markSent(key);
    try {
      const result = await this.fanOut(target, n);
      if (result.sent === 0) this.release(key);
      return result;
    } catch (err) {
      // e.g. the DB was closed under us during shutdown — a notification is never worth an unhandled rejection
      this.release(key);
      log.warn('notify.failed', { kind: n.kind, sessionId: n.sessionId, ...errorInfo(err) });
      return { sent: 0, failed: 1, suppressed: false, results: [] };
    }
  }

  private async fanOut(target: string[] | 'all', n: NotificationPayload): Promise<NotifyResult> {
    const subs = this.db.listPushSubscriptions(target === 'all' ? undefined : target);
    const tasks: Promise<ChannelResult[]>[] = [];

    // ntfy: one POST per distinct server/topic, whether it came from a device or from the config.
    const ntfyCfg = this.config.notifications.ntfy;
    const ntfy = new Map<string, NtfyTarget>();
    const addNtfy = (server: string | undefined, topic: string): void => {
      const s = normalizeServer(server && server.trim() ? server : ntfyCfg.server);
      ntfy.set(`${s}/${topic}`, { server: s, topic });
    };
    for (const s of subs) {
      if (s.kind !== 'ntfy') continue;
      const p = s.payload as Partial<{ server: string; topic: string }> | null;
      if (p && typeof p.topic === 'string' && p.topic) addNtfy(typeof p.server === 'string' ? p.server : undefined, p.topic);
    }
    if (ntfyCfg.topic) addNtfy(ntfyCfg.server, ntfyCfg.topic);
    for (const t of ntfy.values()) tasks.push(this.sendNtfy(t, n).then((r) => [r]));

    const expo = subs.filter((s) => s.kind === 'expo');
    if (expo.length) {
      if (this.config.notifications.expo.enabled) tasks.push(this.sendExpo(expo, n));
      else log.debug('expo.disabled', { count: expo.length });
    }

    for (const s of subs) if (s.kind === 'webpush') tasks.push(this.sendWebPush(s, n).then((r) => [r]));

    const results = (await Promise.all(tasks)).flat();
    const sent = results.filter((r) => r.ok).length;
    const failed = results.length - sent;
    log.debug('notify', { kind: n.kind, sessionId: n.sessionId, sent, failed, targets: results.length });
    return { sent, failed, suppressed: false, results };
  }

  private async sendNtfy(t: NtfyTarget, n: NotificationPayload): Promise<ChannelResult> {
    const target = `${t.server}/${t.topic}`;
    const url = `${t.server}/${encodeURIComponent(t.topic)}`;
    const headers: Record<string, string> = {
      Title: ntfyHeaderValue(n.title),
      Tags: NTFY_TAGS[n.kind],
      Priority: NTFY_PRIORITY[n.kind],
    };
    const click = this.clickUrl(n);
    if (click) headers.Click = click;
    const body = truncateUtf8(n.body.trim() || n.title, NTFY_MAX_BODY_BYTES);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
        log.warn('ntfy.failed', { target, status: res.status, detail });
        return { channel: 'ntfy', target, ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
      }
      return { channel: 'ntfy', target, ok: true, status: res.status };
    } catch (err) {
      log.warn('ntfy.error', { target, ...errorInfo(err) });
      return { channel: 'ntfy', target, ok: false, error: errorMessage(err) };
    }
  }

  private async sendExpo(subs: PushSubscriptionRow[], n: NotificationPayload): Promise<ChannelResult[]> {
    const entries = subs.flatMap((s) => {
      const token = (s.payload as { token?: unknown } | null)?.token;
      return typeof token === 'string' && token ? [{ s, token }] : [];
    });
    const results: ChannelResult[] = [];
    if (!entries.length) return results;
    const url = this.clickUrl(n) ?? null;
    for (let i = 0; i < entries.length; i += EXPO_BATCH_SIZE) {
      const batch = entries.slice(i, i + EXPO_BATCH_SIZE);
      const messages = batch.map(({ token }) => ({
        to: token,
        title: n.title,
        body: n.body,
        sound: 'default',
        priority: 'high',
        channelId: 'default',
        ttl: PUSH_TTL_S,
        data: { sessionId: n.sessionId ?? null, permissionId: n.permissionId ?? null, kind: n.kind, url },
      }));
      let res: Response;
      try {
        res = await fetch(this.expoPushUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(messages),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
      } catch (err) {
        log.warn('expo.error', errorInfo(err));
        for (const e of batch) results.push({ channel: 'expo', target: elideToken(e.token), ok: false, error: errorMessage(err) });
        continue;
      }
      const body = (await res.json().catch(() => null)) as ExpoResponse | null;
      if (!res.ok || !Array.isArray(body?.data)) {
        const error = body?.errors?.map((e) => [e.code, e.message].filter(Boolean).join(': ')).join('; ') || `HTTP ${res.status}`;
        log.warn('expo.failed', { status: res.status, error });
        for (const e of batch) results.push({ channel: 'expo', target: elideToken(e.token), ok: false, status: res.status, error });
        continue;
      }
      // Tickets come back in request order; a short answer leaves the tail of the batch unaccounted for.
      for (const [idx, e] of batch.entries()) {
        const target = elideToken(e.token);
        const ticket = body.data[idx];
        if (!ticket) {
          results.push({ channel: 'expo', target, ok: false, status: res.status, error: 'no ticket in the Expo response' });
          continue;
        }
        if (ticket.status === 'ok') {
          results.push({ channel: 'expo', target, ok: true, status: res.status });
          continue;
        }
        const code = ticket.details?.error;
        const error = [code, ticket.message].filter(Boolean).join(': ') || 'error';
        if (code === 'DeviceNotRegistered') {
          this.db.deletePushSubscription(e.s.id);
          log.info('expo.pruned', { deviceId: e.s.deviceId, target });
          results.push({ channel: 'expo', target, ok: false, status: res.status, error, pruned: true });
        } else {
          log.warn('expo.ticket_error', { deviceId: e.s.deviceId, target, error });
          results.push({ channel: 'expo', target, ok: false, status: res.status, error });
        }
      }
    }
    return results;
  }

  private async sendWebPush(sub: PushSubscriptionRow, n: NotificationPayload): Promise<ChannelResult> {
    const p = sub.payload as Partial<WebPushSubscriptionInput> | null;
    const endpoint = typeof p?.endpoint === 'string' ? p.endpoint : '';
    const target = endpointHost(endpoint);
    if (!this.vapid) {
      log.debug('webpush.skipped_no_vapid', { target });
      return { channel: 'webpush', target, ok: false, error: 'no usable VAPID keys on the daemon' };
    }
    if (!endpoint || typeof p?.keys?.p256dh !== 'string' || typeof p.keys.auth !== 'string') {
      return { channel: 'webpush', target, ok: false, error: 'malformed subscription' };
    }
    const payload = JSON.stringify({
      title: n.title,
      body: n.body,
      sessionId: n.sessionId ?? null,
      permissionId: n.permissionId ?? null,
      kind: n.kind,
      url: this.clickUrl(n) ?? `${publicOrLocalUrl(this.config)}/`,
    });
    const options: webpush.RequestOptions = {
      vapidDetails: { subject: this.config.notifications.webpush.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
      TTL: PUSH_TTL_S,
      // RFC 8291 encoding (the library default today; pinned so a library upgrade cannot silently switch to the aesgcm draft)
      contentEncoding: 'aes128gcm',
      urgency: n.kind === 'permission' ? 'high' : 'normal',
      timeout: HTTP_TIMEOUT_MS,
    };
    if (this.webPushAgent) options.agent = this.webPushAgent;
    try {
      const res = await webpush.sendNotification({ endpoint, keys: { p256dh: p.keys.p256dh, auth: p.keys.auth } }, payload, options);
      return { channel: 'webpush', target, ok: true, status: res.statusCode };
    } catch (err) {
      const e = err as { statusCode?: unknown; body?: unknown };
      const status = typeof e.statusCode === 'number' ? e.statusCode : undefined;
      const detail = typeof e.body === 'string' ? e.body.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      if (status === 404 || status === 410) {
        this.db.deletePushSubscription(sub.id);
        log.info('webpush.pruned', { deviceId: sub.deviceId, target, status });
        return { channel: 'webpush', target, ok: false, status, error: 'subscription expired (removed)', pruned: true };
      }
      log.warn('webpush.error', { target, status, ...errorInfo(err), ...(detail ? { detail } : {}) });
      const result: ChannelResult = { channel: 'webpush', target, ok: false, error: detail || errorMessage(err) };
      if (status !== undefined) result.status = status;
      return result;
    }
  }
}
