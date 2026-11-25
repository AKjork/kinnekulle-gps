/* RailTimer – notiser i bakgrunden, appens del.
   Telefonen prenumererar på webbpush med en egen VAPID-nyckel (skapas här, sparas på telefonen) och startar
   bevakningen i railtimer-data med repository_dispatch när appen lämnas under en resa. Bevakningen
   (bevakning/bevaka.js, GitHub Actions) skickar notiserna. Rena funktioner utan beroenden; används av
   index.html och testas med node --test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RailTimerPush = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'railtimer_push_v1';
  const STOP_AFTER_VISIBLE_MS = 3 * 60000; // appen har visats så här länge: appen tar över, bevakningen stoppas
  const MAX_PAYLOAD = 60000;               // GitHub tar högst 64 kB i client_payload
  const EVENTS = { start: 'bevaka', stop: 'bevaka-stopp', test: 'bevaka-test' };

  function b64url(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(text) {
    const s = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // VAPID-nyckel (ECDSA P-256). pub är den publika nyckeln rå (65 byte) för PushManager.subscribe.
  async function createVapid(subtle) {
    const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await subtle.exportKey('jwk', kp.privateKey);
    const raw = await subtle.exportKey('raw', kp.publicKey);
    return { jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, pub: b64url(raw) };
  }
  function newDevice(rand) {
    const bytes = new Uint8Array(6);
    if (rand) rand(bytes); else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  /* Går notiser att använda här? env: { ua, standalone, hasServiceWorker, hasPushManager, hasNotification, permission }.
     Ger { ok, reason } där reason är ios-hemskarm, ios-gammal, saknas eller blockerad. */
  function support(env) {
    const e = env || {};
    const ios = /iPhone|iPad|iPod/.test(e.ua || '') || (/Macintosh/.test(e.ua || '') && e.touch);
    if (e.permission === 'denied') return { ok: false, reason: 'blockerad', ios };
    if (e.hasServiceWorker && e.hasPushManager && e.hasNotification) return { ok: true, reason: '', ios };
    if (ios && !e.standalone) return { ok: false, reason: 'ios-hemskarm', ios };
    if (ios) return { ok: false, reason: 'ios-gammal', ios };
    return { ok: false, reason: 'saknas', ios };
  }
  const SUPPORT_TEXT = {
    'ios-hemskarm': 'På iPhone fungerar notiser bara när RailTimer ligger på hemskärmen: tryck på Dela → Lägg till på hemskärmen, öppna RailTimer därifrån och slå på notiserna där. Hemskärmsappen har egen inloggning – klistra in inloggningslänken under ⋮ → Uppladdning.',
    'ios-gammal': 'Notiser kräver iOS 16.4 eller senare.',
    'saknas': 'Webbläsaren kan inte ta emot notiser. Använd Chrome på Android eller RailTimer från hemskärmen på iPhone.',
    'blockerad': 'Notiser är blockerade för RailTimer i webbläsarens inställningar. Tillåt dem där och försök igen.'
  };

  /* Begäran till bevakningen. journey: { id, train, startSig, endSig, startedAt, announce, app }.
     known: [[sig, ankomst ms, avgång ms]], notified: [[nyckel, nivå]], names: { sig: namn },
     history: Map(nyckel → { median, n }) – bara sträckor mellan resans stationer skickas, double: [sträcka]. */
  function buildPayload(o) {
    const routeNames = new Set(Object.values(o.names || {}).map(n => String(n).trim().toLowerCase()));
    const history = [];
    if (o.history && typeof o.history.forEach === 'function') {
      o.history.forEach((v, k) => {
        const [a, b] = String(k).split('>');
        if (routeNames.has(a) && routeNames.has(b) && v && Number.isFinite(v.median)) history.push([k, Math.round(v.median), v.n]);
      });
    }
    const p = {
      v: 1, device: o.device,
      journey: o.journey || null,
      push: { sub: o.sub, jwk: o.jwk },
      known: o.known || [], notified: o.notified || [], names: o.names || {},
      history, double: (o.double || []).slice(-300)
    };
    if (o.ref) p.ref = o.ref;
    // Får det inte plats tas det minst viktiga bort först
    for (const drop of ['history', 'double', 'notified']) {
      if (JSON.stringify(p).length <= MAX_PAYLOAD) break;
      p[drop] = [];
    }
    return p;
  }

  function dispatchRequest(settings, eventType, payload) {
    const [owner, repo] = String(settings.repo || '').split('/');
    return {
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`,
      init: {
        method: 'POST', cache: 'no-store',
        headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: eventType, client_payload: payload })
      }
    };
  }
  /* Skickar begäran, med nya försök vid nätfel och serverfel (inte vid 4xx, t.ex. fel token).
     Ger { ok, status, attempts, error } */
  async function sendWithRetry(fetchImpl, req, opts) {
    const o = opts || {};
    const delays = o.delays || [0, 5000, 15000, 30000];
    const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    let last = { ok: false, status: 0, attempts: 0, error: '' };
    for (let k = 0; k < delays.length; k++) {
      if (delays[k]) await sleep(delays[k]);
      let res;
      try {
        res = await fetchImpl(req.url, req.init);
      } catch (e) {
        last = { ok: false, status: 0, attempts: k + 1, error: 'nätverksfel' };
        continue;
      }
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, attempts: k + 1, error: '' };
      last = { ok: false, status: res.status, attempts: k + 1, error: res.status === 401 ? 'token godtas inte' : (res.status === 403 || res.status === 404 ? 'token saknar rätt till repot' : `HTTP ${res.status}`) };
      if (res.status < 500 && res.status !== 429) break;
    }
    return last;
  }

  /* När ska bevakningen startas och stoppas? Appen anropar med händelsen och läget, och gör det som kommer
     tillbaka. watch: { journeyId, active, announced, visibleSince }. ev: hidden | visible | tick | end.
     Ger { watch, action: 'start' | 'stop' | null, announce } */
  function plan(watch, ev, ctx) {
    const w = Object.assign({ journeyId: null, active: false, announced: false, visibleSince: null }, watch || {});
    const c = ctx || {};
    if (w.journeyId !== c.journeyId) Object.assign(w, { journeyId: c.journeyId || null, active: false, announced: false, visibleSince: null });
    const can = !!(c.enabled && c.running && c.train && c.journeyId);
    if (ev === 'end' || (!can && ev !== 'tick')) {
      const action = w.active ? 'stop' : null;
      return { watch: Object.assign(w, { active: false, visibleSince: null }), action };
    }
    if (ev === 'hidden') {
      w.visibleSince = null;
      if (!can || w.active) return { watch: w, action: null };
      const announce = !w.announced;
      return { watch: Object.assign(w, { active: true, announced: true }), action: 'start', announce };
    }
    if (ev === 'visible') {
      if (w.active && w.visibleSince == null) w.visibleSince = c.now;
      return { watch: w, action: null };
    }
    if (ev === 'tick') {
      if (w.active && w.visibleSince != null && c.now - w.visibleSince >= STOP_AFTER_VISIBLE_MS) {
        return { watch: Object.assign(w, { active: false, visibleSince: null }), action: 'stop' };
      }
      return { watch: w, action: null };
    }
    return { watch: w, action: null };
  }

  // Nycklarna i notiserna (det bevakningen meddelat) läggs till i appens, så att appen inte meddelar samma sak igen
  function mergeNotified(notified, keys) {
    for (const k of keys || []) {
      if (!Array.isArray(k) || !k[0]) continue;
      const level = Number(k[1]) || 0;
      if (level > (notified.get(k[0]) || 0)) notified.set(k[0], level);
    }
    return notified;
  }

  return { STORAGE_KEY, STOP_AFTER_VISIBLE_MS, MAX_PAYLOAD, EVENTS, SUPPORT_TEXT, b64url, fromB64url, createVapid, newDevice, support, buildPayload, dispatchRequest, sendWithRetry, plan, mergeNotified };
});
