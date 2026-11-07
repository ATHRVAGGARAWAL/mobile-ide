/* global self, clients */
/*
 * Mobile IDE service worker — Web Push display and click routing only.
 * No caching: the app shell is served by the daemon and must never be stale.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function parsePayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json() || {};
  } catch (_err) {
    try {
      return { title: 'Mobile IDE', body: event.data.text() };
    } catch (_err2) {
      return {};
    }
  }
}

self.addEventListener('push', (event) => {
  const data = parsePayload(event);
  const title = data.title || 'Mobile IDE';
  const kind = data.kind || 'event';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.sessionId ? 'mide-' + data.sessionId + '-' + kind : undefined,
    renotify: !!data.sessionId,
    requireInteraction: kind === 'permission',
    data: { url: data.url || null, sessionId: data.sessionId || null, permissionId: data.permissionId || null, kind },
  };
  // Every push MUST show a notification, otherwise Safari silently revokes the subscription.
  event.waitUntil(self.registration.showNotification(title, options));
});

/** Prefer a same-origin path so the installed app opens instead of a browser tab. */
function targetPath(data) {
  if (data && data.sessionId) {
    const base = '/session/' + encodeURIComponent(data.sessionId);
    // a permission notification opens straight onto its sheet
    return data.permissionId ? base + '?permission=' + encodeURIComponent(data.permissionId) : base;
  }
  if (data && data.url) {
    try {
      const u = new URL(data.url, self.location.origin);
      if (u.origin === self.location.origin) return u.pathname + u.search + u.hash;
      const m = /\/session\/([^/?#]+)/.exec(u.pathname);
      if (m) return '/session/' + m[1];
    } catch (_err) {
      /* fall through */
    }
  }
  return '/';
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const path = targetPath(data);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        try {
          if ('focus' in client) await client.focus();
        } catch (_err) {
          /* ignore */
        }
        client.postMessage({ type: 'notification-click', url: path, sessionId: data.sessionId || null, permissionId: data.permissionId || null });
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(path);
    })(),
  );
});

/* The push service rotated our subscription; the page re-registers it with the daemon (it holds the token, we don't). */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const oldSub = event.oldSubscription;
        const key = oldSub && oldSub.options ? oldSub.options.applicationServerKey : null;
        if (key) await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } catch (_err) {
        /* the page will resubscribe from Settings */
      }
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) client.postMessage({ type: 'push-subscription-change' });
    })(),
  );
});
