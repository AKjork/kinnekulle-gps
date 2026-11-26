# RailTimer – mätdata

Privat repo med mätningar från [RailTimer](https://akjork.github.io/kinnekulle-gps/). Filerna skrivs automatiskt av appen – ändra dem inte för hand.

## Struktur

| Sökväg | Innehåll |
|---|---|
| `korningar/ÅÅÅÅ/<datum>_<tåg>_<id>.json` | En körning (format 2) |
| `gps-spar/ÅÅÅÅ/<datum>_<tåg>_<id>.json` | GPS-spåret för körningen (format 1) |
| `import/<ÅÅÅÅ-MM-DDTHHMMSS>_befintliga-<n>.json` | Mätningar som fanns på telefonen före den första uppladdningen (lista, högst 200 per fil). Samma körning kan finnas i två importfiler om ett försök avbröts – id:t avgör. |
| `.railtimer/anslutning.json` | Senaste anslutningstest från appen |

## Körning, format 2

Samma fält som i appen – `id, trainNumber, vehicleType, startStation, endStation, startedAt, finishedAt, aborted, notes, stops[]` – plus:

- `format: 2`, `appVersion`, `trackPath`
- `interruptions: [{from, to, distanceM}]` – avbrott i mätningen (t.ex. samtal)
- per station: `sig` (Trafikverkets signatur), `lat`, `lon`, `radius`
- vid avbrott: `arrivalWindow`/`departureWindow` `{from, to}` – tiden är då `null` och källan `avbrott` – samt `missedReason: "avbrott"` om stationen passerades helt under avbrottet
- `info.meetings` (från appversion 2026-11-25k, bara när infofliken hittade möten): `[{ sig, name, train, theirPlanned, theirDelayMin, theirSource, waitMin, single, canceled, moved }]` – mötande tåg enligt Trafikverket, senaste läget innan vi åkte från mötesstationen. `waitMin` är appens beräknade väntan, inte uppmätt; `theirSource` är `faktisk`, `trafikverket`, `senast`, `plan` eller `position`. `sig` är tidtabellens mötesplats. Sedan appversion 2026-11-26b: `book: true` när enkel- eller dubbelspåret (`single`) kommer från Trafikverkets linjebok (`railtimer-infra.js`); saknas fältet är det räknat ur tidtabellen.
  - Från appversion 2026-11-25zb: `at` och `atName` när mötet enligt appen blir på en annan plats, `move` `rapporterat` (det mötande tåget rapporterat förbi mötesplatsen mot oss) eller `beräknat` (förutsett när vi är sena), och `onLine: true` när vi möts på dubbelspår mellan stationerna. `theirPlanned`, `theirDelayMin` och `theirSource` gäller då platsen `at`.
  - Från appversion 2026-11-25zh: `via` `rapport` (Trafikverkets rapporter) eller `position` (tågets position längs banan, ur gångprofilerna) när mötet är flyttat, och `position.along: true` när positionen räknats längs banan i stället för fågelvägen.
- `info.trv` (från appversion 2026-11-25zb, bara Mät tidtabell): Trafikverkets svar under resan för vårt tåg och de mötande tågen, så att det går att pröva om ett flyttat möte syntes i förväg. `{ v: 1, t0, line, rows, full? }`: `t0` resans start (ISO), `line` platserna på linjen (signaturer, även driftplatser), `full: true` om loggen nådde 600 rader. Bara ändringar sparas. Tider är sekunder från `t0`, `null` om de saknas. Raderna:
  - `['a', s, tåg, plats, 'a'|'d', planerad, beräknad, rapporterad, inställd 0/1, preliminär 0/1, ändrad, avvikelser]` – en annonsering (Ankomst/Avgang) när den ändrats. *Beräknad* är `EstimatedTimeAtLocation`, *preliminär* `EstimatedTimeIsPreliminary`, *ändrad* `ModifiedTime`, avvikelserna med ` | ` emellan.
  - `['p', s, tåg, lat, lon, km/h, positionens tid]` – mötande tågs position (TrainPosition), när tåget flyttat sig minst 200 m eller efter 3 min.
  - `['m', s, tåg, tidtabellens mötesplats, mötesplats enligt appen, 'rapporterat'|'beräknat'|'', väntan min, deras försening min, källa]` – vad appen räknade med, när det ändrats. Från appversion 2026-11-25zh två fält till: `'rapport'|'position'|''` (varför mötet flyttats) och tågets sida om mötesplatsen enligt appen, längs banan: `'beyond'|'at'|'passed'|'behind'`, tomt när positionen saknas eller räknats fågelvägen.
  - `['e', s, beräknad ankomst till slutstationen (hel minut), försening min]` – appens prognos, när den ändrats.
- `info.events` (från appversion 2026-11-25r): trafikhändelser (OperativeEvent) som rör platser på tågets linje: `[{ id, header, type, sigs, shown, reason, start, end, raw }]`. `shown: false` med `reason` `planerat arbete`, `annan bana` eller `inte under resan` visades inte i infofliken. `raw` är Trafikverkets original som JSON, högst 4 000 tecken.
- `info.marked` (från appversion 2026-11-25w, bara när föraren markerat anslutningar med ☆ i Info): `[{ sig, name, dir, kind, train, to, from, planned, status, transferMin, suggested }]` – anslutningar som resenärer skulle byta till, senaste läget under resan. `dir` är `ut` (från stationen) eller `in` (till oss), `kind` `tåg` eller `buss` (Västtrafik, `train` är då linjen), `status` `ok`, `knappt`, `missas`, `avgått` eller `inställt`. `suggested: true` betyder att appen föreslog att ringa trafikledningen. Från appversion 2026-11-25zi även egna anslutningar (Mina anslutningar): `marked` (markerad med ★) och `own` (egen) säger vilket; saknas fälten är anslutningen markerad.
- `startedBy: 'auto'` (från appversion 2026-11-25r): resan startade av sig själv när tåget rullade iväg från startstationen.
- `advertisedTrainNumber`, `trainNumberEntered` (från appversion 2026-11-25zg): föraren skriver tågorderns operativa tågnummer (OTN), tågvärden det annonserade (ATN), till exempel 23349 och 3349. När Trafikverket har svarat är `trainNumber` OTN (vid startstationen, om numret byts längs vägen), `advertisedTrainNumber` ATN och `trainNumberEntered` `'otn'` eller `'atn'` – vilket som skrevs. Utan svar är `trainNumber` numret som skrevs och fälten saknas. Äldre körningar har bara `trainNumber`.

- per station `slideIn: true` / `slipOut: true` (från appversion 2026-11-25q, bara när föraren markerat): halt – tåget gled vid inbromsningen till stationen respektive slirade vid starten därifrån. Markeras när tåget står vid stationen eller i stationskortet, aldrig automatiskt.

Körningar utan `format` är äldre (format 1).

## GPS-spår, format 1

`{ format, runId, trainNumber, t0, fields, points }` där `fields` är `["t_ms","lat","lon","acc_m","speed_ms","heading_deg","fixAge_ms"]` och varje punkt är en lista i den ordningen. `t_ms` räknas från `t0` med appens klocka – samma klocka som körningens tider.

## platsminnen.json (från appversion 2026-11-25t)

Förarnas platsminnen, en kort anteckning per station som appen visar och läser upp när tåget närmar sig: `{ format: 1, updatedAt, notes: { 'sig:Vaa': { text, at, name } } }`. Nyckeln är stationens signatur (`sig:`), annars namnet (`namn:`). `text: ''` betyder borttaget. Appen slår ihop med telefonens minnen när den synkar, och det nyaste (`at`) gäller per station.
