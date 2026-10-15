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
