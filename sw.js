const CACHE_NAME = 'tracker-shell-v42';
const FONTS_CACHE_NAME = 'tracker-fonts-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/rules.js',
  './js/db.js',
  './js/photos.js',
  './js/backup.js',
  './js/migrate.js',
  './js/store.js',
  './js/storeLogic.js',
  './js/chartMath.js',
  './js/exif.js',
  './js/summaryModel.js',
  './js/config.js',
  './js/googleAuth.js',
  './js/foodLogic.js',
  './js/gemini.js',
  './js/fitness.js',
  './js/mealPlan.js',
  './js/reminders.js',
  './js/reminderRunner.js',
  './js/ui/dom.js',
  './js/ui/fx.js',
  './js/ui/sheet.js',
  './js/ui/today.js',
  './js/ui/camera.js',
  './js/ui/calendar.js',
  './js/ui/summary.js',
  './js/ui/challenges.js',
  './js/ui/stepEditor.js',
  './js/ui/aiKeySheet.js',
  './js/ui/stats.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/logo.svg',
  './vendor/d3.v7.min.js',
];

const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // `cache: 'reload'` forces each shell file past the HTTP cache so a
      // stale disk-cached response (e.g. an old index.html served with a
      // long max-age) can never get baked into a fresh precache.
      .then((cache) => cache.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME && k !== FONTS_CACHE_NAME).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (url.origin === self.location.origin) {
    // `cache: 'no-cache'` makes the browser revalidate with the server
    // (conditional GET) instead of serving a disk-cached response, so
    // the stale-while-revalidate background fetch actually has a chance
    // of seeing a change. The network fetch (and its cache write) is
    // started synchronously and registered with event.waitUntil right
    // here, before respondWith settles — waitUntil called later, inside
    // a .then() that runs after respondWith has already resolved to the
    // cached response, throws InvalidStateError and the cache is never
    // updated.
    const networkFetch = fetch(event.request, { cache: 'no-cache' }).then(async (response) => {
      if (response && response.status === 200) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      return response;
    });
    event.waitUntil(networkFetch.catch(() => {}));
    event.respondWith(
      caches.match(event.request, { cacheName: CACHE_NAME })
        .then((cached) => cached || networkFetch)
        .catch(() => caches.match(event.request, { cacheName: CACHE_NAME }))
        .then((res) => res || Response.error()),
    );
    return;
  }

  if (FONT_ORIGINS.includes(url.origin)) {
    event.respondWith(
      caches.match(event.request, { cacheName: FONTS_CACHE_NAME }).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          // Opaque cross-origin responses (status 0) are allowed for gstatic;
          // only skip caching on an actual network failure.
          if (response && (response.ok || response.type === 'opaque')) {
            const clone = response.clone();
            event.waitUntil(caches.open(FONTS_CACHE_NAME).then((cache) => cache.put(event.request, clone)));
          }
          return response;
        });
      }),
    );
  }
  // Other cross-origin requests: let them go straight to the network.
});

// Tapping a reminder notification: focus an open FueLoop window, else open it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './#/today';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
