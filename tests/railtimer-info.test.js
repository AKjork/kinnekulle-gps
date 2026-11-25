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
    knownDouble: o.knownDouble, knownMeetPlaces: o.knownMeet, history: o.history, routeNames: ROUTE, opts: o.opts,
    messages: o.messages, positions: o.positions, coords: o.coords, ourPos: o.ourPos,
    buses: o.buses, names: o.names, connMode: o.connMode, connAlerts: o.connAlerts, marked: o.marked
  });
}
// Ungefärliga lägen längs linjen (norr → söder)
const COORDS = new Map([['Lkp', { lat: 58.505, lon: 13.164 }], ['Jp', { lat: 58.385, lon: 12.968 }], ['Vr', { lat: 58.262, lon: 12.955 }],
  ['Vdm', { lat: 58.172, lon: 12.99 }], ['Hr', { lat: 58.08, lon: 13.03 }]]);

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

/* Flyttade möten. Vi åkte från Lidköping 11:14 i stället för 11:00 (14 min sena) och är i Järpås 11:24.
   24360 är i tid: i Vara 11:20–11:21 och i Järpås 11:30. Järpås är en mötesplats (känd sedan förut). */
const LATE14 = { Lkp: { dep: at('11:14') } };
test('flyttat möte: det mötande tåget har åkt från Vara mot oss – vi väntar i Järpås i stället för ingen väntan', () => {
  const m = setup(MEET({ Vr: { d: { TimeAtLocationWithSeconds: T('11:21') } } }), { now: at('11:22'), known: LATE14, knownMeet: ['Jp'] });
  const mt = m.meetings[0];
  assert.equal(mt.moved, true, 'rapporterat förbi mötesplatsen');
  assert.equal(mt.sig, 'Vr', 'tidtabellens mötesplats');
  assert.equal(mt.at, 'Jp', 'mötet blir i Järpås');
  assert.equal(mt.move, 'rapporterat');
  // Järpås 11:24, 30 s uppehåll, 24360 in 11:30 + 1 min = 11:31
  assert.equal(mt.ourDep, at('11:31'));
  assert.equal(mt.waitMs, 6.5 * 60000);
  assert.equal(mt.level, 2);
  // 11:31 → Vara 11:40 → 11:40:30 → Vedum 11:49:30 → 11:50 → Herrljunga 11:59
  assert.equal(m.end.predArr, at('11:59'));
  assert.equal(m.end.delayMin, 19);
  assert.equal(m.reason.sig, 'Jp');
  assert.equal(m.reason.late, false, '24360 är i tid – vi är sena');
});

test('flyttat möte: förutsett när vi är sena – det mötande tåget hinner först till sträckan Vara–Järpås', () => {
  // 11:14: vi har just åkt från Lidköping, 24360 är inte rapporterat än
  const m = setup(MEET(), { now: at('11:14'), known: LATE14, knownMeet: ['Jp'] });
  const mt = m.meetings[0];
  assert.equal(mt.moved, false);
  assert.equal(mt.at, 'Jp');
  assert.equal(mt.move, 'beräknat');
  // Vänta i Järpås 6,5 min är mindre än att 24360 väntar i Vara från 11:21 till vi är där 11:33:30 + 1 min
  assert.equal(mt.ourDep, at('11:31'));
  assert.equal(m.end.delayMin, 19);
  // Utan flytten hade vi räknat med att 24360 väntade i Vara: 13 min sena
  const old = setup(MEET(), { now: at('11:14'), known: LATE14, knownMeet: ['Jp'], opts: { predictMoves: false } });
  assert.equal(old.meetings[0].at, 'Vr');
  assert.equal(old.meetings[0].waitMin, 0);
  assert.equal(old.end.delayMin, 13);
  // Meddelandet och utropet säger att mötet troligen flyttas, inte att det mötande tåget är sent
  const a = I.alerts(m, { name: s => ROUTE.get(s) || s }).find(x => x.key === 'm|24360|Vr');
  assert.equal(a.text, 'Möte Järpås i stället för Vara (troligen): vi väntar ca 7 min på 24360');
  assert.equal(a.say, 'Mötet flyttas troligen till Järpås. Vi väntar där cirka 7 minuter.');
  const ut = I.announcement(m, { name: s => ROUTE.get(s) || s, clock: t => new Date(t).toTimeString().slice(0, 5) });
  assert.match(ut.sv, /^Vi är cirka 19 minuter försenade på grund av väntan på mötande tåg\./);
  assert.match(ut.en, /due to waiting for an oncoming train/);
});

test('flyttat möte: lite sena – 24360 väntar hellre i Vara, och vi väntar inte', () => {
  // Åkte 11:05: i Järpås 11:15:30. Att vänta där till 11:31 kostar mer än att 24360 väntar i Vara till 11:25:30
  const m = setup(MEET(), { now: at('11:05'), known: { Lkp: { dep: at('11:05') } }, knownMeet: ['Jp'] });
  assert.equal(m.meetings[0].at, 'Vr');
  assert.equal(m.meetings[0].move, null);
  assert.equal(m.meetings[0].waitMin, 0);
  assert.equal(m.end.predArr, at('11:43') + 30000);
});

test('flyttat möte: aldrig längre bort – är det mötande tåget sent väntar vi i Vara som förut', () => {
  const m = setup(MEET({ Vdm: { d: { TimeAtLocationWithSeconds: T('11:20') } } }), {
    now: at('11:12'), known: { Lkp: { dep: at('11:00') }, Jp: { arr: at('11:10'), dep: at('11:11') } }, knownMeet: ['Jp']
  });
  assert.equal(m.meetings[0].at, 'Vr');
  assert.equal(m.meetings[0].waitMin, 6);
  assert.equal(m.reason.late, true);
});

test('flyttat möte: bara på en mötesplats – Järpås utan möten i tidtabellen flyttar inget', () => {
  const m = setup(MEET(), { now: at('11:14'), known: LATE14 });
  assert.equal(m.meetings[0].at, 'Vr');
  assert.equal(m.meetings[0].waitMin, 0);
  assert.equal(m.end.delayMin, 13);
  assert.deepEqual(m.meetPlaces, ['Vr'], 'mötesplatsen ur tidtabellen sparas');
});

test('flyttat möte: mötesplatser ur tidtabellen – två tåg i Järpås samtidigt', () => {
  // 3346 och 3347 står i Järpås samtidigt, alltså har Järpås två spår
  const a = train('3346', [['Vr', null, '10:20'], ['Jp', '10:29', '10:32'], ['Lkp', '10:41', null]]);
  const b = train('3347', [['Lkp', null, '10:21'], ['Jp', '10:30', '10:31'], ['Vr', '10:40', null]]);
  const m = setup(MEET().concat(a, b), { now: at('11:14'), known: LATE14 });
  assert.deepEqual(m.meetPlaces.sort(), ['Jp', 'Vr']);
  const mt = m.meetings.find(x => x.otn === '24360');
  assert.equal(mt.at, 'Jp');
  assert.equal(mt.move, 'beräknat');
  const known = setup(MEET().concat(a, b), { now: at('11:14'), known: LATE14, knownMeet: ['Jp', 'Vr'] });
  assert.deepEqual(known.meetPlaces, [], 'inget nytt att spara');
});

test('flyttat möte: dubbelspår mellan Järpås och Vara – vi möts på sträckan och väntar inte', () => {
  const m = setup(MEET(), { now: at('11:14'), known: LATE14, knownMeet: ['Jp'], knownDouble: ['Jp|Vr'] });
  assert.equal(m.meetings[0].waitMin, 0);
  assert.equal(m.meetings[0].onLine, true);
  assert.equal(m.end.delayMin, 13);
});

test('flyttat möte: rapporterat förbi Vara medan vi står kvar i Lidköping – vi väntar där', () => {
  // Vi har inte åkt (12 min sena), 24360 åkte från Vara 11:21 och Järpås är ingen mötesplats
  const m = setup(MEET({ Vr: { d: { TimeAtLocationWithSeconds: T('11:21') } } }), { now: at('11:22') });
  const mt = m.meetings[0];
  assert.equal(mt.at, 'Lkp');
  assert.equal(mt.move, 'rapporterat');
  assert.equal(mt.ourDep, at('11:41'), '24360 i Lidköping 11:40 + 1 min');
  assert.equal(m.preds[0].dep, at('11:41'));
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
    ['3049', '11:49'],
    ['417', '11:55', { EstimatedTimeAtLocation: T('12:03') }, 'Cst'],
    ['24362', '11:50', null, 'Lkp'],  // tillbaka mot Lidköping
    ['3051', '11:42'],                // går 2 min efter vår ankomst enligt tidtabell: ingen anslutning
    ['3099', '12:30']                 // mer än 40 min efter
  ]);
  const m = setup(late.concat(deps));
  const by = Object.fromEntries(m.connections.map(c => [c.otn, c]));
  assert.deepEqual(m.connections.map(c => c.otn), ['3047', '3049', '417']);
  assert.equal(by['3047'].status, 'missas');
  assert.equal(by['3049'].status, 'knappt', '3 min att byta');
  assert.equal(by['3049'].transferMin, 3);
  assert.equal(by['417'].status, 'ok', 'också sent: 17 min byte');
  assert.equal(by['417'].delayMin, 8);
  assert.equal(by['3047'].track, '3');
  assert.equal(by['3047'].product, 'Västtågen');
  assert.deepEqual(by['3047'].to, ['Bs']);
  assert.equal(m.missed, 1);
  assert.equal(m.tight, 1);
  // Ingen egen bytestid: hinns inte bara när tåget går före eller i samma minut som vi kommer,
  // knappt under 4 min, och 4 min att byta räcker
  const edge = setup(late.concat(departures([['3045', '11:46'], ['3046', '11:47'], ['3048', '11:50']])));
  assert.deepEqual(edge.connections.map(c => [c.otn, c.transferMin, c.status]), [['3045', 0, 'missas'], ['3046', 1, 'knappt'], ['3048', 4, 'ok']]);
  assert.equal(I.DEFAULTS.tightMarginMin, undefined);
});

test('anslutningar: avgånget tåg innan vi kommit fram', () => {
  const deps = departures([['3047', '11:45', { TimeAtLocationWithSeconds: T('11:45') }]]);
  const m = setup(MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:26') } } }).concat(deps), { now: at('11:45') });
  assert.equal(m.connections[0].status, 'avgått');
});

test('tåg som ansluter till oss i startstationen: sent tåg från annat håll hinner inte', () => {
  const arrivals = [
    ann('3333', 'Lkp', 'a', '10:52', { EstimatedTimeAtLocation: T('11:00'), FromLocation: [{ LocationName: 'Gtp', Order: 0 }] }),
    ann('3337', 'Lkp', 'a', '10:50', { EstimatedTimeAtLocation: T('10:58'), FromLocation: [{ LocationName: 'Gtp', Order: 0 }] }),
    ann('3335', 'Lkp', 'a', '10:40', { FromLocation: [{ LocationName: 'Gtp', Order: 0 }] })
  ];
  const m = setup(arrivals, { now: at('10:50') });
  assert.deepEqual(m.incoming.map(c => [c.otn, c.status]), [['3335', 'ok'], ['3337', 'knappt'], ['3333', 'missas']]);
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

test('avvikelser: preliminär tid och biljettinformation är inga avvikelser för tåget', () => {
  // Riktiga svar 2026-11-25: "Prel. tid" i Lidköping och Framnäs city för 13355, "Movingo gäller ej." för 23349
  const dev = { Vr: 'Prel. tid', Vdm: 'Movingo gäller ej.', Hr: 'Spårändrat' };
  const rows = OUR().map(a => dev[a.LocationSignature] ? Object.assign({}, a, { Deviation: [{ Code: 'X', Description: dev[a.LocationSignature] }] }) : a);
  const trains = I.groupTrains(rows);
  const our = I.nearestRun(trains, '23349', at('11:00'));
  const m = I.compute({ line: I.buildLine(our, 'Lkp', 'Hr'), trains, ourKey: our.key, known: new Map(), now: at('10:55'), routeNames: ROUTE });
  assert.deepEqual(m.deviations.map(d => [d.sig, d.text]), [['Hr', 'Spårändrat']]);
  assert.equal(m.attention, 1);
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
    { Id: 'd', EventType: { Description: 'Banarbete' }, StartDateTime: T('10:30'), Location: { Signature: 'Jp' } },
    // En plats på vår linje och en utanför: en annan bana
    { Id: 'e', EventType: { Description: 'Signalfel' }, StartDateTime: T('10:30'), TrafficImpact: [{ FromLocation: [{ Signature: 'Hr' }], ToLocation: [{ Signature: 'Agå' }] }] },
    // Två platser på vår linje: en sträcka vi kör
    { Id: 'f', EventType: { Description: 'Växelfel' }, StartDateTime: T('10:30'), TrafficImpact: [{ FromLocation: [{ Signature: 'Vr' }], ToLocation: [{ Signature: 'Vdm' }] }] },
    // Banarbete på sträckan vi kör: tidtabellen räknar redan med det
    { Id: 'g', EventType: { Description: 'Banarbete' }, StartDateTime: T('10:30'), TrafficImpact: [{ PublicMessage: { Header: 'Spårarbete Vara–Vedum' }, FromLocation: [{ Signature: 'Vr' }], ToLocation: [{ Signature: 'Vdm' }] }] }
  ];
  const m = setup([], { messages });
  assert.deepEqual(m.messages.map(x => x.id), ['a', 'f']);
  assert.equal(m.messages[0].header, 'Signalfel i Vedum', 'senast ändrade publika meddelandet');
  assert.equal(m.messages[0].text, 'Tågen kör med nedsatt fart.');
  assert.deepEqual(m.messages[0].sigs, ['Vdm']);
  assert.equal(m.messages[0].end, at('13:00'));
  // Det som inte visas, och varför (sparas i körningen)
  assert.deepEqual(m.messagesHidden.map(x => [x.id, x.reason]), [['c', 'inte under resan'], ['d', 'planerat arbete'], ['e', 'annan bana'], ['g', 'planerat arbete']]);
  assert.equal(m.messagesHidden[1].header, 'Banarbete', 'utan publikt meddelande: händelsetypen');
  assert.equal(m.messagesHidden[1].raw.Id, 'd', 'originalet följer med');
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


test('position: mötande tåg långt bort på andra sidan mötesplatsen kan inte vara framme i tid', () => {
  // 11:19 och 24360 står fortfarande i Herrljunga, ca 20 km från Vara: tidigast framme ca 11:25 även i 200 km/h
  const known = { Lkp: { dep: at('11:00') }, Jp: { arr: at('11:10'), dep: at('11:11') } };
  const positions = I.parsePositions([
    { Train: { OperationalTrainNumber: '24360' }, Position: { WGS84: 'POINT (13.03 58.08)' }, TimeStamp: T('11:19'), Speed: 0 },
    { Train: { OperationalTrainNumber: '24360' }, Position: { WGS84: 'POINT (13.0 58.1)' }, TimeStamp: T('11:10') }
  ]);
  assert.equal(positions.get('24360').t, at('11:19'), 'senaste positionen');
  const m = setup(MEET(), { now: at('11:19'), known, positions, coords: COORDS });
  const mt = m.meetings[0];
  assert.equal(mt.position.side, 'beyond');
  assert.ok(mt.position.distM > 19000 && mt.position.distM < 21000, String(mt.position.distM));
  assert.equal(mt.their.source, 'position');
  assert.ok(mt.waitMin >= 5, `vi väntar (${mt.waitMin} min)`);
});

test('position: mötande tåg som redan passerat mötesplatsen mot oss visas, men ändrar inte prognosen', () => {
  const known = { Lkp: { dep: at('11:00') }, Jp: { arr: at('11:10'), dep: at('11:11') } };
  const positions = I.parsePositions([{ Train: { OperationalTrainNumber: '24360' }, Position: { WGS84: 'POINT (12.96 58.32)' }, TimeStamp: T('11:14') }]);
  const m = setup(MEET(), { now: at('11:15'), known, positions, coords: COORDS });
  assert.equal(m.meetings[0].position.side, 'passed');
  assert.equal(m.meetings[0].their.source, 'plan');
  // Gammal position används inte
  const old = setup(MEET(), { now: at('11:25'), known, positions, coords: COORDS });
  assert.equal(old.meetings.length ? old.meetings[0].position : null, null);
  assert.ok(I.queryPositions(['24360']).includes('namespace="järnväg.trafikinfo" objecttype="TrainPosition" schemaversion="1.1"'));
  assert.ok(I.queryNames(['Vr']).includes('<INCLUDE>Geometry.WGS84</INCLUDE>'));
});

test('anslutningar längs vägen: tåg från Vara åt annat håll efter vår ankomst, och tåg som kommer dit före vår avgång', () => {
  const to = sig => ({ ToLocation: [{ LocationName: sig, Priority: 1, Order: 0 }] });
  const rows = [
    ann('X2', 'Vr', 'd', '11:24', to('Sk')),  // 4 min efter vår ankomst: räcker
    ann('X1', 'Vr', 'd', '11:30', to('G')),   // 10 min: ok
    ann('X9', 'Vr', 'd', '11:50', to('G')),   // 30 min: utanför fönstret
    ann('X3', 'Vr', 'a', '11:15', { FromLocation: [{ LocationName: 'Sk', Priority: 1, Order: 0 }] }) // till oss, 6 min före avgång
  ];
  const m = setup(rows);
  assert.equal(m.stops.length, 1);
  const st = m.stops[0];
  assert.equal(st.sig, 'Vr');
  assert.deepEqual(st.connections.map(c => [c.otn, c.status]), [['X2', 'ok'], ['X1', 'ok']]);
  assert.deepEqual(st.incoming.map(c => [c.otn, c.status]), [['X3', 'ok']]);
  assert.equal(m.attention, 0);
  // Vi åkte 3 min sent från Lidköping: bytet i Vara blir knappt
  const late = setup(rows, { now: at('11:04'), known: { Lkp: { dep: at('11:03') } } });
  assert.deepEqual(late.stops[0].connections.map(c => [c.otn, c.transferMin, c.status]), [['X2', 1, 'knappt'], ['X1', 7, 'ok']]);
  assert.equal(late.attention, 1, 'den knappa räknas');
  // Har vi åkt från Vara visas inga anslutningar där
  const passed = setup(rows, { now: at('11:22'), known: { Lkp: { dep: at('11:00') }, Jp: { arr: at('11:10'), dep: at('11:11') }, Vr: { arr: at('11:20'), dep: at('11:21') } } });
  assert.equal(passed.stops.length, 0);
  // Mer än 30 min till Vara: anslutningarna där berör oss inte än (midHorizonMin)
  const early = setup(rows, { now: at('10:45') });
  assert.equal(early.stops.length, 0, 'Vara 35 min bort visas inte');
  assert.equal(setup(rows, { now: at('10:51') }).stops.length, 1, 'inom 30 min visas Vara');
});

test('utrop: försening med orsak, beräknad ankomst och anslutningar – på svenska och engelska', () => {
  const to = sig => ({ ToLocation: [{ LocationName: sig, Priority: 1, Order: 0 }], TrackAtLocation: '3' });
  const conns = [ann('G1', 'Hr', 'd', '11:45', to('G')), ann('B1', 'Hr', 'd', '11:55', to('Bo'))];
  const known = { Lkp: { dep: at('11:00') }, Jp: { arr: at('11:10'), dep: at('11:11') } };
  const m = setup(MEET({ Vdm: { d: { TimeAtLocationWithSeconds: T('11:20') } } }).concat(conns), { now: at('11:12'), known });
  const names = new Map([...ROUTE, ['G', 'Göteborg C'], ['Bo', 'Borås C']]);
  const clock = t => new Date(Math.round(t / 60000) * 60000).toTimeString().slice(0, 5);
  const a = I.announcement(m, { name: s => names.get(s) || s, clock });
  assert.equal(a.sv, 'Vi är cirka 6 minuter försenade på grund av möte med ett försenat tåg. Beräknad ankomst till Herrljunga C 11:46. ' +
    'Tåget mot Göteborg C 11:45 hinns tyvärr inte. Tåget mot Borås C 11:55 hinner ni, det går från spår 3.');
  assert.ok(a.en.startsWith('We are approximately 6 minutes late due to a delayed oncoming train. Expected arrival at Herrljunga C 11:46.'), a.en);
  // Knappt byte: hur många minuter resenärerna har på sig
  const mt = setup(MEET({ Vdm: { d: { TimeAtLocationWithSeconds: T('11:20') } } }).concat([ann('S1', 'Hr', 'd', '11:48', to('Sk'))]), { now: at('11:12'), known });
  const at2 = I.announcement(mt, { name: s => (s === 'Sk' ? 'Skövde C' : names.get(s) || s), clock });
  assert.ok(at2.sv.endsWith('Till tåget mot Skövde C 11:48 har ni cirka 2 minuter att byta, det går från spår 3.'), at2.sv);
  assert.ok(at2.en.endsWith('You will have about 2 minutes to change to the train to Skövde C at 11:48, departing from track 3.'), at2.en);
  // I tid och inga anslutningar som påverkas: inget utrop
  assert.equal(I.announcement(setup(MEET()), { clock }), null);
});

// ── Bussar (Västtrafik) ──
// En buss som railtimer-vt.js ger den: [linje, planerad tid, extra]
function bus(line, hhmm, extra) {
  return Object.assign({ id: `${line}|${hhmm}`, journey: line, line, lineName: line, mode: 'bus', direction: '', origin: '',
    planned: at(hhmm), est: null, canceled: false, partCanceled: false, platform: 'A', stop: 'Hållplatsen' }, extra || {});
}
const LATE = () => MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:26') } } }); // vi kommer till Herrljunga 11:46 (+6)

test('bussar: orten i ett namn', () => {
  assert.equal(I.townKey('Lidköping Resecentrum'), 'lidköping');
  assert.equal(I.townKey('Herrljunga C'), 'herrljunga');
  assert.equal(I.townKey('Skara via Götene'), 'skara');
  assert.equal(I.townKey('Göteborg Nils Ericson Terminalen'), 'göteborg');
  assert.equal(I.townKey(''), '');
  assert.deepEqual(Array.from(I.lineTownsExcept([{ sig: 'Lkp' }, { sig: 'Vr' }, { sig: 'Hr' }], ROUTE, 'Hr')).sort(), ['lidköping', 'vara']);
});

test('bussar i slutstationen: samma fönster och regler som tågen, och bussar mot orter längs linjen räknas inte', () => {
  const deps = [
    bus('1', '11:45', { direction: 'Vårgårda Resecentrum' }),                          // före vår ankomst: missas
    bus('2', '11:49', { direction: 'Ulricehamn busstation', platform: 'B' }),        // 3 min: knappt
    bus('3', '11:55', { direction: 'Borås Resecentrum', est: at('12:02') }),          // sen: ok
    bus('4', '11:50', { direction: 'Vara Resecentrum' }),                             // längs vår linje
    bus('5', '11:43', { direction: 'Borås' }),                                        // 3 min efter planerad ankomst: ingen anslutning
    bus('6', '12:25', { direction: 'Borås' }),                                        // mer än 40 min
    bus('7', '11:52', { direction: 'Herrljunga Hagen' }),                              // inom Herrljunga: räknas
    bus('8', '11:58', { direction: 'Tämta', canceled: true })
  ];
  const buses = new Map([['Hr', { departures: deps, arrivals: [] }]]);
  // Tåg (förval): bussarna visas inte och påverkar inget, men räknas som dolda
  const tag = setup(LATE(), { buses });
  assert.equal(tag.connections.length, 0);
  assert.deepEqual(tag.connectionsHidden, { tåg: 0, buss: 5 });
  assert.equal(tag.missed, 0);
  assert.equal(tag.connMode, 'tag');
  // Buss
  const m = setup(LATE(), { buses, connMode: 'buss' });
  assert.deepEqual(m.connections.map(c => [c.ident, c.transferMin, c.status]),
    [['1', -1, 'missas'], ['2', 3, 'knappt'], ['7', 6, 'ok'], ['3', 16, 'ok'], ['8', 12, 'inställt']]);
  const b3 = m.connections.find(c => c.ident === '3');
  assert.equal(b3.kind, 'buss');
  assert.equal(b3.delayMin, 7);
  assert.equal(b3.source, 'västtrafik');
  assert.equal(b3.toText, 'Borås Resecentrum');
  assert.equal(m.connections.find(c => c.ident === '2').track, 'B');
  assert.equal(m.missed, 1);
  assert.equal(m.tight, 2, 'knappt och inställt');
  // Utropet säger buss och läge
  const clock = t => new Date(Math.round(t / 60000) * 60000).toTimeString().slice(0, 5);
  const a = I.announcement(m, { name: s => ROUTE.get(s) || s, clock });
  assert.ok(a.sv.includes('Buss 1 mot Vårgårda Resecentrum 11:45 hinns tyvärr inte.'), a.sv);
  assert.ok(a.sv.includes('Till buss 2 mot Ulricehamn busstation 11:49 har ni cirka 3 minuter att byta, den går från läge B.'), a.sv);
  assert.ok(a.sv.includes('Buss 7 mot Herrljunga Hagen 11:52 hinner ni, den går från läge A.'), a.sv);
  assert.ok(a.en.includes('Bus 1 to Vårgårda Resecentrum at 11:45 will unfortunately be missed.'), a.en);
  assert.ok(a.en.includes('to change to bus 2 to Ulricehamn busstation at 11:49, departing from stop B.'), a.en);
  // Avgången: Västtrafik har ingen faktisk tid, så en buss vars tid har passerat räknas som avgången
  const gone = setup(LATE(), { buses, connMode: 'buss', now: at('11:45') + 60000 });
  assert.equal(gone.connections.find(c => c.ident === '1').status, 'avgått');
});

test('bussar: Båda visar tåg och bussar i tidsordning, och utan varningsval gäller varningarna alla som hämtats', () => {
  const to = sig => ({ ToLocation: [{ LocationName: sig, Priority: 1, Order: 0 }] });
  const rows = LATE().concat([ann('3049', 'Hr', 'd', '11:49', to('Bs'))]);
  const buses = new Map([['Hr', { departures: [bus('1', '11:45', { direction: 'Vårgårda' }), bus('3', '11:55', { direction: 'Borås' })], arrivals: [] }]]);
  const both = setup(rows, { buses, connMode: 'bada' });
  assert.deepEqual(both.connections.map(c => [c.kind, c.ident || c.otn]), [['buss', '1'], ['tåg', '3049'], ['buss', '3']]);
  assert.deepEqual(both.connectionsHidden, { tåg: 0, buss: 0 });
  // Bara tåg i listan, men varningarna gäller alla: den missade bussen räknas
  const list = setup(rows, { buses, connMode: 'tag', connAlerts: false });
  assert.deepEqual(list.connections.map(c => c.otn), ['3049']);
  assert.equal(list.connAlerts, false);
  assert.equal(list.missed, 1, 'bussen som missas');
  assert.equal(list.tight, 1, 'tåget som blir knappt');
  assert.deepEqual(list.alert.connections.map(c => c.kind), ['buss', 'tåg', 'buss']);
  // Med varningsvalet (förval) gäller varningarna bara tågen
  const follow = setup(rows, { buses, connMode: 'tag' });
  assert.equal(follow.missed, 0);
  assert.equal(follow.tight, 1);
  // Okänt val blir Tåg
  assert.equal(setup(rows, { buses, connMode: 'annat' }).connMode, 'tag');
});

test('bussar längs vägen och till oss i startstationen – bara före avgång', () => {
  const buses = new Map([
    ['Vr', {
      departures: [bus('500', '11:26', { direction: 'Skara Resecentrum' }), bus('501', '11:50', { direction: 'Skara' }), bus('502', '11:30', { direction: 'Herrljunga station' })],
      arrivals: [bus('600', '11:14', { origin: 'Skara Resecentrum' }), bus('601', '11:16', { origin: 'Lidköping Resecentrum' })]
    }],
    ['Lkp', { departures: [], arrivals: [bus('100', '10:50', { origin: 'Götene Resecentrum', est: at('10:58') }), bus('101', '10:40', { origin: 'Götene' })] }]
  ]);
  const m = setup([], { buses, connMode: 'buss', now: at('10:50') });
  assert.equal(m.stops.length, 1);
  const st = m.stops[0];
  assert.equal(st.sig, 'Vr');
  assert.deepEqual(st.connections.map(c => [c.ident, c.status]), [['500', 'ok']], 'efter fönstret och mot Herrljunga räknas inte');
  assert.deepEqual(st.incoming.map(c => [c.ident, c.status, c.fromText]), [['600', 'ok', 'Skara Resecentrum']], 'från Lidköping längs vår linje räknas inte');
  assert.deepEqual(m.incoming.map(c => [c.ident, c.transferMin, c.status]), [['101', 20, 'ok'], ['100', 2, 'knappt']]);
  assert.deepEqual(m.incomingHidden, { tåg: 0, buss: 0 });
  // Tåg: samma bussar räknas som dolda, och stationen längs vägen visas inte
  const tag = setup([], { buses, now: at('10:50') });
  assert.equal(tag.stops.length, 0);
  assert.deepEqual(tag.stopsHidden, { tåg: 0, buss: 2 });
  assert.deepEqual(tag.incomingHidden, { tåg: 0, buss: 2 });
  assert.equal(tag.attention, 0);
  // Efter avgång från Lidköping: inga bussar till oss där
  const after = setup([], { buses, connMode: 'buss', now: at('11:01'), known: { Lkp: { dep: at('11:00') } } });
  assert.equal(after.incoming, null);
});

test('markerade anslutningar: knapp eller missad ger förslaget att ringa trafikledningen – bara när det räcker att vänta högst 15 min', () => {
  const deps = departures([['3047', '11:45'], ['3049', '11:49'], ['417', '11:55']]);
  const marked = new Set(['ut|Hr|tåg|3047', 'ut|Hr|tåg|3049', 'ut|Hr|tåg|417']);
  const m = setup(LATE().concat(deps), { marked });
  assert.deepEqual(m.connections.map(c => [c.otn, c.marked, c.key]),
    [['3047', true, 'ut|Hr|tåg|3047'], ['3049', true, 'ut|Hr|tåg|3049'], ['417', true, 'ut|Hr|tåg|417']]);
  assert.deepEqual(m.actions.map(a => [a.type, a.c.otn, a.waitMin, a.theirTrack]), [['hold', '3047', 5, '3'], ['hold', '3049', 1, '3']]);
  assert.equal(m.markedList.length, 3);
  // Utan markering: inget förslag
  const none = setup(LATE().concat(deps));
  assert.equal(none.actions.length, 0);
  assert.equal(none.connections[0].marked, false);
  // 20 min sena: 3047 skulle behöva vänta 19 min, då föreslås inget
  const veryLate = setup(MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:40') } } }).concat(departures([['3047', '11:45']])), { marked });
  assert.equal(veryLate.connections[0].status, 'missas');
  assert.equal(veryLate.actions.length, 0);
  // Avgånget tåg: inget förslag
  const gone = setup(LATE().concat(departures([['3047', '11:45', { TimeAtLocationWithSeconds: T('11:45') }]])), { marked, now: at('11:45') });
  assert.equal(gone.connections[0].status, 'avgått');
  assert.equal(gone.actions.length, 0);
  // Markeringen gäller även när valet döljer tågen, och för bussar (linje och klockslag)
  const buses = new Map([['Hr', { departures: [bus('1', '11:45', { direction: 'Vårgårda' })], arrivals: [] }]]);
  const b = setup(LATE().concat(deps), { buses, connMode: 'buss', marked: new Set(['ut|Hr|tåg|3047', 'ut|Hr|buss|1|1145']) });
  assert.deepEqual(b.actions.map(a => [a.c.kind, a.c.ident, a.waitMin]), [['tåg', '3047', 5], ['buss', '1', 5]]);
  assert.deepEqual(b.connections.map(c => c.kind), ['buss']);
});

test('markerade anslutningar till oss: kan vi vänta på ett sent tåg i startstationen', () => {
  const arrivals = [ann('3333', 'Lkp', 'a', '10:52', { EstimatedTimeAtLocation: T('11:00'), TrackAtLocation: '2', FromLocation: [{ LocationName: 'Gtp', Order: 0 }] })];
  const m = setup(arrivals, { now: at('10:50'), marked: new Set(['in|Lkp|tåg|3333']) });
  assert.equal(m.incoming[0].status, 'missas');
  assert.deepEqual(m.actions.map(a => [a.type, a.sig, a.c.otn, a.waitMin, a.theirTrack]), [['wait', 'Lkp', '3333', 4, '2']]);
});

test('meddelanden: texter och nycklar, och samma sak meddelas en gång per nivå', () => {
  const clock = t => new Date(Math.round(t / 60000) * 60000).toTimeString().slice(0, 5);
  const m = {
    meetings: [{ level: 2, otn: '24360', ident: '24360', sig: 'Vr', theirDelayMin: 6, waitMin: 6 }],
    connections: [{ level: 1, otn: '3049', status: 'knappt', transferMin: 3, adv: at('11:49'), to: ['G'] }],
    incoming: [], stops: [], deviations: [{ sig: 'Hr', text: 'Spårändrat' }], messages: []
  };
  const list = I.alerts(m, { name: s => ({ Vr: 'Vara', G: 'Göteborg C', Hr: 'Herrljunga C' })[s] || s, clock });
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
  assert.deepEqual(I.newAlerts(I.alerts(m, { clock }), notified).map(a => a.text), ['Anslutning 11:49 G: missas'], 'värre: meddelas igen');
});

test('loggen över Trafikverkets svar: bara ändringar, mötande tågs position och vad appen räknade med', () => {
  const rows1 = OUR().concat(MEET());
  const trains1 = I.groupTrains(rows1);
  const our = I.nearestRun(trains1, '23349', at('11:00'));
  const line = I.buildLine(our, 'Lkp', 'Hr');
  const log = I.trvLogNew(at('11:00'), line.map(l => l.sig));
  const keys = [our.key, '24360|2026-11-25'];
  I.trvLogTrains(log, trains1, keys, at('11:01'));
  const first = log.rows.length;
  assert.equal(first, 16, '8 annonseringar per tåg');
  assert.deepEqual(log.rows.find(r => r[2] === '24360' && r[3] === 'Vr' && r[4] === 'a'),
    ['a', 60, '24360', 'Vr', 'a', 20 * 60, null, null, 0, 0, null, '']);
  // Samma svar igen: inget nytt
  I.trvLogTrains(log, trains1, keys, at('11:02'));
  assert.equal(log.rows.length, first);
  // Trafikverket ger en beräknad tid i Vara: en rad
  const trains2 = I.groupTrains(OUR().concat(MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:24'), EstimatedTimeIsPreliminary: true,
    ModifiedTime: '2026-11-25T10:02:30.000Z' } } })));
  I.trvLogTrains(log, trains2, keys, at('11:03'));
  assert.equal(log.rows.length, first + 1);
  assert.deepEqual(log.rows[first], ['a', 180, '24360', 'Vr', 'a', 1200, 1440, null, 0, 1, 150, '']);
  // Position: en gång, sedan bara när tåget flyttat sig minst 200 m eller efter 3 min
  const pos = (lat, t) => new Map([['24360', { otn: '24360', lat, lon: 12.99, t, speedKmh: 80.4 }]]);
  I.trvLogPositions(log, pos(58.172, at('11:03')), ['24360'], at('11:03'));
  I.trvLogPositions(log, pos(58.1721, at('11:04')), ['24360'], at('11:04'));
  I.trvLogPositions(log, pos(58.180, at('11:05')), ['24360'], at('11:05'));
  assert.deepEqual(log.rows.filter(r => r[0] === 'p').map(r => r[6]), [180, 300]);
  assert.deepEqual(log.rows.filter(r => r[0] === 'p')[0], ['p', 180, '24360', 58.172, 12.99, 80, 180]);
  // Vad appen räknade med
  const m = setup(MEET(), { now: at('11:14'), known: LATE14, knownMeet: ['Jp'] });
  I.trvLogModel(log, m, at('11:14'));
  I.trvLogModel(log, m, at('11:14') + 5000);
  assert.deepEqual(log.rows.filter(r => r[0] === 'm'), [['m', 840, '24360', 'Vr', 'Jp', 'beräknat', 7, 0, 'plan']]);
  assert.deepEqual(log.rows.filter(r => r[0] === 'e'), [['e', 840, 3540, 19]]);
  // Till körningen: utan det som bara håller reda på vad som sparats
  const out = I.trvLogOut(log);
  assert.equal(out.t0, '2026-11-25T10:00:00.000Z');
  assert.deepEqual(Object.keys(out), ['v', 't0', 'line', 'rows']);
  assert.ok(JSON.stringify(out).length < 3000);
  assert.equal(I.trvLogOut(I.trvLogNew(at('11:00'), [])), null, 'tom logg sparas inte');
  // Högst trvLogMax rader
  const small = I.trvLogNew(at('11:00'), line.map(l => l.sig));
  I.trvLogTrains(small, trains1, keys, at('11:01'), { trvLogMax: 5 });
  assert.equal(small.rows.length, 5);
  assert.equal(I.trvLogOut(small).full, true);
});
