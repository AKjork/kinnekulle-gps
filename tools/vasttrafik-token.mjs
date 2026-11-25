/* RailTimer – gemensam Västtrafik-token för alla som använder appen (körs i GitHub Actions).

   Nyckeln och hemligheten (Klientidentifierare och Hemlighet från Västtrafiks utvecklarportal) ligger som
   hemligheter i GitHub (VT_KEY, VT_SECRET i kinnekulle-gps → Settings → Secrets and variables → Actions) och
   finns aldrig i koden. Det här skriptet hämtar ett token (gäller ett dygn) och skriver det till vt-token.json,
   som GitHub Pages lägger ut bredvid appen. Appen läser filen själv, så ingen behöver fylla i något.

   Ett token ger bara tillgång till Västtrafiks öppna trafikdata och slutar gälla efter ett dygn.
   Nytt token när det gamla har mindre än 12 h kvar (workflowet körs var 3:e timme), eller med FORCE=1.

   Varje gång ett nytt token hämtas provas också det appen gör: om Västtrafik tillåter frågorna från
   webbläsaren (CORS, från https://akjork.github.io) och att appens frågor (railtimer-vt.js) får svar.
   Resultatet står i vt-token.json (cors, check) och i körningens sammanfattning. Token skrivs aldrig i loggen.

   node tools/vasttrafik-token.mjs              (i GitHub Actions)
   Testas med node --test (tests/vasttrafik-token.test.js). */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const VT = require('../railtimer-vt.js');

export const ORIGIN = 'https://akjork.github.io';
export const RENEW_BELOW_MS = 12 * 3600000;
// Lidköpings station (Trafikverkets koordinat): appens frågor provas där
export const PROBE = { name: 'Lidköping', lat: 58.50462, lon: 13.1639339 };

export function needsRenewal(existing, now) {
  return !existing || !existing.token || !(Number(existing.expiresAt) - now > RENEW_BELOW_MS);
}

async function preflight(fetch, url, method, headers) {
  try {
    const r = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers }
    });
    return {
      status: r.status,
      allowOrigin: r.headers.get('access-control-allow-origin'),
      allowMethods: r.headers.get('access-control-allow-methods'),
      allowHeaders: r.headers.get('access-control-allow-headers')
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}
// Tillåter svaret en fråga från appens adress med de här rubrikerna?
export function corsAllows(p, header) {
  if (!p || p.error || !(p.status >= 200 && p.status < 300)) return false;
  if (!(p.allowOrigin === '*' || p.allowOrigin === ORIGIN)) return false;
  if (!header) return true;
  const h = String(p.allowHeaders || '').toLowerCase().split(/\s*,\s*/);
  return h.includes('*') || h.includes(header.toLowerCase());
}

/* Ger { file, log, exitCode }. file är innehållet i vt-token.json, eller null när inget behöver skrivas. */
export async function run({ fetch, env, now, existing, force }) {
  const log = [];
  if (!force && !needsRenewal(existing, now)) {
    log.push(`Token gäller till ${new Date(existing.expiresAt).toISOString()} – inget att göra.`);
    return { file: null, log, exitCode: 0 };
  }
  const cors = {
    token: await preflight(fetch, VT.TOKEN_URL, 'POST', 'authorization,content-type'),
    api: await preflight(fetch, VT.API + VT.nearbyPath(PROBE.lat, PROBE.lon, 350), 'GET', 'authorization')
  };
  cors.tokenFromBrowser = corsAllows(cors.token, 'authorization');
  cors.apiFromBrowser = corsAllows(cors.api, 'authorization');
  const file = { token: null, expiresAt: null, fetchedAt: new Date(now).toISOString(), cors };

  if (!env.VT_KEY || !env.VT_SECRET) {
    // Utan hemligheterna skrivs filen bara vid en körning för hand eller ny kod, inte var 3:e timme
    if (!force && existing && existing.error) return { file: null, log: ['VT_KEY och VT_SECRET saknas fortfarande.'], exitCode: 0 };
    file.error = 'VT_KEY och VT_SECRET saknas i GitHub';
    log.push('::warning::VT_KEY och VT_SECRET saknas: lägg in dem i kinnekulle-gps → Settings → Secrets and variables → Actions.');
    return { file, log, exitCode: 0 };
  }

  // Unikt scope: Västtrafik ger då ett nytt token med full giltighetstid i stället för det som redan finns
  const req = VT.tokenRequest(env.VT_KEY, env.VT_SECRET, `railtimer${now}`);
  let resp;
  try { resp = await fetch(req.url, req.init); } catch (e) { resp = null; }
  if (!resp || !resp.ok) {
    file.error = resp ? (resp.status === 400 || resp.status === 401 ? 'Västtrafik godtog inte VT_KEY och VT_SECRET' : `token: HTTP ${resp.status}`) : 'Västtrafik svarar inte';
    log.push(`::error::${file.error}`);
    // Ett gammalt token som fortfarande gäller får vara kvar
    if (existing && existing.token && Number(existing.expiresAt) > now) return { file: null, log, exitCode: 1 };
    return { file, log, exitCode: 1 };
  }
  let json = null;
  try { json = await resp.json(); } catch (e) { json = null; }
  const t = VT.parseToken(json, now);
  if (!t) {
    file.error = 'inget token i svaret';
    log.push(`::error::${file.error}`);
    return { file, log, exitCode: 1 };
  }
  file.token = t.token;
  file.expiresAt = t.expiresAt;

  // Appens frågor med det nya token, från appens adress
  const headers = { Authorization: 'Bearer ' + t.token, Accept: 'application/json', Origin: ORIGIN };
  const check = { station: PROBE.name };
  try {
    const r = await fetch(VT.API + VT.nearbyPath(PROBE.lat, PROBE.lon, 350), { headers });
    check.locations = { status: r.status, allowOrigin: r.headers.get('access-control-allow-origin') };
    if (r.ok) {
      const areas = VT.parseStopAreas(await r.json(), 350, PROBE);
      check.stopAreas = areas.map(a => `${a.name} (${a.dist} m)`);
      if (areas.length) {
        const d = await fetch(VT.API + VT.boardPath('departures', areas[0].gid, now, 60), { headers });
        check.departures = { status: d.status };
        if (d.ok) {
          const calls = VT.parseBoard(await d.json());
          check.departures.count = calls.length;
          check.departures.buses = VT.busesOnly(calls).length;
          check.departures.withEstimate = calls.filter(c => c.est != null).length;
        }
      }
    }
  } catch (e) {
    check.error = String((e && e.message) || e);
  }
  file.check = check;
  log.push(`Nytt token till ${new Date(t.expiresAt).toISOString()}.`);
  return { file, log, exitCode: 0 };
}

// Körs som skript i GitHub Actions
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vt-token.json');
  let existing = null;
  try { existing = JSON.parse(readFileSync(out, 'utf8')); } catch (e) { existing = null; }
  const res = await run({ fetch: globalThis.fetch, env: process.env, now: Date.now(), existing, force: process.env.FORCE === '1' });
  if (res.file) writeFileSync(out, JSON.stringify(res.file, null, 1) + '\n');
  for (const line of res.log) console.log(line);
  // Sammanfattningen visar allt utom token
  const shown = res.file ? Object.assign({}, res.file, { token: res.file.token ? '(nytt token)' : null }) : null;
  if (shown) console.log(JSON.stringify(shown, null, 1));
  if (process.env.GITHUB_STEP_SUMMARY && shown) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Västtrafik-token\n\n```json\n' + JSON.stringify(shown, null, 1) + '\n```\n');
  }
  process.exitCode = res.exitCode;
}
