# Kinnekulle Tågmonitor

## Projektöversikt
GPS-baserad app för att logga tågresor längs alla svenska järnvägsbanor. Används av tågförare för att automatiskt registrera ankomst- och avgångstider vid stationer. Stöder alla stationer i Sverige via Trafikverkets API.

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
SPEED_THRESHOLD_KMH = 5            // Hastighet för "stillastående" (<5 km/h = stannat)
PASS_DISTANCE_MARGIN = 5           // Meter för att detektera passering
DEFAULT_RADIUS = 100               // Standard geofence-radie (meter)
EXTRA_MARGIN = 120                 // Extra marginal för geofence-utgång
STATIONS_CACHE_MAX_AGE_MS = 7d     // Cache för stationsdata (7 dagar)
MAX_RECENT_STATIONS = 20           // Max antal senast använda stationer
```

## Stationshantering

### Dynamisk stationslista
- Hämtar alla svenska stationer från Trafikverket TrainStation API
- Ca 500+ stationer med GPS-koordinater (WGS84)
- Cachas i localStorage för offline-bruk
- Fallback till hårdkodad lista om API misslyckas

### Stationssökning (Autocomplete)
- **Sökfält** ersätter tidigare dropdown-listor
- **Smart filtrering**:
  - Söker på stationsnamn och signatur
  - Visar senast använda stationer först
  - Visar närliggande stationer baserat på GPS-position
- **Keyboard-navigation**: Pil upp/ned + Enter för snabbval

### API-anrop för stationer
```javascript
// TrainStation API query
objecttype: "TrainStation"
schemaversion: "1.4"
filter: Advertised=true (endast "synliga" stationer)
includes: AdvertisedLocationName, LocationSignature, Geometry.WGS84
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
- **Större stationskort** - lättlästa med tydlig text och knappar
- **Expanderbara kort** - tap för detaljer (behåller expanded-state vid uppdatering)
- **Sökbar stationslista** - autocomplete med smart filtrering
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

## Uppdatering (2026-01-22)

### Ny funktionalitet: Alla svenska stationer
- **TrainStation API** - Hämtar alla annonserade stationer från Trafikverket
- **Autocomplete-sökning** - Ersätter tidigare dropdown-listor
- **Smart filtrering**:
  - Senast använda stationer visas först
  - Närliggande stationer (baserat på GPS) föreslås
  - Sök på stationsnamn eller signatur (t.ex. "Cst" för Stockholm C)
- **Stationscache** - Sparas lokalt i 7 dagar för offline-bruk
- **Större stationskort** - Ökad padding och textstorlek för bättre läsbarhet

### Nya funktioner
| Funktion | Beskrivning |
|----------|-------------|
| `fetchAllStationsFromAPI` | Hämtar alla stationer från TrainStation API |
| `filterStations` | Smart filtrering: sök + senaste + närhet |
| `setupStationSearch` | Konfigurerar autocomplete för sökfält |
| `loadRecentStations` | Läser senast använda från localStorage |
| `addToRecentStations` | Sparar vald station för snabbval |

### localStorage-nycklar
```javascript
STORAGE_KEY_ALL_STATIONS = 'kmon_all_stations_v1'     // Cache för alla stationer
STORAGE_KEY_RECENT_STATIONS = 'kmon_recent_stations_v1' // Senast använda
```
