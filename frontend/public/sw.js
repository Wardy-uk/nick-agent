// SARA / NEURO Service Worker — offline shell caching + push notifications
// Version — bump this string to force cache invalidation on next deploy
const CACHE_VERSION = 'neuro-v7';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;

// App shell files to precache on install
// Vite hashes JS/CSS filenames — we use a broad match strategy in fetch handler instead
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

// ── Install: precache shell ───────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => {
      // Cache what we can — ignore failures for individual assets
      return Promise.allSettled(
        PRECACHE_URLS.map(url => cache.add(url).catch(() => {}))
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== SHELL_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API, cache-first for assets ─────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests entirely
  if (event.request.method !== 'GET') return;

  // Skip cross-origin requests (push endpoints, fonts, etc.)
  if (url.origin !== self.location.origin) return;

  // API calls: network-first, no caching (data is handled by useCachedFetch/IndexedDB)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline', cached: false }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // App shell / static assets: network-first, fall back to cache when offline
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache valid responses for offline fallback
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline — serve from cache
        return caches.match(event.request)
          .then(cached => cached || new Response('Offline', { status: 503 }));
      })
  );
});

// ── Push notifications ────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  const options = {
    body: data.body,
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    data: data.data || {},
    vibrate: [200, 100, 200],
    requireInteraction: true,
    tag: data.data?.type || 'sara-notification'
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'SARA', options)
  );
});

// ── Notification click ────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.navigate(self.location.origin + url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
