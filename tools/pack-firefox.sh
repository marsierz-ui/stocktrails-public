#!/usr/bin/env bash
# Package the extension for Firefox (Gecko MV3).
# Differences from the Chrome build (tools/pack-extension.sh):
#   - drop "key" (Chromium-only; Firefox uses browser_specific_settings.gecko.id)
#   - add browser_specific_settings.gecko.id + strict_min_version (121 = first
#     Firefox with MV3 background.service_worker, which background.js relies on
#     via importScripts)
# Same runtime file set as Chrome; chrome.* is aliased to browser.* by Gecko.
#
# Usage: bash tools/pack-firefox.sh   ->   dist/stocktrails-firefox-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./manifest.json').version")"
OUT="dist/stocktrails-firefox-${VERSION}.zip"
ITEMS=(manifest.json src popup dashboard vendor icons)

mkdir -p dist
rm -f "$OUT"

BACKUP="$(mktemp)"
cp manifest.json "$BACKUP"
node -e '
  const fs = require("fs");
  const m = require("./manifest.json");
  delete m.key;
  m.browser_specific_settings = {
    gecko: { id: "attention-tracker@marsierz.app", strict_min_version: "121.0" }
  };
  fs.writeFileSync("manifest.json", JSON.stringify(m, null, 2) + "\n");
'
restore() { cp "$BACKUP" manifest.json; rm -f "$BACKUP"; }
trap restore EXIT

if command -v zip >/dev/null 2>&1; then
  zip -r -X "$OUT" "${ITEMS[@]}" -x '*/.*' '*.map' >/dev/null
else
  list="$(IFS=,; echo "${ITEMS[*]}")"
  powershell -NoProfile -Command "Compress-Archive -Force -DestinationPath '$OUT' -Path $list" >/dev/null
fi

echo "Built $OUT (Firefox/Gecko manifest)"
