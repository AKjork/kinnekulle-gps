# Analys mot tidtabell – design

Delprojekt 2 av 3: analys av mätningarna mot tidtabellen i `Analys.html`. Delprojekt 1 (uppladdning, GPS-spår, avbrott) är publicerat. Delprojekt 3 (automatik i appen) kommer senare.

## 1. Bakgrund och mål

André mäter verkliga gång- och uppehållstider med RailTimer. Mätningarna ligger nu i det privata repot `AKjork/railtimer-data` och hämtas till analysverktyget.

André, 2026-10-15: *"Skulle det gå att göra så man kan exportera en tidtabell när man valt det? Och på den ska det framgå hur många mätningar tabellen är baserad på? Jag skulle också vilja kunna välja något filter eller liknande när det är avvikelser. Tex kommer fram för sent eller för tidig. Är man för tidig måste man stå och vänta osv. Filter för allt som kan förbättra tidtabellerna."*

**Mål:** underlag som visar var tidtabellen är för snål, så att tåget kommer sent, och var den är för generös, så att tåget kommer tidigt och får stå och vänta. Underlaget ska gå att exportera till Excel och PDF, för eget bruk och för planerare. Varje tabell visar hur många mätningar den bygger på.

**Läget i datan (2026-10-15, 162 körningar):**
- 15 körningar är avbrutna, och alla är i format 1.
- 101 körningar har tidtabellstider, alla i hela minuter.
- Ankomster mot tidtabell (974 st): 88 för tidiga, 649 i tid och 237 för sena (±1 min).
- Avgångar (982 st): 9 för tidiga, 703 i tid och 270 för sena.
- 60 gånger kom tåget mer än 1 min för tidigt. Uppehållet blev då i median 1,3 min längre än planerat.
- Fordonstyp saknas i 125 körningar.
- Tre stationer har två namn: "Herrljunga"/"Herrljunga C", "Hallsberg personbangård"/"Hallsberg" och "Framnäs city"/"Framnäs City".

## 2. Beslut

| Fråga | Beslut |
|---|---|
| Exportformat | Både Excel (CSV) och PDF (utskrift via webbläsaren) |
| Vad avvikelser mäts på | Båda: gångtid per sträcka mot planerad gångtid, och klockslag vid station mot tidtabellens klockslag |
| Nya filter | Tid på dygnet, vardag eller helg, valbar tolerans, stopp eller passage, plus avvikelsetyp |
| Upplägg | Beräkningar i en egen testad modul, `railtimer-analys.js`. Flikarna i `Analys.html` byggs ut |
| Övriga val | André, 2026-10-15: *"kör. Du behöver inte fråga mer. Bygg det du anser är bra och behövs så utvärderar jag allt när det är klart sen"*. Övriga beslut i den här specen är Claudes och redovisas för André när arbetet är klart |

## 3. Avgränsning

Följande ingår inte:
- Hämtning av tidtabeller i efterhand för körningar som saknar tidtabellstider.
- Väder och röda dagar. Röda dagar räknas som vardag.
- Ändrad mätlogik i appen. `index.html` ändras inte i det här delprojektet.
- Versionsstämplade modul-URL:er, som är ett uppskjutet fynd från delprojekt 1.
- Gångtider som räknas om med hänsyn till stopp eller passage vid ändstationerna. Se §7.

## 4. Vilka mätningar som räknas

- **Avbrutna körningar** räknas inte.
- **Tider som saknas** räknas inte. Avbrottstider är redan `null` i format 2 och räknas därför inte. Manuellt registrerade tider räknas.
- **Stationsnamn** slås ihop när körningarna läses in, oavsett om de kommer från GitHub, lokal lagring eller fil:
  - Stor och liten bokstav spelar ingen roll.
  - Kända namnbyten har verifierats mot Trafikverkets TrainStation-API 2026-10-15:
    - `Herrljunga` → `Herrljunga C` (signatur Hrc).
    - `Hallsberg personbangård` → `Hallsberg` (signatur Hpbg, som Trafikverket i dag annonserar som "Hallsberg").
    - `Framnäs City` → `Framnäs city` (signatur Fc).
  - Andra namn som bara skiljer sig i stor och liten bokstav får den vanligaste stavningen i datan.
- **Riktningarna hålls isär.** Lidköping → Mariestad och Mariestad → Lidköping räknas alltid för sig i Tidtabell och Mot tidtabell. Kryssrutan "Slå ihop riktningar" gäller bara de övriga flikarna.
- **Stopp eller passage** avgörs per station och körning. Passage är när `shouldStop === false` eller när `departSource === 'gps-pass'`, det vill säga när appen registrerade en genomfart. Allt annat räknas som stopp.
- **Tidtabellen** är de planerade tider (`scheduledArrival`/`scheduledDeparture`) som appen hämtade från Trafikverket när resan startade. Passagepunkter har bara planerad avgång, och den används då som planerad passagetid.
- **Körningens starttid** är den verkliga avgången från första stationen, och annars `startedAt`. Tid på dygnet och vardag eller helg avgörs av starttiden i lokal tid:
  - morgon 05:00–08:59,
  - dag 09:00–14:59,
  - eftermiddag 15:00–17:59,
  - kväll 18:00–04:59.
  - Lördag och söndag är helg.
- **Datumfiltret** använder lokalt datum för starttiden. I dag används UTC-datum, vilket rättas.
- **Tolerans:** ±0,5, ±1 eller ±2 min, med ±1 min förvalt. En avvikelse vars belopp är högst toleransen räknas som i tid. Avvikelser räknas på exakta sekunder och avrundas inte först.

## 5. Begrepp och beräkningar

### 5.1 Sträckobservation (gångtid)
För varje par av intilliggande stationer A, B i en körning, där A har verklig avgång och B verklig ankomst:
- **verklig gångtid** = ankomst B − avgång A, i minuter. Samma rimlighetskontroll som i dag gäller: 0,1–180 min. `excludeInboundRun` respekteras.
- **planerad gångtid** = planerad ankomst B (annars planerad avgång B) − planerad avgång A (annars planerad ankomst A). Den finns bara om båda tiderna finns.
- **avvikelse** = verklig − planerad.
- **kategori** enligt toleransen:
  - `sen`: för lite tid i tidtabellen, avvikelsen > +tol,
  - `itid`,
  - `tidig`: för mycket tid, avvikelsen < −tol.

### 5.2 Stationsobservation (klockslag)
För varje station i en körning med verklig ankomst eller avgång:
- **riktning:** nästa station i körningen ("mot X"). Vid slutstationen används föregående station ("från X").
- **typ:** stopp eller passage, enligt §4.
- **ankomstavvikelse** = verklig − planerad ankomst. Avgångsavvikelsen beräknas på samma sätt. Båda får kategori enligt toleransen.
- **uppehåll** = verklig avgång − verklig ankomst, bara vid stopp. Det planerade uppehållet räknas på samma sätt ur tidtabellen.
- **väntan:** när ankomsten var tidig (< −tol) och både planerat och verkligt uppehåll finns, är väntan = max(0, uppehåll − planerat uppehåll). Det är tiden tåget stod längre än planerat för att det kom för tidigt.

### 5.3 Sammanställning per sträcka (A → B)
Följande räknas fram per sträcka:
- Antal körningar (n), och hur många av dem som har tidtabellstider.
- Planerad gångtid: det vanligaste värdet, och intervallet om det varierar mellan tåg.
- Verklig gångtid: median, P90 och medel.
- Avvikelsens median.
- Antal med för lite tid, i tid och för mycket tid.
- **Bedömning:** *För få mätningar* om färre än 3 mätningar har tidtabellstider. Annars *Snål* om mediansavvikelsen > +tol, *Generös* om < −tol och i övrigt *Lagom*.
- **Förslag:** verklig median avrundad till hela minuter, och ändringen jämfört med nuvarande planerade gångtid.

### 5.4 Sammanställning per station (station + riktning)
Följande räknas fram per station och riktning:
- Typ: den vanligaste.
- Antal (n).
- Ankomster: för sena, i tid och för tidiga, samt avvikelsens median.
- Väntan: antal gånger och median i minuter.
- Uppehåll: planerat (det vanligaste) och verkligt (median).
- Avgångar: för sena, i tid och för tidiga.

**Bedömning**, i den här ordningen:
1. *För få mätningar* om färre än 3 mätningar har tidtabellstider.
2. *Tidig – väntan* om ankomstens mediansavvikelse < −tol.
3. *Sen ankomst* om den är > +tol.
4. *Sen avgång* om avgångens mediansavvikelse > +tol.
5. I övrigt *I tid*.

## 6. Fliken Mot tidtabell (ersätter Jämför)

- **Urvalsrad:** *"Bygger på N körningar med tidtabell av M i urvalet · period ÅÅÅÅ-MM-DD – ÅÅÅÅ-MM-DD · tolerans ±1 min"*.
- **Väljaren Visa:**
  - Alla.
  - Sträckor där tidtabellen är snål.
  - Sträckor där tidtabellen är generös.
  - Stationer med väntan, det vill säga stationer där minst en ankomst var tidig med väntan.
  - Stationer med sen ankomst.
  - Stationer med sen avgång.
- **Två tabeller:** *Sträckor* och *Stationer* enligt §5.3–5.4. Sträckor sorteras efter hur mycket gångtiden avviker. Om Station 1 och 2 är valda i filtret visas bara sträckor och stationer på rutten mellan dem, i den valda riktningen.
- **Klick på en rad** visar de enskilda mätningarna under tabellen: datum, tåg, planerat, verkligt, avvikelse och kategori, nyast först.
- **Knappar:** *Exportera till Excel* (§8) och *Skriv ut / PDF* (§8).

## 7. Fliken Tidtabell (förslag)

- **Riktning** är Station 1 → Station 2. Bara körningar som passerar båda stationerna i den ordningen används.
- **Rutten** hämtas från den körning i urvalet som har flest stationer mellan dem.
- **Gångtid per sträcka och uppehåll per station** räknas bara på körningar i den riktningen. Tidsbasen är median (förvald), P90 eller medel.
- **Kryssrutan Stopp** är förvald efter vad som var vanligast i mätningarna. Passage ger inget uppehåll. Gångtiderna räknas inte om vid passage, och en notering säger det.
- **Tider:**
  - Exakta minuter läggs ihop längs rutten. Varje klockslag avrundas sedan till hela minuter, så att avrundningsfelen inte växer.
  - Med starttid visas klockslag (TT:MM), annars minuter från start (+12).
  - Exakt gångtid och exakt uppehåll visas med en decimal.
- **Jämförelse med nuvarande tidtabell:** för varje sträcka visas den vanligaste planerade gångtiden i körningarna i urvalet och skillnaden mot förslaget.
- **Underlag:**
  - Rubriken visar *"Förslag Lidköping → Mariestad · bygger på N körningar · period … · tidsbas Median"*.
  - Varje rad visar n för gångtid och uppehåll, och *få mätningar* om n < 3.
  - Total restid visas.
- **Knappar:** *Exportera till Excel* och *Skriv ut / PDF*.

## 8. Export

**Excel (CSV)** har samma format som appens befintliga export:
- BOM först, så att Excel läser å, ä och ö rätt.
- Semikolon mellan fälten och varje fält inom citattecken.
- Radbrytningen `\n`.
- Decimalkomma.

Filen börjar med ett informationsblock, följt av en tom rad och tabellen:
```
"RailTimer – Tidtabellsförslag" (eller "– Avvikelser mot tidtabell")
"Sträcka";"Lidköping → Mariestad"
"Bygger på";"24 körningar"
"Period";"2025-10-29 – 2026-10-15"
"Urval";"Tåg: alla · Fordon: alla · Tid på dygnet: alla · Dag: alla · Stationstyp: alla"
"Tidsbas";"Median"            (bara förslag)
"Tolerans";"±1 min"
"Skapad";"2026-10-15 18:30"
```
Filnamn: `tidtabell_<från>-<till>_<ÅÅÅÅ-MM-DD>.csv` och `avvikelser_<ÅÅÅÅ-MM-DD>.csv`.

**PDF:**
- Knappen fyller ett utskriftshuvud med samma informationsblock och anropar `window.print()`.
- En `@media print`-stilmall visar bara utskriftshuvudet och innehållet i den aktiva fliken, med svart text på vit bakgrund och kompakta tabeller.
- PDF skapas med webbläsarens "Spara som PDF".

## 9. Filter

Nya val läggs till i filterpanelen:
- **Tid på dygnet:** alla, morgon, dag, eftermiddag eller kväll.
- **Dag:** alla, vardag eller helg.
- **Tolerans:** ±0,5, ±1 eller ±2 min.
- **Stationstyp:** alla, stopp eller passage.

Så här gäller filtren:
- Tid på dygnet, dag, tåg, fordon och datum filtrerar körningar i alla flikar.
- Stationstyp filtrerar stationsobservationerna i Mot tidtabell och uppehållen i läget Uppehållstider.
- Toleransen används i Mot tidtabell och Tidtabell.

## 10. Modulen `railtimer-analys.js`

Modulen innehåller rena funktioner utan beroenden, med samma mönster som `railtimer-avbrott.js`. Den är global `RailTimerAnalys` i webbläsaren och `module.exports` i Node.

| Funktion | Ansvar |
|---|---|
| `canonicalStation(name)` | Kända alias och stavning |
| `normalizeRuns(runs)` | Nya körningsobjekt med kanoniska namn. Ändrar inte indata |
| `runStart(run)`, `localDate(d)`, `timeOfDay(d)`, `dayType(d)` | Tidsindelning i lokal tid |
| `runMatches(run, filter)` | Filter på körningsnivå |
| `stopType(stop)` | `stopp` eller `passage` |
| `classify(dev, tol)` | `sen` / `itid` / `tidig` |
| `segmentObservations(runs, opts)` | Enligt §5.1 |
| `stationObservations(runs, opts)` | Enligt §5.2, med filter på stationstyp |
| `summarizeSegments(obs, opts)` | Enligt §5.3 |
| `summarizeStations(obs, opts)` | Enligt §5.4 |
| `proposeTimetable(runs, opts)` | Enligt §7 |
| `stats(values)` | n, median, P90, medel |
| `csvDocument(title, meta, header, rows)` | CSV enligt §8 |
| `formatMinutes(v)` | Minuter med decimalkomma |

## 11. Kantfall

- **Inga körningar med tidtabell i urvalet:** Mot tidtabell visar *"Inga körningar med tidtabellstider i urvalet."*. Tidtabell fungerar ändå, eftersom den bygger på verkliga tider.
- **Station 1 och 2 saknas eller är samma station:** Tidtabell visar samma hjälptext som i dag.
- **Ingen körning går i den valda riktningen:** *"Inga körningar går från X till Y i urvalet."*
- **En sträcka utan mätningar i förslaget:** gångtiden visas som "–" och tiden efter läggs inte ihop. Noteringen *"saknar mätningar"* visas, som i dag.
- **Midnatt och sommartid:** alla skillnader räknas på millisekunder (ISO-tider) och påverkas inte.
- **Mycket få mätningar:** bedömningen *För få mätningar* och markeringen *få mätningar* (n < 3).

## 12. Test

**Node** (`node --test "tests/*.test.js"`): modulens funktioner med handgjorda körningar. Testerna täcker:
- alias och stavning, utan att indata ändras,
- tidsindelningen vid gränserna (04:59/05:00, 08:59/09:00, söndag/måndag),
- tolerans vid gränsen (exakt ±tol är i tid),
- passagepunkt med bara planerad avgång,
- väntan vid tidig ankomst,
- sammanställningarnas bedömningar,
- förslag per riktning, så att motsatt riktning inte blandas in,
- avrundning utan att felen växer,
- CSV med BOM, citattecken och decimalkomma.

**Webbläsare** (`node tests/run-browser-tests.mjs`): `Analys.html?test=1` med simulerat GitHub. Testerna täcker:
- Mot tidtabell visar sträckor och stationer, och Visa-väljaren filtrerar.
- Klick visar enskilda mätningar.
- CSV-exporten innehåller "Bygger på" och raderna.
- Tidtabell räknar per riktning och visar n.
- Nya filter påverkar urvalet.
- Utskriftshuvudet fylls.

Alla befintliga tester ska fortsätta gå igenom. Regressionsfacit för appen påverkas inte, eftersom `index.html` inte ändras.

## 13. Publicering

- Grenen `feat/analys-tidtabell` utgår från `bf83e1b`.
- André utvärderar först och pushar själv till `main`.
- `index.html` och `sw.js` ändras inte. `Analys.html` laddar `railtimer-analys.js` med en vanlig skripttagg.
