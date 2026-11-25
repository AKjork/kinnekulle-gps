/* RailTimer – Västtrafiks API (Planera Resa v4) för bussanslutningar.
   - Token: OAuth2 client credentials med nyckel och hemlighet från Västtrafiks utvecklarportal
     (POST https://ext-api.vasttrafik.se/token). Västtrafiks egen JavaScript-klient skriver att token inte kan
     hämtas från webbläsaren. Därför kan appen i stället gå via en egen liten server (docs/vasttrafik-worker.js),
     som har nyckeln och hemligheten och lägger till token. Provsidan vasttrafik-koll.html visar vilket som går.
   - Hållplatser nära en station: /locations/by-coordinates (bara hållplatsområden).
   - Avgångar och ankomster: /stop-areas/{gid}/departures och /arrivals, med planerad tid, Västtrafiks
     beräknade tid (realtid), inställt och läge.
   Inget här är provat mot det riktiga API:t: utvecklingsmiljön når inte ext-api.vasttrafik.se.
   Rena funktioner och en liten klient utan beroenden. Används av index.html och vasttrafik-koll.html och
   testas med node --test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RailTimerVt = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API = 'https://ext-api.vasttrafik.se/pr/v4';
  const TOKEN_URL = 'https://ext-api.vasttrafik.se/token';
  const PORTAL_URL = 'https://developer.vasttrafik.se/';
  const DEFAULTS = {
    timeoutMs: 10000,
    stopRadiusM: 350,   // hållplatsområden högst så här långt från stationens koordinat
    maxStopAreas: 3,
    boardLimit: 50
  };

  function ms(v) {
    if (v == null || v === '') return null;
    const t = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  function base64(s) {
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
    return Buffer.from(String(s), 'utf8').toString('base64');
  }
  function vtError(kind, message) {
    const e = new Error(message);
    e.kind = kind;
    return e;
  }

  // Egen server: adressen utan / på slutet, eller '' om den inte är en https-adress (http bara för localhost)
  function cleanServer(url) {
    const s = String(url || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    return /^https:\/\/[^\s/]+/i.test(s) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(s) ? s : '';
  }
  // Inställningarna räcker för att fråga: nyckel och hemlighet, eller en egen server
  function configured(s) {
    return !!(s && ((s.key && s.secret) || cleanServer(s.server)));
  }

  // ── Token ──
  function tokenRequest(key, secret, deviceId) {
    const scope = deviceId ? `&scope=device_${encodeURIComponent(deviceId)}` : '';
    return {
      url: TOKEN_URL,
      init: {
        method: 'POST',
        headers: { Authorization: 'Basic ' + base64(`${key}:${secret}`), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials' + scope
      }
    };
  }
  // { access_token, expires_in (s) } → { token, expiresAt } eller null
  function parseToken(json, now) {
    if (!json || typeof json.access_token !== 'string' || !json.access_token) return null;
    const life = Number(json.expires_in);
    return { token: json.access_token, expiresAt: now + (Number.isFinite(life) && life > 0 ? life : 3600) * 1000 };
  }

  // ── Frågorna ──
  function nearbyPath(lat, lon, radiusM) {
    return `/locations/by-coordinates?latitude=${Number(lat).toFixed(6)}&longitude=${Number(lon).toFixed(6)}` +
      `&radiusInMeters=${Math.round(radiusM)}&types=stoparea&limit=10&offset=0`;
  }
  // kind: 'departures' eller 'arrivals'. Tiden i RFC 3339 (UTC).
  function boardPath(kind, gid, startMs, spanMin, limit) {
    const per = kind === 'arrivals' ? 'maxArrivalsPerLineAndDirection' : 'maxDeparturesPerLineAndDirection';
    return `/stop-areas/${encodeURIComponent(gid)}/${kind === 'arrivals' ? 'arrivals' : 'departures'}` +
      `?startDateTime=${encodeURIComponent(new Date(startMs).toISOString())}` +
      `&timeSpanInMinutes=${Math.max(1, Math.min(1440, Math.round(spanMin)))}&${per}=10&limit=${limit || DEFAULTS.boardLimit}&offset=0`;
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, rad = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Hållplatsområden närmast först, högst maxDist bort: [{ gid, name, dist }]
  function parseStopAreas(json, maxDist, at, maxCount) {
    const out = [];
    for (const r of (json && json.results) || []) {
      if (!r || !r.gid) continue;
      if (r.locationType && r.locationType !== 'stoparea') continue;
      let dist = Number(r.straightLineDistanceInMeters);
      if (!Number.isFinite(dist) && at && Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) dist = haversine(at.lat, at.lon, r.latitude, r.longitude);
      if (!Number.isFinite(dist)) dist = 0;
      if (maxDist != null && dist > maxDist) continue;
      if (out.some(x => x.gid === r.gid)) continue;
      out.push({ gid: String(r.gid), name: String(r.name || ''), dist: Math.round(dist) });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.slice(0, maxCount || DEFAULTS.maxStopAreas);
  }

  /* Avgångs- eller ankomsttavlan: [{ id, journey, line, lineName, mode, direction, origin, planned, est, canceled,
     platform, stop, stopGid }]. direction är vart fordonet går, origin varifrån det kommer. */
  function parseBoard(json) {
    const out = [];
    for (const r of (json && json.results) || []) {
      if (!r) continue;
      const planned = ms(r.plannedTime);
      if (planned == null) continue;
      const sj = r.serviceJourney || {};
      const line = sj.line || {};
      const sp = r.stopPoint || {};
      out.push({
        id: `${sj.gid || r.detailsReference || ''}|${planned}`,
        journey: String(sj.gid || ''),
        line: String(line.shortName || line.designation || line.name || ''),
        lineName: String(line.name || ''),
        mode: String(line.transportMode || 'unknown').toLowerCase(),
        direction: String(sj.direction || '').trim(),
        origin: String(sj.origin || '').trim(),
        planned,
        est: ms(r.estimatedTime),
        canceled: !!r.isCancelled,
        partCanceled: !!r.isPartCancelled,
        platform: String(sp.platform || ''),
        stop: String(sp.name || ''),
        stopGid: String(sp.gid || '')
      });
    }
    out.sort((a, b) => a.planned - b.planned);
    return out;
  }
  // Bara bussar. Västtågen tas från Trafikverket, inte härifrån, så att inget tåg kommer med två gånger.
  function busesOnly(calls) {
    return (calls || []).filter(c => c.mode === 'bus');
  }
  // Samma tur från två hållplatsområden en gång
  function uniqueCalls(calls) {
    const seen = new Set(), out = [];
    for (const c of calls || []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out.sort((a, b) => a.planned - b.planned);
  }

  // Orten i en destination eller ett stationsnamn: "Lidköping Resecentrum" → "lidköping", "Herrljunga C" → "herrljunga",
  // "Skara via Götene" → "skara" (via räknas inte: bussen går dit)
  function townKey(name) {
    const s = String(name || '').toLocaleLowerCase('sv').split(/\s+via\s+/)[0];
    const m = s.match(/[a-zåäöéü]+(?:-[a-zåäöéü]+)*/);
    return m ? m[0] : '';
  }

  // ── Klienten ──
  /* opts: { fetch, settings: { key, secret, server, deviceId }, tokenStore: { get(), set(t) }, now, online,
     timeoutMs }. Med egen server går alla frågor dit (server + /pr/v4/…) utan token; servern lägger till den.
     Felsorter (e.kind): setup, blocked (Västtrafik tillåter inte frågan från webbläsaren), network, timeout,
     auth, http. */
  function createClient(opts) {
    const o = opts || {};
    const doFetch = o.fetch || (typeof fetch === 'function' ? fetch.bind(null) : null);
    const settings = o.settings || {};
    const now = o.now || (() => Date.now());
    const online = o.online || (() => true);
    const timeoutMs = o.timeoutMs || DEFAULTS.timeoutMs;
    let mem = null;
    const store = o.tokenStore || { get: () => mem, set: t => { mem = t; } };
    const server = cleanServer(settings.server);
    const base = server ? server + '/pr/v4' : API;

    async function fetchT(url, init) {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      try {
        return await doFetch(url, Object.assign({}, init || {}, ctl ? { signal: ctl.signal } : {}));
      } catch (e) {
        if (e && e.name === 'AbortError') throw vtError('timeout', 'Västtrafik svarar inte');
        throw await failure(url);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    /* fetch kastar samma fel vid nätfel och när Västtrafik inte tillåter frågan från webbläsaren (CORS).
       Går adressen att nå utan CORS (mode no-cors ger ett ogenomskinligt svar) är det CORS. */
    async function failure(url) {
      if (!online()) return vtError('network', 'ingen täckning');
      try {
        await doFetch(url, { mode: 'no-cors', cache: 'no-store' });
        return vtError('blocked', server ? 'servern tillåter inte frågan från appen' : 'Västtrafik tillåter inte frågan från webbläsaren');
      } catch (e) {
        return vtError('network', server ? 'servern svarar inte' : 'nätverksfel');
      }
    }

    async function token(force) {
      if (server) return null;
      const t = store.get();
      if (!force && t && t.token && t.expiresAt > now() + 60000) return t.token;
      if (!settings.key || !settings.secret) throw vtError('setup', 'nyckel och hemlighet saknas');
      const req = tokenRequest(settings.key, settings.secret, settings.deviceId);
      const resp = await fetchT(req.url, req.init);
      if (resp.status === 400 || resp.status === 401) throw vtError('auth', 'Västtrafik godtog inte nyckeln och hemligheten');
      if (!resp.ok) throw vtError('http', `token: HTTP ${resp.status}`);
      let json = null;
      try { json = await resp.json(); } catch (e) { json = null; }
      const parsed = parseToken(json, now());
      if (!parsed) throw vtError('auth', 'inget token i svaret');
      store.set(parsed);
      return parsed.token;
    }

    async function get(path) {
      const url = base + path;
      for (let attempt = 0; attempt < 2; attempt++) {
        const tok = await token(attempt > 0);
        const headers = { Accept: 'application/json' };
        if (tok) headers.Authorization = 'Bearer ' + tok;
        const resp = await fetchT(url, { headers });
        if (resp.status === 401 && !server && attempt === 0) { store.set(null); continue; }
        if (resp.status === 401 || resp.status === 403) throw vtError('auth', server ? 'servern fick inte svar från Västtrafik (nyckeln?)' : 'Västtrafik godtog inte token');
        if (!resp.ok) throw vtError('http', `HTTP ${resp.status}`);
        try { return await resp.json(); } catch (e) { throw vtError('http', 'svaret gick inte att läsa'); }
      }
      throw vtError('auth', 'Västtrafik godtog inte token');
    }

    return {
      base, viaServer: !!server, token, get,
      async stopAreasNear(lat, lon, radiusM) {
        const r = radiusM || DEFAULTS.stopRadiusM;
        return parseStopAreas(await get(nearbyPath(lat, lon, r)), r, { lat, lon });
      },
      async board(kind, gid, startMs, spanMin) {
        return parseBoard(await get(boardPath(kind, gid, startMs, spanMin)));
      }
    };
  }

  // Felet i ord för appen och provsidan
  function errorText(e) {
    if (!e) return '';
    if (e.kind === 'blocked') return `${e.message}. Lägg in en egen server under ⋮ → Västtrafik.`;
    return String(e.message || e);
  }

  return {
    API, TOKEN_URL, PORTAL_URL, DEFAULTS, ms, base64, cleanServer, configured, tokenRequest, parseToken,
    nearbyPath, boardPath, haversine, parseStopAreas, parseBoard, busesOnly, uniqueCalls, townKey, createClient, errorText
  };
});
