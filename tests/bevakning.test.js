'use strict';
// GitHubs datorer går i UTC: klockslagen i notiserna ska ändå vara svensk tid
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const WP = require('../bevakning/webpush.js');
const B = require('../bevakning/bevaka.js');
const I = require('../railtimer-info.js');

/* Samma linje som i railtimer-info.test.js: Lidköping (Lkp) – Järpås (Jp) – Vara (Vr) – Vedum (Vdm) – Herrljunga (Hr).
   Vårt tåg 23349 möter 24360 i Vara. Anslutning i Herrljunga: 3047 mot Borås 11:45. */
const T = hhmm => `2026-11-25T${hhmm}:00.000+01:00`;
const at = hhmm => Date.parse(T(hhmm));
function ann(otn, sig, kind, hhmm, extra) {
  return Object.assign({
    OperationalTrainNumber: otn, AdvertisedTrainIdent: otn, DepartureDateOTN: '2026-11-25T00:00:00.000+01:00',
    LocationSignature: sig, ActivityType: kind === 'a' ? 'Ankomst' : 'Avgang', Advertised: true,
    AdvertisedTimeAtLocation: T(hhmm), LocationDateTimeOTN: T(hhmm)
  }, extra || {});
}
function train(otn, stops) {
  const out = [];
  for (const [sig, a, d, ex] of stops) {
    if (a) out.push(ann(otn, sig, 'a', a, ex && ex.a));
    if (d) out.push(ann(otn, sig, 'd', d, ex && ex.d));
  }
  return out;
}
const OUR = ex => train('23349', [
  ['Lkp', null, '11:00'], ['Jp', '11:10', '11:11'], ['Vr', '11:20', '11:21'], ['Vdm', '11:30', '11:31'], ['Hr', '11:40', null, ex && ex.Hr]
]);
const MEET = ex => train('24360', [
  ['Hr', null, '11:05'], ['Vdm', '11:13', '11:14', ex && ex.Vdm], ['Vr', '11:20', '11:21', ex && ex.Vr], ['Jp', '11:30', '11:31'], ['Lkp', '11:40', null]
]);
const CONN = () => [ann('3047', 'Hr', 'd', '11:45', {
  ToLocation: [{ LocationName: 'Bs', Priority: 1, Order: 0 }], ProductInformation: [{ Code: 'PNA054', Description: 'Västtågen' }], TrackAtLocation: '3'
})];
const NAMES = { Lkp: 'Lidköping', Jp: 'Järpås', Vr: 'Vara', Vdm: 'Vedum', Hr: 'Herrljunga C' };

// Simulerat Trafikverket: svaret väljs efter frågan
function fakeTrv(world) {
  const calls = [];
  const fetch = async (url, init) => {
    const xml = String(init.body);
    calls.push(xml);
    if (world.offline) throw new TypeError('fetch failed');
    const reply = (type, list) => ({ ok: true, status: 200, json: async () => ({ RESPONSE: { RESULT: [{ [type]: list }] } }) });
    if (/objecttype="TrainAnnouncement"/.test(xml)) {
      if (world.rejectOtn && /LocationDateTimeOTN/.test(xml)) return { ok: false, status: 400, json: async () => ({ RESPONSE: { RESULT: [{ ERROR: { MESSAGE: 'Okänt fält' } }] } }) };
      if (/name="OperationalTrainNumber"/.test(xml)) return reply('TrainAnnouncement', world.notFound ? [] : world.our());
      return reply('TrainAnnouncement', world.our().concat(world.others()));
    }
    if (/objecttype="TrainStation"/.test(xml)) return reply('TrainStation', [{ LocationSignature: 'Bs', AdvertisedLocationName: 'Borås C' }]);
    if (/objecttype="TrainPosition"/.test(xml)) return reply('TrainPosition', []);
    if (/objecttype="OperativeEvent"/.test(xml)) return reply('OperativeEvent', []);
    return { ok: false, status: 500, json: async () => null };
  };
  return { fetch, calls };
}
function payload(extra) {
  return Object.assign({
    v: 1, device: 'abc123',
    journey: { id: 'j1', train: '23349', startSig: 'Lkp', endSig: 'Hr', startedAt: at('11:00'), announce: true, app: 'test' },
    push: { sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'x', auth: 'y' } }, jwk: { d: 'd', x: 'x', y: 'y' } },
    known: [['Lkp', null, at('11:00')]], notified: [], names: NAMES, history: [], double: []
  }, extra);
}
function watch(world, p, opts) {
  const o = opts || {};
  const sent = [];
  const clockNow = { t: o.now != null ? o.now : at('11:05') };
  const trv = fakeTrv(world);
  const req = B.readPayload(p || payload());
  assert.ok(req.ok, req.error);
  const w = B.createWatch(req, {
    fetch: trv.fetch, trvKey: 'nyckel', now: () => clockNow.t, sleep: async ms => { clockNow.t += ms; },
    send: async msg => { sent.push(msg); return o.gone ? { ok: false, status: 410, gone: true } : { ok: true, status: 201 }; }
  });
  return { w, sent, clockNow, calls: trv.calls };
}

test('bevakning: första varvet bekräftar tyst, i svensk tid, och sedan ingen notis när inget ändras', async () => {
  const world = { our: () => OUR(), others: () => MEET().concat(CONN()) };
  const { w, sent, clockNow } = watch(world);
  assert.equal(await w.step(), null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'start');
  assert.equal(sent[0].silent, true);
  assert.equal(sent[0].title, 'Tåg 23349 → Herrljunga C');
  assert.match(sent[0].body, /Herrljunga C 11:40 i tid/, 'klockslaget i svensk tid fast datorn går i UTC');
  clockNow.t += 60000;
  assert.equal(await w.step(), null);
  assert.equal(sent.length, 1, 'inget nytt att meddela');
});

test('bevakning: sent mötande tåg ger en notis med mötet och den missade anslutningen, en gång', async () => {
  let late = false;
  const world = { our: () => OUR(), others: () => MEET(late ? { Vr: { a: { EstimatedTimeAtLocation: T('11:26') } } } : null).concat(CONN()) };
  const { w, sent, clockNow } = watch(world);
  await w.step();
  late = true;
  clockNow.t += 60000;
  await w.step();
  assert.equal(sent.length, 2);
  const a = sent[1];
  assert.equal(a.kind, 'alert');
  assert.equal(a.level, 2);
  const lines = a.body.split('\n');
  assert.equal(lines.length, 3, a.body);
  assert.match(lines[0], /^Möte Vara: 24360 är 6 min sent – vi väntar ca 6 min$|^Anslutning 11:45 Borås C: missas$/);
  assert.ok(lines.includes('Anslutning 11:45 Borås C: missas'), 'destinationens namn hämtat från Trafikverket');
  assert.ok(lines.includes('Möte Vara: 24360 är 6 min sent – vi väntar ca 6 min'));
  assert.equal(lines[2], 'Herrljunga C 11:46 +6 min');
  assert.ok(a.keys.some(([k, l]) => k === 'c|3047' && l === 2), 'nycklarna följer med så att appen inte meddelar igen');
  assert.match(a.say, /Anslutningen mot Borås C 11:45 hinns inte\.|Möte i Vara/);
  clockNow.t += 60000;
  await w.step();
  assert.equal(sent.length, 2, 'samma sak meddelas inte igen');
});

test('bevakning: det appen redan meddelat meddelas inte igen, och utan bekräftelse när appen redan bekräftat', async () => {
  const world = { our: () => OUR(), others: () => MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:26') } } }).concat(CONN()) };
  const p = payload({ notified: [['m|24360|Vr', 2], ['c|3047', 2]] });
  p.journey.announce = false;
  const { w, sent } = watch(world, p);
  await w.step();
  assert.equal(sent.length, 0);
});

test('bevakning: en notis om något värre räcker som bekräftelse', async () => {
  const world = { our: () => OUR(), others: () => MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:26') } } }).concat(CONN()) };
  const { w, sent } = watch(world);
  await w.step();
  assert.deepEqual(sent.map(m => m.kind), ['alert']);
});

test('bevakning: appens egna tider används före Trafikverkets', async () => {
  // Appen hann registrera avgång från Järpås 11:16 (5 min sent) innan den lämnades; Trafikverket har inget
  const world = { our: () => OUR(), others: () => CONN() };
  const p = payload({ known: [['Lkp', null, at('11:00')], ['Jp', at('11:10'), at('11:16')]] });
  const { w, sent } = watch(world, p, { now: at('11:17') });
  await w.step();
  assert.match(sent[0].body, /Herrljunga C 11:4[4-5] \+[45] min/);
});

test('bevakning: slutar när Trafikverket rapporterar ankomsten till slutstationen', async () => {
  const world = { our: () => OUR({ Hr: { a: { TimeAtLocationWithSeconds: T('11:41') } } }), others: () => CONN() };
  const { w } = watch(world, null, { now: at('11:42') });
  assert.equal(await w.step(), 'framme');
});

test('bevakning: tåget hittas inte – notis efter tre försök och sedan slut', async () => {
  const world = { notFound: true, our: () => OUR(), others: () => [] };
  const { w, sent } = watch(world);
  const reason = await w.run();
  assert.equal(reason, 'tåget hittades inte');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'error');
  assert.match(sent[0].body, /tåg 23349 hittades inte/);
});

test('bevakning: godtar Trafikverket inte tågorderns tid frågas igen utan den, som i appen', async () => {
  const world = { rejectOtn: true, our: () => OUR(), others: () => MEET() };
  const { w, sent, calls } = watch(world);
  await w.step();
  assert.equal(sent[0].kind, 'start');
  assert.ok(calls.some(x => /TrainAnnouncement/.test(x) && !/LocationDateTimeOTN/.test(x)));
});

test('bevakning: ingen kontakt med Trafikverket – en notis efter fem minuter, och bevakningen fortsätter', async () => {
  const world = { our: () => OUR(), others: () => MEET() };
  const { w, sent, clockNow } = watch(world);
  await w.step();
  world.offline = true;
  for (let k = 0; k < 7; k++) { clockNow.t += 60000; assert.equal(await w.step(), null); }
  const errs = sent.filter(m => m.kind === 'error');
  assert.equal(errs.length, 1);
  assert.match(errs[0].body, /Ingen kontakt med Trafikverket sedan 11:06/);
});

test('bevakning: prenumerationen finns inte längre (410) – bevakningen slutar', async () => {
  const world = { our: () => OUR(), others: () => MEET() };
  const { w } = watch(world, null, { gone: true });
  assert.match(await w.run(), /prenumeration finns inte/);
});

test('bevakning: längsta tiden och långt efter planerad ankomst', async () => {
  const world = { our: () => OUR(), others: () => [] };
  const { w } = watch(world, null, { now: at('14:41') });
  assert.equal(await w.step(), 'långt efter planerad ankomst');
});

test('bevakning: begäran utan prenumeration eller med okänd version godtas inte', () => {
  assert.equal(B.readPayload(null).ok, false);
  assert.equal(B.readPayload({ v: 2 }).ok, false);
  assert.equal(B.readPayload(payload({ push: { sub: { endpoint: 'http://x' }, jwk: {} } })).ok, false);
  const r = B.readPayload(payload({ known: [['Jp', 1, null], ['bad']], history: [['lidköping>järpås', 600000, 4]] }));
  assert.deepEqual(r.known.get('Jp'), { arr: 1, dep: null });
  assert.equal(r.known.has('bad'), true);
  assert.deepEqual(r.history.get('lidköping>järpås'), { median: 600000, n: 4 });
});

test('webbpush: krypteringen (RFC 8291/8188) går att dekryptera med telefonens nycklar', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: WP.b64url(ua.getPublicKey()), auth: WP.b64url(auth) } };
  const text = JSON.stringify({ title: 'Tåg 23349 → Herrljunga C', body: 'Anslutning 11:45 Borås C: missas' });
  const body = WP.encrypt(sub, text);
  assert.equal(body.readUInt32BE(16), 4096, 'postens storlek');
  assert.equal(body[20], 65, 'avsändarens nyckel');
  assert.equal(WP.decrypt(body, ua, auth).toString('utf8'), text);
  // Samma salt och avsändarnyckel ger samma resultat; nytt salt ger nytt
  const sender = crypto.createECDH('prime256v1'); sender.generateKeys();
  const salt = crypto.randomBytes(16);
  assert.deepEqual(WP.encrypt(sub, text, { salt, senderKeys: sender }), WP.encrypt(sub, text, { salt, senderKeys: sender }));
  assert.throws(() => WP.encrypt(sub, 'x'.repeat(WP.MAX_PLAINTEXT + 1)), /för långt/);
  assert.throws(() => WP.encrypt({ endpoint: 'https://x', keys: {} }, 'x'), /nycklar/);
});

test('webbpush: VAPID-huvudet är signerat med telefonens nyckel för push-tjänstens ursprung', () => {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = kp.privateKey.export({ format: 'jwk' });
  const v = WP.vapidHeaders('https://fcm.googleapis.com/fcm/send/abc', jwk, { now: Date.parse('2026-11-25T12:00:00Z') });
  const [h, c, s] = v.jwt.split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: kp.publicKey, dsaEncoding: 'ieee-p1363' }, WP.fromB64url(s)));
  const claims = JSON.parse(WP.fromB64url(c));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.exp, Date.parse('2026-11-25T12:00:00Z') / 1000 + 12 * 3600);
  assert.match(claims.sub, /^https:\/\//, 'Apple kräver mailto: eller https:');
  assert.equal(WP.fromB64url(v.publicKey).length, 65);
  assert.match(v.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
});

test('webbpush: skickar med rätt huvuden, och 410 betyder att prenumerationen är borta', async () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: WP.b64url(ua.getPublicKey()), auth: WP.b64url(crypto.randomBytes(16)) } };
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  let seen;
  const ok = await WP.send(sub, jwk, { title: 'x' }, { fetch: async (url, init) => { seen = { url, init }; return { status: 201, text: async () => '' }; } });
  assert.equal(ok.ok, true);
  assert.equal(seen.url, sub.endpoint);
  assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen.init.headers.TTL, '900');
  assert.equal(seen.init.headers.Urgency, 'high');
  const gone = await WP.send(sub, jwk, { title: 'x' }, { fetch: async () => ({ status: 410, text: async () => 'expired' }) });
  assert.deepEqual([gone.ok, gone.gone], [false, true]);
  const net = await WP.send(sub, jwk, { title: 'x' }, { fetch: async () => { throw new Error('nät'); } });
  assert.deepEqual([net.ok, net.status], [false, 0]);
});

test('meddelanden: samma texter som appen, en gång per nivå', () => {
  const m = {
    meetings: [{ level: 2, otn: '24360', ident: '24360', sig: 'Vr', theirDelayMin: 6, waitMin: 6 }],
    connections: [{ level: 1, otn: '3049', status: 'knappt', transferMin: 3, adv: at('11:49'), to: ['G'] }],
    incoming: [], stops: [], deviations: [{ sig: 'Hr', text: 'Spårändrat' }], messages: []
  };
  const list = I.alerts(m, { name: s => ({ Vr: 'Vara', G: 'Göteborg C', Hr: 'Herrljunga C' })[s] || s, clock: B.clock });
  assert.deepEqual(list.map(a => a.text), [
    'Möte Vara: 24360 är 6 min sent – vi väntar ca 6 min',
    'Anslutning 11:49 Göteborg C: knappt (3 min)',
    'Herrljunga C: Spårändrat'
  ]);
  assert.equal(list[1].say, 'Anslutningen mot Göteborg C 11:49 blir knapp.');
  const notified = new Map([['d|Hr|Spårändrat', 1]]);
  assert.deepEqual(I.newAlerts(list, notified).map(a => a.key), ['m|24360|Vr', 'c|3049']);
  assert.deepEqual(I.newAlerts(list, notified), [], 'redan meddelat');
  m.connections[0].level = 2;
  m.connections[0].status = 'missas';
  assert.deepEqual(I.newAlerts(I.alerts(m, { clock: B.clock }), notified).map(a => a.text), ['Anslutning 11:49 G: missas'], 'värre: meddelas igen');
});
