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
        // Väntan: tåget kom för tidigt och stod kvar till planerad ankomst – väntan är tiden fram till den.
        // Åkte tåget före planerad ankomst väntade det inte på tidtabellen (vanligt vid planerat uppehåll 0).
        let wait = null;
        if (type === 'stopp' && arrivalCategory === 'tidig' && aDep && pArr) wait = aDep >= pArr ? minutes(aArr, pArr) : 0;
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

  const STATION_ORDER = { vantan: 0, tidig: 1, 'sen-ankomst': 2, 'sen-avgang': 3, itid: 4, fa: 5 };

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
      const waits = list.filter(o => o.wait != null && o.wait > 0).map(o => o.wait);
      let assessment;
      if (nPlanned < MIN_SAMPLES) assessment = 'fa';
      // Tidig ankomst blir "Tidig – väntan" bara när tåget faktiskt väntade; annars (och vid passage) "Tidig"
      else if (arrivalDev.median != null && arrivalDev.median < -tol) assessment = waits.length ? 'vantan' : 'tidig';
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
        wait: stats(waits),
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
