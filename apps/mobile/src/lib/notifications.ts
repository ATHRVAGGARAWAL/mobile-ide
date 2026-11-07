/**
 * Native push notifications (Expo Push over APNs/FCM). Every export is a safe no-op on web,
 * where `webpush.ts` takes over. `expo-notifications` is required lazily so the web bundle
 * never evaluates it.
 */
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Linking from 'expo-linking';
import type * as Notifications from 'expo-notifications';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { api, errorMessage } from '../state/api';
import { useSettings } from '../state/settings';
import type { NotificationTarget } from './links';
import { tailOf, type ChannelStatus } from './notificationStatus';
import { setWebAppBadge } from './webpush';

type NotificationsModule = typeof Notifications;

export const pushSupported: boolean = Platform.OS === 'ios' || Platform.OS === 'android';

/** Expo Go cannot register for remote push (SDK 53+); a development build is required. */
export function isExpoGo(): boolean {
  return pushSupported && Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
}

/** Android notification channel the daemon's pushes land in (Expo's default). */
export const ANDROID_CHANNEL_ID = 'default';

let cached: NotificationsModule | null | undefined;
function notifications(): NotificationsModule | null {
  if (!pushSupported) return null;
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('expo-notifications') as NotificationsModule;
  } catch (err) {
    console.warn('[notifications] expo-notifications unavailable', err);
    cached = null;
  }
  return cached;
}

export type PushPermission = 'granted' | 'denied' | 'undetermined' | 'unsupported';

export interface ExpoPushStatus {
  supported: boolean;
  isDevice: boolean;
  /** running inside Expo Go, which cannot receive remote push */
  expoGo: boolean;
  permission: PushPermission;
  projectId: string | null;
  /** token registered with the daemon from this device, if any */
  token: string | null;
}

export type PushRegistrationResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'unsupported' | 'simulator' | 'expo_go' | 'denied' | 'no_project_id' | 'token' | 'server'; message: string };

/** EAS project id required by `getExpoPushTokenAsync`; empty in app.json until `eas init` has run. */
export function easProjectId(): string | null {
  const extra = (Constants.expoConfig?.extra ?? {}) as { eas?: { projectId?: string } };
  const id = extra.eas?.projectId || Constants.easConfig?.projectId || null;
  return id && id.trim() ? id.trim() : null;
}

let handlerConfigured = false;
/** Show notifications while the app is foregrounded (banner + list + sound; the badge is driven by `syncAppBadge`). */
export function configureNotificationHandling(): void {
  if (handlerConfigured) return;
  const N = notifications();
  if (!N) return;
  handlerConfigured = true;
  try {
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  } catch (err) {
    console.warn('[notifications] setNotificationHandler failed', err);
  }
}

async function ensureAndroidChannel(N: NotificationsModule): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await N.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: 'Agent activity',
      description: 'Permission requests, finished turns and errors from your coding agents.',
      importance: N.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  } catch (err) {
    console.warn('[notifications] channel setup failed', err);
  }
}

export async function getExpoPushStatus(): Promise<ExpoPushStatus> {
  const token = useSettings.getState().expoPushToken;
  const projectId = easProjectId();
  const N = notifications();
  const expoGo = isExpoGo();
  if (!N) return { supported: false, isDevice: Device.isDevice, expoGo, permission: 'unsupported', projectId, token };
  try {
    const perm = await N.getPermissionsAsync();
    const permission: PushPermission = perm.granted ? 'granted' : perm.canAskAgain ? 'undetermined' : 'denied';
    return { supported: true, isDevice: Device.isDevice, expoGo, permission, projectId, token };
  } catch (err) {
    console.warn('[notifications] getPermissionsAsync failed', err);
    return { supported: true, isDevice: Device.isDevice, expoGo, permission: 'undetermined', projectId, token };
  }
}

/** Re-evaluates whenever the registered token changes (and on demand via `refresh`). */
export function useExpoPushStatus(): { status: ExpoPushStatus | null; refresh: () => void } {
  const token = useSettings((s) => s.expoPushToken);
  const [status, setStatus] = useState<ExpoPushStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getExpoPushStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token, tick]);
  return { status, refresh: () => setTick((n) => n + 1) };
}

/** Settings copy for the Expo push channel. `null` status = still checking. */
export function describeExpoPushStatus(status: ExpoPushStatus | null): ChannelStatus {
  if (!pushSupported) {
    return {
      label: 'Native app only',
      tone: 'neutral',
      detail: 'Delivered through Apple/Google push once you install the iOS build. In the browser, use Web Push or ntfy below.',
      action: null,
    };
  }
  if (!status) return { label: 'Checking…', tone: 'neutral', detail: 'Reading the notification permission.', action: null };
  if (!status.supported) {
    return { label: 'Unavailable', tone: 'warning', detail: 'expo-notifications is missing from this build. Rebuild the app with EAS.', action: null };
  }
  if (status.expoGo) {
    return { label: 'Needs a dev build', tone: 'warning', detail: 'Expo Go cannot receive remote push. Install a development build (`eas build --profile development`).', action: null };
  }
  if (!status.isDevice) {
    return { label: 'Simulator', tone: 'neutral', detail: 'Simulators cannot receive push notifications. Try on a physical device.', action: null };
  }
  if (status.permission === 'denied') {
    return { label: 'Blocked', tone: 'danger', detail: 'Notifications are turned off for Mobile IDE. Allow them in the system Settings, then come back.', action: 'settings' };
  }
  if (status.token) {
    return { label: 'Registered', tone: 'success', detail: `This device is registered with the daemon (token ${tailOf(status.token, 6)}). Re-register if pushes stop arriving.`, action: 'reregister' };
  }
  if (!status.projectId) {
    return {
      label: 'Needs EAS project id',
      tone: 'warning',
      detail: 'Push tokens need app.json → extra.eas.projectId. Run `eas init` in apps/mobile, rebuild, then enable here.',
      action: null,
    };
  }
  return {
    label: 'Not enabled',
    tone: 'neutral',
    detail: 'Registers this device with the daemon so approvals and finished turns arrive as system notifications.',
    action: 'enable',
  };
}

/** Ask for permission, fetch the Expo push token and register it with the daemon. */
export async function registerExpoPush(): Promise<PushRegistrationResult> {
  const N = notifications();
  if (!N) {
    return { ok: false, reason: 'unsupported', message: 'Push notifications need the native app. On the web, use Web Push or ntfy instead.' };
  }
  if (!Device.isDevice) {
    return { ok: false, reason: 'simulator', message: 'Push tokens are only issued on a physical device.' };
  }
  if (isExpoGo()) {
    return { ok: false, reason: 'expo_go', message: 'Expo Go cannot receive remote push notifications. Install a development build of Mobile IDE.' };
  }
  await ensureAndroidChannel(N);
  let perm = await N.getPermissionsAsync();
  if (!perm.granted) {
    if (!perm.canAskAgain) {
      return { ok: false, reason: 'denied', message: 'Notifications are turned off for Mobile IDE. Enable them in the system Settings app.' };
    }
    perm = await N.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
    if (!perm.granted) return { ok: false, reason: 'denied', message: 'Notification permission was not granted.' };
  }
  const projectId = easProjectId();
  if (!projectId) {
    return {
      ok: false,
      reason: 'no_project_id',
      message: 'This build has no EAS project id (app.json → extra.eas.projectId). Run `eas init`, rebuild, and try again.',
    };
  }
  let token: string;
  try {
    token = (await N.getExpoPushTokenAsync({ projectId })).data;
  } catch (err) {
    return { ok: false, reason: 'token', message: `Couldn't get a push token: ${errorMessage(err)}` };
  }
  try {
    await api.pushRegister({ kind: 'expo', token });
  } catch (err) {
    return { ok: false, reason: 'server', message: `The daemon rejected the token: ${errorMessage(err)}` };
  }
  useSettings.getState().setExpoPushToken(token);
  return { ok: true, token };
}

/**
 * Forget the token locally. The daemon prunes tokens Expo reports as unregistered; to stop
 * pushes immediately revoke the device (`mide devices --revoke <id>`).
 */
export function clearExpoPush(): void {
  useSettings.getState().setExpoPushToken(null);
}

export async function openSystemNotificationSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch (err) {
    console.warn('[notifications] openSettings failed', err);
  }
}

/** Mirror the number of pending permissions onto the app icon (native) or the installed PWA (web). */
export async function syncAppBadge(count: number): Promise<void> {
  if (Platform.OS === 'web') {
    await setWebAppBadge(count);
    return;
  }
  const N = notifications();
  if (!N) return;
  try {
    await N.setBadgeCountAsync(Math.max(0, Math.floor(count)));
  } catch {
    /* badge permission may be missing; not worth surfacing */
  }
}

function targetOf(r: Notifications.NotificationResponse): NotificationTarget {
  const data = (r.notification.request.content.data ?? {}) as Record<string, unknown>;
  const sessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;
  const permissionId = typeof data.permissionId === 'string' && data.permissionId ? data.permissionId : null;
  const url = typeof data.url === 'string' && data.url ? data.url : null;
  return { sessionId, permissionId, url };
}

/** Fires when the user taps a notification, including the tap that cold-started the app. No-op on web. */
export function useNotificationOpens(onOpen: (target: NotificationTarget) => void): void {
  const cb = useRef(onOpen);
  cb.current = onOpen;
  useEffect(() => {
    const N = notifications();
    if (!N) return;
    let disposed = false;
    let lastId: string | null = null;
    const handle = (r: Notifications.NotificationResponse | null | undefined) => {
      if (!r || disposed) return;
      const id = r.notification.request.identifier;
      if (id && id === lastId) return;
      lastId = id;
      cb.current(targetOf(r));
    };
    N.getLastNotificationResponseAsync()
      .then((r) => {
        handle(r);
        if (r) N.clearLastNotificationResponseAsync().catch(() => {});
      })
      .catch(() => {});
    const sub = N.addNotificationResponseReceivedListener(handle);
    return () => {
      disposed = true;
      sub.remove();
    };
  }, []);
}
