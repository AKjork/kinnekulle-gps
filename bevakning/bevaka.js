/* RailTimer – bevakning i bakgrunden (körs i GitHub Actions i railtimer-data, se bevakning.yml där).

   När appen lämnas under en resa startar den bevakningen med repository_dispatch (händelsen "bevaka").
   Varje minut hämtas samma sak från Trafikverket som infofliken hämtar, och samma beräkning görs
   (railtimer-info.js: compute och alerts). Blir något värre – möte med väntan, anslutning som blir knapp
   eller missas, tåg som inte hinner till oss, avvikelse eller störning – skickas en webbpush till telefonen
   (webpush.js). Samma sak meddelas en gång per nivå, och det appen redan meddelat (payload.notified) meddelas
   inte igen.

   Bevakningen slutar när Trafikverket rapporterar ankomsten till slutstationen, när appen skickar
   "bevaka-stopp" (appen har visats i 3 min, eller resan är slut), 3 h efter planerad ankomst eller efter 350 min.
   "bevaka-test" skickar bara en testnotis.

   Skillnad mot appen: här finns inte telefonens GPS. Våra tider är appens fram till att appen lämnades
   (payload.known) och sedan Trafikverkets rapporter, och vårt läge är Trafikverkets tågposition. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const INFO = require('../railtimer-info.js');
const WP = require('./webpush.js');

const TRV_URL = 'https://api.trafikinfo.trafikverket.se/v2/data.json';
const MIN = 60000;
const CFG = {
  stepMs: MIN,                 // som appen: varje minut (INFO_REFRESH_MS)
  fetchTimeoutMs: 15000,       // INFO_FETCH_TIMEOUT_MS
  lineBeforeMs: 60 * MIN,      // INFO_LINE_BEFORE_MS
  lineAfterMs: 45 * MIN,       // INFO_LINE_AFTER_MS
  messagesMs: 10 * MIN,        // INFO_MESSAGES_MS
  maxRunMs: 350 * MIN,         // GitHub stoppar jobbet efter 360 min
  afterArrivalMs: 3 * 3600000, // längst så här länge efter planerad ankomst
  notFoundTries: 3,            // tåget hittas inte: ge upp efter så här många försök (minuter)
  offlineNoticeAfter: 5,       // så många misslyckade hämtningar i rad innan telefonen får veta
  ourPosMaxAgeMs: 2 * MIN
};

// Klockslag i svensk tid (GitHubs datorer går i UTC), avrundat till hel minut som i appen
const clockFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clock = t => t == null ? '–' : clockFmt.format(new Date(Math.round(t / MIN) * MIN));
const delayText = d => d == null ? '' : (d === 0 ? 'i tid' : (d > 0 ? `+${d} min` : `−${-d} min`));

function trvKeyFromApp() {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const m = /TRAFIKVERKET_API_KEY\s*=\s*'([^']+)'/.exec(html);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

function err(kind, message) { const e = new Error(message); e.kind = kind; return e; }

/* Kontrollerar och läser appens begäran. Ger { ok, error, … } */
function readPayload(p) {
  const j = p && p.journey;
  const push = p && p.push;
  if (!p || p.v !== 1) return { ok: false, error: 'okänd version' };
  if (!push || !push.sub || !push.sub.endpoint || !push.jwk) return { ok: false, error: 'prenumerationen saknas' };
  if (!/^https:\/\//.test(push.sub.endpoint)) return { ok: false, error: 'ogiltig adress för notiser' };
  return {
    ok: true,
    journey: j ? {
      id: String(j.id || ''), train: String(j.train || ''), startSig: j.startSig || '', endSig: j.endSig || '',
      startedAt: Number(j.startedAt) || null, announce: !!j.announce, app: String(j.app || '')
    } : null,
    sub: push.sub, jwk: push.jwk,
    known: new Map((Array.isArray(p.known) ? p.known : []).filter(k => Array.isArray(k) && k[0])
      .map(([sig, arr, dep]) => [sig, { arr: Number.isFinite(arr) ? arr : null, dep: Number.isFinite(dep) ? dep : null }])),
    notified: new Map((Array.isArray(p.notified) ? p.notified : []).filter(k => Array.isArray(k) && k[0]).map(([k, l]) => [String(k), Number(l) || 0])),
    names: new Map(Object.entries(p.names && typeof p.names === 'object' ? p.names : {})),
    history: new Map((Array.isArray(p.history) ? p.history : []).filter(h => Array.isArray(h) && h[0]).map(([k, median, n]) => [k, { median, n }])),
    double: Array.isArray(p.double) ? p.double.map(String) : []
  };
}

/* En bevakning. deps: { fetch, now, sleep, log, trvKey, send(message) → { ok, gone } } */
function createWatch(req, deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  const j = req.journey;
  const st = {
    our: null, ourKey: null, line: null, trains: null, safeFields: false, positionsOff: false,
    positions: new Map(), messages: [], messagesAt: 0, names: new Map(), coords: new Map(), askedNames: new Set(),
    notified: req.notified, failures: 0, notFound: 0, offlineSent: false, announced: !j || !j.announce,
    startedAt: now(), model: null, sent: 0
  };
  const name = sig => req.names.get(sig) || st.names.get(sig) || sig;

  async function trv(queries) {
    let resp;
    try {
      resp = await deps.fetch(TRV_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: INFO.request(deps.trvKey, queries),
        signal: AbortSignal.timeout(CFG.fetchTimeoutMs)
      });
    } catch (e) {
      throw err(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network', 'Trafikverket svarar inte');
    }
    let data = null;
    try { data = await resp.json(); } catch (e) { data = null; }
    if (!resp.ok) {
      const r = INFO.resultOf(data, 0, '');
      throw r.error && r.error !== 'Tomt svar' ? err('api', r.error) : err('http', `HTTP ${resp.status}`);
    }
    return data;
  }
  // Som infoAnnouncements i appen: godtas inte frågan med alla fält frågas igen utan de oprovade
  async function announcements(build) {
    const fields = st.safeFields ? INFO.SAFE_ANNOUNCEMENT_FIELDS : INFO.ANNOUNCEMENT_FIELDS;
    try {
      const r = INFO.resultOf(await trv([build(fields)]), 0, 'TrainAnnouncement');
      if (r.error) throw err('api', r.error);
      return r.list;
    } catch (e) {
      if ((e.kind === 'http' || e.kind === 'api') && !st.safeFields) { st.safeFields = true; return announcements(build); }
      throw e;
    }
  }
  async function fetchNames(sigs) {
    const missing = Array.from(new Set(sigs)).filter(s => s && !st.askedNames.has(s) && (!req.names.has(s) || !st.coords.has(s))).slice(0, 80);
    if (!missing.length) return;
    missing.forEach(s => st.askedNames.add(s));
    try {
      const r = INFO.resultOf(await trv([INFO.queryNames(missing)]), 0, 'TrainStation');
      if (r.error) return;
      for (const s of r.list) {
        if (s.LocationSignature && s.AdvertisedLocationName) st.names.set(s.LocationSignature, s.AdvertisedLocationName);
        const pt = INFO.wgs84(s.Geometry && s.Geometry.WGS84);
        if (s.LocationSignature && pt) st.coords.set(s.LocationSignature, pt);
      }
    } catch (e) { log(`namn: ${e.message}`); }
  }
  async function refreshPositions(model) {
    if (st.positionsOff) return;
    const otns = Array.from(new Set((model ? model.meetings : []).filter(m => !m.canceled).map(m => m.otn))).slice(0, 8);
    otns.push(st.our.otn); // vårt eget läge, i stället för telefonens GPS
    try {
      const r = INFO.resultOf(await trv([INFO.queryPositions(Array.from(new Set(otns)))]), 0, 'TrainPosition');
      if (r.error) throw err('api', r.error);
      st.positions = INFO.parsePositions(r.list);
    } catch (e) {
      if (e.kind === 'api' || e.kind === 'http') st.positionsOff = true;
      log(`positioner: ${e.message}`);
    }
  }
  async function refreshMessages(t) {
    st.messagesAt = t;
    try {
      const r = INFO.resultOf(await trv([INFO.queryMessages()]), 0, 'OperativeEvent');
      if (r.error) throw new Error(r.error);
      st.messages = r.list.map(INFO.parseMessage).filter(Boolean);
    } catch (e) { log(`störningar: ${e.message}`); }
  }

  function computeModel(t) {
    const pos = st.our && st.positions.get(String(st.our.otn));
    const ourPos = pos && t - pos.t <= CFG.ourPosMaxAgeMs ? { lat: pos.lat, lon: pos.lon } : null;
    const routeNames = new Map(st.line.map(l => [l.sig, name(l.sig)]));
    return INFO.compute({
      line: st.line, trains: st.trains, ourKey: st.ourKey, known: req.known, now: t, knownDouble: req.double,
      history: req.history, routeNames, messages: st.messages, positions: st.positions, coords: st.coords, ourPos
    });
  }

  function headline(m) {
    const endName = name(m.end.sig);
    if (m.end.arrived) return `Framme i ${endName}`;
    return `${endName} ${clock(m.end.predArr)} ${delayText(m.end.delayMin)}`.trim();
  }
  function message(kind, extra) {
    return Object.assign({
      v: 1, kind, journeyId: j ? j.id : '', at: now(),
      title: j ? `Tåg ${j.train} → ${name(j.endSig)}` : 'RailTimer'
    }, extra);
  }
  async function push(msg) {
    const r = await deps.send(msg);
    st.sent++;
    log(`notis ${msg.kind}: ${r.ok ? 'skickad' : `fel ${r.status}`} – ${String(msg.body || '').replace(/\n/g, ' · ')}`);
    if (r.gone) throw err('gone', 'telefonens prenumeration finns inte längre');
    return r;
  }

  /* Ett varv: hämta, räkna och meddela. Ger null för att fortsätta, annars varför bevakningen slutar. */
  async function step() {
    const t = now();
    try {
      if (!st.line) {
        const at = j.startedAt || t;
        const list = await announcements(fields => INFO.queryOurTrain(j.train, at, fields));
        const our = INFO.nearestRun(INFO.groupTrains(list), j.train, at);
        const line = our ? INFO.buildLine(our, j.startSig, j.endSig) : [];
        if (!our || line.length < 2) {
          st.notFound++;
          if (st.notFound >= CFG.notFoundTries) {
            await push(message('error', { level: 1, body: `Bevakningen i bakgrunden kunde inte starta: tåg ${j.train} hittades inte hos Trafikverket på sträckan.` }));
            return 'tåget hittades inte';
          }
          return null;
        }
        Object.assign(st, { our, ourKey: our.key, line });
      }
      const from = Math.max(0, st.model ? st.model.frontier : 0);
      const end = st.line[st.line.length - 1];
      const endT = end.advArr != null ? end.advArr : (end.plannedArr != null ? end.plannedArr : t);
      const trains = INFO.groupTrains(await announcements(fields =>
        INFO.queryLine(st.line.slice(from).map(l => l.sig), t - CFG.lineBeforeMs, Math.max(endT, t) + CFG.lineAfterMs, fields)));
      if (!trains.has(st.ourKey)) trains.set(st.ourKey, st.our);
      st.trains = trains;
      st.failures = 0;
    } catch (e) {
      if (e.kind === 'gone') throw e;
      st.failures++;
      log(`Trafikverket: ${e.message} (${st.failures} i rad)`);
      if (st.failures >= CFG.offlineNoticeAfter && !st.offlineSent && st.line) {
        st.offlineSent = true;
        await push(message('error', { level: 1, body: `Ingen kontakt med Trafikverket sedan ${clock(t - (st.failures - 1) * CFG.stepMs)} – bevakningen försöker igen.` }));
      }
      if (!st.trains) return null;
    }

    // Namn och lägen för linjens platser och för anslutningarnas destinationer
    const stopSigs = st.line.filter(l => l.stop).map(l => l.sig);
    const sigs = st.line.map(l => l.sig);
    for (const tr of st.trains.values()) if (stopSigs.some(s => tr.at.has(s))) sigs.push(...tr.to, ...tr.from);
    await fetchNames(sigs);
    let model = computeModel(t);
    if (model) {
      await refreshPositions(model);
      model = computeModel(t);
    }
    if (t - st.messagesAt >= CFG.messagesMs) {
      await refreshMessages(t);
      model = computeModel(t);
    }
    st.model = model;
    if (!model) return null;
    if (model.doubleSections.length) req.double.push(...model.doubleSections);

    log(`${clock(t)} ${headline(model)} · ${model.meetings.length} möten · ${model.missed + (model.midMissed || 0)} missas · ${model.tight} knappa · nivå ${model.level}`);

    const fresh = INFO.newAlerts(INFO.alerts(model, { name, clock }), st.notified);
    if (!st.announced && !fresh.length) {
      // Bekräftelse en gång per resa, tyst: telefonen vet att bevakningen gick igång
      await push(message('start', {
        level: 0, silent: true,
        body: `Bevakar i bakgrunden: ${headline(model)}. Du får en notis om något blir värre.`,
        keys: Array.from(st.notified)
      }));
    }
    st.announced = true; // en notis om något blivit värre räcker också som bekräftelse
    if (fresh.length) {
      const top = fresh.slice(0, 3).map(a => a.text);
      const more = fresh.length > 3 ? `\n(och ${fresh.length - 3} till i Info)` : '';
      await push(message('alert', {
        level: fresh[0].level, body: `${top.join('\n')}${more}\n${headline(model)}`,
        say: fresh[0].say, keys: Array.from(st.notified)
      }));
    }
    if (model.end.arrived) return 'framme';
    if (model.end.adv != null && t > model.end.adv + CFG.afterArrivalMs) return 'långt efter planerad ankomst';
    return null;
  }

  async function run() {
    const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    for (let k = 0; ; k++) {
      let reason;
      try { reason = await step(); } catch (e) {
        if (e.kind === 'gone') return e.message;
        log(`fel: ${e && e.stack || e}`);
        reason = null;
      }
      if (reason) return reason;
      if (now() - st.startedAt >= CFG.maxRunMs) return 'längsta tiden';
      const next = st.startedAt + (k + 1) * CFG.stepMs;
      await sleep(Math.max(1000, next - now()));
    }
  }
  return { step, run, state: st };
}

async function main() {
  const ev = JSON.parse(fs.readFileSync(process.env.RT_EVENT_PATH || process.env.GITHUB_EVENT_PATH, 'utf8'));
  const action = ev.action;
  const req = readPayload(ev.client_payload);
  const log = s => console.log(s);
  if (!req.ok) { console.log(`::error::Bevakningen: ${req.error}`); process.exitCode = 1; return; }
  const send = msg => WP.send(req.sub, req.jwk, msg, { ttl: msg.kind === 'start' ? 300 : 900, urgency: msg.kind === 'start' ? 'normal' : 'high' });
  if (action === 'bevaka-test') {
    const r = await send({ v: 1, kind: 'test', at: Date.now(), level: 1, title: 'RailTimer', body: 'Testnotis: notiser i bakgrunden fungerar på den här telefonen.' });
    console.log(r.ok ? `::notice::Testnotis skickad (HTTP ${r.status})` : `::error::Testnotisen kom inte fram: HTTP ${r.status} ${r.text || r.error || ''}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (!req.journey || !req.journey.train || !req.journey.startSig || !req.journey.endSig) {
    console.log('::error::Bevakningen: resan saknar tågnummer eller stationer');
    process.exitCode = 1;
    return;
  }
  if (Number(process.env.RT_MAX_MIN) > 0) CFG.maxRunMs = Number(process.env.RT_MAX_MIN) * MIN; // prov
  const w = createWatch(req, { fetch: globalThis.fetch, trvKey: process.env.RT_TRV_KEY || trvKeyFromApp(), log, send });
  console.log(`Bevakar tåg ${req.journey.train} ${req.journey.startSig} → ${req.journey.endSig} (app ${req.journey.app})`);
  const reason = await w.run();
  console.log(`::notice::Bevakningen slutade: ${reason} (${w.state.sent} notiser)`);
}

module.exports = { createWatch, readPayload, clock, CFG };
if (require.main === module) main().catch(e => { console.log(`::error::${e && e.stack || e}`); process.exitCode = 1; });
