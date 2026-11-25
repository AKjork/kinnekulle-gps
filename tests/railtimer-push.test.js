'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const P = require('../railtimer-push.js');
const WP = require('../bevakning/webpush.js');

test('notiser: VAPID-nyckeln från webbläsaren (WebCrypto) går att signera med i bevakningen', async () => {
  const v = await P.createVapid(crypto.webcrypto.subtle);
  assert.equal(P.fromB64url(v.pub).length, 65, 'rå publik nyckel för PushManager.subscribe');
  assert.deepEqual(Object.keys(v.jwk).sort(), ['crv', 'd', 'kty', 'x', 'y']);
  const h = WP.vapidHeaders('https://web.push.apple.com/x', v.jwk);
  assert.equal(h.publicKey, v.pub, 'samma publika nyckel som prenumerationen');
  const [a, b, sig] = h.jwt.split('.');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: v.jwk.x, y: v.jwk.y }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${a}.${b}`), { key: pub, dsaEncoding: 'ieee-p1363' }, WP.fromB64url(sig)));
  assert.match(P.newDevice(), /^[0-9a-f]{12}$/);
});

test('notiser: vilka telefoner som kan få notiser', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
  const android = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
  const all = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: 'default' };
  assert.deepEqual(P.support(Object.assign({ ua: android }, all)), { ok: true, reason: '', ios: false });
  assert.equal(P.support({ ua: iphone, hasServiceWorker: true, standalone: false }).reason, 'ios-hemskarm', 'Safari på iPhone: lägg till på hemskärmen');
  assert.equal(P.support(Object.assign({ ua: iphone, standalone: true }, all)).ok, true, 'från hemskärmen');
  assert.equal(P.support({ ua: iphone, standalone: true, hasServiceWorker: true }).reason, 'ios-gammal');
  assert.equal(P.support(Object.assign({ ua: android }, all, { permission: 'denied' })).reason, 'blockerad');
  assert.match(P.SUPPORT_TEXT['ios-hemskarm'], /Lägg till på hemskärmen/);
});

test('notiser: begäran till bevakningen har högst 10 fält och bara resans egna gångtider', () => {
  const history = new Map([['lidköping>järpås', { median: 600123.4, n: 5 }], ['hallsberg>laxå', { median: 900000, n: 9 }]]);
  const p = P.buildPayload({
    device: 'abc', sub: { endpoint: 'https://fcm.googleapis.com/x' }, jwk: { d: 'd' },
    journey: { id: 'j', train: '23349', startSig: 'Lkp', endSig: 'Hrc' }, known: [['Lkp', null, 1]],
    notified: [['c|3047', 2]], names: { Lkp: 'Lidköping', Jp: 'Järpås' }, history, double: ['Vr|Vdm']
  });
  assert.ok(Object.keys(p).length <= 10, 'GitHub tar högst 10 fält i client_payload');
  assert.deepEqual(p.history, [['lidköping>järpås', 600123, 5]]);
  assert.equal(p.v, 1);
  assert.deepEqual(p.push, { sub: { endpoint: 'https://fcm.googleapis.com/x' }, jwk: { d: 'd' } });
  // För stor: gångtiderna och sträckorna tas bort först
  const big = P.buildPayload({ device: 'a', sub: {}, jwk: {}, double: Array.from({ length: 300 }, (_, i) => 'x'.repeat(300) + i) });
  assert.ok(JSON.stringify(big).length <= P.MAX_PAYLOAD);
  assert.deepEqual(big.double, []);
});

test('notiser: begäran till GitHub (repository_dispatch) och nya försök', async () => {
  const req = P.dispatchRequest({ repo: 'AKjork/railtimer-data', token: 'tok' }, 'bevaka', { v: 1 });
  assert.equal(req.url, 'https://api.github.com/repos/AKjork/railtimer-data/dispatches');
  assert.equal(req.init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(req.init.body), { event_type: 'bevaka', client_payload: { v: 1 } });
  const seq = [new TypeError('nät'), { status: 502 }, { status: 204 }];
  let calls = 0;
  const r = await P.sendWithRetry(async () => { const x = seq[calls++]; if (x instanceof Error) throw x; return x; }, req, { sleep: async () => {} });
  assert.deepEqual([r.ok, r.attempts], [true, 3]);
  calls = 0;
  const bad = await P.sendWithRetry(async () => { calls++; return { status: 404 }; }, req, { sleep: async () => {} });
  assert.deepEqual([bad.ok, calls, bad.error], [false, 1, 'token saknar rätt till repot'], 'inga nya försök vid fel token');
});

test('notiser: bevakningen startar när appen lämnas och stoppas efter 3 min synlig, eller när resan är slut', () => {
  const ctx = (now, extra) => Object.assign({ now, enabled: true, running: true, train: '23349', journeyId: 'j1' }, extra);
  let r = P.plan(null, 'visible', ctx(0));
  assert.equal(r.action, null, 'appen syns: appen meddelar själv');
  r = P.plan(r.watch, 'hidden', ctx(1000));
  assert.deepEqual([r.action, r.announce], ['start', true], 'första gången med bekräftelse');
  r = P.plan(r.watch, 'hidden', ctx(2000));
  assert.equal(r.action, null, 'redan igång');
  r = P.plan(r.watch, 'visible', ctx(10000));
  r = P.plan(r.watch, 'tick', ctx(10000 + 2 * 60000));
  assert.equal(r.action, null, 'kort titt: bevakningen fortsätter');
  r = P.plan(r.watch, 'hidden', ctx(10000 + 2 * 60000 + 1));
  assert.equal(r.action, null, 'lämnad igen inom 3 min: samma bevakning');
  r = P.plan(r.watch, 'visible', ctx(200000));
  r = P.plan(r.watch, 'tick', ctx(200000 + P.STOP_AFTER_VISIBLE_MS));
  assert.equal(r.action, 'stop', 'synlig i 3 min: appen tar över');
  r = P.plan(r.watch, 'hidden', ctx(500000));
  assert.deepEqual([r.action, r.announce], ['start', false], 'ny bevakning utan ny bekräftelse');
  r = P.plan(r.watch, 'end', ctx(600000, { running: false }));
  assert.equal(r.action, 'stop', 'resan slut');
  assert.equal(P.plan(r.watch, 'end', ctx(0)).action, null, 'inget att stoppa');
  // Utan tågnummer, avstängt eller ingen resa: ingen bevakning
  assert.equal(P.plan(null, 'hidden', ctx(0, { train: '' })).action, null);
  assert.equal(P.plan(null, 'hidden', ctx(0, { enabled: false })).action, null);
  assert.equal(P.plan(null, 'hidden', ctx(0, { running: false })).action, null);
  // Ny resa: allt börjar om
  const prev = P.plan(null, 'hidden', ctx(0)).watch;
  const next = P.plan(prev, 'hidden', ctx(1, { journeyId: 'j2' }));
  assert.deepEqual([next.action, next.announce], ['start', true]);
});

test('notiser: det bevakningen meddelat räknas som meddelat i appen', () => {
  const n = new Map([['c|3047', 1], ['m|1|Vr', 2]]);
  P.mergeNotified(n, [['c|3047', 2], ['m|1|Vr', 1], ['d|Hr|Spårändrat', 1], ['bad'], null]);
  assert.deepEqual(Array.from(n), [['c|3047', 2], ['m|1|Vr', 2], ['d|Hr|Spårändrat', 1]]);
});
