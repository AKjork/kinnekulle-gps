/* RailTimer – analys av mätningar mot tidtabellen (per tåg, vad sträckorna tar, tidtabellsförslag, export).
   Rena funktioner utan beroenden. Används av Analys.html och testas med node --test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RailTimerAnalys = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_TOLERANCE = 1;   // minuter: inom ±1 min räknas som i tid, som i appen
  const MIN_SAMPLES = 3;         // färre mätningar av vad sträckan tar ger bedömningen "För få mätningar"

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

  // Minuter efter midnatt den dag `base` har (lokal tid). Räknas på kalenderdag och klockslag,
  // så att bytet mellan sommar- och vintertid inte flyttar tiderna.
  function clockMinutes(v, base) {
    const d = toDate(v);
    if (!d) return null;
    const b = toDate(base) || d;
    const days = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / 86400000);
    return days * 1440 + d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
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

  /* Körningen gäller tågnumret: operativt (trainNumber, OTN) eller annonserat (advertisedTrainNumber, ATN, sparas
     sedan 2026-11-25zg). Föraren skriver OTN, tågvärden ATN, till exempel 23349 och 3349. */
  function runTrainMatches(run, train) {
    const t = String(train == null ? '' : train).trim();
    if (!t) return true;
    return String(run.trainNumber || '').trim() === t || String(run.advertisedTrainNumber || '').trim() === t;
  }

  // filter: { vehicle, train, dateFrom, dateTo, timeOfDay, dayType } – tomt värde betyder alla
  function runMatches(run, filter) {
    const f = filter || {};
    if (!run || run.aborted) return false;
    if (f.vehicle && run.vehicleType !== f.vehicle) return false;
    if (f.train && !runTrainMatches(run, f.train)) return false;
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

  // Avvikelse i minuter → 'sen' (> +tol), 'tidig' (< −tol) eller 'itid'. Exakt ±tol är i tid.
  function classify(dev, tol) {
    if (dev == null || !isFinite(dev)) return null;
    const t = tol == null ? DEFAULT_TOLERANCE : tol;
    if (dev > t) return 'sen';
    if (dev < -t) return 'tidig';
    return 'itid';
  }

  /* Planerade tider: bara tågorderns tider (driftstid, Trafikverkets LocationDateTimeOTN, fälten operationalArrival och
     operationalDeparture från appversion 2026-11-25f). Körningar före det har bara annonserade tider (scheduledArrival,
     scheduledDeparture), och de stämmer inte med tågordern:
       - Vid de flesta mellanstationer är annonserad ankomst samma minut som avgången. Tågordern har ankomsten en minut
         tidigare (23349 2026-11-25 Vedum: annonserad 12:01/12:01, tågorder 12:00/12:01). Uppehållet räknades då som
         gångtid. 1 206 av 1 479 mellanstationer i datan 2026-11-25 hade samma annonserade ankomst och avgång.
       - Annonserad avgång kan vara tidigare än tågorderns (Vara: 11:53 mot 11:54).
     Annonserade tider används därför bara för ordning och gruppering (anyPlannedTime), aldrig för jämförelser.
     Passage (inget planerat stopp): en tid gäller för både ankomst och avgång. */
  function plannedArrival(stop) {
    if (!stop) return null;
    return toDate(stop.operationalArrival) || (plannedType(stop) === 'passage' ? toDate(stop.operationalDeparture) : null);
  }
  function plannedDeparture(stop) {
    if (!stop) return null;
    return toDate(stop.operationalDeparture) || (plannedType(stop) === 'passage' ? toDate(stop.operationalArrival) : null);
  }
  function hasOperational(stop) { return !!(stop && (toDate(stop.operationalArrival) || toDate(stop.operationalDeparture))); }
  // Vilken planerad tid som helst (tågorder eller annonserad), avgång före ankomst: bara för att ordna stationer
  function anyPlannedTime(stop) {
    if (!stop) return null;
    return toDate(stop.operationalDeparture) || toDate(stop.operationalArrival) || toDate(stop.scheduledDeparture) || toDate(stop.scheduledArrival);
  }
  function anyPlannedArrivalFirst(stop) {
    if (!stop) return null;
    return toDate(stop.operationalArrival) || toDate(stop.operationalDeparture) || toDate(stop.scheduledArrival) || toDate(stop.scheduledDeparture);
  }

  function minutes(a, b) { return (b - a) / 60000; }

  function runInfo(run) {
    const start = runStart(run);
    return {
      trainNumber: run.trainNumber || '',
      vehicleType: run.vehicleType || '',
      date: localDate(start),
      weekday: start ? start.getDay() : null,
      start: start ? start.toISOString() : null,
      runId: run.id != null ? String(run.id) : ''
    };
  }

  // Gångtid per sträcka mellan intilliggande stationer, med planerad gångtid när tidtabell finns
  // opts.tracks: Map körnings-id → analyzeTrack-resultat. Då får varje mätning hasTrack och unplannedStop
  // (minuter stillastående mellan stationerna, 0 när tåget inte stannade).
  function segmentObservations(runs, opts) {
    const tol = opts && opts.tolerance != null ? opts.tolerance : DEFAULT_TOLERANCE;
    const tracks = (opts && opts.tracks) || null;
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
        const orderAt = pDep || anyPlannedTime(a);
        const deviation = planned != null ? actual - planned : null;
        const tInfo = tracks ? tracks.get(info.runId) : null;
        const legIndex = i + (run.sliceOffset || 0); // index i hela körningen, även när den är avskuren
        const leg = tInfo ? tInfo.legs.find(l => l.index === legIndex) : null;
        out.push(Object.assign({
          key: `${a.name} → ${b.name}`, from: a.name, to: b.name, index: i, legIndex,
          actual, planned, deviation, category: classify(deviation, tol),
          fromType: stopType(a), toType: stopType(b),
          plannedPattern: patternOf(a, b, plannedType),
          actualPattern: patternOf(a, b, stopType),
          order: orderAt ? clockMinutes(orderAt, info.start) : null,
          hasTrack: !!leg,
          unplannedStop: leg ? leg.stops.reduce((t, s) => t + s.minutes, 0) : null
        }, info));
      }
    }
    return out;
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
    if (!s.length) return { n: 0, median: null, p90: null, mean: null, p10: null };
    return { n: s.length, median: quantileSorted(s, 0.5), p90: quantileSorted(s, 0.9), mean: s.reduce((a, b) => a + b, 0) / s.length, p10: quantileSorted(s, 0.1) };
  }

  function groupBy(list, key) {
    const groups = new Map();
    for (const o of list || []) {
      if (!groups.has(o[key])) groups.set(o[key], []);
      groups.get(o[key]).push(o);
    }
    return groups;
  }

  // ── Riktning ──

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

  // Körningarna avskurna till sträckan from → to (bara den riktningen). cutStart: körningen började före `from`,
  // så första stationen har en mätt ankomst och är en mellanstation (inte körningens start).
  function sliceRuns(runs, from, to) {
    return directedRuns(runs, from, to).list.map(({ run, i, j }) => Object.assign({}, run, { stops: run.stops.slice(i, j + 1), cutStart: i > 0, sliceOffset: (run.sliceOffset || 0) + i }));
  }

  // ── Analys per tåg ──

  // Har körningen tågorderns tider? Bara sådana körningar jämförs mot tidtabellen (se plannedArrival).
  function hasTimetable(run) {
    return ((run && run.stops) || []).some(hasOperational);
  }

  // Körning med bara annonserade tider (före appversion 2026-11-25f): räknas bara i det som mäts, inte mot tidtabellen
  function hasAdvertisedOnly(run) {
    const stops = (run && run.stops) || [];
    return !stops.some(hasOperational) && stops.some(s => s.scheduledArrival || s.scheduledDeparture);
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
     (även körningar utan tidtabell), plus en rad per sträcka med alla mätningar (mönster '*').
     opts.skipUnplanned: mätningar där GPS-spåret visar att tåget stannade mellan stationerna räknas inte
     (signal, möte på linjen) – de säger inte vad sträckan tar. skipped = antal som inte räknades. */
  function segmentNeeds(obs, opts) {
    const skip = !!(opts && opts.skipUnplanned);
    const groups = new Map();
    const add = (o, pattern) => {
      const key = `${o.key}|${pattern}`;
      if (!groups.has(key)) groups.set(key, { key, segment: o.key, from: o.from, to: o.to, pattern, values: [] });
      groups.get(key).values.push(o.actual);
    };
    const skipped = new Map();
    for (const o of obs || []) {
      if (skip && o.unplannedStop > 0) {
        for (const p of [o.actualPattern, '*']) skipped.set(`${o.key}|${p}`, (skipped.get(`${o.key}|${p}`) || 0) + 1);
        continue;
      }
      add(o, o.actualPattern);
      add(o, '*');
    }
    return Array.from(groups.values()).map(g => {
      const s = stats(g.values);
      return { key: g.key, segment: g.segment, from: g.from, to: g.to, pattern: g.pattern, n: s.n, median: s.median, p90: s.p90, mean: s.mean, skipped: skipped.get(g.key) || 0 };
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
     Första stationen saknar mätt ankomst: där är tappad tid avgångsavvikelsen (typ 'start'). En körning som skurits
     av vid Station 1 (cutStart) har mätt ankomst där, så första stationen räknas då som mellanstation.
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
        if (k > 0 || run.cutStart) {
          const aArr = toDate(s.actualArrival);
          const pArr = plannedArrival(s);
          if (!aArr || !pArr) continue;
          type = plannedType(s);
          arrivalDev = minutes(pArr, aArr);
          lost = departureDev - Math.max(arrivalDev, 0);
          dwell = aDep >= aArr ? minutes(aArr, aDep) : null;
        }
        // Planerat uppehåll enligt tågordern (bara när ankomsten finns där)
        const sArr = toDate(s.operationalArrival);
        const sDep = toDate(s.operationalDeparture);
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

  // Samma tågnummer med mer än så här (minuter) annan planerad tid vid samma station är en egen tidtabell,
  // t.ex. söndagens 13346 som går 92 min senare än vardagarnas
  const VARIANT_GAP = 10;

  function hhmm(min) {
    const t = ((Math.round(min) % 1440) + 1440) % 1440;
    return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  }

  // Planerade klockslag per station i en körning: { arr, dep }
  function plannedClockMap(run) {
    const base = runStart(run);
    const m = new Map();
    for (const s of run.stops || []) {
      m.set(s.name, { arr: clockMinutes(plannedArrival(s), base), dep: clockMinutes(plannedDeparture(s), base) });
    }
    return m;
  }

  // Samma tidtabell: planerade tider vid gemensamma stationer skiljer högst VARIANT_GAP. Har den ena körningen bara
  // ankomst och den andra bara avgång (den ena slutar där den andra börjar) ska avgången komma efter ankomsten,
  // inom en timme.
  function sameTimetable(a, b) {
    for (const [name, x] of a) {
      const y = b.get(name);
      if (!y) continue;
      let compared = false;
      for (const f of ['arr', 'dep']) {
        if (x[f] != null && y[f] != null) {
          compared = true;
          if (Math.abs(x[f] - y[f]) > VARIANT_GAP) return false;
        }
      }
      if (!compared) {
        const arr = x.arr != null ? x.arr : y.arr;
        const dep = x.dep != null ? x.dep : y.dep;
        if (arr != null && dep != null && (dep < arr - VARIANT_GAP || dep > arr + 60)) return false;
      }
    }
    return true;
  }

  function dayLabel(runs) {
    const days = runs.map(r => { const d = runStart(r); return d ? d.getDay() : null; }).filter(d => d != null);
    const all = test => days.length > 0 && days.every(test);
    if (all(d => d >= 1 && d <= 5)) return 'vardag';
    if (all(d => d === 6)) return 'lördag';
    if (all(d => d === 0)) return 'söndag';
    if (all(d => d === 0 || d === 6)) return 'helg';
    return 'blandat';
  }

  /* Tågnummer → tidtabeller. Samma tågnummer kan köra olika tidtabeller (t.ex. vardag och söndag): körningar vars
     planerade tider vid samma station skiljer mer än VARIANT_GAP blir egna. Ett tåg med en tidtabell har tågnumret
     som nyckel och namn; flera får "<tåg> <dagar>", vid behov med första avgångens klockslag. */
  function trainVariants(runs) {
    const byTrain = new Map();
    for (const run of runs || []) {
      const train = String(run.trainNumber || '').trim();
      if (!train || !hasTimetable(run)) continue;
      if (!byTrain.has(train)) byTrain.set(train, []);
      byTrain.get(train).push(run);
    }
    const startOf = r => { const d = runStart(r); return d ? d.getTime() : 0; };
    const out = [];
    for (const [train, list] of byTrain) {
      const groups = [];
      for (const run of list.slice().sort((a, b) => startOf(a) - startOf(b))) {
        const clocks = plannedClockMap(run);
        const g = groups.find(x => x.clocks.every(c => sameTimetable(c, clocks)));
        if (g) {
          g.runs.push(run);
          g.clocks.push(clocks);
        } else {
          groups.push({ runs: [run], clocks: [clocks] });
        }
      }
      const variants = groups.map(g => ({ runs: g.runs, label: groups.length > 1 ? `${train} ${dayLabel(g.runs)}` : train, time: '' }));
      for (const v of variants) {
        if (variants.filter(x => x.label === v.label).length > 1) {
          const first = v.runs.map(r => clockMinutes(plannedDeparture(r.stops[0]), runStart(r))).filter(c => c != null);
          v.time = first.length ? hhmm(Math.min(...first)) : '';
        }
      }
      for (const v of variants) {
        const label = v.time ? `${v.label} ${v.time}` : v.label;
        out.push({ key: label, train, label, runs: v.runs, runIds: v.runs.map(r => String(r.id)) });
      }
    }
    return out;
  }

  // Tågets stationer i ordning efter planerat klockslag (median), så att partiella körningar blir en rutt
  function routeOf(runs) {
    const clocks = new Map();
    for (const run of runs || []) {
      const base = runStart(run);
      for (const s of run.stops || []) {
        const c = clockMinutes(anyPlannedArrivalFirst(s), base);
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

  function trainRow(v, runCount, needsByKey, tol, stationType) {
    const tRuns = v.runs;
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
    const stopEvents = events.filter(e => e.type !== 'start');

    const endDelay = stats(tRuns.map(run => {
      const last = run.stops[run.stops.length - 1];
      const a = toDate(last.actualArrival);
      const p = plannedArrival(last);
      return a && p ? minutes(p, a) : null;
    }));

    // Tid över: planerad restid − vad tåget behöver (sträckornas tid och tågets egna uppehåll utan väntan, median).
    // Gångtidsmarginalen ovan räknar inte med uppehållen, som ofta ryms i den planerade gångtiden.
    const prop = proposeFor(tRuns, needsByKey, 'median');
    const travel = {
      planned: prop.error ? null : prop.totalCurrent,
      needed: prop.error ? null : prop.totalExact,
      spare: !prop.error && prop.totalCurrent != null && prop.totalExact != null ? prop.totalCurrent - prop.totalExact : null
    };

    return {
      train: v.train, key: v.key, label: v.label, runCount, timetableRuns: tRuns.length, period: period(tRuns),
      route, routeLabel: route.length ? `${route[0]} → ${route[route.length - 1]}` : '',
      startDelay: stats(times.filter(t => t.index === 0).map(t => t.departureDev)),
      endDelay, segments, margin, travel, dwells, events,
      // Listan räknar bara uppehåll och stopp vid passage: sen avgång från första stationen har okänd orsak
      // (t.ex. sent inkommande tåg) och visas i Avgång start och i tågkortet
      eventCount: stopEvents.length,
      lostMax: stopEvents.length ? Math.max(...stopEvents.map(e => e.lost)) : null
    };
  }

  /* Per tåg: tågets körningar med tidtabell jämförs med tågets egen tidtabell och med vad sträckorna tar, en rad per
     tidtabell (trainVariants). opts: { tolerance, stationType }. Körningar utan tågnummer räknas inte; tågnummer
     utan någon körning med tidtabell räknas i withoutTimetable. Flest körningar först, sedan flest tillfällen. */
  function summarizeTrains(runs, needs, opts) {
    const tol = opts && opts.tolerance != null ? opts.tolerance : DEFAULT_TOLERANCE;
    const stationType = (opts && opts.stationType) || '';
    const needsByKey = needMap(needs);
    const counts = new Map();
    for (const run of runs || []) {
      const train = String(run.trainNumber || '').trim();
      if (train) counts.set(train, (counts.get(train) || 0) + 1);
    }
    const variants = trainVariants(runs);
    const perTrain = new Map();
    for (const v of variants) perTrain.set(v.train, (perTrain.get(v.train) || 0) + 1);
    const withoutTimetable = { trains: 0, runs: 0 };
    for (const [train, n] of counts) {
      if (perTrain.has(train)) continue;
      withoutTimetable.trains += 1;
      withoutTimetable.runs += n;
    }
    // Körningar totalt: med en tidtabell alla tågets körningar (även utan tidtabell), med flera bara tidtabellens
    const rows = variants.map(v => trainRow(v, perTrain.get(v.train) > 1 ? v.runs.length : counts.get(v.train), needsByKey, tol, stationType));
    rows.sort((a, b) => b.timetableRuns - a.timetableRuns || b.eventCount - a.eventCount
      || compareTrain(a.train, b.train) || a.label.localeCompare(b.label));
    return { rows, withoutTimetable };
  }

  /* Sträckor: vad sträckan tar och vilken planerad gångtid varje tåg har där, en rad per sträcka och planerat
     mönster. opts: { tolerance, stationType ('stopp' = bara SS, 'passage' = mönster med P), train (bara sträckor
     som tåget kör, med alla tågs tider), labels (Map körnings-id → tidtabellens namn från trainVariants) }. */
  function segmentPlans(obs, needs, opts) {
    const tol = opts && opts.tolerance != null ? opts.tolerance : DEFAULT_TOLERANCE;
    const stationType = (opts && opts.stationType) || '';
    // train: ett tågnummer eller flera (OTN för ett ATN, se runTrainMatches)
    const trains = opts && opts.train ? new Set([].concat(opts.train instanceof Set ? Array.from(opts.train) : opts.train).map(String)) : null;
    const labels = (opts && opts.labels) || null;
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
      if (trains && !list.some(o => trains.has(String(o.trainNumber)))) continue;
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
          trains: Array.from(new Set(items.map(o => (labels && labels.get(String(o.runId))) || String(o.trainNumber || '')))).sort(compareTrain),
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

  /* Tidtabellsförslag för ett tåg: tågets egna stopp och nuvarande tider, sträckornas tid (alla tåg, samma
     planerade mönster) och tågets egna uppehåll utan väntan. opts: { basis: 'median' | 'p90' | 'mean' }.
     Klockslag är minuter efter midnatt; exakta tider läggs ihop och varje klockslag avrundas till hela minuter,
     så att avrundningsfelen inte växer. Möten och anslutningar ingår inte. */
  function proposeTrainTimetable(runs, needs, train, opts) {
    const basis = (opts && opts.basis) || 'median';
    // `train` är tidtabellens nyckel från trainVariants: tågnumret, eller "<tåg> <dagar>" när tåget har flera
    const key = String(train == null ? '' : train).trim();
    const v = trainVariants(runs).find(x => x.key === key);
    // legSource 'egna': tågets egna gångtider där det har minst MIN_SAMPLES mätningar med samma stoppmönster, annars alla tågs
    const legSource = opts && opts.legSource === 'egna' ? 'egna' : 'alla';
    const own = v && legSource === 'egna' ? needMap(segmentNeeds(segmentObservations(v.runs, {}))) : null;
    const head = { train: v ? v.train : key, key, label: v ? v.label : key, basis, legSource };
    return Object.assign(head, proposeFor(v ? v.runs : [], needMap(needs), basis, own));
  }

  // Förslaget för en tidtabells körningar (se proposeTrainTimetable); ger också Tid över i Per tåg.
  // ownNeedsByKey: tågets egna gångtider (valfritt), som används där de har minst MIN_SAMPLES mätningar med det planerade
  // stoppmönstret – tågets mätningar med annat mönster (t.ex. passage vid ett behovsstopp) blandas inte in.
  function proposeFor(tRuns, needsByKey, basis, ownNeedsByKey) {
    const route = routeOf(tRuns);
    if (route.length < 2) return { error: 'inga-korningar', route: [], rows: [], missing: [], runCount: tRuns.length };
    const startOf = r => { const d = runStart(r); return d ? d.getTime() : 0; };
    const byLatest = tRuns.slice().sort((a, b) => startOf(b) - startOf(a));

    // Nuvarande tider per station, från den senaste körning som har värdet; passagepunkter får sin passagetid
    const current = new Map();
    for (const run of byLatest) {
      const base = runStart(run);
      for (const s of run.stops || []) {
        if (!current.has(s.name)) current.set(s.name, { arr: null, dep: null, type: plannedType(s) });
        const c = current.get(s.name);
        const pa = plannedArrival(s);
        const pd = plannedDeparture(s);
        if (c.arr == null && pa) c.arr = clockMinutes(pa, base);
        if (c.dep == null && pd) c.dep = clockMinutes(pd, base);
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
        const pa = plannedArrival(s);
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
        plannedLeg: null, need: null, legSource: null, legValue: null, legRounded: null, legDiff: null, few: false,
        plannedDwell: null, dwellValue: null, dwellN: 0, dwellSource: null
      };
      if (isFirst) {
        row.propDep = anchor;
        return row;
      }
      const prevName = route[i - 1];
      const prev = current.get(prevName);
      const pattern = (prev.type === 'stopp' ? 'S' : 'P') + (c.type === 'stopp' ? 'S' : 'P');
      const own = ownNeedsByKey ? ownNeedsByKey.get(`${prevName} → ${name}|${pattern}`) : null;
      const useOwn = !!own && own.n >= MIN_SAMPLES;
      row.need = useOwn ? own : needFor(needsByKey, `${prevName} → ${name}`, pattern);
      row.legSource = useOwn ? 'egna' : 'alla';
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
      route, rows, missing,
      runCount: tRuns.length, period: period(tRuns),
      totalCurrent: rows[0].currentDep != null && last.currentArr != null ? last.currentArr - rows[0].currentDep : null,
      totalProposed: known ? last.propArr - anchor : null,
      totalExact: known ? cum : null
    };
  }

  // ── Nytt tåg ──

  // Ett uppehåll räknas som vanligt (resandeutbyte) när det planerade uppehållet är högst så här många minuter;
  // längre planerade uppehåll är oftast möten eller vändningar och säger inget om vad ett nytt tåg behöver
  const NORMAL_DWELL = 2;
  // Längsta verkliga uppehåll som räknas vid stopp utan tidtabell; längre är oftast möten eller vändningar
  const MAX_UNTIMED_DWELL = 5;

  /* Rutten för ett nytt tåg från `from` till `to`: först en väg genom körningarnas stationsföljder (bredden först),
     sedan fylls stationer i som någon körning har mellan två intilliggande stationer i vägen. Fungerar även när ingen
     körning har gått hela vägen. null när vägen saknas.
     Körningar åt båda hållen och körningar som saknar mellanstationer (t.ex. utan tågnummer: bara start och slut) ger
     genvägar. Vägen får därför aldrig vända: steget p → u → v förbjuds när någon körning har alla tre och u inte ligger
     mellan p och v – annars kan vägen gå bakåt ett steg och ta en genväg förbi startstationen. */
  function routeBetween(runs, from, to) {
    const lists = (runs || []).map(r => (r.stops || []).map(s => s.name));
    const next = new Map();
    for (const s of lists) {
      for (let i = 0; i < s.length - 1; i++) {
        if (!next.has(s[i])) next.set(s[i], new Set());
        next.get(s[i]).add(s[i + 1]);
      }
    }
    if (!from || !to || from === to || !next.has(from)) return null;
    const positions = lists.map(s => new Map(s.map((n, i) => [n, i])));
    const turns = (p, u, v) => positions.some(pos => {
      const a = pos.get(p);
      const b = pos.get(u);
      const c = pos.get(v);
      return a != null && b != null && c != null && !((a < b && b < c) || (c < b && b < a));
    });
    // Bredden först över steg (u → v), så att varje steg kan prövas mot steget före
    const prev = new Map();
    const queue = [];
    for (const v of next.get(from)) { prev.set(`${from}|${v}`, null); queue.push([from, v]); }
    let goal = null;
    while (queue.length && !goal) {
      const [u, v] = queue.shift();
      if (v === to) { goal = [u, v]; break; }
      for (const w of next.get(v) || []) {
        const key = `${v}|${w}`;
        if (prev.has(key) || w === from || turns(u, v, w)) continue;
        prev.set(key, [u, v]);
        queue.push([v, w]);
      }
    }
    if (!goal) return null;
    let chain = [goal[1]];
    for (let step = goal; step; step = prev.get(`${step[0]}|${step[1]}`)) chain.unshift(step[0]);
    if (new Set(chain).size !== chain.length) return null;
    for (let changed = true; changed;) {
      changed = false;
      const out = [chain[0]];
      for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i];
        const b = chain[i + 1];
        let best = [];
        for (const names of lists) {
          const ia = names.indexOf(a);
          const ib = names.indexOf(b);
          if (ia < 0 || ib <= ia + 1 || ib - ia - 1 <= best.length) continue;
          const mid = names.slice(ia + 1, ib);
          if (!mid.some(n => chain.includes(n) || out.includes(n))) best = mid;
        }
        if (best.length) { out.push(...best); changed = true; }
        out.push(b);
      }
      chain = out;
    }
    return chain;
  }

  /* Tidtabellsförslag för ett nytt tåg från opts.from till opts.to. opts: { from, to, basis, stops: { station: true/false },
     dwells: { station: minuter } }.
     - Stopp där opts.stops säger, annars där tågen oftast stannat mitt på en körning.
     - Gångtider: vad sträckorna tar för alla tåg (needs), med stopp och passage som valt (reserv: alla mätningar).
     - Uppehåll: angivet i opts.dwells, annars vad tåg med vanligt kort planerat uppehåll (högst NORMAL_DWELL) står vid
       stationen, utan väntan på tidtabellen ('matt'), annars verkliga uppehåll vid stopp utan tidtabell (högst
       MAX_UNTIMED_DWELL, 'utan-tidtabell'), annars medianen för vanliga uppehåll vid alla stationer ('schablon' – utan
       tidtabell i urvalet: för alla uppehåll utan tidtabell).
       dwellWaited: hur många av de mätta som kom före planerad avgång och avgick inom avgångsminuten. De väntade in
       avgångstiden, så mätningen visar bara att uppehållet räckte – tåget kan ha behövt kortare tid.
     - Tider i minuter från avgången; exakta tider läggs ihop och varje klockslag avrundas till hela minuter, så att
       felen inte växer. Möten och anslutningar ingår inte. */
  function proposeNewTimetable(runs, needs, opts) {
    const from = opts && opts.from;
    const to = opts && opts.to;
    const basis = (opts && opts.basis) || 'median';
    const chosen = (opts && opts.stops) || {};
    const manual = (opts && opts.dwells) || {};
    const route = routeBetween(runs, from, to);
    if (!route) return { from, to, basis, error: 'ingen-vag', route: [], rows: [], missing: [], runCount: 0 };
    const needsByKey = needMap(needs);

    // Hur ofta tågen stannat och passerat mitt på en körning, vanliga uppehåll och uppehåll utan tidtabell per station
    const counts = new Map();
    const dwells = new Map();
    const untimed = new Map();
    const normalAll = [];
    const untimedAll = [];
    const add = (map, name, value) => { if (!map.has(name)) map.set(name, []); map.get(name).push(value); };
    for (const run of runs || []) {
      const stops = run.stops || [];
      for (let k = 1; k < stops.length - 1; k++) {
        const s = stops[k];
        if (!counts.has(s.name)) counts.set(s.name, { stopp: 0, passage: 0 });
        counts.get(s.name)[stopType(s)] += 1;
        if (stopType(s) !== 'stopp') continue;
        const a = toDate(s.actualArrival);
        const d = toDate(s.actualDeparture);
        if (!a || !d) continue;
        // Tågorderns tider. Körningar utan dem (även de med bara annonserade tider) räknas som stopp utan tidtabell:
        // hela det verkliga uppehållet, som kan innehålla väntan på avgångstiden
        const pa = plannedArrival(s);
        const pd = plannedDeparture(s);
        if (!pa && !pd) {
          const m = minutes(a, d);
          if (m > 0.05 && m <= MAX_UNTIMED_DWELL) { add(untimed, s.name, m); untimedAll.push(m); }
          continue;
        }
        if (!pa || !pd || minutes(pa, pd) > NORMAL_DWELL) continue;
        const begin = pa > a && pa < d ? pa : a;
        const m = minutes(begin, d);
        if (!(m > 0.05 && m < 15)) continue;
        add(dwells, s.name, { m, waited: a < pd && minutes(pd, d) < 1 });
        normalAll.push(m);
      }
    }
    const generic = stats(normalAll.length ? normalAll : untimedAll)[basis];

    const missing = [];
    const rows = [];
    let known = true;
    let cum = 0;
    let prevDep = 0;
    for (let i = 0; i < route.length; i++) {
      const name = route[i];
      const isFirst = i === 0;
      const isLast = i === route.length - 1;
      const c = counts.get(name) || { stopp: 0, passage: 0 };
      const defaultStop = c.stopp > 0 && c.stopp >= c.passage;
      const isStop = isFirst || isLast || (chosen[name] != null ? !!chosen[name] : defaultStop);
      const row = {
        station: name, type: isFirst ? 'start' : isLast ? 'slut' : isStop ? 'stopp' : 'passage',
        stopCount: c.stopp, passCount: c.passage, defaultStop,
        arr: null, dep: null, arrRounded: null, depRounded: null,
        need: null, legValue: null, legRounded: null, few: false,
        dwellValue: null, dwellN: 0, dwellWaited: 0, dwellSource: null
      };
      if (!isFirst) {
        const prev = rows[i - 1];
        const pattern = (prev.type === 'passage' ? 'P' : 'S') + (row.type === 'passage' ? 'P' : 'S');
        row.need = needFor(needsByKey, `${prev.station} → ${name}`, pattern);
        row.legValue = row.need && row.need.n ? row.need[basis] : null;
        row.few = !!row.need && row.need.n < MIN_SAMPLES;
        if (row.legValue == null) {
          missing.push(`${prev.station} → ${name}`);
          known = false;
        }
        if (known) {
          cum += row.legValue;
          row.arr = cum;
          row.arrRounded = Math.round(cum);
          row.legRounded = row.arrRounded - prevDep;
        }
      }
      if (!isLast) {
        if (row.type === 'stopp') {
          const own = dwells.get(name) || [];
          const free = untimed.get(name) || [];
          if (manual[name] != null && manual[name] !== '' && isFinite(manual[name])) {
            row.dwellValue = Number(manual[name]);
            row.dwellSource = 'angivet';
          } else if (own.length) {
            row.dwellValue = stats(own.map(o => o.m))[basis];
            row.dwellSource = 'matt';
            row.dwellN = own.length;
            row.dwellWaited = own.filter(o => o.waited).length;
          } else if (free.length) {
            row.dwellValue = stats(free)[basis];
            row.dwellSource = 'utan-tidtabell';
            row.dwellN = free.length;
          } else if (generic != null) {
            row.dwellValue = generic;
            row.dwellSource = 'schablon';
          } else {
            missing.push(`uppehåll i ${name}`);
            known = false;
          }
        }
        if (known) {
          cum += row.type === 'stopp' ? row.dwellValue : 0;
          row.dep = cum;
          row.depRounded = Math.round(cum);
          prevDep = row.depRounded;
        }
      }
      rows.push(row);
    }
    const pairs = new Set(route.slice(0, -1).map((n, i) => `${n}|${route[i + 1]}`));
    const used = (runs || []).filter(r => (r.stops || []).some((s, k, arr) => k < arr.length - 1 && pairs.has(`${s.name}|${arr[k + 1].name}`)));
    const last = rows[rows.length - 1];
    return {
      from, to, basis, route, rows, missing,
      runCount: used.length, period: period(used), generic,
      totalExact: known ? last.arr : null,
      totalRounded: known ? last.arrRounded : null
    };
  }

  // ── Försening längs linjen ──

  /* Var förseningen uppstår och försvinner i en körning med tidtabell från första till sista stationen:
     slut = start + gångtid + uppehåll (exakt), där
       start    = avgångsavvikelse vid första stationen,
       gångtid  = Σ (verklig − planerad gångtid) per sträcka,
       uppehåll = Σ (verkligt − planerat uppehåll) vid mellanstationerna (passage: planerat 0).
     null när någon tid saknas (t.ex. avbrott) eller körningen är avskuren (cutStart). */
  function delayBreakdown(run) {
    const stops = (run && run.stops) || [];
    if (stops.length < 2 || run.cutStart) return null;
    const t = stops.map(s => ({
      aa: toDate(s.actualArrival), ad: toDate(s.actualDeparture), pa: plannedArrival(s), pd: plannedDeparture(s)
    }));
    const first = t[0];
    const last = t[t.length - 1];
    if (!first.ad || !first.pd || !last.aa || !last.pa) return null;
    let running = 0;
    let dwell = 0;
    for (let i = 0; i < t.length - 1; i++) {
      const a = t[i];
      const b = t[i + 1];
      if (!a.ad || !a.pd || !b.aa || !b.pa) return null;
      running += minutes(a.ad, b.aa) - minutes(a.pd, b.pa);
      if (i + 1 < t.length - 1) {
        if (!b.ad || !b.pd) return null;
        dwell += minutes(b.aa, b.ad) - minutes(b.pa, b.pd);
      }
    }
    return { start: minutes(first.pd, first.ad), running, dwell, end: minutes(last.pa, last.aa) };
  }

  // Medianer av delayBreakdown över körningarna; n = antal hela körningar
  function delayBalance(runs) {
    const list = (runs || []).filter(hasTimetable).map(delayBreakdown).filter(Boolean);
    const pick = k => stats(list.map(b => b[k]));
    return { n: list.length, start: pick('start'), running: pick('running'), dwell: pick('dwell'), end: pick('end'),
      sum: list.reduce((acc, b) => ({ running: acc.running + b.running, dwell: acc.dwell + b.dwell }), { running: 0, dwell: 0 }) };
  }

  /* Avvikelse mot tidtabellen station för station för en tidtabells körningar (trainVariants): per station ankomst-
     och avgångsavvikelse (median, P10, P90, antal). Rutten är tågets (routeOf). Används till diagrammet i Per tåg. */
  function delayProfile(runs) {
    const route = routeOf(runs);
    const per = new Map(route.map(n => [n, { arr: [], dep: [] }]));
    for (const run of runs || []) {
      const stops = run.stops || [];
      stops.forEach((s, k) => {
        const p = per.get(s.name);
        if (!p) return;
        const aa = toDate(s.actualArrival);
        const pa = plannedArrival(s);
        const ad = toDate(s.actualDeparture);
        const pd = plannedDeparture(s);
        if ((k > 0 || run.cutStart) && aa && pa) p.arr.push(minutes(pa, aa));
        if (k < stops.length - 1 && ad && pd) p.dep.push(minutes(pd, ad));
      });
    }
    return {
      route,
      points: route.map(name => ({ station: name, arr: stats(per.get(name).arr), dep: stats(per.get(name).dep) })),
      balance: delayBalance(runs)
    };
  }

  // ── GPS-spår ──

  const STILL_SPEED_MS = 2 / 3.6;    // samma tröskel som appen: under 2 km/h står tåget still
  const MIN_UNPLANNED_S = 10;        // kortare stillastående mellan stationerna räknas inte som stopp
  const STATION_MARGIN_M = 150;      // utanför stationens radie + så här mycket räknas positionen som linjen
  const MAX_TRACK_ACC_M = 50;        // sämre noggrannhet än så hoppas över
  const MERGE_GAP_S = 5;             // två stillaståenden med kort glapp (falsk fart) är samma stopp
  const MERGE_DIST_M = 30;

  function distanceM(a, b) {
    const R = 6371000;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Spårfilens punkter (format 1: fields + points, t_ms från t0) som { t (ms), lat, lon, acc, speed }
  function trackPoints(track) {
    if (!track || !Array.isArray(track.points)) return [];
    const fields = Array.isArray(track.fields) ? track.fields : ['t_ms', 'lat', 'lon', 'acc_m', 'speed_ms', 'heading_deg', 'fixAge_ms'];
    const at = name => fields.indexOf(name);
    const iT = at('t_ms'), iLat = at('lat'), iLon = at('lon'), iAcc = at('acc_m'), iV = at('speed_ms');
    const t0 = toDate(track.t0);
    const base = t0 ? t0.getTime() : 0;
    return track.points.map(p => ({
      t: base + Number(p[iT]), lat: Number(p[iLat]), lon: Number(p[iLon]),
      acc: iAcc >= 0 && p[iAcc] != null ? Number(p[iAcc]) : null,
      speed: iV >= 0 && p[iV] != null ? Number(p[iV]) : null
    })).filter(p => isFinite(p.t) && isFinite(p.lat) && isFinite(p.lon)).sort((a, b) => a.t - b.t);
  }

  /* Ett GPS-spår mot sin körning: per sträcka (avgång A → ankomst B) fartprofilen mot sträckan från avgången och
     stopp mellan stationerna – minst MIN_UNPLANNED_S under 2 km/h, utanför stationernas radie + STATION_MARGIN_M.
     Utan stationskoordinater (äldre körningar) räknas de första och sista 30 s som station. */
  function analyzeTrack(run, track) {
    const pts = trackPoints(track).filter(p => p.acc == null || p.acc <= MAX_TRACK_ACC_M);
    const stops = (run && run.stops) || [];
    const legs = [];
    let cursor = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      const dep = toDate(a.actualDeparture);
      const arr = toDate(b.actualArrival);
      if (!dep || !arr || arr <= dep) continue;
      const t1 = dep.getTime();
      const t2 = arr.getTime();
      while (cursor < pts.length && pts[cursor].t < t1) cursor++;
      const legPts = [];
      for (let k = cursor; k < pts.length && pts[k].t <= t2; k++) legPts.push(pts[k]);
      if (legPts.length < 2) continue;
      const near = (p, s) => {
        if (s.lat == null || s.lon == null) return null;
        return distanceM(p, { lat: Number(s.lat), lon: Number(s.lon) }) <= (Number(s.radius) || 200) + STATION_MARGIN_M;
      };
      let d = 0;
      const profile = legPts.map((p, k) => {
        if (k > 0) d += distanceM(legPts[k - 1], p);
        const speed = p.speed != null ? p.speed : (k > 0 ? distanceM(legPts[k - 1], p) / Math.max(0.5, (p.t - legPts[k - 1].t) / 1000) : 0);
        const nA = near(p, a);
        const nB = near(p, b);
        const atStation = nA == null && nB == null ? (p.t - t1 < 30000 || t2 - p.t < 30000) : (!!nA || !!nB);
        return { t: p.t, d, v: speed * 3.6, still: speed < STILL_SPEED_MS, atStation, lat: p.lat, lon: p.lon };
      });
      // Stillastående utanför stationerna, med korta glapp av falsk fart ihopslagna
      const runsStill = [];
      let cur = null;
      for (const p of profile) {
        if (p.still && !p.atStation) {
          if (!cur) cur = { first: p, last: p };
          else cur.last = p;
        } else if (cur) { runsStill.push(cur); cur = null; }
      }
      if (cur) runsStill.push(cur);
      const merged = [];
      for (const r of runsStill) {
        const prev = merged[merged.length - 1];
        if (prev && (r.first.t - prev.last.t) / 1000 <= MERGE_GAP_S && distanceM(prev.last, r.first) <= MERGE_DIST_M) prev.last = r.last;
        else merged.push(Object.assign({}, r));
      }
      const legStops = merged
        .map(r => ({ start: new Date(r.first.t).toISOString(), minutes: (r.last.t - r.first.t) / 60000, d: r.first.d, lat: r.first.lat, lon: r.first.lon }))
        .filter(s => s.minutes * 60 >= MIN_UNPLANNED_S);
      legs.push({ index: i, key: `${a.name} → ${b.name}`, from: a.name, to: b.name, length: d,
        excluded: !!b.excludeInboundRun,
        profile: profile.map(p => ({ t: p.t - t1, d: p.d, v: p.v })), stops: legStops });
    }
    return { runId: run && run.id != null ? String(run.id) : '', legs };
  }

  // Körnings-id → analyzeTrack för alla spår som hör till en körning i `runs`
  function analyzeTracks(runs, tracks) {
    const byId = new Map((runs || []).map(r => [String(r.id), r]));
    const out = new Map();
    for (const track of tracks || []) {
      const run = track && byId.get(String(track.runId));
      if (run) out.set(String(run.id), analyzeTrack(run, track));
    }
    return out;
  }

  /* Stopp mellan stationerna i urvalet, ett per tillfälle: sträcka, datum, tåg, varaktighet och läge (m från A).
     excluded: föraren har redan markerat sträckan som undantagen (excludeInboundRun) i appen. */
  function unplannedStops(runs, trackInfo) {
    const out = [];
    for (const run of runs || []) {
      const t = trackInfo && trackInfo.get(String(run.id));
      if (!t) continue;
      const info = runInfo(run);
      // Bara sträckor som finns i körningen (en avskuren körning har färre)
      const pairs = new Set((run.stops || []).slice(0, -1).map((s, k) => `${s.name} → ${run.stops[k + 1].name}`));
      for (const leg of t.legs) {
        if (!pairs.has(leg.key)) continue;
        for (const s of leg.stops) {
          out.push(Object.assign({ segment: leg.key, from: leg.from, to: leg.to, legLength: leg.length, excluded: leg.excluded }, s,
            { date: info.date, weekday: info.weekday, train: info.trainNumber, runId: info.runId }));
        }
      }
    }
    return out.sort((a, b) => b.minutes - a.minutes || String(b.start).localeCompare(String(a.start)));
  }

  // ── Broms och gas (GPS-spår) ──
  /* Var tågen bromsar och gasar, i meter före och efter varje uppehåll och i km längs linjen.
     Accelerationen räknas ur GPS-farten, utjämnad över ±2 s. I datan 2026-11-25 (51 spår, 1 punkt/s) ligger jämn fart
     (rullning, lutning) inom ±0,1 m/s², inbromsning kring −0,5 m/s² och gas 0,2–0,5 m/s². */
  const MOTION_ACCEL = 0.15;     // m/s²: från så här mycket räknas det som broms respektive gas
  const MOTION_SMOOTH = 2;       // punkter före och efter när farten jämnas ut
  const ZONE_BIN_M = 50;         // längdsteg vid stationerna
  const LINE_BIN_M = 100;        // längdsteg längs linjen
  const ZONE_WINDOW_M = 4000;    // så långt före och efter stationen räknas
  const ZONE_SHARE = 0.5;        // zon: minst hälften av körningarna bromsar (gasar) i längdsteget …
  const ZONE_MIN_RUNS = 3;       // … och minst så många körningar har passerat där
  const ZONE_GAP_M = 150;        // kortare glapp inom en zon slås ihop
  const ZONE_MIN_M = 100;        // kortare zoner räknas inte
  const ZONE_CHAIN_M = 1000;     // inbromsning (gas) i steg: zoner med kortare glapp hör till samma inbromsning
  const ANCHOR_MAX_M = 400;      // spåret ska passera så här nära stationens koordinat
  const ACTIONS = ['broms', 'gas', 'jamn', 'still'];

  function lowerBoundT(pts, t) {
    let lo = 0, hi = pts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].t < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // Sträckan d växer aldrig bakåt, så även den kan sökas binärt
  function lowerBoundD(pts, d) {
    let lo = 0, hi = pts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].d < d) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /* Spårets punkter med sträcka d (m från spårets början), utjämnad fart v (km/h), acceleration a (m/s²) och
     vad tåget gör: 'broms', 'gas', 'jamn' (jämn fart) eller 'still' (under 2 km/h). GPS-brus när tåget står still
     räknas inte som sträcka. */
  function motionPoints(track) {
    const p = trackPoints(track).filter(q => q.acc == null || q.acc <= MAX_TRACK_ACC_M);
    const n = p.length;
    const smooth = p.map((q, k) => {
      let sum = 0, c = 0;
      for (let j = Math.max(0, k - MOTION_SMOOTH); j <= Math.min(n - 1, k + MOTION_SMOOTH); j++) {
        if (p[j].speed == null || Math.abs(p[j].t - q.t) > (MOTION_SMOOTH + 0.5) * 1000) continue;
        sum += p[j].speed;
        c++;
      }
      return c ? sum / c : null;
    });
    const out = [];
    let d = 0;
    for (let k = 0; k < n; k++) {
      const q = p[k];
      if (k > 0) {
        const prev = p[k - 1];
        const step = distanceM(prev, q);
        const moving = prev.speed != null || q.speed != null
          ? Math.max(prev.speed || 0, q.speed || 0) >= STILL_SPEED_MS
          : step / Math.max(0.5, (q.t - prev.t) / 1000) >= STILL_SPEED_MS;
        if (moving) d += step;
      }
      let a = null;
      if (k > 0 && k < n - 1 && smooth[k - 1] != null && smooth[k + 1] != null) {
        const dt = (p[k + 1].t - p[k - 1].t) / 1000;
        if (dt > 0 && dt <= 4) a = (smooth[k + 1] - smooth[k - 1]) / dt;
      }
      const v = smooth[k] != null ? smooth[k] : q.speed;
      const action = v != null && v < STILL_SPEED_MS ? 'still'
        : a == null ? null : a <= -MOTION_ACCEL ? 'broms' : a >= MOTION_ACCEL ? 'gas' : 'jamn';
      out.push({ t: q.t, lat: q.lat, lon: q.lon, d, v: v == null ? null : v * 3.6, a, action });
    }
    return out;
  }

  // Körnings-id → motionPoints för alla spår som hör till en körning i `runs` (räknas en gång per inläsning)
  function motionTracks(runs, tracks) {
    const ids = new Set((runs || []).map(r => String(r.id)));
    const out = new Map();
    for (const track of tracks || []) {
      if (track && ids.has(String(track.runId))) out.set(String(track.runId), motionPoints(track));
    }
    return out;
  }

  /* Var i spåret tåget är vid stationen: punkten närmast stationens koordinat (högst ANCHOR_MAX_M bort), med
     sträckan interpolerad mot grannpunkterna. Sökningen gäller tiden runt ankomst och avgång (±10 min). */
  function stationAnchor(stop, pts) {
    if (!stop || stop.lat == null || stop.lon == null || !pts || !pts.length) return null;
    const target = { lat: Number(stop.lat), lon: Number(stop.lon) };
    if (!isFinite(target.lat) || !isFinite(target.lon)) return null;
    const arr = toDate(stop.actualArrival);
    const dep = toDate(stop.actualDeparture);
    const t1 = arr || dep ? (arr || dep).getTime() - 600000 : -Infinity;
    const t2 = dep || arr ? (dep || arr).getTime() + 600000 : Infinity;
    let best = -1;
    let bestDist = Infinity;
    for (let k = t1 === -Infinity ? 0 : lowerBoundT(pts, t1); k < pts.length && pts[k].t <= t2; k++) {
      const dist = distanceM(pts[k], target);
      if (dist < bestDist) { bestDist = dist; best = k; }
    }
    if (best < 0 || bestDist > ANCHOR_MAX_M) return null;
    const cos = Math.cos(target.lat * Math.PI / 180);
    const xy = q => ({ x: (q.lon - target.lon) * 111320 * cos, y: (q.lat - target.lat) * 110574 });
    let d = pts[best].d;
    let off = bestDist;
    for (const [i, j] of [[best - 1, best], [best, best + 1]]) {
      if (i < 0 || j >= pts.length) continue;
      const A = xy(pts[i]);
      const B = xy(pts[j]);
      const len2 = (B.x - A.x) ** 2 + (B.y - A.y) ** 2;
      if (len2 < 1) continue;
      const f = Math.max(0, Math.min(1, -(A.x * (B.x - A.x) + A.y * (B.y - A.y)) / len2));
      const o = Math.hypot(A.x + f * (B.x - A.x), A.y + f * (B.y - A.y));
      if (o < off) { off = o; d = pts[i].d + f * (pts[j].d - pts[i].d); }
    }
    return { k: best, d, offset: off };
  }

  /* Linjerna som körningarna går på: stationerna i ordning med km från linjens ena ände (den sydligaste).
     Avståndet mellan grannstationer är medianen av spårens sträcka. Kanter som hoppar över stationer (körningar
     utan tågnummer har bara start och slut) tas bort när vägen via stationerna är lika lång. Grenar blir egna linjer. */
  function lineAxis(entries, minRuns) {
    const count = new Map();
    const pos = new Map();
    for (const e of entries) {
      const seen = new Set();
      e.run.stops.forEach((s, i) => {
        if (!e.anchors[i] || seen.has(s.name)) return;
        seen.add(s.name);
        count.set(s.name, (count.get(s.name) || 0) + 1);
        if (!pos.has(s.name)) pos.set(s.name, { lat: [], lon: [] });
        pos.get(s.name).lat.push(Number(s.lat));
        pos.get(s.name).lon.push(Number(s.lon));
      });
    }
    const keep = new Set([...count].filter(([, c]) => c >= minRuns).map(([name]) => name));
    const lens = new Map();
    for (const e of entries) {
      const seq = e.run.stops.map((s, i) => ({ name: s.name, a: e.anchors[i] })).filter(x => x.a && keep.has(x.name));
      for (let k = 0; k + 1 < seq.length; k++) {
        const a = seq[k];
        const b = seq[k + 1];
        const len = Math.abs(b.a.d - a.a.d);
        if (a.name === b.name || len < 50) continue;
        const key = a.name < b.name ? a.name + '\u0000' + b.name : b.name + '\u0000' + a.name;
        if (!lens.has(key)) lens.set(key, []);
        lens.get(key).push(len);
      }
    }
    const adj = new Map([...keep].map(n => [n, new Map()]));
    const edges = [...lens].map(([key, l]) => { const [a, b] = key.split('\u0000'); return { a, b, w: stats(l).median }; });
    for (const e of edges) { adj.get(e.a).set(e.b, e.w); adj.get(e.b).set(e.a, e.w); }
    // Kortaste väg från `from` utan den direkta kanten from–skip (Dijkstra, få stationer)
    const dijkstra = (from, nodes, skip) => {
      const dist = new Map([[from, 0]]);
      const prev = new Map();
      const done = new Set();
      for (;;) {
        let u = null;
        for (const [n, dn] of dist) if (!done.has(n) && (u == null || dn < dist.get(u))) u = n;
        if (u == null) break;
        done.add(u);
        for (const [v, w] of adj.get(u)) {
          if (!nodes.has(v) || (u === from && v === skip)) continue;
          const nd = dist.get(u) + w;
          if (!dist.has(v) || nd < dist.get(v)) { dist.set(v, nd); prev.set(v, u); }
        }
      }
      return { dist, prev };
    };
    edges.sort((x, y) => y.w - x.w);
    for (const e of edges) {
      const alt = dijkstra(e.a, keep, e.b).dist.get(e.b);
      if (alt != null && alt <= e.w * 1.05) { adj.get(e.a).delete(e.b); adj.get(e.b).delete(e.a); }
    }
    const lines = [];
    const at = new Map();
    const remaining = new Set([...keep].sort());
    const median = name => { const p = pos.get(name); return { lat: stats(p.lat).median, lon: stats(p.lon).median }; };
    while (remaining.size) {
      const start = remaining.values().next().value;
      const farthest = from => {
        const r = dijkstra(from, remaining, null);
        let far = from;
        for (const [n, dn] of r.dist) if (dn > r.dist.get(far) || (dn === r.dist.get(far) && n < far)) far = n;
        return { far, r };
      };
      const a = farthest(start).far;
      const { far: b, r } = farthest(a);
      let path = [b];
      while (path[0] !== a) path.unshift(r.prev.get(path[0]));
      if (median(path[path.length - 1]).lat < median(path[0]).lat) path = path.reverse();
      let km = 0;
      const stations = path.map((name, k) => {
        if (k > 0) km += adj.get(path[k - 1]).get(name) / 1000;
        return Object.assign({ name, km }, median(name));
      });
      const index = lines.length;
      lines.push({ index, length: km * 1000, stations });
      stations.forEach(s => { at.set(s.name, { line: index, km: s.km }); remaining.delete(s.name); });
    }
    return { lines, at };
  }

  // Zoner där minst ZONE_SHARE av körningarna gör `kind`, med korta glapp ihopslagna
  function findZones(bins, kind, minRuns, binM) {
    const zones = [];
    for (const b of bins) {
      if (!(b.n >= minRuns && b[kind] / b.n >= ZONE_SHARE)) continue;
      const last = zones[zones.length - 1];
      if (last && b.from - last.to <= ZONE_GAP_M) { last.to = b.from + binM; last.bins.push(b); }
      else zones.push({ kind, from: b.from, to: b.from + binM, bins: [b] });
    }
    return zones.filter(z => z.to - z.from >= ZONE_MIN_M).map(z => {
      const first = z.bins[0];
      const last = z.bins[z.bins.length - 1];
      return {
        kind, from: z.from, to: z.to, length: z.to - z.from,
        share: z.bins.reduce((s, b) => s + b[kind] / b.n, 0) / z.bins.length,
        runs: Math.max(...z.bins.map(b => b.n)),
        vFrom: first.v.median, vTo: last.v.median,
        start: { lat: first.lat, lon: first.lon }, end: { lat: last.lat, lon: last.lon }
      };
    });
  }

  /* Inbromsningen fram till stoppet (backwards) eller gasen därifrån, från zonen `pick`. Bromsar tåget i steg
     (till exempel inför en bangård) räknas stegen dit, så länge glappet är högst ZONE_CHAIN_M och tåget inte gasar
     däremellan. steps = antal zoner. */
  function chainZones(zones, pick, backwards) {
    if (!pick) return null;
    const list = zones.slice().sort((a, b) => a.from - b.from);
    let k = list.indexOf(pick);
    const out = Object.assign({}, pick, { steps: 1 });
    for (;;) {
      k += backwards ? -1 : 1;
      const next = list[k];
      if (!next) break;
      if (next.kind !== pick.kind) break;
      if ((backwards ? out.from - next.to : next.from - out.to) > ZONE_CHAIN_M) break;
      if (backwards) { out.from = next.from; out.vFrom = next.vFrom; out.start = next.start; }
      else { out.to = next.to; out.vTo = next.vTo; out.end = next.end; }
      out.share = Math.min(out.share, next.share);
      out.steps++;
    }
    out.length = out.to - out.from;
    return out;
  }

  function newBin(from) { return { from, n: 0, broms: 0, gas: 0, jamn: 0, still: 0, v: [], lat: [], lon: [] }; }

  // En körnings punkter i ett längdsteg → vad tåget mest gjorde där (en röst per körning och längdsteg)
  function vote(binMap, key, p) {
    let b = binMap.get(key);
    if (!b) { b = { c: { broms: 0, gas: 0, jamn: 0, still: 0 }, v: [], lat: p.lat, lon: p.lon }; binMap.set(key, b); }
    b.c[p.action]++;
    if (p.v != null) b.v.push(p.v);
  }
  function addVotes(target, binMap, binM) {
    for (const [key, b] of binMap) {
      const action = ACTIONS.reduce((best, x) => (b.c[x] > b.c[best] ? x : best), ACTIONS[0]);
      if (!target.has(key)) target.set(key, newBin(key * binM));
      const t = target.get(key);
      t.n++;
      t[action]++;
      if (b.v.length) t.v.push(stats(b.v).median);
      t.lat.push(b.lat);
      t.lon.push(b.lon);
    }
  }
  function finishBins(target) {
    return [...target.values()].sort((a, b) => a.from - b.from).map(b => Object.assign(b, {
      v: stats(b.v), lat: stats(b.lat).median, lon: stats(b.lon).median
    }));
  }

  /* Broms och gas vid uppehållen och längs linjen. motion: körnings-id → motionPoints (motionTracks).
     Per station och riktning räknas bara körningar som stannade där (GPS-spåret under 2 km/h inom ANCHOR_MAX_M).
     Avstånd s är meter från stationens koordinat i färdriktningen: negativt före, positivt efter.
     Ger { runCount, lines: [{ index, length, stations, dirs: [{ dir, from, toward, bins }] }],
           stations: [{ key, name, line, km, dir, from, toward, n, passages, stopAt, bins, zones, approach, departure, runs }] } */
  function motionZones(runs, motion) {
    const entries = [];
    for (const run of runs || []) {
      const pts = motion && motion.get(String(run.id));
      if (!pts || pts.length < 10 || !Array.isArray(run.stops)) continue;
      entries.push({ run, pts, anchors: run.stops.map(s => stationAnchor(s, pts)) });
    }
    const empty = { runCount: entries.length, lines: [], stations: [] };
    if (!entries.length) return empty;
    const minRuns = Math.min(ZONE_MIN_RUNS, entries.length);
    const axis = lineAxis(entries, minRuns);
    const groups = new Map();
    const lineBins = new Map();
    for (const e of entries) {
      const info = runInfo(e.run);
      const stops = e.run.stops;
      const { pts } = e;
      // Stannade tåget vid stationen? (GPS under 2 km/h nära stationen) och var
      const stopped = stops.map((s, i) => {
        const an = e.anchors[i];
        if (!an) return null;
        let first = null;
        for (let k = lowerBoundD(pts, an.d - ANCHOR_MAX_M); k < pts.length; k++) {
          const sd = pts[k].d - an.d;
          if (sd > ANCHOR_MAX_M) break;
          if (sd >= -ANCHOR_MAX_M && pts[k].action === 'still') { first = sd; break; }
        }
        // Mätningen avslutades i samma stund som tåget kom fram (slutstationen): appens ankomst räcker om farten var låg
        const arr = toDate(s.actualArrival);
        if (first == null && arr && stopType(s) === 'stopp') {
          const k = Math.min(pts.length - 1, lowerBoundT(pts, arr.getTime()));
          if (pts[k].v != null && pts[k].v < 10 && Math.abs(pts[k].d - an.d) <= ANCHOR_MAX_M) first = pts[k].d - an.d;
        }
        return first;
      });
      // Körningens läge på linjen: km mellan stationerna i körningen, i spårets ordning
      const marks = stops.map((s, i) => ({ s, an: e.anchors[i], at: axis.at.get(s.name) })).filter(x => x.an && x.at);
      const lineOf = new Map();
      for (const m of marks) {
        if (!lineOf.has(m.at.line)) lineOf.set(m.at.line, []);
        lineOf.get(m.at.line).push({ d: m.an.d, km: m.at.km });
      }
      for (const [line, list] of lineOf) {
        list.sort((a, b) => a.d - b.d);
        if (list.length < 2) continue;
        const segs = [];
        for (let k = 0; k + 1 < list.length; k++) if (list[k + 1].d - list[k].d > 1 && list[k + 1].km !== list[k].km) segs.push([list[k], list[k + 1]]);
        if (!segs.length) continue;
        const L = axis.lines[line];
        const bins = { 1: new Map(), '-1': new Map() };
        let j = 0;
        for (const p of pts) {
          if (!p.action || p.d < segs[0][0].d - ANCHOR_MAX_M || p.d > segs[segs.length - 1][1].d + ANCHOR_MAX_M) continue;
          while (j < segs.length - 1 && p.d > segs[j][1].d) j++;
          const [a, b] = segs[j];
          const dir = b.km > a.km ? 1 : -1;
          const km = a.km + (p.d - a.d) / (b.d - a.d) * (b.km - a.km);
          if (km < 0 || km * 1000 > L.length) continue;
          vote(bins[dir], Math.floor(km * 1000 / LINE_BIN_M), p);
        }
        for (const dir of [1, -1]) {
          const key = line + '|' + dir;
          if (!lineBins.has(key)) lineBins.set(key, new Map());
          addVotes(lineBins.get(key), bins[dir], LINE_BIN_M);
        }
      }
      // Per uppehåll: fönstret går från föregående till nästa station där tåget stannade (högst ZONE_WINDOW_M)
      stops.forEach((s, i) => {
        const an = e.anchors[i];
        const at = axis.at.get(s.name);
        if (!an || !at) return;
        let dir = 0;
        for (let k = i + 1; k < stops.length && !dir; k++) {
          const o = axis.at.get(stops[k].name);
          if (e.anchors[k] && o && o.line === at.line && o.km !== at.km) dir = o.km > at.km ? 1 : -1;
        }
        for (let k = i - 1; k >= 0 && !dir; k--) {
          const o = axis.at.get(stops[k].name);
          if (e.anchors[k] && o && o.line === at.line && o.km !== at.km) dir = o.km < at.km ? 1 : -1;
        }
        if (!dir) return;
        const L = axis.lines[at.line];
        const key = s.name + '|' + dir;
        if (!groups.has(key)) {
          const ends = dir > 0 ? [L.stations[0], L.stations[L.stations.length - 1]] : [L.stations[L.stations.length - 1], L.stations[0]];
          const st = L.stations.find(x => x.name === s.name);
          groups.set(key, { key, name: s.name, line: at.line, km: at.km, dir, from: ends[0].name, toward: ends[1].name,
            lat: st.lat, lon: st.lon, n: 0, passages: 0, stopAt: [], reachBefore: [], reachAfter: [], bins: new Map(), runs: [] });
        }
        const g = groups.get(key);
        if (stopped[i] == null) { g.passages++; return; }
        // Körningens första station är start, utom när körningen är avskuren (cutStart)
        let lo = i === 0 && !e.run.cutStart ? -ANCHOR_MAX_M : -ZONE_WINDOW_M;
        let hi = i === stops.length - 1 ? ANCHOR_MAX_M : ZONE_WINDOW_M;
        for (let k = i - 1; k >= 0; k--) if (e.anchors[k] && stopped[k] != null) { lo = Math.max(lo, e.anchors[k].d - an.d); break; }
        for (let k = i + 1; k < stops.length; k++) if (e.anchors[k] && stopped[k] != null) { hi = Math.min(hi, e.anchors[k].d - an.d); break; }
        const binMap = new Map();
        const profile = [];
        let lastS = null;
        for (let k = lowerBoundD(pts, an.d + lo); k < pts.length; k++) {
          const p = pts[k];
          const sd = p.d - an.d;
          if (sd > hi) break;
          if (p.action) vote(binMap, Math.floor(sd / ZONE_BIN_M), p);
          if (p.v != null && (lastS == null || Math.abs(sd - lastS) >= 15)) { profile.push({ s: Math.round(sd), v: Math.round(p.v * 10) / 10 }); lastS = sd; }
        }
        addVotes(g.bins, binMap, ZONE_BIN_M);
        g.reachBefore.push(-lo);
        g.reachAfter.push(hi);
        g.n++;
        g.stopAt.push(stopped[i]);
        g.runs.push({ runId: info.runId, date: info.date, weekday: info.weekday, train: info.trainNumber, profile });
      });
    }
    // Stationer där alla körningar passerade är med (n = 0, inga zoner), så att linjen blir hel
    const stations = [...groups.values()].map(g => {
      const bins = finishBins(g.bins);
      if (!g.n) return Object.assign({}, g, { stopAt: null, bins, zones: [], approach: null, departure: null });
      const zr = Math.min(ZONE_MIN_RUNS, g.n);
      const zones = findZones(bins, 'broms', zr, ZONE_BIN_M).concat(findZones(bins, 'gas', zr, ZONE_BIN_M)).sort((a, b) => a.from - b.from);
      const stopAt = stats(g.stopAt).median;
      const brakes = zones.filter(z => z.kind === 'broms' && z.from < stopAt + 50 && z.to >= stopAt - ANCHOR_MAX_M);
      const gases = zones.filter(z => z.kind === 'gas' && z.to > stopAt - 50 && z.from <= stopAt + ANCHOR_MAX_M);
      const approach = chainZones(zones.filter(z => z.to <= stopAt + ANCHOR_MAX_M), brakes.sort((a, b) => b.to - a.to)[0], true);
      const departure = chainZones(zones.filter(z => z.from >= stopAt - ANCHOR_MAX_M), gases.sort((a, b) => a.from - b.from)[0], false);
      const withKm = z => z && Object.assign(z, { km1: g.km + g.dir * z.from / 1000, km2: g.km + g.dir * z.to / 1000 });
      zones.forEach(withKm);
      // own: zonen ligger närmare den här stationen än grannstationen där tåget stannar (annars hör den till grannen),
      // och högst ZONE_WINDOW_M / 2 bort. Zoner längre ut syns längs linjen.
      const half = list => stats(list).median / 2;
      const before = half(g.reachBefore);
      const after = half(g.reachAfter);
      for (const z of zones) { const mid = (z.from + z.to) / 2; z.own = mid >= -before && mid <= after; }
      if (approach) approach.own = true;
      if (departure) departure.own = true;
      return Object.assign({}, g, { stopAt, bins, zones, approach: withKm(approach), departure: withKm(departure) });
    }).sort((a, b) => a.line - b.line || a.dir - b.dir || a.dir * (a.km - b.km));
    const lines = axis.lines.map(L => Object.assign({}, L, {
      dirs: [1, -1].map(dir => ({
        dir,
        from: dir > 0 ? L.stations[0].name : L.stations[L.stations.length - 1].name,
        toward: dir > 0 ? L.stations[L.stations.length - 1].name : L.stations[0].name,
        bins: finishBins(lineBins.get(L.index + '|' + dir) || new Map())
      }))
    }));
    return { runCount: entries.length, lines, stations };
  }

  // ── Km-tal: Trafikverkets längdmätning (linjeboken) ──

  /* Stationernas km-tal enligt Trafikverkets Underlag till linjebok, TC Göteborg, version 2026-09-01,
     sid D813–D822 (Gårdsjö – Håkantorp). Hasslerör: km-talet gäller växeln. André 2026-11-25: Gårdsjö –
     Håkantorp räcker. Mellan stationerna räknas km-talet längs GPS-spåren (linjens km), så där är det ungefärligt. */
  const KMTAL_SECTIONS = [{
    name: 'Håkantorp – Gårdsjö',
    source: 'Trafikverket, Underlag till linjebok TC Göteborg 2026-09-01, sid D813–D822',
    stations: [
      ['Gårdsjö', 0], ['Hova', 8730], ['Torved', 16845], ['Lyrestad', 21024], ['Hasslerör', 30640], ['Mariestad', 39045],
      ['Lugnås', 50252], ['Äskekärr', 56250], ['Österäng', 59400], ['Forshem', 63774], ['Hällekis', 67510], ['Råbäck', 71620],
      ['Trolmen', 74087], ['Blomberg', 80399], ['Källby', 83974], ['Filsbäck', 88000], ['Lidköping', 93111],
      ['Framnäs city', 94160], ['Lovene', 103790], ['Järpås', 111937], ['Stora Levene', 118435], ['Håkantorp', 121021]
    ]
  }];

  /* Km-talet längs en linje från motionZones (stationer med linjens km). Stationerna i sections är fasta punkter;
     stationer som inte följer linjebokens ordning tas inte med. Ger { segs: [{ name, source, sign, refs, lo, hi }] }
     eller null när ingen sträcka har minst två av linjens stationer. */
  function kmTalAxis(line, sections) {
    if (!line || !Array.isArray(line.stations)) return null;
    const at = new Map(line.stations.map(s => [String(s.name).toLowerCase(), s]));
    const segs = [];
    for (const sec of sections || KMTAL_SECTIONS) {
      // name = linjebokens namn, station = linjens (stavningen kan skilja i stor och liten bokstav)
      const all = sec.stations.map(([name, m]) => { const st = at.get(String(name).toLowerCase()); return { name, m, station: st && st.name, km: st && st.km }; })
        .filter(r => r.km != null && isFinite(r.km)).sort((a, b) => a.km - b.km);
      if (all.length < 2) continue;
      const sign = Math.sign(all[all.length - 1].m - all[0].m);
      const refs = [];
      for (const r of all) if (!refs.length || (r.km > refs[refs.length - 1].km && sign * (r.m - refs[refs.length - 1].m) > 0)) refs.push(r);
      if (!sign || refs.length < 2) continue;
      segs.push({ name: sec.name, source: sec.source || '', sign, refs, lo: refs[0].km, hi: refs[refs.length - 1].km });
    }
    return segs.length ? { segs } : null;
  }

  // Km-talet vid linjens km: { section, m } eller null utanför sträckorna (där gäller en annan bana och ett annat km-tal)
  function kmTalAt(axis, km) {
    if (!axis || km == null || !isFinite(km)) return null;
    const eps = 1e-6;
    const segs = axis.segs.filter(s => km >= s.lo - eps && km <= s.hi + eps);
    const seg = segs.find(s => km > s.lo + eps && km < s.hi - eps) || segs[0];
    if (!seg) return null;
    const r = seg.refs;
    let k = 0;
    while (k + 2 < r.length && r[k + 1].km < km) k++;
    const a = r[k], b = r[k + 1];
    const f = Math.max(0, Math.min(1, (km - a.km) / (b.km - a.km)));
    return { section: seg.name, m: Math.round(a.m + f * (b.m - a.m)) };
  }

  // Stationens km-tal enligt linjeboken, eller null
  function kmTalStation(axis, name) {
    if (!axis) return null;
    const key = String(name).toLowerCase();
    for (const s of axis.segs) {
      const r = s.refs.find(x => x.name.toLowerCase() === key);
      if (r) return { section: s.name, m: r.m };
    }
    return null;
  }

  // 23 450 m → "23+450" (som i linjeboken och på kilometertavlorna). step: avrunda till så många meter.
  function formatKmTal(m, step) {
    if (m == null || !isFinite(m)) return '';
    const st = step > 0 ? step : 1;
    const v = Math.round(m / st) * st;
    const sign = v < 0 ? '−' : '';
    const a = Math.abs(v);
    return sign + Math.floor(a / 1000) + '+' + String(a % 1000).padStart(3, '0');
  }

  // ── Halka: förarens markeringar och starter som är svagare än vanligt ──

  const START_V1 = 5;            // km/h: startens acceleration räknas från den här farten …
  const START_V2 = 40;           // … till den här
  const START_MAX_MS = 120000;   // längre tid från stillastående till 40 km/h räknas inte (tåget stannade igen e.d.)
  const START_MAX_GAP_MS = 5000; // glapp i GPS-spåret under starten: räknas inte
  const ADH_MIN_BASE = 6;        // jämförelse kräver minst så många andra starter på samma ställe
  const ADH_WEAK = 0.6;          // svagare än vanligt: under 60 % av det normala

  /* Startens acceleration (m/s²) från stillastående vid stationen: farten 5 → 40 km/h. an = stationAnchor.
     null när tåget inte stod still inom ANCHOR_MAX_M, när det inte nådde 40 km/h inom 2 min, när det stannade
     igen eller när spåret har glapp. */
  function startAcceleration(pts, an) {
    if (!pts || !an) return null;
    let ks = -1;
    for (let k = lowerBoundD(pts, an.d - ANCHOR_MAX_M); k < pts.length && pts[k].d <= an.d + ANCHOR_MAX_M; k++) {
      if (pts[k].action === 'still') ks = k;
    }
    if (ks < 0) return null;
    let i1 = -1;
    for (let k = ks + 1; k < pts.length; k++) {
      const p = pts[k];
      if (p.t - pts[ks].t > START_MAX_MS || p.t - pts[k - 1].t > START_MAX_GAP_MS) return null;
      if (p.v == null) continue;
      if (i1 >= 0 && p.v < 1) return null;
      if (i1 < 0 && p.v >= START_V1) i1 = k;
      if (i1 >= 0 && p.v >= START_V2) {
        const dt = (p.t - pts[i1].t) / 1000;
        return dt > 0 ? (p.v - pts[i1].v) / 3.6 / dt : null;
      }
    }
    return null;
  }

  /* Halka per körning: förarens markeringar (stop.slideIn = gled vid inbromsningen till stationen, stop.slipOut =
     slirade vid starten därifrån) och, med GPS-spår, startens acceleration från stillastående. Ger händelser
     { runId, date, weekday, train, vehicle, kind: 'broms'|'start', station, from, toward, marked, acc }.
     Riktningen är from → toward (föregående/nästa station i körningen). */
  function adhesionEvents(runs, motion) {
    const out = [];
    for (const run of runs || []) {
      if (!Array.isArray(run.stops)) continue;
      const info = runInfo(run);
      const pts = motion && motion.get(String(run.id));
      const stops = run.stops;
      const usable = pts && pts.length >= 10;
      stops.forEach((s, i) => {
        const prev = stops[i - 1], next = stops[i + 1];
        const base = { runId: info.runId, date: info.date, weekday: info.weekday, train: info.trainNumber, vehicle: info.vehicleType, station: s.name };
        if (s.slideIn && prev) out.push(Object.assign({}, base, { kind: 'broms', from: prev.name, toward: s.name, marked: true, acc: null }));
        if (!next) return;
        const acc = usable ? startAcceleration(pts, stationAnchor(s, pts)) : null;
        if (s.slipOut || acc != null) out.push(Object.assign({}, base, { kind: 'start', from: s.name, toward: next.name, marked: !!s.slipOut, acc }));
      });
    }
    return out;
  }

  /* Jämför varje start med de andra starterna från samma station mot samma station med samma fordonstyp. Med minst
     ADH_MIN_BASE andra får starten normal (median), baseN, ratio och weak (under ADH_WEAK av det normala).
     Halka går inte att skilja från försiktig körning i GPS-spåret: weak är en avvikelse, inte halt. */
  function adhesionCompare(events) {
    const groups = new Map();
    for (const e of events) {
      if (e.kind !== 'start' || e.acc == null) continue;
      const key = e.from + '\u0000' + e.toward + '\u0000' + (e.vehicle || '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    for (const list of groups.values()) {
      for (const e of list) {
        const others = list.filter(x => x !== e).map(x => x.acc);
        if (others.length < ADH_MIN_BASE) continue;
        e.normal = stats(others).median;
        e.baseN = others.length;
        e.ratio = e.acc / e.normal;
        e.weak = e.ratio < ADH_WEAK;
      }
    }
    return events;
  }

  // ── Jämför perioder ──

  function inPeriod(run, p) {
    const d = localDate(runStart(run));
    if (!d) return false;
    return (!p || !p.from || d >= p.from) && (!p || !p.to || d <= p.to);
  }

  function trainPeriodStats(runs, tol) {
    const tt = runs.filter(hasTimetable);
    const ends = [];
    const starts = [];
    const planned = [];
    const actual = [];
    for (const run of tt) {
      const s = run.stops || [];
      const f = s[0];
      const l = s[s.length - 1];
      if (!f || !l) continue;
      const pd = plannedDeparture(f), ad = toDate(f.actualDeparture), pa = plannedArrival(l), aa = toDate(l.actualArrival);
      if (pd && ad) starts.push(minutes(pd, ad));
      if (pa && aa) ends.push(minutes(pa, aa));
      if (pd && pa) planned.push(minutes(pd, pa));
      if (ad && aa) actual.push(minutes(ad, aa));
    }
    const events = stationTimes(tt).filter(t => t.type !== 'start' && t.lost > tol).length;
    return {
      runs: tt.length, startDelay: stats(starts), endDelay: stats(ends), planned: stats(planned), actual: stats(actual),
      eventsPerRun: tt.length ? events / tt.length : null, balance: delayBalance(tt)
    };
  }

  /* Period A mot period B ({ from, to } i lokal tid, inklusive) för samma urval. opts: { tolerance, tracks,
     skipUnplanned }. Sträckor per verkligt stoppmönster: median i A och B och skillnad B − A (när båda har minst
     MIN_SAMPLES). Tåg per tågnummer (överlever en ny tidtabell): restid planerad och verklig, försening vid start och slut,
     gånger tappat per körning och var tiden går (delayBalance). */
  function comparePeriods(runs, a, b, opts) {
    const tol = opts && opts.tolerance != null ? opts.tolerance : DEFAULT_TOLERANCE;
    const valid = (runs || []).filter(r => r && !r.aborted);
    const A = valid.filter(r => inPeriod(r, a));
    const B = valid.filter(r => inPeriod(r, b));
    const needsOf = list => needMap(segmentNeeds(segmentObservations(list, { tracks: opts && opts.tracks }),
      { skipUnplanned: opts && opts.skipUnplanned }).filter(n => n.pattern !== '*'));
    const nA = needsOf(A);
    const nB = needsOf(B);
    const keys = new Set([...nA.keys(), ...nB.keys()]);
    const segments = Array.from(keys).map(key => {
      const x = nA.get(key) || null;
      const y = nB.get(key) || null;
      const ref = x || y;
      const ok = x && y && x.n >= MIN_SAMPLES && y.n >= MIN_SAMPLES;
      return { key, segment: ref.segment, pattern: ref.pattern,
        a: x ? { n: x.n, median: x.median } : { n: 0, median: null },
        b: y ? { n: y.n, median: y.median } : { n: 0, median: null },
        diff: ok ? y.median - x.median : null };
    }).sort((p, q) => (q.diff == null ? -1 : Math.abs(q.diff)) - (p.diff == null ? -1 : Math.abs(p.diff)) || p.key.localeCompare(q.key));
    const trainsOf = list => groupBy(list.filter(r => String(r.trainNumber || '').trim()), 'trainNumber');
    const tA = trainsOf(A);
    const tB = trainsOf(B);
    const names = new Set([...tA.keys(), ...tB.keys()]);
    const trains = Array.from(names).map(train => {
      const x = trainPeriodStats(tA.get(train) || [], tol);
      const y = trainPeriodStats(tB.get(train) || [], tol);
      const diff = k => x[k].median != null && y[k].median != null ? y[k].median - x[k].median : null;
      return { train: String(train), a: x, b: y,
        diffEnd: diff('endDelay'), diffPlanned: diff('planned'), diffActual: diff('actual') };
    }).filter(t => t.a.runs || t.b.runs)
      .sort((p, q) => (q.a.runs && q.b.runs ? 1 : 0) - (p.a.runs && p.b.runs ? 1 : 0) || compareTrain(p.train, q.train));
    return {
      a: Object.assign({}, a, { runs: A.length, period: period(A), balance: delayBalance(A) }),
      b: Object.assign({}, b, { runs: B.length, period: period(B), balance: delayBalance(B) }),
      segments, trains
    };
  }

  // Förval för Jämför: B = de sista `days` dagarna med mätningar, A = allt före
  function defaultPeriods(runs, days) {
    const p = period((runs || []).filter(r => r && !r.aborted));
    if (!p) return null;
    const end = new Date(p.to + 'T12:00:00');
    const bFrom = new Date(end.getTime() - ((days || 30) - 1) * 86400000);
    const aTo = new Date(bFrom.getTime() - 86400000);
    return { a: { from: p.from, to: localDate(aTo) }, b: { from: localDate(bFrom), to: p.to } };
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
    runTrainMatches,
    DEFAULT_TOLERANCE, MIN_SAMPLES, STATION_ALIASES,
    canonicalStation, normalizeRuns,
    localDate, clockMinutes, runStart, timeOfDay, dayType, runMatches, period,
    stopType, plannedType, PATTERN_LABELS, classify, segmentObservations,
    segmentNeeds, stationTimes, trainVariants, summarizeTrains, segmentPlans, proposeTrainTimetable,
    routeBetween, proposeNewTimetable,
    delayBreakdown, delayBalance, delayProfile, hasTimetable, hasAdvertisedOnly, plannedArrival, plannedDeparture,
    trackPoints, analyzeTrack, analyzeTracks, unplannedStops, distanceM,
    MOTION_ACCEL, ZONE_BIN_M, LINE_BIN_M, ZONE_WINDOW_M, ZONE_SHARE, ZONE_MIN_RUNS,
    motionPoints, motionTracks, stationAnchor, motionZones,
    KMTAL_SECTIONS, kmTalAxis, kmTalAt, kmTalStation, formatKmTal,
    START_V1, START_V2, ADH_MIN_BASE, ADH_WEAK, startAcceleration, adhesionEvents, adhesionCompare,
    comparePeriods, defaultPeriods,
    stats, directedRuns, sliceRuns,
    formatMinutes, csvDocument
  };
});
