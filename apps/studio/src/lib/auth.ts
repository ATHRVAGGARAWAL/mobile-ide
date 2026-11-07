/**
 * Who the Studio is to the daemon: a paired device like the phone, except it pairs itself. The launcher puts a one-time
 * code in the URL fragment (`#pair=CODE&session=ID`); the first visit exchanges it for a device token that lives in
 * localStorage of this origin from then on. The fragment is scrubbed from the address bar right away.
 */
import { API, PairResponse } from '@mobile-ide/core';

const TOKEN_KEY = 'mide.studio.token';
const DEVICE_KEY = 'mide.studio.deviceId';
const SERVER_KEY = 'mide.studio.serverName';

export interface LaunchParams {
  pair: string | null;
  session: string | null;
}

/** Read and clear `#pair=…&session=…` (a `?session=` query works too, for links typed by hand). */
export function readLaunchParams(): LaunchParams {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(location.search);
  const params: LaunchParams = { pair: hash.get('pair') ?? query.get('pair'), session: hash.get('session') ?? query.get('session') };
  if (location.hash || location.search) {
    try {
      history.replaceState(null, '', location.pathname);
    } catch {
      /* file:// or a locked-down context */
    }
  }
  return params;
}

export interface StoredAuth {
  token: string;
  deviceId: string | null;
  serverName: string | null;
}

export function loadAuth(): StoredAuth | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    return { token, deviceId: localStorage.getItem(DEVICE_KEY), serverName: localStorage.getItem(SERVER_KEY) };
  } catch {
    return null;
  }
}

export function saveAuth(auth: StoredAuth): void {
  try {
    localStorage.setItem(TOKEN_KEY, auth.token);
    if (auth.deviceId) localStorage.setItem(DEVICE_KEY, auth.deviceId);
    if (auth.serverName) localStorage.setItem(SERVER_KEY, auth.serverName);
  } catch {
    /* private mode: the session still works until reload */
  }
}

export function clearAuth(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(DEVICE_KEY);
    localStorage.removeItem(SERVER_KEY);
  } catch {
    /* ignore */
  }
}

/** The daemon's origin — the Studio is always served by the daemon it talks to. */
export const BASE_URL = location.origin;

/** Exchange a one-time code for a device token. Throws with the daemon's message on failure. */
export async function pairWithCode(code: string): Promise<StoredAuth> {
  const res = await fetch(BASE_URL + API.pair, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, deviceName: `Studio · ${describeMachine()}`, platform: 'studio' }),
  });
  if (!res.ok) {
    let message = `pairing failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  const parsed = PairResponse.parse(await res.json());
  const auth: StoredAuth = { token: parsed.token, deviceId: parsed.deviceId, serverName: parsed.serverName };
  saveAuth(auth);
  return auth;
}

function describeMachine(): string {
  const ua = navigator.userAgent;
  const os = /Linux/.test(ua) ? 'Linux' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'desktop';
  const browser =
    /Brave/.test(ua) || (navigator as { brave?: unknown }).brave
      ? 'Brave'
      : /Edg\//.test(ua)
        ? 'Edge'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Firefox\//.test(ua)
            ? 'Firefox'
            : 'browser';
  return `${os} ${browser}`;
}
