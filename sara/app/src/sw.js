import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

// Injected by VitePWA at build time
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { payload = { title: 'SARA', body: event.data?.text() || '' }; }

  const title = payload.title || 'SARA';
  const options = {
    body: payload.body || '',
    icon: '/icons/pwa-192x192.png',
    badge: '/icons/pwa-192x192.png',
    tag: payload.data?.type || 'sara',
    renotify: true,
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click — bring app to foreground ──────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const tab = data.tab || null;
  const notificationUrl = data.url || '/';
  const notificationType = data.type || null;
  const notificationTitle = event.notification.title || 'SARA';
  const appUrl = new URL('/', self.location.origin);
  const payload = JSON.stringify({
    ...data,
    title: notificationTitle,
  });
  appUrl.searchParams.set('source', 'notification');
  if (tab) appUrl.searchParams.set('tab', tab);
  if (notificationType) appUrl.searchParams.set('type', notificationType);
  if (notificationUrl) appUrl.searchParams.set('url', notificationUrl);
  if (notificationTitle) appUrl.searchParams.set('title', notificationTitle);
  appUrl.searchParams.set('payload', payload);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage({
            type: 'sara-notification-open',
            tab,
            notificationType,
            notificationUrl,
            notificationTitle,
            notificationData: data,
          });
          if ('navigate' in client) {
            client.navigate(appUrl.toString());
          }
          return client.focus();
        }
      }
      return clients.openWindow(appUrl.toString());
    })
  );
});
