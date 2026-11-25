// Prov mot Trafikverkets riktiga API: operativt (OTN) och annonserat tågnummer (ATN).
// Körs av .github/workflows/trafikverket-prov.yml, eftersom utvecklingsmiljön inte når Trafikverket.
// Svarar inte på några frågor; skriver bara ut vad API:t svarar, i körningens logg och sammanfattning.
//
// 1. Varje tågnummer i NUMBERS frågas som appen gör: OperationalTrainNumber = n ELLER AdvertisedTrainIdent = n,
//    ±12 h kring nu. Vilka körningar (OTN, ATN, avgångsdatum, första och sista plats) svaret ger.
// 2. Hela landet, avgångar ett dygn: hur ofta OTN och ATN skiljer, om ett ATN har flera OTN samma dag,
//    och om ett nummer är OTN för ett tåg och ATN för ett annat samma dag (då blir ett inskrivet nummer tvetydigt).
import { appendFileSync } from 'node:fs';

const KEY = '1acaea82911c472cb3409d57ae19707f'; // samma publika nyckel som appen (index.html)
const URL = 'https://api.trafikinfo.trafikverket.se/v2/data.json';
const NUMBERS = (process.env.NUMBERS || '3349 23349 3334 23334 3346 13346 53346 3344 13344 3355 13355 23355 3360 24360 3341 23341 24341 3332 23332 3302 23302 13302 3001 13001 3004 13004 3333 23333 24347 3321 13321 8074')
  .split(/[\s,]+/).filter(Boolean);

function swedish(d) {
  const f = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = {}; for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
async function ask(query) {
  const body = `<REQUEST><LOGIN authenticationkey="${KEY}" />${query}</REQUEST>`;
  const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch (e) { /* */ }
  const r = data && data.RESPONSE && data.RESPONSE.RESULT && data.RESPONSE.RESULT[0];
  if (!res.ok || !r || r.ERROR) throw new Error(`HTTP ${res.status}: ${(r && r.ERROR && r.ERROR.MESSAGE) || text.slice(0, 300)}`);
  return r.TrainAnnouncement || [];
}
const inc = f => f.map(x => `<INCLUDE>${x}</INCLUDE>`).join('');
const FIELDS = ['AdvertisedTrainIdent', 'OperationalTrainNumber', 'TechnicalTrainIdent', 'DepartureDateOTN', 'LocationSignature', 'AdvertisedTimeAtLocation', 'ActivityType', 'Advertised', 'ProductInformation'];

const out = [];
const log = s => { out.push(s); console.log(s); };
const now = new Date();
log(`# Prov: operativt och annonserat tågnummer (${swedish(now)} svensk tid)`);

// 1. Numren som appen skulle fråga
log('\n## Numren, OTN = n eller ATN = n, ±12 h\n');
log('| n | OTN | ATN | tekn. | avg.datum | från | till | träff på |');
log('|---|---|---|---|---|---|---|---|');
for (const n of NUMBERS) {
  const q = `<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="1000"><FILTER><AND>` +
    `<OR><EQ name="OperationalTrainNumber" value="${n}" /><EQ name="AdvertisedTrainIdent" value="${n}" /></OR>` +
    `<GTE name="AdvertisedTimeAtLocation" value="${swedish(new Date(now - 12 * 3600e3))}" />` +
    `<LTE name="AdvertisedTimeAtLocation" value="${swedish(new Date(+now + 12 * 3600e3))}" />` +
    `</AND></FILTER>${inc(FIELDS)}</QUERY>`;
  try {
    const list = await ask(q);
    const runs = new Map();
    for (const a of list) {
      const k = `${a.OperationalTrainNumber}|${a.AdvertisedTrainIdent}|${a.DepartureDateOTN}`;
      if (!runs.has(k)) runs.set(k, []);
      runs.get(k).push(a);
    }
    if (!runs.size) log(`| ${n} | – | – | – | – | – | – | inget |`);
    for (const rows of runs.values()) {
      rows.sort((a, b) => String(a.AdvertisedTimeAtLocation).localeCompare(String(b.AdvertisedTimeAtLocation)));
      const a = rows[0], z = rows[rows.length - 1];
      const hit = [String(a.OperationalTrainNumber) === n ? 'OTN' : '', String(a.AdvertisedTrainIdent) === n ? 'ATN' : ''].filter(Boolean).join('+');
      log(`| ${n} | ${a.OperationalTrainNumber ?? ''} | ${a.AdvertisedTrainIdent ?? ''} | ${a.TechnicalTrainIdent ?? ''} | ${String(a.DepartureDateOTN || '').slice(0, 10)} | ${a.LocationSignature} ${String(a.AdvertisedTimeAtLocation).slice(11, 16)} | ${z.LocationSignature} ${String(z.AdvertisedTimeAtLocation).slice(11, 16)} | ${hit} (${rows.length}) |`);
    }
  } catch (e) { log(`| ${n} | fel: ${e.message.replace(/\|/g, '/')} |`); }
}

// 2. Hela landet, avgångar ett dygn (fyra frågor om 6 h)
log('\n## Hela landet, avgångar ett dygn\n');
const all = [];
const start = new Date(now - 6 * 3600e3);
for (let i = 0; i < 4; i++) {
  const a = new Date(+start + i * 6 * 3600e3), b = new Date(+start + (i + 1) * 6 * 3600e3);
  const q = `<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="60000"><FILTER><AND>` +
    `<EQ name="ActivityType" value="Avgang" />` +
    `<GTE name="AdvertisedTimeAtLocation" value="${swedish(a)}" /><LT name="AdvertisedTimeAtLocation" value="${swedish(b)}" />` +
    `</AND></FILTER>${inc(FIELDS)}</QUERY>`;
  try { const l = await ask(q); all.push(...l); log(`- ${swedish(a).slice(0, 16)} – ${swedish(b).slice(11, 16)}: ${l.length} avgångar`); }
  catch (e) { log(`- ${swedish(a).slice(0, 16)}: fel ${e.message}`); }
}
const trains = new Map(); // otn|date → { otn, atn:Set, rows }
const byAtn = new Map();  // atn|date → Set(otn)
for (const r of all) {
  const otn = r.OperationalTrainNumber != null ? String(r.OperationalTrainNumber) : '';
  const atn = r.AdvertisedTrainIdent != null ? String(r.AdvertisedTrainIdent) : '';
  const date = String(r.DepartureDateOTN || '').slice(0, 10);
  const k = `${otn}|${date}`;
  if (!trains.has(k)) trains.set(k, { otn, date, atn: new Set(), rows: [], product: '' });
  const t = trains.get(k);
  if (atn) t.atn.add(atn);
  t.rows.push(r);
  const prod = (r.ProductInformation || []).map(p => p.Description || p).join(',');
  if (!t.product && prod) t.product = prod;
  if (atn) { const ka = `${atn}|${date}`; if (!byAtn.has(ka)) byAtn.set(ka, new Set()); byAtn.get(ka).add(otn); }
}
const list = [...trains.values()];
const withAtn = list.filter(t => t.atn.size);
const same = withAtn.filter(t => t.atn.has(t.otn));
const diff = withAtn.filter(t => !t.atn.has(t.otn));
log(`\nTåg (OTN + avgångsdatum): ${list.length}. Med ATN: ${withAtn.length}. ATN = OTN: ${same.length}. ATN ≠ OTN: ${diff.length}. Utan ATN: ${list.length - withAtn.length}.`);
const multiAtn = withAtn.filter(t => t.atn.size > 1);
log(`OTN med flera ATN samma dag: ${multiAtn.length}${multiAtn.length ? ' – ' + multiAtn.slice(0, 15).map(t => `${t.otn}: ${[...t.atn].join('/')}`).join(', ') : ''}`);
const multiOtn = [...byAtn.entries()].filter(([, s]) => s.size > 1);
log(`ATN med flera OTN samma dag: ${multiOtn.length}`);
for (const [ka, s] of multiOtn.slice(0, 25)) {
  const [atn, date] = ka.split('|');
  const parts = [...s].map(o => {
    const t = trains.get(`${o}|${date}`);
    const rows = t.rows.filter(r => String(r.AdvertisedTrainIdent) === atn).sort((a, b) => String(a.AdvertisedTimeAtLocation).localeCompare(String(b.AdvertisedTimeAtLocation)));
    return `${o} ${rows[0].LocationSignature} ${String(rows[0].AdvertisedTimeAtLocation).slice(11, 16)}–${rows[rows.length - 1].LocationSignature} ${String(rows[rows.length - 1].AdvertisedTimeAtLocation).slice(11, 16)}`;
  });
  log(`  - ATN ${atn} ${date}: ${parts.join(' · ')}`);
}
// Nummer som är OTN för ett tåg och ATN för ett annat samma dag
const otnSet = new Map(list.map(t => [`${t.otn}|${t.date}`, t]));
const clashes = [];
for (const [ka, s] of byAtn) {
  const [atn, date] = ka.split('|');
  const other = otnSet.get(`${atn}|${date}`);
  if (other && !s.has(atn)) clashes.push({ n: atn, date, atnOf: [...s], otnTrain: other });
}
log(`\nNummer som är ATN för ett tåg och OTN för ett annat tåg samma dag: ${clashes.length}`);
for (const c of clashes.slice(0, 30)) {
  const o = c.otnTrain; const r0 = o.rows.sort((a, b) => String(a.AdvertisedTimeAtLocation).localeCompare(String(b.AdvertisedTimeAtLocation)))[0];
  log(`  - ${c.n} ${c.date}: ATN för OTN ${c.atnOf.join('/')}; OTN för ett tåg med ATN ${[...o.atn].join('/') || '–'} (${o.product || 'okänd produkt'}, ${r0.LocationSignature} ${String(r0.AdvertisedTimeAtLocation).slice(11, 16)})`);
}
// Västtågen och Kinnekullebanan för sig
const vt = withAtn.filter(t => /västtåg/i.test(t.product));
log(`\nVästtågen: ${vt.length} tåg, ATN ≠ OTN: ${vt.filter(t => !t.atn.has(t.otn)).length}. Exempel: ${vt.slice(0, 20).map(t => `${t.otn}→${[...t.atn].join('/')}`).join(', ')}`);
const pattern = new Map();
for (const t of diff) {
  const a = [...t.atn][0];
  const rel = t.otn.endsWith(a) ? `OTN = prefix ${t.otn.slice(0, t.otn.length - a.length) || '∅'} + ATN` : 'annat';
  pattern.set(rel, (pattern.get(rel) || 0) + 1);
}
log(`Mönster när ATN ≠ OTN: ${[...pattern].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}: ${v}`).join(', ')}`);

// 3. Tåg som byter OTN längs vägen vid stationerna i CHAIN_SIGS (förvalt Lidköping, Håkantorp, Öxnered):
//    alla delar (OTN) av samma ATN, var numret byts, och om tåg-id:t (OperationalTransportIdentifiers TR) är detsamma.
const CHAIN_SIGS = (process.env.CHAIN_SIGS || 'Lkp,Håp,Öx').split(',').map(x => x.trim()).filter(Boolean);
log(`\n## Tåg som byter OTN längs vägen (${CHAIN_SIGS.join(', ')})\n`);
try {
  const w0 = swedish(new Date(now - 6 * 3600e3)), w1 = swedish(new Date(+now + 18 * 3600e3));
  const at = await ask(`<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="5000"><FILTER><AND>` +
    `<IN name="LocationSignature" value="${CHAIN_SIGS.join(',')}" />` +
    `<GTE name="AdvertisedTimeAtLocation" value="${w0}" /><LTE name="AdvertisedTimeAtLocation" value="${w1}" />` +
    `</AND></FILTER>${inc(FIELDS)}</QUERY>`);
  const atns = [...new Set(at.map(a => a.AdvertisedTrainIdent).filter(Boolean).map(String))];
  log(`${at.length} annonseringar vid stationerna, ${atns.length} ATN.`);
  const rows = [];
  for (let i = 0; i < atns.length; i += 60) {
    const part = atns.slice(i, i + 60);
    rows.push(...await ask(`<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="20000"><FILTER><AND>` +
      `<IN name="AdvertisedTrainIdent" value="${part.join(',')}" />` +
      `<GTE name="AdvertisedTimeAtLocation" value="${swedish(new Date(now - 12 * 3600e3))}" /><LTE name="AdvertisedTimeAtLocation" value="${swedish(new Date(+now + 30 * 3600e3))}" />` +
      `</AND></FILTER>${inc(FIELDS.concat(['OperationalTransportIdentifiers', 'ToLocation', 'FromLocation']))}</QUERY>`));
  }
  const byAtn = new Map();
  for (const r of rows) {
    const k = `${r.AdvertisedTrainIdent}|${String(r.DepartureDateOTN || '').slice(0, 10)}`;
    if (!byAtn.has(k)) byAtn.set(k, new Map());
    const m = byAtn.get(k);
    const o = String(r.OperationalTrainNumber ?? '');
    if (!m.has(o)) m.set(o, []);
    m.get(o).push(r);
  }
  let multi = 0, sameTr = 0, diffTr = 0;
  const lines = [];
  for (const [k, m] of byAtn) {
    if (m.size < 2) continue;
    multi++;
    const segs = [...m.entries()].map(([o, list]) => {
      list.sort((a, b) => String(a.AdvertisedTimeAtLocation).localeCompare(String(b.AdvertisedTimeAtLocation)));
      const tr = list.map(a => (a.OperationalTransportIdentifiers || []).find(x => x.ObjectType === 'TR')).find(Boolean);
      const first = list[0], last = list[list.length - 1];
      return { o, first, last, tr: tr ? `${tr.Company}/${tr.Core}/${tr.Variant}` : '–', n: list.length,
        acts: `${first.LocationSignature} ${first.ActivityType} ${String(first.AdvertisedTimeAtLocation).slice(11, 16)} → ${last.LocationSignature} ${last.ActivityType} ${String(last.AdvertisedTimeAtLocation).slice(11, 16)}` };
    }).sort((a, b) => String(a.first.AdvertisedTimeAtLocation).localeCompare(String(b.first.AdvertisedTimeAtLocation)));
    const trs = new Set(segs.map(s => s.tr).filter(t => t !== '–'));
    if (trs.size <= 1) sameTr++; else diffTr++;
    lines.push(`- ATN ${k}: ` + segs.map(s => `OTN ${s.o} ${s.acts} (${s.n}, TR ${s.tr})`).join(' · '));
  }
  log(`ATN med flera OTN: ${multi} (samma tåg-id TR i alla delar: ${sameTr}, olika: ${diffTr})`);
  for (const l of lines.slice(0, 40)) log(l);
  // Byten vid samma station: slutar en del med Ankomst där nästa börjar med Avgang?
} catch (e) { log(`fel: ${e.message}`); }

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n');
