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
SPEED_THRESHOLD_KMH = 5      // Hastighet för "stillastående"
PASS_DISTANCE_MARGIN = 5     // Meter för att detektera passering
DEFAULT_RADIUS = 100         // Standard geofence-radie (meter)
EXTRA_MARGIN = 120          // Extra marginal för geofence-utgång
```

## Stationslogik

### Ankomst
- Registreras när tåget kommer in i stationens geofence (radie)
- "Rullar" och uppdateras till närmaste punkt tills tåget stannar (<5 km/h)

### Avgång
- Registreras när tåget accelererar (>5 km/h) efter att ha stannat
- Eller vid geofence-utgång om `reachedLowSpeed=true`

### Passering (utan stopp)
- Kräver hastighet >10 km/h
- Ankomst = närmaste punkt, Avgång = strax efter

## UI/UX
- **Mörkt tema** - industriellt, optimerat för mobil
- **Kompakta kort** - expanderbara med tap
- **Vibration** - dubbelpuls vid ankomst, enkelpuls vid avgång
- **Offline-indikator** - visas i header

## GitHub Pages
- URL: https://akjork.github.io/kinnekulle-gps/
- Branch: main
- Folder: / (root)

## Senaste ändringar (2026-01-19)
- Buggfix: Avgång markerades för tidigt vid inbromsning
- Buggfix: Passering triggades felaktigt efter mittpunkten
- Ny design: Kompakt mörkt tema för mobil
- Ny funktion: CSV-export för Excel
- Ny funktion: Vibration vid ankomst/avgång
- Ny funktion: Offline-indikator
- Förbättrad felhantering för GPS och API
