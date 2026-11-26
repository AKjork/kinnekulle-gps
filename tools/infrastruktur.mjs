// Gör om Trafikverkets publika underlag om infrastrukturen till railtimer-infra.js, som appen läser.
//
//   node tools/infrastruktur.mjs <katalog> [--write railtimer-infra.js] [--check railtimer-infra.js]
//
// Katalogen ska ha filerna som tools/infrastruktur-hamta.sh hämtar (workflowet Infrastruktur-prov):
//   jnb-2a.xlsx           Järnvägsnätsbeskrivningen, bilaga 2 A: möteslängder och plattformar (hela landet)
//   jnb-2b.xlsx           Järnvägsnätsbeskrivningen, bilaga 2 B: banstandard (spårtyp per bandel, platsernas signaturer)
//   linjebok-*.pdf.txt    Underlag till linjebok, text ur PDF:en (pdftotext -layout)
//
// Ut:
//   lines     linjebokens linjer: platserna i ordning med spårtypen emellan (E enkelspår, D dubbelspår, F flerspår,
//             - inom en driftplats, där termerna inte gäller enligt linjeboken, ? blandat)
//   meet      platser med möteslängd (bilaga 2 A): där tåg kan mötas
//   platforms per plattform spåren den ligger vid (bilaga 2 A), utom plattformar som inte är tillgängliga för resande
// Rapporten (stdout) jämför linjebokens spårtyp med banstandarden och med upp- och nedspårssignalerna.
// Inga beroenden: Excel-filerna läses med zlib.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Excel (xlsx) utan beroenden ──
function unzip(buf) {
  const files = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('inte en zip-fil');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nlen + xlen + clen;
  }
  return files;
}
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const textOf = xml => unxml((xml.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''));
function readXlsx(path) {
  const z = unzip(readFileSync(path));
  const get = n => (z.get(n) || Buffer.alloc(0)).toString('utf8');
  const shared = (get('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || []).map(textOf);
  const rels = new Map();
  for (const m of get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = (m[0].match(/Id="([^"]+)"/) || [])[1], target = (m[0].match(/Target="([^"]+)"/) || [])[1];
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const sheets = new Map();
  for (const m of get('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml((m[0].match(/name="([^"]*)"/) || [])[1] || '');
    const rid = (m[0].match(/r:id="([^"]+)"/) || [])[1];
    const xml = get('xl/' + rels.get(rid));
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = (c[1].match(/r="([A-Z]+)\d+"/) || [])[1];
        const t = (c[1].match(/t="([^"]+)"/) || [])[1];
        const body = c[2] || '';
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = null;
        if (t === 's') val = v != null ? shared[+v] : null;
        else if (t === 'inlineStr') val = textOf(body);
        else if (t === 'str') val = v != null ? unxml(v) : null;
        else if (v != null) val = isNaN(+v) ? unxml(v) : +v;
        let col = 0;
        for (const ch of ref || '') col = col * 26 + ch.charCodeAt(0) - 64;
        row[col - 1] = val;
      }
      rows.push(row);
    }
    sheets.set(name.trim(), rows);
  }
  return sheets;
}
const sheet = (sheets, prefix) => { for (const [k, v] of sheets) if (k.startsWith(prefix)) return v; throw new Error(`fliken ${prefix} saknas`); };
const str = v => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const key = s => str(s).toLowerCase();

// ── Linjeboken ──
const KIND = { 'Enkelspår': 'E', 'Dubbelspår': 'D', 'Flerspår': 'F' };
// Signaler och annat som har en plats inom parentes men inte är en plats
const NOT_PLACE = /^(Hsi|Infsi|Msi|Utfsi|Ublsi|Mblsi|Lpsi|Vsi|Dvsi|Försi|Fsi|Repsi|Rep|Enl|S-tavla|Tavla|Detektor|Hatavla|ATC|Stopplykta|Slutpunktsstopplykta|Brosignal|Plan|Spärrsignal|Dvärgsignal|Signal)\b/;
/* Platserna i ordning per linje (beskrivning i en riktning, sidhuvud som "Gdö  Håp"), med spårtypen emellan.
   Rubriken för en linjedel, till exempel "(Gårdsjö) – (Håkantorp)" och "Enkelspår. System M …", sätter spårtypen.
   En driftplats rubrik ("Håkantorp" och "System H. ATC …" utan spårtyp) betyder att termerna inte gäller där.
   Mellan två platser gäller den spårtyp som linjedelarna emellan har: en enda ger den, ingen ger -, flera ger ?. */
function parseLinjebok(text, sigs, doc) {
  const lines = text.split('\n');
  const out = [];
  const headings = [];
  // lineKind: linjedelens spårtyp (rubriken), inDp: inom en driftplats (dess rubrik, till "Driftplatsgräns")
  let cur = null, pair = null, lineKind = null, inDp = false, since = new Set([null]), heading = null, page = '';
  const kind = () => (inDp ? null : lineKind);
  const start = () => {
    if (cur && cur.sigs.length > 1) out.push(cur);
    lineKind = null; inDp = false; heading = null;
    cur = { doc, pair: pair ? pair.join(' ') : '', page, sigs: [], gaps: [], heads: [] };
    since = new Set([null]);
  };
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n], t = raw.trim();
    if (/UNDERLAG TILL LINJEBOK/.test(raw)) {
      const id = (raw.match(/\b([A-L]\s?\d+)\s*$/) || raw.match(/^\s*([A-L]\s?\d+)\b/) || [])[1];
      // Bara avdelning D (linjebeskrivningen) har linjerna; i övriga avdelningar finns platser i löptext
      if (id && !/^D/.test(id)) { if (cur) { start(); cur = null; } pair = null; continue; }
      const pg = id ? id.replace(/\s/g, '') : null;
      if (pg) page = pg;
      /* Sidhuvudet med linjens ändar, till exempel "Gdö  Håp", "Uv → Hrc", "Hrc-Uvc" eller "F→N" (pilen är ett
         privat tecken ur ett symboltypsnitt, U+F0E0). Byts riktningen, eller är båda ändarna andra, börjar en ny
         beskrivning. "Uv"/"Uvc" på varannan sida är samma linje. */
      const next = (lines[n + 1] || '').replace(/[-←-⇿]/g, ' ').trim();
      const hm = pg && next.match(/^([A-ZÅÄÖ][\wåäö/]*)\s*(?:\s|-)\s*([A-ZÅÄÖ][\wåäö/]*)$/);
      if (hm) {
        const p2 = [hm[1], hm[2]];
        if (!pair || (p2[0] !== pair[0] && p2[1] !== pair[1]) || (p2[0] === pair[1] && p2[1] === pair[0])) { pair = p2; start(); }
      }
      continue;
    }
    // Första sidan i varje beskrivning
    if (/^Lutningsförhållande/.test(t)) { start(); continue; }
    if (!cur) continue;
    const km = t.match(/\b(Enkelspår|Dubbelspår|Flerspår)\b/);
    if (km) {
      lineKind = KIND[km[1]]; inDp = false;
      const title = [lines[n - 1] || '', t].map(s => s.trim()).join(' ').replace(/\s+/g, ' ');
      heading = { doc, page, title, kind: lineKind, nu: false, line: n + 1 };
      headings.push(heading);
      since.add(kind());
      continue;
    }
    // Driftplatsens rubrik: ett namn och raden "System …" utan spårtyp. Gäller till "Driftplatsgräns".
    if (/^(?:[A-ZÅÄÖ][\wåäöÅÄÖ .-]*driftplats\.\s*)?System\s+[A-Z]/.test(t)) {
      inDp = true; since.add(null);
      continue;
    }
    if (/Driftplatsgräns/.test(t)) { inDp = false; since.add(kind()); }
    // Upp- och nedspårssignaler (… N3, … U3) eller hastighet per spår: tecken på dubbelspår
    if (heading && (/\b[A-ZÅÄÖ][\wåäö]* N\s?\d+[^)]*\b[A-ZÅÄÖ][\wåäö]* U\s?\d+/.test(t) || /\b[A-ZÅÄÖ][\wåäö]* U\s?\d+[^)]*\b[A-ZÅÄÖ][\wåäö]* N\s?\d+/.test(t))) heading.nu = true;
    if (/^Vsi\b|\bVsi,/.test(t.replace(/^[0-9+=\-\s]+/, ''))) continue; // vägskyddssignal (plankorsning)
    for (const m of t.matchAll(/([A-ZÅÄÖ][\wåäöÅÄÖéü .\-]*?)\s?\(([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9]{0,5})\)/g)) {
      const name = m[1].replace(/^.*?\b(?:Växel\.|Växel)\s*/, '').trim();
      const sig = m[2];
      if (!sigs.has(sig) || NOT_PLACE.test(m[1].trim())) continue;
      const last = cur.sigs[cur.sigs.length - 1];
      // Samma plats igen (till exempel en annan riktning genom driftplatsen): sträckan hittills är inom platsen
      if (last === sig) { since = new Set([kind()]); continue; }
      if (last != null) {
        const ks = Array.from(since).filter(k => k != null);
        cur.gaps.push(ks.length === 1 ? ks[0] : (ks.length ? '?' : '-'));
        cur.heads.push(heading);
      }
      cur.sigs.push(sig);
      since = new Set([kind()]);
      void name;
    }
  }
  start();
  return { lines: out, headings };
}

export { parseLinjebok, readXlsx };

// ── Indata ──
function main() {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--')) || '.';
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const report = [];
  const say = s => { report.push(s); console.log(s); };

  const b2 = readXlsx(join(dir, 'jnb-2b.xlsx'));
  const a2 = readXlsx(join(dir, 'jnb-2a.xlsx'));
  const sigOfName = new Map(), nameOfSig = new Map();
  for (const r of sheet(b2, 'Platsdata').slice(2)) {
    if (!r || !r[0]) continue;
    sigOfName.set(key(r[1]), str(r[0]));
    nameOfSig.set(str(r[0]), str(r[1]));
  }
  const sigs = new Set(nameOfSig.keys());
  const version = (rows, re) => { for (const r of rows.slice(0, 2)) for (const c of r || []) { const m = str(c).match(re); if (m) return m[1]; } return null; };

  // Möteslängder: platser där tåg kan mötas
  const mRows = sheet(a2, '3.)');
  const meet = new Set(), meetMissing = [];
  const bandelOf = new Map(); // signatur → bandelar (ur bilaga 2 A), för jämförelsen med banstandarden
  const addBandel = (sig, b) => { if (!sig || b == null || b === '') return; if (!bandelOf.has(sig)) bandelOf.set(sig, new Set()); bandelOf.get(sig).add(String(b)); };
  for (const r of mRows.slice(2)) {
    if (!r || !r[1]) continue;
    const sig = sigOfName.get(key(r[1]));
    if (!sig) { meetMissing.push(str(r[1])); continue; }
    if (typeof r[2] === 'number' && r[2] > 0) meet.add(sig);
    addBandel(sig, str(r[0]));
  }
  // Plattformar: spåren vid varje plattform
  const pRows = sheet(a2, '4.)');
  const platforms = new Map(), platMissing = [], closed = [];
  const tracksOf = s => {
    const out = [];
    for (let t of str(s).split(/[,;]/)) {
      t = t.trim().toLowerCase();
      if (!t) continue;
      const rm = t.match(/^(\d+)-(\d+)$/);
      if (rm && +rm[2] > +rm[1] && +rm[2] - +rm[1] <= 10) { for (let k = +rm[1]; k <= +rm[2]; k++) out.push(String(k)); }
      else out.push(t);
    }
    return out;
  };
  for (const r of pRows.slice(2)) {
    if (!r || !r[1]) continue;
    const sig = sigOfName.get(key(r[1]));
    if (!sig) { platMissing.push(str(r[1])); continue; }
    addBandel(sig, str(r[0]));
    if (/ej tillgänglig|avstängd/i.test(str(r[7]))) { closed.push(`${str(r[1])} spår ${str(r[2])}: ${str(r[7])}`); continue; }
    const tr = tracksOf(r[2]).filter(t => t !== 'e'); // E = spåret på linjen (enkelspår), inget spårnummer
    if (!tr.length) continue;
    if (!platforms.has(sig)) platforms.set(sig, []);
    const list = platforms.get(sig);
    const g = Array.from(new Set(tr)).join(',');
    if (!list.includes(g)) list.push(g);
  }

  // Banstandarden: spårtyp per bandel (rader utan från/till gäller hela bandelen)
  const bRows = sheet(b2, 'Indelningsdata');
  const bandel = new Map();
  for (const r of bRows.slice(2)) {
    if (!r || r[0] == null || !str(r[6])) continue;
    const b = String(r[0]);
    if (!bandel.has(b)) bandel.set(b, { name: str(r[1]), whole: null, parts: [] });
    const k = KIND[str(r[6])] || null;
    const e = bandel.get(b);
    if (!str(r[2]) && !str(r[3])) e.whole = k; else e.parts.push({ from: str(r[2]).replace(/[()]/g, ''), to: str(r[3]).replace(/[()]/g, ''), kind: k });
  }

  // Linjeböckerna
  const docs = readdirSync(dir).filter(f => /^linjebok-.*\.txt$/.test(f)).sort();
  let allLines = [], allHeadings = [];
  for (const f of docs) {
    const r = parseLinjebok(readFileSync(join(dir, f), 'utf8'), sigs, basename(f).replace(/\.pdf\.txt$|\.txt$/, ''));
    allLines = allLines.concat(r.lines);
    allHeadings = allHeadings.concat(r.headings);
    say(`${f}: ${r.lines.length} linjebeskrivningar, ${r.headings.length} rubriker med spårtyp`);
  }

  /* Rubriker som säger Enkelspår fast linjedelen har upp- och nedspårssignaler (till exempel "Mblsi (F N3, F U3)").
     Säger banstandarden (bilaga 2 B) dubbelspår för grannparen under rubriken, och inget enkelspår, rättas de till D.
     Säger den enkelspår gäller rubriken (signalerna hör då till ett spår bredvid). Kan den inte jämföras blir
     sträckan okänd (?). Allt står i rapporten. */
  const pk = (a, b) => [a, b].sort().join('|');
  function standardKind(x, y) {
    const bx = bandelOf.get(x), by = bandelOf.get(y);
    if (!bx || !by) return null;
    const common = Array.from(bx).filter(b => by.has(b));
    if (common.length !== 1) return null;
    const k = bandelKind(common[0], x, y);
    return k ? { k, bandel: common[0] } : null;
  }
  const fixTo = new Map(), FIX = [];
  for (const h of allHeadings) {
    if (!(h.kind === 'E' && h.nu)) continue;
    const ks = [];
    for (const L of allLines) for (let i = 0; i < L.gaps.length; i++) {
      if (L.heads[i] !== h) continue;
      const s = standardKind(L.sigs[i], L.sigs[i + 1]);
      if (s) ks.push(s);
    }
    const d = ks.filter(s => s.k !== 'E'), e = ks.filter(s => s.k === 'E');
    const to = d.length && !e.length ? 'D' : (e.length ? 'E' : '?');
    fixTo.set(h, to);
    FIX.push({ h, to, why: d.length && !e.length ? `banstandarden: dubbelspår (bandel ${Array.from(new Set(d.map(s => s.bandel))).join(', ')})` : (e.length ? `banstandarden: enkelspår (bandel ${Array.from(new Set(e.map(s => s.bandel))).join(', ')}) – rubriken gäller` : 'går inte att jämföra med banstandarden – okänd') });
  }

  // Spårtyp mellan två grannplatser i linjeboken, med rättelserna
  const pairKind = new Map(), pairSeen = new Map();
  for (const L of allLines) {
    for (let i = 0; i < L.gaps.length; i++) {
      let k = L.gaps[i];
      if (L.heads[i] && fixTo.has(L.heads[i]) && k === 'E') k = fixTo.get(L.heads[i]);
      L.gaps[i] = k;
      const p = pk(L.sigs[i], L.sigs[i + 1]);
      if (!pairSeen.has(p)) pairSeen.set(p, new Set());
      pairSeen.get(p).add(k);
    }
  }
  /* Båda riktningarna ihop: en enda känd spårtyp (E, D, F) gäller. Okänd inom en driftplats (-) åt ena hållet krockar
     inte med en känd åt det andra. Olika kända, eller ? åt något håll, ger ?. */
  for (const [p, ks] of pairSeen) {
    const known = Array.from(ks).filter(k => 'EDF'.includes(k));
    pairKind.set(p, ks.has('?') || known.length > 1 ? '?' : (known.length ? known[0] : '-'));
  }

  // Jämförelse med banstandarden: grannplatser som båda hör till samma bandel enligt bilaga 2 A
  function bandelKind(b, x, y) {
    const e = bandel.get(b);
    if (!e) return null;
    const parts = e.parts.filter(q => (q.from === x && q.to === y) || (q.from === y && q.to === x));
    if (parts.length) return parts[0].kind;
    if (e.parts.length && e.parts.some(q => q.kind !== e.whole)) {
      // Bandelen har delar med annan spårtyp: bara jämförbar när ingen del rör platserna
      if (e.parts.some(q => [q.from, q.to].includes(x) || [q.from, q.to].includes(y))) return null;
      if (e.whole == null) return null;
    }
    return e.whole;
  }
  let agree = 0;
  const disagree = [];
  for (const [p, k] of pairKind) {
    if (!'EDF'.includes(k)) continue;
    const [x, y] = p.split('|');
    const bx = bandelOf.get(x), by = bandelOf.get(y);
    if (!bx || !by) continue;
    const common = Array.from(bx).filter(b => by.has(b));
    if (common.length !== 1) continue;
    const bk = bandelKind(common[0], x, y);
    if (!bk) continue;
    const same = (bk === 'E') === (k === 'E');
    if (same) agree++; else disagree.push(`${nameOfSig.get(x)} (${x}) – ${nameOfSig.get(y)} (${y}): linjeboken ${k}, banstandarden bandel ${common[0]} ${bk}`);
  }

  // Linjerna kompakt: "Gdö E Hova E Tvd …", en riktning per linje (den andra är samma baklänges)
  const seen = new Set(), outLines = [];
  for (const L of allLines) {
    const toks = [];
    for (let i = 0; i < L.sigs.length; i++) { toks.push(L.sigs[i]); if (i < L.gaps.length) toks.push(pairKind.get(pk(L.sigs[i], L.sigs[i + 1]))); }
    const s = toks.join(' '), rev = toks.slice().reverse().join(' ');
    if (seen.has(s) || seen.has(rev)) continue;
    seen.add(s);
    outLines.push(s);
  }

  say(`Linjer: ${outLines.length}, grannpar: ${pairKind.size} (${['E', 'D', 'F', '-', '?'].map(k => `${k} ${Array.from(pairKind.values()).filter(v => v === k).length}`).join(', ')})`);
  say(`Mötesplatser: ${meet.size}${meetMissing.length ? `, utan signatur: ${meetMissing.join(', ')}` : ''}`);
  say(`Plattformar: ${platforms.size} platser${platMissing.length ? `, utan signatur: ${Array.from(new Set(platMissing)).join(', ')}` : ''}`);
  say(`Inte tillgängliga för resande (tas inte med): ${closed.length}`);
  for (const c of closed) say(`  - ${c}`);
  say(`Rubriker med Enkelspår men upp- och nedspårssignaler: ${FIX.length}`);
  for (const f of FIX) say(`  - ${f.h.doc} ${f.h.page}: ${f.h.title} → ${f.to} (${f.why})`);
  say(`Mot banstandarden (bilaga 2 B): ${agree} grannpar lika, ${disagree.length} olika`);
  for (const d of disagree) say(`  - ${d}`);

  const sourcesNote = {
    linjebok: docs.map(f => f.replace(/\.pdf\.txt$/, '')),
    jnb2a: { moteslangder: version(mRows, /daterad\s+(\d{4}-\d{2}-\d{2})/), plattformar: version(pRows, /daterad\s+(\d{4}-\d{2}-\d{2})/) }
  };
  const data = {
    sources: [
      'Trafikverket, Underlag till linjebok: TC Göteborg samlad version 2026-11-01 och TC Hallsberg samlad version 2026-09-01 (spårtyp mellan platserna)',
      `Trafikverket, Järnvägsnätsbeskrivning 2027 bilaga 2 A (2026-11-19): möteslängder (rapport ${sourcesNote.jnb2a.moteslangder}) och plattformar (rapport ${sourcesNote.jnb2a.plattformar})`,
      'Trafikverket, Järnvägsnätsbeskrivning 2027 bilaga 2 B Banstandard (2026-09-24): signaturer och kontroll av spårtypen'
    ],
    lines: outLines,
    meet: Array.from(meet).sort().join(' '),
    platforms: Object.fromEntries(Array.from(platforms).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([s, l]) => [s, l.join('|')]))
  };
  const js = `/* RailTimer – Trafikverkets uppgifter om infrastrukturen. Genererad av tools/infrastruktur.mjs, ändra inte för hand.
   lines: linjebokens linjer, platsernas signaturer i ordning med spårtypen emellan: E enkelspår, D dubbelspår,
          F flerspår, - inom en driftplats (termerna gäller inte där), ? blandat.
   meet: platser med möteslängd, där tåg kan mötas (mellanslag emellan).
   platforms: per signatur plattformarna (|) med spåren vid varje plattform (,). */
(function (root, data) {
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.RailTimerInfra = data;
})(typeof self !== 'undefined' ? self : this, ${JSON.stringify(data, null, 1).replace(/\n\s*/g, ' ')});
`;
  const w = opt('--write');
  if (w) { writeFileSync(w, js); say(`Skrev ${w} (${js.length} tecken)`); }
  const c = opt('--check');
  if (c) {
    const old = existsSync(c) ? readFileSync(c, 'utf8') : '';
    say(old === js ? `${c} är aktuell.` : `${c} skiljer sig från underlagen: kör med --write och granska ändringen.`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + report.join('\n') + '\n```\n', { flag: 'a' });

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
