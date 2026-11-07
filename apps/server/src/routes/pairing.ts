/** Pairing and device management: POST /api/pair, GET /api/me, GET|DELETE /api/devices. */
import { Hono } from 'hono';
import { API, PairRequest, PairResponse } from '@mobile-ide/core';
import type { z } from 'zod';
import { generateToken } from '../auth.js';
import type { AuthedEnv, ServerContext } from '../context.js';
import type { DeviceRow } from '../db.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { RateLimiter } from './rate-limit.js';
import { clientIp, parseJsonBody, queryBool, RateLimitError } from './util.js';

/** What clients may learn about a device — never the token hash. */
export interface DeviceSummary {
  id: string;
  /** alias of `id` for clients that store `deviceId` */
  deviceId: string;
  name: string;
  platform: string | null;
  createdAt: number;
  lastSeen: number | null;
  revokedAt: number | null;
  /** true for the device that made the request */
  current: boolean;
}

export function deviceSummary(d: DeviceRow, currentId: string): DeviceSummary {
  return {
    id: d.id,
    deviceId: d.id,
    name: d.name,
    platform: d.platform,
    createdAt: d.createdAt,
    lastSeen: d.lastSeen,
    revokedAt: d.revokedAt,
    current: d.id === currentId,
  };
}

export function pairingRoutes(ctx: ServerContext, pairLimiter: RateLimiter): Hono<AuthedEnv> {
  const app = new Hono<AuthedEnv>();
  const log = ctx.log.child({ mod: 'http.pair' });

  // Unauthenticated (exempted by the auth middleware); rate-limited per client IP.
  app.post(API.pair, async (c) => {
    const ip = clientIp(c, ctx.config.config.trustProxy);
    const rl = pairLimiter.check(ip);
    if (!rl.ok) {
      log.warn('pair.rate_limited', { ip });
      throw new RateLimitError('Too many pairing attempts. Wait a minute and try again.', Math.ceil(rl.retryAfterMs / 1000));
    }
    const body = await parseJsonBody(c, PairRequest);
    const token = generateToken();
    const deviceName = body.deviceName.trim() || 'Device';
    const platform = body.platform?.trim() || undefined;
    // Burn the code and create the device atomically so a crash cannot waste a valid code.
    const device = ctx.db.transaction(() => {
      if (!ctx.db.consumePairingCode(body.code)) return null;
      return ctx.db.createDevice(deviceName, platform, token);
    });
    if (!device) {
      log.warn('pair.invalid_code', { ip, deviceName });
      throw new HttpError(400, 'Invalid or expired pairing code. Run `mide pair` on the server for a fresh one.', 'invalid_code');
    }
    log.info('pair.success', { ip, deviceId: device.id, deviceName, platform });
    const res: z.infer<typeof PairResponse> = { token, deviceId: device.id, serverName: ctx.serverName };
    return c.json(res, 201);
  });

  app.get(API.me, (c) => {
    const me = c.get('device');
    return c.json(deviceSummary(me, me.id));
  });

  /** Active devices; `?all=1` includes revoked ones. */
  app.get(API.devices, (c) => {
    const me = c.get('device');
    const all = queryBool(c, 'all');
    const devices = ctx.db.listDevices().filter((d) => all || d.revokedAt === null);
    return c.json(devices.map((d) => deviceSummary(d, me.id)));
  });

  /** Revoke a device (idempotent). Revoking the calling device logs it out. */
  app.delete(`${API.devices}/:id`, (c) => {
    const me = c.get('device');
    const id = c.req.param('id');
    const target = ctx.db.getDevice(id);
    if (!target) throw new NotFoundError('device not found');
    if (target.revokedAt !== null) return c.json({ ok: true, id, alreadyRevoked: true, self: id === me.id });
    ctx.db.revokeDevice(id);
    log.info('device.revoked', { deviceId: id, by: me.id, self: id === me.id });
    return c.json({ ok: true, id, alreadyRevoked: false, self: id === me.id });
  });

  return app;
}
