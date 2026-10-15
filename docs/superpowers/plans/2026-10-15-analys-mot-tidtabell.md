# Analys mot tidtabell – genomförandeplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Analysverktyget visar var tidtabellen är för snål eller för generös: gångtid per sträcka, samt ankomst, väntan och avgång per station. Det går att filtrera på avvikelsetyp, tid på dygnet, vardag eller helg, tolerans och stationstyp. Både avvikelser och tidtabellsförslag kan exporteras till Excel och PDF, och det framgår hur många mätningar de bygger på.

**Architecture:**
- All beräkning ligger i en ny modul utan beroenden, `railtimer-analys.js`. Den följer samma mönster som `railtimer-avbrott.js` och testas med Node.
- `Analys.html` läser in körningarna med sammanslagna stationsnamn och filtrerar dem med modulen.
- Resultatet visas i två flikar: Mot tidtabell, som ersätter Jämför, och Tidtabell, med förslag per riktning.
- Export sker som CSV i samma format som appens export, och som utskrift via webbläsaren.

**Tech Stack:**
- Vanilla JS i en HTML-fil (befintligt mönster).
- Node 22+ (`node --test`).
- Chrome utan fönster via `tests/run-browser-tests.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-15-analys-mot-tidtabell-design.md`

## Global Constraints

- **`index.html`, `Kinnekulle GPS.html` och `sw.js` ändras inte.** Appens mätlogik och regressionsfacit påverkas inte.
- **Tolerans:** ±0,5, ±1 eller ±2 min, med ±1 förvalt. Exakt ±tol räknas som i tid. Avvikelser räknas på exakta sekunder.
- **Bedömning kräver minst 3 mätningar med tidtabell** (`MIN_SAMPLES = 3`). Annars blir den "För få mätningar".
- **Tidsindelning:**
  - Tid på dygnet: morgon 05–09, dag 09–15, eftermiddag 15–18 och kväll 18–05.
  - Lördag och söndag är helg.
  - Allt avgörs av körningens start i lokal tid. Starten är den verkliga avgången från första stationen, annars `startedAt`.
- **Stationsnamn:**
  - Herrljunga → Herrljunga C, Hallsberg personbangård → Hallsberg och Framnäs City → Framnäs city.
  - Andra namn som bara skiljer sig i stor och liten bokstav får den vanligaste stavningen.
- **Passage** är `shouldStop === false` eller `departSource === 'gps-pass'`.
- **Uppehåll i tidtabellsförslaget räknas från planerad ankomst** när tåget kom före den. Väntan på tidtabellen ingår inte.
- **CSV:**
  - BOM först, semikolon mellan fälten, varje fält inom citattecken och radbrytningen `\n`.
  - Decimalkomma.
  - Ett informationsblock överst: titel, Bygger på, Period, Urval, Tolerans, … och Skapad.
- **All text** är på svenska, med å, ä och ö.
- **Inga npm-beroenden.** Tester körs med `node --test "tests/*.test.js"` och `node tests/run-browser-tests.mjs [filter]`.
- **Var arbetet sker:** i `C:\Users\andre\kinnekulle-gps-ux-wt` på grenen `feat/analys-tidtabell`. Ingen push sker. Publicering görs bara i uppgift 6, med Andrés uttryckliga OK.
- **Commit-meddelanden** avslutas med `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Station 1 och 2 i en riktning som ingen körning går.** Tidtabell ska säga *"Inga körningar går från X till Y i urvalet."* i stället för att visa ett tomt eller felaktigt förslag. Test i uppgift 4.
2. **Ett urval utan körningar**, till exempel helg när det inte finns några helgkörningar. Alla flikar ska visa tomma lägen utan fel, och Mot tidtabell ska visa *"Inga körningar med tidtabellstider i urvalet."* Test i uppgift 2 och 3.
3. **Passagepunkter med bara planerad avgång.** Den planerade gångtiden ska räknas mot passagetiden och inte bli tom eller fel. Test i uppgift 1.
4. **Tåget kommer tidigt och står och väntar.** Förslaget får inte bygga in väntan på tidtabellen i uppehållet. Test i uppgift 1.
5. **Gamla körningar med äldre stationsnamn**, som Herrljunga och Hallsberg personbangård, ska slås ihop med dagens namn i alla flikar. Test i uppgift 1 och 2.

---

## Filer

| Fil | Ansvar |
|---|---|
| `railtimer-analys.js` (ny) | Stationsnamn, urval, observationer, sammanställningar, tidtabellsförslag och CSV. Rena funktioner. |
| `tests/railtimer-analys.test.js` (ny) | Node-tester för modulen. |
| `Analys.html` | Nya filter och sammanslagna namn vid inläsning. Fliken Mot tidtabell ersätter Jämför. Tidtabell visar förslag per riktning. Export, utskrift och testkrokar. |
| `tests/replay.html` | Webbläsartester för analysverktyget och bilder av de nya flikarna. |
| `tests/run-browser-tests.mjs` | Bilder som tas som utskrift (`-utskrift`). |
| `CLAUDE.md` | Dokumentation. |

---

### Task 1: Beräkningsmodulen `railtimer-analys.js`

**Files:**
- Create: `tests/railtimer-analys.test.js`, `railtimer-analys.js`

**Interfaces:**
- Produces, som global `RailTimerAnalys` i webbläsaren och `module.exports` i Node:
  - **Konstanter:** `DEFAULT_TOLERANCE = 1`, `MIN_SAMPLES = 3` och `STATION_ALIASES`.
  - **Stationsnamn:**
    - `canonicalStation(name) → string`
    - `normalizeRuns(runs) → runs`. Ändrar inte indata.
  - **Tid och urval:**
    - `localDate(d) → 'ÅÅÅÅ-MM-DD' | null`
    - `runStart(run) → Date | null`
    - `timeOfDay(d) → 'morgon' | 'dag' | 'eftermiddag' | 'kvall' | null`
    - `dayType(d) → 'vardag' | 'helg' | null`
    - `runMatches(run, {vehicle, train, dateFrom, dateTo, timeOfDay, dayType}) → boolean`
    - `period(runs) → {from, to} | null`
  - **Klassning:**
    - `stopType(stop) → 'stopp' | 'passage' | null`
    - `classify(dev, tol) → 'sen' | 'itid' | 'tidig' | null`
  - **Observationer:**
    - `segmentObservations(runs, {tolerance}) → [{key, from, to, actual, planned, deviation, category, fromType, toType, trainNumber, vehicleType, date, start, runId}]`
    - `stationObservations(runs, {tolerance, stationType}) → [{key, station, towards, from, type, arrivalDev, departureDev, arrivalCategory, departureCategory, dwell, plannedDwell, wait, trainNumber, vehicleType, date, start, runId}]`
    - `stationLabel(row) → 'Källby (mot Blomberg)' | 'Hällekis (från Råbäck)'`
  - **Statistik:**
    - `stats(values) → {n, median, p90, mean}`
    - `mode(values) → number | null`
  - **Sammanställningar:**
    - `summarizeSegments(obs, {tolerance}) → [{key, from, to, n, nPlanned, planned, plannedMin, plannedMax, actual, deviation, counts: {sen, itid, tidig}, assessment: 'snal' | 'generos' | 'lagom' | 'fa', suggestion, change}]`
    - `summarizeStations(obs, {tolerance}) → [{key, station, towards, from, label, type, n, nPlanned, arrivalDev, arrivalCounts, departureDev, departureCounts, wait, dwell, plannedDwell, assessment: 'vantan' | 'sen-ankomst' | 'sen-avgang' | 'itid' | 'fa'}]`
  - **Riktning och förslag:**
    - `directedRuns(runs, from, to) → {list: [{run, i, j}], route}`
    - `sliceRuns(runs, from, to) → runs`
    - `proposeTimetable(runs, {from, to, basis, stops}) → {from, to, basis, route, rows, missing, runCount, period, totalMin, totalRounded}`. Varje rad har `station, isFirst, isLast, isStop, defaultStop, stopCount, passCount, arrival, departure, arrivalRounded, departureRounded, leg, legValue, legRounded, plannedLeg, plannedLegMin, plannedLegMax, legChange, dwell, dwellValue`. Utan körningar i riktningen blir `error: 'ingen-riktning'`.
  - **Export:**
    - `formatMinutes(v, decimals) → '3,3'`
    - `csvDocument(title, meta, sections) → string`

- [ ] **Step 1: Skriv testerna**

Skapa `tests/railtimer-analys.test.js`:
```js
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
  close(b.wait, 2 + 10 / 60, 'väntan');
  close(b.departureDev, 10 / 60, 'avgång');
  assert.equal(b.departureCategory, 'itid');
  const c = obs.find(o => o.station === 'C');
  assert.deepEqual([c.key, c.towards, c.from, c.arrivalCategory, c.wait], ['C|från|B', null, 'B', 'itid', null]);
  assert.equal(obs.find(o => o.station === 'A').key, 'A|mot|B');
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
```

- [ ] **Step 2: Kör testerna och kontrollera att de misslyckas**

Run: `node --test "tests/railtimer-analys.test.js"`
Expected: FAIL med `Cannot find module '../railtimer-analys.js'`.

- [ ] **Step 3: Skriv modulen**

Skapa `railtimer-analys.js`:
```js
/* RailTimer – analys av mätningar mot tidtabellen (avvikelser, väntan, tidtabellsförslag, export).
   Rena funktioner utan beroenden. Används av Analys.html och testas med node --test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RailTimerAnalys = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_TOLERANCE = 1;   // minuter: inom ±1 min räknas som i tid, som i appen
  const MIN_SAMPLES = 3;         // färre mätningar med tidtabell ger bedömningen "För få mätningar"

  // Namnbyten verifierade mot Trafikverkets TrainStation-API 2026-10-15 (signatur i kommentaren)
  const STATION_ALIASES = {
    'herrljunga': 'Herrljunga C',             // Hrc
    'hallsberg personbangård': 'Hallsberg',   // Hpbg
    'framnäs city': 'Framnäs city'            // Fc
  };
  // Målnamnen är också sina egna alias, så att deras stavning alltid vinner
  Object.values(STATION_ALIASES).forEach(name => { STATION_ALIASES[name.toLowerCase()] = name; });

  // ── Stationsnamn ──

  function nameKey(name) {
    return String(name == null ? '' : name).trim().toLowerCase();
  }

  function canonicalStation(name) {
    return STATION_ALIASES[nameKey(name)] || String(name == null ? '' : name).trim();
  }

  // Nya körningsobjekt där samma station alltid har samma namn. Ändrar inte indata.
  function normalizeRuns(runs) {
    const list = Array.isArray(runs) ? runs.filter(r => r && typeof r === 'object') : [];
    // Namn som bara skiljer sig i stor och liten bokstav får den vanligaste stavningen i datan
    const counts = new Map();
    for (const run of list) {
      for (const stop of run.stops || []) {
        const name = String(stop && stop.name != null ? stop.name : '').trim();
        const key = nameKey(name);
        if (!name || STATION_ALIASES[key]) continue;
        if (!counts.has(key)) counts.set(key, new Map());
        const spellings = counts.get(key);
        spellings.set(name, (spellings.get(name) || 0) + 1);
      }
    }
    const spelling = new Map();
    for (const [key, spellings] of counts) {
      const best = Array.from(spellings.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      spelling.set(key, best);
    }
    const fix = name => {
      const key = nameKey(name);
      return STATION_ALIASES[key] || spelling.get(key) || String(name == null ? '' : name).trim();
    };
    return list.map(run => Object.assign({}, run, {
      startStation: run.startStation ? fix(run.startStation) : run.startStation,
      endStation: run.endStation ? fix(run.endStation) : run.endStation,
      stops: (run.stops || []).map(stop => Object.assign({}, stop, { name: fix(stop && stop.name) }))
    }));
  }

  // ── Tid ──

  function toDate(v) {
    if (v == null || v === '') return null;
    // Datum känns igen på getTime(): testriggen byter ut Date, och instanceof gäller då inte
    const d = typeof v.getTime === 'function' ? new Date(v.getTime()) : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function localDate(v) {
    const d = toDate(v);
    return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null;
  }

  // Körningens starttid: verklig avgång från första stationen, annars startedAt
  function runStart(run) {
    const first = run && Array.isArray(run.stops) ? run.stops[0] : null;
    return toDate(first && first.actualDeparture) || toDate(run && run.startedAt);
  }

  function timeOfDay(v) {
    const d = toDate(v);
    if (!d) return null;
    const h = d.getHours();
    if (h >= 5 && h < 9) return 'morgon';
    if (h >= 9 && h < 15) return 'dag';
    if (h >= 15 && h < 18) return 'eftermiddag';
    return 'kvall';
  }

  function dayType(v) {
    const d = toDate(v);
    if (!d) return null;
    const day = d.getDay();
    return day === 0 || day === 6 ? 'helg' : 'vardag';
  }

  // filter: { vehicle, train, dateFrom, dateTo, timeOfDay, dayType } – tomt värde betyder alla
  function runMatches(run, filter) {
    const f = filter || {};
    if (!run || run.aborted) return false;
    if (f.vehicle && run.vehicleType !== f.vehicle) return false;
    if (f.train && String(run.trainNumber || '') !== String(f.train)) return false;
    const start = runStart(run);
    if (f.dateFrom || f.dateTo) {
      const d = localDate(start);
      if (!d) return false;
      if (f.dateFrom && d < f.dateFrom) return false;
      if (f.dateTo && d > f.dateTo) return false;
    }
    if (f.timeOfDay && timeOfDay(start) !== f.timeOfDay) return false;
    if (f.dayType && dayType(start) !== f.dayType) return false;
    return true;
  }

  // Tidigaste och senaste startdatum bland körningarna
  function period(runs) {
    const dates = (runs || []).map(r => localDate(runStart(r))).filter(Boolean).sort();
    return dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null;
  }

  // ── Stationer och avvikelser ──

  // Passage: inget planerat stopp, eller appen registrerade en genomfart
  function stopType(stop) {
    if (!stop) return null;
    return stop.shouldStop === false || stop.departSource === 'gps-pass' ? 'passage' : 'stopp';
  }

  // Avvikelse i minuter → 'sen' (> +tol), 'tidig' (< −tol) eller 'itid'. Exakt ±tol är i tid.
  function classify(dev, tol) {
    if (dev == null || !isFinite(dev)) return null;
    const t = tol == null ? DEFAULT_TOLERANCE : tol;
    if (dev > t) return 'sen';
    if (dev < -t) return 'tidig';
    return 'itid';
  }

  // Passagepunkter har bara planerad avgång; den används då som planerad passagetid
  function plannedDeparture(stop) { return toDate(stop.scheduledDeparture) || toDate(stop.scheduledArrival); }
  function plannedArrival(stop) { return toDate(stop.scheduledArrival) || toDate(stop.scheduledDeparture); }

  function minutes(a, b) { return (b - a) / 60000; }

  function runInfo(run) {
    const start = runStart(run);
    return {
      trainNumber: run.trainNumber || '',
      vehicleType: run.vehicleType || '',
      date: localDate(start),
      start: start ? start.toISOString() : null,
      runId: run.id != null ? String(run.id) : ''
    };
  }

  // Gångtid per sträcka mellan intilliggande stationer, med planerad gångtid när tidtabell finns
  function segmentObservations(runs, opts) {
    const tol = opts && opts.tolerance != null ? opts.tolerance : DEFAULT_TOLERANCE;
    const out = [];
    for (const run of runs || []) {
      const stops = run.stops || [];
      const info = runInfo(run);
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i];
        const b = stops[i + 1];
        const dep = toDate(a.actualDeparture);
        const arr = toDate(b.actualArrival);
        if (!dep || !arr || b.excludeInboundRun) continue;
        const actual = minutes(dep, arr);
        if (!(actual > 0.1 && actual < 180)) continue;
        const pDep = plannedDeparture(a);
        const pArr = plannedArrival(b);
        const planned = pDep && pArr && pArr >= pDep ? minutes(pDep, pArr) : null;
        const deviation = planned != null ? actual - planned : null;
        out.push(Object.assign({
          key: `${a.name} → ${b.name}`, from: a.name, to: b.name,
          actual, planned, deviation, category: classify(deviation, tol),
          fromType: stopType(a), toType: stopType(b)
        }, info));
      }
    }
    return out;
  }

  // Ankomst, avgång, uppehåll och väntan per station; opts.stationType begränsar till 'stopp' eller 'passage'
  function stationObservations(runs, opts) {
    const tol = opts && opts.tolerance != null ? opts.tolerance : DEFAULT_TOLERANCE;
    const typeFilter = (opts && opts.stationType) || '';
    const out = [];
    for (const run of runs || []) {
      const stops = run.stops || [];
      const info = runInfo(run);
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        const aArr = toDate(s.actualArrival);
        const aDep = toDate(s.actualDeparture);
        if (!aArr && !aDep) continue;
        const type = stopType(s);
        if (typeFilter && type !== typeFilter) continue;
        const next = stops[i + 1];
        const prev = stops[i - 1];
        const towards = next ? next.name : null;
        const from = !next && prev ? prev.name : null;
        const pArr = toDate(s.scheduledArrival);
        const pDep = toDate(s.scheduledDeparture);
        const arrivalDev = aArr && pArr ? minutes(pArr, aArr) : null;
        const departureDev = aDep && pDep ? minutes(pDep, aDep) : null;
        const dwell = type === 'stopp' && aArr && aDep && aDep >= aArr ? minutes(aArr, aDep) : null;
        const plannedDwell = pArr && pDep && pDep >= pArr ? minutes(pArr, pDep) : null;
        const arrivalCategory = classify(arrivalDev, tol);
        // Väntan: tåget kom för tidigt och stod längre än planerat
        const wait = arrivalCategory === 'tidig' && dwell != null && plannedDwell != null ? Math.max(0, dwell - plannedDwell) : null;
        out.push(Object.assign({
          key: towards ? `${s.name}|mot|${towards}` : `${s.name}|från|${from || ''}`,
          station: s.name, towards, from, type,
          arrivalDev, departureDev, arrivalCategory, departureCategory: classify(departureDev, tol),
          dwell, plannedDwell, wait
        }, info));
      }
    }
    return out;
  }

  function stationLabel(row) {
    return row.towards ? `${row.station} (mot ${row.towards})` : `${row.station} (från ${row.from || '?'})`;
  }

  // ── Statistik ──

  function sortedValues(values) {
    return (values || []).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
  }

  // Linjär interpolation, samma som median och P90 i Analys.html
  function quantileSorted(s, q) {
    if (!s.length) return null;
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  function stats(values) {
    const s = sortedValues(values);
    if (!s.length) return { n: 0, median: null, p90: null, mean: null };
    return { n: s.length, median: quantileSorted(s, 0.5), p90: quantileSorted(s, 0.9), mean: s.reduce((a, b) => a + b, 0) / s.length };
  }

  // Vanligaste värdet (på hela sekunder); vid lika antal det minsta
  function mode(values) {
    const counts = new Map();
    for (const v of values || []) {
      if (v == null || !isFinite(v)) continue;
      const k = Math.round(v * 60) / 60;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let best = null;
    let bestN = 0;
    for (const [k, n] of counts) {
      if (n > bestN || (n === bestN && k < best)) { best = k; bestN = n; }
    }
    return best;
  }

  function countCategories(list, field) {
    const c = { sen: 0, itid: 0, tidig: 0 };
    for (const o of list) if (o[field]) c[o[field]] += 1;
    return c;
  }

  function groupBy(list, key) {
    const groups = new Map();
    for (const o of list || []) {
      if (!groups.has(o[key])) groups.set(o[key], []);
      groups.get(o[key]).push(o);
    }
    return groups;
  }

  // ── Sammanställningar ──

  function summarizeSegments(obs, opts) {
    const tol = opts && opts.tolerance != null ? opts.tolerance : DEFAULT_TOLERANCE;
    const rows = [];
    for (const [key, list] of groupBy(obs, 'key')) {
      const withPlan = list.filter(o => o.planned != null);
      const plannedValues = withPlan.map(o => o.planned);
      const planned = mode(plannedValues);
      const actual = stats(list.map(o => o.actual));
      const deviation = stats(withPlan.map(o => o.deviation));
      let assessment;
      if (withPlan.length < MIN_SAMPLES) assessment = 'fa';
      else if (deviation.median > tol) assessment = 'snal';
      else if (deviation.median < -tol) assessment = 'generos';
      else assessment = 'lagom';
      const suggestion = actual.median != null ? Math.round(actual.median) : null;
      rows.push({
        key, from: list[0].from, to: list[0].to,
        n: list.length, nPlanned: withPlan.length,
        planned,
        plannedMin: plannedValues.length ? Math.min(...plannedValues) : null,
        plannedMax: plannedValues.length ? Math.max(...plannedValues) : null,
        actual, deviation,
        counts: countCategories(withPlan, 'category'),
        assessment, suggestion,
        change: suggestion != null && planned != null ? Math.round(suggestion - planned) : null
      });
    }
    // Sträckor med tillräckligt underlag först, störst avvikelse först; sedan få mätningar, sist utan tidtabell
    const group = r => (r.nPlanned >= MIN_SAMPLES ? 0 : r.nPlanned > 0 ? 1 : 2);
    rows.sort((a, b) => group(a) - group(b)
      || Math.abs(b.deviation.median || 0) - Math.abs(a.deviation.median || 0)
      || b.n - a.n || a.key.localeCompare(b.key));
    return rows;
  }

  const STATION_ORDER = { vantan: 0, 'sen-ankomst': 1, 'sen-avgang': 2, itid: 3, fa: 4 };

  function summarizeStations(obs, opts) {
    const tol = opts && opts.tolerance != null ? opts.tolerance : DEFAULT_TOLERANCE;
    const rows = [];
    for (const [key, list] of groupBy(obs, 'key')) {
      const first = list[0];
      const passages = list.filter(o => o.type === 'passage').length;
      const arr = list.filter(o => o.arrivalDev != null);
      const dep = list.filter(o => o.departureDev != null);
      const nPlanned = list.filter(o => o.arrivalDev != null || o.departureDev != null).length;
      const arrivalDev = stats(arr.map(o => o.arrivalDev));
      const departureDev = stats(dep.map(o => o.departureDev));
      let assessment;
      if (nPlanned < MIN_SAMPLES) assessment = 'fa';
      else if (arrivalDev.median != null && arrivalDev.median < -tol) assessment = 'vantan';
      else if (arrivalDev.median != null && arrivalDev.median > tol) assessment = 'sen-ankomst';
      else if (departureDev.median != null && departureDev.median > tol) assessment = 'sen-avgang';
      else assessment = 'itid';
      rows.push({
        key, station: first.station, towards: first.towards, from: first.from,
        label: stationLabel(first),
        type: passages > list.length - passages ? 'passage' : 'stopp',
        n: list.length, nPlanned,
        arrivalDev, arrivalCounts: countCategories(arr, 'arrivalCategory'),
        departureDev, departureCounts: countCategories(dep, 'departureCategory'),
        wait: stats(list.filter(o => o.wait != null && o.wait > 0).map(o => o.wait)),
        dwell: stats(list.map(o => o.dwell)),
        plannedDwell: mode(list.map(o => o.plannedDwell)),
        assessment
      });
    }
    rows.sort((a, b) => STATION_ORDER[a.assessment] - STATION_ORDER[b.assessment] || b.n - a.n || a.label.localeCompare(b.label));
    return rows;
  }

  // ── Riktning och tidtabellsförslag ──

  // Körningar som går från `from` till `to` i den ordningen, plus den längsta rutten mellan dem
  function directedRuns(runs, from, to) {
    const list = [];
    let route = [];
    for (const run of runs || []) {
      const names = (run.stops || []).map(s => s.name);
      const i = names.indexOf(from);
      const j = names.indexOf(to);
      if (i === -1 || j === -1 || i >= j) continue;
      list.push({ run, i, j });
      if (j - i + 1 > route.length) route = names.slice(i, j + 1);
    }
    return { list, route };
  }

  // Körningarna avskurna till sträckan from → to (bara den riktningen)
  function sliceRuns(runs, from, to) {
    return directedRuns(runs, from, to).list.map(({ run, i, j }) => Object.assign({}, run, { stops: run.stops.slice(i, j + 1) }));
  }

  /* Förslag till tidtabell från `from` till `to`, bara den riktningen.
     opts: { from, to, basis: 'median' | 'p90' | 'mean', stops: { station: true/false } (valfritt) }
     Klockslag är minuter från avgången i `from`: exakta tider läggs ihop och varje klockslag avrundas
     sedan till hela minuter, så att avrundningsfelen inte växer. */
  function proposeTimetable(runs, opts) {
    const from = opts.from;
    const to = opts.to;
    const basis = opts.basis || 'median';
    const chosen = opts.stops || {};
    const { list, route } = directedRuns(runs, from, to);
    if (!list.length) return { from, to, basis, error: 'ingen-riktning', route: [], rows: [], runCount: 0, missing: [] };

    const legs = new Map();
    const plannedLegs = new Map();
    const dwells = new Map();
    const types = new Map();
    const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
    for (const { run, i, j } of list) {
      const stops = run.stops;
      for (let k = i; k <= j; k++) {
        const s = stops[k];
        if (!types.has(s.name)) types.set(s.name, { stopp: 0, passage: 0 });
        types.get(s.name)[stopType(s)] += 1;
        if (k > i && k < j && stopType(s) === 'stopp') {
          const a = toDate(s.actualArrival);
          const d = toDate(s.actualDeparture);
          const pa = toDate(s.scheduledArrival);
          // Kom tåget före planerad ankomst räknas uppehållet därifrån: väntan på tidtabellen ska inte in i förslaget
          const from = a && pa && pa > a ? pa : a;
          if (from && d) {
            const m = minutes(from, d);
            if (m > 0.05 && m < 60) push(dwells, s.name, m);
          }
        }
        if (k < j) {
          const b = stops[k + 1];
          const legKey = `${s.name} → ${b.name}`;
          const dep = toDate(s.actualDeparture);
          const arr = toDate(b.actualArrival);
          if (dep && arr && !b.excludeInboundRun) {
            const m = minutes(dep, arr);
            if (m > 0.1 && m < 180) push(legs, legKey, m);
          }
          const pDep = plannedDeparture(s);
          const pArr = plannedArrival(b);
          if (pDep && pArr && pArr >= pDep) push(plannedLegs, legKey, minutes(pDep, pArr));
        }
      }
    }

    const missing = [];
    let cum = 0;
    let known = true;
    let prevDepRounded = 0;
    const rows = route.map((name, idx) => {
      const isFirst = idx === 0;
      const isLast = idx === route.length - 1;
      const t = types.get(name) || { stopp: 0, passage: 0 };
      const defaultStop = isFirst || isLast || t.stopp >= t.passage;
      const isStop = isFirst || isLast || (chosen[name] != null ? !!chosen[name] : defaultStop);
      const row = {
        station: name, isFirst, isLast, isStop, defaultStop, stopCount: t.stopp, passCount: t.passage,
        arrival: null, departure: null, arrivalRounded: null, departureRounded: null,
        leg: null, legValue: null, legRounded: null, plannedLeg: null, plannedLegMin: null, plannedLegMax: null, legChange: null,
        dwell: null, dwellValue: null, plannedDwell: null
      };
      if (isFirst) {
        row.departure = 0;
        row.departureRounded = 0;
        return row;
      }
      const legKey = `${route[idx - 1]} → ${name}`;
      row.leg = stats(legs.get(legKey) || []);
      row.legValue = row.leg.n ? row.leg[basis] : null;
      const planned = plannedLegs.get(legKey) || [];
      row.plannedLeg = mode(planned);
      row.plannedLegMin = planned.length ? Math.min(...planned) : null;
      row.plannedLegMax = planned.length ? Math.max(...planned) : null;
      if (row.legValue == null) { known = false; missing.push(legKey); }
      if (known) {
        cum += row.legValue;
        row.arrival = cum;
        row.arrivalRounded = Math.round(cum);
        row.legRounded = row.arrivalRounded - prevDepRounded;
        if (row.plannedLeg != null) row.legChange = Math.round(row.legRounded - row.plannedLeg);
      }
      if (!isLast) {
        if (isStop) {
          row.dwell = stats(dwells.get(name) || []);
          row.dwellValue = row.dwell.n ? row.dwell[basis] : null;
          if (row.dwellValue == null && known) { known = false; missing.push(`uppehåll i ${name}`); }
        }
        if (known) {
          cum += isStop ? row.dwellValue : 0;
          row.departure = cum;
          row.departureRounded = Math.round(cum);
          prevDepRounded = row.departureRounded;
        }
      }
      return row;
    });
    const last = rows[rows.length - 1];
    return {
      from, to, basis, route, rows, missing,
      runCount: list.length,
      period: period(list.map(x => x.run)),
      totalMin: known ? last.arrival : null,
      totalRounded: known ? last.arrivalRounded : null
    };
  }

  // ── Export ──

  // Minuter med decimalkomma, utan "-0,0"
  function formatMinutes(v, decimals) {
    if (v == null || !isFinite(v)) return '';
    const d = decimals == null ? 1 : decimals;
    const s = v.toFixed(d);
    return (/^-0(\.0+)?$/.test(s) ? s.slice(1) : s).replace('.', ',');
  }

  function csvCell(v) {
    if (v == null) return '""';
    const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : formatMinutes(v)) : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /* CSV för Excel: BOM, semikolon, varje fält inom citattecken, decimalkomma (samma som appens export).
     meta: [[rubrik, värde], ...], sections: [{ title (valfri), header: [...], rows: [[...], ...] }] */
  function csvDocument(title, meta, sections) {
    const lines = [[title]];
    for (const pair of meta || []) lines.push(pair);
    for (const section of sections || []) {
      lines.push([]);
      if (section.title) lines.push([section.title]);
      lines.push(section.header);
      for (const row of section.rows) lines.push(row);
    }
    return '﻿' + lines.map(cells => cells.map(csvCell).join(';')).join('\n');
  }

  return {
    DEFAULT_TOLERANCE, MIN_SAMPLES, STATION_ALIASES,
    canonicalStation, normalizeRuns,
    localDate, runStart, timeOfDay, dayType, runMatches, period,
    stopType, classify, segmentObservations, stationObservations, stationLabel,
    stats, mode, summarizeSegments, summarizeStations,
    directedRuns, sliceRuns, proposeTimetable,
    formatMinutes, csvDocument
  };
});
```

- [ ] **Step 4: Kör testerna**

Run: `node --test "tests/railtimer-analys.test.js"` och sedan `node --test "tests/*.test.js"`
Expected: `ℹ pass 20` och `ℹ fail 0`. För hela Node-sviten: `ℹ pass 67` och `ℹ fail 0`.

- [ ] **Step 5: Committa**

```bash
git add railtimer-analys.js tests/railtimer-analys.test.js
git commit -m "Beräkningsmodul för analys mot tidtabell: avvikelser, väntan, förslag och CSV

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Stationsnamn och nya filter i `Analys.html`

Körningarna läses in med sammanslagna stationsnamn, oavsett källa. Fyra nya filter tillkommer: tid på dygnet, dag, tolerans och stationstyp. Alla flikar filtreras med `RailTimerAnalys.runMatches`, så att datumfiltret använder lokalt datum. Testkrokarna flyttas sist i skriptet och får `setFilters`, `showTab` och `getLastDownload`. Variablerna för de kommande flikarna läggs till nu.

**Files:**
- Modify: `Analys.html`, `tests/replay.html`

**Interfaces:**
- Consumes: `RailTimerAnalys.{normalizeRuns, runMatches, stopType}` (Task 1).
- Produces i `Analys.html`:
  - `const AN`, `currentFilter() → {vehicle, train, dateFrom, dateTo, timeOfDay, dayType}` och `buildDwellSegments(logs, stationType)`.
  - Variablerna `currentRuns`, `ttChoices`, `ttRouteKey`, `lastTimetable`, `againstState` och `lastDownload`.
  - Testkroken `window.__analys` med `setFetchForTest`, `loadFromGithub`, `getLogs`, `setFilters(values)`, `showTab(name)` och `getLastDownload()`.
- Produces i `tests/replay.html`: `atMin(min, day)`, `ttStop(name, o)`, `againstRuns()`, `loadAnalysWith(runs)` och `tableRows(w, id)`.

- [ ] **Step 1: Skriv testerna**

Lägg till före raden `// ── Körning ──` i `tests/replay.html`:
```js
// ── Analys mot tidtabell: urval och stationsnamn ──

// Minuter efter midnatt den 15 oktober 2026 (torsdag, lokal tid) som ISO-tid
function atMin(min, day) { return new Date(new Date(2026, 9, day || 15).getTime() + Math.round(min * 60000)).toISOString(); }

function ttStop(name, o) {
  const t = v => (v == null ? null : atMin(v));
  return {
    name,
    actualArrival: t(o.arr), actualDeparture: t(o.dep),
    scheduledArrival: t(o.sArr), scheduledDeparture: t(o.sDep),
    arrivalSource: o.arr != null ? 'gps' : '', departSource: o.dep != null ? 'gps' : '',
    shouldStop: true
  };
}

/* Lidköping → Blomberg med tidtabell 07:00, 07:03/07:04, 07:09/07:10, 07:13 (minuter efter start):
   Lidköping → Filsbäck tar 2–3 min för lång tid (snål), Filsbäck → Källby 4 min för kort tid (generös,
   väntan i Källby), Källby → Blomberg i tid. Tre morgonkörningar, en kvällskörning helt i tid och två
   körningar mitt på dagen i motsatt riktning utan tidtabell. */
function againstRuns() {
  const forward = (id, s, ab) => {
    const bArr = s + ab, bDep = bArr + 0.5, cArr = bDep + 1, cDep = s + 10, dArr = cDep + 3;
    return {
      id, trainNumber: '3344', vehicleType: 'Y31', startedAt: atMin(s), aborted: false, startStation: 'Lidköping', endStation: 'Blomberg',
      stops: [
        ttStop('Lidköping', { dep: s, sDep: s }),
        ttStop('Filsbäck', { arr: bArr, dep: bDep, sArr: s + 3, sDep: s + 4 }),
        ttStop('Källby', { arr: cArr, dep: cDep, sArr: s + 9, sDep: s + 10 }),
        ttStop('Blomberg', { arr: dArr, sArr: s + 13 })
      ]
    };
  };
  const onTime = (id, s) => ({
    id, trainNumber: '3344', vehicleType: 'Y31', startedAt: atMin(s), aborted: false, startStation: 'Lidköping', endStation: 'Blomberg',
    stops: [
      ttStop('Lidköping', { dep: s, sDep: s }),
      ttStop('Filsbäck', { arr: s + 3, dep: s + 4, sArr: s + 3, sDep: s + 4 }),
      ttStop('Källby', { arr: s + 9, dep: s + 10, sArr: s + 9, sDep: s + 10 }),
      ttStop('Blomberg', { arr: s + 13, sArr: s + 13 })
    ]
  });
  const reverse = (id, s) => ({
    id, trainNumber: '3355', vehicleType: 'Y31', startedAt: atMin(s), aborted: false, startStation: 'Blomberg', endStation: 'Lidköping',
    stops: [
      ttStop('Blomberg', { dep: s }),
      ttStop('Källby', { arr: s + 4, dep: s + 5 }),
      ttStop('Filsbäck', { arr: s + 10, dep: s + 11 }),
      ttStop('Lidköping', { arr: s + 16 })
    ]
  });
  return [forward('f1', 420, 5), forward('f2', 450, 5.5), forward('f3', 480, 6), onTime('k1', 1140), reverse('r1', 720), reverse('r2', 750)];
}

// Laddar analysverktyget med körningarna som enskilda filer i ett simulerat repo
async function loadAnalysWith(runs) {
  const w = await loadAnalys();
  w.localStorage.clear();
  await new Promise(resolve => { const req = w.indexedDB.deleteDatabase('railtimer-analys'); req.onsuccess = req.onerror = req.onblocked = () => resolve(); });
  w.localStorage.setItem('railtimer_github_v1', JSON.stringify({ repo: 'AKjork/railtimer-data', token: 'test-token', branch: 'main' }));
  const fake = browserFakeGitHub(w);
  runs.forEach(r => fake.put('korningar/2026/' + r.id + '.json', JSON.stringify(r)));
  w.__analys.setFetchForTest(fake.fetch);
  await w.__analys.loadFromGithub();
  return w;
}

// Tabellens rader som listor med cellernas text
function tableRows(w, id) {
  return Array.from(w.document.querySelectorAll('#' + id + ' tbody tr')).map(tr => Array.from(tr.cells).map(td => td.textContent.trim()));
}

test('analys: tid på dygnet begränsar urvalet', async () => {
  const w = await loadAnalysWith(againstRuns());
  const trips = () => w.document.getElementById('statTrips').textContent;
  assertEqual(trips(), '6', 'alla körningar');
  w.__analys.setFilters({ filterTimeOfDay: 'morgon' });
  assertEqual(trips(), '3', 'morgon');
  w.__analys.setFilters({ filterTimeOfDay: 'dag' });
  assertEqual(trips(), '2', 'dag');
  w.__analys.setFilters({ filterTimeOfDay: 'kvall' });
  assertEqual(trips(), '1', 'kväll');
  w.__analys.setFilters({ filterTimeOfDay: '', filterDayType: 'helg' });
  assertEqual(trips(), '0', 'helg');
  // Två valda stationer får inte få analysen att krascha
  w.__analys.setFilters({ filterDayType: '', filterFrom: 'Lidköping', filterTo: 'Blomberg' });
  assertEqual(trips(), '6', 'två stationer valda');
});

test('analys: samma station med två namn slås ihop vid inläsning', async () => {
  const runs = againstRuns().slice(0, 2);
  runs[0].stops[3].name = 'Herrljunga';
  runs[1].stops[3].name = 'Herrljunga C';
  const w = await loadAnalysWith(runs);
  const names = new Set(w.__analys.getLogs().map(r => r.stops[3].name));
  assertEqual(Array.from(names), ['Herrljunga C'], 'stationsnamn');
  const options = Array.from(w.document.querySelectorAll('#stationList1 option')).map(o => o.value);
  assert(!options.includes('Herrljunga'), 'det gamla namnet ska inte finnas i stationslistan');
});

```

- [ ] **Step 2: Kör testerna och kontrollera att de misslyckas**

Run: `node tests/run-browser-tests.mjs "analys:"`
Expected: `2 lyckades, 2 misslyckades`. Det är de två befintliga analystesterna som lyckas. De nya misslyckas så här:
- `✖ analys: tid på dygnet begränsar urvalet` med `w.__analys.setFilters is not a function`.
- `✖ analys: samma station med två namn slås ihop vid inläsning` med `stationsnamn: fick ["Herrljunga","Herrljunga C"], väntade ["Herrljunga C"]`.

- [ ] **Step 3: Sammanslagna namn, nya filter och testkrokar**

I `Analys.html`, ersätt:
```html
<script src="railtimer-github.js"></script>
<script>
```
med:
```html
<script src="railtimer-github.js"></script>
<script src="railtimer-analys.js"></script>
<script>
```

I `Analys.html`, ersätt:
```html
    <div class="filters">
      <label style="display:flex;align-items:center;gap:.4rem;font-size:.85rem;color:var(--ink-dim)">
        <input type="checkbox" id="chkMergeDir" checked> Slå ihop riktningar (A↔B)
      </label>
    </div>
```
med:
```html
    <div class="filters">
      <div class="filter-group">
        <label for="filterTimeOfDay">Tid på dygnet</label>
        <select id="filterTimeOfDay">
          <option value="">Alla</option>
          <option value="morgon">Morgon 05–09</option>
          <option value="dag">Dag 09–15</option>
          <option value="eftermiddag">Eftermiddag 15–18</option>
          <option value="kvall">Kväll 18–05</option>
        </select>
      </div>
      <div class="filter-group">
        <label for="filterDayType">Dag</label>
        <select id="filterDayType">
          <option value="">Alla</option>
          <option value="vardag">Vardag</option>
          <option value="helg">Helg</option>
        </select>
      </div>
      <div class="filter-group">
        <label for="filterTolerance">Tolerans</label>
        <select id="filterTolerance" title="Avvikelser inom toleransen räknas som i tid">
          <option value="0.5">±0,5 min</option>
          <option value="1" selected>±1 min</option>
          <option value="2">±2 min</option>
        </select>
      </div>
      <div class="filter-group">
        <label for="filterStationType">Stationstyp</label>
        <select id="filterStationType" title="Gäller stationer i Mot tidtabell och uppehållstider">
          <option value="">Alla</option>
          <option value="stopp">Stopp</option>
          <option value="passage">Passage</option>
        </select>
      </div>
    </div>
    <div class="filters">
      <label style="display:flex;align-items:center;gap:.4rem;font-size:.85rem;color:var(--ink-dim)">
        <input type="checkbox" id="chkMergeDir" checked> Slå ihop riktningar (A↔B)
      </label>
    </div>
```

I `Analys.html`, ersätt:
```js
  const TEST_MODE = new URLSearchParams(location.search).has('test');
  let testFetch = null;                 // simulerat GitHub i testerna
```
med:
```js
  const TEST_MODE = new URLSearchParams(location.search).has('test');
  const AN = window.RailTimerAnalys;    // analys mot tidtabell (railtimer-analys.js)
  let testFetch = null;                 // simulerat GitHub i testerna
```

I `Analys.html`, ersätt:
```js
    filterDateTo: document.getElementById('filterDateTo'),
    btnClearFilters: document.getElementById('btnClearFilters'),
```
med:
```js
    filterDateTo: document.getElementById('filterDateTo'),
    filterTimeOfDay: document.getElementById('filterTimeOfDay'),
    filterDayType: document.getElementById('filterDayType'),
    filterTolerance: document.getElementById('filterTolerance'),
    filterStationType: document.getElementById('filterStationType'),
    btnClearFilters: document.getElementById('btnClearFilters'),
```

I `Analys.html`, ersätt:
```js
  els.filterDateTo.addEventListener('change', runAnalysis);
```
med:
```js
  els.filterDateTo.addEventListener('change', runAnalysis);
  els.filterTimeOfDay.addEventListener('change', runAnalysis);
  els.filterDayType.addEventListener('change', runAnalysis);
  els.filterTolerance.addEventListener('change', runAnalysis);
  els.filterStationType.addEventListener('change', runAnalysis);
```

I `Analys.html`, ersätt:
```js
      const r = await RailTimerGitHub.loadRunsFromRepo({ client, cache: BlobCache });
      allLogs = r.runs;
```
med:
```js
      const r = await RailTimerGitHub.loadRunsFromRepo({ client, cache: BlobCache });
      allLogs = AN.normalizeRuns(r.runs);
```

I `Analys.html`, ersätt:
```js
      allLogs = JSON.parse(raw);
      if(!Array.isArray(allLogs)) allLogs = [];
```
med:
```js
      const parsed = JSON.parse(raw);
      allLogs = AN.normalizeRuns(Array.isArray(parsed) ? parsed : []);
```

I `Analys.html`, ersätt:
```js
        seen.add(key);
        allLogs.push(log);
      }

```
med:
```js
        seen.add(key);
        allLogs.push(log);
      }
      allLogs = AN.normalizeRuns(allLogs);

```

I `Analys.html`, ersätt:
```js
    els.filterDateFrom.value = '';
    els.filterDateTo.value = '';
    runAnalysis();
```
med:
```js
    els.filterDateFrom.value = '';
    els.filterDateTo.value = '';
    els.filterTimeOfDay.value = '';
    els.filterDayType.value = '';
    els.filterTolerance.value = '1';
    els.filterStationType.value = '';
    runAnalysis();
```

I `Analys.html`, ersätt:
```js
    const mergeDir = els.chkMergeDir.checked;
    const filterVehicle = els.filterVehicle.value;
    const filterTrain = validTrains.has(els.filterTrain.value) ? els.filterTrain.value : '';
    // Only use station filter if it's a valid station name
    const filterFrom = validStations.has(els.filterFrom.value) ? els.filterFrom.value : '';
    const filterTo = validStations.has(els.filterTo.value) ? els.filterTo.value : '';
    const filterDateFrom = els.filterDateFrom.value;
    const filterDateTo = els.filterDateTo.value;

    // Filter logs first
    let filteredLogs = allLogs.filter(log => {
      if(log.aborted) return false;
      if(filterVehicle && log.vehicleType !== filterVehicle) return false;
      if(filterTrain && log.trainNumber !== filterTrain) return false;
      if(filterDateFrom || filterDateTo){
        const logDate = log.startedAt ? new Date(log.startedAt).toISOString().slice(0,10) : null;
        if(!logDate) return false;
        if(filterDateFrom && logDate < filterDateFrom) return false;
        if(filterDateTo && logDate > filterDateTo) return false;
      }
      return true;
    });

```
med:
```js
    const mergeDir = els.chkMergeDir.checked;
    // Only use station filter if it's a valid station name
    const filterFrom = validStations.has(els.filterFrom.value) ? els.filterFrom.value : '';
    const filterTo = validStations.has(els.filterTo.value) ? els.filterTo.value : '';

    // Filter logs first – samma urval i alla flikar (datum, tid på dygnet och dag i lokal tid)
    const filter = currentFilter();
    let filteredLogs = allLogs.filter(log => AN.runMatches(log, filter));
    currentRuns = filteredLogs;

```

I `Analys.html`, ersätt:
```js
      segments = buildDwellSegments(filteredLogs);
```
med:
```js
      segments = buildDwellSegments(filteredLogs, els.filterStationType.value);
```

I `Analys.html`, ersätt:
```js
  function buildDwellSegments(logs){
    const results = [];

    for(const log of logs){
      const stops = log.stops || [];
      const logDate = log.startedAt ? new Date(log.startedAt).toISOString().slice(0,10) : '?';

      for(const stop of stops){
        const hasArrival = !!stop.actualArrival;
```
med:
```js
  function buildDwellSegments(logs, stationType){
    const results = [];

    for(const log of logs){
      const stops = log.stops || [];
      const logDate = log.startedAt ? new Date(log.startedAt).toISOString().slice(0,10) : '?';

      for(const stop of stops){
        if(stationType && AN.stopType(stop) !== stationType) continue;
        const hasArrival = !!stop.actualArrival;
```

I `Analys.html`, ersätt:
```js
  function updateModeLabels(){
```
med:
```js
  // Urval på körningsnivå från filterpanelen (samma i alla flikar)
  function currentFilter(){
    return {
      vehicle: els.filterVehicle.value,
      train: validTrains.has(els.filterTrain.value) ? els.filterTrain.value : '',
      dateFrom: els.filterDateFrom.value,
      dateTo: els.filterDateTo.value,
      timeOfDay: els.filterTimeOfDay.value,
      dayType: els.filterDayType.value
    };
  }

  function updateModeLabels(){
```

I `Analys.html`, ersätt:
```js
  let validStations = new Set();
  let ttRoute = [];
  let ttRunningStats = {};
  let ttDwellStats = {};
```
med:
```js
  let validStations = new Set();
  let ttRoute = [];
  let ttRunningStats = {};
  let ttDwellStats = {};
  let currentRuns = [];          // körningarna i aktuellt urval
  let ttChoices = {};            // valda stopp i tidtabellsförslaget: { station: true/false }
  let ttRouteKey = '';
  let lastTimetable = null;      // senaste tidtabellsförslaget
  let againstState = null;       // senaste analysen i Mot tidtabell
  let lastDownload = null;       // senaste exporten (läses av testerna)
```

I `Analys.html`, ta bort:
```js
  if(TEST_MODE){
    window.__analys = { setFetchForTest: fn => { testFetch = fn; }, loadFromGithub, getLogs: () => allLogs };
  }


```

I `Analys.html`, ersätt:
```js
  // Initialize
  showEmpty();

```
med:
```js
  // Bara i testläge: tests/replay.html styr verktyget genom de här funktionerna
  if(TEST_MODE){
    window.__analys = {
      setFetchForTest: fn => { testFetch = fn; },
      loadFromGithub,
      getLogs: () => allLogs,
      setFilters(values){
        for(const [id, value] of Object.entries(values)) document.getElementById(id).value = value;
        runAnalysis();
      },
      showTab(name){ document.querySelector('.tab[data-tab="' + name + '"]').click(); },
      getLastDownload: () => lastDownload
    };
  }

  // Initialize
  showEmpty();

```

- [ ] **Step 4: Kör testerna**

Run: `node tests/run-browser-tests.mjs`
Expected: `22 lyckades, 0 misslyckades`. Regressionen för appen ska också gå igenom.

- [ ] **Step 5: Committa**

```bash
git add Analys.html tests/replay.html
git commit -m "Analysverktyget: sammanslagna stationsnamn och filter för tid på dygnet, dag, tolerans och stationstyp

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Fliken Mot tidtabell (ersätter Jämför)

**Files:**
- Modify: `Analys.html`, `tests/replay.html`

**Interfaces:**
- Consumes: `RailTimerAnalys.{sliceRuns, segmentObservations, stationObservations, summarizeSegments, summarizeStations, period, stationLabel, formatMinutes, csvDocument, localDate, DEFAULT_TOLERANCE}` (Task 1), och `currentFilter`, `currentRuns`, `againstState`, `lastDownload` och testkrokarna (Task 2).
- Produces i `Analys.html`:
  - **Gemensamt för flikarna:** `ASSESSMENT_LABELS`, `TIME_OF_DAY_LABELS`, `DAY_LABELS`, `TYPE_LABELS`, `BASIS_LABELS`, `AGAINST_TITLE` och `TIMETABLE_TITLE`.
  - **Formatering:** `esc(v)`, `toleranceValue()`, `fmtMin(v, d)`, `fmtSigned(v, d)`, `fmtTol(t)`, `plannedText(p, min, max)`, `periodText(p)`, `nowText()` och `safeFilePart(s)`.
  - **Export och utskrift:** `describeFilter(extra)`, `downloadText(filename, text)`, `preparePrint(reportId, title, meta) → text` och `printReport(reportId, title, meta)`.
  - **Mot tidtabell:** `renderAgainst(runs)`, `renderAgainstDetail(kind, key)`, `againstMeta(d)`, `exportAgainstCsv() → text` och `printAgainst()`.
  - **Testkrokar:** `exportAgainstCsv` och `prepareAgainstPrint`.

- [ ] **Step 1: Skriv testerna**

Lägg till före raden `// ── Körning ──` i `tests/replay.html`:
```js
// ── Analys mot tidtabell: fliken Mot tidtabell ──

test('analys: Mot tidtabell visar snål sträcka, generös sträcka och väntan', async () => {
  const w = await loadAnalysWith(againstRuns());
  w.__analys.showTab('against');
  const summary = w.document.getElementById('againstSummary').textContent;
  assert(summary.includes('Bygger på 4 körningar med tidtabell av 6 i urvalet'), 'sammanfattning: ' + summary);
  const seg = tableRows(w, 'againstSegments');
  assertEqual(seg.slice(0, 3).map(r => [r[0], r[10]]),
    [['Filsbäck → Källby', 'Generös'], ['Lidköping → Filsbäck', 'Snål'], ['Källby → Blomberg', 'Lagom']], 'sträckor och bedömning');
  const kallby = tableRows(w, 'againstStations').find(r => r[0] === 'Källby (mot Blomberg)');
  assertEqual([kallby[6], kallby[11]], ['3', 'Tidig – väntan'], 'väntan i Källby');
});

test('analys: Visa-väljaren visar bara sträckor där tidtabellen är snål', async () => {
  const w = await loadAnalysWith(againstRuns());
  const show = w.document.getElementById('againstShow');
  show.value = 'snal';
  show.dispatchEvent(new w.Event('change'));
  assertEqual(tableRows(w, 'againstSegments').map(r => r[0]), ['Lidköping → Filsbäck'], 'sträckor');
  assertEqual(w.document.getElementById('againstStationsBlock').style.display, 'none', 'stationerna döljs');
  show.value = 'vantan';
  show.dispatchEvent(new w.Event('change'));
  assertEqual(tableRows(w, 'againstStations').map(r => r[0]), ['Källby (mot Blomberg)'], 'stationer med väntan');
});

test('analys: klick på en sträcka visar de enskilda mätningarna', async () => {
  const w = await loadAnalysWith(againstRuns());
  const row = Array.from(w.document.querySelectorAll('#againstSegments tbody tr')).find(tr => tr.cells[0].textContent === 'Lidköping → Filsbäck');
  row.click();
  const detail = w.document.getElementById('againstDetail');
  assertEqual(detail.querySelector('h3').textContent, 'Lidköping → Filsbäck – 4 mätningar', 'rubrik');
  assertEqual(detail.querySelectorAll('tbody tr').length, 4, 'antal rader');
});

test('analys: export av avvikelser innehåller urval, antal mätningar och sträckorna', async () => {
  const w = await loadAnalysWith(againstRuns());
  const text = w.__analys.exportAgainstCsv();
  assert(text.charCodeAt(0) === 0xFEFF, 'BOM saknas');
  for (const part of ['"Bygger på";"4 körningar med tidtabell (av 6 i urvalet)"', '"Tolerans";"±1 min"',
    '"Lidköping → Filsbäck";"4";"4";"3";"3";"3";"5,3"', '"Källby";"mot Blomberg";"Stopp";"4"']) {
    assert(text.includes(part), 'saknas i CSV: ' + part);
  }
  assert(/^avvikelser_\d{4}-\d{2}-\d{2}\.csv$/.test(w.__analys.getLastDownload().filename), 'filnamn');
});

test('analys: utskriften får rubrik med urval och antal mätningar', async () => {
  const w = await loadAnalysWith(againstRuns());
  const header = w.__analys.prepareAgainstPrint();
  assert(header.includes('RailTimer – Avvikelser mot tidtabell'), 'rubrik');
  assert(header.includes('Bygger på: 4 körningar med tidtabell (av 6 i urvalet)'), 'antal: ' + header);
});

test('analys: med två stationer valda visar Mot tidtabell bara sträckan mellan dem i den riktningen', async () => {
  const w = await loadAnalysWith(againstRuns());
  w.__analys.setFilters({ filterFrom: 'Lidköping', filterTo: 'Källby' });
  const summary = w.document.getElementById('againstSummary').textContent;
  assert(summary.includes('av 4 i urvalet') && summary.includes('· sträcka Lidköping → Källby'), 'sammanfattning: ' + summary);
  assertEqual(tableRows(w, 'againstSegments').map(r => r[0]).sort(), ['Filsbäck → Källby', 'Lidköping → Filsbäck'], 'sträckor');
});

test('analys: urval utan körningar med tidtabell ger ett meddelande', async () => {
  const w = await loadAnalysWith(againstRuns());
  w.__analys.setFilters({ filterDayType: 'helg' });
  assertEqual(w.document.getElementById('againstSummary').textContent, 'Inga körningar med tidtabellstider i urvalet.', 'meddelande');
  assertEqual(w.document.getElementById('againstContent').style.display, 'none', 'tabellerna döljs');
});

```

- [ ] **Step 2: Kör testerna och kontrollera att de misslyckas**

Run: `node tests/run-browser-tests.mjs "analys:"`
Expected: `4 lyckades, 7 misslyckades`. De sju nya testerna misslyckas, eftersom fliken inte finns än:
- `✖ analys: Mot tidtabell visar snål sträcka, generös sträcka och väntan` med `Cannot read properties of null (reading 'click')`
- `✖ analys: Visa-väljaren visar bara sträckor där tidtabellen är snål` med `Cannot set properties of null (setting 'value')`
- `✖ analys: klick på en sträcka visar de enskilda mätningarna` med `Cannot read properties of undefined (reading 'click')`
- `✖ analys: export av avvikelser innehåller urval, antal mätningar och sträckorna` med `w.__analys.exportAgainstCsv is not a function`
- `✖ analys: utskriften får rubrik med urval och antal mätningar` med `w.__analys.prepareAgainstPrint is not a function`
- `✖ analys: med två stationer valda visar Mot tidtabell bara sträckan mellan dem i den riktningen` med `Cannot read properties of null (reading 'textContent')`
- `✖ analys: urval utan körningar med tidtabell ger ett meddelande` med `Cannot read properties of null (reading 'textContent')`

- [ ] **Step 3: Fliken, tabellerna, export och utskrift**

I `Analys.html`, ersätt:
```html
    <button class="tab" data-tab="compare">Jämför</button>
```
med:
```html
    <button class="tab" data-tab="against">Mot tidtabell</button>
```

I `Analys.html`, ersätt:
```html
  <div id="tabCompare" class="tab-content">
    <p class="meta" id="compareHint">Visar tidtabell vs verklighet per körning. Välj tågnummer i filtret ovan för att se körningar med tidtabellsdata.</p>
    <div id="compareContent"></div>
  </div>
```
med:
```html
  <div id="tabAgainst" class="tab-content">
    <div class="report" id="againstReport">
      <div class="print-header"></div>
      <p class="meta" id="againstSummary">Ladda data för att se analys.</p>
      <div id="againstContent" style="display:none">
        <div class="report-actions no-print">
          <div class="filter-group">
            <label for="againstShow">Visa</label>
            <select id="againstShow">
              <option value="alla">Alla sträckor och stationer</option>
              <option value="snal">Sträckor där tidtabellen är snål</option>
              <option value="generos">Sträckor där tidtabellen är generös</option>
              <option value="vantan">Stationer med väntan</option>
              <option value="sen-ankomst">Stationer med sen ankomst</option>
              <option value="sen-avgang">Stationer med sen avgång</option>
            </select>
          </div>
          <button id="btnAgainstCsv" class="ghost">Exportera till Excel</button>
          <button id="btnAgainstPrint" class="ghost">Skriv ut / PDF</button>
        </div>
        <div id="againstSegmentsBlock">
          <h3>Sträckor – gångtid mot tidtabell</h3>
          <div class="table-wrap">
            <table id="againstSegments" class="clickable">
              <thead><tr>
                <th>Sträcka</th>
                <th class="num" title="Antal mätta gångtider">Körningar</th>
                <th class="num" title="Mätningar där tidtabellstider finns">Med tidtabell</th>
                <th class="num" title="Vanligaste planerade gångtiden (min). Inom parentes: intervallet när den varierar mellan tåg">Planerad</th>
                <th class="num" title="Verklig gångtid, median (min)">Median</th>
                <th class="num" title="Verklig gångtid, 90:e percentilen (min)">P90</th>
                <th class="num" title="Verklig − planerad gångtid, median (min)">Avvikelse</th>
                <th class="num" title="Gångtiden var längre än planerat, mer än toleransen">För lite tid</th>
                <th class="num">I tid</th>
                <th class="num" title="Gångtiden var kortare än planerat, mer än toleransen – tåget får vänta">För mycket tid</th>
                <th>Bedömning</th>
                <th class="num" title="Verklig median avrundad till hela minuter. Inom parentes: ändring mot planerad">Förslag</th>
              </tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
        <div id="againstStationsBlock">
          <h3>Stationer – ankomst, väntan och avgång mot tidtabell</h3>
          <div class="table-wrap">
            <table id="againstStations" class="clickable">
              <thead><tr>
                <th>Station</th>
                <th>Typ</th>
                <th class="num">Körningar</th>
                <th class="num" title="Ankomst senare än planerat">Ank. sen</th>
                <th class="num">Ank. i tid</th>
                <th class="num" title="Ankomst tidigare än planerat">Ank. tidig</th>
                <th class="num" title="Gånger tåget kom tidigt och stod längre än planerat">Väntan</th>
                <th class="num" title="Väntan, median (min)">Väntan (min)</th>
                <th class="num" title="Vanligaste planerade uppehållet (min)">Planerat uppehåll</th>
                <th class="num" title="Verkligt uppehåll, median (min)">Verkligt uppehåll</th>
                <th class="num" title="Avgång senare än planerat">Avg. sen</th>
                <th>Bedömning</th>
              </tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
        <div id="againstDetail"></div>
        <p class="meta no-print">Klicka på en rad för att se de enskilda mätningarna. Avvikelse = verkligt − planerat i minuter; inom toleransen räknas som i tid. <strong>Snål</strong>: tåget behöver mer tid än tidtabellen ger. <strong>Generös</strong>: tåget kommer fram tidigt och får vänta. Bedömningen kräver minst 3 mätningar med tidtabell.</p>
      </div>
    </div>
  </div>
```

I `Analys.html`, ersätt:
```css
  .compare-log{margin-bottom:1.5rem}
  .compare-log h3{margin:.5rem 0}
  .compare-log .delay-early{color:var(--pri)}
  .compare-log .delay-late{color:var(--err)}
  .compare-log .delay-ok{color:var(--ink-dim)}
  .compare-log .no-data{color:var(--mut);font-style:italic}
```
med:
```css
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .assess{display:inline-block;padding:.1rem .4rem;border-radius:4px;font-size:.7rem;font-weight:600;white-space:nowrap}
  .assess.snal,.assess.sen-ankomst,.assess.sen-avgang{background:rgba(239,68,68,0.15);color:var(--err)}
  .assess.generos,.assess.vantan{background:rgba(59,130,246,0.15);color:var(--blue)}
  .assess.lagom,.assess.itid{background:rgba(34,197,94,0.15);color:var(--pri)}
  .assess.fa{background:var(--bg);color:var(--mut)}
  .clickable tbody tr[data-key]{cursor:pointer}
  .clickable tbody tr.selected td{background:var(--pri-glow)}
  .report-actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-end;margin:.5rem 0 1rem}
  .few{color:var(--warn);font-size:.7rem;white-space:nowrap}
  .change-up{color:var(--err)}
  .change-down{color:var(--blue)}
  .print-header{display:none}
  @media print{
    @page{margin:12mm}
    body{background:#fff;color:#000}
    header,.card,#modeDescription,.stats-row,.tabs,.no-print,.tab-content:not(.active),#ttHint,#againstSummary,#ttSummary{display:none !important}
    main{max-width:none;padding:0}
    .print-header{display:block;margin-bottom:.5rem}
    .print-header h2{margin:0 0 .25rem;color:#000;font-size:1.1rem}
    .print-header p{margin:.1rem 0;font-size:.75rem;color:#000}
    h3,.meta,.tt-note{color:#000}
    .table-wrap{border:none;overflow:visible}
    table{background:#fff;font-size:.7rem}
    th,td{border:1px solid #888;color:#000 !important;background:#fff !important;padding:.15rem .3rem}
    .assess,.few{background:none !important;color:#000 !important;padding:0}
    .timetable-result .pass{color:#444}
  }
```

I `Analys.html`, ersätt:
```js
    renderDetailsTable(segments);
    updateTimetable();
    renderCompare(filteredLogs);
  }
```
med:
```js
    renderDetailsTable(segments);
    updateTimetable(filteredLogs);
    renderAgainst(filteredLogs);
  }
```

I `Analys.html`, ersätt:
```js
    els.detailsTable.innerHTML = '<tr><td colspan="5" class="empty">Ladda data för att se analys</td></tr>';
    drawEmptyChart();
  }
```
med:
```js
    els.detailsTable.innerHTML = '<tr><td colspan="5" class="empty">Ladda data för att se analys</td></tr>';
    drawEmptyChart();
    againstState = null;
    lastTimetable = null;
    document.getElementById('againstSummary').textContent = 'Ladda data för att se analys.';
    document.getElementById('againstContent').style.display = 'none';
  }
```

I `Analys.html`, ersätt:
```js
  document.getElementById('ttTimeBasis').addEventListener('change', generateTimetable);
```
med:
```js
  document.getElementById('ttTimeBasis').addEventListener('change', generateTimetable);
  document.getElementById('againstShow').addEventListener('change', () => renderAgainst(currentRuns));
  document.getElementById('btnAgainstCsv').addEventListener('click', exportAgainstCsv);
  document.getElementById('btnAgainstPrint').addEventListener('click', printAgainst);
  ['againstSegments', 'againstStations'].forEach(id => {
    document.getElementById(id).addEventListener('click', e => {
      const tr = e.target.closest('tr[data-key]');
      if(tr) renderAgainstDetail(tr.dataset.kind, tr.dataset.key);
    });
  });
```

I `Analys.html`, ersätt:
```js
      showTab(name){ document.querySelector('.tab[data-tab="' + name + '"]').click(); },
      getLastDownload: () => lastDownload
```
med:
```js
      showTab(name){ document.querySelector('.tab[data-tab="' + name + '"]').click(); },
      exportAgainstCsv,
      prepareAgainstPrint: () => againstState && preparePrint('againstReport', AGAINST_TITLE, againstMeta(againstState)),
      getLastDownload: () => lastDownload
```

I `Analys.html`, ersätt:
```js
  // ── Compare: timetable vs reality ──

```
med:
```js
  // ── Gemensamt för Mot tidtabell och Tidtabell ──

  const ASSESSMENT_LABELS = {
    snal: 'Snål', generos: 'Generös', lagom: 'Lagom', fa: 'För få mätningar',
    vantan: 'Tidig – väntan', 'sen-ankomst': 'Sen ankomst', 'sen-avgang': 'Sen avgång', itid: 'I tid'
  };
  const TIME_OF_DAY_LABELS = { morgon: 'Morgon 05–09', dag: 'Dag 09–15', eftermiddag: 'Eftermiddag 15–18', kvall: 'Kväll 18–05' };
  const DAY_LABELS = { vardag: 'Vardag', helg: 'Helg' };
  const TYPE_LABELS = { stopp: 'Stopp', passage: 'Passage' };
  const BASIS_LABELS = { median: 'Median', p90: 'P90', mean: 'Medelvärde' };
  const AGAINST_TITLE = 'RailTimer – Avvikelser mot tidtabell';
  const TIMETABLE_TITLE = 'RailTimer – Tidtabellsförslag';

  function esc(v){ return escapeHtml(v == null ? '' : String(v)); }
  function toleranceValue(){ return Number(els.filterTolerance.value) || AN.DEFAULT_TOLERANCE; }
  function fmtMin(v, decimals){ return v == null ? '–' : AN.formatMinutes(v, decimals); }
  // Med tecken: +2,5 / −1,5 (typografiskt minus) / 0,0
  function fmtSigned(v, decimals){
    if(v == null) return '–';
    const s = AN.formatMinutes(v, decimals);
    if(s.startsWith('-')) return '−' + s.slice(1);
    return v > 0 && s !== AN.formatMinutes(0, decimals) ? '+' + s : s;
  }
  function fmtTol(t){ return '±' + AN.formatMinutes(t, t % 1 ? 1 : 0) + ' min'; }
  function plannedText(p, min, max){
    if(p == null) return '–';
    return min != null && max != null && min !== max ? `${fmtMin(p, 0)} (${fmtMin(min, 0)}–${fmtMin(max, 0)})` : fmtMin(p, 0);
  }
  function periodText(p){ return p ? (p.from === p.to ? p.from : p.from + ' – ' + p.to) : '–'; }
  function nowText(){ return new Date().toLocaleString('sv-SE', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }); }
  function safeFilePart(s){ return String(s || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_'); }

  // Urvalet i klartext för export och utskrift
  function describeFilter(extra){
    const f = currentFilter();
    const parts = [
      'Tåg: ' + (f.train || 'alla'),
      'Fordon: ' + (f.vehicle || 'alla'),
      'Tid på dygnet: ' + (TIME_OF_DAY_LABELS[f.timeOfDay] || 'alla'),
      'Dag: ' + (DAY_LABELS[f.dayType] || 'alla'),
      'Stationstyp: ' + (TYPE_LABELS[els.filterStationType.value] || 'alla')
    ];
    if(f.dateFrom || f.dateTo) parts.push('Datum: ' + (f.dateFrom || '…') + ' – ' + (f.dateTo || '…'));
    if(extra) parts.push(extra);
    return parts.join(' · ');
  }

  // CSV laddas ner som fil (i testläge sparas den bara för testerna)
  function downloadText(filename, text){
    lastDownload = { filename, text };
    if(TEST_MODE) return;
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Utskrift/PDF: rubrik och urval fylls i rapportens utskriftshuvud, sedan skrivs den aktiva fliken ut
  function preparePrint(reportId, title, meta){
    const header = document.querySelector('#' + reportId + ' .print-header');
    header.innerHTML = '<h2>' + esc(title) + '</h2>' +
      meta.map(([k, v]) => '<p><strong>' + esc(k) + ':</strong> ' + esc(v) + '</p>').join('');
    return header.textContent;
  }
  function printReport(reportId, title, meta){
    preparePrint(reportId, title, meta);
    if(!TEST_MODE) window.print();
  }

  // ── Mot tidtabell: gångtid per sträcka och klockslag per station ──

  function againstData(runs){
    const tol = toleranceValue();
    const from = validStations.has(els.filterFrom.value) ? els.filterFrom.value : '';
    const to = validStations.has(els.filterTo.value) ? els.filterTo.value : '';
    const onRoute = from && to && from !== to;
    // Med två stationer valda: bara körningar i den riktningen, avskurna till sträckan mellan dem
    const base = onRoute ? AN.sliceRuns(runs, from, to) : runs;
    const withTimetable = base.filter(r => (r.stops || []).some(s => s.scheduledArrival || s.scheduledDeparture));
    const segObs = AN.segmentObservations(base, { tolerance: tol });
    const staObs = AN.stationObservations(base, { tolerance: tol, stationType: els.filterStationType.value });
    return {
      tol, route: onRoute ? from + ' → ' + to : '',
      runCount: base.length, timetableRuns: withTimetable.length,
      period: AN.period(withTimetable),
      segObs, staObs,
      segments: AN.summarizeSegments(segObs, { tolerance: tol }),
      stations: AN.summarizeStations(staObs, { tolerance: tol })
    };
  }

  function isStationView(show){ return show === 'vantan' || show === 'sen-ankomst' || show === 'sen-avgang'; }
  function isSegmentView(show){ return show === 'snal' || show === 'generos'; }

  function visibleRows(d, show){
    if(isSegmentView(show)) return { segments: d.segments.filter(r => r.assessment === show), stations: [] };
    if(show === 'vantan') return { segments: [], stations: d.stations.filter(r => r.wait.n > 0) };
    if(isStationView(show)) return { segments: [], stations: d.stations.filter(r => r.assessment === show) };
    return { segments: d.segments, stations: d.stations };
  }

  function renderAgainst(runs){
    const summary = document.getElementById('againstSummary');
    const content = document.getElementById('againstContent');
    document.getElementById('againstDetail').innerHTML = '';
    againstState = againstData(runs);
    const d = againstState;
    if(!d.timetableRuns){
      summary.textContent = 'Inga körningar med tidtabellstider i urvalet.';
      content.style.display = 'none';
      return;
    }
    content.style.display = '';
    summary.textContent = `Bygger på ${d.timetableRuns} körningar med tidtabell av ${d.runCount} i urvalet · period ${periodText(d.period)} · tolerans ${fmtTol(d.tol)}` +
      (d.route ? ` · sträcka ${d.route}` : '');
    const show = document.getElementById('againstShow').value;
    const v = visibleRows(d, show);
    document.getElementById('againstSegmentsBlock').style.display = isStationView(show) ? 'none' : '';
    document.getElementById('againstStationsBlock').style.display = isSegmentView(show) ? 'none' : '';
    renderAgainstSegments(v.segments);
    renderAgainstStations(v.stations);
  }

  function renderAgainstSegments(rows){
    const tbody = document.querySelector('#againstSegments tbody');
    if(!rows.length){
      tbody.innerHTML = '<tr><td colspan="12" class="empty">Inga sträckor med aktuellt urval</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `<tr data-kind="segment" data-key="${esc(r.key)}">
      <td>${esc(r.key)}</td>
      <td class="num">${r.n}</td>
      <td class="num">${r.nPlanned}</td>
      <td class="num">${plannedText(r.planned, r.plannedMin, r.plannedMax)}</td>
      <td class="num">${fmtMin(r.actual.median)}</td>
      <td class="num">${fmtMin(r.actual.p90)}</td>
      <td class="num">${fmtSigned(r.deviation.median)}</td>
      <td class="num">${r.counts.sen}</td>
      <td class="num">${r.counts.itid}</td>
      <td class="num">${r.counts.tidig}</td>
      <td><span class="assess ${r.assessment}">${ASSESSMENT_LABELS[r.assessment]}</span></td>
      <td class="num">${r.suggestion == null ? '–' : r.suggestion + (r.change ? ' (' + fmtSigned(r.change, 0) + ')' : '')}</td>
    </tr>`).join('');
  }

  function renderAgainstStations(rows){
    const tbody = document.querySelector('#againstStations tbody');
    if(!rows.length){
      tbody.innerHTML = '<tr><td colspan="12" class="empty">Inga stationer med aktuellt urval</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `<tr data-kind="station" data-key="${esc(r.key)}">
      <td>${esc(r.label)}</td>
      <td>${TYPE_LABELS[r.type]}</td>
      <td class="num">${r.n}</td>
      <td class="num">${r.arrivalCounts.sen}</td>
      <td class="num">${r.arrivalCounts.itid}</td>
      <td class="num">${r.arrivalCounts.tidig}</td>
      <td class="num">${r.wait.n}</td>
      <td class="num">${fmtMin(r.wait.median)}</td>
      <td class="num">${fmtMin(r.plannedDwell, 0)}</td>
      <td class="num">${fmtMin(r.dwell.median)}</td>
      <td class="num">${r.departureCounts.sen}</td>
      <td><span class="assess ${r.assessment}">${ASSESSMENT_LABELS[r.assessment]}</span></td>
    </tr>`).join('');
  }

  const SEGMENT_CATEGORY = { sen: 'För lite tid', itid: 'I tid', tidig: 'För mycket tid' };
  const STATION_CATEGORY = { sen: 'Sen', itid: 'I tid', tidig: 'Tidig' };

  // De enskilda mätningarna bakom en rad, nyast först
  function renderAgainstDetail(kind, key){
    const el = document.getElementById('againstDetail');
    const d = againstState;
    if(!d){ el.innerHTML = ''; return; }
    document.querySelectorAll('#againstSegments tbody tr, #againstStations tbody tr').forEach(tr => {
      tr.classList.toggle('selected', tr.dataset.kind === kind && tr.dataset.key === key);
    });
    const newestFirst = (a, b) => String(b.start || '').localeCompare(String(a.start || ''));
    if(kind === 'segment'){
      const list = d.segObs.filter(o => o.key === key).sort(newestFirst);
      el.innerHTML = `<h3>${esc(key)} – ${list.length} mätningar</h3><div class="table-wrap"><table><thead><tr>
        <th>Datum</th><th>Tåg</th><th class="num">Planerad (min)</th><th class="num">Verklig (min)</th><th class="num">Avvikelse</th><th>Kategori</th>
        </tr></thead><tbody>` + list.map(o => `<tr>
        <td>${esc(o.date)}</td><td>${esc(o.trainNumber)}</td>
        <td class="num">${fmtMin(o.planned, 0)}</td><td class="num">${fmtMin(o.actual)}</td>
        <td class="num">${fmtSigned(o.deviation)}</td><td>${o.category ? SEGMENT_CATEGORY[o.category] : '–'}</td>
        </tr>`).join('') + '</tbody></table></div>';
    }else{
      const list = d.staObs.filter(o => o.key === key).sort(newestFirst);
      const label = list.length ? AN.stationLabel(list[0]) : key;
      el.innerHTML = `<h3>${esc(label)} – ${list.length} mätningar</h3><div class="table-wrap"><table><thead><tr>
        <th>Datum</th><th>Tåg</th><th>Typ</th><th class="num">Ankomst</th><th class="num">Väntan (min)</th><th class="num">Uppehåll (min)</th><th class="num">Avgång</th>
        </tr></thead><tbody>` + list.map(o => `<tr>
        <td>${esc(o.date)}</td><td>${esc(o.trainNumber)}</td><td>${TYPE_LABELS[o.type]}</td>
        <td class="num">${fmtSigned(o.arrivalDev)}${o.arrivalCategory ? ' ' + STATION_CATEGORY[o.arrivalCategory].toLowerCase() : ''}</td>
        <td class="num">${o.wait ? fmtMin(o.wait) : '–'}</td>
        <td class="num">${fmtMin(o.dwell)}</td>
        <td class="num">${fmtSigned(o.departureDev)}${o.departureCategory ? ' ' + STATION_CATEGORY[o.departureCategory].toLowerCase() : ''}</td>
        </tr>`).join('') + '</tbody></table></div>';
    }
  }

  function againstMeta(d){
    const show = document.getElementById('againstShow');
    const meta = [
      ['Bygger på', `${d.timetableRuns} körningar med tidtabell (av ${d.runCount} i urvalet)`],
      ['Period', periodText(d.period)],
      ['Urval', describeFilter(d.route ? 'Sträcka: ' + d.route : '')],
      ['Tolerans', fmtTol(d.tol)]
    ];
    if(show.value !== 'alla') meta.push(['Visar', show.options[show.selectedIndex].text]);
    meta.push(['Skapad', nowText()]);
    return meta;
  }

  function exportAgainstCsv(){
    const d = againstState;
    if(!d || !d.timetableRuns) return null;
    const v = visibleRows(d, document.getElementById('againstShow').value);
    const sections = [];
    if(v.segments.length) sections.push({
      title: 'Sträckor – gångtid mot tidtabell',
      header: ['Sträcka', 'Körningar', 'Med tidtabell', 'Planerad gångtid (min)', 'Planerad min', 'Planerad max',
        'Verklig median (min)', 'Verklig P90 (min)', 'Avvikelse median (min)', 'För lite tid', 'I tid', 'För mycket tid',
        'Bedömning', 'Förslag (hela min)', 'Ändring (min)'],
      rows: v.segments.map(r => [r.key, r.n, r.nPlanned, r.planned, r.plannedMin, r.plannedMax,
        r.actual.median, r.actual.p90, r.deviation.median, r.counts.sen, r.counts.itid, r.counts.tidig,
        ASSESSMENT_LABELS[r.assessment], r.suggestion, r.change])
    });
    if(v.stations.length) sections.push({
      title: 'Stationer – ankomst, väntan och avgång mot tidtabell',
      header: ['Station', 'Riktning', 'Typ', 'Körningar', 'Med tidtabell', 'Ankomst sen', 'Ankomst i tid', 'Ankomst tidig',
        'Ankomst avvikelse median (min)', 'Väntan antal', 'Väntan median (min)', 'Planerat uppehåll (min)',
        'Verkligt uppehåll median (min)', 'Avgång sen', 'Avgång i tid', 'Avgång tidig', 'Avgång avvikelse median (min)', 'Bedömning'],
      rows: v.stations.map(r => [r.station, r.towards ? 'mot ' + r.towards : 'från ' + (r.from || ''), TYPE_LABELS[r.type],
        r.n, r.nPlanned, r.arrivalCounts.sen, r.arrivalCounts.itid, r.arrivalCounts.tidig, r.arrivalDev.median,
        r.wait.n, r.wait.median, r.plannedDwell, r.dwell.median,
        r.departureCounts.sen, r.departureCounts.itid, r.departureCounts.tidig, r.departureDev.median,
        ASSESSMENT_LABELS[r.assessment]])
    });
    const text = AN.csvDocument(AGAINST_TITLE, againstMeta(d), sections);
    downloadText('avvikelser_' + AN.localDate(new Date()) + '.csv', text);
    return text;
  }

  function printAgainst(){
    if(againstState && againstState.timetableRuns) printReport('againstReport', AGAINST_TITLE, againstMeta(againstState));
  }

```

I `Analys.html`, ta bort allt från och med raden
```js
  function renderCompare(logs){
```
till (men inte med) raden
```js
  // ── Timetable proposal ──
```

- [ ] **Step 4: Kör testerna**

Run: `node tests/run-browser-tests.mjs`
Expected: `29 lyckades, 0 misslyckades`.

- [ ] **Step 5: Committa**

```bash
git add Analys.html tests/replay.html
git commit -m "Fliken Mot tidtabell: gångtid per sträcka, väntan per station, avvikelsefilter och export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Fliken Tidtabell (förslag i vald riktning)

**Files:**
- Modify: `Analys.html`, `tests/replay.html`

**Interfaces:**
- Consumes: `RailTimerAnalys.proposeTimetable` (Task 1), de gemensamma hjälpfunktionerna (Task 3), och `ttChoices`, `ttRouteKey` och `lastTimetable` (Task 2).
- Produces i `Analys.html`:
  - `updateTimetable(runs)`, `exportTimetableCsv() → text`, `printTimetable()`, `timetableTitle(p)` och `ttMeta(p)`.
  - Testkrokarna `exportTimetableCsv` och `prepareTimetablePrint`.

- [ ] **Step 1: Skriv testerna**

Lägg till före raden `// ── Körning ──` i `tests/replay.html`:
```js
// ── Analys mot tidtabell: tidtabellsförslag ──

test('analys: tidtabellsförslaget räknar bara vald riktning och visar antal körningar', async () => {
  const w = await loadAnalysWith(againstRuns());
  w.__analys.setFilters({ filterFrom: 'Lidköping', filterTo: 'Blomberg' });
  w.__analys.showTab('timetable');
  const summary = () => w.document.getElementById('ttSummary').textContent;
  assert(summary().startsWith('Förslag Lidköping → Blomberg · bygger på 4 körningar'), 'sammanfattning: ' + summary());
  const text = w.__analys.exportTimetableCsv();
  for (const part of ['"Sträcka";"Lidköping → Blomberg"', '"Bygger på";"4 körningar"', '"Tidsbas";"Median"', '"Blomberg";"Slut";"+11"']) {
    assert(text.includes(part), 'saknas i CSV: ' + part);
  }
  w.__analys.setFilters({ filterFrom: 'Blomberg', filterTo: 'Lidköping' });
  assert(summary().includes('bygger på 2 körningar'), 'motsatt riktning: ' + summary());
  w.__analys.setFilters({ filterDayType: 'helg' });
  assertEqual(summary(), 'Inga körningar går från Blomberg till Lidköping i urvalet.', 'tomt urval');
});

test('analys: utskriften av tidtabellsförslaget har rubrik och antal körningar', async () => {
  const w = await loadAnalysWith(againstRuns());
  w.__analys.setFilters({ filterFrom: 'Lidköping', filterTo: 'Blomberg' });
  const header = w.__analys.prepareTimetablePrint();
  assert(header.includes('RailTimer – Tidtabellsförslag Lidköping → Blomberg'), 'rubrik: ' + header);
  assert(header.includes('Bygger på: 4 körningar'), 'antal: ' + header);
});

```

- [ ] **Step 2: Kör testerna och kontrollera att de misslyckas**

Run: `node tests/run-browser-tests.mjs "analys:"`
Expected: `11 lyckades, 2 misslyckades`. Det gamla förslaget saknar sammanfattning och utskrift:
- `✖ analys: tidtabellsförslaget räknar bara vald riktning och visar antal körningar` med `Cannot read properties of null (reading 'textContent')`
- `✖ analys: utskriften av tidtabellsförslaget har rubrik och antal körningar` med `w.__analys.prepareTimetablePrint is not a function`

- [ ] **Step 3: Förslaget per riktning, export och utskrift**

I `Analys.html`, ersätt:
```html
  <div id="tabTimetable" class="tab-content">
    <p class="meta" id="ttHint">Välj två stationer i filtren ovan (Station 1 och Station 2) för att föreslå en tidtabell baserad på mätdata.</p>
    <div id="ttSetup" style="display:none">
      <div class="timetable-setup">
        <div class="filter-group">
          <label>Starttid (valfritt)</label>
          <input type="time" id="ttStartTime">
        </div>
        <div class="filter-group">
          <label>Tidsbas</label>
          <select id="ttTimeBasis">
            <option value="median">Median (realistisk)</option>
            <option value="p90">P90 (med marginal)</option>
            <option value="mean">Medelvärde</option>
          </select>
        </div>
      </div>
      <h3>Mellanstationer – kryssa i för stopp</h3>
      <div id="ttStationList" class="station-list"></div>
      <div id="ttResult" class="timetable-result"></div>
    </div>
  </div>
```
med:
```html
  <div id="tabTimetable" class="tab-content">
    <p class="meta" id="ttHint">Välj Station 1 (från) och Station 2 (till) i filtren ovan för att föreslå en tidtabell i den riktningen, baserad på mätdata.</p>
    <div id="ttSetup" style="display:none">
      <div class="report" id="ttReport">
        <div class="print-header"></div>
        <p class="meta" id="ttSummary"></p>
        <div class="timetable-setup no-print" id="ttActions">
          <div class="filter-group">
            <label>Starttid (valfritt)</label>
            <input type="time" id="ttStartTime">
          </div>
          <div class="filter-group">
            <label>Tidsbas</label>
            <select id="ttTimeBasis">
              <option value="median">Median (realistisk)</option>
              <option value="p90">P90 (med marginal)</option>
              <option value="mean">Medelvärde</option>
            </select>
          </div>
          <button id="btnTtCsv" class="ghost">Exportera till Excel</button>
          <button id="btnTtPrint" class="ghost">Skriv ut / PDF</button>
        </div>
        <div id="ttStopsBlock" class="no-print">
          <h3>Mellanstationer – kryssa i för stopp</h3>
          <div id="ttStationList" class="station-list"></div>
        </div>
        <div id="ttResult" class="timetable-result"></div>
      </div>
    </div>
  </div>
```

I `Analys.html`, ersätt:
```js
  let ttRoute = [];
  let ttRunningStats = {};
  let ttDwellStats = {};
  let currentRuns = [];          // körningarna i aktuellt urval
```
med:
```js
  let currentRuns = [];          // körningarna i aktuellt urval
```

I `Analys.html`, ersätt:
```js
  document.getElementById('ttStartTime').addEventListener('input', generateTimetable);
  document.getElementById('ttTimeBasis').addEventListener('change', generateTimetable);
```
med:
```js
  document.getElementById('ttStartTime').addEventListener('input', () => updateTimetable(currentRuns));
  document.getElementById('ttTimeBasis').addEventListener('change', () => updateTimetable(currentRuns));
  document.getElementById('btnTtCsv').addEventListener('click', exportTimetableCsv);
  document.getElementById('btnTtPrint').addEventListener('click', printTimetable);
  document.getElementById('ttStationList').addEventListener('change', e => {
    if(!e.target.classList.contains('tt-stop-check')) return;
    ttChoices[e.target.dataset.station] = e.target.checked;
    updateTimetable(currentRuns);
  });
```

I `Analys.html`, ersätt:
```js
      prepareAgainstPrint: () => againstState && preparePrint('againstReport', AGAINST_TITLE, againstMeta(againstState)),
```
med:
```js
      prepareAgainstPrint: () => againstState && preparePrint('againstReport', AGAINST_TITLE, againstMeta(againstState)),
      exportTimetableCsv,
      prepareTimetablePrint: () => lastTimetable && preparePrint('ttReport', timetableTitle(lastTimetable), ttMeta(lastTimetable)),
```

I `Analys.html`, ersätt allt från och med raden
```js
  // ── Timetable proposal ──
```
till (men inte med) raden
```js
  // Bara i testläge: tests/replay.html styr verktyget genom de här funktionerna
```
med:
```js
  // ── Tidtabell: förslag i vald riktning ──

  function ttStartMinutes(){
    const v = document.getElementById('ttStartTime').value;
    if(!v) return null;
    const [h, m] = v.split(':').map(Number);
    return h * 60 + m;
  }

  // Minuter från start som klockslag (TT:MM) när starttid finns, annars +minuter
  function ttClock(min, start){
    if(min == null) return '–';
    if(start == null) return '+' + min;
    const total = ((start + min) % 1440 + 1440) % 1440;
    return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  }

  function timetableTitle(p){ return TIMETABLE_TITLE + ' ' + p.from + ' → ' + p.to; }

  function updateTimetable(runs){
    const from = validStations.has(els.filterFrom.value) ? els.filterFrom.value : '';
    const to = validStations.has(els.filterTo.value) ? els.filterTo.value : '';
    const setup = document.getElementById('ttSetup');
    const hint = document.getElementById('ttHint');
    lastTimetable = null;
    if(!from || !to || from === to){
      setup.style.display = 'none';
      hint.style.display = 'block';
      return;
    }
    setup.style.display = 'block';
    hint.style.display = 'none';
    const routeKey = from + '|' + to;
    if(routeKey !== ttRouteKey){ ttRouteKey = routeKey; ttChoices = {}; }
    const p = AN.proposeTimetable(runs, { from, to, basis: document.getElementById('ttTimeBasis').value, stops: ttChoices });
    const ok = !p.error;
    document.getElementById('ttActions').style.display = ok ? '' : 'none';
    document.getElementById('ttStopsBlock').style.display = ok ? '' : 'none';
    if(!ok){
      document.getElementById('ttSummary').textContent = `Inga körningar går från ${from} till ${to} i urvalet.`;
      document.getElementById('ttResult').innerHTML = '';
      return;
    }
    lastTimetable = p;
    document.getElementById('ttSummary').textContent =
      `Förslag ${p.from} → ${p.to} · bygger på ${p.runCount} körningar · period ${periodText(p.period)} · tidsbas ${BASIS_LABELS[p.basis]}`;
    renderTTStationList(p);
    renderTTResult(p);
  }

  function renderTTStationList(p){
    document.getElementById('ttStationList').innerHTML = p.rows.map(r => {
      if(r.isFirst || r.isLast){
        return `<div class="station-item endpoint"><span class="station-name"><strong>${esc(r.station)}</strong></span>` +
          `<span class="station-data">${r.isFirst ? 'Startstation' : 'Slutstation'}</span></div>`;
      }
      return `<div class="station-item"><label>` +
        `<input type="checkbox" class="tt-stop-check" data-station="${esc(r.station)}"${r.isStop ? ' checked' : ''}>` +
        `<span class="station-name">${esc(r.station)}</span></label>` +
        `<span class="station-data">stannade ${r.stopCount} · passerade ${r.passCount}</span></div>`;
    }).join('');
  }

  function renderTTResult(p){
    const start = ttStartMinutes();
    const tol = toleranceValue();
    const few = n => (n && n < AN.MIN_SAMPLES ? ' <span class="few">få mätningar</span>' : '');
    let html = '<div class="table-wrap"><table><thead><tr>' +
      '<th>Station</th><th class="num">Ank</th><th class="num">Avg</th>' +
      '<th class="num" title="Gångtid enligt vald tidsbas (min)">Gångtid</th>' +
      '<th class="num" title="Vanligaste planerade gångtiden i urvalet (min)">Planerad nu</th>' +
      '<th class="num" title="Förslagets gångtid i hela minuter − planerad nu">Ändring</th>' +
      '<th class="num" title="Uppehåll enligt vald tidsbas (min)">Uppehåll</th><th>Mätningar</th>' +
      '</tr></thead><tbody>';
    for(const r of p.rows){
      const pass = !r.isStop;
      const cls = r.isFirst || r.isLast ? 'endpoint-row' : pass ? '' : 'stop-row';
      let changeCls = '';
      if(r.legValue != null && r.plannedLeg != null && Math.abs(r.legValue - r.plannedLeg) > tol){
        changeCls = r.legValue > r.plannedLeg ? ' change-up' : ' change-down';
      }
      const counts = r.isFirst ? '' : 'gång ' + (r.leg ? r.leg.n : 0) + few(r.leg && r.leg.n) +
        (r.dwell ? ' · uppeh ' + r.dwell.n + few(r.dwell.n) : '');
      html += `<tr class="${cls}">` +
        `<td${pass ? ' class="pass"' : ''}>${esc(r.station)}${pass ? ' <em>(passerar)</em>' : ''}</td>` +
        `<td class="num">${r.isFirst ? '' : ttClock(r.arrivalRounded, start)}</td>` +
        `<td class="num">${r.isLast ? '' : (pass ? '<span class="pass">↓</span>' : ttClock(r.departureRounded, start))}</td>` +
        `<td class="num">${r.isFirst ? '' : fmtMin(r.legValue)}</td>` +
        `<td class="num">${r.isFirst ? '' : plannedText(r.plannedLeg, r.plannedLegMin, r.plannedLegMax)}</td>` +
        `<td class="num${changeCls}">${r.isFirst || r.legChange == null ? '' : fmtSigned(r.legChange, 0)}</td>` +
        `<td class="num">${r.isStop && !r.isFirst && !r.isLast ? fmtMin(r.dwellValue) : ''}</td>` +
        `<td style="font-size:.75rem;color:var(--mut)">${counts}</td></tr>`;
    }
    html += '</tbody></table></div>';
    if(p.totalRounded != null){
      html += `<p class="tt-note"><strong>Total restid: ${p.totalRounded} min</strong> (exakt ${fmtMin(p.totalMin)} min)`;
      if(start != null) html += ` · ${ttClock(0, start)} → ${ttClock(p.totalRounded, start)}`;
      html += '</p>';
    }
    if(p.missing.length){
      html += `<p class="tt-note">Saknar mätningar: ${esc(p.missing.join(', '))}. Tiderna efter det kan inte räknas fram.</p>`;
    }
    if(p.rows.some(r => !r.isFirst && !r.isLast && !r.isStop)){
      html += '<p class="meta">Vid passage räknas gångtiderna som de mättes. Om tåget oftast stannade där kan verklig tid vid passage bli något kortare.</p>';
    }
    html += '<p class="meta">Uppehållen räknas utan väntan: kom tåget före planerad ankomst räknas uppehållet från planerad ankomst. Klockslagen är exakta tider avrundade till hela minuter. Planerad nu är den vanligaste planerade gångtiden i urvalet, med intervall inom parentes när den varierar. Ändring = förslag − planerad nu, färgad när skillnaden är större än toleransen.</p>';
    document.getElementById('ttResult').innerHTML = html;
  }

  function ttMeta(p){
    const meta = [
      ['Sträcka', p.from + ' → ' + p.to],
      ['Bygger på', p.runCount + ' körningar'],
      ['Period', periodText(p.period)],
      ['Urval', describeFilter()],
      ['Tidsbas', BASIS_LABELS[p.basis]],
      ['Tolerans', fmtTol(toleranceValue())]
    ];
    const start = document.getElementById('ttStartTime').value;
    if(start) meta.push(['Starttid', start]);
    if(p.missing.length) meta.push(['Saknar mätningar', p.missing.join(', ')]);
    meta.push(['Skapad', nowText()]);
    return meta;
  }

  function exportTimetableCsv(){
    const p = lastTimetable;
    if(!p) return null;
    const start = ttStartMinutes();
    const rows = p.rows.map(r => [
      r.station,
      r.isFirst ? 'Start' : r.isLast ? 'Slut' : (r.isStop ? 'Stopp' : 'Passage'),
      r.isFirst ? '' : ttClock(r.arrivalRounded, start),
      r.isLast ? '' : ttClock(r.departureRounded, start),
      r.isFirst ? null : r.legValue,
      r.isFirst ? null : r.plannedLeg,
      r.isFirst ? null : r.legChange,
      r.isStop && !r.isFirst && !r.isLast ? r.dwellValue : null,
      r.isFirst ? null : (r.leg ? r.leg.n : 0),
      r.dwell ? r.dwell.n : null
    ]);
    if(p.totalRounded != null) rows.push(['Total restid (min)', '', '', '', p.totalMin, null, null, null, null, null]);
    const text = AN.csvDocument(TIMETABLE_TITLE, ttMeta(p), [{
      header: ['Station', 'Typ', 'Ankomst', 'Avgång', 'Gångtid (min)', 'Planerad gångtid nu (min)', 'Ändring (min)',
        'Uppehåll (min)', 'Mätningar gångtid', 'Mätningar uppehåll'],
      rows
    }]);
    downloadText('tidtabell_' + safeFilePart(p.from) + '-' + safeFilePart(p.to) + '_' + AN.localDate(new Date()) + '.csv', text);
    return text;
  }

  function printTimetable(){
    if(lastTimetable) printReport('ttReport', timetableTitle(lastTimetable), ttMeta(lastTimetable));
  }


```

- [ ] **Step 4: Kör testerna**

Run: `node tests/run-browser-tests.mjs`
Expected: `31 lyckades, 0 misslyckades`.

- [ ] **Step 5: Committa**

```bash
git add Analys.html tests/replay.html
git commit -m "Fliken Tidtabell: förslag i vald riktning med antal körningar, jämförelse mot tidtabellen och export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Bilder för granskning och dokumentation

**Files:**
- Modify: `tests/replay.html`, `tests/run-browser-tests.mjs`, `CLAUDE.md`

- [ ] **Step 1: Bilder av de nya flikarna**

I `tests/replay.html`, ersätt:
```js
  } else if (name === 'rapport') {
    const fixes = buildJourney();
    await runJourney(fixes, { drop: twoStationCall(fixes).drop });
  } else {
```
med:
```js
  } else if (name === 'rapport') {
    const fixes = buildJourney();
    await runJourney(fixes, { drop: twoStationCall(fixes).drop });
  } else if (name === 'mot-tidtabell' || name === 'mot-tidtabell-utskrift') {
    const frame = document.getElementById('app');
    frame.style.width = '1200px';   // analysverktyget används främst på dator
    frame.style.height = '2200px';
    const w = await loadAnalysWith(againstRuns());
    w.__analys.showTab('against');
    if (name.endsWith('-utskrift')) w.__analys.prepareAgainstPrint();
  } else if (name === 'tidtabell') {
    const frame = document.getElementById('app');
    frame.style.width = '1200px';
    frame.style.height = '1700px';
    const w = await loadAnalysWith(againstRuns());
    w.__analys.setFilters({ filterFrom: 'Lidköping', filterTo: 'Blomberg' });
    w.__analys.showTab('timetable');
  } else {
```

I `tests/run-browser-tests.mjs`, ersätt:
```js
//   node tests/run-browser-tests.mjs --shot=installningar   sparar en bild i telefonstorlek i tests/screenshots/
//                                                          (även --shot=avbrott och --shot=rapport)
```
med:
```js
//   node tests/run-browser-tests.mjs --shot=installningar   sparar en bild i telefonstorlek i tests/screenshots/
//                                                          (även --shot=avbrott och --shot=rapport)
//   node tests/run-browser-tests.mjs --shot=mot-tidtabell    analysverktyget i datorstorlek (även --shot=tidtabell);
//                                                          --shot=mot-tidtabell-utskrift visar utskriften (PDF)
```

I `tests/run-browser-tests.mjs`, ersätt:
```js
  } else if (SHOT) {
    const clip = Object.assign({ scale: 1 }, res.result.result.value);
```
med:
```js
  } else if (SHOT) {
    // Bilder vars namn slutar på -utskrift tas som om sidan skrevs ut (utskriftsmallen, @media print)
    if (SHOT.endsWith('-utskrift')) await send('Emulation.setEmulatedMedia', { media: 'print' });
    const clip = Object.assign({ scale: 1 }, res.result.result.value);
```

- [ ] **Step 2: Dokumentation**

Lägg till sist i `CLAUDE.md`:
```markdown

## Uppdatering (2026-10-15c): analys mot tidtabell (Analys.html)

Spec: `docs/superpowers/specs/2026-10-15-analys-mot-tidtabell-design.md` · Plan: `docs/superpowers/plans/2026-10-15-analys-mot-tidtabell.md`

- **Mot tidtabell** (ersätter Jämför): gångtid per sträcka och riktning mot planerad gångtid – bedömning Snål / Lagom / Generös och förslag i hela minuter – och per station ankomst, väntan vid tidig ankomst, uppehåll och avgång. Väljaren *Visa* filtrerar på avvikelsetyp; klick på en rad visar de enskilda mätningarna.
- **Tidtabell**: förslag i vald riktning (Station 1 → Station 2) som bara bygger på körningar i den riktningen. Antal körningar, period, planerad gångtid nu och ändring visas; klockslagen avrundas till hela minuter utan att felen växer.
- **Export**: *Exportera till Excel* (CSV som appens: BOM, semikolon, citattecken, decimalkomma, informationsblock med urval, period och antal) och *Skriv ut / PDF* (utskriftsmall som bara visar rapporten med rubrik och urval).
- **Nya filter**: tid på dygnet (morgon 05–09, dag 09–15, eftermiddag 15–18, kväll 18–05), vardag eller helg, tolerans (±0,5 / ±1 / ±2 min) och stationstyp (stopp eller passage). Tid och datum avgörs av körningens start i lokal tid.
- **Stationsnamn** slås ihop vid inläsning: Herrljunga → Herrljunga C, Hallsberg personbangård → Hallsberg, Framnäs City → Framnäs city (verifierat mot Trafikverkets TrainStation-API), och namn som bara skiljer sig i stor och liten bokstav.
- Beräkningarna finns i `railtimer-analys.js` och testas med `node --test "tests/*.test.js"`; flikarna med `node tests/run-browser-tests.mjs analys`.
```

- [ ] **Step 3: Kör hela sviten**

```bash
node --test "tests/*.test.js"
node tests/run-browser-tests.mjs
```
Expected: `ℹ pass 67`, `ℹ fail 0` och `31 lyckades, 0 misslyckades`.

- [ ] **Step 4: Ta bilderna och granska dem**

```bash
node tests/run-browser-tests.mjs --shot=mot-tidtabell
node tests/run-browser-tests.mjs --shot=tidtabell
node tests/run-browser-tests.mjs --shot=mot-tidtabell-utskrift
```
Kontrollera följande i `tests/screenshots/`:
- **mot-tidtabell:** Filsbäck → Källby är *Generös* med förslaget 1 (−4). Lidköping → Filsbäck är *Snål* med förslaget 5 (+2). Källby (mot Blomberg) är *Tidig – väntan* med 3 väntetillfällen.
- **tidtabell:** förslaget Lidköping → Blomberg bygger på 4 körningar. Uppehållet i Källby är 1,0 min, och den totala restiden är 11 min.
- **mot-tidtabell-utskrift:** bara rubrik, informationsblock och tabeller syns, i svart på vitt.

- [ ] **Step 5: Committa**

```bash
git add tests/replay.html tests/run-browser-tests.mjs CLAUDE.md
git commit -m "Bilder av de nya analysflikarna och dokumentation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Utvärdering och publicering (tillsammans med André)

André utvärderar när allt är klart. Inget publiceras utan hans uttryckliga OK. Blockeras ett kommando av behörighetskontrollen kör han det själv med `!` före kommandot.

- [ ] **Step 1: Visa resultatet för André**

Visa:
- en sammanfattning av ändringarna,
- testresultaten,
- de tre bilderna (fullständiga sökvägar),
- besluten i specen som han inte själv har tagit, till exempel tröskeln för bedömning, tidsindelningen och uppehåll utan väntan.

- [ ] **Step 2: Publicera, med Andrés uttryckliga OK**

```bash
git fetch origin
git merge-base --is-ancestor origin/main HEAD && echo "snabbspolning möjlig"
```
Om det skrivs ut "snabbspolning möjlig", be André köra:
`! git -C C:/Users/andre/kinnekulle-gps-ux-wt push origin feat/analys-tidtabell:main`

- [ ] **Step 3: Kontrollera publiceringen**

```bash
gh api repos/AKjork/kinnekulle-gps/pages/builds/latest --jq '.status, .commit'
```
Vänta tills bygget har status `built` för HEAD. Hämta sedan `Analys.html` och `railtimer-analys.js` från https://akjork.github.io/kinnekulle-gps/, med en unik `?cb=` per fil. Jämför dem byte för byte med `git show HEAD:<fil>`.
