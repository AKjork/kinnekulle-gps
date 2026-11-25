'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Kör sw.js i en simulerad service worker och returnerar dess fetch-hanterare.
// opts.response: svaret från nätet (opts.fetch: egen fetch, t.ex. ett nätfel eller ett svar som aldrig kommer);
// opts.cached: den sparade kopian; put och addAll samlas i opts.puts och opts.added.
// opts.timeoutMs: hur länge sw.js tidsgräns får vara i testet (förvalt som i koden).
function loadServiceWorker(opts) {
  const o = opts || {};
  const listeners = {};
  const puts = o.puts || [];
  const added = o.added || [];
  const calls = o.calls || {};
  const sandbox = {
    self: {
      location: new URL('https://akjork.github.io/kinnekulle-gps/sw.js?v=test'),
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => { calls.skipWaiting = (calls.skipWaiting || 0) + 1; },
      clients: { claim: () => { calls.claim = (calls.claim || 0) + 1; return Promise.resolve(); } }
    },
    caches: {
      match: async () => o.cached,
      open: async () => ({ put: async (req, resp) => { puts.push({ req, resp }); }, addAll: async list => { added.push(...list); } }),
      keys: async () => ['kinnekulle-gps-cache-gammal', 'kinnekulle-gps-cache-test'],
      delete: async key => { (calls.deleted = calls.deleted || []).push(key); return true; }
    },
    fetch: o.fetch || (async () => Object.assign({ clone() { return this; } }, o.response || {})),
    Request: class { constructor(url, init) { this.url = url; this.cache = init && init.cache; } },
    setTimeout: (fn, ms) => setTimeout(fn, o.timeoutMs != null ? o.timeoutMs : ms),
    URL, Promise, console
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), sandbox);
  listeners.fetch.listeners = listeners;
  return listeners.fetch;
}

// Ett fetch-event; handled blir true om service workern svarar i stället för nätet
function fetchEvent(method, url) {
  const waits = [];
  const event = { request: { method, url }, handled: false, respondWith(p) { event.handled = true; event.response = p; }, waitUntil(p) { waits.push(p); }, waits };
  return event;
}

test('service workern lämnar anrop till GitHub orörda (privata data och token cachas inte)', () => {
  const onFetch = loadServiceWorker();
  const event = fetchEvent('GET', 'https://api.github.com/repos/AKjork/railtimer-data/git/trees/main?recursive=1');
  onFetch(event);
  assert.equal(event.handled, false);
});

test('service workern svarar för appens egna filer', () => {
  const onFetch = loadServiceWorker();
  const event = fetchEvent('GET', 'https://akjork.github.io/kinnekulle-gps/railtimer-github.js');
  onFetch(event);
  assert.equal(event.handled, true);
});

test('service workern sparar bara lyckade svar – en felsida ersätter aldrig appen offline', async () => {
  for (const [response, saved] of [[{ ok: true, status: 200, type: 'basic' }, 1], [{ ok: false, status: 503, type: 'basic' }, 0], [{ ok: false, status: 404, type: 'basic' }, 0]]) {
    const puts = [];
    const onFetch = loadServiceWorker({ response, puts });
    const event = fetchEvent('GET', 'https://akjork.github.io/kinnekulle-gps/index.html');
    onFetch(event);
    await event.response;
    await Promise.all(event.waits);
    assert.equal(puts.length, saved, `HTTP ${response.status}`);
  }
});

// 2026-11-25n: nätet först, så att appen kör senaste versionen när den öppnas
test('service workern: med nät visas senaste versionen från servern, inte den sparade kopian', async () => {
  const onFetch = loadServiceWorker({ response: { ok: true, status: 200, type: 'basic', body: 'ny' }, cached: { ok: true, body: 'gammal' } });
  const event = fetchEvent('GET', 'https://akjork.github.io/kinnekulle-gps/index.html');
  onFetch(event);
  assert.equal((await event.response).body, 'ny');
});

test('service workern: utan nät visas den sparade kopian', async () => {
  const onFetch = loadServiceWorker({ fetch: async () => { throw new TypeError('Failed to fetch'); }, cached: { ok: true, body: 'gammal' } });
  const event = fetchEvent('GET', 'https://akjork.github.io/kinnekulle-gps/index.html');
  onFetch(event);
  assert.equal((await event.response).body, 'gammal');
});

test('service workern: svarar inte nätet i tid (dålig täckning) visas den sparade kopian', async () => {
  const onFetch = loadServiceWorker({ fetch: () => new Promise(() => {}), cached: { ok: true, body: 'gammal' }, timeoutMs: 5 });
  const event = fetchEvent('GET', 'https://akjork.github.io/kinnekulle-gps/railtimer-info.js');
  onFetch(event);
  assert.equal((await event.response).body, 'gammal');
});

test('service workern: felsvar från servern ger den sparade kopian, och utan kopia felsvaret', async () => {
  const err = { ok: false, status: 503, type: 'basic', body: 'fel' };
  let onFetch = loadServiceWorker({ response: err, cached: { ok: true, body: 'gammal' } });
  let event = fetchEvent('GET', 'https://akjork.github.io/kinnekulle-gps/index.html');
  onFetch(event);
  assert.equal((await event.response).body, 'gammal');
  onFetch = loadServiceWorker({ response: err });
  event = fetchEvent('GET', 'https://akjork.github.io/kinnekulle-gps/index.html');
  onFetch(event);
  assert.equal((await event.response).status, 503);
});

test('service workern: versionskollen (version.json) går alltid till nätet och sparas inte', () => {
  const onFetch = loadServiceWorker();
  const event = fetchEvent('GET', 'https://akjork.github.io/kinnekulle-gps/version.json?t=1');
  onFetch(event);
  assert.equal(event.handled, false);
});

test('service workern: Västtrafiks gemensamma token (vt-token.json) går alltid till nätet och sparas inte', () => {
  const onFetch = loadServiceWorker();
  const event = fetchEvent('GET', 'https://akjork.github.io/kinnekulle-gps/vt-token.json?t=1');
  onFetch(event);
  assert.equal(event.handled, false);
});

test('service workern: en ny version tar över direkt och gamla kopior tas bort', async () => {
  const calls = {};
  const onFetch = loadServiceWorker({ calls });
  onFetch.listeners.install({ waitUntil() {} });
  assert.equal(calls.skipWaiting, 1, 'skipWaiting vid installation');
  let activating;
  onFetch.listeners.activate({ waitUntil(p) { activating = p; } });
  await activating;
  assert.deepEqual(calls.deleted, ['kinnekulle-gps-cache-gammal']);
  assert.equal(calls.claim, 1, 'tar över öppna sidor');
});

test('version.json har samma version som appen (APP_VERSION i index.html)', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = (html.match(/const APP_VERSION = '([^']+)'/) || [])[1];
  const published = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8')).version;
  assert.ok(app, 'APP_VERSION hittades');
  assert.equal(published, app, 'Höj versionen i både index.html och version.json');
});

test('service workern hämtar appens filer förbi webbläsarens cache vid installation', async () => {
  const added = [];
  const onFetch = loadServiceWorker({ added });
  let installing;
  onFetch.listeners.install({ waitUntil(p) { installing = p; } });
  await installing;
  assert.ok(added.length > 0, 'inga filer sparades');
  assert.ok(added.every(r => r.cache === 'reload'), 'alla hämtas med cache: reload');
  assert.ok(added.some(r => r.url === './') && added.some(r => r.url === './index.html'), 'både ./ och index.html');
});
