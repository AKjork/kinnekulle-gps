// Kör tests/replay.html i Chrome utan fönster och skriver ut resultatet.
//   node tests/run-browser-tests.mjs            kör alla uppspelade tester
//   node tests/run-browser-tests.mjs avbrott    kör bara tester vars namn innehåller "avbrott"
//   node tests/run-browser-tests.mjs --golden   sparar facit för en vanlig resa i tests/golden-normal-run.json
//   node tests/run-browser-tests.mjs --shot=installningar   sparar en bild i telefonstorlek i tests/screenshots/
//                                                          (även --shot=avbrott och --shot=rapport)
//   node tests/run-browser-tests.mjs --shot=mot-tidtabell    analysverktyget i datorstorlek (även --shot=tidtabell);
//                                                          --shot=mot-tidtabell-utskrift visar utskriften (PDF)
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
    // Bilder vars namn slutar på -utskrift tas som om sidan skrevs ut (utskriftsmallen, @media print)
    if (SHOT.endsWith('-utskrift')) await send('Emulation.setEmulatedMedia', { media: 'print' });
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
