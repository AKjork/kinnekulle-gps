# Uppladdning, GPS-spår och avbrottshantering – genomförandeplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Varje resa i RailTimer laddas upp automatiskt till ett privat GitHub-repo tillsammans med GPS-spåret. Avbrott i mätningen (till exempel samtal) ger aldrig felaktiga tider. Analysverktyget hämtar mätningarna direkt från repot.

**Architecture:** Två fristående moduler utan beroenden:
- `railtimer-avbrott.js`: rena funktioner för att upptäcka avbrott och komma ikapp.
- `railtimer-github.js`: GitHub-klient, uppladdningskö och hämtning.

`index.html` och `Analys.html` laddar modulerna med `<script>` och kopplar in dem. Logiken för ankomst och avgång vid vanlig körning ändras inte. Det säkras med ett regressionsfacit som tas fram från dagens kod innan något ändras.

**Tech Stack:**
- Vanilla JS i en HTML-fil (befintligt mönster).
- IndexedDB för spår och analyscache.
- GitHub REST API (contents, git/trees, git/blobs) med fine-grained token.
- Tester:
  - Node 22+ inbyggda testkörare (`node --test`) för modulerna.
  - Chrome utan fönster, styrt via CDP från ett Node-skript utan beroenden, för uppspelade resor.

**Spec:** `docs/superpowers/specs/2026-10-15-uppladdning-design.md`

## Global Constraints

- **Logiken för ankomst och avgång vid vanlig körning får inte ändras.** Regressionstestet mot `tests/golden-normal-run.json` ska gå igenom efter varje uppgift.
- **Avbrott:** mer än `20000` ms mellan två positioner **och** minst `150` m förflyttning. En tid `T` i `from < T ≤ to + 2000 ms` sparas som `null` med fönster `{from, to}` (ISO) och källan `'avbrott'`.
- **Import:** högst `200` körningar per fil.
- **Skrivningar till GitHub:** en i taget, med minst `1000` ms mellanrum.
- **Lagringsnycklar:**
  - `railtimer_github_v1`: `{repo, token, branch}`.
  - `railtimer_upload_v1`: `{repo, uploadedIds, uploadedTrackCount, backlogDone, lastError, lastSuccessAt, retryNotBefore}`.
  - IndexedDB `railtimer`, lager `tracks` (keyPath `runId`).
  - Analysens IndexedDB `railtimer-analys`, lager `blobs` (keyPath `sha`).
- **Repo:** standard `AKjork/railtimer-data`, gren `main`.
- **Sökvägar:** `korningar/ÅÅÅÅ/<datum>_<tåg>_<id>.json`, `gps-spar/ÅÅÅÅ/<samma namn>`, `import/<ÅÅÅÅ-MM-DDTHHMM>_befintliga-<n>.json` och `.railtimer/anslutning.json`.
- **Uppladdningskön körs aldrig medan en resa pågår.**
- **Token** skrivs aldrig ut, loggas aldrig och hamnar aldrig i kod, tester eller repo.
- **Inga npm-beroenden.** Tester körs med:
  - `node --test "tests/*.test.js"`
  - `node tests/run-browser-tests.mjs`. Chrome ska finnas på `C:/Program Files/Google/Chrome/Application/chrome.exe`; ange annars `CHROME_PATH`.
- **`Kinnekulle GPS.html` ska vara identisk med `index.html`** efter varje uppgift som ändrar `index.html`: kör `cp index.html "Kinnekulle GPS.html"`.
- **All text i gränssnittet är på svenska**, med å, ä och ö.
- **Var arbetet sker:** i `C:\Users\andre\kinnekulle-gps-ux-wt` på grenen `feat/uppladdning`. Ingen push i uppgift 1–9. Publicering sker bara i uppgift 10, med Andrés uttryckliga OK.
- **Commit-meddelanden** avslutas med raden `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **En token som klistras in med mellanslag eller radbrytning** ska fungera, eftersom den rensas. Test i uppgift 7.
2. **Ett samtal precis vid ankomsten till slutstationen.** Ankomsten sparas som saknad, och resan avslutas och sparas ändå. Test i uppgift 4.
3. **"Avbryt resa".** Körningen laddas ändå upp, med `aborted: true`. Test i uppgift 7.
4. **En resa som avslutas innan någon GPS-position har kommit** ska inte få spår eller `trackPath`, och inget fel ska uppstå. Test i uppgift 6.
5. **Byte till ett annat repo** gör att allt laddas upp igen dit, utan att något hoppas över. Test i uppgift 5.

---

## Filer

| Fil | Ansvar |
|---|---|
| `railtimer-avbrott.js` (ny) | Upptäcka avbrott, komma ikapp och ersätta tider inom avbrott. Rena funktioner. |
| `railtimer-github.js` (ny) | GitHub-klient, sökvägar, base64, uppladdningskö, sammanslagning och hämtning till analysen. |
| `index.html` | Testläge, resans id, format 2, avbrott, GPS-spår (IndexedDB), uppladdningskö och inställningsvy. |
| `Kinnekulle GPS.html` | Identisk kopia av `index.html`. |
| `Analys.html` | Datakällan "Hämta från GitHub" med cache per fil. |
| `sw.js` | De nya modulerna läggs till i `ASSETS`. |
| `tests/railtimer-avbrott.test.js` (ny) | Node-tester för avbrottsmodulen. |
| `tests/railtimer-github.test.js` (ny) | Node-tester för GitHub-modulen. |
| `tests/fake-github.js` (ny) | Simulerat GitHub-API för Node-testerna. |
| `tests/replay.html` (ny) | Testrigg som spelar upp resor i appen (`?test=1`) med styrd klocka. |
| `tests/run-browser-tests.mjs` (ny) | Kör `replay.html` i Chrome utan fönster: tester, facit och bilder. |
| `tests/golden-normal-run.json` (ny, genereras) | Regressionsfacit för en vanlig resa, framtaget med dagens logik. |
| `.gitignore` (ny) | Undantar `tests/screenshots/`. |
| `CLAUDE.md` | Dokumentation av ändringarna. |

---

### Task 1: Testläge, testrigg och regressionsfacit

Appen får ett testläge (`?test=1`) där den varken startar GPS, service worker, skärmlås eller hämtningar. Testriggen kan då mata in simulerade positioner. Initieringen av en resa bryts ut till två funktioner, som en ren flytt utan ändrad logik. Därefter tas facit fram med dagens logik.

**Files:**
- Modify: `index.html` (konstanter, `init`, `requestGpsWatch`, `startJourney`, `enableWakeLockForJourney`)
- Create: `tests/run-browser-tests.mjs`, `tests/replay.html`, `tests/golden-normal-run.json` (genereras)
- Modify: `Kinnekulle GPS.html` (kopia)

**Interfaces:**
- Produces:
  - `TEST_MODE: boolean`
  - `makeRouteStation(st, idx) → stationsobjekt`
  - `initJourneyState(route, {trainNumber, vehicleType, notes})`
  - `window.__railtimer = { state, makeRouteStation, initJourneyState, handlePosition, stopJourney, loadLogs, loadActiveJourney, resumeJourney, showView, renderRouteCards }`, bara i testläge
  - I testriggen: `buildJourney(dwellMs)`, `runJourney(fixes, {drop, reloadBefore, beforeStart})`, `twoStationCall` (läggs till i Task 4), `test(name, fn)`, `assertEqual` och `assert`

- [ ] **Step 1: Lägg till testlägeskonstanten i `index.html`**

Ersätt:
```js
  const DEPART_REVERT_WINDOW_MS = 120000; // allow 2 min to re-time a premature departure
  const STORAGE_KEY_LOGS = 'kmon_gps_logs_v1';
```
med:
```js
  const DEPART_REVERT_WINDOW_MS = 120000; // allow 2 min to re-time a premature departure
  // ?test=1 används av tests/replay.html: ingen nätverkstrafik, GPS, service worker eller skärmlås
  const TEST_MODE = new URLSearchParams(location.search).has('test');
  const STORAGE_KEY_LOGS = 'kmon_gps_logs_v1';
```

- [ ] **Step 2: Testläge i `init` och testkrokar**

Ersätt:
```js
  async function init(){
    updateLogCount();
    bindEvents();
    setupPWA();
    updateWakeButton();
    setupOnlineStatus();
    setupStationSearch();
    applyStoredSettings();
    hideUnsupportedFileActions();
    trackHeaderHeight();
    await loadAllStations();
    getUserLocation();
    checkForInterruptedJourney();
  }
```
med:
```js
  async function init(){
    updateLogCount();
    bindEvents();
    if(!TEST_MODE) setupPWA();
    updateWakeButton();
    setupOnlineStatus();
    setupStationSearch();
    applyStoredSettings();
    hideUnsupportedFileActions();
    trackHeaderHeight();
    if(TEST_MODE){
      exposeTestHooks();
      return;
    }
    await loadAllStations();
    getUserLocation();
    checkForInterruptedJourney();
  }

  // Bara i testläge: tests/replay.html spelar upp resor genom de här funktionerna
  function exposeTestHooks(){
    window.__railtimer = {
      state, makeRouteStation, initJourneyState, handlePosition, stopJourney,
      loadLogs, loadActiveJourney, resumeJourney, showView, renderRouteCards
    };
  }
```

- [ ] **Step 3: Ingen GPS och inget skärmlås i testläge**

Ersätt:
```js
  function requestGpsWatch(){
    if(!navigator.geolocation){
```
med:
```js
  function requestGpsWatch(){
    if(TEST_MODE) return; // testerna matar positioner direkt till handlePosition
    if(!navigator.geolocation){
```
Ersätt:
```js
    if(keepScreenAwake || !('wakeLock' in navigator)) return;
```
med:
```js
    if(TEST_MODE || keepScreenAwake || !('wakeLock' in navigator)) return;
```

- [ ] **Step 4: Bryt ut initieringen av resan. Det är en ren flytt utan ändrad logik.**

Ersätt (början av `startJourney`):
```js
      showHeaderStatus('En resa pågår redan – avsluta den först.', true);
      return;
    }
    speedHistory.length=0; // nollställer tidigare hastighetsposter inför ny resa
    state.awaitingDepartureIndex=null;
    state.departureProvisionalIdx=null;
    state.lastSpeed=null;
    state.lastSpeedTime=null;

    // Validate selection
```
med:
```js
      showHeaderStatus('En resa pågår redan – avsluta den först.', true);
      return;
    }

    // Validate selection
```
Ersätt:
```js
    const route = slice.map((st, idx) => ({
      name:st.name,
      sig:st.sig||'',
      lat:st.lat,
      lon:st.lon,
      radius:isFinite(st.radius)?st.radius:DEFAULT_RADIUS,
      customRadius:!!st.customRadius,
      actualArrival:null,
      actualDeparture:null,
      scheduledArrival:st.scheduledArrival||null,
      scheduledDeparture:st.scheduledDeparture||null,
      arrivalSource:'',
      departSource:'',
      arrivalPosition:null,
      departurePosition:null,
      shouldStop:true,
      excludeInboundRun:false,
      inZone:false,
      lastSeenDistance:null,
      passThrough:false,
      needsArrivalRetiming:false,
      reachedLowSpeed:false,
      closestDistance:null,
      closestTime:null,
      closestPosition:null,
      departureProvisional:false,
      departureProvisionalAt:null,
      order:idx+1
    }));
    state.route=route;
    state.running=true;
    state.trainNumber=trainNumber;
    state.vehicleType=vehicleType;
    state.notes=(document.getElementById('startNotes').value||'').trim();
    state.startedAt=new Date();
    state.lastReachedIndex=0;
    state.nextIndex=route.length>1?1:null;
    state.autoReason='';
    state.aborted=false;
    hideSetupError();
```
med:
```js
    const route = slice.map(makeRouteStation);
    initJourneyState(route, {
      trainNumber,
      vehicleType,
      notes: (document.getElementById('startNotes').value||'').trim()
    });
    hideSetupError();
```
Ersätt:
```js
  function buildRouteFromTimetable(timetableResult, startSig, endSig){
```
med:
```js
  // En station i resans rutt, i det format logiken för ankomst/avgång förväntar sig
  function makeRouteStation(st, idx){
    return {
      name:st.name,
      sig:st.sig||'',
      lat:st.lat,
      lon:st.lon,
      radius:isFinite(st.radius)?st.radius:DEFAULT_RADIUS,
      customRadius:!!st.customRadius,
      actualArrival:null,
      actualDeparture:null,
      scheduledArrival:st.scheduledArrival||null,
      scheduledDeparture:st.scheduledDeparture||null,
      arrivalSource:'',
      departSource:'',
      arrivalPosition:null,
      departurePosition:null,
      shouldStop:true,
      excludeInboundRun:false,
      inZone:false,
      lastSeenDistance:null,
      passThrough:false,
      needsArrivalRetiming:false,
      reachedLowSpeed:false,
      closestDistance:null,
      closestTime:null,
      closestPosition:null,
      departureProvisional:false,
      departureProvisionalAt:null,
      order:idx+1
    };
  }

  // Nollställer och startar en ny resa. Används av startJourney och av testerna.
  function initJourneyState(route, meta){
    speedHistory.length=0; // nollställer tidigare hastighetsposter inför ny resa
    state.awaitingDepartureIndex=null;
    state.departureProvisionalIdx=null;
    state.lastSpeed=null;
    state.lastSpeedTime=null;
    state.route=route;
    state.running=true;
    state.trainNumber=meta.trainNumber||'';
    state.vehicleType=meta.vehicleType||'';
    state.notes=meta.notes||'';
    state.startedAt=new Date();
    state.lastReachedIndex=0;
    state.nextIndex=route.length>1?1:null;
    state.autoReason='';
    state.aborted=false;
  }

  function buildRouteFromTimetable(timetableResult, startSig, endSig){
```
Kontrollera med `git diff index.html` att de borttagna raderna i `startJourney` och de nya i `makeRouteStation`/`initJourneyState` är samma tilldelningar. Enda skillnaden ska vara att `meta.*||''` används i stället för de lokala variablerna.

- [ ] **Step 5: Skapa `tests/run-browser-tests.mjs`**

```js
// Kör tests/replay.html i Chrome utan fönster och skriver ut resultatet.
//   node tests/run-browser-tests.mjs            kör alla uppspelade tester
//   node tests/run-browser-tests.mjs avbrott    kör bara tester vars namn innehåller "avbrott"
//   node tests/run-browser-tests.mjs --golden   sparar facit för en vanlig resa i tests/golden-normal-run.json
//   node tests/run-browser-tests.mjs --shot=installningar   sparar en bild i telefonstorlek i tests/screenshots/
//                                                          (även --shot=avbrott och --shot=rapport)
// Kräver Node 22+ (inbyggd WebSocket och fetch) och Chrome. Annan Chrome-sökväg: CHROME_PATH=...
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const GOLDEN = args.includes('--golden');
const SHOT = (args.find(a => a.startsWith('--shot=')) || '').slice('--shot='.length);
const FILTER = args.find(a => !a.startsWith('--')) || '';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'railtimer-test-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1200,1300', 'about:blank'
], { stdio: 'ignore' });

let exitCode = 1;
try {
  const ws = await connect(profile);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params) => new Promise(resolve => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/tests/replay.html` });
  for (let i = 0; i < 100; i++) {
    const r = await send('Runtime.evaluate', { expression: 'typeof window.runTests === "function"', returnByValue: true });
    if (r.result && r.result.result && r.result.result.value === true) break;
    await new Promise(r2 => setTimeout(r2, 100));
  }

  const expression = SHOT ? `window.prepareShot(${JSON.stringify(SHOT)})`
    : GOLDEN ? 'window.captureGolden()' : `window.runTests(${JSON.stringify(FILTER)})`;
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 300000 });
  if (res.result && res.result.exceptionDetails) {
    console.error('Fel i testsidan:', res.result.exceptionDetails.exception && res.result.exceptionDetails.exception.description);
  } else if (SHOT) {
    const clip = Object.assign({ scale: 1 }, res.result.result.value);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    const dir = path.join(ROOT, 'tests', 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${SHOT}.png`);
    fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    console.log(`Bild sparad: ${file}`);
    exitCode = 0;
  } else if (GOLDEN) {
    const golden = res.result.result.value;
    fs.writeFileSync(path.join(ROOT, 'tests', 'golden-normal-run.json'), JSON.stringify(golden, null, 1) + '\n');
    console.log(`Facit sparat: tests/golden-normal-run.json (${golden.length} stationer)`);
    exitCode = 0;
  } else {
    const out = res.result.result.value;
    for (const t of out.results) console.log(`${t.ok ? '✔' : '✖'} ${t.name}${t.ok ? '' : '\n    ' + t.error}`);
    console.log(`\n${out.passed} lyckades, ${out.failed} misslyckades`);
    exitCode = out.failed === 0 && out.passed > 0 ? 0 : 1;
  }
  ws.close();
} catch (err) {
  console.error(err);
} finally {
  chrome.kill();
  server.close();
  setTimeout(() => {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Chrome kan hålla filer kvar en stund */ }
    process.exit(exitCode);
  }, 500);
}

async function connect(profileDir) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!fs.existsSync(portFile)) continue;
    const devPort = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    try {
      const list = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (!page) continue;
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      return ws;
    } catch (e) { /* Chrome inte redo än */ }
  }
  throw new Error(`Chrome startade inte (${CHROME})`);
}
```

- [ ] **Step 6: Skapa `tests/replay.html`, med riggen och testerna för uppgift 1**

Senare uppgifter lägger till test **före** raden `// ── Körning ──`.

```html
<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<title>RailTimer – uppspelade resor</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 1rem; }
  iframe { width: 390px; height: 844px; border: 1px solid #888; }
</style>
</head>
<body>
<h1>RailTimer – uppspelade resor</h1>
<p>Körs med <code>node tests/run-browser-tests.mjs</code>. Appen laddas i testläge (<code>?test=1</code>) och får simulerade GPS-positioner.</p>
<iframe id="app"></iframe>
<script>
'use strict';

// Kinnekullebanan Lidköping → Hällekis: namn, latitud, longitud, signatur
const STATIONS = [
  ['Lidköping', 58.50462, 13.1639339, 'Lkp'],
  ['Filsbäck', 58.4931843, 13.2469536, 'Fiä'],
  ['Källby', 58.5107931, 13.3023402, 'Kll'],
  ['Blomberg', 58.5402058, 13.3206466, 'Bmb'],
  ['Råbäck', 58.6105061, 13.376454, 'Rbk'],
  ['Hällekis', 58.6302156, 13.432943, 'Hlk']
];
const START = Date.UTC(2026, 9, 15, 5, 0, 0);
const STEP_MS = 2000;
const realSleep = ms => new Promise(r => setTimeout(r, ms));

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* GPS-positioner var 2:a sekund för en hel resa. Tåget står vid start, accelererar till 20 m/s,
   bromsar in de sista 400 m och står 40 s vid varje station (dwellMs: avvikande uppehåll per stationsindex).
   Varje position: { t, lat, lon, speed, leg, frac, dwellAt } där leg i går från station i till i+1. */
function buildJourney(dwellMs) {
  const dwell = Object.assign({}, dwellMs);
  const fixes = [];
  let t = START;
  const push = (lat, lon, speed, info) => { fixes.push(Object.assign({ t, lat, lon, speed }, info)); t += STEP_MS; };
  for (let i = 0; i < 3; i++) push(STATIONS[0][1], STATIONS[0][2], 0, { leg: -1, frac: 0, dwellAt: 0 });
  for (let leg = 0; leg < STATIONS.length - 1; leg++) {
    const A = STATIONS[leg], B = STATIONS[leg + 1];
    const L = haversine(A[1], A[2], B[1], B[2]);
    for (let s = 0; s < L; ) {
      const v = s < 200 ? 3 + 12 * s / 200 : (s < L - 400 ? 20 : Math.max(1.5, 20 * (L - s) / 400));
      const f = s / L;
      push(A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f, v, { leg, frac: f, dwellAt: null });
      s += v * STEP_MS / 1000;
    }
    const isLast = leg + 1 === STATIONS.length - 1;
    const ms = isLast ? 10000 : (dwell[leg + 1] != null ? dwell[leg + 1] : 40000);
    for (let k = 0; k < ms / STEP_MS; k++) push(B[1], B[2], 0, { leg, frac: 1, dwellAt: leg + 1 });
  }
  return fixes;
}

async function loadApp() {
  const frame = document.getElementById('app');
  await new Promise(resolve => { frame.onload = resolve; frame.src = '../index.html?test=1&n=' + Date.now(); });
  const w = frame.contentWindow;
  for (let i = 0; i < 100 && !w.__railtimer; i++) await realSleep(20);
  if (!w.__railtimer) throw new Error('Appen startade inte i testläge');
  return w;
}

// Appen använder new Date() och Date.now(); i testerna styr vi klockan
function installClock(w, startMs) {
  const RealDate = w.Date;
  let now = startMs;
  class TestDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(now); }
    static now() { return now; }
  }
  w.Date = TestDate;
  return { set(t) { now = t; } };
}

async function clearAppStorage(w) {
  w.localStorage.clear();
  await new Promise(resolve => {
    const req = w.indexedDB.deleteDatabase('railtimer');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/* Spelar upp en resa. opts.drop(fix) → true tar bort positionen (avbrott).
   opts.reloadBefore: sidan laddas om (och resan återupptas) innan första position med t ≥ reloadBefore.
   opts.beforeStart(w): körs innan resan startar, t.ex. för att ställa in uppladdning. */
async function runJourney(fixes, opts) {
  const o = opts || {};
  let w = await loadApp();
  await clearAppStorage(w);
  if (o.beforeStart) await o.beforeStart(w);
  let clock = installClock(w, fixes[0].t - STEP_MS);
  let rt = w.__railtimer;
  const route = STATIONS.map((s, i) => rt.makeRouteStation({ name: s[0], lat: s[1], lon: s[2], sig: s[3], radius: 200 }, i));
  rt.initJourneyState(route, { trainNumber: 'TEST', vehicleType: 'Y31', notes: '' });
  rt.showView('journey');
  rt.renderRouteCards();
  const fed = [];
  let reloaded = false;
  for (const f of fixes) {
    if (o.drop && o.drop(f)) continue;
    if (o.reloadBefore && !reloaded && f.t >= o.reloadBefore) {
      reloaded = true;
      // Samtalet kommer: appen går till bakgrunden (spåret sparas, Task 6) och sidan laddas sedan om
      if (rt.onAppHidden) await rt.onAppHidden();
      const saved = rt.loadActiveJourney();
      w = await loadApp();
      clock = installClock(w, f.t);
      rt = w.__railtimer;
      await rt.resumeJourney(saved);
    }
    clock.set(f.t);
    rt.handlePosition({ coords: { latitude: f.lat, longitude: f.lon, accuracy: 5, speed: f.speed, heading: null }, timestamp: f.t });
    fed.push(f);
    await realSleep(0); // som i verkligheten: webbläsaren hinner arbeta (t.ex. spara i IndexedDB) mellan positionerna
    if (!rt.state.running) break;
  }
  await realSleep(150);
  const logs = rt.loadLogs();
  return { w, rt, log: logs[logs.length - 1], fed };
}

const pick = s => ({ name: s.name, actualArrival: s.actualArrival, actualDeparture: s.actualDeparture, arrivalSource: s.arrivalSource, departSource: s.departSource });
const summarize = log => log.stops.map(pick);
const stopOf = (log, name) => log.stops.find(s => s.name === name);
const iso = t => new Date(t).toISOString();

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: fick ${a}, väntade ${e}`);
}
function assert(cond, label) {
  if (!cond) throw new Error(label);
}
function sameAsControl(log, control, names) {
  for (const name of names) assertEqual(pick(stopOf(log, name)), pick(stopOf(control, name)), name);
}

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

async function golden() {
  const res = await fetch('golden-normal-run.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Facit saknas – kör: node tests/run-browser-tests.mjs --golden');
  return res.json();
}

// ── Task 1: regression ──

test('vanlig resa: alla stationer får tider', async () => {
  const r = await runJourney(buildJourney());
  const s = r.log.stops;
  assert(s[0].actualDeparture, 'avgång från start saknas');
  for (let i = 1; i < s.length - 1; i++) assert(s[i].actualArrival && s[i].actualDeparture, `tider saknas för ${s[i].name}`);
  assert(s[s.length - 1].actualArrival, 'ankomst till slutstationen saknas');
});

test('regression: vanlig resa ger exakt samma tider som facit', async () => {
  const r = await runJourney(buildJourney());
  assertEqual(summarize(r.log), await golden(), 'tider');
});

// ── Körning ──

window.captureGolden = async function () {
  const r = await runJourney(buildJourney());
  return summarize(r.log);
};

window.runTests = async function (filter) {
  const results = [];
  for (const t of TESTS) {
    if (filter && !t.name.includes(filter)) continue;
    try {
      await t.fn();
      results.push({ name: t.name, ok: true });
    } catch (e) {
      results.push({ name: t.name, ok: false, error: String(e && e.message || e) });
    }
  }
  return { results, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
};
</script>
</body>
</html>
```

- [ ] **Step 7: Kör regressionen utan facit och kontrollera att den misslyckas**

Run: `node tests/run-browser-tests.mjs regression`
Expected: `✖ regression: …` med `Facit saknas – kör: node tests/run-browser-tests.mjs --golden`.

- [ ] **Step 8: Ta fram facit med dagens logik**

Run: `node tests/run-browser-tests.mjs --golden`
Expected: `Facit sparat: tests/golden-normal-run.json (6 stationer)`. Filen ska innehålla exakt dessa tider:

| Station | actualArrival | actualDeparture |
|---|---|---|
| Lidköping | `null` | `2026-10-15T05:00:06.000Z` |
| Filsbäck | `2026-10-15T05:05:24.000Z` | `2026-10-15T05:06:04.000Z` |
| Källby | `2026-10-15T05:10:22.000Z` | `2026-10-15T05:11:02.000Z` |
| Blomberg | `2026-10-15T05:15:02.000Z` | `2026-10-15T05:15:42.000Z` |
| Råbäck | `2026-10-15T05:23:54.000Z` | `2026-10-15T05:24:34.000Z` |
| Hällekis | `2026-10-15T05:29:00.000Z` | `null` |

Alla källor är `gps` utom Lidköpings ankomst och Hällekis avgång, som är tomma.

- [ ] **Step 9: Kör testerna**

Run: `node tests/run-browser-tests.mjs`
Expected: `2 lyckades, 0 misslyckades`.

- [ ] **Step 10: Uppdatera kopian och committa**

```bash
cp index.html "Kinnekulle GPS.html" && cmp index.html "Kinnekulle GPS.html"
git add index.html "Kinnekulle GPS.html" tests/run-browser-tests.mjs tests/replay.html tests/golden-normal-run.json
git commit -m "Testläge, testrigg för uppspelade resor och regressionsfacit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Avbrottsmodulen `railtimer-avbrott.js`

**Files:**
- Create: `tests/railtimer-avbrott.test.js`, `railtimer-avbrott.js`

**Interfaces:**
- Produces (global `RailTimerAvbrott` i webbläsaren, `module.exports` i Node):
  - `GAP_MS=20000`, `MOVE_M=150`, `GRACE_MS=2000`
  - `detectInterruption(prev:{t,lat,lon}|null, fix:{t,lat,lon}) → {from:number,to:number,distanceM:number}|null`
  - `isWithinInterruption(t, interruptions, graceMs?) → interruption|null`
  - `applyInterruptionWindows(stops, interruptions, graceMs?) → nya stops`
  - `markStationMissed(station, intr)` och `markDepartureUnknown(station, intr)`, som ändrar objektet
  - `distanceToSegment(p, a, b) → meter`
  - `planCatchUp(route, {lastReachedIndex,nextIndex,awaitingDepartureIndex}, {lat,lon}) → {passed:number[], lastReachedIndex, nextIndex, departedDuringGap:number|null}|null`
  - `haversine(lat1, lon1, lat2, lon2) → meter`

- [ ] **Step 1: Skriv testerna i `tests/railtimer-avbrott.test.js`**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AV = require('../railtimer-avbrott.js');

// Fem stationer på en rak nord-sydlig linje, ungefär 3,3 km mellan varje
const route = [0, 1, 2, 3, 4].map(i => ({ name: 'S' + i, lat: 58.0 + i * 0.03, lon: 13.0, radius: 200 }));
const between = (i, f) => ({ lat: 58.0 + (i + f) * 0.03, lon: 13.0 });

test('detectInterruption: ingen tidigare position ger inget avbrott', () => {
  assert.equal(AV.detectInterruption(null, { t: 1000, lat: 58, lon: 13 }), null);
});

test('detectInterruption: exakt 20 s räcker inte', () => {
  const prev = { t: 0, lat: 58.0, lon: 13.0 };
  const fix = { t: 20000, lat: 58.01, lon: 13.0 };
  assert.equal(AV.detectInterruption(prev, fix), null);
});

test('detectInterruption: mer än 20 s och minst 150 m ger avbrott med avrundad sträcka', () => {
  const prev = { t: 0, lat: 58.0, lon: 13.0 };
  const fix = { t: 20001, lat: 58.0014, lon: 13.0 }; // ≈ 156 m
  const intr = AV.detectInterruption(prev, fix);
  assert.ok(intr);
  assert.equal(intr.from, 0);
  assert.equal(intr.to, 20001);
  assert.equal(intr.distanceM, Math.round(AV.haversine(58.0, 13.0, 58.0014, 13.0)));
});

test('detectInterruption: långt glapp utan förflyttning är inget avbrott', () => {
  const prev = { t: 0, lat: 58.0, lon: 13.0 };
  const fix = { t: 60000, lat: 58.0009, lon: 13.0 }; // ≈ 100 m
  assert.equal(AV.detectInterruption(prev, fix), null);
});

test('isWithinInterruption: gränserna from < t ≤ to + 2 s', () => {
  const intr = [{ from: '2026-10-15T05:00:00.000Z', to: '2026-10-15T05:03:00.000Z' }];
  assert.equal(AV.isWithinInterruption('2026-10-15T05:00:00.000Z', intr), null);
  assert.ok(AV.isWithinInterruption('2026-10-15T05:00:00.001Z', intr));
  assert.ok(AV.isWithinInterruption('2026-10-15T05:03:02.000Z', intr));
  assert.equal(AV.isWithinInterruption('2026-10-15T05:03:02.001Z', intr), null);
  assert.equal(AV.isWithinInterruption(null, intr), null);
});

test('applyInterruptionWindows: tid inom avbrott blir null med fönster, andra lämnas', () => {
  const intr = [{ from: '2026-10-15T05:00:00.000Z', to: '2026-10-15T05:03:00.000Z', distanceM: 2100 }];
  const stops = [
    { name: 'Källby', actualArrival: '2026-10-15T04:59:30.000Z', actualDeparture: '2026-10-15T05:03:00.500Z', arrivalSource: 'gps', departSource: 'gps' }
  ];
  const out = AV.applyInterruptionWindows(stops, intr);
  assert.equal(out[0].actualArrival, '2026-10-15T04:59:30.000Z');
  assert.equal(out[0].arrivalSource, 'gps');
  assert.equal(out[0].actualDeparture, null);
  assert.deepEqual(out[0].departureWindow, { from: '2026-10-15T05:00:00.000Z', to: '2026-10-15T05:03:00.000Z' });
  assert.equal(out[0].departSource, 'avbrott');
  assert.equal(stops[0].actualDeparture, '2026-10-15T05:03:00.500Z', 'indata får inte ändras');
});

test('applyInterruptionWindows: fungerar med Date-objekt och utan avbrott', () => {
  const stops = [{ actualArrival: new Date('2026-10-15T05:01:00Z'), actualDeparture: null }];
  assert.deepEqual(AV.applyInterruptionWindows(stops, []), [{ actualArrival: stops[0].actualArrival, actualDeparture: null }]);
  const out = AV.applyInterruptionWindows(stops, [{ from: Date.parse('2026-10-15T05:00:00Z'), to: Date.parse('2026-10-15T05:02:00Z') }]);
  assert.equal(out[0].actualArrival, null);
  assert.equal(out[0].arrivalSource, 'avbrott');
});

test('planCatchUp: tåget är fortfarande före nästa station – ingen ändring', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 1, nextIndex: 2, awaitingDepartureIndex: null }, between(1, 0.5));
  assert.equal(plan, null);
});

test('planCatchUp: två stationer passerade – appen kommer ikapp och avgången blir okänd', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 1, nextIndex: 2, awaitingDepartureIndex: 1 }, between(3, 0.5));
  assert.deepEqual(plan, { passed: [2, 3], lastReachedIndex: 3, nextIndex: 4, departedDuringGap: 1 });
});

test('planCatchUp: inom radien för en senare station blir den nästa station', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 1, nextIndex: 2, awaitingDepartureIndex: null }, { lat: route[3].lat + 0.0005, lon: 13.0 });
  assert.deepEqual(plan, { passed: [2], lastReachedIndex: 2, nextIndex: 3, departedDuringGap: null });
});

test('planCatchUp: inom radien för nästa station – vanlig logik tar hand om det', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 1, nextIndex: 2, awaitingDepartureIndex: 1 }, { lat: route[2].lat, lon: 13.0 });
  assert.equal(plan, null);
});

test('planCatchUp: går aldrig bakåt', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 2, nextIndex: 3, awaitingDepartureIndex: null }, between(0, 0.5));
  assert.equal(plan, null);
});

test('planCatchUp: förbi sista stationens radie – slutstationen blir nästa', () => {
  const plan = AV.planCatchUp(route, { lastReachedIndex: 0, nextIndex: 1, awaitingDepartureIndex: null }, { lat: route[4].lat + 0.01, lon: 13.0 });
  assert.deepEqual(plan, { passed: [1, 2, 3], lastReachedIndex: 3, nextIndex: 4, departedDuringGap: null });
});

test('markStationMissed och markDepartureUnknown sätter fält och fönster', () => {
  const intr = { from: Date.parse('2026-10-15T05:00:00Z'), to: Date.parse('2026-10-15T05:04:00Z') };
  const st = { actualArrival: 'x', actualDeparture: 'y', inZone: true, needsArrivalRetiming: true };
  AV.markStationMissed(st, intr);
  assert.equal(st.missedReason, 'avbrott');
  assert.equal(st.actualArrival, null);
  assert.equal(st.actualDeparture, null);
  assert.deepEqual(st.arrivalWindow, { from: '2026-10-15T05:00:00.000Z', to: '2026-10-15T05:04:00.000Z' });
  assert.equal(st.inZone, false);
  const st2 = { actualArrival: 'a', actualDeparture: null, inZone: true, departureProvisional: true };
  AV.markDepartureUnknown(st2, intr);
  assert.equal(st2.actualArrival, 'a');
  assert.equal(st2.departSource, 'avbrott');
  assert.deepEqual(st2.departureWindow, { from: '2026-10-15T05:00:00.000Z', to: '2026-10-15T05:04:00.000Z' });
  assert.equal(st2.departureProvisional, false);
});
```

- [ ] **Step 2: Kör testerna och kontrollera att de misslyckas**

Run: `node --test "tests/railtimer-avbrott.test.js"`
Expected: FAIL med `Cannot find module '../railtimer-avbrott.js'`.

- [ ] **Step 3: Skriv `railtimer-avbrott.js`**

```js
/* RailTimer – avbrott i mätningen (samtal, appen i bakgrunden, GPS-glapp).
   Rena funktioner utan beroenden. Används av index.html och testas med node --test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RailTimerAvbrott = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GAP_MS = 20000;     // mer än 20 s utan GPS-position …
  const MOVE_M = 150;       // … och minst 150 m förflyttning = avbrott
  const GRACE_MS = 2000;    // tider registrerade av första positionen efter avbrottet
  const DEFAULT_RADIUS = 200;

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function toMs(t) {
    if (t == null || t === '') return null;
    // Datum känns igen på getTime(): testerna byter ut Date, och instanceof gäller då inte
    const ms = typeof t.getTime === 'function' ? t.getTime() : (typeof t === 'number' ? t : Date.parse(t));
    return Number.isFinite(ms) ? ms : null;
  }

  function iso(t) {
    return new Date(toMs(t)).toISOString();
  }

  // prev och fix: { t: ms enligt appens klocka, lat, lon }
  function detectInterruption(prev, fix) {
    if (!prev || !fix) return null;
    const gap = fix.t - prev.t;
    if (!(gap > GAP_MS)) return null;
    const distance = haversine(prev.lat, prev.lon, fix.lat, fix.lon);
    if (!(distance >= MOVE_M)) return null;
    return { from: prev.t, to: fix.t, distanceM: Math.round(distance) };
  }

  function windowOf(intr) {
    return { from: iso(intr.from), to: iso(intr.to) };
  }

  // Returnerar avbrottet som tiden t ligger i (from < t ≤ to + grace), annars null
  function isWithinInterruption(t, interruptions, graceMs) {
    const grace = graceMs == null ? GRACE_MS : graceMs;
    const ms = toMs(t);
    if (ms == null || !Array.isArray(interruptions)) return null;
    for (const intr of interruptions) {
      const from = toMs(intr.from);
      const to = toMs(intr.to);
      if (from == null || to == null) continue;
      if (ms > from && ms <= to + grace) return intr;
    }
    return null;
  }

  // Tider inom ett avbrott ersätts med null, fönster och källan 'avbrott'. Ändrar inte indata.
  function applyInterruptionWindows(stops, interruptions, graceMs) {
    if (!Array.isArray(stops)) return [];
    return stops.map(stop => {
      const out = Object.assign({}, stop);
      const a = isWithinInterruption(out.actualArrival, interruptions, graceMs);
      if (a) {
        out.actualArrival = null;
        out.arrivalWindow = windowOf(a);
        out.arrivalSource = 'avbrott';
      }
      const d = isWithinInterruption(out.actualDeparture, interruptions, graceMs);
      if (d) {
        out.actualDeparture = null;
        out.departureWindow = windowOf(d);
        out.departSource = 'avbrott';
      }
      return out;
    });
  }

  // Stationen passerades helt under avbrottet
  function markStationMissed(station, intr) {
    const w = windowOf(intr);
    station.missedReason = 'avbrott';
    station.actualArrival = null;
    station.actualDeparture = null;
    station.arrivalWindow = w;
    station.departureWindow = w;
    station.arrivalSource = 'avbrott';
    station.departSource = 'avbrott';
    station.inZone = false;
    station.needsArrivalRetiming = false;
    station.departureProvisional = false;
    station.departureProvisionalAt = null;
  }

  // Tåget stod vid stationen när avbrottet började och har lämnat den
  function markDepartureUnknown(station, intr) {
    station.actualDeparture = null;
    station.departureWindow = windowOf(intr);
    station.departSource = 'avbrott';
    station.inZone = false;
    station.needsArrivalRetiming = false;
    station.departureProvisional = false;
    station.departureProvisionalAt = null;
  }

  // Avstånd i meter från punkten p till sträckan a–b (lokal platt projektion runt p)
  function distanceToSegment(p, a, b) {
    const R = 6371000;
    const rad = Math.PI / 180;
    const k = Math.cos(p.lat * rad);
    const ax = (a.lon - p.lon) * rad * k * R, ay = (a.lat - p.lat) * rad * R;
    const bx = (b.lon - p.lon) * rad * k * R, by = (b.lat - p.lat) * rad * R;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(ax + t * dx, ay + t * dy);
  }

  /* Var på rutten är tåget efter ett avbrott?
     route: [{lat, lon, radius}], progress: {lastReachedIndex, nextIndex, awaitingDepartureIndex}, pos: {lat, lon}
     Returnerar null om inget behöver ändras, annars
     { passed: [index], lastReachedIndex, nextIndex, departedDuringGap: index|null }. Går aldrig bakåt. */
  function planCatchUp(route, progress, pos) {
    if (!Array.isArray(route) || !progress || !pos) return null;
    const next = progress.nextIndex;
    if (next == null || next >= route.length) return null;
    const last = Math.max(0, progress.lastReachedIndex || 0);

    // 1. Inom radien för en station som ännu inte nåtts – den närmaste vinner
    let target = null;
    let best = Infinity;
    for (let j = next; j < route.length; j++) {
      const st = route[j];
      if (st.lat == null || st.lon == null) continue;
      const d = haversine(pos.lat, pos.lon, st.lat, st.lon);
      if (d <= (st.radius || DEFAULT_RADIUS) && d < best) {
        best = d;
        target = j;
      }
    }

    let newLast;
    let newNext;
    if (target != null) {
      if (target === next) return null;
      newLast = target - 1;
      newNext = target;
    } else {
      // 2. Närmaste delsträcka (rak linje mellan två stationer), från senast nådda och framåt
      let k = null;
      best = Infinity;
      for (let i = last; i < route.length - 1; i++) {
        const a = route[i];
        const b = route[i + 1];
        if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) continue;
        const d = distanceToSegment(pos, a, b);
        if (d < best) {
          best = d;
          k = i;
        }
      }
      if (k == null || k + 1 <= next) return null;
      newLast = k;
      newNext = k + 1;
    }

    const passed = [];
    for (let i = next; i < newNext; i++) passed.push(i);
    const a = progress.awaitingDepartureIndex;
    const departedDuringGap = (a != null && a < next) ? a : null;
    return { passed, lastReachedIndex: Math.max(last, newLast), nextIndex: newNext, departedDuringGap };
  }

  return {
    GAP_MS, MOVE_M, GRACE_MS,
    haversine, detectInterruption, isWithinInterruption, applyInterruptionWindows,
    markStationMissed, markDepartureUnknown, distanceToSegment, planCatchUp
  };
});
```

- [ ] **Step 4: Kör testerna**

Run: `node --test "tests/railtimer-avbrott.test.js"`
Expected: `ℹ pass 14` och `ℹ fail 0`.

- [ ] **Step 5: Committa**

```bash
git add railtimer-avbrott.js tests/railtimer-avbrott.test.js
git commit -m "Modul för avbrott i mätningen: upptäckt, ikappkörning och tidsfönster

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Körningsformat 2

Resan får sitt id när den startar. Körningen sparas med format, appversion, stationssignatur, position och radie. `normalizeLogEntry` bevarar de nya fälten.

**Files:**
- Modify: `index.html` (`initJourneyState`, `saveLog`, `normalizeLogEntry`, `saveActiveJourney`, `resumeJourney`)
- Modify: `tests/replay.html`
- Modify: `Kinnekulle GPS.html` (kopia)

**Interfaces:**
- Consumes: `initJourneyState` (Task 1)
- Produces:
  - `state.journeyId: string`
  - Körningsobjekt med `format: 2`, `appVersion` och `interruptions: []`
  - `stops[].sig`, `stops[].lat`, `stops[].lon` och `stops[].radius`

- [ ] **Step 1: Skriv testet. Lägg till före `// ── Körning ──` i `tests/replay.html`.**

```js
// ── Task 3: körningsformat 2 ──

test('format 2: id, format, appversion och stationsfält', async () => {
  const r = await runJourney(buildJourney());
  const log = r.log;
  assertEqual(log.format, 2, 'format');
  assert(typeof log.appVersion === 'string' && log.appVersion.length > 0, 'appVersion saknas');
  assertEqual(log.id, r.rt.state.journeyId, 'id ska vara resans id');
  const s = log.stops[1];
  assertEqual([s.sig, s.lat, s.lon, s.radius], ['Fiä', STATIONS[1][1], STATIONS[1][2], 200], 'stationsfält');
  assertEqual(log.interruptions, [], 'avbrott');
});

```

- [ ] **Step 2: Kör testet och kontrollera att det misslyckas**

Run: `node tests/run-browser-tests.mjs "format 2"`
Expected: `✖ format 2: …` med `format: fick undefined, väntade 2`.

- [ ] **Step 3: Resans id i `initJourneyState`**

Ersätt:
```js
    state.nextIndex=route.length>1?1:null;
    state.autoReason='';
    state.aborted=false;
  }

  function buildRouteFromTimetable(timetableResult, startSig, endSig){
```
med:
```js
    state.nextIndex=route.length>1?1:null;
    state.autoReason='';
    state.aborted=false;
    state.journeyId=Date.now().toString(36); // blir körningens id när resan sparas
  }

  function buildRouteFromTimetable(timetableResult, startSig, endSig){
```

- [ ] **Step 4: Format 2 i `saveLog`**

Ersätt:
```js
  function saveLog(aborted){
    const logs=loadLogs();
    const entry={
      id:Date.now().toString(36),
      trainNumber:state.trainNumber,
      vehicleType:state.vehicleType,
      startStation:state.route[0]?.name||'',
      endStation:state.route[state.route.length-1]?.name||'',
      startedAt:state.startedAt,
      finishedAt:new Date(),
      aborted:!!aborted,
      notes:state.notes,
      stops:state.route.map(st=>({
        name:st.name,
        actualArrival:st.actualArrival,
        actualDeparture:st.actualDeparture,
        scheduledArrival:st.scheduledArrival,
        scheduledDeparture:st.scheduledDeparture,
        arrivalSource:st.arrivalSource,
        departSource:st.departSource,
        shouldStop:st.shouldStop,
        excludeInboundRun:!!st.excludeInboundRun,
        notes:st.notes||''
      }))
    };
```
med:
```js
  function saveLog(aborted){
    const logs=loadLogs();
    const entry={
      id:state.journeyId||Date.now().toString(36),
      format:2,
      appVersion:APP_VERSION,
      trainNumber:state.trainNumber,
      vehicleType:state.vehicleType,
      startStation:state.route[0]?.name||'',
      endStation:state.route[state.route.length-1]?.name||'',
      startedAt:state.startedAt,
      finishedAt:new Date(),
      aborted:!!aborted,
      notes:state.notes,
      interruptions:(state.interruptions||[]).slice(),
      stops:state.route.map(st=>({
        name:st.name,
        sig:st.sig||'',
        lat:st.lat,
        lon:st.lon,
        radius:st.radius,
        actualArrival:st.actualArrival,
        actualDeparture:st.actualDeparture,
        scheduledArrival:st.scheduledArrival,
        scheduledDeparture:st.scheduledDeparture,
        arrivalSource:st.arrivalSource,
        departSource:st.departSource,
        shouldStop:st.shouldStop,
        excludeInboundRun:!!st.excludeInboundRun,
        notes:st.notes||''
      }))
    };
```

- [ ] **Step 5: `normalizeLogEntry` bevarar fälten från format 2**

Ersätt:
```js
    const normalizedStops = stopsArray.map((stop,idx)=>({
      name: stop.name || stop.station || `Uppehåll ${idx+1}`,
      actualArrival: stop.actualArrival || stop.arrival || stop.arr || null,
      actualDeparture: stop.actualDeparture || stop.departure || stop.dep || null,
      scheduledArrival: stop.scheduledArrival || null,
      scheduledDeparture: stop.scheduledDeparture || null,
      arrivalSource: stop.arrivalSource || '',
      departSource: stop.departSource || '',
      shouldStop: stop.shouldStop!=null ? !!stop.shouldStop : !stop.skipNoStop,
      excludeInboundRun: !!(stop.excludeInboundRun || stop.exclude),
      notes: stop.notes || ''
    }));
    const rawId = entry.id || entry.measurementId || entry.measurementID || `${entry.trainNumber||''}|${startStation||''}|${startedAt||''}`;
    return {
      id: String(rawId || Date.now().toString(36)),
      trainNumber: entry.trainNumber || '',
      vehicleType: entry.vehicleType || '',
      startStation: startStation || '',
      endStation: endStation || '',
      startedAt: startedAt || null,
      finishedAt: finishedAt || null,
      aborted: !!entry.aborted,
      notes: entry.notes || entry.note || '',
      stops: normalizedStops
    };
  }
```
med:
```js
    const normalizedStops = stopsArray.map((stop,idx)=>{
      const out = {
        name: stop.name || stop.station || `Uppehåll ${idx+1}`,
        actualArrival: stop.actualArrival || stop.arrival || stop.arr || null,
        actualDeparture: stop.actualDeparture || stop.departure || stop.dep || null,
        scheduledArrival: stop.scheduledArrival || null,
        scheduledDeparture: stop.scheduledDeparture || null,
        arrivalSource: stop.arrivalSource || '',
        departSource: stop.departSource || '',
        shouldStop: stop.shouldStop!=null ? !!stop.shouldStop : !stop.skipNoStop,
        excludeInboundRun: !!(stop.excludeInboundRun || stop.exclude),
        notes: stop.notes || ''
      };
      // Fält från format 2 bevaras när de finns
      for(const key of ['sig','lat','lon','radius','arrivalWindow','departureWindow','missedReason']){
        if(stop[key]!==undefined) out[key]=stop[key];
      }
      return out;
    });
    const rawId = entry.id || entry.measurementId || entry.measurementID || `${entry.trainNumber||''}|${startStation||''}|${startedAt||''}`;
    const out = {
      id: String(rawId || Date.now().toString(36)),
      trainNumber: entry.trainNumber || '',
      vehicleType: entry.vehicleType || '',
      startStation: startStation || '',
      endStation: endStation || '',
      startedAt: startedAt || null,
      finishedAt: finishedAt || null,
      aborted: !!entry.aborted,
      notes: entry.notes || entry.note || '',
      stops: normalizedStops
    };
    for(const key of ['format','appVersion','interruptions','trackPath']){
      if(entry[key]!==undefined) out[key]=entry[key];
    }
    return out;
  }
```

- [ ] **Step 6: Resans id överlever "Återuppta resa"**

Ersätt:
```js
        lastReachedIndex: state.lastReachedIndex,
        nextIndex: state.nextIndex,
        awaitingDepartureIndex: state.awaitingDepartureIndex,
        lastSaveTime: Date.now()
      };
```
med:
```js
        lastReachedIndex: state.lastReachedIndex,
        nextIndex: state.nextIndex,
        awaitingDepartureIndex: state.awaitingDepartureIndex,
        journeyId: state.journeyId,
        lastSaveTime: Date.now()
      };
```
Ersätt:
```js
    state.awaitingDepartureIndex = saved.awaitingDepartureIndex;
    state.aborted = false;
```
med:
```js
    state.awaitingDepartureIndex = saved.awaitingDepartureIndex;
    state.aborted = false;
    state.journeyId = saved.journeyId || Date.now().toString(36);
```

- [ ] **Step 7: Kör testerna**

Run: `node tests/run-browser-tests.mjs`
Expected: `3 lyckades, 0 misslyckades`. Regressionen ska också gå igenom.

- [ ] **Step 8: Uppdatera kopian och committa**

```bash
cp index.html "Kinnekulle GPS.html" && cmp index.html "Kinnekulle GPS.html"
git add index.html "Kinnekulle GPS.html" tests/replay.html
git commit -m "Körningsformat 2: resans id, appversion, stationssignatur och position

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Avbrottshantering i appen

**Files:**
- Modify: `index.html` (skripttagg, `AV`, `initJourneyState`, `handlePosition`, nya `checkForInterruption`/`handleInterruption`/`isInterruptedTime`, `saveLog`, `saveActiveJourney`, `resumeJourney`, `handleVisibilityChange`, `timeCell`, `updateCard`, `renderReport`)
- Modify: `tests/replay.html`
- Modify: `Kinnekulle GPS.html` (kopia)

**Interfaces:**
- Consumes:
  - `RailTimerAvbrott` (Task 2)
  - `state.journeyId` och format 2 (Task 3)
- Produces:
  - `state.interruptions: {from:string,to:string,distanceM:number}[]`
  - `state.lastFix: {t,lat,lon}|null`
  - `state.interruptionTipShown: boolean`
  - Stationsfälten `arrivalWindow`, `departureWindow` och `missedReason`

- [ ] **Step 1: Skriv testerna. Lägg till före `// ── Körning ──` i `tests/replay.html`.**

```js
// ── Task 4: avbrott ──

test('avbrott: samtal när tåget står i Källby', async () => {
  const fixes = buildJourney();
  const control = await runJourney(fixes);
  const arrK = Date.parse(stopOf(control.log, 'Källby').actualArrival);
  const tResume = fixes.find(f => f.leg === 2 && f.frac >= 0.66).t;
  const r = await runJourney(fixes, { drop: f => f.t > arrK + 10000 && f.t < tResume });
  const lastBefore = Math.max(...fixes.filter(f => f.t <= arrK + 10000).map(f => f.t));
  const k = stopOf(r.log, 'Källby');
  assertEqual(k.actualArrival, stopOf(control.log, 'Källby').actualArrival, 'ankomst Källby');
  assertEqual(k.actualDeparture, null, 'avgång Källby');
  assertEqual(k.departSource, 'avbrott', 'källa för avgång');
  assertEqual(k.departureWindow, { from: iso(lastBefore), to: iso(tResume) }, 'fönster');
  sameAsControl(r.log, control.log, ['Lidköping', 'Filsbäck', 'Blomberg', 'Råbäck', 'Hällekis']);
  assertEqual(r.log.interruptions.length, 1, 'antal avbrott');
});

function twoStationCall(fixes) {
  const from = fixes.find(f => f.leg === 1 && f.frac >= 0.5).t;     // mitt mellan Filsbäck och Källby
  const resume = fixes.find(f => f.leg === 3 && f.frac >= 0.5).t;   // mitt mellan Blomberg och Råbäck
  return { from, resume, drop: f => f.t >= from && f.t < resume };
}

function assertTwoStationCall(r, control) {
  for (const name of ['Källby', 'Blomberg']) {
    const s = stopOf(r.log, name);
    assertEqual([s.missedReason, s.actualArrival, s.actualDeparture], ['avbrott', null, null], name);
  }
  sameAsControl(r.log, control.log, ['Lidköping', 'Filsbäck', 'Råbäck', 'Hällekis']);
  assertEqual(r.log.interruptions.length, 1, 'antal avbrott');
}

test('avbrott: samtal medan två stationer passeras – appen kommer ikapp', async () => {
  const fixes = buildJourney();
  const control = await runJourney(fixes);
  const call = twoStationCall(fixes);
  const r = await runJourney(fixes, { drop: call.drop });
  assertTwoStationCall(r, control);
});

test('avbrott: 60 s utan positioner medan tåget står still är inget avbrott', async () => {
  const fixes = buildJourney({ 3: 100000 });
  const control = await runJourney(fixes);
  const dwellStart = fixes.find(f => f.dwellAt === 3).t;
  const r = await runJourney(fixes, { drop: f => f.t > dwellStart + 20000 && f.t <= dwellStart + 80000 });
  sameAsControl(r.log, control.log, STATIONS.map(s => s[0]));
  assertEqual(r.log.interruptions.length, 0, 'antal avbrott');
});

test('avbrott: 30 s glapp mellan stationer tar inte bort några tider', async () => {
  const fixes = buildJourney();
  const control = await runJourney(fixes);
  const from = fixes.find(f => f.leg === 3 && f.frac >= 0.3).t;
  const r = await runJourney(fixes, { drop: f => f.t >= from && f.t < from + 30000 });
  sameAsControl(r.log, control.log, STATIONS.map(s => s[0]));
  assertEqual(r.log.interruptions.length, 1, 'antal avbrott');
});

test('avbrott: samtal när tåget kommer fram till slutstationen', async () => {
  const fixes = buildJourney();
  const control = await runJourney(fixes);
  const from = fixes.find(f => f.leg === 4 && f.frac >= 0.8).t;   // sista biten mot Hällekis
  const r = await runJourney(fixes, { drop: f => f.t >= from && f.dwellAt == null });
  const h = stopOf(r.log, 'Hällekis');
  assertEqual(h.actualArrival, null, 'ankomst Hällekis');
  assertEqual(h.arrivalSource, 'avbrott', 'källa');
  assert(h.arrivalWindow && h.arrivalWindow.to, 'fönster saknas');
  assertEqual(r.rt.state.running, false, 'resan ska avslutas');
  sameAsControl(r.log, control.log, ['Lidköping', 'Filsbäck', 'Källby', 'Blomberg', 'Råbäck']);
});

test('avbrott: sidan laddas om under samtalet och resan återupptas', async () => {
  const fixes = buildJourney();
  const control = await runJourney(fixes);
  const call = twoStationCall(fixes);
  const r = await runJourney(fixes, { drop: call.drop, reloadBefore: call.resume });
  assertTwoStationCall(r, control);
});

```

- [ ] **Step 2: Kör testerna och kontrollera att de misslyckas**

Run: `node tests/run-browser-tests.mjs avbrott`
Expected: Fallen 1, 2, 4, 5 och 6 misslyckas, till exempel `avgång Källby: fick "2026-…", väntade null`. Fall 3, det med 60 s stillastående, kan redan gå igenom. Det är väntat.

- [ ] **Step 3: Ladda modulen och lägg till `AV`**

Ersätt:
```html
  All data sparas endast lokalt i webbläsaren på den här enheten.
</footer>

<script>
(function(){
  'use strict';

  const APP_VERSION = '2026-10-15';
```
med:
```html
  All data sparas endast lokalt i webbläsaren på den här enheten.
</footer>

<script src="railtimer-avbrott.js"></script>
<script>
(function(){
  'use strict';

  const APP_VERSION = '2026-10-15';
  const AV = window.RailTimerAvbrott || null; // avbrott i mätningen (railtimer-avbrott.js)
```

- [ ] **Step 4: Nollställ avbrotten när resan startar**

Ersätt:
```js
    state.journeyId=Date.now().toString(36); // blir körningens id när resan sparas
  }
```
med:
```js
    state.journeyId=Date.now().toString(36); // blir körningens id när resan sparas
    state.interruptions=[];
    state.lastFix=null;
    state.interruptionTipShown=false;
  }
```

- [ ] **Step 5: Upptäck avbrott i `handlePosition`**

Ersätt:
```js
    const lat=pos.coords.latitude;
    const lon=pos.coords.longitude;
    const acc=pos.coords.accuracy;
    const speed=pos.coords.speed!=null?pos.coords.speed:estimateSpeedFromHistory(pos);
```
med:
```js
    const lat=pos.coords.latitude;
    const lon=pos.coords.longitude;
    const acc=pos.coords.accuracy;
    checkForInterruption({ t:state.lastFixTime, lat, lon });
    const speed=pos.coords.speed!=null?pos.coords.speed:estimateSpeedFromHistory(pos);
```
Ersätt:
```js
    saveActiveJourney(); // Auto-save journey state
  }

  const speedHistory=[];
```
med:
```js
    saveActiveJourney(); // Auto-save journey state
  }

  // Avbrott: mer än 20 s sedan förra positionen och tåget har flyttat sig minst 150 m
  // (samtal, appen i bakgrunden, GPS-glapp). Vanliga positioner påverkas inte.
  function checkForInterruption(fix){
    const prev=state.lastFix;
    state.lastFix=fix;
    if(!AV) return;
    const intr=AV.detectInterruption(prev, fix);
    if(intr) handleInterruption(intr, fix);
  }

  function handleInterruption(intr, fix){
    const record={ from:new Date(intr.from).toISOString(), to:new Date(intr.to).toISOString(), distanceM:intr.distanceM };
    state.interruptions.push(record);
    // Ikappkörning: stationer som passerades under avbrottet markeras som missade
    const plan=AV.planCatchUp(state.route, {
      lastReachedIndex:state.lastReachedIndex,
      nextIndex:state.nextIndex,
      awaitingDepartureIndex:state.awaitingDepartureIndex
    }, fix);
    if(plan){
      plan.passed.forEach(i=>AV.markStationMissed(state.route[i], record));
      if(plan.departedDuringGap!=null) AV.markDepartureUnknown(state.route[plan.departedDuringGap], record);
      state.lastReachedIndex=plan.lastReachedIndex;
      state.nextIndex=plan.nextIndex;
      if(state.awaitingDepartureIndex!=null && state.awaitingDepartureIndex<plan.nextIndex) state.awaitingDepartureIndex=null;
      if(state.departureProvisionalIdx!=null && state.departureProvisionalIdx<plan.nextIndex) state.departureProvisionalIdx=null;
    }
    const secs=Math.round((intr.to-intr.from)/1000);
    const length=secs<90?`${secs} s`:`${Math.round(secs/60)} min`;
    showJourneyMessage(`Avbrott i mätningen (${length}) – tider under avbrottet sparas som saknade`, true);
    clearTimeout(handleInterruption._timer);
    handleInterruption._timer=setTimeout(()=>{ els.journeyMsg.style.display='none'; }, 8000);
    if(!state.interruptionTipShown){
      state.interruptionTipShown=true;
      showHeaderStatus('Under samtal: gå tillbaka till RailTimer så fortsätter mätningen', false);
    }
  }

  // Tid som registrerades under ett avbrott – visas som "avbrott" i stället för en klocktid
  function isInterruptedTime(t){
    return !!(AV && t && AV.isWithinInterruption(t, state.interruptions));
  }

  const speedHistory=[];
```

- [ ] **Step 6: Inga felaktiga tider sparas**

Ersätt (i `saveLog`):
```js
      interruptions:(state.interruptions||[]).slice(),
      stops:state.route.map(st=>({
        name:st.name,
        sig:st.sig||'',
        lat:st.lat,
        lon:st.lon,
        radius:st.radius,
        actualArrival:st.actualArrival,
        actualDeparture:st.actualDeparture,
        scheduledArrival:st.scheduledArrival,
        scheduledDeparture:st.scheduledDeparture,
        arrivalSource:st.arrivalSource,
        departSource:st.departSource,
        shouldStop:st.shouldStop,
        excludeInboundRun:!!st.excludeInboundRun,
        notes:st.notes||''
      }))
    };
```
med:
```js
      interruptions:(state.interruptions||[]).slice(),
      stops:state.route.map(st=>{
        const stop={
          name:st.name,
          sig:st.sig||'',
          lat:st.lat,
          lon:st.lon,
          radius:st.radius,
          actualArrival:st.actualArrival,
          actualDeparture:st.actualDeparture,
          scheduledArrival:st.scheduledArrival,
          scheduledDeparture:st.scheduledDeparture,
          arrivalSource:st.arrivalSource,
          departSource:st.departSource,
          shouldStop:st.shouldStop,
          excludeInboundRun:!!st.excludeInboundRun,
          notes:st.notes||''
        };
        if(st.arrivalWindow) stop.arrivalWindow=st.arrivalWindow;
        if(st.departureWindow) stop.departureWindow=st.departureWindow;
        if(st.missedReason) stop.missedReason=st.missedReason;
        return stop;
      })
    };
    // Tider som registrerades under ett avbrott sparas aldrig som riktiga tider
    if(AV) entry.stops=AV.applyInterruptionWindows(entry.stops, entry.interruptions);
```

- [ ] **Step 7: Avbrotten överlever omladdning**

Ersätt:
```js
        journeyId: state.journeyId,
        lastSaveTime: Date.now()
      };
```
med:
```js
        journeyId: state.journeyId,
        interruptions: state.interruptions,
        lastFix: state.lastFix,
        interruptionTipShown: state.interruptionTipShown,
        lastSaveTime: Date.now()
      };
```
Ersätt:
```js
    state.journeyId = saved.journeyId || Date.now().toString(36);
```
med:
```js
    state.journeyId = saved.journeyId || Date.now().toString(36);
    state.interruptions = Array.isArray(saved.interruptions) ? saved.interruptions : [];
    state.lastFix = saved.lastFix || null; // så att ett avbrott upptäcks även efter omladdning
    state.interruptionTipShown = !!saved.interruptionTipShown;
```

- [ ] **Step 8: Ta bort det felaktiga meddelandet "GPS fortsätter"**

Ersätt:
```js
      if(keepScreenAwake && !wakeLockSentinel){
        requestWakeLock();
      }
      // Check if journey was interrupted while in background
      if(state.running){
        const saved = loadActiveJourney();
        if(saved && saved.lastSaveTime){
          const timeSinceLastSave = Date.now() - saved.lastSaveTime;
          if(timeSinceLastSave > 60000){ // More than 1 minute
            showJourneyMessage(`Appen var i bakgrunden i ${Math.round(timeSinceLastSave/60000)} min - GPS fortsätter`, false);
            setTimeout(() => { els.journeyMsg.style.display='none'; }, 5000);
          }
        }
      }
    }else if(document.visibilityState==='hidden'){
```
med:
```js
      if(keepScreenAwake && !wakeLockSentinel){
        requestWakeLock();
      }
      // Ett avbrott upptäcks och meddelas vid nästa GPS-position (checkForInterruption)
    }else if(document.visibilityState==='hidden'){
```

- [ ] **Step 9: Visa avbrott i stationskorten och rapporten**

Ersätt:
```js
  // Faktisk tid om den finns, annars tidtabellens tid nedtonad
  function timeCell(cls, actual, scheduled){
    if(actual) return `<span class="${cls}"><strong>${formatTime(actual)}</strong>${delayBadge(actual, scheduled)}</span>`;
```
med:
```js
  // Faktisk tid om den finns, annars tidtabellens tid nedtonad. Tider under avbrott visas som "avbrott".
  function timeCell(cls, actual, scheduled, timeWindow){
    if((actual && isInterruptedTime(actual)) || (!actual && timeWindow)){
      return `<span class="${cls} planned" title="Tiden saknas på grund av avbrott i mätningen">avbrott</span>`;
    }
    if(actual) return `<span class="${cls}"><strong>${formatTime(actual)}</strong>${delayBadge(actual, scheduled)}</span>`;
```
Ersätt:
```js
    const done = idx===0 ? !!station.actualDeparture : (isLast ? !!station.actualArrival : !!(station.actualArrival && station.actualDeparture));
    if(done) classes.push('done');
    card.className=classes.join(' ');

    const stopIcon = station.shouldStop ? '' : ' ⏩';
    const times=[];
    if(idx>0 || station.actualArrival) times.push(timeCell('arr', station.actualArrival, station.scheduledArrival));
    if(!isLast || station.actualDeparture) times.push(timeCell('dep', station.actualDeparture, station.scheduledDeparture));
```
med:
```js
    const done = station.missedReason ? true : (idx===0 ? !!station.actualDeparture : (isLast ? !!station.actualArrival : !!(station.actualArrival && station.actualDeparture)));
    if(done) classes.push('done');
    card.className=classes.join(' ');

    const stopIcon = station.shouldStop ? '' : ' ⏩';
    const times=[];
    if(station.missedReason){
      times.push('<span class="planned">missad – avbrott</span>');
    }else{
      if(idx>0 || station.actualArrival) times.push(timeCell('arr', station.actualArrival, station.scheduledArrival, station.arrivalWindow));
      if(!isLast || station.actualDeparture) times.push(timeCell('dep', station.actualDeparture, station.scheduledDeparture, station.departureWindow));
    }
```
Ersätt (i `renderReport`):
```js
      const parts=[];
      if(idx>0 || st.actualArrival){
        parts.push(`<span>↓ <strong>${st.actualArrival?formatTime(st.actualArrival):'–'}</strong>${st.scheduledArrival?` <small>(${formatClock(st.scheduledArrival)})</small>`:''}${delayBadge(st.actualArrival, st.scheduledArrival)}</span>`);
      }
      if(idx<stops.length-1 || st.actualDeparture){
        parts.push(`<span>↑ <strong>${st.actualDeparture?formatTime(st.actualDeparture):'–'}</strong>${st.scheduledDeparture?` <small>(${formatClock(st.scheduledDeparture)})</small>`:''}${delayBadge(st.actualDeparture, st.scheduledDeparture)}</span>`);
      }
```
med:
```js
      const parts=[];
      const shown=(t, timeWindow)=>t?formatTime(t):(timeWindow?'avbrott':'–');
      if(st.missedReason){
        parts.push('<span>missad – avbrott</span>');
      }else{
        if(idx>0 || st.actualArrival){
          parts.push(`<span>↓ <strong>${shown(st.actualArrival, st.arrivalWindow)}</strong>${st.scheduledArrival?` <small>(${formatClock(st.scheduledArrival)})</small>`:''}${delayBadge(st.actualArrival, st.scheduledArrival)}</span>`);
        }
        if(idx<stops.length-1 || st.actualDeparture){
          parts.push(`<span>↑ <strong>${shown(st.actualDeparture, st.departureWindow)}</strong>${st.scheduledDeparture?` <small>(${formatClock(st.scheduledDeparture)})</small>`:''}${delayBadge(st.actualDeparture, st.scheduledDeparture)}</span>`);
        }
      }
```

- [ ] **Step 10: Kör testerna**

Run: `node tests/run-browser-tests.mjs`
Expected: `9 lyckades, 0 misslyckades`. Regressionen ska också gå igenom.

- [ ] **Step 11: Uppdatera kopian och committa**

```bash
cp index.html "Kinnekulle GPS.html" && cmp index.html "Kinnekulle GPS.html"
git add index.html "Kinnekulle GPS.html" tests/replay.html
git commit -m "Avbrott i mätningen: inga felaktiga tider, och appen kommer ikapp efter samtal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: GitHub-modulen `railtimer-github.js`

**Files:**
- Create: `tests/fake-github.js`, `tests/railtimer-github.test.js`, `railtimer-github.js`

**Interfaces:**
- Produces (global `RailTimerGitHub`, `module.exports` i Node):
  - **Konstanter:** `API`, `IMPORT_CHUNK=200`, `MIN_WRITE_INTERVAL_MS=1000`, `DEFAULT_REPO='AKjork/railtimer-data'`, `MESSAGES`
  - **Fel:** `GitHubError(kind, message?, extra?)` med `kind` ∈ `auth|forbidden|notfound|ratelimit|conflict|network|unknown` och `retryAfterMs`
  - **Repo och sökvägar:**
    - `parseRepo(text) → {owner, repo}|null`
    - `localDate(t) → 'ÅÅÅÅ-MM-DD'|null`
    - `runPath(log)`, `trackPath(log)`, `importPath(when, part)`
    - `runCommitMessage(log)`, `trackCommitMessage(log, points)`
  - **Kodning:** `encodeBase64(text)` och `decodeBase64(b64)`
  - **Klient:** `createClient({owner, repo, token, branch?, fetch?, now?}) → {owner, repo, branch, getRepo, getFile, putFile, upsertFile, listTree, getBlob}`
  - **Anslutningstest:** `testAccess(client, deviceLabel, nowMs?) → {private, defaultBranch, fullName}`
  - **Kö:**
    - `normalizeState(state, repoFullName)` och `planUpload({logs, state, trackIds, now, importChunk?})`
    - `runUploadPass({client, logs, state, repo, trackStore, now?, sleep?, minIntervalMs?, onProgress?}) → {state, importedRuns, uploadedRuns, uploadedTracks, error, skippedUntil}`
  - **Hämtning:**
    - `mergeRuns(importLists, singleRuns)`
    - `loadRunsFromRepo({client, cache?, concurrency?}) → {runs, newFiles, totalFiles, trackFiles, errors}`

- [ ] **Step 1: Skapa `tests/fake-github.js`**

```js
'use strict';
/* Ett simulerat GitHub-API för tester: håller filer i minnet och svarar som det riktiga
   på de anrop RailTimer gör. override() lägger in ett engångssvar för nästa matchande anrop. */
function fakeGitHub(opts) {
  const options = opts || {};
  const files = new Map(); // path -> { sha, text }
  const calls = [];
  const overrides = [];
  let shaCounter = 0;

  function response(status, body, headers) {
    const h = headers || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: name => (h[name.toLowerCase()] == null ? null : String(h[name.toLowerCase()])) },
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    };
  }

  async function fetch(url, init) {
    const req = init || {};
    const method = (req.method || 'GET').toUpperCase();
    const u = new URL(url);
    const path = u.pathname;
    calls.push({ method, path, search: u.search, body: req.body ? JSON.parse(req.body) : null, headers: req.headers || {} });

    const i = overrides.findIndex(o => o.method === method && o.path.test(path));
    if (i >= 0) {
      const o = overrides.splice(i, 1)[0];
      if (o.networkError) throw new TypeError('Failed to fetch');
      return response(o.status, o.body || {}, o.headers);
    }

    let m;
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+)\/([^/]+)$/))) {
      return response(200, { private: options.private !== false, default_branch: 'main', full_name: `${m[1]}/${m[2]}` });
    }
    if ((m = path.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/))) {
      const p = decodeURIComponent(m[1]);
      if (method === 'GET') {
        const f = files.get(p);
        if (!f) return response(404, { message: 'Not Found' });
        const b64 = Buffer.from(f.text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
        return response(200, { sha: f.sha, content: b64, encoding: 'base64' });
      }
      if (method === 'PUT') {
        const body = JSON.parse(req.body);
        const existing = files.get(p);
        if (existing && body.sha !== existing.sha) return response(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
        const sha = 'sha' + (++shaCounter);
        files.set(p, { sha, text: Buffer.from(body.content, 'base64').toString('utf8'), message: body.message });
        return response(existing ? 200 : 201, { content: { path: p, sha } });
      }
    }
    if (method === 'GET' && /\/git\/trees\//.test(path)) {
      return response(200, { truncated: false, tree: Array.from(files, ([p, f]) => ({ path: p, sha: f.sha, type: 'blob', size: f.text.length })) });
    }
    if (method === 'GET' && (m = path.match(/\/git\/blobs\/(.+)$/))) {
      const f = Array.from(files.values()).find(x => x.sha === decodeURIComponent(m[1]));
      if (!f) return response(404, { message: 'Not Found' });
      return response(200, { encoding: 'base64', content: Buffer.from(f.text, 'utf8').toString('base64') });
    }
    return response(500, { message: `Okänt anrop i testet: ${method} ${path}` });
  }

  return {
    fetch,
    files,
    calls,
    override(o) { overrides.push(o); },
    putFileDirect(path, text) { const sha = 'sha' + (++shaCounter); files.set(path, { sha, text }); return sha; }
  };
}

module.exports = { fakeGitHub };
```

- [ ] **Step 2: Skriv testerna i `tests/railtimer-github.test.js`**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const GH = require('../railtimer-github.js');
const { fakeGitHub } = require('./fake-github.js');

const REPO = 'AKjork/railtimer-data';

function makeLog(i, extra) {
  const start = new Date(Date.UTC(2026, 8, 1, 10, 0, 0) + i * 3600000).toISOString();
  return Object.assign({
    id: 'run' + String(i).padStart(4, '0'),
    trainNumber: '23301',
    vehicleType: 'Y31',
    startStation: 'Lidköping',
    endStation: 'Herrljunga',
    startedAt: start,
    finishedAt: start,
    aborted: false,
    stops: []
  }, extra || {});
}

function setup(opts) {
  const gh = fakeGitHub(opts);
  const client = GH.createClient({ owner: 'AKjork', repo: 'railtimer-data', token: 'test-token', fetch: gh.fetch });
  let clock = Date.UTC(2026, 9, 15, 8, 0, 0);
  const sleeps = [];
  const env = {
    gh, client, sleeps,
    now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    advance: ms => { clock += ms; }
  };
  return env;
}

function memoryTrackStore(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    list: async () => Array.from(map.keys()),
    get: async id => map.get(id),
    remove: async id => { map.delete(id); }
  };
}

function pass(env, logs, state, trackStore) {
  return GH.runUploadPass({ client: env.client, logs, state, repo: REPO, trackStore, now: env.now, sleep: env.sleep });
}

test('parseRepo: ägare/namn, webbadress och .git', () => {
  assert.deepEqual(GH.parseRepo('AKjork/railtimer-data'), { owner: 'AKjork', repo: 'railtimer-data' });
  assert.deepEqual(GH.parseRepo(' https://github.com/AKjork/railtimer-data.git/ '), { owner: 'AKjork', repo: 'railtimer-data' });
  assert.equal(GH.parseRepo('railtimer-data'), null);
  assert.equal(GH.parseRepo(''), null);
});

test('sökvägar: tecken rensas, tomt tågnummer blir utan-tag och id kortas till 40 tecken', () => {
  const log = makeLog(1, { trainNumber: '23 301/A', id: 'x|y:z' });
  assert.equal(GH.runPath(log), `korningar/2026/${GH.localDate(log.startedAt)}_23301A_x-y-z.json`);
  assert.equal(GH.trackPath(log), `gps-spar/2026/${GH.localDate(log.startedAt)}_23301A_x-y-z.json`);
  const long = makeLog(2, { trainNumber: '', id: 'a'.repeat(60) });
  assert.match(GH.runPath(long), /_utan-tag_a{40}\.json$/);
  assert.match(GH.importPath(Date.UTC(2026, 9, 15, 8, 48, 0), 2), /^import\/\d{4}-\d{2}-\d{2}T\d{4}_befintliga-2\.json$/);
});

test('commit-meddelanden följer specen', () => {
  const log = makeLog(1);
  assert.equal(GH.runCommitMessage(log), `Körning ${GH.localDate(log.startedAt)} tåg 23301 Lidköping → Herrljunga`);
  assert.equal(GH.trackCommitMessage(log, 3412), `GPS-spår ${GH.localDate(log.startedAt)} tåg 23301 (3 412 punkter)`);
});

test('base64: å, ä och ö överlever fram och tillbaka, även med radbrytningar', () => {
  const text = JSON.stringify({ station: 'Källby → Råbäck, Österäng', not: 'möte' });
  const b64 = GH.encodeBase64(text);
  assert.equal(GH.decodeBase64(b64), text);
  assert.equal(GH.decodeBase64(b64.replace(/(.{10})/g, '$1\n')), text);
});

test('normalizeState: nytt repo börjar om från början', () => {
  const s = GH.normalizeState({ repo: 'AKjork/annat', uploadedIds: ['a'], backlogDone: true }, REPO);
  assert.deepEqual(s.uploadedIds, []);
  assert.equal(s.backlogDone, false);
  assert.equal(s.repo, REPO);
  const kept = GH.normalizeState({ uploadedIds: ['a'], backlogDone: true }, REPO);
  assert.deepEqual(kept.uploadedIds, ['a']);
  assert.equal(kept.repo, REPO);
});

test('450 befintliga körningar blir tre importfiler (200, 200, 50) och därefter backlogDone', async () => {
  const env = setup();
  const logs = Array.from({ length: 450 }, (_, i) => makeLog(i));
  const r = await pass(env, logs, null);
  assert.equal(r.error, null);
  assert.equal(r.importedRuns, 450);
  const imports = Array.from(env.gh.files.keys()).filter(p => p.startsWith('import/')).sort();
  assert.equal(imports.length, 3);
  assert.deepEqual(imports.map(p => JSON.parse(env.gh.files.get(p).text).length), [200, 200, 50]);
  assert.equal(env.gh.files.get(imports[0]).message, 'Import av befintliga körningar, del 1 av 3 (200 körningar)');
  assert.equal(r.state.backlogDone, true);
  assert.equal(r.state.uploadedIds.length, 450);
  assert.ok(env.sleeps.every(ms => ms <= GH.MIN_WRITE_INTERVAL_MS), 'väntan mellan skrivningar högst 1 s');
});

test('utan befintliga körningar blir backlogDone direkt', async () => {
  const env = setup();
  const r = await pass(env, [], null);
  assert.equal(r.state.backlogDone, true);
  assert.equal(env.gh.calls.length, 0);
});

test('ny körning efter importen laddas upp som egen fil med rätt sökväg och meddelande', async () => {
  const env = setup();
  const state = { repo: REPO, uploadedIds: [], backlogDone: true };
  const log = makeLog(7);
  const r = await pass(env, [log], state);
  assert.equal(r.uploadedRuns, 1);
  const f = env.gh.files.get(GH.runPath(log));
  assert.ok(f, 'filen finns i repot');
  assert.equal(f.message, GH.runCommitMessage(log));
  assert.deepEqual(JSON.parse(f.text), log);
  assert.deepEqual(r.state.uploadedIds, [log.id]);
});

test('skrivningar sker med minst 1 s mellanrum', async () => {
  const env = setup();
  const state = { repo: REPO, uploadedIds: [], backlogDone: true };
  await pass(env, [makeLog(1), makeLog(2), makeLog(3)], state);
  assert.deepEqual(env.sleeps, [1000, 1000]);
});

test('422 när filen redan finns markeras som uppladdad utan dubblett', async () => {
  const env = setup();
  const log = makeLog(3);
  env.gh.putFileDirect(GH.runPath(log), JSON.stringify(log));
  const r = await pass(env, [log], { repo: REPO, uploadedIds: [], backlogDone: true });
  assert.equal(r.error, null);
  assert.deepEqual(r.state.uploadedIds, [log.id]);
  assert.equal(env.gh.files.size, 1);
});

test('422 där filen ändå inte finns ger fel och lämnar kön orörd', async () => {
  const env = setup();
  const log = makeLog(4);
  env.gh.override({ method: 'PUT', path: /\/contents\//, status: 422, body: { message: 'Invalid request' } });
  const r = await pass(env, [log], { repo: REPO, uploadedIds: [], backlogDone: true });
  assert.equal(r.error.kind, 'unknown');
  assert.deepEqual(r.state.uploadedIds, []);
});

test('401 ger felet auth och kön är orörd', async () => {
  const env = setup();
  env.gh.override({ method: 'PUT', path: /\/contents\//, status: 401, body: { message: 'Bad credentials' } });
  const r = await pass(env, [makeLog(5)], { repo: REPO, uploadedIds: [], backlogDone: true });
  assert.equal(r.error.kind, 'auth');
  assert.equal(r.error.message, GH.MESSAGES.auth);
  assert.deepEqual(r.state.uploadedIds, []);
  assert.equal(r.state.lastError.kind, 'auth');
});

test('403 utan rate-limit är saknad skrivrätt', async () => {
  const env = setup();
  env.gh.override({ method: 'PUT', path: /\/contents\//, status: 403, body: { message: 'Resource not accessible by personal access token' } });
  const r = await pass(env, [makeLog(5)], { repo: REPO, uploadedIds: [], backlogDone: true });
  assert.equal(r.error.kind, 'forbidden');
});

test('403 med retry-after: 60 stoppar kön, sätter retryNotBefore och nästa körning väntar', async () => {
  const env = setup();
  env.gh.override({ method: 'PUT', path: /\/contents\//, status: 403, headers: { 'retry-after': '60' }, body: { message: 'You have exceeded a secondary rate limit' } });
  const t0 = env.now();
  const r = await pass(env, [makeLog(6), makeLog(7)], { repo: REPO, uploadedIds: [], backlogDone: true });
  assert.equal(r.error.kind, 'ratelimit');
  assert.equal(r.state.retryNotBefore, t0 + 60000);
  assert.equal(r.uploadedRuns, 0);
  const again = await pass(env, [makeLog(6), makeLog(7)], r.state);
  assert.equal(again.skippedUntil, t0 + 60000);
  env.advance(60000);
  const later = await pass(env, [makeLog(6), makeLog(7)], r.state);
  assert.equal(later.uploadedRuns, 2);
  assert.equal(later.state.retryNotBefore, null);
});

test('429 utan rubriker väntar en minut', async () => {
  const env = setup();
  env.gh.override({ method: 'PUT', path: /\/contents\//, status: 429, body: {} });
  const t0 = env.now();
  const r = await pass(env, [makeLog(8)], { repo: REPO, uploadedIds: [], backlogDone: true });
  assert.equal(r.error.kind, 'ratelimit');
  assert.equal(r.state.retryNotBefore, t0 + 60000);
});

test('nätverksfel stoppar kön tyst och lämnar den orörd', async () => {
  const env = setup();
  env.gh.override({ method: 'PUT', path: /\/contents\//, networkError: true });
  const r = await pass(env, [makeLog(9)], { repo: REPO, uploadedIds: [], backlogDone: true });
  assert.equal(r.error.kind, 'network');
  assert.equal(r.state.lastError.kind, 'network');
  assert.deepEqual(r.state.uploadedIds, []);
});

test('409 provas igen en gång', async () => {
  const env = setup();
  env.gh.override({ method: 'PUT', path: /\/contents\//, status: 409, body: {} });
  const log = makeLog(10);
  const r = await pass(env, [log], { repo: REPO, uploadedIds: [], backlogDone: true });
  assert.equal(r.error, null);
  assert.deepEqual(r.state.uploadedIds, [log.id]);
});

test('spåret laddas upp efter sin körning och tas bort lokalt', async () => {
  const env = setup();
  const log = makeLog(11);
  const track = { format: 1, runId: log.id, points: [[0, 58.1, 13.1, 5, 0, null, 100], [1000, 58.2, 13.2, 5, 10, 90, 120]] };
  const store = memoryTrackStore({ [log.id]: track });
  const r = await pass(env, [log], { repo: REPO, uploadedIds: [], backlogDone: true }, store);
  assert.equal(r.uploadedRuns, 1);
  assert.equal(r.uploadedTracks, 1);
  const order = env.gh.calls.filter(c => c.method === 'PUT').map(c => c.path);
  assert.ok(order[0].includes('/korningar/') && order[1].includes('/gps-spar/'), 'körningen före spåret');
  assert.deepEqual(JSON.parse(env.gh.files.get(GH.trackPath(log)).text), track);
  assert.equal(env.gh.files.get(GH.trackPath(log)).message, GH.trackCommitMessage(log, 2));
  assert.equal(store.map.size, 0);
  assert.equal(r.state.uploadedTrackCount, 1);
});

test('spåret skickas inte om körningen misslyckades', async () => {
  const env = setup();
  const log = makeLog(12);
  const store = memoryTrackStore({ [log.id]: { format: 1, runId: log.id, points: [] } });
  env.gh.override({ method: 'PUT', path: /\/korningar\//, status: 401, body: {} });
  const r = await pass(env, [log], { repo: REPO, uploadedIds: [], backlogDone: true }, store);
  assert.equal(r.error.kind, 'auth');
  assert.equal(store.map.size, 1);
  assert.equal(env.gh.calls.filter(c => c.method === 'PUT').length, 1);
});

test('spår för körningar som importerats laddas också upp', async () => {
  const env = setup();
  const log = makeLog(13);
  const store = memoryTrackStore({ [log.id]: { format: 1, runId: log.id, points: [[0, 1, 2, 3, 4, 5, 6]] } });
  const r = await pass(env, [log], null, store);
  assert.equal(r.importedRuns, 1);
  assert.equal(r.uploadedTracks, 1);
});

test('byte till ett annat repo laddar upp alla körningar igen', async () => {
  const env = setup();
  const logs = [makeLog(1), makeLog(2)];
  const oldState = { repo: 'AKjork/gammalt-repo', uploadedIds: logs.map(l => l.id), backlogDone: true, uploadedTrackCount: 5 };
  const r = await pass(env, logs, oldState);
  assert.equal(r.importedRuns, 2);
  assert.equal(r.state.repo, REPO);
  assert.equal(r.state.uploadedTrackCount, 0);
  assert.deepEqual(r.state.uploadedIds.slice().sort(), logs.map(l => l.id).sort());
});

test('testAccess skriver anslutningsfilen och rapporterar om repot är privat', async () => {
  const env = setup({ private: false });
  const info = await GH.testAccess(env.client, 'Telefon / RailTimer 2026-10-15', Date.UTC(2026, 9, 15, 8, 0, 0));
  assert.equal(info.private, false);
  const f = env.gh.files.get('.railtimer/anslutning.json');
  assert.deepEqual(JSON.parse(f.text), { enhet: 'Telefon / RailTimer 2026-10-15', testad: '2026-10-15T08:00:00.000Z' });
  await GH.testAccess(env.client, 'Telefon', Date.UTC(2026, 9, 15, 9, 0, 0));
  assert.equal(JSON.parse(env.gh.files.get('.railtimer/anslutning.json').text).testad, '2026-10-15T09:00:00.000Z');
});

test('mergeRuns: enskild körning ersätter importens version och dubbletter tas bort', () => {
  const a = makeLog(1, { notes: 'från import' });
  const b = makeLog(2);
  const a2 = makeLog(1, { notes: 'enskild fil' });
  const merged = GH.mergeRuns([[a, b], [b]], [a2]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find(r => r.id === a.id).notes, 'enskild fil');
});

test('loadRunsFromRepo: bara nya filer hämtas, spår räknas och trasiga filer rapporteras', async () => {
  const env = setup();
  const a = makeLog(1);
  const b = makeLog(2);
  const c = makeLog(3);
  env.gh.putFileDirect('import/2026-10-15T0848_befintliga-1.json', JSON.stringify([a, b]));
  env.gh.putFileDirect(GH.runPath(c), JSON.stringify(c));
  env.gh.putFileDirect(GH.trackPath(c), JSON.stringify({ format: 1, points: [] }));
  env.gh.putFileDirect('korningar/2026/trasig.json', '{inte json');
  env.gh.putFileDirect('README.md', '# data');
  const cache = new Map();
  const cacheAdapter = { get: async sha => cache.get(sha), set: async (sha, json) => { cache.set(sha, json); } };
  const first = await GH.loadRunsFromRepo({ client: env.client, cache: cacheAdapter });
  assert.equal(first.runs.length, 3);
  assert.equal(first.newFiles, 2);
  assert.equal(first.totalFiles, 3);
  assert.equal(first.trackFiles, 1);
  assert.equal(first.errors.length, 1);
  const blobCalls = () => env.gh.calls.filter(x => x.path.includes('/git/blobs/')).length;
  const before = blobCalls();
  const second = await GH.loadRunsFromRepo({ client: env.client, cache: cacheAdapter });
  assert.equal(second.newFiles, 0);
  assert.equal(blobCalls() - before, 1, 'bara den trasiga filen hämtas igen');
});

test('klienten skickar token i Authorization och inga andra egna rubriker', async () => {
  const env = setup();
  await env.client.getRepo();
  const h = env.gh.calls[0].headers;
  assert.equal(h.Authorization, 'Bearer test-token');
  assert.deepEqual(Object.keys(h).sort(), ['Accept', 'Authorization']);
});
```

- [ ] **Step 3: Kör testerna och kontrollera att de misslyckas**

Run: `node --test "tests/railtimer-github.test.js"`
Expected: FAIL med `Cannot find module '../railtimer-github.js'`.

- [ ] **Step 4: Skriv `railtimer-github.js`**

```js
/* RailTimer – uppladdning till och hämtning från ett privat GitHub-repo.
   Utan beroenden. Används av index.html och Analys.html och testas med node --test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RailTimerGitHub = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API = 'https://api.github.com';
  const IMPORT_CHUNK = 200;          // högst 200 körningar per importfil (GitHubs filgräns ~1 MB)
  const MIN_WRITE_INTERVAL_MS = 1000; // GitHub: högst 80 skrivningar/min, en i taget
  const DEFAULT_REPO = 'AKjork/railtimer-data';

  const MESSAGES = {
    auth: 'Token ogiltig – kontrollera i Uppladdning',
    forbidden: 'Token saknar skrivrätt till repot',
    notfound: 'Repot hittades inte, eller token saknar åtkomst',
    ratelimit: 'GitHub begränsar antalet anrop – försöker igen senare',
    conflict: 'Konflikt hos GitHub – försök igen',
    network: 'Ingen kontakt med GitHub (ingen täckning?)'
  };

  class GitHubError extends Error {
    constructor(kind, message, extra) {
      super(message || MESSAGES[kind] || 'Oväntat fel');
      this.name = 'GitHubError';
      this.kind = kind;
      if (extra) Object.assign(this, extra);
    }
  }

  // ── Repo och sökvägar ──

  function parseRepo(text) {
    const m = String(text || '').trim().match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
    return m ? { owner: m[1], repo: m[2] } : null;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function localDate(t) {
    const d = t instanceof Date ? t : new Date(t);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function safeTrain(train) {
    return String(train || '').replace(/[^0-9A-Za-z]/g, '') || 'utan-tag';
  }

  function safeId(id) {
    return String(id || '').replace(/[^0-9A-Za-z-]/g, '-').slice(0, 40) || 'okand';
  }

  function runFileName(log) {
    const date = localDate(log.startedAt) || localDate(log.finishedAt) || '0000-00-00';
    return { year: date.slice(0, 4), date, name: `${date}_${safeTrain(log.trainNumber)}_${safeId(log.id)}.json` };
  }

  function runPath(log) {
    const f = runFileName(log);
    return `korningar/${f.year}/${f.name}`;
  }

  function trackPath(log) {
    const f = runFileName(log);
    return `gps-spar/${f.year}/${f.name}`;
  }

  function importPath(when, part) {
    const d = when instanceof Date ? when : new Date(when);
    return `import/${localDate(d)}T${pad(d.getHours())}${pad(d.getMinutes())}_befintliga-${part}.json`;
  }

  function groupDigits(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  function runCommitMessage(log) {
    return `Körning ${localDate(log.startedAt) || 'okänt datum'} tåg ${log.trainNumber || '–'} ${log.startStation || '?'} → ${log.endStation || '?'}`;
  }

  function trackCommitMessage(log, points) {
    return `GPS-spår ${localDate(log.startedAt) || 'okänt datum'} tåg ${log.trainNumber || '–'} (${groupDigits(points)} punkter)`;
  }

  // ── Base64 för UTF-8 ──

  function encodeBase64(text) {
    const bytes = new TextEncoder().encode(String(text));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function decodeBase64(b64) {
    const bin = atob(String(b64 || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ── Klient ──

  function encodePath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
  }

  function waitFromHeaders(res, nowMs) {
    const ra = res.headers.get('retry-after');
    if (ra != null && ra !== '' && !isNaN(Number(ra))) return Math.max(0, Number(ra) * 1000);
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      if (!isNaN(reset)) return Math.max(0, reset * 1000 - nowMs);
    }
    return null;
  }

  async function errorFromResponse(res, nowMs) {
    let message = '';
    try {
      const text = await res.text();
      try { message = JSON.parse(text).message || text; } catch (e) { message = text; }
    } catch (e) { /* tom kropp */ }
    const wait = waitFromHeaders(res, nowMs);
    if (res.status === 401) return new GitHubError('auth');
    if (res.status === 403 || res.status === 429) {
      if (wait != null) return new GitHubError('ratelimit', null, { retryAfterMs: wait });
      if (res.status === 429 || /rate limit/i.test(message)) return new GitHubError('ratelimit', null, { retryAfterMs: 60000 });
      return new GitHubError('forbidden');
    }
    if (res.status === 404) return new GitHubError('notfound');
    if (res.status === 409) return new GitHubError('conflict');
    return new GitHubError('unknown', `Oväntat svar från GitHub (${res.status})${message ? ': ' + message : ''}`, { status: res.status });
  }

  function createClient(opts) {
    const owner = opts.owner;
    const repo = opts.repo;
    const token = opts.token;
    const branch = opts.branch || 'main';
    const fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const now = opts.now || (() => Date.now());
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    async function request(method, url, body) {
      const headers = { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}` };
      if (body) headers['Content-Type'] = 'application/json';
      try {
        return await fetchImpl(API + url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
      } catch (e) {
        throw new GitHubError('network');
      }
    }

    async function getRepo() {
      const res = await request('GET', base);
      if (!res.ok) throw await errorFromResponse(res, now());
      const j = await res.json();
      return { private: !!j.private, defaultBranch: j.default_branch, fullName: j.full_name };
    }

    // { sha, text } eller null om filen inte finns
    async function getFile(path) {
      const res = await request('GET', `${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw await errorFromResponse(res, now());
      const j = await res.json();
      return { sha: j.sha, text: j.content != null ? decodeBase64(j.content) : null };
    }

    // 'created' | 'updated' | 'exists'
    async function putFile(path, text, message, sha) {
      const body = { message, content: encodeBase64(text), branch };
      if (sha) body.sha = sha;
      const res = await request('PUT', `${base}/contents/${encodePath(path)}`, body);
      if (res.status === 201) return 'created';
      if (res.status === 200) return 'updated';
      if (!sha && (res.status === 422 || res.status === 409)) {
        const existing = await getFile(path);
        if (existing) return 'exists';
      }
      throw await errorFromResponse(res, now());
    }

    async function upsertFile(path, text, message) {
      const existing = await getFile(path);
      return putFile(path, text, message, existing ? existing.sha : undefined);
    }

    // [{ path, sha, size }] för alla filer i grenen
    async function listTree() {
      const res = await request('GET', `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      if (res.status === 409) return []; // tomt repo
      if (!res.ok) throw await errorFromResponse(res, now());
      const j = await res.json();
      return (j.tree || []).filter(e => e.type === 'blob').map(e => ({ path: e.path, sha: e.sha, size: e.size }));
    }

    async function getBlob(sha) {
      const res = await request('GET', `${base}/git/blobs/${encodeURIComponent(sha)}`);
      if (!res.ok) throw await errorFromResponse(res, now());
      const j = await res.json();
      return decodeBase64(j.content);
    }

    return { owner, repo, branch, getRepo, getFile, putFile, upsertFile, listTree, getBlob };
  }

  // Kontrollerar att repot finns och att token får skriva
  async function testAccess(client, deviceLabel, nowMs) {
    const info = await client.getRepo();
    const when = new Date(nowMs == null ? Date.now() : nowMs).toISOString();
    await client.upsertFile('.railtimer/anslutning.json',
      JSON.stringify({ enhet: deviceLabel || 'okänd enhet', testad: when }, null, 1),
      'Anslutningstest från RailTimer');
    return info;
  }

  // ── Uppladdningskö ──

  function normalizeState(state, repoFullName) {
    const fresh = { repo: repoFullName || null, uploadedIds: [], uploadedTrackCount: 0, backlogDone: false, lastError: null, lastSuccessAt: null, retryNotBefore: null };
    if (!state || typeof state !== 'object') return fresh;
    if (repoFullName && state.repo && state.repo !== repoFullName) return fresh; // nytt repo: börja om
    return Object.assign({}, fresh, state, {
      repo: repoFullName || state.repo || null,
      uploadedIds: Array.isArray(state.uploadedIds) ? state.uploadedIds.map(String) : [],
      uploadedTrackCount: Number(state.uploadedTrackCount) || 0
    });
  }

  function byStart(a, b) {
    return String(a.startedAt || '').localeCompare(String(b.startedAt || ''));
  }

  // Ordnad lista med uppgifter: importfiler, enskilda körningar, spår
  function planUpload(opts) {
    const state = opts.state;
    const now = opts.now == null ? Date.now() : opts.now;
    const chunk = opts.importChunk || IMPORT_CHUNK;
    const uploaded = new Set((state.uploadedIds || []).map(String));
    const logs = (opts.logs || []).filter(l => l && l.id != null);
    const pending = logs.filter(l => !uploaded.has(String(l.id))).sort(byStart);
    const tasks = [];
    if (!state.backlogDone) {
      const total = Math.ceil(pending.length / chunk);
      for (let i = 0; i < total; i++) {
        const runs = pending.slice(i * chunk, (i + 1) * chunk);
        tasks.push({
          type: 'import', part: i + 1, total, runs,
          path: importPath(now, i + 1),
          message: `Import av befintliga körningar, del ${i + 1} av ${total} (${runs.length} körningar)`
        });
      }
    } else {
      for (const log of pending) tasks.push({ type: 'run', log, path: runPath(log), message: runCommitMessage(log) });
    }
    const byId = new Map(logs.map(l => [String(l.id), l]));
    for (const runId of opts.trackIds || []) {
      const log = byId.get(String(runId));
      if (log) tasks.push({ type: 'track', runId: String(runId), log, path: trackPath(log) });
    }
    return tasks;
  }

  /* Kör kön en gång. opts: { client, logs, state, repo, trackStore, now, sleep, minIntervalMs, onProgress }
     trackStore: { list(): Promise<runId[]>, get(runId): Promise<track|undefined>, remove(runId): Promise }
     Returnerar { state, importedRuns, uploadedRuns, uploadedTracks, error, skippedUntil } */
  async function runUploadPass(opts) {
    const now = opts.now || (() => Date.now());
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const minInterval = opts.minIntervalMs == null ? MIN_WRITE_INTERVAL_MS : opts.minIntervalMs;
    const state = normalizeState(opts.state, opts.repo);
    const result = { state, importedRuns: 0, uploadedRuns: 0, uploadedTracks: 0, error: null, skippedUntil: null };

    if (state.retryNotBefore && now() < state.retryNotBefore) {
      result.skippedUntil = state.retryNotBefore;
      return result;
    }
    state.retryNotBefore = null;

    const uploaded = new Set(state.uploadedIds);
    const trackIds = opts.trackStore ? await opts.trackStore.list() : [];
    const tasks = planUpload({ logs: opts.logs, state, trackIds, now: now() });
    let lastWrite = null;

    async function pace() {
      if (lastWrite != null) {
        const wait = lastWrite + minInterval - now();
        if (wait > 0) await sleep(wait);
      }
      lastWrite = now();
    }

    async function withConflictRetry(fn) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof GitHubError) || e.kind !== 'conflict') throw e;
        await sleep(1000);
        return fn();
      }
    }

    try {
      for (const task of tasks) {
        if (task.type === 'track') {
          if (!uploaded.has(task.runId)) continue;
          const track = await opts.trackStore.get(task.runId);
          if (!track) continue;
          await pace();
          const message = trackCommitMessage(task.log, Array.isArray(track.points) ? track.points.length : 0);
          await withConflictRetry(() => opts.client.putFile(task.path, JSON.stringify(track), message));
          await opts.trackStore.remove(task.runId);
          state.uploadedTrackCount += 1;
          result.uploadedTracks += 1;
        } else if (task.type === 'import') {
          await pace();
          await withConflictRetry(() => opts.client.putFile(task.path, JSON.stringify(task.runs, null, 1), task.message));
          task.runs.forEach(r => uploaded.add(String(r.id)));
          result.importedRuns += task.runs.length;
        } else {
          await pace();
          await withConflictRetry(() => opts.client.putFile(task.path, JSON.stringify(task.log, null, 1), task.message));
          uploaded.add(String(task.log.id));
          result.uploadedRuns += 1;
        }
        state.uploadedIds = Array.from(uploaded);
        state.lastSuccessAt = new Date(now()).toISOString();
        state.lastError = null;
        if (opts.onProgress) opts.onProgress(state);
      }
      state.backlogDone = true;
    } catch (err) {
      const e = err instanceof GitHubError ? err : new GitHubError('unknown', String((err && err.message) || err));
      result.error = e;
      state.lastError = { at: new Date(now()).toISOString(), kind: e.kind, message: e.message };
      if (e.kind === 'ratelimit') state.retryNotBefore = now() + (e.retryAfterMs == null ? 60000 : e.retryAfterMs);
    }
    if (opts.onProgress) opts.onProgress(state);
    return result;
  }

  // ── Hämtning till analysen ──

  function mergeRuns(importLists, singleRuns) {
    const byKey = new Map();
    function add(run) {
      if (!run || typeof run !== 'object') return;
      const key = run.id != null ? String(run.id) : `${run.trainNumber || ''}|${run.startedAt || ''}`;
      byKey.set(key, run);
    }
    (importLists || []).forEach(list => (Array.isArray(list) ? list : []).forEach(add));
    (singleRuns || []).forEach(add);
    return Array.from(byKey.values());
  }

  /* cache: { get(sha): Promise<json|undefined>, set(sha, json): Promise } (valfri)
     Returnerar { runs, newFiles, totalFiles, trackFiles, errors } */
  async function loadRunsFromRepo(opts) {
    const files = await opts.client.listTree();
    const wanted = files
      .filter(f => /\.json$/i.test(f.path) && (f.path.startsWith('korningar/') || f.path.startsWith('import/')))
      .sort((a, b) => a.path.localeCompare(b.path));
    const trackFiles = files.filter(f => f.path.startsWith('gps-spar/')).length;
    const parsed = new Map();
    const errors = [];
    let newFiles = 0;
    const queue = wanted.slice();

    async function worker() {
      while (queue.length) {
        const f = queue.shift();
        try {
          let json = opts.cache ? await opts.cache.get(f.sha) : undefined;
          if (json === undefined) {
            json = JSON.parse(await opts.client.getBlob(f.sha));
            newFiles += 1;
            if (opts.cache) await opts.cache.set(f.sha, json);
          }
          parsed.set(f.path, json);
        } catch (e) {
          if (e instanceof GitHubError) throw e;
          errors.push({ path: f.path, message: e.message });
        }
      }
    }

    const workers = Math.max(1, Math.min(opts.concurrency || 6, queue.length));
    await Promise.all(Array.from({ length: workers }, worker));
    const imports = wanted.filter(f => f.path.startsWith('import/') && parsed.has(f.path)).map(f => parsed.get(f.path));
    const singles = wanted.filter(f => f.path.startsWith('korningar/') && parsed.has(f.path)).map(f => parsed.get(f.path));
    return { runs: mergeRuns(imports, singles), newFiles, totalFiles: wanted.length, trackFiles, errors };
  }

  return {
    API, IMPORT_CHUNK, MIN_WRITE_INTERVAL_MS, DEFAULT_REPO, MESSAGES, GitHubError,
    parseRepo, localDate, runPath, trackPath, importPath, runCommitMessage, trackCommitMessage,
    encodeBase64, decodeBase64, createClient, testAccess,
    normalizeState, planUpload, runUploadPass, mergeRuns, loadRunsFromRepo
  };
});
```

- [ ] **Step 5: Kör alla Node-tester**

Run: `node --test "tests/*.test.js"`
Expected: `ℹ pass 39` och `ℹ fail 0`, varav 14 för avbrottsmodulen och 25 för GitHub-modulen.

- [ ] **Step 6: Committa**

```bash
git add railtimer-github.js tests/fake-github.js tests/railtimer-github.test.js
git commit -m "GitHub-modul: klient, sökvägar, uppladdningskö och hämtning till analysen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: GPS-spår i appen

**Files:**
- Modify: `index.html` (skripttaggar, `GH`, spårfunktioner, `TrackStore`, `initJourneyState`, `handlePosition`, `saveLog`, `stopJourney`, `handleVisibilityChange`, `resumeJourney`, `exposeTestHooks`)
- Modify: `tests/replay.html`
- Modify: `Kinnekulle GPS.html` (kopia)

**Interfaces:**
- Consumes: `RailTimerGitHub.trackPath` (Task 5), `state.journeyId` (Task 3)
- Produces:
  - `TrackStore.{put(track), get(runId), remove(runId), list()}`, med samma form som `trackStore` i `runUploadPass`
  - `flushTrack() → Promise`
  - `onAppHidden() → Promise`
  - `restoreTrack(runId)`
  - Fältet `trackPath` i körningen
  - Testkrokarna `onAppHidden` och `getTrack(runId)`

- [ ] **Step 1: Skriv testerna. Lägg till före `// ── Körning ──` i `tests/replay.html`.**

```js
// ── Task 6: GPS-spår ──

test('GPS-spår: varje position sparas och kopplas till körningen', async () => {
  const fixes = buildJourney();
  const r = await runJourney(fixes);
  const track = await r.rt.getTrack(r.log.id);
  assert(track, 'spåret saknas');
  assertEqual(track.points.length, r.fed.length, 'antal punkter');
  assertEqual(track.fields, ['t_ms', 'lat', 'lon', 'acc_m', 'speed_ms', 'heading_deg', 'fixAge_ms'], 'fält');
  const round6 = v => Math.round(v * 1e6) / 1e6;
  assertEqual(track.points[0], [0, round6(STATIONS[0][1]), round6(STATIONS[0][2]), 5, 0, null, 0], 'första punkten');
  assertEqual(r.log.trackPath, r.w.RailTimerGitHub.trackPath(r.log), 'trackPath');
});

test('GPS-spår: resa som avslutas innan någon position kommit får inget spår', async () => {
  const w = await loadApp();
  await clearAppStorage(w);
  installClock(w, START);
  const rt = w.__railtimer;
  const route = STATIONS.map((s, i) => rt.makeRouteStation({ name: s[0], lat: s[1], lon: s[2], sig: s[3], radius: 200 }, i));
  rt.initJourneyState(route, { trainNumber: 'TEST', vehicleType: 'Y31', notes: '' });
  rt.stopJourney(false, 'Avslutad manuellt');
  await realSleep(150);
  const logs = rt.loadLogs();
  const log = logs[logs.length - 1];
  assertEqual(log.trackPath, undefined, 'trackPath');
  assertEqual(await rt.getTrack(log.id), undefined, 'spår');
});

test('GPS-spår: fortsätter efter omladdning och Återuppta resa', async () => {
  const fixes = buildJourney();
  const call = twoStationCall(fixes);
  const r = await runJourney(fixes, { drop: call.drop, reloadBefore: call.resume });
  const track = await r.rt.getTrack(r.log.id);
  assertEqual(track.points.length, r.fed.length, 'antal punkter efter omladdning');
});

```

- [ ] **Step 2: Kör testerna och kontrollera att de misslyckas**

Run: `node tests/run-browser-tests.mjs GPS-spår`
Expected: `✖` med `r.rt.getTrack is not a function` eller `rt.getTrack is not a function`.

- [ ] **Step 3: Ladda GitHub-modulen**

Ersätt:
```html
<script src="railtimer-avbrott.js"></script>
<script>
(function(){
  'use strict';

  const APP_VERSION = '2026-10-15';
  const AV = window.RailTimerAvbrott || null; // avbrott i mätningen (railtimer-avbrott.js)
```
med:
```html
<script src="railtimer-avbrott.js"></script>
<script src="railtimer-github.js"></script>
<script>
(function(){
  'use strict';

  const APP_VERSION = '2026-10-15';
  const AV = window.RailTimerAvbrott || null; // avbrott i mätningen (railtimer-avbrott.js)
  const GH = window.RailTimerGitHub || null;  // uppladdning till GitHub (railtimer-github.js)
```

- [ ] **Step 4: Spårets lagring och funktioner. Spåret startar med resan.**

Ersätt:
```js
    state.interruptions=[];
    state.lastFix=null;
    state.interruptionTipShown=false;
  }
```
med:
```js
    state.interruptions=[];
    state.lastFix=null;
    state.interruptionTipShown=false;
    startTrack(state.journeyId);
  }

  // ── GPS-spår ──
  // Varje position under en resa sparas i IndexedDB (databas railtimer, lager tracks).
  // Saknas IndexedDB hålls spåret i minnet tills det är uppladdat.
  const TRACK_FIELDS=['t_ms','lat','lon','acc_m','speed_ms','heading_deg','fixAge_ms'];
  const TRACK_FLUSH_MS=30000;
  const track={ runId:null, t0:null, points:[], dirty:false, lastFlush:0 };

  const TrackStore=(function(){
    const memory=new Map();
    let dbPromise=null;
    function open(){
      if(!dbPromise){
        dbPromise=new Promise((resolve, reject)=>{
          if(!window.indexedDB){ reject(new Error('IndexedDB saknas')); return; }
          const req=indexedDB.open('railtimer', 1);
          req.onupgradeneeded=()=>{ req.result.createObjectStore('tracks', { keyPath:'runId' }); };
          req.onsuccess=()=>resolve(req.result);
          req.onerror=()=>reject(req.error);
        });
        dbPromise.catch(()=>{});
      }
      return dbPromise;
    }
    // Returnerar { value } från IndexedDB, eller null om IndexedDB inte går att använda
    async function withStore(mode, fn){
      let db;
      try{ db=await open(); }catch(e){ return null; }
      return new Promise((resolve, reject)=>{
        const tx=db.transaction('tracks', mode);
        const req=fn(tx.objectStore('tracks'));
        tx.oncomplete=()=>resolve({ value:req?req.result:undefined });
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(tx.error);
      });
    }
    return {
      async put(t){ const r=await withStore('readwrite', s=>s.put(t)); if(!r) memory.set(t.runId, t); },
      async get(runId){ const r=await withStore('readonly', s=>s.get(runId)); return r ? r.value : memory.get(runId); },
      async remove(runId){ memory.delete(runId); await withStore('readwrite', s=>s.delete(runId)); },
      async list(){ const r=await withStore('readonly', s=>s.getAllKeys()); return r ? r.value.map(String) : Array.from(memory.keys()); }
    };
  })();

  function startTrack(runId){
    track.runId=runId;
    track.t0=null;
    track.points=[];
    track.dirty=false;
    track.lastFlush=Date.now();
  }

  function roundTo(v, decimals){
    if(v==null || isNaN(v)) return null;
    const f=10**decimals;
    return Math.round(v*f)/f;
  }

  function appendTrackPoint(pos, nowMs){
    if(!track.runId) return;
    if(track.t0==null) track.t0=nowMs;
    const c=pos.coords;
    track.points.push([
      nowMs-track.t0,
      roundTo(c.latitude, 6),
      roundTo(c.longitude, 6),
      c.accuracy==null ? null : Math.round(c.accuracy),
      roundTo(c.speed, 2),
      c.heading==null || isNaN(c.heading) ? null : Math.round(c.heading),
      pos.timestamp ? Math.round(nowMs-pos.timestamp) : null
    ]);
    track.dirty=true;
    if(nowMs-track.lastFlush>=TRACK_FLUSH_MS) flushTrack();
  }

  function trackObject(){
    return { format:1, runId:track.runId, trainNumber:state.trainNumber||'', t0:new Date(track.t0).toISOString(), fields:TRACK_FIELDS, points:track.points };
  }

  function flushTrack(){
    if(!track.runId || !track.dirty || track.t0==null) return Promise.resolve();
    track.dirty=false;
    track.lastFlush=Date.now();
    return TrackStore.put(trackObject()).catch(e=>{
      track.dirty=true;
      console.warn('Kunde inte spara GPS-spåret', e);
    });
  }

  // Appen går till bakgrunden (t.ex. vid samtal): spara resan och spåret direkt,
  // ifall webbläsaren stänger sidan medan den ligger i bakgrunden
  function onAppHidden(){
    if(!state.running) return Promise.resolve();
    saveActiveJourney();
    return flushTrack();
  }

  // "Återuppta resa": fortsätt fylla på det sparade spåret
  async function restoreTrack(runId){
    startTrack(runId);
    try{
      const saved=await TrackStore.get(runId);
      if(saved && Array.isArray(saved.points)){
        track.points=saved.points;
        track.t0=Date.parse(saved.t0);
      }
    }catch(e){
      console.warn('Kunde inte läsa GPS-spåret', e);
    }
  }
```

- [ ] **Step 5: Varje position läggs till i spåret**

Ersätt:
```js
    updateGpsStatus(pos);
    if(!state.running) return;
    const lat=pos.coords.latitude;
    const lon=pos.coords.longitude;
    const acc=pos.coords.accuracy;
    checkForInterruption({ t:state.lastFixTime, lat, lon });
```
med:
```js
    updateGpsStatus(pos);
    if(!state.running) return;
    appendTrackPoint(pos, state.lastFixTime);
    const lat=pos.coords.latitude;
    const lon=pos.coords.longitude;
    const acc=pos.coords.accuracy;
    checkForInterruption({ t:state.lastFixTime, lat, lon });
```

- [ ] **Step 6: `trackPath` i körningen, och spåret sparas när resan slutar och när appen går till bakgrunden**

Ersätt:
```js
    // Tider som registrerades under ett avbrott sparas aldrig som riktiga tider
    if(AV) entry.stops=AV.applyInterruptionWindows(entry.stops, entry.interruptions);
```
med:
```js
    // Tider som registrerades under ett avbrott sparas aldrig som riktiga tider
    if(AV) entry.stops=AV.applyInterruptionWindows(entry.stops, entry.interruptions);
    if(GH && track.runId===entry.id && track.points.length) entry.trackPath=GH.trackPath(entry);
```
Ersätt:
```js
    // Rapporten visas ensam överst; startformuläret kommer först via "Starta ny mätning"
    showView('report');
  }
```
med:
```js
    // Rapporten visas ensam överst; startformuläret kommer först via "Starta ny mätning"
    showView('report');
    flushTrack();
  }
```
Ersätt:
```js
    }else if(document.visibilityState==='hidden'){
      // Save journey when going to background
      if(state.running){
        saveActiveJourney();
      }
    }
```
med:
```js
    }else if(document.visibilityState==='hidden'){
      onAppHidden();
    }
```

- [ ] **Step 7: "Återuppta resa" läser in spåret innan GPS:en startar**

Ersätt:
```js
  function resumeJourney(saved){
    // Restore state
```
med:
```js
  async function resumeJourney(saved){
    // Restore state
```
Ersätt:
```js
    renderedRouteKey='';
    renderRouteCards();
    renderRouteMap();
    requestGpsWatch();
    enableWakeLockForJourney();

    showJourneyMessage('Resa återupptagen!', false);
```
med:
```js
    renderedRouteKey='';
    renderRouteCards();
    renderRouteMap();
    await restoreTrack(state.journeyId); // innan GPS:en startar, så att inga punkter skrivs över
    requestGpsWatch();
    enableWakeLockForJourney();

    showJourneyMessage('Resa återupptagen!', false);
```

- [ ] **Step 8: Testkrokar**

Ersätt:
```js
      loadLogs, loadActiveJourney, resumeJourney, showView, renderRouteCards
    };
```
med:
```js
      loadLogs, loadActiveJourney, resumeJourney, showView, renderRouteCards, onAppHidden,
      getTrack: runId => TrackStore.get(runId)
    };
```

- [ ] **Step 9: Kör testerna**

Run: `node tests/run-browser-tests.mjs`
Expected: `12 lyckades, 0 misslyckades`. Regressionen ska också gå igenom.

- [ ] **Step 10: Uppdatera kopian och committa**

```bash
cp index.html "Kinnekulle GPS.html" && cmp index.html "Kinnekulle GPS.html"
git add index.html "Kinnekulle GPS.html" tests/replay.html
git commit -m "GPS-spår spelas in för varje resa och sparas i IndexedDB

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Uppladdning i appen

**Files:**
- Modify: `index.html` (HTML för inställningsvyn, CSS, menyval, konstanter, variabler, Statistik/överlagring, uppladdningsfunktioner, `bindEvents`, `showView`, `stopJourney`, `init`, `handleVisibilityChange`, `exposeTestHooks`)
- Modify: `tests/replay.html`
- Modify: `Kinnekulle GPS.html` (kopia)

**Interfaces:**
- Consumes:
  - `RailTimerGitHub.{createClient, parseRepo, runUploadPass, testAccess, normalizeState, DEFAULT_REPO}` (Task 5)
  - `TrackStore` och `flushTrack` (Task 6)
- Produces:
  - `scheduleUpload() → Promise<result|null>`
  - `whenUploadIdle() → Promise<null>`
  - `showUploadSettings()`, `saveAndTestGithub()`, `uploadNow()`, `removeGithubToken()`, `renderUploadStatus()` och `closeOverlay()`
  - Testkrokarna `setFetchForTest(fn)`, `scheduleUpload`, `whenUploadIdle`, `showUploadSettings` och `saveAndTestGithub`

- [ ] **Step 1: Skriv testerna. Lägg till före `// ── Körning ──` i `tests/replay.html`.**

```js
// ── Task 7: uppladdning i appen ──

// Ett minimalt simulerat GitHub i webbläsaren (samma svar som tests/fake-github.js)
function browserFakeGitHub(w, opts) {
  const o = opts || {};
  const files = new Map();
  const calls = [];
  let n = 0;
  const GH = w.RailTimerGitHub;
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  async function fetch(url, init) {
    const method = ((init && init.method) || 'GET').toUpperCase();
    const p = new URL(url).pathname;
    calls.push({ method, path: p });
    if (o.offline) throw new TypeError('Failed to fetch');
    let m;
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(p)) return resp(200, { private: true, default_branch: 'main', full_name: 'AKjork/railtimer-data' });
    if ((m = p.match(/\/contents\/(.+)$/))) {
      const path = decodeURIComponent(m[1]);
      if (method === 'GET') { const f = files.get(path); return f ? resp(200, { sha: f.sha, content: GH.encodeBase64(f.text) }) : resp(404, { message: 'Not Found' }); }
      const body = JSON.parse(init.body);
      const f = files.get(path);
      if (f && body.sha !== f.sha) return resp(422, { message: 'sha' });
      const sha = 'sha' + (++n);
      files.set(path, { sha, text: GH.decodeBase64(body.content), message: body.message });
      return resp(f ? 200 : 201, { content: { sha } });
    }
    if (method === 'GET' && /\/git\/trees\//.test(p)) {
      return resp(200, { truncated: false, tree: Array.from(files, ([path, f]) => ({ path, sha: f.sha, type: 'blob', size: f.text.length })) });
    }
    if (method === 'GET' && (m = p.match(/\/git\/blobs\/(.+)$/))) {
      const f = Array.from(files.values()).find(x => x.sha === m[1]);
      return f ? resp(200, { content: GH.encodeBase64(f.text), encoding: 'base64' }) : resp(404, { message: 'Not Found' });
    }
    return resp(500, { message: 'okänt anrop' });
  }
  function put(path, text) { files.set(path, { sha: 'sha' + (++n), text }); }
  return { fetch, files, calls, put };
}

function configureUpload(w, fake) {
  w.__railtimer.setFetchForTest(fake.fetch);
  w.localStorage.setItem('railtimer_github_v1', JSON.stringify({ repo: 'AKjork/railtimer-data', token: 'test-token', branch: 'main' }));
  w.localStorage.setItem('railtimer_upload_v1', JSON.stringify({ repo: 'AKjork/railtimer-data', uploadedIds: [], backlogDone: true }));
}

test('uppladdning: resan och spåret laddas upp när resan är klar', async () => {
  let fake;
  const r = await runJourney(buildJourney(), { beforeStart: async w => { fake = browserFakeGitHub(w); configureUpload(w, fake); } });
  await r.rt.whenUploadIdle();
  const GH = r.w.RailTimerGitHub;
  const run = fake.files.get(GH.runPath(r.log));
  assert(run, 'körningen saknas i repot');
  assertEqual(JSON.parse(run.text).id, r.log.id, 'körningens id');
  const track = fake.files.get(GH.trackPath(r.log));
  assert(track, 'spåret saknas i repot');
  assertEqual(JSON.parse(track.text).points.length, r.fed.length, 'spårets punkter');
  assertEqual(await r.rt.getTrack(r.log.id), undefined, 'spåret ska tas bort från telefonen');
  const state = JSON.parse(r.w.localStorage.getItem('railtimer_upload_v1'));
  assertEqual(state.uploadedIds, [r.log.id], 'uppladdade id');
  assertEqual(state.uploadedTrackCount, 1, 'antal spår');
});

test('uppladdning: utan täckning väntar resan och laddas upp nästa gång', async () => {
  const r = await runJourney(buildJourney(), { beforeStart: async w => configureUpload(w, browserFakeGitHub(w, { offline: true })) });
  await r.rt.whenUploadIdle();
  let state = JSON.parse(r.w.localStorage.getItem('railtimer_upload_v1'));
  assertEqual(state.uploadedIds, [], 'inget uppladdat utan täckning');
  assertEqual(state.lastError && state.lastError.kind, 'network', 'felet');
  r.rt.setFetchForTest(browserFakeGitHub(r.w).fetch);
  await r.rt.scheduleUpload();
  state = JSON.parse(r.w.localStorage.getItem('railtimer_upload_v1'));
  assertEqual(state.uploadedIds, [r.log.id], 'uppladdad när nätet kom tillbaka');
});

test('uppladdning: avbruten resa laddas också upp, med flaggan aborted', async () => {
  let fake;
  const fixes = buildJourney();
  const stopAt = fixes.find(f => f.leg === 2 && f.frac >= 0.5).t;
  const r = await runJourney(fixes, { drop: f => f.t > stopAt, beforeStart: async w => { fake = browserFakeGitHub(w); configureUpload(w, fake); } });
  r.rt.stopJourney(true, 'Resan avbröts manuellt');
  await r.rt.whenUploadIdle();
  const logs = r.rt.loadLogs();
  const log = logs[logs.length - 1];
  const file = fake.files.get(r.w.RailTimerGitHub.runPath(log));
  assert(file, 'den avbrutna resan saknas i repot');
  assertEqual(JSON.parse(file.text).aborted, true, 'aborted');
});

test('uppladdning: inställningsvyn testar anslutningen och sparar repo och token', async () => {
  const w = await loadApp();
  await clearAppStorage(w);
  const fake = browserFakeGitHub(w);
  w.__railtimer.setFetchForTest(fake.fetch);
  w.__railtimer.showUploadSettings();
  const d = w.document;
  assertEqual(d.getElementById('ghRepo').value, 'AKjork/railtimer-data', 'förifyllt repo');
  d.getElementById('ghToken').value = '  github_pat_test\n'; // inklistrad med mellanslag och radbrytning
  await w.__railtimer.saveAndTestGithub();
  assertEqual(d.getElementById('ghTestResult').textContent, 'Ansluten – repot är privat och token kan skriva.', 'resultat');
  assertEqual(JSON.parse(w.localStorage.getItem('railtimer_github_v1')), { repo: 'AKjork/railtimer-data', token: 'github_pat_test', branch: 'main' }, 'sparade inställningar');
  assertEqual(d.getElementById('ghToken').value, '', 'tokenfältet töms');
  assert(fake.files.has('.railtimer/anslutning.json'), 'anslutningsfilen skrevs');
});

```

- [ ] **Step 2: Kör testerna och kontrollera att de misslyckas**

Run: `node tests/run-browser-tests.mjs uppladdning`
Expected: `✖` med `w.__railtimer.setFetchForTest is not a function`.

- [ ] **Step 3: HTML för inställningsvyn, CSS och menyval**

Ersätt:
```html
    <div id="statsContent"></div>
  </section>

</main>
```
med:
```html
    <div id="statsContent"></div>
  </section>

  <section id="settings" style="display:none">
    <h2>Uppladdning till GitHub</h2>
    <p class="hint">Varje resa laddas upp automatiskt till ditt privata repo när den är klar. Token sparas bara på den här enheten.</p>
    <div class="form-group">
      <label for="ghRepo">Repo</label>
      <input id="ghRepo" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="AKjork/railtimer-data">
    </div>
    <div class="form-group">
      <label for="ghToken">Token</label>
      <input id="ghToken" type="password" autocomplete="off" placeholder="github_pat_…">
    </div>
    <p class="hint"><a id="ghTokenLink" target="_blank" rel="noopener">Skapa token hos GitHub</a> – välj repot under "Only select repositories".</p>
    <div class="settings-actions">
      <button id="btnGhSave" class="primary">Spara och testa</button>
      <button id="btnGhUploadNow" class="ghost">Ladda upp nu</button>
    </div>
    <p id="ghTestResult" class="meta" role="status" aria-live="polite"></p>
    <div id="uploadStatus" class="upload-status"></div>
    <div class="settings-actions">
      <button id="btnGhRemove" class="danger">Ta bort token</button>
      <button id="btnCloseSettings" class="ghost">Stäng</button>
    </div>
  </section>

</main>
```
Ersätt:
```css
  .toast.err{border-color:var(--err);color:var(--err)}
```
med:
```css
  .toast.err{border-color:var(--err);color:var(--err)}

  /* Uppladdning */
  .settings-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin:.75rem 0}
  .settings-actions button{flex:1;min-height:2.75rem;font-size:.95rem}
  .upload-status{border:1px solid var(--b);border-radius:8px;padding:.75rem;background:var(--card-bg);font-size:.85rem;color:var(--ink-dim);line-height:1.6;font-variant-numeric:tabular-nums}
  .upload-status strong{color:var(--ink)}
  #ghTestResult.ok{color:var(--pri)}
  #ghTestResult.err{color:var(--err)}
  .hint a{color:var(--pri)}
```
Ersätt:
```html
        <button id="btnStatistics">Statistik</button>
```
med:
```html
        <button id="btnStatistics">Statistik</button>
        <button id="btnUploadSettings">Uppladdning</button>
```

- [ ] **Step 4: Konstanter och variabler**

Ersätt:
```js
  const STORAGE_KEY_ACTIVE_JOURNEY = 'railtimer_active_journey_v1';
```
med:
```js
  const STORAGE_KEY_ACTIVE_JOURNEY = 'railtimer_active_journey_v1';
  const STORAGE_KEY_GITHUB = 'railtimer_github_v1';   // { repo, token, branch } – bara på den här enheten
  const STORAGE_KEY_UPLOAD = 'railtimer_upload_v1';   // uppladdningsköns tillstånd
  const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=RailTimer&description=Uppladdning+till+railtimer-data&target_name=AKjork&expires_in=none&contents=write';
```
Ersätt:
```js
  let statsReturnView = null; // Vilka vyer som var synliga innan Statistik öppnades
```
med:
```js
  let overlayReturnView = null; // Vyn som var öppen innan Statistik eller Uppladdning öppnades
  let uploadPromise = null;     // pågående körning av uppladdningskön
  let afterJourneyPromise = null; // sparning av spåret och uppladdning efter senaste resan
  let testFetch = null;         // simulerat GitHub i testerna
```

- [ ] **Step 5: Gemensam stängning för överlagringsvyer, plus uppladdningsfunktionerna**

Ersätt:
```js
  // === Statistics ===
  function showStatistics(){
    if(currentView!=='statistics') statsReturnView=currentView;
    showView('statistics');
    populateStatsFilters();
    renderStatistics();
  }

  // Tillbaka till vyn som var öppen – en pågående resa ska alltid gå att komma tillbaka till
  function hideStatistics(){
    const target = state.running ? 'journey' : (statsReturnView || 'setup');
    statsReturnView=null;
    showView(target);
    if(target==='journey'){
      renderRouteCards();
      renderRouteMap();
    }
  }
```
med:
```js
  // === Statistics ===
  function showStatistics(){
    rememberOverlayReturn();
    showView('statistics');
    populateStatsFilters();
    renderStatistics();
  }

  function rememberOverlayReturn(){
    if(currentView!=='statistics' && currentView!=='settings') overlayReturnView=currentView;
  }

  // Tillbaka till vyn som var öppen – en pågående resa ska alltid gå att komma tillbaka till
  function closeOverlay(){
    const target = state.running ? 'journey' : (overlayReturnView || 'setup');
    overlayReturnView=null;
    showView(target);
    if(target==='journey'){
      renderRouteCards();
      renderRouteMap();
    }
  }

  function hideStatistics(){
    closeOverlay();
  }

  // === Uppladdning till GitHub ===

  function loadGithubSettings(){
    try{
      const s=JSON.parse(localStorage.getItem(STORAGE_KEY_GITHUB)||'null');
      return s && s.repo && s.token ? s : null;
    }catch(e){ return null; }
  }

  function loadUploadState(){
    try{ return JSON.parse(localStorage.getItem(STORAGE_KEY_UPLOAD)||'null'); }catch(e){ return null; }
  }

  function saveUploadState(s){
    try{ localStorage.setItem(STORAGE_KEY_UPLOAD, JSON.stringify(s)); }catch(e){}
  }

  function githubClient(settings){
    const repo=GH && GH.parseRepo(settings.repo);
    if(!repo) return null;
    return GH.createClient({ owner:repo.owner, repo:repo.repo, token:settings.token, branch:settings.branch||'main', fetch:testFetch||undefined });
  }

  // Kör uppladdningskön en gång. Körs aldrig medan en resa pågår, för att inte störa mätningen.
  function scheduleUpload(){
    if(uploadPromise) return uploadPromise;
    const settings=loadGithubSettings();
    if(!GH || !settings || state.running) return Promise.resolve(null);
    const client=githubClient(settings);
    if(!client) return Promise.resolve(null);
    uploadPromise=GH.runUploadPass({
      client,
      repo:`${client.owner}/${client.repo}`,
      logs:loadLogs(),
      state:loadUploadState(),
      trackStore:TrackStore,
      onProgress:saveUploadState
    }).then(result=>{
      saveUploadState(result.state);
      renderUploadStatus();
      return result;
    }).catch(err=>{
      console.warn('Uppladdningen misslyckades', err);
      return null;
    }).finally(()=>{ uploadPromise=null; });
    return uploadPromise;
  }

  // Väntar tills uppladdningen efter en resa (och en pågående körning av kön) är klar
  function whenUploadIdle(){
    return Promise.resolve(afterJourneyPromise).then(()=>uploadPromise).then(()=>null);
  }

  // Efter en avslutad resa: ladda upp och berätta hur det gick
  function afterJourneyUpload(){
    if(!loadGithubSettings()) return null;
    return scheduleUpload().then(result=>{
      if(result && !result.error && result.uploadedRuns+result.importedRuns>0){
        showHeaderStatus('Resan uppladdad', false);
      }else if(result && result.error && result.error.kind!=='network'){
        showHeaderStatus(result.error.message, true);
      }else{
        showHeaderStatus('Väntar på uppladdning', false);
      }
      return result;
    });
  }

  function showUploadSettings(){
    rememberOverlayReturn();
    const s=loadGithubSettings();
    document.getElementById('ghRepo').value = s ? s.repo : (GH ? GH.DEFAULT_REPO : '');
    const tokenInput=document.getElementById('ghToken');
    tokenInput.value='';
    tokenInput.placeholder = s ? '•••• sparad – lämna tomt för att behålla' : 'github_pat_…';
    document.getElementById('ghTokenLink').href=TOKEN_URL;
    setGhResult('', false);
    renderUploadStatus();
    showView('settings');
  }

  function setGhResult(text, isError){
    const el=document.getElementById('ghTestResult');
    el.textContent=text;
    el.className='meta'+(text ? (isError ? ' err' : ' ok') : '');
  }

  function deviceLabel(){
    const ua=navigator.userAgent||'';
    const kind=/iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'okänd enhet';
    return `${kind} · RailTimer ${APP_VERSION}`;
  }

  async function saveAndTestGithub(){
    if(!GH){ setGhResult('Uppladdningsmodulen kunde inte laddas – ladda om sidan.', true); return; }
    const repo=GH.parseRepo(document.getElementById('ghRepo').value || GH.DEFAULT_REPO);
    if(!repo){ setGhResult('Ange repot som ägare/namn, t.ex. AKjork/railtimer-data.', true); return; }
    const existing=loadGithubSettings();
    const token=document.getElementById('ghToken').value.trim() || (existing && existing.token) || '';
    if(!token){ setGhResult('Klistra in din token.', true); return; }
    const settings={ repo:`${repo.owner}/${repo.repo}`, token, branch:'main' };
    setGhResult('Testar anslutningen…', false);
    try{
      const info=await GH.testAccess(githubClient(settings), deviceLabel());
      localStorage.setItem(STORAGE_KEY_GITHUB, JSON.stringify(settings));
      document.getElementById('ghToken').value='';
      document.getElementById('ghToken').placeholder='•••• sparad – lämna tomt för att behålla';
      if(info.private) setGhResult('Ansluten – repot är privat och token kan skriva.', false);
      else setGhResult('Ansluten, men repot är PUBLIKT – dina mätningar blir synliga för alla.', true);
      renderUploadStatus();
      scheduleUpload();
    }catch(err){
      setGhResult(err && err.message ? err.message : 'Kunde inte ansluta.', true);
    }
  }

  async function uploadNow(){
    if(!loadGithubSettings()){ setGhResult('Spara repo och token först.', true); return; }
    if(state.running){ setGhResult('Uppladdningen körs när resan är avslutad.', false); return; }
    setGhResult('Laddar upp…', false);
    const result=await scheduleUpload();
    if(!result) setGhResult('Inget att ladda upp just nu.', false);
    else if(result.error) setGhResult(result.error.message, result.error.kind!=='network');
    else if(result.skippedUntil) setGhResult(`GitHub begränsar – nästa försök ${formatClock(result.skippedUntil)}.`, false);
    else setGhResult(`Klart: ${result.importedRuns+result.uploadedRuns} körningar och ${result.uploadedTracks} spår uppladdade.`, false);
  }

  function removeGithubToken(){
    if(!confirm('Ta bort token från den här enheten? Mätningarna i repot påverkas inte.')) return;
    localStorage.removeItem(STORAGE_KEY_GITHUB);
    showUploadSettings();
    setGhResult('Token borttagen från enheten.', false);
  }

  async function renderUploadStatus(){
    const el=document.getElementById('uploadStatus');
    if(!el) return;
    const settings=loadGithubSettings();
    if(!settings){ el.textContent='Uppladdning är inte inställd.'; return; }
    if(!GH){ el.textContent='Uppladdningsmodulen saknas – ladda om sidan.'; return; }
    const st=GH.normalizeState(loadUploadState(), settings.repo);
    const uploaded=new Set(st.uploadedIds);
    const waitingRuns=loadLogs().filter(l=>!uploaded.has(String(l.id))).length;
    let waitingTracks=0;
    try{
      waitingTracks=(await TrackStore.list()).filter(id=>!(state.running && id===state.journeyId)).length;
    }catch(e){}
    const lines=[`<strong>Uppladdat:</strong> ${uploaded.size} körningar, ${st.uploadedTrackCount} spår`];
    if(waitingRuns || waitingTracks) lines.push(`<strong>Väntar:</strong> ${waitingRuns} körningar, ${waitingTracks} spår`);
    if(st.retryNotBefore && st.retryNotBefore>Date.now()) lines.push(`GitHub begränsar – nästa försök ${formatClock(st.retryNotBefore)}`);
    if(st.lastError){
      lines.push(st.lastError.kind==='network' ? 'Väntar (ingen täckning)' : `<strong>Senaste fel:</strong> ${escapeHtml(st.lastError.message)} (${formatClock(st.lastError.at)})`);
    }else if(st.lastSuccessAt){
      lines.push(`Senast uppladdat ${new Date(st.lastSuccessAt).toLocaleString('sv-SE')}`);
    }
    el.innerHTML=lines.join('<br>');
  }
```

- [ ] **Step 6: Knappar, vyn och utlösare**

Ersätt:
```js
    document.getElementById('btnCloseStats').addEventListener('click', hideStatistics);
```
med:
```js
    document.getElementById('btnCloseStats').addEventListener('click', hideStatistics);

    // Uppladdning
    document.getElementById('btnUploadSettings').addEventListener('click', () => {
      closeAllMenus();
      showUploadSettings();
    });
    document.getElementById('btnGhSave').addEventListener('click', saveAndTestGithub);
    document.getElementById('btnGhUploadNow').addEventListener('click', uploadNow);
    document.getElementById('btnGhRemove').addEventListener('click', removeGithubToken);
    document.getElementById('btnCloseSettings').addEventListener('click', closeOverlay);
    window.addEventListener('online', () => { scheduleUpload(); });
```
Ersätt:
```js
    document.getElementById('statistics').style.display = view==='statistics' ? 'block' : 'none';
```
med:
```js
    document.getElementById('statistics').style.display = view==='statistics' ? 'block' : 'none';
    document.getElementById('settings').style.display = view==='settings' ? 'block' : 'none';
```
Ersätt:
```js
    showView('report');
    flushTrack();
  }
```
med:
```js
    showView('report');
    // Spåret sparas klart innan uppladdningen läser det
    afterJourneyPromise=flushTrack().then(afterJourneyUpload);
  }
```
Ersätt:
```js
    await loadAllStations();
    getUserLocation();
    checkForInterruptedJourney();
  }
```
med:
```js
    await loadAllStations();
    getUserLocation();
    checkForInterruptedJourney();
    scheduleUpload();
  }
```
Ersätt:
```js
      // Ett avbrott upptäcks och meddelas vid nästa GPS-position (checkForInterruption)
    }else if(document.visibilityState==='hidden'){
```
med:
```js
      // Ett avbrott upptäcks och meddelas vid nästa GPS-position (checkForInterruption)
      scheduleUpload();
    }else if(document.visibilityState==='hidden'){
```

- [ ] **Step 7: Testkrokar**

Ersätt:
```js
      loadLogs, loadActiveJourney, resumeJourney, showView, renderRouteCards, onAppHidden,
      getTrack: runId => TrackStore.get(runId)
    };
```
med:
```js
      loadLogs, loadActiveJourney, resumeJourney, showView, renderRouteCards, onAppHidden,
      getTrack: runId => TrackStore.get(runId),
      setFetchForTest: fn => { testFetch = fn; },
      scheduleUpload, whenUploadIdle, showUploadSettings, saveAndTestGithub
    };
```

- [ ] **Step 8: Kör testerna**

Run: `node tests/run-browser-tests.mjs`
Expected: `16 lyckades, 0 misslyckades`. Regressionen ska också gå igenom.

- [ ] **Step 9: Uppdatera kopian och committa**

```bash
cp index.html "Kinnekulle GPS.html" && cmp index.html "Kinnekulle GPS.html"
git add index.html "Kinnekulle GPS.html" tests/replay.html
git commit -m "Uppladdning till GitHub: inställningsvy, kö och automatisk uppladdning efter resan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Analysverktyget hämtar från GitHub

**Files:**
- Modify: `Analys.html` (CSS, datakällans HTML, skripttagg, konstanter, lyssnare, nya funktioner)
- Modify: `tests/replay.html`

**Interfaces:**
- Consumes: `RailTimerGitHub.{parseRepo, createClient, loadRunsFromRepo, DEFAULT_REPO}` (Task 5)
- Produces:
  - `loadFromGithub()`, `saveGithubSettings()` och `BlobCache.{get, set}`
  - I testläge: `window.__analys = { setFetchForTest, loadFromGithub, getLogs }`

- [ ] **Step 1: Skriv testerna. Lägg till före `// ── Körning ──` i `tests/replay.html`.**

```js
// ── Task 8: analysverktyget hämtar från GitHub ──

async function loadAnalys() {
  const frame = document.getElementById('app');
  await new Promise(resolve => { frame.onload = resolve; frame.src = '../Analys.html?test=1&n=' + Date.now(); });
  const w = frame.contentWindow;
  for (let i = 0; i < 100 && !w.__analys; i++) await realSleep(20);
  if (!w.__analys) throw new Error('Analysverktyget startade inte i testläge');
  return w;
}

test('analys: hämtar körningar från GitHub och bara nya filer andra gången', async () => {
  const w = await loadAnalys();
  w.localStorage.clear();
  await new Promise(resolve => { const req = w.indexedDB.deleteDatabase('railtimer-analys'); req.onsuccess = req.onerror = req.onblocked = () => resolve(); });
  w.localStorage.setItem('railtimer_github_v1', JSON.stringify({ repo: 'AKjork/railtimer-data', token: 'test-token', branch: 'main' }));
  const fake = browserFakeGitHub(w);
  const run = (id, train) => ({ id, trainNumber: train, vehicleType: 'Y31', startStation: 'Lidköping', endStation: 'Hällekis', startedAt: '2026-10-01T05:00:00.000Z', aborted: false, stops: [] });
  fake.put('import/2026-10-15T0848_befintliga-1.json', JSON.stringify([run('a', '1'), run('b', '2')]));
  fake.put('korningar/2026/2026-10-15_3_c.json', JSON.stringify(run('c', '3')));
  fake.put('gps-spar/2026/2026-10-15_3_c.json', JSON.stringify({ format: 1, points: [] }));
  w.__analys.setFetchForTest(fake.fetch);
  await w.__analys.loadFromGithub();
  assertEqual(w.__analys.getLogs().map(r => r.id).sort(), ['a', 'b', 'c'], 'körningar');
  assertEqual(w.document.getElementById('loadStatus').textContent, '3 körningar från GitHub (2 nya filer).', 'status');
  await w.__analys.loadFromGithub();
  assertEqual(w.document.getElementById('loadStatus').textContent, '3 körningar från GitHub (0 nya filer).', 'status andra gången');
});

test('analys: utan inställningar öppnas GitHub-inställningarna', async () => {
  const w = await loadAnalys();
  w.localStorage.clear();
  await w.__analys.loadFromGithub();
  assert(w.document.getElementById('ghSettings').open, 'inställningarna ska vara öppna');
  assertEqual(w.document.getElementById('ghRepo').value, 'AKjork/railtimer-data', 'förifyllt repo');
});

```

- [ ] **Step 2: Kör testerna och kontrollera att de misslyckas**

Run: `node tests/run-browser-tests.mjs analys`
Expected: `✖` med `Analysverktyget startade inte i testläge`.

- [ ] **Step 3: CSS och datakällans HTML i `Analys.html`**

Ersätt:
```css
  select,input[type="date"],input[type="file"],input[type="text"]{
```
med:
```css
  select,input[type="date"],input[type="file"],input[type="text"],input[type="password"]{
```
Ersätt:
```css
  @media (max-width:640px){
    .timetable-setup{flex-direction:column}
  }
</style>
```
med:
```css
  @media (max-width:640px){
    .timetable-setup{flex-direction:column}
  }
  .gh-settings{margin-top:.75rem}
  .gh-settings summary{cursor:pointer;color:var(--ink-dim);font-size:.85rem}
</style>
```
Ersätt:
```html
    <div class="filters">
      <button id="btnLoadLocal" class="primary">Ladda från RailTimer</button>
      <span style="color:var(--mut);font-size:.85rem">eller</span>
      <div class="filter-group">
        <label>Importera JSON-fil(er)</label>
        <input type="file" id="fileInput" accept=".json" multiple>
      </div>
    </div>
    <div id="loadStatus" class="meta"></div>
  </div>
```
med:
```html
    <div class="filters">
      <button id="btnLoadGithub" class="primary">Hämta från GitHub</button>
      <button id="btnLoadLocal" class="ghost">Ladda från RailTimer</button>
      <span style="color:var(--mut);font-size:.85rem">eller</span>
      <div class="filter-group">
        <label>Importera JSON-fil(er)</label>
        <input type="file" id="fileInput" accept=".json" multiple>
      </div>
    </div>
    <div id="loadStatus" class="meta"></div>
    <details id="ghSettings" class="gh-settings">
      <summary>GitHub-inställningar</summary>
      <div class="filters" style="margin-top:.5rem">
        <div class="filter-group">
          <label for="ghRepo">Repo</label>
          <input type="text" id="ghRepo" placeholder="AKjork/railtimer-data" autocomplete="off" spellcheck="false">
        </div>
        <div class="filter-group">
          <label for="ghToken">Token</label>
          <input type="password" id="ghToken" placeholder="github_pat_…" autocomplete="off">
        </div>
        <div class="filter-group">
          <label>&nbsp;</label>
          <button id="btnSaveGithub" class="ghost">Spara</button>
        </div>
      </div>
      <p class="meta">Token sparas bara i den här webbläsaren. Samma token som i appen fungerar.</p>
    </details>
  </div>
```

- [ ] **Step 4: Skripttagg, konstanter och lyssnare**

Ersätt:
```html
</main>

<script>
(function(){
  'use strict';

  const STORAGE_KEY = 'kmon_gps_logs_v1';
```
med:
```html
</main>

<script src="railtimer-github.js"></script>
<script>
(function(){
  'use strict';

  const STORAGE_KEY = 'kmon_gps_logs_v1';
  const GH_KEY = 'railtimer_github_v1'; // { repo, token, branch } – samma format som i appen
  const TEST_MODE = new URLSearchParams(location.search).has('test');
  let testFetch = null;                 // simulerat GitHub i testerna
```
Ersätt:
```js
  // Event listeners
  els.btnLoadLocal.addEventListener('click', loadFromLocalStorage);
```
med:
```js
  // Event listeners
  document.getElementById('btnLoadGithub').addEventListener('click', loadFromGithub);
  document.getElementById('btnSaveGithub').addEventListener('click', saveGithubSettings);
  els.btnLoadLocal.addEventListener('click', loadFromLocalStorage);
```

- [ ] **Step 5: Hämtning med cache per fil**

Ersätt:
```js
  function loadFromLocalStorage(){
```
med:
```js
  // ── Hämtning från GitHub-repot ──

  function loadGithubSettings(){
    try{
      const s = JSON.parse(localStorage.getItem(GH_KEY) || 'null');
      return s && s.repo && s.token ? s : null;
    }catch(e){ return null; }
  }

  function saveGithubSettings(){
    const repo = RailTimerGitHub.parseRepo(document.getElementById('ghRepo').value || RailTimerGitHub.DEFAULT_REPO);
    if(!repo){ els.loadStatus.textContent = 'Ange repot som ägare/namn, t.ex. AKjork/railtimer-data.'; return; }
    const existing = loadGithubSettings();
    const token = document.getElementById('ghToken').value.trim() || (existing && existing.token) || '';
    if(!token){ els.loadStatus.textContent = 'Klistra in din token.'; return; }
    localStorage.setItem(GH_KEY, JSON.stringify({ repo: `${repo.owner}/${repo.repo}`, token, branch: 'main' }));
    document.getElementById('ghToken').value = '';
    document.getElementById('ghSettings').open = false;
    els.loadStatus.textContent = 'GitHub-inställningarna är sparade.';
  }

  // Redan hämtade filer sparas per sha i IndexedDB, så att bara nya filer hämtas
  const BlobCache = (function(){
    let dbPromise = null;
    function open(){
      if(!dbPromise){
        dbPromise = new Promise((resolve, reject) => {
          if(!window.indexedDB){ reject(new Error('IndexedDB saknas')); return; }
          const req = indexedDB.open('railtimer-analys', 1);
          req.onupgradeneeded = () => { req.result.createObjectStore('blobs', { keyPath: 'sha' }); };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        dbPromise.catch(() => {});
      }
      return dbPromise;
    }
    return {
      async get(sha){
        try{
          const db = await open();
          return await new Promise((resolve, reject) => {
            const req = db.transaction('blobs').objectStore('blobs').get(sha);
            req.onsuccess = () => resolve(req.result ? req.result.json : undefined);
            req.onerror = () => reject(req.error);
          });
        }catch(e){ return undefined; }
      },
      async set(sha, json){
        try{
          const db = await open();
          await new Promise((resolve, reject) => {
            const tx = db.transaction('blobs', 'readwrite');
            tx.objectStore('blobs').put({ sha, json });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          });
        }catch(e){ /* utan cache hämtas filen igen nästa gång */ }
      }
    };
  })();

  async function loadFromGithub(){
    const s = loadGithubSettings();
    if(!s){
      document.getElementById('ghRepo').value = RailTimerGitHub.DEFAULT_REPO;
      document.getElementById('ghSettings').open = true;
      els.loadStatus.textContent = 'Ange repo och token under GitHub-inställningar.';
      return;
    }
    const repo = RailTimerGitHub.parseRepo(s.repo);
    if(!repo){ els.loadStatus.textContent = 'Repot ska anges som ägare/namn.'; return; }
    const client = RailTimerGitHub.createClient({ owner: repo.owner, repo: repo.repo, token: s.token, branch: s.branch || 'main', fetch: testFetch || undefined });
    els.loadStatus.textContent = 'Hämtar från GitHub…';
    try{
      const r = await RailTimerGitHub.loadRunsFromRepo({ client, cache: BlobCache });
      allLogs = r.runs;
      let text = `${r.runs.length} körningar från GitHub (${r.newFiles} nya filer).`;
      if(r.errors.length) text += ` ${r.errors.length} filer kunde inte läsas.`;
      els.loadStatus.textContent = text;
      setupFilters();
      runAnalysis();
    }catch(err){
      els.loadStatus.textContent = err && err.message ? err.message : 'Kunde inte hämta från GitHub.';
    }
  }

  if(TEST_MODE){
    window.__analys = { setFetchForTest: fn => { testFetch = fn; }, loadFromGithub, getLogs: () => allLogs };
  }

  function loadFromLocalStorage(){
```

- [ ] **Step 6: Kör testerna**

Run: `node tests/run-browser-tests.mjs`
Expected: `18 lyckades, 0 misslyckades`.

- [ ] **Step 7: Committa**

```bash
git add Analys.html tests/replay.html
git commit -m "Analysverktyget hämtar körningar från GitHub-repot, med cache per fil

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Klart för publicering

Service worker, version, `.gitignore`, bilder för granskning, dokumentation och hela testsviten.

**Files:**
- Modify: `sw.js`, `index.html` (`APP_VERSION`), `Kinnekulle GPS.html`, `CLAUDE.md`, `tests/replay.html`
- Create: `.gitignore`

- [ ] **Step 1: Modulerna fungerar utan nät**

I `sw.js`, ersätt:
```js
const ASSETS = [
  './index.html',
  './Kinnekulle GPS.html',
  './kinnekulle-gps.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
```
med:
```js
const ASSETS = [
  './index.html',
  './Kinnekulle GPS.html',
  './railtimer-avbrott.js',
  './railtimer-github.js',
  './kinnekulle-gps.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
```

- [ ] **Step 2: Höj versionen**

I `index.html`, ersätt:
```js
  const APP_VERSION = '2026-10-15';
```
med:
```js
  const APP_VERSION = '2026-10-15b';
```

- [ ] **Step 3: Bilder i telefonstorlek. Lägg till före `window.captureGolden` i `tests/replay.html`.**

```js
// Bilder i telefonstorlek för granskning (node tests/run-browser-tests.mjs --shot=<namn>)
window.prepareShot = async function (name) {
  if (name === 'installningar') {
    const w = await loadApp();
    await clearAppStorage(w);
    w.localStorage.setItem('railtimer_github_v1', JSON.stringify({ repo: 'AKjork/railtimer-data', token: 'x', branch: 'main' }));
    w.localStorage.setItem('railtimer_upload_v1', JSON.stringify({ repo: 'AKjork/railtimer-data', uploadedIds: ['a', 'b', 'c'], backlogDone: true, uploadedTrackCount: 2, lastSuccessAt: '2026-10-15T06:10:00.000Z' }));
    w.__railtimer.showUploadSettings();
  } else if (name === 'avbrott') {
    const fixes = buildJourney();
    const call = twoStationCall(fixes);
    await runJourney(fixes, { drop: f => call.drop(f) || f.t > call.resume + 60000 });
  } else if (name === 'rapport') {
    const fixes = buildJourney();
    await runJourney(fixes, { drop: twoStationCall(fixes).drop });
  } else {
    throw new Error('Okänd bild: ' + name);
  }
  await realSleep(300);
  window.scrollTo(0, 0); // appen kan ha scrollat även testsidan (scrollIntoView)
  const r = document.getElementById('app').getBoundingClientRect();
  return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
};

```
Skapa `.gitignore`:
```
tests/screenshots/
```

- [ ] **Step 4: Dokumentation. Lägg till sist i `CLAUDE.md`.**

```markdown

## Uppdatering (2026-10-15b): uppladdning, GPS-spår och avbrott

Spec: `docs/superpowers/specs/2026-10-15-uppladdning-design.md` · Plan: `docs/superpowers/plans/2026-10-15-uppladdning.md`

### Uppladdning till GitHub
- Varje avslutad (även avbruten) resa laddas upp till privata repot `AKjork/railtimer-data`: `korningar/ÅÅÅÅ/<datum>_<tåg>_<id>.json`, spåret i `gps-spar/…`. Befintliga mätningar laddas upp första gången som `import/…_befintliga-N.json` (högst 200 per fil).
- Inställningar: ⋮ → Uppladdning (repo, token, "Spara och testa", "Ladda upp nu"). Token sparas bara i `localStorage` (`railtimer_github_v1`).
- Kön (`railtimer_upload_v1`) körs efter resan, vid start, `online` och när appen blir synlig – aldrig under en pågående resa. En skrivning i taget, minst 1 s mellanrum, väntar enligt GitHubs `retry-after`.
- Logiken finns i `railtimer-github.js` (även Analys.html använder den).

### Körningsformat 2
`format`, `appVersion`, `interruptions`, `trackPath`; per station `sig`, `lat`, `lon`, `radius`, och vid avbrott `arrivalWindow`/`departureWindow`/`missedReason`. `normalizeLogEntry` bevarar fälten.

### GPS-spår
Varje position under resan sparas i IndexedDB (`railtimer`/`tracks`) var 30:e sekund och när appen går till bakgrunden (`onAppHidden`). Fält: `t_ms, lat, lon, acc_m, speed_ms, heading_deg, fixAge_ms`. Tas bort från telefonen när det är uppladdat.

### Avbrott (samtal, bakgrund, GPS-glapp)
- Avbrott = mer än 20 s mellan positioner och minst 150 m förflyttning (`railtimer-avbrott.js`).
- Tider inom avbrottet (`from < T ≤ to + 2 s`) sparas som `null` med fönster och källan `avbrott` – aldrig som felaktiga tider.
- Ikappkörning: stationer som passerades under avbrottet markeras `missedReason: 'avbrott'` och appen fortsätter från rätt station (tidigare kunde den fastna).
- Vanlig körning är oförändrad – säkras av regressionsfacit `tests/golden-normal-run.json`.

### Tester
- `node --test "tests/*.test.js"` – modulerna (utan beroenden).
- `node tests/run-browser-tests.mjs [filter]` – uppspelade resor i Chrome utan fönster (`index.html?test=1`).
- `node tests/run-browser-tests.mjs --golden` – tar fram facit (bara när logiken avsiktligt ändras).
- `node tests/run-browser-tests.mjs --shot=installningar|avbrott|rapport` – bilder i telefonstorlek (`tests/screenshots/`).
```

Skapa `docs/railtimer-data-README.md`. Den laddas upp som README i datarepot i uppgift 10.

```markdown
# RailTimer – mätdata

Privat repo med mätningar från [RailTimer](https://akjork.github.io/kinnekulle-gps/). Filerna skrivs automatiskt av appen – ändra dem inte för hand.

## Struktur

| Sökväg | Innehåll |
|---|---|
| `korningar/ÅÅÅÅ/<datum>_<tåg>_<id>.json` | En körning (format 2) |
| `gps-spar/ÅÅÅÅ/<datum>_<tåg>_<id>.json` | GPS-spåret för körningen (format 1) |
| `import/<ÅÅÅÅ-MM-DDTHHMM>_befintliga-<n>.json` | Mätningar som fanns på telefonen före den första uppladdningen (lista, högst 200 per fil) |
| `.railtimer/anslutning.json` | Senaste anslutningstest från appen |

## Körning, format 2

Samma fält som i appen – `id, trainNumber, vehicleType, startStation, endStation, startedAt, finishedAt, aborted, notes, stops[]` – plus:

- `format: 2`, `appVersion`, `trackPath`
- `interruptions: [{from, to, distanceM}]` – avbrott i mätningen (t.ex. samtal)
- per station: `sig` (Trafikverkets signatur), `lat`, `lon`, `radius`
- vid avbrott: `arrivalWindow`/`departureWindow` `{from, to}` – tiden är då `null` och källan `avbrott` – samt `missedReason: "avbrott"` om stationen passerades helt under avbrottet

Körningar utan `format` är äldre (format 1).

## GPS-spår, format 1

`{ format, runId, trainNumber, t0, fields, points }` där `fields` är `["t_ms","lat","lon","acc_m","speed_ms","heading_deg","fixAge_ms"]` och varje punkt är en lista i den ordningen. `t_ms` räknas från `t0` med appens klocka – samma klocka som körningens tider.
```

- [ ] **Step 5: Uppdatera kopian och kör hela sviten**

```bash
cp index.html "Kinnekulle GPS.html" && cmp index.html "Kinnekulle GPS.html"
node --test "tests/*.test.js"
node tests/run-browser-tests.mjs
```
Expected: `ℹ pass 39`, `ℹ fail 0` och `18 lyckades, 0 misslyckades`.

- [ ] **Step 6: Ta bilderna och granska dem**

```bash
node tests/run-browser-tests.mjs --shot=installningar
node tests/run-browser-tests.mjs --shot=avbrott
node tests/run-browser-tests.mjs --shot=rapport
```
Öppna `tests/screenshots/*.png` och kontrollera följande:
- Inställningsvyn är läsbar i 390 × 844 och knapparna är minst 44 px höga.
- I resvyn står Källby och Blomberg som "missad – avbrott", och meddelandet om avbrottet syns i panelen för nästa station.
- Rapporten visar "missad – avbrott" och korrekt restid.

- [ ] **Step 7: Committa**

```bash
git add sw.js index.html "Kinnekulle GPS.html" CLAUDE.md tests/replay.html .gitignore docs/railtimer-data-README.md
git commit -m "Klart för publicering: service worker, version, dokumentation och bilder för granskning

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Engångsuppsättning och publicering (tillsammans med André)

Varje steg här påverkar något utanför arbetsträdet. **Fråga André före varje steg och vänta på ett uttryckligt ja.** Blockeras ett kommando av behörighetskontrollen, be André köra det själv med `!` före kommandot.

- [ ] **Step 1: Visa resultatet för André**

Visa:
- en sammanfattning av ändringarna,
- testresultaten: 39 modultester och 18 uppspelade tester,
- de tre bilderna (sökvägar i `tests/screenshots/`).

- [ ] **Step 2: Skapa datarepot med README, med Andrés OK**

```bash
gh repo create AKjork/railtimer-data --private --add-readme --description "Mätdata från RailTimer: körningar och GPS-spår"
gh api repos/AKjork/railtimer-data --jq '.private'
gh api repos/AKjork/railtimer-data/contents/README.md --jq '.sha'
```
Expected: `true` och en sha. Ersätt sedan standard-README med formatbeskrivningen:
```bash
gh api --method PUT repos/AKjork/railtimer-data/contents/README.md -f message="README: format för RailTimer-data" -f content="$(base64 -w0 docs/railtimer-data-README.md)" -f sha="$(gh api repos/AKjork/railtimer-data/contents/README.md --jq '.sha')"
```
Expected: ett svar med `"path": "README.md"`.

- [ ] **Step 3: André skapar token**

Ge André länken:
`https://github.com/settings/personal-access-tokens/new?name=RailTimer&description=Uppladdning+till+railtimer-data&target_name=AKjork&expires_in=none&contents=write`

Under "Repository access" väljer han "Only select repositories" och sedan `railtimer-data`. Han kopierar token själv och klistrar aldrig in den i chatten.

- [ ] **Step 4: Publicera, med Andrés uttryckliga OK**

```bash
git fetch origin
git merge-base --is-ancestor origin/main HEAD && echo "snabbspolning möjlig"
```
Om det skrivs ut "snabbspolning möjlig", be André köra:
`! git -C C:/Users/andre/kinnekulle-gps-ux-wt push origin feat/uppladdning:main`

Kontrollera sedan att sidan är publicerad:
```bash
until curl -s "https://akjork.github.io/kinnekulle-gps/index.html?cb=$RANDOM" | grep -q "APP_VERSION = '2026-10-15b'"; do sleep 10; done; echo "publicerad"
curl -s "https://akjork.github.io/kinnekulle-gps/railtimer-github.js" | grep -c "runUploadPass"
```
Expected: `publicerad` och en siffra som är minst 1.

- [ ] **Step 5: André ansluter telefonen och datorn**

**På telefonen:**
1. Öppna appen två gånger, så att den nya versionen laddas.
2. Gå till ⋮ → Uppladdning, klistra in token och tryck "Spara och testa".
3. Svaret ska vara: *"Ansluten – repot är privat och token kan skriva."*

**På datorn:**
1. Öppna `Analys.html`, gå till GitHub-inställningar, ange token och spara.
2. Tryck "Hämta från GitHub".

- [ ] **Step 6: Kontrollera i repot, bara läsning**

```bash
gh api repos/AKjork/railtimer-data/contents/.railtimer/anslutning.json --jq '.path'
gh api repos/AKjork/railtimer-data/contents/import --jq '.[].name'
```
Expected: `.railtimer/anslutning.json` och minst en fil `…_befintliga-1.json`. Om André inte hade några sparade mätningar finns ingen importmapp än. Efter nästa resa ska det finnas en fil under `korningar/2026/` och en under `gps-spar/2026/`.
