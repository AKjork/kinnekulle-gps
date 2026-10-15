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

Körningar utan `format` är äldre (format 1).

## GPS-spår, format 1

`{ format, runId, trainNumber, t0, fields, points }` där `fields` är `["t_ms","lat","lon","acc_m","speed_ms","heading_deg","fixAge_ms"]` och varje punkt är en lista i den ordningen. `t_ms` räknas från `t0` med appens klocka – samma klocka som körningens tider.
