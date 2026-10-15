/* RailTimer – avbrott i mätningen (samtal, appen i bakgrunden, GPS-glapp).
   Rena funktioner utan beroenden. Används av index.html och testas med node --test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RailTimerAvbrott = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GAP_MS = 20000;     // mer än 20 s utan GPS-position …
  const MOVE_M = 150;       // … och minst 150 m förflyttning = avbrott
  const GRACE_MS = 2000;    // tider registrerade av första positionen efter avbrottet
  const DEFAULT_RADIUS = 200;

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function toMs(t) {
    if (t == null || t === '') return null;
    // Datum känns igen på getTime(): testerna byter ut Date, och instanceof gäller då inte
    const ms = typeof t.getTime === 'function' ? t.getTime() : (typeof t === 'number' ? t : Date.parse(t));
    return Number.isFinite(ms) ? ms : null;
  }

  function iso(t) {
    return new Date(toMs(t)).toISOString();
  }

  // prev och fix: { t: ms enligt appens klocka, lat, lon }
  function detectInterruption(prev, fix) {
    if (!prev || !fix) return null;
    const gap = fix.t - prev.t;
    if (!(gap > GAP_MS)) return null;
    const distance = haversine(prev.lat, prev.lon, fix.lat, fix.lon);
    if (!(distance >= MOVE_M)) return null;
    return { from: prev.t, to: fix.t, distanceM: Math.round(distance) };
  }

  function windowOf(intr) {
    return { from: iso(intr.from), to: iso(intr.to) };
  }

  // Returnerar avbrottet som tiden t ligger i (from < t ≤ to + grace), annars null
  function isWithinInterruption(t, interruptions, graceMs) {
    const grace = graceMs == null ? GRACE_MS : graceMs;
    const ms = toMs(t);
    if (ms == null || !Array.isArray(interruptions)) return null;
    for (const intr of interruptions) {
      const from = toMs(intr.from);
      const to = toMs(intr.to);
      if (from == null || to == null) continue;
      if (ms > from && ms <= to + grace) return intr;
    }
    return null;
  }

  // Tider inom ett avbrott ersätts med null, fönster och källan 'avbrott'. Ändrar inte indata.
  function applyInterruptionWindows(stops, interruptions, graceMs) {
    if (!Array.isArray(stops)) return [];
    return stops.map(stop => {
      const out = Object.assign({}, stop);
      const a = isWithinInterruption(out.actualArrival, interruptions, graceMs);
      if (a) {
        out.actualArrival = null;
        out.arrivalWindow = windowOf(a);
        out.arrivalSource = 'avbrott';
      }
      const d = isWithinInterruption(out.actualDeparture, interruptions, graceMs);
      if (d) {
        out.actualDeparture = null;
        out.departureWindow = windowOf(d);
        out.departSource = 'avbrott';
      }
      return out;
    });
  }

  // Stationen passerades helt under avbrottet
  function markStationMissed(station, intr) {
    const w = windowOf(intr);
    station.missedReason = 'avbrott';
    station.actualArrival = null;
    station.actualDeparture = null;
    station.arrivalWindow = w;
    station.departureWindow = w;
    station.arrivalSource = 'avbrott';
    station.departSource = 'avbrott';
    station.inZone = false;
    station.needsArrivalRetiming = false;
    station.departureProvisional = false;
    station.departureProvisionalAt = null;
  }

  // Tåget stod vid stationen när avbrottet började och har lämnat den
  function markDepartureUnknown(station, intr) {
    station.actualDeparture = null;
    station.departureWindow = windowOf(intr);
    station.departSource = 'avbrott';
    station.inZone = false;
    station.needsArrivalRetiming = false;
    station.departureProvisional = false;
    station.departureProvisionalAt = null;
  }

  // Avstånd i meter från punkten p till sträckan a–b (lokal platt projektion runt p)
  function distanceToSegment(p, a, b) {
    const R = 6371000;
    const rad = Math.PI / 180;
    const k = Math.cos(p.lat * rad);
    const ax = (a.lon - p.lon) * rad * k * R, ay = (a.lat - p.lat) * rad * R;
    const bx = (b.lon - p.lon) * rad * k * R, by = (b.lat - p.lat) * rad * R;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(ax + t * dx, ay + t * dy);
  }

  /* Var på rutten är tåget efter ett avbrott?
     route: [{lat, lon, radius}], progress: {lastReachedIndex, nextIndex, awaitingDepartureIndex}, pos: {lat, lon}
     Returnerar null om inget behöver ändras, annars
     { passed: [index], lastReachedIndex, nextIndex, departedDuringGap: index|null }. Går aldrig bakåt. */
  function planCatchUp(route, progress, pos) {
    if (!Array.isArray(route) || !progress || !pos) return null;
    const next = progress.nextIndex;
    if (next == null || next >= route.length) return null;
    const last = Math.max(0, progress.lastReachedIndex || 0);

    // 1. Inom radien för en station som ännu inte nåtts – den närmaste vinner
    let target = null;
    let best = Infinity;
    for (let j = next; j < route.length; j++) {
      const st = route[j];
      if (st.lat == null || st.lon == null) continue;
      const d = haversine(pos.lat, pos.lon, st.lat, st.lon);
      if (d <= (st.radius || DEFAULT_RADIUS) && d < best) {
        best = d;
        target = j;
      }
    }

    let newLast;
    let newNext;
    if (target != null) {
      if (target === next) return null;
      newLast = target - 1;
      newNext = target;
    } else {
      // 2. Närmaste delsträcka (rak linje mellan två stationer), från senast nådda och framåt
      let k = null;
      best = Infinity;
      for (let i = last; i < route.length - 1; i++) {
        const a = route[i];
        const b = route[i + 1];
        if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) continue;
        const d = distanceToSegment(pos, a, b);
        if (d < best) {
          best = d;
          k = i;
        }
      }
      if (k == null || k + 1 <= next) return null;
      newLast = k;
      newNext = k + 1;
    }

    const passed = [];
    for (let i = next; i < newNext; i++) passed.push(i);
    const a = progress.awaitingDepartureIndex;
    const departedDuringGap = (a != null && a < next) ? a : null;
    return { passed, lastReachedIndex: Math.max(last, newLast), nextIndex: newNext, departedDuringGap };
  }

  return {
    GAP_MS, MOVE_M, GRACE_MS,
    haversine, detectInterruption, isWithinInterruption, applyInterruptionWindows,
    markStationMissed, markDepartureUnknown, distanceToSegment, planCatchUp
  };
});
