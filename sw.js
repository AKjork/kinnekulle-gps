const CACHE_NAME = 'kinnekulle-gps-cache-v1';
const ASSETS = [
  './Kinnekulle GPS.html',
  './kinnekulle-gps.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).catch(err => {
      console.warn('Cache misslyckades', err);
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => (key === CACHE_NAME ? null : caches.delete(key)))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        return resp;
      }).catch(() => cached);
    })
  );
});
