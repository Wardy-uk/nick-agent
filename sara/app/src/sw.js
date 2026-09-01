import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';

// ── The page itself comes from the NETWORK first ─────────────────────────────
//
// ⚠ REGISTERED BEFORE `precacheAndRoute`, and the order is the whole mechanism.
// Workbox matches routes in registration order, and the precache registers a
// route for `/` and `/index.html` — so with precache first, a reload was served
// the PREVIOUS build's HTML, which references the previous build's asset
// hashes, which are also precached. The page therefore loaded entirely from
// yesterday while the new worker installed quietly behind it, and only the
// SECOND reload showed the new build.
//
// That is not a theoretical ordering nicety. It cost three screenshots of the
// Pi panel showing a UI from before 30 August over a correctly-updated server,
// and then cost Nick a refresh that came back on build 540a138 while the width
// change he had just asked for was sitting in 165340a. `skipWaiting` and
// `clients.claim` below do NOT fix this: they make the new worker take over
// fast, but the page in front of him was already built from the old HTML.
//
// A screen that shows last week's app and looks completely fine is the failure
// this codebase refuses everywhere else. Here the CACHE was introducing it.
//
// ⚠ The offline promise is kept, and it matters on a phone — the capture
// outbox, opening her on a train. NetworkFirst falls back to its own cache, so
// a genuine outage still gets the last good shell; the 3s timeout bounds how
// long a bad connection can hold the launch. Hashed assets stay PRECACHED
// below, because they are immutable and are the bulk of the offline story.
registerRoute(new NavigationRoute(
  new NetworkFirst({
    cacheName: 'sara-shell',
    networkTimeoutSeconds: 3,
  }),
  // The API is never the app shell. `/api` is same-origin in dev via the Vite
  // proxy, and a navigation-looking request to it must not be answered with
  // HTML.
  { denylist: [/^\/api\//] },
));

// Injected by VitePWA at build time
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Take over as soon as a new build lands. `registerType: 'autoUpdate'` does NOT do this
// for us under injectManifest — that's only wired up for generateSW, so without these two
// lines a new service worker installs and then WAITS for every existing client to close.
// A swiped-away iOS PWA doesn't reliably count as closed, so the phone kept serving the
// previous bundle after a deploy: voice arrived one build late, the voice picker didn't
// arrive at all, and "fully close and reopen" was never a dependable fix.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
  // #111 — the nudge's actual words are the notification BODY; the title is a
  // label ("SARA — Escalation"). It was never forwarded, so the card could only
  // ever show and speak the label. Speaking "SARA nudge" is worse than silence.
  const notificationBody = event.notification.body || '';
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
  if (notificationBody) appUrl.searchParams.set('body', notificationBody);
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
            notificationBody,
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
