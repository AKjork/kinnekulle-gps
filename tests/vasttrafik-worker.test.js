'use strict';
// Den egna servern för Västtrafik (docs/vasttrafik-worker.js, Cloudflare Worker) med simulerat Västtrafik
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Filen är en ES-modul för Cloudflare; här körs den som en funktion med egen fetch
function loadWorker(fakeFetch) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'vasttrafik-worker.js'), 'utf8').replace('export default', 'return');
  return new Function('fetch', 'btoa', src)(fakeFetch, s => Buffer.from(s, 'binary').toString('base64'));
}
function fakeVt(opts) {
  const o = opts || {};
  const calls = [];
  let tokens = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/token')) {
      if (o.badKey) return new Response('{}', { status: 401 });
      tokens++;
      return new Response(JSON.stringify({ access_token: 'T' + tokens, expires_in: 3600 }), { status: 200 });
    }
    const auth = init.headers.Authorization;
    if (o.rejectFirst && auth === 'Bearer T1') return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ results: [{ auth, url }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, calls, tokens: () => tokens };
}
const env = { VT_KEY: 'nyckel', VT_SECRET: 'hemlig' };
const APP = 'https://akjork.github.io';
const req = (pathname, init) => new Request('https://railtimer-vt.exempel.workers.dev' + pathname, init);

test('egen server: frågan går vidare till Västtrafik med token, och svaret får CORS för appen', async () => {
  const vt = fakeVt();
  const worker = loadWorker(vt.fetch);
  const r = await worker.fetch(req('/pr/v4/stop-areas/G/departures?limit=50', { headers: { Origin: APP } }), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), APP);
  const body = await r.json();
  assert.equal(body.results[0].url, 'https://ext-api.vasttrafik.se/pr/v4/stop-areas/G/departures?limit=50');
  assert.equal(body.results[0].auth, 'Bearer T1');
  assert.equal(vt.calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('nyckel:hemlig').toString('base64'));
  await worker.fetch(req('/pr/v4/locations/by-coordinates?latitude=58', { headers: { Origin: APP } }), env);
  assert.equal(vt.tokens(), 1, 'samma token');
  const pre = await worker.fetch(req('/pr/v4/x', { method: 'OPTIONS', headers: { Origin: APP } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
});

test('egen server: bara appen, bara GET till /pr/v4/, nytt token när Västtrafik inte godtar det gamla', async () => {
  const worker = loadWorker(fakeVt().fetch);
  assert.equal((await worker.fetch(req('/pr/v4/x', { headers: { Origin: 'https://annan.se' } }), env)).status, 403);
  assert.equal((await worker.fetch(req('/token', { headers: { Origin: APP } }), env)).status, 404);
  assert.equal((await worker.fetch(req('/pr/v4/x', { method: 'POST', headers: { Origin: APP } }), env)).status, 404);
  const vt = fakeVt({ rejectFirst: true });
  const w2 = loadWorker(vt.fetch);
  const r = await w2.fetch(req('/pr/v4/x', { headers: { Origin: APP } }), env);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).results[0].auth, 'Bearer T2');
  const bad = loadWorker(fakeVt({ badKey: true }).fetch);
  const e = await bad.fetch(req('/pr/v4/x', { headers: { Origin: APP } }), env);
  assert.equal(e.status, 502);
  assert.match((await e.json()).error, /godtog inte nyckeln/);
});
