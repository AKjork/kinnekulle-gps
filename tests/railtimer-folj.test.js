// node --test "tests/*.test.js" – Var är tåget? (railtimer-folj.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../railtimer-folj.js');

// Fyra stationer rakt norrut, ca 5,6 km isär
const M = 60000;
const T0 = Date.UTC(2026, 10, 26, 7, 0, 0);
const route = [
  { sig: 'A', name: 'Astad', lat: 58.00, lon: 13.0 },
  { sig: 'B', name: 'Bby', lat: 58.05, lon: 13.0 },
  { sig: 'C', name: 'Cköping', lat: 58.10, lon: 13.0 },
  { sig: 'D', name: 'Dala', lat: 58.15, lon: 13.0 }
];
const axis = F.buildRouteAxis(route, []);
const at = (km) => ({ lat: 58.0 + km / 111.2, lon: 13.0 }); // km norr om A
// Vårt tågs linje: A, B, driftplatsen X mellan B och C, C, D; plan var 6:e minut
function line(reports) {
  const plan = { A: [null, 0], B: [5, 6], X: [9, 9], C: [12, 13], D: [18, null] };
  return ['A', 'B', 'X', 'C', 'D'].map(sig => Object.assign({
    sig, arr: null, dep: null,
    planArr: plan[sig][0] != null ? T0 + plan[sig][0] * M : null,
    planDep: plan[sig][1] != null ? T0 + plan[sig][1] * M : null
  }, (reports || {})[sig] || {}));
}

test('linjen längs rutten: raka linjer, och spårets sträckning när den finns', () => {
  assert.equal(axis.stationD.length, 4);
  assert.deepEqual(axis.legKind, ['rak', 'rak', 'rak']);
  assert.ok(Math.abs(axis.stationD[1] - 5560) < 30, String(axis.stationD[1]));
  // Spåret A–B med en krok österut, åt fel håll (börjar vid B): vänds, och blir längre än fågelvägen
  const bend = [[58.05, 13.0], [58.025, 13.02], [58.0, 13.0]];
  const ax2 = F.buildRouteAxis(route, [bend]);
  assert.deepEqual(ax2.legKind, ['spår', 'rak', 'rak']);
  assert.ok(ax2.stationD[1] > axis.stationD[1] + 200, 'längs spåret');
  const loc = F.locate(ax2, { lat: 58.025, lon: 13.02 });
  assert.ok(loc.off < 5 && Math.abs(loc.d - ax2.stationD[1] / 2) < 50, JSON.stringify(loc));
  // Ett spår som inte slutar vid stationen används inte
  assert.deepEqual(F.buildRouteAxis(route, [[[58.0, 13.0], [58.02, 13.0]]]).legKind[0], 'rak');
  assert.equal(F.buildRouteAxis([route[0]], []), null);
});

test('bara rapporter: avgått från A – någonstans mellan A och B, aldrig ett exakt läge', () => {
  const r = F.follow({ route, axis, line: line({ A: { dep: T0 + 30000 } }), now: T0 + 3 * M });
  assert.equal(r.source, 'rapport');
  assert.equal(r.passedIdx, 0);
  assert.equal(r.atIdx, null);
  assert.equal(r.nextIdx, 1);
  assert.deepEqual(r.between, [0, 1]);
  assert.equal(r.distM, null, 'inget avstånd utan position');
  assert.deepEqual(r.stations[0].dep, { t: T0 + 30000, src: 'rapport' });
  assert.equal(r.lastReport.sig, 'A');
  assert.equal(r.lastReport.delayMin, 1);
});

test('rapport på en driftplats mellan stationerna: B passerad, mellan B och C', () => {
  const r = F.follow({ route, axis, line: line({ A: { dep: T0 }, B: { arr: T0 + 5 * M, dep: T0 + 6 * M }, X: { dep: T0 + 9 * M } }), now: T0 + 10 * M });
  assert.equal(r.passedIdx, 1);
  assert.equal(r.nextIdx, 2);
  assert.deepEqual(r.between, [1, 2]);
  assert.equal(r.lastReport.sig, 'X');
  assert.deepEqual(r.stations[1].arr, { t: T0 + 5 * M, src: 'rapport' });
});

test('ankomsten rapporterad men inte avgången: vid B, och långt efter planerad avgång bara "vid eller efter"', () => {
  const l = line({ A: { dep: T0 }, B: { arr: T0 + 5 * M } });
  const r1 = F.follow({ route, axis, line: l, now: T0 + 7 * M });
  assert.equal(r1.atIdx, 1, 'står vid B');
  assert.equal(r1.nextIdx, 2);
  assert.equal(r1.unsure, null);
  const r2 = F.follow({ route, axis, line: l, now: T0 + 10 * M });
  assert.equal(r2.atIdx, null, 'appen säger inte att tåget står kvar');
  assert.equal(r2.unsure, 1);
  assert.equal(r2.nextIdx, 2);
  assert.deepEqual(r2.between, [1, 2]);
  assert.equal(r2.stations[1].passed, false, 'B räknas inte som passerad');
  // Trafikverket har en beräknad avgång längre fram: då står tåget kvar
  l[1].estDep = T0 + 12 * M;
  assert.equal(F.follow({ route, axis, line: l, now: T0 + 10 * M }).atIdx, 1);
});

test('position: mellan B och C med avstånd, passage med ca-tid, stopp i C och avgång därifrån', () => {
  const l = line({ A: { dep: T0 } });
  let memo = null;
  const step = (km, t, speed) => {
    const r = F.follow({ route, axis, line: l, pos: Object.assign(at(km), { t, speedKmh: speed }), memo, now: t + 10000 });
    memo = r.memo;
    return r;
  };
  const r1 = step(4, T0 + 4 * M, 80);
  assert.equal(r1.source, 'position');
  assert.equal(r1.nextIdx, 1);
  assert.ok(Math.abs(r1.distM - 1560) < 40, String(r1.distM));
  assert.equal(r1.between, null, 'läget är känt');
  assert.equal(r1.pos.ageS, 10);
  // Förbi B utan att stanna: ca-tid mitt emellan positionerna, B passerad
  const r2 = step(7, T0 + 6 * M, 80);
  assert.equal(r2.passedIdx, 1);
  assert.equal(r2.nextIdx, 2);
  assert.equal(r2.stations[1].arr.src, 'ca');
  const tB = r2.stations[1].arr.t;
  assert.ok(Math.abs(tB - (T0 + 4 * M + (5.56 - 4) / 3 * 2 * M)) < 3000, new Date(tB).toISOString());
  assert.equal(r2.stations[1].dep.t, tB, 'passage: samma tid');
  // Stannar i C (11,12 km)
  step(10.9, T0 + 9 * M, 20);
  const r3 = step(11.15, T0 + 10 * M, 0);
  assert.equal(r3.atIdx, 2, 'står vid C');
  assert.equal(r3.stations[2].arr.src, 'ca');
  assert.equal(r3.stations[2].dep, null, 'ingen avgång medan tåget står (mitten passerades vid inbromsningen)');
  step(11.15, T0 + 11 * M, 0);
  // Positionen hoppar bakåt (fel i uppgifterna): ingenting går bakåt
  const back = step(2, T0 + 11 * M + 20000, 0);
  assert.equal(back.pos.used, false);
  assert.equal(back.pos.why, 'bakom tåget');
  assert.equal(back.passedIdx, 1);
  // Lämnar C
  const r4 = step(12, T0 + 12 * M, 40);
  assert.equal(r4.passedIdx, 2);
  assert.equal(r4.nextIdx, 3);
  assert.equal(r4.stations[2].dep.t, T0 + 11.5 * M, 'avgång mellan sista stillastående och första i rörelse');
  // Framme i D
  const r5 = step(16.68, T0 + 17 * M, 0);
  assert.equal(r5.done, true);
  assert.equal(r5.nextIdx, null);
});

test('position: gammal, eller långt från linjen, används inte; rapporterna gäller då', () => {
  const l = line({ A: { dep: T0 } });
  const old = F.follow({ route, axis, line: l, pos: Object.assign(at(7), { t: T0, speedKmh: 80 }), now: T0 + 6 * M });
  assert.equal(old.pos.used, false);
  assert.equal(old.pos.why, 'gammal');
  assert.equal(old.source, 'rapport');
  assert.deepEqual(old.between, [0, 1]);
  const far = F.follow({ route, axis, line: l, pos: { lat: 58.05, lon: 13.1, t: T0 + 5 * M, speedKmh: 80 }, now: T0 + 5 * M });
  assert.equal(far.pos.why, 'långt från linjen');
  assert.equal(far.nextIdx, 1);
});

test('före avgång: vid startstationen, eller på väg dit', () => {
  const l = line();
  const r = F.follow({ route, axis, line: l, now: T0 - 5 * M });
  assert.equal(r.atIdx, 0);
  assert.equal(r.nextIdx, 1);
  assert.equal(r.source, 'ingen');
  const before = F.follow({ route, axis, line: l, pos: Object.assign(at(-3), { t: T0 - 5 * M, speedKmh: 90 }), now: T0 - 5 * M });
  assert.equal(before.atIdx, 0);
  assert.equal(before.approaching, true);
  assert.ok(Math.abs(before.distM - 3000) < 50, String(before.distM));
});

test('slutstationen: rapporterad ankomst ger framme', () => {
  const r = F.follow({ route, axis, line: line({ A: { dep: T0 }, D: { arr: T0 + 18 * M } }), now: T0 + 18 * M });
  assert.equal(r.done, true);
  assert.equal(r.atIdx, 3);
  assert.ok(r.stations.every(s => s.passed));
  assert.deepEqual(r.stations[3].arr, { t: T0 + 18 * M, src: 'rapport' });
});

test('gångprofilernas linje: stationerna längs den, och uppmätta sträckor räknas som spår', () => {
  const pts = [[58.0, 13.0, 0], [58.05, 13.0, 5560], [58.10, 13.0, 11120], [58.15, 13.0, 16680]];
  const ax = F.fromInfoAxis({ pts, meas: [true, false, true], len: 16680, stations: { A: 0, B: 5560 } }, route);
  assert.deepEqual(ax.stationD.map(Math.round), [0, 5560, 11120, 16680]);
  assert.deepEqual(ax.legKind, ['spår', 'rak', 'spår']);
});

test('beräknad ankomst: från positionen, och utan position från tidtabellen och senaste förseningen', () => {
  const r2 = route.map((s, i) => Object.assign({}, s, { planArr: i ? T0 + [0, 5, 12, 18][i] * M : null, planDep: i < 3 ? T0 + [0, 6, 13][i] * M : null }));
  // Halvvägs mellan B och C, 2 min sena: halva sträckan (6 min plan) kvar från positionens tid
  const p = F.follow({ route: r2, axis, line: line({ A: { dep: T0 }, B: { arr: T0 + 7 * M, dep: T0 + 8 * M } }),
    pos: Object.assign(at(8.34), { t: T0 + 11.5 * M, speedKmh: 90 }), now: T0 + 11.5 * M });
  assert.equal(p.est.by, 'position');
  assert.equal(p.est.idx, 2);
  assert.ok(Math.abs(p.est.t - (T0 + 14.5 * M)) < 10000, new Date(p.est.t).toISOString());
  // Utan position: avgick A 3 min sent. Klockan 10 bör tåget ha passerat B (plan 5 + 3 = 8) men inte C (12 + 3)
  const r = F.follow({ route: r2, axis, line: line({ A: { dep: T0 + 3 * M } }), now: T0 + 10 * M });
  assert.equal(r.nextIdx, 1, 'B räknas inte som passerad');
  assert.deepEqual([r.est.idx, r.est.by, r.est.behind, r.est.delayMin], [2, 'plan', true, 3]);
  assert.equal(r.est.t, T0 + 15 * M);
  assert.equal(r.stations[1].passed, false);
  // Före tiden: nästa enligt plan är nästa station
  const early = F.follow({ route: r2, axis, line: line({ A: { dep: T0 + 3 * M } }), now: T0 + 4 * M });
  assert.deepEqual([early.est.idx, early.est.behind, early.est.t], [1, false, T0 + 8 * M]);
});
