#!/usr/bin/env bash
# Package the extension for the Chrome Web Store.
# Includes ONLY the runtime files; excludes server/, pwa/, docs/, tools/,
# supabase/, .github/, etc., and the brand lockups in icons/brand (marketing
# images for the store listing, never loaded by the extension). Excluding pwa/ also drops the only remote-code load
# (Tesseract CDN in pwa/share.js), keeping the package MV3-compliant.
#
# Usage: bash tools/pack-extension.sh   ->   dist/stocktrails-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./manifest.json').version")"
OUT="dist/stocktrails-${VERSION}.zip"
ITEMS=(manifest.json src popup dashboard vendor icons)

mkdir -p dist
rm -f "$OUT"

# The repo manifest pins a "key" so friends get a stable ID via load-unpacked.
# The Web Store manages its own key; an uploaded package carrying a mismatched
# key is rejected. Build the zip against a manifest with "key" stripped, then
# restore the original.
BACKUP="$(mktemp)"
cp manifest.json "$BACKUP"
node -e "const m=require('./manifest.json');delete m.key;require('fs').writeFileSync('manifest.json',JSON.stringify(m,null,2)+'\n')"
restore() { cp "$BACKUP" manifest.json; rm -f "$BACKUP"; }
trap restore EXIT

PY="$(command -v python3 || command -v python || true)"
if command -v zip >/dev/null 2>&1; then
  # -X strips extra file attributes; exclude dotfiles and source maps.
  zip -r -X "$OUT" "${ITEMS[@]}" -x '*/.*' '*.map' 'icons/brand/lockup-*' >/dev/null
elif [ -n "$PY" ]; then
  # Windows fallback. NOT PowerShell's Compress-Archive: on Windows PowerShell
  # 5.1 it writes entry names with backslash separators ("dashboard\dashboard.js"),
  # which is invalid per the zip spec - the Web Store and non-Windows unzip see
  # one flat file with a slash in its name instead of a directory tree.
  "$PY" - "$OUT" "${ITEMS[@]}" <<'PYEOF'
import os, sys, zipfile
out, items = sys.argv[1], sys.argv[2:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for item in items:
        if os.path.isfile(item):
            z.write(item, item.replace(os.sep, "/"))
            continue
        for root, dirs, files in os.walk(item):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            for f in sorted(files):
                p = os.path.join(root, f)
                if f.startswith(".") or f.endswith(".map") or p.replace(os.sep, "/").startswith("icons/brand/lockup-"):
                    continue
                z.write(p, p.replace(os.sep, "/"))
PYEOF
else
  echo "Need 'zip' or python to build the archive." >&2
  exit 1
fi

echo "Built $OUT (key stripped for Web Store)"
