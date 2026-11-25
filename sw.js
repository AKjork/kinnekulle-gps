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
  './railtimer-push.js',
  './railtimer-vt.js',
  './vasttrafik-koll.html',
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
        // Bara appens gamla kopior; notisernas läge (PUSH_CACHE) får vara kvar
        keys.map(key => (key === CACHE_NAME || !key.startsWith('kinnekulle-gps-cache-') ? null : caches.delete(key)))
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

/* ── Notiser i bakgrunden (2026-11-25v) ──
   Bevakningen i railtimer-data skickar webbpush. Här visas notisen, och det senaste läget sparas i
   PUSH_CACHE (vilka saker som meddelats per resa, senaste notisen och senaste begäran), så att appen
   inte meddelar samma sak igen när den öppnas. Begäran till GitHub (repository_dispatch) skickas härifrån
   när appen lämnas, eftersom service workern lever kvar en stund efter att sidan gått till bakgrunden. */
const PUSH_CACHE = 'railtimer-push';
const PUSH_STATE_URL = './push-state';

function readPushState() {
  return caches.open(PUSH_CACHE)
    .then(cache => cache.match(PUSH_STATE_URL))
    .then(resp => (resp ? resp.json() : {}))
    .catch(() => ({}));
}
function writePushState(update) {
  return readPushState().then(st => {
    const next = Object.assign({}, st, update(st));
    return caches.open(PUSH_CACHE)
      .then(cache => cache.put(PUSH_STATE_URL, new Response(JSON.stringify(next), { headers: { 'Content-Type': 'application/json' } })))
      .then(() => next);
  }).catch(() => null);
}
function tellClients(msg) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(list => { list.forEach(c => { try { c.postMessage(msg); } catch (e) { /* stängd */ } }); return list; })
    .catch(() => []);
}

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const kind = data.kind || 'alert';
  event.waitUntil((async () => {
    await writePushState(st => {
      const sameJourney = st.journeyId === data.journeyId;
      return {
        journeyId: data.journeyId || st.journeyId || null,
        keys: data.keys ? data.keys : (sameJourney ? st.keys : []),
        last: { kind, title: data.title || '', body: data.body || '', at: Date.now() }
      };
    });
    const wins = await tellClients({ type: 'RT_PUSH', data });
    const visible = wins.some(w => w.visibilityState === 'visible');
    // Notisen visas alltid (krävs av webbläsarna). Syns appen redan är den tyst – appen meddelar själv.
    await self.registration.showNotification(data.title || 'RailTimer', {
      body: data.body || '',
      tag: kind === 'test' ? 'railtimer-test' : (kind === 'start' ? 'railtimer-start' : undefined),
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      silent: !!(visible || data.silent),
      vibrate: data.level >= 2 ? [200, 100, 200, 100, 200] : [150, 80, 150],
      requireInteraction: data.level >= 2 && !visible,
      lang: 'sv',
      data: { url: './index.html' }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const win = list.find(c => c.url && new URL(c.url).pathname.startsWith(new URL('./', self.location.href).pathname));
    if (win && win.focus) return win.focus();
    return self.clients.openWindow ? self.clients.openWindow('./index.html') : null;
  }));
});

// Webbläsaren kan ha bytt prenumeration sedan appen sparade den: skicka den som gäller nu
async function freshSubscription(req) {
  try {
    const pm = self.registration && self.registration.pushManager;
    const sub = pm ? await pm.getSubscription() : null;
    if (!sub) return req;
    const body = JSON.parse(req.init.body);
    if (!body.client_payload || !body.client_payload.push) return req;
    body.client_payload.push.sub = JSON.parse(JSON.stringify(sub));
    return { url: req.url, init: Object.assign({}, req.init, { body: JSON.stringify(body) }) };
  } catch (e) {
    return req;
  }
}

// Begäran till GitHub med nya försök vid nätfel och serverfel (som sendWithRetry i railtimer-push.js)
async function dispatchWithRetry(req, delays) {
  let last = { ok: false, status: 0, error: '' };
  for (let k = 0; k < delays.length; k++) {
    if (delays[k]) await new Promise(r => setTimeout(r, delays[k]));
    try {
      const res = await fetch(req.url, req.init);
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: '' };
      last = { ok: false, status: res.status, error: `HTTP ${res.status}` };
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = { ok: false, status: 0, error: 'nätverksfel' };
    }
  }
  return last;
}

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (data.type === 'RT_DISPATCH' && data.req && /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/dispatches$/.test(data.req.url)) {
    event.waitUntil(freshSubscription(data.req).then(req => dispatchWithRetry(req, data.delays || [0, 5000, 15000, 30000])).then(result => {
      const rec = { event: data.event || '', journeyId: data.journeyId || null, at: Date.now(), ok: result.ok, status: result.status, error: result.error };
      return writePushState(() => ({ dispatch: rec })).then(() => tellClients({ type: 'RT_DISPATCH_RESULT', id: data.id, result: rec }));
    }));
  }
});
