'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../railtimer-vt.js');

// Svar som i Västtrafiks dokumentation för Planera Resa v4
const board = list => ({ results: list, pagination: { limit: 50, offset: 0, size: list.length } });
const call = (line, mode, planned, extra) => Object.assign({
  detailsReference: 'ref-' + line,
  serviceJourney: { gid: '901401' + line, direction: 'Skara Resecentrum', origin: 'Lidköping Resecentrum',
    line: { gid: '9011014', name: 'Buss ' + line, shortName: line, designation: line, transportMode: mode } },
  stopPoint: { gid: '9022014004101001', name: 'Lidköping Resecentrum', platform: 'C', latitude: 58.505, longitude: 13.157 },
  plannedTime: planned, isCancelled: false
}, extra || {});

test('token: Basic med nyckel och hemlighet, och svaret med giltighetstid', () => {
  const r = V.tokenRequest('nyckel', 'hemlig', 'abc');
  assert.equal(r.url, 'https://ext-api.vasttrafik.se/token');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers.Authorization, 'Basic ' + Buffer.from('nyckel:hemlig').toString('base64'));
  assert.equal(r.init.body, 'grant_type=client_credentials&scope=device_abc');
  assert.deepEqual(V.parseToken({ access_token: 'T1', expires_in: 600 }, 1000), { token: 'T1', expiresAt: 601000 });
  assert.equal(V.parseToken({ access_token: 'T1' }, 0).expiresAt, 3600000, 'utan giltighetstid: en timme');
  assert.equal(V.parseToken({}, 0), null);
  assert.equal(V.base64('å:ö'), Buffer.from('å:ö').toString('base64'), 'å, ä och ö');
});

test('inställningarna: nyckel och hemlighet eller egen server (https)', () => {
  assert.equal(V.configured({ key: 'k', secret: 's' }), true);
  assert.equal(V.configured({ key: 'k' }), false);
  assert.equal(V.configured({ server: 'https://vt.exempel.workers.dev/' }), true);
  assert.equal(V.configured({ server: 'http://exempel.se' }), false, 'inte http');
  assert.equal(V.cleanServer('https://vt.exempel.workers.dev//'), 'https://vt.exempel.workers.dev');
  assert.equal(V.cleanServer('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(V.cleanServer('javascript:alert(1)'), '');
});

test('frågorna: hållplatsområden nära stationen och tavlan för en tid', () => {
  assert.equal(V.nearbyPath(58.5051234567, 13.157, 350),
    '/locations/by-coordinates?latitude=58.505123&longitude=13.157000&radiusInMeters=350&types=stoparea&limit=10&offset=0');
  const t = Date.parse('2026-11-25T11:40:00+01:00');
  assert.equal(V.boardPath('departures', '9021014004101000', t, 41),
    '/stop-areas/9021014004101000/departures?startDateTime=2026-11-25T10%3A40%3A00.000Z&timeSpanInMinutes=41&maxDeparturesPerLineAndDirection=10&limit=50&offset=0');
  assert.ok(V.boardPath('arrivals', 'G', t, 2000).includes('/arrivals?') && V.boardPath('arrivals', 'G', t, 2000).includes('timeSpanInMinutes=1440&maxArrivalsPerLineAndDirection=10'));
});

test('hållplatsområden: närmast först, bara hållplatsområden inom avståndet', () => {
  const json = { results: [
    { gid: 'B', name: 'Lidköping Nya Stadens torg', locationType: 'stoparea', straightLineDistanceInMeters: 320 },
    { gid: 'A', name: 'Lidköping Resecentrum', locationType: 'stoparea', straightLineDistanceInMeters: 40 },
    { gid: 'P', name: 'Lidköping Resecentrum', locationType: 'stoppoint', straightLineDistanceInMeters: 30 },
    { gid: 'C', name: 'Lidköping Stadshuset', locationType: 'stoparea', straightLineDistanceInMeters: 600 },
    { gid: 'D', name: 'Utan avstånd', locationType: 'stoparea', latitude: 58.506, longitude: 13.157 }
  ] };
  const list = V.parseStopAreas(json, 350, { lat: 58.505, lon: 13.157 });
  assert.deepEqual(list.map(x => [x.gid, x.dist]), [['A', 40], ['D', 111], ['B', 320]]);
  assert.deepEqual(V.parseStopAreas({ results: [] }, 350), []);
  assert.deepEqual(V.parseStopAreas(null, 350), []);
});

test('tavlan: linje, trafikslag, riktning, planerad och beräknad tid, inställt och läge – bara bussar', () => {
  const json = board([
    call('121', 'bus', '2026-11-25T11:48:00+01:00', { estimatedTime: '2026-11-25T11:51:30+01:00' }),
    call('3', 'bus', '2026-11-25T11:45:00+01:00', { isCancelled: true }),
    call('VTG', 'train', '2026-11-25T11:50:00+01:00'),
    { plannedTime: null }
  ]);
  const calls = V.parseBoard(json);
  assert.deepEqual(calls.map(c => c.line), ['3', '121', 'VTG'], 'i tidsordning, utan rader utan tid');
  const c = calls[1];
  assert.equal(c.mode, 'bus');
  assert.equal(c.direction, 'Skara Resecentrum');
  assert.equal(c.origin, 'Lidköping Resecentrum');
  assert.equal(c.planned, Date.parse('2026-11-25T11:48:00+01:00'));
  assert.equal(c.est, Date.parse('2026-11-25T11:51:30+01:00'));
  assert.equal(c.platform, 'C');
  assert.equal(c.canceled, false);
  assert.equal(calls[0].canceled, true);
  assert.equal(calls[0].est, null);
  assert.deepEqual(V.busesOnly(calls).map(x => x.line), ['3', '121'], 'Västtågen tas från Trafikverket');
  assert.deepEqual(V.uniqueCalls(calls.concat(calls)).length, 3, 'samma tur från två hållplatsområden en gång');
  assert.equal(V.townKey('Skara via Götene'), 'skara');
});

// Simulerat Västtrafik: fetch(url, init) → svar. opts.cors=false: webbläsaren stoppar frågan (TypeError),
// men mode no-cors når fram.
function fakeVt(opts) {
  const o = opts || {};
  const calls = [];
  let tokens = 0;
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetch = async (url, init) => {
    const i = init || {};
    calls.push({ url, init: i });
    if (i.mode === 'no-cors') { if (o.offline) throw new TypeError('Failed to fetch'); return { ok: false, status: 0, type: 'opaque' }; }
    if (o.offline || (o.cors === false && url.includes('/token')) || (o.corsData === false && url.includes('/pr/v4'))) throw new TypeError('Failed to fetch');
    if (url.endsWith('/token')) {
      if (o.badKey) return resp(401, { error: 'invalid_client' });
      tokens++;
      return resp(200, { access_token: 'T' + tokens, expires_in: 3600, token_type: 'Bearer' });
    }
    if (o.server && url.startsWith(o.server)) {
      if (i.headers && i.headers.Authorization) return resp(400, {});
    } else if (!(i.headers && i.headers.Authorization === 'Bearer T' + tokens) || (o.expireFirst && tokens === 1)) return resp(401, {});
    if (url.includes('/locations/by-coordinates')) return resp(200, { results: [{ gid: '9021014004101000', name: 'Lidköping Resecentrum', locationType: 'stoparea', straightLineDistanceInMeters: 60 }] });
    if (url.includes('/departures')) return resp(200, board([call('121', 'bus', '2026-11-25T11:48:00+01:00')]));
    if (url.includes('/arrivals')) return resp(200, board([call('122', 'bus', '2026-11-25T11:30:00+01:00')]));
    return resp(404, {});
  };
  return { fetch, calls, tokens: () => tokens };
}

test('klienten: token hämtas en gång och används för frågorna', async () => {
  const vt = fakeVt();
  const store = { t: null, get() { return this.t; }, set(t) { this.t = t; } };
  const c = V.createClient({ fetch: vt.fetch, settings: { key: 'k', secret: 's', deviceId: 'd1' }, tokenStore: store, now: () => 1000 });
  const areas = await c.stopAreasNear(58.505, 13.157);
  assert.deepEqual(areas.map(a => a.name), ['Lidköping Resecentrum']);
  const deps = await c.board('departures', areas[0].gid, Date.parse('2026-11-25T11:40:00+01:00'), 41);
  assert.equal(deps[0].line, '121');
  const arrs = await c.board('arrivals', areas[0].gid, Date.parse('2026-11-25T11:00:00+01:00'), 31);
  assert.equal(arrs[0].line, '122');
  assert.equal(vt.tokens(), 1, 'samma token för alla frågor');
  assert.equal(store.t.token, 'T1');
  assert.ok(vt.calls[1].url.startsWith('https://ext-api.vasttrafik.se/pr/v4/locations/by-coordinates?'));
});

test('klienten: utgånget token byts en gång', async () => {
  const vt = fakeVt({ expireFirst: true });
  const c = V.createClient({ fetch: vt.fetch, settings: { key: 'k', secret: 's' } });
  const deps = await c.board('departures', 'G', 0, 10);
  assert.equal(deps.length, 1);
  assert.equal(vt.tokens(), 2);
});

test('klienten: Västtrafik stoppar token i webbläsaren – felet säger det, och med egen server behövs inget token', async () => {
  const vt = fakeVt({ cors: false });
  const c = V.createClient({ fetch: vt.fetch, settings: { key: 'k', secret: 's' } });
  await assert.rejects(c.board('departures', 'G', 0, 10), e => e.kind === 'blocked' && /tillåter inte/.test(e.message));
  assert.ok(V.errorText({ kind: 'blocked', message: 'Västtrafik tillåter inte frågan från webbläsaren' }).includes('egen server'));
  // Utan täckning: nätfel
  const off = V.createClient({ fetch: fakeVt({ offline: true }).fetch, settings: { key: 'k', secret: 's' }, online: () => false });
  await assert.rejects(off.board('departures', 'G', 0, 10), e => e.kind === 'network');
  const unreachable = V.createClient({ fetch: fakeVt({ offline: true }).fetch, settings: { key: 'k', secret: 's' } });
  await assert.rejects(unreachable.board('departures', 'G', 0, 10), e => e.kind === 'network');
  // Egen server: frågorna går dit utan token, och servern lägger till det
  const sv = fakeVt({ cors: false, server: 'https://vt.exempel.workers.dev' });
  const viaServer = V.createClient({ fetch: sv.fetch, settings: { server: 'https://vt.exempel.workers.dev/' } });
  assert.equal(viaServer.viaServer, true);
  const deps = await viaServer.board('departures', 'G', 0, 10);
  assert.equal(deps[0].line, '121');
  assert.ok(sv.calls.every(x => x.url.startsWith('https://vt.exempel.workers.dev/pr/v4/') && !(x.init.headers && x.init.headers.Authorization)));
  assert.equal(sv.tokens(), 0);
});

test('klienten: fel nyckel och saknade inställningar', async () => {
  const bad = V.createClient({ fetch: fakeVt({ badKey: true }).fetch, settings: { key: 'k', secret: 'fel' } });
  await assert.rejects(bad.token(), e => e.kind === 'auth' && /godtog inte nyckeln/.test(e.message));
  const none = V.createClient({ fetch: fakeVt().fetch, settings: {} });
  await assert.rejects(none.token(), e => e.kind === 'setup');
});
