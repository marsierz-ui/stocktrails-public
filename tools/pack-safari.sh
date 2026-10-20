#!/usr/bin/env bash
# Prepare a Safari-convertible SOURCE bundle.
# Safari cannot load a zip/folder directly. On a Mac with Xcode you convert this
# source, then build + sign an app that contains the extension:
#
#   1) unzip stocktrails-safari-src-<version>.zip -d stocktrails
#   2) xcrun safari-web-extension-converter stocktrails
#   3) Xcode opens: set a Team (free Apple ID works for local use), Build & Run
#   4) Safari > Settings > Extensions: enable it.
#      Unsigned/dev builds also need Safari > Develop > "Allow Unsigned Extensions".
#
# Manifest here has "key" stripped (Chromium-only). Safari ignores gecko/key.
#
# Usage: bash tools/pack-safari.sh   ->   dist/stocktrails-safari-src-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./manifest.json').version")"
OUT="dist/stocktrails-safari-src-${VERSION}.zip"
ITEMS=(manifest.json src popup dashboard vendor icons CONVERT-SAFARI.txt)

mkdir -p dist
rm -f "$OUT"

BACKUP="$(mktemp)"
cp manifest.json "$BACKUP"
node -e 'const fs=require("fs");const m=require("./manifest.json");delete m.key;fs.writeFileSync("manifest.json",JSON.stringify(m,null,2)+"\n")'

cat > CONVERT-SAFARI.txt <<'EOF'
Attention Tracker - Safari conversion (requires macOS + Xcode)

Safari does not load extension folders/zips like Chrome or Firefox. You must
build a signed app on a Mac:

  1. Unzip this bundle into a folder, e.g. ./stocktrails
  2. In Terminal:
         xcrun safari-web-extension-converter ./stocktrails
  3. Xcode opens the generated project. Pick a Signing Team
     (a free personal Apple ID works for running it on your own Mac),
     then press Run (Cmd+R) to build and launch.
  4. In Safari: Settings > Extensions, enable "Attention Tracker".
     For a self-built (unsigned) extension you must first enable:
         Safari > Settings > Advanced > "Show features for web developers"
         Safari > Develop menu > "Allow Unsigned Extensions"
     (that toggle resets each time Safari restarts).

  For distribution to other people, the app must be notarized / shipped
  through the Mac App Store (a paid Apple Developer account, $99/yr).

Known issue - Google sign-in:
  Sign-in uses launchWebAuthFlow with a browser-generated redirect URL.
  Safari's redirect URL differs from Chrome's, so Google sign-in will fail
  until that redirect URL is added to:
    - Supabase: Authentication > URL Configuration > Redirect URLs
    - Google Cloud Console: the OAuth client's Authorized redirect URIs
  Trigger sign-in once and read the exact redirect URL from the auth error
  or the network request, then whitelist it in both places.
EOF

cleanup() { cp "$BACKUP" manifest.json; rm -f "$BACKUP" CONVERT-SAFARI.txt; }
trap cleanup EXIT

if command -v zip >/dev/null 2>&1; then
  zip -r -X "$OUT" "${ITEMS[@]}" -x '*/.*' '*.map' >/dev/null
else
  list="$(IFS=,; echo "${ITEMS[*]}")"
  powershell -NoProfile -Command "Compress-Archive -Force -DestinationPath '$OUT' -Path $list" >/dev/null
fi

echo "Built $OUT (Safari source bundle; convert on a Mac)"
