'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AN = require('../railtimer-analys.js');

// Klockslag 2026-10-15 (torsdag) i lokal tid som ISO-sträng – testerna beror inte på datorns tidszon
function at(h, m, s, day) { return new Date(2026, 9, day || 15, h, m, s || 0).toISOString(); }

// En station i en körning. Tider anges som [tim, min, sek] eller [tim, min, sek, dag].
// sArr/sDep är tågorderns tider (operationalArrival/-Departure); de annonserade sätts lika om inte aArr/aDep anges.
// advertisedOnly: körning före appversion 2026-11-25f, bara annonserade tider (aArr/aDep, annars sArr/sDep).
function stop(name, o) {
  const opt = o || {};
  const t = v => (v ? at(...v) : null);
  return {
    name,
    actualArrival: t(opt.arr),
    actualDeparture: t(opt.dep),
    scheduledArrival: t(opt.aArr || opt.sArr),
    scheduledDeparture: t(opt.aDep || opt.sDep),
    operationalArrival: opt.advertisedOnly ? null : t(opt.sArr),
    operationalDeparture: opt.advertisedOnly ? null : t(opt.sDep),
    arrivalSource: opt.arr ? 'gps' : '',
    departSource: opt.pass ? 'gps-pass' : (opt.dep ? 'gps' : ''),
    shouldStop: opt.shouldStop == null ? true : opt.shouldStop
  };
}

function run(id, stops, extra) {
  return Object.assign({ id, trainNumber: '3344', vehicleType: 'Y31', startedAt: stops[0].actualDeparture, aborted: false, stops }, extra || {});
}

const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≠ ${expected}`);

// ── Stationsnamn ──

test('canonicalStation: kända namnbyten och stavning från Trafikverket', () => {
  assert.equal(AN.canonicalStation('Herrljunga'), 'Herrljunga C');
  assert.equal(AN.canonicalStation('Hallsberg personbangård'), 'Hallsberg');
  assert.equal(AN.canonicalStation('Framnäs City'), 'Framnäs city');
  assert.equal(AN.canonicalStation(' Källby '), 'Källby');
});

test('normalizeRuns: alias, vanligaste stavningen vid skiftlägesvarianter, och indata ändras inte', () => {
  const runs = [
    run('a', [stop('Herrljunga', { dep: [7, 0] }), stop('Vedum', { arr: [7, 9] })], { startStation: 'Herrljunga', endStation: 'Vedum' }),
    run('b', [stop('VEDUM', { dep: [8, 0] }), stop('Vara', { arr: [8, 9] })]),
    run('c', [stop('Vedum', { dep: [9, 0] }), stop('Vara', { arr: [9, 9] })])
  ];
  const out = AN.normalizeRuns(runs);
  assert.equal(out[0].stops[0].name, 'Herrljunga C');
  assert.equal(out[0].startStation, 'Herrljunga C');
  assert.equal(out[1].stops[0].name, 'Vedum', 'den vanligaste stavningen vinner');
  assert.equal(runs[0].stops[0].name, 'Herrljunga', 'indata ändras inte');
  assert.equal(runs[1].stops[0].name, 'VEDUM');
});

// ── Tid och urval ──

test('timeOfDay: gränserna 05, 09, 15 och 18', () => {
  const tod = (h, m) => AN.timeOfDay(new Date(2026, 9, 15, h, m));
  assert.deepEqual([tod(4, 59), tod(5, 0), tod(8, 59), tod(9, 0), tod(14, 59), tod(15, 0), tod(17, 59), tod(18, 0)],
    ['kvall', 'morgon', 'morgon', 'dag', 'dag', 'eftermiddag', 'eftermiddag', 'kvall']);
});

test('dayType: lördag och söndag är helg', () => {
  assert.equal(new Date(2026, 9, 18).getDay(), 0, 'testdatumet ska vara en söndag');
  assert.equal(AN.dayType(new Date(2026, 9, 17, 12)), 'helg');
  assert.equal(AN.dayType(new Date(2026, 9, 18, 23, 59)), 'helg');
  assert.equal(AN.dayType(new Date(2026, 9, 19, 0, 0)), 'vardag');
});

test('runMatches: avbrutna, tåg, lokalt datum, tid på dygnet och dag utgår från verklig avgång', () => {
  const morning = run('m', [stop('A', { dep: [8, 55] }), stop('B', { arr: [9, 5] })], { startedAt: at(8, 50) });
  const evening = run('e', [stop('A', { dep: [0, 30, 0, 18] }), stop('B', { arr: [0, 50, 0, 18] })]); // natten till söndag
  assert.equal(AN.runMatches(Object.assign({}, morning, { aborted: true }), {}), false);
  assert.equal(AN.runMatches(morning, { train: '3344' }), true);
  assert.equal(AN.runMatches(morning, { train: '3345' }), false);
  assert.equal(AN.runMatches(morning, { timeOfDay: 'morgon' }), true);
  assert.equal(AN.runMatches(morning, { timeOfDay: 'dag' }), false);
  assert.equal(AN.runMatches(evening, { dayType: 'helg', timeOfDay: 'kvall' }), true);
  assert.equal(AN.runMatches(evening, { dateFrom: '2026-10-18', dateTo: '2026-10-18' }), true, 'lokalt datum, inte UTC');
  assert.equal(AN.runMatches(evening, { dateTo: '2026-10-17' }), false);
  const noDeparture = run('x', [stop('A', {}), stop('B', { arr: [10, 0] })], { startedAt: at(6, 0) });
  assert.equal(AN.timeOfDay(AN.runStart(noDeparture)), 'morgon', 'utan avgång används startedAt');
});

test('classify: exakt ±tolerans är i tid', () => {
  assert.deepEqual([AN.classify(1, 1), AN.classify(1.0001, 1), AN.classify(-1, 1), AN.classify(-1.0001, 1)], ['itid', 'sen', 'itid', 'tidig']);
  assert.deepEqual([AN.classify(0.6, 0.5), AN.classify(1.9, 2), AN.classify(null, 1)], ['sen', 'itid', null]);
});

test('stopType: genomfart och ej planerat stopp är passage', () => {
  assert.equal(AN.stopType(stop('A', { dep: [7, 0] })), 'stopp');
  assert.equal(AN.stopType(stop('A', { arr: [7, 0], dep: [7, 0, 5], pass: true })), 'passage');
  assert.equal(AN.stopType(stop('A', { arr: [7, 0], dep: [7, 1], shouldStop: false })), 'passage');
});

// ── Observationer ──

test('segmentObservations: planerad gångtid, och passagepunkt med bara planerad avgång', () => {
  const r = run('p', [
    stop('A', { dep: [7, 0], sDep: [7, 0] }),
    stop('B', { arr: [7, 3, 30], dep: [7, 3, 40], sDep: [7, 3], pass: true, shouldStop: false }),
    stop('C', { arr: [7, 7], sArr: [7, 6] })
  ]);
  const obs = AN.segmentObservations([r], { tolerance: 1 });
  assert.deepEqual(obs.map(o => o.key), ['A → B', 'B → C']);
  close(obs[0].actual, 3.5, 'A → B verklig');
  assert.equal(obs[0].planned, 3);
  close(obs[0].deviation, 0.5, 'A → B avvikelse');
  assert.equal(obs[0].category, 'itid');
  close(obs[1].actual, 10 / 3, 'B → C verklig');
  assert.equal(obs[1].planned, 3, 'planerad passage i B räknas som avgång');
  assert.deepEqual([obs[0].toType, obs[1].fromType], ['passage', 'passage']);
});

test('segmentObservations: utan tidtabell, orimliga tider och excludeInboundRun', () => {
  const r = run('q', [
    stop('A', { dep: [7, 0] }),
    stop('B', { arr: [7, 0, 3], dep: [7, 1] }),
    Object.assign(stop('C', { arr: [7, 5], dep: [7, 6] }), { excludeInboundRun: true }),
    stop('D', { arr: [7, 10] })
  ]);
  const obs = AN.segmentObservations([r], {});
  assert.deepEqual(obs.map(o => o.key), ['C → D'], 'A → B är kortare än 0,1 min och B → C är undantagen');
  assert.equal(obs[0].planned, null);
  assert.equal(obs[0].category, null);
});

// ── Export ──

test('csvDocument: BOM, citattecken, semikolon, decimalkomma och sektioner', () => {
  const text = AN.csvDocument('RailTimer – Test', [['Bygger på', '3 körningar']], [
    { title: 'Sträckor', header: ['Sträcka', 'Median', 'Antal'], rows: [['A → B', 2.46, 3], ['B "C"', -0.04, null]] }
  ]);
  assert.equal(text.charCodeAt(0), 0xFEFF);
  assert.equal(text.slice(1), [
    '"RailTimer – Test"',
    '"Bygger på";"3 körningar"',
    '',
    '"Sträckor"',
    '"Sträcka";"Median";"Antal"',
    '"A → B";"2,5";"3"',
    '"B ""C""";"0,0";""'
  ].join('\n'));
});

test('stats och formatMinutes', () => {
  const s = AN.stats([4, 1, 3, 2, null]);
  assert.equal(s.n, 4);
  close(s.median, 2.5, 'median');
  close(s.p90, 3.7, 'p90');
  close(s.mean, 2.5, 'medel');
  close(s.p10, 1.3, 'p10');
  assert.deepEqual(AN.stats([]), { n: 0, median: null, p90: null, mean: null, p10: null });
  assert.deepEqual([AN.formatMinutes(3.26), AN.formatMinutes(-1.04), AN.formatMinutes(null), AN.formatMinutes(2, 0)], ['3,3', '-1,0', '', '2']);
});

// ── Analys per tåg ──

test('clockMinutes: minuter efter midnatt räknade på klockslag, även när vintertiden börjar', () => {
  assert.equal(AN.clockMinutes(at(7, 30), at(7, 0)), 450);
  assert.equal(AN.clockMinutes(at(0, 15, 0, 16), at(23, 50)), 1455, 'efter midnatt räknas vidare');
  // 25 oktober 2026 ställs klockan tillbaka 03:00 → 02:00. 07:00 är ändå 420 minuter efter midnatt.
  assert.equal(AN.clockMinutes(new Date(2026, 9, 25, 7, 0), new Date(2026, 9, 25, 6, 0)), 420);
  assert.equal(AN.clockMinutes(null, at(7, 0)), null);
});

test('segmentObservations: planerat och verkligt stoppmönster och planerad avgång som klockslag', () => {
  const r = run('m', [
    stop('A', { dep: [7, 0], sDep: [7, 0] }),
    stop('B', { arr: [7, 3], dep: [7, 3, 5], sArr: [7, 3], sDep: [7, 3], pass: true }),   // planerat stopp som passerades
    stop('C', { arr: [7, 7], dep: [7, 7, 5], sDep: [7, 7], pass: true, shouldStop: false }),
    stop('D', { arr: [7, 10], sArr: [7, 10] })
  ]);
  const obs = AN.segmentObservations([r], {});
  assert.deepEqual(obs.map(o => [o.key, o.plannedPattern, o.actualPattern, o.order]),
    [['A → B', 'SS', 'SP', 420], ['B → C', 'SP', 'PP', 423], ['C → D', 'PS', 'PS', 427]]);
  assert.equal(AN.plannedType(r.stops[1]), 'stopp', 'planerat stopp även när tåget passerade');
  assert.equal(AN.PATTERN_LABELS.SP, 'Stopp–passage');
});

test('segmentNeeds: gångtid per sträcka och verkligt stoppmönster, från alla körningar', () => {
  const stopping = [0, 1, 2].map(k => run('s' + k, [
    stop('A', { dep: [7, 0] }), stop('B', { arr: [7, 4], dep: [7, 5] }), stop('C', { arr: [7, 9] })
  ], { trainNumber: k === 0 ? '3344' : '3346' }));
  const passing = [0, 1].map(k => run('p' + k, [
    stop('A', { dep: [8, 0] }), stop('B', { arr: [8, 3, 30], dep: [8, 3, 35], pass: true }), stop('C', { arr: [8, 7, 35] })
  ]));
  const needs = AN.segmentNeeds(AN.segmentObservations(stopping.concat(passing), {}));
  assert.deepEqual(needs.map(n => [n.key, n.n, n.median]), [
    ['A → B|*', 5, 4], ['A → B|SP', 2, 3.5], ['A → B|SS', 3, 4],
    ['B → C|*', 5, 4], ['B → C|PS', 2, 4], ['B → C|SS', 3, 4]
  ], 'en rad per verkligt mönster och en (*) med alla mätningar på sträckan');
  const ss = needs.find(n => n.key === 'A → B|SS');
  assert.deepEqual([ss.segment, ss.from, ss.to, ss.pattern], ['A → B', 'A', 'B', 'SS']);
});

test('stationTimes: tappad tid vid uppehåll, avgång från start och passage', () => {
  const r = run('t', [
    stop('A', { dep: [7, 1], sDep: [7, 0] }),                                     // start: 1 min sen
    stop('B', { arr: [7, 3], dep: [7, 6, 30], sArr: [7, 5], sDep: [7, 6] }),         // 2 min tidig, åker 0,5 min sent: tappar 0,5
    stop('C', { arr: [7, 10], dep: [7, 13], sArr: [7, 9], sDep: [7, 10] }),          // 1 min sen, åker 3 min sent: tappar 2
    stop('P', { arr: [7, 15], dep: [7, 15, 6], sDep: [7, 13], pass: true, shouldStop: false }),   // passerar 2 min sent: tappar 0,1
    stop('X', { dep: [7, 17], sArr: [7, 16], sDep: [7, 16] }),                      // ingen mätt ankomst (avbrott): räknas inte
    stop('D', { arr: [7, 20], sArr: [7, 18] })
  ]);
  const t = AN.stationTimes([r]);
  assert.deepEqual(t.map(x => [x.station, x.type]), [['A', 'start'], ['B', 'stopp'], ['C', 'stopp'], ['P', 'passage']]);
  const [a, b, c, p] = t;
  assert.deepEqual([a.arrivalDev, a.departureDev, a.lost, a.plannedClock], [null, 1, 1, 420]);
  assert.deepEqual([b.arrivalDev, b.departureDev, b.lost, b.dwell, b.plannedDwell], [-2, 0.5, 0.5, 3.5, 1]);
  assert.deepEqual([c.arrivalDev, c.departureDev, c.lost, c.dwell], [1, 3, 2, 3]);
  close(p.lost, 0.1, 'passage');
  assert.equal(p.plannedDwell, null);
  assert.deepEqual([b.train, b.date, b.weekday, b.runId, b.stopped], ['3344', '2026-10-15', 4, 't', true]);
});

// Två tåg A → B → C med olika planerad tid B → C (3344: 6 min, 3346: 2 min); B → C tar 4 min för båda.
// 3344 tappar 2,5 min i B den 15:e. Tåg 3355 har ingen tidtabell.
function trainFixture() {
  const t3344 = [13, 14, 15].map(day => run('a' + day, [
    stop('A', { dep: [7, 0, 0, day], sDep: [7, 0, 0, day] }),
    stop('B', { arr: [7, 3, 0, day], dep: day === 15 ? [7, 6, 30, day] : [7, 4, 0, day], sArr: [7, 3, 0, day], sDep: [7, 4, 0, day] }),
    stop('C', { arr: day === 15 ? [7, 10, 30, day] : [7, 8, 0, day], sArr: [7, 10, 0, day] })
  ], { trainNumber: '3344' }));
  const t3346 = [13, 14, 15].map(day => run('b' + day, [
    stop('A', { dep: [10, 0, 0, day], sDep: [10, 0, 0, day] }),
    stop('B', { arr: [10, 3, 0, day], dep: [10, 4, 0, day], sArr: [10, 3, 0, day], sDep: [10, 4, 0, day] }),
    stop('C', { arr: [10, 8, 0, day], sArr: [10, 6, 0, day] })
  ], { trainNumber: '3346' }));
  const none = run('x', [stop('C', { dep: [12, 0] }), stop('B', { arr: [12, 4], dep: [12, 5] }), stop('A', { arr: [12, 8] })], { trainNumber: '3355' });
  return t3344.concat(t3346, [none]);
}

test('summarizeTrains: varje tåg mot sin egen tidtabell och vad sträckan tar', () => {
  const runs = trainFixture();
  const needs = AN.segmentNeeds(AN.segmentObservations(runs, {}));
  const res = AN.summarizeTrains(runs, needs, { tolerance: 1 });
  assert.deepEqual(res.rows.map(r => r.train), ['3344', '3346'], 'tåg med tillfällen först vid lika många körningar');
  assert.deepEqual(res.withoutTimetable, { trains: 1, runs: 1 });
  const a = res.rows[0];
  assert.deepEqual([a.runCount, a.timetableRuns, a.routeLabel, a.route], [3, 3, 'A → C', ['A', 'B', 'C']]);
  assert.deepEqual(a.segments.map(s => [s.segment, s.pattern, s.planned, s.need.median, s.need.n, s.margin, s.assessment]),
    [['A → B', 'SS', 3, 3, 6, 0, 'lagom'], ['B → C', 'SS', 6, 4, 6, 2, 'generos']]);
  assert.deepEqual([a.margin.sum, a.margin.count, a.margin.of, a.margin.planned, a.margin.need], [2, 2, 2, 9, 7]);
  assert.deepEqual(a.events.map(e => [e.station, e.type, e.lost, e.date]), [['B', 'stopp', 2.5, '2026-10-15']]);
  assert.deepEqual([a.eventCount, a.lostMax, a.startDelay.median, a.endDelay.median], [1, 2.5, 0, -2]);
  assert.deepEqual(a.dwells.map(d => [d.station, d.plannedDwell, d.dwell.median, d.lost.median, d.events]), [['B', 1, 1, 0, 1]]);
  const b = res.rows[1];
  assert.deepEqual(b.segments.map(s => [s.planned, s.margin, s.assessment]), [[3, 0, 'lagom'], [2, -2, 'snal']]);
  assert.deepEqual([b.margin.sum, b.eventCount, b.lostMax, b.endDelay.median], [-2, 0, null, 2]);
});

test('summarizeTrains: ändrad tidtabell, toleransen och stationstyp', () => {
  const runs = trainFixture();
  // Tåg 3346 hade tidigare 3 min B → C (ankomst 10:07 den 13:e och 14:e); den senaste körningen har 2 min
  runs.filter(r => r.trainNumber === '3346' && r.id !== 'b15').forEach(r => { r.stops[2].operationalArrival = at(10, 7, 0, Number(r.id.slice(1))); });
  const needs = AN.segmentNeeds(AN.segmentObservations(runs, {}));
  const b = AN.summarizeTrains(runs, needs, { tolerance: 1 }).rows.find(r => r.train === '3346');
  assert.deepEqual([b.segments[1].planned, b.segments[1].plannedPrev], [2, [3]]);
  const count = opts => AN.summarizeTrains(runs, needs, opts).rows.find(r => r.train === '3344').eventCount;
  assert.equal(count({ tolerance: 3 }), 0, 'tolerans 3 min');
  assert.equal(count({ tolerance: 1, stationType: 'passage' }), 0, 'bara stopp vid passage');
  assert.equal(count({ tolerance: 1, stationType: 'stopp' }), 1, 'uppehåll och avgång från start');
});

test('segmentPlans: planerad tid per tåg på samma sträcka och bedömningen Snål och generös', () => {
  const runs = trainFixture();
  const obs = AN.segmentObservations(runs, {});
  const needs = AN.segmentNeeds(obs);
  const rows = AN.segmentPlans(obs, needs, { tolerance: 1 });
  assert.deepEqual(rows.map(r => [r.segment, r.pattern, r.assessment, r.spread]), [['B → C', 'SS', 'blandad', 4], ['A → B', 'SS', 'lagom', 0]]);
  assert.deepEqual(rows[0].plans.map(p => [p.planned, p.trains, p.n, p.margin, p.assessment]),
    [[2, ['3346'], 3, -2, 'snal'], [6, ['3344'], 3, 2, 'generos']]);
  assert.deepEqual(rows[1].plans.map(p => [p.planned, p.trains, p.n]), [[3, ['3344', '3346'], 6]]);
  assert.equal(AN.segmentPlans(obs, needs, { tolerance: 1, stationType: 'passage' }).length, 0, 'inga passager');
  assert.deepEqual(AN.segmentPlans(obs, needs, { tolerance: 1, train: '3346' }).map(r => r.plans.length), [2, 1], 'alla tågs tider på tågets sträckor');
  const fewObs = AN.segmentObservations(runs.slice(0, 2), {});
  const few = AN.segmentPlans(fewObs, AN.segmentNeeds(fewObs), { tolerance: 1 });
  assert.deepEqual(few.map(r => [r.segment, r.assessment, r.plans[0].margin]), [['A → B', 'fa', null], ['B → C', 'fa', null]]);
});

test('summarizeTrains: med för få mätningar i tågets stoppmönster används alla mätningar på sträckan', () => {
  // Tåg 3350 ska stanna i B (behovsstopp) men passerar alltid, så ingen körning har stannat där
  const runs = [13, 14, 15].map(day => run('c' + day, [
    stop('A', { dep: [9, 0, 0, day], sDep: [9, 0, 0, day] }),
    stop('B', { arr: [9, 2, 30, day], dep: [9, 2, 35, day], sArr: [9, 3, 0, day], sDep: [9, 3, 0, day], pass: true }),
    stop('C', { arr: [9, 6, 35, day], sArr: [9, 7, 0, day] })
  ], { trainNumber: '3350' }));
  const needs = AN.segmentNeeds(AN.segmentObservations(runs, {}));
  const row = AN.summarizeTrains(runs, needs, { tolerance: 1 }).rows[0];
  assert.deepEqual(row.segments.map(s => [s.segment, s.pattern, s.need.pattern, s.need.n, s.need.median, s.margin]),
    [['A → B', 'SS', '*', 3, 2.5, 0.5], ['B → C', 'SS', '*', 3, 4, 0]]);
});

test('proposeTrainTimetable: tågets egen tidtabell mot vad sträckorna tar, med avrundade klockslag', () => {
  const runs = trainFixture();
  const needs = AN.segmentNeeds(AN.segmentObservations(runs, {}));
  const p = AN.proposeTrainTimetable(runs, needs, '3346', { basis: 'median' });
  assert.deepEqual([p.route, p.runCount, p.missing], [['A', 'B', 'C'], 3, []]);
  assert.deepEqual(p.rows.map(r => [r.station, r.type, r.currentArr, r.currentDep, r.propArr, r.propDep]),
    [['A', 'start', null, 600, null, 600], ['B', 'stopp', 603, 604, 603, 604], ['C', 'slut', 606, null, 608, null]]);
  assert.deepEqual(p.rows.map(r => [r.plannedLeg, r.legValue, r.legRounded, r.legDiff]),
    [[null, null, null, null], [3, 3, 3, 0], [2, 4, 4, 2]]);
  assert.deepEqual([p.rows[1].plannedDwell, p.rows[1].dwellValue, p.rows[1].dwellN, p.rows[1].dwellSource], [1, 1, 3, 'matt']);
  assert.deepEqual([p.totalCurrent, p.totalProposed, p.totalExact], [6, 8, 8]);
  assert.equal(AN.proposeTrainTimetable(runs, needs, '3355', {}).error, 'inga-korningar', 'tåg utan tidtabell');
});

test('proposeTrainTimetable: väntan räknas inte, partiella körningar slås ihop och planerat uppehåll används utan mätningar', () => {
  // Tåg 13001: A → B → C den 13:e och C → D den 14:e. I B kommer tåget 2 min tidigt och står till planerad avgång.
  const first = run('u1', [
    stop('A', { dep: [7, 0, 0, 13], sDep: [7, 0, 0, 13] }),
    stop('B', { arr: [7, 3, 0, 13], dep: [7, 6, 0, 13], sArr: [7, 5, 0, 13], sDep: [7, 6, 0, 13] }),
    stop('C', { arr: [7, 10, 0, 13], sArr: [7, 10, 0, 13] })
  ], { trainNumber: '13001' });
  const second = run('u2', [
    stop('C', { dep: [7, 11, 0, 14], sDep: [7, 11, 0, 14] }),
    stop('D', { arr: [7, 15, 0, 14], sArr: [7, 15, 0, 14] })
  ], { trainNumber: '13001' });
  const needs = AN.segmentNeeds(AN.segmentObservations([first, second], {}));
  const p = AN.proposeTrainTimetable([first, second], needs, '13001', { basis: 'median' });
  assert.deepEqual(p.route, ['A', 'B', 'C', 'D']);
  assert.deepEqual([p.rows[1].dwellValue, p.rows[1].dwellSource], [1, 'matt'], 'uppehållet räknas från planerad ankomst');
  assert.deepEqual([p.rows[2].plannedDwell, p.rows[2].dwellValue, p.rows[2].dwellSource], [1, 1, 'planerat']);
  assert.ok(p.rows.slice(1).every(r => r.few), 'en mätning per sträcka');
  assert.deepEqual(p.rows.map(r => [r.propArr, r.propDep]), [[null, 420], [423, 424], [428, 429], [433, null]]);
  const gap = AN.proposeTrainTimetable([first, second], needs.filter(n => n.segment !== 'B → C'), '13001', { basis: 'median' });
  assert.deepEqual(gap.missing, ['B → C']);
  assert.deepEqual(gap.rows.map(r => r.propArr), [null, 423, null, null]);
  assert.equal(gap.totalProposed, null);
});

test('stationTimes: avskuren körning (Station 1 mitt på linjen) räknar första stationen som mellanstation', () => {
  // Tåget kommer 10 min sent till B och står 0,5 min längre än planerat: det tappar 0,5 min där, inte 10,5
  const r = run('k', [
    stop('A', { dep: [7, 0], sDep: [7, 0] }),
    stop('B', { arr: [7, 15], dep: [7, 16, 30], sArr: [7, 5], sDep: [7, 6] }),
    stop('C', { arr: [7, 20], sArr: [7, 10] })
  ]);
  const sliced = AN.sliceRuns([r], 'B', 'C');
  const [b] = AN.stationTimes(sliced);
  assert.deepEqual([b.station, b.type, b.arrivalDev, b.lost], ['B', 'stopp', 10, 0.5]);
  const row = AN.summarizeTrains(sliced, AN.segmentNeeds(AN.segmentObservations(sliced, {})), { tolerance: 1 }).rows[0];
  assert.deepEqual([row.eventCount, row.startDelay.median], [0, 10.5], 'inget tillfälle; Avgång start är avgångsavvikelsen');
});

test('summarizeTrains och proposeTrainTimetable: samma tågnummer med två tidtabeller blir två rader', () => {
  // 3346 går 10:00 på vardagarna 13–15 oktober och 11:30 söndagen den 18:e (B → C planerat 5 min)
  const weekdays = trainFixture().filter(r => r.trainNumber === '3346');
  const sunday = run('sön', [
    stop('A', { dep: [11, 30, 0, 18], sDep: [11, 30, 0, 18] }),
    stop('B', { arr: [11, 33, 0, 18], dep: [11, 34, 0, 18], sArr: [11, 33, 0, 18], sDep: [11, 34, 0, 18] }),
    stop('C', { arr: [11, 38, 0, 18], sArr: [11, 39, 0, 18] })
  ], { trainNumber: '3346' });
  const all = weekdays.concat([sunday]);
  const needs = AN.segmentNeeds(AN.segmentObservations(all, {}));
  const rows = AN.summarizeTrains(all, needs, { tolerance: 1 }).rows;
  assert.deepEqual(rows.map(r => [r.key, r.label, r.train, r.timetableRuns]), [['3346 vardag', '3346 vardag', '3346', 3], ['3346 söndag', '3346 söndag', '3346', 1]]);
  assert.deepEqual([rows[0].segments[1].planned, rows[0].segments[1].plannedPrev], [2, []], 'söndagens tider blandas inte in i vardagstågets');
  const p = AN.proposeTrainTimetable(all, needs, '3346 söndag', { basis: 'median' });
  assert.deepEqual([p.label, p.runCount, p.rows[0].currentDep, p.totalCurrent], ['3346 söndag', 1, 690, 9]);
  assert.deepEqual(AN.trainVariants(trainFixture()).map(v => v.key), ['3344', '3346'], 'en tidtabell per tåg: nyckeln är tågnumret');
  const plans = AN.segmentPlans(AN.segmentObservations(all, {}), needs, { tolerance: 1, labels: new Map(AN.trainVariants(all).flatMap(v => v.runIds.map(id => [id, v.label]))) });
  assert.deepEqual(plans.find(r => r.segment === 'B → C').plans.map(x => [x.planned, x.trains]), [[2, ['3346 vardag']], [5, ['3346 söndag']]]);
});

test('summarizeTrains: Tid över räknar med tågets uppehåll, inte bara gångtiden', () => {
  // Planerat A 07:00, B 07:04/07:04 (uppehåll 0), C 07:09. Tåget kör 4 + 4 min men står 1 min i B:
  // gångtiden har 1 min över på B → C, men den minuten går åt till uppehållet
  const runs = [13, 14, 15].map(day => run('v' + day, [
    stop('A', { dep: [7, 0, 0, day], sDep: [7, 0, 0, day] }),
    stop('B', { arr: [7, 4, 0, day], dep: [7, 5, 0, day], sArr: [7, 4, 0, day], sDep: [7, 4, 0, day] }),
    stop('C', { arr: [7, 9, 0, day], sArr: [7, 9, 0, day] })
  ], { trainNumber: '3360' }));
  const row = AN.summarizeTrains(runs, AN.segmentNeeds(AN.segmentObservations(runs, {})), { tolerance: 1 }).rows[0];
  assert.equal(row.margin.sum, 1, 'gångtidsmarginalen');
  assert.deepEqual([row.travel.planned, row.travel.needed, row.travel.spare], [9, 9, 0], 'ingen tid över när uppehållet räknas');
});

test('summarizeTrains: sen avgång från första stationen räknas inte bland tillfällena i listan', () => {
  // Tåget går 3 min sent från A (orsaken är okänd, t.ex. sent inkommande tåg) och håller tiden därefter
  const late = run('s1', [
    stop('A', { dep: [8, 3], sDep: [8, 0] }),
    stop('B', { arr: [8, 7], dep: [8, 8], sArr: [8, 4], sDep: [8, 5] }),
    stop('C', { arr: [8, 12], sArr: [8, 9] })
  ], { trainNumber: '3370' });
  const row = AN.summarizeTrains([late], AN.segmentNeeds(AN.segmentObservations([late], {})), { tolerance: 1 }).rows[0];
  assert.deepEqual(row.events.map(e => [e.station, e.type, e.lost]), [['A', 'start', 3]], 'tillfället syns i tågkortet');
  assert.deepEqual([row.eventCount, row.lostMax, row.startDelay.median], [0, null, 3], 'men inte i listans Tappat tid; Avgång start visar det');
});

test('proposeTrainTimetable: gångtid från tågets egna körningar där de räcker, annars alla tåg', () => {
  // 3344 kör B → C på 5 min (tre egna mätningar), 3346 på 4 min; A → B tar 3 min för båda
  const runs = trainFixture().map(r => {
    if (r.trainNumber !== '3344') return r;
    const day = Number(r.id.slice(1));
    const c = Object.assign({}, r.stops[2], { actualArrival: at(7, day === 15 ? 11 : 9, day === 15 ? 30 : 0, day) });
    return Object.assign({}, r, { stops: [r.stops[0], r.stops[1], c] });
  });
  const needs = AN.segmentNeeds(AN.segmentObservations(runs, {}));
  const all = AN.proposeTrainTimetable(runs, needs, '3344', { basis: 'median' });
  const own = AN.proposeTrainTimetable(runs, needs, '3344', { basis: 'median', legSource: 'egna' });
  assert.deepEqual(all.rows.slice(1).map(r => [r.legValue, r.legSource]), [[3, 'alla'], [4.5, 'alla']], 'alla tåg: medianen av 4, 4, 4, 5, 5, 5');
  assert.deepEqual(own.rows.slice(1).map(r => [r.legValue, r.legSource, r.need.n]), [[3, 'egna', 3], [5, 'egna', 3]]);
  const few = AN.proposeTrainTimetable(runs.filter(r => r.id !== 'a15'), needs, '3344', { basis: 'median', legSource: 'egna' });
  assert.deepEqual(few.rows.slice(1).map(r => r.legSource), ['alla', 'alla'], 'färre än 3 egna mätningar: alla tåg');
});

test('proposeTrainTimetable: tågets egna gångtider bara med samma stoppmönster, annars alla tågs', () => {
  // 3344 passerade B (behovsstopp) en av tre gånger: två egna mätningar med stopp i B räcker inte, och tågets
  // mätningar med passage ska inte blandas in – då används alla tågs med stopp i B (3346:s tre och 3344:s två)
  const runs = trainFixture().map(r => r.id !== 'a14' ? r : Object.assign({}, r, {
    stops: [r.stops[0], Object.assign({}, r.stops[1], { departSource: 'gps-pass' }), r.stops[2]]
  }));
  const needs = AN.segmentNeeds(AN.segmentObservations(runs, {}));
  const own = AN.proposeTrainTimetable(runs, needs, '3344', { basis: 'median', legSource: 'egna' });
  assert.deepEqual(own.rows.slice(1).map(r => [r.legSource, r.need.pattern, r.need.n]), [['alla', 'SS', 5], ['alla', 'SS', 5]]);
});

/* Nytt tåg. Tåg 1 (tre körningar) A → B → C → D: stannar i B (1 min), passerar C. Tåg 2 (tre körningar): stannar
   även i C (1 min). Tåg 3 (tre körningar) kör D → E – ingen körning går hela A → E. Tåg 4 står 10 min i B enligt
   tidtabell (möte) och räknas inte som vanligt uppehåll. */
function newTrainFixture() {
  const out = [];
  [13, 14, 15].forEach(day => {
    out.push(run('t1-' + day, [
      stop('A', { dep: [7, 0, 0, day], sDep: [7, 0, 0, day] }),
      stop('B', { arr: [7, 3, 0, day], dep: [7, 4, 0, day], sArr: [7, 3, 0, day], sDep: [7, 4, 0, day] }),
      stop('C', { arr: [7, 6, 0, day], dep: [7, 6, 0, day], sDep: [7, 6, 0, day], pass: true, shouldStop: false }),
      stop('D', { arr: [7, 9, 0, day], sArr: [7, 9, 0, day] })
    ], { trainNumber: '1' }));
    out.push(run('t2-' + day, [
      stop('A', { dep: [8, 0, 0, day], sDep: [8, 0, 0, day] }),
      stop('B', { arr: [8, 3, 0, day], dep: [8, 4, 0, day], sArr: [8, 3, 0, day], sDep: [8, 4, 0, day] }),
      stop('C', { arr: [8, 6, 30, day], dep: [8, 7, 30, day], sArr: [8, 6, 0, day], sDep: [8, 7, 0, day] }),
      stop('D', { arr: [8, 10, 30, day], sArr: [8, 10, 0, day] })
    ], { trainNumber: '2' }));
    out.push(run('t3-' + day, [
      stop('D', { dep: [9, 0, 0, day], sDep: [9, 0, 0, day] }),
      stop('E', { arr: [9, 5, 0, day], sArr: [9, 5, 0, day] })
    ], { trainNumber: '3' }));
  });
  out.push(run('t4', [
    stop('A', { dep: [10, 0], sDep: [10, 0] }),
    stop('B', { arr: [10, 3], dep: [10, 13], sArr: [10, 3], sDep: [10, 13] }),
    stop('D', { arr: [10, 18], sArr: [10, 18] })
  ], { trainNumber: '4' }));
  return out;
}

test('proposeNewTimetable: rutten pusslas ihop, förvalda stopp, stopp och passage, uppehåll och avrundning', () => {
  const runs = newTrainFixture();
  const needs = AN.segmentNeeds(AN.segmentObservations(runs, {}));
  const p = AN.proposeNewTimetable(runs, needs, { from: 'A', to: 'E', basis: 'median' });
  assert.deepEqual(p.route, ['A', 'B', 'C', 'D', 'E'], 'ingen körning går hela vägen');
  assert.deepEqual(p.rows.map(r => [r.station, r.type, r.defaultStop]),
    [['A', 'start', false], ['B', 'stopp', true], ['C', 'stopp', true], ['D', 'passage', false], ['E', 'slut', false]], 'förvalt: där tågen oftast stannat');
  assert.deepEqual(p.rows.map(r => [r.arrRounded, r.depRounded]), [[null, 0], [3, 4], [7, 8], [11, 11], [16, null]]);
  assert.deepEqual([p.rows[1].dwellValue, p.rows[1].dwellSource, p.rows[1].dwellN], [1, 'matt', 6], 'mötet i B (10 min) räknas inte');
  assert.deepEqual([p.rows[3].type, p.rows[3].dwellValue], ['passage', null], 'D passeras: ingen stannade där mitt på en körning');
  assert.deepEqual([p.totalExact, p.totalRounded, p.missing], [15.5, 16, []]);
  const stopAtD = AN.proposeNewTimetable(runs, needs, { from: 'A', to: 'E', stops: { C: false, D: true }, dwells: { B: 2 } });
  assert.deepEqual(stopAtD.rows.map(r => [r.type, r.legValue, r.dwellValue, r.dwellSource]), [
    ['start', null, null, null], ['stopp', 3, 2, 'angivet'], ['passage', 2, null, null], ['stopp', 3, 1, 'schablon'], ['slut', 5, null, null]
  ], 'passage i C ger passagetiderna; stopp i D utan mätningar ger schablonen');
  const gap = AN.proposeNewTimetable(runs, needs.filter(n => n.segment !== 'D → E'), { from: 'A', to: 'E' });
  assert.deepEqual([gap.missing, gap.totalRounded], [['D → E'], null]);
  assert.equal(AN.proposeNewTimetable(runs, needs, { from: 'E', to: 'A' }).error, 'ingen-vag');
});

test('routeBetween: vänder inte tillbaka för att ta en genväg som en körning utan mellanstationer ger', () => {
  // Linjen A – B – C – D. Nedtåg D, C, B, A läses in först, sedan upptåg A, B, C, D och ett tåg som bara har A och D
  // (som Vara → Järpås förbi Håkantorp och Stora Levene i datan). Vägen B → A → D är lika kort som B → C → D.
  const runs = [];
  [13, 14, 15].forEach(day => runs.push(run('d' + day, [stop('D', { dep: [8, 0, 0, day] }), stop('C', { arr: [8, 3, 0, day], dep: [8, 4, 0, day] }),
    stop('B', { arr: [8, 7, 0, day], dep: [8, 8, 0, day] }), stop('A', { arr: [8, 11, 0, day] })], { trainNumber: '2' })));
  [13, 14, 15].forEach(day => runs.push(run('u' + day, [stop('A', { dep: [7, 0, 0, day] }), stop('B', { arr: [7, 3, 0, day], dep: [7, 4, 0, day] }),
    stop('C', { arr: [7, 7, 0, day], dep: [7, 8, 0, day] }), stop('D', { arr: [7, 11, 0, day] })], { trainNumber: '1' })));
  runs.push(run('x', [stop('A', { dep: [9, 0] }), stop('D', { arr: [9, 9] })], { trainNumber: '' }));
  assert.deepEqual(AN.routeBetween(runs, 'B', 'D'), ['B', 'C', 'D']);
  assert.deepEqual(AN.routeBetween(runs, 'C', 'A'), ['C', 'B', 'A'], 'åt andra hållet');
  assert.deepEqual(AN.routeBetween(runs, 'A', 'D'), ['A', 'B', 'C', 'D'], 'genvägen fylls i med mellanstationerna');
  const needs = AN.segmentNeeds(AN.segmentObservations(runs, {}));
  assert.equal(AN.proposeNewTimetable(runs, needs, { from: 'B', to: 'D', stops: { C: false } }).totalRounded, 6);
});

test('proposeNewTimetable: hur många uppehåll som väntade in avgångstiden, och verkliga uppehåll utan tidtabell före schablonen', () => {
  const runs = newTrainFixture();
  // Tåg 6 kommer 30 s sent till B och avgår 1,5 min sent: väntade inte in avgångstiden (tåg 1 och 2 gjorde det)
  [13, 14, 15].forEach(day => runs.push(run('t6-' + day, [
    stop('A', { dep: [12, 0, 0, day], sDep: [12, 0, 0, day] }),
    stop('B', { arr: [12, 3, 30, day], dep: [12, 5, 30, day], sArr: [12, 3, 0, day], sDep: [12, 4, 0, day] }),
    stop('D', { arr: [12, 9, 0, day], sArr: [12, 9, 0, day] })
  ], { trainNumber: '6' })));
  // Tåg 5 saknar tidtabell och stannar i D 2, 2,5 och 3 min – och en gång 8 min, som räknas som möte eller vändning
  [[13, 5, 0], [14, 5, 30], [15, 6, 0], [16, 11, 0]].forEach(([day, m, s]) => runs.push(run('t5-' + day, [
    stop('C', { dep: [11, 0, 0, day] }),
    stop('D', { arr: [11, 3, 0, day], dep: [11, m, s, day] }),
    stop('E', { arr: [11, 9, 0, day] })
  ], { trainNumber: '5' })));
  const needs = AN.segmentNeeds(AN.segmentObservations(runs, {}));
  const p = AN.proposeNewTimetable(runs, needs, { from: 'A', to: 'E', stops: { D: true } });
  const at = name => p.rows.find(r => r.station === name);
  assert.deepEqual([at('B').dwellValue, at('B').dwellSource, at('B').dwellN, at('B').dwellWaited], [1, 'matt', 9, 6]);
  assert.deepEqual([at('D').dwellValue, at('D').dwellSource, at('D').dwellN], [2.5, 'utan-tidtabell', 3]);
});

test('proposeNewTimetable: utan tidtabell i urvalet räknas uppehållen och schablonen från verkliga uppehåll', () => {
  // Körningar utan tidtabell som stannar 0,5, 0,6 och 0,7 min i B och passerar C
  const runs = [30, 36, 42].map((sec, k) => run('u' + k, [
    stop('A', { dep: [7, 0, 0, 13 + k] }),
    stop('B', { arr: [7, 3, 0, 13 + k], dep: [7, 3, sec, 13 + k] }),
    stop('C', { arr: [7, 6, 0, 13 + k], dep: [7, 6, 0, 13 + k], pass: true, shouldStop: false }),
    stop('D', { arr: [7, 9, 0, 13 + k] })
  ], { trainNumber: '' }));
  const needs = AN.segmentNeeds(AN.segmentObservations(runs, {}));
  const p = AN.proposeNewTimetable(runs, needs, { from: 'A', to: 'D', stops: { C: true } });
  assert.deepEqual(p.rows.slice(1, 3).map(r => [r.station, r.dwellValue, r.dwellSource]), [['B', 0.6, 'utan-tidtabell'], ['C', 0.6, 'schablon']]);
  assert.deepEqual(p.missing, []);
});

// ── Försening längs linjen ──

// A 07:00 → B 07:10/07:12 → C 07:20. Avgår 1 min sent, kör 2 min fortare till B, står 1 min för länge, kör som planerat.
function delayRun(id, extra) {
  return run(id, [
    stop('A', { dep: [7, 1], sDep: [7, 0] }),
    stop('B', { arr: [7, 9], dep: [7, 12], sArr: [7, 10], sDep: [7, 12] }),
    stop('C', { arr: [7, 20], sArr: [7, 20] })
  ], extra);
}

test('delayBreakdown: slut = start + gångtid + uppehåll', () => {
  const b = AN.delayBreakdown(delayRun('d1'));
  close(b.start, 1, 'start');
  close(b.running, -2, 'gångtid'); // 8 mot 10 min, sedan 8 mot 8
  close(b.dwell, 1, 'uppehåll');   // 3 mot 2 min
  close(b.end, 0, 'slut');
  close(b.start + b.running + b.dwell, b.end, 'summan');
});

test('delayBreakdown: saknad tid eller avskuren körning ger null', () => {
  const r = delayRun('d2');
  r.stops[1].actualDeparture = null;
  assert.equal(AN.delayBreakdown(r), null);
  assert.equal(AN.delayBreakdown(Object.assign(delayRun('d3'), { cutStart: true })), null);
});

test('delayProfile: avvikelse per station i tågets ordning, och balansen', () => {
  const p = AN.delayProfile([delayRun('d4'), delayRun('d5')]);
  assert.deepEqual(p.route, ['A', 'B', 'C']);
  assert.equal(p.points[0].arr.n, 0, 'ingen ankomst vid första stationen');
  close(p.points[0].dep.median, 1, 'avgång A');
  close(p.points[1].arr.median, -1, 'ankomst B');
  close(p.points[1].dep.median, 0, 'avgång B');
  assert.equal(p.points[2].dep.n, 0, 'ingen avgång vid sista stationen');
  assert.equal(p.balance.n, 2);
  close(p.balance.running.median, -2, 'gångtid');
  close(p.balance.sum.dwell, 2, 'summa uppehåll');
});

// ── GPS-spår ──

// Spår längs en rak linje norrut från A (58.0, 13.0), 1 punkt/s. segments: [[sekunder, m/s], ...]
function straightTrack(runId, t0, segments) {
  const points = [];
  let t = 0;
  let d = 0;
  for (const [secs, v] of segments) {
    for (let k = 0; k < secs; k++) {
      points.push([t * 1000, 58 + d / 111195, 13, 5, v, null, 0]);
      t += 1;
      d += v;
    }
  }
  return { format: 1, runId, t0, fields: ['t_ms', 'lat', 'lon', 'acc_m', 'speed_ms', 'heading_deg', 'fixAge_ms'], points };
}

function trackRun(id, legSeconds) {
  const t0 = new Date(2026, 9, 15, 7, 0, 0);
  const r = run(id, [
    Object.assign(stop('A', {}), { actualDeparture: t0.toISOString(), lat: 58, lon: 13, radius: 100 }),
    Object.assign(stop('B', {}), { actualArrival: new Date(t0.getTime() + legSeconds * 1000).toISOString(), lat: 58 + 5000 / 111195, lon: 13, radius: 100 })
  ]);
  return { run: r, t0: t0.toISOString() };
}

test('analyzeTrack: stopp mitt på sträckan hittas, inte vid stationerna', () => {
  // 20 m/s i 125 s (2,5 km), står 60 s, 20 m/s i 125 s → B 5 km bort
  const { run: r, t0 } = trackRun('t1', 310);
  const t = AN.analyzeTrack(r, straightTrack('t1', t0, [[125, 20], [60, 0], [125, 20]]));
  assert.equal(t.legs.length, 1);
  assert.equal(t.legs[0].stops.length, 1);
  assert.ok(Math.abs(t.legs[0].stops[0].minutes - 59 / 60) < 1e-9, 'stoppets längd');
  assert.ok(Math.abs(t.legs[0].stops[0].d - 2500) < 30, 'läget på sträckan');
  assert.ok(Math.abs(t.legs[0].length - 5000) < 30, 'sträckans längd');
});

test('analyzeTrack: kort stillastående och falsk fart slås ihop, men under 10 s räknas inte', () => {
  const { run: r, t0 } = trackRun('t2', 400);
  // står 8 s (räknas inte), kör, står 6 s + 2 s falsk fart (1 m/s) + 6 s = ett stopp på 13 s
  const t = AN.analyzeTrack(r, straightTrack('t2', t0, [[60, 20], [8, 0], [60, 20], [6, 0], [2, 1], [6, 0], [130, 20], [134, 0]]));
  assert.equal(t.legs[0].stops.length, 1, 'ett stopp');
  assert.ok(Math.abs(t.legs[0].stops[0].minutes * 60 - 13) < 1e-9, 'ihopslaget');
});

test('segmentObservations med spår och segmentNeeds utan körningar som stannade på linjen', () => {
  const a = trackRun('t3', 310);
  const b = trackRun('t4', 250);
  const tracks = AN.analyzeTracks([a.run, b.run], [
    straightTrack('t3', a.t0, [[125, 20], [60, 0], [125, 20]]),
    straightTrack('t4', b.t0, [[250, 20]])
  ]);
  const obs = AN.segmentObservations([a.run, b.run], { tracks });
  assert.deepEqual(obs.map(o => o.unplannedStop > 0), [true, false]);
  assert.ok(obs.every(o => o.hasTrack));
  const all = AN.segmentNeeds(obs).find(n => n.pattern === '*');
  const skip = AN.segmentNeeds(obs, { skipUnplanned: true }).find(n => n.pattern === '*');
  assert.equal(all.n, 2);
  assert.equal(skip.n, 1);
  assert.equal(skip.skipped, 1);
  const list = AN.unplannedStops([a.run, b.run], tracks);
  assert.equal(list.length, 1);
  assert.equal(list[0].segment, 'A → B');
});

// ── Jämför perioder ──

test('comparePeriods: sträcka och tåg i period A mot B', () => {
  const mk = (id, day, arrMin) => run(id, [
    stop('A', { dep: [7, 0, 0, day], sDep: [7, 0, 0, day] }),
    stop('B', { arr: [7, arrMin, 0, day], sArr: [7, 10, 0, day] })
  ]);
  const runs = [mk('p1', 1, 9), mk('p2', 2, 9), mk('p3', 3, 9), mk('p4', 20, 11), mk('p5', 21, 11), mk('p6', 22, 11)];
  const c = AN.comparePeriods(runs, { from: '2026-10-01', to: '2026-10-10' }, { from: '2026-10-11', to: '2026-10-31' }, {});
  assert.equal(c.a.runs, 3);
  assert.equal(c.b.runs, 3);
  const s = c.segments.find(x => x.key === 'A → B|SS');
  close(s.a.median, 9, 'A');
  close(s.b.median, 11, 'B');
  close(s.diff, 2, 'skillnad');
  const t = c.trains.find(x => x.train === '3344');
  close(t.a.endDelay.median, -1, 'slut A');
  close(t.diffEnd, 2, 'slut skillnad');
  close(t.diffPlanned, 0, 'samma planerade restid');
});

test('defaultPeriods: B = sista 30 dagarna, A = före', () => {
  const runs = [run('q1', [stop('A', { dep: [7, 0, 0, 1] })]), run('q2', [stop('A', { dep: [7, 0, 0, 31] })])];
  assert.deepEqual(AN.defaultPeriods(runs, 30), { a: { from: '2026-10-01', to: '2026-10-01' }, b: { from: '2026-10-02', to: '2026-10-31' } });
});

// ── Broms och gas ──

const M_PER_DEG_LAT = 111195;

/* Simulerad körning rakt norrut: stationer [{ name, x (m), stop }], i den ordning tåget kör (x upp eller ner).
   Tåget står 20 s vid start, gasar med acc till vmax, bromsar med dec så att det står vid nästa stopp, står dwell s.
   Ger körningen (stationer med koordinater och tider) och spåret (1 punkt/s). Stillastående har GPS-brus ±3 m. */
function simulateRun(id, stations, opts) {
  const o = Object.assign({ vmax: 20, acc: 0.4, dec: 0.5, dwell: 30, day: 15, hour: 7 }, opts || {});
  const t0 = new Date(2026, 9, o.day, o.hour, 0, 0);
  const sign = Math.sign(stations[stations.length - 1].x - stations[0].x);
  const times = stations.map(() => ({ arr: null, dep: null }));
  const points = [];
  const dt = 0.05;
  let t = 0, x = stations[0].x, v = 0, next = 1, standUntil = 20, nextOut = 0, k = 0, stopping = false;
  times[0].arr = 0;
  const target = () => { let j = next; while (j < stations.length - 1 && !stations[j].stop) j++; return j; };
  for (let guard = 0; guard < 400000; guard++) {
    if (t >= nextOut - 1e-9) {
      const noise = v === 0 ? (k % 2 ? 3 : -3) : 0;
      points.push([Math.round(t * 1000), 58 + (x + noise) / M_PER_DEG_LAT, 13, 4, Math.round(v * 100) / 100, null, 0]);
      k++;
      nextOut += 1;
    }
    if (t < standUntil) {
      t += dt;
      if (t >= standUntil && times[next - 1].dep == null) times[next - 1].dep = standUntil;
      continue;
    }
    if (next >= stations.length) { if (t > standUntil + 20) break; t += dt; continue; }
    const j = target();
    const remaining = Math.abs(stations[j].x - x);
    // Hastighetsbegränsning { from, to, v }: tåget bromsar till v före och håller högst v inom
    let cap = o.vmax;
    let brakeTo = null;
    if (o.limit) {
      const entry = (sign > 0 ? o.limit.from : o.limit.to) - x;
      const exit = (sign > 0 ? o.limit.to : o.limit.from) - x;
      if (entry * sign <= 0 && exit * sign > 0) cap = o.limit.v;
      else if (entry * sign > 0 && v > o.limit.v && entry * sign <= (v * v - o.limit.v ** 2) / (2 * o.dec) + 0.05) brakeTo = o.limit.v;
    }
    // Inbromsningen till stopp fortsätter tills tåget står (annars kryper det fram i diskretiseringen)
    if (stopping || remaining <= v * v / (2 * o.dec) + 0.05) { stopping = true; v = Math.max(0, v - o.dec * dt); }
    else if (brakeTo != null) v = Math.max(brakeTo, v - o.dec * dt);
    else if (v > cap) v = Math.max(cap, v - o.dec * dt);
    else v = Math.min(cap, v + o.acc * dt);
    const before = x;
    x += sign * v * dt;
    t += dt;
    // Passage: stationer utan stopp som passerades
    while (next < j && Math.sign(stations[next].x - before) !== Math.sign(stations[next].x - x)) { times[next].arr = t; times[next].dep = t; next++; }
    if (stopping && v === 0) {
      stopping = false;
      x = stations[j].x;
      times[j].arr = t;
      next = j + 1;
      standUntil = next >= stations.length ? t : t + o.dwell;
      if (next >= stations.length) { standUntil = t; times[j].dep = null; }
    }
  }
  const iso = s => (s == null ? null : new Date(t0.getTime() + s * 1000).toISOString());
  const r = run(id, stations.map((s, i) => Object.assign(stop(s.name, {}), {
    actualArrival: i === 0 ? null : iso(times[i].arr),
    actualDeparture: i === stations.length - 1 ? null : iso(times[i].dep),
    arrivalSource: 'gps', departSource: s.stop || i === 0 || i === stations.length - 1 ? 'gps' : 'gps-pass',
    shouldStop: !!s.stop || i === 0 || i === stations.length - 1,
    lat: 58 + s.x / M_PER_DEG_LAT, lon: 13, radius: 200
  })), { startedAt: t0.toISOString() });
  const track = { format: 1, runId: id, trainNumber: '3344', t0: t0.toISOString(), fields: ['t_ms', 'lat', 'lon', 'acc_m', 'speed_ms', 'heading_deg', 'fixAge_ms'], points };
  return { run: r, track };
}

const ABC = [{ name: 'A', x: 0, stop: true }, { name: 'B', x: 3000, stop: true }, { name: 'C', x: 6000, stop: true }];
const assertEqualLen = (list, n, label) => assert.equal(list.length, n, label);
const within = (v, lo, hi, label) => assert.ok(v >= lo && v <= hi, `${label}: ${v} utanför ${lo}…${hi}`);

test('motionPoints: broms, gas, jämn fart och stillastående; GPS-brus vid stillastående ger ingen sträcka', () => {
  const { track } = simulateRun('m1', ABC);
  const pts = AN.motionPoints(track);
  const at = (from, to) => pts.filter(p => p.d >= from && p.d <= to);
  // gasar 0–500 m, jämn fart 20 m/s, bromsar 2 600–3 000 m (v²/2a = 400 m)
  assert.ok(at(100, 400).every(p => p.action === 'gas'), 'gas efter start');
  assert.ok(at(1000, 2400).every(p => p.action === 'jamn'), 'jämn fart');
  assert.ok(at(2700, 2950).every(p => p.action === 'broms'), 'broms före B');
  assert.ok(pts.filter(p => p.action === 'still').length >= 60, 'stillastående vid A, B och C');
  within(pts[pts.length - 1].d, 5950, 6050, 'hela sträckan trots brus');
  const a = pts.filter(p => p.action === 'broms').map(p => p.a);
  within(Math.min(...a), -0.55, -0.45, 'inbromsning');
});

test('stationAnchor: läget vid stationen interpoleras mellan punkterna', () => {
  const { run: r, track } = simulateRun('m2', ABC);
  const pts = AN.motionPoints(track);
  const b = AN.stationAnchor(r.stops[1], pts);
  within(b.d, 2990, 3010, 'B');
  assert.equal(AN.stationAnchor(Object.assign({}, r.stops[1], { lat: 58.2 }), pts), null, 'för långt bort');
});

test('motionZones: inbromsning och gas vid uppehållet, i båda riktningarna, och linjen med km', () => {
  const back = ABC.slice().reverse();
  const sims = [
    simulateRun('z1', ABC, { day: 1 }), simulateRun('z2', ABC, { day: 2 }), simulateRun('z3', ABC, { day: 3 }),
    simulateRun('z4', [ABC[0], Object.assign({}, ABC[1], { stop: false }), ABC[2]], { day: 4 }),
    simulateRun('z5', back, { day: 5 }), simulateRun('z6', back, { day: 6 }), simulateRun('z7', back, { day: 7, dec: 0.8 }),
    // Utan tågnummer: bara start och slut. Ger ingen genväg A–C i linjen.
    (() => { const s = simulateRun('z8', ABC, { day: 8 }); s.run.stops.splice(1, 1); return s; })()
  ];
  const runs = sims.map(s => s.run);
  const z = AN.motionZones(runs, AN.motionTracks(runs, sims.map(s => s.track)));
  assert.equal(z.runCount, 8);
  assert.equal(z.lines.length, 1);
  assert.deepEqual(z.lines[0].stations.map(s => s.name), ['A', 'B', 'C'], 'linjen i ordning, söderut först');
  within(z.lines[0].stations[1].km, 2.99, 3.01, 'B km');

  const b = z.stations.find(s => s.key === 'B|1');
  assert.equal(b.n, 3, 'tre körningar stannade');
  assert.equal(b.passages, 1, 'en passerade');
  assert.equal(b.toward, 'C');
  within(b.approach.from, -450, -350, 'inbromsningen börjar ca 400 m före');
  within(b.approach.to, -50, 50, 'och slutar vid stationen');
  within(b.approach.vFrom, 66, 74, 'fart när inbromsningen börjar');
  within(b.departure.from, -50, 50, 'gasen börjar vid stationen');
  within(b.departure.to, 450, 600, 'och slutar ca 500 m efter');
  within(b.approach.km1, 2.54, 2.66, 'km där inbromsningen börjar');
  within(b.approach.start.lat, 58 + 2550 / M_PER_DEG_LAT, 58 + 2650 / M_PER_DEG_LAT, 'koordinat där inbromsningen börjar');
  assert.equal(b.runs.length, 3);
  assert.ok(b.runs[0].profile.length > 50, 'fartprofil per körning');

  const bBack = z.stations.find(s => s.key === 'B|-1');
  assert.equal(bBack.n, 3);
  assert.equal(bBack.toward, 'A');
  // Andra hållet: km minskar i färdriktningen
  within(bBack.approach.km1, 3.25, 3.45, 'inbromsningen börjar norr om B');
  const a = z.stations.find(s => s.key === 'A|1');
  assert.equal(a.approach, null, 'ingen inbromsning vid start');
  within(a.departure.to, 450, 600, 'gas från start');
  // Linjen: andel som bromsar ca 300 m före B söderifrån
  const lb = z.lines[0].dirs.find(d => d.dir === 1).bins.find(x => x.from === 2700);
  assert.equal(lb.n, 5, 'alla körningar söderifrån (även passagen och den utan mellanstation)');
  assert.equal(lb.broms, 4, 'alla utom passagen bromsar');
});

test('motionZones: inbromsning i steg räknas ihop när tåget inte gasar emellan', () => {
  const zonesWith = limit => {
    const sims = [1, 2, 3].map(day => simulateRun('s' + day, ABC, { day, limit }));
    const runs = sims.map(s => s.run);
    return AN.motionZones(runs, AN.motionTracks(runs, sims.map(s => s.track))).stations.find(s => s.key === 'B|1');
  };
  // 20 → 10 m/s från 1 700 m (300 m broms), rullar till 2 900 m, bromsar till stopp vid 3 000 m
  const staged = zonesWith({ from: 2000, to: 3000, v: 10 });
  assert.equal(staged.approach.steps, 2, 'två steg');
  within(staged.approach.from, -1350, -1250, 'inbromsningen börjar vid första steget');
  assert.equal(staged.zones.filter(x => x.kind === 'broms' && x.to <= 100).length, 2, 'båda stegen finns som zoner före B');
  // Begränsningen slutar 500 m före: tåget gasar emellan, så bara sista inbromsningen hör till stoppet
  const between = zonesWith({ from: 2000, to: 2500, v: 10 });
  assert.equal(between.approach.steps, 1, 'ett steg');
  within(between.approach.from, -500, -100, 'bara sista inbromsningen');
  assert.ok(between.zones.some(x => x.kind === 'gas' && x.to < 0), 'gasen emellan');
});

// ── Km-tal (appversion 2026-11-25p) ──

test('km-tal: linjebokens km-tal vid stationerna och däremellan längs linjen', () => {
  // Linjen som motionZones ger den: stationerna med linjens km (från GPS-spåren)
  const line = { stations: [
    { name: 'Vara', km: 21.38 }, { name: 'Håkantorp', km: 27.07 }, { name: 'Stora Levene', km: 29.72 },
    { name: 'Framnäs city', km: 53.92 }, { name: 'Lidköping', km: 55.03 }, { name: 'Filsbäck', km: 60.01 },
    { name: 'Källby', km: 64.03 }, { name: 'Råbäck', km: 76.39 }, { name: 'Hällekis', km: 80.48 }, { name: 'Gårdsjö', km: 147.8 }
  ] };
  const ax = AN.kmTalAxis(line);
  assert.equal(ax.segs.length, 1);
  assert.equal(ax.segs[0].name, 'Håkantorp – Gårdsjö');
  assert.equal(ax.segs[0].sign, -1, 'km-talet minskar mot Gårdsjö');
  assert.deepEqual(ax.segs[0].refs.map(r => r.name), ['Håkantorp', 'Stora Levene', 'Framnäs city', 'Lidköping', 'Filsbäck', 'Källby', 'Råbäck', 'Hällekis', 'Gårdsjö']);
  // Vid stationerna: linjeboken (André: Hällekis 67+510, Råbäck 71+620, Källby 83+974)
  assert.equal(AN.kmTalAt(ax, 80.48).m, 67510);
  assert.equal(AN.kmTalAt(ax, 76.39).m, 71620);
  assert.equal(AN.kmTalAt(ax, 64.03).m, 83974);
  assert.deepEqual(AN.kmTalStation(ax, 'Källby'), { section: 'Håkantorp – Gårdsjö', m: 83974 });
  assert.equal(AN.kmTalStation(ax, 'Vara'), null, 'Vara ligger inte på sträckan');
  // Däremellan: längs linjen. Halvvägs Källby–Råbäck
  const mid = AN.kmTalAt(ax, (64.03 + 76.39) / 2).m;
  assert.equal(mid, Math.round((83974 + 71620) / 2));
  // Utanför sträckan gäller en annan bana: inget km-tal
  assert.equal(AN.kmTalAt(ax, 25), null, 'mellan Vara och Håkantorp');
  assert.equal(AN.kmTalAt(ax, 150), null, 'efter Gårdsjö');
  assert.equal(AN.kmTalAt(ax, 27.07).m, 121021, 'Håkantorp');
  // Utan stationer på sträckan
  assert.equal(AN.kmTalAxis({ stations: [{ name: 'Vara', km: 0 }, { name: 'Vedum', km: 10 }] }), null);
  // Station i fel ordning tas inte med
  const odd = AN.kmTalAxis({ stations: [{ name: 'Lidköping', km: 0 }, { name: 'Källby', km: 5 }, { name: 'Filsbäck', km: 6 }] });
  assert.deepEqual(odd.segs[0].refs.map(r => r.name), ['Lidköping', 'Källby']);
  assert.equal(AN.formatKmTal(83974), '83+974');
  assert.equal(AN.formatKmTal(83974, 10), '83+970');
  assert.equal(AN.formatKmTal(950), '0+950');
  assert.equal(AN.formatKmTal(null), '');
});

// ── Halka (appversion 2026-11-25q) ──

test('halka: startens acceleration, förarens markeringar och starter som är svagare än vanligt', () => {
  const sims = [1, 2, 3, 4, 5, 6, 7, 8].map(day => simulateRun('h' + day, ABC, { day }));
  const weak = simulateRun('hw', ABC, { day: 9, acc: 0.2 });
  weak.run.stops[1].slipOut = true;   // slirade vid starten från B
  weak.run.stops[2].slideIn = true;   // gled vid inbromsningen in mot C
  sims.push(weak);
  const runs = sims.map(s => s.run);
  const motion = AN.motionTracks(runs, sims.map(s => s.track));
  const ev = AN.adhesionCompare(AN.adhesionEvents(runs, motion));
  const starts = ev.filter(e => e.kind === 'start');
  assertEqualLen(starts, 18, 'två starter per körning (A och B)');
  for (const e of starts.filter(e => e.runId !== 'hw')) within(e.acc, 0.35, 0.45, 'acceleration 0,4 m/s² ' + e.from);
  const w = starts.filter(e => e.runId === 'hw');
  for (const e of w) {
    within(e.acc, 0.17, 0.23, 'svag start ' + e.from);
    assert.equal(e.baseN, 8, 'jämförs med de åtta andra');
    assert.ok(e.weak, 'svagare än vanligt: ' + e.ratio);
  }
  assert.ok(starts.filter(e => e.runId !== 'hw').every(e => !e.weak), 'vanliga starter flaggas inte');
  const slip = w.find(e => e.from === 'B');
  assert.deepEqual([slip.marked, slip.toward], [true, 'C'], 'markerat: slirade ut från B mot C');
  const slide = ev.filter(e => e.kind === 'broms');
  assert.equal(slide.length, 1);
  assert.deepEqual([slide[0].station, slide[0].from, slide[0].toward, slide[0].marked, slide[0].acc], ['C', 'B', 'C', true, null], 'gled in mot C');
  // För få att jämföra med: ingen bedömning
  const few = AN.adhesionCompare(AN.adhesionEvents(runs.slice(0, 4), motion));
  assert.ok(few.every(e => e.ratio == null && !e.weak), 'under sex andra starter: ingen jämförelse');
  // Markering utan GPS-spår räknas ändå
  const noTrack = AN.adhesionEvents([weak.run], new Map());
  assert.deepEqual(noTrack.map(e => [e.kind, e.station, e.marked, e.acc]), [['start', 'B', true, null], ['broms', 'C', true, null]], 'markeringarna utan spår');
});

// ── Tågorderns tider (appversion 2026-11-25f) ──

/* Tåg 23349 Lidköping → Herrljunga C 2026-11-25: verkliga tider ur railtimer-data (hela sekunder), planerade enligt
   förarens tågorder. Trafikverkets annonserade tider (som appen hade före 2026-11-25f) har ankomst = avgång vid
   mellanstationerna och Vara avgång 11:53. advertisedOnly: bara de annonserade tiderna, som en gammal körning. */
function train23349(advertisedOnly, id) {
  const d = 25;
  const s = (name, arr, dep, sArr, sDep, aArr, aDep, extra) => stop(name, Object.assign({
    arr: arr && [...arr, d], dep: dep && [...dep, d], sArr: sArr && [...sArr, 0, d], sDep: sDep && [...sDep, 0, d],
    aArr: aArr && [...aArr, 0, d], aDep: aDep && [...aDep, 0, d], advertisedOnly
  }, extra || {}));
  return run(id || 'k23349', [
    s('Lidköping', null, [11, 22, 17], null, [11, 22], null, [11, 22]),
    s('Framnäs city', [11, 24, 9], [11, 24, 52], [11, 23], [11, 24], [11, 24], [11, 24]),
    s('Lovene', [11, 32, 24], [11, 33, 13], [11, 32], [11, 33], [11, 33], [11, 33]),
    s('Järpås', [11, 39, 52], [11, 40, 25], [11, 39], [11, 40], [11, 40], [11, 40]),
    s('Stora Levene', [11, 45, 42], [11, 46, 15], [11, 44], [11, 45], [11, 45], [11, 45]),
    s('Håkantorp', [11, 48, 51], [11, 48, 53], [11, 48], [11, 49], [11, 49], [11, 49], { pass: true }),
    s('Vara', [11, 52, 48], [11, 53, 35], [11, 53], [11, 54], [11, 53], [11, 53]),
    s('Vedum', [12, 0, 9], [12, 1, 5], [12, 0], [12, 1], [12, 1], [12, 1]),
    s('Herrljunga C', [12, 9, 33], null, [12, 9], null, [12, 9], null)
  ], { trainNumber: '23349' });
}

test('tågorderns tider: Var tiden går för 23349 – gångtid +2,9 min och uppehåll −2,6 min', () => {
  const b = AN.delayBreakdown(train23349(false));
  close(b.start, 17 / 60, 'avgång start');
  close(b.end, 33 / 60, 'ankomst slut');
  close(b.dwell, (263 - 7 * 60) / 60, 'uppehåll: 263 s verkligt mot 7 × 1 min planerat');
  close(b.running, b.end - b.start - b.dwell, 'gångtid');
  assert.ok(b.running > 2.88 && b.running < 2.89, `gångtid ${b.running}`);
});

test('tågorderns tider: ankomst, avgång och tappad tid i Vedum och Vara räknas mot tågordern', () => {
  const t = AN.stationTimes([train23349(false)]);
  const ved = t.find(x => x.station === 'Vedum');
  close(ved.arrivalDev, 9 / 60, 'Vedum ankomst 9 s efter 12:00');
  close(ved.departureDev, 5 / 60, 'Vedum avgång 5 s efter 12:01');
  close(ved.dwell, 56 / 60, 'Vedum uppehåll');
  close(ved.plannedDwell, 1, 'planerat uppehåll 1 min');
  close(ved.lost, 5 / 60 - 9 / 60, 'tappad tid');
  const vara = t.find(x => x.station === 'Vara');
  close(vara.departureDev, -25 / 60, 'Vara avgång 25 s före tågorderns 11:54 (annonserad 11:53)');
  close(vara.lost, -25 / 60, 'kom tidigt: tappad tid = avgångsavvikelsen');
});

test('tågorderns tider: en körning med bara annonserade tider jämförs inte mot tidtabellen men räknas i mätningarna', () => {
  const old = train23349(true, 'gammal');
  assert.equal(AN.hasTimetable(old), false);
  assert.equal(AN.hasAdvertisedOnly(old), true);
  assert.equal(AN.hasAdvertisedOnly(train23349(false)), false);
  assert.equal(AN.delayBreakdown(old), null, 'Var tiden går');
  assert.deepEqual(AN.stationTimes([old]), [], 'avvikelser och tappad tid');
  const obs = AN.segmentObservations([old], {});
  assert.equal(obs.length, 8, 'alla sträckor mäts');
  assert.ok(obs.every(o => o.planned == null), 'ingen planerad gångtid');
  assert.ok(obs.every(o => o.order != null), 'ordningen finns ändå');
  const need = AN.segmentNeeds(obs).find(n => n.key === 'Vara → Vedum|SS');
  close(need.median, (6 * 60 + 34) / 60, 'vad sträckan tar Vara → Vedum');
  assert.deepEqual(AN.trainVariants([old]), [], 'inget tåg med tågorderns tider');
  const sum = AN.summarizeTrains([old], [], {});
  assert.deepEqual([sum.rows.length, sum.withoutTimetable.trains, sum.withoutTimetable.runs], [0, 1, 1]);
  assert.equal(AN.delayBalance([old, train23349(false)]).n, 1, 'bara körningen med tågorderns tider');
});

test('tågorderns tider: uppehållet i Vedum räknas från tågorderns ankomst, inte från den annonserade', () => {
  const runs = [train23349(false, 'k1'), train23349(false, 'k2'), train23349(false, 'k3')];
  const needs = AN.segmentNeeds(AN.segmentObservations(runs, {}));
  const p = AN.proposeTrainTimetable(runs, needs, '23349');
  const ved = p.rows.find(r => r.station === 'Vedum');
  close(ved.dwellValue, 56 / 60, 'tåget kom 12:00:09 och åkte 12:01:05');
  close(ved.plannedDwell, 1, 'planerat enligt tågordern');
  const vara = p.rows.find(r => r.station === 'Vara');
  close(vara.dwellValue, 35 / 60, 'Vara: kom 11:52:48, före tågorderns ankomst 11:53 – räknas från 11:53');
  // Med de annonserade tiderna (12:01/12:01) blev uppehållet i Vedum bara 5 s: väntan före "ankomsten" 12:01 räknades bort
});

test('tågorderns tider: nytt tåg räknar gamla körningar som stopp utan tidtabell, med hela uppehållet', () => {
  const old = [train23349(true, 'g1'), train23349(true, 'g2'), train23349(true, 'g3')];
  const needs = AN.segmentNeeds(AN.segmentObservations(old, {}));
  const p = AN.proposeNewTimetable(old, needs, { from: 'Lidköping', to: 'Herrljunga C' });
  const ved = p.rows.find(r => r.station === 'Vedum');
  assert.equal(ved.dwellSource, 'utan-tidtabell');
  close(ved.dwellValue, 56 / 60, 'hela uppehållet (kan innehålla väntan)');
  const withOtn = [train23349(false, 'n1'), train23349(false, 'n2'), train23349(false, 'n3')];
  const q = AN.proposeNewTimetable(withOtn, needs, { from: 'Lidköping', to: 'Herrljunga C' });
  const v2 = q.rows.find(r => r.station === 'Vedum');
  assert.deepEqual([v2.dwellSource, v2.dwellN, v2.dwellWaited], ['matt', 3, 3]);
  close(v2.dwellValue, 56 / 60, 'från tågorderns ankomst 12:00 (tåget kom 12:00:09)');
});

test('tågorderns tider: passage med bara en tid i tågordern', () => {
  const p = { name: 'X', shouldStop: false, operationalDeparture: at(11, 49), scheduledArrival: at(11, 49), scheduledDeparture: at(11, 49) };
  assert.equal(AN.plannedArrival(p).toISOString(), at(11, 49));
  assert.equal(AN.plannedDeparture(p).toISOString(), at(11, 49));
  const s = { name: 'Y', shouldStop: true, operationalDeparture: at(11, 22) };
  assert.equal(AN.plannedArrival(s), null, 'stopp utan tågorderns ankomst: ingen planerad ankomst');
});
