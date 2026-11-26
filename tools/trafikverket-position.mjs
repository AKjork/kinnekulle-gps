// Prov mot Trafikverkets riktiga API: går det att se var tåget är, utan att vara på tåget?
// Körs av .github/workflows/trafikverket-position.yml, eftersom utvecklingsmiljön inte når Trafikverket.
// Svarar inte på några frågor; skriver bara ut vad API:t svarar, i körningens logg och sammanfattning.
//
// Två källor:
//  - TrainAnnouncement: rapporterna från driftplatserna (på System M bara vissa stationer, ofta hela minuter).
//  - TrainPosition (namespace järnväg.trafikinfo): fordonens egen GPS, samma som Trafikverkets tågkarta.
//
// 1. Tågen på Kinnekullebanan och Älvsborgsbanan nu (LINE_SIGS), med senaste rapporten.
// 2. TrainPosition för tågen var POLL_S:e sekund i DURATION_S sekunder: hur ofta positionen ändras, hur gammal
//    den är när den hämtas, fart, och var den ligger mot linjen och mot senaste rapporten.
// 3. SSE (sseurl): skickar Trafikverket nya positioner av sig själv, och tillåts det från appens adress (CORS)?
// 4. Pågående störningar (OperativeEvent): händelsetyperna, de som rör linjen och Göteborgsområdet, och fälten.
import { appendFileSync } from 'node:fs';

const KEY = '1acaea82911c472cb3409d57ae19707f'; // samma publika nyckel som appen (index.html)
const URL = 'https://api.trafikinfo.trafikverket.se/v2/data.json';
const ORIGIN = 'https://akjork.github.io';
const DURATION_S = Number(process.env.DURATION_S || 240);
const POLL_S = Number(process.env.POLL_S || 10);
const SSE_S = Number(process.env.SSE_S || 90);
// Gårdsjö – Håkantorp (Kinnekullebanan, System M) och Håkantorp – Herrljunga C (Älvsborgsbanan), ur railtimer-infra.js
const KINNE = 'Gdö Hova Tvd Lyd Hsr Mst Lnå Äsr Öäg Fhm Hlk Rbk Trm Bmb Kll Fiä Lkp Fc Lve Jps Stlv Håp'.split(' ');
const ALVS = 'Håp Vaa Ved Hrc'.split(' ');
const LINE_SIGS = (process.env.SIGS || KINNE.concat(ALVS.slice(1)).join(' ')).split(/[\s,]+/).filter(Boolean);
const EXTRA = (process.env.NUMBERS || '').split(/[\s,]+/).filter(Boolean);

const out = [];
const log = s => { out.push(s); console.log(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function swedish(d) {
  const f = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = {}; for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
const hms = t => swedish(new Date(t)).slice(11);
const inc = f => f.map(x => `<INCLUDE>${x}</INCLUDE>`).join('');
async function ask(query, type, extraHeaders) {
  const body = `<REQUEST><LOGIN authenticationkey="${KEY}" />${query}</REQUEST>`;
  const res = await fetch(URL, { method: 'POST', headers: Object.assign({ 'Content-Type': 'text/xml' }, extraHeaders || {}), body });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch (e) { /* */ }
  const r = data && data.RESPONSE && data.RESPONSE.RESULT && data.RESPONSE.RESULT[0];
  if (!res.ok || !r || r.ERROR) throw new Error(`HTTP ${res.status}: ${(r && r.ERROR && r.ERROR.MESSAGE) || text.slice(0, 300)}`);
  return { list: r[type] || [], info: r.INFO || null, headers: res.headers };
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const wgs = s => { const m = /POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/.exec(String(s || '')); return m ? { lon: +m[1], lat: +m[2] } : null; };
// Avstånd från p till sträckan a–b och var på sträckan (0–1)
function project(p, a, b) {
  const k = Math.cos(p.lat * Math.PI / 180), R = 6371000, rad = Math.PI / 180;
  const ax = (a.lon - p.lon) * rad * k * R, ay = (a.lat - p.lat) * rad * R;
  const bx = (b.lon - p.lon) * rad * k * R, by = (b.lat - p.lat) * rad * R;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let f = L2 ? -(ax * dx + ay * dy) / L2 : 0; f = Math.max(0, Math.min(1, f));
  return { off: Math.hypot(ax + f * dx, ay + f * dy), f };
}
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

const now = Date.now();
log(`# Prov: var är tåget? Tågposition (fordonens GPS) och rapporter (${swedish(new Date(now))} svensk tid)`);
log(`\nLinjen: ${LINE_SIGS.join(' ')}. Positionen hämtas var ${POLL_S}:e sekund i ${DURATION_S} s.`);

// ── Stationerna: namn och läge ──
const stations = new Map();
try {
  const or = LINE_SIGS.map(s => `<EQ name="LocationSignature" value="${s}" />`).join('');
  const { list } = await ask(`<QUERY objecttype="TrainStation" schemaversion="1.4"><FILTER><OR>${or}</OR></FILTER>${inc(['LocationSignature', 'AdvertisedLocationName', 'Geometry.WGS84'])}</QUERY>`, 'TrainStation');
  for (const s of list) { const p = wgs(s.Geometry && s.Geometry.WGS84); if (p) stations.set(s.LocationSignature, Object.assign({ name: s.AdvertisedLocationName || s.LocationSignature }, p)); }
} catch (e) { log(`\nTrainStation: ${e.message}`); }
const nm = s => (stations.get(s) || {}).name || s;

// ── 1. Tågen på linjen nu ──
const trains = new Map(); // otn → { otn, atn, rows: [] }
try {
  const or = LINE_SIGS.map(s => `<EQ name="LocationSignature" value="${s}" />`).join('');
  const nums = EXTRA.map(n => `<EQ name="OperationalTrainNumber" value="${n}" /><EQ name="AdvertisedTrainIdent" value="${n}" />`).join('');
  const q = `<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="3000"><FILTER><AND>` +
    `<OR>${or}</OR>${nums ? `<OR>${nums}</OR>` : ''}` +
    `<GTE name="AdvertisedTimeAtLocation" value="${swedish(new Date(now - 100 * 60000))}" />` +
    `<LTE name="AdvertisedTimeAtLocation" value="${swedish(new Date(now + 40 * 60000))}" />` +
    `</AND></FILTER>${inc(['OperationalTrainNumber', 'AdvertisedTrainIdent', 'LocationSignature', 'ActivityType', 'AdvertisedTimeAtLocation', 'LocationDateTimeOTN', 'TimeAtLocation', 'TimeAtLocationWithSeconds', 'Advertised', 'Canceled', 'ProductInformation', 'ToLocation'])}</QUERY>`;
  const { list } = await ask(q, 'TrainAnnouncement');
  for (const a of list) {
    const otn = String(a.OperationalTrainNumber || a.AdvertisedTrainIdent || '');
    if (!otn) continue;
    if (!trains.has(otn)) trains.set(otn, { otn, atn: String(a.AdvertisedTrainIdent || ''), rows: [], product: '' });
    const tr = trains.get(otn);
    tr.rows.push(a);
    if (!tr.product && a.ProductInformation && a.ProductInformation[0]) tr.product = a.ProductInformation[0].Description || '';
  }
} catch (e) { log(`\nTrainAnnouncement: ${e.message}`); }

// Pågår: rapporterat de senaste 100 min och inte framme, eller planerat nu
const active = [];
for (const tr of trains.values()) {
  tr.rows.sort((a, b) => String(a.AdvertisedTimeAtLocation).localeCompare(String(b.AdvertisedTimeAtLocation)));
  const rep = tr.rows.filter(r => r.TimeAtLocation);
  tr.last = rep.length ? rep.reduce((x, y) => Date.parse(y.TimeAtLocationWithSeconds || y.TimeAtLocation) >= Date.parse(x.TimeAtLocationWithSeconds || x.TimeAtLocation) ? y : x) : null;
  const t0 = Date.parse(tr.rows[0].AdvertisedTimeAtLocation), t1 = Date.parse(tr.rows[tr.rows.length - 1].AdvertisedTimeAtLocation);
  tr.lastRow = tr.rows[tr.rows.length - 1];
  const arrivedEnd = tr.last && tr.last === tr.lastRow && tr.last.ActivityType === 'Ankomst';
  tr.reports = rep.length;
  tr.minuteOnly = rep.filter(r => !r.TimeAtLocationWithSeconds || /:00(\.000)?([+-]|$)/.test(String(r.TimeAtLocationWithSeconds).slice(16))).length;
  if (!arrivedEnd && ((tr.last && now - Date.parse(tr.last.TimeAtLocation) < 100 * 60000) || (t0 <= now + 15 * 60000 && t1 >= now - 5 * 60000))) active.push(tr);
}
active.sort((a, b) => (b.last ? 1 : 0) - (a.last ? 1 : 0));
const watch = active.slice(0, 14);
log(`\n## 1. Tåg på linjen nu: ${active.length} (${trains.size} med tider i fönstret)\n`);
log('| OTN | ATN | produkt | senaste rapport | rapporter | varav hela minuter | nästa enligt plan |');
log('|---|---|---|---|---|---|---|');
for (const tr of watch) {
  const L = tr.last;
  const lastText = L ? `${nm(L.LocationSignature)} ${L.ActivityType === 'Ankomst' ? 'ank' : 'avg'} ${hms(Date.parse(L.TimeAtLocationWithSeconds || L.TimeAtLocation))} (${Math.round((Date.parse(L.TimeAtLocation) - Date.parse(L.LocationDateTimeOTN || L.AdvertisedTimeAtLocation)) / 60000)} min)` : '–';
  const nextRow = tr.rows.find(r => !r.TimeAtLocation && Date.parse(r.AdvertisedTimeAtLocation) >= (L ? Date.parse(L.AdvertisedTimeAtLocation) : 0) && r !== L);
  const nextText = nextRow ? `${nm(nextRow.LocationSignature)} ${hms(Date.parse(nextRow.LocationDateTimeOTN || nextRow.AdvertisedTimeAtLocation)).slice(0, 5)}` : '–';
  log(`| ${tr.otn} | ${tr.atn} | ${tr.product} | ${lastText} | ${tr.reports} | ${tr.minuteOnly} | ${nextText} |`);
}

// ── Fälten i TrainPosition ──
const POSF = ['Train.OperationalTrainNumber', 'Train.AdvertisedTrainNumber', 'Train.JourneyPlanNumber', 'Position.WGS84', 'TimeStamp', 'ModifiedTime', 'Speed', 'Bearing', 'Status.Active', 'Deleted'];
const posQuery = (otns, extra) => `<QUERY namespace="järnväg.trafikinfo" objecttype="TrainPosition" schemaversion="1.1" limit="${otns.length * 4 + 4}"${extra || ''}>` +
  `<FILTER><OR>${otns.map(o => `<EQ name="Train.OperationalTrainNumber" value="${o}" />`).join('')}</OR></FILTER></QUERY>`;
const otns = watch.map(t => t.otn);
if (otns.length) {
  try {
    const { list } = await ask(posQuery(otns.slice(0, 1)), 'TrainPosition');
    log(`\n## Fälten i TrainPosition (tåg ${otns[0]}, utan INCLUDE)\n`);
    log('```');
    log(JSON.stringify(list[0] || null, null, 1).slice(0, 1500));
    log('```');
  } catch (e) { log(`\nTrainPosition utan INCLUDE: ${e.message}`); }
}

// ── 3. SSE (startas samtidigt som avläsningen) ──
const sse = { started: false, events: 0, positions: 0, firstAt: null, cors: null, error: null, url: null, perTrain: new Map() };
async function runSse() {
  try {
    const { info } = await ask(posQuery(otns, ' sseurl="true"'), 'TrainPosition');
    sse.url = info && info.SSEURL;
    if (!sse.url) { sse.error = 'inget SSEURL i svaret'; return; }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SSE_S * 1000);
    const t0 = Date.now();
    const res = await fetch(sse.url, { headers: { Accept: 'text/event-stream', Origin: ORIGIN }, signal: ctl.signal });
    sse.started = true;
    sse.status = res.status;
    sse.cors = res.headers.get('access-control-allow-origin');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, k); buf = buf.slice(k + 2);
          const data = ev.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('');
          if (!data) continue;
          sse.events++;
          if (sse.firstAt == null) sse.firstAt = (Date.now() - t0) / 1000;
          try {
            const j = JSON.parse(data);
            const list = (j.RESPONSE && j.RESPONSE.RESULT && j.RESPONSE.RESULT[0] && j.RESPONSE.RESULT[0].TrainPosition) || [];
            for (const p of list) {
              sse.positions++;
              const o = String(p.Train && p.Train.OperationalTrainNumber);
              sse.perTrain.set(o, (sse.perTrain.get(o) || 0) + 1);
            }
          } catch (e) { /* */ }
        }
      }
    } catch (e) { if (e.name !== 'AbortError') throw e; }
    clearTimeout(timer);
  } catch (e) { if (e.name !== 'AbortError') sse.error = e.message; }
}
const ssePromise = otns.length ? runSse() : Promise.resolve();

// ── 2. Avläsning av tågpositionen ──
const seen = new Map(); // otn → { stamps: Map(TimeStamp → p), ages: [], polls, empty }
let corsData = null;
const t0 = Date.now();
let polls = 0;
while (otns.length && Date.now() - t0 < DURATION_S * 1000) {
  const at = Date.now();
  try {
    const { list, headers } = await ask(`<QUERY namespace="järnväg.trafikinfo" objecttype="TrainPosition" schemaversion="1.1" limit="${otns.length * 4 + 4}">` +
      `<FILTER><OR>${otns.map(o => `<EQ name="Train.OperationalTrainNumber" value="${o}" />`).join('')}</OR></FILTER>${inc(POSF)}</QUERY>`, 'TrainPosition', polls === 0 ? { Origin: ORIGIN } : null);
    if (polls === 0) corsData = headers.get('access-control-allow-origin');
    polls++;
    for (const o of otns) {
      if (!seen.has(o)) seen.set(o, { stamps: new Map(), ages: [], empty: 0 });
      const s = seen.get(o);
      const mine = list.filter(p => String(p.Train && p.Train.OperationalTrainNumber) === o);
      if (!mine.length) { s.empty++; continue; }
      const p = mine.reduce((x, y) => Date.parse(y.TimeStamp) > Date.parse(x.TimeStamp) ? y : x);
      const ts = Date.parse(p.TimeStamp);
      s.ages.push((at - ts) / 1000);
      if (!s.stamps.has(p.TimeStamp)) s.stamps.set(p.TimeStamp, Object.assign({ fetchedAt: at, ts }, p));
    }
  } catch (e) { log(`Avläsning ${polls}: ${e.message}`); polls++; }
  await sleep(Math.max(0, POLL_S * 1000 - (Date.now() - at)));
}

log(`\n## 2. Tågpositionen, ${polls} avläsningar på ${Math.round((Date.now() - t0) / 1000)} s\n`);
log(`CORS för frågan från ${ORIGIN}: \`${corsData}\``);
log('\n| OTN | position | nya positioner | tid mellan (median, P90) | ålder vid hämtning (median, max) | fart | läge mot linjen | mot senaste rapporten |');
log('|---|---|---|---|---|---|---|---|');
// Linjen i ordning (stationer med läge) för att se var positionen ligger
const lineSt = LINE_SIGS.map(s => Object.assign({ sig: s }, stations.get(s) || {})).filter(s => s.lat != null);
const summary = { withPos: 0, total: otns.length, intervals: [], ages: [] };
for (const tr of watch) {
  const s = seen.get(tr.otn);
  const stamps = s ? Array.from(s.stamps.values()).sort((a, b) => a.ts - b.ts) : [];
  if (!stamps.length) { log(`| ${tr.otn} | saknas (${s ? s.empty : 0} av ${polls} tomma) | – | – | – | – | – | – |`); continue; }
  summary.withPos++;
  const iv = []; for (let i = 1; i < stamps.length; i++) iv.push((stamps[i].ts - stamps[i - 1].ts) / 1000);
  summary.intervals.push(...iv); summary.ages.push(...s.ages);
  const last = stamps[stamps.length - 1];
  const p = wgs(last.Position && last.Position.WGS84);
  const speeds = stamps.map(x => x.Speed).filter(v => v != null);
  // Närmaste delsträcka på linjen
  let best = null;
  for (let k = 0; p && k + 1 < lineSt.length; k++) {
    const pr = project(p, lineSt[k], lineSt[k + 1]);
    if (!best || pr.off < best.off) best = { k, off: pr.off, f: pr.f };
  }
  const where = best ? `${Math.round(best.off)} m från ${nm(lineSt[best.k].sig)}–${nm(lineSt[best.k + 1].sig)} (${Math.round(best.f * 100)} %)` : '–';
  // Mot senaste rapporten: avstånd från rapportens station
  const L = tr.last;
  const rs = L && stations.get(L.LocationSignature);
  const vsRep = rs && p ? `${Math.round(haversine(p.lat, p.lon, rs.lat, rs.lon) / 100) / 10} km från ${nm(L.LocationSignature)} (${L.ActivityType === 'Ankomst' ? 'ank' : 'avg'} ${hms(Date.parse(L.TimeAtLocationWithSeconds || L.TimeAtLocation)).slice(0, 5)})` : '–';
  log(`| ${tr.otn} | ${p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : '?'} | ${stamps.length} | ${iv.length ? `${median(iv)} s, ${pct(iv, 0.9)} s` : '–'} | ${Math.round(median(s.ages))} s, ${Math.round(Math.max(...s.ages))} s | ${speeds.length ? `${speeds[speeds.length - 1]} km/h (${speeds.length} av ${stamps.length})` : 'saknas'} | ${where} | ${vsRep} |`);
}
log(`\n**${summary.withPos} av ${summary.total} tåg hade position.** Tid mellan nya positioner: median ${median(summary.intervals)} s, P90 ${pct(summary.intervals, 0.9)} s. Ålder när den hämtades: median ${Math.round(median(summary.ages) || 0)} s, P90 ${Math.round(pct(summary.ages, 0.9) || 0)} s.`);

// Positionerna i ordning för ett tåg i rörelse, så att det syns hur de följer linjen
const moving = watch.map(t => ({ t, s: seen.get(t.otn) })).filter(x => x.s && x.s.stamps.size >= 3)
  .sort((a, b) => b.s.stamps.size - a.s.stamps.size)[0];
if (moving) {
  log(`\n### Positionerna för ${moving.t.otn} i ordning\n`);
  log('| tid (TimeStamp) | hämtad | lat, lon | fart | sträcka sedan förra |');
  log('|---|---|---|---|---|');
  let prev = null;
  for (const x of Array.from(moving.s.stamps.values()).sort((a, b) => a.ts - b.ts)) {
    const p = wgs(x.Position && x.Position.WGS84);
    log(`| ${hms(x.ts)} | +${Math.round((x.fetchedAt - x.ts) / 1000)} s | ${p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : '?'} | ${x.Speed != null ? x.Speed + ' km/h' : '–'} | ${prev && p ? Math.round(haversine(prev.lat, prev.lon, p.lat, p.lon)) + ' m' : ''} |`);
    prev = p;
  }
}

await ssePromise;
log(`\n## 3. SSE (Trafikverket skickar nya positioner av sig själv)\n`);
if (sse.error) log(`Fel: ${sse.error}`);
log(`- SSEURL i svaret: ${sse.url ? 'ja' : 'nej'}`);
log(`- Ström öppnad: ${sse.started ? `ja (HTTP ${sse.status})` : 'nej'}; CORS från ${ORIGIN}: \`${sse.cors}\``);
log(`- På ${SSE_S} s: ${sse.events} händelser med ${sse.positions} positioner; första efter ${sse.firstAt != null ? Math.round(sse.firstAt) + ' s' : '–'}`);
if (sse.perTrain.size) log(`- Per tåg: ${Array.from(sse.perTrain).map(([o, n]) => `${o}: ${n}`).join(', ')}`);

// ── 4. Störningar (OperativeEvent): vad står det, och säger Trafikverket vilket tåg? ──
// André 2026-11-26: "Vem/vilka har problem med dragfordon/motorvagn?" (händelse vid Gamlestaden–Göteborg C)
try {
  const { list } = await ask(`<QUERY namespace="ols.open" objecttype="OperativeEvent" schemaversion="1.0" limit="2000"><FILTER><EQ name="EventState" value="1" /></FILTER></QUERY>`, 'OperativeEvent');
  log(`\n## 4. Pågående störningar (OperativeEvent): ${list.length}\n`);
  const types = new Map();
  for (const e of list) {
    const d = (e.EventType && e.EventType.Description) || '?';
    types.set(d, (types.get(d) || 0) + 1);
  }
  log('| händelsetyp | antal |');
  log('|---|---|');
  for (const [d, n] of Array.from(types).sort((a, b) => b[1] - a[1])) log(`| ${d} | ${n} |`);
  // Alla signaturer på alla nivåer
  const sigs = (o, acc) => {
    if (!o || typeof o !== 'object') return acc;
    for (const [k, v] of Object.entries(o)) {
      if ((k === 'Signature' || k === 'LocationSignature') && typeof v === 'string') acc.add(v);
      else if (typeof v === 'object') sigs(v, acc);
    }
    return acc;
  };
  const WATCH = new Set(LINE_SIGS.concat((process.env.EVENT_SIGS || 'G Gas Sel Agb Öx Bgs').split(/[\s,]+/)));
  const near = list.filter(e => Array.from(sigs(e, new Set())).some(x => WATCH.has(x)));
  const vehicle = list.filter(e => /dragfordon|motorvagn|fordon/i.test((e.EventType && e.EventType.Description) || ''));
  log(`\nRör linjen eller Göteborgsområdet: ${near.length}. Fordonsfel i hela landet: ${vehicle.length}.`);
  const shown = new Set();
  for (const e of near.concat(vehicle).slice(0, 4)) {
    if (shown.has(e.EventId)) continue;
    shown.add(e.EventId);
    log(`\n### ${(e.EventType && e.EventType.Description) || '?'} · ${Array.from(sigs(e, new Set())).join(' ')}\n`);
    log('```');
    log(JSON.stringify(e, null, 1).slice(0, 3500));
    log('```');
  }
  // Fält som förekommer, med antal
  const fields = new Map();
  const walk = (o, pre) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(x => walk(x, pre)); return; }
    for (const [k, v] of Object.entries(o)) {
      const key = pre ? `${pre}.${k}` : k;
      fields.set(key, (fields.get(key) || 0) + 1);
      if (v && typeof v === 'object') walk(v, key);
    }
  };
  list.forEach(e => walk(e, ''));
  log('\n| fält | förekomster |');
  log('|---|---|');
  for (const [k, n] of Array.from(fields).sort()) log(`| ${k} | ${n} |`);
} catch (e) { log(`\nOperativeEvent: ${e.message}`); }

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n');
