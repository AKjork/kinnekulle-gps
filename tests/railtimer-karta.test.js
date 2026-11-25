'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../railtimer-karta.js');

// Ett spår i en båge (söderut) från A till B, som en way i Overpass-format med nodid
let nextId = 1000;
function way(points, tags, id) {
  const nodes = points.map(() => nextId++);
  return { type: 'way', id: id || nextId++, nodes, geometry: points.map(([lat, lon]) => ({ lat, lon })), tags: tags || { railway: 'rail' } };
}
const A = { lat: 58.50, lon: 13.10 };
const B = { lat: 58.50, lon: 13.30 };
function arc(n, depth) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push([A.lat - depth * Math.sin(Math.PI * f), A.lon + (B.lon - A.lon) * f]);
  }
  return pts;
}

test('vägen följer spåret i en båge, inte fågelvägen', () => {
  const g = K.buildGraph([way(arc(40, 0.05))]);
  const p = K.legPath(g, { a: A, b: B });
  assert.ok(p, 'väg hittad');
  const straight = K.haversine(A.lat, A.lon, B.lat, B.lon);
  const len = K.pathLength(p);
  assert.ok(len > straight * 1.2, `bågen är längre än fågelvägen (${Math.round(len)} mot ${Math.round(straight)})`);
  // Mittpunkten ligger på bågen, ca 5,5 km söder om fågelvägen
  const mid = K.projectOnPath(p, A.lat - 0.05, (A.lon + B.lon) / 2);
  assert.ok(mid.dist < 200, 'bågens mitt ligger på linjen');
  assert.deepEqual(p[0], [A.lat, A.lon]);
  assert.deepEqual(p[p.length - 1], [B.lat, B.lon]);
});

test('spåret är delat i flera ways som delar nod, och samma way i flera rektanglar räknas en gång', () => {
  const pts = arc(40, 0.05);
  const w1 = way(pts.slice(0, 21));
  const w2 = way(pts.slice(20));
  w2.nodes[0] = w1.nodes[w1.nodes.length - 1]; // gemensam nod
  const g = K.buildGraph([w1, w2, w1]);
  const p = K.legPath(g, { a: A, b: B });
  assert.ok(p && K.pathLength(p) > 15000);
});

test('glapp på några meter mellan två ways kopplas ihop', () => {
  const pts = arc(40, 0.05);
  const w1 = way(pts.slice(0, 21));
  const second = pts.slice(20).map(([lat, lon], i) => (i === 0 ? [lat + 0.0001, lon] : [lat, lon])); // ca 11 m bort
  const w2 = way(second);
  const g = K.buildGraph([w1, w2]);
  assert.ok(K.legPath(g, { a: A, b: B }), 'väg över glappet');
});

test('huvudspåret väljs framför en kortare växelförbindelse med service-tagg', () => {
  const main = way(arc(40, 0.01));
  // Rak genväg A→B märkt service=crossover: kortare men kostar fyra gånger mer
  const short = way([[A.lat, A.lon], [B.lat, B.lon]], { railway: 'rail', service: 'crossover' });
  short.nodes[0] = main.nodes[0];
  short.nodes[1] = main.nodes[main.nodes.length - 1];
  const g = K.buildGraph([main, short]);
  const p = K.legPath(g, { a: A, b: B });
  assert.ok(p.length > 3, 'går längs bågen');
});

test('ingen väg om stationen ligger långt från spåret, eller om vägen är orimligt lång', () => {
  const g = K.buildGraph([way(arc(40, 0.05))]);
  assert.equal(K.legPath(g, { a: A, b: { lat: 59.5, lon: 13.3 } }), null);
  // Väg A→B via en omväg 10 gånger fågelvägen
  const A2 = { lat: 58.5, lon: 13.1 }, B2 = { lat: 58.5, lon: 13.12 };
  const loop = way([[58.5, 13.1], [58.9, 13.1], [58.9, 13.12], [58.5, 13.12]]);
  assert.equal(K.legPath(K.buildGraph([loop]), { a: A2, b: B2 }), null);
});

test('förenklingen behåller formen men tar bort punkter på raka partier', () => {
  const line = [];
  for (let i = 0; i <= 100; i++) line.push([58.5, 13 + i * 0.001]);
  assert.equal(K.simplify(line, 5).length, 2);
  const bend = arc(100, 0.05);
  const s = K.simplify(bend, 6);
  assert.ok(s.length > 5 && s.length < bend.length);
});

test('Overpass-frågan har en rektangel per sträcka och utesluter bangårdsspår', () => {
  const legs = K.routeLegs([{ lat: 58.5, lon: 13.1 }, { lat: null, lon: null }, { lat: 58.5, lon: 13.3 }, { lat: 58.6, lon: 13.4 }]);
  assert.equal(legs.length, 2, 'station utan koordinater hoppas över');
  const q = K.overpassQuery(legs);
  assert.equal((q.match(/way\["railway"="rail"\]/g) || []).length, 2);
  assert.match(q, /yard\|siding\|spur/);
  assert.match(q, /out geom/);
  const box = K.legBox(legs[0]);
  assert.ok(box.s < 58.5 - 0.017 && box.n > 58.5 + 0.017, 'minst 2 km marginal');
});

test('hämtning: saknade sträckor hämtas en gång och sparas; misslyckad sträcka försöks inte igen samma dygn', async () => {
  const route = [{ lat: A.lat, lon: A.lon }, { lat: B.lat, lon: B.lon }, { lat: 59.9, lon: 13.3 }];
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok: true, json: async () => ({ elements: [way(arc(40, 0.05))] }) };
  };
  const cache = {};
  const r1 = await K.loadRouteGeometry(route, cache, fetchFn, 1000);
  assert.equal(calls.length, 1);
  assert.equal(r1.fetched, 2);
  const [k1, k2] = K.routeLegs(route).map(l => l.key);
  assert.ok(r1.paths[k1] && r1.paths[k1].length > 2, 'första sträckan längs spåret');
  assert.equal(r1.paths[k2], null, 'andra sträckan saknar spår');
  assert.ok(decodeURIComponent(calls[0].body).includes('[out:json]'));

  const r2 = await K.loadRouteGeometry(route, cache, fetchFn, 2000);
  assert.equal(calls.length, 1, 'inget nytt anrop');
  assert.deepEqual(r2.paths[k1], r1.paths[k1]);

  await K.loadRouteGeometry(route, cache, fetchFn, 2000 + 25 * 3600 * 1000);
  assert.equal(calls.length, 2, 'misslyckad sträcka försöks igen efter ett dygn');
});

test('hämtning: nätfel sparas inte, andra servern provas', async () => {
  const route = [{ lat: A.lat, lon: A.lon }, { lat: B.lat, lon: B.lon }];
  const urls = [];
  const cache = {};
  const r = await K.loadRouteGeometry(route, cache, async url => { urls.push(url); throw new TypeError('Failed to fetch'); }, 1000);
  assert.equal(urls.length, K.OVERPASS_URLS.length);
  assert.ok(r.error);
  assert.deepEqual(cache, {});
  const ok = await K.loadRouteGeometry(route, cache, async url =>
    url === K.OVERPASS_URLS[0] ? { ok: false, status: 429 } : { ok: true, json: async () => ({ elements: [way(arc(20, 0.02))] }) }, 1000);
  assert.equal(ok.fetched, 1);
});

test('cachen rensar de äldsta sträckorna', () => {
  const cache = {};
  for (let i = 0; i < 155; i++) K.cachePut(cache, 'k' + i, [[0, 0], [1, 1]], i);
  assert.equal(Object.keys(cache.legs).length, 150);
  assert.equal(cache.legs.k0, undefined);
  assert.ok(cache.legs.k154);
});
