'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../railtimer-info.js');
const X = require('../railtimer-infra.js');

/* Trafikverkets underlag i railtimer-infra.js (tools/infrastruktur.mjs): linjeboken TC Göteborg och TC Hallsberg och
   järnvägsnätsbeskrivningen 2027 bilaga 2 A. Kontrollerat mot banstandarden (bilaga 2 B) och tågens verkliga väg. */

test('infra: 23349 Hallsberg pbg → Herrljunga C – dubbelspår till Gårdsjö, sedan enkelspår', () => {
  // Platserna i Trafikverkets svar för 23349 2026-11-25 (railtimer-data/api-koll), i ordning
  const line = 'Hpbg Hrbg Täl Öj Vt Lln Lå Väv Fa Gdö Hova Lyd Hsr Mst Lnå Äsr Öäg Fhm Hlk Rbk Trm Bmb Kll Fiä Lkp Fc Lve Jps Stlv Håp Vaa Ved Hrc'.split(' ');
  const kinds = line.slice(1).map((s, i) => I.trackKind(X, line[i], s) || '?').join('');
  // Inom Hallsbergs driftplats okänt, Östansjö–Gårdsjö dubbelspår (Västra stambanan), Gårdsjö–Herrljunga enkelspår
  assert.equal(kinds, '???' + 'D'.repeat(6) + 'E'.repeat(23));
  // Mötesplatser (möteslängd) på Kinnekullebanan och Älvsborgsbanan – inte Hällekis, Råbäck eller Källby
  assert.deepEqual(I.infraMeetPlaces(X, line.slice(9)), ['Gdö', 'Hova', 'Lyd', 'Mst', 'Fhm', 'Lkp', 'Jps', 'Håp', 'Vaa', 'Ved', 'Hrc']);
});

test('infra: övriga banor, och platser som inte är grannar i linjeboken', () => {
  assert.equal(I.trackKind(X, 'Fby', 'Hrc'), 'D', 'Falköping–Herrljunga: linjebokens rubrik säger Enkelspår, banstandarden (bandel 611) dubbelspår');
  assert.equal(I.trackKind(X, 'Hrc', 'Agg'), null, 'genom Herrljungas driftplatsdelar okänt');
  assert.equal(I.trackKind(X, 'Vgå', 'A'), 'D', 'Vårgårda–Alingsås');
  assert.equal(I.trackKind(X, 'Thn', 'Veas'), 'D', 'Trollhättan–Göteborg');
  assert.equal(I.trackKind(X, 'Öx', 'Vg'), 'E', 'Öxnered–Vänersborg (Älvsborgsbanan)');
  assert.equal(I.trackKind(X, 'Lkp', 'Jps'), 'E', 'Lidköping–Järpås förbi Framnäs city och Lovene');
  assert.equal(I.trackKind(X, 'Gdö', 'Håp'), 'E', 'hela Kinnekullebanan');
  assert.equal(I.trackKind(X, 'Fa', 'Hova'), null, 'dubbelspår och enkelspår blandat');
});

test('infra: plattformar vid våra stationer', () => {
  assert.equal(I.platformInfo(X, 'Hrc', '2', '3').same, true);
  assert.equal(I.platformInfo(X, 'Hrc', '1', '2').same, true);
  assert.equal(I.platformInfo(X, 'Hrc', '4', '5').same, true);
  assert.equal(I.platformInfo(X, 'Hrc', '3', '4').same, false);
  assert.equal(I.platformInfo(X, 'Hrc', '6', '7').same, false);
  assert.equal(I.platformInfo(X, 'Vaa', '1', '2').same, true);
  assert.equal(I.platformInfo(X, 'Håp', '1', '2').same, true);
  assert.equal(I.platformInfo(X, 'Mst', '5', '6').same, true);
  assert.equal(I.platformInfo(X, 'Lkp', '1', '2').same, false);
  assert.equal(I.platformInfo(X, 'Ved', '1', '2').same, false);
  assert.equal(I.platformInfo(X, 'Gdö', '3', '4').same, true);
  assert.equal(I.platformInfo(X, 'Lå', '2', '3').same, true);
  assert.equal(I.platformInfo(X, 'Lå', '1', '2').same, false);
  assert.equal(I.platformInfo(X, 'Hlk', '1', '2'), null, 'Hällekis: plattform vid spåret på linjen, utan spårnummer');
});

test('infra: källorna står i filen', () => {
  assert.ok(X.sources.some(s => /linjebok/.test(s)));
  assert.ok(X.sources.some(s => /bilaga 2 A/.test(s)));
  assert.ok(X.lines.length > 20 && X.meet.split(' ').length > 800 && Object.keys(X.platforms).length > 400);
});
