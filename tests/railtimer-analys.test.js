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

test('stationObservations: avvikelser, väntan vid tidig ankomst och riktning', () => {
  const r = run('w', [
    stop('A', { dep: [7, 0], sDep: [7, 0] }),
    stop('B', { arr: [7, 3], dep: [7, 6, 10], sArr: [7, 5], sDep: [7, 6] }),
    stop('C', { arr: [7, 10], sArr: [7, 10] })
  ]);
  const obs = AN.stationObservations([r], { tolerance: 1 });
  const b = obs.find(o => o.station === 'B');
  assert.equal(b.key, 'B|mot|C');
  assert.equal(b.arrivalDev, -2);
  assert.equal(b.arrivalCategory, 'tidig');
  close(b.dwell, 3 + 10 / 60, 'uppehåll');
  assert.equal(b.plannedDwell, 1);
  assert.equal(b.wait, 2, 'väntan = tiden fram till planerad ankomst (den sena avgången räknas inte som väntan)');
  close(b.departureDev, 10 / 60, 'avgång');
  assert.equal(b.departureCategory, 'itid');
  const c = obs.find(o => o.station === 'C');
  assert.deepEqual([c.key, c.towards, c.from, c.arrivalCategory, c.wait], ['C|från|B', null, 'B', 'itid', null]);
  assert.equal(obs.find(o => o.station === 'A').key, 'A|mot|B');
});

test('stationObservations: ingen väntan när tåget åkte före planerad ankomst', () => {
  // Planerat uppehåll 0 (07:05/07:05): tåget kommer 1,5 min tidigt, står 70 s för resandeutbyte och åker
  const r = run('x', [
    stop('A', { dep: [7, 0], sDep: [7, 0] }),
    stop('B', { arr: [7, 3, 30], dep: [7, 4, 40], sArr: [7, 5], sDep: [7, 5] }),
    stop('C', { arr: [7, 9], sArr: [7, 9] })
  ]);
  const b = AN.stationObservations([r], { tolerance: 1 }).find(o => o.station === 'B');
  assert.equal(b.arrivalCategory, 'tidig');
  assert.equal(b.wait, 0, 'tåget väntade inte på tidtabellen');
});

test('stationObservations: ingen väntan i tid, och filter på stationstyp', () => {
  const r = run('v', [
    stop('A', { dep: [7, 0], sDep: [7, 0] }),
    stop('B', { arr: [7, 5, 30], dep: [7, 6, 30], sArr: [7, 5], sDep: [7, 6] }),
    stop('P', { arr: [7, 8], dep: [7, 8, 5], sDep: [7, 8], pass: true, shouldStop: false }),
    stop('C', { arr: [7, 10], sArr: [7, 10] })
  ]);
  const all = AN.stationObservations([r], { tolerance: 1 });
  assert.equal(all.find(o => o.station === 'B').wait, null, 'ingen väntan när ankomsten är i tid');
  assert.equal(all.find(o => o.station === 'P').dwell, null, 'passage har inget uppehåll');
  assert.deepEqual(AN.stationObservations([r], { stationType: 'passage' }).map(o => o.station), ['P']);
  assert.deepEqual(AN.stationObservations([r], { stationType: 'stopp' }).map(o => o.station), ['A', 'B', 'C']);
});

// ── Sammanställningar ──

// Tre körningar A → B → C → D: A → B tar längre tid än planerat, B → C kortare (tidig ankomst i C, väntan),
// C → D enligt tidtabell. Planerat: A 07:00, B 07:03/07:04, C 07:09/07:10, D 07:13.
function threeRuns() {
  const actualAB = [5, 5.5, 6];       // planerat 3 min → +2, +2,5, +3
  return actualAB.map((ab, k) => {
    const bArr = 7 * 60 + ab;           // minuter efter midnatt
    const bDep = bArr + 0.5;
    const cArr = bDep + 1;              // planerat 5 min → mycket för snabbt
    const cDep = 7 * 60 + 10;           // står kvar till planerad avgång (väntan)
    const dArr = cDep + 3;              // planerat 3 min → i tid
    const hm = v => [Math.floor(v / 60), Math.floor(v % 60), Math.round((v % 1) * 60)];
    return run('r' + k, [
      stop('A', { dep: [7, 0], sDep: [7, 0] }),
      stop('B', { arr: hm(bArr), dep: hm(bDep), sArr: [7, 3], sDep: [7, 4] }),
      stop('C', { arr: hm(cArr), dep: hm(cDep), sArr: [7, 9], sDep: [7, 10] }),
      stop('D', { arr: hm(dArr), sArr: [7, 13] })
    ]);
  });
}

test('summarizeSegments: snål, generös och lagom med förslag i hela minuter', () => {
  const rows = AN.summarizeSegments(AN.segmentObservations(threeRuns(), { tolerance: 1 }), { tolerance: 1 });
  const ab = rows.find(r => r.key === 'A → B');
  assert.deepEqual([ab.n, ab.nPlanned, ab.planned, ab.assessment], [3, 3, 3, 'snal']);
  assert.deepEqual(ab.counts, { sen: 3, itid: 0, tidig: 0 });
  close(ab.actual.median, 5.5, 'median');
  assert.deepEqual([ab.suggestion, ab.change], [6, 3]);
  const bc = rows.find(r => r.key === 'B → C');
  assert.equal(bc.assessment, 'generos');
  assert.equal(bc.counts.tidig, 3);
  assert.equal(rows.find(r => r.key === 'C → D').assessment, 'lagom');
  assert.deepEqual(rows.map(r => r.key), ['B → C', 'A → B', 'C → D'], 'störst avvikelse först');
});

test('summarizeSegments: för få mätningar, varierande planerad tid och sträckor utan tidtabell sist', () => {
  const mk = (id, planned, actual) => run(id, [stop('A', { dep: [7, 0], sDep: planned ? [7, 0] : null }), stop('B', { arr: [7, actual], sArr: planned ? [7, planned] : null })]);
  const rows = AN.summarizeSegments(AN.segmentObservations([
    mk('1', 3, 6), mk('2', 4, 6), mk('3', null, 5),
    run('4', [stop('X', { dep: [8, 0] }), stop('Y', { arr: [8, 2] })])
  ], {}), { tolerance: 1 });
  assert.deepEqual(rows.map(r => r.key), ['A → B', 'X → Y']);
  const ab = rows[0];
  assert.deepEqual([ab.n, ab.nPlanned, ab.assessment, ab.planned, ab.plannedMin, ab.plannedMax], [3, 2, 'fa', 3, 3, 4]);
  assert.deepEqual([rows[1].nPlanned, rows[1].assessment, rows[1].change], [0, 'fa', null]);
});

test('summarizeStations: väntan, sen ankomst och sen avgång', () => {
  const stationRows = AN.summarizeStations(AN.stationObservations(threeRuns(), { tolerance: 1 }), { tolerance: 1 });
  const c = stationRows.find(r => r.key === 'C|mot|D');
  assert.deepEqual([c.n, c.type, c.assessment, c.wait.n], [3, 'stopp', 'vantan', 3]);
  assert.equal(c.arrivalCounts.tidig, 3);
  const b = stationRows.find(r => r.key === 'B|mot|C');
  assert.equal(b.assessment, 'sen-ankomst');
  const lateDep = [0, 1, 2].map(k => run('d' + k, [
    stop('A', { dep: [7, 0], sDep: [7, 0] }),
    stop('B', { arr: [7, 3], dep: [7, 6], sArr: [7, 3], sDep: [7, 4] }),
    stop('C', { arr: [7, 9], sArr: [7, 9] })
  ]));
  const rowsDep = AN.summarizeStations(AN.stationObservations(lateDep, { tolerance: 1 }), { tolerance: 1 });
  assert.equal(rowsDep.find(r => r.key === 'B|mot|C').assessment, 'sen-avgang');
  const few = AN.summarizeStations(AN.stationObservations(lateDep.slice(0, 2), { tolerance: 1 }), { tolerance: 1 });
  assert.equal(few.find(r => r.key === 'B|mot|C').assessment, 'fa');
});

test('summarizeStations: tidig ankomst utan väntan och tidig passage blir Tidig, inte Tidig – väntan', () => {
  const runs = [0, 1, 2].map(k => run('e' + k, [
    stop('A', { dep: [7, 0], sDep: [7, 0] }),
    stop('B', { arr: [7, 3], dep: [7, 3, 50], sArr: [7, 5], sDep: [7, 5] }),   // åker före planerad ankomst: ingen väntan
    stop('P', { arr: [7, 6], dep: [7, 6, 5], sArr: [7, 8], sDep: [7, 8], pass: true, shouldStop: false }),
    stop('C', { arr: [7, 10], sArr: [7, 10] })
  ]));
  const rows = AN.summarizeStations(AN.stationObservations(runs, { tolerance: 1 }), { tolerance: 1 });
  assert.deepEqual(['B|mot|P', 'P|mot|C'].map(k => rows.find(r => r.key === k).assessment), ['tidig', 'tidig']);
});

// ── Tidtabellsförslag ──

// Passage i B och C, 2,4 min per sträcka: exakt 2,4 / 4,8 / 7,2 → avrundat 2 / 5 / 7 (inte 2 + 2 + 2 = 6)
function passRuns() {
  return [0, 1, 2].map(k => run('t' + k, [
    stop('A', { dep: [7, 0], sDep: [7, 0] }),
    stop('B', { arr: [7, 2, 24], dep: [7, 2, 30], sDep: [7, 3], pass: true, shouldStop: false }),
    stop('C', { arr: [7, 4, 54], dep: [7, 5, 0], sDep: [7, 5], pass: true, shouldStop: false }),
    stop('D', { arr: [7, 7, 24], sArr: [7, k === 2 ? 9 : 8] })
  ]));
}

test('proposeTimetable: avrundning till hela minuter utan att felen växer', () => {
  const p = AN.proposeTimetable(passRuns(), { from: 'A', to: 'D', basis: 'median' });
  assert.deepEqual(p.route, ['A', 'B', 'C', 'D']);
  assert.equal(p.runCount, 3);
  assert.deepEqual(p.rows.map(r => [r.arrivalRounded, r.departureRounded]), [[null, 0], [2, 2], [5, 5], [7, null]]);
  close(p.totalMin, 7.2, 'exakt restid');
  assert.equal(p.totalRounded, 7);
  assert.deepEqual(p.rows.map(r => r.isStop), [true, false, false, true], 'passage är förvald där tåget oftast passerade');
  assert.deepEqual(p.rows.map(r => r.legRounded), [null, 2, 3, 2]);
  assert.deepEqual(p.rows.map(r => r.plannedLeg), [null, 3, 2, 3], 'vanligaste planerade gångtiden');
  assert.deepEqual(p.rows.map(r => r.legChange), [null, -1, 1, -1]);
  assert.deepEqual([p.rows[3].plannedLegMin, p.rows[3].plannedLegMax], [3, 4]);
  assert.deepEqual(p.period, { from: '2026-10-15', to: '2026-10-15' });
});

test('proposeTimetable: bara vald riktning räknas och rutten tas från den längsta körningen', () => {
  const reverse = [0, 1].map(k => run('rev' + k, [
    stop('D', { dep: [8, 0] }), stop('C', { arr: [8, 9], dep: [8, 10] }), stop('B', { arr: [8, 19], dep: [8, 20] }), stop('A', { arr: [8, 29] })
  ]));
  const short = run('kort', [stop('A', { dep: [9, 0] }), stop('B', { arr: [9, 2, 24], dep: [9, 2, 30], pass: true, shouldStop: false }), stop('D', { arr: [9, 9] })]);
  const p = AN.proposeTimetable(passRuns().concat(reverse, [short]), { from: 'A', to: 'D', basis: 'median' });
  assert.deepEqual(p.route, ['A', 'B', 'C', 'D']);
  assert.equal(p.runCount, 4, 'tre långa och en kort körning åt rätt håll, inga åt motsatt håll');
  assert.equal(p.totalRounded, 7);
  assert.deepEqual(AN.proposeTimetable(reverse, { from: 'A', to: 'D' }).error, 'ingen-riktning');
});

test('proposeTimetable: uppehåll vid stopp, valda stopp och sträcka utan mätningar', () => {
  const runs = [0, 1, 2].map(k => run('s' + k, [
    stop('A', { dep: [7, 0] }),
    stop('B', { arr: [7, 3], dep: [7, 4] }),
    stop('C', { arr: [7, 8] }),
    stop('D', { arr: [7, 12] })
  ]));
  const p = AN.proposeTimetable(runs, { from: 'A', to: 'D', basis: 'median' });
  assert.deepEqual(p.rows.map(r => [r.arrivalRounded, r.departureRounded]), [[null, 0], [3, 4], [8, null], [null, null]]);
  assert.equal(p.rows[1].dwell.n, 3);
  assert.deepEqual(p.missing, ['uppehåll i C', 'C → D'], 'C saknar avgång, så tiden efter C kan inte räknas fram');
  assert.equal(p.totalMin, null);
  const asPass = AN.proposeTimetable(runs, { from: 'A', to: 'C', basis: 'median', stops: { B: false } });
  assert.deepEqual(asPass.rows.map(r => [r.arrivalRounded, r.departureRounded]), [[null, 0], [3, 3], [7, null]], 'passage i B ger inget uppehåll');
});

test('proposeTimetable: väntan på tidtabellen räknas inte in i uppehållet', () => {
  // I C kommer tåget 1,5–2,5 min före planerad ankomst och står till planerad avgång (väntan)
  const p = AN.proposeTimetable(threeRuns(), { from: 'A', to: 'D', basis: 'median' });
  assert.equal(p.rows[2].dwellValue, 1, 'uppehållet räknas från planerad ankomst, inte från den tidiga ankomsten');
  close(p.rows[1].dwellValue, 0.5, 'sen ankomst i B: verkligt uppehåll');
  assert.deepEqual(p.rows.map(r => [r.arrivalRounded, r.departureRounded]), [[null, 0], [6, 6], [7, 8], [11, null]]);
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
