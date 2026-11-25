/* RailTimer – infofliken: läget framåt under resan.
   Bygger på Trafikverkets TrainAnnouncement för vårt tåg och för alla tåg på resten av linjen:
   - möten: motgående tåg som enligt tidtabell är på samma plats som vi samtidigt. På enkelspår kan
     vi inte åka vidare förrän det mötande tåget har kommit in, så är det sent blir vi sena.
   - enkel- eller dubbelspår räknas ur tidtabellen: två motgående tåg som enligt tidtabell är på samma
     sträcka samtidigt möts mellan stationerna, och då är sträckan dubbelspår.
   - prognos per plats längs resan: våra egna tider, uppehåll, annonserad avgångstid, mötena och
     de egna gångtiderna från tidigare körningar (så mycket vi brukar ta igen).
   - anslutningar i slutstationen och tåg som ansluter till oss i startstationen.
   - avvikelser för vårt tåg (t.ex. Spårändrat) och störningar (OperativeEvent) längs vägen.
   Rena funktioner utan beroenden. Används av index.html och testas med node --test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RailTimerInfo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60000;
  const DEFAULTS = {
    meetMarginMs: 60000,      // vi kan avgå tidigast så här länge efter att det mötande tåget kommit in
    minDwellMs: 30000,        // kortaste uppehåll vid ett annonserat stopp när vi är sena
    transferMin: 4,           // minsta bytestid (ändras per station i fliken)
    tightMarginMin: 2,        // upp till så här mycket över bytestiden räknas bytet som knappt
    connectionWindowMin: 40,  // anslutningar som enligt tidtabell går högst så här länge efter vår ankomst
    minPlannedTransferMin: 2, // tåg som enligt tidtabell går tidigare än så efter vår ankomst är inga anslutningar
    incomingWindowMin: 30,    // tåg som ansluter till oss: ankomst högst så här länge före vår avgång
    lineOverlapMs: 60000,     // motgående tåg på samma sträcka samtidigt så här länge = möte mellan stationerna
    recoveryMinRatio: 0.85,   // egna gångtider får korta planerad gångtid högst så här mycket
    historyMinObs: 3,         // egna gångtider räknas från så här många mätningar
    maxConnections: 8
  };

  // ── Hjälpfunktioner ──
  function ms(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  // Text ur Trafikverkets listor: [{ Code, Description }] eller ["text"]
  function texts(list) {
    if (!Array.isArray(list)) return [];
    return list.map(x => typeof x === 'string' ? x : (x && (x.Description || x.LocationName || x.Code)) || '').filter(Boolean);
  }
  // Signaturer ur ToLocation/FromLocation: [{ LocationName: 'G', Priority, Order }] eller ["G"]
  function sigsOf(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map(x => typeof x === 'string' ? { s: x, o: 0 } : { s: x && x.LocationName, o: (x && x.Order) || 0 })
      .filter(x => x.s)
      .sort((a, b) => a.o - b.o)
      .map(x => x.s);
  }
  const sectionKey = (a, b) => [a, b].sort().join('|');
  const median = arr => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const roundMin = v => v == null ? null : Math.round(v / MIN);

  // Svensk tid utan tidszon (ÅÅÅÅ-MM-DDTHH:MM:SS), som Trafikverket tolkar tider i frågor – oavsett telefonens tidszon
  let stockholm = null;
  function localIso(t) {
    const d = new Date(t);
    try {
      if (!stockholm) {
        stockholm = new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        });
      }
      const p = {};
      for (const part of stockholm.formatToParts(d)) p[part.type] = part.value;
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
    } catch (e) {
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
  }
  const xmlAttr = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

  // ── Frågor till Trafikverket ──
  const ANNOUNCEMENT_FIELDS = [
    'ActivityType', 'Advertised', 'AdvertisedTimeAtLocation', 'AdvertisedTrainIdent', 'Canceled',
    'DepartureDateOTN', 'Deviation', 'EstimatedTimeAtLocation', 'FromLocation', 'LocationDateTimeOTN',
    'LocationSignature', 'OperationalTrainNumber', 'PlannedEstimatedTimeAtLocation',
    'PlannedEstimatedTimeAtLocationIsValid', 'ProductInformation', 'TimeAtLocation',
    'TimeAtLocationWithSeconds', 'ToLocation', 'TrackAtLocation'
  ];
  /* Utan de fält som inte är provade mot det riktiga API:et (tågorderns tid och planerad försening).
     Godtar Trafikverket inte frågan med alla fält frågar appen igen med de här, som fetchTimetable gör
     sedan 2026-11-25g. Driftstiden blir då den annonserade tiden. */
  const SAFE_ANNOUNCEMENT_FIELDS = ANNOUNCEMENT_FIELDS.filter(f => !/^(LocationDateTimeOTN|PlannedEstimatedTimeAtLocation)/.test(f));
  const includes = fields => (fields || ANNOUNCEMENT_FIELDS).map(f => `<INCLUDE>${f}</INCLUDE>`).join('');

  function request(apiKey, queries) {
    return `<REQUEST><LOGIN authenticationkey="${xmlAttr(apiKey)}" />${queries.join('')}</REQUEST>`;
  }
  // Vårt tåg, alla platser, ±12 h kring `at` (körningen väljs med nearestRun)
  function queryOurTrain(otn, at, fields) {
    return `<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="1000"><FILTER><AND>` +
      `<EQ name="OperationalTrainNumber" value="${xmlAttr(otn)}" />` +
      `<GTE name="AdvertisedTimeAtLocation" value="${localIso(at - 12 * 3600000)}" />` +
      `<LTE name="AdvertisedTimeAtLocation" value="${localIso(at + 12 * 3600000)}" />` +
      `</AND></FILTER>${includes(fields)}</QUERY>`;
  }
  // Alla tåg på platserna (resten av vår linje) i tidsfönstret
  function queryLine(sigs, from, to, fields) {
    const or = sigs.map(s => `<EQ name="LocationSignature" value="${xmlAttr(s)}" />`).join('');
    return `<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="4000"><FILTER><AND>` +
      `<OR>${or}</OR>` +
      `<GTE name="AdvertisedTimeAtLocation" value="${localIso(from)}" />` +
      `<LTE name="AdvertisedTimeAtLocation" value="${localIso(to)}" />` +
      `</AND></FILTER>${includes(fields)}</QUERY>`;
  }
  // Namn för signaturer som inte finns i appens stationslista (driftplatser utan resandeutbyte)
  function queryNames(sigs) {
    const or = sigs.map(s => `<EQ name="LocationSignature" value="${xmlAttr(s)}" />`).join('');
    return `<QUERY objecttype="TrainStation" schemaversion="1.4"><FILTER><OR>${or}</OR></FILTER>` +
      `<INCLUDE>LocationSignature</INCLUDE><INCLUDE>AdvertisedLocationName</INCLUDE></QUERY>`;
  }
  /* Pågående störningar och banarbeten. TrainMessage finns inte längre (Trafikverket 2026-11-25:
     "ObjectType 'TrainMessage' does not exists"); ersättaren är OperativeEvent 1.0 i namespace ols.open,
     EventState 1 = pågår. Samma fråga som kontrollsidan api-koll.html. */
  function queryMessages() {
    return `<QUERY namespace="ols.open" objecttype="OperativeEvent" schemaversion="1.0" limit="2000">` +
      `<FILTER><EQ name="EventState" value="1" /></FILTER></QUERY>`;
  }
  // RESULT[i] ur svaret, eller ett fel
  function resultOf(data, i, type) {
    const r = data && data.RESPONSE && Array.isArray(data.RESPONSE.RESULT) ? data.RESPONSE.RESULT[i] : null;
    if (!r) return { error: 'Tomt svar' };
    if (r.ERROR) return { error: r.ERROR.MESSAGE || 'Fel i frågan' };
    return { list: Array.isArray(r[type]) ? r[type] : [] };
  }

  // ── Tolkning av svaren ──
  function parseAnnouncement(a) {
    if (!a || !a.LocationSignature || !a.ActivityType) return null;
    const adv = ms(a.AdvertisedTimeAtLocation);
    if (adv == null) return null;
    const planEst = a.PlannedEstimatedTimeAtLocationIsValid ? ms(a.PlannedEstimatedTimeAtLocation) : null;
    return {
      otn: String(a.OperationalTrainNumber || a.AdvertisedTrainIdent || ''),
      ident: String(a.AdvertisedTrainIdent || a.OperationalTrainNumber || ''),
      date: String(a.DepartureDateOTN || '').slice(0, 10),
      sig: a.LocationSignature,
      kind: a.ActivityType === 'Ankomst' ? 'arr' : 'dep',
      adv,
      plan: ms(a.LocationDateTimeOTN) != null ? ms(a.LocationDateTimeOTN) : adv, // driftstid, annars annonserad
      est: ms(a.EstimatedTimeAtLocation) != null ? ms(a.EstimatedTimeAtLocation) : planEst,
      actual: ms(a.TimeAtLocationWithSeconds) != null ? ms(a.TimeAtLocationWithSeconds) : ms(a.TimeAtLocation),
      canceled: !!a.Canceled,
      advertised: !!a.Advertised,
      track: a.TrackAtLocation || '',
      deviations: texts(a.Deviation),
      product: texts(a.ProductInformation)[0] || '',
      to: sigsOf(a.ToLocation),
      from: sigsOf(a.FromLocation)
    };
  }

  // Tåg per tågnummer och avgångsdatum: { key, otn, ident, date, product, to, from, at: Map(sig → { arr, dep }) }
  function groupTrains(rawList) {
    const trains = new Map();
    for (const raw of rawList || []) {
      const r = raw && raw.sig ? raw : parseAnnouncement(raw);
      if (!r) continue;
      const key = `${r.otn}|${r.date}`;
      let tr = trains.get(key);
      if (!tr) {
        tr = { key, otn: r.otn, ident: r.ident, date: r.date, product: '', to: [], from: [], at: new Map() };
        trains.set(key, tr);
      }
      if (!tr.product && r.product) tr.product = r.product;
      if (!tr.to.length && r.to.length) tr.to = r.to;
      if (!tr.from.length && r.from.length) tr.from = r.from;
      if (!tr.at.has(r.sig)) tr.at.set(r.sig, { arr: null, dep: null });
      tr.at.get(r.sig)[r.kind] = r;
    }
    return trains;
  }

  // Körningen (avgångsdatum) vars annonserade tider ligger närmast `at`
  function nearestRun(trains, otn, at) {
    let best = null, bestD = Infinity;
    for (const tr of trains.values()) {
      if (tr.otn !== String(otn)) continue;
      let lo = Infinity, hi = -Infinity;
      for (const loc of tr.at.values()) for (const r of [loc.arr, loc.dep]) if (r) { lo = Math.min(lo, r.adv); hi = Math.max(hi, r.adv); }
      const d = at < lo ? lo - at : (at > hi ? at - hi : 0);
      if (d < bestD) { best = tr; bestD = d; }
    }
    return best;
  }

  const planArr = loc => loc.arr ? loc.arr.plan : (loc.dep ? loc.dep.plan : null);
  const planDep = loc => loc.dep ? loc.dep.plan : (loc.arr ? loc.arr.plan : null);
  const advArrOf = loc => loc.arr ? loc.arr.adv : (loc.dep ? loc.dep.adv : null);

  /* Vår linje: vårt tågs platser i tidsordning från start till slut, även platser där tåget bara passerar
     (driftplatser utan resandeutbyte, där möten också kan ligga). */
  function buildLine(our, startSig, endSig) {
    if (!our) return [];
    const all = [];
    for (const [sig, loc] of our.at) {
      const t = planArr(loc) != null ? planArr(loc) : planDep(loc);
      if (t == null) continue;
      all.push({
        sig,
        arr: loc.arr, dep: loc.dep,
        plannedArr: loc.arr ? loc.arr.plan : null,
        plannedDep: loc.dep ? loc.dep.plan : null,
        advArr: loc.arr ? loc.arr.adv : null,
        advDep: loc.dep && loc.dep.advertised ? loc.dep.adv : null,
        stop: !!((loc.arr && loc.arr.advertised) || (loc.dep && loc.dep.advertised)),
        t
      });
    }
    all.sort((a, b) => a.t - b.t);
    let s = all.findIndex(l => l.sig === startSig);
    let e = all.findIndex(l => l.sig === endSig);
    if (s < 0) s = 0;
    if (e < 0) e = all.length - 1;
    if (e < s) return [];
    const line = all.slice(s, e + 1);
    // Startstationens ankomst och slutstationens avgång hör inte till resan
    if (line.length) {
      line[0] = Object.assign({}, line[0], { plannedArr: null, advArr: null, arr: null });
      const last = line.length - 1;
      line[last] = Object.assign({}, line[last], { plannedDep: null, advDep: null, dep: null });
    }
    return line;
  }

  /* Var ett motgående tåg möter oss enligt tidtabell (driftstider).
     kind 'station': båda är på platsen i samtidigt; 'line': de möts mellan i och j (dubbelspår);
     'unknown': mellan i och j men tåget har inga tider på platserna emellan. null: inget möte på vår linje. */
  function crossingOf(line, tr, idxOf, opts) {
    const pts = [];
    for (const [sig, loc] of tr.at) {
      const i = idxOf.get(sig);
      if (i == null) continue;
      const a = planArr(loc), d = planDep(loc);
      if (a == null || d == null) continue;
      pts.push({ i, a, d });
    }
    if (pts.length < 2) return null;
    pts.sort((x, y) => x.i - y.i);
    if (!(pts[0].a > pts[pts.length - 1].a)) return null; // inte motgående
    let prev = null;
    for (const p of pts) {
      const L = line[p.i];
      const oa = L.plannedArr != null ? L.plannedArr : L.plannedDep;
      const od = L.plannedDep != null ? L.plannedDep : L.plannedArr;
      if (oa == null || od == null) return null;
      let rel;
      if (od < p.a) rel = 'before';      // vi lämnar platsen innan de kommer
      else if (p.d < oa) rel = 'after';  // de har lämnat platsen innan vi kommer
      else rel = 'overlap';
      if (rel === 'overlap') return { kind: 'station', i: p.i, maxIdx: pts[pts.length - 1].i };
      if (rel === 'after') {
        if (!prev) return null; // möts före vår startstation
        if (p.i === prev.i + 1) {
          const ourOn = [line[prev.i].plannedDep, line[p.i].plannedArr];
          const theirOn = [p.d, prev.a];
          const overlap = Math.min(ourOn[1], theirOn[1]) - Math.max(ourOn[0], theirOn[0]);
          if (overlap >= opts.lineOverlapMs) return { kind: 'line', i: prev.i, j: p.i };
        }
        return { kind: 'unknown', i: prev.i, j: p.i };
      }
      prev = p;
    }
    return null; // möts efter vår slutstation
  }

  // Senast kända avvikelse för ett tåg: faktisk tid mot driftstid vid den senaste platsen tåget rapporterats på
  function latestDelay(tr) {
    let best = null;
    for (const loc of tr.at.values()) {
      for (const r of [loc.arr, loc.dep]) {
        if (r && r.actual != null && (!best || r.actual > best.actual)) best = r;
      }
    }
    return best ? { delay: best.actual - best.plan, at: best.actual, sig: best.sig } : null;
  }

  /* När det mötande tåget kommer in på platsen: faktisk tid, Trafikverkets beräknade tid,
     senast kända försening framräknad, eller tidtabellen. Aldrig tidigare än nu om det inte kommit. */
  function theirArrival(tr, sig, now) {
    const loc = tr.at.get(sig);
    if (!loc) return null;
    const row = loc.arr || loc.dep;
    const planned = row.plan;
    const advPlanned = row.adv;
    if (loc.arr && loc.arr.actual != null) return { t: loc.arr.actual, source: 'faktisk', planned, advPlanned, arrived: true };
    if (loc.dep && loc.dep.actual != null) return { t: loc.dep.actual, source: 'faktisk', planned, advPlanned, arrived: true, departed: true };
    let t = null, source = 'plan';
    if (row.est != null) { t = row.est; source = 'trafikverket'; }
    else {
      const ld = latestDelay(tr);
      if (ld && ld.delay > 0) { t = planned + ld.delay; source = 'senast'; }
      else t = planned;
    }
    return { t: Math.max(t, now), source, planned, advPlanned, arrived: false };
  }

  // ── Egna gångtider ──
  /* Median för verklig gångtid (avgång A → ankomst B) per stationspar ur appens egna körningar.
     Nyckel: "a>b" med små bokstäver. */
  function historyMedians(logs) {
    const runs = new Map();
    for (const log of logs || []) {
      const stops = Array.isArray(log && log.stops) ? log.stops : [];
      for (let i = 0; i + 1 < stops.length; i++) {
        const A = stops[i], B = stops[i + 1];
        if (!A || !B || B.excludeInboundRun) continue;
        const d = ms(A.actualDeparture), a = ms(B.actualArrival);
        if (d == null || a == null) continue;
        const run = a - d;
        if (!(run > 0 && run < 3 * 3600000)) continue;
        const key = `${String(A.name || '').trim().toLowerCase()}>${String(B.name || '').trim().toLowerCase()}`;
        if (!runs.has(key)) runs.set(key, []);
        runs.get(key).push(run);
      }
    }
    const out = new Map();
    for (const [k, v] of runs) out.set(k, { median: median(v), n: v.length });
    return out;
  }

  /* Faktor per sträcka i linjen (≤ 1): så mycket kortare än planerat vi brukar köra mellan två stationer
     i vår rutt. Gäller alla delsträckor mellan stationerna. */
  function recoveryRatios(line, routeNames, history, opts) {
    const ratios = line.map(() => 1);
    let obs = 0;
    if (!history || !history.size) return { ratios, obs };
    const marks = [];
    line.forEach((l, i) => { if (routeNames.has(l.sig)) marks.push(i); });
    for (let k = 0; k + 1 < marks.length; k++) {
      const ia = marks[k], ib = marks[k + 1];
      const A = line[ia], B = line[ib];
      const P = (B.plannedArr != null ? B.plannedArr : B.plannedDep) - (A.plannedDep != null ? A.plannedDep : A.plannedArr);
      const h = history.get(`${routeNames.get(A.sig).trim().toLowerCase()}>${routeNames.get(B.sig).trim().toLowerCase()}`);
      if (!(P > 0) || !h || h.n < opts.historyMinObs) continue;
      const r = clamp(h.median / P, opts.recoveryMinRatio, 1);
      for (let i = ia; i < ib; i++) ratios[i] = r;
      obs = Math.max(obs, h.n);
    }
    return { ratios, obs };
  }

  // Planerad gångtid från plats i till i+1 (driftstider)
  function plannedRun(line, i) {
    const A = line[i], B = line[i + 1];
    const from = A.plannedDep != null ? A.plannedDep : A.plannedArr;
    const to = B.plannedArr != null ? B.plannedArr : B.plannedDep;
    const run = to - from;
    return run > 0 ? run : (run === 0 ? 0 : 60000);
  }

  // ── Prognosen ──
  /* Vår beräknade ankomst och avgång vid varje plats. known: index → { arr, dep } (verkliga tider).
     Platser vi inte nått än ligger aldrig före nu. */
  function predict(line, known, meetingsAt, ratios, now, opts) {
    const n = line.length;
    let f = -1;
    for (let i = 0; i < n; i++) if (known[i] && (known[i].arr != null || known[i].dep != null)) f = i;
    const preds = [];
    for (let i = 0; i < n; i++) {
      const L = line[i], K = known[i] || {};
      const p = { arr: null, dep: null, base: null, waitMs: 0 };
      if (i < f) { p.arr = K.arr != null ? K.arr : null; p.dep = K.dep != null ? K.dep : null; preds.push(p); continue; }
      if (i > 0) {
        if (K.arr != null) p.arr = K.arr;
        else if (i > f) {
          const prev = preds[i - 1];
          const base = prev.dep != null ? prev.dep : (prev.arr != null ? prev.arr : now);
          p.arr = Math.max(base + plannedRun(line, i - 1) * ratios[i - 1], now);
        }
      }
      if (i < n - 1) {
        if (K.dep != null) p.dep = K.dep;
        else {
          let dep = p.arr != null ? p.arr + (L.stop ? opts.minDwellMs : 0) : -Infinity;
          if (L.advDep != null) dep = Math.max(dep, L.advDep);
          if (!Number.isFinite(dep)) dep = L.plannedDep != null ? L.plannedDep : now;
          dep = Math.max(dep, now);
          p.base = dep;
          for (const m of meetingsAt.get(i) || []) {
            if (!m.dependent) continue;
            const need = m.their.t + opts.meetMarginMs;
            if (need > dep) dep = need;
          }
          for (const m of meetingsAt.get(i) || []) {
            m.ourDep = dep;
            m.waitMs = m.dependent ? Math.max(0, Math.min(dep, m.their.t + opts.meetMarginMs) - p.base) : 0;
          }
          p.waitMs = dep - p.base;
          p.dep = dep;
        }
      }
      preds.push(p);
    }
    return { preds, frontier: f };
  }

  // ── Anslutningar ──
  // Tåget går (eller kommer) längs vår linje, alltså ingen anslutning
  function alongOurLine(tr, lineSigs, exceptSig) {
    if (tr.to.some(s => s !== exceptSig && lineSigs.has(s))) return true;
    if (tr.from.some(s => s !== exceptSig && lineSigs.has(s))) return true;
    for (const sig of tr.at.keys()) if (sig !== exceptSig && lineSigs.has(sig)) return true;
    return false;
  }

  function connectionStatus(transferMin, minTransfer, tight) {
    if (transferMin < minTransfer) return 'missas';
    if (transferMin < minTransfer + tight) return 'knappt';
    return 'ok';
  }

  // Tåg som går från slutstationen efter vår ankomst
  function outgoing(trains, our, endL, predArr, arrived, lineSigs, now, o) {
    const out = [];
    const ourAdv = endL.advArr != null ? endL.advArr : endL.plannedArr;
    if (ourAdv == null) return out;
    for (const tr of trains.values()) {
      if (tr.otn === our.otn) continue;
      const loc = tr.at.get(endL.sig);
      const dep = loc && loc.dep;
      if (!dep || !dep.advertised) continue;
      // En anslutning går minst bytestiden efter vår ankomst enligt tidtabell
      const plannedTransfer = (dep.adv - ourAdv) / MIN;
      if (plannedTransfer < Math.max(o.minPlannedTransferMin, o.transferMin) || plannedTransfer > o.connectionWindowMin) continue;
      if (alongOurLine(tr, lineSigs, endL.sig)) continue;
      const departed = dep.actual != null;
      // Inte avgått: Trafikverkets beräknade tid (aldrig före nu), annars tidtabellen
      const theirDep = departed ? dep.actual : (dep.est != null ? Math.max(dep.est, now) : dep.adv);
      const transfer = (theirDep - predArr) / MIN;
      let status;
      if (dep.canceled) status = 'inställt';
      else if (departed && !arrived) status = 'avgått';
      else status = connectionStatus(transfer, o.transferMin, o.tightMarginMin);
      out.push({
        otn: tr.otn, ident: tr.ident, product: tr.product, to: tr.to,
        adv: dep.adv, dep: theirDep, delayMin: roundMin(theirDep - dep.adv), track: dep.track,
        transferMin: Math.floor(transfer), plannedTransferMin: Math.round(plannedTransfer), status,
        source: departed ? 'faktisk' : (dep.est != null ? 'trafikverket' : 'plan')
      });
    }
    out.sort((a, b) => a.adv - b.adv);
    return out.slice(0, o.maxConnections);
  }

  // Tåg som kommer till startstationen före vår avgång (resenärer som ska byta till oss)
  function incoming(trains, our, startL, predDep, lineSigs, now, o) {
    const out = [];
    const ourAdv = startL.advDep != null ? startL.advDep : startL.plannedDep;
    if (ourAdv == null) return out;
    for (const tr of trains.values()) {
      if (tr.otn === our.otn) continue;
      const loc = tr.at.get(startL.sig);
      const arr = loc && loc.arr;
      if (!arr || !arr.advertised) continue;
      const plannedTransfer = (ourAdv - arr.adv) / MIN;
      if (plannedTransfer < Math.max(o.minPlannedTransferMin, o.transferMin) || plannedTransfer > o.incomingWindowMin) continue;
      if (alongOurLine(tr, lineSigs, startL.sig)) continue;
      const arrived = arr.actual != null;
      const theirArr = arrived ? arr.actual : Math.max(arr.est != null ? arr.est : arr.adv, now);
      const transfer = (predDep - theirArr) / MIN;
      out.push({
        otn: tr.otn, ident: tr.ident, product: tr.product, from: tr.from,
        adv: arr.adv, arr: theirArr, delayMin: roundMin(theirArr - arr.adv), track: arr.track,
        transferMin: Math.floor(transfer), arrived,
        status: arr.canceled ? 'inställt' : connectionStatus(transfer, o.transferMin, o.tightMarginMin),
        source: arrived ? 'faktisk' : (arr.est != null ? 'trafikverket' : 'plan')
      });
    }
    out.sort((a, b) => a.adv - b.adv);
    return out.slice(0, o.maxConnections);
  }

  // ── Störningar (OperativeEvent) ──
  // Alla stationssignaturer i en post, på vilken nivå som helst (Signature, LocationSignature) – som i railtimer-trv.js
  function signaturesIn(value, out) {
    const found = out || [];
    if (Array.isArray(value)) value.forEach(v => signaturesIn(v, found));
    else if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) {
        const v = value[k];
        if ((k === 'Signature' || k === 'LocationSignature') && typeof v === 'string') found.push(v);
        else signaturesIn(v, found);
      }
    }
    return found;
  }
  /* En händelse: rubrik och text från det senast ändrade publika meddelandet (TrafficImpact.PublicMessage),
     annars händelsetypen, som i api-koll.html. Sluttiden är den senaste i påverkan eller händelsen. */
  function parseMessage(m) {
    if (!m || m.Deleted) return null;
    const impacts = Array.isArray(m.TrafficImpact) ? m.TrafficImpact : [];
    const pms = impacts.map(t => t && t.PublicMessage).filter(Boolean)
      .sort((a, b) => String(b.ModifiedDateTime || '').localeCompare(String(a.ModifiedDateTime || '')));
    const pm = pms[0] || {};
    const sigs = new Set(signaturesIn(m));
    // Äldre form (TrainMessage): AffectedLocation som lista med signaturer
    for (const imp of impacts.concat([m])) {
      for (const a of Array.isArray(imp && imp.AffectedLocation) ? imp.AffectedLocation : []) if (typeof a === 'string') sigs.add(a);
    }
    const ends = impacts.map(t => ms(t && t.EndDateTime)).concat([ms(m.PrognosticatedEndDateTimeTrafficImpact), ms(m.EndDateTime)]).filter(v => v != null);
    const header = pm.Header || m.Header || (m.EventType && m.EventType.Description) || texts(m.ReasonCode)[0] || 'Trafikhändelse';
    const type = String((m.EventType && m.EventType.Description) || '').replace(/\s+/g, ' ').trim();
    const out = {
      id: String(m.Id || m.EventId || m.EventID || header),
      header: String(header).replace(/\s+/g, ' ').trim(),
      type,
      text: String(pm.Description || m.ExternalDescription || '').replace(/\s+/g, ' ').trim(),
      start: ms(m.StartDateTime),
      end: ends.length ? Math.max.apply(null, ends) : null,
      sigs: Array.from(sigs)
    };
    out.planned = PLANNED_WORK.test(`${out.type} ${out.header}`);
    Object.defineProperty(out, 'raw', { value: m, enumerable: false }); // originalet, för att spara i körningen
    return out;
  }
  /* Planerade arbeten (banarbete, spårarbete, underhåll): tidtabellen räknar redan med dem. Påverkar ett arbete
     vårt tåg syns det i vårt tågs annonseringar (avvikelse, inställt), inte här. 2026-11-25: ett banarbete som
     inte rörde tåg 13346 visades i infofliken. */
  const PLANNED_WORK = /arbete|underhåll/i;

  /* Händelser som berör resten av vår linje, med varför de andra inte visas (hidden: { …, reason }).
     En händelse berör oss när minst två av dess platser ligger på vår linje (en sträcka vi kör), eller när den
     bara har en plats och den ligger på vår linje (t.ex. signalfel i Vara). En händelse med en plats på vår linje
     och andra utanför gäller en annan bana (t.ex. Herrljunga – Alingsås). */
  function classifyMessages(messages, sigs, now, until) {
    const shown = [], hidden = [];
    for (const raw of messages || []) {
      const m = raw && raw.sigs ? raw : parseMessage(raw);
      if (!m) continue;
      const on = m.sigs.filter(s => sigs.has(s));
      if (!on.length) continue;
      const item = Object.assign({}, m, { sigs: on, allSigs: m.sigs });
      Object.defineProperty(item, 'raw', { value: m.raw, enumerable: false });
      let reason = null;
      if (!((m.start == null || m.start <= until) && (m.end == null || m.end >= now))) reason = 'inte under resan';
      else if (m.planned) reason = 'planerat arbete';
      else if (!(on.length >= 2 || new Set(m.sigs).size === 1)) reason = 'annan bana';
      if (reason) hidden.push(Object.assign(item, { reason }));
      else shown.push(item);
    }
    return { shown, hidden };
  }
  function messagesFor(messages, sigs, now, until) {
    return classifyMessages(messages, sigs, now, until).shown;
  }

  /* ── Allt för fliken ──
     input: { line, trains, ourKey, known: Map(sig → { arr, dep }), now, transferMin, knownDouble,
              history, routeNames: Map(sig → namn), messages, opts } */
  function compute(input) {
    const o = Object.assign({}, DEFAULTS, input.opts || {});
    if (input.transferMin != null) o.transferMin = input.transferMin;
    const now = input.now;
    const line = input.line || [];
    const trains = input.trains || new Map();
    const our = trains.get(input.ourKey) || { otn: '', at: new Map() };
    const n = line.length;
    if (n < 2) return null;
    const idxOf = new Map(line.map((l, i) => [l.sig, i]));
    const lineSigs = new Set(line.map(l => l.sig));
    const routeNames = input.routeNames || new Map();

    // Våra verkliga tider: appens egna (GPS eller manuellt) före Trafikverkets
    const known = line.map(l => {
      const own = input.known && input.known.get(l.sig);
      const trv = our.at.get(l.sig);
      return {
        arr: own && own.arr != null ? own.arr : (trv && trv.arr && trv.arr.actual != null ? trv.arr.actual : null),
        dep: own && own.dep != null ? own.dep : (trv && trv.dep && trv.dep.actual != null ? trv.dep.actual : null)
      };
    });
    known[0].arr = null;
    known[n - 1].dep = null;

    // Enkel- eller dubbelspår: möten mellan stationerna betyder dubbelspår
    const double = new Set(input.knownDouble || []);
    const newDouble = new Set();
    const raw = [];
    for (const tr of trains.values()) {
      if (tr.key === input.ourKey || tr.otn === our.otn) continue;
      const c = crossingOf(line, tr, idxOf, o);
      if (!c) continue;
      if (c.kind === 'line') {
        const k = sectionKey(line[c.i].sig, line[c.j].sig);
        if (!double.has(k)) newDouble.add(k);
        double.add(k);
      } else if (c.kind === 'station') raw.push({ tr, c });
    }

    // Plats vi senast har en tid för: möten där eller tidigare är passerade
    let frontier = -1;
    for (let i = 0; i < n; i++) if (known[i].arr != null || known[i].dep != null) frontier = i;

    const meetingsAt = new Map();
    const meetings = [];
    for (const { tr, c } of raw) {
      const i = c.i;
      if (i >= n - 1) continue;                         // vid slutstationen åker vi inte vidare
      if (i < frontier || (i === frontier && known[i].dep != null)) continue; // redan passerat
      const their = theirArrival(tr, line[i].sig, now);
      if (!their) continue;
      const sec = sectionKey(line[i].sig, line[i + 1].sig);
      const single = !double.has(sec);
      const loc = tr.at.get(line[i].sig);
      const nextLoc = tr.at.get(line[i + 1].sig);
      const canceled = !!((loc.arr && loc.arr.canceled) || (loc.dep && loc.dep.canceled) || (nextLoc && nextLoc.dep && nextLoc.dep.canceled));
      // Har det mötande tåget redan passerat en plats närmare oss är mötet flyttat
      let moved = false;
      for (let k = Math.max(frontier, 0); k < i; k++) {
        const l2 = tr.at.get(line[k].sig);
        if (l2 && ((l2.arr && l2.arr.actual != null) || (l2.dep && l2.dep.actual != null))) moved = true;
      }
      if (their.departed && !(known[i].arr != null)) moved = true;
      const m = {
        i, sig: line[i].sig, otn: tr.otn, ident: tr.ident, product: tr.product,
        their, theirDelayMin: roundMin(their.t - their.planned),
        single, canceled, moved,
        dependent: single && !canceled && !moved && c.maxIdx > i,
        waitMs: 0, ourDep: null
      };
      if (!meetingsAt.has(i)) meetingsAt.set(i, []);
      meetingsAt.get(i).push(m);
      meetings.push(m);
    }

    const rec = recoveryRatios(line, routeNames, input.history, o);
    const { preds } = predict(line, known, meetingsAt, rec.ratios, now, o);
    // Samma prognos utan egna gångtider: så mycket tar vi igen tack vare dem
    const plain = rec.obs ? predict(line, known, new Map(Array.from(meetingsAt, ([k, v]) => [k, v.map(m => Object.assign({}, m))])), line.map(() => 1), now, o).preds : preds;

    const endL = line[n - 1];
    const predArr = preds[n - 1].arr;
    const endAdv = endL.advArr != null ? endL.advArr : endL.plannedArr;
    const arrived = known[n - 1].arr != null;
    const endTrv = endL.arr && endL.arr.est != null ? endL.arr.est : null;
    const ourEnd = our.at.get(endL.sig);
    const end = {
      sig: endL.sig, adv: endAdv, predArr, arrived,
      delayMin: roundMin(predArr - endAdv),
      trvEst: ourEnd && ourEnd.arr && ourEnd.arr.est != null ? ourEnd.arr.est : endTrv,
      track: (ourEnd && ourEnd.arr && ourEnd.arr.track) || (endL.arr && endL.arr.track) || ''
    };
    const recoveryMin = rec.obs ? roundMin(plain[n - 1].arr - predArr) : 0;

    // Avvikelse nu: senaste verkliga tid mot annonserad (driftstid där annonserad saknas)
    let currentDelayMin = null;
    if (frontier >= 0) {
      const L = line[frontier], K = known[frontier];
      if (K.dep != null) currentDelayMin = roundMin(K.dep - (L.advDep != null ? L.advDep : L.plannedDep));
      else if (K.arr != null) currentDelayMin = roundMin(K.arr - (L.advArr != null ? L.advArr : L.plannedArr));
    }

    // Avvikelser för vårt tåg längre fram (Spårändrat, Inställt …)
    const deviations = [];
    const seen = new Set();
    for (let i = Math.max(frontier, 0); i < n; i++) {
      const loc = our.at.get(line[i].sig) || line[i];
      for (const r of [i === 0 ? null : loc.arr, i === n - 1 ? null : loc.dep]) {
        if (!r) continue;
        const list = r.deviations.slice();
        if (r.canceled && !list.some(t => /inställ/i.test(t))) list.push('Inställt');
        for (const text of list) {
          const k = `${line[i].sig}|${text}`;
          if (seen.has(k)) continue;
          seen.add(k);
          deviations.push({ i, sig: line[i].sig, text, kind: r.kind });
        }
      }
    }

    const remaining = new Set(line.slice(Math.max(frontier, 0)).map(l => l.sig));
    const cls = classifyMessages(input.messages, remaining, now, predArr);
    const messages = cls.shown;

    const startDeparted = known[0].dep != null;
    const conn = outgoing(trains, our, endL, predArr, arrived, lineSigs, now, o);
    const inc = startDeparted ? [] : incoming(trains, our, line[0], preds[0].dep, lineSigs, now, o);

    // Nivåer: 0 inget att göra, 1 håll koll, 2 påverkar
    // Väntan i hela minuter, samma som visas
    const lvlMeeting = m => (m.canceled || m.moved) ? 0 : (m.waitMin >= 5 ? 2 : (m.waitMin >= 1 ? 1 : 0));
    const lvlConn = c => (c.status === 'missas' || c.status === 'avgått') ? 2 : ((c.status === 'knappt' || c.status === 'inställt') ? 1 : 0);
    meetings.sort((a, b) => a.i - b.i);
    for (const m of meetings) { m.waitMin = roundMin(m.waitMs); m.level = lvlMeeting(m); }
    for (const c of conn) c.level = lvlConn(c);
    for (const c of inc) c.level = lvlConn(c);
    const endLevel = end.delayMin >= 6 ? 2 : (end.delayMin >= 2 ? 1 : 0);
    const levels = [endLevel].concat(meetings.map(m => m.level), conn.map(c => c.level), inc.map(c => c.level),
      deviations.map(() => 1), messages.map(() => 1));
    const attention = meetings.filter(m => m.level).length + conn.filter(c => c.level).length +
      inc.filter(c => c.level).length + deviations.length + messages.length;

    // Varför vi blir sena: det möte som kostar mest
    const worstMeeting = meetings.filter(m => m.waitMin >= 1).sort((a, b) => b.waitMs - a.waitMs)[0] || null;

    return {
      now, frontier, end, currentDelayMin, recoveryMin, recoveryObs: rec.obs,
      meetings, deviations, messages, messagesHidden: cls.hidden, connections: conn, incoming: startDeparted ? null : inc,
      preds: preds.map((p, i) => ({ sig: line[i].sig, arr: p.arr, dep: p.dep, waitMs: p.waitMs })),
      doubleSections: Array.from(newDouble),
      reason: worstMeeting ? { sig: worstMeeting.sig, otn: worstMeeting.ident || worstMeeting.otn, waitMin: worstMeeting.waitMin } : null,
      missed: conn.filter(c => c.level === 2).length,
      tight: conn.filter(c => c.level === 1).length,
      level: Math.max.apply(null, levels),
      attention
    };
  }

  return {
    DEFAULTS, MIN, ms, localIso, sectionKey, median, ANNOUNCEMENT_FIELDS, SAFE_ANNOUNCEMENT_FIELDS,
    request, queryOurTrain, queryLine, queryNames, queryMessages, resultOf,
    parseAnnouncement, groupTrains, nearestRun, buildLine, crossingOf, latestDelay, theirArrival,
    historyMedians, recoveryRatios, plannedRun, predict, outgoing, incoming, signaturesIn, parseMessage, classifyMessages, messagesFor, compute
  };
});
