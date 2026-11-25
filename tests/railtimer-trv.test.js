'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const TRV = require('../railtimer-trv.js');

// Annonseringar som Trafikverket skickar dem (tider med tidszon, sekunder i TimeAtLocationWithSeconds)
function ann(sig, activity, advertised, reported, extra) {
  return Object.assign({
    LocationSignature: sig, ActivityType: activity, Advertised: true,
    AdvertisedTimeAtLocation: advertised, OperationalTrainNumber: '24360',
    TimeAtLocation: reported ? reported.replace(/:\d\d\.000/, ':00.000') : undefined,
    TimeAtLocationWithSeconds: reported || undefined
  }, extra || {});
}

const ANNS = [
  ann('Hrc', 'Avgang', '2026-11-24T19:40:00.000+01:00', '2026-11-24T19:40:12.000+01:00', { TrackAtLocation: '3', Operator: 'SJ', ProductInformation: [{ Code: 'PNA054', Description: 'Västtågen' }] }),
  ann('Ved', 'Ankomst', '2026-11-24T19:47:00.000+01:00', '2026-11-24T19:47:20.000+01:00', { TrackAtLocation: '1' }),
  ann('Ved', 'Avgang', '2026-11-24T19:48:00.000+01:00', '2026-11-24T19:47:55.000+01:00', { TrackAtLocation: '1', LocationDateTimeOTN: '2026-11-24T19:47:30.000+01:00' }),
  ann('Vaa', 'Ankomst', '2026-11-24T19:55:00.000+01:00', '2026-11-24T19:55:40.000+01:00'),
  ann('Vaa', 'Avgang', '2026-11-24T19:58:00.000+01:00', null, { Canceled: true, Deviation: [{ Code: 'ANA002', Description: 'Inställt' }] }),
  ann('Mst', 'Ankomst', '2026-11-24T21:19:00.000+01:00', null)
];

function run() {
  return {
    id: 'mwv0y2ak', trainNumber: '24360 ', startedAt: '2026-11-24T18:24:45.596Z', finishedAt: '2026-11-24T20:19:41.923Z',
    stops: [
      { name: 'Herrljunga C', sig: 'Hrc', actualDeparture: '2026-11-24T18:40:03.898Z', scheduledDeparture: '2026-11-24T18:40:00.000Z', departSource: 'gps' },
      { name: 'Vedum', sig: 'Ved', actualArrival: '2026-11-24T18:47:27.904Z', actualDeparture: '2026-11-24T18:47:30.548Z', scheduledArrival: '2026-11-24T18:47:00.000Z', scheduledDeparture: '2026-11-24T18:48:00.000Z', arrivalSource: 'gps', departSource: 'gps' },
      { name: 'Vara', sig: 'Vaa', actualArrival: '2026-11-24T18:55:45.905Z', actualDeparture: '2026-11-24T18:59:41.908Z', scheduledArrival: '2026-11-24T18:55:00.000Z', scheduledDeparture: '2026-11-24T18:58:00.000Z', arrivalSource: 'gps', departSource: 'manual' },
      { name: 'Utan signatur', actualArrival: '2026-11-24T19:10:00.000Z' },
      { name: 'Mariestad', sig: 'Mst', actualArrival: '2026-11-24T20:19:30.000Z', scheduledArrival: '2026-11-24T20:19:00.000Z', arrivalSource: 'gps' }
    ]
  };
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('buildQuery: filter, include, namespace och tecken som måste skyddas', () => {
  const xml = TRV.buildQuery({
    namespace: 'järnväg.trafikinfo', objecttype: 'TrainPosition', schemaversion: '1.1', limit: 5, orderby: 'TimeStamp desc',
    filter: { op: 'AND', items: [{ op: 'EQ', name: 'Train.OperationalTrainNumber', value: '1"<2' }, { op: 'IN', name: 'X', value: 'a,b' }] },
    include: ['Speed']
  });
  assert.equal(xml, '<QUERY namespace="järnväg.trafikinfo" objecttype="TrainPosition" schemaversion="1.1" limit="5" orderby="TimeStamp desc">'
    + '<FILTER><AND><EQ name="Train.OperationalTrainNumber" value="1&quot;&lt;2" /><IN name="X" value="a,b" /></AND></FILTER>'
    + '<INCLUDE>Speed</INCLUDE></QUERY>');
  assert.match(TRV.buildRequest('k&y', []), /^<REQUEST><LOGIN authenticationkey="k&amp;y" \/><\/REQUEST>$/);
});

test('query: ger posterna, och fel från API:t blir undantag med Trafikverkets text', async () => {
  let body = null;
  const records = await TRV.query({ objecttype: 'TrainStation', schemaversion: '1.4' }, {
    fetch: async (url, init) => { body = init.body; return okResponse({ RESPONSE: { RESULT: [{ TrainStation: [{ LocationSignature: 'Ved' }] }] } }); }
  });
  assert.deepEqual(records, [{ LocationSignature: 'Ved' }]);
  assert.match(body, /authenticationkey="1acaea82911c472cb3409d57ae19707f"/);

  const err = await TRV.query({ objecttype: 'TrainPosition', schemaversion: '9' }, {
    fetch: async () => ({ ok: false, status: 400, json: async () => ({ RESPONSE: { RESULT: [{ ERROR: { SOURCE: 'Request', MESSAGE: 'Invalid schemaversion' } }] } }) })
  }).catch(e => e);
  assert.equal(err.kind, 'api');
  assert.equal(err.message, 'Request: Invalid schemaversion');

  const empty = await TRV.query({ objecttype: 'TrainMessage', schemaversion: '1.7' }, { fetch: async () => okResponse({ RESPONSE: { RESULT: [{}] } }) });
  assert.deepEqual(empty, []);
});

test('query: nätfel och tidsgräns', async () => {
  const net = await TRV.query({ objecttype: 'X', schemaversion: '1' }, { fetch: async () => { throw new TypeError('Failed to fetch'); } }).catch(e => e);
  assert.equal(net.kind, 'network');
  const slow = await TRV.query({ objecttype: 'X', schemaversion: '1' }, {
    timeoutMs: 20,
    fetch: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  }).catch(e => e);
  assert.equal(slow.kind, 'timeout');
  const http = await TRV.query({ objecttype: 'X', schemaversion: '1' }, { fetch: async () => ({ ok: false, status: 503, json: async () => { throw new Error('ingen json'); } }) }).catch(e => e);
  assert.equal(http.kind, 'http');
  assert.equal(http.message, 'HTTP 503');
});

test('swedishLocal: svensk tid oavsett datorns tidszon, även sommartid', () => {
  assert.equal(TRV.swedishLocal('2026-11-24T23:30:00Z'), '2026-11-25T00:30:00');
  assert.equal(TRV.swedishLocal('2026-07-01T22:15:09Z'), '2026-07-02T00:15:09');
  assert.equal(TRV.swedishDay('2026-11-24T23:30:00Z'), '2026-11-25');
  assert.equal(TRV.swedishLocal(null), null);
});

test('runQuery: tågnummer utan mellanslag och fönster ± 3 h i svensk tid', () => {
  const q = TRV.runQuery(run());
  const items = q.filter.items;
  assert.deepEqual(items[0], { op: 'EQ', name: 'OperationalTrainNumber', value: '24360' });
  assert.equal(items[1].value, '2026-11-24T16:24:45'); // start 19:24:45 svensk tid − 3 h
  assert.equal(items[2].value, '2026-11-25T00:19:41'); // slut 21:19:41 svensk tid + 3 h
  assert.ok(q.include.includes('TimeAtLocationWithSeconds'));
  assert.equal(TRV.runQuery({ trainNumber: '', stops: [] }), null);
});

test('trafikverketTimes: rapporterade tider, operativ tid, spår, inställt och avvikelser per station', () => {
  const r = run();
  const res = TRV.trafikverketTimes(r, ANNS, Date.parse('2026-11-24T20:20:00Z'));
  assert.equal(res.stops.length, 5);
  assert.deepEqual(res.stops[0], { departure: '2026-11-24T19:40:12.000+01:00', track: '3' });
  assert.deepEqual(res.stops[1], { arrival: '2026-11-24T19:47:20.000+01:00', departure: '2026-11-24T19:47:55.000+01:00', track: '1' });
  assert.deepEqual(res.stops[2], { arrival: '2026-11-24T19:55:40.000+01:00', canceled: true, deviations: ['Inställt'] });
  assert.equal(res.stops[3], null);
  assert.deepEqual(res.stops[4], {});
  assert.equal(res.meta.found, 4);
  assert.equal(res.meta.complete, false, 'Mariestad är inte rapporterad än');
  assert.equal(res.meta.operator, 'SJ');
  assert.equal(res.meta.product, 'Västtågen');
  assert.equal(res.meta.fetchedAt, '2026-11-24T20:20:00.000Z');
});

test('trafikverketTimes: allt rapporterat ger complete, inställda räknas inte', () => {
  const anns = ANNS.slice(0, 5).concat([ann('Mst', 'Ankomst', '2026-11-24T21:19:00.000+01:00', '2026-11-24T21:19:10.000+01:00')]);
  assert.equal(TRV.trafikverketTimes(run(), anns).meta.complete, true);
});

test('matchAnnouncement: närmast i tid när tåget passerar samma station två gånger', () => {
  const anns = [ann('Ved', 'Ankomst', '2026-11-24T08:00:00.000+01:00', null), ann('Ved', 'Ankomst', '2026-11-24T19:47:00.000+01:00', null)];
  assert.equal(TRV.matchAnnouncement(anns, 'Ved', 'Ankomst', Date.parse('2026-11-24T18:46:00Z')), anns[1]);
  assert.equal(TRV.matchAnnouncement(anns, 'Ved', 'Avgang', 0), null);
});

test('applyTrafikverket och compareRun: appen − Trafikverket i sekunder, källa och läge', () => {
  const r = run();
  TRV.applyTrafikverket(r, TRV.trafikverketTimes(r, ANNS, 0));
  assert.equal(r.trv.found, 4);
  assert.equal(r.stops[3].trv, undefined);
  const rows = TRV.compareRun(r);
  const pick = rows.map(x => [x.sig, x.kind, x.diffS, x.source]);
  assert.deepEqual(pick, [
    ['Hrc', 'departure', -8, 'gps'],
    ['Ved', 'arrival', 8, 'gps'],
    ['Ved', 'departure', -24, 'gps'],
    ['Vaa', 'arrival', 6, 'gps']
  ]);
  assert.equal(rows[0].first, true);
  const sum = TRV.summarizeComparison(rows);
  assert.equal(sum.arrival.n, 2);
  assert.equal(sum.arrival.median, 7);
  assert.equal(sum.departure.median, -16);
  assert.equal(sum.departure.within10, 1);
  assert.equal(sum.largest[0].diffS, -24);
  assert.deepEqual(sum.stations.map(s => `${s.name} ${s.kind} ${s.n}`), ['Herrljunga C departure 1', 'Vara arrival 1', 'Vedum arrival 1', 'Vedum departure 1']);
});

test('needsTrafikverket: utan tider, ofullständigt strax efter resan, men inte gamla körningar eller utan tågnummer', () => {
  const now = Date.parse('2026-11-24T20:25:00Z');
  const r = run();
  assert.equal(TRV.needsTrafikverket(r, now), true);
  r.trv = { fetchedAt: '2026-11-24T20:20:00Z', complete: false };
  assert.equal(TRV.needsTrafikverket(r, now), true);
  r.trv = { fetchedAt: '2026-11-24T20:40:00Z', complete: false };
  assert.equal(TRV.needsTrafikverket(r, now), false, 'hämtat mer än 15 min efter resan: det som finns är slutgiltigt');
  r.trv = { fetchedAt: '2026-11-24T20:20:00Z', complete: true };
  assert.equal(TRV.needsTrafikverket(r, now), false);
  assert.equal(TRV.needsTrafikverket(Object.assign(run(), { trainNumber: '' }), now), false);
  assert.equal(TRV.needsTrafikverket(run(), now + 4 * 864e5), false, 'Trafikverket sparar bara några dygn');
});

test('fieldSummary: fält i nästlade listor, antal poster och upp till tre exempel', () => {
  const s = TRV.fieldSummary(ANNS);
  const by = Object.fromEntries(s.map(f => [f.path, f]));
  assert.equal(by.LocationSignature.count, 6);
  assert.deepEqual(by.LocationSignature.examples, ['Hrc', 'Ved', 'Vaa']);
  assert.equal(by['Deviation.Description'].count, 1);
  assert.equal(by['ProductInformation.Description'].examples[0], 'Västtågen');
  assert.equal(by.TrackAtLocation.count, 3);
  assert.equal(by.TimeAtLocationWithSeconds.count, 4);
  assert.equal(by.Canceled.count, 1);
  assert.deepEqual(TRV.fieldSummary([{ Counties: [14, 15] }])[0], { path: 'Counties', count: 1, examples: ['14, 15'] });
});

test('pickRuns: de senaste plus en körning per ålder, bara körningar med tågnummer och signaturer', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const mk = (id, daysAgo, extra) => Object.assign({ id, trainNumber: '24360', startedAt: new Date(now - daysAgo * 864e5).toISOString(), stops: [{ sig: 'Ved', actualArrival: 'x' }] }, extra);
  const logs = [mk('a', 1), mk('b', 8), mk('c', 31), mk('d', 95), mk('e', 3, { trainNumber: '' }), mk('f', 4, { stops: [{ name: 'X', actualArrival: 'x' }] })];
  const picked = TRV.pickRuns(logs, now, 1);
  assert.deepEqual(picked.map(p => `${p.run.id}:${p.reason}`), ['a:senaste', 'b:7 dagar', 'c:30 dagar', 'd:90 dagar']);
});

test('runCheck: varje del för sig, även när en del ger fel, och jämförelse mot körningarna', async () => {
  const seen = [];
  const bodies = [];
  const fakeFetch = async (url, init) => {
    const type = /objecttype="([^"]+)"/.exec(init.body)[1];
    seen.push(type);
    bodies.push(init.body);
    const result = {
      TrainAnnouncement: () => (/AdvertisedTimeAtLocation" value="2026-11-24T00:00:00"/.test(init.body) ? ANNS : ANNS.slice(0, 4)),
      TrainPosition: () => (/<EQ name="Train.OperationalTrainNumber"/.test(init.body) ? [{ Train: { OperationalTrainNumber: '24360' }, Speed: 80, TimeStamp: '2026-11-24T20:00:00.000+01:00', Position: { WGS84: 'POINT (13.0 58.1)' } }]
        : [{ Train: { OperationalTrainNumber: '24360' }, TimeStamp: '2026-11-24T20:59:00.000+01:00', Speed: 50 }, { Train: { OperationalTrainNumber: '9' }, TimeStamp: '2026-11-24T10:00:00.000+01:00' }]),
      TrainStation: () => (/<IN /.test(init.body) ? [{ LocationSignature: 'Ved', PlatformLine: ['1', '2'] }]
        : [{ LocationSignature: 'Ved', Advertised: true }, { LocationSignature: 'Hrc', Advertised: true }, { LocationSignature: 'Xx', Advertised: false, Geometry: { WGS84: 'POINT (1 2)' } }]),
      OperativeEvent: () => [
        { EventType: { Description: 'Banarbete' }, EventSections: [{ FromLocation: { Signature: 'Vaa' }, ToLocation: { Signature: 'Grn' } }], TrafficImpact: [{ PublicMessage: { Header: 'Banarbete Vara' } }] },
        { EventType: { Description: 'Annat' }, EventSections: [{ FromLocation: { Signature: 'Cst' } }] }
      ],
      TrainStationMessage: () => [{ LocationCode: 'Ved', FreeText: 'Spårändring', EndDateTime: '2026-11-24T23:00:00.000+01:00' }],
      ReasonCode: () => [{ Code: 'ANA002', Level1Description: 'Inställt' }]
    }[type];
    if (!result || /schemaversion="2.0"/.test(init.body)) return { ok: false, status: 400, json: async () => ({ RESPONSE: { RESULT: [{ ERROR: { SOURCE: 'Request', MESSAGE: `Okänd ${type}` } }] } }) };
    return okResponse({ RESPONSE: { RESULT: [{ [type]: result() }] } });
  };
  const progress = [];
  const out = await TRV.runCheck({
    fetch: fakeFetch, trainNumber: '24360', date: '2026-11-24', logs: [run()], nowMs: Date.parse('2026-11-24T20:05:00Z'),
    sleep: async () => {}, onProgress: t => progress.push(t)
  });
  const s = out.sections;
  assert.equal(s.announcements.count, 6);
  assert.deepEqual(s.announcements.sigs, ['Hrc', 'Ved', 'Vaa', 'Mst']);
  assert.equal(s.positions.train.count, 1);
  assert.deepEqual(s.positions.national, { count: 2, last10min: 1, withSpeed: 1, myTrainsSeen: ['24360'], myTrainsCount: 1 });
  assert.deepEqual(s.stations.all, { count: 3, advertised: 2, notAdvertised: 1, notAdvertisedWithPosition: 1, routeNotAdvertised: [] });
  assert.equal(s.stations.route.fields[1].path, 'PlatformLine');
  assert.equal(s.messages.onRouteCount, 1);
  assert.equal(s.messages.onRoute[0].TrafficImpact[0].PublicMessage.Header, 'Banarbete Vara');
  assert.ok(bodies.some(b => /namespace="ols.open" objecttype="OperativeEvent" schemaversion="1.0"/.test(b) && /<EQ name="EventState" value="1" \/>/.test(b)), 'OperativeEvent, bara pågående');
  assert.ok(bodies.some(b => /TrainStationMessage/.test(b) && /<IN name="LocationCode" value="Hrc,Ved,Vaa,Mst" \/>/.test(b) && /<GT name="EndDateTime" value="2026-11-24T21:05:00" \/>/.test(b)), 'stationsmeddelanden som gäller nu för tågets stationer');
  assert.equal(s.stationMessages.onRouteCount, 1);
  assert.deepEqual(s.namespaces.map(v => [v.label, v.ok]), [
    ['TrainAnnouncement 1.9 utan namespace (appen i dag)', true], ['TrainAnnouncement 1.9 rail.trafficinfo', true],
    ['TrainAnnouncement 2.0 rail.trafficinfo', false], ['TrainStation 1.4 rail.trafficinfo', true]
  ]);
  assert.equal(s.namespaces[2].error, 'Request: Okänd TrainAnnouncement');
  assert.equal(s.reasonCodes.count, 1);
  assert.equal(s.comparison.runs.length, 1);
  assert.equal(s.comparison.runs[0].announcements, 4);
  assert.equal(s.comparison.rows.length, 4);
  assert.equal(s.comparison.rows[0].date, '2026-11-24');
  assert.equal(progress[progress.length - 1], 'Klart');
  assert.ok(seen.includes('TrainStationMessage'));
});

test('runCheck: utan kontakt avbryts kontrollen efter första frågan', async () => {
  let calls = 0;
  const out = await TRV.runCheck({ fetch: async () => { calls++; throw new TypeError('Failed to fetch'); }, trainNumber: '1', date: '2026-11-24', logs: [run()], sleep: async () => {} });
  assert.equal(calls, 1);
  assert.equal(out.aborted, 'Ingen kontakt med Trafikverket');
  assert.deepEqual(out.sections, {});
});

test('hela minuter: tider på :00 jämförs inte i sekunder och anges för sig', () => {
  assert.equal(TRV.wholeMinute('2026-11-24T19:47:00.000+01:00'), true);
  assert.equal(TRV.wholeMinute('2026-11-24T19:47:20.000+01:00'), false);
  assert.equal(TRV.wholeMinute(null), false);
  const r = run();
  const anns = ANNS.slice(0, 4).map(a => a.LocationSignature === 'Ved' && a.ActivityType === 'Ankomst' ? Object.assign({}, a, { TimeAtLocationWithSeconds: '2026-11-24T19:47:00.000+01:00' }) : a);
  TRV.applyTrafikverket(r, TRV.trafikverketTimes(r, anns, 0));
  const rows = TRV.compareRun(r);
  assert.deepEqual(rows.filter(x => x.wholeMinute).map(x => `${x.sig} ${x.kind}`), ['Ved arrival']);
  const sum = TRV.summarizeComparison(rows);
  assert.equal(sum.arrival.n, 1, 'bara Vara räknas');
  assert.equal(sum.minuteRows, 1);
  assert.deepEqual(sum.minuteStations, ['Vedum']);
});

test('signaturesIn: signaturer på alla nivåer i en OperativeEvent', () => {
  const ev = { EventSections: [{ FromLocation: { Signature: 'Vaa' }, ViaLocation: { Signature: 'Ved' } }], TrafficImpact: [{ SelectedSections: [{ SectionLocations: [{ Signature: 'Hrc' }] }] }], LocationSignature: 'Gdö' };
  assert.deepEqual(TRV.signaturesIn(ev).sort(), ['Gdö', 'Hrc', 'Vaa', 'Ved']);
});

test('wgs84: läser punkt från Trafikverkets format', () => {
  assert.deepEqual(TRV.wgs84('POINT (12.99868 58.16898)'), { lon: 12.99868, lat: 58.16898 });
  assert.equal(TRV.wgs84(''), null);
});
