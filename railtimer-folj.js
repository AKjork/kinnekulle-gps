/* RailTimer – Var är tåget? Följer ett tåg utan telefonens GPS, med Trafikverkets uppgifter.
   Två källor, som fungerar olika (André 2026-11-26):
   - Rapporterna (TrainAnnouncement): tåget har ankommit till eller avgått från en driftplats. På System M
     (till exempel Gårdsjö – Håkantorp) rapporteras bara vissa stationer, ofta i hela minuter, så mellan två
     rapporter vet man bara att tåget är någonstans mellan stationerna.
   - Tågpositionen (TrainPosition): fordonets egen GPS, samma som Trafikverkets tågkarta. Exakt, men inte alla tåg
     har den, och den kan vara några sekunder gammal.
   Appen visar aldrig ett exakt läge som den inte vet: utan färsk position säger den bara mellan vilka stationer
   tåget är. Passerade stationer får rapportens tid, eller en ungefärlig tid (ca) ur positionerna.
   Rena funktioner utan beroenden. Används av index.html och testas med node --test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RailTimerFolj = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    posMaxAgeMs: 5 * 60000,   // äldre positioner används inte (samma som för mötande tåg i railtimer-info.js)
    offRouteM: 1500,          // längre än så från linjen: positionen gäller inte vår rutt (eller är fel)
    atM: 500,                 // så här nära stationens mitt räknas tåget som vid stationen
    passM: 400,               // i rörelse så här långt förbi stationens mitt har tåget lämnat den …
    passStandM: 1200,         // … och står det still, eller saknas farten, så här långt (det kan stå vid utfartssignalen)
    standKmh: 5,              // under så här står tåget still
    standMoveM: 30,           // utan fart: flyttat sig högst så här mellan två positioner = står still …
    standMinMs: 15000,        // … under minst så här lång tid
    backJumpM: 2000,          // en position så här långt bakom det tåget redan passerat räknas inte för var tåget är
    interpolateMaxMs: 4 * 60000, // ca-tid vid passage bara när positionerna före och efter är högst så här långt isär
    depLateMs: 3 * 60000      // ankomsten rapporterad men inte avgången, så här långt efter att tåget borde ha gått
  };

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  const num = v => v != null && v !== '' && Number.isFinite(Number(v));
  const hasPos = p => !!p && num(p.lat) && num(p.lon);
  // Avstånd från q till sträckan a–b och var på sträckan (0–1); a och b är [lat, lon, …]
  function project(q, a, b, lo, hi) {
    const R = 6371000, rad = Math.PI / 180, k = Math.cos(q.lat * rad);
    const ax = (a[1] - q.lon) * rad * k * R, ay = (a[0] - q.lat) * rad * R;
    const bx = (b[1] - q.lon) * rad * k * R, by = (b[0] - q.lat) * rad * R;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let f = L2 ? -(ax * dx + ay * dy) / L2 : 0;
    f = Math.max(lo != null ? lo : 0, Math.min(hi != null ? hi : 1, f));
    return { off: Math.hypot(ax + f * dx, ay + f * dy), f };
  }

  /* Linjen längs rutten: per sträcka spårets sträckning (legPaths[i] = [[lat, lon], …] från station i till i+1,
     till exempel kartans spår från OpenStreetMap) eller en rak linje mellan stationerna.
     Ger { pts: [[lat, lon, d]], len, stationD: [meter längs linjen per station], legKind: ['spår'|'rak'] }, eller null. */
  function buildRouteAxis(stations, legPaths) {
    const list = Array.isArray(stations) ? stations : [];
    if (list.length < 2 || !list.every(hasPos)) return null;
    const pts = [], stationD = [0], legKind = [];
    const push = (lat, lon) => {
      const last = pts[pts.length - 1];
      if (!last) { pts.push([lat, lon, 0]); return; }
      const dd = haversine(last[0], last[1], lat, lon);
      if (dd < 1) return;
      pts.push([lat, lon, last[2] + dd]);
    };
    push(Number(list[0].lat), Number(list[0].lon));
    for (let i = 0; i + 1 < list.length; i++) {
      const A = list[i], B = list[i + 1];
      let path = legPaths && Array.isArray(legPaths[i]) && legPaths[i].length >= 2 ? legPaths[i].filter(p => p && num(p[0]) && num(p[1])) : null;
      if (path && path.length >= 2) {
        // Åt rätt håll: börjar närmast A
        const f = path[0], l = path[path.length - 1];
        if (haversine(f[0], f[1], A.lat, A.lon) > haversine(l[0], l[1], A.lat, A.lon)) path = path.slice().reverse();
        // Spåret ska börja vid A och sluta vid B (som för kartan: högst 1,5 km bort)
        if (haversine(path[0][0], path[0][1], A.lat, A.lon) > 1500 || haversine(path[path.length - 1][0], path[path.length - 1][1], B.lat, B.lon) > 1500) path = null;
      } else path = null;
      if (path) {
        for (const p of path) push(Number(p[0]), Number(p[1]));
        legKind.push('spår');
      } else {
        push(Number(B.lat), Number(B.lon));
        legKind.push('rak');
      }
      stationD.push(pts[pts.length - 1][2]);
    }
    return { pts, len: pts[pts.length - 1][2], stationD, legKind };
  }

  /* Gångprofilernas linje (railtimer-info.js: buildAxis) för samma rutt: { pts, len, stations: { sig: d }, meas }.
     Stationerna utan läge där projiceras på linjen. Sträckor som är uppmätta räknas som spår. */
  function fromInfoAxis(axis, stations) {
    if (!axis || !Array.isArray(axis.pts) || axis.pts.length < 2 || !Array.isArray(stations) || stations.length < 2) return null;
    const stationD = stations.map(s => {
      if (s && s.sig && axis.stations && axis.stations[s.sig] != null) return axis.stations[s.sig];
      const loc = hasPos(s) ? locate(axis, s) : null;
      return loc && loc.off <= 1000 ? loc.d : null;
    });
    if (stationD.some(d => d == null)) return null;
    for (let i = 1; i < stationD.length; i++) if (stationD[i] < stationD[i - 1]) return null;
    const legKind = stationD.slice(1).map((d, i) => {
      for (let k = 0; k + 1 < axis.pts.length; k++) {
        if (axis.pts[k + 1][2] <= stationD[i] || axis.pts[k][2] >= d) continue;
        if (axis.meas && !axis.meas[k]) return 'rak';
      }
      return 'spår';
    });
    return { pts: axis.pts, len: axis.len != null ? axis.len : axis.pts[axis.pts.length - 1][2], stationD, legKind };
  }

  /* Läget p längs linjen: { d (meter), off (meter från linjen) } eller null. Före första och efter sista punkten
     förlängs linjen rakt, så att ett tåg på väg till startstationen får ett negativt d (avståndet dit). */
  function locate(axis, p) {
    const pts = axis && axis.pts;
    if (!Array.isArray(pts) || pts.length < 2 || !hasPos(p)) return null;
    const q = { lat: Number(p.lat), lon: Number(p.lon) };
    let best = null;
    const last = pts.length - 2;
    for (let k = 0; k + 1 < pts.length; k++) {
      const pr = project(q, pts[k], pts[k + 1], k === 0 ? -Infinity : 0, k === last ? Infinity : 1);
      if (!best || pr.off < best.off) best = { k, off: pr.off, f: pr.f };
    }
    const a = pts[best.k], b = pts[best.k + 1];
    return { d: a[2] + (b[2] - a[2]) * best.f, off: Math.round(best.off) };
  }

  // Senaste rapporten på linjen: { k, sig, kind: 'arr'|'dep', t, plan, delayMin, minute } eller null
  function latestReport(line) {
    let best = null;
    (line || []).forEach((l, k) => {
      for (const kind of ['arr', 'dep']) {
        const t = l && l[kind];
        if (t == null) continue;
        // Senast i linjens ordning; på samma plats avgången efter ankomsten
        if (!best || k > best.k || (k === best.k && kind === 'dep')) {
          const plan = kind === 'arr' ? (l.planArr != null ? l.planArr : l.planDep) : (l.planDep != null ? l.planDep : l.planArr);
          best = { k, sig: l.sig, kind, t, plan: plan != null ? plan : null,
            delayMin: plan != null ? Math.round((t - plan) / 60000) : null, minute: !!(l.minute && l.minute[kind]) };
        }
      }
    });
    return best;
  }

  /* Var tåget är.
     input: {
       route: [{ sig, name, lat, lon, planArr, planDep }] resans stationer i ordning, med planerade tider (ms)
       line: [{ sig, arr, dep, planArr, planDep, minute: { arr, dep } }]  vårt tågs alla platser mellan resans start och slut
                                                          i ordning (även driftplatser), med Trafikverkets rapporterade tider (ms)
       axis: buildRouteAxis/fromInfoAxis, eller null      linjen längs rutten
       pos: { lat, lon, t, speedKmh } eller null          tågets senaste position (TrainPosition)
       memo: föregående resultats memo, eller null        så att tåget aldrig går bakåt och för ca-tiderna
       now, opts
     }
     Ger {
       stations: [{ arr: { t, src: 'rapport'|'ca' } | null, dep: …, passed }],
       passedIdx (sista stationen tåget lämnat, −1 före start), atIdx (stationen tåget står vid, eller null), nextIdx (null vid slutet),
       done (framme i slutstationen), approaching (på väg till startstationen),
       distM (till nästa station, eller från stationen tåget är vid; null utan position), distKind: 'spår'|'rak',
       pos: { lat, lon, t, ageS, speedKmh, d, off, used, why } eller null, lastReport, between: [i, j] (när läget bara är känt
       mellan två stationer), unsure (stationen där bara ankomsten är rapporterad, långt efter avgången), source:
       'position'|'rapport'|'ingen', est: { idx, t, by: 'position'|'plan', behind } (beräknad ankomst till nästa station;
       by 'plan' med behind: tåget bör enligt tidtabellen redan ha passerat stationerna före idx), memo
     } */
  function follow(input) {
    const o = Object.assign({}, DEFAULTS, input && input.opts);
    const route = (input && input.route) || [];
    const n = route.length;
    if (n < 2) return null;
    const now = input.now != null ? input.now : Date.now();
    const line = Array.isArray(input.line) ? input.line : [];
    const axis = input.axis && Array.isArray(input.axis.stationD) && input.axis.stationD.length === n ? input.axis : null;
    const prev = input.memo || {};
    const memo = {
      passedIdx: prev.passedIdx != null ? prev.passedIdx : -1,
      maxD: prev.maxD != null ? prev.maxD : null,
      lastPos: prev.lastPos || null,
      standing: prev.standing || null,
      ca: Object.assign({}, prev.ca || {})
    };

    // Rapporterna per station i rutten (via signaturen) och på linjen
    const lineIdx = new Map();
    line.forEach((l, k) => { if (l && l.sig && !lineIdx.has(l.sig)) lineIdx.set(l.sig, k); });
    const routeLine = route.map(st => (st && st.sig && lineIdx.has(st.sig) ? lineIdx.get(st.sig) : null));
    const rep = route.map((st, i) => {
      const l = routeLine[i] != null ? line[routeLine[i]] : null;
      return { arr: l && l.arr != null ? l.arr : null, dep: l && l.dep != null ? l.dep : null };
    });
    rep[0].arr = null;
    rep[n - 1].dep = null;
    const last = latestReport(line);

    // Framsteg ur rapporterna: stationer före den senaste rapporten är passerade. Rapporterat på en driftplats
    // som inte är med i rutten: stationerna före den är passerade, nästa är stationen efter.
    let repPassed = -1, repAt = null;
    if (last) {
      for (let i = 0; i < n; i++) {
        const k = routeLine[i];
        if (k == null) continue;
        if (k < last.k || (k === last.k && last.kind === 'dep')) repPassed = Math.max(repPassed, i);
        else if (k === last.k && i > 0) repAt = i;
      }
    }
    // En station med rapporterad avgång är passerad, även om en senare rapport saknas
    for (let i = 0; i < n; i++) if (rep[i].dep != null) repPassed = Math.max(repPassed, i);
    /* Ankomsten rapporterad men inte avgången, långt efter att tåget borde ha gått (planerad eller Trafikverkets
       beräknade avgång + depLateMs): appen vet inte om tåget står kvar eller har gått (på System M rapporteras
       avgången inte alltid). Då säger den "vid eller efter" stationen, aldrig att tåget står där. */
    let unsureAt = null;
    if (repAt != null && repAt < n - 1) {
      const l = line[routeLine[repAt]] || {};
      const expected = Math.max(l.planDep != null ? l.planDep : -Infinity, l.estDep != null ? l.estDep : -Infinity, rep[repAt].arr + 30000);
      if (now > expected + o.depLateMs) unsureAt = repAt;
    }

    // Positionen
    let P = null;
    const p = input.pos;
    if (hasPos(p) && num(p.t)) {
      P = { lat: Number(p.lat), lon: Number(p.lon), t: Number(p.t), ageS: Math.max(0, Math.round((now - p.t) / 1000)),
        speedKmh: num(p.speedKmh) ? Number(p.speedKmh) : null, d: null, off: null, used: false, why: '' };
      if (now - P.t > o.posMaxAgeMs) P.why = 'gammal';
      else if (!axis) P.why = 'ingen linje';
      else {
        const loc = locate(axis, P);
        P.off = loc ? loc.off : null;
        if (!loc || loc.off > o.offRouteM) P.why = 'långt från linjen';
        else {
          P.d = loc.d;
          if (memo.maxD != null && loc.d < memo.maxD - o.backJumpM) P.why = 'bakom tåget';
          else P.used = true;
        }
      }
    }

    // Står tåget still? Farten, eller utan fart: samma ställe som förra positionen en stund
    let standing = false;
    if (P && P.used) {
      if (P.speedKmh != null) standing = P.speedKmh <= o.standKmh;
      else if (memo.lastPos && memo.lastPos.t < P.t && P.t - memo.lastPos.t >= o.standMinMs && Math.abs(P.d - memo.lastPos.d) <= o.standMoveM) standing = true;
    }
    const D = axis ? axis.stationD : null;
    let posPassed = -1, posAt = null, ahead = null, approaching = false;
    if (P && P.used) {
      const passM = P.speedKmh != null && P.speedKmh > o.standKmh ? o.passM : o.passStandM;
      for (let i = 0; i < n; i++) if (P.d > D[i] + passM) posPassed = i;
      for (let i = posPassed + 1; i < n; i++) {
        // Startstationen: tåget är där oavsett fart. Övriga, även slutstationen: bara när tåget står still.
        if (Math.abs(P.d - D[i]) <= o.atM && (standing || i === 0)) { posAt = i; break; }
      }
      // Första stationen framför tåget (för nästa station när tåget just åkt förbi en mitt)
      ahead = D.findIndex(x => x > P.d);
      if (ahead < 0) ahead = n;
      if (posPassed < 0 && P.d < D[0] - o.atM) approaching = true;
    }

    // Tåget går aldrig bakåt: det som en gång är passerat förblir passerat
    let passedIdx = Math.max(memo.passedIdx, repPassed, posPassed);
    let atIdx = null, unsure = false;
    if (repAt != null && repAt > passedIdx) {
      if (P && P.used) {
        // Rapporten säger att tåget kommit fram. Positionen avgör om det står kvar eller redan är på väg ut.
        const leaving = !standing && P.d > D[repAt] && posAt !== repAt;
        if (!leaving) atIdx = repAt;
      } else if (unsureAt === repAt) unsure = true;
      else atIdx = repAt;
    }
    if (posAt != null && posAt > passedIdx && (atIdx == null || posAt >= atIdx)) atIdx = posAt;
    // Slutstationen: ankomsten rapporterad, tåget står vid den, eller har passerat den
    const done = rep[n - 1].arr != null || atIdx === n - 1 || passedIdx >= n - 1;
    if (done) { atIdx = n - 1; passedIdx = Math.max(passedIdx, n - 2); unsure = false; }
    // Före avgång från start (ingen rapport, ingen position förbi): tåget står vid eller är på väg till startstationen
    if (!done && passedIdx < 0 && atIdx == null && !unsure && !(P && P.used && ahead > 0)) atIdx = 0;
    let nextIdx = null;
    if (!done) {
      if (atIdx != null) nextIdx = atIdx + 1;
      else if (unsure) nextIdx = repAt + 1;
      else nextIdx = Math.max(passedIdx + 1, P && P.used ? ahead : 0, repAt != null && repAt > passedIdx ? repAt + 1 : 0);
      nextIdx = Math.min(nextIdx, n - 1);
    }

    /* ca-tider ur positionerna, där rapporten saknas: när tåget passerar stationens mitt (mellan två positioner som
       ligger högst interpolateMaxMs isär), och vid ett stopp när tåget sågs stå där (första och sista positionen). */
    if (P && P.used) {
      const L = memo.lastPos;
      if (L && P.t > L.t && P.t - L.t <= o.interpolateMaxMs && P.d > L.d) {
        for (let i = 0; i < n; i++) {
          if (D[i] > L.d && D[i] <= P.d) {
            const t = Math.round(L.t + (D[i] - L.d) / (P.d - L.d) * (P.t - L.t));
            const c = memo.ca[i] || {};
            if (c.arr == null && i > 0) c.arr = t;
            if (c.dep == null && i < n - 1 && !(memo.standing && memo.standing.i === i)) c.dep = t;
            memo.ca[i] = c;
          }
        }
      }
      if (standing && posAt != null && posAt > 0) {
        const c = memo.ca[posAt] || {};
        if (!memo.standing || memo.standing.i !== posAt) {
          memo.standing = { i: posAt, first: P.t, last: P.t };
          // Tåget passerade mitten och stannade sedan: det var ankomsten, inte avgången
          c.dep = null;
        } else memo.standing.last = P.t;
        if (c.arr == null || c.arr > memo.standing.first) c.arr = memo.standing.first;
        memo.ca[posAt] = c;
      } else if (memo.standing && posPassed >= memo.standing.i) {
        // Tåget stod vid stationen och har lämnat den: avgången mellan sista stillastående och första positionen därefter
        const s = memo.standing;
        const c = memo.ca[s.i] || {};
        if (c.dep == null && s.i < n - 1 && P.t - s.last <= o.interpolateMaxMs) c.dep = Math.round((s.last + P.t) / 2);
        memo.ca[s.i] = c;
        memo.standing = null;
      }
      memo.lastPos = { d: P.d, t: P.t };
      memo.maxD = memo.maxD == null ? P.d : Math.max(memo.maxD, P.d);
    }
    memo.passedIdx = passedIdx;

    const stations = route.map((st, i) => {
      const c = memo.ca[i] || {};
      const passed = i <= passedIdx || (done && i === n - 1);
      const arr = rep[i].arr != null ? { t: rep[i].arr, src: 'rapport' } : (i > 0 && c.arr != null && (passed || atIdx === i) ? { t: c.arr, src: 'ca' } : null);
      const dep = rep[i].dep != null ? { t: rep[i].dep, src: 'rapport' } : (i < n - 1 && c.dep != null && passed ? { t: c.dep, src: 'ca' } : null);
      return { arr, dep, passed };
    });

    let distM = null;
    if (P && P.used) {
      const ref = atIdx != null ? atIdx : nextIdx;
      if (ref != null) distM = Math.max(0, Math.round(Math.abs(D[ref] - P.d)));
    }
    const refLeg = Math.max(0, Math.min(n - 2, (nextIdx != null ? nextIdx : n - 1) - 1));
    const distKind = axis && axis.legKind ? (axis.legKind[atIdx != null && atIdx < n - 1 ? atIdx : refLeg] || 'rak') : 'rak';
    const source = P && P.used ? 'position' : (last ? 'rapport' : 'ingen');

    /* Beräknad ankomst till nästa station (aldrig före nu).
       Med position: resten av sträckan i planerad gångtid, räknat från positionens tid.
       Utan position: tidtabellen plus förseningen vid senaste rapporten. På System M rapporteras bara vissa
       stationer, så tåget kan ha passerat flera stationer sedan dess utan att det syns. Den första station som
       tåget enligt det inte hunnit till är nästa enligt plan (est.idx); stationerna före den räknas inte som passerade. */
    const planOf = (i, kind) => {
      const st = route[i] || {};
      const a = num(st.planArr) ? Number(st.planArr) : null, d = num(st.planDep) ? Number(st.planDep) : null;
      return kind === 'arr' ? (a != null ? a : d) : (d != null ? d : a);
    };
    let est = null;
    if (!done && nextIdx != null) {
      if (source === 'position' && atIdx == null && nextIdx > 0) {
        const a = nextIdx - 1, b = nextIdx;
        const run = planOf(b, 'arr') != null && planOf(a, 'dep') != null ? planOf(b, 'arr') - planOf(a, 'dep') : null;
        const len = D[b] - D[a];
        if (run > 0 && len > 0) {
          const f = Math.max(0, Math.min(1, (P.d - D[a]) / len));
          est = { idx: b, t: Math.max(now, Math.round(P.t + (1 - f) * run)), by: 'position' };
        }
      } else if (source !== 'position' && last && last.delayMin != null) {
        const delay = Math.max(0, last.t - (last.plan != null ? last.plan : last.t));
        const from = atIdx != null ? atIdx + 1 : nextIdx;
        for (let i = from; i < n; i++) {
          const pa = planOf(i, 'arr');
          if (pa == null) continue;
          const t = pa + delay;
          if (t > now || i === n - 1) { est = { idx: i, t: Math.max(now, t), by: 'plan', delayMin: Math.round(delay / 60000), behind: i > from }; break; }
        }
      }
    }
    // Utan position mellan två stationer: bara att tåget är någonstans där
    const between = !done && atIdx == null && nextIdx != null && nextIdx > 0 && source !== 'position' ? [nextIdx - 1, nextIdx] : null;
    return { stations, passedIdx, atIdx, nextIdx, done, approaching: approaching && atIdx === 0, distM, distKind,
      pos: P, lastReport: last, between, unsure: unsure ? repAt : null, source, est, memo };
  }

  return { DEFAULTS, buildRouteAxis, fromInfoAxis, locate, latestReport, follow, haversine };
});
