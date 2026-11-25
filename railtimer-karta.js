/* RailTimer – kartans linje längs spåret i stället för fågelvägen.
   Spårnätet hämtas från OpenStreetMap (Overpass API) runt varje sträcka, och vägen mellan två
   stationer räknas fram som kortaste väg i spårnätet. Resultatet förenklas och sparas per sträcka,
   så att det bara hämtas en gång och finns kvar offline.
   Rena funktioner utan beroenden (utom hämtningen, som får fetch som argument).
   Används av index.html och testas med node --test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RailTimerKarta = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  const SERVICE_PENALTY = 4;   // spår med service=* (växelförbindelser m.m.) kostar mer, så att huvudspåret väljs
  const SNAP_M = 25;           // ändpunkter närmare än så kopplas ihop (glapp i OSM-datat)
  const MAX_STATION_SNAP_M = 1500; // stationen måste ligga högst så här långt från spåret
  const SIMPLIFY_M = 6;        // förenkling av den färdiga linjen
  const MAX_DETOUR = 3;        // längre än 3 × fågelvägen (+ 5 km) räknas som fel väg
  const FAIL_RETRY_MS = 24 * 3600 * 1000; // misslyckad sträcka försöks igen efter ett dygn
  const CACHE_MAX_LEGS = 150;  // ca 200 kB i localStorage

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Nyckel för en sträcka: koordinaterna avrundade till ca 10 m, så att en flyttad mittpunkt ger ny väg
  function legKey(a, b) {
    const f = p => `${(+p.lat).toFixed(4)},${(+p.lon).toFixed(4)}`;
    return `${f(a)}>${f(b)}`;
  }

  // Sträckorna i en rutt: stationer utan koordinater hoppas över
  function routeLegs(route) {
    const pts = (route || []).filter(s => s && s.lat != null && s.lon != null);
    const legs = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      legs.push({ a: { lat: +pts[i].lat, lon: +pts[i].lon }, b: { lat: +pts[i + 1].lat, lon: +pts[i + 1].lon }, key: legKey(pts[i], pts[i + 1]) });
    }
    return legs;
  }

  // Rektangel runt en sträcka med marginal: minst 2 km, annars en fjärdedel av sträckans längd
  function legBox(leg) {
    const d = haversine(leg.a.lat, leg.a.lon, leg.b.lat, leg.b.lon);
    const padM = Math.max(2000, d * 0.25);
    const midLat = (leg.a.lat + leg.b.lat) / 2;
    const dLat = padM / 111320;
    const dLon = padM / (111320 * Math.cos(midLat * Math.PI / 180));
    return {
      s: Math.min(leg.a.lat, leg.b.lat) - dLat, n: Math.max(leg.a.lat, leg.b.lat) + dLat,
      w: Math.min(leg.a.lon, leg.b.lon) - dLon, e: Math.max(leg.a.lon, leg.b.lon) + dLon
    };
  }

  // Overpass-fråga: alla järnvägsspår utom bangårds- och sidospår, i rektanglarna runt sträckorna
  function overpassQuery(legs) {
    const r = v => v.toFixed(5);
    const parts = legs.map(legBox).map(b =>
      `way["railway"="rail"]["service"!~"^(yard|siding|spur)$"](${r(b.s)},${r(b.w)},${r(b.n)},${r(b.e)});`);
    return `[out:json][timeout:90];(${parts.join('')});out geom qt;`;
  }

  // Rutnät för att snabbt hitta noder nära en punkt
  function makeGrid(cellDeg) {
    const cells = new Map();
    const key = (lat, lon) => `${Math.floor(lat / cellDeg)}:${Math.floor(lon / cellDeg)}`;
    return {
      add(id, lat, lon) {
        const k = key(lat, lon);
        let c = cells.get(k);
        if (!c) cells.set(k, c = []);
        c.push(id);
      },
      near(lat, lon, rings) {
        const out = [];
        const i0 = Math.floor(lat / cellDeg), j0 = Math.floor(lon / cellDeg);
        for (let i = i0 - rings; i <= i0 + rings; i++) {
          for (let j = j0 - rings; j <= j0 + rings; j++) {
            const c = cells.get(`${i}:${j}`);
            if (c) for (const id of c) out.push(id);
          }
        }
        return out;
      }
    };
  }

  /* Spårnätet som graf. elements: Overpass-svarets element (way med nodes och geometry).
     Returnerar { nodes: Map(id → {lat, lon}), adj: Map(id → [[id, kostnad], …]), grid } */
  function buildGraph(elements) {
    const nodes = new Map();
    const adj = new Map();
    const ends = [];
    const link = (a, b, w) => {
      if (a === b) return;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push([b, w]);
      adj.get(b).push([a, w]);
    };
    const seenWays = new Set();
    for (const el of elements || []) {
      if (!el || el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
      if (seenWays.has(el.id)) continue; // samma spår kan komma från flera rektanglar
      seenWays.add(el.id);
      const ids = Array.isArray(el.nodes) && el.nodes.length === el.geometry.length
        ? el.nodes.map(String)
        : el.geometry.map(g => `${g.lat.toFixed(6)},${g.lon.toFixed(6)}`);
      const penalty = el.tags && el.tags.service ? SERVICE_PENALTY : 1;
      for (let i = 0; i < ids.length; i++) {
        const g = el.geometry[i];
        if (!g || g.lat == null) continue;
        if (!nodes.has(ids[i])) nodes.set(ids[i], { lat: g.lat, lon: g.lon });
        if (i > 0 && el.geometry[i - 1]) {
          const p = el.geometry[i - 1];
          link(ids[i - 1], ids[i], haversine(p.lat, p.lon, g.lat, g.lon) * penalty);
        }
      }
      ends.push(ids[0], ids[ids.length - 1]);
    }
    const grid = makeGrid(0.01);
    for (const [id, n] of nodes) grid.add(id, n.lat, n.lon);
    // Glapp: en spårände som slutar nära en annan nod kopplas ihop med den
    for (const id of ends) {
      const n = nodes.get(id);
      if (!n) continue;
      const have = new Set((adj.get(id) || []).map(e => e[0]));
      for (const other of grid.near(n.lat, n.lon, 1)) {
        if (other === id || have.has(other)) continue;
        const o = nodes.get(other);
        const d = haversine(n.lat, n.lon, o.lat, o.lon);
        if (d <= SNAP_M) link(id, other, d + 5);
      }
    }
    return { nodes, adj, grid };
  }

  // Närmaste nod i spårnätet, eller null om inget spår finns inom MAX_STATION_SNAP_M
  function nearestNode(graph, lat, lon) {
    let best = null, bestD = Infinity;
    for (let rings = 1; rings <= 2 && best == null; rings++) {
      for (const id of graph.grid.near(lat, lon, rings)) {
        if (!graph.adj.has(id)) continue;
        const n = graph.nodes.get(id);
        const d = haversine(lat, lon, n.lat, n.lon);
        if (d < bestD) { bestD = d; best = id; }
      }
    }
    return bestD <= MAX_STATION_SNAP_M ? best : null;
  }

  // Binär heap för A*
  function heap() {
    const a = [];
    return {
      get size() { return a.length; },
      push(item) {
        a.push(item);
        let i = a.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (a[p][0] <= a[i][0]) break;
          [a[p], a[i]] = [a[i], a[p]];
          i = p;
        }
      },
      pop() {
        const top = a[0], last = a.pop();
        if (a.length) {
          a[0] = last;
          let i = 0;
          for (;;) {
            const l = 2 * i + 1, r = l + 1;
            let m = i;
            if (l < a.length && a[l][0] < a[m][0]) m = l;
            if (r < a.length && a[r][0] < a[m][0]) m = r;
            if (m === i) break;
            [a[m], a[i]] = [a[i], a[m]];
            i = m;
          }
        }
        return top;
      }
    };
  }

  // Kortaste väg (A*) mellan två noder: lista med [lat, lon], eller null
  function shortestPath(graph, from, to) {
    if (from == null || to == null) return null;
    const goal = graph.nodes.get(to);
    const h = id => { const n = graph.nodes.get(id); return haversine(n.lat, n.lon, goal.lat, goal.lon); };
    const dist = new Map([[from, 0]]);
    const prev = new Map();
    const open = heap();
    open.push([h(from), from]);
    const done = new Set();
    while (open.size) {
      const [, u] = open.pop();
      if (u === to) break;
      if (done.has(u)) continue;
      done.add(u);
      const du = dist.get(u);
      for (const [v, w] of graph.adj.get(u) || []) {
        const nd = du + w;
        if (nd < (dist.has(v) ? dist.get(v) : Infinity)) {
          dist.set(v, nd);
          prev.set(v, u);
          open.push([nd + h(v), v]);
        }
      }
    }
    if (!dist.has(to)) return null;
    const path = [];
    for (let id = to; id != null; id = prev.get(id)) {
      const n = graph.nodes.get(id);
      path.push([n.lat, n.lon]);
      if (id === from) break;
    }
    return path.reverse();
  }

  function pathLength(path) {
    let s = 0;
    for (let i = 1; i < path.length; i++) s += haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    return s;
  }

  // Douglas–Peucker i meter (lokal plan projektion)
  function simplify(path, tolM) {
    if (!path || path.length <= 2) return path ? path.slice() : path;
    const lat0 = path[0][0] * Math.PI / 180;
    const kx = 111320 * Math.cos(lat0), ky = 110540;
    const xy = path.map(p => [p[1] * kx, p[0] * ky]);
    const keep = new Uint8Array(path.length);
    keep[0] = keep[path.length - 1] = 1;
    const stack = [[0, path.length - 1]];
    while (stack.length) {
      const [i, j] = stack.pop();
      const [x1, y1] = xy[i], [x2, y2] = xy[j];
      const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
      let maxD = -1, idx = -1;
      for (let k = i + 1; k < j; k++) {
        const [x, y] = xy[k];
        let t = len2 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = x1 + t * dx - x, ey = y1 + t * dy - y;
        const d = Math.sqrt(ex * ex + ey * ey);
        if (d > maxD) { maxD = d; idx = k; }
      }
      if (maxD > tolM) {
        keep[idx] = 1;
        stack.push([i, idx], [idx, j]);
      }
    }
    return path.filter((_, k) => keep[k]);
  }

  /* Väg längs spåret för en sträcka. Returnerar [[lat, lon], …] från station a till station b,
     eller null om spåret inte hittas eller vägen blir orimligt lång. */
  function legPath(graph, leg) {
    const s = nearestNode(graph, leg.a.lat, leg.a.lon);
    const t = nearestNode(graph, leg.b.lat, leg.b.lon);
    if (s == null || t == null) return null;
    const p = s === t ? [[graph.nodes.get(s).lat, graph.nodes.get(s).lon]] : shortestPath(graph, s, t);
    if (!p) return null;
    const straight = haversine(leg.a.lat, leg.a.lon, leg.b.lat, leg.b.lon);
    if (pathLength(p) > straight * MAX_DETOUR + 5000) return null;
    const full = [[leg.a.lat, leg.a.lon]].concat(p, [[leg.b.lat, leg.b.lon]]);
    return simplify(full, SIMPLIFY_M).map(q => [Math.round(q[0] * 1e5) / 1e5, Math.round(q[1] * 1e5) / 1e5]);
  }

  // ── Sparade sträckor ──
  // cache: { legs: { [key]: { p: [[lat,lon],…] | null, at: ms } } }
  function cacheGet(cache, key, nowMs) {
    const e = cache && cache.legs && cache.legs[key];
    if (!e) return undefined;
    if (e.p) return e.p;
    return nowMs - e.at < FAIL_RETRY_MS ? null : undefined; // misslyckad nyligen: försök inte igen än
  }

  function cachePut(cache, key, path, nowMs) {
    if (!cache.legs) cache.legs = {};
    cache.legs[key] = { p: path || null, at: nowMs };
    const keys = Object.keys(cache.legs);
    if (keys.length > CACHE_MAX_LEGS) {
      keys.sort((x, y) => cache.legs[x].at - cache.legs[y].at);
      for (const k of keys.slice(0, keys.length - CACHE_MAX_LEGS)) delete cache.legs[k];
    }
    return cache;
  }

  /* Hämtar de sträckor i rutten som saknas i cachen. fetchFn: (url, init) → Response.
     Returnerar { paths: { [key]: path | null }, fetched: antal nya, error } och uppdaterar cache. */
  async function loadRouteGeometry(route, cache, fetchFn, nowMs) {
    const legs = routeLegs(route);
    const paths = {};
    const missing = [];
    for (const leg of legs) {
      const c = cacheGet(cache, leg.key, nowMs);
      if (c === undefined) missing.push(leg);
      else paths[leg.key] = c;
    }
    if (!missing.length || !fetchFn) return { paths, fetched: 0, error: null };
    let data = null, error = null;
    const body = 'data=' + encodeURIComponent(overpassQuery(missing));
    for (const url of OVERPASS_URLS) {
      try {
        const resp = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        if (!resp.ok) { error = `HTTP ${resp.status}`; continue; }
        data = await resp.json();
        break;
      } catch (e) {
        error = e && e.message || String(e);
      }
    }
    if (!data) return { paths, fetched: 0, error }; // nätfel sparas inte – försöks igen nästa gång
    const graph = buildGraph(data.elements);
    for (const leg of missing) {
      const p = legPath(graph, leg);
      paths[leg.key] = p;
      cachePut(cache, leg.key, p, nowMs);
    }
    return { paths, fetched: missing.length, error: null };
  }

  /* Placerar en position längs linjen: närmaste punkt på polylinjen och hur långt längs den (0–1).
     Används för att dela sträckan i körd och kvarvarande del. */
  function projectOnPath(path, lat, lon) {
    if (!path || path.length < 2) return null;
    const kx = Math.cos(lat * Math.PI / 180);
    let best = null, total = 0;
    const segLen = [];
    for (let i = 1; i < path.length; i++) {
      const d = haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
      segLen.push(d);
      total += d;
    }
    let acc = 0;
    for (let i = 1; i < path.length; i++) {
      const [ay, ax] = path[i - 1], [by, bx] = path[i];
      const dx = (bx - ax) * kx, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 ? (((lon - ax) * kx) * dx + (lat - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const py = ay + t * (by - ay), px = ax + t * (bx - ax);
      const d = haversine(lat, lon, py, px);
      if (!best || d < best.dist) best = { dist: d, index: i, point: [py, px], along: acc + t * segLen[i - 1] };
      acc += segLen[i - 1];
    }
    best.fraction = total ? best.along / total : 0;
    return best;
  }

  return {
    OVERPASS_URLS, haversine, legKey, routeLegs, legBox, overpassQuery,
    buildGraph, nearestNode, shortestPath, pathLength, simplify, legPath,
    cacheGet, cachePut, loadRouteGeometry, projectOnPath
  };
});
