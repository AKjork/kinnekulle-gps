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
  './railtimer-trv.js',
  './api-koll.html',
  './railtimer-info.js',
  './kinnekulle-gps.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
// Så länge väntar appen på nätet innan den sparade kopian används (dålig täckning)
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', event => {
  // cache: 'reload' – hämta från servern, inte ur webbläsarens cache (GitHub Pages cachar i 10 min),
  // annars kan en ny version spara gamla filer.
  // skipWaiting: den nya versionen tar över direkt i stället för att vänta tills appen stängts helt
  // (2026-11-25n – förut krävdes ⋮ → Uppdatera app).
  self.skipWaiting();
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

/* Nätet först: appen ska alltid köra senaste versionen från GitHub Pages när den öppnas.
   Den sparade kopian används bara utan täckning, när nätet inte svarat inom NETWORK_TIMEOUT_MS,
   eller när servern svarar med fel. Bara lyckade svar sparas – en felsida (404, 503) får aldrig
   ersätta appen, eftersom den då skulle visas offline. Förut (till 2026-11-25m) visades den sparade
   kopian först och den nya hämtades i bakgrunden, så en ny version syntes först vid nästa start. */
self.addEventListener('fetch', event => {
  const { request } = event;
  // Bara appens egna filer. Anrop till GitHub (privata mätdata, token i huvudet) och andra domäner går förbi cachen.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Versionskollen (version.json) går alltid till nätet och sparas inte
  if (url.pathname.endsWith('/version.json')) return;

  const network = fetch(request);
  const saved = network.then(resp => {
    if (resp && resp.ok && resp.type === 'basic') {
      const copy = resp.clone();
      return caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
    }
  }, () => {});
  // Låt service workern leva tills den nya kopian är sparad; ett nätfel här är väntat offline
  if (event.waitUntil) event.waitUntil(saved);

  const timedOut = new Promise(resolve => setTimeout(() => resolve('timeout'), NETWORK_TIMEOUT_MS));
  event.respondWith(
    Promise.race([network.then(resp => resp, () => 'offline'), timedOut]).then(first => {
      if (first && first !== 'timeout' && first !== 'offline' && first.ok) return first;
      return caches.match(request).then(cached => {
        if (cached) return cached;
        // Ingen sparad kopia: vänta på nätet (eller ge felsvaret därifrån)
        if (first && first !== 'timeout' && first !== 'offline') return first;
        return network;
      });
    })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
