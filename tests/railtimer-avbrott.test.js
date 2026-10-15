'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AV = require('../railtimer-avbrott.js');

// Fem stationer på en rak nord-sydlig linje, ungefär 3,3 km mellan varje
const route = [0, 1, 2, 3, 4].map(i => ({ name: 'S' + i, lat: 58.0 + i * 0.03, lon: 13.0, radius: 200 }));
const between = (i, f) => ({ lat: 58.0 + (i + f) * 0.03, lon: 13.0 });

test('detectInterruption: ingen tidigare position ger inget avbrott', () => {
  assert.equal(AV.detectInterruption(null, { t: 1000, lat: 58, lon: 13 }), null);
});

test('detectInterruption: exakt 20 s räcker inte', () => {
  const prev = { t: 0, lat: 58.0, lon: 13.0 };
  const fix = { t: 20000, lat: 58.01, lon: 13.0 };
  assert.equal(AV.detectInterruption(prev, fix), null);
});

test('detectInterruption: mer än 20 s och minst 150 m ger avbrott med avrundad sträcka', () => {
  const prev = { t: 0, lat: 58.0, lon: 13.0 };
  const fix = { t: 20001, lat: 58.0014, lon: 13.0 }; // ≈ 156 m
  const intr = AV.detectInterruption(prev, fix);
  assert.ok(intr);
  assert.equal(intr.from, 0);
  assert.equal(intr.to, 20001);
  assert.equal(intr.distanceM, Math.round(AV.haversine(58.0, 13.0, 58.0014, 13.0)));
});

test('detectInterruption: långt glapp utan förflyttning är inget avbrott', () => {
  const prev = { t: 0, lat: 58.0, lon: 13.0 };
  const fix = { t: 60000, lat: 58.0009, lon: 13.0 }; // ≈ 100 m
  assert.equal(AV.detectInterruption(prev, fix), null);
});

test('isWithinInterruption: gränserna from < t ≤ to + 2 s', () => {
  const intr = [{ from: '2026-10-15T05:00:00.000Z', to: '2026-10-15T05:03:00.000Z' }];
  assert.equal(AV.isWithinInterruption('2026-10-15T05:00:00.000Z', intr), null);
  assert.ok(AV.isWithinInterruption('2026-10-15T05:00:00.001Z', intr));
  assert.ok(AV.isWithinInterruption('2026-10-15T05:03:02.000Z', intr));
  assert.equal(AV.isWithinInterruption('2026-10-15T05:03:02.001Z', intr), null);
  assert.equal(AV.isWithinInterruption(null, intr), null);
});

test('applyInterruptionWindows: tid inom avbrott blir null med fönster, andra lämnas', () => {
  const intr = [{ from: '2026-10-15T05:00:00.000Z', to: '2026-10-15T05:03:00.000Z', distanceM: 2100 }];
  const stops = [
    { name: 'Källby', actualArrival: '2026-10-15T04:59:30.000Z', actualDeparture: '2026-10-15T05:03:00.500Z', arrivalSource: 'gps', departSource: 'gps' }
  ];
  const out = AV.applyInterruptionWindows(stops, intr);
  assert.equal(out[0].actualArrival, '2026-10-15T04:59:30.000Z');
  assert.equal(out[0].arrivalSource, 'gps');
  assert.equal(out[0].actualDeparture, null);
  assert.deepEqual(out[0].departureWindow, { from: '2026-10-15T05:00:00.000Z', to: '2026-10-15T05:03:00.000Z' });
  assert.equal(out[0].departSource, 'avbrott');
  assert.equal(stops[0].actualDeparture, '2026-10-15T05:03:00.500Z', 'indata får inte ändras');
});

test('applyInterruptionWindows: fungerar med Date-objekt och utan avbrott', () => {
  const stops = [{ actualArrival: new Date('2026-10-15T05:01:00Z'), actualDeparture: null }];
  assert.deepEqual(AV.applyInterruptionWindows(stops, []), [{ actualArrival: stops[0].actualArrival, actualDeparture: null }]);
  const out = AV.applyInterruptionWindows(stops, [{ from: Date.parse('2026-10-15T05:00:00Z'), to: Date.parse('2026-10-15T05:02:00Z') }]);
  assert.equal(out[0].actualArrival, null);
  assert.equal(out[0].arrivalSource, 'avbrott');
});

test('planCatchUp: tåget är fortfarande före nästa station – ingen ändring', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 1, nextIndex: 2, awaitingDepartureIndex: null }, between(1, 0.5));
  assert.equal(plan, null);
});

test('planCatchUp: två stationer passerade – appen kommer ikapp och avgången blir okänd', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 1, nextIndex: 2, awaitingDepartureIndex: 1 }, between(3, 0.5));
  assert.deepEqual(plan, { passed: [2, 3], lastReachedIndex: 3, nextIndex: 4, departedDuringGap: 1 });
});

test('planCatchUp: inom radien för en senare station blir den nästa station', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 1, nextIndex: 2, awaitingDepartureIndex: null }, { lat: route[3].lat + 0.0005, lon: 13.0 });
  assert.deepEqual(plan, { passed: [2], lastReachedIndex: 2, nextIndex: 3, departedDuringGap: null });
});

test('planCatchUp: inom radien för nästa station utan väntande avgång – vanlig logik tar hand om det', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 1, nextIndex: 2, awaitingDepartureIndex: null }, { lat: route[2].lat, lon: 13.0 });
  assert.equal(plan, null);
});

test('planCatchUp: avgick under avbrottet och står redan vid nästa station – avgången blir okänd', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 1, nextIndex: 2, awaitingDepartureIndex: 1 }, { lat: route[2].lat, lon: 13.0 });
  assert.deepEqual(plan, { passed: [], lastReachedIndex: 1, nextIndex: 2, departedDuringGap: 1 });
});

test('planCatchUp: avgick under avbrottet och står mellan stationerna – avgången blir okänd', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 1, nextIndex: 2, awaitingDepartureIndex: 1 }, between(1, 0.5));
  assert.deepEqual(plan, { passed: [], lastReachedIndex: 1, nextIndex: 2, departedDuringGap: 1 });
});

test('planCatchUp: kvar innanför stationens utgångsgräns (radie + 150 m) – vanlig logik avgör avgången', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 1, nextIndex: 2, awaitingDepartureIndex: 1 }, between(1, 0.075)); // ≈ 250 m
  assert.equal(plan, null);
});

test('planCatchUp: station med egen radie har ingen extra marginal, som i appen', () => {
  const custom = route.map((s, i) => (i === 1 ? Object.assign({}, s, { customRadius: true }) : s));
  const plan = AV.planCatchUp(custom, { lastReachedIndex: 1, nextIndex: 2, awaitingDepartureIndex: 1 }, between(1, 0.075)); // ≈ 250 m
  assert.deepEqual(plan, { passed: [], lastReachedIndex: 1, nextIndex: 2, departedDuringGap: 1 });
});

test('planCatchUp: går aldrig bakåt', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 2, nextIndex: 3, awaitingDepartureIndex: null }, between(0, 0.5));
  assert.equal(plan, null);
});

test('planCatchUp: förbi sista stationens radie – slutstationen blir nästa', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 0, nextIndex: 1, awaitingDepartureIndex: null }, { lat: route[4].lat + 0.01, lon: 13.0 });
  assert.deepEqual(plan, { passed: [1, 2, 3], lastReachedIndex: 3, nextIndex: 4, departedDuringGap: null });
});

test('markStationMissed och markDepartureUnknown sätter fält och fönster', () => {
  const intr = { from: Date.parse('2026-10-15T05:00:00Z'), to: Date.parse('2026-10-15T05:04:00Z') };
  const st = { actualArrival: 'x', actualDeparture: 'y', inZone: true, needsArrivalRetiming: true };
  AV.markStationMissed(st, intr);
  assert.equal(st.missedReason, 'avbrott');
  assert.equal(st.actualArrival, null);
  assert.equal(st.actualDeparture, null);
  assert.deepEqual(st.arrivalWindow, { from: '2026-10-15T05:00:00.000Z', to: '2026-10-15T05:04:00.000Z' });
  assert.equal(st.inZone, false);
  const st2 = { actualArrival: 'a', actualDeparture: null, inZone: true, departureProvisional: true };
  AV.markDepartureUnknown(st2, intr);
  assert.equal(st2.actualArrival, 'a');
  assert.equal(st2.departSource, 'avbrott');
  assert.deepEqual(st2.departureWindow, { from: '2026-10-15T05:00:00.000Z', to: '2026-10-15T05:04:00.000Z' });
  assert.equal(st2.departureProvisional, false);
});
