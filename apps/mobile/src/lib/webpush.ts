/**
 * Web Push for the installed PWA (VAPID). Web only; every export is a safe no-op elsewhere.
 *
 * Flow: Settings → `subscribeWebPush()` → Notification.requestPermission (needs a user gesture)
 * → register /sw.js → PushManager.subscribe(applicationServerKey) → POST /api/push/register.
 * The service worker (public/sw.js) shows every push (Safari revokes silent subscriptions) and
 * posts `{type:'notification-click', url, sessionId}` back to the page, which `initWebPush` routes.
 */
import { Platform } from 'react-native';
import { api, errorMessage } from '../state/api';
import { isPaired, useSettings } from '../state/settings';
import { plainStorage } from '../state/storage';
import { openNotificationTarget } from './links';
import type { ChannelStatus } from './notificationStatus';
import { isStandaloneWeb } from './platform';

export const SW_PATH = '/sw.js';
const MANUAL_VAPID_KEY = 'webpush.vapidPublicKey';

export type WebPushSupport =
  | { ok: true }
  | { ok: false; reason: 'not_web' | 'insecure' | 'not_standalone' | 'unsupported' | 'denied'; message: string };

export type SubscribeResult =
  | { ok: true; endpoint: string }
  | { ok: false; reason: 'unsupported' | 'no_vapid' | 'denied' | 'subscribe' | 'server'; message: string };

export interface WebPushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface WebGlobals {
  navigator?: Navigator;
  Notification?: typeof Notification;
  isSecureContext?: boolean;
}

function g(): WebGlobals {
  return globalThis as unknown as WebGlobals;
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(g().navigator?.userAgent ?? '');
}

const NOT_STANDALONE_MSG = 'iOS only allows Web Push for installed web apps. Add to Home Screen first, then open Mobile IDE from there.';

export function webPushSupport(): WebPushSupport {
  if (Platform.OS !== 'web') return { ok: false, reason: 'not_web', message: 'Web Push is only used in the browser build.' };
  const w = g();
  if (w.isSecureContext === false) {
    return { ok: false, reason: 'insecure', message: 'Web Push needs HTTPS (or localhost). Open the app through your tailscale serve URL.' };
  }
  const hasSw = !!w.navigator && 'serviceWorker' in w.navigator;
  const hasPush = 'PushManager' in globalThis;
  const hasNotification = typeof w.Notification !== 'undefined';
  if (isIos() && !isStandaloneWeb()) return { ok: false, reason: 'not_standalone', message: NOT_STANDALONE_MSG };
  if (!hasSw || !hasPush || !hasNotification) return { ok: false, reason: 'unsupported', message: 'This browser does not support Web Push.' };
  if (w.Notification?.permission === 'denied') {
    return { ok: false, reason: 'denied', message: 'Notifications are blocked for this site. Allow them in the browser settings and try again.' };
  }
  return { ok: true };
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  const nav = g().navigator;
  if (Platform.OS !== 'web' || !nav || !('serviceWorker' in nav)) return null;
  try {
    return await nav.serviceWorker.register(SW_PATH, { scope: '/' });
  } catch (err) {
    console.warn('[webpush] service worker registration failed', err);
    return null;
  }
}

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  const nav = g().navigator;
  if (!nav || !('serviceWorker' in nav)) return null;
  const reg = await registerServiceWorker();
  if (!reg) return null;
  try {
    return await nav.serviceWorker.ready;
  } catch {
    return reg;
  }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (Platform.OS !== 'web') return null;
  try {
    const nav = g().navigator;
    if (!nav || !('serviceWorker' in nav)) return null;
    const reg = await nav.serviceWorker.getRegistration('/');
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export async function loadManualVapidKey(): Promise<string | null> {
  try {
    const v = await plainStorage.getItem(MANUAL_VAPID_KEY);
    return v || null;
  } catch {
    return null;
  }
}

export async function saveManualVapidKey(key: string | null): Promise<void> {
  try {
    if (key) await plainStorage.setItem(MANUAL_VAPID_KEY, key);
    else await plainStorage.removeItem(MANUAL_VAPID_KEY);
  } catch {
    /* ignore */
  }
}

/** Public key from the daemon (`GET /api/push/vapid`), else a manually pasted one. */
export async function resolveVapidKey(manual?: string | null): Promise<string | null> {
  try {
    const r = await api.pushVapid();
    if (r.publicKey) return r.publicKey;
  } catch (err) {
    console.warn('[webpush] VAPID lookup failed', err);
  }
  const m = (manual ?? (await loadManualVapidKey()))?.trim();
  return m || null;
}

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.trim().replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!clean || /[^A-Za-z0-9+/]/.test(clean)) throw new Error('invalid base64url');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function subscriptionBody(sub: PushSubscription): WebPushSubscriptionBody | null {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

function sameKey(sub: PushSubscription, key: Uint8Array): boolean {
  try {
    const cur = sub.options?.applicationServerKey;
    if (!cur) return true;
    const a = new Uint8Array(cur);
    if (a.length !== key.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== key[i]) return false;
    return true;
  } catch {
    return true;
  }
}

/** Subscribe this browser and register the subscription with the daemon. Call from a user gesture. */
export async function subscribeWebPush(opts: { vapidPublicKey?: string | null } = {}): Promise<SubscribeResult> {
  const support = webPushSupport();
  if (!support.ok) return { ok: false, reason: 'unsupported', message: support.message };
  const key = await resolveVapidKey(opts.vapidPublicKey);
  if (!key) {
    return {
      ok: false,
      reason: 'no_vapid',
      message:
        'The daemon has no VAPID key. Run `npx web-push generate-vapid-keys`, put the keys under notifications.webpush in ~/.mobile-ide/config.json and restart it — or paste the public key below.',
    };
  }
  let applicationServerKey: Uint8Array;
  try {
    applicationServerKey = urlBase64ToUint8Array(key);
  } catch {
    return { ok: false, reason: 'no_vapid', message: 'That VAPID public key is not valid base64url.' };
  }
  const NotificationCtor = g().Notification;
  if (!NotificationCtor) return { ok: false, reason: 'unsupported', message: 'This browser does not support notifications.' };
  let permission: NotificationPermission = NotificationCtor.permission;
  if (permission !== 'granted') {
    try {
      permission = await NotificationCtor.requestPermission();
    } catch {
      permission = 'denied';
    }
  }
  if (permission !== 'granted') return { ok: false, reason: 'denied', message: 'Notification permission was not granted.' };

  const reg = await readyRegistration();
  if (!reg) return { ok: false, reason: 'subscribe', message: 'Could not install the service worker. Is /sw.js served alongside the app?' };

  let sub: PushSubscription | null = null;
  try {
    sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, applicationServerKey)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey as BufferSource });
  } catch (err) {
    return { ok: false, reason: 'subscribe', message: `Push subscription failed: ${errorMessage(err)}` };
  }
  const body = subscriptionBody(sub);
  if (!body) return { ok: false, reason: 'subscribe', message: 'The browser returned an incomplete push subscription.' };
  try {
    await api.pushRegister({ kind: 'webpush', subscription: body });
  } catch (err) {
    return { ok: false, reason: 'server', message: `The daemon rejected the subscription: ${errorMessage(err)}` };
  }
  useSettings.getState().setWebPushEndpoint(body.endpoint);
  if (opts.vapidPublicKey?.trim()) void saveManualVapidKey(opts.vapidPublicKey.trim());
  return { ok: true, endpoint: body.endpoint };
}

/** Drop the browser subscription; the daemon prunes it on its next 404/410. */
export async function unsubscribeWebPush(): Promise<void> {
  try {
    const sub = await currentSubscription();
    if (sub) await sub.unsubscribe();
  } catch (err) {
    console.warn('[webpush] unsubscribe failed', err);
  }
  useSettings.getState().setWebPushEndpoint(null);
}

/** Badging API for the installed PWA (Safari 16.4+, Chrome). */
export async function setWebAppBadge(count: number): Promise<void> {
  if (Platform.OS !== 'web') return;
  const nav = g().navigator as (Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }) | undefined;
  try {
    if (count > 0) await nav?.setAppBadge?.(Math.floor(count));
    else await nav?.clearAppBadge?.();
  } catch {
    /* unsupported or not installed */
  }
}

export interface WebPushStatus {
  support: WebPushSupport;
  /** the browser holds a push subscription for this origin */
  subscribed: boolean;
  /** endpoint we last registered with the daemon (null = daemon does not know this browser) */
  endpoint: string | null;
  permission: NotificationPermission | 'unsupported';
}

export async function getWebPushStatus(): Promise<WebPushStatus> {
  const support = webPushSupport();
  const endpoint = useSettings.getState().webPushEndpoint;
  const permission = g().Notification?.permission ?? 'unsupported';
  if (Platform.OS !== 'web') return { support, subscribed: false, endpoint, permission };
  const sub = await currentSubscription();
  return { support, subscribed: !!sub, endpoint, permission };
}

/** Settings copy for the Web Push channel. `null` status = still checking. */
export function describeWebPushStatus(status: WebPushStatus | null): ChannelStatus {
  if (Platform.OS !== 'web') {
    return {
      label: 'Web app only',
      tone: 'neutral',
      detail: 'Used by the installed web app (Add to Home Screen). The native app gets push notifications above instead.',
      action: null,
    };
  }
  if (!status) return { label: 'Checking…', tone: 'neutral', detail: 'Looking for a push subscription in this browser.', action: null };
  const { support } = status;
  if (!support.ok) {
    switch (support.reason) {
      case 'insecure':
        return { label: 'Needs HTTPS', tone: 'warning', detail: support.message, action: null };
      case 'not_standalone':
        return { label: 'Add to Home Screen first', tone: 'warning', detail: support.message, action: null };
      case 'denied':
        return { label: 'Blocked', tone: 'danger', detail: support.message, action: null };
      default:
        return { label: 'Unsupported here', tone: 'neutral', detail: support.message, action: null };
    }
  }
  if (status.subscribed && status.endpoint) {
    return {
      label: 'Subscribed',
      tone: 'success',
      detail: `This installed app receives pushes via ${pushServiceLabel(status.endpoint)}. Every push shows a notification (Safari requires it).`,
      action: 'disable',
    };
  }
  if (status.subscribed) {
    return {
      label: 'Not registered',
      tone: 'warning',
      detail: 'The browser holds a subscription the daemon does not know about (maybe from a previous pairing). Tap Enable to register it.',
      action: 'enable',
    };
  }
  return {
    label: 'Not enabled',
    tone: 'neutral',
    detail: 'System notifications for approvals and finished turns, delivered by the browser vendor’s push service. Needs the daemon’s VAPID key (`mide vapid`).',
    action: 'enable',
  };
}

function pushServiceLabel(endpoint: string): string {
  try {
    const host = new URL(endpoint).host;
    if (/apple/i.test(host)) return 'Apple Push';
    if (/google|fcm/i.test(host)) return 'Google FCM';
    if (/mozilla/i.test(host)) return 'Mozilla Push';
    return host;
  } catch {
    return 'the push service';
  }
}

function whenHydrated(): Promise<void> {
  return new Promise((resolve) => {
    if (useSettings.getState().hydrated) {
      resolve();
      return;
    }
    const unsub = useSettings.subscribe((s) => {
      if (s.hydrated) {
        unsub();
        resolve();
      }
    });
  });
}

/** If the browser holds a subscription the daemon doesn't know about (rotated endpoint), register it. */
async function reconcileSubscription(): Promise<void> {
  await whenHydrated();
  const settings = useSettings.getState();
  if (!isPaired(settings)) return;
  const sub = await currentSubscription();
  if (!sub) {
    if (settings.webPushEndpoint) settings.setWebPushEndpoint(null);
    return;
  }
  const body = subscriptionBody(sub);
  if (!body || body.endpoint === settings.webPushEndpoint) return;
  try {
    await api.pushRegister({ kind: 'webpush', subscription: body });
    useSettings.getState().setWebPushEndpoint(body.endpoint);
  } catch (err) {
    console.warn('[webpush] re-register failed', err);
  }
}

let initialised = false;
/**
 * Web startup: install the service worker (no permission prompt), route notification clicks it
 * posts back, and re-register a rotated subscription with the daemon.
 */
export function initWebPush(): void {
  if (initialised || Platform.OS !== 'web') return;
  initialised = true;
  const nav = g().navigator;
  if (!nav || !('serviceWorker' in nav)) return;
  try {
    nav.serviceWorker.addEventListener('message', (ev: MessageEvent) => {
      const data = ev.data as { type?: string; url?: string | null; sessionId?: string | null; permissionId?: string | null } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'notification-click') openNotificationTarget({ url: data.url ?? null, sessionId: data.sessionId ?? null, permissionId: data.permissionId ?? null });
      else if (data.type === 'push-subscription-change') void reconcileSubscription();
    });
  } catch {
    /* ignore */
  }
  void (async () => {
    if (g().isSecureContext === false) return;
    const reg = await registerServiceWorker();
    if (!reg) return;
    await reconcileSubscription();
  })();
}
