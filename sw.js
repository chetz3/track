const CACHE_NAME = 'tracker-shell-v5';
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
  './js/ui/dom.js',
  './js/ui/sheet.js',
  './js/ui/today.js',
  './js/ui/camera.js',
  './js/ui/calendar.js',
  './js/ui/summary.js',
  './js/ui/challenges.js',
  './js/ui/stepEditor.js',
  './js/ui/stats.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/d3.v7.min.js',
];

const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
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
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request)
          .then((response) => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      }),
    );
    return;
  }

  if (FONT_ORIGINS.includes(url.origin)) {
    event.respondWith(
      caches.open(FONTS_CACHE_NAME).then((cache) => cache.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          // Opaque cross-origin responses (status 0) are allowed for gstatic;
          // only skip caching on an actual network failure.
          if (response && (response.ok || response.type === 'opaque')) {
            cache.put(event.request, response.clone());
          }
          return response;
        });
      })),
    );
  }
  // Other cross-origin requests: let them go straight to the network.
});
