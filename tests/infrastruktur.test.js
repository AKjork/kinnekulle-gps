'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

/* tools/infrastruktur.mjs: linjeboken som text (pdftotext -layout), byggd som de riktiga sidorna.
   Sidhuvudet har en pil ur ett symboltypsnitt (U+F0E0) mellan linjens ändar, och "Uv"/"Uvc" på varannan sida. */
const ARROW = '';
const page = (id, a, b) => `TRAFIKVERKET         UNDERLAG TILL LINJEBOK                     ${id}\n                                                         ${a} ${ARROW} ${b}\n`;
const TEXT = [
  'TRAFIKVERKET         UNDERLAG TILL LINJEBOK                     A3',
  '  Gårdsjö (Gdö) i innehållsförteckningen räknas inte',
  page('D813', 'Gdö', 'Håp'),
  '                 GÅRDSJÖ          HÅKANTORP',
  '                                      Lutningsförhållande: max 15 ‰',
  'Gårdsjö',
  'System H. ATC. (Fjtkl H)',
  '  251+040     Enl hsi    Infsi (Gdö 21 och Gdö 51)',
  '                            Gårdsjö (Gdö) *',
  '(Gårdsjö) – (Håkantorp)',
  'Enkelspår. System M. ATC till km 1+205 och från km 119+280',
  '  8+730                 Hova (Hova) *',
  '  9+240                 Driftplatsgräns',
  ' 16+557                 Vsi, 20309, Torved',
  ' 16+845                 Torved (Tvd), hp',
  page('D814', 'Gdö', 'Håp'),
  'Håkantorp',
  'System H. ATC. (Fjtkl G).',
  ' 120+425                Infsi (Håp 51)',
  ' 121+021                    Håkantorp (Håp) *',
  // Nästa beskrivning: linjebokens rubrik säger Enkelspår, men signalerna är upp- och nedspår
  page('D13', 'Sk', 'G'),
  '                 SKÖVDE          GÖTEBORG',
  '        Lutningsförhållande: max 10 ‰',
  ' (Falköpings central) – (Herrljunga central)',
  ' Enkelspår. System H. ATC. (Fjtkl G).',
  '  346+835                Mblsi (F N3, F U3)',
  '  357+500                   Floby (Fby)',
  page('D14', 'Sk', 'G'),
  '  377+536                    Herrljunga central (Hrc) *, dpd',
  'Herrljunga central',
  'System H. ATC. (Fjtkl G)',
  '  381+166                   Herrljunga västra (Hrv) *, dpd',
  '  381+500                   Vara (Vaa)',
  // Avdelning E: platser i löptext hör inte till någon linje
  'TRAFIKVERKET         UNDERLAG TILL LINJEBOK                     E3',
  '  Floby (Fby) och Vara (Vaa) i en instruktion'
].join('\n');
const SIGS = new Set(['Gdö', 'Hova', 'Tvd', 'Håp', 'Fby', 'Hrc', 'Hrv', 'Vaa', 'F']);

test('linjeboken: platserna i ordning med spårtypen emellan', async () => {
  const { parseLinjebok } = await import('../tools/infrastruktur.mjs');
  const r = parseLinjebok(TEXT, SIGS, 'prov');
  assert.deepEqual(r.lines.map(L => [L.page, L.sigs.join(' '), L.gaps.join(' ')]), [
    // Gårdsjö ligger i driftplatsen före rubriken; Torved efter Driftplatsgräns; Håkantorps driftplats på slutet
    ['D813', 'Gdö Hova Tvd Håp', 'E E E'],
    // Sidhuvudet byts från Gdö/Håp till Sk/G: ny linje. Herrljunga C står före driftplatsens rubrik, så sträckan
    // därifrån får linjens spårtyp, som sträckan in till en driftplats. Båda inom driftplatsen: - (okänt).
    ['D13', 'Fby Hrc Hrv Vaa', 'E E -']
  ]);
  assert.deepEqual(r.headings.map(h => [h.page, h.kind, h.nu]), [['D813', 'E', false], ['D13', 'E', true]],
    'rubriken D13 har upp- och nedspårssignaler – tools/infrastruktur.mjs jämför den med banstandarden');
});
