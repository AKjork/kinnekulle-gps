# Kinnekulle Tågmonitor

## Projektöversikt
GPS-baserad app för att logga tågresor längs Kinnekullebanan. Används av tågförare för att automatiskt registrera ankomst- och avgångstider vid stationer.

## Tech Stack
- **Single HTML-fil** med inbäddad CSS och JavaScript
- **Vanilla JS** - inga frameworks
- **PWA** - Service Worker för offline, installerbar på mobil
- **localStorage** - lokal datalagring
- **Geolocation API** - GPS-spårning med geofencing
- **Trafikverket API** - hämtar tidtabellsdata

## Huvudfiler
| Fil | Beskrivning |
|-----|-------------|
| `Kinnekulle GPS.html` | Huvudappen (GPS-version) |
| `index.html` | Kopia av GPS-appen för GitHub Pages |
| `sw.js` | Service Worker för PWA |
| `kinnekulle-gps.webmanifest` | PWA manifest |

## Viktiga konstanter (i koden)
```javascript
SPEED_THRESHOLD_KMH = 5      // Hastighet för "stillastående" (<5 km/h = stannat)
PASS_DISTANCE_MARGIN = 5     // Meter för att detektera passering
DEFAULT_RADIUS = 100         // Standard geofence-radie (meter)
EXTRA_MARGIN = 120           // Extra marginal för geofence-utgång
```

## Stationslogik

### Grundprincip
- Ankomst "rullar" och uppdateras tills tåget stannar
- Avgång registreras endast när tåget faktiskt börjar röra sig igen
- Fungerar oavsett vilken sida om mittpunkten tåget stannar på

### Ankomst
1. Registreras när tåget kommer in i geofence (radie)
2. Uppdateras löpande till närmaste punkt mot centrum
3. **Låses** när tåget stannar (<5 km/h)

### Avgång (för stationer med shouldStop=true)
- Kräver att `reachedLowSpeed=true` (tåget har stannat)
- Triggas av `processSpeedTriggers` när hastighet går över 5 km/h igen
- Geofence-utgång markerar avgång ENDAST om tåget rör sig (>5 km/h)
- GPS-fluktuation medan stillastående triggar INTE avgång

### Passering (för stationer med shouldStop=false)
- `markPassingDeparture` triggas ENDAST för stationer utan planerat stopp
- Kräver hastighet >5 km/h (dvs rör sig) efter att ha passerat mittpunkten
- Ankomst = närmaste punkt, Avgång = strax efter
- Fungerar vid alla hastigheter så länge tåget inte stannar

## Viktiga funktioner

| Funktion | Ansvar |
|----------|--------|
| `handleStationEntry` | Registrerar ankomst vid geofence-ingång |
| `trackClosestApproach` | Uppdaterar ankomst till närmaste punkt |
| `processSpeedTriggers` | Hanterar stopp/avgång baserat på hastighet |
| `handleStationExit` | Hanterar geofence-utgång (kräver rörelse) |
| `markPassingDeparture` | Endast för genomfart utan stopp |

## UI/UX
- **Mörkt tema** - industriellt, optimerat för mobil
- **Kompakta kort** - expanderbara med tap (behåller expanded-state vid uppdatering)
- **Vibration** - dubbelpuls vid ankomst, enkelpuls vid avgång
- **Offline-indikator** - visas i header
- **CSV-export** - svensk semikolon-separator för Excel

## GitHub Pages
- URL: https://akjork.github.io/kinnekulle-gps/
- Branch: main
- Folder: / (root)

## Buggfixar och ändringar (2026-01-19)

### Fixade buggar
- **Avgång vid inbromsning**: Geofence-utgång kräver nu rörelse (>5 km/h)
- **Avgång vid stillastående**: GPS-fluktuation triggar inte längre avgång
- **Felaktig passering**: `markPassingDeparture` triggas endast för `shouldStop=false`
- **Kort kollapsade**: Expanded-state bevaras nu vid GPS-uppdateringar (`expandedCards` Set)
- **Passering vid medelhastighet**: Sänkt tröskelvärde från >10 km/h till >5 km/h för passeringsdetektering

### Nya funktioner
- Kompakt mörkt tema för mobil
- CSV-export för Excel
- Vibration vid ankomst/avgång
- Offline-indikator i header
- Förbättrade felmeddelanden för GPS och API
