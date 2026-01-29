# RailTimer

## Projektöversikt
GPS-baserad app för att mäta gång- och uppehållstider för tåg i Sverige. Används av tågförare för att automatiskt registrera ankomst- och avgångstider vid stationer. Stöder alla stationer i Sverige via Trafikverkets API.

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
| `Analys.html` | Analysverktyg för gång- och uppehållstider |
| `sw.js` | Service Worker för PWA |
| `kinnekulle-gps.webmanifest` | PWA manifest |

## Viktiga konstanter (i koden)
```javascript
SPEED_THRESHOLD_KMH = 2            // Hastighet för "stillastående" (<2 km/h = stannat)
PASS_DISTANCE_MARGIN = 5           // Meter för att detektera passering
DEFAULT_RADIUS = 200               // Standard geofence-radie (meter) - ökad för API-koordinater
EXTRA_MARGIN = 150                 // Extra marginal för geofence-utgång
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
- Ankomst "rullar" och uppdateras tills tåget stannar ELLER passerar mittpunkten
- Avgång registreras när tåget börjar röra sig igen (om det stannade) eller vid mittpunktspassering (om det inte stannade)
- **Enkel regel**: Antingen stannar tåget (<2 km/h) eller så gör det inte det

### Tre scenarier

#### 1. Tåget stannar vid stationen
1. Ankomst registreras vid geofence-ingång
2. Uppdateras löpande till närmaste punkt mot centrum
3. **Låses** när tåget stannar (<2 km/h) - `reachedLowSpeed=true`
4. Avgång registreras när tåget börjar röra sig igen (>2 km/h)

#### 2. Tåget passerar utan att stanna (shouldStop=false)
1. Ankomst registreras vid geofence-ingång
2. Uppdateras till närmaste punkt (mittpunkten)
3. Avgång registreras direkt när avståndet börjar öka (passerat mittpunkten)
4. `markPassingDeparture` bekräftar passeringen

#### 3. Tåget passerar utan att stanna (shouldStop=true - planerat stopp men stannade inte)
1. Ankomst registreras vid geofence-ingång
2. Uppdateras till närmaste punkt
3. **Provisorisk avgång** sätts när avståndet börjar öka (`departureProvisional=true`)
4. Om tåget sedan stannar: provisorisk avgång återkallas, **ankomst uppdateras till stoppögonblicket**, hanteras som scenario 1
5. Om tåget lämnar zonen utan att stanna: provisorisk avgång bekräftas

#### 4. Tåget passerar mittpunkten och sedan stannar
1. Provisorisk avgång sätts vid mittpunktspassering
2. När tåget stannar (<2 km/h) återkallas provisorisk avgång
3. **Ankomsttid uppdateras till stoppögonblicket** (inte närmaste punkt-tiden)
4. Avgång registreras när tåget börjar röra sig igen (som scenario 1)

### Hastighetsdetektering
- **Stillastående**: <2 km/h (sänkt från 5 km/h för att undvika falska stopp vid låg fart)
- **Rör sig**: >2 km/h
- `reachedLowSpeed` flagga spårar om tåget faktiskt har stannat

### Provisorisk avgång
- Används för stationer med planerat stopp (`shouldStop=true`) där tåget passerar utan att stanna
- `departureProvisional=true` markerar osäker avgång
- `state.departureProvisionalIdx` håller reda på vilken station som har provisorisk avgång
- Återkallas automatiskt om tåget sedan stannar (<2 km/h)
- Bekräftas vid geofence-utgång om tåget fortfarande rör sig

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
- **Avgång vid inbromsning**: Geofence-utgång kräver nu rörelse (>2 km/h)
- **Avgång vid stillastående**: GPS-fluktuation triggar inte längre avgång
- **Felaktig passering**: `markPassingDeparture` triggas endast för `shouldStop=false`
- **Kort kollapsade**: Expanded-state bevaras nu vid GPS-uppdateringar (`expandedCards` Set)
- **Passering vid medelhastighet**: Sänkt tröskelvärde från >10 km/h till >2 km/h för passeringsdetektering

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

## Uppdatering (2026-01-23)

### Nya funktioner

#### 1. Tidtabellsjämförelse
- Visar avvikelse mot tidtabell i realtid på varje stationskort
- Format: `+2 min` (sen), `-1 min` (tidig), `I tid` (inom ±1 min)
- Färgkodning: grön (i tid), gul (1-5 min sen), röd (>5 min sen)
- Förseningssummering visas i header under körning

#### 2. Statistikvy
- Öppnas via ⋮-menyn → "Statistik"
- Visar historisk data per sträcka (station → station)
- Statistik: antal körningar, medeltid, bästa tid, sämsta tid
- Filtrera på fordonstyp och rutt
- Stapelgrafik för visuell jämförelse

#### 3. Kartvy
- SVG-baserad karta (ingen extern kartleverantör)
- Visar rutten som linje med stationsmarkörer
- Färgkodning: grå (ej passerad), orange (ankommit), grön (klar), blå (aktiv)
- Pulsande markör för aktuell GPS-position
- Kollapsbar - klicka på "Karta" för att visa/dölja

#### 4. Anteckningar
- Textfält i varje expanderat stationskort
- Spara kommentarer (t.ex. "signal på rött", "möte")
- Sparas i loggen och exporteras med CSV/JSON

#### 5. Ljudsignaler
- Web Audio API för ljudåterkoppling
- Två korta toner (800Hz) vid ankomst
- En längre ton (600Hz) vid avgång
- Aktiveras via "Ljud av/på"-knappen i header
- Sparas i localStorage

#### 6. Större typsnitt-läge
- Aktiveras via "Aa"-knappen i header
- Ökar typsnitt för enklare avläsning i kupén
- Påverkar kort, badges, knappar och statusboxar
- Sparas i localStorage

#### 7. Landskapsläge
- Optimerad layout för horisontellt läge
- Stationskort visas i två kolumner
- Kompaktare header och statusrutor
- Aktiveras automatiskt via CSS media query

### Nya funktioner (kod)
| Funktion | Beskrivning |
|----------|-------------|
| `playTone` | Spelar ton via Web Audio API |
| `playArrivalSound` | Två korta toner vid ankomst |
| `playDepartureSound` | En längre ton vid avgång |
| `toggleSound` | Växlar ljud av/på |
| `toggleLargeText` | Växlar stort typsnitt |
| `showStatistics` | Visar statistikvyn |
| `renderStatistics` | Renderar statistikdata |
| `renderRouteMap` | Renderar SVG-kartan |
| `updateDelaySummary` | Uppdaterar förseningsvisning i header |
| `handleCardInput` | Hanterar anteckningar i stationskort |

### Nya localStorage-nycklar
```javascript
STORAGE_KEY_SOUND_ENABLED = 'railtimer_sound_v1'    // Ljud på/av
STORAGE_KEY_LARGE_TEXT = 'railtimer_large_text_v1' // Stort typsnitt på/av
```

## Uppdatering (2026-01-26)

### Förbättrad passeringsdetektering

**Problem**: Vid passering av stationer i låg hastighet (3-5 km/h) registrerades felaktigt stopp.

**Lösning**: Sänkt hastighetströskel och ny logik för mittpunktspassering.

### Ändringar

#### Hastighetströskel sänkt
- `SPEED_THRESHOLD_KMH`: 5 → 2 km/h
- Endast tåg som verkligen står stilla (<2 km/h) räknas som "stoppade"
- Förhindrar falska stopp vid långsam passering

#### Avgång vid mittpunktspassering
- Avgång sätts nu när avståndet till stationscentrum börjar öka
- Gäller både för stationer med och utan planerat stopp
- Provisorisk avgång (`departureProvisional`) för planerade stopp som inte genomförs

#### Hantering av "passera sen stanna"
- Om tåget passerar mittpunkten och sedan stannar, återkallas provisorisk avgång
- **Ankomsttid uppdateras till stoppögonblicket** (inte närmaste punkt-tiden)
- Stationen behandlas då som ett normalt stopp
- Förhindrar felaktig registrering vid inbromsning efter mittpunkt

### Nya fält i station-objektet
```javascript
station.departureProvisional      // true = osäker avgång, kan återkallas
station.departureProvisionalAt    // Tidstämpel för provisorisk avgång
state.departureProvisionalIdx     // Index för station med provisorisk avgång
```

### Uppdaterade funktioner
| Funktion | Ändring |
|----------|---------|
| `trackClosestApproach` | Sätter provisorisk avgång vid mittpunktspassering |
| `processSpeedTriggers` | Återkallar provisorisk avgång om tåget stannar, uppdaterar ankomst till stoppögonblicket |
| `handleStationExit` | Bekräftar provisorisk avgång vid zonlämning |

## Analys.html - Tidsanalysverktyg

### Översikt
Fristående analysverktyg för att analysera sparade körningsloggar. Visar statistik för gångtider (tid mellan stationer) och uppehållstider (tid stillastående vid station).

### Funktioner

#### Datakällor
- **Ladda från RailTimer** - Läser direkt från localStorage (`kmon_gps_logs_v1`)
- **Importera JSON-filer** - Stöd för flera filer samtidigt med dublettkontroll

#### Lägen (Mode tabs)
- **Gångtider** - Tid från avgång vid station A till ankomst vid station B
- **Uppehållstider** - Tid från ankomst till avgång vid samma station

#### Filter
| Filter | Beskrivning |
|--------|-------------|
| Fordonstyp | Filtrera på typ av fordon |
| Tågnummer | Filtrera på specifikt tåg |
| Station 1 & 2 | Sökbara fält med autocomplete |
| Datum från/till | Datumintervall |
| Slå ihop riktningar | Sammanslår A→B och B→A |

#### Stationsfiltrering
När **två stationer** väljs:
- Visar endast körningar med de stationerna som start OCH slut
- Skapar segment mellan **konsekutiva stationer** (A→B, B→C, C→D)
- Lägger till **totalsträcka** (A→D total) markerad i orange

#### Statistikkolumner
| Kolumn | Förklaring |
|--------|------------|
| Antal | Antal observationer/mätningar |
| Snitt | Medelvärde (summan / antal) |
| Std | Standardavvikelse - spridningsmått (lågt=jämnt, högt=varierande) |
| Median | Mittvärdet (50% snabbare, 50% långsammare) |
| P90 | 90:e percentilen (90% av tiderna är kortare) |
| Min/Max | Kortaste/längsta uppmätta tiden |

#### Vyer (Data tabs)
- **Diagram** - Stapeldiagram med snitt per sträcka (grön=segment, orange=total)
- **Tabell** - Statistik per sträcka med alla kolumner
- **Avvikare** - Tågnummer med tider >2 standardavvikelser från snitt
- **Detaljer** - Alla enskilda observationer (max 200 rader)

### Tekniska detaljer

#### Segment-beräkning
```javascript
// Gångtid = avgång station A → ankomst station B (konsekutiva)
minutes = (toStop.actualArrival - fromStop.actualDeparture) / 60000

// Uppehållstid = ankomst → avgång vid samma station
minutes = (stop.actualDeparture - stop.actualArrival) / 60000
```

#### Dublettkontroll vid filinläsning
- Kontrollerar på `log.id` (unikt per körning)
- Fallback: `startedAt + trainNumber` om id saknas
- Visar antal borttagna dubletter i statusmeddelande

#### Viktiga funktioner
| Funktion | Beskrivning |
|----------|-------------|
| `buildSegmentsBetweenStations` | Bygger segment mellan två valda stationer |
| `buildRunningSegments` | Bygger alla gångtidssegment |
| `buildDwellSegments` | Bygger uppehållstidssegment |
| `renderChart` | Renderar stapeldiagram på canvas |
| `renderSummaryTable` | Renderar statistiktabell |
| `renderOutliersTable` | Hittar avvikande tågnummer (z-score > 2) |

## Uppdatering (2026-01-28)

### Fix: Ankomsttid vid "passera sen stanna"

**Problem**: När tåget passerade mittpunkten och sedan stannade, behölls ankomsttiden från närmaste punkt istället för att uppdateras till stoppögonblicket.

**Lösning**: I `processSpeedTriggers`, när en provisorisk avgång återkallas (tåget stannar), uppdateras nu även ankomsttiden till stoppögonblicket.

**Ändrad kod** (i `processSpeedTriggers`):
```javascript
if(speed<=SPEED_THRESHOLD_MS && (withinDist || withinTime)){
  station.actualDeparture=null;
  // ... återkalla provisorisk avgång ...
  station.reachedLowSpeed=true;
  // NY: Uppdatera ankomst till stoppögonblicket
  station.actualArrival=new Date();
  station.arrivalSource='gps';
  station.arrivalPosition=pos?{...}:null;
  station.needsArrivalRetiming=false;
}
```

### Förenklad logik

Nu finns endast två möjliga utfall:

1. **STOPP** (hastighet < 2 km/h):
   - Ankomst = stoppögonblicket
   - Avgång = när tåget börjar röra sig igen

2. **PASSERING** (aldrig < 2 km/h):
   - Ankomst = närmaste punkt till stationskoordinaterna
   - Avgång = när avståndet börjar öka

## Uppdatering (2026-01-29)

### Fix: API-anrop med datumfilter

**Problem**: Tåg med många poster (t.ex. 3335 med 745+ poster) överskred API-gränsen `limit=500`. Detta gjorde att dagens data inte hämtades.

**Lösning**: Lade till datumfilter direkt i API-anropet (GTE/LTE på AdvertisedTimeAtLocation) istället för att filtrera lokalt.

**Före:**
```xml
<FILTER>
  <EQ name="OperationalTrainNumber" value="${otn}" />
</FILTER>
```

**Efter:**
```xml
<FILTER>
  <AND>
    <EQ name="OperationalTrainNumber" value="${otn}" />
    <GTE name="AdvertisedTimeAtLocation" value="${dateStart}" />
    <LTE name="AdvertisedTimeAtLocation" value="${dateEnd}" />
  </AND>
</FILTER>
```

Detta säkerställer att endast relevant data för det valda datumet hämtas, oavsett hur många totala poster tågnumret har.
