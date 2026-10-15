'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Kör sw.js i en simulerad service worker och returnerar dess fetch-hanterare
function loadServiceWorker() {
  const listeners = {};
  const sandbox = {
    self: {
      location: new URL('https://akjork.github.io/kinnekulle-gps/sw.js?v=test'),
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => {},
      clients: { claim: () => Promise.resolve() }
    },
    caches: {
      match: async () => undefined,
      open: async () => ({ put: async () => {}, addAll: async () => {} }),
      keys: async () => [],
      delete: async () => true
    },
    fetch: async () => ({ clone() { return this; } }),
    URL, Promise, console
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), sandbox);
  return listeners.fetch;
}

// Ett fetch-event; handled blir true om service workern svarar i stället för nätet
function fetchEvent(method, url) {
  const event = { request: { method, url }, handled: false, respondWith() { event.handled = true; } };
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
