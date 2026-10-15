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
