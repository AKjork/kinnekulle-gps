'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Kör sw.js i en simulerad service worker och returnerar dess fetch-hanterare.
// opts.response: svaret från nätet; put och addAll samlas i opts.puts och opts.added.
function loadServiceWorker(opts) {
  const o = opts || {};
  const listeners = {};
  const puts = o.puts || [];
  const added = o.added || [];
  const sandbox = {
    self: {
      location: new URL('https://akjork.github.io/kinnekulle-gps/sw.js?v=test'),
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => {},
      clients: { claim: () => Promise.resolve() }
    },
    caches: {
      match: async () => undefined,
      open: async () => ({ put: async (req, resp) => { puts.push({ req, resp }); }, addAll: async list => { added.push(...list); } }),
      keys: async () => [],
      delete: async () => true
    },
    fetch: async () => Object.assign({ clone() { return this; } }, o.response || {}),
    Request: class { constructor(url, init) { this.url = url; this.cache = init && init.cache; } },
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
