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
