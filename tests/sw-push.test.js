'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// sw.js i en simulerad service worker med notiser, fönster och en riktig Cache-liknande lagring
function loadWorker(opts) {
  const o = opts || {};
  const listeners = {};
  const stores = new Map();
  const shown = [];
  const posted = [];
  const deleted = [];
  const fetches = [];
  const windows = (o.windows || []).map(w => Object.assign({ postMessage: m => posted.push(m), async focus() { this.focused = true; return this; } }, w));
  const opened = [];
  const sandbox = {
    self: {
      location: new URL('https://akjork.github.io/kinnekulle-gps/sw.js?v=test'),
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => {},
      registration: {
        showNotification: async (title, options) => { shown.push({ title, options }); },
        pushManager: { getSubscription: async () => (o.subscription ? { toJSON: () => o.subscription } : null) }
      },
      clients: {
        claim: async () => {},
        matchAll: async () => windows,
        openWindow: async url => { opened.push(url); return null; }
      }
    },
    caches: {
      open: async name => {
        if (!stores.has(name)) stores.set(name, new Map());
        const m = stores.get(name);
        return {
          put: async (req, resp) => { m.set(String(req), await resp.text()); },
          match: async req => (m.has(String(req)) ? new Response(m.get(String(req))) : undefined),
          addAll: async () => {}
        };
      },
      match: async () => undefined,
      keys: async () => ['kinnekulle-gps-cache-gammal', 'kinnekulle-gps-cache-test', 'railtimer-push'],
      delete: async key => { deleted.push(key); return true; }
    },
    fetch: o.fetch || (async (url, init) => { fetches.push({ url, init }); return { status: 204 }; }),
    Request: class { constructor(url) { this.url = url; } },
    Response, URL, Promise, console, JSON,
    setTimeout: (fn) => setTimeout(fn, 0)
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), sandbox);
  const state = async () => { const m = stores.get('railtimer-push'); return m && m.has('./push-state') ? JSON.parse(m.get('./push-state')) : null; };
  return { listeners, shown, posted, deleted, fetches, opened, windows, state };
}
function pushEvent(data) {
  const waits = [];
  return { data: { json: () => data, text: () => JSON.stringify(data) }, waitUntil: p => waits.push(p), waits };
}

test('service workern: notisen visas med text och vibration, och läget sparas för appen', async () => {
  const sw = loadWorker();
  const ev = pushEvent({ v: 1, kind: 'alert', journeyId: 'j1', title: 'Tåg 23349 → Herrljunga C', body: 'Anslutning 11:45 Borås C: missas\nHerrljunga C 11:46 +6 min', level: 2, keys: [['c|3047', 2]] });
  sw.listeners.push(ev);
  await Promise.all(ev.waits);
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, 'Tåg 23349 → Herrljunga C');
  assert.equal(sw.shown[0].options.body, 'Anslutning 11:45 Borås C: missas\nHerrljunga C 11:46 +6 min');
  assert.equal(sw.shown[0].options.silent, false);
  assert.equal(sw.shown[0].options.requireInteraction, true, 'nivå 2 ligger kvar tills den läses');
  const st = await sw.state();
  assert.equal(st.journeyId, 'j1');
  assert.deepEqual(st.keys, [['c|3047', 2]]);
  assert.equal(st.last.kind, 'alert');
});

test('service workern: syns appen är notisen tyst och appen får veta', async () => {
  const sw = loadWorker({ windows: [{ url: 'https://akjork.github.io/kinnekulle-gps/index.html', visibilityState: 'visible' }] });
  const ev = pushEvent({ v: 1, kind: 'alert', journeyId: 'j1', title: 't', body: 'b', level: 1, keys: [['x', 1]] });
  sw.listeners.push(ev);
  await Promise.all(ev.waits);
  assert.equal(sw.shown[0].options.silent, true);
  assert.equal(sw.posted[0].type, 'RT_PUSH');
  assert.deepEqual(sw.posted[0].data.keys, [['x', 1]]);
});

test('service workern: tryck på notisen öppnar appen, eller visar den om den redan är öppen', async () => {
  for (const [windows, focused, opened] of [[[], false, 1], [[{ url: 'https://akjork.github.io/kinnekulle-gps/index.html', visibilityState: 'hidden' }], true, 0]]) {
    const sw = loadWorker({ windows });
    let closed = false;
    const waits = [];
    sw.listeners.notificationclick({ notification: { close: () => { closed = true; } }, waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    assert.equal(closed, true);
    assert.equal(sw.opened.length, opened);
    assert.equal(!!(sw.windows[0] && sw.windows[0].focused), focused);
  }
});

test('service workern: begäran till GitHub skickas med nya försök, och bara till dispatches', async () => {
  let n = 0;
  const calls = [];
  const sw = loadWorker({ fetch: async (url, init) => { calls.push(url); if (++n < 2) throw new TypeError('nät'); return { status: 204 }; } });
  const waits = [];
  const req = { url: 'https://api.github.com/repos/AKjork/railtimer-data/dispatches', init: { method: 'POST', body: '{}' } };
  sw.listeners.message({ data: { type: 'RT_DISPATCH', req, event: 'bevaka', journeyId: 'j1', delays: [0, 1] }, waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  assert.equal(calls.length, 2, 'ett nytt försök efter nätfelet');
  const st = await sw.state();
  assert.deepEqual([st.dispatch.event, st.dispatch.ok, st.dispatch.status], ['bevaka', true, 204]);
  // Har webbläsaren bytt prenumeration skickas den som gäller nu
  const fresh = { endpoint: 'https://fcm.googleapis.com/ny', keys: { p256dh: 'p', auth: 'a' } };
  const sent = [];
  const sw3 = loadWorker({ fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return { status: 204 }; }, subscription: fresh });
  const w3 = [];
  const body = JSON.stringify({ event_type: 'bevaka', client_payload: { v: 1, push: { sub: { endpoint: 'https://fcm.googleapis.com/gammal' }, jwk: {} } } });
  sw3.listeners.message({ data: { type: 'RT_DISPATCH', req: { url: req.url, init: { method: 'POST', body } }, event: 'bevaka' }, waitUntil: p => w3.push(p) });
  await Promise.all(w3);
  assert.equal(sent[0].client_payload.push.sub.endpoint, 'https://fcm.googleapis.com/ny');
  // Andra adresser skickas inte (token följer med i begäran)
  const waits2 = [];
  sw.listeners.message({ data: { type: 'RT_DISPATCH', req: { url: 'https://evil.example/dispatches', init: {} } }, waitUntil: p => waits2.push(p) });
  assert.equal(waits2.length, 0);
});

test('service workern: notisernas läge tas inte bort när en ny version tar över', async () => {
  const sw = loadWorker();
  const waits = [];
  sw.listeners.activate({ waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(sw.deleted, ['kinnekulle-gps-cache-gammal']);
});
