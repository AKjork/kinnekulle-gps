# Uppladdning av mätningar, GPS-spår och hantering av avbrott

Datum: 2026-10-15 · Status: för granskning · Delprojekt 1 av 3

## 1. Bakgrund och mål

RailTimer mäter gång- och uppehållstider med GPS. Målet för hela arbetet är **korrekta gångtider mot tidtabellen**, både för egen uppföljning och som underlag till tidtabellsplanerare.

I dag finns mätningarna bara i telefonens webbläsarlagring. För att analysera dem på datorn måste de exporteras och importeras för hand. Försvinner telefonens data försvinner mätningarna.

Två fel i appen ger dessutom felaktiga eller saknade mätningar vid telefonsamtal (verifierat med simulerad resa 2026-10-15):

- **Felaktiga tider sparas utan varning.** Om tåget avgår under ett samtal registreras avgången när appen kommer tillbaka. I testet blev avgången 2 min 20 s för sen, uppehållet 3:04 i stället för 0:44 och gångtiden till nästa station 42 s.
- **Appen fastnar.** Passerar tåget två eller fler stationer under ett samtal väntar appen på den första av dem för evigt. Resten av resan mäts inte. Orsaken är att bara stationerna närmast före och efter kontrolleras (`candidateIndices`).

Det här delprojektet ska:

1. ladda upp varje resa automatiskt till ett privat GitHub-repo,
2. spela in och ladda upp GPS-spåret för varje resa,
3. aldrig spara felaktiga tider efter ett avbrott, och låta appen komma ikapp,
4. låta analysverktyget hämta mätningarna direkt från repot.

## 2. Beslut

| Beslut | Motivering |
|---|---|
| En användare | Bara André mäter. Ingen inloggning eller behörighetsmodell för flera. |
| Privat GitHub-repo som lagring | Valt av André. Versionshistorik och inga nya tjänster. |
| GPS-spåret spelas in och laddas upp | Rådata bevaras. Gör det möjligt att i efterhand upptäcka stopp mellan stationer och räkna om tider med förbättrad logik. |
| Avbrottshantering ingår här | Den avgör vilka data som laddas upp. Felaktiga tider får inte hamna i repot. |
| Ordning: uppladdning → analys mot tidtabell → automatik i appen | Uppladdningen är minst, skyddar data direkt och gör senare analys smidigare. |

## 3. Avgränsning

**Ingår**

- Uppladdning av körningar, spår och befintliga mätningar (engångsimport).
- Inspelning av GPS-spår.
- Upptäckt av avbrott, ogiltigförklaring av tider inom avbrott och ikappkörning efter avbrott.
- Inställningsvy för uppladdning i appen.
- Hämtning från repot i `Analys.html`.
- Gemensam modul för GitHub-kommunikationen.

**Ingår inte** (YAGNI)

- Ändra eller ta bort körningar i repot från appen.
- Flera användare.
- Analys av spåren (delprojekt 2).
- Ändrad logik för ankomst och avgång vid normal körning. Logiken ändras bara direkt efter ett avbrott.
- Mätning i bakgrunden. Det kräver en vanlig app (App Store/Google Play) och är utanför detta arbete.

## 4. Översikt

```
Telefonen (RailTimer)                         GitHub (privat)                Datorn
┌─────────────────────────────┐                ┌────────────────────┐        ┌──────────────┐
│ GPS → logik ankomst/avgång   │                │ AKjork/            │        │ Analys.html  │
│     → spår (IndexedDB)       │  en fil i      │ railtimer-data     │ läser  │ cache per    │
│ resa klar → logg (localStor.)├─ taget, PUT ──▶│  korningar/…       ├───────▶│ fil (sha)    │
│ uppladdningskö               │                │  gps-spar/…        │        └──────────────┘
└─────────────────────────────┘                │  import/…          │
                                               └────────────────────┘
```

Båda sidor använder modulen `railtimer-github.js` för all kommunikation med GitHub.

## 5. Datarepot

**Repo:** `AKjork/railtimer-data`, privat, standardgren `main`, skapas med en `README.md` som beskriver formaten i avsnitt 6.

**Struktur**

```
korningar/2026/2026-10-15_23301_mgr3k2x1.json   en körning (format 2)
gps-spar/2026/2026-10-15_23301_mgr3k2x1.json    GPS-spåret för körningen
import/2026-10-15T1048_befintliga-1.json        befintliga körningar, del 1 (max 200 st)
.railtimer/anslutning.json                       senaste anslutningstest (enhet, tid)
```

**Namnregler**

- Datum: lokalt datum för `startedAt` (`YYYY-MM-DD`). Mappen är årtalet.
- Tågnummer: `trainNumber` med allt utom `0-9A-Za-z` borttaget. Tomt blir `utan-tag`.
- Id: körningens `id` där allt utom `0-9A-Za-z-` ersätts med `-`, högst 40 tecken.
- Importfiler: tidsstämpel för importen (`YYYY-MM-DDTHHMM`) plus löpnummer, så att en ny import aldrig krockar med en gammal.

**Commit-meddelanden**

- `Körning 2026-10-15 tåg 23301 Lidköping → Herrljunga`
- `GPS-spår 2026-10-15 tåg 23301 (3 412 punkter)`
- `Import av befintliga körningar, del 1 av 3 (200 körningar)`

## 6. Dataformat

### 6.1 Körning, format 2

Samma objekt som appen sparar i `kmon_gps_logs_v1` i dag, med dessa tillägg. Körningar utan `format` räknas som format 1 och läses som förut.

| Fält | Typ | Betydelse |
|---|---|---|
| `format` | `2` | Formatversion. |
| `appVersion` | text | `APP_VERSION` när körningen sparades. |
| `trackPath` | text, valfritt | Sökväg till spårfilen i repot. |
| `interruptions` | lista | `{from, to, distanceM}` – avbrott under resan (ISO-tider, meter som tåget rörde sig). |
| `stops[].sig` | text | Stationens signatur, t.ex. `Lkp`. |
| `stops[].lat`, `lon`, `radius` | tal | Den position och radie som användes för stationen. |
| `stops[].arrivalWindow` | `{from, to}`, valfritt | Ankomsten skedde under ett avbrott. `actualArrival` är då `null` och `arrivalSource` är `avbrott`. |
| `stops[].departureWindow` | `{from, to}`, valfritt | Samma för avgång. `departSource` är `avbrott`. |
| `stops[].missedReason` | `'avbrott'`, valfritt | Stationen passerades helt under ett avbrott. Båda tiderna är `null`. |

`normalizeLogEntry` i appen ska bevara alla dessa fält. I dag plockar den ut en fast uppsättning fält och skulle annars tappa dem.

### 6.2 GPS-spår, format 1

```json
{
  "format": 1,
  "runId": "mgr3k2x1",
  "trainNumber": "23301",
  "t0": "2026-10-15T04:53:12.000Z",
  "fields": ["t_ms", "lat", "lon", "acc_m", "speed_ms", "heading_deg", "fixAge_ms"],
  "points": [[0, 58.711253, 13.825541, 6, 0, null, 312]]
}
```

- `t_ms`: appens klocka i millisekunder sedan `t0`. Samma klocka som ankomst- och avgångstiderna.
- `fixAge_ms`: appens klocka minus positionens egen tidsstämpel (`pos.timestamp`).
- Avrundning: lat/lon 6 decimaler, `acc_m` och `heading_deg` heltal, `speed_ms` 2 decimaler. Saknade värden är `null`.
- Varje position som tas emot under en pågående resa läggs till. Ungefär 45 byte per punkt, 100–150 kB för en timmes resa.

### 6.3 Importfil

En JSON-lista med körningar i det format de har på telefonen, högst 200 per fil.

## 7. Appen

### 7.1 Resans id

Resan får sitt id när den startar (`state.journeyId`, samma form som i dag: `Date.now().toString(36)`). `saveLog` använder det i stället för att skapa ett nytt. Id:t sparas med den pågående resan så att det överlever "Återuppta resa".

### 7.2 Inspelning av spåret

- Varje anrop till `handlePosition` under en pågående resa lägger till en punkt i spåret innan logiken körs.
- Spåret sparas i IndexedDB (databas `railtimer`, lager `tracks`, nyckel `runId`) var 30:e sekund, när appen går till bakgrunden och när resan avslutas.
- "Återuppta resa" läser in spåret och fortsätter fylla på det.
- Går IndexedDB inte att använda hålls spåret bara i minnet och laddas upp när resan är klar. Laddas sidan om innan dess går det spåret förlorat.

### 7.3 Avbrott

**Upptäckt.** Vid varje ny position under en pågående resa gäller: om det gått mer än **20 s** sedan förra positionen (appens klocka) **och** tåget har flyttat sig minst **150 m** mellan de två positionerna, så har ett avbrott skett från förra positionens tid (`from`) till nu (`to`). Avbrottet sparas i `interruptions`. Ett långt stillastående vid en station är alltså inget avbrott.

Tiden och positionen för den senaste GPS-positionen sparas med den pågående resan (`saveActiveJourney`). Då upptäcks avbrottet även om webbläsaren har laddat om sidan under samtalet och resan fortsätter via "Återuppta resa".

**Ikappkörning.** Innan den vanliga logiken körs för positionen efter ett avbrott:

1. Är tåget inom radien för en station `j` som ännu inte nåtts (`j ≥ nextIndex`) blir `j` nästa station. Stationerna mellan föregående och `j` markeras som passerade.
2. Annars bestäms vilken delsträcka (rak linje mellan två stationer, från `lastReachedIndex` och framåt) tåget ligger närmast. Tåget anses vara mellan station `k` och `k+1`. Stationerna `nextIndex … k` markeras som passerade, och `lastReachedIndex`/`nextIndex` flyttas fram.
3. Passerade stationer får `missedReason: 'avbrott'` och fönster för båda tiderna.
4. Stod tåget vid en station när avbrottet började och har nu lämnat den, får stationen `departureWindow` och `departSource: 'avbrott'`.
5. Indexen flyttas aldrig bakåt.

Därefter körs den vanliga logiken med positionen.

**Inga felaktiga tider.** När en körning sparas blir varje ankomst- eller avgångstid `T` som ligger i ett avbrott, `from < T ≤ to + 2 s`, ersatt med `null` plus fönster och källan `avbrott`. Det fångar tider som registrerades av den första positionen efter avbrottet. Under resan visas sådana tider i stationskorten med märket "avbrott" i stället för en klocktid. Stationer som passerades under ett avbrott visas som "missad – avbrott".

En tid som först registreras av positionen efter avbrottet, och sedan skrivs över av en senare observation, behålls. Ett exempel är ankomsten som justeras till det ögonblick tåget stannar. Den nya tiden ligger då efter `to + 2 s`.

**Meddelanden.**

- Vid avbrott: *"Avbrott i mätningen (3 min) – tider under avbrottet sparas som saknade"*.
- Första gången under en resa visas också tipset *"Under samtal: gå tillbaka till RailTimer så fortsätter mätningen"*.
- Det felaktiga meddelandet *"… GPS fortsätter"* i `handleVisibilityChange` tas bort.

**Oförändrat.** Utan avbrott körs exakt samma logik som i dag. Det visas med ett regressionstest (avsnitt 12).

### 7.4 Uppladdningskö

**Lagring på telefonen**

- `railtimer_github_v1`: `{repo, token, branch}`.
- `railtimer_upload_v1`: `{repo, uploadedIds, uploadedTrackCount, backlogDone, lastError, lastSuccessAt, retryNotBefore}`. Byts repot börjar kön om från början, och allt laddas upp till det nya repot.
- Spåren ligger i IndexedDB tills de är uppladdade.

**Utlösare.** Kön körs när en resa avslutas eller avbryts, när appen startar, vid händelsen `online`, när appen blir synlig igen och när man trycker "Ladda upp nu". Bara en körning av kön åt gången. Kön körs aldrig medan en resa pågår, så att mätningen inte störs. Den körs direkt när resan är avslutad.

**Ordning i en körning av kön**

1. Om `backlogDone` är falskt: alla körningar på telefonen som inte är uppladdade skickas som importfiler med högst 200 per fil. Sedan sätts `backlogDone`.
2. Varje körning som inte är uppladdad skickas som en egen fil. Även avbrutna resor laddas upp; de har flaggan `aborted`.
3. Varje spår vars körning är uppladdad skickas. När det har lyckats tas spåret bort från telefonen.

**Regler**

- Filerna skickas en i taget (GitHubs krav), med minst 1 s mellan skrivningar. GitHub tillåter högst 80 skrivningar per minut och 500 per timme.
- Finns filen redan (svar 422) hämtas den. Finns den markeras körningen som uppladdad, utan dubblett.
- Körningarna ligger kvar på telefonen som i dag. "Töm loggar" påverkar inte repot.
- Efter avslutad resa visas *"Resan uppladdad"* eller *"Väntar på uppladdning"*.

### 7.5 Inställningsvy (⋮ → Uppladdning)

- Fältet Repo, förifyllt med `AKjork/railtimer-data`, och fältet Token (dolt).
- Knappen "Spara och testa":
  1. hämtar repot och varnar om det är publikt,
  2. skriver `.railtimer/anslutning.json` för att bekräfta skrivrätt,
  3. visar resultatet i klartext.
- Länken "Skapa token" öppnar GitHubs förifyllda formulär:
  `https://github.com/settings/personal-access-tokens/new?name=RailTimer&description=Uppladdning+till+railtimer-data&target_name=AKjork&expires_in=none&contents=write`.
  Repot väljs i formuläret under "Only select repositories".
- En statusrad, till exempel *"Uppladdat: 37 körningar, 12 spår · 1 väntar"*, plus senaste fel och när.
- Knapparna "Ladda upp nu" och "Ta bort token".
- Vyn visas med `showView('settings')`, som Statistik.

### 7.6 Service worker och filer

- `railtimer-github.js` läggs till i `ASSETS` i `sw.js`.
- `APP_VERSION` höjs.
- `Kinnekulle GPS.html` hålls identisk med `index.html`.

## 8. Analysverktyget

- En ny datakälla, "Hämta från GitHub". Repo och token anges en gång och sparas i `railtimer_github_v1` på datorn.
- Hämtningen:
  1. listar repot med ett anrop (`git/trees/main?recursive=1`),
  2. hämtar bara filer under `korningar/` och `import/` vars `sha` inte redan finns i cachen (IndexedDB `railtimer-analys`, lager `blobs`), med högst 6 anrop samtidigt,
  3. slår ihop: importfiler först, sedan enskilda körningar, som ersätter importens version vid samma `id`.
- Status visas, till exempel *"142 körningar från GitHub (3 nya)"*.
- Tider som är `null` hoppas redan över av analysen. Därför ingår körningar med avbrott utan att de felaktiga delarna räknas.
- "Ladda från RailTimer" och filimport finns kvar.
- Spåren hämtas inte i detta delprojekt.

## 9. Modulen `railtimer-github.js`

Fristående, utan beroenden. Fungerar som global i webbläsaren och som modul i Node, så att den kan testas.

| Del | Ansvar |
|---|---|
| `createClient({repo, token, branch, fetch})` | `getRepo`, `getFile`, `putFile` (skapa eller uppdatera), `listTree`, `getBlob`. Översätter svar till fel av typen `auth`, `forbidden`, `notfound`, `ratelimit` (med väntetid), `conflict`, `network` eller `unknown`. |
| Sökvägar | `runPath(log)`, `trackPath(log)`, `importPath(tid, del)` enligt namnreglerna i avsnitt 5. |
| Kodning | Base64 för UTF-8 (å, ä, ö) i båda riktningar. |
| Kö | `planUpload(...)` tar fram vad som ska skickas och i vilken ordning. `runUploadPass(...)` skickar, med injicerad väntefunktion och lagring så att den kan testas. |
| Sammanslagning | `mergeRuns(importlistor, körningar)` för analysverktyget. |

**Modulen `railtimer-avbrott.js`.** Avbrottslogiken är rena funktioner, så att den kan testas i Node:

- `detectInterruption`: upptäcker avbrott.
- `planCatchUp`: räknar ut ikappkörningen.
- `applyInterruptionWindows`: ersätter tider inom avbrott med fönster.
- `isWithinInterruption`, `markStationMissed` och `markDepartureUnknown`: hjälpfunktioner.

`index.html` kopplar in funktionerna, eftersom resans tillstånd finns där.

## 10. Säkerhet

- Token sparas bara i webbläsaren på Andrés egna enheter, aldrig i koden eller repot. Fältet är dolt och token skrivs aldrig ut i meddelanden.
- Token ska vara begränsad till `railtimer-data` med rättigheten Contents: read and write. Går en enhet förlorad tas token bort hos GitHub.
- Analyssidan är publik men visar inga data utan token.
- Appen varnar om repot är publikt.

## 11. Felhantering

| Situation | Beteende |
|---|---|
| Ingen täckning | Kön stannar tyst. Status: "väntar (ingen täckning)". Nytt försök vid nästa utlösare. |
| 401 | "Token ogiltig – kontrollera i Uppladdning". Kön ligger kvar. |
| 403 utan rate-limit-huvuden | "Token saknar skrivrätt till repot". Kön ligger kvar. |
| 404 | "Repot hittades inte, eller token saknar åtkomst". |
| 403/429 med `retry-after` eller `x-ratelimit-remaining: 0` | Kön stannar. `retryNotBefore` sätts enligt GitHub, och kön körs inte förrän dess. |
| 409 | Ett nytt försök. Lyckas det inte: felmeddelande, och kön ligger kvar. |
| 422 vid skapande | Filen hämtas. Finns den markeras körningen som uppladdad, annars visas felet. |
| IndexedDB saknas | Spåret hålls i minnet (avsnitt 7.2). |
| Avbrott under resa | Avsnitt 7.3. |

## 12. Test

**Modulen (Node, `node --test`, utan beroenden, med simulerat `fetch`)**

1. 450 körningar på telefonen och `backlogDone` falskt ger tre importfiler (200, 200, 50). Därefter blir `backlogDone` sant.
2. En ny körning får rätt sökväg och commit-meddelande. Svar 201 gör att den markeras som uppladdad.
3. 422 följt av att filen finns ger "uppladdad". 422 följt av 404 ger fel.
4. 401 ger felet `auth`, och kön är orörd.
5. 403 med `retry-after: 60` stoppar kön och sätter `retryNotBefore`.
6. Nätverksfel stoppar kön tyst.
7. Spåret skickas efter sin körning och tas bort lokalt efter lyckad uppladdning.
8. Base64 med å, ä och ö överlever fram och tillbaka.
9. `mergeRuns`: den enskilda körningen ersätter importens version, och dubbletter tas bort.
10. Sökvägar: tecken rensas, tomt tågnummer blir `utan-tag` och id kortas till 40 tecken.
11. Analysens hämtning: bara filer med nya `sha` hämtas.

**Avbrott (simulerad GPS i webbläsaren, samma metod som 2026-10-15)**

1. Samtal när tåget står i Källby. Ankomsten behålls, avgången blir `null` med fönster, och gångtiden Källby→Blomberg räknas inte. Blomberg mäts normalt.
2. Samtal medan två stationer passeras. Källby och Blomberg får `missedReason: 'avbrott'`, appen kommer ikapp, och Råbäck och Hällekis får tider.
3. Inga GPS-positioner på 60 s medan tåget står still ger inget avbrott, och avgången efteråt mäts normalt.
4. Ett glapp på 30 s mellan stationer, utan passerad station, ger ett registrerat avbrott men inga tider tas bort.
5. Sidan laddas om under ett samtal och resan fortsätter via "Återuppta resa". Avbrottet upptäcks ändå, och samma resultat som i fall 1 och 2 fås.
6. **Regression:** samma simulerade resa utan avbrott ger exakt samma tider i den gamla och den nya versionen.

**Gränssnitt:** inställningsvyn kontrolleras i telefonstorlek (390 × 844).

**Så körs testerna**

- `node --test "tests/*.test.js"`: modulerna, utan beroenden.
- `node tests/run-browser-tests.mjs`: de uppspelade resorna, i Chrome utan fönster via Node 22+.
- Regressionsfacit för en vanlig resa sparas i `tests/golden-normal-run.json`. Det tas fram med dagens logik innan något ändras.
- `node tests/run-browser-tests.mjs --shot=installningar|avbrott|rapport`: sparar bilder i telefonstorlek.

**Fler fall som testas**

- En token som klistras in med mellanslag eller radbrytning.
- Ett samtal precis vid ankomsten till slutstationen.
- En avbruten resa, som laddas upp med flaggan `aborted`.
- En resa utan några GPS-positioner, som inte får något spår.
- Byte till ett annat repo, där allt laddas upp igen.

**Efter publicering:** André anger token på telefonen. Därefter kontrolleras i repot, med enbart läsning, att importfilerna och den första körningen har kommit fram.

## 13. Engångsuppsättning

1. Repot `AKjork/railtimer-data` skapas som privat, med `README.md` (formaten i avsnitt 6). Det görs av Claude med Andrés OK, eller av André.
2. André skapar token via länken i avsnitt 7.5 och väljer repot.
3. André anger repo och token i appen (telefonen) och i analysverktyget (datorn).
4. Första uppladdningen skickar alla befintliga mätningar som importfiler.

## 14. Publicering

Bygge och test sker på grenen `feat/uppladdning` i arbetsträdet `kinnekulle-gps-ux-wt`. Resultatet visas för André innan det publiceras. Publiceringen är en push till `main`, och den görs bara med Andrés uttryckliga OK.

## 15. Noterat för senare delprojekt

**Delprojekt 2: Analys mot tidtabell**

- Jämförelse per sträcka och riktning: tidtabellens tid mot uppmätt median, snabbaste ostörda körning och P90, med osäkerheten ±1 min från avrundningen.
- Hur förseningen utvecklas längs linjen.
- Tidtabellsförslag per riktning (i dag slås riktningarna ihop, `Analys.html:1285`), med stopp och passage åtskilda och den nuvarande tidtabellen bredvid.
- Jämförelserna görs främst mellan stationer där tidtabellen har tydliga uppehåll, eftersom tidtabellen bara har hela minuter.
- Störda sträckor upptäcks från spåret.

**Delprojekt 3: Automatik i appen**

- Tåget hittas via Trafikverkets `TrainPosition`, som är verifierad för Kinnekullebanan 2026-10-15.
- Slutstation enligt Andrés flöde: *"Ska du köra till Herrljunga?"* Ja ger slutstation. Nej ger ett val bland tågets återstående stationer. I första hand föreslås den slutstation som användes förra gången med samma tåg.
- Fordonstyp kommer ihåg per tågnummer.
- Passagepunkter (`Advertised=false`, bara avgång) markeras som passage och inte som planerat stopp.
- Sökning på både operativt och annonserat tågnummer.
