#!/usr/bin/env bash
# Hämtar Trafikverkets publika underlag om infrastrukturen och skriver dem i körningens logg.
# Körs av .github/workflows/infrastruktur-prov.yml, eftersom utvecklingsmiljön inte når bransch.trafikverket.se.
# Svarar inte på några frågor och publicerar inget; filerna läses ur loggen och tolkas i utvecklingsmiljön.
#
# Varje fil skrivs som:  FIL-START|namn|byte|sha256  , rader  FIL|namn|<base64>  och  FIL-SLUT|namn
# PDF:er skrivs som text (pdftotext -layout), gzip och base64. Excel-filer som de är, gzip och base64.
# Sist körs tools/infrastruktur.mjs mot filerna: rapporten (jämförelsen med banstandarden, rättade rubriker) och om
# railtimer-infra.js stämmer med underlagen. Ny version av linjeboken eller bilagorna: byt adresserna nedan.
set -euo pipefail

FILES=(
  # Järnvägsnätsbeskrivning 2027, bilaga 2 A: möteslängder och plattformar
  "jnb-2a.xlsx https://bransch.trafikverket.se/contentassets/05cfe3edce764ca4b2a3c53b4ed9a69c/bil_2_a_jnb_2027_moteslangder_och_plattformar_261119.xlsx"
  # Järnvägsnätsbeskrivning 2027, bilaga 2 B: banstandard
  "jnb-2b.xlsx https://bransch.trafikverket.se/contentassets/05cfe3edce764ca4b2a3c53b4ed9a69c/bil_2_b_jnb_2027_banstandarddata_260924.xlsx"
  # Underlag till linjebok, TC Göteborg, samlad version 2026-11-01
  "linjebok-g.pdf https://bransch.trafikverket.se/contentassets/1bcae666e9c2485597a9aece1e0dea42/dlo_g_samlad_version-_261101.pdf"
  # Underlag till linjebok, TC Hallsberg, samlad version 2026-09-01
  "linjebok-h.pdf https://bransch.trafikverket.se/contentassets/ac03238de53c4358bada12694ebf1e51/tc_h_samlad_version_260901.pdf"
)

work=$(mktemp -d)
for entry in "${FILES[@]}"; do
  name=${entry%% *}; url=${entry#* }
  file="$work/$name"
  if ! curl -fsSL --retry 2 -m 120 -o "$file" "$url"; then
    echo "FEL|$name|kunde inte hämtas: $url"
    echo "- $name: **kunde inte hämtas**" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    continue
  fi
  bytes=$(stat -c %s "$file")
  sha=$(sha256sum "$file" | cut -d' ' -f1)
  if [[ $name == *.pdf ]]; then
    pdftotext -layout "$file" "$file.txt"
    payload="$file.txt"
  else
    payload="$file"
  fi
  echo "FIL-START|$name|$bytes|$sha"
  gzip -9 -c "$payload" | base64 -w 3000 | sed "s/^/FIL|$name|/"
  echo "FIL-SLUT|$name"
  echo "- $name: $bytes byte, sha256 \`$sha\`" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
done

echo "== tools/infrastruktur.mjs =="
node tools/infrastruktur.mjs "$work" --check railtimer-infra.js
