'use strict';
process.env.TZ = 'Europe/Stockholm';
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../railtimer-info.js');

/* Linjen Lidköping (Lkp) – Järpås (Jp) – Vara (Vr) – Vedum (Vdm) – Herrljunga (Hr), enkelspår.
   Vårt tåg 23349 mot Herrljunga möter 24360 i Vara enligt tidtabell. */
const T = hhmm => `2026-11-25T${hhmm}:00.000+01:00`;
const at = hhmm => Date.parse(T(hhmm));
function ann(otn, sig, kind, hhmm, extra) {
  return Object.assign({
    OperationalTrainNumber: otn, AdvertisedTrainIdent: otn, DepartureDateOTN: '2026-11-25T00:00:00.000+01:00',
    LocationSignature: sig, ActivityType: kind === 'a' ? 'Ankomst' : 'Avgang', Advertised: true,
    AdvertisedTimeAtLocation: T(hhmm), LocationDateTimeOTN: T(hhmm)
  }, extra || {});
}
// [sig, ankomst, avgång] → meddelanden
function train(otn, stops, extra) {
  const out = [];
  for (const [sig, a, d, ex] of stops) {
    if (a) out.push(ann(otn, sig, 'a', a, Object.assign({}, extra, ex && ex.a)));
    if (d) out.push(ann(otn, sig, 'd', d, Object.assign({}, extra, ex && ex.d)));
  }
  return out;
}
const OUR = () => train('23349', [
  ['Lkp', null, '11:00'], ['Jp', '11:10', '11:11'], ['Vr', '11:20', '11:21'], ['Vdm', '11:30', '11:31'], ['Hr', '11:40', null]
]);
const MEET = (ex) => train('24360', [
  ['Hr', null, '11:05'], ['Vdm', '11:13', '11:14', ex && ex.Vdm], ['Vr', '11:20', '11:21', ex && ex.Vr], ['Jp', '11:30', '11:31'], ['Lkp', '11:40', null]
]);
const ROUTE = new Map([['Lkp', 'Lidköping'], ['Jp', 'Järpås'], ['Vr', 'Vara'], ['Vdm', 'Vedum'], ['Hr', 'Herrljunga C']]);

function setup(rows, opts) {
  const o = opts || {};
  const trains = I.groupTrains(OUR().concat(rows || []));
  const our = I.nearestRun(trains, '23349', at('11:00'));
  const line = I.buildLine(our, 'Lkp', 'Hr');
  const known = new Map(Object.entries(o.known || {}));
  return I.compute({
    line, trains, ourKey: our.key, known, now: o.now != null ? o.now : at('10:55'),
    transferMin: o.transferMin, knownDouble: o.knownDouble, history: o.history, routeNames: ROUTE,
    messages: o.messages
  });
}

test('linjen: vårt tågs platser i tidsordning, utan ankomst i start och avgång i slut', () => {
  const trains = I.groupTrains(OUR());
  const our = I.nearestRun(trains, '23349', at('11:00'));
  const line = I.buildLine(our, 'Lkp', 'Hr');
  assert.deepEqual(line.map(l => l.sig), ['Lkp', 'Jp', 'Vr', 'Vdm', 'Hr']);
  assert.equal(line[0].plannedArr, null);
  assert.equal(line[4].plannedDep, null);
  assert.equal(line[2].advDep, at('11:21'));
  assert.ok(line.every(l => l.stop));
  assert.deepEqual(I.buildLine(our, 'Jp', 'Vdm').map(l => l.sig), ['Jp', 'Vr', 'Vdm'], 'del av linjen');
});

test('körningen: samma tågnummer två dagar – den som går närmast väljs', () => {
  const tomorrow = OUR().map(a => Object.assign({}, a, {
    DepartureDateOTN: '2026-11-26T00:00:00.000+01:00',
    AdvertisedTimeAtLocation: a.AdvertisedTimeAtLocation.replace('11-25', '11-26'),
    LocationDateTimeOTN: a.LocationDateTimeOTN.replace('11-25', '11-26')
  }));
  const trains = I.groupTrains(OUR().concat(tomorrow));
  assert.equal(I.nearestRun(trains, '23349', at('11:05')).date, '2026-11-25');
  assert.equal(I.nearestRun(trains, '23349', at('11:05') + 20 * 3600000).date, '2026-11-26');
});

test('möte: motgående tåg som är i Vara samtidigt som vi är ett möte där', () => {
  const trains = I.groupTrains(OUR().concat(MEET()));
  const our = I.nearestRun(trains, '23349', at('11:00'));
  const line = I.buildLine(our, 'Lkp', 'Hr');
  const idx = new Map(line.map((l, i) => [l.sig, i]));
  const c = I.crossingOf(line, trains.get('24360|2026-11-25'), idx, I.DEFAULTS);
  assert.equal(c.kind, 'station');
  assert.equal(line[c.i].sig, 'Vr');
});

test('möte i tid: ingen väntan och ingen försening', () => {
  const m = setup(MEET());
  assert.equal(m.meetings.length, 1);
  const mt = m.meetings[0];
  assert.equal(mt.sig, 'Vr');
  assert.equal(mt.otn, '24360');
  assert.equal(mt.single, true, 'enkelspår');
  assert.equal(mt.waitMin, 0);
  assert.equal(m.end.delayMin, 0);
  assert.equal(m.level, 0);
});

test('möte med sent tåg: vi väntar i Vara och blir lika sena till Herrljunga', () => {
  // 24360 avgick från Vedum 11:20 i stället för 11:14 (6 min sen); kl 11:15 är vi i Järpås i tid
  const m = setup(MEET({ Vdm: { d: { TimeAtLocationWithSeconds: T('11:20') } } }), {
    now: at('11:12'), known: { Lkp: { dep: at('11:00') }, Jp: { arr: at('11:10'), dep: at('11:11') } }
  });
  const mt = m.meetings[0];
  assert.equal(mt.their.source, 'senast', 'räknat från senast kända försening');
  assert.equal(mt.theirDelayMin, 6);
  assert.equal(mt.waitMin, 6, 'väntar till en minut efter att 24360 kommit in (11:27)');
  assert.equal(mt.ourDep, at('11:27'));
  assert.equal(m.end.delayMin, 6);
  assert.equal(m.reason.sig, 'Vr');
  assert.equal(m.level, 2);
});

test('möte: Trafikverkets beräknade tid i mötesstationen går före framräknad försening', () => {
  const m = setup(MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:23') } } }));
  assert.equal(m.meetings[0].their.source, 'trafikverket');
  assert.equal(m.meetings[0].waitMin, 3);
  assert.equal(m.end.delayMin, 3);
});

test('dubbelspår: tåg som enligt tidtabell möts mellan Vara och Vedum gör sträckan till dubbelspår, och då väntar vi inte', () => {
  // 3346 kör Vedum 11:22 → Vara 11:29 medan vi kör Vara 11:21 → Vedum 11:30: de möts mellan stationerna
  const other = train('3346', [['Vdm', null, '11:22'], ['Vr', '11:29', '11:29'], ['Jp', '11:38', null]]);
  const late = MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:26') } } });
  const m = setup(late.concat(other));
  assert.deepEqual(m.doubleSections, ['Vdm|Vr']);
  assert.equal(m.meetings.find(x => x.otn === '24360').single, false);
  assert.equal(m.meetings.find(x => x.otn === '24360').waitMin, 0);
  assert.equal(m.end.delayMin, 0);
  // Sparad kunskap räcker, även utan tåget som möts på linjen
  const m2 = setup(late, { knownDouble: ['Vdm|Vr'] });
  assert.equal(m2.meetings[0].waitMin, 0);
  assert.deepEqual(m2.doubleSections, [], 'inget nytt att spara');
});

test('inställt mötande tåg: vi väntar inte', () => {
  const m = setup(MEET({ Vr: { a: { Canceled: true, EstimatedTimeAtLocation: T('11:40') } } }));
  assert.equal(m.meetings[0].canceled, true);
  assert.equal(m.meetings[0].waitMin, 0);
  assert.equal(m.end.delayMin, 0);
});

test('flyttat möte: det mötande tåget har redan passerat Vara mot oss', () => {
  const m = setup(MEET({ Vr: { d: { TimeAtLocationWithSeconds: T('11:08') } } }).concat(
    [ann('24360', 'Jp', 'a', '11:30', { TimeAtLocationWithSeconds: T('11:12') })]), { now: at('11:12') });
  assert.equal(m.meetings[0].moved, true);
  assert.equal(m.meetings[0].waitMin, 0);
});

test('passerat möte: när vi har åkt från Vara visas mötet inte längre', () => {
  const m = setup(MEET({ Vdm: { d: { TimeAtLocationWithSeconds: T('11:20') } } }), {
    now: at('11:28'),
    known: { Lkp: { dep: at('11:00') }, Jp: { arr: at('11:10'), dep: at('11:11') }, Vr: { arr: at('11:20'), dep: at('11:27') } }
  });
  assert.equal(m.meetings.length, 0);
  assert.equal(m.currentDelayMin, 6);
  // 11:27 + 9 min till Vedum, 30 s uppehåll, 9 min till Herrljunga = 11:45:30
  assert.equal(m.end.predArr, at('11:45') + 30000);
  assert.equal(m.end.delayMin, 6);
});

test('prognosen ligger aldrig före nu', () => {
  const m = setup([], { now: at('11:25'), known: { Lkp: { dep: at('11:00') }, Jp: { arr: at('11:10'), dep: at('11:11') } } });
  const vr = m.preds.find(p => p.sig === 'Vr');
  assert.equal(vr.arr, at('11:25'), 'ankomst Vara tidigast nu');
  // 11:25 + 30 s uppehåll + 9 min + 30 s + 9 min = 11:44
  assert.equal(m.end.delayMin, 4);
});

test('egna gångtider: så mycket vi brukar ta igen räknas in', () => {
  // Vedum → Herrljunga tar planerat 9 min, men brukar ta 7,5
  const logs = [0, 1, 2].map(k => ({ stops: [
    { name: 'Vedum', actualDeparture: '2026-11-20T10:31:00.000Z' },
    { name: 'Herrljunga C', actualArrival: new Date(Date.parse('2026-11-20T10:31:00.000Z') + (450 + k * 10) * 1000).toISOString() }
  ] }));
  const history = I.historyMedians(logs);
  assert.equal(history.get('vedum>herrljunga c').n, 3);
  const late = MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:26') } } });
  const without = setup(late);
  const withH = setup(late, { history });
  assert.equal(without.end.delayMin, 6);
  // 7 min 40 s i stället för 9 min: 80 s tidigare
  assert.equal(without.end.predArr - withH.end.predArr, 80000, 'tidigare ankomst med egna gångtider');
  assert.equal(withH.recoveryMin, 1);
  assert.equal(withH.recoveryObs, 3);
});

test('egna gångtider: färre än 3 mätningar används inte, och längre gångtider gör oss inte senare', () => {
  const two = I.historyMedians([1, 2].map(() => ({ stops: [
    { name: 'Vedum', actualDeparture: '2026-11-20T10:31:00.000Z' }, { name: 'Herrljunga C', actualArrival: '2026-11-20T10:36:00.000Z' }
  ] })));
  assert.equal(setup([], { history: two }).recoveryObs, 0);
  const slow = I.historyMedians([1, 2, 3].map(() => ({ stops: [
    { name: 'Vedum', actualDeparture: '2026-11-20T10:31:00.000Z' }, { name: 'Herrljunga C', actualArrival: '2026-11-20T10:45:00.000Z' }
  ] })));
  assert.equal(setup([], { history: slow }).end.delayMin, 0);
});

// Tåg från Herrljunga: [tågnummer, avgång, extra, till]
function departures(list) {
  return list.map(([otn, hhmm, extra, to]) => ann(otn, 'Hr', 'd', hhmm, Object.assign({
    ToLocation: [{ LocationName: to || 'G', Priority: 1, Order: 0 }], ProductInformation: [{ Code: 'PNA054', Description: 'Västtågen' }],
    TrackAtLocation: '3'
  }, extra)));
}

test('anslutningar: i tid, knappt, missas – och tåg tillbaka längs vår linje räknas inte', () => {
  const late = MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:26') } } }); // vi kommer 11:46 (+6)
  const deps = departures([
    ['3047', '11:45', null, 'Bs'],
    ['3049', '11:51'],
    ['417', '11:55', { EstimatedTimeAtLocation: T('12:03') }, 'Cst'],
    ['24362', '11:50', null, 'Lkp'],  // tillbaka mot Lidköping
    ['3051', '11:42'],                // går 2 min efter vår ankomst enligt tidtabell: ingen anslutning
    ['3099', '12:30']                 // mer än 40 min efter
  ]);
  const m = setup(late.concat(deps));
  const by = Object.fromEntries(m.connections.map(c => [c.otn, c]));
  assert.deepEqual(m.connections.map(c => c.otn), ['3047', '3049', '417']);
  assert.equal(by['3047'].status, 'missas');
  assert.equal(by['3049'].status, 'knappt', '5 min byte med bytestid 4');
  assert.equal(by['417'].status, 'ok', 'också sent: 17 min byte');
  assert.equal(by['417'].delayMin, 8);
  assert.equal(by['3047'].track, '3');
  assert.equal(by['3047'].product, 'Västtågen');
  assert.deepEqual(by['3047'].to, ['Bs']);
  assert.equal(m.missed, 1);
  assert.equal(m.tight, 1);
  // Med bytestid 6 blir 3049 missad och 3047 räknas inte längre som anslutning (5 min enligt tidtabell)
  const m6 = setup(late.concat(deps), { transferMin: 6 });
  assert.deepEqual(m6.connections.map(c => [c.otn, c.status]), [['3049', 'missas'], ['417', 'ok']]);
});

test('anslutningar: avgånget tåg innan vi kommit fram', () => {
  const deps = departures([['3047', '11:45', { TimeAtLocationWithSeconds: T('11:45') }]]);
  const m = setup(MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:26') } } }).concat(deps), { now: at('11:45') });
  assert.equal(m.connections[0].status, 'avgått');
});

test('tåg som ansluter till oss i startstationen: sent tåg från annat håll hinner inte', () => {
  const arrivals = [
    ann('3333', 'Lkp', 'a', '10:52', { EstimatedTimeAtLocation: T('10:58'), FromLocation: [{ LocationName: 'Gtp', Order: 0 }] }),
    ann('3335', 'Lkp', 'a', '10:40', { FromLocation: [{ LocationName: 'Gtp', Order: 0 }] })
  ];
  const m = setup(arrivals, { now: at('10:50') });
  assert.deepEqual(m.incoming.map(c => [c.otn, c.status]), [['3335', 'ok'], ['3333', 'missas']]);
  const after = setup(arrivals, { now: at('11:01'), known: { Lkp: { dep: at('11:00') } } });
  assert.equal(after.incoming, null, 'inte efter avgång');
});

test('avvikelser för vårt tåg längre fram visas', () => {
  const rows = OUR().map(a => a.LocationSignature === 'Hr' ? Object.assign({}, a, { Deviation: [{ Code: 'ANA088', Description: 'Spårändrat' }], TrackAtLocation: '5' }) : a);
  const trains = I.groupTrains(rows);
  const our = I.nearestRun(trains, '23349', at('11:00'));
  const m = I.compute({ line: I.buildLine(our, 'Lkp', 'Hr'), trains, ourKey: our.key, known: new Map(), now: at('10:55'), routeNames: ROUTE });
  assert.deepEqual(m.deviations.map(d => [d.sig, d.text]), [['Hr', 'Spårändrat']]);
  assert.equal(m.end.track, '5');
});

test('störningar (OperativeEvent): bara de som berör resten av vår linje och pågår', () => {
  // Formen som kontrollsidan läser: signaturer på valfri nivå, text i TrafficImpact.PublicMessage
  const messages = [
    { Id: 'a', EventType: { Description: 'Signalfel' }, StartDateTime: T('10:00'),
      TrafficImpact: [
        { PublicMessage: { Header: 'Gammal rubrik', Description: 'Gammal text', ModifiedDateTime: T('10:05') }, AffectedLocation: [{ Signature: 'Vdm' }] },
        { PublicMessage: { Header: 'Signalfel i Vedum', Description: 'Tågen kör  med nedsatt fart.', ModifiedDateTime: T('10:20') }, EndDateTime: T('13:00') }
      ] },
    { Id: 'b', EventType: { Description: 'Banarbete' }, StartDateTime: T('10:00'), TrafficImpact: [{ AffectedLocation: [{ Signature: 'Cst' }] }] },
    { Id: 'c', EventType: { Description: 'Växelfel' }, StartDateTime: T('09:00'), EndDateTime: T('10:00'), TrafficImpact: [{ Location: { LocationSignature: 'Vr' } }] },
    { Id: 'd', EventType: { Description: 'Banarbete' }, StartDateTime: T('10:30'), Location: { Signature: 'Jp' } }
  ];
  const m = setup([], { messages });
  assert.deepEqual(m.messages.map(x => x.id), ['a', 'd']);
  assert.equal(m.messages[0].header, 'Signalfel i Vedum', 'senast ändrade publika meddelandet');
  assert.equal(m.messages[0].text, 'Tågen kör med nedsatt fart.');
  assert.deepEqual(m.messages[0].sigs, ['Vdm']);
  assert.equal(m.messages[0].end, at('13:00'));
  assert.equal(m.messages[1].header, 'Banarbete', 'utan publikt meddelande: händelsetypen');
  assert.deepEqual(I.signaturesIn({ a: [{ Signature: 'X' }, { b: { LocationSignature: 'Y' } }] }), ['X', 'Y']);
  assert.ok(I.queryMessages().includes('namespace="ols.open" objecttype="OperativeEvent" schemaversion="1.0"'));
  assert.ok(I.queryMessages().includes('<EQ name="EventState" value="1" />'));
});

test('frågorna: lokal tid, alla platser och flera frågor i samma anrop', () => {
  const q = I.queryLine(['Vr', 'Vdm'], at('11:00'), at('12:00'));
  assert.ok(q.includes('<EQ name="LocationSignature" value="Vr" />') && q.includes('<EQ name="LocationSignature" value="Vdm" />'));
  assert.ok(q.includes('value="2026-11-25T11:00:00"') && q.includes('value="2026-11-25T12:00:00"'));
  assert.ok(q.includes('<INCLUDE>LocationDateTimeOTN</INCLUDE>') && q.includes('<INCLUDE>EstimatedTimeAtLocation</INCLUDE>'));
  const r = I.request('KEY', [I.queryOurTrain('23349', at('11:00')), q]);
  assert.equal((r.match(/<QUERY /g) || []).length, 2);
  assert.ok(r.startsWith('<REQUEST><LOGIN authenticationkey="KEY" />'));
  assert.deepEqual(I.resultOf({ RESPONSE: { RESULT: [{ ERROR: { MESSAGE: 'x' } }] } }, 0, 'TrainAnnouncement'), { error: 'x' });
  // Utan de oprovade fälten (skyddet om Trafikverket inte godtar dem)
  const safe = I.queryLine(['Vr'], at('11:00'), at('12:00'), I.SAFE_ANNOUNCEMENT_FIELDS);
  assert.ok(!safe.includes('LocationDateTimeOTN') && !safe.includes('PlannedEstimatedTimeAtLocation'));
  assert.ok(safe.includes('<INCLUDE>EstimatedTimeAtLocation</INCLUDE>') && safe.includes('<INCLUDE>TimeAtLocation</INCLUDE>'));
});

test('utan tågorderns tid används den annonserade', () => {
  const rows = OUR().map(a => { const c = Object.assign({}, a); delete c.LocationDateTimeOTN; return c; });
  const r = I.parseAnnouncement(rows[1]);
  assert.equal(r.plan, r.adv);
});

test('det mötande tågets ankomst ligger aldrig före nu om det inte kommit', () => {
  const trains = I.groupTrains(MEET());
  const tr = trains.get('24360|2026-11-25');
  assert.equal(I.theirArrival(tr, 'Vr', at('11:24')).t, at('11:24'));
  assert.equal(I.theirArrival(tr, 'Vr', at('11:00')).t, at('11:20'));
});
