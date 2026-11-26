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
  const trains = I.groupTrains((o.ourRows || OUR()).concat(rows || []));
  const our = I.nearestRun(trains, '23349', at('11:00'));
  const line = I.buildLine(our, 'Lkp', 'Hr');
  const known = new Map(Object.entries(o.known || {}));
  return I.compute({
    line, trains, ourKey: our.key, known, now: o.now != null ? o.now : at('10:55'),
    knownDouble: o.knownDouble, knownMeetPlaces: o.knownMeet, history: o.history, routeNames: ROUTE, opts: o.opts,
    messages: o.messages, positions: o.positions, coords: o.coords, ourPos: o.ourPos, axis: o.axis,
    buses: o.buses, names: o.names, connMode: o.connMode, connAlerts: o.connAlerts, marked: o.marked, posAt: o.posAt, own: o.own,
    infra: o.infra
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
  assert.equal(a.text, 'Möte i Järpås i stället för Vara (troligen): vi väntar ca 7 min på 24360');
  assert.equal(a.short, 'möte Järpås: vänta 7 min', 'panelens korta rad');
  assert.equal(I.alerts(m, { name: s => ROUTE.get(s) || s, follow: true }).find(x => x.key === 'm|24360|Vr').text,
    'Möte i Järpås i stället för Vara (troligen): tåget väntar ca 7 min på 24360', 'Var är tåget?: tåget, inte vi');
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
  // I ordning längs linjen (2026-11-26f): Vara–Vedum före Vedum
  assert.deepEqual(m.messages.map(x => x.id), ['f', 'a']);
  assert.equal(m.messages[1].header, 'Signalfel i Vedum', 'senast ändrade publika meddelandet');
  assert.equal(m.messages[1].title, 'Signalfel i Vedum', 'Trafikverkets egen rubrik går före');
  assert.equal(m.messages[0].title, 'Växelfel', 'händelsetypen i ord');
  assert.equal(m.messages[1].text, 'Tågen kör med nedsatt fart.');
  assert.deepEqual(m.messages[1].sigs, ['Vdm']);
  assert.deepEqual(m.messages[0].sigs, ['Vr', 'Vdm'], 'platserna i linjens ordning');
  assert.equal(m.messages[1].end, at('13:00'));
  assert.equal(m.messages[1].clear, false, 'pågår när vi är där');
  assert.ok(m.messages[1].ourT > at('11:00'), 'när vi är vid första berörda plats');
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

/* Linjen längs banan: gångprofiler (referenslinjer ur GPS-spår) för sträckorna i rutten, här raka linjer mellan
   stationerna med en punkt ungefär var 100:e meter. */
function legProfile(from, to, a, b, opts) {
  const o = opts || {};
  const len = I.haversine(a.lat, a.lon, b.lat, b.lon), steps = Math.max(2, Math.round(len / 100));
  const pts = [];
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    pts.push([a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f, Math.round((1 - f) * len / 25), 5]);
  }
  return { key: I.legKey(from, to, true, true), from, to, stopA: true, stopB: true, n: o.n || 5, legSec: Math.round(len / 25), pts };
}
const SIGS = ['Lkp', 'Jp', 'Vr', 'Vdm', 'Hr'];
const STOPS = SIGS.map(s => ({ sig: s, name: ROUTE.get(s), lat: COORDS.get(s).lat, lon: COORDS.get(s).lon }));
function profilesFor(legs) {
  const out = new Map();
  for (const [x, y] of legs) {
    const A = STOPS.find(s => s.sig === x), B = STOPS.find(s => s.sig === y);
    const p = legProfile(A.name, B.name, A, B);
    out.set(p.key, p);
  }
  return out;
}
const AXIS_ALL = () => I.buildAxis(STOPS, profilesFor([['Lkp', 'Jp'], ['Jp', 'Vr'], ['Vr', 'Vdm'], ['Vdm', 'Hr']]));
const pos24360 = (lat, lon, hhmm, speed) => I.parsePositions([{ Train: { OperationalTrainNumber: '24360' },
  Position: { WGS84: `POINT (${lon} ${lat})` }, TimeStamp: T(hhmm), ...(speed != null ? { Speed: speed } : {}) }]);
const between = (x, y, f) => ({ lat: COORDS.get(x).lat + (COORDS.get(y).lat - COORDS.get(x).lat) * f, lon: COORDS.get(x).lon + (COORDS.get(y).lon - COORDS.get(x).lon) * f });

test('linjen längs banan: profilerna i rutten blir en axel med meter längs banan, och profilen åt andra hållet duger', () => {
  // Järpås–Vara bara åt andra hållet (Vara → Järpås)
  const profiles = profilesFor([['Lkp', 'Jp'], ['Vr', 'Jp'], ['Vr', 'Vdm'], ['Vdm', 'Hr']]);
  const axis = I.buildAxis(STOPS, profiles);
  assert.ok(axis);
  assert.equal(axis.measuredLegs, 4);
  const d = s => axis.stations[s];
  assert.equal(d('Lkp'), 0);
  const lkpJp = I.haversine(COORDS.get('Lkp').lat, COORDS.get('Lkp').lon, COORDS.get('Jp').lat, COORDS.get('Jp').lon);
  assert.ok(Math.abs(d('Jp') - lkpJp) < 5, `${d('Jp')} ~ ${Math.round(lkpJp)}`);
  assert.ok(d('Jp') < d('Vr') && d('Vr') < d('Vdm') && d('Vdm') < d('Hr'));
  assert.ok(Math.abs(d('Hr') - axis.len) < 5);
  // Ett läge mitt mellan Järpås och Vara ligger mitt mellan dem längs banan, nära linjen och på uppmätt bana
  const loc = I.axisLocate(axis, between('Jp', 'Vr', 0.5));
  assert.ok(Math.abs(loc.d - (d('Jp') + d('Vr')) / 2) < 10);
  assert.ok(loc.off < 5);
  assert.equal(I.axisMeasured(axis, d('Lkp'), d('Hr')), true);
  // Utan profil för Järpås–Vara: rak linje, inte uppmätt där
  const partial = I.buildAxis(STOPS, profilesFor([['Lkp', 'Jp'], ['Vr', 'Vdm'], ['Vdm', 'Hr']]));
  assert.equal(partial.measuredLegs, 3);
  assert.equal(I.axisMeasured(partial, partial.stations.Jp + 500, partial.stations.Vr - 500), false);
  assert.equal(I.axisMeasured(partial, partial.stations.Vr, partial.stations.Hr), true);
  // En profil som inte börjar vid A (fel namn) används inte, och utan någon profil blir det ingen axel
  const wrong = profilesFor([['Vdm', 'Hr']]);
  const p = wrong.get(I.legKey('Vedum', 'Herrljunga C', true, true));
  wrong.set(I.legKey('Lidköping', 'Järpås', true, true), Object.assign({}, p, { key: I.legKey('Lidköping', 'Järpås', true, true) }));
  assert.equal(I.buildAxis(STOPS, wrong).measuredLegs, 1);
  assert.equal(I.buildAxis(STOPS, new Map()), null);
});

test('längs banan: 24360 är ute på enkelspåret mellan Vara och Järpås enligt sin position – vi väntar i Järpås', () => {
  // 14 min sena från Lidköping, ingen rapport från Vara. 11:23 är 24360 mitt mellan Vara och Järpås i 90 km/h.
  const p = between('Vr', 'Jp', 0.5);
  const positions = pos24360(p.lat, p.lon, '11:23', 90);
  const o = { now: at('11:23'), known: LATE14, knownMeet: ['Jp'], positions, coords: COORDS, opts: { predictMoves: false } };
  const m = setup(MEET(), Object.assign({ axis: AXIS_ALL() }, o));
  const mt = m.meetings[0];
  assert.equal(mt.moved, true, 'har passerat Vara mot oss');
  assert.equal(mt.movedVia, 'position');
  assert.equal(mt.at, 'Jp');
  assert.equal(mt.move, 'rapporterat');
  assert.equal(mt.moveVia, 'position');
  assert.equal(mt.ourDep, at('11:31'), '24360 i Järpås 11:30 + 1 min');
  assert.equal(m.end.delayMin, 19);
  assert.equal(mt.position.along, true);
  assert.ok(mt.position.distM > 6000 && mt.position.distM < 7500, String(mt.position.distM));
  // Med fågelvägen (utan axel) visas positionen bara: mötet enligt tidtabell i Vara, utan väntan
  const crow = setup(MEET(), o);
  assert.equal(crow.meetings[0].at, 'Vr');
  assert.equal(crow.meetings[0].waitMin, 0);
  assert.equal(crow.meetings[0].position.along, undefined);
  assert.equal(crow.end.delayMin, 13);
  // Loggen säger att flytten kom från positionen, och var tåget är i förhållande till Järpås (på andra sidan)
  const log = I.trvLogNew(at('11:00'), ['Lkp', 'Jp', 'Vr', 'Vdm', 'Hr']);
  I.trvLogModel(log, m, at('11:23'));
  const row = log.rows.find(r => r[0] === 'm');
  assert.deepEqual(row.slice(-2), ['position', 'beyond']);
});

test('längs banan: står 24360 still nära Vara kan det vänta vid utfartssignalen – inte ute på sträckan', () => {
  const p = between('Vr', 'Jp', 900 / 13700); // ca 900 m från Vara mot Järpås
  const o = { now: at('11:23'), known: LATE14, knownMeet: ['Jp'], coords: COORDS, axis: AXIS_ALL(), opts: { predictMoves: false } };
  const still = setup(MEET(), Object.assign({ positions: pos24360(p.lat, p.lon, '11:23', 0) }, o));
  assert.equal(still.meetings[0].moved, false);
  assert.equal(still.meetings[0].position.side, 'at');
  assert.equal(still.meetings[0].at, 'Vr');
  const unknown = setup(MEET(), Object.assign({ positions: pos24360(p.lat, p.lon, '11:23') }, o));
  assert.equal(unknown.meetings[0].at, 'Vr', 'utan fart: samma sak');
  // I 80 km/h har det lämnat Vara
  const moving = setup(MEET(), Object.assign({ positions: pos24360(p.lat, p.lon, '11:23', 80) }, o));
  assert.equal(moving.meetings[0].movedVia, 'position', 'har lämnat Vara mot oss');
  assert.equal(moving.meetings[0].at, 'Jp');
  assert.equal(moving.meetings[0].moveVia, 'position');
});

test('längs banan: har 24360 passerat oss är mötet klart – fågelvägen trodde att det var på andra sidan Vara', () => {
  // Vi står i Vara (i tid), 24360 rapporteras inte där men är 11:22 mitt mellan Vara och Järpås: det har passerat oss
  const p = between('Vr', 'Jp', 0.5);
  const known = { Lkp: { dep: at('11:00') }, Jp: { arr: at('11:10'), dep: at('11:11') }, Vr: { arr: at('11:20') } };
  const o = { now: at('11:23'), known, positions: pos24360(p.lat, p.lon, '11:22', 90), coords: COORDS };
  const m = setup(MEET(), Object.assign({ axis: AXIS_ALL() }, o));
  assert.equal(m.meetings.length, 0, 'mötet är avklarat');
  assert.equal(m.preds[2].dep, at('11:23'), 'vi kan åka nu');
  // Med fågelvägen från Vara: 7 km bort räknades som på andra sidan, och vi väntade
  const crow = setup(MEET(), o);
  assert.equal(crow.meetings[0].position.side, 'beyond');
  assert.ok(crow.meetings[0].waitMin >= 1);
});

test('längs banan: där banan inte är uppmätt räknas fågelvägen som förut', () => {
  const p = between('Vr', 'Jp', 0.5);
  const partial = I.buildAxis(STOPS, profilesFor([['Lkp', 'Jp'], ['Vr', 'Vdm'], ['Vdm', 'Hr']]));
  const o = { now: at('11:23'), known: LATE14, knownMeet: ['Jp'], positions: pos24360(p.lat, p.lon, '11:23', 90), coords: COORDS, opts: { predictMoves: false } };
  const m = setup(MEET(), Object.assign({ axis: partial }, o));
  assert.equal(m.meetings[0].position.along, undefined);
  assert.equal(m.meetings[0].at, 'Vr');
  assert.equal(m.meetings[0].moved, false);
  // Långt från linjen (annan bana): inte på vår linje
  const off = setup(MEET(), Object.assign({ axis: AXIS_ALL() }, o, { positions: pos24360(p.lat, p.lon + 0.02, '11:23', 90) }));
  assert.equal(off.meetings[0].position.along, undefined);
  assert.equal(off.meetings[0].moved, false);
});

test('längs banan: långt bort på andra sidan Vara – undre gränsen räknas på avståndet längs banan', () => {
  const known = { Lkp: { dep: at('11:00') }, Jp: { arr: at('11:10'), dep: at('11:11') } };
  const o = { now: at('11:19'), known, positions: pos24360(COORDS.get('Hr').lat, COORDS.get('Hr').lon, '11:19', 0), coords: COORDS };
  const m = setup(MEET(), Object.assign({ axis: AXIS_ALL() }, o));
  const mt = m.meetings[0];
  assert.equal(mt.position.along, true);
  assert.equal(mt.position.side, 'beyond');
  const axis = AXIS_ALL();
  assert.ok(Math.abs(mt.position.distM - (axis.stations.Hr - axis.stations.Vr)) < 50);
  assert.equal(mt.their.source, 'position');
  const crow = setup(MEET(), o);
  assert.ok(mt.waitMs >= crow.meetings[0].waitMs, 'längs banan är det minst lika långt som fågelvägen');
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
    incoming: [], stops: [], deviations: [{ sig: 'Hr', text: 'Spårändrat' }], messages: [],
    end: { sig: 'Hr' }
  };
  const list = I.alerts(m, { name: s => ({ Vr: 'Vara', G: 'Göteborg C', Hr: 'Herrljunga C' })[s] || s, clock });
  // Viktigast först: nivå 2, sedan möte före knappt byte före avvikelse (2026-11-26f)
  assert.deepEqual(list.map(a => a.text), [
    'Möte i Vara: vi väntar ca 6 min på 24360 (6 min sent)',
    'Byte till Göteborg C 11:49 i Herrljunga C: 3 min – knappt',
    'Herrljunga C: Spårändrat'
  ]);
  assert.deepEqual(list.map(a => a.short), ['möte Vara: vänta 6 min', 'knappt byte Göteborg C', 'Spårändrat Herrljunga C']);
  assert.equal(list[1].say, 'Anslutningen mot Göteborg C 11:49 blir knapp.');
  const notified = new Map([['d|Hr|Spårändrat', 1]]);
  assert.deepEqual(I.newAlerts(list, notified).map(a => a.key), ['m|24360|Vr', 'c|3049']);
  assert.deepEqual(I.newAlerts(list, notified), [], 'redan meddelat');
  m.connections[0].level = 2;
  m.connections[0].status = 'missas';
  assert.deepEqual(I.newAlerts(I.alerts(m, { clock }), notified).map(a => a.text), ['Byte till G 11:49 i Hr missas – går när vi kommer fram'], 'värre: meddelas igen');
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
  assert.deepEqual(log.rows.filter(r => r[0] === 'm'), [['m', 840, '24360', 'Vr', 'Jp', 'beräknat', 7, 0, 'plan', '', '']]);
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

/* Gångprofiler. Sträckan Lidköping → Järpås rakt norrut, 6 km. Ett spår per körning, en punkt i sekunden:
   jämn fart från avgång till ankomst (tiden i sekunder). */
const A0 = { lat: 58.40, lon: 13.00 }, LEG_M = 6000;
const latAt = m => A0.lat + m / 110540;
function legRun(id, depMs, runSec, opt) {
  const o = opt || {};
  const arr = depMs + runSec * 1000;
  const run = { id, stops: [
    { name: 'Lidköping', actualArrival: null, actualDeparture: new Date(depMs).toISOString() },
    { name: 'Järpås', actualArrival: new Date(arr).toISOString(), actualDeparture: new Date(arr + (o.dwellSec != null ? o.dwellSec : 40) * 1000).toISOString(),
      excludeInboundRun: !!o.exclude },
    { name: 'Vara', actualArrival: new Date(arr + 600000).toISOString(), actualDeparture: null }
  ] };
  const points = [];
  for (let s = -5; s <= runSec + 5; s++) {
    if (o.gapFrom != null && s > o.gapFrom && s < o.gapFrom + 60) continue;
    const m = clampN(s / runSec, 0, 1) * LEG_M;
    points.push([s * 1000 + 5000, latAt(m), A0.lon, 5]);
  }
  return { run, track: { runId: id, t0: new Date(depMs - 5000).toISOString(), fields: ['t_ms', 'lat', 'lon', 'acc_m'], points } };
}
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function buildProfiles(list) {
  const b = I.profileBuilder();
  for (const x of list) b.add(x.run, x.track);
  return b.result();
}

test('gångprofil: tid kvar till nästa station från där vi är, median av tidigare spår', () => {
  const dep = at('10:00');
  const list = [legRun('a', dep, 600), legRun('b', dep + 86400000, 620), legRun('c', dep + 2 * 86400000, 640)];
  const p = buildProfiles(list);
  const prof = p.get('lidköping>järpås|ss');
  assert.ok(prof, 'profil för Lidköping → Järpås, stannade i båda');
  assert.equal(prof.n, 3);
  assert.equal(prof.legSec, 620);
  assert.ok(prof.pts.length >= 55 && prof.pts.length <= 65, 'en punkt ungefär var 100:e meter: ' + prof.pts.length);
  // Halvvägs: hälften kvar, median 310 s
  const half = I.remainingFrom(prof, { lat: latAt(3000), lon: A0.lon });
  assert.ok(Math.abs(half.sec - 310) <= 2, 'halvvägs: ' + half.sec);
  assert.ok(half.distM < 5);
  assert.equal(I.remainingFrom(prof, { lat: latAt(3000), lon: A0.lon + 0.01 }), null, '580 m vid sidan: ingen tid');
  // Beräknad ankomst: positionens tid + tid kvar, aldrig före nu
  const e = I.positionEstimate(p, { from: 'Lidköping', to: 'Järpås', stopA: true, stopB: true, pos: { lat: latAt(4500), lon: A0.lon }, at: at('11:00'), now: at('11:00') + 10000 });
  assert.ok(Math.abs(e.t - (at('11:00') + 155000)) <= 2000, 'tre fjärdedelar: 155 s kvar');
  assert.equal(e.exact, true);
  assert.equal(I.positionEstimate(p, { from: 'Lidköping', to: 'Järpås', stopA: true, stopB: false, pos: { lat: latAt(4500), lon: A0.lon }, at: 0, now: 0 }), null,
    'inget för passage i Järpås när spåren stannade där');
  // Stannade inte i Lidköping: den andra profilen bara efter första fjärdedelen av sträckan
  const near = I.positionEstimate(p, { from: 'Lidköping', to: 'Järpås', stopA: false, stopB: true, pos: { lat: latAt(500), lon: A0.lon }, at: 0, now: 0 });
  const far = I.positionEstimate(p, { from: 'Lidköping', to: 'Järpås', stopA: false, stopB: true, pos: { lat: latAt(4500), lon: A0.lon }, at: 0, now: 0 });
  assert.equal(near, null);
  assert.equal(far.exact, false);
});

test('gångprofil: minst 3 spår, undantagna sträckor räknas inte, och ett spår med glapp blir inte referenslinje', () => {
  const dep = at('10:00');
  assert.equal(buildProfiles([legRun('a', dep, 600), legRun('b', dep + 86400000, 620)]).size, 0, 'två spår räcker inte');
  const excl = buildProfiles([legRun('a', dep, 600), legRun('b', dep + 86400000, 620), legRun('c', dep + 2 * 86400000, 640, { exclude: true })]);
  assert.equal(excl.get('lidköping>järpås|ss'), undefined, 'föraren undantog sträckan i en av dem');
  // Det nyaste spåret har ett glapp på 60 s (ca 600 m): referenslinjen tas från nästa, men glappspåret räknas ändå
  const gap = buildProfiles([legRun('g', dep + 3 * 86400000, 600, { gapFrom: 200 }), legRun('a', dep, 600), legRun('b', dep + 86400000, 620), legRun('c', dep + 2 * 86400000, 640)]);
  const prof = gap.get('lidköping>järpås|ss');
  assert.equal(prof.n, 4);
  const steps = prof.pts.slice(1).map((q, k) => I.haversine(prof.pts[k][0], prof.pts[k][1], q[0], q[1]));
  assert.ok(Math.max(...steps) < 150, 'inga långa hopp i referenslinjen: ' + Math.round(Math.max(...steps)));
  // Passage i Järpås (uppehåll under 8 s) är en egen profil
  const pass = buildProfiles([legRun('a', dep, 600, { dwellSec: 3 }), legRun('b', dep + 86400000, 620, { dwellSec: 2 }), legRun('c', dep + 2 * 86400000, 640, { dwellSec: 4 })]);
  assert.ok(pass.get('lidköping>järpås|sp'));
});

test('prognos från där vi är: ankomsten till nästa station räknas från positionen, och resten efter den', () => {
  // Åkte från Lidköping 11:00. Enligt gångprofilen är vi framme i Järpås 11:12 i stället för 11:10
  const m = setup([], { now: at('11:05'), known: { Lkp: { dep: at('11:00') } }, posAt: { sig: 'Jp', t: at('11:12') } });
  assert.deepEqual(m.posAt, { sig: 'Jp', t: at('11:12') });
  assert.equal(m.preds[1].arr, at('11:12'));
  // 30 s uppehåll i Järpås, sedan planerade gångtider (9 min): Vara 11:21:30, Vedum 11:31, Herrljunga 11:40:30
  assert.equal(m.end.predArr, at('11:40') + 30000);
  const none = setup([], { now: at('11:05'), known: { Lkp: { dep: at('11:00') } } });
  assert.equal(none.end.predArr, at('11:40'), 'utan positionen: enligt planen');
  // Gäller inte en plats vi redan nått
  const old = setup([], { now: at('11:12'), known: { Lkp: { dep: at('11:00') }, Jp: { arr: at('11:10') } }, posAt: { sig: 'Jp', t: at('11:15') } });
  assert.equal(old.posAt, null);
  assert.equal(old.preds[1].arr, at('11:10'));
});

test('egna anslutningar (Mina): tåg och buss i slutstationen och längs vägen, även utanför de vanliga fönstren', () => {
  // Vi kommer till Herrljunga 11:46 (+6). Vedum nås 11:30, mer än 30 min bort klockan 10:55.
  const rows = LATE().concat(departures([
    ['3047', '11:45', null, 'Bs'],        // vanlig, missas
    ['3049', '11:49'],                    // vanlig, knappt
    ['182', '12:30', null, 'Cst'],        // egen: 44 min efter vår ankomst, utanför de vanliga 40 min
    ['24362', '11:50', null, 'Lkp']       // egen: tillbaka längs vår linje, räknas ändå
  ]), [ann('X9', 'Vdm', 'd', '11:40', { ToLocation: [{ LocationName: 'Sk', Priority: 1, Order: 0 }] })]);
  const buses = new Map([['Hr', { departures: [bus('600', '12:10', { direction: 'Borås' }), bus('601', '13:30', { direction: 'Ulricehamn' })], arrivals: [] }]]);
  const own = [
    { kind: 'tåg', id: '182', sig: 'Hr' }, { kind: 'tåg', id: '24362', sig: 'Hr' }, { kind: 'buss', id: '601', sig: 'Hr' },
    { kind: 'tåg', id: 'X9', sig: 'Vdm' }, { kind: 'tåg', id: '999', sig: 'Hr' }, { kind: 'buss', id: '5', sig: 'Sk' }
  ];
  // Tåg (förval): som förut – de egna utanför fönstret syns inte, men de egna som också är vanliga märks
  const tag = setup(rows, { buses, own });
  assert.deepEqual(tag.connections.map(c => c.otn), ['3047', '3049'], 'som förut');
  assert.equal(tag.stops.length, 0, 'Vedum är för långt bort för de vanliga');
  // Mina: de egna, också längre bort och längs vår linje, och de vanliga döljs med antal
  const m = setup(rows, { buses, own, connMode: 'mina' });
  assert.equal(m.connMode, 'mina');
  assert.deepEqual(m.connections.map(c => [c.kind, c.ident, c.status]), [['tåg', '24362', 'ok'], ['tåg', '182', 'ok'], ['buss', '601', 'ok']]);
  assert.ok(m.connections.every(c => c.own));
  assert.equal(m.connections.find(c => c.ident === '182').transferMin, 44);
  assert.deepEqual(m.connectionsHidden, { tåg: 2, buss: 1 }, '3047, 3049 och buss 600 dolda');
  assert.deepEqual(m.stops.map(st => [st.sig, st.connections.map(c => c.otn)]), [['Vdm', ['X9']]], 'Vedum längre bort än 30 min');
  assert.equal(m.missed, 0, 'varningarna följer valet: 3047 som missas räknas inte');
  // Status per post: hittad, inte i dag, inte på linjen
  const st = Object.fromEntries(m.ownStatus.map(x => [`${x.kind} ${x.id}`, x]));
  assert.equal(st['tåg 182'].found, true);
  assert.equal(st['tåg x9'].found, true, 'tågnumret jämförs utan stor och liten bokstav');
  assert.deepEqual([st['tåg 999'].found, st['tåg 999'].onLine, st['tåg 999'].stop], [false, true, true]);
  assert.equal(st['buss 5'].onLine, false);
  // Markerade (★) syns också i Mina
  const withMark = setup(rows, { buses, own, connMode: 'mina', marked: new Set(['ut|Hr|tåg|3049']) });
  assert.deepEqual(withMark.connections.map(c => c.otn).filter(x => x === '3049'), ['3049']);
  assert.equal(withMark.tight, 1, 'den markerade räknas');
  // Varningar för alla: de egna räknas med de vanliga
  const all = setup(rows, { buses, own, connMode: 'mina', connAlerts: false });
  assert.equal(all.missed, 1, '3047');
  assert.ok(all.alert.connections.some(c => c.ident === '182'));
});

test('egna anslutningar: knapp eller missad ger förslaget att ringa trafikledningen, och knappt enligt plan varnar inte', () => {
  // 3061 har enligt tidtabell 2 min att byta i Herrljunga (11:40 → 11:42), 3047 har 5 min
  const rows = departures([['3061', '11:42'], ['3047', '11:45']]);
  const own = [{ kind: 'tåg', id: '3061', sig: 'Hr' }, { kind: 'tåg', id: '3047', sig: 'Hr' }];
  // I tid: 3061 är knapp som planerat – visas, men varnar inte och ger inget förslag
  const ok = setup(rows, { own, connMode: 'mina' });
  const c61 = ok.connections.find(c => c.otn === '3061');
  assert.deepEqual([c61.status, c61.transferMin, c61.plannedTransferMin, c61.asPlanned, c61.level], ['knappt', 2, 2, true, 0]);
  assert.equal(ok.actions.length, 0);
  assert.equal(ok.tight, 0);
  assert.equal(ok.attention, 0);
  assert.equal(I.alerts(ok).filter(a => a.key.startsWith('c|')).length, 0);
  assert.equal(I.announcement(ok), null, 'inget utrop för ett byte som är knappt enligt plan');
  // 6 min sena: båda missas, och de egna ger förslaget utan ★. 3061 behöver vänta tills det blir 2 min igen (6 min),
  // 3047 tills det blir 4 min (5 min).
  const late = setup(LATE().concat(rows), { own, connMode: 'mina' });
  assert.deepEqual(late.connections.map(c => [c.otn, c.status, c.level, c.own, c.marked]),
    [['3061', 'missas', 2, true, false], ['3047', 'missas', 2, true, false]]);
  assert.deepEqual(late.actions.map(a => [a.type, a.c.otn, a.waitMin]), [['hold', '3061', 6], ['hold', '3047', 5]]);
  assert.deepEqual(late.markedList.map(x => x.c.otn), ['3061', '3047'], 'sparas i körningen');
  // Förslaget gäller oavsett valet, som för ★
  const tag = setup(LATE().concat(rows), { own });
  assert.deepEqual(tag.actions.map(a => a.c.otn), ['3061', '3047']);
  // De vanliga som förut: utan egna eller ★ inget förslag
  assert.equal(setup(LATE().concat(rows)).actions.length, 0);
});

test('egna anslutningar: det föraren skriver tolkas', () => {
  assert.deepEqual(I.parseOwn('buss 600 Lidköping'), { kind: 'buss', id: '600', place: 'Lidköping' });
  assert.deepEqual(I.parseOwn('Tåg 182 från Herrljunga C'), { kind: 'tåg', id: '182', place: 'Herrljunga C' });
  assert.deepEqual(I.parseOwn('tag 3051 vid Hällekis'), { kind: 'tåg', id: '3051', place: 'Hällekis' });
  assert.deepEqual(I.parseOwn('Buss 1 i Vara'), { kind: 'buss', id: '1', place: 'Vara' });
  assert.equal(I.parseOwn('600 Lidköping'), null);
  assert.equal(I.parseOwn('buss 600'), null);
  assert.deepEqual(I.parseOwn('buss600 Vara'), { kind: 'buss', id: '600', place: 'Vara' });
  assert.deepEqual(I.normOwn([{ kind: 'buss', id: ' 600 ', sig: 'Lkp' }, { kind: 'x', id: '', sig: 'Hr' }, null]), [{ kind: 'buss', id: '600', sig: 'Lkp' }]);
});

test('vårt tåg i flera delar (ett OTN var, samma ATN): ihopslaget, och delarna räknas inte som andra tåg', () => {
  // ATN 3349 som 23349 Lkp–Vr och 23350 Vr–Hr (tågnumret byts i Vara)
  const a = (otn, sig, kind, hhmm) => ann(otn, sig, kind, hhmm, { AdvertisedTrainIdent: '3349' });
  const rows = [a('23349', 'Lkp', 'd', '11:00'), a('23349', 'Jp', 'a', '11:10'), a('23349', 'Jp', 'd', '11:11'), a('23349', 'Vr', 'a', '11:20'),
    a('23350', 'Vr', 'd', '11:21'), a('23350', 'Vdm', 'a', '11:30'), a('23350', 'Vdm', 'd', '11:31'), a('23350', 'Hr', 'a', '11:40')];
  const trains = I.groupTrains(rows.concat(MEET()));
  const our = I.mergeTrains([trains.get('23349|2026-11-25'), trains.get('23350|2026-11-25')]);
  assert.deepEqual(our.otns, ['23349', '23350']);
  assert.equal(our.ident, '3349');
  const vr = our.at.get('Vr');
  assert.equal(vr.arr.otn, '23349');
  assert.equal(vr.dep.otn, '23350');
  const line = I.buildLine(our, 'Lkp', 'Hr');
  assert.deepEqual(line.map(l => l.sig), ['Lkp', 'Jp', 'Vr', 'Vdm', 'Hr']);
  assert.ok(I.isOurs(trains.get('23350|2026-11-25'), our));
  assert.ok(!I.isOurs(trains.get('24360|2026-11-25'), our));
  trains.set(our.key, our);
  trains.delete('23350|2026-11-25');
  const m = I.compute({ line, trains, ourKey: our.key, known: new Map(), now: at('10:50'), routeNames: ROUTE });
  assert.deepEqual(m.meetings.map(x => x.otn), ['24360'], 'bara det mötande tåget, inte vår andra del');
  // Ett tåg i en del blir som det var
  const one = I.mergeTrains([trains.get('24360|2026-11-25')]);
  assert.deepEqual(one.otns, ['24360']);
  assert.equal(I.mergeTrains([]), null);
  // Frågan gäller OTN eller ATN
  assert.match(I.queryOurTrain('3349', at('11:00')), /<OR><EQ name="OperationalTrainNumber" value="3349" \/><EQ name="AdvertisedTrainIdent" value="3349" \/><\/OR>/);
});

// ── Trafikverkets infrastruktur: linjeboken och järnvägsnätsbeskrivningen (railtimer-infra.js) ──
// Testlinjen Lkp – Jp – Vr – Vdm – Hr med spårtypen k mellan Vara och Vedum
const INFRA = k => ({ lines: [`Lkp E Jp E Vr ${k} Vdm E Hr`], meet: '', platforms: {} });

test('linjeboken: spårtyp mellan två platser – grannar, längre sträckor, blandat, inom driftplats och olika linjer', () => {
  const X = { lines: ['Aa E Bb E Cc D Dd D Ee', 'Ee - Ff - Gg D Hh', 'Kk D Ll ? Mm'] };
  assert.equal(I.trackKind(X, 'Aa', 'Bb'), 'E');
  assert.equal(I.trackKind(X, 'Bb', 'Aa'), 'E', 'åt båda hållen');
  assert.equal(I.trackKind(X, 'Aa', 'Cc'), 'E', 'inte grannar: alla delar emellan enkelspår');
  assert.equal(I.trackKind(X, 'Cc', 'Ee'), 'D');
  assert.equal(I.trackKind(X, 'Bb', 'Dd'), null, 'enkel- och dubbelspår blandat');
  assert.equal(I.trackKind(X, 'Ee', 'Ff'), null, 'inom en driftplats gäller inte termerna');
  assert.equal(I.trackKind(X, 'Gg', 'Hh'), 'D');
  assert.equal(I.trackKind(X, 'Ll', 'Mm'), null, 'blandat enligt underlaget');
  assert.equal(I.trackKind(X, 'Aa', 'Hh'), null, 'inte på samma linje');
  assert.equal(I.trackKind(X, 'Aa', 'Öö'), null, 'okänd plats');
  assert.equal(I.trackKind(X, 'Aa', 'Aa'), null);
  assert.equal(I.trackKind(null, 'Aa', 'Bb'), null, 'utan underlag');
  assert.equal(I.trackKind({ lines: ['Aa F Bb'] }, 'Aa', 'Bb'), 'D', 'flerspår räknas som dubbelspår');
  assert.equal(I.trackKind({ lines: ['Aa E Bb', 'Bb D Aa'] }, 'Aa', 'Bb'), null, 'linjer som inte är eniga');
  assert.equal(I.trackKind({ lines: ['Aa E Bb', 'Bb E Aa'] }, 'Aa', 'Bb'), 'E');
  // En plats två gånger på samma linje (en annan väg genom en driftplats): de närmaste förekomsterna gäller
  assert.equal(I.trackKind({ lines: ['Hh - Ii - Hh D Jj'] }, 'Hh', 'Jj'), 'D');
});

test('linjeboken: enkelspår går före sparat dubbelspår och före möten mellan stationerna i tidtabellen', () => {
  // 3346 möter oss mellan Vara och Vedum enligt tidtabell, och sträckan är sparad som dubbelspår (se testet ovan)
  const other = train('3346', [['Vdm', null, '11:22'], ['Vr', '11:29', '11:29'], ['Jp', '11:38', null]]);
  const late = MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:26') } } });
  const m = setup(late.concat(other), { knownDouble: ['Vdm|Vr'], infra: INFRA('E') });
  const mt = m.meetings.find(x => x.otn === '24360');
  assert.equal(mt.single, true, 'enkelspår enligt linjeboken');
  assert.equal(mt.book, true);
  // 24360 in i Vara 11:26 + 1 min: vi åker 11:27 i stället för 11:21
  assert.equal(mt.waitMin, 6);
  assert.equal(m.end.delayMin, 6);
  assert.equal(m.meetings.some(x => x.otn === '3346'), false, 'inget möte på sträckan');
  assert.deepEqual(m.doubleSections, [], 'inget dubbelspår att spara');
  assert.deepEqual(m.trackBook, { sections: 4, of: 4 });
});

test('linjeboken: dubbelspår utan möten i tidtabellen – vi väntar inte; utan linjeboken som förut', () => {
  const late = MEET({ Vr: { a: { EstimatedTimeAtLocation: T('11:26') } } });
  const m = setup(late, { infra: INFRA('D') });
  assert.equal(m.meetings[0].single, false);
  assert.equal(m.meetings[0].book, true);
  assert.equal(m.meetings[0].waitMin, 0);
  assert.equal(m.end.delayMin, 0);
  assert.deepEqual(m.doubleSections, [], 'finns i linjeboken, inget att spara');
  // Utan linjeboken: enkelspår, räknat ur tidtabellen
  const m0 = setup(late);
  assert.equal(m0.meetings[0].single, true);
  assert.equal(m0.meetings[0].book, false);
  assert.equal(m0.meetings[0].waitMin, 6);
  assert.deepEqual(m0.trackBook, { sections: 0, of: 4 });
  // Sträckor som linjeboken inte har: tidtabellen som förut
  const part = setup(late, { infra: { lines: ['Lkp E Jp'], meet: '', platforms: {} } });
  assert.deepEqual(part.trackBook, { sections: 1, of: 4 });
  assert.equal(part.meetings[0].book, false);
});

test('mötesplatser från järnvägsnätsbeskrivningen: mötet flyttas till Järpås även när inga tåg setts mötas där', () => {
  // Som "flyttat möte: det mötande tåget har åkt från Vara mot oss …", men Järpås är känd från underlaget
  const rows = MEET({ Vr: { d: { TimeAtLocationWithSeconds: T('11:21') } } });
  const book = setup(rows, { now: at('11:22'), known: LATE14, infra: { lines: [], meet: 'Jp Hr', platforms: {} } });
  const mt = book.meetings[0];
  assert.equal(mt.at, 'Jp');
  assert.equal(mt.ourDep, at('11:31'));
  assert.equal(book.end.delayMin, 19);
  assert.deepEqual(book.meetPlaces, ['Vr'], 'Vara ur tidtabellen sparas, Järpås finns i underlaget');
  // Utan någon känd mötesplats mellan oss och Vara blir det inte Järpås
  const none = setup(rows, { now: at('11:22'), known: LATE14 });
  assert.notEqual(none.meetings[0].at, 'Jp');
});

test('plattformar: samma eller annan plattform enligt järnvägsnätsbeskrivningen', () => {
  const X = { platforms: { Hrc: '2,3,1|5,4|6|7', Lkp: '1|2', A: '1A,2' } };
  assert.deepEqual(I.platformInfo(X, 'Hrc', '2', '3'), { same: true, shared: ['3', '1'] });
  assert.deepEqual(I.platformInfo(X, 'Hrc', '1', '5'), { same: false, shared: ['2', '3'] });
  assert.deepEqual(I.platformInfo(X, 'Hrc', '6', ''), { same: null, shared: [] }, 'deras spår okänt');
  assert.deepEqual(I.platformInfo(X, 'Hrc', '9', '3'), { same: null, shared: [] }, 'vårt spår har ingen plattform enligt underlaget');
  assert.deepEqual(I.platformInfo(X, 'Hrc', '2', '2'), { same: null, shared: ['3', '1'] }, 'samma spår');
  assert.equal(I.platformInfo(X, 'Lkp', '1', '2').same, false);
  assert.equal(I.platformInfo(X, 'A', '1a', '2').same, true, 'stor och liten bokstav');
  assert.equal(I.platformInfo(X, 'Vaa', '1', '2'), null, 'platsen saknas');
  assert.equal(I.platformInfo(null, 'Hrc', '2', '3'), null);
});

test('plattformar i Info: samma eller annan plattform i anslutningen, förslaget att ringa och utropet', () => {
  // Vi kommer till Herrljunga på spår 2 (+6). 3047 spår 3 missas, 3049 spår 5 knappt, 417 spår 3 hinns.
  const ourRows = train('23349', [['Lkp', null, '11:00'], ['Jp', '11:10', '11:11'], ['Vr', '11:20', '11:21'], ['Vdm', '11:30', '11:31'],
    ['Hr', '11:40', null, { a: { TrackAtLocation: '2' } }]]);
  const deps = departures([['3047', '11:45'], ['3049', '11:49', { TrackAtLocation: '5' }], ['417', '11:55']]);
  const marked = new Set(['ut|Hr|tåg|3047', 'ut|Hr|tåg|3049']);
  const infra = { lines: [], meet: '', platforms: { Hr: '2,3,1|5,4|6|7' } };
  const m = setup(LATE().concat(deps), { ourRows, marked, infra });
  assert.equal(m.end.track, '2');
  assert.deepEqual(m.connections.map(c => [c.otn, c.track, c.samePlatform]), [['3047', '3', true], ['3049', '5', false], ['417', '3', true]]);
  const names = new Map([...ROUTE, ['G', 'Göteborg C']]);
  const opts = { name: s => names.get(s) || s, clock: t => new Date(Math.round(t / 60000) * 60000).toTimeString().slice(0, 5) };
  assert.deepEqual(m.actions.map(a => I.actionText(a, opts).sub), [
    'Herrljunga C → Göteborg C 11:45 · vi spår 2, 3047 spår 3 – samma plattform',
    'Herrljunga C → Göteborg C 11:49 · vi spår 2, 3049 spår 5 – annan plattform; spår 3 och 1 vid vår'
  ]);
  assert.match(I.announcement(m, opts).sv, /Tåget mot Göteborg C 11:55 hinner ni, det går från spår 3 på samma plattform\.$/);
  assert.match(I.announcement(m, opts).en, /departing from track 3 on the same platform\.$/);
  // Deras spår okänt: vilka spår som ligger vid vår plattform
  const noTrack = Object.assign({}, m.actions[0], { theirTrack: '' });
  assert.equal(I.actionText(noTrack, opts).sub, 'Herrljunga C → Göteborg C 11:45 · vi spår 2 – spår 3 och 1 vid samma plattform');
  // Utan underlaget: frågan som förut, och inget om plattformen i utropet
  const m0 = setup(LATE().concat(deps), { ourRows, marked });
  assert.equal(m0.connections[0].samePlatform, undefined);
  assert.equal(I.actionText(m0.actions[0], opts).sub, 'Herrljunga C → Göteborg C 11:45 · vi spår 2, 3047 spår 3 – samma plattform?');
  assert.match(I.announcement(m0, opts).sv, /det går från spår 3\.$/);
});


test('tågpositioner: bara dagens körning när avgångsdatumet anges, och raderade räknas inte', () => {
  // Provet 2026-11-26: Trafikverket hade gårdagens 23248 bredvid dagens
  const list = [
    { Train: { OperationalTrainNumber: '23248', OperationalTrainDepartureDate: '2026-11-25T00:00:00.000+01:00' }, Position: { WGS84: 'POINT (15.11 59.07)' }, TimeStamp: '2026-11-25T08:57:01.000+01:00', Speed: 0 },
    { Train: { OperationalTrainNumber: '23248', OperationalTrainDepartureDate: '2026-11-26T00:00:00.000+01:00' }, Position: { WGS84: 'POINT (14.61 58.99)' }, TimeStamp: '2026-11-26T08:36:28.000+01:00', Speed: 0, Bearing: 73 },
    { Train: { OperationalTrainNumber: '23248', OperationalTrainDepartureDate: '2026-11-26T00:00:00.000+01:00' }, Position: { WGS84: 'POINT (14.70 59.00)' }, TimeStamp: '2026-11-26T08:40:00.000+01:00', Deleted: true }
  ];
  const today = I.parsePositions(list, { date: '2026-11-26' }).get('23248');
  assert.equal(today.date, '2026-11-26');
  assert.equal(today.lon, 14.61);
  assert.equal(today.bearing, 73);
  assert.equal(I.parsePositions(list, { date: '2026-11-24' }).size, 0, 'ingen position för en annan dag');
  assert.equal(I.parsePositions(list).get('23248').t, Date.parse('2026-11-26T08:36:28.000+01:00'), 'utan datum: den senaste som inte är raderad');
  assert.ok(I.queryPositions(['23248']).includes('<INCLUDE>Train.OperationalTrainDepartureDate</INCLUDE>'));
});

test('störningar: händelsetypen i ord, var händelsen är och att det är ett fordonsfel (provet 2026-11-26)', () => {
  // O261126-030 i provet: fordonsfel mellan Veas och Vpm, påverkan Vänersborg – Göteborg C till 11:00, inget tågnummer
  const raw = {
    OperativeEventId: 'O261126-030', EventType: { Description: 'Dragfordon/motorvagn', EventTypeCode: '34' },
    StartDateTime: '2026-11-26T08:19:39.236+01:00', EventState: 1,
    EventSection: [{ FromLocation: { Signature: 'Veas' }, ToLocation: { Signature: 'Vpm' } }],
    TrafficImpact: [{ StartDateTime: '2026-11-26T08:19:54.941+01:00', EndDateTime: '2026-11-26T11:00:00.000+01:00',
      SelectedSection: [{ SectionLocation: [{ Signature: 'Öx', Affected: true }, { Signature: 'Gas', Affected: true }, { Signature: 'G', Affected: true }] }] }]
  };
  const m = I.parseMessage(raw);
  assert.deepEqual(m.at, ['Veas', 'Vpm'], 'var händelsen är');
  assert.equal(m.vehicle, true);
  assert.equal(I.messageTitle(m), 'Fel på ett tåg (lok eller motorvagn)');
  assert.equal(m.end, Date.parse('2026-11-26T11:00:00.000+01:00'));
  // Trafikverkets egen rubrik går före
  const pub = I.parseMessage(Object.assign({}, raw, { TrafficImpact: [{ PublicMessage: { Header: 'Fordonsfel vid Trollhättan', Description: 'Tåg kan bli försenade.' } }] }));
  assert.equal(I.messageTitle(pub), 'Fordonsfel vid Trollhättan');
  assert.equal(I.messageTitle(I.parseMessage({ EventType: { Description: 'Spårväxel' } })), 'Växelfel');
  assert.equal(I.messageTitle(I.parseMessage({ EventType: { Description: 'Spår (t.ex. solkurva, skevningsfel, spårlägesfel)' } })), 'Fel på spåret');
  assert.equal(I.messageTitle(I.parseMessage({ EventType: { Description: 'Annat (järnväg)' } })), 'Trafikstörning');
});

test('störningar längs vägen: när vi är där, klar före oss räknas inte, och texten säger vad, var och sedan när', () => {
  const messages = [
    // Fordonsfel Vara–Vedum som pågår till 13:00
    { Id: 'f', EventType: { Description: 'Dragfordon/motorvagn' }, StartDateTime: T('10:20'),
      TrafficImpact: [{ FromLocation: [{ Signature: 'Vr' }], ToLocation: [{ Signature: 'Vdm' }], EndDateTime: T('13:00') }] },
    // Växelfel i Vedum som är klart 11:15, innan vi är där (11:30); nu är 10:55
    { Id: 'v', EventType: { Description: 'Spårväxel' }, StartDateTime: T('10:00'),
      TrafficImpact: [{ Location: { LocationSignature: 'Vdm' }, EndDateTime: T('11:15') }] }
  ];
  const m = setup([], { messages });
  const f = m.messages.find(x => x.id === 'f'), v = m.messages.find(x => x.id === 'v');
  assert.equal(f.title, 'Fel på ett tåg (lok eller motorvagn)');
  assert.equal([f.clear, f.level].join(), 'false,1', 'pågår när vi är där');
  assert.ok(f.ourT != null && f.i < v.i, 'Vara före Vedum, med vår tid där');
  assert.equal([v.clear, v.level].join(), 'true,0', 'klar innan vi är där');
  const name = s => ({ Vr: 'Vara', Vdm: 'Vedum' })[s] || s;
  const clock = t => new Date(Math.round(t / 60000) * 60000).toTimeString().slice(0, 5);
  const list = I.alerts(m, { name, clock }).filter(a => a.kind === 'storning');
  assert.deepEqual(list.map(a => a.text), [`Fel på ett tåg (lok eller motorvagn) vid Vara – Vedum, sedan ${clock(at('10:20'))}`], 'bara den som pågår');
  assert.equal(list[0].short, 'störning Vara');
  assert.equal(list[0].say, 'Trafikstörning vid Vara: fel på ett tåg (lok eller motorvagn).');
});
