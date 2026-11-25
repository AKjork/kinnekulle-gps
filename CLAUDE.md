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
| `railtimer-info.js` | Infofliken: möten, enkel- eller dubbelspår, prognos och anslutningar under resan |
| `railtimer-vt.js` | Västtrafiks API (Planera Resa v4): token, hållplatser vid en station, avgångar och ankomster – bussanslutningar i Info |
| `vasttrafik-koll.html` | Västtrafik-data: provar Västtrafiks API från telefonen (token, hållplatser, bussar) |
| `vt-token.json`, `tools/vasttrafik-token.mjs`, `.github/workflows/vasttrafik-token.yml` | Västtrafiks gemensamma token: GitHub Actions hämtar den med hemligheterna `VT_KEY`/`VT_SECRET` och lägger den i `vt-token.json`, som appen läser (sedan 2026-11-25za) |
| `docs/vasttrafik-worker.js` | Egen liten server för Västtrafik (Cloudflare Worker). Behövs inte: Västtrafik tillåter appens adress (2026-11-25za) |
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
- **Före uppladdning** (`fillTrafikverketBeforeUpload`): hämtar tider för högst 3 körningar som inte laddats upp än och saknar dem (`needsTrafikverket`). Körningen ska vara högst 7 dagar gammal (3 sedan 2026-11-25j). En ofullständig hämtning görs om tills den gjorts mer än 15 min efter resan.
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
- **TrainMessage** som rör tågets stationer, **TrainStationMessage** och **ReasonCode**. (TrainMessage finns inte längre, se 2026-11-25j.)
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

## Uppdatering (2026-11-25j): svaret från Trafikverket – OperativeEvent, hela minuter och hur länge data finns

André 2026-11-25 körde kontrollsidan för 23349 och sparade svaret i `railtimer-data/api-koll/api-koll_2026-11-25_130558_23349.json`. Appversion `2026-11-25j`.

### Vad svaret visade
- **TrainAnnouncement 1.9 utan namespace fungerar.** Tåget hade 57 annonseringar, 50 annonserade och 7 ej annonserade.
  - `LocationDateTimeOTN` finns i alla 50 annonserade, så tågorderns tider (2026-11-25f) fungerar.
  - `TimeAtLocationWithSeconds` finns för 25 av 57.
  - Nya fält: `OperationalTransportIdentifiers` och `PlannedEstimatedTimeAtLocationIsValid`.
- **Var Trafikverket rapporterar** (23349 Hallsberg pbg–Herrljunga C):
  - Med sekunder: Hallsberg–Gårdsjö, Håkantorp, Vara, Vedum och Herrljunga C.
  - Bara hela minuter, även i `TimeAtLocationWithSeconds`: Mariestad, Forshem och Lidköping. Även Håkantorps avgång vissa dagar.
  - Ingen rapport alls för de övriga stationerna mellan Gårdsjö och Håkantorp.
- **Trafikverkets tider är inte stopp och start.** Tider med sekunder, 10 ankomster och 9 avgångar i körningarna 2026-11-24–25:
  - Ankomst: appen 27–63 s efter Trafikverket, median 43 s.
  - Avgång: appen 2–31 s före Trafikverket, median 17 s.
  - Det stämmer med att Trafikverket registrerar när tåget når och lämnar stationens område, inte stoppet och starten. Trafikverket kan alltså inte ersätta appens tider, men fångar grova fel. 23334 2026-11-24 har en avgång 614 s före Trafikverkets: den falska avgången vid start som rättades 2026-11-25.
- **Hur länge data finns:** körningar 0–1 dygn gamla hade data, 6 dygn och äldre inget. Det bekräftar att tiderna måste hämtas strax efter resan.
- **TrainMessage finns inte längre:** svaret var "ObjectType 'TrainMessage' does not exists". Ersättaren är **OperativeEvent** 1.0 i namespace `ols.open`.
- **TrainStationMessage** utan filter gav 2 000 meddelanden, även gamla från 2025.
- **TrainPosition 1.1** fungerar. 4 335 tåg hade position och 267 rapporterade de senaste 10 min. 26 av förarens 84 tågnummer fanns med, bland dem 23349.
- **TrainStation**: 1 754 platser, 720 annonserade och 1 034 ej annonserade, alla med position.
- **ReasonCode**: 789 orsakskoder.
- Trafikverkets datautbytesportal skriver att TrainAnnouncement kräver namespace från 2/9 2026 (`rail.trafficinfo`). Frågan utan namespace svarade ändå 2026-11-25.

### Ändrat
- **Kontrollsidan**:
  - **OperativeEvent** (`namespace="ols.open"`, `EventState=1`) i stället för TrainMessage. En händelse rör tåget när någon `Signature`/`LocationSignature` på någon nivå är en av tågets stationer (`signaturesIn`). Rubrik och text kommer från det senast ändrade `TrafficImpact.PublicMessage`, annars `EventType.Description`.
  - **TrainStationMessage** bara för tågets stationer och bara de som gäller nu (`IN LocationCode`, `GT EndDateTime`). Samma text på skärm och i utrop visas en gång. `\PAU=…\` tas bort.
  - **Namespace**: TrainAnnouncement 1.9 utan namespace, 1.9 och 2.0 med `rail.trafficinfo`, och TrainStation 1.4 med `rail.trafficinfo`. Tabellen visar vad API:t godtar, så att appen kan byta i förväg.
  - Tider i hela minuter räknas inte i jämförelsen. Det står vilka stationer det gäller (`#minuteNote`).
  - Klockslagen visas i svensk tid, som datumen.
- **Appen**:
  - `wholeMinute`: en Trafikverket-tid på :00 visas som "hel minut" utan "appen ±s" och räknas inte i rapportens median.
  - Rapporten förklarar att Trafikverket registrerar ankomsten innan tåget stannar och avgången efter att det börjat rulla.
  - Tiderna hämtas för körningar som är högst 3 dygn gamla (förut 7).
  - Får en körning äldre än ett dygn tomt svar sparas inget. Rapporten säger då att Trafikverket inte har kvar tiderna (`trvStatus` `gone`). Förut hade körningen fått "inga tider för tåget".

### Tester
- `node --test "tests/*.test.js"` (128): OperativeEvent, stationsmeddelanden, namespace, hela minuter och `signaturesIn`.
- `node tests/run-browser-tests.mjs trafikverket` (10), nya: hela minuter i rapporten och äldre körning utan svar.
- Alla webbläsartester: 87.

## Uppdatering (2026-11-25k): infofliken – läget framåt under resan

André 2026-11-25: förväntas vi möta ett sent tåg så att vi blir sena? Enkel- eller dubbelspår? Hur påverkar det anslutningarna i slutstationen (till exempel Vara → möte med sent tåg → sena till Herrljunga → missade anslutningar, eller ingen påverkan om de anslutande tågen också är sena)? Löpande under resan, utifrån tåget man kör, tidigt och kompakt – ett stöd för den som jobbar på tåget. Appversion `2026-11-25k`.

Dataunderlag (`railtimer-data`, 214 körningar): uppehåll över 2 min vid mellanstationer är vanliga i Gårdsjö (44 %), Forshem (34 %), Laxå (30 %) och Vara (27 %), troligen möten; övriga mellanstationer 0–9 %. 4 av 25 ankomster till Herrljunga med tidtabell var mer än 3 min sena.

### Beräkningen (`railtimer-info.js`, rena funktioner)
- **Linjen** (`buildLine`): vårt tågs alla platser i Trafikverkets TrainAnnouncement mellan start- och slutstation i tidsordning, även driftplatser där tåget bara passerar (möten kan ligga där). Körningen väljs med `nearestRun` (avgångsdatum närmast resans start). Tider: driftstid (`LocationDateTimeOTN`), annars annonserad tid; annonserad avgång är tidigaste avgång vid annonserade stopp.
- **Frågorna** har svensk tid oavsett telefonens tidszon (`localIso`, som `swedishLocal` i `railtimer-trv.js`). **Skydd:** godtar Trafikverket inte frågan med alla fält (felsvar, inte tidsgräns eller nätfel) frågas igen utan `LocationDateTimeOTN` och `PlannedEstimatedTimeAtLocation` (`SAFE_ANNOUNCEMENT_FIELDS`, `infoAnnouncements`), som `fetchTimetable` gör sedan 2026-11-25g, och resten av resan frågas utan dem. Driftstiden blir då den annonserade tiden.
- **Möten** (`crossingOf`): ett motgående tåg (tiden minskar längs vår linje) möter oss vid plats *i* om båda är där samtidigt enligt tidtabell: vi lämnar inte platsen innan de kommit och de har inte lämnat den innan vi kommer. Är de enligt tidtabell på samma sträcka samtidigt minst 1 min möts de mellan stationerna, och då är sträckan **dubbelspår**. Sådana sträckor sparas (`railtimer_info_v1.double`) och gäller även nästa resa. Övriga sträckor räknas som enkelspår.
- **Det mötande tågets ankomst** (`theirArrival`): faktisk tid, annars Trafikverkets beräknade tid (`EstimatedTimeAtLocation`, eller planerad försening), annars senast rapporterade försening framräknad (`latestDelay`), annars tidtabellen – aldrig före nu om tåget inte kommit.
- **Vi väntar** på enkelspår till det mötande tåget kommit in + 1 min (`meetMarginMs`). Inget beroende om mötet är på dubbelspår, om det mötande tåget är inställt, eller om det redan passerat mötesplatsen mot oss (*mötet flyttat närmare oss*). Möten vi passerat visas inte.
- **Prognos** (`predict`): från senaste plats vi har en tid för (appens egna tider före Trafikverkets) framåt: planerad gångtid × faktor, minst 30 s uppehåll vid annonserade stopp, inte före annonserad avgång, och mötena. Platser vi inte nått ligger aldrig före nu.
- **Egna gångtider** (`historyMedians`, `recoveryRatios`): median för verklig gångtid mellan stationsparen ur telefonens körningar (minst 3). Faktorn är median/planerad, högst 1 och minst 0,85, så de visar hur mycket vi brukar ta igen men gör oss aldrig senare. *Tar igen ca N min* jämför med prognosen utan dem.
- **Anslutningar i slutstationen** (`outgoing`): annonserade avgångar minst bytestiden och högst 40 min efter vår annonserade ankomst. Tåg som går längs vår linje (har tider på andra platser på linjen, eller destination där) räknas inte. Deras avgång: faktisk, beräknad (aldrig före nu) eller tidtabellen. Status: *ok* (byte ≥ bytestid + 2 min), *knappt*, *missas*, *avgått* (gått innan vi är framme) eller *inställt*. *Ingen egen bytestid sedan 2026-11-25u: missas under 1 min, knappt under 4 min.*
- **Tåg som ansluter till oss i startstationen** (`incoming`), bara före avgång: annonserade ankomster minst bytestiden och högst 30 min före vår avgång, från annat håll. *hinner*, *knappt* eller *hinner inte*.
- **Avvikelser för vårt tåg** längre fram (`Deviation`, t.ex. Spårändrat, och inställda platser) och spår i slutstationen.
- **Störningar** (`OperativeEvent` 1.0, namespace `ols.open`, `EventState=1`, var 10:e minut, egen fråga – samma som kontrollsidan sedan 2026-11-25j, eftersom TrainMessage inte finns längre): de som har en signatur kvar på linjen på någon nivå (`signaturesIn`) och pågår (`messagesFor`). Rubrik och text från det senast ändrade `TrafficImpact.PublicMessage`, annars `EventType.Description` (`parseMessage`).
- **Nivåer**: 2 (påverkar: väntan ≥ 5 min, anslutning missas/avgått, försening ≥ 6 min), 1 (håll koll: väntan 1–4 min, knapp anslutning, inställt, avvikelse, störning), 0.

### I appen
- **Flikarna Stationer och Info** överst i stationslistan (`setInfoTab`); flikarna och kolumnrubrikerna står kvar när listan rullas (`.list-top`). Info visar en siffra (gul, röd vid nivå 2) med antal saker att hålla koll på.
- **Raden i panelen** (`#npInfo`, `infoHeadline`), högst två rader: *Herrljunga C 12:26 +3 · möte Vara · 1 anslutning missas*. Gul eller röd efter nivå. Tryck öppnar Info.
- **Fliken** (`infoPaneHtml`): prognos till slutstationen (plan, Trafikverkets beräknade tid, spår, tar igen, uppdaterad), *Längs vägen* (möten med det mötande tågets försening och källa, enkel- eller dubbelspår, vår väntan och avgång; avvikelser; störningar) i ordning längs linjen, *Ansluter till oss* före avgång, *Anslutningar* med **bytestid − / +** (per slutstation, 1–15 min, förval 4, `railtimer_info_v1.transfer`), och en rad om vad prognosen bygger på. *Bytestiden går inte att ändra sedan 2026-11-25u, och fliken har hela ytan.*
- **Hämtning** (`refreshInfo`): vid start och återupptagen resa, varje minut medan appen syns, när appen blir synlig igen och vid `online`. Först vårt tåg (±12 h), sedan alla tåg på platserna kvar från 1 h bakåt till 45 min efter vår planerade ankomst, i en fråga. Tidsgräns 15 s. Namn på driftplatser och destinationer som saknas i stationslistan hämtas en gång (TrainStation) och sparas (`railtimer_sig_names_v1`). Går hämtningen inte visas senaste data med *uppdaterad … (gammal)* och felet; utan data *Ingen kontakt med Trafikverket*.
- **Omräkning** utan nätet var 5:e sekund (`updateInfo` i panelens timer), så att våra egna tider kommer med direkt. Fliken ritas bara om när innehållet ändrats.
- **Meddelanden** (`notifyInfo`): när något blir värre (möte med väntan, anslutning knapp eller missas, avvikelse, störning) vibrerar telefonen, ljud om ljudet är på, och en toast visar det viktigaste i 8 s. Samma sak meddelas en gång per nivå.
- **Körningen** sparar mötena (`info.meetings`: plats, tåg, planerad tid, deras försening och källa, vår beräknade väntan, enkelspår, inställt, flyttat) – senaste läget innan vi åkte från mötesstationen. Analysverktyget kan senare visa vad möten kostar per station. `normalizeLogEntry` bevarar `info`. Se `docs/railtimer-data-README.md`.
- Utan tågnummer säger fliken att infon bygger på tågnumret. I testläge hämtar appen inget själv; testerna anropar `refreshInfo`.
- Service workern sparar `railtimer-info.js` för offline.

### Provat mot riktiga svar
- Kontrollsidans svar för 23349 2026-11-25 (`railtimer-data/api-koll/…_23349.json`, 57 annonseringar) genom `groupTrains`, `nearestRun`, `buildLine` och `compute`: linjen Lidköping–Herrljunga C blir Lkp, Fc, Lve, Jps, Stlv, Håp, Vaa, Ved, Hrc med tågorderns tider (Vara 11:53/11:54, annonserad avgång 11:53), destinationen `Hrc`, produkten Västtågen och spår 7. Tåget hade redan gått, så prognosen blev Trafikverkets faktiska ankomst 12:08.
- Trafikverkets beräknade tid fanns bara på 1 av 57 rader, och faktiska tider bara vid vissa stationer (se 2026-11-25j). Därför räknas ett mötande tågs ankomst ofta fram från senast rapporterade försening.

### Inte provat
- Möten och anslutningar mot riktiga svar med flera tåg: utvecklingsmiljön når inte Trafikverkets API, och kontrollsidan hämtar bara förarens tåg.
- `OperativeEvent` har inget sparat svar än; tolkningen följer kontrollsidan. Går frågan inte visas fliken utan störningar.
- Tågklareraren kan flytta möten. Prognosen räknar med mötet enligt tidtabell tills det mötande tåget passerat mötesplatsen.

### Tester
- `node --test "tests/*.test.js"` (149), nya i `tests/railtimer-info.test.js` (21): linjen, körningen, möte, väntan med sent tåg, Trafikverkets beräknade tid, dubbelspår (även sparat), inställt och flyttat möte, passerat möte, prognos aldrig före nu, egna gångtider, anslutningar (ok, knappt, missas, avgått, tillbaka längs linjen, bytestid), tåg som ansluter till oss, avvikelser, störningar (OperativeEvent), frågorna (även utan de oprovade fälten) och annonserad tid när tågorderns saknas.
- `node tests/run-browser-tests.mjs info` (6): sent mötande tåg i panelen och fliken med vibration, toast, anslutningar och bytestid; möte i tid; ingen kontakt; Trafikverket godtar inte tågorderns tid; mötena i körningen; utan tågnummer. Simulerat Trafikverket: `fakeTrafikverketInfo` i `tests/replay.html`. Alla webbläsartester: 93.
- Bilder: `--shot=info` (fliken) och `--shot=resa-info` (stationerna med raden i panelen).

## Uppdatering (2026-11-25l): vägen mellan appen och analysverktyget

André 2026-11-25 kom in i appen via inloggningslänken men hittade inte analysverktyget. Appversion `2026-11-25l`.

- Appens ⋮-meny har **Analysverktyg** (`btnAnalysis`) under Statistik. Valet öppnar `Analys.html` i samma flik, men inte under en resa ("Öppnas när resan är klar"), eftersom mätningen stannar när sidan byts.
- Analysverktygets rubrikrad har länken **← Till appen** (`./`). Den visas inte i utskriften.
- Tester: `node --test "tests/*.test.js"` (149). `node tests/run-browser-tests.mjs` (94), nytt: *meny: Analysverktyg öppnar analysverktyget, men inte under en resa*.

## Uppdatering (2026-11-25m): Trafikverkets km-tal i Broms och gas (Analys.html)

> **Ersatt (2026-11-25o):** plankorsningarna (RailCrossing) och linjens eget km används inte längre. Km-talet kommer från linjeboken, se 2026-11-25p.

André 2026-11-25: gör om kilometrarna till järnvägens egna km-tal, han förstod inte kolumnen Km. Appversion `2026-11-25m`.

- Förut var **Km** RailTimers eget mått: sträckan längs GPS-spåren från linjens sydligaste ände (Herrljunga C = 0, Vara 21,4, Hallsberg 200,3).
- **Källan:** Trafikverkets öppna API, objekttypen `RailCrossing` 1.5 (plankorsningarna). Varje plankorsning har `Kilometer` och `Meter` enligt banans längdmätning, `TrackPortion` (bandel) och `Geometry.WGS84`.
  - Kilometertavlorna själva (Markeringsstolpe/Kilometertal) finns bara som WFS och nedladdning hos Lastkajen. Varken den, Overpass eller Trafikverkets API nås från utvecklingsmiljön.
- `railtimer-trv.js`:
  - `fetchRailCrossings(box)` frågar först med `<WITHIN name="Geometry.WGS84" shape="box" value="lon lat, lon lat" />`.
  - Godtas inte filtret (felsvar), eller blir svaret tomt, hämtas hela landet (tidsgräns 30 s) och rektangeln väljs i appen. Vid nätfel eller tidsgräns görs inget nytt försök.
  - `parseCrossings` ger `{ lat, lon, bandel, m }`, där m = km-talet i meter. Raderade och ofullständiga poster tas inte med.
- `railtimer-analys.js`:
  - `motionZones` ger per linje `trace`: medianläget i spåren var 25:e meter med linjens km.
  - `kmTalAxis(line, crossings)`: plankorsningar högst 40 m från spåren blir referenspunkter. Per bandel behålls den längsta kedjan där km-talet följer spåret (±15 %, minst ±60 m), och bandelen behöver minst 3 sådana punkter. Felaktiga poster och korsningar på andra linjer kommer därmed inte med.
  - `kmTalAt(axis, km)` interpolerar mellan referenspunkterna och räknar vidare längs spåret högst 3 km utanför dem. Mellan två bandelar gäller den närmaste, och där flera täcker samma ställe den med flest punkter.
  - `formatKmTal(m, step)` ger "269+000".
- **Analys.html:**
  - Plankorsningarna hämtas när fliken visas, för rektangeln runt spåren + 0,02°. De sparas i `railtimer_kmtal_v1` och hämtas igen efter 30 dagar eller när spåren går utanför rektangeln.
  - Efter ett fel görs nytt försök tidigast efter 10 min, eller med **Försök igen**. Äldre sparat km-tal används hellre än inget.
  - Km-tal visas avrundat till 10 m: i stationsraderna ("km 269+000 · 3 uppehåll"), i linjebandet (jämna km per bandel, streckad linje där bandelen byts), i Lista för halkbekämpningen och zontabellen (kolumnen **Km-tal**, intervall i färdriktningen), i rutorna (*börjar km …*, *slutar km …*), vid pekaren i fartprofilen, i utskriften (raden Km) och i CSV:n (Bandel, Km-tal, Börjar bromsa km-tal, Slutar gasa km-tal; linjens egna km finns kvar som "Km från …").
  - Raden under linjebandet (`#motionKmNote`) säger var km-talet kommer från: bandelarna med första och sista station och antal plankorsningar.
  - Saknas km-tal står "Km från Herrljunga C" i kolumnerna och "21,4 km från Herrljunga C" i raderna, och raden säger varför.
- **Inte provat mot Trafikverket:** varken schemaversion 1.5, fälten, WITHIN-filtret eller om bandelarnas km-tal längs Kinnekullebanan räcker. Kontrollera vid första öppningen att raden under linjebandet visar bandelar, och att km-talen vid stationerna stämmer med linjeboken.
- Tester: `node --test "tests/*.test.js"` (152), nya *km-tal: …*, *parseCrossings: …* och *fetchRailCrossings: …*. `node tests/run-browser-tests.mjs` (95), nytt *analys: Broms och gas visar Trafikverkets km-tal från plankorsningarna*. Bilderna `--shot=broms-och-gas…` visar km-tal (simulerade plankorsningar).

## Uppdatering (2026-11-25n): appen kör senaste versionen när den öppnas

André 2026-11-25, under resan med 23334: infofliken syntes inte, eftersom telefonen visade den sparade kopian av appen. "Appen borde ju uppdateras och köra senaste versionen automatiskt när man öppnar den. Samt synka sig med GitHub." Appversion `2026-11-25n`.

### Förut
- Service workern visade den sparade kopian först och hämtade den nya i bakgrunden. En ny version syntes först vid nästa start, och en ny service worker väntade tills appen stängts helt eller ⋮ → Uppdatera app valdes.

### Nu
- **Nätet först** (`sw.js`): appens filer hämtas från GitHub Pages. Den sparade kopian används bara utan täckning, när nätet inte svarat inom 4 s (`NETWORK_TIMEOUT_MS`), eller när servern svarar med fel. Bara lyckade svar sparas, som förut.
- **Ny service worker tar över direkt** (`skipWaiting` vid installation, `clients.claim` vid aktivering). Registreringen har `updateViaCache: 'none'`, så att `sw.js` aldrig läses ur webbläsarens cache. En äldre service worker som väntar får `SKIP_WAITING` (`monitorServiceWorker`).
- **Versionskoll** (`checkForNewVersion`): `version.json` har den publicerade appversionen och hämtas förbi alla cachar (`?t=…`, `cache: 'no-store'`, service workern rör den inte). Den kollas vid start, när appen blir synlig igen (högst en gång per minut), när nätet kommer tillbaka, när en ny service worker tar över och var 15:e minut.
  - Skiljer den sig från `APP_VERSION` och **ingen resa pågår, startformuläret visas och ingen frågeruta är öppen** (`canReloadNow`): appen laddar om direkt, efter pågående uppladdning (högst 20 s). Bara en gång per version (`sessionStorage` `railtimer_reloaded_for`), så att den aldrig laddar om i en slinga.
  - Annars (resa, rapport, eller kollen var 15:e minut): meddelandet *Ny version … – ⋮ → Uppdatera app (resan fortsätter)* och knappen i menyn. Versionen tas i bruk vid *Starta ny mätning*.
- **Uppdatera app mitt i resan** (`applyUpdate`): resan och GPS-spåret sparas, och efter omladdningen fortsätter appen samma resa direkt, utan frågan *Återuppta resa?*, med meddelandet *Appen uppdaterad till … – resan fortsätter* (`sessionStorage` `railtimer_resume_after_update` med resans id, `takeResumeAfterUpdate`). En vanlig omstart frågar som förut.
- **Höj versionen på två ställen:** `APP_VERSION` i `index.html` och `version.json`. Testet *version.json har samma version som appen* i `tests/sw.test.js` slår fel annars.
- **Synk med GitHub** var redan automatisk och är oförändrad: körningar som inte laddats upp skickas när appen startar, när den blir synlig, när nätet kommer tillbaka och efter varje resa – aldrig under en pågående resa. Kräver att uppladdningen är inställd (⋮ → Uppladdning eller inloggningslänken).
- Övergången: telefoner som har en äldre version kör den gamla service workern tills den nya har installerats. Det sker vid första öppningen efter publiceringen; från nästa öppning gäller nätet först.

### Tester
- `node --test "tests/*.test.js"` (159), nya i `tests/sw.test.js`: med nät visas servern, utan nät och vid tidsgräns den sparade kopian, felsvar, `version.json` orörd, `skipWaiting`/`clients.claim` och gamla kopior bort, och samma version i `index.html` och `version.json`.
- `node tests/run-browser-tests.mjs uppdatering` (2): *Uppdatera app mitt i resan laddar om och fortsätter samma resa utan frågan* (tiderna kvar, vanlig omstart frågar), och *ny version laddas direkt vid start utan resa, men under resan bara med meddelande* (en gång per version, samma version gör inget). Alla webbläsartester: 97.
- Inte provat på en riktig telefon: att Safari och Chrome byter service worker som väntat. Kontrollera efter publiceringen att ⋮-menyn visar den nya versionen efter en omstart.

## Uppdatering (2026-11-25o): körningarna från GitHub på telefonen, förvald fordonstyp och rutt

André 2026-11-25: "Absolut allt som gör det mer smidigt och automatiserat." Appversion `2026-11-25o`.

### Synk från GitHub (`syncFromGithub`)
- Förut gick synken bara upp till GitHub. Historiken fanns bara på telefonen där körningarna gjorts och försvann när webbläsarens data rensades.
- Nu hämtas körningarna i `railtimer-data` (`korningar/…` och `import/…`) med `GH.loadRunsFromRepo`, samma som analysverktyget.
  - Filerna sparas per sha i analysverktygets lokala databas (IndexedDB `railtimer-analys`/`blobs`, `AppBlobCache`). Bara nya filer hämtas, och det som analysverktyget redan hämtat i samma webbläsare hämtas inte igen.
  - Körningarna sparas kompakt (`compactRun`: tåg, fordon, start och slut, tider, `excludeInboundRun`) under nyckeln `app:korningar-v1` och läses vid start (`loadRepoRunsFromDevice`), så att de finns utan nät.
- **När:** vid start efter uppladdningen, när appen blir synlig och efter varje resa. Högst var 30:e minut (`REPO_SYNC_MIN_MS`) utom efter en resa, aldrig under en pågående resa och inte utan nät. Läget sparas i `railtimer_repo_sync_v1` (`at, count, newFiles, error`).
- `allRuns()`: telefonens körningar plus de från GitHub som inte finns på telefonen (samma id). Används av:
  - infoflikens egna gångtider (`historyMedians`);
  - Statistik och dess filter;
  - ruttförslaget för ett tågnummer (`analyzeRouteHistory`);
  - förvald fordonstyp.
- ⋮ → Uppladdning visar *Hämtat från GitHub: N körningar (tid)* och ett eventuellt fel.

### Startformuläret
- **Fordonstyp** (`prefillVehicleType`): den som oftast använts för tågnumret (vid lika den senaste), annars den senast använda. Den väljs vid start och när tågnumret skrivs, men aldrig när föraren själv valt fordonstyp (`vehicleChosenByUser`).
- **Rutten fylls i direkt** när förslaget kommer från GPS + tidtabell, alltså när föraren står vid en station på tågets väg inom 30 min före till 15 min efter avgången (`findCurrentRouteSegment`).
  - Det sker bara när start- och slutfälten är tomma eller fortfarande har det som fylldes i automatiskt (`routeFieldsUntouched`, `autoFilledRoute`).
  - Rubriken visar *✓ Rutt ifylld: …*.
  - Förslag ur tidigare körningar visas som förut, med knappen att trycka på.

### Tester
- `node --test "tests/*.test.js"` (159).
- `node tests/run-browser-tests.mjs` (100), nya:
  - *synk: körningarna i GitHub hämtas till telefonen …*: fyra körningar i fyra filer, kompakt, inga nya filer andra gången, inte under resa, fordonstyp, Uppladdning, Statistik, kvar efter omstart och förarens val av fordon.
  - *startformulär: tågnumret fyller i rutten …*.
- Inte provat mot riktiga GitHub från telefonen. Kontrollera i ⋮ → Uppladdning att *Hämtat från GitHub* visar ungefär lika många körningar som analysverktyget.

## Uppdatering (2026-11-25p): km-tal från linjeboken och enkel lista för halkbekämpningen (Analys.html)

André 2026-11-25:
- "Så enkelt underlag som möjligt till halkbekämpningen men ska kunna bli mer avancerat om man vill nörda ned sig."
- "Vi kan inte utgå från annat än Trafikverkets verkliga km." Exempel: Hällekis 67+510, Råbäck 71+620, Källby 83+974.
- "Vi kan följa GPS-spåret och åtminstone presentera ungefärliga kilometrar. Det räcker med Gårdsjö–Håkantorp och omvänt."

Appversion `2026-11-25p`.

### Km-tal
- **Källa:** Trafikverkets *Underlag till linjebok*, TC Göteborg, version 2026-09-01, sid D813–D822 (Gårdsjö – Håkantorp). Dokumentet är publikt på bransch.trafikverket.se. Stationernas km-tal finns i `AN.KMTAL_SECTIONS` och stämmer med Andrés exempel.
  - Exempel: Gårdsjö 0+000, Hova 8+730, Mariestad 39+045, Hällekis 67+510, Källby 83+974, Lidköping 93+111 och Håkantorp 121+021.
  - Hasslerörs km-tal gäller växeln.
- `kmTalAxis(line)`: stationerna på linjen med linjebokens km-tal blir fasta punkter. Stationer som inte följer linjebokens ordning tas inte med.
- `kmTalAt(axis, km)` interpolerar längs linjens km, som räknas ur GPS-spåren.
  - Utanför Håkantorp – Gårdsjö ges inget km-tal, eftersom där gäller en annan bana med andra km.
  - Sträckorna mellan stationerna i spåren stämmer med linjeboken på i regel några tiotal meter, högst 151 m (Mariestad–Hasslerör, där linjebokens km-tal gäller växeln).
- **Visas:**
  - vid stationerna exakt (`kmTalStation`), annars avrundat till 10 m;
  - inget eget km någonstans, utan "–" där km-tal saknas.
- **Borttaget:** `fetchRailCrossings`, `parseCrossings`, `WITHIN` i `filterXml` (`railtimer-trv.js`), `trace` i `motionZones`, `railtimer_kmtal_v1` och knappen Försök igen.
- Övriga banor:
  - Herrljunga C – Håkantorp: Vara 69+179, Vedum 79+836 och Herrljunga C 90+565, i linjeboken D684–D687.
  - Gårdsjö – Hallsberg: Gårdsjö 252+267, Laxå 229+398 och Hallsberg pbg 199+419.
  - De är inte inlagda. Mellan Gårdsjö och Laxå skiljer spåren 352 m från linjeboken (1,5 %).

### Enkel lista (förvald) och Detaljerad
- Knapparna **Enkel lista** och **Detaljerad** överst i fliken. Valet sparas (`railtimer_motion_mode_v1`, inte i testläge).
- **Enkel lista** (`#motionSimple`). André 2026-11-25: "vill kunna se åt båda håll, broms och gas kan se väldigt annorlunda ut."
  - En tabell per riktning, vald riktning först, till exempel Håkantorp → Gårdsjö och Gårdsjö → Håkantorp.
  - En rad per station med uppehåll i den riktningen.
  - **Bromsar in** och **Gasar ut** i km-tal i färdriktningen, med längd.
  - Delen utanför Håkantorp – Gårdsjö räknas inte. Cellen säger då "och utanför …", eller "–, utan km-tal".
  - Klick på en rad öppnar stationen i Detaljerad.
- *Exportera till Excel* i enkla läget ger `behandla-ralsen_<datum>.csv`: en rad per station och riktning, med km-tal, längd, anmärkning och koordinater. *Skriv ut / PDF* skriver bara listan.
- **Detaljerad** är den tidigare vyn.
  - Linjebandet visar båda riktningarna ovanför varandra: överst vald riktning →, under den andra ←.
  - Tabellen heter nu *Inbromsning och gas per station*.
- **Förvald sträcka** är Håkantorp → Gårdsjö när linjen har den (`motionRouteChosen`), tills Från/Till, ⇄, Hela linjen eller Station 1 och 2 väljer en annan.

### Från stoppet och rimlighet
- André 2026-11-25 om Lovene: "tror inte vi bromsar så sent? Finns det någon kontroll på rimligheten?"
  - Vid Lovene stannar tågen 132 m efter stationens koordinat söderifrån och 99 m före den norrifrån.
  - Förut stod det därför "Bromsar 350 m före – 100 m efter". Räknat från stoppet är det 500 respektive 550 m, med 0,50 och 0,44 m/s².
- **Inbromsning och gas räknas från stoppet**: medianen för var tågen stannar (`g.stopAt`), avrundat till 50 m. Det gäller texterna i Detaljerad (`brakeText`/`gasText`: "från 500 m före stoppet", "till 650 m efter stoppet") och rutornas längd. Fartprofilen och stapeln räknar som förut från stationens koordinat.
- **Rimlighet** (`brakeCheck`): medelretardationen från farten där inbromsningen börjar till stopp, v²/2s, visas i rutan ("ca 0,44 m/s²").
  - Utanför 0,15–1,0 m/s² står *kontrollera* i stationsraden och i rutan.
  - Inbromsning i steg flaggas inte för låga värden, eftersom tåget rullar mellan stegen.
  - Spåren 2026-11: 0,15–0,55 m/s², de flesta 0,35–0,50. Låga värden finns där tågen bromsar i steg (Mariestad, Lyrestad, Forshem, Lidköping norrifrån).

### Tester
- `node --test "tests/*.test.js"` (157), nytt: *km-tal: linjebokens km-tal vid stationerna och däremellan längs linjen*.
- `node tests/run-browser-tests.mjs`, nya:
  - *analys: Broms och gas – enkla listan med linjebokens km-tal, och Detaljerad*;
  - *analys: Broms och gas – förvalt Håkantorp – Gårdsjö, och inget km-tal utanför*.
- Bilder: `--shot=broms-och-gas-enkel` och `--shot=broms-och-gas-enkel-mobil`. Bilderna `--shot=broms-och-gas…` visar Detaljerad.

## Uppdatering (2026-11-25q): halka – förarens markering och starter som är svagare än vanligt

André 2026-11-25:
- Han frågade om GPS:en kan avläsa automatiskt att det är halt.
- "Gör det du rekommenderar men datan måste stämma. Det är viktigt att vi inte visar fel på något sätt."
- "Att trycka på en knapp när vi bromsar i halka är inte det bästa."

Appversion `2026-11-25q`.

### Varför inte automatiskt
- GPS:en ser hur tåget rör sig, inte vad föraren begär. En svag start eller lång inbromsning går därför inte att skilja från försiktig körning.
- Dataunderlag (`railtimer-data`, 296 starter med Y31):
  - Startaccelerationen 5→40 km/h är i median 0,57 m/s².
  - Samma station och riktning skiljer ±30 % mellan körningarna (P10 0,70 och P90 1,36 av det normala).
  - Facit saknas: det är okänt vilka dagar det var halt.
- Därför är **förarens markering** det enda som visas som halt. Den automatiska jämförelsen visas som avvikelse, uttryckligen *inte bekräftat halt*.

### Appen (index.html)
- **Markering när tåget står still**, aldrig under inbromsningen. Panelen visar vid en station (efter ankomst) *Halt?* med två knappar (`#npHalt`):
  - **Gled in hit** (`station.slideIn`) gäller inbromsningen till stationen.
  - **Slirade ut från X** (`slipOut` på `previousStartIndex`) gäller föregående station där tåget stod still och startade. Passager hoppas över.
  - Tryck igen tar bort markeringen.
- Samma val finns som kryssrutor i stationskortet, för markering i efterhand under resan (`data-action="slide-in"`/`"slip-out"`). Stationsraden visar "halt: gled in, slirade ut".
- Körningen sparar `slideIn: true`/`slipOut: true` per station, bara när de är markerade. `normalizeLogEntry` bevarar fälten. Se `docs/railtimer-data-README.md`.
- Efter att körningen laddats upp kan den inte markeras längre; det görs under resan.

### Analysen (`railtimer-analys.js`)
- `startAcceleration(pts, anchor)`: farten 5 → 40 km/h från stillastående inom 400 m från stationen.
  - Räknas inte om tåget inte når 40 km/h inom 2 min, stannar igen eller om spåret har glapp över 5 s.
- `adhesionEvents(runs, motion)`: förarens markeringar (`kind` `broms`/`start`, `from` → `toward`) och startaccelerationerna. Markeringar räknas även utan GPS-spår.
- `adhesionCompare(events)`: varje start jämförs med andra starter från samma station mot samma håll med samma fordonstyp. Med minst 6 sådana (`ADH_MIN_BASE`) ger den `normal` (median), `ratio` och `weak` (under 60 %, `ADH_WEAK`).
  - Det normala räknas på alla körningar oavsett filtret. Visas gör bara körningarna i urvalet.
  - Spåren 2026-11: 193 av 296 starter kunde jämföras och 8 var svagare än vanligt.

### Broms och gas (Analys.html)
- **Enkel lista**:
  - "halt markerat N gånger" i cellen *Bromsar in* (gled in) eller *Gasar ut* (slirade ut) för rätt station och riktning.
  - Listan **Markerat halt av förarna** med datum, tåg, vad, riktning och var (km-tal för inbromsningen eller gasen).
  - Utan markeringar står hur man markerar.
- **Detaljerad**: **Starter som var svagare än vanligt** med acceleration, normalt (antal), andel och om föraren markerat halt.
  - Texten säger att det inte är bekräftat halt och varför inbromsningar inte jämförs.
  - En rad visar hur många av de markerade starterna som var svagare än vanligt, så att jämförelsen kan prövas mot förarnas markeringar under hösten.
- **CSV**: enkla listan får kolumnerna *Halt markerat vid inbromsning/start* och delen *Markerat halt av förarna*. Detaljerad får även *Starter som var svagare än vanligt*.

### Tester
- `node --test "tests/*.test.js"` (158), nytt: *halka: startens acceleration, förarens markeringar och starter som är svagare än vanligt* (simulerat 0,4 och 0,2 m/s²).
- `node tests/run-browser-tests.mjs` (103), nya:
  - *halt: vid stationen markerar föraren gled in och slirade ut; det sparas i körningen*;
  - *analys: halka – förarens markeringar i listan och starter som var svagare än vanligt*;
  - *analys: halka – utan markeringar säger listan hur man markerar*.
- Bild: `--shot=resa-vid-station` visar Halt?-knapparna.

## Uppdatering (2026-11-25r): resan startar av sig själv, uppläsning, dagens tur och störningar som rör tåget

André 2026-11-25:
- "Gör allt" om förslagen: start och slut av sig själv, uppläst info, nästa tur, mötande tågets position, anslutningar vid alla stopp, utropstext och platsminnen. De tre första finns här; resten kommer i följande versioner.
- Under resan med 13346: infofliken visade ett banarbete som inte påverkade tåget alls.

Appversion `2026-11-25r`.

### Resan startar av sig själv (`autoStartFix`)
- Med start, slut och fordon ifyllda följer appen GPS:en medan startformuläret visas, och i rapporten när nästa tur är ifylld. Skärmen hålls vaken medan appen väntar (`keepAwakeWhileArmed`).
  - Fälten kan vara ifyllda för hand, av tågnumret (2026-11-25o) eller av dagens tur.
- Raden under Start-knappen (`#autoStartStatus`): *Startar av sig själv när tåget rullar från X*, med avgången när tidtabellen är hämtad.
- **Villkor**, alla måste gälla:
  - Rörelsen började högst 600 m från startstationen (`AUTO_START_FROM_M`, egen mittpunkt om den finns).
  - Tåget har rört sig i sträck minst 8 s (`START_DEPART_CONFIRM_MS`, samma som avgången från startstationen).
  - Farten är minst 15 km/h (`AUTO_START_MIN_KMH`), alltså inte gångfart.
  - Tåget har lämnat stationens zon (radie + marginal = 350 m, och minst 150 m längre bort än där rörelsen började).
  - Tåget har kommit närmare slutstationen.
  - Det är högst 10 min före tidtabellens avgång (`AUTO_START_EARLY_MS`) när tidtabellen är känd, så att växling före avgång inte startar resan.
  - Positioner med noggrannhet sämre än 50 m räknas inte.
- **Avgången** från startstationen räknas från första positionen i rörelse, som vid en vanlig start. Positionerna från en halv minut före rörelsen läggs i GPS-spåret, och resans start är spårets början (`applyAutoStart`).
- Körningen får `startedBy: 'auto'`. Det sparas även för återupptagen resa.
- Startar resan inte, till exempel för att stationen inte finns i listan, försöker appen inte igen för samma rutt (`blockedKey`).
- ⋮ → **Starta när tåget rullar** (`railtimer_auto_start_v1`, förvalt på).
- Ingen omladdning för ny version medan tåget just börjat rulla (`canReloadNow`).
- **Slutet** fanns redan: resan avslutas när tåget står still vid slutstationen (`processSpeedTriggers`). Nu läses det upp.

### Uppläsning (`speak`)
- Svensk röst (`sv-SE`) om telefonen har en. Tågnummer läses siffra för siffra (`spellTrain`).
- Det som läses upp:
  - *Resan startad. Tåg 2 3 3 4 9 mot Herrljunga C.*
  - *Framme i X. Resan är sparad. Nästa tur … avgår …*
  - Det viktigaste av infoflikens meddelanden (`notifyInfo`, samma som toasten): möte med väntan, anslutning knapp eller missad, tåg som inte hinner till oss, avvikelse, störning och vändtid. Samma sak läses en gång per nivå.
- ⋮ → **Läs upp info** (`railtimer_speech_v1`, förvalt på). När den slås på säger appen *Uppläsning på*.
- iPhone läser bara upp efter en tryckning på sidan; första tryckningen låser upp rösten (`unlockSpeech`).
- I testläge sparas texten i stället (`spoken()`).

### Dagens tur
- Fältet **Dagens tur** i startformuläret: tågnumren i tur och ordning (`railtimer_tour_v1`, `{ date, trains }`). Turen gäller i dag, och gårdagens till kl. 04.
- **Förslag** (`tourFromHistory`): tågen samma veckodag förra gången, i den ordning de kördes, ur alla körningar (även från GitHub). Knappen *Som förra onsdagen: 23349 → 23334*.
- När appen startar och tågnumret är tomt fylls första tåget i turen som inte körts i dag i (`prefillFromTour`). Rutten och fordonet fylls då i som när föraren skriver tågnumret.
- **Under resan** (`fetchNextTour`, `tourStatus`): nästa tågs tidtabell hämtas. Avgången från vår slutstation gäller, annars tågets första station.
  - Vändtiden räknas från vår ankomst: verklig, annars infoflikens prognos, annars tidtabellen.
  - Infofliken har avsnittet *Nästa tur*, till exempel *3346 · Hällekis → Lidköping, vändtid enligt plan 9 min, 2 min vändtid*.
  - Panelens rad får *vändtid 2 min* när den är kortare än 4 min (`TOUR_TIGHT_MIN`) och *nästa tur … blir sen* under 1 min (`TOUR_LATE_MIN`). Båda meddelas och läses upp.
- **Efter resan** (`prepareNextTour`): nästa tåg fylls i med start och slut från dess tidtabell, och samma fordon.
  - Rapporten visar överst *Nästa tur: 3346 · Hällekis 05:41 → Lidköping – Startar av sig själv när tåget rullar*, med knappen Ändra.
  - Är rutten okänd fylls den i av tågnumret, som när föraren skriver det.

### Störningar som rör tåget (`classifyMessages`)
- Förut visades varje trafikhändelse (OperativeEvent) som hade någon plats på resten av linjen.
- **Nu visas** en händelse när den pågår under resan, inte är ett planerat arbete, och antingen har minst två platser på vår linje (en sträcka vi kör) eller bara en plats som ligger på linjen (till exempel växelfel i Råbäck).
- **Inte visas:**
  - **Planerade arbeten** (banarbete, spårarbete, underhåll; `PLANNED_WORK` på händelsetyp och rubrik). Tidtabellen räknar redan med dem. Påverkar ett arbete vårt tåg syns det i vårt tågs annonseringar som avvikelse eller inställt.
  - **Händelser på en annan bana**: en plats på vår linje och andra utanför, till exempel Herrljunga – Alingsås.
- Infoflikens sista rad säger hur många som inte visas och varför.
- **Körningen sparar** alla händelser som rör platser på linjen, även de som inte visades: `info.events` med `shown`, `reason` och Trafikverkets original (`raw`, högst 4 000 tecken). Så kan filtreringen prövas mot riktiga svar. Se `docs/railtimer-data-README.md`.
- OperativeEvent har fortfarande inget sparat svar från Trafikverket. Tolkningen av platserna (`signaturesIn`) är densamma som förut.

### Tester
- `node --test "tests/*.test.js"` (158): störningstestet har en annan bana, en sträcka vi kör och banarbete på sträckan.
- `node tests/run-browser-tests.mjs` (110), nya:
  - *autostart: resan startar av sig själv när tåget rullar iväg …* (gångfart startar inte, avgång från första rörelsen, spåret, uppläsning, `startedBy`);
  - *autostart: inte när det är avstängt, inte utan fordon och inte långt före tidtabellens avgång*;
  - *tur: dagens tur läses, föreslås från samma veckodag …*;
  - *tur: vändtiden till nästa tur …*;
  - *tur: framme i slutstationen – … nästa tur fylls i och kan starta av sig själv*;
  - *uppläsning: av i menyn läser inget, på igen bekräftas*;
  - *info: banarbeten och händelser på andra banor visas inte, men sparas i körningen med varför*.
- Bilder: `--shot=startformular`, `--shot=nasta-tur` och `--shot=info-tur`.
- Inte provat på telefon: rösten (Safari och Chrome), att GPS:en fortsätter i startformuläret med skärmen vaken, och starten när ett riktigt tåg rullar. Kontrollera vid första resan att raden under Start-knappen syns och att resan startar efter några hundra meter.

## Uppdatering (2026-11-25s): mötande tågets position, anslutningar längs vägen och utrop

André 2026-11-25: fortsättning på "Gör allt" (se 2026-11-25r). Appversion `2026-11-25s`.

### Mötande tågets position (TrainPosition)
- Efter varje hämtning frågas Trafikverket om senaste positionen för de mötande tågen, högst 8 (`queryPositions`, TrainPosition 1.1 i namespace `järnväg.trafikinfo`, som kontrollsidan provade 2026-11-25j).
  - `parsePositions` ger senaste positionen per tågnummer: läge (`Position.WGS84`), tid och fart (`Speed` finns för ungefär hälften).
  - Godtar Trafikverket inte frågan hämtas inga positioner resten av resan (`positionsOff`). Infon fungerar som förut.
- **Läget** i förhållande till mötesplatsen (`positionAt`): avståndet fågelvägen och sidan. Jämförelsen görs från vår GPS-position, eller senaste platsen vi passerat.
  - *beyond*: tåget är fortfarande på andra sidan mötesplatsen.
  - *at*: inom 500 m.
  - *passed*: mellan oss och mötesplatsen.
  - Positioner äldre än 5 min används inte (`positionMaxAgeMs`).
- **Undre gräns för ankomsten**: är tåget på andra sidan kan det inte vara framme förrän tidigast efter avståndet i 200 km/h (`maxSpeedMs`). Är det senare än Trafikverkets tid gäller gränsen, med källan *räknat från tågets position*.
  - Gränsen gör aldrig prognosen för tidig. *passed* ändrar inte prognosen, eftersom fågelvägen kan lura nära stationer; det visas bara.
- **Visas** i mötesraden: *3,9 km från Råbäck · 0 km/h · 30 s sedan*, *vid Råbäck* eller *har passerat Råbäck mot oss*. Positionen sparas med mötet i körningen (`info.meetings[].position`).
- **Lägen för driftplatser**: namnfrågan hämtar även `Geometry.WGS84` (`queryNames`). Läget sparas i `railtimer_sig_coords_v1` (0 = okänt, frågas inte igen).

### Anslutningar längs vägen
- Vid varje station där vi stannar och inte har åkt från (`stops` i `compute`) visas:
  - tåg som går därifrån åt ett annat håll högst 20 min efter vår ankomst (`midConnectionWindowMin`);
  - tåg som kommer dit högst 20 min före vår avgång och ansluter till oss.
- Samma regler som i slutstationen: tåg längs vår linje räknas inte, och bytestiden gäller per station (`transferBySig`, förval 4 min). *`transferBySig` är borttaget 2026-11-25u.*
- Avsnittet *Anslutningar längs vägen* i Info, till exempel *Blomberg → Mariestad, missas, 3 min att byta*.
- De räknas i siffran på fliken, i panelens rad (*N anslutningar missas*) och i meddelandena, som läses upp: *Anslutningen i Blomberg mot Mariestad hinns inte.*

### Utrop (`announcement`)
- Färdig text för högtalaren när vi beräknas vara minst 3 min sena, eller när en anslutning i slutstationen blir knapp eller missas. Avsnittet *Utrop* överst i Info, med **Svenska/English** och **Kopiera**.
- Exempel: *Vi är cirka 6 minuter försenade på grund av möte med ett försenat tåg. Beräknad ankomst till Herrljunga C 11:46. Tåget mot Göteborg C 11:45 hinns tyvärr inte. Tåget mot Borås C 11:55 hinner ni, det går från spår 3.*
- **Orsaken** anges bara när den är känd: väntan på ett försenat mötande tåg i minst 2 min, annars den första störningen som visas (rubriken). Annars utan orsak.
- **Anslutningar**: missade, eller redan avgångna, högst 3; knappa, högst 3; och de som hinns, högst 2, bara när vi är sena.
- Tider avrundade till hel minut, spår när Trafikverket anger det.

### Tester
- `node --test "tests/*.test.js"` (162), nya i `tests/railtimer-info.test.js`:
  - *position: mötande tåg långt bort på andra sidan mötesplatsen …*;
  - *position: mötande tåg som redan passerat mötesplatsen mot oss …*;
  - *anslutningar längs vägen: …*;
  - *utrop: …*.
- `node tests/run-browser-tests.mjs` (111), nytt: *info: mötande tågets position, anslutningar längs vägen och färdigt utrop*.
- Bild: `--shot=info-utrop`.
- Inte provat mot riktiga svar: positionsfrågan med flera tågnummer (OR-filter på `Train.OperationalTrainNumber`), och anslutningar vid mellanstationer med riktiga tåg. Kontrollera vid nästa resa med möte att mötesraden visar avståndet.

## Uppdatering (2026-11-25t): platsminnen och förarnas haltmarkeringar under resan

André 2026-11-25: sista delen av "Gör allt" (se 2026-11-25r och s). Appversion `2026-11-25t`.

### Platsminnen
- **Fältet** *📌 Kom ihåg vid platsen* i det utfällda stationskortet, högst 120 tecken. Det sparas per station (`railtimer_place_notes_v1`, nyckel `sig:<signatur>`, annars `namn:<namn>`, som egna mittpunkter) med tid.
  - Ett tömt fält tar bort minnet (`text: ''`), så att borttagningen också synkas.
- **Visas** i stationsraden för kommande stationer: *📌 ofta rött vid infarten*.
- **Meddelas en gång per resa** när tåget är högst 2 km från stationen (`PLACE_REMIND_M`): vibration, toast i 10 s och uppläsning, till exempel *Blomberg: ofta rött vid infarten.* (`checkPlaceReminders`). Vad som meddelats sparas med resan (`reminded`), så att det inte upprepas efter Återuppta.
- **Synkas** via `platsminnen.json` i `railtimer-data` när körningarna synkas (`syncPlaceNotes` i `syncFromGithub`): nyast per station gäller (`mergePlaceNotes`), och filen skrivs bara när något ändrats. Alla telefoner med samma inloggning får minnena.

### Förarnas haltmarkeringar (från 2026-11-25q)
- Markeringarna **gled in** och **slirade ut** i alla körningar från de senaste 14 dagarna (`HALT_DAYS`), även körningar från GitHub, i samma riktning som resan (`haltSummary`):
  - gled in vid stationen med samma föregående station;
  - slirade ut från stationen mot samma nästa station.
- **Visas** i stationsraden: *❄ halt: gled in 1×, slirade ut 2×*.
- **Meddelas en gång per resa**: glidning när tåget är högst 2 km från stationen, slirning när tåget står vid stationen före avgång. Exempel: *Blomberg: förare har markerat halt vid inbromsningen en gång de senaste två veckorna.*
- Bara förarnas egna markeringar används, inget framräknat (som 2026-11-25q: "datan måste stämma"). Var tågen brukar börja bromsa finns i analysverktygets Broms och gas, inte i resvyn.
- Räknas en gång per resa (`computeHaltSummaries`), så att körningarna inte läses vid varje position.
- **Körningarna från GitHub** sparas nu med `slideIn`/`slipOut` (`compactRun`). Nyckeln är bytt till `app:korningar-v2`, så de hämtas om vid första starten (`syncFromGithub(true)` när inga finns sparade).

### Tester
- `node --test "tests/*.test.js"` (162).
- `node tests/run-browser-tests.mjs` (113), nya:
  - *platsminne: visas i stationsraden, läses upp när tåget är nära och synkas med GitHub*;
  - *halt: förarnas markeringar senaste två veckorna i samma riktning meddelas vid inbromsningen och starten*.
- Inte provat på telefon. Kontrollera vid första resan med ett platsminne att det läses upp ungefär 2 km före stationen.

## Uppdatering (2026-11-25u): Info får hela skärmen, ingen egen bytestid och versionen i menyn

André 2026-11-25:
- "Infofliken blir väldigt liten. Jag vill att man helt ska kunna byta mellan info och stationer."
- "Jag vet inte heller om alternativ att själv välja bytestid är så bra?"
- Han ville kunna se vilken version appen har. Han hittade inte *Uppdatera app*, eftersom knappen bara visas när en ny version finns.

Appversion `2026-11-25u`.

### Flikarna Stationer och Info
- Förut låg flikarna överst i stationslistan. Info fick bara listans yta under panelen och kartan, ungefär en tredjedel av skärmen.
- Nu ligger flikarna (`.view-tabs`) direkt under resans rubrik och står alltid kvar.
  - **Stationer:** panelen, kartan och stationslistan, som förut.
  - **Info:** hela ytan under flikarna (`#infoView`, egen scroll). Panelen, kartan och listan döljs (`#journey.show-info`).
- **Liggande telefon och skärmar ≥ 820 px:** flikarna ligger ovanför högra kolumnen, och Info ersätter bara stationslistan. Panelen och kartan står kvar till vänster.
- Raden i panelen öppnar Info som förut. Kartan ritas om när Stationer väljs igen, eftersom den var dold och saknade storlek.
- Avsluta och Avbryt finns under Stationer.

### Ingen egen bytestid
- Bytestid − / + är borttaget, även per station längs vägen (`transferBySig`, `railtimer_info_v1.transfer`). Ett eget värde kunde glömmas kvar, och det ändrade både vilka tåg som räknades som anslutningar och om de "missades".
- **Fasta regler** (`connectionStatus` i `railtimer-info.js`):
  - **missas** (hinner inte): under 1 min att byta (`missedUnderMin`), alltså när tåget går före eller i samma stund som vi kommer. Bara då säger appen och utropet att tåget inte hinns.
  - **knappt:** 1–3 min att byta (under `transferMin`, 4 min).
  - **ok:** 4 min eller mer.
  - Minuterna att byta visas alltid, så att föraren själv ser hur knappt det är.
- **Vilka tåg som räknas** är oförändrat. Det är tåg som enligt tidtabell går 4–40 min efter vår ankomst åt ett annat håll (vid stationerna längs vägen 4–20 min). Ett knappt byte uppstår alltså bara när något tåg är sent.
- **Utropet** för knappt byte säger minuterna: *Till tåget mot Skövde C 11:48 har ni cirka 2 minuter att byta, det går från spår 3.* Förut stod det *blir knappt*.
- Infoflikens sista rad förklarar reglerna.
- Förut räknades 4–5 min som knappt och under 4 min som missat.

### Versionen i menyn
- Längst ner i ⋮-menyn: *Version 2026-11-25u – Tryck för att söka ny version* (`btnVersion`, `checkVersionByHand`). *Överst sedan 2026-11-25y.*
  - Ett tryck söker direkt och säger *Du har senaste versionen*, *Ny version … – ⋮ → Uppdatera app*, *Ingen täckning …* eller *Kunde inte söka ny version just nu* (`versionCheckResult`).
  - Trycket laddar aldrig om av sig självt.
- Knappen *Uppdatera app* säger vilken version den uppdaterar till (*Uppdatera app till 2026-11-25v*).

### Uppläsning
André 2026-11-25 under resan: "Jag hör inte att något läses upp alls?"
- "Resan startad" lästes bara upp när resan startade av sig själv. Annars läses något upp bara när det händer något (2026-11-25r), så en resa i tid kan vara tyst.
- **Tryck på Start** läser nu upp *Resan startad. Tåg 3 3 4 4 mot Hällekis.* (utan tågnummer: *Resan startad mot Hällekis.*). Det sker direkt i tryckningen, före tidtabellshämtningen, så att iPhone släpper fram rösten resten av resan och föraren hör att uppläsningen fungerar. Förut sades *Resan startad. mot Hällekis.* utan tågnummer.
- **Återuppta** säger *Resan fortsätter.*, också i tryckningen.
- `speak`: `resume()` om Chrome fastnat i pausat läge, och en referens till yttrandet så att Chrome inte kastar det innan det lästs upp.
- **iPhone:** står ljudomkopplaret på ljudlöst hörs ingen uppläsning från webbsidor (Apples forum). `navigator.audioSession.type = 'playback'` skulle kanske ändra det, men det är inte provat och inte inlagt.

### Tester
- `node --test "tests/*.test.js"` (162): anslutningar utan egen bytestid (0 min missas, 1 min knappt, 4 min ok), tåg till oss som hinner knappt eller inte, knappt byte längs vägen när vi är sena, och utropet med minuterna.
- `node tests/run-browser-tests.mjs info` och `uppdatering`:
  - Info fyller ytan under flikarna, med panel, karta och lista dolda.
  - På bred skärm står panel och karta kvar.
  - Kartan har rätt storlek tillbaka i Stationer.
  - Det finns ingen bytestidsinställning.
  - Versionen står längst ner i menyn, och trycket ger rätt meddelande.
  - Tryck på Start läses upp, men en start som inte blir av läses inte upp.
- Bilder: `--shot=info`, `--shot=resa-info` och `--shot=resa-liggande`.

## Uppdatering (2026-11-25v): notiser i bakgrunden

> **Borttaget (2026-11-25z):** notiserna i bakgrunden finns inte längre, se 2026-11-25z. Kvar är `INFO.alerts`/`INFO.newAlerts` och att *Prel. tid* och *Movingo gäller ej.* inte är avvikelser.

André 2026-11-25: han får inte installera appar på jobbmobilen (Android), bara utvalda. Han saknar att kunna stänga appen och ändå få en notis, till exempel vid risk för missad anslutning. Privat har han iPhone. Appversion `2026-11-25v`.

### Hur det fungerar
- En webbsida kan inte räkna när den är stängd: telefonen fryser den, och GPS:en stannar. Bevakningen körs därför på en server: **GitHub Actions i `railtimer-data`**, som appen redan har token till. Inget nytt konto och inga hemligheter att lägga in.
- **Telefonen** prenumererar på webbpush med en egen VAPID-nyckel (ECDSA P-256, skapas med WebCrypto och sparas i `railtimer_push_v1`). Android: Chrome direkt. iPhone: bara från hemskärmen (iOS 16.4+); hemskärmsappen har egen lagring, så inloggningslänken klistras in där.
- **När appen lämnas** under en resa med tågnummer (`visibilitychange` → hidden) skickar appen `repository_dispatch` `bevaka` till `railtimer-data` (`PUSH.dispatchRequest`), via service workern med nya försök (`RT_DISPATCH` i `sw.js`), eftersom sidan kan frysas direkt. Service workern lägger in den prenumeration som gäller just då (`freshSubscription`).
  - Begäran (`PUSH.buildPayload`, högst 10 fält och 60 kB): telefonens id (`device`), resan (tåg, start- och slutsignatur, start, `announce`), prenumerationen och VAPID-nyckeln, appens egna tider (`known`), det appen redan meddelat (`notified`), stationernas namn, egna gångtider för resans sträckor och kända dubbelspår.
- **Bevakningen** (`bevakning/bevaka.js`, workflow `.github/workflows/bevakning.yml` i `railtimer-data`, checkar ut `kinnekulle-gps` från `main`) gör samma hämtningar som infofliken varje minut och samma beräkning (`railtimer-info.js`: `compute`). Det som blivit värre (`INFO.alerts` + `INFO.newAlerts`, samma regler och texter som appens `notifyInfo`) skickas som webbpush (`bevakning/webpush.js`: RFC 8291 aes128gcm och VAPID ES256, utan beroenden).
  - Våra tider: appens fram till att appen lämnades, sedan Trafikverkets rapporter. Vårt läge: Trafikverkets tågposition (TrainPosition), inte telefonens GPS.
  - Första gången under resan en tyst bekräftelse (*Bevakar i bakgrunden: Herrljunga C 11:40 i tid*), om inte en riktig notis kommer direkt.
  - Notisen: rubrik *Tåg 23349 → Herrljunga C*, upp till tre rader (*Anslutning 11:45 Borås C: missas*, *Möte Vara: 24360 är 6 min sent – vi väntar ca 6 min*), och prognosen sist. Klockslag i svensk tid (GitHubs datorer går i UTC).
  - Slutar när Trafikverket rapporterat ankomsten till slutstationen, 3 h efter planerad ankomst, efter 350 min, när prenumerationen är borta (404/410), eller när tåget inte hittas (efter 3 försök, med en notis). Ingen kontakt med Trafikverket i 5 min: en notis, och bevakningen försöker igen.
- **Appen tar över** när den visats i 3 min (`STOP_AFTER_VISIBLE_MS`): `bevaka-stopp`. En kort titt stoppar inget. Resan slut (`stopJourney`) eller **Kasta bort** stoppar också. Workflowets `concurrency` (`bevakning-<device>-resa`, `cancel-in-progress`) gör att en ny begäran från samma telefon avbryter den som körs. Läget i `PUSH.plan` (`railtimer_push_v1.watch`), så att det överlever omladdning och Återuppta.
- **Inget meddelas två gånger:** notisen har nycklarna för det som meddelats. Service workern sparar dem per resa (cachen `railtimer-push`, `./push-state`, rensas inte vid ny version), och appen lägger in dem i `infoState.notified` när den syns igen (`readPushState`, `RT_PUSH`). Syns appen när en notis kommer är notisen tyst.
- **Service workern** (`sw.js`): `push` visar notisen (nivå 2 ligger kvar tills den läses), `notificationclick` öppnar appen. `activate` tar bara bort appens egna gamla kopior.
- ⋮ → **Notiser i bakgrunden**: Slå på (frågar om tillåtelse i tryckningen, prenumererar och beställer en testnotis), Skicka testnotis, Stäng av, senaste notis och senaste begäran till GitHub. Kräver uppladdningen. Infoflikens sista rad säger om notiserna är på.
- **Kostnad:** körningarna räknas mot GitHubs gratisminuter för privata repon (2 000 min/månad), men bara medan appen är stängd under en resa. Körningarna i `railtimer-data` var 1 100–3 000 min/månad, så att bevaka hela resor alltid hade kunnat ta slut på minuterna.

### Avvikelser
- *Prel. tid* och *Movingo gäller ej.* är inga avvikelser för tåget (`NOT_DEVIATION` i `compute`): preliminär tid finns redan som beräknad tid, och biljettinformation rör resenärerna. Båda sågs i riktiga svar 2026-11-25 och gav meddelanden i onödan. De visas inte i Info, räknas inte och meddelas inte.

### Provat
- Krypteringen dekrypteras av referensbiblioteket `http_ece`, och `web-push`s kryptering dekrypteras av vår (lokalt, inte i repot). VAPID-signaturen kontrolleras.
- **På GitHub mot Trafikverkets riktiga API** (prov 2026-11-25, tåg 13355 Lidköping → Herrljunga C, 6 min): linjen och prognosen (*Herrljunga C 18:12 +2 min*, 2 möten), en notis om möte vid start och en om knapp anslutning (*Anslutning 18:16 Stockholm C: knappt (3 min)*). Notiserna gick till en provadress, inte en telefon.
- **Inte provat:** notis till en riktig telefon (FCM/Apple), och att `repository_dispatch` med Andrés token startar körningen (utvecklingsmiljöns token startar inga körningar; Andrés finkorniga token med Contents: write ska enligt GitHub räcka). Provas med *Skicka testnotis*.
- Provgrenarna `actions-prov` (railtimer-data) och `bevakning-test` (kinnekulle-gps) kunde inte tas bort härifrån.

### Tester
- `node --test "tests/*.test.js"` (190): `tests/bevakning.test.js` (bevakningen med simulerat Trafikverket, webbpush, meddelandena), `tests/railtimer-push.test.js` (nyckel, stöd, begäran, nya försök, när bevakningen startar och stoppas) och `tests/sw-push.test.js` (notis, tyst när appen syns, tryck, begäran med nya försök, ny prenumeration, cachen kvar).
- `node tests/run-browser-tests.mjs notiser` (3); alla webbläsartester: 116.
- Bilder: `--shot=notiser` och `--shot=notiser-iphone`.

## Uppdatering (2026-11-25w): bussar från Västtrafik, valet Tåg | Buss | Båda och markerade anslutningar

André 2026-11-25:
- "Hur är det med Västtrafiks bussar? Jag är bara intresserad av Västtrafiks bussar."
- "Man kanske skulle bygga in ett val där användaren får välja tåg eller buss eller båda." Om valet även ska gälla varningar och utrop: "Gör det du rekommenderar men gör det också valbart."
- "Ska man också kunna välja om man har anslutning med ett tåg eller inte? Och om man väljer att man har anslutning med ett tåg och vi är lite sena, då kanske förslag kan komma upp som beskriver ring trafikledningen och kolla om de kan hålla tåget. Kan anslutande tåg tas in på ett spår på samma plattform … Informationen måste vara kort och kompakt."

Appversion `2026-11-25w`.

### Västtrafik (`railtimer-vt.js`)
- **Planera Resa v4** (`https://ext-api.vasttrafik.se/pr/v4`). Fälten kommer från Västtrafiks officiella JavaScript-klient (spegel: github.com/simonbengtsson/vasttrafik-api, `mirror/docs`).
  - Token: OAuth2 client credentials, `POST /token` med Basic nyckel:hemlighet (`tokenRequest`, `parseToken`). Sparas i `railtimer_vt_token_v1` till strax före `expires_in`. Svarar Västtrafik 401 på en fråga hämtas ett nytt token en gång.
  - Hållplatser vid en station: `/locations/by-coordinates?…&radiusInMeters=350&types=stoparea` (`parseStopAreas`), högst 3 närmast stationens koordinat. Sparas per signatur i `railtimer_vt_stops_v1` i 30 dagar, även tomma svar.
  - Tavlorna: `/stop-areas/{gid}/departures` och `/arrivals` med `startDateTime`, `timeSpanInMinutes`, `max…PerLineAndDirection=10`, `limit=50` (`parseBoard`): linje, `transportMode`, riktning (`direction`), ursprung (`origin`), `plannedTime`, `estimatedTime` (realtid), `isCancelled` och läge (`stopPoint.platform`).
  - **Bara bussar** (`busesOnly`: `transportMode === 'bus'`). Västtågen tas från Trafikverket, så att inget tåg kommer med två gånger. Samma tur från två hållplatsområden räknas en gång (`uniqueCalls`).
- **Webbläsaren:** Västtrafiks JavaScript-klient skriver att token inte kan hämtas i webbläsaren. Det är inte provat här, eftersom utvecklingsmiljön inte når ext-api.vasttrafik.se. Därför:
  - Ett misslyckat anrop klassas (`failure`): når samma adress fram med `mode: 'no-cors'` är det Västtrafiks CORS (`kind: 'blocked'`), annars nätfel. Felet säger då att det behövs en egen server.
  - **Egen server** (`docs/vasttrafik-worker.js`, Cloudflare Worker): har nyckeln och hemligheten som hemligheter (`VT_KEY`, `VT_SECRET`), hämtar token och skickar `GET /pr/v4/…` vidare. Bara till `https://akjork.github.io` (CORS), bara GET och bara `/pr/v4/`. Med en server inställd går appens alla frågor dit utan token (`createClient`: `server + /pr/v4`). Anvisningen står överst i filen. Testas i `tests/vasttrafik-worker.test.js`.
- **⋮ → Västtrafik (bussar)** (`#vtSettings`): nyckel, hemlighet och egen server (bara https), sparade i `railtimer_vt_v1` bara på enheten. *Spara och testa* sparar alltid och provar sedan token, hållplatserna vid resans slutstation (annars Herrljunga C) och bussarna därifrån närmaste timmen (`saveAndTestVt`). *Provsidan* öppnar `vasttrafik-koll.html`, men inte under en resa.

### Bussarna i Info (`railtimer-info.js`)
- `busOutgoing`/`busIncoming`: samma fönster och regler som tågen. I slutstationen 4–40 min efter vår ankomst, längs vägen 4–20 min, och till oss i startstationen 4–30 min före avgång (bara före avgång). Statusen är densamma: *missas* under 1 min, *knappt* under 4 min, annars *ok*, samt *inställt*.
  - Bussens tid: Västtrafiks beräknade tid, annars tidtabellen. Västtrafik har ingen faktisk tid, så en buss vars tid passerat för mer än 30 s sedan räknas som avgången (*avgått* om vi inte är framme).
  - **Bussar längs vår linje räknas inte**, som tågen: bussens destination (för bussar till oss ursprunget) jämförs ort mot ort (`townKey`: första ordet, "via" räknas inte) med stationerna på linjen utom stationens egen ort. Stadsbussar inom stationens ort räknas.
- `input.buses` (Map signatur → `{ departures, arrivals }`) och `input.names` (signatur → namn för linjens platser) till `compute`. Anslutningarna har `kind` `tåg` eller `buss`; bussar har `toText`/`fromText`, `ident` = linjen och `track` = läget.
- **Hämtning** (`refreshBuses` i index.html): bara när Buss eller Båda är valt och Västtrafik är inställt, högst varannan minut (`VT_REFRESH_MS`) efter Trafikverket. Tavlor behövs för slutstationen (avgångar), startstationen före avgång (ankomster) och stopp längs vägen som vi når inom en timme (`busTargets`). Går ingenting står de senaste bussarna kvar med felet. Ändras valet under en hämtning görs en ny direkt efteråt.

### Valet Tåg | Buss | Båda
- Överst i anslutningsdelen i Info (`connControlHtml`), sparat i `railtimer_conn_v1` (`{ mode, alerts }`). Förval Tåg. Utan Västtrafik är Buss och Båda gråa, med en länk till inställningarna, och då gäller Tåg även om något annat sparats.
- Listorna visar valda slag (`splitByMode`). Rubrikerna säger valet och hur många som är dolda, till exempel *Anslutningar i Hällekis · bara buss · 2 tåg dolda*, så att ett glömt val syns (lärdomen från bytestiden, 2026-11-25u).
- **Varningar: bara valda | alla** (`connAlerts`, förval bara valda): med *bara valda* följer panelens rad, siffran på fliken, meddelandena, uppläsningen och utropet valet. Med *alla* gäller de alla anslutningar som hämtats, och det står under valet. `compute` ger listorna i `alert` (`{ connections, incoming, stops }`), och `alerts()` och `announcement()` använder dem.
- Utropet säger *Buss 1 mot Skara 11:45 hinns tyvärr inte.* och *… den går från läge A.* Meddelandet säger *Anslutningen till bussen mot Skara 11:45 hinns inte.*

### ☆ Markerade anslutningar och förslaget att ringa trafikledningen
- Varje anslutning i Info har ☆. Ett tryck markerar (★) att resenärer ska byta till den, ett nytt tryck tar bort markeringen. Markeringen sparas per vårt tågnummer (`railtimer_conn_marks_v1`), så den gäller även nästa gång samma tåg körs. Nyckeln (`connKey`): riktning (`ut` från stationen, `in` till oss), station och tågnummer, för bussar linje och klockslag.
- Markerade anslutningar gäller oavsett valet Tåg | Buss | Båda. Blir en markerad anslutning *knapp* eller *missas*, och det räcker att den väntar högst 15 min (`holdMaxMin`) för vanlig bytestid (4 min), blir det ett förslag (`actions`, `actionText`):
  - *☎ Ring trafikledningen: kan 3051 vänta ca 5 min?* och under: *Hällekis → Mariestad 05:32 · vi spår 2, 3051 spår 3 – samma plattform?* (bara *spår vid samma plattform?* när spåren är okända, inget när de är samma, inget för bussar).
  - Till oss: *Ring trafikledningen: kan vi vänta på 3337 ca 2 min?*
  - Inte när den gått eller är inställd.
- Förslaget visas överst i Info (avsnittet *Åtgärd*, högst två), i panelens rad (*☎ ring trafikledningen*) och meddelas först, med uppläsning: *Ring trafikledningen. Kan tåget mot Mariestad vänta cirka 5 minuter?* En gång per anslutning.
- Förklaringen *Tryck ☆ på en anslutning som resenärer ska byta till.* visas bara tills något markerats.
- **Körningen** sparar de markerade (`info.marked`, se `docs/railtimer-data-README.md`), med `suggested` när förslaget kom.

### Inte provat
- Allt mot det riktiga Västtrafik: token från webbläsaren, CORS för frågorna, `limit=50`, att `startDateTime` bakåt i tiden ger bussar som redan gått, och vilka hållplatsområden som ligger inom 350 m från stationerna. Kör provsidan (⋮ → Västtrafik → Provsidan → Kör kontroll → Spara i railtimer-data) och kontrollera.
- Bevakningen i bakgrunden (2026-11-25v) räknar utan bussar och utan markeringarna, eftersom de finns på telefonen. Den använder samma `alerts()`, så tågen meddelas som förut.

### Tester
- `node --test "tests/*.test.js"`, nya: `tests/railtimer-vt.test.js` (token, frågorna, hållplatser, tavlan, klienten med utgånget token, CORS och egen server), `tests/vasttrafik-worker.test.js`, och i `tests/railtimer-info.test.js` *bussar: …* och *markerade anslutningar: …*.
- `node tests/run-browser-tests.mjs`, nya: *buss: utan Västtrafik …*, *buss: Buss visar bussarna …*, *buss: Västtrafik stoppar token …*, *☆ markerad anslutning: …* och *provsidan för Västtrafik: …* (2). Simulerat Västtrafik: `fakeVasttrafik` i `tests/replay.html`.
- Bilder: `--shot=info-buss`, `--shot=vasttrafik-installningar` och `--shot=vasttrafik-data`.

## Uppdatering (2026-11-25x): Mät tidtabell | Bara info

André 2026-11-25: "Man kanske också ska kunna välja om man vill mäta en tidtabell eller bara använda informationsfliken. Lokförare kanske ibland är intresserade av att mäta en tidtabell. Men ombordpersonalen är ju nästan aldrig intresserad av det … och då behöver ju tåget följas på något sätt med mobilens GPS." Appversion `2026-11-25x`.

- **Valet** överst i startformuläret: **Mät tidtabell | Bara info** (`#purposeMeasure`, `#purposeInfo`), sparat i `railtimer_purpose_v1` (`purpose`, `setPurpose`, `renderPurpose`). Förval Mät tidtabell, som förut.
- **Bara info**:
  - Fordonstyp och anteckningar döljs och behövs inte. Tågnumret krävs, eftersom Info bygger på det (*Bara info behöver tågnumret – Info bygger på det.*). Knappen heter *Starta Bara info*. Resan startar av sig själv som vanligt, med tågnummer i stället för fordon (`autoStartArmed`).
  - **GPS:en följer tåget som vanligt**: ankomst och avgång registreras, så att appen vet var tåget är och prognosen i Info räknar med de egna tiderna. Logiken för ankomst och avgång är oförändrad.
  - Info öppnas direkt (`setInfoTab('info')`, även vid Återuppta). Stationer finns kvar som flik.
  - Förarens saker döljs: *Halt?* i panelen och haltkryssrutorna i stationskorten (`#journey.info-only`). Rubriken säger *Tåg 3344 · Lidköping → Hällekis · Bara info*.
  - Notiser i bakgrunden (2026-11-25v) fungerar som vanligt.
  - **Inget sparas som mätning** (`finishInfoOnly`): ingen körning, ingen uppladdning, ingen hämtning av Trafikverkets tider, och GPS-spåret tas bort från telefonen. Rapporten säger bara *Resan klar* (eller *avbruten*) och *Bara info – inget sparades som mätning*, nästa tur fylls i, och knappen heter *Starta ny resa*. Uppläsningen vid slutstationen säger *Framme i X.* utan *Resan är sparad*.
  - Bara tågnummer, tid och stationer sparas (`railtimer_info_trips_v1`, 40 dagar), så att dagens tur vet vilka tåg som körts i dag och kan föreslå turen från samma veckodag (`tourRuns` i `prefillFromTour` och `tourFromHistory`).
- `state.purpose` (`measure`/`info`) sparas med pågående resa (`saveActiveJourney`) och läses vid Återuppta.

### Tester
- `node --test "tests/*.test.js"` (207).
- `node tests/run-browser-tests.mjs` (124), nya: *bara info: valet sparas, fordon och anteckningar behövs inte, Info öppnas och inget sparas som mätning* och *bara info: GPS:en följer tåget hela vägen, Halt? syns inte, och vid slutstationen tas spåret bort*.
- Bild: `--shot=startformular-info`.

## Uppdatering (2026-11-25y): versionen och Uppdatera app överst i en meny som rullas

André 2026-11-25, med en bild av ⋮-menyn: "Detta är allt jag ser". Menyn slutade vid *Installera app*. Versionen (2026-11-25u) och *Uppdatera app* låg under den, nedanför skärmen. Appversion `2026-11-25y`.

- **Menyn rullades inte.** Den fortsatte nedanför skärmen. Under en resa rullar sidan inte (`body.journey-mode`), så där gick det inte att nå de sista valen alls.
- **Nu** är menyn högst skärmens höjd minus rubriken (`max-height: calc(100dvh - 4.5rem)`), och den rullas för sig (`overflow-y: auto`, `overscroll-behavior: contain`).
- **Överst i menyn:** *Uppdatera app till …* (`btnUpdate`, grön och fet, bara när en ny version finns) och *Version … – Tryck för att söka ny version* (`btnVersion`). Därefter Inställningar som förut. *Installera app* ligger kvar längst ner.
- `showUpdatePrompt` visar knappen som block, så att den fyller menyns bredd.

### Tester
- `node --test "tests/*.test.js"` (207).
- `node tests/run-browser-tests.mjs uppdatering`: på en lägre skärm (560 px) ryms menyn på skärmen och rullas, och versionen och *Uppdatera app* är de två första valen och syns utan att rulla.

## Uppdatering (2026-11-25z): notiserna i bakgrunden borttagna

André 2026-11-25: "Då släpper vi notiserna för nu. Det löser sig om jag får installera appen på jobbmobilen i framtiden." Appversion `2026-11-25z`.

### Varför
- GitHubs villkor för Actions: Actions ska inte användas som del av en serverlös tjänst, och på GitHubs egna datorer bara för att bygga, testa, driftsätta eller publicera projektet. Bevakningen från 2026-11-25v var just en serverlös tjänst. Missbruk kan ge stoppade körningar, begränsad Actions, avstängda repon och i vissa fall avstängt konto, och både appen och mätdatan ligger på kontot.
- Dessutom: en körning får vara högst 6 timmar, och tiden räknas medan bevakningen väntar (avrundat uppåt per körning, 2 000 min/månad gratis för privata repon).

### Borttaget
- Appen: ⋮ → Notiser i bakgrunden, prenumerationen, start och stopp av bevakningen när appen lämnas eller syns (`railtimer-push.js`), raden om notiser i Infofliken och testkrokarna.
- Service workern: `push`, `notificationclick`, begäran till GitHub och cachen `railtimer-push`. `activate` tar åter bort alla andra cachar.
- Servern: `bevakning/bevaka.js`, `bevakning/webpush.js` och `.github/workflows/bevakning.yml` i `railtimer-data`. Provgrenarnas workflow (`actions-prov` i railtimer-data) är också borttaget. Grenarna `actions-prov` och `bevakning-test` finns kvar; de kan inte tas bort härifrån och gör ingenting.
- Testerna `tests/bevakning.test.js`, `tests/railtimer-push.test.js`, `tests/sw-push.test.js` och `notiser:` i `tests/replay.html`, och bilderna `--shot=notiser…`.

### Kvar
- `INFO.alerts` och `INFO.newAlerts` (`railtimer-info.js`): reglerna och texterna för appens meddelanden. Testet *meddelanden: …* ligger nu i `tests/railtimer-info.test.js`.
- *Prel. tid* och *Movingo gäller ej.* är inga avvikelser (`NOT_DEVIATION`).
- Koden finns i commit 8dd11a2 om notiserna behövs igen. En installerad app kan ge notiser utan server; i en webbapp krävs en server som får användas så, till exempel Cloudflare Workers.

### Tester
- `node --test "tests/*.test.js"` och `node tests/run-browser-tests.mjs`.

## Uppdatering (2026-11-25za): bussarna utan inställningar – gemensam Västtrafik-nyckel från GitHub

André 2026-11-25:
- "Tänk om jag vill att en kollega ska testa den?"
- "Kör repor privat. Allt på GitHub."
- "Allt som har med den här appen att göra eller detta projektet ska ligga på GitHub. Tanken är att kollegor ska kunna testa och använda appen. Då får det inte vara för krångligt."

Appversion `2026-11-25za` (bokstäverna tog slut vid z; därefter za, zb …).

### Hur det fungerar
- **Hemligheterna** `VT_KEY` (Klientidentifierare) och `VT_SECRET` (Hemlighet) från Västtrafiks utvecklarportal ligger i kinnekulle-gps → Settings → Secrets and variables → Actions. André lade in dem 2026-11-25. De finns bara där, aldrig i koden eller i filerna.
- **Workflowet** `.github/workflows/vasttrafik-token.yml` kör `tools/vasttrafik-token.mjs` var 3:e timme, vid körning för hand (*Run workflow*) och när skriptet eller workflowet ändras.
  - Nytt token hämtas först när det gamla har mindre än 12 h kvar (`RENEW_BELOW_MS`). Ett token gäller 24 h. Det blir ungefär två commits om dygnet av `github-actions[bot]` ("Västtrafik-token (automatiskt)").
  - Unikt scope per token (`device_railtimer<tid>`), så att Västtrafik ger ett nytt och inte det gamla som snart går ut.
  - Skriptet provar också CORS från appens adress och kör appens egna frågor vid Lidköping. Resultatet står i filen (`cors`, `check`) och i körningens sammanfattning.
  - Godtar Västtrafik inte nyckeln blir körningen röd, och ett gammalt token som fortfarande gäller får ligga kvar. Saknas hemligheterna skrivs `error` i filen, bara vid körning för hand eller första gången.
- **`vt-token.json`** (`{ token, expiresAt, fetchedAt, cors, check, error }`) publiceras med GitHub Pages. Den har aldrig nyckel eller hemlighet. Ändra den aldrig för hand.
- **Appen** (`railtimer-vt.js`): utan egna inställningar läser klienten `vt-token.json?t=<tid>` med `cache: 'no-store'` (`sharedTokenUrl`, `sourceOf` = `shared`) och sparar token med `source`.
  - Ordning: egen server, egen nyckel, sedan den gemensamma.
  - Svarar Västtrafik 401 läses filen igen en gång, eftersom GitHub kan ha förnyat token.
  - Fel i ord (`parseShared`): *den gemensamma Västtrafik-nyckeln finns inte än*, *… saknas (VT_KEY och VT_SECRET saknas i GitHub)*, *… har gått ut – GitHub har inte förnyat den*, eller *kunde inte hämta den gemensamma nyckeln*.
- **Service workern** rör inte `vt-token.json`, som `version.json`.

### Provat mot Västtrafik (från GitHub, 2026-11-25)
- Västtrafik svarar på CORS från `https://akjork.github.io`, både för token (`POST, OPTIONS`, `authorization,content-type`) och för Planera Resa v4 (`GET`, `authorization`). Även svaren på frågorna har `Access-Control-Allow-Origin: https://akjork.github.io`.
- Den egna servern (`docs/vasttrafik-worker.js`) behövs alltså inte. Med egen nyckel går det också att hämta token direkt från telefonen.
- Vid Lidköping finns tre hållplatsområden inom 350 m: Lidköpings resecentrum (59 m), Gamla stadens torg (279 m) och Nya stadens torg (316 m). En avgångstavla gav 15 avgångar, 13 bussar, alla med Västtrafiks beräknade tid.
- Inte provat: telefonen mot `vt-token.json` på riktigt. Kontrollera med ⋮ → Västtrafik → Testa, eller med Provsidan.

### I appen
- **Buss och Båda går alltid att välja.** Förvalet är fortfarande Tåg. Texten *Bussar kräver en nyckel från Västtrafik* är borttagen.
- Ett fel med bussarna står i Info med en länk till ⋮ → Västtrafik.
- **⋮ → Västtrafik (bussar):**
  - Överst: *Bussanslutningarna i Info kommer från Västtrafik och fungerar utan inställningar.* Under den en rad om nyckeln (`showVtStatus`): *Gemensam nyckel från GitHub – gäller till i morgon 18:03 och förnyas av sig själv*, *Bussarna hämtas med din egen nyckel*, eller felet.
  - *Egen nyckel (behövs inte)* är ihopfälld och har nyckel, hemlighet och egen server. Den fälls ut när en egen nyckel finns.
  - **Testa** (`saveAndTestVt`): med ifyllda fält sparas de och provas. Med tomma fält tas den egna nyckeln bort och den gemensamma provas. Bara nyckel utan hemlighet sparas inte.
  - **Ta bort egen nyckel** syns bara när en finns.
- **Provsidan** (`vasttrafik-koll.html`) provar den gemensamma först: om filen gäller, till när, när GitHub hämtade den och om frågorna fungerar. Resultatet har aldrig token. *Västtrafik tillåter inte …* föreslår nu att ta bort den egna nyckeln i stället för en egen server (`errorText`).

### Att veta
- Token i `vt-token.json` kan läsas av alla, eftersom repot är publikt och sidan är publicerad. Med den går det att fråga Planera Resa v4 på Andrés applikation i högst 24 h. Nyckeln och hemligheten syns aldrig. Missbrukas den: byt hemlighet i portalen och i GitHub.
- **Gör inte kinnekulle-gps privat.** GitHub Pages för privata repon kräver GitHub Enterprise Cloud; på Andrés konto skulle appen sluta publiceras. Det som publiceras med Pages kan ändå alla läsa. Mätdatan ligger i det privata `railtimer-data`.
- GitHubs villkor för Actions (se 2026-11-25z): workflowet är ett publiceringssteg. Det tar ca 15 s, lägger en fil i repot som publiceras med Pages och svarar inte på några frågor. Det är inte en tjänst som bevakningen var. Actions är gratis för publika repon.
- GitHub stänger av schemalagda körningar i publika repon efter 60 dagar utan aktivitet. Slutar bussarna efter en lång paus: Actions → *Västtrafik-token* → *Enable workflow* → *Run workflow*.
- Andra sessioner: `git pull` före commit som vanligt. `github-actions[bot]` committar `vt-token.json` ungefär två gånger om dygnet.

### Tester
- `node --test "tests/*.test.js"` (187), nya:
  - `tests/vasttrafik-token.test.js`: nytt token, CORS, appens frågor, inget nytt när det gamla gäller, utan hemligheter och fel nyckel.
  - *gemensam token: …* i `tests/railtimer-vt.test.js`.
  - `vt-token.json` förbi service workern i `tests/sw.test.js`.
- `node tests/run-browser-tests.mjs` (122), nya: *buss: utan inställningar används den gemensamma nyckeln …* och *buss: saknas den gemensamma nyckeln …*. Provsidans två tester provar även den gemensamma. Simulerat: `vt-token.json` i `fakeVasttrafik` (`opts.shared`).
- Testet *tidtabell: hela vägen …* godtar versioner med två bokstäver (`[a-z]{0,2}`).
- Bilder: `--shot=vasttrafik-installningar` och `--shot=vasttrafik-data` (utan egen nyckel).
