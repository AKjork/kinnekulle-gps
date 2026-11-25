/* RailTimer – infofliken: läget framåt under resan.
   Bygger på Trafikverkets TrainAnnouncement för vårt tåg och för alla tåg på resten av linjen:
   - möten: motgående tåg som enligt tidtabell är på samma plats som vi samtidigt. På enkelspår kan
     vi inte åka vidare förrän det mötande tåget har kommit in, så är det sent blir vi sena.
   - enkel- eller dubbelspår räknas ur tidtabellen: två motgående tåg som enligt tidtabell är på samma
     sträcka samtidigt möts mellan stationerna, och då är sträckan dubbelspår.
   - prognos per plats längs resan: våra egna tider, uppehåll, annonserad avgångstid, mötena och
     de egna gångtiderna från tidigare körningar (så mycket vi brukar ta igen).
   - anslutningar i slutstationen och tåg som ansluter till oss i startstationen, även Västtrafiks bussar
     (input.buses, hämtade med railtimer-vt.js) och valet Tåg | Buss | Båda.
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
    transferMin: 4,           // byten kortare än så är knappa; tåg som enligt tidtabell går tidigare än så efter vår ankomst är inga anslutningar
    missedUnderMin: 1,        // under så här många minuter att byta hinns bytet inte (tåget går före eller i samma stund som vi kommer)
    connectionWindowMin: 40,  // anslutningar som enligt tidtabell går högst så här länge efter vår ankomst
    minPlannedTransferMin: 2, // tåg som enligt tidtabell går tidigare än så efter vår ankomst är inga anslutningar
    incomingWindowMin: 30,    // tåg som ansluter till oss: ankomst högst så här länge före vår avgång
    lineOverlapMs: 60000,     // motgående tåg på samma sträcka samtidigt så här länge = möte mellan stationerna
    recoveryMinRatio: 0.85,   // egna gångtider får korta planerad gångtid högst så här mycket
    historyMinObs: 3,         // egna gångtider räknas från så här många mätningar
    maxConnections: 8,
    midConnectionWindowMin: 20, // anslutningar vid stationerna längs vägen: högst så här länge efter vår ankomst
    holdMaxMin: 15,           // förslaget att ringa trafikledningen: bara när det räcker att vänta högst så här länge
    positionMaxAgeMs: 5 * 60000, // tågpositioner äldre än så används inte
    maxSpeedMs: 200 / 3.6     // inget tåg kör fortare: det mötande tåget kan inte vara framme tidigare än så
  };

  /* Trafikverkets Deviation-texter som inte säger något om tågets gång, bara till resenärerna:
     preliminär tid (den beräknade tiden finns redan) och biljettinformation. Sågs i riktiga svar
     2026-11-25 (bevakningen på 13355 och kontrollsidan för 23349) och meddelas inte som avvikelser. */
  const NOT_DEVIATION = /^\s*(prel\.?\s*tid|preliminär tid|movingo gäller ej)\.?\s*$/i;

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
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  // "POINT (lon lat)" → { lat, lon }
  function wgs84(text) {
    const m = /POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/.exec(String(text || ''));
    return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null;
  }
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
      `<INCLUDE>LocationSignature</INCLUDE><INCLUDE>AdvertisedLocationName</INCLUDE><INCLUDE>Geometry.WGS84</INCLUDE></QUERY>`;
  }
  /* Mötande tågs senaste position (TrainPosition 1.1, namespace järnväg.trafikinfo – provat 2026-11-25j:
     fälten Train.OperationalTrainNumber, Position.WGS84, TimeStamp; Speed finns för ungefär hälften). */
  function queryPositions(otns) {
    const or = otns.map(o => `<EQ name="Train.OperationalTrainNumber" value="${xmlAttr(o)}" />`).join('');
    return `<QUERY namespace="järnväg.trafikinfo" objecttype="TrainPosition" schemaversion="1.1" limit="${otns.length * 4 + 4}">` +
      `<FILTER><OR>${or}</OR></FILTER>` +
      ['Train.OperationalTrainNumber', 'Position.WGS84', 'TimeStamp', 'Speed', 'Bearing'].map(f => `<INCLUDE>${f}</INCLUDE>`).join('') +
      `</QUERY>`;
  }
  // Senaste positionen per tågnummer: Map(otn → { otn, lat, lon, t, speedKmh })
  function parsePositions(list) {
    const out = new Map();
    for (const p of list || []) {
      const otn = p && p.Train && p.Train.OperationalTrainNumber != null ? String(p.Train.OperationalTrainNumber) : '';
      const pt = wgs84(p && p.Position && p.Position.WGS84);
      const t = ms(p && p.TimeStamp);
      if (!otn || !pt || t == null) continue;
      const prev = out.get(otn);
      if (prev && prev.t >= t) continue;
      out.set(otn, { otn, lat: pt.lat, lon: pt.lon, t, speedKmh: Number.isFinite(Number(p.Speed)) && p.Speed !== null ? Number(p.Speed) : null });
    }
    return out;
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

  // Ingen egen bytestid: "missas" bara när tåget går före eller i samma stund som vi kommer,
  // "knappt" under 4 min att byta. Minuterna visas, så att föraren själv ser hur knappt det är.
  function connectionStatus(transferMin, o) {
    if (transferMin < o.missedUnderMin) return 'missas';
    if (transferMin < o.transferMin) return 'knappt';
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
      else status = connectionStatus(transfer, o);
      out.push({
        kind: 'tåg', otn: tr.otn, ident: tr.ident, product: tr.product, to: tr.to,
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
        kind: 'tåg', otn: tr.otn, ident: tr.ident, product: tr.product, from: tr.from,
        adv: arr.adv, arr: theirArr, delayMin: roundMin(theirArr - arr.adv), track: arr.track,
        transferMin: Math.floor(transfer), arrived,
        status: arr.canceled ? 'inställt' : connectionStatus(transfer, o),
        source: arrived ? 'faktisk' : (arr.est != null ? 'trafikverket' : 'plan')
      });
    }
    out.sort((a, b) => a.adv - b.adv);
    return out.slice(0, o.maxConnections);
  }

  // ── Bussar (Västtrafik, railtimer-vt.js) ──
  // Orten i ett namn: "Lidköping Resecentrum" → "lidköping", "Herrljunga C" → "herrljunga", "Skara via Götene" → "skara"
  function townKey(name) {
    const s = String(name || '').toLocaleLowerCase('sv').split(/\s+via\s+/)[0];
    const m = s.match(/[a-zåäöéü]+(?:-[a-zåäöéü]+)*/);
    return m ? m[0] : '';
  }
  /* Orterna längs vår linje utom stationens egen. En buss dit går längs vår linje och är ingen anslutning,
     som tågen längs linjen. En buss inom stationens egen ort (stadsbuss) räknas. */
  function lineTownsExcept(line, names, sig) {
    const here = townKey(names.get(sig));
    const out = new Set();
    for (const l of line) {
      if (l.sig === sig) continue;
      const k = townKey(names.get(l.sig));
      if (k && k !== here) out.add(k);
    }
    return out;
  }

  /* Bussar som går från stationen efter vår ankomst: samma fönster och regler som tågen (outgoing).
     Bussens tid: Västtrafiks beräknade tid, annars tidtabellen. Västtrafik har ingen faktisk tid: en buss vars
     tid passerat för mer än 30 s sedan räknas som avgången. */
  function busOutgoing(calls, L, predArr, arrived, towns, now, o) {
    const out = [];
    const ourAdv = L.advArr != null ? L.advArr : L.plannedArr;
    if (ourAdv == null || predArr == null) return out;
    for (const b of calls || []) {
      const plannedTransfer = (b.planned - ourAdv) / MIN;
      if (plannedTransfer < Math.max(o.minPlannedTransferMin, o.transferMin) || plannedTransfer > o.connectionWindowMin) continue;
      const k = townKey(b.direction);
      if (k && towns.has(k)) continue;
      const t = b.est != null ? b.est : b.planned;
      const departed = t < now - 30000;
      const theirDep = departed ? t : Math.max(t, now);
      const transfer = (theirDep - predArr) / MIN;
      let status;
      if (b.canceled) status = 'inställt';
      else if (departed && !arrived) status = 'avgått';
      else status = connectionStatus(transfer, o);
      out.push({
        kind: 'buss', otn: b.id, ident: b.line, product: 'Buss', to: [], toText: b.direction,
        adv: b.planned, dep: theirDep, delayMin: roundMin(theirDep - b.planned), track: b.platform, stop: b.stop,
        transferMin: Math.floor(transfer), plannedTransferMin: Math.round(plannedTransfer), status,
        source: b.est != null ? 'västtrafik' : 'plan'
      });
    }
    out.sort((a, b) => a.adv - b.adv);
    return out.slice(0, o.maxConnections);
  }
  // Bussar som kommer till stationen före vår avgång och ansluter till oss (som incoming)
  function busIncoming(calls, L, predDep, towns, now, o) {
    const out = [];
    const ourAdv = L.advDep != null ? L.advDep : L.plannedDep;
    if (ourAdv == null || predDep == null) return out;
    for (const b of calls || []) {
      const plannedTransfer = (ourAdv - b.planned) / MIN;
      if (plannedTransfer < Math.max(o.minPlannedTransferMin, o.transferMin) || plannedTransfer > o.incomingWindowMin) continue;
      const k = townKey(b.origin);
      if (k && towns.has(k)) continue;
      const t = b.est != null ? b.est : b.planned;
      const arrived = t <= now;
      const theirArr = arrived ? t : Math.max(t, now);
      const transfer = (predDep - theirArr) / MIN;
      out.push({
        kind: 'buss', otn: b.id, ident: b.line, product: 'Buss', from: [], fromText: b.origin,
        adv: b.planned, arr: theirArr, delayMin: roundMin(theirArr - b.planned), track: b.platform, stop: b.stop,
        transferMin: Math.floor(transfer), arrived,
        status: b.canceled ? 'inställt' : connectionStatus(transfer, o),
        source: b.est != null ? 'västtrafik' : 'plan'
      });
    }
    out.sort((a, b) => a.adv - b.adv);
    return out.slice(0, o.maxConnections);
  }

  /* Valet Tåg | Buss | Båda (mode 'tag', 'buss', 'bada'). Ger de som visas och hur många tåg och bussar
     som döljs. */
  const CONN_MODES = ['tag', 'buss', 'bada'];
  function connShows(mode, c) {
    if (mode === 'bada') return true;
    return mode === 'buss' ? c.kind === 'buss' : c.kind !== 'buss';
  }
  /* Nyckeln för en markerad anslutning (resenärer ska byta), samma varje dag för vårt tågnummer:
     riktning (ut = från stationen, in = till oss), station och tågets nummer – för en buss linjen och klockslaget. */
  function connKey(c, sig, dir) {
    if (c.kind === 'buss') {
      const d = new Date(c.adv);
      return `${dir}|${sig}|buss|${c.ident}|${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${dir}|${sig}|tåg|${c.ident || c.otn}`;
  }
  function splitByMode(list, mode) {
    const shown = [], hidden = { tåg: 0, buss: 0 };
    for (const c of list || []) {
      if (connShows(mode, c)) shown.push(c);
      else hidden[c.kind === 'buss' ? 'buss' : 'tåg']++;
    }
    return { shown, hidden };
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
     input: { line, trains, ourKey, known: Map(sig → { arr, dep }), now, knownDouble,
              history, routeNames: Map(sig → namn), messages, opts } */
  function compute(input) {
    const o = Object.assign({}, DEFAULTS, input.opts || {});
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

    // Position för ett mötande tåg: { distM, speedKmh, ageS, t, side } där side är 'beyond' (på andra sidan
    // mötesplatsen), 'at' (inom 500 m) eller 'passed' (mellan oss och mötesplatsen)
    const positions = input.positions || new Map();
    const coords = input.coords || new Map();
    function positionAt(otn, sig, i) {
      const pos = positions.get(String(otn));
      const st = coords.get(sig);
      if (!pos || !st || now - pos.t > o.positionMaxAgeMs) return null;
      const distM = haversine(pos.lat, pos.lon, st.lat, st.lon);
      let ref = input.ourPos || null;
      if (!ref) for (let k = Math.min(Math.max(frontier, 0), i); k >= 0 && !ref; k--) ref = coords.get(line[k].sig) || null;
      let side = 'at';
      if (ref && distM > 500) {
        const dS = haversine(ref.lat, ref.lon, st.lat, st.lon), dT = haversine(ref.lat, ref.lon, pos.lat, pos.lon);
        side = dT > dS + 500 ? 'beyond' : (dT < dS - 500 ? 'passed' : 'at');
      } else if (!ref && distM > 500) side = 'unknown';
      return { distM: Math.round(distM), speedKmh: pos.speedKmh, ageS: Math.max(0, Math.round((now - pos.t) / 1000)), t: pos.t, side };
    }

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
      // Tågets senaste position (TrainPosition): avstånd till mötesplatsen, och var det är i förhållande till den.
      // Är det fortfarande på andra sidan mötesplatsen kan det inte vara framme tidigare än avståndet i högsta
      // fart – en undre gräns som aldrig gör prognosen för tidig. Annars används positionen bara för att visa.
      const position = positionAt(tr.otn, line[i].sig, i);
      if (position && position.side === 'beyond' && !their.arrived) {
        const earliest = position.t + position.distM / o.maxSpeedMs * 1000;
        if (earliest > their.t) { their.t = earliest; their.source = 'position'; }
      }
      const m = {
        i, sig: line[i].sig, otn: tr.otn, ident: tr.ident, product: tr.product, position,
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
        const list = r.deviations.filter(t => !NOT_DEVIATION.test(t));
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

    // Bussar (Västtrafik): input.buses = Map(sig → { departures, arrivals }), bara bussar (railtimer-vt.js).
    // Orterna längs linjen tas från namnen (input.names, annars routeNames).
    const buses = input.buses || new Map();
    const names = new Map(routeNames);
    if (input.names) for (const [k, v] of input.names) if (v) names.set(k, v);
    const busAt = sig => buses.get(sig) || null;
    const byAdv = (a, b) => a.adv - b.adv;

    const conn = outgoing(trains, our, endL, predArr, arrived, lineSigs, now, o);
    const endBus = busAt(endL.sig);
    if (endBus) conn.push(...busOutgoing(endBus.departures, endL, predArr, arrived, lineTownsExcept(line, names, endL.sig), now, o));
    conn.sort(byAdv);
    const inc = startDeparted ? [] : incoming(trains, our, line[0], preds[0].dep, lineSigs, now, o);
    const startBus = busAt(line[0].sig);
    if (!startDeparted && startBus) inc.push(...busIncoming(startBus.arrivals, line[0], preds[0].dep, lineTownsExcept(line, names, line[0].sig), now, o));
    inc.sort(byAdv);

    // Anslutningar vid stationerna längs vägen där vi stannar och inte har åkt från: tåg och bussar som går
    // därifrån åt ett annat håll högst midConnectionWindowMin efter vår ankomst, och som kommer dit före vår avgång
    const stops = [];
    for (let i = Math.max(frontier, 1); i < n - 1; i++) {
      const L = line[i];
      if (!L.stop || known[i].dep != null) continue;
      const oi = Object.assign({}, o, { connectionWindowMin: o.midConnectionWindowMin, incomingWindowMin: o.midConnectionWindowMin });
      const out = preds[i].arr != null ? outgoing(trains, our, L, preds[i].arr, known[i].arr != null, lineSigs, now, oi) : [];
      const into = preds[i].dep != null ? incoming(trains, our, L, preds[i].dep, lineSigs, now, oi) : [];
      const b = busAt(L.sig);
      if (b) {
        const towns = lineTownsExcept(line, names, L.sig);
        if (preds[i].arr != null) out.push(...busOutgoing(b.departures, L, preds[i].arr, known[i].arr != null, towns, now, oi));
        if (preds[i].dep != null) into.push(...busIncoming(b.arrivals, L, preds[i].dep, towns, now, oi));
        out.sort(byAdv);
        into.sort(byAdv);
      }
      if (out.length || into.length) stops.push({ i, sig: L.sig, connectionsAll: out, incomingAll: into });
    }

    // Nivåer: 0 inget att göra, 1 håll koll, 2 påverkar
    // Väntan i hela minuter, samma som visas
    const lvlMeeting = m => (m.canceled || m.moved) ? 0 : (m.waitMin >= 5 ? 2 : (m.waitMin >= 1 ? 1 : 0));
    const lvlConn = c => (c.status === 'missas' || c.status === 'avgått') ? 2 : ((c.status === 'knappt' || c.status === 'inställt') ? 1 : 0);
    meetings.sort((a, b) => a.i - b.i);
    for (const m of meetings) { m.waitMin = roundMin(m.waitMs); m.level = lvlMeeting(m); }
    for (const c of conn) c.level = lvlConn(c);
    for (const c of inc) c.level = lvlConn(c);
    for (const st of stops) for (const c of st.connectionsAll.concat(st.incomingAll)) { c.level = lvlConn(c); c.sig = st.sig; }

    /* Valet Tåg | Buss | Båda: listorna visar bara valda slag, och hur många som döljs.
       Med connAlerts (förval) följer varningarna, siffran, panelens rad och utropet samma val; annars gäller
       de alla anslutningar som hämtats. */
    const mode = CONN_MODES.includes(input.connMode) ? input.connMode : 'tag';
    const alertsFollow = input.connAlerts !== false;
    const endSplit = splitByMode(conn, mode);
    const incSplit = splitByMode(inc, mode);
    const stopsHidden = { tåg: 0, buss: 0 };
    for (const st of stops) {
      const a = splitByMode(st.connectionsAll, mode), b = splitByMode(st.incomingAll, mode);
      st.connections = a.shown;
      st.incoming = b.shown;
      st.hidden = { tåg: a.hidden.tåg + b.hidden.tåg, buss: a.hidden.buss + b.hidden.buss };
      stopsHidden.tåg += st.hidden.tåg;
      stopsHidden.buss += st.hidden.buss;
    }
    const shownStops = stops.filter(st => st.connections.length || st.incoming.length);
    const alert = alertsFollow
      ? { connections: endSplit.shown, incoming: incSplit.shown, stops: shownStops }
      : { connections: conn, incoming: inc, stops: stops.map(st => ({ i: st.i, sig: st.sig, connections: st.connectionsAll, incoming: st.incomingAll })) };
    const midAll = [];
    for (const st of alert.stops) midAll.push(...st.connections, ...st.incoming);

    /* Markerade anslutningar (input.marked: nycklar från connKey) gäller oavsett valet Tåg | Buss | Båda.
       Blir en markerad anslutning knapp eller missas, och det räcker att den väntar högst holdMaxMin för att få
       vanlig bytestid (transferMin), blir det ett förslag: ring trafikledningen och fråga om den kan vänta –
       eller om vi kan vänta på den som ska till oss – och om spår vid samma plattform. Inte när den gått
       eller är inställd. */
    const marked = input.marked instanceof Set ? input.marked : new Set(input.marked || []);
    const ourTrack = sig => {
      const l = our.at.get(sig);
      return (l && ((l.arr && l.arr.track) || (l.dep && l.dep.track))) || '';
    };
    const every = [];
    for (const c of conn) every.push({ c, sig: endL.sig, dir: 'ut' });
    for (const c of inc) every.push({ c, sig: line[0].sig, dir: 'in' });
    for (const st of stops) {
      for (const c of st.connectionsAll) every.push({ c, sig: st.sig, dir: 'ut' });
      for (const c of st.incomingAll) every.push({ c, sig: st.sig, dir: 'in' });
    }
    const actions = [];
    for (const x of every) {
      x.c.key = connKey(x.c, x.sig, x.dir);
      x.c.marked = marked.has(x.c.key);
      if (!x.c.marked || (x.c.status !== 'knappt' && x.c.status !== 'missas')) continue;
      const waitMin = o.transferMin - x.c.transferMin;
      if (waitMin < 1 || waitMin > o.holdMaxMin) continue;
      actions.push({
        type: x.dir === 'ut' ? 'hold' : 'wait', sig: x.sig, c: x.c, waitMin,
        ourTrack: x.sig === endL.sig ? end.track : ourTrack(x.sig), theirTrack: x.c.track || ''
      });
    }
    actions.sort((a, b) => a.c.adv - b.c.adv);
    const markedList = every.filter(x => x.c.marked).map(x => ({ sig: x.sig, dir: x.dir, c: x.c }));

    const endLevel = end.delayMin >= 6 ? 2 : (end.delayMin >= 2 ? 1 : 0);
    const levels = [endLevel].concat(meetings.map(m => m.level), alert.connections.map(c => c.level), alert.incoming.map(c => c.level),
      midAll.map(c => c.level), deviations.map(() => 1), messages.map(() => 1));
    const attention = meetings.filter(m => m.level).length + alert.connections.filter(c => c.level).length +
      alert.incoming.filter(c => c.level).length + midAll.filter(c => c.level).length + deviations.length + messages.length;

    // Varför vi blir sena: det möte som kostar mest
    const worstMeeting = meetings.filter(m => m.waitMin >= 1).sort((a, b) => b.waitMs - a.waitMs)[0] || null;

    return {
      now, frontier, end, currentDelayMin, recoveryMin, recoveryObs: rec.obs,
      meetings, deviations, messages, messagesHidden: cls.hidden,
      connections: endSplit.shown, connectionsHidden: endSplit.hidden,
      incoming: startDeparted ? null : incSplit.shown, incomingHidden: incSplit.hidden,
      stops: shownStops, stopsHidden, connMode: mode, connAlerts: alertsFollow, alert, actions, markedList,
      midMissed: alert.stops.reduce((k, st) => k + st.connections.filter(c => c.level === 2).length, 0),
      preds: preds.map((p, i) => ({ sig: line[i].sig, arr: p.arr, dep: p.dep, waitMs: p.waitMs })),
      doubleSections: Array.from(newDouble),
      reason: worstMeeting ? { sig: worstMeeting.sig, otn: worstMeeting.ident || worstMeeting.otn, waitMin: worstMeeting.waitMin } : null,
      missed: alert.connections.filter(c => c.level === 2).length,
      tight: alert.connections.filter(c => c.level === 1).length,
      level: Math.max.apply(null, levels),
      attention
    };
  }

  /* ── Utrop ──
     Färdig text för högtalaren när vi är minst 3 min sena eller en anslutning i slutstationen blir knapp eller
     missas. Orsak bara när den är känd: väntan på ett försenat mötande tåg (minst 2 min), annars en störning
     längs vägen. opts: { name: sig → namn, clock: tid → "hh:mm" }. Ger { sv, en } eller null. */
  function announcement(m, opts) {
    if (!m || !m.end || m.end.arrived || m.end.predArr == null) return null;
    const name = (opts && opts.name) || (s => s);
    const clock = (opts && opts.clock) || (t => new Date(Math.round(t / MIN) * MIN).toTimeString().slice(0, 5));
    const d = m.end.delayMin || 0;
    const conns = (m.alert && m.alert.connections) || m.connections || [];
    const bad = conns.filter(c => c.status === 'missas' || c.status === 'avgått').slice(0, 3);
    const tight = conns.filter(c => c.status === 'knappt').slice(0, 3);
    const ok = conns.filter(c => c.status === 'ok').slice(0, 2);
    if (d < 3 && !bad.length && !tight.length) return null;
    const endName = name(m.end.sig);
    const dest = c => c.kind === 'buss' ? (c.toText || '?') : ((c.to || []).map(name).filter(Boolean).join(' / ') || '?');
    // "Tåget mot X 11:45" / "Buss 1 mot X 11:45"; "spår 3" / "läge A"
    const what = (c, start) => c.kind === 'buss' ? `${start ? 'B' : 'b'}uss${c.ident ? ' ' + c.ident : 'en'} mot ${dest(c)} ${clock(c.adv)}` : `${start ? 'T' : 't'}åget mot ${dest(c)} ${clock(c.adv)}`;
    const whatEn = c => c.kind === 'buss' ? `${c.ident ? 'bus ' + c.ident : 'the bus'} to ${dest(c)} at ${clock(c.adv)}` : `the train to ${dest(c)} at ${clock(c.adv)}`;
    const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
    const fromSv = c => c.track ? `, ${c.kind === 'buss' ? 'den går från läge' : 'det går från spår'} ${c.track}` : '';
    const fromEn = c => c.track ? `, departing from ${c.kind === 'buss' ? 'stop' : 'track'} ${c.track}` : '';
    const meetReason = m.reason && m.reason.waitMin >= 2;
    const msg = !meetReason && m.messages && m.messages[0] ? m.messages[0].header : '';
    const lowerFirst = t => t ? t.charAt(0).toLocaleLowerCase('sv') + t.slice(1) : t;
    const sv = [], en = [];
    if (d >= 3) {
      sv.push(`Vi är cirka ${d} minuter försenade${meetReason ? ' på grund av möte med ett försenat tåg' : (msg ? ` på grund av ${lowerFirst(msg)}` : '')}.`);
      en.push(`We are approximately ${d} minutes late${meetReason ? ' due to a delayed oncoming train' : (msg ? ' due to a traffic disruption' : '')}.`);
    }
    const track = m.end.track ? `, spår ${m.end.track}` : '';
    sv.push(`Beräknad ankomst till ${endName} ${clock(m.end.predArr)}${track}.`);
    en.push(`Expected arrival at ${endName} ${clock(m.end.predArr)}${m.end.track ? `, track ${m.end.track}` : ''}.`);
    for (const c of bad) {
      sv.push(c.status === 'avgått' ? `${what(c, true)} har tyvärr redan gått.` : `${what(c, true)} hinns tyvärr inte.`);
      en.push(c.status === 'avgått' ? `${cap(whatEn(c))} has unfortunately already left.` : `${cap(whatEn(c))} will unfortunately be missed.`);
    }
    // Knappt: hur många minuter det blir att byta, så att resenärerna själva kan avgöra
    for (const c of tight) {
      const n = Math.max(c.transferMin, 1);
      sv.push(`Till ${what(c, false)} har ni cirka ${n} minut${n === 1 ? '' : 'er'} att byta${fromSv(c)}.`);
      en.push(`You will have about ${n} minute${n === 1 ? '' : 's'} to change to ${whatEn(c)}${fromEn(c)}.`);
    }
    if (d >= 3) for (const c of ok) {
      sv.push(`${what(c, true)} hinner ni${fromSv(c)}.`);
      en.push(`You will make ${whatEn(c)}${fromEn(c)}.`);
    }
    return { sv: sv.join(' '), en: en.join(' ') };
  }

  /* ── Meddelanden ──
     Det som ska meddelas när det blir värre: möte med väntan, anslutning som blir knapp eller missas, tåg som
     inte hinner till oss, avvikelse och störning. Varje sak har en nyckel och en nivå; den som meddelar
     (appen i notifyInfo, bevakningen i bakgrunden i bevakning/bevaka.js) meddelar en nyckel en gång per nivå.
     text: kort, för toast och notis. say: för uppläsning (inga tågnummer, "minuter" utskrivet).
     opts: { name: sig → namn, clock: tid → "hh:mm" (avrundat till hel minut) }. */
  /* Förslaget när en markerad anslutning blir knapp eller missas (compute: actions), kort:
     title "Ring trafikledningen: kan 3053 vänta ca 3 min?", sub "Hällekis → Mariestad 11:55 · vi spår 2, 3053 spår 3 –
     samma plattform?" och say för uppläsning. opts som i alerts. */
  function actionText(a, opts) {
    const name = (opts && opts.name) || (s => s);
    const clock = (opts && opts.clock) || (t => new Date(Math.round(t / MIN) * MIN).toTimeString().slice(0, 5));
    const c = a.c;
    const to = c.kind === 'buss' ? (c.toText || '?') : ((c.to || []).map(name).join(' / ') || '?');
    const from = c.kind === 'buss' ? (c.fromText || '?') : ((c.from || []).map(name).join(' / ') || '?');
    const who = c.kind === 'buss' ? `buss ${c.ident}` : String(c.ident || c.otn);
    const title = a.type === 'hold' ? `Ring trafikledningen: kan ${who} vänta ca ${a.waitMin} min?` : `Ring trafikledningen: kan vi vänta på ${who} ca ${a.waitMin} min?`;
    const place = a.type === 'hold' ? `${name(a.sig)} → ${to} ${clock(c.adv)}` : `${name(a.sig)}: från ${from} ${clock(c.adv)}`;
    let plat = '';
    if (c.kind !== 'buss') {
      if (a.ourTrack && a.theirTrack) { if (a.ourTrack !== a.theirTrack) plat = `vi spår ${a.ourTrack}, ${who} spår ${a.theirTrack} – samma plattform?`; }
      else plat = 'spår vid samma plattform?';
    }
    const what = c.kind === 'buss' ? 'bussen' : 'tåget';
    const mins = `${a.waitMin} minut${a.waitMin === 1 ? '' : 'er'}`;
    const say = a.type === 'hold' ? `Ring trafikledningen. Kan ${what} mot ${to} vänta cirka ${mins}?` : `Ring trafikledningen. Kan vi vänta på ${what} från ${from} cirka ${mins}?`;
    return { title, sub: [place, plat].filter(Boolean).join(' · '), say };
  }

  function alerts(m, opts) {
    const out = [];
    if (!m) return out;
    const name = (opts && opts.name) || (s => s);
    const clock = (opts && opts.clock) || (t => new Date(Math.round(t / MIN) * MIN).toTimeString().slice(0, 5));
    const places = sigs => (sigs || []).map(name).join(' / ');
    const trainText = c => [c.product, c.ident].filter(Boolean).join(' ');
    const minutes = k => `${k} minut${k === 1 ? '' : 'er'}`;
    const connSay = { knappt: 'blir knapp', missas: 'hinns inte', 'avgått': 'har gått', 'inställt': 'är inställd' };
    const connText = c => c.status === 'knappt' ? `knappt (${Math.max(c.transferMin, 0)} min)` : c.status;
    // Bussar (Västtrafik) har riktningen som text; tåg Trafikverkets platser
    const bus = c => c.kind === 'buss';
    const to = c => bus(c) ? (c.toText || '') : places(c.to);
    const from = c => bus(c) ? (c.fromText || '') : places(c.from);
    const toUs = c => c.status === 'knappt' ? 'ger ett knappt byte till oss' : (c.status === 'inställt' ? (bus(c) ? 'är inställd' : 'är inställt') : 'hinner inte till oss');
    const add = (key, level, text, say) => out.push({ key, level, text, say });
    // Först förslaget att ringa trafikledningen (markerad anslutning som blir knapp eller missas)
    for (const a of m.actions || []) { const t = actionText(a, opts); add(`a|${a.c.key}`, 2, t.title, t.say); }
    for (const mt of m.meetings || []) if (mt.level) add(`m|${mt.otn}|${mt.sig}`, mt.level,
      `Möte ${name(mt.sig)}: ${mt.ident || mt.otn} är ${mt.theirDelayMin} min sent – vi väntar ca ${mt.waitMin} min`,
      `Möte i ${name(mt.sig)}. Mötande tåg ${minutes(mt.theirDelayMin)} sent. Vi väntar cirka ${minutes(mt.waitMin)}.`);
    // Anslutningarna som varningarna gäller: valda slag (Tåg | Buss | Båda), eller alla om varningarna inte följer valet
    const A = m.alert || m;
    for (const c of A.connections || []) if (c.level) add(`c|${c.otn}`, c.level,
      `Anslutning ${clock(c.adv)} ${bus(c) ? `buss ${c.ident} ` : ''}${to(c)}: ${connText(c)}`,
      `Anslutningen ${bus(c) ? 'till bussen ' : ''}mot ${to(c)} ${clock(c.adv)} ${connSay[c.status] || c.status}.`);
    for (const c of A.incoming || []) if (c.level) add(`i|${c.otn}`, c.level,
      `${trainText(c)} från ${from(c)}: ${c.status === 'knappt' ? 'knappt byte till oss' : (c.status === 'inställt' ? 'inställt' : 'hinner inte till oss')}`,
      `${bus(c) ? 'Bussen' : 'Tåget'} från ${from(c)} ${toUs(c)}.`);
    for (const st of A.stops || []) {
      const where = name(st.sig);
      for (const c of st.connections) if (c.level) add(`c|${c.otn}|${st.sig}`, c.level,
        `Anslutning i ${where} ${clock(c.adv)} ${bus(c) ? `buss ${c.ident} ` : ''}${to(c)}: ${connText(c)}`,
        `Anslutningen i ${where} ${bus(c) ? 'till bussen ' : ''}mot ${to(c)} ${connSay[c.status] || c.status}.`);
      for (const c of st.incoming) if (c.level) add(`i|${c.otn}|${st.sig}`, c.level,
        `${trainText(c)} från ${from(c)} till oss i ${where}: ${c.status === 'knappt' ? 'knappt' : (c.status === 'inställt' ? 'inställt' : 'hinner inte')}`,
        `${bus(c) ? 'Bussen' : 'Tåget'} från ${from(c)} ${toUs(c)} i ${where}.`);
    }
    for (const d of m.deviations || []) add(`d|${d.sig}|${d.text}`, 1, `${name(d.sig)}: ${d.text}`, `${name(d.sig)}: ${d.text}.`);
    for (const msg of m.messages || []) add(`t|${msg.id}`, 1, msg.header, `${msg.header}.`);
    return out;
  }
  // Det som är nytt eller värre än i `notified` (Map nyckel → nivå), som nu räknas som meddelat; viktigast först
  function newAlerts(list, notified) {
    const fresh = [];
    for (const a of list || []) {
      const prev = notified.get(a.key) || 0;
      if (a.level > prev) { fresh.push(a); notified.set(a.key, a.level); }
    }
    return fresh.sort((a, b) => b.level - a.level);
  }

  return {
    DEFAULTS, MIN, ms, localIso, haversine, wgs84, queryPositions, parsePositions, announcement, alerts, newAlerts, actionText, sectionKey, median, ANNOUNCEMENT_FIELDS, SAFE_ANNOUNCEMENT_FIELDS,
    request, queryOurTrain, queryLine, queryNames, queryMessages, resultOf,
    parseAnnouncement, groupTrains, nearestRun, buildLine, crossingOf, latestDelay, theirArrival,
    historyMedians, recoveryRatios, plannedRun, predict, outgoing, incoming, signaturesIn, parseMessage, classifyMessages, messagesFor, compute,
    townKey, lineTownsExcept, busOutgoing, busIncoming, CONN_MODES, connShows, splitByMode, connKey
  };
});
