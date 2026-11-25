# RailTimer – mätdata

Privat repo med mätningar från [RailTimer](https://akjork.github.io/kinnekulle-gps/). Filerna skrivs automatiskt av appen – ändra dem inte för hand.

## Struktur

| Sökväg | Innehåll |
|---|---|
| `korningar/ÅÅÅÅ/<datum>_<tåg>_<id>.json` | En körning (format 2) |
| `gps-spar/ÅÅÅÅ/<datum>_<tåg>_<id>.json` | GPS-spåret för körningen (format 1) |
| `import/<ÅÅÅÅ-MM-DDTHHMMSS>_befintliga-<n>.json` | Mätningar som fanns på telefonen före den första uppladdningen (lista, högst 200 per fil). Samma körning kan finnas i två importfiler om ett försök avbröts – id:t avgör. |
| `.railtimer/anslutning.json` | Senaste anslutningstest från appen |
| `.github/workflows/bevakning.yml` | Notiser i bakgrunden (se nedan) |

## Körning, format 2

Samma fält som i appen – `id, trainNumber, vehicleType, startStation, endStation, startedAt, finishedAt, aborted, notes, stops[]` – plus:

- `format: 2`, `appVersion`, `trackPath`
- `interruptions: [{from, to, distanceM}]` – avbrott i mätningen (t.ex. samtal)
- per station: `sig` (Trafikverkets signatur), `lat`, `lon`, `radius`
- vid avbrott: `arrivalWindow`/`departureWindow` `{from, to}` – tiden är då `null` och källan `avbrott` – samt `missedReason: "avbrott"` om stationen passerades helt under avbrottet
- `info.meetings` (från appversion 2026-11-25k, bara när infofliken hittade möten): `[{ sig, name, train, theirPlanned, theirDelayMin, theirSource, waitMin, single, canceled, moved }]` – mötande tåg enligt Trafikverket, senaste läget innan vi åkte från mötesstationen. `waitMin` är appens beräknade väntan, inte uppmätt; `theirSource` är `faktisk`, `trafikverket`, `senast` eller `plan`
- `info.events` (från appversion 2026-11-25r): trafikhändelser (OperativeEvent) som rör platser på tågets linje: `[{ id, header, type, sigs, shown, reason, start, end, raw }]`. `shown: false` med `reason` `planerat arbete`, `annan bana` eller `inte under resan` visades inte i infofliken. `raw` är Trafikverkets original som JSON, högst 4 000 tecken.
- `info.marked` (från appversion 2026-11-25w, bara när föraren markerat anslutningar med ☆ i Info): `[{ sig, name, dir, kind, train, to, from, planned, status, transferMin, suggested }]` – anslutningar som resenärer skulle byta till, senaste läget under resan. `dir` är `ut` (från stationen) eller `in` (till oss), `kind` `tåg` eller `buss` (Västtrafik, `train` är då linjen), `status` `ok`, `knappt`, `missas`, `avgått` eller `inställt`. `suggested: true` betyder att appen föreslog att ringa trafikledningen.
- `startedBy: 'auto'` (från appversion 2026-11-25r): resan startade av sig själv när tåget rullade iväg från startstationen.

- per station `slideIn: true` / `slipOut: true` (från appversion 2026-11-25q, bara när föraren markerat): halt – tåget gled vid inbromsningen till stationen respektive slirade vid starten därifrån. Markeras när tåget står vid stationen eller i stationskortet, aldrig automatiskt.

Körningar utan `format` är äldre (format 1).

## GPS-spår, format 1

`{ format, runId, trainNumber, t0, fields, points }` där `fields` är `["t_ms","lat","lon","acc_m","speed_ms","heading_deg","fixAge_ms"]` och varje punkt är en lista i den ordningen. `t_ms` räknas från `t0` med appens klocka – samma klocka som körningens tider.

## platsminnen.json (från appversion 2026-11-25t)

Förarnas platsminnen, en kort anteckning per station som appen visar och läser upp när tåget närmar sig: `{ format: 1, updatedAt, notes: { 'sig:Vaa': { text, at, name } } }`. Nyckeln är stationens signatur (`sig:`), annars namnet (`namn:`). `text: ''` betyder borttaget. Appen slår ihop med telefonens minnen när den synkar, och det nyaste (`at`) gäller per station.

## Notiser i bakgrunden

`.github/workflows/bevakning.yml` körs när appen skickar `repository_dispatch` med uppladdningens token:

- `bevaka`: appen har lämnats under en resa med tågnummer. Bevakningen hämtar Trafikverkets data varje minut, räknar som appens infoflik och skickar en webbpush till telefonen när något blir värre. Den slutar när tåget är framme, när appen skickar `bevaka-stopp` eller efter högst 6 timmar.
- `bevaka-stopp`: appen har visats i 3 minuter igen, eller resan är slut. Stoppar telefonens bevakning (en bevakning per telefon).
- `bevaka-test`: en testnotis.

Koden ligger i kinnekulle-gps (`bevakning/bevaka.js` och `bevakning/webpush.js`). Begäran innehåller telefonens prenumeration och dess VAPID-nyckel, så inga hemligheter behöver läggas in här. Körningarna räknas mot GitHubs gratisminuter för privata repon (2 000 minuter i månaden), men bara medan appen är stängd under en resa.
