/* RailTimer – Trafikverkets öppna API (api.trafikinfo.trafikverket.se).
   Frågor, anrop med tidsgräns, Trafikverkets rapporterade tider för en körning, jämförelse med
   appens GPS-tider och kontrollen av vad API:t svarar (api-koll.html).
   Utan beroenden; anropen får fetch som argument. Används av index.html och api-koll.html och
   testas med node --test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RailTimerTrv = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API_URL = 'https://api.trafikinfo.trafikverket.se/v2/data.json';
  const DEFAULT_KEY = '1acaea82911c472cb3409d57ae19707f'; // samma nyckel som index.html
  const TIMEOUT_MS = 10000;
  const WINDOW_MS = 3 * 3600 * 1000;      // körningens tidsfönster ± 3 h (sena tåg, tåg över midnatt)
  const RECHECK_AFTER_MS = 15 * 60 * 1000; // ofullständiga tider hämtas om tills 15 min efter resan
  const MAX_AGE_MS = 3 * 24 * 3600 * 1000; // äldre körningar hämtas inte (Trafikverket sparar bara några dygn)

  // Fälten som behövs för en körning. Tågorderns tider (LocationDateTimeOTN) sparar appen redan när
  // tidtabellen hämtas (operationalArrival/operationalDeparture), så de tas inte med här.
  const RUN_FIELDS = [
    'LocationSignature', 'ActivityType', 'Advertised', 'AdvertisedTimeAtLocation',
    'TimeAtLocation', 'TimeAtLocationWithSeconds', 'TrackAtLocation', 'Canceled', 'Deviation',
    'Operator', 'ProductInformation', 'OperationalTrainNumber'
  ];

  class TrvError extends Error {
    constructor(kind, message) {
      super(message);
      this.name = 'TrvError';
      this.kind = kind; // network | timeout | http | api
    }
  }

  // ── Frågor ──

  function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Filter: { op: 'EQ'|'NE'|'GT'|'GTE'|'LT'|'LTE'|'LIKE'|'IN'|'EXISTS'|'WITHIN', name, value, shape? } eller { op: 'AND'|'OR', items: [...] }
  function filterXml(f) {
    if (!f) return '';
    if (f.op === 'AND' || f.op === 'OR') return `<${f.op}>${(f.items || []).map(filterXml).join('')}</${f.op}>`;
    const shape = f.shape ? ` shape="${xmlEscape(f.shape)}"` : '';
    return `<${f.op} name="${xmlEscape(f.name)}"${shape} value="${xmlEscape(f.value)}" />`;
  }

  function buildQuery(q) {
    const attrs = [`objecttype="${xmlEscape(q.objecttype)}"`, `schemaversion="${xmlEscape(q.schemaversion)}"`];
    if (q.namespace) attrs.unshift(`namespace="${xmlEscape(q.namespace)}"`);
    if (q.limit != null) attrs.push(`limit="${Number(q.limit)}"`);
    if (q.orderby) attrs.push(`orderby="${xmlEscape(q.orderby)}"`);
    const filter = q.filter ? `<FILTER>${filterXml(q.filter)}</FILTER>` : '';
    const include = (q.include || []).map(f => `<INCLUDE>${xmlEscape(f)}</INCLUDE>`).join('');
    return `<QUERY ${attrs.join(' ')}>${filter}${include}</QUERY>`;
  }

  function buildRequest(key, queries) {
    return `<REQUEST><LOGIN authenticationkey="${xmlEscape(key || DEFAULT_KEY)}" />${queries.map(buildQuery).join('')}</REQUEST>`;
  }

  function errorText(json) {
    const results = json && json.RESPONSE && json.RESPONSE.RESULT;
    const err = Array.isArray(results) ? (results.find(r => r && r.ERROR) || {}).ERROR : null;
    return err ? [err.SOURCE, err.MESSAGE].filter(Boolean).join(': ') : null;
  }

  // Skickar frågorna och ger RESULT-listan (en post per fråga). opts: { fetch, key, url, timeoutMs }
  async function request(queries, opts) {
    const o = opts || {};
    const fetchImpl = o.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetchImpl) throw new TrvError('network', 'Ingen fetch');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; if (controller) controller.abort(); }, o.timeoutMs || TIMEOUT_MS);
    let res;
    let json = null;
    try {
      res = await fetchImpl(o.url || API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: buildRequest(o.key, queries),
        signal: controller ? controller.signal : undefined
      });
      try { json = await res.json(); } catch (e) { json = null; }
    } catch (e) {
      if (timedOut) throw new TrvError('timeout', 'Trafikverket svarade inte i tid');
      throw new TrvError('network', 'Ingen kontakt med Trafikverket');
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw new TrvError('timeout', 'Trafikverket svarade inte i tid');
    const apiError = errorText(json);
    if (!res.ok) throw new TrvError(apiError ? 'api' : 'http', apiError || `HTTP ${res.status}`);
    const results = json && json.RESPONSE && json.RESPONSE.RESULT;
    if (!Array.isArray(results)) throw new TrvError('api', 'Oväntat svar från Trafikverket');
    return results;
  }

  // En fråga: posterna för objekttypen. Ett fel i svaret blir ett undantag.
  async function query(q, opts) {
    const results = await request([q], opts);
    const r = results[0] || {};
    if (r.ERROR) throw new TrvError('api', [r.ERROR.SOURCE, r.ERROR.MESSAGE].filter(Boolean).join(': '));
    return Array.isArray(r[q.objecttype]) ? r[q.objecttype] : [];
  }

  // ── Tider ──

  function toMs(t) {
    if (t == null || t === '') return null;
    const ms = typeof t.getTime === 'function' ? t.getTime() : (typeof t === 'number' ? t : Date.parse(t));
    return Number.isFinite(ms) ? ms : null;
  }

  let stockholmFormat = null;
  // Svensk lokal tid utan tidszon, 'ÅÅÅÅ-MM-DDTHH:MM:SS', som API:t tolkar som svensk tid
  function swedishLocal(t) {
    const ms = toMs(t);
    if (ms == null) return null;
    if (!stockholmFormat) {
      stockholmFormat = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      });
    }
    const p = {};
    for (const part of stockholmFormat.formatToParts(new Date(ms))) p[part.type] = part.value;
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  }

  function swedishDay(t) {
    const s = swedishLocal(t);
    return s ? s.slice(0, 10) : null;
  }

  // Körningens tidsfönster: från tidigaste till senaste kända tid, ± 3 h
  function runWindow(run) {
    const times = [toMs(run.startedAt), toMs(run.finishedAt)];
    for (const st of run.stops || []) {
      times.push(toMs(st.scheduledArrival), toMs(st.scheduledDeparture), toMs(st.actualArrival), toMs(st.actualDeparture));
    }
    const known = times.filter(t => t != null);
    if (!known.length) return null;
    return { from: swedishLocal(Math.min(...known) - WINDOW_MS), to: swedishLocal(Math.max(...known) + WINDOW_MS) };
  }

  function trainOf(run) {
    return String((run && run.trainNumber) || '').trim();
  }

  function runQuery(run, include) {
    const win = runWindow(run);
    const train = trainOf(run);
    if (!win || !train) return null;
    const q = {
      objecttype: 'TrainAnnouncement', schemaversion: '1.9', limit: 1000,
      filter: { op: 'AND', items: [
        { op: 'EQ', name: 'OperationalTrainNumber', value: train },
        { op: 'GTE', name: 'AdvertisedTimeAtLocation', value: win.from },
        { op: 'LTE', name: 'AdvertisedTimeAtLocation', value: win.to }
      ] }
    };
    if (include !== false) q.include = include || RUN_FIELDS;
    return q;
  }

  async function fetchRunAnnouncements(run, opts) {
    const q = runQuery(run);
    if (!q) return [];
    return query(q, opts);
  }

  // Annonseringen för stationen och aktiviteten som ligger närmast refMs i tid
  function matchAnnouncement(anns, sig, activity, refMs) {
    let best = null;
    let bestDist = Infinity;
    for (const a of anns || []) {
      if (!a || a.LocationSignature !== sig || a.ActivityType !== activity) continue;
      const t = toMs(a.AdvertisedTimeAtLocation);
      const dist = refMs == null || t == null ? 0 : Math.abs(t - refMs);
      if (!best || dist < bestDist) { best = a; bestDist = dist; }
    }
    return best;
  }

  // Trafikverket rapporterar vissa stationer bara i hela minuter (2026-11-25: Lidköping, Mariestad, Forshem),
  // även i TimeAtLocationWithSeconds. En tid på :00 räknas därför som minut, inte sekund.
  function wholeMinute(t) {
    const m = /T\d\d:\d\d:(\d\d)/.exec(String(t || ''));
    return !!m && m[1] === '00';
  }

  function reported(a) {
    return a ? (a.TimeAtLocationWithSeconds || a.TimeAtLocation || null) : null;
  }

  function descriptions(list) {
    return (list || []).map(d => d && (d.Description || d.Code)).filter(Boolean);
  }

  /* Trafikverkets tider för körningens stationer.
     Ger { meta: { fetchedAt, found, complete, operator, product }, stops: [ { arrival, departure,
     track, canceled, deviations } | null ] } i samma ordning som run.stops.
     complete = Trafikverket har rapporterat allt det annonserat för stationerna (inställda räknas inte). */
  function trafikverketTimes(run, anns, nowMs) {
    const stops = run.stops || [];
    let complete = true;
    let matched = 0;
    const out = stops.map(st => {
      if (!st || !st.sig) return null;
      const arrRef = toMs(st.scheduledArrival) ?? toMs(st.actualArrival) ?? toMs(st.scheduledDeparture) ?? toMs(st.actualDeparture);
      const depRef = toMs(st.scheduledDeparture) ?? toMs(st.actualDeparture) ?? toMs(st.scheduledArrival) ?? toMs(st.actualArrival);
      const arr = matchAnnouncement(anns, st.sig, 'Ankomst', arrRef);
      const dep = matchAnnouncement(anns, st.sig, 'Avgang', depRef);
      if (!arr && !dep) return null;
      matched++;
      const t = {};
      for (const [a, key] of [[arr, 'arrival'], [dep, 'departure']]) {
        if (!a) continue;
        const r = reported(a);
        if (r) t[key] = r;
        else if (!a.Canceled) complete = false;
      }
      const track = (dep && dep.TrackAtLocation) || (arr && arr.TrackAtLocation);
      if (track) t.track = String(track);
      if ((arr && arr.Canceled) || (dep && dep.Canceled)) t.canceled = true;
      const devs = Array.from(new Set(descriptions(arr && arr.Deviation).concat(descriptions(dep && dep.Deviation))));
      if (devs.length) t.deviations = devs;
      return t;
    });
    const first = (anns || []).find(a => a && (a.Operator || a.ProductInformation)) || {};
    const meta = { fetchedAt: new Date(nowMs == null ? Date.now() : nowMs).toISOString(), found: matched, complete };
    if (first.Operator) meta.operator = first.Operator;
    const product = descriptions(first.ProductInformation)[0];
    if (product) meta.product = product;
    return { meta, stops: out };
  }

  // Lägger in Trafikverkets tider i körningen (ändrar run): run.trv och stops[i].trv
  function applyTrafikverket(run, result) {
    run.trv = result.meta;
    (run.stops || []).forEach((st, i) => {
      if (!st) return;
      if (result.stops[i]) st.trv = result.stops[i];
      else delete st.trv;
    });
    return run;
  }

  // Ska appen hämta Trafikverkets tider för körningen?
  function needsTrafikverket(run, nowMs) {
    if (!trainOf(run)) return false;
    const now = nowMs == null ? Date.now() : nowMs;
    const finished = toMs(run.finishedAt) ?? toMs(run.startedAt);
    if (finished == null || now - finished > MAX_AGE_MS) return false;
    if (!run.trv) return true;
    return run.trv.complete === false && (toMs(run.trv.fetchedAt) ?? 0) < finished + RECHECK_AFTER_MS;
  }

  // ── Jämförelse med appens tider ──

  // En rad per station och aktivitet där både appen och Trafikverket har en tid. diffS = appen − Trafikverket.
  function compareRun(run) {
    const rows = [];
    (run.stops || []).forEach((st, i) => {
      if (!st || !st.trv) return;
      for (const [kind, appKey, srcKey] of [['arrival', 'actualArrival', 'arrivalSource'], ['departure', 'actualDeparture', 'departSource']]) {
        const app = toMs(st[appKey]);
        const trv = toMs(st.trv[kind]);
        if (app == null || trv == null) continue;
        rows.push({
          index: i, name: st.name, sig: st.sig, kind, source: st[srcKey] || '', shouldStop: st.shouldStop !== false,
          first: i === 0, last: i === run.stops.length - 1, wholeMinute: wholeMinute(st.trv[kind]),
          app: new Date(app).toISOString(), trv: st.trv[kind], diffS: Math.round((app - trv) / 1000)
        });
      }
    });
    return rows;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function stats(values) {
    const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!v.length) return { n: 0 };
    const abs = v.map(Math.abs);
    return {
      n: v.length,
      median: quantile(v, 0.5), p10: quantile(v, 0.1), p90: quantile(v, 0.9),
      min: v[0], max: v[v.length - 1],
      within10: abs.filter(x => x <= 10).length, within30: abs.filter(x => x <= 30).length
    };
  }

  // Sammanfattning per aktivitet och per station (sig + aktivitet + stopp/passage).
  // Tider i hela minuter räknas inte; de anges som minuteRows.
  function summarizeComparison(allRows) {
    const rows = allRows.filter(r => !r.wholeMinute);
    const byKind = {};
    const byStation = new Map();
    for (const r of rows) {
      (byKind[r.kind] = byKind[r.kind] || []).push(r.diffS);
      const key = `${r.sig}|${r.kind}|${r.shouldStop ? 'stopp' : 'passage'}`;
      if (!byStation.has(key)) byStation.set(key, { sig: r.sig, name: r.name, kind: r.kind, shouldStop: r.shouldStop, diffs: [] });
      byStation.get(key).diffs.push(r.diffS);
    }
    const stations = Array.from(byStation.values()).map(s => Object.assign({ sig: s.sig, name: s.name, kind: s.kind, shouldStop: s.shouldStop }, stats(s.diffs)));
    stations.sort((a, b) => a.name.localeCompare(b.name, 'sv') || a.kind.localeCompare(b.kind));
    return {
      arrival: stats(byKind.arrival || []),
      departure: stats(byKind.departure || []),
      stations,
      largest: rows.slice().sort((a, b) => Math.abs(b.diffS) - Math.abs(a.diffS)).slice(0, 15),
      minuteRows: allRows.length - rows.length,
      minuteStations: Array.from(new Set(allRows.filter(r => r.wholeMinute).map(r => r.name || r.sig)))
    };
  }

  // ── Kontrollen: vilka fält som finns ──

  function flattenInto(value, path, found) {
    if (value == null || value === '') return;
    if (Array.isArray(value)) {
      if (!value.length) return;
      if (value.every(v => v == null || typeof v !== 'object')) found.set(path, value.join(', '));
      else value.forEach(v => flattenInto(v, path, found));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) flattenInto(v, path ? `${path}.${k}` : k, found);
      return;
    }
    if (!found.has(path)) found.set(path, String(value));
  }

  // [{ path, count, examples }] – hur många poster som har varje fält och upp till tre exempel
  function fieldSummary(records) {
    const fields = new Map();
    for (const rec of records || []) {
      const found = new Map();
      flattenInto(rec, '', found);
      for (const [path, example] of found) {
        if (!fields.has(path)) fields.set(path, { path, count: 0, examples: [] });
        const f = fields.get(path);
        f.count++;
        if (f.examples.length < 3 && !f.examples.includes(example)) f.examples.push(example);
      }
    }
    return Array.from(fields.values()).sort((a, b) => a.path.localeCompare(b.path));
  }

  // Körningar att jämföra: de senaste med tågnummer och stationssignaturer, plus en per ålder (för hur långt bakåt API:t har data)
  function pickRuns(logs, nowMs, recent, ages) {
    const usable = (logs || []).filter(r => r && trainOf(r) && (r.stops || []).some(s => s && s.sig && (s.actualArrival || s.actualDeparture)) && toMs(r.startedAt) != null)
      .sort((a, b) => toMs(b.startedAt) - toMs(a.startedAt));
    const picked = new Map();
    for (const r of usable.slice(0, recent == null ? 20 : recent)) picked.set(String(r.id), { run: r, reason: 'senaste' });
    for (const days of ages || [7, 14, 30, 60, 90, 180, 365]) {
      const target = nowMs - days * 864e5;
      let best = null;
      for (const r of usable) {
        const d = Math.abs(toMs(r.startedAt) - target);
        if (d <= Math.max(3, days * 0.3) * 864e5 && (!best || d < best.d)) best = { r, d };
      }
      if (best && !picked.has(String(best.r.id))) picked.set(String(best.r.id), { run: best.r, reason: `${days} dagar` });
    }
    return Array.from(picked.values());
  }

  // Alla stationssignaturer i en post, på vilken nivå som helst (Signature, LocationSignature)
  function signaturesIn(value, out) {
    const found = out || [];
    if (Array.isArray(value)) value.forEach(v => signaturesIn(v, found));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if ((k === 'Signature' || k === 'LocationSignature') && typeof v === 'string') found.push(v);
        else signaturesIn(v, found);
      }
    }
    return found;
  }

  function safe(promiseFn) {
    return promiseFn().then(value => ({ ok: true, value }), err => ({ ok: false, kind: err && err.kind, error: (err && err.message) || String(err) }));
  }

  function wgs84(text) {
    const m = /POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i.exec(text || '');
    return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null;
  }

  // ── Km-tal: plankorsningarna (RailCrossing) har banans km-tal och bandel ──

  const CROSSING_QUERY = { objecttype: 'RailCrossing', schemaversion: '1.5' };
  const CROSSING_FIELDS = ['Kilometer', 'Meter', 'TrackPortion', 'Geometry.WGS84', 'Deleted'];
  const CROSSING_TIMEOUT_MS = 30000; // utan rektangel kommer hela landet (ca 1 MB)

  // [{ lat, lon, bandel, m }], m = km-talet i meter (Kilometer · 1000 + Meter). Raderade och ofullständiga tas inte med.
  function parseCrossings(list) {
    const out = [];
    for (const c of list || []) {
      if (!c || c.Deleted === true) continue;
      const p = wgs84(c.Geometry && c.Geometry.WGS84);
      const km = Number(c.Kilometer);
      const meter = c.Meter == null ? 0 : Number(c.Meter);
      const bandel = c.TrackPortion == null || c.TrackPortion === '' ? null : Number(c.TrackPortion);
      if (!p || !isFinite(p.lat) || !isFinite(p.lon) || c.Kilometer == null || !isFinite(km) || !isFinite(meter) || bandel == null || !isFinite(bandel)) continue;
      out.push({ lat: p.lat, lon: p.lon, bandel, m: Math.round(km * 1000 + meter) });
    }
    return out;
  }

  function inBox(p, box) {
    return !box || (p.lat >= box.minLat && p.lat <= box.maxLat && p.lon >= box.minLon && p.lon <= box.maxLon);
  }

  /* Plankorsningarna inom rektangeln box { minLat, minLon, maxLat, maxLon }. Först med ett geometriskt filter
     (WITHIN box i WGS84). Godtar Trafikverket inte filtret, eller blir svaret tomt, hämtas hela landet och
     rektangeln väljs här. Nätfel och tidsgräns ger undantag (TrvError). opts: { fetch, key, timeoutMs }.
     Ger { crossings, filtered } där filtered = Trafikverket godtog filtret. */
  async function fetchRailCrossings(box, opts) {
    const o = opts || {};
    const base = Object.assign({ include: CROSSING_FIELDS }, CROSSING_QUERY);
    if (box) {
      const value = `${box.minLon} ${box.minLat}, ${box.maxLon} ${box.maxLat}`;
      try {
        const list = await query(Object.assign({}, base, { filter: { op: 'WITHIN', name: 'Geometry.WGS84', shape: 'box', value } }), o);
        const crossings = parseCrossings(list).filter(p => inBox(p, box));
        if (crossings.length) return { crossings, filtered: true };
      } catch (e) {
        if (!(e instanceof TrvError) || (e.kind !== 'api' && e.kind !== 'http')) throw e;
      }
    }
    const list = await query(base, Object.assign({}, o, { timeoutMs: o.timeoutMs || CROSSING_TIMEOUT_MS }));
    return { crossings: parseCrossings(list).filter(p => inBox(p, box)), filtered: false };
  }

  /* Kontrollen i api-koll.html. opts: { fetch, key, trainNumber, date (ÅÅÅÅ-MM-DD), logs, nowMs, onProgress(text),
     recentRuns, sleep, pauseMs }. Varje del körs för sig, så att ett fel i en del inte stoppar de andra. */
  async function runCheck(opts) {
    const o = opts || {};
    const now = o.nowMs == null ? Date.now() : o.nowMs;
    const req = { fetch: o.fetch, key: o.key };
    const progress = o.onProgress || (() => {});
    const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const pause = o.pauseMs == null ? 300 : o.pauseMs;
    const train = String(o.trainNumber || '').trim();
    const date = o.date || swedishDay(now);
    const out = { checkedAt: new Date(now).toISOString(), trainNumber: train, date, sections: {} };

    // 1. Tågets annonseringar under dagen, alla fält
    progress(`Tåg ${train}: annonseringar`);
    const ann = await safe(() => query({
      objecttype: 'TrainAnnouncement', schemaversion: '1.9', limit: 1000, orderby: 'AdvertisedTimeAtLocation',
      filter: { op: 'AND', items: [
        { op: 'EQ', name: 'OperationalTrainNumber', value: train },
        { op: 'GTE', name: 'AdvertisedTimeAtLocation', value: `${date}T00:00:00` },
        { op: 'LTE', name: 'AdvertisedTimeAtLocation', value: `${date}T23:59:59` }
      ] }
    }, req));
    // Ingen kontakt alls: avbryt direkt i stället för att vänta ut varje fråga
    if (!ann.ok && (ann.kind === 'network' || ann.kind === 'timeout')) {
      out.aborted = ann.error;
      progress('Avbrutet');
      return out;
    }
    const anns = ann.ok ? ann.value : [];
    const routeSigs = Array.from(new Set(anns.map(a => a.LocationSignature).filter(Boolean)));
    out.sections.announcements = ann.ok
      ? { count: anns.length, fields: fieldSummary(anns), records: anns, sigs: routeSigs }
      : { error: ann.error };

    // 2. Tågets position, och hur många tåg som rapporterar position just nu
    progress('Tågpositioner');
    const pos = await safe(() => query({
      namespace: 'järnväg.trafikinfo', objecttype: 'TrainPosition', schemaversion: '1.1', limit: 5,
      orderby: 'TimeStamp desc', filter: { op: 'EQ', name: 'Train.OperationalTrainNumber', value: train }
    }, req));
    const allPos = await safe(() => query({
      namespace: 'järnväg.trafikinfo', objecttype: 'TrainPosition', schemaversion: '1.1', limit: 10000,
      include: ['Train.OperationalTrainNumber', 'TimeStamp', 'Status.Active', 'Speed']
    }, req));
    const myTrains = Array.from(new Set((o.logs || []).map(trainOf).filter(Boolean)));
    const posSection = {};
    if (pos.ok) posSection.train = { count: pos.value.length, fields: fieldSummary(pos.value), records: pos.value.slice(0, 5) };
    else posSection.trainError = pos.error;
    if (allPos.ok) {
      const list = allPos.value;
      const recent = list.filter(p => now - (toMs(p.TimeStamp) ?? 0) <= 10 * 60000);
      const seen = new Set(list.map(p => p.Train && String(p.Train.OperationalTrainNumber)).filter(Boolean));
      posSection.national = {
        count: list.length, last10min: recent.length,
        withSpeed: list.filter(p => p.Speed != null).length,
        myTrainsSeen: myTrains.filter(t => seen.has(t)), myTrainsCount: myTrains.length
      };
    } else posSection.nationalError = allPos.error;
    out.sections.positions = posSection;
    await sleep(pause);

    // 3. Stationer: alla platser, och alla fält för stationerna på tågets väg
    progress('Stationer');
    const allStations = await safe(() => query({
      objecttype: 'TrainStation', schemaversion: '1.4', limit: 20000,
      include: ['LocationSignature', 'Advertised', 'Geometry.WGS84', 'CountryCode']
    }, req));
    const routeStations = routeSigs.length ? await safe(() => query({
      objecttype: 'TrainStation', schemaversion: '1.4', limit: 500,
      filter: { op: 'IN', name: 'LocationSignature', value: routeSigs.join(',') }
    }, req)) : { ok: true, value: [] };
    const stSection = {};
    if (allStations.ok) {
      const list = allStations.value;
      const notAdvertised = list.filter(s => s.Advertised === false);
      stSection.all = {
        count: list.length, advertised: list.filter(s => s.Advertised === true).length,
        notAdvertised: notAdvertised.length,
        notAdvertisedWithPosition: notAdvertised.filter(s => s.Geometry && s.Geometry.WGS84).length,
        routeNotAdvertised: routeSigs.filter(sig => notAdvertised.some(s => s.LocationSignature === sig))
      };
    } else stSection.allError = allStations.error;
    if (routeStations.ok) stSection.route = { count: routeStations.value.length, fields: fieldSummary(routeStations.value), records: routeStations.value };
    else stSection.routeError = routeStations.error;
    out.sections.stations = stSection;
    await sleep(pause);

    // 4. Störningar och stationsmeddelanden som rör tågets stationer.
    // TrainMessage finns inte längre (svar 2026-11-25: "ObjectType 'TrainMessage' does not exists");
    // ersättaren är OperativeEvent i namespace ols.open. EventState 1 = pågår.
    progress('Störningar och meddelanden');
    const nowLocal = swedishLocal(now);
    const msgs = await safe(() => query({
      namespace: 'ols.open', objecttype: 'OperativeEvent', schemaversion: '1.0', limit: 2000,
      filter: { op: 'EQ', name: 'EventState', value: '1' }
    }, req));
    if (msgs.ok) {
      const onRoute = msgs.value.filter(m => signaturesIn(m).some(sig => routeSigs.includes(sig)));
      out.sections.messages = { count: msgs.value.length, fields: fieldSummary(msgs.value), onRoute: onRoute.slice(0, 20), onRouteCount: onRoute.length };
    } else out.sections.messages = { error: msgs.error };
    // Stationsmeddelanden: bara de som gäller nu, för tågets stationer (utan filter kom 2 000 gamla meddelanden)
    const stFilter = routeSigs.length
      ? { op: 'AND', items: [{ op: 'IN', name: 'LocationCode', value: routeSigs.join(',') }, { op: 'GT', name: 'EndDateTime', value: nowLocal }] }
      : { op: 'GT', name: 'EndDateTime', value: nowLocal };
    const stMsgs = await safe(() => query({ objecttype: 'TrainStationMessage', schemaversion: '1', limit: 500, filter: stFilter }, req));
    if (stMsgs.ok) {
      const onRoute = stMsgs.value.filter(m => routeSigs.includes(m.LocationCode));
      out.sections.stationMessages = { count: stMsgs.value.length, fields: fieldSummary(stMsgs.value), onRoute: onRoute.slice(0, 40), onRouteCount: onRoute.length };
    } else out.sections.stationMessages = { error: stMsgs.error };
    const codes = await safe(() => query({ objecttype: 'ReasonCode', schemaversion: '1', limit: 5000 }, req));
    out.sections.reasonCodes = codes.ok ? { count: codes.value.length, fields: fieldSummary(codes.value), records: codes.value.slice(0, 5) } : { error: codes.error };
    await sleep(pause);

    // Namespace: Trafikverket skriver att TrainAnnouncement kräver namespace från 2/9 2026, men frågorna
    // utan namespace svarade 2026-11-25. Här provas varianterna, så att appen kan byta i förväg.
    progress('Namespace');
    const nsTrain = { op: 'EQ', name: 'OperationalTrainNumber', value: train };
    const nsDay = { op: 'AND', items: [nsTrain, { op: 'GTE', name: 'AdvertisedTimeAtLocation', value: `${date}T00:00:00` }, { op: 'LTE', name: 'AdvertisedTimeAtLocation', value: `${date}T23:59:59` }] };
    const variants = [
      { label: 'TrainAnnouncement 1.9 utan namespace (appen i dag)', q: { objecttype: 'TrainAnnouncement', schemaversion: '1.9', limit: 1000, filter: nsDay } },
      { label: 'TrainAnnouncement 1.9 rail.trafficinfo', q: { namespace: 'rail.trafficinfo', objecttype: 'TrainAnnouncement', schemaversion: '1.9', limit: 1000, filter: nsDay } },
      { label: 'TrainAnnouncement 2.0 rail.trafficinfo', q: { namespace: 'rail.trafficinfo', objecttype: 'TrainAnnouncement', schemaversion: '2.0', limit: 1000, filter: nsDay } },
      { label: 'TrainStation 1.4 rail.trafficinfo', q: { namespace: 'rail.trafficinfo', objecttype: 'TrainStation', schemaversion: '1.4', limit: 5, filter: { op: 'EQ', name: 'Advertised', value: 'true' } } }
    ];
    out.sections.namespaces = [];
    for (const v of variants) {
      const r = await safe(() => query(v.q, req));
      const item = { label: v.label, namespace: v.q.namespace || null, objecttype: v.q.objecttype, schemaversion: v.q.schemaversion };
      if (r.ok) Object.assign(item, { ok: true, count: r.value.length, fields: fieldSummary(r.value).map(f => f.path) });
      else Object.assign(item, { ok: false, error: r.error });
      out.sections.namespaces.push(item);
    }
    await sleep(pause);

    // 5. Appens körningar mot Trafikverkets rapporterade tider, och hur långt bakåt det finns data
    const picked = pickRuns(o.logs, now, o.recentRuns);
    const runs = [];
    let allRows = [];
    for (let i = 0; i < picked.length; i++) {
      const { run, reason } = picked[i];
      progress(`Körningar mot Trafikverket ${i + 1}/${picked.length}`);
      const r = await safe(() => fetchRunAnnouncements(run, req));
      const item = { id: String(run.id), trainNumber: trainOf(run), startedAt: run.startedAt, reason,
        ageDays: Math.round((now - toMs(run.startedAt)) / 864e5) };
      if (r.ok) {
        const copy = JSON.parse(JSON.stringify(run));
        const times = trafikverketTimes(copy, r.value, now);
        applyTrafikverket(copy, times);
        const rows = compareRun(copy).map(row => Object.assign({ runId: item.id, trainNumber: item.trainNumber, date: swedishDay(run.startedAt) }, row));
        Object.assign(item, { announcements: r.value.length, matchedStops: times.meta.found, complete: times.meta.complete, rows: rows.length });
        allRows = allRows.concat(rows);
      } else item.error = r.error;
      runs.push(item);
      if (i < picked.length - 1) await sleep(pause);
    }
    out.sections.comparison = { runs, rows: allRows, summary: summarizeComparison(allRows) };
    progress('Klart');
    return out;
  }

  return {
    API_URL, DEFAULT_KEY, RUN_FIELDS, TrvError,
    xmlEscape, filterXml, buildQuery, buildRequest, request, query,
    toMs, swedishLocal, swedishDay, runWindow, runQuery, fetchRunAnnouncements,
    matchAnnouncement, trafikverketTimes, applyTrafikverket, needsTrafikverket, wholeMinute, signaturesIn,
    compareRun, stats, summarizeComparison, fieldSummary, pickRuns, wgs84, runCheck,
    CROSSING_QUERY, CROSSING_FIELDS, parseCrossings, fetchRailCrossings
  };
});
