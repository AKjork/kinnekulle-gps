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
    midHorizonMin: 30,        // anslutningar längs vägen bara vid stationer vi når inom så här lång tid (André 2026-11-25:
                              // en buss i Lidköping berör inte den som står i Herrljunga, nästan en timme därifrån)
    holdMaxMin: 15,           // förslaget att ringa trafikledningen: bara när det räcker att vänta högst så här länge
    ownWindowMin: 120,        // egna anslutningar (valet Mina): från oss högst så här länge efter vår ankomst …
    ownIncomingWindowMin: 60, // … och till oss högst så här länge före vår avgång, vid alla stationer framför oss
    positionMaxAgeMs: 5 * 60000, // tågpositioner äldre än så används inte
    maxSpeedMs: 200 / 3.6,    // inget tåg kör fortare: det mötande tåget kan inte vara framme tidigare än så
    axisAtM: 600,             // längs banan: så här nära en plats räknas ett tåg som vid platsen (stationens mitt, långa mötesspår)
    axisSureOffM: 150,        // ett tågs position räknas som på vår linje bara så här nära den uppmätta linjen
    axisOurOffM: 300,         // vår egen GPS-position: högst så här långt från linjen
    axisStandKmh: 5,          // står det mötande tåget still …
    axisStandM: 1200,         // … så här nära nästa mötesplats kan det stå kvar vid utfartssignalen: inte ute på sträckan
    predictMoves: true,       // möten flyttas närmare oss när vi är sena och det ger minst väntan sammanlagt
    trvLogMax: 600,           // högst så många rader i loggen över Trafikverkets svar under resan
    trvLogPosM: 200,          // mötande tågs position loggas när tåget flyttat sig så här långt …
    trvLogPosMs: 3 * 60000    // … eller så här länge sedan senast
  };

  /* Trafikverkets Deviation-texter som inte säger något om tågets gång, bara till resenärerna:
     preliminär tid (den beräknade tiden finns redan) och biljettinformation. Sågs i riktiga svar
     2026-11-25 (provet mot Trafikverket för 13355 och kontrollsidan för 23349) och meddelas inte som avvikelser. */
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
    'TimeAtLocationWithSeconds', 'ToLocation', 'TrackAtLocation',
    // Fanns i kontrollsidans riktiga svar 2026-11-25 (57 resp. 50 av 57 annonseringar); bara till loggen under resan
    'ModifiedTime', 'EstimatedTimeIsPreliminary'
  ];
  /* Utan de fält som inte är provade mot det riktiga API:et (tågorderns tid och planerad försening).
     Godtar Trafikverket inte frågan med alla fält frågar appen igen med de här, som fetchTimetable gör
     sedan 2026-11-25g. Driftstiden blir då den annonserade tiden. */
  const SAFE_ANNOUNCEMENT_FIELDS = ANNOUNCEMENT_FIELDS.filter(f => !/^(LocationDateTimeOTN|PlannedEstimatedTimeAtLocation)/.test(f));
  const includes = fields => (fields || ANNOUNCEMENT_FIELDS).map(f => `<INCLUDE>${f}</INCLUDE>`).join('');

  function request(apiKey, queries) {
    return `<REQUEST><LOGIN authenticationkey="${xmlAttr(apiKey)}" />${queries.join('')}</REQUEST>`;
  }
  /* Vårt tåg, alla platser, ±12 h kring `at`. Numret kan vara operativt (OTN, föraren) eller annonserat (ATN,
     tågvärden); tåget väljs med RailTimerTrv.pickTrain och delarna slås ihop med mergeTrains. */
  function queryOurTrain(n, at, fields) {
    return `<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="1000"><FILTER><AND>` +
      `<OR><EQ name="OperationalTrainNumber" value="${xmlAttr(n)}" /><EQ name="AdvertisedTrainIdent" value="${xmlAttr(n)}" /></OR>` +
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
  /* Egna tåg (valet Mina) vid sina stationer, i ett längre fönster än linjens fråga: tågnumret som annonserat
     (AdvertisedTrainIdent) eller operativt (OperationalTrainNumber). entries: [{ id, sig }] */
  function queryOwnTrains(entries, from, to, fields) {
    const or = entries.map(e => `<AND><EQ name="LocationSignature" value="${xmlAttr(e.sig)}" />` +
      `<OR><EQ name="AdvertisedTrainIdent" value="${xmlAttr(e.id)}" /><EQ name="OperationalTrainNumber" value="${xmlAttr(e.id)}" /></OR></AND>`).join('');
    return `<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="500"><FILTER><AND>` +
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
      prelim: a.EstimatedTimeIsPreliminary === true || a.EstimatedTimeIsPreliminary === 'true',
      modified: ms(a.ModifiedTime),
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

  /* Ett tåg av flera delar (ett OTN var, samma ATN): tågnumret byts längs vägen, till exempel 947 → 948 → 949.
     Delarna i tidsordning slås ihop till ett tåg med alla OTN (otns). Vid platsen där numret byts har den
     ena delen ankomsten och den andra avgången. Ett tåg i en del blir som det var. */
  function mergeTrains(parts) {
    const list = (parts || []).filter(Boolean);
    if (!list.length) return null;
    if (list.length === 1) return Object.assign({}, list[0], { otns: [list[0].otn] });
    const first = list[0];
    const tr = { key: first.key, otn: first.otn, otns: [], ident: first.ident, date: first.date, product: '', to: [], from: [], at: new Map() };
    for (const p of list) {
      if (!tr.otns.includes(p.otn)) tr.otns.push(p.otn);
      if (!tr.product && p.product) tr.product = p.product;
      if (!tr.from.length && p.from.length) tr.from = p.from;
      if (p.to.length) tr.to = p.to; // sista delens destination
      for (const [sig, loc] of p.at) {
        const cur = tr.at.get(sig) || { arr: null, dep: null };
        tr.at.set(sig, { arr: cur.arr || loc.arr, dep: cur.dep || loc.dep });
      }
    }
    return tr;
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
      if (rel === 'overlap') return { kind: 'station', i: p.i, maxIdx: pts[pts.length - 1].i, minIdx: pts[0].i };
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

  /* När det mötande tåget åker från platsen mot oss om det inte behöver vänta på oss: faktisk tid, Trafikverkets
     beräknade tid, senast kända försening framräknad, eller tidtabellen. Aldrig före ankomsten dit och aldrig
     före nu om det inte åkt. null: tåget åker inte därifrån. */
  function theirDeparture(tr, sig, now) {
    const loc = tr.at.get(sig);
    const r = loc && loc.dep;
    if (!r) return null;
    if (r.actual != null) return { t: r.actual, planned: r.plan, source: 'faktisk', departed: true };
    let t, source;
    if (r.est != null) { t = r.est; source = 'trafikverket'; }
    else {
      const ld = latestDelay(tr);
      if (ld && ld.delay > 0) { t = r.plan + ld.delay; source = 'senast'; }
      else { t = r.plan; source = 'plan'; }
    }
    const a = loc.arr ? (loc.arr.actual != null ? loc.arr.actual : loc.arr.est) : null;
    if (a != null) t = Math.max(t, a);
    return { t: Math.max(t, now), planned: r.plan, source, departed: false };
  }

  // Lägsta plats på vår linje där tåget rapporterats (faktisk tid): { k, t, plan } eller null
  function progressOf(tr, line) {
    for (let k = 0; k < line.length; k++) {
      const loc = tr.at.get(line[k].sig);
      if (!loc) continue;
      const r = loc.arr && loc.arr.actual != null ? loc.arr : (loc.dep && loc.dep.actual != null ? loc.dep : null);
      if (r) return { k, t: r.actual, plan: r.plan };
    }
    return null;
  }

  /* Platser på vår linje där tåg kan mötas: där två tåg enligt tidtabell är samtidigt (det kräver två spår),
     ändarna av sträckor med dubbelspår, start- och slutstationen, och platser vi känner till sedan förut
     (known: signaturer). Ger { idx: Set(index), found: [signaturer ur tidtabellen] }. */
  function together(a, b) {
    const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
    if (lo < hi) return true;
    return lo === hi && ((a[0] < lo && lo < a[1]) || (b[0] < lo && lo < b[1]));
  }
  function meetingPlaces(line, trains, double, known) {
    const n = line.length;
    const idx = new Set(n ? [0, n - 1] : []);
    const found = [];
    const knownSet = new Set(known || []);
    for (let i = 0; i < n; i++) {
      const sig = line[i].sig;
      if (knownSet.has(sig)) idx.add(i);
      const iv = [];
      for (const tr of (trains || new Map()).values()) {
        const loc = tr.at.get(sig);
        if (!loc) continue;
        const a = planArr(loc), d = planDep(loc);
        if (a != null && d != null && d >= a) iv.push([a, d]);
      }
      iv.sort((x, y) => x[0] - y[0]);
      let two = false;
      for (let x = 0; x < iv.length && !two; x++) {
        for (let y = x + 1; y < iv.length && iv[y][0] <= iv[x][1]; y++) if (together(iv[x], iv[y])) { two = true; break; }
      }
      if (two) { idx.add(i); found.push(sig); }
    }
    for (let i = 0; i + 1 < n; i++) if (double && double.has(sectionKey(line[i].sig, line[i + 1].sig))) { idx.add(i); idx.add(i + 1); }
    return { idx, found };
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

  /* ── Gångprofiler: tid kvar till nästa station från där vi är ──
     Ur tidigare körningars GPS-spår. Per sträcka A → B och om tåget stannade i A och i B (nyckel "a>b|ss",
     "a>b|ps" …, namnen med små bokstäver som i historyMedians): en referenslinje med en punkt ungefär var
     100:e meter, och för varje punkt medianen av hur lång tid det var kvar till ankomsten i B när tågen var där.
     profileBuilder() tar ett spår i taget, nyast först, så att bara ett spår åt gången behöver finnas i minnet.
     Referenslinjen tas från det nyaste spåret utan glapp. Sträckor som föraren undantagit (excludeInboundRun)
     räknas inte. Varje profil har minst minObs spår, och varje punkt minst minObs värden. */
  const PROFILE = {
    stepM: 100,        // avstånd mellan referenslinjens punkter
    matchM: 100,       // ett spår räknas vid en punkt bara om det var så här nära den
    gapM: 400,         // ett spår med glapp längre än så blir inte referenslinje
    maxAccM: 50,       // positioner med sämre noggrannhet används inte
    maxTracks: 15,     // högst så många spår per sträcka (de nyaste)
    minObs: 3,
    stopDwellMs: 8000, // uppehåll minst så här långt = stannade (passager under 6 s, stopp från 10 s i datan 2026-11)
    lookupM: 300       // vi måste vara högst så här långt från referenslinjen
  };
  const nameKey = s => String(s || '').trim().toLowerCase();
  function legKey(a, b, stopA, stopB) { return `${nameKey(a)}>${nameKey(b)}|${stopA ? 's' : 'p'}${stopB ? 's' : 'p'}`; }

  // Spårets positioner { t, lat, lon } i tidsordning (format från appens GPS-spår: t0 + fält)
  function trackPoints(track) {
    const t0 = ms(track && track.t0);
    if (t0 == null) return [];
    const f = Array.isArray(track.fields) ? track.fields : ['t_ms', 'lat', 'lon', 'acc_m'];
    const it = f.indexOf('t_ms'), ila = f.indexOf('lat'), ilo = f.indexOf('lon'), iac = f.indexOf('acc_m');
    const out = [];
    for (const p of Array.isArray(track.points) ? track.points : []) {
      if (!Array.isArray(p)) continue;
      const t = t0 + Number(p[it]), lat = Number(p[ila]), lon = Number(p[ilo]);
      const acc = iac >= 0 && p[iac] != null ? Number(p[iac]) : null;
      if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (acc != null && acc > PROFILE.maxAccM) continue;
      out.push({ t, lat, lon });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // Körningens sträckor med avgång från A, ankomst till B och om tåget stannade där
  function runLegs(run) {
    const stops = Array.isArray(run && run.stops) ? run.stops : [];
    const out = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const A = stops[i], B = stops[i + 1];
      if (!A || !B || B.excludeInboundRun || B.missedReason) continue;
      const dep = ms(A.actualDeparture), arr = ms(B.actualArrival);
      if (dep == null || arr == null || !(arr > dep) || arr - dep > 3 * 3600000) continue;
      const aArr = ms(A.actualArrival), bDep = ms(B.actualDeparture);
      const stopA = i === 0 || (aArr != null && dep - aArr >= PROFILE.stopDwellMs);
      const stopB = i + 1 === stops.length - 1 || (bDep != null && bDep - arr >= PROFILE.stopDwellMs);
      out.push({ key: legKey(A.name, B.name, stopA, stopB), from: A.name, to: B.name, stopA, stopB, dep, arr });
    }
    return out;
  }

  function profileBuilder(opts) {
    const o = Object.assign({}, PROFILE, opts || {});
    const legs = new Map();
    // Referenslinjen: punkter minst stepM isär, sista punkten (vid B) med; null om spåret har glapp
    function thin(pts) {
      const ref = [[pts[0].lat, pts[0].lon]];
      for (let k = 1; k < pts.length; k++) {
        const p = pts[k], q = pts[k - 1], last = ref[ref.length - 1];
        if (haversine(q.lat, q.lon, p.lat, p.lon) > o.gapM) return null;
        if (haversine(last[0], last[1], p.lat, p.lon) >= o.stepM) ref.push([p.lat, p.lon]);
      }
      const end = pts[pts.length - 1], last = ref[ref.length - 1];
      if (haversine(last[0], last[1], end.lat, end.lon) > 5) ref.push([end.lat, end.lon]);
      return ref;
    }
    /* Tid kvar till ankomsten (s) när spåret var vid varje referenspunkt: den sista tidpunkten spåret var som
       närmast punkten (står tåget still där räknas när det åkte), framåt i tiden, högst matchM bort. */
    function remsFor(ref, pts, arr) {
      const out = new Array(ref.length).fill(null);
      let j = 0;
      for (let k = 0; k < ref.length; k++) {
        let best = Infinity, end = pts.length;
        const d = new Array(pts.length);
        for (let x = j; x < pts.length; x++) {
          d[x] = haversine(ref[k][0], ref[k][1], pts[x].lat, pts[x].lon);
          if (d[x] < best) best = d[x];
          else if (d[x] > best + 300) { end = x; break; }
        }
        if (best > o.matchM) continue;
        let bi = j;
        for (let x = j; x < end; x++) if (d[x] <= best + 10) bi = x;
        out[k] = Math.round((arr - pts[bi].t) / 1000);
        j = bi;
      }
      return out;
    }
    // Sträckor med glapp som kom innan det fanns en referenslinje: räknas när en finns
    const waiting = new Map();
    function count(L, seg, leg) {
      if (L.rems.length >= o.maxTracks) return false;
      const r = remsFor(L.ref, seg, leg.arr);
      if (r.filter(v => v != null).length < 0.6 * r.length) return false; // spåret täcker inte sträckan
      L.rems.push(r);
      L.durs.push(leg.arr - leg.dep);
      return true;
    }
    function add(run, track) {
      const pts = trackPoints(track);
      if (pts.length < 2) return 0;
      let used = 0;
      for (const leg of runLegs(run)) {
        const seg = pts.filter(p => p.t >= leg.dep - 2000 && p.t <= leg.arr + 2000);
        if (seg.length < 5) continue;
        let L = legs.get(leg.key);
        if (!L) {
          const ref = thin(seg);
          if (!ref || ref.length < 2) {
            if (!waiting.has(leg.key)) waiting.set(leg.key, []);
            if (waiting.get(leg.key).length < o.maxTracks) waiting.get(leg.key).push({ seg, leg });
            continue;
          }
          L = { key: leg.key, from: leg.from, to: leg.to, stopA: leg.stopA, stopB: leg.stopB, ref, rems: [], durs: [] };
          legs.set(leg.key, L);
          for (const w of waiting.get(leg.key) || []) if (count(L, w.seg, w.leg)) used++;
          waiting.delete(leg.key);
        }
        if (count(L, seg, leg)) used++;
      }
      return used;
    }
    function result() {
      const out = new Map();
      for (const L of legs.values()) {
        if (L.rems.length < o.minObs) continue;
        const pts = [];
        L.ref.forEach((p, k) => {
          const vals = L.rems.map(r => r[k]).filter(v => v != null);
          if (vals.length >= o.minObs) pts.push([Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5, Math.round(median(vals)), vals.length]);
        });
        if (pts.length < 2) continue;
        out.set(L.key, { key: L.key, from: L.from, to: L.to, stopA: L.stopA, stopB: L.stopB, n: L.rems.length,
          legSec: Math.round(median(L.durs) / 1000), pts });
      }
      return out;
    }
    return { add, result };
  }

  // Punkten p projicerad på sträckan a–b (meter, lokalt plant): { d: avstånd, f: 0–1 längs sträckan }
  function project(p, a, b) {
    const kx = 111320 * Math.cos(a[0] * Math.PI / 180), ky = 110540;
    const bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * ky, px = (p.lon - a[1]) * kx, py = (p.lat - a[0]) * ky;
    const len2 = bx * bx + by * by;
    const f = len2 > 0 ? clamp((px * bx + py * by) / len2, 0, 1) : 0;
    return { d: Math.hypot(px - f * bx, py - f * by), f };
  }
  /* Tid kvar till B (s) från läget pos ({ lat, lon }) enligt profilen: { sec, distM, n, start } eller null när
     vi är längre än lookupM från referenslinjen. Mellan två punkter vägs tiden efter var vi är. start är tiden
     kvar från A, så att man ser hur långt in på sträckan vi är. */
  function remainingFrom(profile, pos, maxM) {
    const pts = profile && profile.pts;
    if (!Array.isArray(pts) || pts.length < 2 || !pos) return null;
    let best = null;
    for (let k = 0; k + 1 < pts.length; k++) {
      const pr = project(pos, pts[k], pts[k + 1]);
      if (!best || pr.d < best.d) best = { k, d: pr.d, f: pr.f };
    }
    if (!best || best.d > (maxM || PROFILE.lookupM)) return null;
    const a = pts[best.k], b = pts[best.k + 1];
    return { sec: a[2] + (b[2] - a[2]) * best.f, distM: Math.round(best.d), n: Math.min(a[3], b[3]), start: pts[0][2] };
  }
  /* Beräknad ankomst till nästa station från där vi är. q: { from, to, stopA, stopB, pos: { lat, lon }, at
     (positionens tid), now }. Profilen för samma uppehåll i A gäller; finns bara den andra (stannade i A eller
     inte) används den först när vi är förbi första fjärdedelen av sträckan, eftersom starten skiljer.
     Ger { t, sec, key, n, exact } eller null. */
  function positionEstimate(profiles, q) {
    if (!profiles || !q || !q.pos) return null;
    const exact = legKey(q.from, q.to, q.stopA, q.stopB), other = legKey(q.from, q.to, !q.stopA, q.stopB);
    const get = k => profiles instanceof Map ? profiles.get(k) : profiles[k];
    let p = get(exact), r = p ? remainingFrom(p, q.pos) : null, isExact = true;
    if (!r) {
      p = get(other);
      r = p ? remainingFrom(p, q.pos) : null;
      if (r && r.sec > 0.75 * r.start) r = null;
      isExact = false;
    }
    if (!r) return null;
    const at = q.at != null ? q.at : q.now;
    return { t: Math.max(at + r.sec * 1000, q.now != null ? q.now : at), sec: Math.round(r.sec), key: p.key, n: r.n, exact: isExact, distM: r.distM };
  }

  /* ── Linjen längs banan ──
     Referenslinjerna i gångprofilerna följer spåret. Lagda efter varandra längs vår rutt (stops: [{ name, sig,
     lat, lon }] i ordning) blir de en axel med meter längs banan, så att ett tågs position kan jämföras med
     mötesplatserna längs spåret i stället för fågelvägen – som lurar där banan svänger. En sträcka utan profil
     blir en rak linje mellan stationerna och räknas inte som uppmätt; där används fågelvägen som förut.
     Profilen åt andra hållet duger (punkterna vänds). Ger { pts: [[lat, lon, d]], meas: [uppmätt per delsträcka],
     len, stations: { sig: d }, measuredLegs } eller null utan någon uppmätt sträcka. */
  const AXIS = { gapM: 400, endM: 1500 };
  function buildAxis(stops, profiles) {
    const list = (Array.isArray(stops) ? stops : []).filter(s => s && s.name);
    if (list.length < 2 || !profiles) return null;
    const all = profiles instanceof Map ? Array.from(profiles.values()) : Object.values(profiles);
    const has = s => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)) && s.lat != null && s.lon != null;
    const pts = [], meas = [];
    let measuredLegs = 0, prevMeasured = false;
    const push = (lat, lon, measured) => {
      const last = pts[pts.length - 1];
      if (!last) { pts.push([lat, lon, 0]); return; }
      const dd = haversine(last[0], last[1], lat, lon);
      if (dd < 1) return;
      meas.push(!!measured && dd <= AXIS.gapM);
      pts.push([lat, lon, last[2] + dd]);
    };
    const bounds = [];   // index i axeln där varje sträcka börjar
    for (let s = 0; s + 1 < list.length; s++) {
      const A = list[s], B = list[s + 1];
      const fw = `${nameKey(A.name)}>${nameKey(B.name)}|`, bw = `${nameKey(B.name)}>${nameKey(A.name)}|`;
      const pick = pre => all.filter(p => p && String(p.key || '').startsWith(pre) && Array.isArray(p.pts) && p.pts.length >= 2)
        .sort((a, b) => (b.n || 0) - (a.n || 0))[0] || null;
      let prof = pick(fw), path = prof ? prof.pts.map(p => [p[0], p[1]]) : null;
      if (!prof) { prof = pick(bw); path = prof ? prof.pts.map(p => [p[0], p[1]]).reverse() : null; }
      // Profilen ska börja vid A och sluta vid B
      if (path && ((has(A) && haversine(path[0][0], path[0][1], A.lat, A.lon) > AXIS.endM) ||
                   (has(B) && haversine(path[path.length - 1][0], path[path.length - 1][1], B.lat, B.lon) > AXIS.endM))) path = null;
      bounds.push(Math.max(pts.length - 1, 0));
      if (path) {
        path.forEach((p, k) => push(p[0], p[1], k === 0 ? prevMeasured : true));
        measuredLegs++;
        prevMeasured = true;
      } else {
        if (!has(A) || !has(B)) return null; // utan läge går sträckan inte att rita
        push(Number(A.lat), Number(A.lon), false);
        push(Number(B.lat), Number(B.lon), false);
        prevMeasured = false;
      }
    }
    bounds.push(pts.length - 1);
    if (!measuredLegs || pts.length < 2) return null;
    const axis = { pts, meas, len: pts[pts.length - 1][2], stations: {}, measuredLegs };
    // Stationernas läge längs banan: deras koordinat projicerad nära skarven mellan sträckorna
    list.forEach((s, k) => {
      if (!s.sig) return;
      const joint = pts[bounds[k]][2];
      let d = joint;
      if (has(s)) {
        const loc = axisLocate(axis, { lat: Number(s.lat), lon: Number(s.lon) }, { from: pts[bounds[Math.max(k - 1, 0)]][2], to: pts[bounds[Math.min(k + 1, bounds.length - 1)]][2] });
        if (loc && loc.off <= 1000) d = loc.d;
      }
      axis.stations[s.sig] = Math.round(d);
    });
    return axis;
  }
  /* Läget p ({ lat, lon }) längs axeln: { d (meter längs banan), off (meter från linjen), k (delsträcka) } eller
     null. range { from, to } (meter) begränsar sökningen. */
  function axisLocate(axis, p, range) {
    const pts = axis && axis.pts;
    if (!Array.isArray(pts) || pts.length < 2 || !p || !Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lon))) return null;
    const q = { lat: Number(p.lat), lon: Number(p.lon) };
    let best = null;
    for (let k = 0; k + 1 < pts.length; k++) {
      if (range && (pts[k + 1][2] < range.from || pts[k][2] > range.to)) continue;
      const pr = project(q, pts[k], pts[k + 1]);
      if (!best || pr.d < best.off) best = { k, off: pr.d, f: pr.f };
    }
    if (!best) return null;
    const a = pts[best.k], b = pts[best.k + 1];
    return { d: a[2] + (b[2] - a[2]) * best.f, off: Math.round(best.off), k: best.k };
  }
  // Följer axeln uppmätta spår hela vägen mellan d1 och d2?
  function axisMeasured(axis, d1, d2) {
    if (!axis || !Array.isArray(axis.pts)) return false;
    const lo = Math.min(d1, d2), hi = Math.max(d1, d2);
    if (lo < -AXIS.gapM || hi > axis.len + AXIS.gapM) return false;
    for (let k = 0; k + 1 < axis.pts.length; k++) {
      if (axis.pts[k + 1][2] < lo || axis.pts[k][2] > hi) continue;
      if (!axis.meas[k]) return false;
    }
    return true;
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

  /* Vår ankomst till plats c om vi åker från plats i vid tiden t, utan möten: samma räkning som i predict
     (planerad gångtid × faktor, uppehåll vid stoppen däremellan, inte före annonserad avgång, aldrig före nu). */
  function travel(line, ratios, i, t, c, now, opts) {
    let x = t;
    for (let k = i; k < c; k++) {
      x = Math.max(x + plannedRun(line, k) * ratios[k], now);
      if (k + 1 < c) {
        const L = line[k + 1];
        let d = x + (L.stop ? opts.minDwellMs : 0);
        if (L.advDep != null) d = Math.max(d, L.advDep);
        x = Math.max(d, now);
      }
    }
    return x;
  }

  // ── Prognosen ──
  /* Vår beräknade ankomst och avgång vid varje plats. known: index → { arr, dep } (verkliga tider).
     meets: mötena med planerad mötesplats m.i (compute). Där väntar vi, om mötet beror på oss (m.dependent),
     tills det mötande tåget kommit in + marginalen.
     move(m, i, dep, arriveAt): kan mötet i stället bli vid plats i före den planerade (compute)? Ger
     { need, kind, their } = möte här, vi kan åka tidigast need; { done } = mötet är avklarat utan väntan här;
     null = inte här. arriveAt(c) = vår ankomst till plats c om vi åker från i vid dep.
     Efteråt har varje möte atI (var mötet blir), waitMs, ourDep och move ('rapporterat', 'beräknat' eller null).
     pos: { i, t } = ankomsten till plats i räknad från där vi är (gångprofilerna). Platserna mellan senaste
     kända plats och i räknas då bakåt från den med planerad gångtid × faktor.
     Platser vi inte nått än ligger aldrig före nu. */
  function predict(line, known, meets, ratios, now, opts, move, pos) {
    const n = line.length;
    let f = -1;
    for (let i = 0; i < n; i++) if (known[i] && (known[i].arr != null || known[i].dep != null)) f = i;
    const preds = [];
    const list = (meets || []).slice().sort((a, b) => a.i - b.i);
    for (const m of list) Object.assign(m, { atI: m.i, waitMs: 0, ourDep: null, need: null, move: null, moveVia: null, theirAt: null, onLine: false, resolved: false });
    for (let i = 0; i < n; i++) {
      const L = line[i], K = known[i] || {};
      const p = { arr: null, dep: null, base: null, waitMs: 0 };
      if (i < f) { p.arr = K.arr != null ? K.arr : null; p.dep = K.dep != null ? K.dep : null; preds.push(p); continue; }
      if (i > 0) {
        if (K.arr != null) p.arr = K.arr;
        else if (i > f && pos && i <= pos.i) {
          let back = 0;
          for (let k = i; k < pos.i; k++) back += plannedRun(line, k) * ratios[k];
          p.arr = Math.max(pos.t - back, now);
        } else if (i > f) {
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
          const here = [];
          // Möten som enligt tidtabell är här
          for (const m of list) {
            if (m.resolved || m.i !== i) continue;
            m.resolved = true;
            if (m.dependent) { m.need = m.their.t + opts.meetMarginMs; if (m.need > dep) dep = m.need; }
            here.push(m);
          }
          // Möten längre fram som i stället blir här. Väntar vi här kan fler hinna fram först, så frågan
          // ställs igen tills inget ändras.
          if (move) {
            let again = true;
            for (let round = 0; again && round <= list.length; round++) {
              again = false;
              for (const m of list) {
                if (m.resolved || m.i <= i) continue;
                const d0 = dep;
                const r = move(m, i, dep, c => travel(line, ratios, i, d0, c, now, opts));
                if (!r) continue;
                m.resolved = true;
                if (r.done) { m.onLine = !!r.onLine; m.atI = i; m.moveVia = r.via || null; continue; }
                Object.assign(m, { atI: i, move: r.kind, moveVia: r.via || null, need: r.need, theirAt: r.their || null });
                here.push(m);
                if (r.need > dep) { dep = r.need; again = true; }
              }
            }
          }
          for (const m of here) {
            m.ourDep = dep;
            m.waitMs = m.need != null ? Math.max(0, Math.min(dep, m.need) - p.base) : 0;
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

  /* Kortaste planerade byte som räknas: bytestiden för de vanliga. En egen anslutning (o.match, valet Mina) räknas
     så länge den enligt tidtabell inte går före vår ankomst (eller kommer efter vår avgång) – föraren har själv
     sagt att den gäller. */
  const lowestPlanned = o => o.match ? 0 : Math.max(o.minPlannedTransferMin, o.transferMin);

  // Vårt eget tåg, även en annan del av det (eget OTN, samma tåg)
  function isOurs(tr, our) {
    return !!tr && !!our && (tr.key === our.key || tr.otn === our.otn || (Array.isArray(our.otns) && our.otns.includes(tr.otn)));
  }

  // Tåg som går från slutstationen efter vår ankomst
  function outgoing(trains, our, endL, predArr, arrived, lineSigs, now, o) {
    const out = [];
    const ourAdv = endL.advArr != null ? endL.advArr : endL.plannedArr;
    if (ourAdv == null) return out;
    for (const tr of trains.values()) {
      if (isOurs(tr, our)) continue;
      if (o.match && !o.match('tåg', tr.ident, tr.otn)) continue;
      const loc = tr.at.get(endL.sig);
      const dep = loc && loc.dep;
      if (!dep || !dep.advertised) continue;
      // En anslutning går minst bytestiden efter vår ankomst enligt tidtabell (en egen: inte före vår ankomst)
      const plannedTransfer = (dep.adv - ourAdv) / MIN;
      if (plannedTransfer < lowestPlanned(o) || plannedTransfer > o.connectionWindowMin) continue;
      if (!o.match && alongOurLine(tr, lineSigs, endL.sig)) continue;
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
      if (isOurs(tr, our)) continue;
      if (o.match && !o.match('tåg', tr.ident, tr.otn)) continue;
      const loc = tr.at.get(startL.sig);
      const arr = loc && loc.arr;
      if (!arr || !arr.advertised) continue;
      const plannedTransfer = (ourAdv - arr.adv) / MIN;
      if (plannedTransfer < lowestPlanned(o) || plannedTransfer > o.incomingWindowMin) continue;
      if (!o.match && alongOurLine(tr, lineSigs, startL.sig)) continue;
      const arrived = arr.actual != null;
      const theirArr = arrived ? arr.actual : Math.max(arr.est != null ? arr.est : arr.adv, now);
      const transfer = (predDep - theirArr) / MIN;
      out.push({
        kind: 'tåg', otn: tr.otn, ident: tr.ident, product: tr.product, from: tr.from,
        adv: arr.adv, arr: theirArr, delayMin: roundMin(theirArr - arr.adv), track: arr.track,
        transferMin: Math.floor(transfer), plannedTransferMin: Math.round(plannedTransfer), arrived,
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
      if (o.match && !o.match('buss', b.line)) continue;
      const plannedTransfer = (b.planned - ourAdv) / MIN;
      if (plannedTransfer < lowestPlanned(o) || plannedTransfer > o.connectionWindowMin) continue;
      const k = townKey(b.direction);
      if (!o.match && k && towns.has(k)) continue;
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
      if (o.match && !o.match('buss', b.line)) continue;
      const plannedTransfer = (ourAdv - b.planned) / MIN;
      if (plannedTransfer < lowestPlanned(o) || plannedTransfer > o.incomingWindowMin) continue;
      const k = townKey(b.origin);
      if (!o.match && k && towns.has(k)) continue;
      const t = b.est != null ? b.est : b.planned;
      const arrived = t <= now;
      const theirArr = arrived ? t : Math.max(t, now);
      const transfer = (predDep - theirArr) / MIN;
      out.push({
        kind: 'buss', otn: b.id, ident: b.line, product: 'Buss', from: [], fromText: b.origin,
        adv: b.planned, arr: theirArr, delayMin: roundMin(theirArr - b.planned), track: b.platform, stop: b.stop,
        transferMin: Math.floor(transfer), plannedTransferMin: Math.round(plannedTransfer), arrived,
        status: b.canceled ? 'inställt' : connectionStatus(transfer, o),
        source: b.est != null ? 'västtrafik' : 'plan'
      });
    }
    out.sort((a, b) => a.adv - b.adv);
    return out.slice(0, o.maxConnections);
  }

  /* Valet Tåg | Buss | Båda (mode 'tag', 'buss', 'bada'). Ger de som visas och hur många tåg och bussar
     som döljs. */
  const CONN_MODES = ['tag', 'buss', 'bada', 'mina'];
  function connShows(mode, c) {
    if (mode === 'mina') return !!(c.own || c.marked);
    if (mode === 'bada') return true;
    return mode === 'buss' ? c.kind === 'buss' : c.kind !== 'buss';
  }

  /* Egna anslutningar (valet Mina): föraren anger till exempel "buss 600 Lidköping" eller "tåg 182 Herrljunga C".
     En post: { kind: 'tåg'|'buss', id: tågnummer eller busslinje, sig: stationens signatur }. Ett tåg känns igen på
     det annonserade tågnumret eller det operativa, en buss på linjen. */
  function normOwn(list) {
    const out = [];
    for (const e of list || []) {
      if (!e || !e.sig) continue;
      const kind = e.kind === 'buss' ? 'buss' : 'tåg';
      const id = String(e.id == null ? '' : e.id).trim().toLowerCase();
      if (id) out.push({ kind, id, sig: e.sig });
    }
    return out;
  }
  function ownMatcher(entries) {
    return (kind, ...ids) => entries.some(e => e.kind === kind && ids.some(x => x != null && String(x).trim().toLowerCase() === e.id));
  }
  // Tolkar det föraren skriver: "buss 600 Lidköping", "tåg 182 från Herrljunga C", "Buss 1 vid Vara"
  function parseOwn(text) {
    const m = String(text || '').trim().match(/^(buss|bus|tåg|tag)(?:\.?\s+|(?=\d))([0-9a-zåäö]+)\s+(?:(?:från|fr\.?|i|vid|på)\s+)?(.+)$/i);
    if (!m) return null;
    const k = m[1].toLowerCase();
    return { kind: k === 'buss' || k === 'bus' ? 'buss' : 'tåg', id: m[2], place: m[3].trim() };
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
      if (tr.key === input.ourKey || isOurs(tr, our)) continue;
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

    /* Längs banan (input.axis, buildAxis): platserna, vi och de mötande tågen i meter längs vår linje. Ett tågs
       läge räknas bara där linjen är uppmätt (GPS-spår) mellan tåget och platsen, och tåget är högst axisSureOffM
       från den. Platser vars läge inte följer linjens ordning räknas inte. */
    const axis = input.axis && Array.isArray(input.axis.pts) && input.axis.pts.length >= 2 ? input.axis : null;
    const lineD = line.map(() => null);
    if (axis) {
      for (let i = 0; i < n; i++) {
        const sig = line[i].sig;
        if (axis.stations && axis.stations[sig] != null) { lineD[i] = axis.stations[sig]; continue; }
        const st = coords.get(sig);
        const loc = st ? axisLocate(axis, st) : null;
        if (loc && loc.off <= 1000) lineD[i] = loc.d;
      }
      let hi = -Infinity;
      for (let i = 0; i < n; i++) {
        if (lineD[i] == null) continue;
        if (lineD[i] < hi - 300) lineD[i] = null; else hi = Math.max(hi, lineD[i]);
      }
    }
    let usD;
    function ourD() {
      if (usD !== undefined) return usD;
      usD = null;
      if (!axis) return usD;
      if (input.ourPos) {
        const loc = axisLocate(axis, input.ourPos);
        if (loc && loc.off <= o.axisOurOffM) usD = loc.d;
      }
      if (usD == null) for (let k = Math.max(frontier, 0); k >= 0 && usD == null; k--) usD = lineD[k];
      return usD;
    }
    const alongCache = new Map();
    // Det mötande tågets läge längs banan: { d, off, t, speedKmh } eller null (ingen färsk position, långt från linjen)
    function trainAlong(otn) {
      const key = String(otn);
      if (alongCache.has(key)) return alongCache.get(key);
      let r = null;
      const pos = positions.get(key);
      if (axis && pos && now - pos.t <= o.positionMaxAgeMs) {
        const loc = axisLocate(axis, pos);
        if (loc && loc.off <= o.axisSureOffM) r = { d: loc.d, off: loc.off, t: pos.t, speedKmh: pos.speedKmh };
      }
      alongCache.set(key, r);
      return r;
    }
    // Läget säkert längs banan mellan d1 och d2 (uppmätt linje hela vägen)
    const sureBetween = (d1, d2) => d1 != null && d2 != null && axisMeasured(axis, d1, d2);
    /* Hur långt på vår sida om en plats tåget måste vara för att ha lämnat den mot oss: står det still, eller vet vi
       inte farten, kan det stå kvar vid utfartssignalen i ett långt mötesspår. */
    const leftM = T => T.speedKmh != null && T.speedKmh > o.axisStandKmh ? o.axisAtM : o.axisStandM;

    function positionAt(otn, sig, i) {
      const pos = positions.get(String(otn));
      const st = coords.get(sig);
      if (!pos || now - pos.t > o.positionMaxAgeMs) return null;
      // Längs banan, när linjen är uppmätt mellan tåget, platsen och oss
      const T = trainAlong(otn), dS = lineD[i];
      if (T && dS != null) {
        const dU = ourD();
        if (sureBetween(Math.min(T.d, dS, dU != null ? dU : dS), Math.max(T.d, dS))) {
          const alongM = Math.abs(T.d - dS);
          const side = dU != null && T.d < dU - o.axisAtM ? 'behind'
            : (T.d > dS + o.axisAtM ? 'beyond' : (dS - T.d > leftM(T) ? 'passed' : 'at'));
          return { distM: Math.round(alongM), along: true, rel: Math.round(T.d - dS), speedKmh: pos.speedKmh, ageS: Math.max(0, Math.round((now - pos.t) / 1000)), t: pos.t, side };
        }
      }
      if (!st) return null;
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

    const meetings = [];
    const trainOf = new Map(); // mötets nyckel → det mötande tåget
    for (const { tr, c } of raw) {
      const i = c.i;
      if (i >= n - 1) continue;                         // vid slutstationen åker vi inte vidare
      if (i < frontier || (i === frontier && known[i].dep != null)) continue; // redan passerat
      // Rapporterat där vi redan varit: tåget har passerat oss, mötet är avklarat
      const prog = progressOf(tr, line);
      if (prog && (prog.k < frontier || (prog.k === frontier && known[frontier].dep != null))) continue;
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
      let movedVia = moved ? 'rapport' : null;
      if (their.departed && !(known[i].arr != null)) { moved = true; movedVia = movedVia || 'rapport'; }
      // Tågets senaste position (TrainPosition): avstånd till mötesplatsen, och var det är i förhållande till den.
      // Är det fortfarande på andra sidan mötesplatsen kan det inte vara framme tidigare än avståndet i högsta
      // fart – en undre gräns som aldrig gör prognosen för tidig. Längs uppmätt bana (along) är läget säkert:
      // har tåget passerat mötesplatsen mot oss är mötet flyttat, och har det passerat oss är mötet avklarat.
      // Med fågelvägen används positionen annars bara för att visa.
      const position = positionAt(tr.otn, line[i].sig, i);
      if (position && position.along && position.side === 'behind') continue;
      if (position && position.along && position.side === 'passed' && !moved) { moved = true; movedVia = 'position'; }
      if (position && position.side === 'beyond' && !their.arrived) {
        const earliest = position.t + position.distM / o.maxSpeedMs * 1000;
        if (earliest > their.t) { their.t = earliest; their.source = 'position'; }
      }
      const m = {
        key: `${tr.key}|${i}`, trainKey: tr.key,
        i, sig: line[i].sig, otn: tr.otn, ident: tr.ident, product: tr.product, position,
        their, theirDelayMin: roundMin(their.t - their.planned),
        single, canceled, moved, movedVia,
        dependent: single && !canceled && !moved && c.maxIdx > i,
        minIdx: c.minIdx != null ? c.minIdx : 0, prog,
        waitMs: 0, ourDep: null
      };
      trainOf.set(m.key, tr);
      meetings.push(m);
    }

    /* Flyttade möten. Tågklareraren kan flytta ett möte närmare oss när vi är sena, så att det mötande tåget
       inte står och väntar på oss. På enkelspår mellan två mötesplatser (sträckan i–c) får bara ett av tågen
       vara ute: antingen väntar vi i i tills det mötande tåget kommit in, eller så väntar det i c tills vi
       kommit dit. Vi räknar med det som ger minst väntan sammanlagt. Har tåget redan åkt mot oss från c
       (rapporterat) blir mötet här. Ett möte flyttas aldrig längre bort än tidtabellens mötesplats, så när
       det mötande tåget är sent väntar vi där som förut – prognosen blir aldrig tidigare av det här. */
    const places = meetingPlaces(line, trains, double, input.knownMeetPlaces);
    for (const { c } of raw) places.idx.add(c.i);
    const nextPlace = i => { for (let k = i + 1; k < n; k++) if (places.idx.has(k)) return k; return n - 1; };
    const singleBetween = (a, b) => { for (let k = a; k < b; k++) if (double.has(sectionKey(line[k].sig, line[k + 1].sig))) return false; return true; };
    function move(m, i, dep, arriveAt) {
      const tr = trainOf.get(m.key);
      if (!tr || m.canceled || !places.idx.has(i) || m.minIdx > i) return null;
      const here = tr.at.get(line[i].sig);
      if (m.prog && m.prog.k <= i) {
        // Rapporterat här: står det här möts vi här; har det redan åkt härifrån är mötet avklarat
        if (m.prog.k === i && here && here.arr && here.arr.actual != null && !(here.dep && here.dep.actual != null)) {
          return { need: here.arr.actual + o.meetMarginMs, kind: 'rapporterat', via: 'rapport', their: theirArrival(tr, line[i].sig, now) };
        }
        return { done: true };
      }
      const c = nextPlace(i);
      if (c > m.i) return null;
      const X0 = theirArrival(tr, line[i].sig, now);
      if (!X0) return null;
      const cLoc = tr.at.get(line[c].sig);
      // Ute på sträckan mot oss: åkt från c, eller rapporterat mellan c och oss
      let entered = !!(cLoc && cLoc.dep && cLoc.dep.actual != null) || !!(m.prog && m.prog.k < c);
      let via = entered ? 'rapport' : null;
      /* Längs uppmätt bana: har tåget lämnat c mot oss är det ute på sträckan (eller redan här i i). Står det
         still, eller vet vi inte farten, kan det stå kvar vid utfartssignalen i c – då krävs att det är längre ut.
         Är det förbi i mot oss möts vi på sträckan (dubbelspår, eller fel i uppgifterna) utan väntan här. */
      const T = trainAlong(tr.otn), di = lineD[i], dc = lineD[c];
      let beyondC = null;
      if (T && di != null && dc != null && sureBetween(Math.min(T.d, di), Math.max(T.d, dc))) {
        if (T.d < di - leftM(T)) return { done: true, onLine: true, via: 'position' };
        if (!entered && T.d <= dc - leftM(T)) { entered = true; via = 'position'; }
        else if (T.d > dc + o.axisAtM) beyondC = T;
      }
      let E = entered ? null : theirDeparture(tr, line[c].sig, now);
      // Fortfarande på andra sidan c: kan inte åka därifrån förrän tidigast efter avståndet i högsta fart
      if (E && beyondC && !E.departed) {
        const earliest = beyondC.t + (beyondC.d - dc) / o.maxSpeedMs * 1000;
        if (earliest > E.t) E = Object.assign({}, E, { t: earliest, source: 'position' });
      }
      // Hit kommer tåget tidigast efter avgången från c och sin planerade gångtid, och efter senaste rapporten
      let t = X0.t, source = X0.source;
      const later = (v, s) => { if (v != null && v > t) { t = v; source = s; } };
      if (E && X0.planned != null && E.planned != null) later(E.t + (X0.planned - E.planned), E.source);
      if (m.prog && X0.planned != null && m.prog.plan != null) later(m.prog.t + (X0.planned - m.prog.plan), 'senast');
      const pos = positionAt(tr.otn, line[i].sig, i);
      if (pos && pos.side === 'beyond') later(pos.t + pos.distM / o.maxSpeedMs * 1000, 'position');
      const their = Object.assign({}, X0, { t, source });
      if (!singleBetween(i, c)) {
        // Dubbelspår till nästa mötesplats: möts vi på sträckan blir det ingen väntan
        if (entered || (E && E.t < arriveAt(c) && t > dep)) return { done: true, onLine: true, via };
        return null;
      }
      if (entered) return { need: t + o.meetMarginMs, kind: 'rapporterat', via, their };
      if (!o.predictMoves || !E) return null;
      const A = arriveAt(c);
      if (E.t >= A) return null; // vi hinner till c innan de vill åka därifrån: mötet blir längre fram
      const ourWait = t + o.meetMarginMs - dep;   // vi väntar här
      const theirWait = A + o.meetMarginMs - E.t; // de väntar i c
      if (ourWait > theirWait) return null;
      return { need: t + o.meetMarginMs, kind: m.moved ? 'rapporterat' : 'beräknat', via: m.moved ? m.movedVia : null, their };
    }

    /* Från där vi är (input.posAt: { sig, t }, gångprofilerna i appen): ankomsten till nästa station i rutten.
       Gäller bara en plats vi inte nått, efter den senaste vi har en tid för. */
    let pos = null;
    if (input.posAt && input.posAt.t != null && idxOf.has(input.posAt.sig)) {
      const pi = idxOf.get(input.posAt.sig);
      if (pi > 0 && pi > frontier && known[pi].arr == null) pos = { i: pi, t: Math.max(input.posAt.t, now) };
    }
    const rec = recoveryRatios(line, routeNames, input.history, o);
    const { preds } = predict(line, known, meetings, rec.ratios, now, o, move, pos);
    // Samma prognos utan egna gångtider: så mycket tar vi igen tack vare dem
    const plain = rec.obs ? predict(line, known, meetings.map(m => Object.assign({}, m)), line.map(() => 1), now, o, move, pos).preds : preds;
    // Var mötet blir: plats, det mötande tågets ankomst dit och position i förhållande till den platsen
    for (const m of meetings) {
      m.at = line[m.atI].sig;
      if (m.atI !== m.i) {
        if (m.theirAt) { m.their = m.theirAt; m.theirDelayMin = roundMin(m.their.t - m.their.planned); }
        m.position = positionAt(m.otn, m.at, m.atI);
        m.single = singleBetween(m.atI, nextPlace(m.atI));
      }
      delete m.theirAt; delete m.need; delete m.resolved;
    }

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
      if (known[i].arr == null && preds[i].arr != null && preds[i].arr - now > o.midHorizonMin * MIN) continue;
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

    /* Egna anslutningar (input.own, valet Mina): vid alla stationer framför oss där vi stannar, också utanför de
       vanliga fönstren och bortom midHorizonMin – från oss högst ownWindowMin efter vår ankomst, till oss högst
       ownIncomingWindowMin före vår avgång. Föraren har själv sagt att de gäller, så de räknas även när de går
       längs vår linje. ownStatus säger för varje post om den hittades, och annars varför inte. */
    const own = normOwn(input.own);
    const ownFound = new Set();
    const ownEnd = [], ownStart = [], ownMid = new Map();
    const ownIdOf = c => [c.ident, c.otn].filter(x => x != null).map(x => String(x).trim().toLowerCase());
    if (own.length) {
      for (let i = Math.max(frontier, 0); i < n; i++) {
        const L = line[i];
        const entries = own.filter(e => e.sig === L.sig);
        if (!entries.length) continue;
        const isStart = i === 0, isEnd = i === n - 1;
        if (!isStart && !isEnd && (!L.stop || known[i].dep != null)) continue;
        const oo = Object.assign({}, o, { match: ownMatcher(entries), connectionWindowMin: o.ownWindowMin, incomingWindowMin: o.ownIncomingWindowMin });
        const towns = lineTownsExcept(line, names, L.sig);
        const b = busAt(L.sig);
        const out = [], into = [];
        if (!isStart && preds[i].arr != null) {
          out.push(...outgoing(trains, our, L, preds[i].arr, known[i].arr != null, lineSigs, now, oo));
          if (b) out.push(...busOutgoing(b.departures, L, preds[i].arr, known[i].arr != null, towns, now, oo));
        }
        if (!isEnd && !startDeparted && preds[i].dep != null && (isStart || known[i].dep == null)) {
          into.push(...incoming(trains, our, L, preds[i].dep, lineSigs, now, oo));
          if (b) into.push(...busIncoming(b.arrivals, L, preds[i].dep, towns, now, oo));
        }
        out.sort(byAdv);
        into.sort(byAdv);
        for (const c of out.concat(into)) {
          c.own = true;
          const ids = ownIdOf(c);
          for (const e of entries) if (e.kind === c.kind && ids.includes(e.id)) ownFound.add(`${e.kind}|${e.id}|${e.sig}`);
        }
        if (isEnd) ownEnd.push(...out);
        else if (isStart) ownStart.push(...into);
        else if (out.length || into.length) ownMid.set(i, { out, into });
      }
    }
    const ownStatus = own.map(e => {
      const idx = line.findIndex(l => l.sig === e.sig);
      const isStop = idx === 0 || idx === n - 1 || (idx > 0 && line[idx].stop);
      const passed = idx >= 0 && (idx < Math.max(frontier, 0) || (idx < n - 1 && known[idx].dep != null));
      return { kind: e.kind, id: e.id, sig: e.sig, onLine: idx >= 0, stop: idx >= 0 && isStop, passed,
        found: ownFound.has(`${e.kind}|${e.id}|${e.sig}`) };
    });

    // Nivåer: 0 inget att göra, 1 håll koll, 2 påverkar
    // Väntan i hela minuter, samma som visas
    // Ett flyttat möte räknas som andra: efter väntan (förut 0, eftersom väntan inte räknades)
    const lvlMeeting = m => m.canceled ? 0 : (m.waitMin >= 5 ? 2 : (m.waitMin >= 1 ? 1 : 0));
    /* Knappt enligt plan: en egen anslutning kan enligt tidtabell ha under transferMin att byta (till exempel 2 min
       över plattformen). Den är knapp varje gång, så den varnar bara när det blir mindre än planerat (asPlanned).
       De vanliga har minst transferMin enligt plan, så för dem ändrar det inget. */
    const lvlConn = c => {
      c.asPlanned = c.status === 'knappt' && c.plannedTransferMin != null && c.transferMin >= c.plannedTransferMin;
      if (c.status === 'missas' || c.status === 'avgått') return 2;
      if (c.status === 'inställt' || (c.status === 'knappt' && !c.asPlanned)) return 1;
      return 0;
    };
    meetings.sort((a, b) => a.atI - b.atI || a.i - b.i);
    for (const m of meetings) { m.waitMin = roundMin(m.waitMs); m.level = lvlMeeting(m); }
    for (const c of conn) c.level = lvlConn(c);
    for (const c of inc) c.level = lvlConn(c);
    for (const st of stops) for (const c of st.connectionsAll.concat(st.incomingAll)) { c.level = lvlConn(c); c.sig = st.sig; }

    for (const c of ownEnd.concat(ownStart)) c.level = lvlConn(c);
    for (const [i, x] of ownMid) for (const c of x.out.concat(x.into)) { c.level = lvlConn(c); c.sig = line[i].sig; }

    /* Markerade anslutningar (input.marked: nycklar från connKey) gäller oavsett valet Tåg | Buss | Båda | Mina.
       Nycklarna sätts före valet, eftersom Mina visar de markerade. */
    const marked = input.marked instanceof Set ? input.marked : new Set(input.marked || []);
    const keyed = (list, sig, dir) => { for (const c of list) { c.key = connKey(c, sig, dir); c.marked = marked.has(c.key); } };
    keyed(conn, endL.sig, 'ut');
    keyed(ownEnd, endL.sig, 'ut');
    keyed(inc, line[0].sig, 'in');
    keyed(ownStart, line[0].sig, 'in');
    for (const st of stops) { keyed(st.connectionsAll, st.sig, 'ut'); keyed(st.incomingAll, st.sig, 'in'); }
    for (const [i, x] of ownMid) { keyed(x.out, line[i].sig, 'ut'); keyed(x.into, line[i].sig, 'in'); }
    // En vanlig anslutning som också är egen visas som egen
    const ownKeys = new Set();
    for (const c of ownEnd.concat(ownStart)) ownKeys.add(c.key);
    for (const x of ownMid.values()) for (const c of x.out.concat(x.into)) ownKeys.add(c.key);
    for (const c of conn.concat(inc)) if (ownKeys.has(c.key)) c.own = true;
    for (const st of stops) for (const c of st.connectionsAll.concat(st.incomingAll)) if (ownKeys.has(c.key)) c.own = true;
    // Vanliga och egna ihop, utan dubbletter (egna först, eftersom de kan ligga utanför de vanliga fönstren)
    const union = (general, ownList) => {
      const out = [], seen = new Set();
      for (const c of ownList.concat(general)) if (!seen.has(c.key)) { seen.add(c.key); out.push(c); }
      return out.sort(byAdv);
    };

    /* Valet Tåg | Buss | Båda | Mina: listorna visar bara valda slag, och hur många som döljs. Mina visar de egna
       och de markerade (★). Med connAlerts (förval) följer varningarna, siffran, panelens rad och utropet samma val;
       annars gäller de alla anslutningar som hämtats. */
    const mode = CONN_MODES.includes(input.connMode) ? input.connMode : 'tag';
    const mina = mode === 'mina';
    const alertsFollow = input.connAlerts !== false;
    const split = (general, ownList) => mina ? splitByMode(union(general, ownList), mode) : splitByMode(general, mode);
    const endSplit = split(conn, ownEnd);
    const incSplit = split(inc, ownStart);
    const byI = new Map(stops.map(st => [st.i, st]));
    if (mina) for (const i of ownMid.keys()) if (!byI.has(i)) byI.set(i, { i, sig: line[i].sig, connectionsAll: [], incomingAll: [] });
    const stopList = Array.from(byI.values()).sort((a, b) => a.i - b.i);
    const stopsHidden = { tåg: 0, buss: 0 };
    for (const st of stopList) {
      const x = ownMid.get(st.i) || { out: [], into: [] };
      const a = split(st.connectionsAll, x.out), b = split(st.incomingAll, x.into);
      st.connections = a.shown;
      st.incoming = b.shown;
      st.hidden = { tåg: a.hidden.tåg + b.hidden.tåg, buss: a.hidden.buss + b.hidden.buss };
      stopsHidden.tåg += st.hidden.tåg;
      stopsHidden.buss += st.hidden.buss;
    }
    const shownStops = stopList.filter(st => st.connections.length || st.incoming.length);
    const allStops = Array.from(new Set(stops.map(st => st.i).concat(Array.from(ownMid.keys())))).sort((a, b) => a - b).map(i => {
      const st = byI.get(i) || { connectionsAll: [], incomingAll: [] }, x = ownMid.get(i) || { out: [], into: [] };
      return { i, sig: line[i].sig, connections: union(st.connectionsAll, x.out), incoming: union(st.incomingAll, x.into) };
    });
    const alert = alertsFollow
      ? { connections: endSplit.shown, incoming: incSplit.shown, stops: shownStops }
      : { connections: union(conn, ownEnd), incoming: union(inc, ownStart), stops: allStops };
    const midAll = [];
    for (const st of alert.stops) midAll.push(...st.connections, ...st.incoming);

    /* Blir en markerad (★) eller egen anslutning (Mina) knapp eller missas, och det räcker att den väntar högst
       holdMaxMin för att få vanlig bytestid (transferMin) – eller bytestiden enligt plan när den är kortare – blir
       det ett förslag: ring trafikledningen och fråga om den kan vänta, eller om vi kan vänta på den som ska till
       oss, och om spår vid samma plattform. Inte när den gått eller är inställd. */
    const ourTrack = sig => {
      const l = our.at.get(sig);
      return (l && ((l.arr && l.arr.track) || (l.dep && l.dep.track))) || '';
    };
    const every = [];
    for (const c of union(conn, ownEnd)) every.push({ c, sig: endL.sig, dir: 'ut' });
    for (const c of union(inc, ownStart)) every.push({ c, sig: line[0].sig, dir: 'in' });
    for (const st of allStops) {
      for (const c of st.connections) every.push({ c, sig: st.sig, dir: 'ut' });
      for (const c of st.incoming) every.push({ c, sig: st.sig, dir: 'in' });
    }
    const actions = [];
    for (const x of every) {
      if (!(x.c.marked || x.c.own) || (x.c.status !== 'knappt' && x.c.status !== 'missas')) continue;
      const planned = x.c.plannedTransferMin;
      const need = planned != null ? Math.min(o.transferMin, Math.max(planned, o.missedUnderMin)) : o.transferMin;
      const waitMin = need - x.c.transferMin;
      if (waitMin < 1 || waitMin > o.holdMaxMin) continue;
      actions.push({
        type: x.dir === 'ut' ? 'hold' : 'wait', sig: x.sig, c: x.c, waitMin,
        ourTrack: x.sig === endL.sig ? end.track : ourTrack(x.sig), theirTrack: x.c.track || ''
      });
    }
    actions.sort((a, b) => a.c.adv - b.c.adv);
    // Markerade och egna: sparas i körningen (info.marked)
    const markedList = every.filter(x => x.c.marked || x.c.own).map(x => ({ sig: x.sig, dir: x.dir, c: x.c }));

    const endLevel = end.delayMin >= 6 ? 2 : (end.delayMin >= 2 ? 1 : 0);
    const levels = [endLevel].concat(meetings.map(m => m.level), alert.connections.map(c => c.level), alert.incoming.map(c => c.level),
      midAll.map(c => c.level), deviations.map(() => 1), messages.map(() => 1));
    const attention = meetings.filter(m => m.level).length + alert.connections.filter(c => c.level).length +
      alert.incoming.filter(c => c.level).length + midAll.filter(c => c.level).length + deviations.length + messages.length;

    // Varför vi blir sena: det möte som kostar mest
    const worstMeeting = meetings.filter(m => m.waitMin >= 1).sort((a, b) => b.waitMs - a.waitMs)[0] || null;

    return {
      now, frontier, end, currentDelayMin, recoveryMin, recoveryObs: rec.obs,
      posAt: pos ? { sig: line[pos.i].sig, t: pos.t } : null,
      meetings, deviations, messages, messagesHidden: cls.hidden,
      connections: endSplit.shown, connectionsHidden: endSplit.hidden,
      incoming: startDeparted ? null : incSplit.shown, incomingHidden: incSplit.hidden,
      stops: shownStops, stopsHidden, connMode: mode, connAlerts: alertsFollow, alert, actions, markedList, ownStatus,
      midMissed: alert.stops.reduce((k, st) => k + st.connections.filter(c => c.level === 2).length, 0),
      preds: preds.map((p, i) => ({ sig: line[i].sig, arr: p.arr, dep: p.dep, waitMs: p.waitMs })),
      doubleSections: Array.from(newDouble),
      meetPlaces: places.found.filter(s => !(input.knownMeetPlaces || []).includes(s)),
      // late: det mötande tåget är sent (annars väntar vi för att vi själva är sena och mötet flyttats)
      reason: worstMeeting ? { sig: worstMeeting.at, otn: worstMeeting.ident || worstMeeting.otn, waitMin: worstMeeting.waitMin,
        late: worstMeeting.theirDelayMin >= 1, moved: worstMeeting.atI !== worstMeeting.i } : null,
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
    // Knappt enligt plan (en egen anslutning med kort planerat byte) ger inget utrop på egen hand
    if (d < 3 && !bad.length && !tight.some(c => !c.asPlanned)) return null;
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
    // Är det mötande tåget i tid väntar vi för att mötet flyttats när vi själva är sena: då inget "försenat tåg"
    const meetSv = m.reason && m.reason.late ? ' på grund av möte med ett försenat tåg' : ' på grund av väntan på mötande tåg';
    const meetEn = m.reason && m.reason.late ? ' due to a delayed oncoming train' : ' due to waiting for an oncoming train';
    if (d >= 3) {
      sv.push(`Vi är cirka ${d} minuter försenade${meetReason ? meetSv : (msg ? ` på grund av ${lowerFirst(msg)}` : '')}.`);
      en.push(`We are approximately ${d} minutes late${meetReason ? meetEn : (msg ? ' due to a traffic disruption' : '')}.`);
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
     (appen i notifyInfo) meddelar en nyckel en gång per nivå.
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
    // Nyckeln är tidtabellens mötesplats, så att ett möte som flyttas inte meddelas en gång till på samma nivå
    for (const mt of m.meetings || []) {
      if (!mt.level) continue;
      const train = mt.ident || mt.otn;
      const at = mt.at || mt.sig;
      if (at !== mt.sig) {
        const sure = mt.move === 'rapporterat';
        add(`m|${mt.otn}|${mt.sig}`, mt.level,
          `Möte ${name(at)} i stället för ${name(mt.sig)}${sure ? '' : ' (troligen)'}: vi väntar ca ${mt.waitMin} min på ${train}`,
          sure ? `Mötet är flyttat närmare oss. Vi väntar troligen i ${name(at)} cirka ${minutes(mt.waitMin)}.`
            : `Mötet flyttas troligen till ${name(at)}. Vi väntar där cirka ${minutes(mt.waitMin)}.`);
      } else {
        add(`m|${mt.otn}|${mt.sig}`, mt.level,
          `Möte ${name(at)}: ${train} är ${mt.theirDelayMin} min sent – vi väntar ca ${mt.waitMin} min`,
          `Möte i ${name(at)}. Mötande tåg ${minutes(mt.theirDelayMin)} sent. Vi väntar cirka ${minutes(mt.waitMin)}.`);
      }
    }
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
  /* ── Loggen över Trafikverkets svar under resan ──
     Så att det i efterhand går att pröva om ett flyttat möte syntes hos Trafikverket i förväg: vårt tågs och de
     mötande tågens annonseringar längs linjen, de mötande tågens position och vad appen räknade med. Bara
     ändringar sparas, högst opts.trvLogMax rader (full: true när det tog slut). Tider i sekunder från t0, null
     när de saknas. Rader:
       ['a', s, tåg, plats, 'a'|'d', planerad, beräknad, rapporterad, inställd 0/1, preliminär 0/1, ändrad, avvikelser]
       ['p', s, tåg, lat, lon, km/h, positionens tid]
       ['m', s, tåg, tidtabellens mötesplats, mötesplats, 'rapporterat'|'beräknat'|'', väntan min, deras försening min, källa]
       ['e', s, beräknad ankomst till slutstationen (hel minut), försening min]
     log.last och log.lastPos håller reda på vad som redan sparats och följer inte med i körningen (trvLogOut). */
  function trvLogNew(t0, lineSigs) {
    return { v: 1, t0: Math.floor(t0 / 1000) * 1000, line: (lineSigs || []).slice(), rows: [], last: {}, lastPos: {}, full: false };
  }
  const relS = (log, t) => t == null ? null : Math.round((t - log.t0) / 1000);
  function trvLogPut(log, key, kind, now, tail, opts) {
    const sig = JSON.stringify(tail);
    if (log.last[key] === sig) return false;
    const max = (opts && opts.trvLogMax) || DEFAULTS.trvLogMax;
    if (log.rows.length >= max) { log.full = true; return false; }
    log.last[key] = sig;
    log.rows.push([kind, relS(log, now)].concat(tail));
    return true;
  }
  // Annonseringarna på linjens platser för tågen med nycklarna keys (vårt tåg och de mötande)
  function trvLogTrains(log, trains, keys, now, opts) {
    if (!log || !trains) return;
    const sigs = new Set(log.line);
    for (const key of keys || []) {
      const tr = trains.get(key);
      if (!tr) continue;
      for (const [sig, loc] of tr.at) {
        if (!sigs.has(sig)) continue;
        for (const r of [loc.arr, loc.dep]) {
          if (!r) continue;
          trvLogPut(log, `a|${tr.key}|${sig}|${r.kind}`, 'a', now, [r.otn || tr.otn, sig, r.kind === 'arr' ? 'a' : 'd', relS(log, r.plan),
            relS(log, r.est), relS(log, r.actual), r.canceled ? 1 : 0, r.prelim ? 1 : 0, relS(log, r.modified), r.deviations.join(' | ')], opts);
        }
      }
    }
  }
  // Mötande tågs position (parsePositions): när tåget flyttat sig trvLogPosM eller det gått trvLogPosMs sedan senast
  function trvLogPositions(log, positions, otns, now, opts) {
    if (!log || !positions) return;
    const o = Object.assign({}, DEFAULTS, opts || {});
    for (const otn of otns || []) {
      const p = positions.get(String(otn));
      if (!p || p.lat == null || p.lon == null) continue;
      const prev = log.lastPos[otn];
      if (prev && (p.t <= prev.t || (haversine(prev.lat, prev.lon, p.lat, p.lon) < o.trvLogPosM && p.t - prev.t < o.trvLogPosMs))) continue;
      if (log.rows.length >= o.trvLogMax) { log.full = true; return; }
      log.lastPos[otn] = { lat: p.lat, lon: p.lon, t: p.t };
      log.rows.push(['p', relS(log, now), String(otn), Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5,
        p.speedKmh != null ? Math.round(p.speedKmh) : null, relS(log, p.t)]);
    }
  }
  // Vad appen räknade med (compute): mötena och ankomsten till slutstationen
  function trvLogModel(log, m, now, opts) {
    if (!log || !m) return;
    for (const mt of m.meetings || []) {
      trvLogPut(log, `m|${mt.otn}|${mt.sig}`, 'm', now, [mt.otn, mt.sig, mt.at || mt.sig, mt.move || '', mt.waitMin,
        mt.theirDelayMin, mt.their ? mt.their.source : '', mt.moveVia || (mt.moved ? mt.movedVia : '') || '',
        mt.position && mt.position.along ? mt.position.side : ''], opts);
    }
    if (m.end && m.end.predArr != null) trvLogPut(log, 'e', 'e', now, [relS(log, Math.round(m.end.predArr / MIN) * MIN), m.end.delayMin], opts);
  }
  // Det som sparas i körningen (info.trv), eller null om inget loggats
  function trvLogOut(log) {
    if (!log || !log.rows || !log.rows.length) return null;
    return Object.assign({ v: log.v, t0: new Date(log.t0).toISOString(), line: log.line, rows: log.rows }, log.full ? { full: true } : {});
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
    request, queryOurTrain, queryLine, queryOwnTrains, queryNames, queryMessages, resultOf,
    parseAnnouncement, groupTrains, nearestRun, mergeTrains, isOurs, buildLine, crossingOf, latestDelay, theirArrival, theirDeparture,
    progressOf, meetingPlaces, travel, trvLogNew, PROFILE, legKey, trackPoints, runLegs, profileBuilder, remainingFrom, positionEstimate, AXIS, buildAxis, axisLocate, axisMeasured, trvLogTrains, trvLogPositions, trvLogModel, trvLogOut,
    historyMedians, recoveryRatios, plannedRun, predict, outgoing, incoming, signaturesIn, parseMessage, classifyMessages, messagesFor, compute,
    townKey, lineTownsExcept, busOutgoing, busIncoming, CONN_MODES, connShows, splitByMode, connKey, normOwn, ownMatcher, parseOwn
  };
});
