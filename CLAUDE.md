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
| `index.html` | Huvudappen (GitHub Pages) |
| `Kinnekulle GPS.html`, `Kinnekulle.html` | Vidarekoppling till `index.html` för gamla bokmärken (sedan 2026-11-25d; förut kopior som hölls i takt för hand) |
| `Analys.html` | Analysverktyg för gång- och uppehållstider |
| `sw.js` | Service Worker för PWA |
| `railtimer-avbrott.js`, `railtimer-github.js`, `railtimer-karta.js`, `railtimer-analys.js` | Avbrott, uppladdning, kartans linje längs spåret, analysens beräkningar |
| `railtimer-trv.js` | Trafikverkets API: frågor, rapporterade tider för en körning, jämförelse, kontrollen |
| `api-koll.html` | Trafikverket-data: visar vad API:t svarar och appens tider mot Trafikverkets |
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
- Cachas i localStorage för offline-bruk; en lista äldre än 7 dagar används ändå utan nät och byts i bakgrunden (2026-11-25d)

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

> Historik: lägena Gångtider/Uppehållstider och flikarna Diagram, Tabell, Avvikare och Detaljer nedan är borttagna (se 2026-11-25c).

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

## Uppdatering (2026-10-15)

Utseende och buggfixar. Logiken för ankomst/avgång (`processSpeedTriggers`, `handleStationEntry`, `handleStationExit`, `trackClosestApproach`, trösklar) är **oförändrad**.

### Buggfixar
- **Statistik under resa**: att stänga Statistik visade startformuläret och gömde den pågående resan. Nu återgår `hideStatistics` alltid till resan om den pågår. `startJourney` vägrar starta om en resa redan pågår.
- **Anteckningar under resa**: stationskorten byggdes om helt vid varje GPS-position, så fokus i anteckningsfältet tappades. Nu byggs korten bara om när rutten ändras (`renderedRouteKey`); annars uppdaterar `updateCard` bara tider, avstånd och klasser.
- **Statusmeddelanden**: ljusa bakgrunder från gamla temat gav grå text på ljusgrönt. Meddelanden visas nu som en toast längst ner (`.toast`), resmeddelanden med `badge live/warn`.
- **Rapporten** visades under startformuläret. Nu visas den ensam (`showView('report')`); formuläret kommer via "Starta ny mätning".

### Utseende
- Header på en rad: titel, försening, GPS, antal loggar och ⋮-meny. Skärm vaken, ljud och stor text är reglage i menyn; export ligger i menyn.
- Panel för **nästa station** överst under resan (fastnar under headern vid scroll): namn, avstånd, tid enligt tidtabell, fart och GPS-noggrannhet. Vid station: uppehållets längd och planerad avgång. Ersätter de fyra statusrutorna.
- Kommande stationer visar tidtabellens tid nedtonad i stället för streck. Tidtabellstider visas utan sekunder (`formatClock`).
- Stora knappar för manuell ankomst/avgång i utfällt kort. "Flytta stationens mittpunkt hit" kräver bekräftelse.
- Passerade kort tonas bara ner i rubrikdelen, inte i den utfällda delen.
- Avsluta/Avbryt längst ner i resvyn.
- Rapport: sammanfattning (restid, försening vid slutstation, antal uppehåll, längsta uppehåll) och en lista per station i stället för tabell med sju kolumner.
- Basstorlek 16 px. Stor text skalar hela appen via `html.large-text` (rem). Chrome räknar inte om rem för synliga knappar, därför tvingar `toggleLargeText` en omräkning.
- Kartan: korrigerad för longitud (cos(lat)), centrerad, och etiketter klipps inte i kanten. Nästa station får namn bredvid punkten.
- `theme-color` ändrad från gammal blå till headerns mörka färg.

### Övrigt
- Utan tågnummer mäts bara start- och slutstation; det står nu under fältet.
- "Spara till fil" och "Synka loggfil" döljs när webbläsaren saknar File System Access API (mobil).
- Statistiken listar sträckor i ordning längs linjen (längsta körningarna först, insättningsordning) i stället för bokstavsordning.
- Skärmen hålls vaken automatiskt under resan (`enableWakeLockForJourney`) och släpps efteråt om resan slog på den.
- `formatDistance` med decimalkomma ("1,2 km"), `formatDuration` klarar över en timme (h:mm:ss).


## Uppdatering (2026-10-15b): uppladdning, GPS-spår och avbrott

Spec: `docs/superpowers/specs/2026-10-15-uppladdning-design.md` · Plan: `docs/superpowers/plans/2026-10-15-uppladdning.md`

### Uppladdning till GitHub
- Varje avslutad (även avbruten) resa laddas upp till privata repot `AKjork/railtimer-data`: `korningar/ÅÅÅÅ/<datum>_<tåg>_<id>.json`, spåret i `gps-spar/…`. Befintliga mätningar laddas upp första gången som `import/…_befintliga-N.json` (högst 200 per fil).
- Inställningar: ⋮ → Uppladdning (repo, token, "Spara och testa", "Ladda upp nu"). Token sparas bara i `localStorage` (`railtimer_github_v1`).
- Kön (`railtimer_upload_v1`) körs efter resan, vid start, `online` och när appen blir synlig – aldrig under en pågående resa. En skrivning i taget, minst 1 s mellanrum, väntar enligt GitHubs `retry-after`.
- Logiken finns i `railtimer-github.js` (även Analys.html använder den).

### Körningsformat 2
`format`, `appVersion`, `interruptions`, `trackPath`; per station `sig`, `lat`, `lon`, `radius`, och vid avbrott `arrivalWindow`/`departureWindow`/`missedReason`. `normalizeLogEntry` bevarar fälten.

### GPS-spår
Varje position under resan sparas i IndexedDB (`railtimer`/`tracks`) var 30:e sekund och när appen går till bakgrunden (`onAppHidden`). Fält: `t_ms, lat, lon, acc_m, speed_ms, heading_deg, fixAge_ms`. Tas bort från telefonen när det är uppladdat.

### Avbrott (samtal, bakgrund, GPS-glapp)
- Avbrott = mer än 20 s mellan positioner och minst 150 m förflyttning (`railtimer-avbrott.js`).
- Tider inom avbrottet (`from < T ≤ to + 2 s`) sparas som `null` med fönster och källan `avbrott` – aldrig som felaktiga tider.
- Ikappkörning: stationer som passerades under avbrottet markeras `missedReason: 'avbrott'` och appen fortsätter från rätt station (tidigare kunde den fastna).
- Vanlig körning är oförändrad – säkras av regressionsfacit `tests/golden-normal-run.json`.

### Tester
- `node --test "tests/*.test.js"` – modulerna och service workern (utan beroenden). Service workern hanterar bara appens egna filer; anrop till GitHub går förbi cachen.
- `node tests/run-browser-tests.mjs [filter]` – uppspelade resor i Chrome utan fönster (`index.html?test=1`).
- `node tests/run-browser-tests.mjs --golden` – tar fram facit (bara när logiken avsiktligt ändras).
- `node tests/run-browser-tests.mjs --shot=installningar|avbrott|rapport` – bilder i telefonstorlek (`tests/screenshots/`).

## Uppdatering (2026-10-15c): analys mot tidtabell (Analys.html)

Spec: `docs/superpowers/specs/2026-10-15-analys-mot-tidtabell-design.md` · Plan: `docs/superpowers/plans/2026-10-15-analys-mot-tidtabell.md`

- **Mot tidtabell** (ersätter Jämför): gångtid per sträcka och riktning mot planerad gångtid – bedömning Snål / Lagom / Generös och förslag i hela minuter – och per station ankomst, väntan vid tidig ankomst, uppehåll och avgång. Väljaren *Visa* filtrerar på avvikelsetyp; klick på en rad visar de enskilda mätningarna.
- **Tidtabell**: förslag i vald riktning (Station 1 → Station 2) som bara bygger på körningar i den riktningen. Antal körningar, period, planerad gångtid nu och ändring visas; klockslagen avrundas till hela minuter utan att felen växer.
- **Export**: *Exportera till Excel* (CSV som appens: BOM, semikolon, citattecken, decimalkomma, informationsblock med urval, period och antal) och *Skriv ut / PDF* (utskriftsmall som bara visar rapporten med rubrik och urval).
- **Nya filter**: tid på dygnet (morgon 05–09, dag 09–15, eftermiddag 15–18, kväll 18–05), vardag eller helg, tolerans (±0,5 / ±1 / ±2 min) och stationstyp (stopp eller passage). Tid och datum avgörs av körningens start i lokal tid.
- **Stationsnamn** slås ihop vid inläsning: Herrljunga → Herrljunga C, Hallsberg personbangård → Hallsberg, Framnäs City → Framnäs city (verifierat mot Trafikverkets TrainStation-API), och namn som bara skiljer sig i stor och liten bokstav.
- Beräkningarna finns i `railtimer-analys.js` och testas med `node --test "tests/*.test.js"`; flikarna med `node tests/run-browser-tests.mjs analys`, och bilder i datorstorlek tas med `--shot=per-tag|stracker|tidtabell|per-tag-utskrift` (se 2026-10-15d).

### Rättat efter slutgranskningen
- **Väntan** räknas bara när tåget kom tidigt och stod kvar till planerad ankomst. Väntan är då tiden fram till planerad ankomst. Åkte tåget före planerad ankomst, vanligt vid planerat uppehåll 0, är väntan 0. Tidigare räknades vanliga uppehåll som väntan, i 11 av 59 fall.
- **Tidig – väntan** kräver minst ett väntetillfälle. Annars blir bedömningen *Tidig*, till exempel vid passage.
- **Ändring i förslaget** visas bara för sträckor som bedöms som Snål eller Generös. Lagom och För få mätningar visar planerad tid. Tidigare kunde Lagom visa "(−1)".
- **Uppehåll i Tidtabell** räknas från planerad ankomst när tåget väntade, och i sin helhet när tåget åkte före planerad ankomst. De föll tidigare bort.
- **Utskriftshuvudet** fylls vid varje utskrift (`beforeprint`), även med Ctrl+P. Tidigare kunde en PDF få ett gammalt "Bygger på".
- Har appen öppnats i samma webbläsare styr dess service worker även `Analys.html`, eftersom omfånget är `/kinnekulle-gps/`. Den visar först den sparade kopian och hämtar den nya i bakgrunden. Första laddningen efter en publicering kan alltså visa den gamla versionen. Ladda om en gång till.

## Uppdatering (2026-10-15d): analys per tåg (Analys.html)

Spec: `docs/superpowers/specs/2026-10-15-analys-per-tag-design.md` · Plan: `docs/superpowers/plans/2026-10-15-analys-per-tag.md`

André 2026-10-15: väntan vid en station är ointressant, eftersom den följer tidtabellen. Det intressanta är tågen. Varje tåg har sin egen tidtabell, och samma sträcka kan ha olika planerad gångtid för olika tåg.

### Flikarna
- **Per tåg** är förvald och ersätter Mot tidtabell. Varje tåg har en rad med körningar, avvikelse vid start och slut, summerad marginal och antal gånger tåget tappade tid.
  - Tågkortet visar varje sträcka mot vad sträckan tar, uppehållen och gångerna tåget tappade tid, med datum, veckodag och klockslag.
  - Resandeantal finns inte i mätningarna.
- **Sträckor** visar vad varje sträcka tar och planerad tid per tåg, med marginal. *Snål och generös* betyder att olika tåg har för lite respektive för mycket tid på samma sträcka.
- **Tidtabell** ger förslag per tåg i stället för per riktning. Förslaget bygger på tågets egen tidtabell, vad sträckorna tar och tågets egna uppehåll utan väntan. Möten och anslutningar ingår inte.

### Begrepp
- **Vad sträckan tar** (`segmentNeeds`, `needFor`) är medianen för alla tåg i urvalet som stannade och passerade som tidtabellen säger, även körningar utan tidtabell.
  - Med färre än 3 sådana mätningar används alla mätningar på sträckan, mönstret `*`, som visas som "alla mätningar". Det behövs vid behovsstopp som tåget nästan alltid passerar.
  - Tågnummerfiltret påverkar inte det underlaget.
- **Marginal** = planerad gångtid − vad sträckan tar.
- **Tappad tid** vid en station = avgångsavvikelse − max(ankomstavvikelse, 0). Vid första stationen är tappad tid avgångsavvikelsen, typen *Avgång från start*.
- **Klockslag** är minuter efter midnatt på körningens startdag. De räknas på klocka och kalenderdag (`clockMinutes`), så att bytet till vintertid inte flyttar tiderna.
- **Tidtabeller per tågnummer** (`trainVariants`): skiljer de planerade tiderna vid samma station mer än 10 min blir körningarna egna tidtabeller, till exempel "13346 vardag" och "13346 söndag".
- **Tid över** = planerad restid − sträckornas tid − tågets egna uppehåll utan väntan. Det är samma beräkning som i förslaget. *Marginal gångtid* per sträcka räknar inte med uppehållen.
- **Station 1 mitt på linjen:** en avskuren körning har `cutStart` (`sliceRuns`), och då räknas första stationen som mellanstation.
- **Tappat tid** i listan räknar inte avgång från start, eftersom orsaken där är okänd.

### Borttaget
- Mot tidtabell och väntan per station.
- Bedömningarna Tidig – väntan, Tidig, Sen ankomst, Sen avgång och I tid.
- Modulens `stationObservations`, `summarizeSegments`, `summarizeStations`, `proposeTimetable` och `mode`.

### Tester
- `node --test "tests/*.test.js"` och `node tests/run-browser-tests.mjs analys`.
- Bilder tas med `--shot=per-tag|stracker|tidtabell|per-tag-utskrift`.

## Uppdatering (2026-10-16): nytt tåg, alla tåg, egna gångtider och token (Analys.html)

André 2026-10-16:
- Han vill kunna föreslå tidtabell för ett helt nytt tåg, A–B via valda stationer.
- Han vill kunna skriva ut förslag för alla mätta tåg som en PDF.
- Varje tåg ska kunna jämföras med sig självt, eftersom resandemönstret skiljer.
- Token försvann när fönstret stängdes.

### Tidtabell
- **Nytt tåg** (`proposeNewTimetable`, `routeBetween`):
  - Välj Station 1 och 2, kryssa i stopp och ange avgång. Uppehållet kan ändras per station (0–60 min). Stopplistan byggs bara om när rutten ändras, så att fokus och klick inte försvinner.
  - **Rutten:** pusslas ihop av körningarna, bredden först över steg. Stationer som någon körning har däremellan fylls i. Det fungerar även när ingen körning gått hela vägen.
    - Vägen får aldrig vända: steget p → u → v förbjuds när någon körning har alla tre och u inte ligger mellan p och v.
    - Annars ger körningar åt andra hållet plus körningar utan mellanstationer (utan tågnummer: bara start och slut) genvägar förbi startstationen. Före rättelsen blev 107 av 993 stationspar fel, till exempel Håkantorp → Mariestad 80 min i stället för 73.
  - **Gångtider:** vad sträckorna tar för alla tåg, med stopp och passage som valt.
  - **Uppehåll**, i den här ordningen:
    1. Angivet.
    2. Vad tåg med vanligt kort planerat uppehåll (högst 2 min, `NORMAL_DWELL`) står vid stationen, utan väntan ("mätt").
    3. Verkliga uppehåll vid stopp utan tidtabell, högst 5 min (`MAX_UNTIMED_DWELL`, "mätt utan tidtabell"). Exempel: Hallsberg 2,6, Kumla 1,4 och Örebro Södra 0,8.
    4. Medianen för vanliga uppehåll ("schablon"). Utan tidtabell i urvalet används i stället medianen för uppehållen utan tidtabell.
  - **Väntade in avgångstiden** (`dwellWaited`): hur många av de mätta tågen som kom före planerad avgång och avgick inom avgångsminuten. Sådana mätningar visar bara att uppehållet räckte.
    - Lidköping: 14 av 14 och Mariestad: 5 av 7 väntade in avgångstiden. Uppehållet 2,1 min speglar alltså tidtabellen.
    - *Räknat på annonserade tider (se 2026-11-25f). Sedan 2026-11-25f räknas bara körningar med tågorderns tider som "mätt".*
    - Tåg som inte styrdes av tidtabellen är för få där (2 per station) och stod längre, inte kortare. Därför räknas värdet som förut, och antalet visas.
- **Alla tåg:** en översikt (restid nu och i förslaget per tåg) och ett förslag per tåg. Allt skrivs ut i en PDF och exporteras i en Excelfil.
- **Gångtid från: alla tåg / tågets egna** (`legSource`). Med egna används tågets median där det har minst 3 mätningar med samma stoppmönster, annars alla tågs. Tågets mätningar med annat mönster, till exempel passage vid ett behovsstopp, blandas inte in. Underlag visar vilket.
  - Datan 2026-10-16: gångtiden skiljer i median 0,1 min mellan tågen på samma sträcka. Uppehållen skiljer upp till 14 min och är därför alltid tågets egna.

### Token
GitHub-inställningarna är ett inloggningsformulär (`autocomplete` username/current-password). Därför kan webbläsaren spara token som lösenord och fylla i den igen när webbplatsdatan rensats. En ifylld token som inte sparats används direkt av Hämta från GitHub.
- Fälten har **inget `name`**. Skickas formuläret förbi skriptet, till exempel om skriptet stoppat, hamnar token då aldrig i adressfältet eller i historiken.
- Det är inte provat att webbläsarna faktiskt frågar om att spara. Chrome utan fönster saknar lösenordshanterare. Om frågan uteblir kan `PasswordCredential` och `navigator.credentials.store` läggas till för Chrome och Edge.

### Bilder
`--shot=nytt-tag` och `--shot=tidtabell-alla-utskrift`.

## Uppdatering (2026-11-25): GPS vid start

André 2026-11-25: när mätningen startas tror appen ofta att tåget rör sig fast det står still, eftersom GPS:en inte har låst in sig.

Dataunderlag (`railtimer-data`, okt–nov): 12 körningar avbröts efter 6–10 s eftersom avgång från startstationen registrerades 1–6 s efter start. GPS:en gav då 2–12 km/h i högst 3 s i sträck, med noggrannhet 4–27 m. Felet är alltså falsk fart, inte dålig noggrannhet. I de 38 hela spåren varar verklig avgång alltid längre än 8 s.

- **Avgång från startstationen** (`processSpeedTriggers`, `idx===0`) kräver fart över 2 km/h i `START_DEPART_CONFIRM_MS` (8 s) i sträck. Faller farten under tröskeln börjar räkningen om. Avgångstid och -position tas från första positionen i rörelse (`station.startMoveSince`), så tiden blir densamma som förut vid en riktig avgång. `handleStationExit` använder samma tid om den finns. Övriga stationer är oförändrade.
- **GPS-uppvärmning** (`startGpsWarmup`, `stopGpsWarmup`): medan startformuläret visas körs en egen `watchPosition` med hög noggrannhet. Under Start-knappen visas *GPS söker position*, *GPS låser in sig (±N m)* eller *GPS klar (±N m)* vid högst 15 m (`GPS_READY_ACCURACY_M`). Bevakningen stängs när appen går till bakgrunden och när resans egen bevakning har startat. Inte i testläge.
- Tester: `start: några sekunders falsk fart …` och `start: avgången räknas från …` i `tests/replay.html`. Facit för vanlig resa är oförändrat.

## Uppdatering (2026-11-25b): resvyn och kartan längs spåret

André 2026-11-25: frontend mer kompakt och följsam, tänk över vad som är viktigast att visa. Kartan följde inte järnvägen utan gick fågelvägen.

Logiken för ankomst/avgång är **oförändrad** (regressionsfacit `tests/golden-normal-run.json` passerar).

### Resvyn
- **En skärm utan sidscroll** (`body.journey-mode`): rubrik, panel, karta och stationslista. Bara stationslistan scrollar. Sidfoten och loggräknaren döljs under resan.
- **Panelen** visar det viktigaste stort: nästa station och avstånd. Under den en rad med fyra värden: planerad tid, nedräkning till planerad tid (`countdown`, "kvar till plan" eller "efter plan" i gult/rött), avvikelse (`currentDelay`, senast registrerade tid mot tidtabell) och fart med GPS-noggrannhet. Vid station: uppehållets längd, planerad avgång och tid kvar till avgång. En timer (`startPanelTimer`) uppdaterar varje sekund även när GPS:en är tyst.
- Förseningen i headern är borttagen; den finns i panelen (`#nextDelay`). `updateDelaySummary` finns inte längre.
- **Stationslistan** har en rad per station: nummer, namn med status under (avstånd kvar, "står här · 0:20", "passeras", anteckning), ankomst och avgång. Faktisk tid med avvikelse under, annars tidtabellens tid nedtonad med "plan". Tryck på raden för knapparna och anteckningen som förut.
- Står tåget vid en station är bara den markerad (orange), annars nästa station (grön).
- Listan rullar (`scrollToNextStation`) bara när tåget kommer fram eller åker vidare, och bara listan – inte sidan – så att kartan står kvar.
- Resmeddelanden (`#journeyMsg`) visas som toast längst ner och flyttar inte layouten.
- **Liggande telefon och skärmar ≥ 820 px**: panel och karta till vänster, stationslistan till höger.

### Kartan (`railtimer-karta.js`)
- Spårets sträckning hämtas från **OpenStreetMap via Overpass API** (`overpass-api.de`, reserv `overpass.kumi.systems`) i en rektangel runt varje sträcka (minst 2 km marginal). Bangårds- och sidospår (`service=yard|siding|spur`) hämtas inte; övriga `service`-spår kostar fyra gånger mer så att huvudspåret väljs.
- Vägen mellan två stationer = kortaste väg (A*) i spårnätet mellan noderna närmast stationerna (högst 1,5 km bort). Glapp på upp till 25 m mellan spår kopplas ihop. Blir vägen längre än 3 × fågelvägen + 5 km räknas den som fel och ritas rakt.
- Resultatet förenklas (6 m) och sparas per sträcka i `localStorage` (`railtimer_rail_legs_v1`, högst 150 sträckor, ca 200 kB). Hämtas en gång och fungerar sedan offline. Nätfel sparas inte; en sträcka utan spår försöks igen efter ett dygn. Blir lagringen full sparas bara rutten som körs.
- Hämtningen startar när resan startar eller återupptas (`loadRailGeometry`) och när nätet kommer tillbaka. Tills den är klar, eller om den misslyckas, ritas raka streckade linjer.
- Den körda delen ritas från resans GPS-spår (`track.points`, positioner med noggrannhet sämre än 100 m hoppas över).
- **Följ** (förvalt): föregående, nästa och nästnästa station och tåget. **Hela**: hela rutten. **✕** döljer kartan. Valet sparas (`railtimer_map_v1`).
- Bakgrunden ritas om bara när utsnittet eller stationernas status ändras; vid varje position flyttas bara tågets markör och GPS-spåret förlängs.
- Källan anges i kartans hörn (© OpenStreetMap), som licensen kräver.
- Inte provat mot riktiga Overpass härifrån (utvecklingsmiljön når inte overpass-api.de). Testerna använder simulerat Overpass-svar.

### Tester
- `node --test "tests/*.test.js"` – även `tests/railtimer-karta.test.js` (graf, kortaste väg, glapp, förenkling, fråga, cache, nätfel).
- `node tests/run-browser-tests.mjs karta` och `… resvy`.
- Bilder: `--shot=resa`, `--shot=resa-vid-station`, `--shot=resa-liggande`.

## Uppdatering (2026-11-25c): analysverktyget – längs linjen, GPS-spår och jämför perioder

André 2026-11-25: gå igenom analysverktyget och förbättra det.

Dataunderlag (`railtimer-data`, 213 körningar 2025-10-29 – 2026-11-24): gångtiderna är jämna (i median 0,1 min från sträckans median), och manuella stämplingar är lika exakta som GPS. I 118 hela körningar med tidtabell kör tågen i median 4,3 min fortare än planerad gångtid och står 3,2 min längre vid stationerna än planerat. Marginalen ligger alltså i gångtiderna och används upp vid stationerna.

> **Fel (2026-11-25f):** siffrorna ovan bygger på Trafikverkets annonserade tider, där ankomst och avgång har samma minut vid de flesta mellanstationer. Tågordern har ankomsten en minut tidigare, så uppehållsminuten räknades som gångtid. 23349 2026-11-25 med tågorderns tider: gångtid +2,9 min och uppehåll −2,6 min mot planerat, alltså tvärtom. Slutsatsen gäller inte.

### Borttaget
- Lägena **Gångtider/Uppehållstider**, sifferrutorna, *Slå ihop riktningar* och flikarna **Diagram, Tabell, Avvikare, Detaljer** med sina funktioner (`buildRunningSegments`, `buildDwellSegments`, `buildSegmentsBetweenStations`, `renderChart`, `renderOutliersTable` m.fl.). De skilde inte på stopp och passage, och Avvikare jämförde ett tågs medelvärde med spridningen för enskilda mätningar (fel), så små skillnader flaggades.
- Kvar under filtret: en rad med antal körningar i urvalet (`#statTrips`) och antal körningar med GPS-spår.

### Försening längs linjen (Per tåg)
- **Var tiden går** (`delayBreakdown`, `delayBalance`): för en hel körning gäller exakt *ankomst slut = avgång start + gångtid + uppehåll*, där gångtid = Σ(verklig − planerad gångtid) och uppehåll = Σ(verkligt − planerat uppehåll; passage 0). Medianer visas som rutor överst i Per tåg (alla tåg) och i tågkortet. Körningar med saknad tid eller avskurna (`cutStart`) räknas inte.
- **Diagram** i tågkortet (`delayProfile`, SVG utan bibliotek): avvikelse vid ankomst (fylld punkt) och avgång (ring) vid varje station, median och band för P10–P90. Muspekaren visar värde och antal. `stats` ger nu även `p10`.

### GPS-spår
- `railtimer-github.js`: `loadRunsFromRepo` ger `trackList`; `loadTracksFromRepo` hämtar `gps-spar/…` med samma cache (IndexedDB per sha). Analysen visas först och räknas om när spåren kommit. Importerade JSON-filer med `runId` och `points` läses som spår.
- `analyzeTrack`/`analyzeTracks`: per sträcka (avgång A → ankomst B) fartprofil och **stillastående mellan stationerna**: minst 10 s under 2 km/h, utanför stationens radie + 150 m (utan koordinater: första och sista 30 s), noggrannhet högst 50 m. Stillaståenden med högst 5 s och 30 m glapp slås ihop (falsk fart).
- `segmentObservations(runs, { tracks })` ger `hasTrack`, `unplannedStop` (minuter) och `legIndex` (index i hela körningen; `sliceRuns` sätter `sliceOffset`). `segmentNeeds(obs, { skipUnplanned })` räknar inte sådana mätningar och anger `skipped`.
- Filtret **Räkna inte körningar som stod still mellan stationerna** (förvalt på).
- **Sträckor**: listan *Stod still mellan stationerna* (`unplannedStops`) med datum, tåg, minuter, läge och om föraren redan undantagit sträckan (`excludeInboundRun`). Klick på en rad eller sträcka visar **fartprofilen** (fart mot km från avgång, en linje per körning, de som stod still i orange). Mätningstabellen har kolumnen *Stod still på linjen*. CSV-exporten har stoppen som egen del.
- Datan 2026-11-25: 6 stopp i 51 spår; 5 av dem hade föraren redan undantagit (till exempel två signalstopp ca 0,7 km före Håkantorp). Spår finns från oktober 2026.

### Jämför perioder (ny flik)
- `comparePeriods(runs, a, b, opts)`: samma urval (filtrets datum används inte) i period A och B. Var tiden går per period; **tåg** per tågnummer (planerad och verklig restid, ankomst slut, gånger tappat per körning) så att en ny tidtabell syns som ändrad planerad restid; **sträckor** per verkligt stoppmönster med skillnad när båda har minst 3 mätningar. Skillnad större än toleransen färgas (rött längre/senare i B, blått kortare/tidigare).
- Förval (`defaultPeriods`): B = de sista 30 dagarna med mätningar, A = allt före. Knapp för att återställa. Export till Excel och utskrift som i övriga flikar.

### Tester
- `node --test "tests/*.test.js"` (97) och `node tests/run-browser-tests.mjs analys` (25), nya: försening längs linjen, GPS-spår och Jämför perioder.
- I en Linux-miljö som root fungerar webbläsartesterna med `CHROME_PATH=/usr/bin/google-chrome`.

## Uppdatering (2026-11-25d): rättade fel efter kodgranskningen

André 2026-11-25: åtgärda allt från granskningen (`claude/kodgranskning-2026-11-25.md` i projektet). Appversion `2026-11-25d`.

### Avgång vid mellanstationer
Dataunderlag: 2 av 255 avgångar från mellanstationer i spåren registrerades ca 20 s för tidigt.
- **Position utan fart** (`speedOf`). Vedum 2026-11-24: farten räknades mellan två positioner utan fart, 22 min isär, så tåget verkade köra fast det stod still. Har GPS:en angett fart de senaste 30 s räknas en position utan fart inte för stopp och avgång (`state.lastSpeed` behålls). Anger telefonen aldrig fart räknas den ur positionerna, minst 3 s och högst 15 s bakåt (`SPEED_EST_MIN_MS`/`MAX`). Fart som inte är ett tal ≥ 0 räknas som saknad.
- **Enstaka fartspik** (Hällekis 2026-11-02: 1,9, 1,8, 2,3 km/h och sedan stilla 20 s). Avgång kräver nu rörelse i `DEPART_CONFIRM_MS` (3 s) i sträck vid alla stationer, 8 s vid startstationen som förut. Tiden räknas från första positionen i rörelse (`station.startMoveSince`), även vid zonutgång (`handleStationExit`).
- Uppspelning av alla riktiga spår i `railtimer-data` genom gammal och ny kod: bara de felaktiga avgångarna ändras. Facit för vanlig resa är oförändrat.

### Lagring
- `saveLog` svalde felet när localStorage var full: resan visades som klar men sparades och laddades aldrig upp. Nu (`setItemWithRoom`, `makeRoom`): först tas kartans sparade spårsträckor bort, sedan den äldsta fjärdedelen av körningarna som redan finns i GitHub (`pruneUploadedLogs`), tills det får plats. Körningar som inte är uppladdade tas aldrig bort.
- Får resan ändå inte plats finns den kvar i minnet (`unsavedLogs`, med i `loadLogs`), så att den laddas upp och kan exporteras. Rapporten säger vad som hände (`lastSaveProblem`). Får pågående resa inte plats visas ett meddelande en gång.
- Gränsen är ca 5 MB och delas av alla sidor på akjork.github.io. Körningarna var ca 0,9 MB i november 2026.

### Trafikverket
- **Stationslistan** äldre än 7 dagar används utan nät och byts i bakgrunden (`refreshStations`); nytt försök vid `online`. Den tomma reservlistan `baseStations` är borttagen.
- **Tidsgränser** (`fetchWithTimeout`): tidtabellen 10 s, stationslistan 20 s. Start fastnar inte längre på "Hämtar tidtabell…"; utan tidtabell mäts start- och slutstation och meddelandet säger det.
- `init` väntar inte på stationslistan innan Återuppta resa och uppladdningen.
- **Tidtabellen** (`fetchTimetable`): frågan gäller ±12 h runt nu i lokal tid (`localIso`), och körningen vars tider ligger närmast väljs (`nearestTrainRun`, per `DepartureDateOTN`). Förut gällde hela dygnet enligt UTC-datum: mellan 00 och 01 (sommartid 02) blev det gårdagens tidtabell, och stationer efter midnatt föll bort. Lyckade svar återanvänds i 15 min.
- **Tågnummerförslaget** väntar 0,6 s efter sista tangenten och visar inget för ett nummer som hunnit ändras. Närmaste station tas från GPS-uppvärmningen om den är färsk.

### Övrigt
- Appen startade inte alls när `navigator.serviceWorker` saknas (inbyggda webbläsare i appar, http). Den oanvända `hadController` är borttagen och registreringen kontrollerar att `navigator.serviceWorker` finns.
- **Kasta bort** och resor äldre än 12 h tar bort GPS-spåret (`discardActiveJourney`). Spår utan körning, äldre än 12 h, tas bort vid start (`removeOrphanTracks`). Uppladdning räknar bara spår som har en körning.
- **Stationsfälten**: ändras texten efter ett val gäller inte valet längre. En station med exakt det namnet (oavsett stor och liten bokstav) används (`stationForInput`), annars "Välj start- och slutstation i listan".
- **Service workern** sparar bara lyckade svar (`resp.ok`), hämtar appens filer med `cache: 'reload'` vid installation och sparar även `./`.
- **CSV**: kolumnen Ordning var alltid tom; nu stationens nummer (`logsCsv`).
- **Kartan**: GPS-spåret byggs på med nya positioner i stället för att räknas om helt vid varje position.
- **Flytta stationens mittpunkt hit** sparas nu till kommande resor (André 2026-11-25: "fixa allt"). Mittpunkten sparas per station i `railtimer_station_centers_v1` (nyckel `sig:<signatur>`, annars `namn:<namn>`) och används av `makeRouteStation` före Trafikverkets koordinater (`ownCenter`, `baseLat`/`baseLon`). Den sparas bara när GPS:en är säkrare än ±30 m (`CALIBRATE_MAX_ACCURACY_M`). Kortet visar "egen mittpunkt" och knappen **Återställ mittpunkten** (`resetStationCenter`).
- Den gamla sparningen (`kmon_gps_station_meta_v1`, `stationOverrides`) användes aldrig och läses inte; tidigare flyttar gäller alltså inte. `stationCatalog`, `getSelectedRoute`, `applyTimetableToRoute` och `filterRouteByTimetable` är borttagna.
- `escapeHtml` tål tal och null; Återuppta-dialogen escapar tåg och fordon. Skärmlåset visar meddelande bara när föraren själv slår av eller på det.
- Token i localStorage kan läsas av alla sidor på akjork.github.io. Det går inte att ändra i appen; token är begränsad till `railtimer-data` med skrivrätt till innehåll (`TOKEN_URL`).

### Tester
- `node --test "tests/*.test.js"` (99): service workern sparar inte felsvar och hämtar med `cache: 'reload'`.
- `node tests/run-browser-tests.mjs` (67), nya: `avgång:`, `lagring:`, `stationer:`, `startformulär:`, `tidtabell:`, `mittpunkt:`, `GPS-spår: Kasta bort …` och `CSV:`. `tidtabell: svarar inte …` tar 10 s.

## Uppdatering (2026-11-25e): Broms och gas (Analys.html)

André 2026-11-25: visa var tågen bromsar och gasar i förhållande till uppehållen, i meter och km, så att halkbekämpningen vet var de ska lägga arbetet på hösten. Använd appens GPS-data. Om det faktiskt är halt behöver inte bedömas.

Dataunderlag (`railtimer-data`, 51 spår okt–nov 2026, 1 punkt/s, noggrannhet i median 4 m): accelerationen ur GPS-farten delar sig tydligt. Jämn fart (rullning, lutning) ligger inom ±0,1 m/s², inbromsning kring −0,5 och gas 0,2–0,5 m/s². Vid de flesta stationer bromsar tågen 450–1 100 m före och gasar till 700–1 500 m efter. Vid Vedum och Vara (140 km/h) är det 1 500–2 500 m, och vid Mariestad och Lyrestad bromsar tågen i steg från ca 1 900 m före.

### Beräkningen (`railtimer-analys.js`)
- `motionPoints(track)`: farten jämnas ut över ±2 punkter, accelerationen är farten 1 s efter minus 1 s före. Varje punkt får sträcka `d` (GPS-brus vid stillastående räknas inte), fart `v` (km/h), `a` (m/s²) och `action`: `broms` (a ≤ −0,15), `gas` (a ≥ 0,15), `jamn` eller `still` (under 2 km/h). `motionTracks(runs, tracks)` räknas en gång per inläsning, som `analyzeTracks`.
- `stationAnchor(stop, pts)`: läget i spåret vid stationens koordinat. Punkten närmast koordinaten används, högst 400 m bort och inom ±10 min från ankomst/avgång, interpolerad mot grannpunkterna.
- `motionZones(runs, motion)`:
  - **Linjen** (`lineAxis`): stationerna i ordning med km längs spåret från den sydligaste änden. Avståndet mellan grannstationer är spårens median. Stationer med färre än 3 körningar tas inte med. Kanter som hoppar över stationer (körningar utan tågnummer) tas bort när vägen via stationerna är lika lång (±5 %). Grenar blir egna linjer.
  - **Per station och färdriktning** räknas bara körningar som stannade: under 2 km/h inom 400 m. Slutar mätningen samtidigt som tåget kommer fram, räcker appens ankomst om farten var under 10 km/h.
  - Fönstret går från föregående till nästa uppehåll, högst 4 km. Vid körningens start är det 400 m, utom när körningen är avskuren (`cutStart`).
  - Avstånden räknas i steg om 50 m. Varje körning röstar per steg på det den mest gjorde. En **zon** är där minst hälften av körningarna bromsar (gasar) och minst 3 har passerat, eller alla när färre än 3 stannade. Glapp upp till 150 m slås ihop och zoner under 100 m tas bort.
  - **Inbromsningen** (`approach`) är zonen som slutar vid stoppet plus tidigare steg med högst 1 000 m glapp utan gas emellan, med `steps`. **Gasen** (`departure`) räknas likadant framåt.
  - `own`: zonen ligger närmare stationen än grannuppehållet och högst 2 km bort. Längre ut syns den längs linjen.
  - Varje zon har km längs linjen (`km1`, `km2`), farten och medianläget (lat/lon) i start och slut.
  - Linjen får även andelen som bromsar och gasar per 100 m och riktning, från alla körningar inklusive passager.

### Fliken Broms och gas
- **Sträcka och riktning** (André 2026-11-25: välja till exempel Håkantorp–Gårdsjö och se båda hållen): *Från* och *Till* i fliken, med linjens stationer i ordning, och ⇄ som byter riktning (Från och Till byter plats). Förvalt är hela linjen, och *Hela linjen* återställer. Allt i fliken gäller vald sträcka och riktning, och färdriktningen går alltid åt höger. Väljs samma station i båda, eller en station på en annan linje, blir den andra änden linjens ände längst bort (`setMotionRoute`). Färdriktningen följer valet (`motionRange`: 1 = stigande km). Öppen station följer med vid riktningsbyte.
- **Hela linjen**: ett band i km, 6 px/km, som rullas i sidled på mobilen. Rött betyder bromsar och blått gasar, med starkare färg när fler körningar gör det. Grått betyder jämn fart. Stationsnamnen ligger i upp till fem rader, och ett klick öppnar stationen.
- **Vid uppehållen**: en rad per station längs en lodrät linje. Varje rad har en stapel från 3 km före till 3 km efter, med samma skala för alla stationer, och texten *Bromsar från 950 m före · Gasar till 1 100 m efter*. Stationer utan uppehåll visas nedtonade. Med färre än 3 uppehåll står det *få körningar*.
- **Klick på en station** visar:
  - rutor med inbromsning, gas, var tåget stannar och underlaget;
  - fartprofilen: en linje per körning, median, zonerna och ett band med andelen. Pekaren visar meter, fart och hur många av körningarna som bromsar och gasar. Diagrammet ritas i skärmens bredd;
  - en karta med OpenStreetMaps kartbilder (mörkt filter på skärmen) och linjen färgad efter vad tågen gör, med *börjar bromsa* och *slutar gasa* utmärkta;
  - zonerna med koordinater som länkar till Google Maps.
- **Lista för halkbekämpningen**: per station visas var inbromsningen börjar och var gasen slutar, i meter, km och koordinater.
- **Export**: Excel för båda riktningarna, med uppehållen och alla zoner och koordinater med decimalkomma. **Skriv ut / PDF** blir svart på vitt (egna färgvärden för `#motionReport` i utskrift).
- **Alla körningar som går någon del av sträckan räknas**, och körningarna skärs inte av, så att inbromsningen in mot första stationen kommer med. Station 1 och 2 i filtret väljer sträckan när de ändras, men tar inte bort körningar.
- Export till Excel gäller vald sträcka i båda riktningarna (vald riktning först), med riktningen skriven som "Håkantorp → Gårdsjö".
- Fliken räknas bara när den visas (`motionDirty`), eftersom det tar ca 0,2 s med 50 spår.
- Färgerna (`--brake` #e66767, `--gas` #3987e5, i utskrift #d03b3b och #2a78d6) går att skilja åt vid färgblindhet, både mot mörk och mot vit bakgrund.
- Kartbilderna från `tile.openstreetmap.org` är inte provade härifrån, eftersom utvecklingsmiljön inte når dem. I testläge hämtas inga kartbilder (`setTileUrl`).

### Tester
- `node --test "tests/*.test.js"` (103), med en simulerad körning (`simulateRun`: gas 0,4 m/s², broms 0,5 m/s², stopp, hastighetsbegränsning). Testerna täcker broms, gas och brus, stationens läge, zonerna i båda riktningarna, linjens km utan genvägar och inbromsning i steg med och utan gas emellan.
- `node tests/run-browser-tests.mjs` (68), nytt: *analys: Broms och gas visar var tågen bromsar och gasar vid uppehållen*. Testet täcker sträcka, byt riktning, körningar som bara går en del av sträckan (Källby → Blomberg), Station 1 och 2, Hela linjen, export och utskrift.
- Bilder: `--shot=broms-och-gas`, `--shot=broms-och-gas-mobil` och `--shot=broms-och-gas-utskrift`.

## Uppdatering (2026-11-25f): tågorderns tider (driftstid)

André 2026-11-25: "Det är extremt viktigt att vi presenterar rätt data." Upptäckt med förarens tågorder för 23349 Lidköping–Herrljunga C 2026-11-25.

### Problemet
- `fetchTimetable` hämtade bara `AdvertisedTimeAtLocation`, den annonserade tiden. Vid de flesta mellanstationer är annonserad ankomst samma minut som avgången, men tågordern har ankomsten en minut tidigare: Vedum annonserad 12:01/12:01, tågorder 12:00/12:01. Annonserad avgång kan också vara tidigare än tågorderns: Vara 11:53 mot 11:54 (tågordern skriver "Annonserad avg-tid 11:53").
- Datan 2026-11-25: 1 206 av 1 479 mellanstationer hade samma annonserade ankomst och avgång.
- Följder i analysen:
  - **Var tiden går** räknade uppehållsminuten som gångtid. 23349 2026-11-25: med annonserade tider gångtid −4,1 och uppehåll +4,4 min; med tågorderns gångtid +2,9 och uppehåll −2,6 min. Start (+0,3) och slut (+0,6) lika.
  - **Uppehåll utan väntan** räknades från den annonserade ankomsten (= avgångstiden), så uppehållen blev för korta: Vedum 5 s i stället för 56 s.
  - Planerad gångtid, marginal, tappad tid, ankomstavvikelse och Tid över påverkades på samma sätt.

### Appen
- `fetchTimetable` hämtar även `LocationDateTimeOTN` – Trafikverkets fältbeskrivning: det operativa tågets ankomst- eller avgångstid enligt tidtabell, kan skilja sig från den annonserade. Fältet hette `TechnicalDateTime` före schema 1.8.
- **Körningsformat 3:** per station `operationalArrival` och `operationalDeparture` (tågorderns tider) bredvid `scheduledArrival` och `scheduledDeparture` (annonserade, oförändrad betydelse). `normalizeLogEntry` bevarar fälten.
- `planArr`/`planDep`: tågorderns tid gäller. Utan den den annonserade, men vid en mellanstation där annonserad ankomst = avgång visas ingen planerad ankomst (den är okänd). Passage: samma tid för båda. Används i panelen, stationslistan, rapporten och CSV:n.
- Panelen visar "ankomst plan" enligt tågordern, och "avgång plan" när ankomsten är okänd. Vid station står den annonserade avgången när den skiljer sig ("avgång plan · annons 11:53"). Utfällt kort: "Tågorder: ankomst 12:00, avgång 12:01", eller "Annonserad tid: … (tågorderns tider saknas)".
- CSV: Schema Ank/Avg är tågorderns tider; nya kolumner Tidtabell (tågorder/annonserad), Annonserad Ank och Annonserad Avg sist.
- **Inte provat mot Trafikverket:** varken API:et eller Chrome nås från utvecklingsmiljön. Kontrollera vid nästa resa att det utfällda kortet visar samma tider som tågordern.

### Analysen
- `plannedArrival`/`plannedDeparture` ger bara tågorderns tider (passage: den tid som finns). `hasTimetable` = körningen har tågorderns tider; `hasAdvertisedOnly` = bara annonserade.
- **Jämförelser mot tidtabellen görs bara på körningar med tågorderns tider:** avvikelser, tappad tid, planerad gångtid och marginal, planerat uppehåll, uppehåll utan väntan, Var tiden går, Tid över, tågens tidtabeller och förslag, planerad restid i Jämför perioder.
- Körningar med bara annonserade tider räknas bara i det som mäts: vad sträckorna tar, verkliga uppehåll, GPS-spår. Annonserade tider används bara för att ordna stationerna (`anyPlannedTime`, `anyPlannedArrivalFirst`).
- **Nytt tåg:** gamla körningar räknas som stopp utan tidtabell, alltså hela det verkliga uppehållet (kan innehålla väntan), etiketten "mätt utan tågorderns tider". Mätningar med tågorderns tider går före.
- Analys.html visar under urvalet hur många körningar som jämförs och hur många som bara har annonserade tider (`#basisLine`). Texterna säger "med tågorderns tider" i stället för "med tidtabell".
- Datan 2026-11-25 (214 körningar): 0 med tågorderns tider, 152 med bara annonserade och 62 utan tidtabell. Per tåg, Sträckor (planerad tid), Tidtabell för befintliga tåg och Var tiden går är därför tomma tills nya körningar kommer.
- Gamla körningar kompletteras inte i efterhand: det är okänt hur långt bakåt Trafikverkets API har tidtabeller, och det kan inte provas härifrån. Tågorderns tider gissas aldrig.

### Tester
- `node --test "tests/*.test.js"` (109), nya: `tågorderns tider: …` med 23349 2026-11-25 (verkliga tider och tågorderns).
- `node tests/run-browser-tests.mjs` (73), nya: `tidtabell: tågorderns tider …`, `tidtabell: planerad tid är tågorderns …`, `tidtabell: resvyn räknar mot tågordern …`, `analys: körningar med bara annonserade tider …`. Testdatan i analysproven har tågorderns tider (`sArr`/`sDep`), och `format 3` ersätter `format 2`.

## Uppdatering (2026-11-25g): skydd om Trafikverket inte godtar tågorderns tid

André 2026-11-25, före resan: "Kontrollera så allt ser rätt ut." Appversion `2026-11-25g`.

- `LocationDateTimeOTN` (2026-11-25f) är inte provat mot det riktiga API:et. Godtar Trafikverket inte fältet skulle hela tidtabellsfrågan misslyckas, och resan skulle bara få start- och slutstation.
- **Skydd** (`fetchTimetable`): ger frågan med fältet ett felsvar (inte HTTP 2xx, eller `ERROR` i `RESPONSE.RESULT`), frågas igen utan fältet. Resan får då de annonserade tiderna och kortet visar "Annonserad tid: … (tågorderns tider saknas)". Vid tidsgräns eller nätfel frågas inte igen, så väntan blir som förut högst 10 s. Ett `ERROR` i ett svar med HTTP 200 gav förut meddelandet "Tåg … hittades inte"; nu står Trafikverkets felmeddelande.
- **Hela vägen provat i testerna:** startformuläret med tågnummer, Trafikverkets svar med tågorderns tider, rutten med alla mellanstationer, panelen ("ankomst plan" enligt tågordern), stationskorten (även annonserad avgång som skiljer sig) och den sparade körningen (format 3, båda tiderna). Uppladdningen skickar hela den sparade körningen (`JSON.stringify(task.log)`), så fälten kommer med till `railtimer-data`.
- GitHub Pages byggde 2026-11-25f utan fel (`pages build and deployment`, 3e10cb0).

### Tester
- `node --test "tests/*.test.js"` (109).
- `node tests/run-browser-tests.mjs` (75), nya: `tidtabell: godtar Trafikverket inte LocationDateTimeOTN …` (HTTP 400 och `ERROR` med HTTP 200) och `tidtabell: hela vägen – startformuläret, …`.

## Uppdatering (2026-11-25h): Trafikverkets rapporterade tider och kontrollsidan

André 2026-11-25: kontrollera vad mer vi kan läsa ut ur Trafikverkets API och gör det som krävs. Appversion `2026-11-25h`.

Utvecklingsmiljön når inte `api.trafikinfo.trafikverket.se` (proxyn spärrar adressen). Fälten nedan kommer från dokumentationen, och allt är testat mot simulerade svar. Kontrollsidan finns för att prova på riktigt från telefonen. Sammanfattningen finns också i projektet (`claude/trafikverket-api.md`).

### `railtimer-trv.js`
- `buildQuery`/`query` med tidsgräns (10 s, efter resan 8 s), felsorter `network|timeout|http|api` och Trafikverkets feltext.
- `swedishLocal`/`swedishDay`: svensk tid utan tidszon, som API:t tolkar som svensk tid.
- `runQuery`: tågets annonseringar i körningens tidsfönster ± 3 h. Sena tåg och tåg över midnatt kommer med.
- `trafikverketTimes`: per station Trafikverkets rapporterade tid (`TimeAtLocationWithSeconds`, annars `TimeAtLocation`), spår, inställt och avvikelser. Tågorderns tider ingår inte, eftersom `fetchTimetable` redan sparar dem (2026-11-25f).
  - Matchas på signatur och Ankomst/Avgang, närmast i tid.
  - `complete` = allt som annonserats för körningens stationer är rapporterat. Inställda räknas inte.
- `compareRun`: appen − Trafikverket i sekunder per station och aktivitet. `summarizeComparison` ger median, P10–P90 och antal inom 10/30 s, per aktivitet och per station.
- `runCheck`: kontrollen i api-koll.html.
  - Varje del körs för sig, så att ett fel i en del inte stoppar resten.
  - Utan kontakt avbryts kontrollen efter första frågan (`aborted`).

### I appen
- **Efter resan** (`afterJourneyTrafikverket`): Trafikverkets tider hämtas och sparas i körningen som `run.trv` (`fetchedAt, found, complete, operator, product`) och `stop.trv` (`arrival, departure, track, canceled, deviations`). Sedan laddas körningen upp.
  - Saknas slutstationens rapport görs ett nytt försök efter 60 s (`trvRetryDelayMs`), men aldrig under en ny resa.
  - Misslyckas hämtningen laddas körningen upp ändå.
- **Före uppladdning** (`fillTrafikverketBeforeUpload`): hämtar tider för högst 3 körningar som inte laddats upp än och saknar dem (`needsTrafikverket`). Körningen ska vara högst 7 dagar gammal. En ofullständig hämtning görs om tills den gjorts mer än 15 min efter resan.
- `updateStoredLog` ändrar en körning i lagringen med `setItemWithRoom`, och i `unsavedLogs` om den bara finns i minnet. `normalizeLogEntry` bevarar `trv`.
- Logiken för ankomst och avgång är oförändrad, och regressionsfacit passerar.
- **Rapporten**: raden *Trafikverket ↓ tid appen ±s · ↑ tid appen ±s · spår · inställt* under varje station, och en sammanfattning med medianskillnaden (`#trvSummary`) eller *Hämtar …*/*kunde inte hämtas nu*.
- **CSV** (`logsCsv`): kolumnerna *TrV ankomst*, *TrV avgång* och *TrV spår* sist, efter tågorderns kolumner.
- ⋮ → **Trafikverket-data** öppnar `api-koll.html`, utom under en resa.
- Service workern sparar `railtimer-trv.js` och `api-koll.html`.

### Kontrollsidan `api-koll.html`
Tågnummer (förifyllt från senaste körningen) och datum. Sidan visar:
- **Appens tider mot Trafikverkets** för upp till 20 senaste körningar på telefonen, plus en körning per ålder: 7, 14, 30, 60, 90, 180 och 365 dagar. Därmed syns också hur långt bakåt API:t har data.
- **Tågets annonseringar**: plan, faktisk tid med sekunder, avvikelse, spår, operativ tid, prognos, inställt och avvikelser. Ej annonserade platser visas nedtonade.
- **TrainPosition**: tågets senaste position, hur många tåg som rapporterar och hur många av förarens tågnummer som finns med.
- **TrainStation**: annonserade och ej annonserade platser, och alla fält för tågets stationer.
- **TrainMessage** som rör tågets stationer, **TrainStationMessage** och **ReasonCode**.
- Fältlistor per objekttyp: hur många poster som har varje fält, med exempel.
- **Spara i railtimer-data** skriver resultatet till `api-koll/api-koll_<datum>_<tid>_<tåg>.json` med appens uppladdningsinställningar. **Ladda ner JSON** fungerar utan dem.
- Schemaversioner: TrainAnnouncement 1.9, TrainStation 1.4, TrainPosition 1.1 (namespace `järnväg.trafikinfo`), TrainMessage 1.7, TrainStationMessage 1 och ReasonCode 1. Fel i en version visas i sin del.

### Inte provat
- Svar från det riktiga API:t, särskilt om `TimeAtLocationWithSeconds` finns för Kinnekullebanan och hur långt bakåt data finns.
- Schemaversionerna för TrainPosition, TrainStationMessage och ReasonCode.

### Tester
- `node --test "tests/*.test.js"` (124), bland dem `tests/railtimer-trv.test.js`.
- `node tests/run-browser-tests.mjs trafikverket` (8), som täcker efter resan, nytt försök, utan kontakt, före uppladdning, utan testsvar och kontrollsidan, även utan täckning.
- Alla webbläsartester: 83.
- `tidtabell: hela vägen …` (2026-11-25g) kontrollerar nu appversionens form i stället för en viss version. Förut slog det fel vid varje höjning.
- Bilder: `--shot=rapport-trafikverket` och `--shot=trafikverket-data`.

## Uppdatering (2026-11-25i): inloggningslänk för GitHub

André 2026-11-25: det är jobbigt att lägga in token igen varje gång webbläsarens data har rensats. Appversion `2026-11-25i`.

- **Inloggningslänk** (`railtimer-github.js`: `loginLink`, `settingsFromLink`, `LINK_PARAM`): repo, token och gren (bara om den inte är `main`) läggs som base64url-kodad JSON i länkens #-del, till exempel `…/Analys.html#rt=…`. Webbläsaren skickar aldrig #-delen till servern. Kodningen är inte kryptering: länken ger samma åtkomst som token.
- **Analys.html**: under GitHub-inställningar finns *Slipp skriva in token igen* med knappen *Skapa inloggningslänk*. Den sparar först en ifylld token och visar sedan länken med *Kopiera* och *Dela*; Dela visas bara när `navigator.share` finns.
  - Öppnas sidan med länken (`consumeLoginLink`) sparas inställningarna, #-delen tas bort ur adressfältet (`history.replaceState`) och mätningarna hämtas. Det gäller även när länken öppnas medan sidan redan är öppen (`hashchange`).
  - En länk som klistras in i fältet Token fungerar också, med *Spara* eller *Hämta från GitHub*, även när inställningar redan finns.
- **Appen (index.html)**: *Kopiera inloggningslänk* i Uppladdning. Går det inte att kopiera öppnas delningsmenyn i stället.
  - Länken (`…/index.html#rt=…`) sparar inställningarna vid start, eller när den öppnas medan appen är öppen, och visar *GitHub-inloggning sparad*.
  - En länk inklistrad i fältet Token används av *Spara och testa*.
- Appen och analysverktyget delar `railtimer_github_v1` (samma ursprung), så en länk till någon av sidorna loggar in båda i samma webbläsare. En app som lagts till på hemskärmen har egen lagring på iPhone; där klistrar man in länken i fältet Token.
- Den gamla texten om att låta webbläsaren spara token som lösenord är borttagen ur analysverktyget. Formuläret har kvar `autocomplete` username/current-password.
- Tester: `node --test "tests/*.test.js"` (126), *inloggningslänk: …* i `tests/railtimer-github.test.js`. `node tests/run-browser-tests.mjs` (85), *uppladdning: inloggningslänken …* och *analys: inloggningslänken …*.
