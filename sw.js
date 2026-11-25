const VERSION = (() => {
  try {
    const url = new URL(self.location.href);
    return url.searchParams.get('v') || 'v1';
  } catch (e) {
    return 'v1';
  }
})();

const CACHE_NAME = `kinnekulle-gps-cache-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './railtimer-avbrott.js',
  './railtimer-github.js',
  './railtimer-karta.js',
  './kinnekulle-gps.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  // cache: 'reload' – hämta från servern, inte ur webbläsarens cache (GitHub Pages cachar i 10 min),
  // annars kan en ny version spara gamla filer
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })))).catch(err => {
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
  // Bara appens egna filer. Anrop till GitHub (privata mätdata, token i huvudet) och andra domäner går förbi cachen.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  // Sparad kopia direkt, ny kopia hämtas i bakgrunden. Bara lyckade svar sparas – en felsida (404, 503)
  // får aldrig ersätta appen, eftersom den då skulle visas offline.
  const fetchPromise = fetch(request).then(resp => {
    if (resp && resp.ok && resp.type === 'basic') {
      const copy = resp.clone();
      return caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).then(() => resp, () => resp);
    }
    return resp;
  });
  event.respondWith(
    caches.match(request).then(cached => cached || fetchPromise.catch(() => caches.match(request)))
  );
  // Låt service workern leva tills den nya kopian är sparad; ett nätfel här är väntat offline
  if (event.waitUntil) event.waitUntil(fetchPromise.then(() => {}, () => {}));
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
