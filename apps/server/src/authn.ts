/** Request authentication shared by HTTP routes and WebSocket upgrades. */
import type http from 'node:http';
import type { Db, DeviceRow } from './db.js';
import { WS_AUTH_SUBPROTOCOL_PREFIX } from '@mobile-ide/core';

export interface Credentials {
  authorization?: string | null;
  /** ?token= query param */
  queryToken?: string | null;
  /** Sec-WebSocket-Protocol offers */
  protocols?: string[] | null;
}

export function extractToken(c: Credentials): string | null {
  const auth = c.authorization?.trim();
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim() || null;
  if (c.queryToken) return c.queryToken;
  for (const p of c.protocols ?? []) {
    const t = p.trim();
    if (t.startsWith(WS_AUTH_SUBPROTOCOL_PREFIX)) return t.slice(WS_AUTH_SUBPROTOCOL_PREFIX.length) || null;
  }
  return null;
}

/** Returns the device for valid, unrevoked credentials; touches last_seen. */
export function authenticate(db: Db, c: Credentials): DeviceRow | null {
  const token = extractToken(c);
  if (!token) return null;
  const device = db.deviceByToken(token);
  if (!device || device.revokedAt) return null;
  db.touchDevice(device.id);
  return device;
}

/** `?token=` from a raw request target; null when the target is not a plain path (`//x`, `/\x` would make `new URL` throw). */
function queryTokenOf(target: string | undefined): string | null {
  const t = target ?? '/';
  if (!t.startsWith('/') || /^\/[/\\]/.test(t)) return null;
  try {
    return new URL(t, 'http://localhost').searchParams.get('token');
  } catch {
    return null;
  }
}

export function credentialsFromRequest(req: http.IncomingMessage): Credentials {
  const proto = req.headers['sec-websocket-protocol'];
  const protocols = typeof proto === 'string' ? proto.split(',').map((s) => s.trim()) : Array.isArray(proto) ? proto : null;
  return { authorization: req.headers.authorization ?? null, queryToken: queryTokenOf(req.url), protocols };
}

/** The subprotocol to echo back so browsers accept the handshake. */
export function selectedSubprotocol(protocols: string[] | null | undefined): string | undefined {
  return (protocols ?? []).find((p) => p.trim().startsWith(WS_AUTH_SUBPROTOCOL_PREFIX))?.trim();
}
