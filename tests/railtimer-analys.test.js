'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AN = require('../railtimer-analys.js');

// Klockslag 2026-10-15 (torsdag) i lokal tid som ISO-sträng – testerna beror inte på datorns tidszon
function at(h, m, s, day) { return new Date(2026, 9, day || 15, h, m, s || 0).toISOString(); }

// En station i en körning. Tider anges som [tim, min, sek] eller [tim, min, sek, dag].
function stop(name, o) {
  const opt = o || {};
  const t = v => (v ? at(...v) : null);
  return {
    name,
    actualArrival: t(opt.arr),
    actualDeparture: t(opt.dep),
    scheduledArrival: t(opt.sArr),
    scheduledDeparture: t(opt.sDep),
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
  assert.deepEqual(AN.stats([]), { n: 0, median: null, p90: null, mean: null });
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
  runs.filter(r => r.trainNumber === '3346' && r.id !== 'b15').forEach(r => { r.stops[2].scheduledArrival = at(10, 7, 0, Number(r.id.slice(1))); });
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
