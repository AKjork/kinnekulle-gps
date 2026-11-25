'use strict';
// Den gemensamma Västtrafik-token (tools/vasttrafik-token.mjs, körs i GitHub Actions) med simulerat Västtrafik
const test = require('node:test');
const assert = require('node:assert/strict');

const H = obj => ({ get: k => (obj || {})[k.toLowerCase()] ?? null });
function fakeVt(opts) {
  const o = opts || {};
  const calls = [];
  const cors = o.cors === false ? {} : { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-allow-methods': 'GET, POST' };
  const fetch = async (url, init) => {
    const i = init || {};
    calls.push({ url, init: i });
    if (i.method === 'OPTIONS') return { status: o.cors === false ? 405 : 204, ok: o.cors !== false, headers: H(cors) };
    if (url.endsWith('/token')) {
      if (o.badKey) return { status: 401, ok: false, headers: H({}), json: async () => ({}) };
      return { status: 200, ok: true, headers: H(cors), json: async () => ({ access_token: 'TOK-' + calls.length, expires_in: 86400 }) };
    }
    if (url.includes('/locations/by-coordinates')) return { status: 200, ok: true, headers: H(cors), json: async () => ({ results: [{ gid: 'G1', name: 'Lidköping Resecentrum', locationType: 'stoparea', straightLineDistanceInMeters: 60 }] }) };
    if (url.includes('/departures')) return { status: 200, ok: true, headers: H(cors), json: async () => ({ results: [
      { serviceJourney: { gid: 'a', direction: 'Skara', line: { shortName: '1', transportMode: 'bus' } }, stopPoint: { platform: 'A' }, plannedTime: '2026-11-25T18:00:00+01:00', estimatedTime: '2026-11-25T18:02:00+01:00' },
      { serviceJourney: { gid: 'b', direction: 'Göteborg', line: { shortName: 'VTG', transportMode: 'train' } }, stopPoint: {}, plannedTime: '2026-11-25T18:05:00+01:00' }
    ] }) };
    return { status: 404, ok: false, headers: H({}), json: async () => ({}) };
  };
  return { fetch, calls };
}
const NOW = Date.parse('2026-11-25T18:00:00+01:00');
const ENV = { VT_KEY: 'nyckel', VT_SECRET: 'hemlig' };

test('gemensam token: nytt token, CORS och appens frågor provas – utan nyckeln i filen', async () => {
  const T = await import('../tools/vasttrafik-token.mjs');
  const vt = fakeVt();
  const res = await T.run({ fetch: vt.fetch, env: ENV, now: NOW, existing: null, force: false });
  assert.equal(res.exitCode, 0);
  const f = res.file;
  assert.match(f.token, /^TOK-/);
  assert.equal(f.expiresAt, NOW + 86400000);
  assert.equal(f.cors.tokenFromBrowser, true);
  assert.equal(f.cors.apiFromBrowser, true);
  assert.deepEqual(f.check.stopAreas, ['Lidköping Resecentrum (60 m)']);
  assert.deepEqual(f.check.departures, { status: 200, count: 2, buses: 1, withEstimate: 1 });
  const tokenCall = vt.calls.find(c => c.url.endsWith('/token') && c.init.method === 'POST');
  assert.equal(tokenCall.init.headers.Authorization, 'Basic ' + Buffer.from('nyckel:hemlig').toString('base64'));
  assert.match(tokenCall.init.body, /scope=device_railtimer\d+/, 'unikt scope ger ett nytt token');
  const text = JSON.stringify(f);
  assert.ok(!text.includes('nyckel') && !text.includes('hemlig'), 'nyckel och hemlighet aldrig i filen');
  assert.ok(vt.calls.filter(c => c.url.includes('/pr/v4/')).every(c => c.init.method === 'OPTIONS' || c.init.headers.Origin === T.ORIGIN), 'frågorna från appens adress');
});

test('gemensam token: inget nytt så länge det gamla gäller mer än 12 h, men alltid vid körning för hand', async () => {
  const T = await import('../tools/vasttrafik-token.mjs');
  const existing = { token: 'GAMMAL', expiresAt: NOW + 13 * 3600000 };
  const vt = fakeVt();
  const res = await T.run({ fetch: vt.fetch, env: ENV, now: NOW, existing, force: false });
  assert.equal(res.file, null);
  assert.equal(vt.calls.length, 0, 'inga frågor');
  assert.equal(T.needsRenewal({ token: 'x', expiresAt: NOW + 11 * 3600000 }, NOW), true);
  const forced = await T.run({ fetch: fakeVt().fetch, env: ENV, now: NOW, existing, force: true });
  assert.match(forced.file.token, /^TOK-/);
});

test('gemensam token: utan hemligheterna skrivs CORS-provet och varför, och fel nyckel ger fel i körningen', async () => {
  const T = await import('../tools/vasttrafik-token.mjs');
  const res = await T.run({ fetch: fakeVt({ cors: false }).fetch, env: {}, now: NOW, existing: null, force: true });
  assert.equal(res.exitCode, 0);
  assert.equal(res.file.token, null);
  assert.equal(res.file.error, 'VT_KEY och VT_SECRET saknas i GitHub');
  assert.equal(res.file.cors.tokenFromBrowser, false);
  assert.ok(res.log.some(l => l.startsWith('::warning::')));
  // Schemalagd körning utan hemligheter: skriver inte om filen var 3:e timme
  const again = await T.run({ fetch: fakeVt().fetch, env: {}, now: NOW, existing: res.file, force: false });
  assert.equal(again.file, null);
  // Fel nyckel: felet i körningen, och ett gammalt token som gäller får vara kvar
  const bad = await T.run({ fetch: fakeVt({ badKey: true }).fetch, env: ENV, now: NOW, existing: null, force: true });
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.file.error, 'Västtrafik godtog inte VT_KEY och VT_SECRET');
  const keep = await T.run({ fetch: fakeVt({ badKey: true }).fetch, env: ENV, now: NOW, existing: { token: 'GAMMAL', expiresAt: NOW + 3600000 }, force: false });
  assert.equal(keep.file, null);
  assert.equal(keep.exitCode, 1);
  assert.equal(T.corsAllows({ status: 204, allowOrigin: 'https://akjork.github.io', allowHeaders: '*' }, 'authorization'), true);
  assert.equal(T.corsAllows({ status: 204, allowOrigin: 'https://annan.se', allowHeaders: '*' }, 'authorization'), false);
});
