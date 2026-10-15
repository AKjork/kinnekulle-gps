# Analys per tåg – genomförandeplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Analysverktyget jämför varje tåg med sin egen tidtabell och med vad sträckorna faktiskt tar, visar när tåg tappat tid vid stationer och föreslår tidtabell per tåg. Mot tidtabell och väntan per station tas bort.

**Architecture:** Beräkningarna läggs som rena funktioner i `railtimer-analys.js` och testas med `node --test`:

- `segmentNeeds` ger vad sträckorna tar.
- `stationTimes` ger tappad tid vid stationerna.
- `summarizeTrains`, `segmentPlans` och `proposeTrainTimetable` bygger vyerna.

`Analys.html` får flikarna Per tåg (förvald), Sträckor och en ny Tidtabell. Dessa ersätter Mot tidtabell och det gamla förslaget per riktning. Flikarna testas i Chrome via `tests/replay.html`.

**Tech Stack:** Vanilla JS i en HTML-fil, UMD-modul utan beroenden, `node:test`, Chrome utan fönster via `tests/run-browser-tests.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-15-analys-per-tag-design.md`

## Global Constraints

- **Kod:** Vanilla JS utan bibliotek. Modulen förblir UMD (`RailTimerAnalys` i webbläsaren, `module.exports` i Node).
- **Texter:** All text i gränssnittet är på svenska med å, ä och ö.
- **Export:** CSV som tidigare, via `AN.csvDocument`: BOM, semikolon, varje fält inom citattecken och decimalkomma.
- **Konstanter:** `MIN_SAMPLES = 3` och `DEFAULT_TOLERANCE = 1`. Exakt ±tolerans räknas som lagom.
- **Rör inte:** `index.html`, `Kinnekulle GPS.html`, `sw.js`, `railtimer-github.js` och `railtimer-avbrott.js`.
- **Tester:** `node --test "tests/*.test.js"` och `node tests/run-browser-tests.mjs` ska vara gröna efter varje task.
- **Commits:** varje commit-meddelande slutar med `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Partiella körningar av samma tåg,** till exempel A → C ena dagen och C → D andra dagen. De ska bli en rutt i klockslagsordning. Testet finns i Task 3: `proposeTrainTimetable: … partiella körningar …`.
- **Tidtabell som ändrats mellan körningar.** Senaste planerade tid gäller och tidigare tider visas. Testet finns i Task 2: `summarizeTrains: ändrad tidtabell …`.
- **Tåg över midnatt och dagen då vintertiden börjar.** Klockslagen ska räknas på kalenderdag och klocka. Testet finns i Task 1: `clockMinutes: …`.
- **Tågnummerfiltret.** Vad sträckan tar ska fortfarande räknas på alla tåg i urvalet. Testet finns i Task 4: `analys: tågnummerfiltret visar ett tåg men sträckornas tid bygger på alla tåg`.
- **Avbrott med tomma tider vid en mellanstation.** Stationen ska inte ge tappad tid. Testet finns i Task 1: `stationTimes: …`, station X.

---

### Task 1: Grunder i modulen – stoppmönster, klockslag, vad sträckan tar och tappad tid

**Files:**
- Modify: `railtimer-analys.js`
- Test: `tests/railtimer-analys.test.js`

**Interfaces:**
- Consumes: befintliga `toDate`, `runStart`, `localDate`, `stopType`, `plannedArrival`, `plannedDeparture`, `minutes`, `stats` och `segmentObservations`.
- Produces:
  - `plannedType(stop) → 'stopp' | 'passage' | null`.
  - `PATTERN_LABELS` `{ SS, SP, PS, PP }`.
  - `clockMinutes(v, base) → number | null`.
  - `segmentObservations` får nya fält: `plannedPattern`, `actualPattern` (`'SS' | 'SP' | 'PS' | 'PP'`) och `order` (klockslag för planerad avgång, eller `null`). Varje observation har också `weekday` (0–6) från `runInfo`.
  - `segmentNeeds(obs) → [{ key: 'A → B|SS', segment, from, to, pattern, n, median, p90, mean }]`, sorterad på `key`. Den har också en rad per sträcka med `pattern: '*'`, som innehåller alla mätningar.
  - `stationTimes(runs) → [{ runId, train, vehicleType, date, weekday, start, station, index, type: 'start' | 'stopp' | 'passage', plannedClock, arrivalDev, departureDev, lost, dwell, plannedDwell, stopped }]`.
  - Interna hjälpare som senare tasks använder: `hasTimetable(run)`, `roundSec(v)`, `uniqueSorted(values)`, `needMap(needs)` och `needFor(needsByKey, segment, pattern)`.
    - `needFor` ger raden för det planerade mönstret.
    - Har den raden färre än `MIN_SAMPLES` mätningar ger den i stället `'*'`-raden, om den har fler mätningar.

- [ ] **Step 1: Skriv de misslyckade testerna**

Lägg till sist i `tests/railtimer-analys.test.js`:

```js

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
```

- [ ] **Step 2: Kör testerna och se dem misslyckas**

Run: `node --test tests/railtimer-analys.test.js`
Expected: FAIL i de fyra nya testerna (`AN.clockMinutes is not a function`, `plannedPattern` saknas (`undefined`), `AN.segmentNeeds is not a function`, `AN.stationTimes is not a function`); övriga 24 lyckas.

- [ ] **Step 3: Skriv koden**

I `railtimer-analys.js`, ersätt:

```js
  function localDate(v) {
    const d = toDate(v);
    return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null;
  }
```

med:

```js
  function localDate(v) {
    const d = toDate(v);
    return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null;
  }

  // Minuter efter midnatt den dag `base` har (lokal tid). Räknas på kalenderdag och klockslag,
  // så att bytet mellan sommar- och vintertid inte flyttar tiderna.
  function clockMinutes(v, base) {
    const d = toDate(v);
    if (!d) return null;
    const b = toDate(base) || d;
    const days = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / 86400000);
    return days * 1440 + d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  }
```

I `railtimer-analys.js`, ersätt:

```js
  // Passage: inget planerat stopp, eller appen registrerade en genomfart
  function stopType(stop) {
    if (!stop) return null;
    return stop.shouldStop === false || stop.departSource === 'gps-pass' ? 'passage' : 'stopp';
  }
```

med:

```js
  // Passage: inget planerat stopp, eller appen registrerade en genomfart
  function stopType(stop) {
    if (!stop) return null;
    return stop.shouldStop === false || stop.departSource === 'gps-pass' ? 'passage' : 'stopp';
  }

  // Planerad typ: stopp om tåget ska stanna enligt tidtabellen (även behovsstopp), annars passage
  function plannedType(stop) {
    if (!stop) return null;
    return stop.shouldStop === false ? 'passage' : 'stopp';
  }

  // Stoppmönster för en sträcka: S (stopp) eller P (passage) vid avgångs- och ankomststationen
  function patternOf(a, b, typeOf) {
    return (typeOf(a) === 'stopp' ? 'S' : 'P') + (typeOf(b) === 'stopp' ? 'S' : 'P');
  }

  // '*' = alla mätningar på sträckan (stopp och passage), reserv när tågets mönster har för få mätningar
  const PATTERN_LABELS = { SS: 'Stopp–stopp', SP: 'Stopp–passage', PS: 'Passage–stopp', PP: 'Passage–passage', '*': 'Stopp och passage' };
```

I `railtimer-analys.js`, ersätt:

```js
      date: localDate(start),
      start: start ? start.toISOString() : null,
```

med:

```js
      date: localDate(start),
      weekday: start ? start.getDay() : null,
      start: start ? start.toISOString() : null,
```

I `railtimer-analys.js`, ersätt:

```js
          fromType: stopType(a), toType: stopType(b)
        }, info));
```

med:

```js
          fromType: stopType(a), toType: stopType(b),
          plannedPattern: patternOf(a, b, plannedType),
          actualPattern: patternOf(a, b, stopType),
          order: pDep ? clockMinutes(pDep, info.start) : null
        }, info));
```

Lägg till före raden `  // ── Export ──` i `railtimer-analys.js`:

```js
  // ── Analys per tåg ──

  function hasTimetable(run) {
    return ((run && run.stops) || []).some(s => s.scheduledArrival || s.scheduledDeparture);
  }

  // Planerade tider jämförs på hela sekunder
  function roundSec(v) { return Math.round(v * 60) / 60; }

  function uniqueSorted(values) {
    return Array.from(new Set(values.filter(v => v != null))).sort((a, b) => a - b);
  }

  function needMap(needs) {
    const m = new Map();
    for (const n of needs || []) m.set(n.key, n);
    return m;
  }

  /* Vad sträckan tar: mätta gångtider per sträcka och verkligt stoppmönster, från alla körningar i urvalet
     (även körningar utan tidtabell), plus en rad per sträcka med alla mätningar (mönster '*'). */
  function segmentNeeds(obs) {
    const groups = new Map();
    const add = (o, pattern) => {
      const key = `${o.key}|${pattern}`;
      if (!groups.has(key)) groups.set(key, { key, segment: o.key, from: o.from, to: o.to, pattern, values: [] });
      groups.get(key).values.push(o.actual);
    };
    for (const o of obs || []) {
      add(o, o.actualPattern);
      add(o, '*');
    }
    return Array.from(groups.values()).map(g => {
      const s = stats(g.values);
      return { key: g.key, segment: g.segment, from: g.from, to: g.to, pattern: g.pattern, n: s.n, median: s.median, p90: s.p90, mean: s.mean };
    }).sort((a, b) => a.key.localeCompare(b.key));
  }

  /* Vad sträckan tar för ett planerat mönster: körningar som stannade och passerade som planerat, så att en
     planerad tid med stopp jämförs med körningar som stannade. Har de färre än MIN_SAMPLES mätningar används
     alla mätningar på sträckan ('*'), om de är fler – till exempel vid behovsstopp som tåget nästan alltid passerar. */
  function needFor(needsByKey, segment, pattern) {
    const exact = needsByKey.get(`${segment}|${pattern}`) || null;
    if (exact && exact.n >= MIN_SAMPLES) return exact;
    const all = needsByKey.get(`${segment}|*`) || null;
    return all && all.n > (exact ? exact.n : 0) ? all : exact;
  }

  /* Tid som tåget tappade vid varje station: avgångsavvikelse − max(ankomstavvikelse, 0).
     Kom tåget tidigt och åkte enligt tidtabellen tappade det ingen tid (väntan enligt tidtabellen).
     Första stationen saknar mätt ankomst: där är tappad tid avgångsavvikelsen (typ 'start').
     Mellanstationer utan mätt ankomst (t.ex. avbrott) och sista stationen räknas inte. */
  function stationTimes(runs) {
    const out = [];
    for (const run of runs || []) {
      const stops = run.stops || [];
      const info = runInfo(run);
      for (let k = 0; k < stops.length - 1; k++) {
        const s = stops[k];
        const aDep = toDate(s.actualDeparture);
        const pDep = plannedDeparture(s);
        if (!aDep || !pDep) continue;
        const departureDev = minutes(pDep, aDep);
        let type = 'start';
        let arrivalDev = null;
        let dwell = null;
        let lost = departureDev;
        if (k > 0) {
          const aArr = toDate(s.actualArrival);
          const pArr = plannedArrival(s);
          if (!aArr || !pArr) continue;
          type = plannedType(s);
          arrivalDev = minutes(pArr, aArr);
          lost = departureDev - Math.max(arrivalDev, 0);
          dwell = aDep >= aArr ? minutes(aArr, aDep) : null;
        }
        const sArr = toDate(s.scheduledArrival);
        const sDep = toDate(s.scheduledDeparture);
        out.push({
          runId: info.runId, train: info.trainNumber, vehicleType: info.vehicleType,
          date: info.date, weekday: info.weekday, start: info.start,
          station: s.name, index: k, type,
          plannedClock: clockMinutes(pDep, info.start),
          arrivalDev, departureDev, lost, dwell,
          plannedDwell: sArr && sDep && sDep >= sArr ? minutes(sArr, sDep) : null,
          stopped: stopType(s) === 'stopp'
        });
      }
    }
    return out;
  }

```

I `railtimer-analys.js`, ersätt:

```js
    localDate, runStart, timeOfDay, dayType, runMatches, period,
    stopType, classify, segmentObservations, stationObservations, stationLabel,
```

med:

```js
    localDate, clockMinutes, runStart, timeOfDay, dayType, runMatches, period,
    stopType, plannedType, PATTERN_LABELS, classify, segmentObservations, stationObservations, stationLabel,
    segmentNeeds, stationTimes,
```

- [ ] **Step 4: Kör testerna och se dem lyckas**

Run: `node --test tests/railtimer-analys.test.js`
Expected: PASS, 28 tester, 0 misslyckade.

- [ ] **Step 5: Kör hela sviten**

Run: `node --test "tests/*.test.js"` och `node tests/run-browser-tests.mjs`
Expected: 75 Node-tester lyckas; 33 lyckades, 0 misslyckades.

- [ ] **Step 6: Committa**

```bash
git add railtimer-analys.js tests/railtimer-analys.test.js
git commit -m "Analys per tåg: stoppmönster, klockslag, vad sträckan tar och tappad tid vid stationer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Per tåg och Sträckor i modulen

**Files:**
- Modify: `railtimer-analys.js`
- Test: `tests/railtimer-analys.test.js`

**Interfaces:**
- Consumes (Task 1): `segmentObservations` (med `plannedPattern`, `order` och `start`), `stationTimes`, `segmentNeeds`, `hasTimetable`, `roundSec`, `uniqueSorted`, `needMap`, `clockMinutes` och `plannedArrival`.
- Produces:
  - `summarizeTrains(runs, needs, opts) → { rows: TrainRow[], withoutTimetable: { trains, runs } }`.
    - `opts = { tolerance, stationType }`.
    - `TrainRow = { train, runCount, timetableRuns, period, route: string[], routeLabel, startDelay, endDelay, segments, margin: { sum, planned, need, count, of }, dwells, events, eventCount, lostMax }`.
    - `segments[i] = { key, segment, from, to, pattern, planned, plannedPrev: number[], n, actual, need, margin, assessment, order }`.
    - `dwells[i] = { station, plannedDwell, plannedPrev, dwell, lost, events, n, order }`.
    - `events` är rader från `stationTimes`.
  - `segmentPlans(obs, needs, opts) → [{ key, segment, from, to, pattern, need, plans: [{ planned, trains, n, actual, margin, assessment }], assessment, spread, maxAbsMargin }]`.
    - `opts = { tolerance, stationType, train }`.
    - Radens `assessment` är en av `'fa'`, `'blandad'`, `'snal'`, `'generos'` och `'lagom'`.
  - Interna hjälpare som Task 3 använder: `routeOf(runs)`, `compareTrain(a, b)`, `assessMargin(margin, tol)` och `marginFor(planned, need)`.

- [ ] **Step 1: Skriv de misslyckade testerna**

Lägg till sist i `tests/railtimer-analys.test.js`:

```js

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
```

- [ ] **Step 2: Kör testerna och se dem misslyckas**

Run: `node --test tests/railtimer-analys.test.js`
Expected: FAIL i de fyra nya testerna (`AN.summarizeTrains is not a function`, `AN.segmentPlans is not a function`); övriga 28 lyckas.

- [ ] **Step 3: Skriv koden**

Lägg till före raden `  // ── Export ──` i `railtimer-analys.js`:

```js
  // Marginal = planerad gångtid − vad sträckan tar (median); null utan minst MIN_SAMPLES mätningar
  function marginFor(planned, need) {
    return need && need.n >= MIN_SAMPLES && planned != null ? planned - need.median : null;
  }

  // Exakt ±tolerans räknas som lagom
  function assessMargin(margin, tol) {
    if (margin == null) return 'fa';
    if (margin < -tol) return 'snal';
    if (margin > tol) return 'generos';
    return 'lagom';
  }

  // Tågnummer i nummerordning när båda är tal, annars i bokstavsordning
  function compareTrain(a, b) {
    const na = Number(a);
    const nb = Number(b);
    return a !== '' && b !== '' && isFinite(na) && isFinite(nb) ? na - nb : String(a).localeCompare(String(b));
  }

  function latestFirst(a, b) { return String(b.start || '').localeCompare(String(a.start || '')); }

  // Tågets stationer i ordning efter planerat klockslag (median), så att partiella körningar blir en rutt
  function routeOf(runs) {
    const clocks = new Map();
    for (const run of runs || []) {
      const base = runStart(run);
      for (const s of run.stops || []) {
        const c = clockMinutes(plannedArrival(s), base);
        if (c == null) continue;
        if (!clocks.has(s.name)) clocks.set(s.name, []);
        clocks.get(s.name).push(c);
      }
    }
    return Array.from(clocks.entries())
      .map(([name, values]) => ({ name, clock: stats(values).median }))
      .sort((a, b) => a.clock - b.clock || a.name.localeCompare(b.name))
      .map(x => x.name);
  }

  // Stationstyp i filtret → typer av tillfällen då tåget tappade tid
  const EVENT_TYPES = { stopp: ['start', 'stopp'], passage: ['passage'] };

  function trainRow(train, runCount, tRuns, needsByKey, tol, stationType) {
    const obs = segmentObservations(tRuns, { tolerance: tol }).filter(o => o.planned != null);
    const times = stationTimes(tRuns);
    const route = routeOf(tRuns);

    const groups = new Map();
    for (const o of obs) {
      const key = `${o.key}|${o.plannedPattern}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(o);
    }
    const segments = Array.from(groups.entries()).map(([key, list]) => {
      // Senaste körningens planerade tid gäller; tidigare andra tider visas som "tidigare"
      const planned = roundSec(list.slice().sort(latestFirst)[0].planned);
      const need = needFor(needsByKey, list[0].key, list[0].plannedPattern);
      const margin = marginFor(planned, need);
      return {
        key, segment: list[0].key, from: list[0].from, to: list[0].to, pattern: list[0].plannedPattern,
        planned, plannedPrev: uniqueSorted(list.map(o => roundSec(o.planned))).filter(v => v !== planned),
        n: list.length, actual: stats(list.map(o => o.actual)),
        need, margin, assessment: assessMargin(margin, tol),
        order: stats(list.map(o => o.order)).median
      };
    }).sort((a, b) => (a.order == null ? Infinity : a.order) - (b.order == null ? Infinity : b.order) || a.key.localeCompare(b.key));

    const withMargin = segments.filter(s => s.margin != null);
    const margin = {
      sum: withMargin.length ? withMargin.reduce((t, s) => t + s.margin, 0) : null,
      planned: withMargin.reduce((t, s) => t + s.planned, 0),
      need: withMargin.reduce((t, s) => t + s.need.median, 0),
      count: withMargin.length,
      of: segments.length
    };

    const dwells = Array.from(groupBy(times.filter(t => t.type === 'stopp'), 'station').entries()).map(([station, list]) => {
      const latest = list.slice().sort(latestFirst)[0];
      const plannedDwell = latest.plannedDwell != null ? roundSec(latest.plannedDwell) : null;
      return {
        station, plannedDwell,
        plannedPrev: uniqueSorted(list.map(t => (t.plannedDwell != null ? roundSec(t.plannedDwell) : null))).filter(v => v !== plannedDwell),
        dwell: stats(list.filter(t => t.stopped).map(t => t.dwell)),
        lost: stats(list.map(t => t.lost)),
        events: list.filter(t => t.lost > tol).length,
        n: list.length,
        order: stats(list.map(t => t.plannedClock)).median
      };
    }).sort((a, b) => a.order - b.order || a.station.localeCompare(b.station));

    const allowed = EVENT_TYPES[stationType] || null;
    const events = times.filter(t => t.lost > tol && (!allowed || allowed.includes(t.type)))
      .sort((a, b) => b.lost - a.lost || latestFirst(a, b));

    const endDelay = stats(tRuns.map(run => {
      const last = run.stops[run.stops.length - 1];
      const a = toDate(last.actualArrival);
      const p = plannedArrival(last);
      return a && p ? minutes(p, a) : null;
    }));

    return {
      train, runCount, timetableRuns: tRuns.length, period: period(tRuns),
      route, routeLabel: route.length ? `${route[0]} → ${route[route.length - 1]}` : '',
      startDelay: stats(times.filter(t => t.type === 'start').map(t => t.departureDev)),
      endDelay, segments, margin, dwells, events,
      eventCount: events.length,
      lostMax: events.length ? Math.max(...events.map(e => e.lost)) : null
    };
  }

  /* Per tåg: tågets körningar med tidtabell jämförs med tågets egen tidtabell och med vad sträckorna tar.
     opts: { tolerance, stationType }. Körningar utan tågnummer räknas inte; tågnummer utan någon körning
     med tidtabell räknas i withoutTimetable. Flest körningar först, sedan flest tillfällen, sedan tågnummer. */
  function summarizeTrains(runs, needs, opts) {
    const tol = opts && opts.tolerance != null ? opts.tolerance : DEFAULT_TOLERANCE;
    const stationType = (opts && opts.stationType) || '';
    const needsByKey = needMap(needs);
    const byTrain = new Map();
    for (const run of runs || []) {
      const train = String(run.trainNumber || '').trim();
      if (!train) continue;
      if (!byTrain.has(train)) byTrain.set(train, []);
      byTrain.get(train).push(run);
    }
    const rows = [];
    const withoutTimetable = { trains: 0, runs: 0 };
    for (const [train, list] of byTrain) {
      const tRuns = list.filter(hasTimetable);
      if (!tRuns.length) {
        withoutTimetable.trains += 1;
        withoutTimetable.runs += list.length;
        continue;
      }
      rows.push(trainRow(train, list.length, tRuns, needsByKey, tol, stationType));
    }
    rows.sort((a, b) => b.timetableRuns - a.timetableRuns || b.eventCount - a.eventCount || compareTrain(a.train, b.train));
    return { rows, withoutTimetable };
  }

  /* Sträckor: vad sträckan tar och vilken planerad gångtid varje tåg har där, en rad per sträcka och planerat
     mönster. opts: { tolerance, stationType ('stopp' = bara SS, 'passage' = mönster med P), train (bara sträckor
     som tåget kör, med alla tågs tider) }. */
  function segmentPlans(obs, needs, opts) {
    const tol = opts && opts.tolerance != null ? opts.tolerance : DEFAULT_TOLERANCE;
    const stationType = (opts && opts.stationType) || '';
    const train = opts && opts.train ? String(opts.train) : '';
    const needsByKey = needMap(needs);
    const groups = new Map();
    for (const o of obs || []) {
      if (o.planned == null) continue;
      const key = `${o.key}|${o.plannedPattern}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(o);
    }
    const rows = [];
    for (const [key, list] of groups) {
      const pattern = list[0].plannedPattern;
      if (stationType === 'stopp' && pattern !== 'SS') continue;
      if (stationType === 'passage' && pattern === 'SS') continue;
      if (train && !list.some(o => String(o.trainNumber) === train)) continue;
      const need = needFor(needsByKey, list[0].key, pattern);
      const byPlan = new Map();
      for (const o of list) {
        const p = roundSec(o.planned);
        if (!byPlan.has(p)) byPlan.set(p, []);
        byPlan.get(p).push(o);
      }
      const plans = Array.from(byPlan.entries()).sort((a, b) => a[0] - b[0]).map(([planned, items]) => {
        const margin = marginFor(planned, need);
        return {
          planned,
          trains: Array.from(new Set(items.map(o => String(o.trainNumber || '')))).sort(compareTrain),
          n: items.length, actual: stats(items.map(o => o.actual)),
          margin, assessment: assessMargin(margin, tol)
        };
      });
      const kinds = new Set(plans.map(p => p.assessment));
      let assessment = 'lagom';
      if (!need || need.n < MIN_SAMPLES) assessment = 'fa';
      else if (kinds.has('snal') && kinds.has('generos')) assessment = 'blandad';
      else if (kinds.has('snal')) assessment = 'snal';
      else if (kinds.has('generos')) assessment = 'generos';
      const values = plans.map(p => p.planned);
      const margins = plans.filter(p => p.margin != null).map(p => Math.abs(p.margin));
      rows.push({
        key, segment: list[0].key, from: list[0].from, to: list[0].to, pattern, need, plans, assessment,
        spread: Math.max(...values) - Math.min(...values),
        maxAbsMargin: margins.length ? Math.max(...margins) : 0
      });
    }
    const fa = r => (r.assessment === 'fa' ? 1 : 0);
    rows.sort((a, b) => fa(a) - fa(b) || b.spread - a.spread || b.maxAbsMargin - a.maxAbsMargin
      || (b.need ? b.need.n : 0) - (a.need ? a.need.n : 0) || a.key.localeCompare(b.key));
    return rows;
  }

```

I `railtimer-analys.js`, ersätt:

```js
    segmentNeeds, stationTimes,
```

med:

```js
    segmentNeeds, stationTimes, summarizeTrains, segmentPlans,
```

- [ ] **Step 4: Kör testerna och se dem lyckas**

Run: `node --test tests/railtimer-analys.test.js`
Expected: PASS, 32 tester, 0 misslyckade.

- [ ] **Step 5: Kör hela sviten**

Run: `node --test "tests/*.test.js"` och `node tests/run-browser-tests.mjs`
Expected: 79 Node-tester lyckas; 33 lyckades, 0 misslyckades.

- [ ] **Step 6: Committa**

```bash
git add railtimer-analys.js tests/railtimer-analys.test.js
git commit -m "Analys per tåg: varje tåg mot sin egen tidtabell och planerad tid per tåg på varje sträcka

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Tidtabellsförslag per tåg i modulen

**Files:**
- Modify: `railtimer-analys.js`
- Test: `tests/railtimer-analys.test.js`

**Interfaces:**
- Consumes (Task 1 och 2): `routeOf`, `needMap`, `hasTimetable`, `plannedType`, `stopType`, `clockMinutes`, `runStart`, `stats`, `period` och `MIN_SAMPLES`.
- Produces: `proposeTrainTimetable(runs, needs, train, opts) → { train, basis, route, rows, missing, runCount, period, totalCurrent, totalProposed, totalExact }`.
  - Utan körningar svarar funktionen `{ train, basis, error: 'inga-korningar', route: [], rows: [], missing: [], runCount }`.
  - `opts = { basis: 'median' | 'p90' | 'mean' }`.
  - `rows[i] = { station, type: 'start' | 'stopp' | 'passage' | 'slut', currentArr, currentDep, propArr, propDep, plannedLeg, need, legValue, legRounded, legDiff, few, plannedDwell, dwellValue, dwellN, dwellSource: 'matt' | 'planerat' | null }`. Klockslagen är minuter efter midnatt.

- [ ] **Step 1: Skriv de misslyckade testerna**

Lägg till sist i `tests/railtimer-analys.test.js`:

```js

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
```

- [ ] **Step 2: Kör testerna och se dem misslyckas**

Run: `node --test tests/railtimer-analys.test.js`
Expected: FAIL i de två nya testerna (`AN.proposeTrainTimetable is not a function`); övriga 32 lyckas.

- [ ] **Step 3: Skriv koden**

Lägg till före raden `  // ── Export ──` i `railtimer-analys.js`:

```js
  /* Tidtabellsförslag för ett tåg: tågets egna stopp och nuvarande tider, sträckornas tid (alla tåg, samma
     planerade mönster) och tågets egna uppehåll utan väntan. opts: { basis: 'median' | 'p90' | 'mean' }.
     Klockslag är minuter efter midnatt; exakta tider läggs ihop och varje klockslag avrundas till hela minuter,
     så att avrundningsfelen inte växer. Möten och anslutningar ingår inte. */
  function proposeTrainTimetable(runs, needs, train, opts) {
    const basis = (opts && opts.basis) || 'median';
    const nr = String(train == null ? '' : train).trim();
    const tRuns = (runs || []).filter(r => String(r.trainNumber || '').trim() === nr && hasTimetable(r));
    const route = routeOf(tRuns);
    if (!nr || !tRuns.length || route.length < 2) {
      return { train: nr, basis, error: 'inga-korningar', route: [], rows: [], missing: [], runCount: tRuns.length };
    }
    const needsByKey = needMap(needs);
    const startOf = r => { const d = runStart(r); return d ? d.getTime() : 0; };
    const byLatest = tRuns.slice().sort((a, b) => startOf(b) - startOf(a));

    // Nuvarande tider per station, från den senaste körning som har värdet; passagepunkter får sin passagetid
    const current = new Map();
    for (const run of byLatest) {
      const base = runStart(run);
      for (const s of run.stops || []) {
        if (!current.has(s.name)) current.set(s.name, { arr: null, dep: null, type: plannedType(s) });
        const c = current.get(s.name);
        if (c.arr == null && s.scheduledArrival) c.arr = clockMinutes(s.scheduledArrival, base);
        if (c.dep == null && s.scheduledDeparture) c.dep = clockMinutes(s.scheduledDeparture, base);
      }
    }
    for (const c of current.values()) {
      if (c.type === 'passage') {
        const t = c.dep != null ? c.dep : c.arr;
        c.arr = t;
        c.dep = t;
      }
    }

    // Tågets egna uppehåll vid planerade stopp: kom tåget tidigt och stod kvar efter planerad ankomst räknas
    // uppehållet därifrån (väntan på tidtabellen räknas inte), annars från verklig ankomst
    const dwells = new Map();
    for (const run of tRuns) {
      for (const s of (run.stops || []).slice(1, -1)) {
        if (plannedType(s) !== 'stopp' || stopType(s) !== 'stopp') continue;
        const a = toDate(s.actualArrival);
        const d = toDate(s.actualDeparture);
        const pa = toDate(s.scheduledArrival);
        const from = a && d && pa && pa > a && pa < d ? pa : a;
        if (!from || !d) continue;
        const m = minutes(from, d);
        if (m > 0.05 && m < 60) {
          if (!dwells.has(s.name)) dwells.set(s.name, []);
          dwells.get(s.name).push(m);
        }
      }
    }

    const anchor = current.get(route[0]).dep;
    const missing = [];
    let known = anchor != null;
    if (!known) missing.push(`avgång från ${route[0]}`);
    let cum = 0;
    let prevDep = anchor;
    const rows = route.map((name, i) => {
      const c = current.get(name);
      const isFirst = i === 0;
      const isLast = i === route.length - 1;
      const row = {
        station: name, type: isFirst ? 'start' : isLast ? 'slut' : c.type,
        currentArr: isFirst ? null : c.arr, currentDep: isLast ? null : c.dep,
        propArr: null, propDep: null,
        plannedLeg: null, need: null, legValue: null, legRounded: null, legDiff: null, few: false,
        plannedDwell: null, dwellValue: null, dwellN: 0, dwellSource: null
      };
      if (isFirst) {
        row.propDep = anchor;
        return row;
      }
      const prevName = route[i - 1];
      const prev = current.get(prevName);
      const pattern = (prev.type === 'stopp' ? 'S' : 'P') + (c.type === 'stopp' ? 'S' : 'P');
      row.need = needFor(needsByKey, `${prevName} → ${name}`, pattern);
      row.plannedLeg = prev.dep != null && c.arr != null ? c.arr - prev.dep : null;
      row.legValue = row.need && row.need.n ? row.need[basis] : null;
      row.few = !!row.need && row.need.n < MIN_SAMPLES;
      if (row.legValue == null) {
        missing.push(`${prevName} → ${name}`);
        known = false;
      }
      if (known) {
        cum += row.legValue;
        row.propArr = anchor + Math.round(cum);
        row.legRounded = row.propArr - prevDep;
        if (row.plannedLeg != null) row.legDiff = row.legRounded - row.plannedLeg;
      }
      if (!isLast) {
        if (c.type === 'stopp') {
          row.plannedDwell = c.arr != null && c.dep != null ? c.dep - c.arr : null;
          const s = stats(dwells.get(name) || []);
          row.dwellN = s.n;
          if (s.n) { row.dwellValue = s[basis]; row.dwellSource = 'matt'; }
          else if (row.plannedDwell != null) { row.dwellValue = row.plannedDwell; row.dwellSource = 'planerat'; }
          else { missing.push(`uppehåll i ${name}`); known = false; }
        }
        if (known) {
          cum += c.type === 'stopp' ? row.dwellValue : 0;
          row.propDep = anchor + Math.round(cum);
          prevDep = row.propDep;
        }
      }
      return row;
    });
    const last = rows[rows.length - 1];
    return {
      train: nr, basis, route, rows, missing,
      runCount: tRuns.length, period: period(tRuns),
      totalCurrent: rows[0].currentDep != null && last.currentArr != null ? last.currentArr - rows[0].currentDep : null,
      totalProposed: known ? last.propArr - anchor : null,
      totalExact: known ? cum : null
    };
  }

```

I `railtimer-analys.js`, ersätt:

```js
    segmentNeeds, stationTimes, summarizeTrains, segmentPlans,
```

med:

```js
    segmentNeeds, stationTimes, summarizeTrains, segmentPlans, proposeTrainTimetable,
```

- [ ] **Step 4: Kör testerna och se dem lyckas**

Run: `node --test tests/railtimer-analys.test.js`
Expected: PASS, 34 tester, 0 misslyckade.

- [ ] **Step 5: Kör hela sviten**

Run: `node --test "tests/*.test.js"` och `node tests/run-browser-tests.mjs`
Expected: 81 Node-tester lyckas; 33 lyckades, 0 misslyckades.

- [ ] **Step 6: Committa**

```bash
git add railtimer-analys.js tests/railtimer-analys.test.js
git commit -m "Analys per tåg: tidtabellsförslag för ett tåg utifrån vad sträckorna tar och tågets egna uppehåll

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Fliken Per tåg

**Files:**
- Modify: `Analys.html`
- Test: `tests/replay.html`

**Interfaces:**
- Consumes (Task 1–3):
  - `AN.segmentObservations`, `AN.segmentNeeds`, `AN.summarizeTrains`, `AN.PATTERN_LABELS`, `AN.sliceRuns` och `AN.period`.
  - Befintliga `currentFilter()`, `toleranceValue()`, `describeFilter()`, `preparePrint()`, `printReport()`, `downloadText()`, `fmtMin`, `fmtSigned`, `fmtTol`, `periodText`, `nowText`, `safeFilePart`, `esc` och `ASSESSMENT_LABELS`.
- Produces:
  - `timetableData() → { tol, filter, stationType, route, base, obs, needs, trainRuns, runCount, timetableRuns, period, trains }`.
  - Global `tState` (senaste `timetableData()`) och `openTrain`.
  - `renderTrains()`, `showTrain(nr)`, `renderTrainDetail()`, `trainsMeta(d)`, `exportTrainsCsv()` och `printTrains()`.
  - `fmtClock(min)`, `EVENT_LABELS`, `WEEKDAYS` och `TRAINS_TITLE`.
  - Testkrokarna `showTrain`, `exportTrainsCsv` och `prepareTrainsPrint`.
  - Testhjälparen `ttStop(name, o, day)`, där `day` är valfri, och testdatan `trainRuns()` i `tests/replay.html`.

- [ ] **Step 1: Skriv de misslyckade testerna**

I `tests/replay.html`, ersätt:

```js
function ttStop(name, o) {
  const t = v => (v == null ? null : atMin(v));
```

med:

```js
function ttStop(name, o, day) {
  const t = v => (v == null ? null : atMin(v, day));
```

Lägg till före raden `// ── Körning ──` i `tests/replay.html`:

```js
// ── Analys per tåg ──

/* Lidköping → Filsbäck → Källby → Blomberg den 13–15 oktober. Tåg 3344 har 6 min Filsbäck → Källby och tåg 3346
   har 2 min; båda tar 4 min. 3344 kommer 2 min tidigt till Källby och tappar 2,5 min där den 15:e.
   Tåg 3355 (motsatt riktning) saknar tidtabell. */
function trainRuns() {
  const days = [13, 14, 15];
  const t3344 = days.map(day => {
    const s = 420;
    const kDep = day === 15 ? s + 13.5 : s + 11;
    return {
      id: '3344-' + day, trainNumber: '3344', vehicleType: 'Y31', startedAt: atMin(s, day), aborted: false,
      startStation: 'Lidköping', endStation: 'Blomberg',
      stops: [
        ttStop('Lidköping', { dep: s, sDep: s }, day),
        ttStop('Filsbäck', { arr: s + 3, dep: s + 4, sArr: s + 3, sDep: s + 4 }, day),
        ttStop('Källby', { arr: s + 8, dep: kDep, sArr: s + 10, sDep: s + 11 }, day),
        ttStop('Blomberg', { arr: kDep + 3, sArr: s + 14 }, day)
      ]
    };
  });
  const t3346 = days.map(day => {
    const s = 600;
    return {
      id: '3346-' + day, trainNumber: '3346', vehicleType: 'Y31', startedAt: atMin(s, day), aborted: false,
      startStation: 'Lidköping', endStation: 'Blomberg',
      stops: [
        ttStop('Lidköping', { dep: s, sDep: s }, day),
        ttStop('Filsbäck', { arr: s + 3, dep: s + 4, sArr: s + 3, sDep: s + 4 }, day),
        ttStop('Källby', { arr: s + 8, dep: s + 9, sArr: s + 6, sDep: s + 7 }, day),
        ttStop('Blomberg', { arr: s + 12, sArr: s + 10 }, day)
      ]
    };
  });
  const t3355 = [720, 750].map(s => ({
    id: '3355-' + s, trainNumber: '3355', vehicleType: 'Y31', startedAt: atMin(s), aborted: false,
    startStation: 'Blomberg', endStation: 'Lidköping',
    stops: [
      ttStop('Blomberg', { dep: s }), ttStop('Källby', { arr: s + 3, dep: s + 4 }),
      ttStop('Filsbäck', { arr: s + 8, dep: s + 9 }), ttStop('Lidköping', { arr: s + 12 })
    ]
  }));
  return t3344.concat(t3346, t3355);
}

test('analys: Per tåg är förvald och visar varje tåg mot sin egen tidtabell', async () => {
  const w = await loadAnalysWith(trainRuns());
  assert(w.document.getElementById('tabTrains').classList.contains('active'), 'Per tåg ska vara förvald');
  const summary = w.document.getElementById('trainsSummary').textContent;
  assertEqual(summary, 'Bygger på 6 körningar med tidtabell av 8 i urvalet · 2 tåg · period 2026-10-13 – 2026-10-15 · tolerans ±1 min · 1 tågnummer utan tidtabell (2 körningar) visas inte', 'sammanfattning');
  assertEqual(tableRows(w, 'trainsTable'), [
    ['3344', 'Lidköping → Blomberg', '3', '0,0', '0,0', '+2,0', '1', '2,5'],
    ['3346', 'Lidköping → Blomberg', '3', '0,0', '+2,0', '−2,0', '0', '–']
  ], 'tåg');
  assertEqual(w.document.getElementById('trainDetail').innerHTML, '', 'inget tåg öppet');
});

test('analys: tågkortet visar sträckor mot vad sträckan tar, uppehåll och gånger tåget tappade tid', async () => {
  const w = await loadAnalysWith(trainRuns());
  Array.from(w.document.querySelectorAll('#trainsTable tbody tr')).find(tr => tr.cells[0].textContent === '3344').click();
  assertEqual(tableRows(w, 'trainSegments'), [
    ['Lidköping → Filsbäck', 'Stopp–stopp', '3', '3,0', '3,0', '3,0', '6', '0,0', 'Lagom'],
    ['Filsbäck → Källby', 'Stopp–stopp', '6', '4,0', '4,0', '4,0', '6', '+2,0', 'Generös'],
    ['Källby → Blomberg', 'Stopp–stopp', '3', '3,0', '3,0', '3,0', '6', '0,0', 'Lagom'],
    ['Summa', '', '12,0', '', '10,0', '', '', '+2,0', '']
  ], 'sträckor');
  assertEqual(tableRows(w, 'trainDwells'), [
    ['Filsbäck', '1', '1,0', '0,0', '0', '3'],
    ['Källby', '1', '3,0', '0,0', '1', '3']
  ], 'uppehåll');
  assertEqual(tableRows(w, 'trainEvents'), [
    ['2026-10-15', 'Tor', '07:11', 'Källby', 'Uppehåll', '2,5', '−2,0', '+2,5', '5,5', '1']
  ], 'gånger tåget tappade tid');
  assert(w.document.querySelector('#trainsTable tbody tr.selected').cells[0].textContent === '3344', 'raden markeras');
});

test('analys: tågnummerfiltret visar ett tåg men sträckornas tid bygger på alla tåg', async () => {
  const w = await loadAnalysWith(trainRuns());
  w.__analys.setFilters({ filterTrain: '3346' });
  assertEqual(tableRows(w, 'trainsTable').map(r => r[0]), ['3346'], 'bara tåg 3346');
  const fk = tableRows(w, 'trainSegments').find(r => r[0] === 'Filsbäck → Källby');
  assertEqual([fk[2], fk[4], fk[6], fk[7], fk[8]], ['2', '4,0', '6', '−2,0', 'Snål'], 'kortet öppnas och Underlag är alla sex körningar');
});

test('analys: Per tåg med två valda stationer och med tomt urval', async () => {
  const w = await loadAnalysWith(trainRuns());
  w.__analys.setFilters({ filterFrom: 'Lidköping', filterTo: 'Källby' });
  const summary = w.document.getElementById('trainsSummary').textContent;
  assert(summary.startsWith('Bygger på 6 körningar med tidtabell av 6 i urvalet · 2 tåg') && summary.endsWith('· sträcka Lidköping → Källby'), 'sammanfattning: ' + summary);
  assertEqual(tableRows(w, 'trainsTable').map(r => [r[0], r[1], r[5]]), [['3344', 'Lidköping → Källby', '+2,0'], ['3346', 'Lidköping → Källby', '−2,0']], 'avskurna');
  w.__analys.setFilters({ filterFrom: '', filterTo: '', filterDayType: 'helg' });
  assertEqual(w.document.getElementById('trainsSummary').textContent, 'Inga körningar med tidtabellstider i urvalet.', 'tomt urval');
  assertEqual(w.document.getElementById('trainsContent').style.display, 'none', 'tabellen döljs');
});

test('analys: export och utskrift av Per tåg, även med Ctrl+P', async () => {
  const w = await loadAnalysWith(trainRuns());
  let text = w.__analys.exportTrainsCsv();
  assert(text.charCodeAt(0) === 0xFEFF, 'BOM saknas');
  for (const part of ['"Bygger på";"6 körningar med tidtabell (av 8 i urvalet), 2 tåg"', '"Tolerans";"±1 min"',
    '"3344";"Lidköping → Blomberg";"3";"3";"0";"0";"2";"3";"3";"1";"2,5"']) {
    assert(text.includes(part), 'saknas i CSV: ' + part);
  }
  assert(/^per-tag_\d{4}-\d{2}-\d{2}\.csv$/.test(w.__analys.getLastDownload().filename), 'filnamn');
  w.__analys.showTrain('3344');
  text = w.__analys.exportTrainsCsv();
  assert(text.includes('"Tåg 3344 – gånger tåget tappade tid"') && text.includes('"2026-10-15";"Tor";"07:11";"Källby";"Uppehåll";"2,5";"-2";"2,5";"5,5";"1"'), 'tågkortet i CSV');
  assert(/^tag-3344_\d{4}-\d{2}-\d{2}\.csv$/.test(w.__analys.getLastDownload().filename), 'filnamn med tåg');
  const header = w.__analys.prepareTrainsPrint();
  assert(header.includes('RailTimer – Analys per tåg') && header.includes('Bygger på: 6 körningar med tidtabell (av 8 i urvalet), 2 tåg') && header.includes('Tåg: 3344'), 'utskrift: ' + header);
  w.__analys.setFilters({ filterTimeOfDay: 'dag' });
  w.dispatchEvent(new w.Event('beforeprint'));
  const printed = w.document.querySelector('#trainsReport .print-header').textContent;
  assert(printed.includes('Bygger på: 3 körningar med tidtabell (av 5 i urvalet), 1 tåg'), 'Ctrl+P efter filterbyte: ' + printed);
});

```

- [ ] **Step 2: Kör testerna och se dem misslyckas**

Run: `node tests/run-browser-tests.mjs analys`
Expected: de fem nya testerna misslyckas, eftersom `tabTrains`, `trainsSummary`, `trainsTable` och testkrokarna saknas. De 15 befintliga analystesterna lyckas.

- [ ] **Step 3: Lägg till fliken i sidan**

I `Analys.html`, ersätt:

```html
  <div class="tabs">
    <button class="tab active" data-tab="chart">Diagram</button>
```

med:

```html
  <div class="tabs">
    <button class="tab active" data-tab="trains">Per tåg</button>
    <button class="tab" data-tab="chart">Diagram</button>
```

I `Analys.html`, ersätt:

```html
  <div id="tabChart" class="tab-content active">
```

med:

```html
  <div id="tabTrains" class="tab-content active">
    <div class="report" id="trainsReport">
      <div class="print-header"></div>
      <p class="meta" id="trainsSummary">Ladda data för att se analys.</p>
      <div id="trainsContent" style="display:none">
        <div class="report-actions no-print">
          <button id="btnTrainsCsv" class="ghost">Exportera till Excel</button>
          <button id="btnTrainsPrint" class="ghost">Skriv ut / PDF</button>
        </div>
        <div class="table-wrap">
          <table id="trainsTable" class="clickable">
            <thead><tr>
              <th>Tåg</th>
              <th>Sträcka</th>
              <th class="num" title="Körningar med tidtabell">Körningar</th>
              <th class="num" title="Avvikelse vid avgång från första mätta station, median (min)">Avgång start</th>
              <th class="num" title="Avvikelse vid ankomst till sista mätta station, median (min)">Ankomst slut</th>
              <th class="num" title="Planerad gångtid − vad sträckorna tar, summerat över tågets sträckor (min). Positivt = tid över">Marginal</th>
              <th class="num" title="Gånger tåget tappade mer än toleransen vid en station">Tappat tid</th>
              <th class="num" title="Mest tappad tid vid en station (min)">Mest tappat</th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div id="trainDetail"></div>
        <p class="meta no-print">Klicka på ett tåg för att se dess sträckor, uppehåll och gångerna det tappade tid. <strong>Sträckan tar</strong> = median av mätta gångtider för alla tåg som stannade och passerade som tidtabellen säger; med färre än 3 sådana mätningar används alla mätningar på sträckan. <strong>Marginal</strong> = planerad gångtid − vad sträckan tar. <strong>Tappad tid</strong> vid en station = avgångens avvikelse − ankomstens försening (tidig ankomst räknas som 0), alltså hur mycket längre tåget stod än tidtabellen gav utrymme för. Resandeantal finns inte i mätningarna; datum, veckodag och klockslag visas så att mönster syns.</p>
      </div>
    </div>
  </div>

  <div id="tabChart" class="tab-content">
```

I `Analys.html`, ersätt:

```css
  .print-header{display:none}
```

med:

```css
  .sum-row td{font-weight:600;border-top:2px solid var(--b)}
  .print-header{display:none}
```

I `Analys.html`, ersätt:

```css
    header,.card,#modeDescription,.stats-row,.tabs,.no-print,.tab-content:not(.active),#ttHint,#againstSummary,#ttSummary{display:none !important}
```

med:

```css
    header,.card,#modeDescription,.stats-row,.tabs,.no-print,.tab-content:not(.active),#ttHint,#againstSummary,#ttSummary,#trainsSummary{display:none !important}
```

- [ ] **Step 4: Skriv koden för fliken**

I `Analys.html`, ersätt:

```js
  let lastDownload = null;       // senaste exporten (läses av testerna)
```

med:

```js
  let lastDownload = null;       // senaste exporten (läses av testerna)
  let tState = null;             // analys per tåg: urval, vad sträckorna tar, tåg och sträckor
  let openTrain = '';            // tåget vars kort visas i Per tåg
```

Lägg till före raden `  // Mode tabs (Gångtider / Uppehållstider)` i `Analys.html`:

```js
  document.getElementById('btnTrainsCsv').addEventListener('click', exportTrainsCsv);
  document.getElementById('btnTrainsPrint').addEventListener('click', printTrains);
  document.getElementById('trainsTable').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-train]');
    if(tr) showTrain(tr.dataset.train);
  });

```

I `Analys.html`, ersätt:

```js
    updateTimetable(filteredLogs);
    renderAgainst(filteredLogs);
  }
```

med:

```js
    updateTimetable(filteredLogs);
    renderAgainst(filteredLogs);
    tState = timetableData();
    renderTrains();
  }
```

I `Analys.html`, ersätt:

```js
    document.getElementById('againstSummary').textContent = 'Ladda data för att se analys.';
    document.getElementById('againstContent').style.display = 'none';
  }
```

med:

```js
    document.getElementById('againstSummary').textContent = 'Ladda data för att se analys.';
    document.getElementById('againstContent').style.display = 'none';
    tState = null;
    document.getElementById('trainsSummary').textContent = 'Ladda data för att se analys.';
    document.getElementById('trainsContent').style.display = 'none';
  }
```

I `Analys.html`, ersätt:

```js
  const TIMETABLE_TITLE = 'RailTimer – Tidtabellsförslag';
```

med:

```js
  const TIMETABLE_TITLE = 'RailTimer – Tidtabellsförslag';
  const TRAINS_TITLE = 'RailTimer – Analys per tåg';
  const EVENT_LABELS = { start: 'Avgång från start', stopp: 'Uppehåll', passage: 'Stopp vid passage' };
  const WEEKDAYS = ['Sön', 'Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör'];
```

I `Analys.html`, ersätt:

```js
  function periodText(p){ return p ? (p.from === p.to ? p.from : p.from + ' – ' + p.to) : '–'; }
```

med:

```js
  function periodText(p){ return p ? (p.from === p.to ? p.from : p.from + ' – ' + p.to) : '–'; }
  // Minuter efter midnatt som klockslag TT:MM (tåg över midnatt börjar om på 00:00)
  function fmtClock(min){
    if(min == null) return '–';
    const total = ((Math.round(min) % 1440) + 1440) % 1440;
    return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  }
```

Lägg till före raden `  // ── Mot tidtabell: gångtid per sträcka och klockslag per station ──` i `Analys.html`:

```js
  // ── Analys per tåg: urvalet och vad sträckorna tar ──

  function timetableData(){
    const tol = toleranceValue();
    const filter = currentFilter();
    const from = validStations.has(els.filterFrom.value) ? els.filterFrom.value : '';
    const to = validStations.has(els.filterTo.value) ? els.filterTo.value : '';
    const onRoute = from && to && from !== to;
    // Vad sträckorna tar räknas på alla tåg i urvalet, även när ett tågnummer är valt
    const all = allLogs.filter(log => AN.runMatches(log, Object.assign({}, filter, { train: '' })));
    const base = onRoute ? AN.sliceRuns(all, from, to) : all;
    const obs = AN.segmentObservations(base, { tolerance: tol });
    const needs = AN.segmentNeeds(obs);
    const trainRuns = filter.train ? base.filter(r => String(r.trainNumber || '') === filter.train) : base;
    const withTimetable = trainRuns.filter(r => (r.stops || []).some(s => s.scheduledArrival || s.scheduledDeparture));
    const stationType = els.filterStationType.value;
    return {
      tol, filter, stationType, route: onRoute ? from + ' → ' + to : '',
      base, obs, needs, trainRuns,
      runCount: trainRuns.length, timetableRuns: withTimetable.length, period: AN.period(withTimetable),
      trains: AN.summarizeTrains(trainRuns, needs, { tolerance: tol, stationType })
    };
  }

  // ── Per tåg ──

  // Summerad marginal; "x av y sträckor" när några sträckor saknar underlag
  function marginText(m){
    if(m.sum == null) return '–';
    return fmtSigned(m.sum) + (m.count < m.of ? ` <span class="few">${m.count} av ${m.of} sträckor</span>` : '');
  }

  function renderTrains(){
    const summary = document.getElementById('trainsSummary');
    const content = document.getElementById('trainsContent');
    const d = tState;
    if(!d || !d.trains.rows.length){
      summary.textContent = 'Inga körningar med tidtabellstider i urvalet.';
      content.style.display = 'none';
      openTrain = '';
      document.getElementById('trainDetail').innerHTML = '';
      return;
    }
    content.style.display = '';
    const w = d.trains.withoutTimetable;
    summary.textContent = `Bygger på ${d.timetableRuns} körningar med tidtabell av ${d.runCount} i urvalet · ${d.trains.rows.length} tåg · period ${periodText(d.period)} · tolerans ${fmtTol(d.tol)}` +
      (w.trains ? ` · ${w.trains} tågnummer utan tidtabell (${w.runs} körningar) visas inte` : '') +
      (d.route ? ` · sträcka ${d.route}` : '');
    document.querySelector('#trainsTable tbody').innerHTML = d.trains.rows.map(r => `<tr data-train="${esc(r.train)}">
      <td>${esc(r.train)}</td>
      <td>${esc(r.routeLabel)}</td>
      <td class="num">${r.timetableRuns}</td>
      <td class="num">${fmtSigned(r.startDelay.median)}</td>
      <td class="num">${fmtSigned(r.endDelay.median)}</td>
      <td class="num">${marginText(r.margin)}</td>
      <td class="num">${r.eventCount}</td>
      <td class="num">${r.lostMax == null ? '–' : fmtMin(r.lostMax)}</td>
    </tr>`).join('');
    // Ett ensamt tåg (t.ex. med tågnummerfiltret) öppnas direkt
    if(!d.trains.rows.some(r => r.train === openTrain)) openTrain = d.trains.rows.length === 1 ? d.trains.rows[0].train : '';
    renderTrainDetail();
  }

  function showTrain(train){
    openTrain = String(train || '');
    renderTrainDetail();
  }

  function prevText(values){
    return values.length ? ' <span class="few">tidigare ' + values.map(v => fmtMin(v, 0)).join(', ') + '</span>' : '';
  }

  function renderTrainDetail(){
    const el = document.getElementById('trainDetail');
    document.querySelectorAll('#trainsTable tbody tr').forEach(tr => tr.classList.toggle('selected', tr.dataset.train === openTrain));
    const r = tState && tState.trains.rows.find(x => x.train === openTrain);
    if(!r){ el.innerHTML = ''; return; }
    const tol = tState.tol;
    let html = `<h3>Tåg ${esc(r.train)} · ${esc(r.routeLabel)} · ${r.timetableRuns} körningar med tidtabell` +
      (r.runCount > r.timetableRuns ? ` (av ${r.runCount})` : '') + ` · period ${esc(periodText(r.period))}</h3>`;

    html += '<h3>Gångtid mot vad sträckan tar</h3><div class="table-wrap"><table id="trainSegments"><thead><tr>' +
      '<th>Sträcka</th><th>Stopp</th>' +
      '<th class="num" title="Planerad gångtid i senaste körningen (min)">Planerad</th>' +
      '<th class="num" title="Tågets egen gångtid, median (min)">Tåget kör</th>' +
      '<th class="num" title="Median för alla tåg som stannade och passerade som tidtabellen säger (min)">Sträckan tar</th>' +
      '<th class="num">P90</th><th class="num" title="Mätningar bakom Sträckan tar">Underlag</th>' +
      '<th class="num" title="Planerad − vad sträckan tar (min)">Marginal</th><th>Bedömning</th></tr></thead><tbody>';
    html += r.segments.map(s => `<tr>
      <td>${esc(s.segment)}</td>
      <td>${esc(AN.PATTERN_LABELS[s.pattern])}${s.need && s.need.pattern === '*' ? ' <span class="few">alla mätningar</span>' : ''}</td>
      <td class="num">${fmtMin(s.planned, 0)}${prevText(s.plannedPrev)}</td>
      <td class="num">${fmtMin(s.actual.median)}</td>
      <td class="num">${s.need ? fmtMin(s.need.median) : '–'}</td>
      <td class="num">${s.need ? fmtMin(s.need.p90) : '–'}</td>
      <td class="num">${s.need ? s.need.n : 0}</td>
      <td class="num">${fmtSigned(s.margin)}</td>
      <td><span class="assess ${s.assessment}">${ASSESSMENT_LABELS[s.assessment]}</span></td>
    </tr>`).join('');
    if(r.margin.count){
      html += `<tr class="sum-row"><td>Summa${r.margin.count < r.margin.of ? ` (${r.margin.count} av ${r.margin.of} sträckor)` : ''}</td><td></td>` +
        `<td class="num">${fmtMin(r.margin.planned)}</td><td></td><td class="num">${fmtMin(r.margin.need)}</td><td></td><td></td>` +
        `<td class="num">${fmtSigned(r.margin.sum)}</td><td></td></tr>`;
    }
    html += '</tbody></table></div>';

    html += '<h3>Uppehåll</h3>';
    if(r.dwells.length){
      html += '<div class="table-wrap"><table id="trainDwells"><thead><tr><th>Station</th>' +
        '<th class="num" title="Planerat uppehåll i senaste körningen (min)">Planerat</th>' +
        '<th class="num" title="Verkligt uppehåll när tåget stannade, median (min)">Verkligt</th>' +
        '<th class="num" title="Tappad tid vid stationen, median (min)">Tappad tid</th>' +
        `<th class="num" title="Gånger tåget tappade mer än ${esc(fmtTol(tol))}">Gånger tappat</th>` +
        '<th class="num">Mätningar</th></tr></thead><tbody>' +
        r.dwells.map(x => `<tr><td>${esc(x.station)}</td>
          <td class="num">${fmtMin(x.plannedDwell, 0)}${prevText(x.plannedPrev)}</td>
          <td class="num">${fmtMin(x.dwell.median)}</td><td class="num">${fmtSigned(x.lost.median)}</td>
          <td class="num">${x.events}</td><td class="num">${x.n}</td></tr>`).join('') + '</tbody></table></div>';
    }else{
      html += '<p class="meta">Inga planerade uppehåll på mellanstationer.</p>';
    }

    html += `<h3>Gånger tåget tappade tid (mer än ${esc(fmtTol(tol))})</h3>`;
    if(r.events.length){
      html += '<div class="table-wrap"><table id="trainEvents"><thead><tr><th>Datum</th><th>Dag</th>' +
        '<th class="num" title="Planerad avgång">Tid</th><th>Station</th><th>Typ</th>' +
        '<th class="num" title="Tappad tid (min)">Tappat</th><th class="num" title="Ankomstens avvikelse (min)">Ankomst</th>' +
        '<th class="num" title="Avgångens avvikelse (min)">Avgång</th><th class="num" title="Verkligt uppehåll (min)">Uppehåll</th>' +
        '<th class="num" title="Planerat uppehåll (min)">Planerat</th></tr></thead><tbody>' +
        r.events.map(e => `<tr><td>${esc(e.date)}</td><td>${WEEKDAYS[e.weekday] || ''}</td>
          <td class="num">${fmtClock(e.plannedClock)}</td><td>${esc(e.station)}</td><td>${EVENT_LABELS[e.type]}</td>
          <td class="num">${fmtMin(e.lost)}</td><td class="num">${fmtSigned(e.arrivalDev)}</td><td class="num">${fmtSigned(e.departureDev)}</td>
          <td class="num">${fmtMin(e.dwell)}</td><td class="num">${fmtMin(e.plannedDwell, 0)}</td></tr>`).join('') + '</tbody></table></div>';
    }else{
      html += '<p class="meta">Tåget har inte tappat mer än toleransen vid någon station i urvalet.</p>';
    }
    el.innerHTML = html;
  }

  function trainsMeta(d){
    const meta = [
      ['Bygger på', `${d.timetableRuns} körningar med tidtabell (av ${d.runCount} i urvalet), ${d.trains.rows.length} tåg`],
      ['Period', periodText(d.period)],
      ['Urval', describeFilter(d.route ? 'Sträcka: ' + d.route : '')],
      ['Tolerans', fmtTol(d.tol)]
    ];
    if(openTrain) meta.push(['Tåg', openTrain]);
    meta.push(['Skapad', nowText()]);
    return meta;
  }

  function exportTrainsCsv(){
    const d = tState;
    if(!d || !d.trains.rows.length) return null;
    const sections = [{
      title: 'Tåg',
      header: ['Tåg', 'Sträcka', 'Körningar med tidtabell', 'Körningar totalt', 'Avgång start median (min)', 'Ankomst slut median (min)',
        'Marginal summa (min)', 'Sträckor med marginal', 'Sträckor totalt', 'Gånger tappat tid', 'Mest tappat (min)'],
      rows: d.trains.rows.map(r => [r.train, r.routeLabel, r.timetableRuns, r.runCount, r.startDelay.median, r.endDelay.median,
        r.margin.sum, r.margin.count, r.margin.of, r.eventCount, r.lostMax])
    }];
    const r = d.trains.rows.find(x => x.train === openTrain);
    if(r){
      sections.push({
        title: `Tåg ${r.train} – gångtid mot vad sträckan tar`,
        header: ['Sträcka', 'Stopp', 'Planerad (min)', 'Tidigare planerad (min)', 'Tåget kör median (min)', 'Sträckan tar median (min)',
          'Sträckan tar P90 (min)', 'Underlag', 'Underlag avser', 'Marginal (min)', 'Bedömning'],
        rows: r.segments.map(s => [s.segment, AN.PATTERN_LABELS[s.pattern], s.planned, s.plannedPrev.map(v => AN.formatMinutes(v, 0)).join(', '),
          s.actual.median, s.need ? s.need.median : null, s.need ? s.need.p90 : null, s.need ? s.need.n : 0,
          s.need ? AN.PATTERN_LABELS[s.need.pattern] : '', s.margin, ASSESSMENT_LABELS[s.assessment]])
      }, {
        title: `Tåg ${r.train} – uppehåll`,
        header: ['Station', 'Planerat (min)', 'Verkligt median (min)', 'Tappad tid median (min)', 'Gånger tappat', 'Mätningar'],
        rows: r.dwells.map(x => [x.station, x.plannedDwell, x.dwell.median, x.lost.median, x.events, x.n])
      }, {
        title: `Tåg ${r.train} – gånger tåget tappade tid`,
        header: ['Datum', 'Veckodag', 'Planerad avgång', 'Station', 'Typ', 'Tappat (min)', 'Ankomst avvikelse (min)',
          'Avgång avvikelse (min)', 'Uppehåll (min)', 'Planerat uppehåll (min)'],
        rows: r.events.map(e => [e.date, WEEKDAYS[e.weekday] || '', fmtClock(e.plannedClock), e.station, EVENT_LABELS[e.type],
          e.lost, e.arrivalDev, e.departureDev, e.dwell, e.plannedDwell])
      });
    }
    const text = AN.csvDocument(TRAINS_TITLE, trainsMeta(d), sections);
    downloadText((r ? 'tag-' + safeFilePart(r.train) : 'per-tag') + '_' + AN.localDate(new Date()) + '.csv', text);
    return text;
  }

  function printTrains(){
    if(tState && tState.trains.rows.length) printReport('trainsReport', TRAINS_TITLE, trainsMeta(tState));
  }

```

I `Analys.html`, ersätt:

```js
    if(active.id === 'tabAgainst'){
```

med:

```js
    if(active.id === 'tabTrains'){
      if(tState && tState.trains.rows.length) preparePrint('trainsReport', TRAINS_TITLE, trainsMeta(tState));
      else preparePrint('trainsReport', TRAINS_TITLE, [['Urval', describeFilter()], ['Resultat', 'Inga körningar med tidtabellstider i urvalet.']]);
    }else if(active.id === 'tabAgainst'){
```

I `Analys.html`, ersätt:

```js
      showTab(name){ document.querySelector('.tab[data-tab="' + name + '"]').click(); },
```

med:

```js
      showTab(name){ document.querySelector('.tab[data-tab="' + name + '"]').click(); },
      showTrain,
      exportTrainsCsv,
      prepareTrainsPrint: () => tState && preparePrint('trainsReport', TRAINS_TITLE, trainsMeta(tState)),
```

- [ ] **Step 5: Kör testerna och se dem lyckas**

Run: `node tests/run-browser-tests.mjs analys`
Expected: alla analystester lyckas, även de fem nya.

- [ ] **Step 6: Kör hela sviten**

Run: `node --test "tests/*.test.js"` och `node tests/run-browser-tests.mjs`
Expected: 81 Node-tester lyckas; 38 lyckades, 0 misslyckades.

- [ ] **Step 7: Committa**

```bash
git add Analys.html tests/replay.html
git commit -m "Analysverktyget: fliken Per tåg – varje tåg mot sin egen tidtabell, vad sträckan tar och när tåget tappade tid

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Fliken Sträckor

**Files:**
- Modify: `Analys.html`
- Test: `tests/replay.html`

**Interfaces:**
- Consumes:
  - Task 2: `AN.segmentPlans(obs, needs, opts)`.
  - Task 4: `timetableData()`, `tState`, `trainRuns()`, `fmtMin`, `fmtSigned`, `esc`, `ASSESSMENT_LABELS`, `TRAINS_TITLE` och `fillActivePrintHeader` (med `tabTrains`).
- Produces:
  - `tState.segments` (svaret från `segmentPlans`) och `openSegment`.
  - `renderSegments()`, `renderSegmentDetail()`, `visibleSegments(rows, show)`, `segmentsMeta(d)`, `exportSegmentsCsv()` och `printSegments()`.
  - `ASSESSMENT_LABELS.blandad = 'Snål och generös'` och `SEGMENTS_TITLE`.
  - Testkrokarna `exportSegmentsCsv` och `prepareSegmentsPrint`.

- [ ] **Step 1: Skriv de misslyckade testerna**

Lägg till före raden `// ── Körning ──` i `tests/replay.html`:

```js
test('analys: Sträckor visar vad sträckan tar och planerad tid per tåg', async () => {
  const w = await loadAnalysWith(trainRuns());
  w.__analys.showTab('segments');
  const summary = w.document.getElementById('segmentsSummary').textContent;
  assert(summary.startsWith('3 sträckor med tidtabell, 1 med olika planerad tid för olika tåg · vad sträckan tar bygger på 8 körningar'), 'sammanfattning: ' + summary);
  assertEqual(tableRows(w, 'segmentsTable').map(r => r.slice(0, 5).concat([r[6]])), [
    ['Filsbäck → Källby', 'Stopp–stopp', '4,0', '4,0', '6', 'Snål och generös'],
    ['Källby → Blomberg', 'Stopp–stopp', '3,0', '3,0', '6', 'Lagom'],
    ['Lidköping → Filsbäck', 'Stopp–stopp', '3,0', '3,0', '6', 'Lagom']
  ], 'sträckor');
  const lines = Array.from(w.document.querySelectorAll('#segmentsTable tbody tr')[0].querySelectorAll('.plan-line')).map(l => l.textContent);
  assertEqual(lines, ['2 min (−2,0): 3346', '6 min (+2,0): 3344'], 'planerad tid per tåg');
  const show = w.document.getElementById('segmentsShow');
  show.value = 'olika';
  show.dispatchEvent(new w.Event('change'));
  assertEqual(tableRows(w, 'segmentsTable').map(r => r[0]), ['Filsbäck → Källby'], 'olika planerad tid');
  w.document.querySelector('#segmentsTable tbody tr').click();
  const detail = w.document.getElementById('segmentDetail');
  assertEqual(detail.querySelector('h3').textContent, 'Filsbäck → Källby (Stopp–stopp) – 6 mätningar med tidtabell', 'rubrik');
  assertEqual(tableRows(w, 'segmentObs').length, 6, 'mätningar');
  assertEqual(tableRows(w, 'segmentObs')[0].slice(4), ['som planerat', 'ja'], 'stannade och räknas');
});

test('analys: export och utskrift av Sträckor', async () => {
  const w = await loadAnalysWith(trainRuns());
  const text = w.__analys.exportSegmentsCsv();
  for (const part of ['"Filsbäck → Källby";"Stopp–stopp";"4";"4";"6";"Stopp–stopp";"2";"3346";"3";"4";"-2";"Snål";"Snål och generös"',
    '"Filsbäck → Källby";"Stopp–stopp";"4";"4";"6";"Stopp–stopp";"6";"3344";"3";"4";"2";"Generös";"Snål och generös"']) {
    assert(text.includes(part), 'saknas i CSV: ' + part);
  }
  assert(/^strackor_\d{4}-\d{2}-\d{2}\.csv$/.test(w.__analys.getLastDownload().filename), 'filnamn');
  w.__analys.showTab('segments');
  w.dispatchEvent(new w.Event('beforeprint'));
  const printed = w.document.querySelector('#segmentsReport .print-header').textContent;
  assert(printed.includes('RailTimer – Sträckor och planerad tid') && printed.includes('Bygger på: 3 sträckor med tidtabell; vad sträckan tar från 8 körningar (alla tåg i urvalet)'), 'utskrift: ' + printed);
});

```

- [ ] **Step 2: Kör testerna och se dem misslyckas**

Run: `node tests/run-browser-tests.mjs Sträckor`
Expected: de två nya testerna misslyckas, eftersom fliken `segments`, `segmentsSummary` och `exportSegmentsCsv` saknas.

- [ ] **Step 3: Lägg till fliken i sidan**

I `Analys.html`, ersätt:

```html
    <button class="tab active" data-tab="trains">Per tåg</button>
```

med:

```html
    <button class="tab active" data-tab="trains">Per tåg</button>
    <button class="tab" data-tab="segments">Sträckor</button>
```

Lägg till före raden `  <div id="tabChart" class="tab-content">` i `Analys.html`:

```html
  <div id="tabSegments" class="tab-content">
    <div class="report" id="segmentsReport">
      <div class="print-header"></div>
      <p class="meta" id="segmentsSummary">Ladda data för att se analys.</p>
      <div id="segmentsContent" style="display:none">
        <div class="report-actions no-print">
          <div class="filter-group">
            <label for="segmentsShow">Visa</label>
            <select id="segmentsShow">
              <option value="alla">Alla sträckor</option>
              <option value="olika">Sträckor där tågen har olika planerad tid</option>
              <option value="snal">Sträckor där något tåg har för lite tid</option>
              <option value="generos">Sträckor där något tåg har för mycket tid</option>
            </select>
          </div>
          <button id="btnSegmentsCsv" class="ghost">Exportera till Excel</button>
          <button id="btnSegmentsPrint" class="ghost">Skriv ut / PDF</button>
        </div>
        <div class="table-wrap">
          <table id="segmentsTable" class="clickable">
            <thead><tr>
              <th>Sträcka</th>
              <th>Stopp</th>
              <th class="num" title="Median för alla tåg som stannade och passerade som tidtabellen säger (min)">Sträckan tar</th>
              <th class="num">P90</th>
              <th class="num" title="Mätningar bakom Sträckan tar">Underlag</th>
              <th title="Planerad gångtid, marginal mot vad sträckan tar och tågen som har den tiden">Planerad tid per tåg</th>
              <th>Bedömning</th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div id="segmentDetail"></div>
        <p class="meta no-print">Varje rad är en sträcka med ett planerat stoppmönster. <strong>Sträckan tar</strong> är medianen för alla tåg i urvalet som stannade och passerade som tidtabellen säger, även körningar utan tidtabell; med färre än 3 sådana mätningar används alla mätningar på sträckan. <strong>Planerad tid per tåg</strong> visar varje planerad gångtid med marginalen mot vad sträckan tar inom parentes och tågen som har den. <strong>Snål och generös</strong>: något tåg har för lite tid och något annat för mycket. Klicka på en rad för att se mätningarna.</p>
      </div>
    </div>
  </div>

```

I `Analys.html`, ersätt:

```css
  .sum-row td{font-weight:600;border-top:2px solid var(--b)}
```

med:

```css
  .sum-row td{font-weight:600;border-top:2px solid var(--b)}
  .assess.blandad{background:rgba(245,158,11,0.15);color:var(--warn)}
  .plan-line + .plan-line{margin-top:.2rem}
```

I `Analys.html`, ersätt:

```css
    header,.card,#modeDescription,.stats-row,.tabs,.no-print,.tab-content:not(.active),#ttHint,#againstSummary,#ttSummary,#trainsSummary{display:none !important}
```

med:

```css
    header,.card,#modeDescription,.stats-row,.tabs,.no-print,.tab-content:not(.active),#ttHint,#againstSummary,#ttSummary,#trainsSummary,#segmentsSummary{display:none !important}
```

- [ ] **Step 4: Skriv koden för fliken**

I `Analys.html`, ersätt:

```js
  let openTrain = '';            // tåget vars kort visas i Per tåg
```

med:

```js
  let openTrain = '';            // tåget vars kort visas i Per tåg
  let openSegment = '';          // sträckan vars mätningar visas i Sträckor
```

Lägg till före raden `  // Mode tabs (Gångtider / Uppehållstider)` i `Analys.html`:

```js
  document.getElementById('segmentsShow').addEventListener('change', renderSegments);
  document.getElementById('btnSegmentsCsv').addEventListener('click', exportSegmentsCsv);
  document.getElementById('btnSegmentsPrint').addEventListener('click', printSegments);
  document.getElementById('segmentsTable').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if(!tr) return;
    openSegment = tr.dataset.key;
    renderSegmentDetail();
  });

```

I `Analys.html`, ersätt:

```js
      trains: AN.summarizeTrains(trainRuns, needs, { tolerance: tol, stationType })
    };
```

med:

```js
      trains: AN.summarizeTrains(trainRuns, needs, { tolerance: tol, stationType }),
      segments: AN.segmentPlans(obs, needs, { tolerance: tol, stationType, train: filter.train })
    };
```

I `Analys.html`, ersätt:

```js
    tState = timetableData();
    renderTrains();
  }
```

med:

```js
    tState = timetableData();
    renderTrains();
    renderSegments();
  }
```

I `Analys.html`, ersätt:

```js
    document.getElementById('trainsContent').style.display = 'none';
  }
```

med:

```js
    document.getElementById('trainsContent').style.display = 'none';
    document.getElementById('segmentsSummary').textContent = 'Ladda data för att se analys.';
    document.getElementById('segmentsContent').style.display = 'none';
  }
```

I `Analys.html`, ersätt:

```js
    snal: 'Snål', generos: 'Generös', lagom: 'Lagom', fa: 'För få mätningar',
```

med:

```js
    snal: 'Snål', generos: 'Generös', lagom: 'Lagom', fa: 'För få mätningar', blandad: 'Snål och generös',
```

I `Analys.html`, ersätt:

```js
  const TRAINS_TITLE = 'RailTimer – Analys per tåg';
```

med:

```js
  const TRAINS_TITLE = 'RailTimer – Analys per tåg';
  const SEGMENTS_TITLE = 'RailTimer – Sträckor och planerad tid';
```

Lägg till före raden `  // ── Mot tidtabell: gångtid per sträcka och klockslag per station ──` i `Analys.html`:

```js
  // ── Sträckor ──

  function visibleSegments(rows, show){
    if(show === 'olika') return rows.filter(r => r.plans.length > 1);
    if(show === 'snal') return rows.filter(r => r.plans.some(p => p.assessment === 'snal'));
    if(show === 'generos') return rows.filter(r => r.plans.some(p => p.assessment === 'generos'));
    return rows;
  }

  // "6 min (+2,0): 3344, 3360" – planerad tid, marginal mot vad sträckan tar och tågen som har tiden
  function planLine(p){
    return `${fmtMin(p.planned, 0)} min${p.margin == null ? '' : ' (' + fmtSigned(p.margin) + ')'}: ${p.trains.join(', ')}`;
  }

  function renderSegments(){
    const summary = document.getElementById('segmentsSummary');
    const content = document.getElementById('segmentsContent');
    const d = tState;
    if(!d || !d.segments.length){
      summary.textContent = 'Inga sträckor med tidtabell i urvalet.';
      content.style.display = 'none';
      openSegment = '';
      document.getElementById('segmentDetail').innerHTML = '';
      return;
    }
    content.style.display = '';
    const differing = d.segments.filter(r => r.plans.length > 1).length;
    summary.textContent = `${d.segments.length} sträckor med tidtabell, ${differing} med olika planerad tid för olika tåg · vad sträckan tar bygger på ${d.base.length} körningar (alla tåg i urvalet) · period ${periodText(AN.period(d.base))} · tolerans ${fmtTol(d.tol)}` +
      (d.filter.train ? ` · sträckor som tåg ${d.filter.train} kör` : '') + (d.route ? ` · sträcka ${d.route}` : '');
    const rows = visibleSegments(d.segments, document.getElementById('segmentsShow').value);
    document.querySelector('#segmentsTable tbody').innerHTML = rows.length ? rows.map(r => `<tr data-key="${esc(r.key)}">
      <td>${esc(r.segment)}</td>
      <td>${esc(AN.PATTERN_LABELS[r.pattern])}${r.need && r.need.pattern === '*' ? ' <span class="few">alla mätningar</span>' : ''}</td>
      <td class="num">${r.need ? fmtMin(r.need.median) : '–'}</td>
      <td class="num">${r.need ? fmtMin(r.need.p90) : '–'}</td>
      <td class="num">${r.need ? r.need.n : 0}</td>
      <td>${r.plans.map(p => `<div class="plan-line"><span class="assess ${p.assessment}">${esc(planLine(p))}</span></div>`).join('')}</td>
      <td><span class="assess ${r.assessment}">${ASSESSMENT_LABELS[r.assessment]}</span></td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">Inga sträckor med det valet</td></tr>';
    if(!d.segments.some(r => r.key === openSegment)) openSegment = '';
    renderSegmentDetail();
  }

  // Mätningarna med tidtabell bakom en rad, nyast först
  function renderSegmentDetail(){
    const el = document.getElementById('segmentDetail');
    document.querySelectorAll('#segmentsTable tbody tr').forEach(tr => tr.classList.toggle('selected', tr.dataset.key === openSegment));
    const r = tState && tState.segments.find(x => x.key === openSegment);
    if(!r){ el.innerHTML = ''; return; }
    const list = tState.obs.filter(o => o.key === r.segment && o.planned != null && o.plannedPattern === r.pattern)
      .sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));
    const counted = o => !!r.need && (r.need.pattern === '*' || o.actualPattern === r.need.pattern);
    el.innerHTML = `<h3>${esc(r.segment)} (${esc(AN.PATTERN_LABELS[r.pattern])}) – ${list.length} mätningar med tidtabell</h3>` +
      '<div class="table-wrap"><table id="segmentObs"><thead><tr><th>Datum</th><th>Tåg</th>' +
      '<th class="num">Planerad (min)</th><th class="num">Verklig (min)</th><th>Stannade</th><th>Räknas i Sträckan tar</th></tr></thead><tbody>' +
      list.map(o => `<tr><td>${esc(o.date)}</td><td>${esc(o.trainNumber)}</td>
        <td class="num">${fmtMin(o.planned, 0)}</td><td class="num">${fmtMin(o.actual)}</td>
        <td>${o.actualPattern === o.plannedPattern ? 'som planerat' : esc(AN.PATTERN_LABELS[o.actualPattern])}</td>
        <td>${counted(o) ? 'ja' : 'nej'}</td></tr>`).join('') + '</tbody></table></div>' +
      '<p class="meta">Sträckan tar räknas också på körningar utan tidtabell, så underlaget kan vara större än listan.</p>';
  }

  function segmentsMeta(d){
    const show = document.getElementById('segmentsShow');
    const meta = [
      ['Bygger på', `${d.segments.length} sträckor med tidtabell; vad sträckan tar från ${d.base.length} körningar (alla tåg i urvalet)`],
      ['Period', periodText(AN.period(d.base))],
      ['Urval', describeFilter(d.route ? 'Sträcka: ' + d.route : '')],
      ['Tolerans', fmtTol(d.tol)]
    ];
    if(show.value !== 'alla') meta.push(['Visar', show.options[show.selectedIndex].text]);
    meta.push(['Skapad', nowText()]);
    return meta;
  }

  function exportSegmentsCsv(){
    const d = tState;
    if(!d || !d.segments.length) return null;
    const rows = [];
    for(const r of visibleSegments(d.segments, document.getElementById('segmentsShow').value)){
      for(const p of r.plans){
        rows.push([r.segment, AN.PATTERN_LABELS[r.pattern], r.need ? r.need.median : null, r.need ? r.need.p90 : null, r.need ? r.need.n : 0,
          r.need ? AN.PATTERN_LABELS[r.need.pattern] : '', p.planned, p.trains.join(', '), p.n, p.actual.median, p.margin,
          ASSESSMENT_LABELS[p.assessment], ASSESSMENT_LABELS[r.assessment]]);
      }
    }
    const text = AN.csvDocument(SEGMENTS_TITLE, segmentsMeta(d), [{
      header: ['Sträcka', 'Stopp', 'Sträckan tar median (min)', 'Sträckan tar P90 (min)', 'Underlag', 'Underlag avser',
        'Planerad (min)', 'Tåg', 'Mätningar', 'Tågens median (min)', 'Marginal (min)', 'Bedömning', 'Bedömning sträckan'],
      rows
    }]);
    downloadText('strackor_' + AN.localDate(new Date()) + '.csv', text);
    return text;
  }

  function printSegments(){
    if(tState && tState.segments.length) printReport('segmentsReport', SEGMENTS_TITLE, segmentsMeta(tState));
  }

```

I `Analys.html`, ersätt:

```js
    }else if(active.id === 'tabAgainst'){
```

med:

```js
    }else if(active.id === 'tabSegments'){
      if(tState && tState.segments.length) preparePrint('segmentsReport', SEGMENTS_TITLE, segmentsMeta(tState));
      else preparePrint('segmentsReport', SEGMENTS_TITLE, [['Urval', describeFilter()], ['Resultat', 'Inga sträckor med tidtabell i urvalet.']]);
    }else if(active.id === 'tabAgainst'){
```

I `Analys.html`, ersätt:

```js
      prepareTrainsPrint: () => tState && preparePrint('trainsReport', TRAINS_TITLE, trainsMeta(tState)),
```

med:

```js
      prepareTrainsPrint: () => tState && preparePrint('trainsReport', TRAINS_TITLE, trainsMeta(tState)),
      exportSegmentsCsv,
      prepareSegmentsPrint: () => tState && preparePrint('segmentsReport', SEGMENTS_TITLE, segmentsMeta(tState)),
```

- [ ] **Step 5: Kör testerna och se dem lyckas**

Run: `node tests/run-browser-tests.mjs analys`
Expected: alla analystester lyckas, även de två nya.

- [ ] **Step 6: Kör hela sviten**

Run: `node --test "tests/*.test.js"` och `node tests/run-browser-tests.mjs`
Expected: 81 Node-tester lyckas; 40 lyckades, 0 misslyckades.

- [ ] **Step 7: Committa**

```bash
git add Analys.html tests/replay.html
git commit -m "Analysverktyget: fliken Sträckor – vad sträckan tar och planerad tid per tåg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Tidtabell per tåg, och Mot tidtabell tas bort

**Files:**
- Modify: `Analys.html`, `railtimer-analys.js`
- Test: `tests/replay.html`, `tests/railtimer-analys.test.js`

**Interfaces:**
- Consumes:
  - Task 3: `AN.proposeTrainTimetable(runs, needs, train, { basis })`.
  - Task 4: `tState` (`trains.rows`, `trainRuns`, `needs`, `filter`, `route`), `renderTrainDetail`, `fmtClock` och `trainRuns()`.
  - Task 5: `fillActivePrintHeader` med `tabTrains` och `tabSegments`.
- Produces:
  - `renderTimetable()`, `renderTTResult(p)`, `chosenTrain(rows)`, `openProposal(nr)`, `ttMeta(p)`, `exportTimetableCsv()`, `printTimetable()` och `timetableTitle(p)`.
  - `ttTrainChoice` och `TT_TYPE_LABELS`.
  - Testkroken `setTimetableTrain(nr)`.
- Tar bort:
  - Fliken Mot tidtabell och det gamla förslaget per riktning (starttid, kryssrutor för stopp).
  - `againstState`, `ttChoices`, `ttRouteKey` och `currentRuns`.
  - Modulens `stationObservations`, `stationLabel`, `summarizeSegments`, `summarizeStations`, `proposeTimetable`, `mode` och `countCategories`, med sina tester.

- [ ] **Step 1: Skriv de misslyckade testerna**

Lägg till före raden `// ── Körning ──` i `tests/replay.html`:

```js
test('analys: Tidtabell föreslår tidtabell för valt tåg utifrån vad sträckorna tar', async () => {
  const w = await loadAnalysWith(trainRuns());
  w.__analys.showTab('timetable');
  const options = Array.from(w.document.querySelectorAll('#ttTrain option')).map(o => o.value);
  assertEqual(options, ['3344', '3346'], 'tåg att välja');
  w.__analys.setTimetableTrain('3346');
  const summary = w.document.getElementById('ttSummary').textContent;
  assert(summary.startsWith('Förslag för tåg 3346 Lidköping → Blomberg · bygger på 3 körningar av tåget'), 'sammanfattning: ' + summary);
  assertEqual(tableRows(w, 'ttTable').map(r => r.slice(0, 9)), [
    ['Lidköping', 'Start', '', '10:00', '', '10:00', '', '', ''],
    ['Filsbäck', 'Stopp', '10:03', '10:04', '10:03', '10:04', '3', '3', '0'],
    ['Källby', 'Stopp', '10:06', '10:07', '10:08', '10:09', '2', '4', '+2'],
    ['Blomberg', 'Slut', '10:10', '', '10:12', '', '3', '3', '0']
  ], 'tider');
  assert(w.document.getElementById('ttResult').textContent.includes('Restid nu 10 min · förslag 12 min'), 'restid');
  const text = w.__analys.exportTimetableCsv();
  for (const part of ['"Tåg";"3346"', '"Bygger på";"3 körningar av tåget; sträckornas tid på alla tåg i urvalet"', '"Tidsbas";"Median"',
    '"Källby";"Stopp";"10:06";"10:07";"10:08";"10:09";"2";"4";"2";"1";"1";"6";"3"', '"Restid (min)";"";"";"";"";"";"10";"12";"2"']) {
    assert(text.includes(part), 'saknas i CSV: ' + part);
  }
  assert(/^tidtabell_3346_\d{4}-\d{2}-\d{2}\.csv$/.test(w.__analys.getLastDownload().filename), 'filnamn');
  const header = w.__analys.prepareTimetablePrint();
  assert(header.includes('RailTimer – Tidtabellsförslag tåg 3346 Lidköping → Blomberg') && header.includes('Bygger på: 3 körningar av tåget'), 'utskrift: ' + header);
});

test('analys: knappen i tågkortet öppnar tidtabellsförslaget, och Mot tidtabell finns inte längre', async () => {
  const w = await loadAnalysWith(trainRuns());
  w.__analys.showTrain('3344');
  w.document.querySelector('#trainDetail button[data-proposal]').click();
  assert(w.document.getElementById('tabTimetable').classList.contains('active'), 'Tidtabell visas');
  assertEqual(w.document.getElementById('ttTrain').value, '3344', 'tåget är valt');
  const kallby = tableRows(w, 'ttTable').find(r => r[0] === 'Källby');
  assertEqual(kallby.slice(2, 9), ['07:10', '07:11', '07:08', '07:09', '6', '4', '−2'], 'Källby för 3344: väntan räknas inte i uppehållet');
  w.dispatchEvent(new w.Event('beforeprint'));
  assert(w.document.querySelector('#ttReport .print-header').textContent.includes('Tåg: 3344'), 'Ctrl+P');
  assertEqual(w.document.querySelector('.tab[data-tab="against"]'), null, 'fliken Mot tidtabell är borta');
  assertEqual(Array.from(w.document.querySelectorAll('.tab')).map(t => t.textContent),
    ['Per tåg', 'Sträckor', 'Tidtabell', 'Diagram', 'Tabell', 'Avvikare', 'Detaljer'], 'flikarnas ordning');
});

```

- [ ] **Step 2: Kör testerna och se dem misslyckas**

Run: `node tests/run-browser-tests.mjs Tidtabell` och `node tests/run-browser-tests.mjs tågkortet`
Expected: de två nya testerna misslyckas, eftersom `#ttTrain` saknas och `setTimetableTrain` inte finns. Det andra testet misslyckas på `button[data-proposal]`, som är `null`.

- [ ] **Step 3: Ersätt Tidtabell och ta bort Mot tidtabell i sidan**

I `Analys.html`, ersätt:

```html
    <button class="tab" data-tab="segments">Sträckor</button>
    <button class="tab" data-tab="chart">Diagram</button>
    <button class="tab" data-tab="table">Tabell</button>
    <button class="tab" data-tab="outliers">Avvikare</button>
    <button class="tab" data-tab="details">Detaljer</button>
    <button class="tab" data-tab="timetable">Tidtabell</button>
    <button class="tab" data-tab="against">Mot tidtabell</button>
```

med:

```html
    <button class="tab" data-tab="segments">Sträckor</button>
    <button class="tab" data-tab="timetable">Tidtabell</button>
    <button class="tab" data-tab="chart">Diagram</button>
    <button class="tab" data-tab="table">Tabell</button>
    <button class="tab" data-tab="outliers">Avvikare</button>
    <button class="tab" data-tab="details">Detaljer</button>
```

I `Analys.html`, ersätt allt från och med raden

```html
  <div id="tabTimetable" class="tab-content">
```

till (men inte med) raden

```html
</main>
```

med:

```html
  <div id="tabTimetable" class="tab-content">
    <div class="report" id="ttReport">
      <div class="print-header"></div>
      <p class="meta" id="ttSummary">Ladda data för att se analys.</p>
      <div id="ttContent" style="display:none">
        <div class="timetable-setup no-print" id="ttActions">
          <div class="filter-group">
            <label for="ttTrain">Tåg</label>
            <select id="ttTrain"></select>
          </div>
          <div class="filter-group">
            <label for="ttTimeBasis">Tidsbas</label>
            <select id="ttTimeBasis">
              <option value="median">Median (realistisk)</option>
              <option value="p90">P90 (med marginal)</option>
              <option value="mean">Medelvärde</option>
            </select>
          </div>
          <button id="btnTtCsv" class="ghost">Exportera till Excel</button>
          <button id="btnTtPrint" class="ghost">Skriv ut / PDF</button>
        </div>
        <div id="ttResult" class="timetable-result"></div>
      </div>
    </div>
  </div>

```

I `Analys.html`, ta bort:

```css
  .station-list{display:flex;flex-direction:column;gap:.25rem;margin-bottom:1rem}
  .station-item{display:flex;align-items:center;gap:.5rem;padding:.4rem .6rem;border-radius:6px;background:var(--bg);border:1px solid var(--b);font-size:.85rem}
  .station-item.endpoint{background:var(--pri-glow);border-color:var(--pri)}
  .station-item label{display:flex;align-items:center;gap:.5rem;flex:1;cursor:pointer}
  .station-item .station-name{flex:1}
  .station-item .station-data{color:var(--mut);font-size:.75rem}
```

I `Analys.html`, ersätt:

```css
  .assess.snal,.assess.sen-ankomst,.assess.sen-avgang{background:rgba(239,68,68,0.15);color:var(--err)}
  .assess.generos,.assess.vantan,.assess.tidig{background:rgba(59,130,246,0.15);color:var(--blue)}
  .assess.lagom,.assess.itid{background:rgba(34,197,94,0.15);color:var(--pri)}
  .assess.fa{background:var(--bg);color:var(--mut)}
  .clickable tbody tr[data-key]{cursor:pointer}
```

med:

```css
  .assess.snal{background:rgba(239,68,68,0.15);color:var(--err)}
  .assess.generos{background:rgba(59,130,246,0.15);color:var(--blue)}
  .assess.lagom{background:rgba(34,197,94,0.15);color:var(--pri)}
  .assess.fa{background:var(--bg);color:var(--mut)}
  .clickable tbody tr[data-key],.clickable tbody tr[data-train]{cursor:pointer}
```

I `Analys.html`, ersätt:

```css
    header,.card,#modeDescription,.stats-row,.tabs,.no-print,.tab-content:not(.active),#ttHint,#againstSummary,#ttSummary,#trainsSummary,#segmentsSummary{display:none !important}
```

med:

```css
    header,.card,#modeDescription,.stats-row,.tabs,.no-print,.tab-content:not(.active),#ttSummary,#trainsSummary,#segmentsSummary{display:none !important}
```

I `Analys.html`, ersätt:

```js
  let currentRuns = [];          // körningarna i aktuellt urval
  let ttChoices = {};            // valda stopp i tidtabellsförslaget: { station: true/false }
  let ttRouteKey = '';
  let lastTimetable = null;      // senaste tidtabellsförslaget
  let againstState = null;       // senaste analysen i Mot tidtabell
```

med:

```js
  let lastTimetable = null;      // senaste tidtabellsförslaget
  let ttTrainChoice = '';        // tåget som senast valdes i Tidtabell
```

I `Analys.html`, ersätt:

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

med:

```js
  document.getElementById('ttTrain').addEventListener('change', e => { ttTrainChoice = e.target.value; renderTimetable(); });
  document.getElementById('ttTimeBasis').addEventListener('change', renderTimetable);
  document.getElementById('btnTtCsv').addEventListener('click', exportTimetableCsv);
  document.getElementById('btnTtPrint').addEventListener('click', printTimetable);
  document.getElementById('trainDetail').addEventListener('click', e => {
    const btn = e.target.closest('button[data-proposal]');
    if(btn) openProposal(btn.dataset.proposal);
  });
```

I `Analys.html`, ersätt:

```js
    let filteredLogs = allLogs.filter(log => AN.runMatches(log, filter));
    currentRuns = filteredLogs;
```

med:

```js
    let filteredLogs = allLogs.filter(log => AN.runMatches(log, filter));
```

I `Analys.html`, ersätt:

```js
    updateTimetable(filteredLogs);
    renderAgainst(filteredLogs);
    tState = timetableData();
    renderTrains();
    renderSegments();
  }
```

med:

```js
    tState = timetableData();
    renderTrains();
    renderSegments();
    renderTimetable();
  }
```

I `Analys.html`, ersätt:

```js
    againstState = null;
    lastTimetable = null;
    document.getElementById('againstSummary').textContent = 'Ladda data för att se analys.';
    document.getElementById('againstContent').style.display = 'none';
    tState = null;
```

med:

```js
    lastTimetable = null;
    tState = null;
```

I `Analys.html`, ersätt:

```js
    document.getElementById('segmentsContent').style.display = 'none';
  }
```

med:

```js
    document.getElementById('segmentsContent').style.display = 'none';
    document.getElementById('ttSummary').textContent = 'Ladda data för att se analys.';
    document.getElementById('ttContent').style.display = 'none';
  }
```

I `Analys.html`, ersätt:

```js
  // ── Gemensamt för Mot tidtabell och Tidtabell ──

  const ASSESSMENT_LABELS = {
    snal: 'Snål', generos: 'Generös', lagom: 'Lagom', fa: 'För få mätningar', blandad: 'Snål och generös',
    vantan: 'Tidig – väntan', tidig: 'Tidig', 'sen-ankomst': 'Sen ankomst', 'sen-avgang': 'Sen avgång', itid: 'I tid'
  };
```

med:

```js
  // ── Gemensamt för Per tåg, Sträckor och Tidtabell ──

  const ASSESSMENT_LABELS = {
    snal: 'Snål', generos: 'Generös', lagom: 'Lagom', fa: 'För få mätningar', blandad: 'Snål och generös'
  };
```

I `Analys.html`, ersätt:

```js
  const AGAINST_TITLE = 'RailTimer – Avvikelser mot tidtabell';
  const TIMETABLE_TITLE = 'RailTimer – Tidtabellsförslag';
```

med:

```js
  const TIMETABLE_TITLE = 'RailTimer – Tidtabellsförslag';
  const TT_TYPE_LABELS = { start: 'Start', stopp: 'Stopp', passage: 'Passage', slut: 'Slut' };
```

I `Analys.html`, ta bort:

```js
  function plannedText(p, min, max){
    if(p == null) return '–';
    return min != null && max != null && min !== max ? `${fmtMin(p, 0)} (${fmtMin(min, 0)}–${fmtMin(max, 0)})` : fmtMin(p, 0);
  }
```

I `Analys.html`, ersätt:

```js
      (r.runCount > r.timetableRuns ? ` (av ${r.runCount})` : '') + ` · period ${esc(periodText(r.period))}</h3>`;
```

med:

```js
      (r.runCount > r.timetableRuns ? ` (av ${r.runCount})` : '') + ` · period ${esc(periodText(r.period))}</h3>` +
      `<div class="report-actions no-print"><button class="ghost" data-proposal="${esc(r.train)}">Tidtabellsförslag för tåget</button></div>`;
```

I `Analys.html`, ersätt allt från och med raden

```js
  // ── Mot tidtabell: gångtid per sträcka och klockslag per station ──
```

till (men inte med) raden

```js
  // Utskrift med Ctrl+P (eller knappen): utskriftshuvudet fylls alltid med det aktuella urvalet,
```

med:

```js
  // ── Tidtabell: förslag för ett tåg ──

  function timetableTitle(p){ return TIMETABLE_TITLE + ' tåg ' + p.train + ' ' + p.route[0] + ' → ' + p.route[p.route.length - 1]; }

  // Tåget i Tidtabell: senast valda, annars tågnummerfiltret, annars första tåget i Per tåg
  function chosenTrain(rows){
    const has = t => !!t && rows.some(r => r.train === t);
    if(has(ttTrainChoice)) return ttTrainChoice;
    if(tState && has(tState.filter.train)) return tState.filter.train;
    return rows.length ? rows[0].train : '';
  }

  function renderTimetable(){
    const summary = document.getElementById('ttSummary');
    const content = document.getElementById('ttContent');
    const rows = tState ? tState.trains.rows : [];
    lastTimetable = null;
    if(!rows.length){
      summary.textContent = 'Inga tåg med tidtabell i urvalet.';
      content.style.display = 'none';
      return;
    }
    content.style.display = '';
    const train = chosenTrain(rows);
    const select = document.getElementById('ttTrain');
    select.innerHTML = rows.map(r => `<option value="${esc(r.train)}">${esc(r.train)} – ${esc(r.routeLabel)} (${r.timetableRuns} körningar)</option>`).join('');
    select.value = train;
    const p = AN.proposeTrainTimetable(tState.trainRuns, tState.needs, train, { basis: document.getElementById('ttTimeBasis').value });
    if(p.error){
      summary.textContent = `Tåg ${train} saknar körningar med tidtabell i urvalet.`;
      document.getElementById('ttResult').innerHTML = '';
      return;
    }
    lastTimetable = p;
    summary.textContent = `Förslag för tåg ${p.train} ${p.route[0]} → ${p.route[p.route.length - 1]} · bygger på ${p.runCount} körningar av tåget; sträckornas tid på alla tåg i urvalet · period ${periodText(p.period)} · tidsbas ${BASIS_LABELS[p.basis]}`;
    renderTTResult(p);
  }

  function renderTTResult(p){
    const tol = toleranceValue();
    let html = '<div class="table-wrap"><table id="ttTable"><thead><tr>' +
      '<th>Station</th><th>Typ</th><th class="num">Ankomst nu</th><th class="num">Avgång nu</th>' +
      '<th class="num">Ankomst förslag</th><th class="num">Avgång förslag</th>' +
      '<th class="num" title="Planerad gångtid nu (min)">Gångtid nu</th>' +
      '<th class="num" title="Förslagets gångtid i hela minuter">Gångtid förslag</th>' +
      '<th class="num" title="Förslag − nu (min), färgad när skillnaden är större än toleransen">Skillnad</th>' +
      '<th class="num" title="Planerat uppehåll nu (min)">Uppehåll nu</th>' +
      '<th class="num" title="Uppehåll i förslaget (min)">Uppehåll förslag</th><th>Underlag</th>' +
      '</tr></thead><tbody>';
    for(const r of p.rows){
      const pass = r.type === 'passage';
      const cls = r.type === 'start' || r.type === 'slut' ? 'endpoint-row' : pass ? '' : 'stop-row';
      let diffCls = '';
      if(r.legDiff != null && Math.abs(r.legDiff) > tol) diffCls = r.legDiff > 0 ? ' change-up' : ' change-down';
      const note = r.type === 'start' ? '' : 'gång ' + (r.need ? r.need.n : 0) +
        (r.few ? ' <span class="few">få mätningar</span>' : '') +
        (r.need && r.need.pattern === '*' ? ' <span class="few">alla mätningar</span>' : '') +
        (r.dwellSource === 'matt' ? ' · uppeh ' + r.dwellN + (r.dwellN < AN.MIN_SAMPLES ? ' <span class="few">få mätningar</span>' : '') : '') +
        (r.dwellSource === 'planerat' ? ' · uppeh planerat' : '');
      html += `<tr class="${cls}">` +
        `<td${pass ? ' class="pass"' : ''}>${esc(r.station)}</td><td>${TT_TYPE_LABELS[r.type]}</td>` +
        `<td class="num">${r.type === 'start' ? '' : fmtClock(r.currentArr)}</td>` +
        `<td class="num">${r.type === 'slut' ? '' : pass ? '<span class="pass">↓</span>' : fmtClock(r.currentDep)}</td>` +
        `<td class="num">${r.type === 'start' ? '' : fmtClock(r.propArr)}</td>` +
        `<td class="num">${r.type === 'slut' ? '' : pass ? '<span class="pass">↓</span>' : fmtClock(r.propDep)}</td>` +
        `<td class="num">${r.type === 'start' ? '' : fmtMin(r.plannedLeg, 0)}</td>` +
        `<td class="num">${r.type === 'start' ? '' : fmtMin(r.legRounded, 0)}</td>` +
        `<td class="num${diffCls}">${r.legDiff == null ? '' : fmtSigned(r.legDiff, 0)}</td>` +
        `<td class="num">${r.type === 'stopp' ? fmtMin(r.plannedDwell, 0) : ''}</td>` +
        `<td class="num">${r.type === 'stopp' ? fmtMin(r.dwellValue) : ''}</td>` +
        `<td style="font-size:.75rem;color:var(--mut)">${note}</td></tr>`;
    }
    html += '</tbody></table></div>';
    if(p.totalProposed != null){
      html += `<p class="tt-note"><strong>Restid nu ${p.totalCurrent == null ? '–' : p.totalCurrent} min · förslag ${p.totalProposed} min</strong> (exakt ${fmtMin(p.totalExact)} min)</p>`;
    }
    if(p.missing.length){
      html += `<p class="tt-note">Saknar mätningar: ${esc(p.missing.join(', '))}. Tiderna efter det kan inte räknas fram.</p>`;
    }
    html += '<p class="meta">Förslaget utgår från tågets nuvarande avgång från första stationen och tågets egna stopp. Gångtiderna är vad sträckorna tar för alla tåg i urvalet (vald tidsbas); uppehållen är tågets egna, utan väntan på tidtabellen – finns inga mätningar används planerat uppehåll. Klockslagen är exakta tider avrundade till hela minuter. Förslaget tar inte hänsyn till möten och anslutningar.</p>';
    document.getElementById('ttResult').innerHTML = html;
  }

  function ttMeta(p){
    const meta = [
      ['Tåg', p.train],
      ['Sträcka', p.route[0] + ' → ' + p.route[p.route.length - 1]],
      ['Bygger på', `${p.runCount} körningar av tåget; sträckornas tid på alla tåg i urvalet`],
      ['Period', periodText(p.period)],
      ['Urval', describeFilter(tState && tState.route ? 'Sträcka: ' + tState.route : '')],
      ['Tidsbas', BASIS_LABELS[p.basis]]
    ];
    if(p.missing.length) meta.push(['Saknar mätningar', p.missing.join(', ')]);
    meta.push(['Skapad', nowText()]);
    return meta;
  }

  // Klockslag som TT:MM och skillnader som tal, så att Excel aldrig läser "+11" som 11
  function exportTimetableCsv(){
    const p = lastTimetable;
    if(!p) return null;
    const rows = p.rows.map(r => [
      r.station, TT_TYPE_LABELS[r.type],
      r.type === 'start' ? '' : fmtClock(r.currentArr),
      r.type === 'slut' ? '' : fmtClock(r.currentDep),
      r.type === 'start' ? '' : fmtClock(r.propArr),
      r.type === 'slut' ? '' : fmtClock(r.propDep),
      r.plannedLeg, r.legRounded, r.legDiff,
      r.type === 'stopp' ? r.plannedDwell : null,
      r.type === 'stopp' ? r.dwellValue : null,
      r.type === 'start' ? null : (r.need ? r.need.n : 0),
      r.type === 'stopp' ? (r.dwellSource === 'planerat' ? 'planerat' : r.dwellN) : null
    ]);
    rows.push(['Restid (min)', '', '', '', '', '', p.totalCurrent, p.totalProposed,
      p.totalCurrent != null && p.totalProposed != null ? p.totalProposed - p.totalCurrent : null, null, null, null, null]);
    const text = AN.csvDocument(TIMETABLE_TITLE, ttMeta(p), [{
      header: ['Station', 'Typ', 'Ankomst nu', 'Avgång nu', 'Ankomst förslag', 'Avgång förslag', 'Gångtid nu (min)',
        'Gångtid förslag (min)', 'Skillnad (min)', 'Uppehåll nu (min)', 'Uppehåll förslag (min)', 'Underlag gångtid', 'Underlag uppehåll'],
      rows
    }]);
    downloadText('tidtabell_' + safeFilePart(p.train) + '_' + AN.localDate(new Date()) + '.csv', text);
    return text;
  }

  function printTimetable(){
    if(lastTimetable) printReport('ttReport', timetableTitle(lastTimetable), ttMeta(lastTimetable));
  }

  // Knappen i tågkortet: visa tågets tidtabellsförslag
  function openProposal(train){
    ttTrainChoice = String(train || '');
    renderTimetable();
    document.querySelector('.tab[data-tab="timetable"]').click();
  }


```

I `Analys.html`, ersätt:

```js
    }else if(active.id === 'tabAgainst'){
      if(againstState && againstState.timetableRuns) preparePrint('againstReport', AGAINST_TITLE, againstMeta(againstState));
      else preparePrint('againstReport', AGAINST_TITLE, [['Urval', describeFilter()], ['Resultat', 'Inga körningar med tidtabellstider i urvalet.']]);
    }else if(active.id === 'tabTimetable'){
      if(lastTimetable) preparePrint('ttReport', timetableTitle(lastTimetable), ttMeta(lastTimetable));
      else document.querySelector('#ttReport .print-header').innerHTML = '';
    }
```

med:

```js
    }else if(active.id === 'tabTimetable'){
      if(lastTimetable) preparePrint('ttReport', timetableTitle(lastTimetable), ttMeta(lastTimetable));
      else preparePrint('ttReport', TIMETABLE_TITLE, [['Urval', describeFilter()], ['Resultat', 'Inga tåg med tidtabell i urvalet.']]);
    }
```

I `Analys.html`, ersätt:

```js
      exportAgainstCsv,
      prepareAgainstPrint: () => againstState && preparePrint('againstReport', AGAINST_TITLE, againstMeta(againstState)),
      exportTimetableCsv,
```

med:

```js
      setTimetableTrain(train){ ttTrainChoice = String(train); renderTimetable(); },
      exportTimetableCsv,
```

- [ ] **Step 4: Ta bort testerna av Mot tidtabell och det gamla förslaget**

I `tests/replay.html`, ta bort allt från och med raden

```js
// ── Analys mot tidtabell: fliken Mot tidtabell ──
```

till (men inte med) raden

```js
// ── Analys per tåg ──
```

- [ ] **Step 5: Kör webbläsartesterna och kontrollera att inget gammalt finns kvar**

Run: `node tests/run-browser-tests.mjs` och `grep -nE "stationLabel|summarizeSegments|summarizeStations|proposeTimetable|againstState|AGAINST_TITLE|ttChoices|currentRuns|AN\.mode" Analys.html`
Expected: 31 lyckades, 0 misslyckades; grep skriver inget.

- [ ] **Step 6: Ta bort de gamla funktionerna och deras tester i modulen**

I `railtimer-analys.js`, ersätt:

```js
/* RailTimer – analys av mätningar mot tidtabellen (avvikelser, väntan, tidtabellsförslag, export).
```

med:

```js
/* RailTimer – analys av mätningar mot tidtabellen (per tåg, vad sträckorna tar, tidtabellsförslag, export).
```

I `railtimer-analys.js`, ersätt:

```js
  const MIN_SAMPLES = 3;         // färre mätningar med tidtabell ger bedömningen "För få mätningar"
```

med:

```js
  const MIN_SAMPLES = 3;         // färre mätningar av vad sträckan tar ger bedömningen "För få mätningar"
```

I `railtimer-analys.js`, ta bort allt från och med raden

```js
  // Ankomst, avgång, uppehåll och väntan per station; opts.stationType begränsar till 'stopp' eller 'passage'
```

till (men inte med) raden

```js
  // ── Statistik ──
```

I `railtimer-analys.js`, ta bort allt från och med raden

```js
  // Vanligaste värdet (på hela sekunder); vid lika antal det minsta
```

till (men inte med) raden

```js
  function groupBy(list, key) {
```

I `railtimer-analys.js`, ta bort allt från och med raden

```js
  // ── Sammanställningar ──
```

till (men inte med) raden

```js
  // ── Riktning och tidtabellsförslag ──
```

I `railtimer-analys.js`, ersätt:

```js
  // ── Riktning och tidtabellsförslag ──
```

med:

```js
  // ── Riktning ──
```

I `railtimer-analys.js`, ta bort allt från och med raden

```js
  /* Förslag till tidtabell från `from` till `to`, bara den riktningen.
```

till (men inte med) raden

```js
  // ── Analys per tåg ──
```

I `railtimer-analys.js`, ersätt:

```js
    stopType, plannedType, PATTERN_LABELS, classify, segmentObservations, stationObservations, stationLabel,
    segmentNeeds, stationTimes, summarizeTrains, segmentPlans, proposeTrainTimetable,
    stats, mode, summarizeSegments, summarizeStations,
    directedRuns, sliceRuns, proposeTimetable,
```

med:

```js
    stopType, plannedType, PATTERN_LABELS, classify, segmentObservations,
    segmentNeeds, stationTimes, summarizeTrains, segmentPlans, proposeTrainTimetable,
    stats, directedRuns, sliceRuns,
```

I `tests/railtimer-analys.test.js`, ta bort allt från och med raden

```js
test('stationObservations: avvikelser, väntan vid tidig ankomst och riktning', () => {
```

till (men inte med) raden

```js
// ── Export ──
```

- [ ] **Step 7: Kör hela sviten**

Run: `node --test "tests/*.test.js"`, `node tests/run-browser-tests.mjs` och `grep -nE "stationObservations|summarizeSegments|summarizeStations|proposeTimetable|countCategories|function mode" railtimer-analys.js tests/railtimer-analys.test.js`
Expected: 68 Node-tester lyckas; 31 lyckades, 0 misslyckades; grep skriver inget.

- [ ] **Step 8: Committa**

```bash
git add Analys.html railtimer-analys.js tests/replay.html tests/railtimer-analys.test.js
git commit -m "Analysverktyget: Tidtabell föreslår tidtabell per tåg; Mot tidtabell och väntan per station tas bort

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Bilder och dokumentation

**Files:**
- Modify: `tests/replay.html` (`prepareShot`), `tests/run-browser-tests.mjs` (kommentar) och `CLAUDE.md`
- Ta bort lokalt: `tests/screenshots/mot-tidtabell.png` och `tests/screenshots/mot-tidtabell-utskrift.png`. Mappen är git-ignorerad.

**Interfaces:**
- Consumes (Task 4–6): `trainRuns()` och testkrokarna `showTab`, `showTrain`, `prepareTrainsPrint` och `setTimetableTrain`.
- Produces: bilderna `--shot=per-tag`, `--shot=stracker`, `--shot=tidtabell` och `--shot=per-tag-utskrift`, och ett avsnitt i `CLAUDE.md`.

- [ ] **Step 1: Byt bilderna i prepareShot**

I `tests/replay.html`, ersätt:

```js
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

med:

```js
  } else if (name === 'per-tag' || name === 'per-tag-utskrift') {
    const frame = document.getElementById('app');
    frame.style.width = '1200px';   // analysverktyget används främst på dator
    frame.style.height = '2200px';
    const w = await loadAnalysWith(trainRuns());
    w.__analys.showTab('trains');
    w.__analys.showTrain('3344');
    if (name.endsWith('-utskrift')) w.__analys.prepareTrainsPrint();
  } else if (name === 'stracker') {
    const frame = document.getElementById('app');
    frame.style.width = '1200px';
    frame.style.height = '1500px';
    const w = await loadAnalysWith(trainRuns());
    w.__analys.showTab('segments');
    w.document.querySelector('#segmentsTable tbody tr').click();
  } else if (name === 'tidtabell') {
    const frame = document.getElementById('app');
    frame.style.width = '1200px';
    frame.style.height = '1500px';
    const w = await loadAnalysWith(trainRuns());
    w.__analys.setTimetableTrain('3346');
    w.__analys.showTab('timetable');
  } else {
```

I `tests/run-browser-tests.mjs`, ersätt:

```js
//   node tests/run-browser-tests.mjs --shot=mot-tidtabell    analysverktyget i datorstorlek (även --shot=tidtabell);
//                                                          --shot=mot-tidtabell-utskrift visar utskriften (PDF)
```

med:

```js
//   node tests/run-browser-tests.mjs --shot=per-tag          analysverktyget i datorstorlek (även --shot=stracker och
//                                                          --shot=tidtabell); --shot=per-tag-utskrift visar utskriften (PDF)
```

- [ ] **Step 2: Ta bilderna och granska dem**

Run: `node tests/run-browser-tests.mjs --shot=per-tag`, `node tests/run-browser-tests.mjs --shot=stracker`, `node tests/run-browser-tests.mjs --shot=tidtabell` och `node tests/run-browser-tests.mjs --shot=per-tag-utskrift`

Expected: fyra rader "Bild sparad: …". Öppna bilderna och kontrollera:
- **`per-tag.png`:** listan med 3344 och 3346, och tågkortet för 3344 med tre sträckor, en summarad, två uppehåll och ett tillfälle i Källby.
- **`stracker.png`:** Filsbäck → Källby först med "Snål och generös" och två rader planerad tid, samt mätningarna under tabellen.
- **`tidtabell.png`:** förslaget för 3346 med 10:00–10:12 och restid 10 mot 12 min.
- **`per-tag-utskrift.png`:** utskriftshuvudet med rubrik, Bygger på, Period, Urval, Tolerans, Tåg och Skapad. Formulär och knappar ska inte synas.

- [ ] **Step 3: Ta bort de gamla bilderna av Mot tidtabell**

Run: `rm -f tests/screenshots/mot-tidtabell.png tests/screenshots/mot-tidtabell-utskrift.png` och `ls tests/screenshots`
Expected: `per-tag.png`, `per-tag-utskrift.png`, `stracker.png` och `tidtabell.png` finns, tillsammans med appens bilder (`installningar`, `avbrott`, `rapport` om de tagits). Inga `mot-tidtabell*.png` finns kvar.

- [ ] **Step 4: Uppdatera CLAUDE.md**

I `CLAUDE.md`, ersätt:

```markdown
och bilder i datorstorlek tas med `--shot=mot-tidtabell|tidtabell|mot-tidtabell-utskrift`.
```

med:

```markdown
och bilder i datorstorlek tas med `--shot=per-tag|stracker|tidtabell|per-tag-utskrift` (se 2026-10-15d).
```

Lägg till sist i `CLAUDE.md`:

```markdown

## Uppdatering (2026-10-15d): analys per tåg (Analys.html)

Spec: `docs/superpowers/specs/2026-10-15-analys-per-tag-design.md` · Plan: `docs/superpowers/plans/2026-10-15-analys-per-tag.md`

André 2026-10-15: väntan vid en station är ointressant, eftersom den följer tidtabellen. Det intressanta är tågen. Varje tåg har sin egen tidtabell, och samma sträcka kan ha olika planerad gångtid för olika tåg.

### Flikarna
- **Per tåg** är förvald och ersätter Mot tidtabell. Varje tåg har en rad med körningar, avvikelse vid start och slut, summerad marginal och antal gånger tåget tappade tid.
  - Tågkortet visar varje sträcka mot vad sträckan tar, uppehållen och gångerna tåget tappade tid, med datum, veckodag och klockslag.
  - Resandeantal finns inte i mätningarna.
- **Sträckor** visar vad varje sträcka tar och planerad tid per tåg, med marginal. *Snål och generös* betyder att olika tåg har för lite respektive för mycket tid på samma sträcka.
- **Tidtabell** ger förslag per tåg i stället för per riktning. Förslaget bygger på tågets egen tidtabell, vad sträckorna tar och tågets egna uppehåll utan väntan. Möten och anslutningar ingår inte.

### Begrepp
- **Vad sträckan tar** (`segmentNeeds`, `needFor`) är medianen för alla tåg i urvalet som stannade och passerade som tidtabellen säger, även körningar utan tidtabell.
  - Med färre än 3 sådana mätningar används alla mätningar på sträckan, mönstret `*`, som visas som "alla mätningar". Det behövs vid behovsstopp som tåget nästan alltid passerar.
  - Tågnummerfiltret påverkar inte det underlaget.
- **Marginal** = planerad gångtid − vad sträckan tar.
- **Tappad tid** vid en station = avgångsavvikelse − max(ankomstavvikelse, 0). Vid första stationen är tappad tid avgångsavvikelsen, typen *Avgång från start*.
- **Klockslag** är minuter efter midnatt på körningens startdag. De räknas på klocka och kalenderdag (`clockMinutes`), så att bytet till vintertid inte flyttar tiderna.

### Borttaget
- Mot tidtabell och väntan per station.
- Bedömningarna Tidig – väntan, Tidig, Sen ankomst, Sen avgång och I tid.
- Modulens `stationObservations`, `summarizeSegments`, `summarizeStations`, `proposeTimetable` och `mode`.

### Tester
- `node --test "tests/*.test.js"` och `node tests/run-browser-tests.mjs analys`.
- Bilder tas med `--shot=per-tag|stracker|tidtabell|per-tag-utskrift`.
```

- [ ] **Step 5: Kör hela sviten**

Run: `node --test "tests/*.test.js"` och `node tests/run-browser-tests.mjs`
Expected: 68 Node-tester lyckas; 31 lyckades, 0 misslyckades.

- [ ] **Step 6: Committa**

```bash
git add tests/replay.html tests/run-browser-tests.mjs CLAUDE.md
git commit -m "Bilder av Per tåg, Sträckor och Tidtabell, och dokumentation av analys per tåg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
