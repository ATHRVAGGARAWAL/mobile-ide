/**
 * Persisted device settings: which daemon we talk to, our token, theme, notification prefs.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ThemePreference } from '../theme';

/** Web only: how the installed web app pads the screen edges. `auto` measures; the rest force a layout. */
export type SafeAreaMode = 'auto' | 'none' | 'top' | 'both';
import { secureStorage } from './storage';

export interface PairedServer {
  serverUrl: string;
  token: string;
  deviceId: string;
  serverName: string;
  deviceName: string;
}

interface SettingsState {
  hydrated: boolean;
  serverUrl: string | null;
  token: string | null;
  deviceId: string | null;
  serverName: string | null;
  deviceName: string | null;
  theme: ThemePreference;
  ntfyTopic: string;
  ntfyServer: string;
  /**
   * The device id the ntfy topic was registered under. The daemon keys subscriptions by device, so a re-pair
   * (new device id) leaves the topic unregistered until it is saved again — the UI must not claim otherwise.
   */
  ntfyDeviceId: string | null;
  expoPushToken: string | null;
  webPushEndpoint: string | null;
  terminalFontSize: number;
  safeArea: SafeAreaMode;
  setPaired: (s: PairedServer) => void;
  forgetServer: () => void;
  setTheme: (t: ThemePreference) => void;
  /** remember the topic/server the current device registered with the daemon */
  setNtfy: (topic: string, server: string) => void;
  setExpoPushToken: (t: string | null) => void;
  setWebPushEndpoint: (e: string | null) => void;
  setTerminalFontSize: (n: number) => void;
  setSafeArea: (m: SafeAreaMode) => void;
  setHydrated: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      hydrated: false,
      serverUrl: null,
      token: null,
      deviceId: null,
      serverName: null,
      deviceName: null,
      theme: 'system',
      ntfyTopic: '',
      ntfyServer: 'https://ntfy.sh',
      ntfyDeviceId: null,
      expoPushToken: null,
      webPushEndpoint: null,
      terminalFontSize: 13,
      safeArea: 'auto',
      setPaired: (s) =>
        set((prev) => ({
          serverUrl: normalizeServerUrl(s.serverUrl),
          token: s.token,
          deviceId: s.deviceId,
          serverName: s.serverName,
          deviceName: s.deviceName,
          // a new device id has no subscriptions on the daemon: every channel must register again
          ...(prev.deviceId && prev.deviceId !== s.deviceId ? { expoPushToken: null, webPushEndpoint: null } : {}),
        })),
      // the ntfy topic text is kept (it is the user's, and their ntfy app subscribes to it) but it is no longer registered
      forgetServer: () =>
        set({ serverUrl: null, token: null, deviceId: null, serverName: null, expoPushToken: null, webPushEndpoint: null, ntfyDeviceId: null }),
      setTheme: (theme) => set({ theme }),
      setNtfy: (ntfyTopic, ntfyServer) => set((prev) => ({ ntfyTopic, ntfyServer, ntfyDeviceId: prev.deviceId })),
      setExpoPushToken: (expoPushToken) => set({ expoPushToken }),
      setWebPushEndpoint: (webPushEndpoint) => set({ webPushEndpoint }),
      setTerminalFontSize: (terminalFontSize) => set({ terminalFontSize }),
      setSafeArea: (safeArea) => set({ safeArea }),
      setHydrated: () => set({ hydrated: true }),
    }),
    {
      name: 'settings',
      version: 2,
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        // v1 had no ntfyDeviceId and forgetServer() kept the topic while clearing the device id, so a v1 store cannot say
        // which device registered the topic (a re-paired device has a new id the daemon knows nothing about). Stamping the
        // current id would show "Registered" for a topic the daemon never sends to; unregistered + one tap of "Register
        // again" is the honest state.
        if (version < 2) return { ...p, ntfyDeviceId: null };
        return p;
      },
      storage: createJSONStorage(() => secureStorage),
      partialize: (s) => ({
        serverUrl: s.serverUrl,
        token: s.token,
        deviceId: s.deviceId,
        serverName: s.serverName,
        deviceName: s.deviceName,
        theme: s.theme,
        ntfyTopic: s.ntfyTopic,
        ntfyServer: s.ntfyServer,
        ntfyDeviceId: s.ntfyDeviceId,
        expoPushToken: s.expoPushToken,
        webPushEndpoint: s.webPushEndpoint,
        terminalFontSize: s.terminalFontSize,
        safeArea: s.safeArea,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error) console.warn('[settings] rehydrate failed', error);
        // Called after hydration; mark ready either way so the UI can proceed.
        queueMicrotask(() => useSettings.getState().setHydrated());
        void state;
      },
    },
  ),
);

export function isPaired(s: Pick<SettingsState, 'serverUrl' | 'token'>): boolean {
  return !!s.serverUrl && !!s.token;
}

/** Accepts "host", "host:port", "http(s)://host[:port][/path]" and returns an origin-ish base URL without trailing slash. */
export function normalizeServerUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) {
    const isLocal = /^(localhost|127\.|10\.|192\.168\.|\[?::1)/.test(s) || /^[\w.-]+:\d+$/.test(s);
    s = (isLocal ? 'http://' : 'https://') + s;
  }
  try {
    const u = new URL(s);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return s.replace(/\/+$/, '');
  }
}
