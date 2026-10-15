# Analys per tåg – design

**Datum:** 2026-10-15 · **Gren:** `feat/analys-per-tag` (från main `8f9e2ae`) · **Bygger på:** `docs/superpowers/specs/2026-10-15-analys-mot-tidtabell-design.md`

## 1. Bakgrund

André provade fliken Mot tidtabell den 15 oktober och svarade:

- Väntan vid en station är ointressant. Den följer tidtabellen.
- Det intressanta är tågen: vilka tåg som står länge, och så vidare.
- Varje tåg har sin egen tidtabell.
- Antalet resenärer spelar roll.
- Två tåg som båda går A–B kan ha olika gångtid mellan stationerna enligt tidtabellen.

Han godkände förslaget med ett "kör". Analysen mäter vad varje sträcka tar med alla tåg som stannar likadant, och jämför sedan varje tågs egen tidtabell med det.

## 2. Vad datan visar

Verifierat den 15 oktober på datarepot: 147 körningar, varav 89 med tidtabell.

- 43 av 75 sträckor har olika planerad gångtid för olika tåg med samma stoppmönster. Tågen tar ändå ungefär lika lång tid:
  - Hällekis → Forshem är planerad till 3, 4 eller 5 min, men tar 3,0–3,2 min.
  - Lugnås → Mariestad är planerad till 10–12 min, men tar ungefär 9,4 min.
  - Källby → Blomberg är planerad till 2 min för tåg 3332 och 3 min för övriga, men tar 3 min för alla.
- Bara tåg 13346 har fått ändrad tidtabell mellan körningarna. Det gäller 8 sträckor.
- 28 gånger tappade ett tåg mer än 1 min vid en station, oftast i Lidköping och Vara.
- Körningarna fördelas på 65 tågnummer. 15 av dem har minst 3 körningar med tidtabell, och inget har fler än 8.
- Ett planerat stopp passerades 202 gånger av 896. Där både stopp och passage har mätts skiljer gångtiden oftast mindre än 0,3 min.
- De 58 körningarna utan tidtabell har fullständiga stationslistor med stopp och passage.
- Körningarna saknar anteckningar och resandeantal.

## 3. Mål

1. **Per tåg** blir huvudvyn och ersätter Mot tidtabell. Varje tåg jämförs med sin egen tidtabell, sträcka för sträcka, mot vad sträckan faktiskt tar. Vyn visar också gångerna tåget tappade tid vid en station.
2. **Sträckor** visar vad varje sträcka tar och vilken planerad tid varje tåg har fått där.
3. **Tidtabell** ger ett förslag per tåg i stället för per riktning.
4. **Väntan per station försvinner.** Stationstabellen, Visa-valen för stationer och bedömningarna Tidig – väntan, Tidig, Sen ankomst, Sen avgång och I tid tas bort.
5. **Resenärer:** antalet finns inte i datan. Därför visas klockslag och veckodag vid varje tillfälle då ett tåg tappade tid.

## 4. Begrepp

### 4.1 Stoppmönster
- **Planerad typ** vid en station är *stopp* om `shouldStop !== false`, annars *passage*.
- **Verklig typ** är `stopType`: *passage* om `shouldStop === false` eller `departSource === 'gps-pass'`, alltså när tåget passerade utan att stanna. Annars är den *stopp*.
- **Mönster** för en sträcka A → B är två bokstäver, en för A och en för B: `S` för stopp och `P` för passage. De fyra mönstren är `SS`, `SP`, `PS` och `PP`.
- Etiketter: SS *Stopp–stopp*, SP *Stopp–passage*, PS *Passage–stopp* och PP *Passage–passage*.

### 4.2 Vad sträckan tar
Underlaget är alla mätta gångtider på sträckan A → B med samma **verkliga** mönster, från alla körningar i urvalet, även körningar utan tidtabell. För varje sådan grupp visas antal mätningar (n), median, P90 och medelvärde.

Ett tåg jämförs med gruppen vars mönster är tågets **planerade** mönster. En tidtabell med stopp måste räcka när tåget stannar. Därför räknas inte körningar som passerade ett planerat stopp.

**Reserv:** har gruppen färre än 3 mätningar används alla mätningar på sträckan, med mönstret `*` och etiketten *Stopp och passage*, om de är fler. Det behövs vid behovsstopp som ett tåg nästan alltid passerar.

Tåg 3344 stannar till exempel aldrig mellan Blomberg och Råbäck, så den gruppen saknar mätningar. Stopp och passage skiljer oftast mindre än 0,3 min, enligt avsnitt 2.

### 4.3 Marginal
**Marginal** = tågets planerade gångtid − vad sträckan tar (median).

| Bedömning | Villkor |
|---|---|
| För få mätningar | sträckan har färre än 3 mätningar (`MIN_SAMPLES`) eller saknar underlag |
| Snål | marginal < −tolerans |
| Generös | marginal > +tolerans |
| Lagom | annars; exakt ±tolerans räknas som lagom |

I Sträckor får en sträcka där olika tåg är både snåla och generösa bedömningen *Snål och generös*.

### 4.4 Tappad tid vid en station
- **Mellanstation** med mätt ankomst: tappad tid = avgångsavvikelse − max(ankomstavvikelse, 0). Planerad ankomst vid en passagepunkt är dess planerade passagetid.
  - Kom tåget tidigt och åkte enligt tidtabellen tappade det ingen tid. Det är väntan enligt tidtabellen.
  - Kom tåget sent och stod längre än planerat tappade det skillnaden.
- **Första mätta stationen** har ingen mätt ankomst. Där är tappad tid = avgångsavvikelsen, med typen *Avgång från start*, eftersom orsaken är okänd.
- **Sista stationen** har ingen avgång och räknas inte.
- Mellanstationer utan mätt ankomst eller avgång räknas inte. Det kan till exempel bero på ett avbrott.
- Typen är *Uppehåll* vid planerat stopp och *Stopp vid passage* vid planerad passage. Det senare betyder att tåget stod där det skulle passera.
- **Ett tillfälle** är tappad tid > tolerans.

### 4.5 Klockslag
Planerade och föreslagna tider är minuter efter midnatt den dag körningen startade. De räknas från lokala klockslag och kalenderdagar, så att bytet mellan sommar- och vintertid inte flyttar tiderna.

## 5. Beräkningar i `railtimer-analys.js`

Nya och ändrade exporter:

| Funktion | Ger |
|---|---|
| `plannedType(stop)` | `'stopp'` eller `'passage'` enligt `shouldStop` |
| `PATTERN_LABELS` | etiketterna för SS, SP, PS och PP |
| `clockMinutes(v, base)` | minuter efter midnatt den dag `base` (körningens start) har, enligt 4.5 |
| `segmentObservations` | befintliga fält plus `plannedPattern`, `actualPattern` och `order` (planerad avgång från A som klockslag, annars `null`) |
| `segmentNeeds(obs)` | en rad per sträcka och verkligt mönster, plus en rad med mönstret `*` för alla mätningar: `{ key: 'A → B\|SS', segment, from, to, pattern, n, median, p90, mean }`. Uppslag med reserven i 4.2. |
| `stationTimes(runs)` | en rad per körning och station enligt 4.4: `{ runId, train, date, weekday, start, station, type, plannedClock, arrivalDev, departureDev, lost, dwell, plannedDwell }` |
| `summarizeTrains(runs, needs, opts)` | `{ rows, withoutTimetable: { trains, runs } }`, se 5.1 |
| `segmentPlans(obs, needs, opts)` | Sträckor, se 5.2 |
| `proposeTrainTimetable(runs, needs, train, opts)` | Tidtabell, se 5.3 |

### Tas bort
Funktionerna försvinner tillsammans med sina tester: `stationObservations`, `stationLabel`, `summarizeSegments`, `summarizeStations`, `proposeTimetable` och `mode`.

### Står kvar
`directedRuns` och `sliceRuns` används för Station 1/2. Även `stats`, `classify`, `formatMinutes` och `csvDocument` står kvar.

### 5.1 `summarizeTrains(runs, needs, opts)`
`opts` = `{ tolerance, stationType }`.

**Urval av tåg och körningar**
- Bara tåg med tågnummer och minst en körning med tidtabell listas.
- Övriga tågnummer räknas i `withoutTimetable`.
- Allt per tåg räknas på tågets körningar med tidtabell.

**Fält per tåg**
- `runCount` och `timetableRuns`.
- `period`.
- `route`: tågets stationer ordnade efter planerat klockslag (median). Partiella körningar slås alltså ihop. `routeLabel` är första → sista stationen.
- `startDelay`: statistik över avgångsavvikelsen vid varje körnings första station.
- `endDelay`: statistik över ankomstavvikelsen vid varje körnings sista station.

**`segments`** – en rad per sträcka och planerat mönster, ordnad efter `order` (median):
- `planned` är planerad gångtid i tågets senaste körning på sträckan.
- `plannedPrev` är tidigare, andra värden, i stigande ordning.
- `n` och `actual` är tågets egna mätningar.
- `need` är raden i `needs` för sträckan och det planerade mönstret.
- `margin` och `assessment` följer 4.3.

**`margin`**
- `sum`, `planned` och `need` summeras över sträckor som har en marginal.
- `count` är antalet sådana sträckor och `of` är antalet sträckor totalt.

**`dwells`** – planerade stopp på mellanstationer, ordnade efter klockslag:
- `plannedDwell` är värdet från den senaste körningen, och `plannedPrev` innehåller tidigare värden.
- `dwell` är statistik över verkligt uppehåll när tåget stannade.
- `lost` är statistik över tappad tid.
- `events` är antalet tillfällen.

**`events`** – tillfällen enligt 4.4:
- `stationType` `'stopp'` ger *Uppehåll* och *Avgång från start*, och `'passage'` ger *Stopp vid passage*.
- Ordningen är störst tappad tid först, sedan nyast först.
- `eventCount` är antalet tillfällen och `lostMax` det största värdet.

**Ordning:** flest körningar med tidtabell först, sedan flest tillfällen, sedan tågnummer.

### 5.2 `segmentPlans(obs, needs, opts)`
`opts` = `{ tolerance, stationType, train }`.

- En rad per sträcka och planerat mönster bland mätningar med planerad tid.
- `need` hämtas enligt 4.2.
- `plans` har en post per planerad gångtid, i stigande ordning, med `{ planned, trains, n, actual, margin, assessment }`.
- `spread` är största minus minsta planerade tid.
- Radens bedömning:
  - `'fa'` utan tillräckligt underlag,
  - `'blandad'` om både snål och generös finns,
  - annars `'snal'`, `'generos'` eller `'lagom'`.
- `stationType` `'stopp'` ger bara SS, och `'passage'` ger mönster med P.
- `train` ger bara sträckor som det tåget kör, med alla tågs planerade tider.

**Ordning**
1. Rader med tillräckligt underlag.
2. Störst `spread`.
3. Störst absoluta marginal.
4. Flest mätningar.
5. Namn.

### 5.3 `proposeTrainTimetable(runs, needs, train, opts)`
`opts` = `{ basis: 'median' | 'p90' | 'mean' }`.

- **Underlag:** tågets körningar med tidtabell. Saknas sådana blir svaret `{ error: 'inga-korningar' }`.
- **Rutt:** samma ordning som `route` i 5.1.
- **Nuvarande tider:** för varje station tas planerad ankomst och avgång från den senaste körning som har värdet. Passagepunkter får sin passagetid i båda.
- **Gångtid:** `need[basis]` för sträckan och det planerade mönstret. Under 3 mätningar markeras raden *få mätningar*. Saknas underlag läggs sträckan i `missing`, och tiderna efter den räknas inte.
- **Uppehåll vid planerat stopp:** räknas på tågets egna körningar.
  - Uppehållet räknas från planerad ankomst när tåget kom tidigt och stod kvar efter den. Annars räknas det från verklig ankomst, som förut.
  - Utan mätningar används nuvarande planerat uppehåll, med `dwellSource` `'planerat'`.
  - Utan båda läggs stationen i `missing`.
- **Klockslag:**
  - Förslaget startar på nuvarande avgång från första stationen.
  - Exakta tider läggs ihop, och varje klockslag avrundas till hela minuter, så att felen inte växer.
- **Svar:** `{ train, basis, route, rows, missing, runCount, period, totalCurrent, totalProposed, totalExact }`.
  - Varje rad har station, typ (`start`, `stopp`, `passage` eller `slut`), nuvarande och föreslagna klockslag, `plannedLeg`, `need`, `legValue`, `legRounded`, `legDiff`, `plannedDwell`, `dwellValue`, `dwellN` och `dwellSource`.
- **Möten och anslutningar** ingår inte i förslaget. Det sägs i vyn.

## 6. Vyer i `Analys.html`

**Flikarnas ordning:** Per tåg (förvald), Sträckor, Tidtabell, Diagram, Tabell, Avvikare och Detaljer. Mot tidtabell tas bort.

### 6.1 Per tåg
Sammanfattningen visar:
- antal körningar med tidtabell av antalet i urvalet,
- antal tåg, period och tolerans,
- sträckan, om Station 1 och 2 är valda,
- tågnummer utan tidtabell, med antal körningar, som inte visas.

**Tabell över tåg**

| Kolumn | Innehåll |
|---|---|
| Tåg | tågnummer |
| Sträcka | första → sista stationen |
| Körningar | körningar med tidtabell |
| Avgång start | median avvikelse vid avgång från första stationen |
| Ankomst slut | median avvikelse vid ankomst till sista stationen |
| Marginal | summerad marginal, med "x av y sträckor" när underlag saknas |
| Tappat tid | antal tillfällen |
| Mest tappat | största tappade tid |

**Tågkortet** öppnas med klick på en rad. Har tågnummerfiltret bara ett tåg öppnas kortet direkt.
- **Rubrik:** "Tåg N · första → sista · k körningar med tidtabell · period".
- **Knappar:** *Tidtabellsförslag för tåget*, som byter till fliken Tidtabell med tåget valt.
- **Gångtid mot vad sträckan tar:**
  - Kolumnerna är Sträcka, Stopp, Planerad (med "tidigare x" vid ändring), Tåget kör, Sträckan tar, P90, Underlag, Marginal och Bedömning.
  - Raden Summa visar planerad tid, sträckans tid och marginal.
- **Uppehåll:** Station, Planerat, Verkligt (median), Tappad tid (median), Gånger tappat och Mätningar.
- **Gånger tåget tappade tid:** Datum, Dag, Avgång (planerad HH:MM), Station, Typ, Tappat, Ankomst, Avgång, Uppehåll och Planerat.
- **Förklaring:** marginal, tappad tid, att resandeantal saknas och att klockslag och veckodag visas för att mönster ska synas.

### 6.2 Sträckor
- **Visa:**
  - Alla sträckor,
  - Sträckor där tågen har olika planerad tid,
  - Sträckor där något tåg har för lite tid,
  - Sträckor där något tåg har för mycket tid.
- **Tabell:** Sträcka, Stopp, Sträckan tar, P90, Underlag, Planerad tid per tåg och Bedömning.
  - *Planerad tid per tåg* har en rad per planerad tid: "6 min (+2,0): 3344".
- **Klick på en rad** visar mätningarna i gruppen, nyast först.
  - Kolumnerna är Datum, Tåg, Planerad, Verklig, Stannade och Räknas i Sträckan tar.
  - Stannade är "som planerat" eller det verkliga mönstret, till exempel *Stopp–passage*.
  - Räknas i Sträckan tar är "ja" eller "nej".

### 6.3 Tidtabell
- **Val:** Tåg (lista med tågnummer, sträcka och antal körningar) och Tidsbas (Median, P90 eller Medelvärde).
- **Förvalt tåg:** tåget som valdes senast, annars tågnummerfiltret, annars första tåget i Per tåg.
- **Tabell:** Station, Typ, Ankomst nu, Avgång nu, Ankomst förslag, Avgång förslag, Gångtid nu, Gångtid förslag, Skillnad, Uppehåll nu, Uppehåll förslag och Underlag.
  - Passagepunkter visar sin tid i ankomstkolumnen och ↓ i avgångskolumnen.
- **Sist:** restid nu och i förslaget, saknade mätningar, och att förslaget inte tar hänsyn till möten och anslutningar.
- **Tas bort:** starttiden och kryssrutorna för stopp. Tågets egen tidtabell avgör stoppen och klockslagen.

### 6.4 Filter

| Filter | Verkan i Per tåg, Sträckor och Tidtabell |
|---|---|
| Fordon, datum, tid på dygnet, dag | begränsar alla körningar, även underlaget för vad sträckan tar |
| Tågnummer | begränsar vilka tåg som visas och vilka sträckor Sträckor visar. Vad sträckan tar räknas fortfarande på alla tåg i urvalet. |
| Station 1 och 2 (olika) | körningarna skärs av till sträckan mellan dem i den riktningen, som i Mot tidtabell |
| En station | påverkar inte de nya vyerna, som förut |
| Tolerans | bedömning av marginal, och gräns för tillfällen då tid tappats |
| Stationstyp | tillfällen i tågkortet och mönster i Sträckor, enligt 5.1 och 5.2 |
| Slå ihop riktningar | påverkar inte de nya vyerna |

### 6.5 Export och utskrift

**Exportera till Excel** ger en CSV i samma format som tidigare.
- **Per tåg:**
  - Exporten innehåller listan och, när ett tågkort är öppet, kortets tre tabeller.
  - Filen heter `per-tag_ÅÅÅÅ-MM-DD.csv`, eller `tag-<nr>_ÅÅÅÅ-MM-DD.csv` när ett tåg är öppet.
- **Sträckor:**
  - Exporten har en rad per sträcka och planerad tid, och följer valet i Visa.
  - Filen heter `strackor_ÅÅÅÅ-MM-DD.csv`.
- **Tidtabell:**
  - Exporten innehåller förslaget med restid.
  - Filen heter `tidtabell_<nr>_ÅÅÅÅ-MM-DD.csv`.
  - Klockslag skrivs som HH:MM och skillnader som tal, så att Excel aldrig läser "+11".

**Skriv ut / PDF** skriver ut den aktiva fliken med utskriftshuvud: rubrik, Bygger på, Period, Urval, Tolerans eller Tidsbas, Tåg och Skapad. Huvudet fylls också vid `beforeprint`, alltså med Ctrl+P.

### 6.6 Testkrokar (`window.__analys`, bara `?test=1`)
- **Står kvar:** `setFetchForTest`, `loadFromGithub`, `getLogs`, `setFilters`, `showTab` och `getLastDownload`.
- **Nya:** `showTrain(nr)`, `exportTrainsCsv`, `prepareTrainsPrint`, `exportSegmentsCsv`, `prepareSegmentsPrint`, `setTimetableTrain(nr)`, `exportTimetableCsv` och `prepareTimetablePrint`.
- **Tas bort:** `exportAgainstCsv` och `prepareAgainstPrint`.

## 7. Tester

- **Modul** (`tests/railtimer-analys.test.js`):
  - Nya fält i `segmentObservations`.
  - `segmentNeeds` med passerat planerat stopp.
  - `stationTimes`: tidig ankomst med sen avgång, sen ankomst med långt uppehåll, start, passage och avbrott.
  - `summarizeTrains`: två tåg med olika planerad tid på samma sträcka, ändrad tidtabell, tolerans, stationstyp, tåg utan tidtabell och ordning.
  - `segmentPlans`: blandad bedömning, filter och för få mätningar.
  - `proposeTrainTimetable`: gemensamt underlag, eget uppehåll utan väntan, avrundning, partiella körningar, planerat uppehåll som reserv och sträcka utan mätningar.
  - `clockMinutes` vid bytet till vintertid.
- **Webbläsare** (`tests/replay.html`) med testdatan `trainRuns()`:
  - Två tåg på Lidköping → Filsbäck → Källby → Blomberg med olika planerad tid Filsbäck → Källby.
  - Ett tillfälle då tåget tappade tid i Källby.
  - Ett tåg utan tidtabell.
  - Testerna täcker listan, tågkortet, Sträckor med Visa, Tidtabell för valt tåg, export, utskrift med Ctrl+P, tågnummerfiltret med gemensamt underlag, Station 1/2 och tomt urval.
- **Bilder:** `--shot=per-tag`, `--shot=stracker`, `--shot=tidtabell` och `--shot=per-tag-utskrift` ersätter bilderna av Mot tidtabell.

## 8. Utanför den här omgången
- Hämtning av tidtabeller i efterhand för de 58 körningarna utan tidtabell. Det gäller också operativa tågnummer som 13344, där annonserat nummer saknas.
- Stopp mellan stationer, till exempel vid signal, ur GPS-spåren.
- Resandeantal.
- Möten och anslutningar i tidtabellsförslaget.
- De gamla flikarna Diagram, Tabell, Avvikare och Detaljer, inklusive deras datum i UTC.
