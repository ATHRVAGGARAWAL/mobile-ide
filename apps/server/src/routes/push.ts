/** Push channels: POST /api/push/register, POST /api/push/test, GET /api/push/vapid. */
import { Hono } from 'hono';
import { API, RegisterPushRequest, type PushVapidResponse } from '@mobile-ide/core';
import type { AuthedEnv, ServerContext } from '../context.js';
import type { PushSubscriptionRow } from '../db.js';
import { BadRequestError, HttpError } from '../errors.js';
import { isExpoPushToken, webPushSubscriptionProblem, type ChannelResult } from '../notify.js';
import { isLinkLocalHost, isLocalOrTailnetHost } from './origin.js';
import { parseJsonBody } from './util.js';

/** ntfy topic rules (https://docs.ntfy.sh): letters, digits, `-` and `_`, up to 64 chars. */
const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Why a device-supplied ntfy server is not acceptable, or null. The daemon POSTs every notification of every
 * session (titles, the literal commands of permission prompts) to this URL, so it must be a real ntfy base URL:
 * https, or plain http only to a loopback / private / tailnet host (a self-hosted ntfy); never a URL with
 * credentials, a query or a fragment, and never a link-local address (cloud metadata services).
 */
export function ntfyServerProblem(server: string): string | null {
  let u: URL;
  try {
    u = new URL(server);
  } catch {
    return 'ntfy server must be an http(s) URL';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'ntfy server must be an http(s) URL';
  if (u.username || u.password) return 'ntfy server must not contain credentials';
  if (u.search || u.hash) return 'ntfy server must be a base URL without query or fragment';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return 'ntfy server has no host';
  // parsed, not string-matched: `[::ffff:169.254.169.254]` arrives from URL as the hex `::ffff:a9fe:a9fe`
  if (isLinkLocalHost(host)) return 'ntfy server must not be a link-local address';
  if (u.protocol === 'http:' && !isLocalOrTailnetHost(host)) return 'ntfy server must use https unless it is on your tailnet or LAN';
  return null;
}

function describeFailure(r: ChannelResult): string {
  const why = r.pruned ? 'subscription expired, removed' : r.error || (r.status ? `HTTP ${r.status}` : 'failed');
  return `${r.channel} ${r.target}: ${why}`;
}

export function pushRoutes(ctx: ServerContext): Hono<AuthedEnv> {
  const app = new Hono<AuthedEnv>();
  const log = ctx.log.child({ mod: 'http.push' });

  app.post(API.pushRegister, async (c) => {
    const me = c.get('device');
    const body = await parseJsonBody(c, RegisterPushRequest);
    let row: PushSubscriptionRow;
    switch (body.kind) {
      case 'expo': {
        const token = body.token.trim();
        if (!token) throw new BadRequestError('expo token is required');
        if (!isExpoPushToken(token)) throw new BadRequestError('not an Expo push token (expected ExponentPushToken[...] from getExpoPushTokenAsync)');
        if (!ctx.config.config.notifications.expo.enabled) throw new HttpError(400, 'Expo push is disabled in the daemon config (notifications.expo.enabled)', 'expo_disabled');
        row = ctx.db.upsertPushSubscription(me.id, 'expo', { token });
        break;
      }
      case 'ntfy': {
        const topic = body.topic.trim();
        if (!NTFY_TOPIC.test(topic)) throw new BadRequestError("ntfy topic may only contain letters, digits, '-' and '_' (max 64 chars)");
        const server = body.server?.trim().replace(/\/+$/, '');
        if (server) {
          const problem = ntfyServerProblem(server);
          if (problem) throw new BadRequestError(problem);
        }
        row = ctx.db.upsertPushSubscription(me.id, 'ntfy', server ? { server, topic } : { topic });
        break;
      }
      case 'webpush': {
        if (!ctx.notifier.vapidPublicKey) {
          throw new HttpError(
            400,
            'Web Push is off on the daemon: its VAPID key pair is missing or unusable. Run `mide vapid --rotate` on the laptop and restart the daemon.',
            'webpush_unconfigured',
          );
        }
        const { endpoint, keys } = body.subscription;
        const problem = webPushSubscriptionProblem({ endpoint, keys });
        if (problem) throw new BadRequestError(`invalid web push subscription: ${problem}`);
        row = ctx.db.upsertPushSubscription(me.id, 'webpush', { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
        break;
      }
    }
    log.info('push.registered', { deviceId: me.id, kind: row.kind, id: row.id });
    return c.json({ ok: true, id: row.id, kind: row.kind }, 201);
  });

  /**
   * Send a test notification to every channel of the calling device (plus the config-level ntfy
   * topic). 400 when nothing is registered, 502 when every channel failed; the per-channel
   * outcomes are returned so the Settings screen can show what happened where.
   */
  app.post(API.pushTest, async (c) => {
    const me = c.get('device');
    const result = await ctx.notifier.notify([me.id], {
      title: `${ctx.serverName}: test notification`,
      body: `Notifications from mobile-ide reach ${me.name}. You're all set.`,
      kind: 'test',
    });
    if (result.sent === 0) {
      if (result.failed === 0) {
        throw new HttpError(
          400,
          'No notification channel is registered for this device. Add an ntfy topic, enable push, or install the web app and turn on Web Push first.',
          'no_subscriptions',
        );
      }
      // `failed` without per-target results means the fan-out itself broke (see the daemon log)
      const details = result.results.length ? result.results.map(describeFailure).join('; ') : 'the daemon could not read its push subscriptions';
      log.warn('push.test_failed', { deviceId: me.id, results: result.results });
      throw new HttpError(502, `Sending failed on every channel — ${details.slice(0, 600)}`, 'push_failed');
    }
    log.info('push.test', { deviceId: me.id, sent: result.sent, failed: result.failed });
    return c.json({ ok: true, sent: result.sent, failed: result.failed, results: result.results });
  });

  app.get(API.pushVapid, (c) => {
    const res: PushVapidResponse = { publicKey: ctx.notifier.vapidPublicKey };
    return c.json(res);
  });

  return app;
}
