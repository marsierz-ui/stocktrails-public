# Attention Tracker - Mobile design

> **Status: implemented, since superseded in parts.** The original design used the Node
> backend in `server/` (now an optional fallback for private setups). Today the cloud is
> Supabase, the web app is deployed to GitHub Pages (`.github/workflows/deploy-pwa.yml`) and
> the native Android/iOS app lives in `mobile/`. This file is the original design record;
> current behavior is in ARCHITECTURE.md and the main README.


Goal: use Attention Tracker on a phone. Three parts:

1. A small **sync backend** (or file/cloud sync) so phone and desktop share data.
2. A **PWA dashboard** that reuses the existing charts/analytics.
3. **Share-sheet capture** so you can log a stock from any finance app/site on mobile.

The desktop extension stays the primary *capture* surface (it can watch browsing;
mobile browsers can't run extensions). Mobile is mainly *view + quick capture*.

## Why not "just the extension on mobile"

- Chrome on Android does not support extensions. Firefox Android supports a subset;
  iOS supports Safari Web Extensions only when wrapped in a native app.
- Background page-watching (the desktop content script) has no mobile equivalent.
- So mobile capture = explicit user action (share-sheet / manual add), not passive.

## Architecture

```
 Desktop extension ──push/pull──┐
                                ▼
                         Sync backend  ◄──push/pull── PWA (phone)
 (chrome.storage +              │  (events, intraday,        ▲
  IndexedDB prices)            REST  overrides, portals)     │ Web Share Target
                                                     finance app / browser "Share"
```

Price bars are NOT synced - both clients refetch from Yahoo (daily is unlimited;
hourly is archived per-device). Only the user-authored data syncs:
`events`, `intraday`, `overrides`, `customPortals`, `settings`.

## Option A - File/cloud sync (no backend)

Lowest effort. Reuse the existing Export/Import JSON.

- Desktop: existing **Export JSON**; add **Import JSON (merge)**.
- Phone: the PWA imports the same file (from Files / iCloud / Drive).
- Merge rule: union by event `id` (ts+ticker); for `overrides`/`settings`
  last-write-wins by a `updatedAt` field.

Pros: trivial, private, no server. Cons: manual, not live, clunky on iOS.
Good as the MVP and as a permanent fallback.

## Option B - Small sync backend (recommended for live use)

Single-user, token-auth, tiny REST. Suggested stack: **Cloudflare Workers + D1
(SQLite)** or **a small Node/Express + SQLite** on any host. Either is ~150 lines.

### Data model (server)
```
events(id TEXT PK, ticker, ts INT, source, url, sentiment, priceAtEvent REAL, views INT, updatedAt INT, deleted INT)
intraday(id TEXT PK, ticker, ts INT, source, url, sentiment, priceAtEvent REAL, updatedAt INT, deleted INT)
overrides(ticker TEXT PK, symbol, updatedAt INT)
portals(idx INT, name, pattern, host, updatedAt INT)
meta(key TEXT PK, value)   -- e.g. settings JSON
```
Every row carries `updatedAt`; deletes are tombstones (`deleted=1`) so they
propagate. This makes sync idempotent and last-write-wins per record.

### Endpoints
```
GET  /sync?since=<ts>   -> { events:[...], intraday:[...], overrides:[...], portals:[...], settings, serverTime }
POST /sync              <- { events:[...], intraday:[...], ... }  (upsert by id/updatedAt)
```
Auth: `Authorization: Bearer <token>` (one token, stored in extension + PWA
settings). HTTPS only.

### Client sync loop (both extension and PWA)
1. `POST /sync` with local rows changed since `lastPushedAt`.
2. `GET /sync?since=lastPulledAt`; merge by `id`, keep the higher `updatedAt`,
   apply tombstones.
3. Persist `serverTime` as the new cursor.
Run on a timer (desktop: `chrome.alarms`; PWA: on focus + periodic) and after
each capture.

### Required local change (enables both A and B)
Add `updatedAt` (and soft-delete) to the store model and stamp it on every
write in `src/store.js`. This is the one prerequisite refactor; everything else
layers on top.

## PWA dashboard

The dashboard is already self-contained HTML/JS/canvas. To run as a PWA:

- **Data layer abstraction**: introduce `dataSource` with the same API the
  dashboard calls today (`getAll`, `setAll`, ...). Two implementations:
  - `ExtensionData` -> `chrome.storage` (current behavior).
  - `RemoteData` -> backend REST + IndexedDB cache (PWA).
  `dashboard.js` imports `dataSource` instead of `ATStore` directly. Small,
  mechanical change; charts/analytics stay identical.
- **Manifest** (`manifest.webmanifest`): name, icons, `display: standalone`,
  `start_url`, theme color.
- **Service worker** (`sw.js`): cache the app shell (html/css/js) for offline;
  network-first for `/sync`.
- **Responsive tweaks**: the layout already has mobile breakpoints (sidebar
  hides < 820px); verify chart canvases use `clientWidth` (they do) and add
  touch tooltips (tap instead of hover) for the canvas charts.
- Price fetches: the PWA calls Yahoo directly (CORS is open on the chart
  endpoint from a normal page) - no extension host permissions needed.

## Share-sheet capture (PWA)

Use the **Web Share Target API** so the app appears in the OS share sheet.

`manifest.webmanifest`:
```json
"share_target": {
  "action": "/share",
  "method": "GET",
  "params": { "title": "title", "text": "text", "url": "url" }
}
```
Flow: user taps Share on a stock page in their browser/finance app -> picks
Attention Tracker -> the PWA opens `/share?url=...&text=...` -> parse a ticker
from the URL (reuse `src/portals.js` `detect()`) or from a `$TICKER`/symbol in
the text (validate against Yahoo search) -> create an attention event -> push to
backend. Fallback: a manual "Add ticker" field.

Notes: GET share target works for links/text. iOS support for Web Share Target
is limited; there the fallback is "open the PWA + paste/lookup", or a thin
native share extension later.

## Reuse vs. new

Reuse as-is: `portals.js`, `prices.js`, all chart/analytics code in
`dashboard.js`, `dashboard.css`.
New: `dataSource` abstraction, `manifest.webmanifest`, `sw.js`, `share.js`,
backend (Worker/Express + schema), and `updatedAt`/tombstones in `store.js`.

## Phasing

- **M0 (prereq):** add `updatedAt` + soft-delete to the store; add Import-JSON
  (merge) on desktop. Ships value immediately (manual cross-device via file).
- **M1:** `dataSource` abstraction; PWA shell (manifest + sw) serving the
  dashboard against a local file import (read-only on phone).
- **M2:** backend + `/sync`; wire both clients to live sync.
- **M3:** Web Share Target capture; touch tooltips; polish.

## Open decisions

- Backend host/stack (Cloudflare Workers+D1 vs. Node+SQLite vs. Supabase).
- Single-user token vs. real accounts (single-user token is enough for personal
  use).
- Whether to sync the hourly price archive (default: no, refetch per device).
