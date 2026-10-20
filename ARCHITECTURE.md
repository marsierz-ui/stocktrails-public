# Stocktrails - Architecture & Processes

Living document. Updated as the app changes. Describes what the app does, how it
is built, and how data flows end to end.

## 1. What the app is

Stocktrails records which stocks you look at on finance portals, when, for
how long, and what you expect (Positive / Neutral / Negative), then measures how
those stocks performed since you first paid attention. It ships in three forms
that share the same core JS modules:

- Chrome MV3 extension (primary): content script on finance portals + service
  worker + dashboard page.
- Installable PWA: same dashboard, with `chrome.*` shimmed over IndexedDB.
- Cloud backend: Supabase (Postgres + Auth + RLS + Edge Functions) for
  multi-user sync, Google sign-in, and an in-app admin overview.

## 2. Components

### Extension
- `manifest.json` - MV3 manifest. `host_permissions` + `content_scripts` list
  the supported portals (Yahoo, Google Finance, MarketWatch, CNBC, Bloomberg,
  stockanalysis, MarketBeat, Finviz, Perplexity, TradingView, Seeking Alpha,
  Nasdaq, Stocktwits, WSJ, Holdings Channel (institutional holders pages only)), and Supabase. `optional_host_permissions`
  allows user-added portals. Permissions include `identity` (Google OAuth) and
  `offscreen` (the AI agent's live verdict, below).
- `src/content.js` - injected into portal pages. Detects the ticker, logs an
  attention event, tracks dwell (active visible time), and renders the in-page
  label widget (shadow DOM). Idempotent re-injection. When no portal URL pattern
  matches, falls back to content-based detection (`scanContent`): scans the page
  for cashtags (`$NVDA`), exchange-qualified symbols (`NASDAQ: NVDA`), tracked
  company names, and bare tracked tickers (with a common-word blocklist), scoring
  title/heading hits above body hits. High-precision: it only fires for tickers
  the user already tracks or unambiguous cashtag/exchange mentions. Known
  tickers + company names are read from `attention_v1` + `attention_names_v1` in
  local storage; the innerText scan is throttled to ~2.5s. Content-detected
  events carry `source = "content"`. Above the label widget sit the reminder / last-comment
  pop-up and, above that, the AI agent's verdict on the stock (`showVerdict`, purple, from
  `at_agent_verdicts`, replaced live through `chrome.storage.onChanged`, closed with its x until a new verdict).
- `src/portals.js` - portal URL patterns + `detect(url, custom)`; built-in list
  plus user-defined patterns.
- `src/background.js` - the service worker. Message router, price capture,
  hourly-archive maintenance, badge, alarms (`sync` 5 min, `priceUpdate` daily),
  dynamic content-script registration for custom portals. It also keeps the viewing
  sessions for the AI agent's live verdict (issue #30): every view and dwell ping moves a
  session per stock (`src/agentsession.js`, `at_agent_sessions`); a minute after the last
  activity an alarm (`agent|<ticker>`) opens `dashboard/dashboard.html?headless=agent` in an
  offscreen document (reasons `LOCAL_STORAGE`, `DOM_PARSER`; one at a time, closed when done or
  after 10 minutes by the `agentClose` alarm). That page runs the same Trades & research pipeline as the open dashboard
  (`dashboard.js headlessAgent`, started on the page's load event since `shadow.js` loads after `dashboard.js`;
  `shadow.js trAgentHeadless`): the AI agent decides the undecided moments of the session's stocks
  in the 2-day window (other moments wait for the open dashboard; one request at a time across the
  dashboard and the headless page, a Web Lock, each re-reading the saved record first), asks again about a moment whose session got more views after it was decided
  (a return within 5 minutes continues the session; at most 3 times per moment; the earlier answer is
  kept as `<moment>|prev|<decidedAt>` with `supersededAt`), and reports per stock the verdict, or why
  there is none, which the worker writes to `at_agent_verdicts`. Gates as in the dashboard: signed in,
  assistant consent (`at_ai_on` mirrors it for the worker, which has no localStorage), the daily cap.
  An offscreen document has only `chrome.runtime`; `src/offscreen-shim.js` gives it
  `chrome.storage.local` by messaging the worker (`offscreenStorage`, accepted only from the
  extension's own dashboard page, never from a tab).
- `src/store.js` - local database over `chrome.storage.local`. Two record sets:
  `events` (daily, deduped) and `intraday` (every view). Plus `overrides`
  (ticker->symbol), `customPortals`, `settings`, tombstones for deletions, and
  sync config. Owns `collectChanges`/`applyRemote` (last-write-wins merge).
- `src/prices.js` - Yahoo Finance keyless chart endpoint: `fetchQuote`,
  `fetchDaily`, `fetchBars` (hourly), `searchSymbols`. Direct fetch in the
  extension; via proxy in the PWA.
- `src/pricedb.js` - IndexedDB archive of hourly bars per symbol (backfill +
  daily append), so the intraday chart does not refetch on every load.
- `src/pricecache.js` - IndexedDB `attention_daily`: the daily series the Trades tab
  needs (`ensurePrices` in `dashboard/trades.js`), so opening it does not download
  them all again. `peek` answers from the store at once; a series older than 6 hours is
  marked stale and brought up to date after the page is shown (`trPricesRefresh`: a
  request from 10 days before its last bar, merged; the whole series again when the
  overlap shows a split or restatement, and the report is rebuilt once when a new day
  arrived). Cleared with the imported trades. Tested by `tools/test-pricecache.js`.
- `src/sync.js` - sync orchestrator: push local changes, pull+merge remote.
  Routes to Supabase (Option B). While Supabase is configured it never falls back to the
  token server (Option A, only when Supabase is unset; `AT_SERVER_URL` ships empty).
- `src/cloud.js` - Supabase provider: auth (Google), `trySync`, feedback, and
  all admin RPC wrappers.
- `src/config.js` - Supabase URL/anon key, functions URL, sync server URL,
  price-proxy logic.
- `popup/` - toolbar popup.
- `dashboard/` - the main UI (`dashboard.html/js/css`). Main tabs (`MAIN_TABS`; the id differs from
  the label for two): My Habits (`attention`: Trades & research, Overview, Trends, Breakdown),
  My Stocks (`performance`: watchlist, Single / Compare / Index charts), Predictions, Community
  (`network`: percentiles, community index, third-party indices, Trending), World, Settings (data
  import, account, appearance) and Admin. Helper modules: `trades.js` / `trcharts.js` (Trades &
  research), `biascards.js` and `coach.js` (bias cards, coach, pre-trade check), `shadow.js` (the
  agents' paper portfolios), `ai.js` (assistant panel), `crowdwatch.js` (the "Back to earth" card)
  and `headinfo.js` (the (i) info popup on every headline; `tools/test-headinfo.js` checks that
  every headline has one).

### PWA (installable web app; the native Android/iOS app is in `mobile/`, see below)
- `src/pwa-shim.js` - shims `chrome.storage`, `chrome.runtime`, etc. over
  IndexedDB when `chrome` is absent, so the same modules run on the web. It also
  injects the manifest link and registers the service worker, resolving both
  against its own script URL so they work when the site is deployed under a
  GitHub Pages subpath rather than at the origin root.
- `.github/workflows/deploy-pwa.yml` (and `pr-preview.yml`) copy only the web app's
  files (`index.html`, `manifest.webmanifest`, `sw.js`, `dashboard/`, `src/`,
  `vendor/`, `icons/`, `pwa/`) to the public Pages site; a new top-level folder the
  web app loads must be added to both lists.
- `manifest.webmanifest` + `sw.js` live at the repo root (root is the deployed
  site root); every URL inside them is relative, and the service worker resolves
  its shell list, share-target path and offline fallback against
  `registration.scope`. Root placement is required: a worker under `pwa/` could
  only control `pwa/`.
- Mobile is this same dashboard, not a separate codebase: the main `max-width: 768px`
  block at the end of `dashboard/dashboard.css` (a few small 768px rules for the assistant panel
  and card groups sit elsewhere in the file) moves the section tabs into
  a fixed bottom nav bar, unsticks the header, tightens padding, makes wide
  tables their own horizontal scroll boxes, and takes dialogs edge-to-edge.
- `share_target` (POST) is intercepted by the service worker, which stashes the
  shared text/image in a cache and redirects to `pwa/share.html`.

### Native mobile app (`mobile/`)
- React Native + Expo (TypeScript), Android first. Reuses the Supabase backend
  unchanged: plain PostgREST upserts/selects with client-side delta sync and the
  server `keep_newer` LWW triggers. The token server is not supported.
- Ports of the extension core live in `mobile/lib/` (`store.ts`, `cloudMap.ts`,
  `prices.ts`, `sync.ts`, `db.ts`). Needs a native dev build (Skia, ML Kit OCR,
  share intent), not Expo Go. Broker trades import is not implemented there.
- Auth storage (`lib/supabase.ts` `EncryptedStore`, Supabase's LargeSecureStore
  pattern): each value is AES-256-CTR encrypted with a fresh key kept in
  `expo-secure-store` (Keychain/Keystore); AsyncStorage holds only `enc1:`
  ciphertext. A plaintext session from older builds is re-stored encrypted on
  first read. SecureStore is excluded from Android Auto Backup, so a restored
  backup has no key and reads as signed out.

### Cloud (Supabase, project ref `unymnlguicuwllkuqglm`, eu-west-3)
- Tables: `profiles` (with `is_admin`), `events`, `intraday`, `user_meta`,
  `feedback`; later migrations add `feature_usage`, `ai_usage`, `user_country`,
  `trending_snapshots` / `trending_raw`, `earnings_dates` / `earnings_backfill`,
  `crowd_notify` / `crowd_notified`, `capture_claims` (single-flight claims for the trending and
  earnings captures) and `keepalive`. RLS scopes rows to the owner; `keep_newer()` triggers enforce
  last-write-wins on `updated_at`. `user_meta` uses `user_meta_keep_newer()`
  instead, which LWW-guards only the synced payload (`config` + `updated_at`)
  so the best-effort adoption/country updates (which never bump `updated_at`)
  pass through instead of being silently discarded.
- `events`/`intraday`/`user_meta` also carry `synced_at` (server `now()`, set by
  the `stamp_synced_at()` / `stamp_user_meta_synced_at()` triggers), which is
  what clients pull on - see section 5. The trigger name sorts after the
  `*_lww` one so LWW decides first: a rejected write returns the old row, and
  leaving its `synced_at` alone keeps it from re-notifying every other device.
- `public.is_admin()` helper gates admin RPCs (security definer).
- Admin RPCs aggregate live at query time (no batch job): `admin_totals`,
  `admin_user_stats`, `admin_top_tickers`, `admin_by_hour`, `admin_by_weekday`,
  `admin_extras`, `admin_calendar`, `admin_attention_buckets`,
  `admin_stock_buckets` (the bucket/hour/weekday/top/extras/calendar RPCs also
  return `dwell` sums for the Time column of the admin Aggregate view).
  `admin_marketing_kpis` returns the digital-marketing KPIs for the Insights
  tab: day-N retention (D1/W1/M1), weekly churn rate, quick ratio, resurrected
  users, WoW/MoM growth, engagement depth per active user, and a 12-week
  acquisition trend. `admin_metric_totals` returns 30-day values for every KPI
  card in the dashboard/event/attention metric groups; `admin_metric_series(
  p_metric, p_from, p_to, p_unit)` returns the per-bucket series behind the
  drilldown chart that opens when a KPI card is clicked (sourced from `events`
  and `feature_usage`; `feedback_ratio = feedback_sent / feedback_open`). Count
  metrics in both are normalized per active user (total / distinct active users)
  so they stay comparable as the user base changes; `active_users`/`new_users`
  are absolute and `label_rate`/`feedback_ratio`/`avg_dwell_min` are already
  normalized. `admin_area_usage` aggregates the `area:*` / `click:*`
  `feature_usage` sections into per-area, per-user dwell + click usage.
  `admin_research_effectiveness` groups events by (portal, research_type) and
  reports per-path usage plus the 30d forward return proxy + label hit rate,
  feeding the Insights "Research paths -> returns" table.
- `supabase/schema.sql` is the original base only (the five tables above, `keep_newer()` and
  the `*_lww` triggers); everything later is in `supabase/migrations/`, applied in date order
  (`user_meta_keep_newer()` is one of those). Eleven admin RPCs that `src/cloud.js` calls
  (`admin_totals`, `admin_user_stats`, `admin_calendar`, `admin_attention_buckets`,
  `admin_stock_buckets`, `admin_attention_over_time`, `admin_daily`, `admin_outlook_buckets`,
  `admin_outlook_over_time`, `admin_sentiment`, `admin_stock_daily`) are defined in no file of
  the repo: they exist only in the live database, so a project built from the repo lacks them
  until they are exported into a migration.
- Edge Function `earnings` (verify_jwt=true; the cron job sends the anon key) - earnings release dates for the
  limited-attention card. It reads the Nasdaq calendar (last 3 / next 7 days) and
  SEC EDGAR 8-K item 2.02 filings (up to 25 companies per run, needs the secret
  `SEC_USER_AGENT`) into `earnings_dates`. Clients read it through
  `earnings_for(tickers)`. pg_cron runs it on weekdays at 12:10 UTC (migration
  `20261012_earnings_dates.sql`). `community_first_looks_daily(days)` (migration
  `20261012_community_first_looks.sql`) gives per-day first looks per ticker, with a
  floor of 3+ users per ticker and 5+ active users per day.
- Edge Function `yahoo` (verify_jwt=false) - price proxy for the PWA, sends a UA
  header and falls back to query2 to avoid Yahoo 429s.
- Edge Function `trending` (verify_jwt=false) - snapshots five third-party
  attention lists (StockAnalysis, Reddit mentions, Stocktwits, Yahoo and Wikipedia pageviews)
  into `trending_snapshots` (see section 9c). Server-side
  because three of the first four send no CORS headers and all of them rate-limit by
  IP; it no-ops when the newest capture is under 30 min old, so the dashboard
  can call it on load without becoming a scraper. `.github/workflows/
  trending-capture.yml` calls it with `?force=1` on weekdays at 20:40 UTC.
- Table `trending_snapshots` (source, day, ticker, rank, views) with
  `trending_daily(p_days, p_top)` / `trending_status()`. Not user data: no
  owner scoping, readable by any signed-in user, written only by the edge
  function's service role. `trending_daily` returns ONE row per (source, day)
  with a `{ticker: [views, rank]}` payload - per-ticker rows would cross
  PostgREST's 1000-row response cap after a few weeks and start dropping days
  silently.
- Crowd series and "Back to earth" (migration `20261015_crowd_series_and_alerts.sql`):
  `crowd_stock_daily(p_tickers, p_days)` is the per-stock series of every platform
  with no top-N cut (same `{ticker: [views, rank]}` rows; pass tickers to stay under
  the row cap). A `stocktrails` source appears only on days with >= 20 active users
  and for tickers with >= 5 users. `crowd_settled(p_days)` lists stocks that were in a
  platform's top 20, that the caller looked at (from `intraday`) around then, and that
  no platform has had in its top 50 for >= 3 captured days since. Detection lives only
  in SQL (`_crowd_settled`, service role), shared by the card in Community > Trending
  (`dashboard/crowdwatch.js`) and the daily e-mail (`crowd-alerts` edge function, pg_cron
  22:30 UTC on weekdays, deployed `--no-verify-jwt`; it refuses calls without the
  `x-cron-secret` header matching `CROWD_ALERTS_SECRET`, which the cron reads from Vault,
  and claims each alert in `crowd_notified` before sending so overlapping runs cannot
  mail twice). E-mail is opt-in (`crowd_notify`,
  off by default), once per stock and trend (`crowd_notified`), sent through Resend
  (`RESEND_API_KEY`, `MAIL_FROM`). Nothing new about the user is stored for the in-app
  card; the mobile app does not show it yet.

## 3. Data model

Each event (in both `events` and `intraday`):
`id, ticker, ts, source, url, sentiment, priceAtEvent, views, dwellMs, updatedAt`
(+ `deleted` tombstone in the cloud). Events also carry `researchType` - a
coarse page-type classification at capture (`classifyResearch` in content.js),
synced as `research_type`. Classification is URL/portal-first, then falls back
to scanning the page's own headings / tab labels (`classifyByContent`) so a
section is recognized even when the URL is generic. Buckets: overview / news /
financials / analysis / charts / community / screener / options / ownership /
profile / ai, plus content-detected insider / short / institutional / dividends
/ earnings / estimates. Events also carry `section` (synced as `section`,
migration `20261006_section.sql`) - the exact page section the URL names,
parsed by `ATPortals.detect` (`sectionAfter` in portals.js): the path after the
ticker, up to 3 segments (`/stocks/app/forecast/` -> `forecast`,
`/quote/MRNA/financials/` -> `financials`, `.../financials/balance-sheet/` ->
`financials/balance-sheet`), `overview` for a quote landing page, `null` for
content-detected pages and query-string portals that name no section. Chart
pages put the section first, so StockAnalysis (`/chart/APP/`, `/chart/TYO:7203/`)
and Yahoo (`/chart/MRNA`) have their own patterns and record `chart`. `section`
is finer than `researchType` (key-statistics, history, metrics all fold into
`overview` there) and is the step in a stock's research path: the intraday DB
keeps one row per section visited, and a move to another section within the 30s
double-fire window is kept, since the section differs. The daily row holds the
section of the window's first view, like `researchType`. Ticker detection (`scanContent`) also reads a
URL/structured-data/meta symbol (`urlMetaSymbol`, skipping exchange path
segments like `/stocks/NASDAQ/TSLA`), so the researched stock is picked up on
sub-pages and for not-yet-tracked tickers, not only on quote pages.

- `events` (daily DB): repeated views of the same ticker within
  `settings.dedupeMinutes` (default 60) collapse into one row; `views` is
  incremented and `ts` refreshed.
- `intraday` DB: one row per view (only exact double-fires <30 s are dropped).
- `dwellMs`: active visible-tab time, accumulated onto the latest event for the
  ticker in both DBs.

- Page-type quality: `classifyUrl` falls back to "overview" when it does not know,
  which mixes "unknown" with a real overview page. `node tools/classifier-report.js
  history.csv [--csv templates.csv] [--eval labelled.csv]` measures it on a browsing
  history file on the user's own computer (finance-site visits only, host and path
  templates only, never full URLs): the share that fell back, by type, host and
  template, a CSV of templates to label, and the share of visits the classifier gets
  right against those labels. New rules are added only if they clearly beat that on
  templates they were not written from (issue #17).

## 4. Capture pipeline (per page view)

1. `content.js` polls `location.href` every 1500 ms. On a new ticker it sends an
   `attention` message; it also starts dwell timing and flushes accrued active
   time every 15 s and on visibility change / page hide (chunks >=30 min are
   discarded as sleep/suspend).
2. `background.js handleAttention`: stamps `ts = Date.now()`; `addEvent` (daily,
   deduped) + `addIntraday` (every view); fetches a quote and writes
   `priceAtEvent` (best-effort); updates the badge; backfills the hourly archive
   for new tickers; triggers a sync.
3. `dwell` messages call `store.addDwell` and trigger a sync.
4. `label` messages write one sentiment to the latest daily + intraday rows.
5. All writes land in `chrome.storage.local` immediately, so the local dashboard
   reflects them on next render with no network.

## 5. Sync

- `sync.js doSync`: if Supabase is enabled and signed in, `cloud.trySync` pushes
  records with `updatedAt > cloudCursor` (upsert to `events`/`intraday`/
  `user_meta`) and pulls rows with `synced_at > cloudSyncedAt`; merge is
  last-write-wins by `updated_at`. When Supabase is configured but there is no
  session, sync stops there (no token-server fallback).
- Two cursors, because push and pull are asking different questions:
  - `cloudCursor` (ms, this device's clock) filters this device's own rows by
    their `updatedAt` - both sides of that comparison are local, so it is sound.
  - `cloudSyncedAt` (ISO, the server's clock) filters remote rows by when the
    server received them. It cannot be the local clock: `updated_at` is stamped
    on the capturing device when the row is written, and a row captured at T but
    pushed later (the MV3 worker rarely uploads, so a push can lag a capture by
    hours) is already behind any device whose cursor has moved past T. Pulling on
    `updated_at` made those rows invisible forever, which is how two installs on
    one machine drifted to 92 vs 108 tickers and never re-converged. The cursor
    is rewound `CURSOR_OVERLAP_MS` (5s) per pull because `synced_at` comes from
    `now()` (transaction start), so a long transaction can commit after a later
    timestamp is already visible. Re-reading a row is free; missing one is not.
  - Pulls page in 1000-row blocks ordered by `(synced_at, id)`: PostgREST
    truncates a response at 1000 rows, and a silent truncation with an
    advancing cursor drops rows permanently. Paging is by keyset (rows after the
    last `(synced_at, id)` seen), not `.range()` offsets: another device
    updating a row mid-pull re-stamps it to the end, which shifted the offset
    window past rows that were already behind the cursor (a phone stuck at 238
    of 252 tickers after a history import). Protocol 3 forces one full re-pull.
- Full reconcile (ignore both cursors, push everything, pull everything) runs
  when `syncProtocol` changes - one bump merges installs that already drifted -
  and once a day (`DEEP_SYNC_MS`) after that, so any future gap closes by itself
  rather than living in the data forever.
- If the `synced_at` column is missing (migration not applied), the pull falls
  back to the old `updated_at` cursor and reports it in `lastError`.
- Triggers: after every attention/label/dwell, plus a 5-min alarm.
- Constraint: the Supabase session lives in the page context, not reliably in
  the MV3 service worker, so cloud upload effectively happens while a signed-in
  dashboard/PWA tab is open (on load and on the 5-min alarm).
- Session sharing (#5): the page writes `{ access_token, refresh_token }` after
  sign-in and each sync to IndexedDB `stocktrails_auth` / store `session` / key
  `cur` (extension or PWA origin; content scripts run in the host page's origin and
  cannot open it), and sets the non-secret flag `at_cloud_signed_in` in
  `chrome.storage.local`. The worker's `signedIn()`, the popup and the widget gate
  on that flag; the worker's `restoreSession` reads the tokens. Sign-out deletes
  both. Not `chrome.storage.session`: it is cleared on browser restart and
  extension update, which would stop capture. Installs from before 0.4.0 kept the
  tokens in `chrome.storage.local.at_cloud_session`; `migrateSession` (worker
  install/startup, `restoreSession`) moves them once and removes the key.
- Sign-in flow: the web app (http/https pages) uses PKCE (`flowType: "pkce"` in
  `getClient`): the return carries `?code=`, which only the browser holding the
  code verifier can exchange, so a link carrying `#access_token=` no longer signs a
  visitor into someone else's account. The extension keeps the implicit flow, read
  from the `chromiumapp.org` redirect that only `launchWebAuthFlow` receives; mobile
  is PKCE (`mobile/lib/supabase.ts`).
- E-mail sign-in: the sign-up window also offers an e-mail address and password
  (`ATCloud.signInEmail`: `signUp` with a confirmation link that opens the web app, or
  `signInWithPassword`), after the same Terms tick. Needs the Supabase Email provider.
- The web app refuses to run framed (`src/theme.js`, top-level check on http/https):
  GitHub Pages sends no `X-Frame-Options` and a meta CSP cannot set `frame-ancestors`.
- Settings > Import JSON must rewind `cloudCursor` to 0. Imported rows keep the
  `updatedAt` stamped when they were first recorded, so they are OLDER than this
  device's cursor and `collectChanges` (which only pushes rows past the cursor)
  filtered every one of them out - the import stayed in `chrome.storage.local`,
  rendered as if saved, and was lost on the next sign-out or account switch. The
  handler syncs BEFORE merging (so local already holds the newest cloud copy of
  anything the catch-up push is about to overwrite wholesale - the push is a
  plain `upsert`, not an LWW merge), then merges, rewinds, and pushes.

## 6. Price & return data

- `priceAtEvent`: captured at view time (one `/v8/finance/chart?range=1d` quote).
- Daily series: `prices.fetchDaily` on dashboard load; one bar per trading day,
  dated at UTC midnight. Held in-memory (`SERIES`) for the session.
- Hourly series: served from the IndexedDB archive (`pricedb`), appended once a
  day by the `priceUpdate` alarm.
- NASDAQ benchmark (`^IXIC`): fetched on dashboard load for index/correlation, from 10 days before the first view;
  the Trades pane asks for it from 400 days before the first trade (`ensureBenchmark(from)`), so the trade analysis and
  the paper portfolios cover every trade (a buy before it starts is left out and counted, never bought at a later price).
- Yahoo latency: intraday quotes are ~real-time to ~15 min delayed; a daily bar
  finalizes after market close.

## 7. Charts

All charts render on `<canvas>` with a shared floating tooltip (`#hover-tip`)
and a dashed vertical guide that snaps to the nearest time point. Y-axis tick
labels adapt their precision to the tick step (`drawAxes`): 1 decimal when the
step is below 1 (so fractional axes like "/user" do not collapse to 0/1 dupes),
2 decimals below 0.1, integers otherwise.

### Main chart (`drawMulti`)
- Ordinal x-axis: data points are placed by index, so non-trading periods
  (overnight/weekends/holidays) take no width; the line connects close -> next
  open directly. `xs` is the sorted union of all line + marker timestamps.
- Day separators (faint dashed verticals) on the intraday/hourly chart.
- Hover: snaps to the nearest x, draws the guide, and the tooltip lists the
  x-axis label plus every line's y value at that x (sorted desc). Outlook
  bubbles (markers) show their own annotation.
- Window re-anchoring: after the brush filter, every line whose view passes
  `opts.baseline` (all three views do) restarts at that baseline at the left edge
  of what is shown, each at its OWN first visible point - a name that enters
  mid-window has no earlier price to measure from. Markers are rescaled by their
  line's factor (matched on `label`, falling back to the first line's) so they
  stay glued to it. The chart therefore always reads as "return over the window
  on screen", whether that window came from the Period selector or from dragging
  the brush. On the full window every factor is 1, so nothing changes.

### Single
- One stock, rebased to 100 at the price recorded at first view
  (`priceAtEvent`). On the full window the line starts with an explicit 100
  anchor at the first-view period, then plots bars strictly after the first view,
  then the live quote, so it always starts at 100 (the first daily close is shown
  as a move from your entry price, not as the start). Under a Period the first
  view is usually outside the window, so the anchor is dropped and the window's
  own first bar starts the line (`drawMulti` re-anchors it to 100); the benchmark
  starts from the same bar rather than from the first view. NASDAQ rebased to 100
  too. Markers (one per attended day, sized by time spent, colored by label) snap
  to a plotted line point so they sit on the line and add no extra column.

### Compare
- Every tracked stock on one chart, each rebased to 100 at its own first-view
  price, then re-anchored to the shown window by `drawMulti`. The 100 anchor and
  the live-quote point are snapped to the chart grid
  (`snapGrid`: hour for hourly, UTC day for daily) so all stocks first viewed in
  the same period share one x column - this avoids multiple x/y points landing on
  the same date (daily) or near-now (hourly). Markers snap to a plotted line
  point. Hover shows a per-stock return table at the hovered time, and isolates
  the line nearest the cursor (others dimmed to 12% alpha via `drawMulti`'s
  `opts.highlight`); the chart re-renders on each move while hovering. The
  table is ONE column capped at ~300px (`.tip-rows`); the tip is
  pointer-events: none, so a document-level wheel handler scrolls it while the
  pointer is on a canvas, and `showTip` keeps the offset across the per-move
  re-render until the hovered day (the tip's bold header) changes.

### Benchmark line (`benchLine`)
- NASDAQ buy-and-hold as a plain grey line. Total daily attention is painted as
  the plot's background (`drawMulti`: one band per bar, opacity and colour
  rising with that day's views; days without attention stay clear), so the
  lines on top keep their colours. It starts with an
  explicit anchor at the passed start time (= the stock's first-view period) and
  is rebased to 100 there, so on Single the stock and NASDAQ begin at exactly the
  same x and value at both daily and hourly resolution.

### Index
- A synthetic portfolio (equal-weight or attention-weighted), held per a rule
  (all / positive / attended), compounded bar-to-bar from each name's entry.
  Period trims and re-anchors the window to 100. The curve starts on the first
  bar where the rule holds a stock: before that it sits flat at 100 in cash
  ("Long only on Positive" before the first Positive label, or label-less views
  imported from browsing history), and `chart-msg` names the start.
  "Weight window" (`#win`, All time by default, 30-365 days, kept in `at_view`;
  only matters for Attention-weighted): weights are each held name's views inside
  the trailing window, so a name idle for the whole window gets weight 0 (drops
  out) and its weight fades as its views age, the same logic as Q9's recent basket.
  When no held name has a view in the window the previous weights are kept for the
  names still held (equal weight if none), rather than moving to cash.
  "Decision lag" (`#lag`, default 0 days, kept in `at_view`; 0-14 days): the
  signal time of a bar is `closeTs(date) - 1 - lag`, and entry, labels and
  attention weights only see events up to it. Q9 uses the same rule (`usClose`,
  `lagDays`, default 1 day, `at_tr_lag`). 0 is exact for US listings; an exchange
  that closes before the US one (Europe, Asia) can leak a few hours to a day at
  lag 0, which lag 1 covers (Q9's default, close to its former start-of-UTC-day
  rule). A larger lag models users who research for days before buying.
  Planned: use the window and the lag as tunable parameters when optimizing a
  momentum strategy on attention; per-exchange close times would make lag 0 exact
  for non-US listings.
  Q9 window and lag changes do not redo the report: `analyze` returns
  `recomputeQ9({windowDays, lagDays})` (a closure over the same holdings and
  views) and `trRefreshQ9` swaps only the `data-q='9'` card and its chart.
- An "Allocation statistics" panel below the chart (Index view only) evaluates
  the allocation over the displayed window: structure (holdings, HHI, effective
  holdings, top-1/top-3 weight, avg turnover per bar), performance (total and
  annualized return, volatility, Sharpe, Sortino, max drawdown, hit rate,
  best/worst bar), NASDAQ-relative stats (benchmark/active return, beta,
  correlation, alpha, tracking error), a "Weight vs contribution" scatter
  (`drawWeightContribCanvas`: x = current weight, y = contribution in pp, dot
  colored by sector, names now in cash sitting at x = 0; a dashed
  "proportional" line y = weight x the basket's total contribution marks where a
  name that pulled exactly its weight sits, so distance from it identifies
  outliers; labels are placed greedily, largest excess first, only where the
  box clears every other label and dot - crowded dots stay unlabeled and name
  themselves on hover, in the inline and full-screen views alike), and the same numbers as
  a per-holding table. Scatter and table sit side by side in `.idx-alloc-row`
  (wrapping to stacked below ~700px): they carry the same numbers, so stacking
  them cost a screen of height for no extra information. The table stays a
  `<details>` (`.idx-holdings`, open by default) with its own scroll box so a wide
  basket can be folded away and never makes the row taller than the chart.
  Computed from per-bar detail returned by `computeIndex`. The scatter is drawn
  only after the panel is un-hidden, since canvas sizing reads `clientWidth`.

## 7a. Company names

Tickers are shown as company names where possible. `ATPrices.fetchName` resolves
a symbol to its display name via Yahoo search; the dashboard caches results in
`chrome.storage.local` under `attention_names_v1` (`NAMES`, accessed via
`nameOf(t)`, falling back to the ticker). Resolution runs in the background on
load and re-renders the name-bearing views (watchlist, chart titles/labels,
legends, top lists) when it completes. The Yahoo-symbol editor and admin
aggregate still use raw tickers (admin aggregates arbitrary users' tickers, which
are not in the local name cache).

## 8. Analytics (Attention view)

Two columns, Views (left) and Time (right), one shared period selector
(Day/Week/Month/Year + nav). Each row pairs a stat with its time counterpart:
Market caps (watchlist Cap column) come from Yahoo's keyless
`/ws/fundamentals-timeseries/.../timeseries/<sym>?type=trailingMarketCap`,
converted to USD at the live `XXXUSD=X` quote before bucketing
(`fetchProfile`); quoteSummary needs a crumb and answers 401. The PWA proxy
(`yahoo` edge function) allows that path. `backfillProfiles` also fills names
that have a sector but no cap, and cached profiles without a cap expire after a
day.

Market correlation (both columns): a Previous day / Same day / Next day switch
(`mcLag`, persisted in `at_mc_lag`) picks which NASDAQ return each day's
attention is paired with, and the rolling chart plus the point values show
yours next to the community's, both counted the same way (every intraday view,
one row = one view, UTC day; the personal line ignores the Daily/Intraday basis
so a sole user's two lines are identical up to unsynced rows)
(`community_daily_attention`, open to every
user, days with at least 5 active users only, so a sole user or a small
community sees no community line: views or active minutes per active user per UTC day, so growth does not
read as rising attention). This replaced the admin-only World panel.
A period with fewer than `MC_MIN_DAYS` (10) trading days so far - any Day or
Week, the first days of a Month - falls back to the rolling `MC_ROLL_DAYS` (30)
calendar days ending at the period's end, and says so above the chart. The
rolling line uses a fixed `MC_W` (20) trading-day window fed from before the
period too, so it covers the whole period instead of starting halfway in.

Usage summary, calendar heatmap, over time, by stock over time, distributions
(by hour / weekday / most attended), and rolling market correlation vs NASDAQ.

## 9. Admin (Aggregate view)

Mirrors the user Attention window, aggregated across all users, in the same
Views|Time two-column sequence: usage summary, calendar, over time, by stock,
distributions, market correlation. Backed by the admin RPCs (live aggregation,
admin-gated). The admin by-stock charts support hover-isolate (nearest ticker
highlighted, others dimmed), like the user Compare chart. End-to-end latency to admin: typically <=5 min after an event
(next sync, while a signed-in page is open) plus an admin refresh; returns are
as fresh as Yahoo.

The Admin Insights tab opens with a "Product KPIs" block that groups metrics
into Dashboard / Event / Attention categories (`KPI_GROUPS` / `METRIC_META` in
`dashboard.js`). Each card shows a 30-day total (`admin_metric_totals`) and is
clickable: `openMetricModal` -> `renderMetricModal` opens `#metric-modal` with a
time-series chart drawn by the shared `drawLineCanvas` over `buildAttBuckets`
windows (Day/Week/Month/Year + prev/next nav), fed by `admin_metric_series`. The
Dashboard group includes a feedback-completion ratio (`feedback_sent /
feedback_open`), where `feedback_open`/`feedback_sent` are `feature_usage`
sections recorded by the dashboard feedback flow. Card values and drilldowns are
per active user (see `admin_metric_*`).

Area usage: sections tagged with `data-area` are instrumented by a `trackAreas`
IIFE - an IntersectionObserver credits `area:<name>` when a section is >=60%
visible for >=2s while the tab is focused (per-area throttled), and a delegated
click handler credits `click:<name>`. Both go through `trackFeatureUse` into
`feature_usage`. The Insights "Most-used areas (per user, 30d)" panel reads
`admin_area_usage`; these prefixed sections are filtered out of the section-share
"How people use" chart and the platform-health section-usage table.

## 8a. Predictions

A main tab (`#main-predictions`, `renderPredictions` in `dashboard.js`) that
scores the calls the user makes in the popup / in-page widget.

Capture: alongside the existing Position taken / Target price / Rationale fields,
both surfaces expose an optional **horizon** select (1w / 2w / 1m / 3m / 6m / 1y,
or none), gated on a sentiment label like the other optional fields. It routes
through the `horizon` message -> `store.setHorizon` -> `patchLatest` (latest row
in both DBs) -> `events.horizon_days` / `intraday.horizon_days` (migration
`20260731_prediction_horizon.sql`). The deadline is never stored; it is derived
as `ts + horizonDays * 86400000`.

A prediction = a Positive/Negative event with a horizon, a target price, or both
(`isPredictionCall`). A call with a target but no horizon is open-ended: it has no
deadline, so it can only end in a hit (it never expires). Such rows are listed
(status Open / Hit, "no deadline") but kept out of the accuracy statistics, which
would otherwise count only their wins; a "Target-only calls" card counts them. An
open-ended call whose target is on the wrong side of the call has nothing to score
and is not listed. The watchlist's "Target hit" badge is the verdict of the same
row (`PRED.rows`, built in the background after every load by
`refreshPredictionRows`), so the two views cannot disagree; until the rows exist it
applies the same rules to the live quote. `buildPredictions()`
scores each one off the always-daily `DAILY` series (not the resolution-dependent
`SERIES`), on two independent axes:

- **Direction** - did the price move the way it was called, measured at the
  judging moment (the target touch if there was one, else the deadline close,
  else the live quote).
- **Target** - did a close (or the live quote) actually reach the target price
  before the deadline. A target on the wrong side of the call is dropped from
  target scoring (`badTarget`) but still counts for direction.

Statuses: `hit` (target reached in time), `expired` (deadline passed without it),
`open`. `progress` = realized / required return (signed, so it works for
Negative calls); `timeProg` / `timeUsed` = share of the horizon spent.

Visuals: a scorecard (open, due within 7d, resolved, direction and target hit
rates, progress when missed, median time used, Brier, edge vs NASDAQ), a **pace
scatter** (`drawScatterCanvas`: time used on x, progress to target on y, dashed
on-pace diagonal - above the line is ahead of schedule), hit rate by horizon
bucket vs a coin-flip bar, a cumulative track-record line, a timing-calibration
histogram of how much of the horizon elapsed before hits landed, and a filterable
table (Open / Resolved / All) with dual progress bars per row.

**Event study** and **Forecast Accuracy** live in this tab too (a separate
`data-area="event-study"` section, outside `#pred-body` so they still show when
no call carries a target price). Both score how well the labels read the market,
which is what this tab is about; they moved here out of Performance, which kept
only "Outlook mix over time". `showMain("predictions")` re-runs `renderAnalytics`
and `renderForecast` on every visit because their canvases size to 0 while the
tab is hidden.

Forecast Accuracy: the summary cards (overall hit rate, Brier, labelled events,
flip rate) from `ATStore.computeSentimentStats`, plus an accuracy **timeline**
(`forecastTimeline` / `drawForecastTimelineCanvas`, granularity `#fa-gran`
day/week/month persisted in `at_view`). `forecastOutcomes` reduces each
Positive/Negative label to a hit/miss over `FA_HORIZON` (21) trading days using
the same `DAILY` forward-return machinery as the Event study. Per bucket the
chart plots the positive and negative hit rates against a dashed 50% coin-flip
baseline on the left axis (0-100%), and on its own right axis (-1..1) the rolling
Pearson r of the overall hit rate against the NASDAQ return over the same buckets
(window 6 monthly / 8 weekly / 10 daily). Buckets with no resolved call carry
null so the lines break rather than reading as 0%. Two scales in one plot means
the generic tooltip formatter cannot help, so the chart passes pre-built per-point
HTML through `canvasHover[...].html`, which `attachCanvasHover` uses verbatim.

## 8b. Trades & research (broker imports)

My Habits > Trades & research (`dashboard/trades.js`, with its canvas drawings in
`dashboard/trcharts.js`, `data-pane="trades"`). My Habits is the first main tab and
Trades & research its first sub-view; the dashboard always opens there unless the URL
carries a `#tab` hash (the popup's "My Stocks" link opens `#performance`).
The user imports a broker's transaction export; the app measures how research
shows up in real decisions. CSV/XML import only for now; direct broker
connections and end-to-end encrypted sync come later.

Device-only by design: nothing in this feature talks to Supabase.
- `src/ledger.js` (`ATLedger`) sniffs and parses the file in memory into
  canonical records `{broker, extId, ts, date, dateOnly, kind, isin, symbol,
  name, assetClass, qty, price, priceCcy, amount, fee, tax, currency, plan}`,
  kind = buy | sell | dividend | withholding | adjust. Only these fields survive
  parsing; card spending, transfers, IBANs and names never reach a record.
  Unknown row types are counted by reason, never guessed. Formats: Trade Republic
  (23-column in-app export, the type table mirrors the Portfolio app's importer),
  Scalable Capital, IBKR Flex XML / Flex CSV / Activity Statement CSV, DEGIRO
  Transactions.csv (read by position, headers are localized; the Account
  statement is refused with a pointer), Trading 212, Revolut, Schwab, Freetrade,
  XTB, Saxo, a Stocktrails template, and a column mapper for anything else
  (`previewColumns` / `guessMapping`). Brokers that write local times without a
  zone are converted with an assumed zone (noted per parser); date-only rows are
  stamped at noon and flagged `dateOnly`. Missing broker ids become content
  hashes with an occurrence suffix, so re-importing a file is idempotent.
- `src/ledgerdb.js` (`ATLedgerDB`) stores records, instrument matches and the
  import log in IndexedDB `stocktrails_ledger`, keyed by owner (account id), so
  a second account on the browser never sees them. Extension-origin IndexedDB is
  out of reach of the content scripts, which can read `chrome.storage.local`.
  Not in the JSON backup; Settings > Clear all deletes it too.
- Matching (`trMatch` in trades.js): ISIN -> Yahoo listings via
  `ATPrices.searchSymbols`, then the tracked stock whose Yahoo symbol is among
  them, confirmed by `ATLedger.nameSimilarity` (legal forms and share-class
  words stripped, abbreviations expanded, fuzzy token + trigram match). A bare
  ticker is never enough (BA vs BA.L). Status matched / check / untracked; the
  user can override any row (`manual`). The tracked-stock list holds only
  stocks with recorded views (the closest names first); an untracked instrument
  can still be given a price symbol from its Yahoo listings, so its returns and
  the portfolio line include it.
- `src/decisions.js` (`ATDecisions.analyze`, pure, Node-testable): fills ->
  decisions (one instrument, one side, one day) classified open/add/trim/close;
  savings plans (broker flag or 3+ regular buys of similar size) and
  derivatives/bonds/crypto are set aside, as are decisions before first recorded
  attention + 30 days. Five questions: (1) research in the 30 days before, with
  a permutation timing test on views in the prior 7 days; (2) call vs action
  agreement, Positive call -> buy conversion, Negative -> sell, position-taken
  check, drawn as one bar per kind of call (acted share with a Wilson range).
  A Negative call counts only for a stock held at the call (`heldAt`: a
  position in the file's timeline, or a later sale larger than the file's
  position, which proves shares from before the file: `preHold`); a Negative call on
  a stock not held cannot be acted on without a short sale, so it is scored on its
  own as an "avoid" call (63-day excess return vs NASDAQ, share that lagged, 2b).
  Calls before the file's first record (`coveredFrom`, default the first record)
  are not judged: a purchase just after them could be missing;
  (3) 21-day excess return vs NASDAQ, researched vs not (bootstrap CI),
  plus thirds by research time; (4) attention-spike share for buys vs sells,
  run-up from first look to buy, post-trade monitoring; (5) 63-day excess return
  of Positive calls passed on vs buys, plus the whole path day by day
  (`forwardPath`; mean per day with a bootstrap band that resamples whole paths,
  `pathBand`), medians, hit rates, and the worst passed calls next to the best. One stock can carry the comparison (a stock bought and called many times that collapsed): `influence` names the stock whose removal moves buys minus passed calls the most and gives the result without it.
  Extras: disposition effect (Odean PGR -
  PLR, cost on Yahoo closes), horizon discipline, dividends. Each result carries
  n, a status (none / indicative / solid against `NEED`) and `clear` when the 95%
  range excludes no effect; the UI shows a sufficiency panel with an ETA at the
  user's decision pace.
  More questions (same module, same status logic): the FOMO check inside (4)
  (move from the call to the buy; buy rate for Positive calls whose stock rose
  vs fell up to the decision point - the buy day, or call + your median
  call-to-buy delay - so later moves cannot leak in) and, also in (4), buys
  after the price rose vs fell since the first look, next month vs NASDAQ
  (bootstrap 95%); (6) page types in the 30
  days before a researched buy, with vs without each type, 99% bootstrap range
  because several types are tested at once; (7) when and how fast you decide:
  impulse trades (first recorded view under an hour before a timed decision;
  date-only brokers counted as same-day separately), the distribution of first
  view -> buy in buckets (hour, day, week, month, quarter, year, longer, no view)
  with the next month's return per bucket, and buys by local hour of day: views
  and buys per hour, and day-parts each compared with all other buys (99%
  bootstrap range). The day is cut into fixed parts, into the user's own buying
  clusters, or into parts the user defines (a list of start hours, 0-23, each part
  running to the next start and the last wrapping past midnight: `customBlocks`,
  stored in `at_tr_custom` and part of the analysis cache key); one switch, shown in
  both 7c and 7d, picks among them. Fixed parts (night / morning /
  midday / afternoon / evening) or, when buys form at least two clusters
  (`buyClusters`: 24-bin histogram of buy times smoothed with a wrapping
  kernel, peaks >= 25% of the highest, at least 3 hours apart, each part >= 3
  buys, boundaries at the deepest valley between peaks), into the user's own
  clusters. The clusters use only WHEN buys happened, never their returns, so
  choosing the cuts does not peek at outcomes, and they leave fewer buys near a
  boundary. Every verdict is recomputed with all boundaries moved an hour
  earlier and later; advice uses only a `robust` block (clear, same direction,
  in all three), and the card shows the share of buys within an hour of a
  boundary. A grid of conviction bands x day-parts shows the next month per cell
  (values from 5 buys); it is descriptive, not tested. Conviction bands are
  either thirds of the user's own buys or the watchlist's fixed colour bands
  (up to 1, up to 3, over 3, `convBands`); the score is >= 0 by construction
  (log2(1 + views) x (0.5 + 0.5 x scroll) x (1 + 0.1 x focus)), ties at 0 stay in
  the lowest band, and the day-part and band choices are remembered
  (`at_tr_hours`, `at_tr_conv`); (8) Spearman of the windowed conviction score vs size
  relative to the usual buy at the time (`trailingSizes`: the median of the buys in
  the same currency over the previous 6 months, 12 or 24 when that holds fewer than
  4 buys; at least 4; earlier buys only, so a portfolio that grows does not make
  every later buy look large, and a window of months rather than the last few buys so
  that a calm or turbulent stretch is not learned away); (9) holdings (a total
  return: net dividends after withholding are added on their pay date) vs an
  attention baskets of every viewed stock with a price (up to
  `TR_INDEX_TOP`, 300; a "most viewed over the whole period" universe would
  pick names by later attention, often earned by rising, and flatter it). The
  basket held from the close of day d is set by views before the 16:00 ET close of
  d minus the decision lag (`lagDays`, default 1, selectable 0-14), so a view is
  never used at a price that had already printed. Two baskets are drawn: Recent attention (weights = views in the
  trailing window, `windowDays`, 7-365 days, default 30, `at_tr_win`; a stock you stop
  viewing drops out when its last view leaves the window; with no views in the window
  the last basket is kept) and All attention so far (weights = all views to date,
  never dropped; an idle stock only loses weight as others collect views). The second is the My Stocks Index's "Hold everything attended" +
  "Attention-weighted" idea, but not the same computation: that Index starts at each
  stock's own first view, counts views from its daily event list and can be in USD,
  while Q9 starts on the first day a priced holding exists and counts every view;
  vs NASDAQ, daily compounding on yesterday's weights, holdings valued at purchase
  amount moved by price (no later FX, cash and dividends ignored). With no views
  in the trailing 30 days the attention basket is kept rather than moved to cash
  (quiet spells after a history import read as flat lines otherwise); days when
  only unpriced instruments are held are gaps (null), not flat; both lines start
  on the first day with priced holdings and an attention basket; (10) the
  market's mood, per buy: the NASDAQ as the bars BEFORE the trade day show it
  (`marketSeries`/`barBefore`: volatility = stdev of the last 20 daily returns,
  return over 20 bars, distance from the 252-bar high), placed among every trading
  day of the covered period by percentile (`pctRank`, ties half) so that a tilt is
  judged against the base rate. 10a: size by regime (thirds of those days by
  volatility: calm / normal / turbulent), the size of each buy against the usual
  buy, a strip plot, the share of buys per regime vs the share of days, Spearman
  of volatility percentile vs size and the log2 size difference turbulent - calm.
  10b: dip or chase = mean percentile of the 20-day return (or of the distance
  from the high) on buy days, a size-weighted version (weights capped at 5 usual
  buys), and the share of buys per fifth of days against 20%; below what chance
  gives = buys weakness, above = buys strength. Chance is found by `shiftTest`: the
  whole pattern of buys is slid along the calendar by every possible shift (wrapping
  round) and every statistic recomputed, so the buys keep their spacing and bursts,
  the market keeps its calm and turbulent stretches, and only their alignment is
  broken. That gives a 99% range and a two-sided p per statistic (clear = p <= 0.01,
  several are read together); a bootstrap would be too narrow because neighbouring
  days and neighbouring buys are alike, and a strictly periodic market would never
  reach it (the test needs the covered period to hold at least 120 trading days).
  The next month vs NASDAQ by third of days is an ordinary bootstrap (95%).
  10c: weekly views vs the same week's volatility (95% Fisher; no decision
  involved). (11) first close at or above a Positive
  call's target while held, and a sale within 14 days or not; (12) the
  disposition effect and (13) holding vs the call's horizon. The shared
  `posCalls` list (Positive calls on stocks not held; a repeat within 30 days of
  the last counted call on that stock is a reconfirmation and counts once; with
  the buy that followed) feeds (2), (4) and (5) alike. A peer
  comparison card renders only when the community series shows more than
  `TR_PEER_MIN` (100) active users, and then only as "coming with opt-in".
- The view opens with a separate panel, "What your trades say about you":
  `trFindings` turns every question with at least an indicative result into a
  plain-language pattern (clear ones first), each with an investing quote from
  `TR_QUOTES`; quotes without a primary source we could confirm are marked
  "attributed". Dividend totals are listed under "Your imported data".
- Directly under that panel, whenever there are trades, sits the pre-trade check
  ("Check a buy before you place it", `trCheckHtml` / `trCheckOut` in
  `dashboard/coach.js`): pick a stock and an amount, and it lists what is measured now
  (30-day move, first look, visits, the market's state, size against the usual buy,
  ...) and which adopted rules object. Without an adopted rule it still runs and says
  so. `trReportHtml`, `renderTrades` and `trCheckOut` call `trAgentHtml(R)`,
  `trAgentAfterRender(R)` and `trCheckExtra(tk, ctx, R, amt, ccy)` when they are defined;
  `dashboard/shadow.js` defines them (section 8c).
- Coach (`src/biases.js` `ATBiases`, pure and Node-tested; UI in
  `dashboard/coach.js`, under the findings panel). No model and no network:
  every number is a statistic and every rule's wording is fixed text with the
  user's own numbers filled in. `detect` turns results into named biases (chasing,
  impulse, a bad time of day, oversized buys in turbulent markets, not acting on
  one's calls, ignored targets, buying without research, plus advice-only ones for
  the disposition effect and sizing); a bias is "detected" only when at least one
  signal is clear, otherwise it is listed under "keep an eye on". `RULES` holds a
  concrete rule per bias, each with a plain statement, an "In short" instruction ("Do more research first.") and a reason it fires now (wait after a run-up of more than X% in the last 30 days, which does not grow with how long a stock has been researched, sleep on it, avoid a day part, pause
  or cap the size in turbulent markets, wait after strong market stretches,
  research before buying, sell at the target, act on your calls), each with a grid
  of settings, a `flag` (the rule says "do not"), the `gain` of not doing it (what
  skipping or capping the buy would have been worth against the NASDAQ, assuming the
  skipped money earns the market) and plain-language text.
  `validate` is the honest check: a chronological walk-forward. The first half of the
  decisions is only ever training; the rest is cut into up to 6 blocks; for each block
  the rule is fitted (the setting with the largest mean gain times the square root of
  how many it flags; at least 5 flagged, at most 60% of the decisions, mean gain above
  0) on decisions whose outcome was known before the block began (an embargo: a buy's
  return runs for about a month; a unit's `tEnd` is the close of its outcome's last bar,
  `end` from `ATDecisions.forward`, so weekends and holidays count), then applied to the block. A fold in which no
  setting helped recommends nothing. Only the gains on the later blocks are pooled:
  `supported` (99% bootstrap range above 0), `indicative` (95%), `unclear` (positive
  but within chance), `unsupported`, `untested` (fewer than 24 decisions with an
  outcome or 8 flagged out of sample). The UI shows the in-sample figure beside it,
  because it flatters. `commit` makes a rule the user adopts into a commitment, stored
  in `ATLedgerDB` store `commitments` (added in IndexedDB version 2, per owner, device-only,
  deleted with the trades). `adherence` then reports, for decisions since adoption,
  how often the rule was broken, the same over an equally long stretch before (a
  Newcombe interval for the change), and the next month vs NASDAQ of the decisions that
  kept it against those that broke it (an association: nobody was assigned to comply).
  `simulate` replays a rule over the whole history (in sample) and `preTrade` checks an
  intended buy (stock, amount, time of day, the market now) against the adopted rules;
  facts that cannot be known are reported, never guessed. `progress` ("Are you leaving
  your biases behind?") reads each rule as a habit, measured with the adopted setting,
  else the fitted one, else a fixed default, and compares the last 180 days with all
  earlier decisions (99% Wilson ranges, Newcombe range for the change, a score test of
  the trend over the whole history, shares by half year). A habit about the market is
  judged against the share of trading days in that state in each period
  (`R.market.days`), since it moves with the market itself. Tests: `node tools/test-biases.js`
  on synthetic investors from `tools/synth-world.js` (planted effects are found and hold
  up out of sample; 0 of 216 rules pass in worlds with no effect; an effect that stops
  halfway does not pass; the embargo is respected; a habit planted to fade or grow is
  found, and few are called either way in worlds with no change).
- The questions are grouped by decision stage (`TR_GROUPS` in `dashboard/biascards.js`):
  A Research & attention, B Buying, C Your calls, D Selling & holding, E Portfolio &
  activity. Each group is a collapsible `details.tr-group` with a count of cards that
  have enough data; groups with none start closed, and the user's choice is kept in
  `localStorage` `at_tr_groups`. Cards keep their internal keys (`q1`..`q13`, and named
  keys for the indicators) and show a group label instead (A1, B2...; `TR_CARD_LABEL`),
  so regrouping never renames stored state. Card C1 links to Predictions for call accuracy.
- Bias indicators, phase 1 (`src/indicators.js` `ATIndicators`, pure and Node-tested;
  design in `docs/bias-indicators-design.md`): `analyze(input, R)` runs on the same input
  as `ATDecisions.analyze` plus optional community data, and is attached to the report as
  `R.ind`. A "book" rebuilds each instrument's position and average cost (on Yahoo closes)
  after every trade day; values are converted to the settlement currency at the rate of the
  buys. Indicators: ostrich effect (A5: views of held positions after a rise vs after a
  fall, week-block bootstrap; reading depth; Kaplan-Meier time to the next look after a 10%
  move), confirmation (A6: call changes after sharp moves against vs for the call, needing
  5+ changes overall; reading mix before/after a call; page-type entropy), herding (A7:
  first looks after a community or trending-list spike, against each stock's own rate of
  such days; needs `network_community_daily`, `trending_daily`, `world_crowd_overlap`,
  fetched once per session by `trCommunityData`), rank effect (D4), myopic loss aversion
  (D5, positions bought with a horizon of a year or more), repurchase regret (D6),
  holding-period survival of winners vs losers (in D2), overconfidence (E3: turnover,
  the Odean test on sale -> buy switches, research per trade by month) and
  under-diversification (E4: positions, HHI, correlation, repeated buy amounts against a
  local shuffle) and timing against a savings plan (B7: each buy against an index twin that
  is cut by the same sales, timed buys against plan buys and against the same money as a
  monthly plan in the same stocks; see docs/bias-indicators-design.md section 12). Ostrich, confirmation and herding need no broker import (ostrich then
  reads holdings from "Position taken" labels), so without an import the pane shows the
  import panel and under it groups A and C, with the trade questions as previews
  (`trRenderCallsOnly`). `biases.js` turns the indicators into named biases
  (`detectIndicators`) and adds two walk-forward rules, `no_quick_switch` and
  `hold_through_dips`. Price history is fetched from 100 days before first use, so the
  sharp-move test has 60 trading days behind it. Tests: `node tools/test-indicators.js`
  (each indicator finds a planted effect and stays quiet without it).
- Bias indicators, phase 2 (same module): extrapolation (B3), lottery stocks with
  fixed thresholds (B4, `LOTTERY`), buying after abnormal volume (B5), anchoring (C4:
  round targets, 52-week high, break-even sales, target drift), target calibration
  (C5, works without trades), sector/country concentration (in E4) and home bias
  (E5). Price history now starts 400 days before first use, and `parseChart` keeps
  daily volume on each bar. Sectors come from `ATPrices.fetchProfile` for held
  instruments and the 60 most-viewed stocks (`trProfiles`). Countries come from the
  ISIN prefix, or the Yahoo symbol suffix for views, against approximate MSCI ACWI
  weights (`ATIndicators.ACWI`, with an as-of date). The home country is the
  Settings > Data picker (`at_home_country`, device-only), else the IP country in
  `at_geo_v2`; a VPN exit leaves it blank. Coach rules `avoid_extrapolation` and
  `cap_lottery`; the pre-trade check also states lottery status, 12-month return
  rank, distance from the high and the buy's weight in the depot.
- Bias indicators, phase 3: limited attention (A8). It measures the latency from an
  earnings release to your first view of the stock's financials, earnings, estimates or
  news. Inputs are the releases of stocks you viewed in the 90 days before or held; the
  latency is a Kaplan-Meier median, with 14 days unread counting as missed, compared
  for Friday vs other days and busy vs quiet days. Earnings dates come from
  `earnings_for()` (`trEarnings`, US listings only; others are counted as "not
  measured"). Card A7 also shows a community herding line: an LSV-style measure on
  `community_first_looks_daily()` (`ATIndicators.communityHerding`).
- Buying with the crowd (B6, `crowdBuys`): buys made while other Stocktrails users piled
  into the stock. `ATIndicators.crowdIndex(community, events)` takes the user's own
  views out of `network_community_daily` (which counts them) the way the RPC counts them:
  each daily event's `views` on the New York day of its ts (the last view of a merged
  chain; at or after 16:00 ET is the next day), not the intraday rows; `crowdAt(ci, ticker, ts)`
  gives others' views on the 3 days before the buy's New York day against the stock's own
  rate on the 30 days before that (`ratio`, `hot` = 3+ views and twice the rate), from
  earlier days only. Chance is each stock's share of hot days in the 180 days before the
  buy; the excess has a bootstrap over stocks. Hot-crowd buys against the others at 5,
  21, 63 and 126 trading days, each with a 99% range. Coach bias `crowd_buys`, rule
  `wait_crowd` (on `crowdBuys.buyUnits`, `f.crowd` = ratio; also a habit in
  "Are you leaving your biases behind?"), and the pre-trade check's `ctx.crowd` from the
  session's community data (`TR.comm`). Without community data (signed out, offline) the
  card says so. `tools/synth-world.js` option `crowd: {follow, edge21}` adds community
  rows (own views included) from a separate random stream, so other worlds are unchanged.
- Forecast accuracy: the Brier score tooltip (`BRIER_HELP`) gives the thresholds for reading a score (0.25 = always answering Neutral; break-even hit rate 67.5% with the fixed 85% / 15% confidences).
- Sub-questions: a card with several parts shows each as a tinted panel with a tag
  (4a, 4b, 4c; 7a to 7d), including its first part, so none looks different from the
  others; such cards carry no status chip of their own. Cards 4 and 7 only.
- Matched stocks: edits (tracked stock, price symbol, "looks right", "mark all
  as right") are queued in `TR.pendingLinks` and applied together, so the
  analysis re-runs once instead of after every row.
- Planned: a reminder on the broker's order page that summarises the user's
  research on that stock before they trade - research time, labels over time,
  and their own comments (how they evolved, summarised) - issue #13. Needs broker-side integration (an extension content script on
  the broker's web app) and the encrypted sync for any cross-device use.
- Feedback screenshots skip `[data-private]` regions (html2canvas
  `ignoreElements`), which the trades pane carries.

Browsing-history backfill (Settings > Data, `src/history.js` `ATHistory`): a
Google Takeout Chrome export (JSON) or a history CSV is parsed in memory. JSON
entries are found by shape (any object with `url` / `titleUrl` / `virtual_url`
and `time_usec` / `timestamp_msec` / ISO `time`) because the layout is
undocumented; My Activity `google.com/url?q=` links are unwrapped. CSV needs a
URL column and a visit-time column (`timestamp`, `lastVisitTime`, ...); numbers
are read as ms / s / microseconds, or Chrome's 1601-epoch microseconds, by
magnitude. A CSV from `chrome.history.search` (Comet and other Chromium
browsers) lists each PAGE once with its last visit time and a `visitCount`, so
it yields one visit per page and the other visits cannot be placed in time:
views are understated, and the importer reports how many (`unplaced`).
`ATPortals.detect` keeps only portal URLs. The URL-only research classifier
moved from content.js to `ATPortals.classifyUrl` so both paths share it.

Which visits are added is decided by `ATHistory.newVisits`, not by a cutoff
date: a visit of the same stock within a minute of any existing view (live
capture, an earlier import, or the same visit in a second export or browser) is
the same visit and is skipped. A cutoff at the first recorded view would drop
research done in a second browser after the extension was installed, and
counting a Chrome and a Comet export of the same period twice would inflate
views. The account is synced first so other devices' rows are checked too.
`ATStore.importVisits` adds the rest in one pass with the same 30 s /
dedupe-window rules as live capture (joining an existing daily event within the
window rather than stacking a second one), `updatedAt` = now so the rows push,
that day's close as `priceAtEvent` and `source = "history"`. These rows are
ordinary attention data and sync.

Appearance (Settings > Appearance): `src/theme.js` (loaded from `<head>`, an
extension page cannot use an inline script) sets `html[data-theme]` from
`localStorage` `at_theme` (dark | light | system) before first paint. The
stylesheet takes every neutral colour from CSS variables (`:root` holds the dark
values, `html[data-theme="light"]` overrides them); canvas drawing reads the same
variables through `TC()` in dashboard.js (cached, reset on a theme change, which
also re-renders the visible tab). Not themed yet: the toolbar popup and the
in-page label widget.

Page layout: every view spans the full width of the window (the header and the
content share the same side padding); the Trades & research cards flow into as
many 620px-minimum columns as fit, so a wide screen is used rather than left
empty.

Watchlist sorting: every column heading except the delete column sorts the
table (`WL_SORT`, remembered in `at_wl_sort`). The first click uses the natural
direction (A to Z for text, largest first for numbers), the next reverses it;
stocks without a value (no label yet, no sector) go last either way. With no
sort chosen the order is by symbol, as before.

## 8c. AI layer (optional assistant)

Design, data flow, tiers, controls and risks: `docs/AI.md`. In short:

- On only when the user ticked the assistant's own, optional box at sign-up (or in the one-time terms prompt, or pressed "Turn on the assistant"; `ATAI.grant`, `at_ai_consent`), unless switched off. Accepting the Terms of Use and Privacy Policy (`dashboard/terms.html`, `dashboard/privacy.html`; `ATAI.acceptTerms`, `at_terms`) is a separate, required tick: the sign-in buttons work only after it, and a signed-in user without an accepted `TERMS_VERSION` gets a one-time prompt (accept or sign out) before the app opens. "Turn the assistant off" sets `at_ai_off` and it stays off; the function
  answers every signed-in user by the code default since 2026-10-17 (`LIMITS.allowAllByDefault`;
  temporary), or only accounts in `AI_ALLOWED_USERS` once `AI_ALLOW_ALL=false` is set. Two
  deciders work side by side on the same statistics: the rules agent (src/shadow.js, no model) is
  deterministic, the AI agent (a language model) is stochastic; src/biases.js has no model in it.
- `supabase/functions/ai-coach/` (`index.ts` wires Deno and Supabase; `core.mjs`
  holds every rule and is tested by `tools/test-ai.js`): verifies the JWT, counts the
  call per user and UTC day in `ai_usage` through `ai_usage_bump` before the model is
  called (migration `20261010_ai_usage.sql`, service role only), keeps the system
  prompts, accepts the tasks `step` (the agent), `plan`, `answer`,
  `classify_rationales` and `decide` (the AI agent's paper decisions, see below), validates the model's tool choice against a fixed read-only
  catalogue and its proposed actions against `ACTIONS` and the results, refuses real
  stock names unless `AI_NAMES_OK=true` (403), refuses a payload that
  looks like raw trade data (`looksPrivate`, 422), and calls the model: OpenRouter chat
  (primary, `AI_PROVIDER=openrouter`, `data_collection: deny`), or Cerebras chat (`AI_PROVIDER` selects the provider). With `AI_DECISION_MODEL` set,
  `classify_rationales` and `decide` go to an OpenRouter decision model
  (`/api/alpha/decisions`, one request per item); a moment where its chosen action is below
  `AI_DECIDE_MIN_P` is not decided (listed under `unsure`; docs/AI.md, "Models per task"). Each
  decision-model decision carries its odds (`trace`), the reply its `engine` and `spend`; a `decide` request may
  force a route with `engine: "text" | "decision"` (the model comparison).
  `AI_PROVIDER=mock` runs it without a model.
- `src/aitools.js` (`ATTools`): the tools, T0 read-only, built from allowlists;
  stocks are "Stock n" (`session.alias`), sizes are multiples of the usual buy, dates
  are months, and every result passes `isPrivate()` (with the names opt-in,
  `ctx.useNames`, stocks go by ticker). `checkNumbers` compares the numbers in a reply
  with those in the results. `weeklyReview` builds the review of the last N days
  (attention, calls, trades via `periodStats`, adopted rules broken via
  `ATBiases.brokenIn`).
- `src/aiclient.js` (`ATAI`): consent, the request log ("What was sent", exportable,
  `at_ai_log`), and `ask`: the agent loop, up to 5 `step` requests, running the named
  tools on the device between them; the answer's proposals and actions become cards
  (a retune card carries `ATBiases.whatIf` numbers).
- `src/rationale.js` (`ATRationale`): the notes written with calls are redacted,
  classified once (by the service) and cached by hash (`at_rationale_v1`), then joined
  to the 63-day outcome of the call (`R.calls`) with 99% bootstrap ranges.
- `dashboard/ai.js`: the assistant is a side panel (the weekly review card, consent
  card, names opt-in `at_ai_names`, chat, action cards done only on a click: rules
  through the coach's own commitments, reminders and notes as commitments with `kind`
  `reminder` / `note` in IndexedDB, shown by the pre-trade check and the coach; the log), opened by a floating button
  and following the Trades pane; the AI agent reads the notes written with calls by itself (`trAiNotesAuto`, shown in its card in the AI agent section; there is no separate Assistant section on the page, only the side panel). `ATCloud.aiCoach` calls the function.
- The agent simulation (the agents' paper portfolios): `src/shadow.js` (`ATShadow`, pure, tested by
  `tools/test-shadow.js`) runs a rules agent point in time (monthly snapshots of the rules
  that held up, `ATBiases.fit` / `walkForward` on units known by then; buy, wait up to 10
  trading days, or pass; caps cut the size) on the user's buys and looks, and builds the
  portfolios (you, rules agent, AI agent, NASDAQ, as a share of the money put in), the
  paired results at 21/63/126 trading days and the before/after comparison around the
  first live (not history-imported) view. Looks are dated by their New York trading day
  (16:00 ET rollover). `ATShadow.contextFor` describes one candidate for the model, from
  data before its moment only (its `rulesAgent` is `ATShadow.rulesView`: buy or wait
  and the fired rules at that moment, never the wait length or a pass); `ATAI.decide`
  sends up to 15 (task `decide`; `names` as for `step`) under ids of that request only
  (`c1`...) and maps the answers back, and the stand-in model follows `rulesAgent`
  (buy at its size, or wait 1 day). Its log keeps `decide` bodies whole and apart from the
  other entries. `dashboard/shadow.js` implements the trades
  page's hooks: `trAgentHtml` (the section: summary, trades/looks tabs, chart, horizon
  toggle, before/after table, latest decisions, the AI agent deciding the moments of the last 2 days automatically, in requests of 15, with
  progress, stop and resume, and the names note), `trAgentAfterRender`
  (the chart, loading the saved decisions) and `trCheckExtra` (the rules agent's verdict
  in the pre-trade check; the AI agent's own answer sits directly beneath it, asked automatically when the assistant is on).
  Every run of the pre-trade check is saved in `ATLedgerDB` store `checks` (database version 4;
  `putCheck`, `updateCheck`, `getChecks`; device-only, cleared with the account's data): the
  stock, amount, currency and last close, everything measured (`ctx`), the adopted rules in force,
  which objected or could not be checked, the size cap, the rules agent's verdict and the AI
  agent's answer with the model, `promptVersion` and the exact input sent (`ai`), for evaluating
  the checks later. Version 5 added `reruns` (recent moments decided again by the text model and
  the decision model); no page reads it since the model comparison section was removed. Every paper decision is saved once in
  `ATLedgerDB` store `agent` (database version 3; `getAgentDecisions`,
  `putAgentDecisions`, which writes only ids not saved yet, cleared with the account's
  other data); the AI agent is only asked about moments at most 2 days old (`trAgentUndecided`), and a stored AI decision made later than that is ignored.
  The assistant explains the page itself through `explain_section` (static texts in `src/aitools.js`,
  `SECTIONS`, which mirror the info texts of `dashboard/shadow.js` and `ATShadow`; the server lists the ids
  in `SECTION_IDS`, so changing a section's calculation means changing its text too). The button
  "All decisions side by side" (`trAgentCmpOpen`) lists every moment with what you did, the attention
  index's share of the stock then, and both agents' decisions. The assistant reads the portfolios through `get_agent_portfolio` (ratios only), and what the agents
  decided on single moments and why through `get_agent_decisions` (the saved record and the saved
  checks, loaded by `trAgentEnsure`; aliases, months and days ago, no amounts, a model's own alias in its
  text replaced by the assistant's). Each saved decision keeps its reasoning: the rules agent's `why`
  (readings of the rules that acted), `features` and `active` rules; the AI agent's `reason`, `reasoning`,
  `engine`, `trace` (a decision model's odds) and the exact `input`; the page opens it with "why" under
  each agent and states a size as a share of the amount (in your own money for a buy or a check).
  The "Paper portfolios" chart (`dashboard/shadow.js`, `trAgentPp*`) draws `ATShadow.agentPortfolios` (`S.agents.trades` / `.attention`:
  time-weighted indices per portfolio, all fully invested (money a smaller buy leaves goes into what is held, in proportion; a sale's money leaves the portfolio; savings-plan buys are made by every portfolio at your weight), sizes as final weights,
  `sizeUnit` on saved decisions, `holdings` per line at every month end) with a two-handle timeline. The attention view's attention-weighted
  index (`lines.att`: 30-day window, 1-day lag, `ATShadow.LOOK_WINDOW` / `LOOK_LAG`, rebalanced at every close from the first look) and the
  rules agent's basket (the same, each stock from the day its rules let the look through) are simulated there, not taken from `recomputeQ9`. The older paired results and looks lines are still worked
  out by `run()` for the assistant's `get_agent_portfolio`. Prices and buy amounts are converted to the currency of your buys
  at each day's rate (`input.fx`, filled by `trAgentFx` from dashboard.js `loadFx`). `run({ commitments })` adds the buy
  rules you adopted in the coach to every month's rules (`withAdopted`).
  Under each chart a "Holdings over time" button opens a window of stacked bars per portfolio at every month end
  (`portfolio().holdings` for the trades view, `ATShadow.looksHoldings` for the looks lines; the bars add up to the lines,
  tested); hovering a bar opens a scrollable list of every holding. The info about the AI agent sits in the table's
  AI agent column header.
  `ATShadow.compareRuns` (pure, tested) summarises runs of the two routes; `tools/compare-models.js` runs the same on a
  synthetic investor with the real APIs. `tools/sandbox.js` with `?engines=1` fakes both models to try it.
- `tools/ai-smoke.js` checks the request and reply shapes against the real API with a
  key; `tools/synth-world.js` provides the synthetic investors.

## 9a. World (community view)

A main tab visible to every signed-in user. While the feature bakes, only
admins see the content; everyone else sees a bare "Coming soon." card
(`#world-coming` vs `#world-content`, gated by `IS_ADMIN` in `dashboard.js`,
set by `maybeShowAdminTab`).

Content: an SVG choropleth world map (`vendor/world-map.js`, path data derived
from Simple World Map, CC BY-SA 3.0, keyed by ISO 3166-1 alpha-2) driven by a
replayable time axis over the last 60 UTC days (`WORLD_DAYS`), trimmed at the
front to the first day that actually has data - the window is fixed but the
history behind it is younger, and an axis that opened on a long run of empty
days made a replay look broken rather than empty. The time-control strap
(restart + play + slider + day label) sits UNDER the map; play animates day
frames (~350 ms each) from the current day; restart (⏮) always begins at the
first day on the axis, since play resumes where a pause or a scrub left the
frame. Reaching today hands off to the live feed (today's still-accumulating
data, refetched every 60 s while the tab is visible; the slider scrubs and
pauses). A refetch holds the scrubbed DATE, not the frame index, so a parked
frame does not slide onto another day as the window rolls. Seven modes: the first five per day from one dataset (`world_country_daily` +
`world_country_top_stock_daily`, migration `20260705_world_daily_network.sql`), the last two
whole-window scalars:

- Attention - colour intensity = community views that day (sqrt scale).
- Top stock - most-viewed ticker per country as a map label, anchored on the
  country's largest landmass (`worldLabelBox`).
- Research time - active minutes per user that day (green scale).
- Hit rate - share of that day's positive/negative labels whose direction
  matched the move since (diverging red < 50% < green). "Move since" uses the
  latest community-observed `price_at_event` per ticker as the price-now proxy.
- Return / view - average return-since-view per view made that day (diverging
  around 0, domain fixed across the window so replay frames compare).
- vs NASDAQ - a whole-window per-country scalar (not per-day): Pearson r of that
  country's daily views vs the previous trading day's NASDAQ return
  (`computeWorldCorrByCC`, needs the `^IXIC` benchmark loaded by
  `ensureWorldBench`), diverging red/-1 .. blue/+1.
- vs crowd - a whole-window per-country scalar: cosine similarity of the
  country's ticker view-distribution vs the GLOBAL distribution
  (`world_country_crowd_similarity`, migration
  `20260707_country_crowd_similarity.sql`, loaded by `ensureWorldSim`), sequential
  base->purple. High = the country researches the mainstream mix; low = a
  distinctive set.

Layout: the map is on the left (`.world-left`) with the replay strap beneath it;
the per-country table sits to its right (`.world-right`, scrollable) using the
otherwise-empty space, and stacks below the map under 900px. Hovering a country
shows a tooltip with an inline 30-day SVG sparkline of that country's value in
the current mode (`worldSparkline`), now with min/max y-axis labels, the latest
point marked, and a precise "latest" caption. The community attention-vs-NASDAQ
panel that used to sit below the map moved to My Habits > Market correlation
(section 8). "Trending now" (Community > Trending, `world_trending`, migration
`20260926_trending_per_user_and_community_daily.sql`) scores today's views
against the ticker's trailing 7-day views PER ACTIVE USER scaled to today's
audience: expected = prior views-per-user x active users today, heat = (views
+ 1) / (expected + 1). With a flat audience that is the old score; with a
growing one, growth alone no longer makes every ticker read hot.

VPN category: a user whose IP points elsewhere than they are is recorded under
the user-assigned ISO code `XV` and drawn as one "VPN" bubble in the map's
empty south-west corner (`buildWorldMap`; it carries the `wm-c` class, so the
fill loop, tooltip and table treat it like a country). Two signals: the `geo`
function returns `XV` when ipapi.co's `org` matches a datacenter / VPN
provider (old clients get this too, they only read `country`), and newer
clients (`resolveCountry`) compare the IP country with the country of the
device clock's IANA zone - a VPN moves the IP but not the clock. Known false
positives: a manually pinned clock, roaming data routed via the home country.
The geo cache is 3h (`at_geo_v2`) so a VPN session is caught and left promptly.
Past CH intervals of the one known VPN user were relabelled `XV` by hand.
Two more signals: impossible travel (the geo function also returns the IP
location rounded to 0.1 degree; `resolveCountry` flags a new country more than
300 km from the last genuine fix at over 1000 km/h, and only a fix that passed
every check becomes the new baseline, `at_geo_fix`), and switching behaviour,
judged server-side in `record_country` (migration
`20260926_record_country_vpn_hops.sql`, so old clients are covered too): A -> B
-> A with B under 72h relabels B as `XV`, and with 3+ changes inside 7 days every
finished sub-72h interval outside the home country (most time over 30 days)
becomes `XV`. History before the migration is not rewritten.

You vs the crowd (`world_crowd_overlap`, migrations
`20260706_crowd_overlap_and_rationale.sql` and `20261017_community_privacy_floors.sql`,
which counts only days with 20+ active users and (day, ticker) cells with 5+ users,
since without floors the 4-decimal result let a caller solve for other users' views): per UTC day, the cosine similarity
between the signed-in user's ticker view-vector and the whole community's
(1.0 = you research exactly what the crowd concentrates on). It is the user's
own scalar (only aggregate community counts feed the denominator), so unlike the
other `world_*` RPCs it is NOT admin-gated - the same `renderCrowdOverlap`
panel also appears in the (all-users) Attention section.

Country attribution is IP-based: the `geo` edge function (verify_jwt=false)
resolves the caller's IP (`cf-connecting-ip`) to a country via ipapi.co;
cloud.js `resolveCountry()` caches the result for 3h in
`chrome.storage.local` (`at_geo_v2`) and falls back to the browser locale
region / IANA timezone table (`vendor/tz-countries.js`) when the lookup fails.

Attribution is point-in-time, not current-location (migration
`20260801_country_history.sql`). `public.user_country` holds half-open
`[from_ms, to_ms)` intervals per user; the `record_country` RPC, called from the
best-effort `trySync` update alongside `user_meta.country`, closes the open
interval and opens a new one only when the country actually changes, so the move
is stamped at detection time (bounded by the 3h geo cache). Every `world_*` RPC
joins `user_country` by `ts` range instead of joining the user's single current
country, so a user who moves does not drag their history to the new country.
`user_meta.country` remains the current-country denormalisation used by the admin
views. Rows recorded before this migration are seeded as one interval from
`from_ms = 0` - nothing stored (no per-event timezone or IP) can reconstruct
earlier moves, so a known past move has to be split by hand (SQL in the migration
header).

The map RPCs (`world_country_daily`, `world_country_top_stock_daily`,
`world_country_crowd_similarity`) are gated by `public.is_admin()` like the admin RPCs; opening
the map to everyone later means relaxing that guard and adding a k-anonymity floor.
`world_trending` and `world_crowd_overlap` are open to every signed-in user and carry their own
floors (migration `20261017_community_privacy_floors.sql`; `world_trending` shows a ticker only
with 3+ users, admins excepted).

## 9b. Network (community relative stats)

Open to every signed-in user (the Community tab; only the World map is gated). For non-admins
the RPCs apply privacy floors of 3+ users per ticker or 5+ active users per day (migrations
`20260926_community_open.sql`, `20261017_community_privacy_floors.sql`). Two blocks,
rendered once per dashboard load:

- Personal percentiles (`network_percentiles`): the calling user's last-30-day
  views, research time, distinct tickers and label hit rate, each with rank()
  and the active-user total; the cards show "top X%" for communities of >=10
  users and the literal "#K of N" below that (percent-style badges mislead at
  small N). Hit rates (here and in the World hit-rate mode) exclude labels
  whose ticker has no later price observation yet, so fresh labels do not read
  as 0%.
- Community index (`network_community_index`): top-20 tickers by community
  views with first-community-view timestamp, entry price and return since
  (latest-price proxy). The dashboard draws a line for the top 10 (Yahoo daily
  bars fetched client-side via `loadIndexBars`, level computed by `pitIndexVals`)
  alongside the user's OWN personal index and NASDAQ, all on one shared date axis
  for direct comparison. The personal index is built identically to the community
  line (first PRICED view = entry, weighted by views, sorted by views desc, same
  top-10 cap, from the daily `events` set rather than `GROUPS`), so when you are
  the only active user the two lines coincide. Three things are needed to hold
  that: (1) with one contributor the community rows are re-based on the LOCAL
  events, since the RPC only sees what has synced; (2) the RPC's 20-row cap is a
  cut on synced views, so local-only names are seeded into the community pool
  first, otherwise a name local counts rank into the top 10 could not reach the
  community basket; (3) `loadIndexBars` fetches each symbol ONCE for both baskets
  - `ATPrices.fetchDaily` has no cache, and two independent requests per symbol
  meant a rate-limited duplicate dropped a holding from one line only. Residual
  differences are reported in the chart caption rather than left silent. The
  holdings table sits in a fixed-height scroll box (`.net-index-scroll`).
- Both lines carry the same Weighting (equal / attention-weighted) and Holding
  (all / attended / positive) selectors as the Performance Index view
  (`#net-method`, `#net-rule`, persisted in `at_view`). `pitIndexVals`
  compounds bar-to-bar like `computeIndex`: each day's return uses the PREVIOUS
  day's weights, weights renormalise among the names actually held that day, a
  day with nothing held is flat, and prices are forward-filled so a missing bar
  holds a name at its last close. The holding rules need labels, so
  `network_community_sentiment` returns one label per (ticker, UTC day) - the
  majority of that day's labels, ties to neutral, timestamped at end of day so a
  label only moves the basket from the next bar. The client seeds each community
  name's timeline with an unlabelled event at its entry (the RPC only returns
  days that carried a label, and `heldAt` reads "no events yet" as "not attended
  yet"), and treats a missing RPC as "no labels", i.e. everything held.

## 9c. Third-party attention indices (Network chart)

The same chart carries one line per outside attention list, so the community's
basket can be read against crowds this app does not own. `TREND_SOURCES` in
`dashboard.js` is the single definition of each list (id, label, colour,
weighting mode, the sentence shown under the chart):

- `stockanalysis` - stockanalysis.com/trending, "most popular stocks today based
  on pageviews", read from the page's own SvelteKit data payload
  (`/trending/__data.json`) rather than the rendered table, whose column order
  follows saved user settings. The literal request in this feature.
- `apewisdom` - apewisdom.io, mentions per rolling 24h across the Reddit
  investing subs.
- `stocktwits` - Stocktwits trending symbols. Requested with the site's own
  Origin/Referer; the bare API call is refused (403) for anything that does not
  look like the web app.
- `yahoo` - Yahoo Finance trending tickers.
- `wikipedia` - daily English Wikipedia pageviews (human readers) of each
  company's article. No list exists, so the universe is the top 150 of
  StockAnalysis plus the other lists' names that day; Wikidata maps ticker ->
  article (current NYSE/NASDAQ listing, P414 + qualifier P249, no end date, not
  dissolved; GOOG/GOOGL share Alphabet and the first keeps it). Keyed by the UTC
  day the views accrued; each run adds the last 4 complete UTC days not stored
  yet, so weekends fill in and the line starts a few days before capture did. A
  run where under half the lookups answered stores nothing. Weighted by views;
  brand-level attention, so mega-caps lead.

Weighting: `weight: "views"` for the sources that publish a per-day FLOW
(StockAnalysis pageviews, Reddit mentions, Wikipedia pageviews) - the share of that flow is the
weight. `weight: "rank"` for the other two (Stocktwits, Yahoo), where weights decay as 1/rank. Stocktwits is ranked rather
than counted on purpose: `watchlist_count` is a running total (NVDA 662k against
INTU 12k on the same list), so weighting by it would produce a mega-cap index
wearing a trending label. Yahoo publishes no magnitude at all. The Weighting
selector still applies (Equal splits the day's list evenly); the Holding
selector does not - an outside list carries no Positive/Negative calls.

None of the lists except Wikipedia keep history, so everything is stored at
capture (migration `20260926_trending_asset_and_raw.sql`): every list IN FULL
(apewisdom all pages, ~800 names; Stocktwits 30; Yahoo everything it returns),
each row tagged with `asset` (equity, etf, crypto, index, fx, commodity, other -
Stocktwits' `instrument_class`, Yahoo's symbol conventions), and every capture's
raw response appended to `trending_raw` (source, day, captured_at, payload
jsonb; never replaced, admin-readable) - the per-day rows below are replaced by
each later capture of the day, the raw archive keeps them all. The index lines
read `trending_daily()`, which returns equities and ETFs only, re-ranked among
themselves, so crypto (Stocktwits' .X, Yahoo's -USD) and indices stay stored for
later analysis but never enter an index or push the stocks down a rank.
Stockanalysis was already stored in full: the page shows 20 rows, but its table is fed by
`/_api/endpoints/screener/table` (`m=views`, `f=views-over-1`), which returns
every stock the site has a views figure for (~490 a day) in one call. The
`__data.json` payload (top 20) is the fallback if that endpoint moves. Each
capture REPLACES the (source, day) rows rather than merging, since the tail of
that list churns hour to hour. A day's snapshot is final once taken at or after
16:30 ET (`CLOSE_MIN`); later non-forced calls return `skipped: "day closed"`,
so an evening dashboard load cannot add post-close views to a list the index
trades at that day's close.

The index lines hold the top `TREND_TOP` (10, same cap as the community
basket). The "StockAnalysis views" section below the chart (`renderTrendViews`)
pulls the top `TREND_STORED` (20) per day for display and the day totals from
`trending_day_totals()`, so each share is of the day's FULL pageviews. Clicking
a date shows `renderTrendComp`: the lists' index holdings and weights on
that day side by side (`trendDayWeights`); the section ("Attention index
composition", its heading's tooltip explains how the lists trade) has a day
picker and replaced the StockAnalysis views table. Its "Full screen" button opens
`openCompFull`: one list at a time (StockAnalysis first), a stock x captured-day
matrix in the StockAnalysis-table design, with header rows for the day's sample
(names listed, total views, held / priced) and the index level
(`NET.trendIdx`), summary cards (days captured, names listed / held / priced
per day, names ever held, index return), an Index weight / Share of views
toggle for the two view-counting lists, and a CSV of every list, day and stored
name (`compCsv`). The full stockanalysis history downloads as CSV
(`ATCloud.trendingRows`, paged past PostgREST's 1000-row cap). Days captured
before the full-list change hold only 20 names, and the table's "Stocks listed"
row shows it.

Prices: `ATPrices.fetchDaily` requests `events=split` and `parseChart` rescales
the history before a split when Yahoo left the closes unadjusted (AIXI's 1:7
reverse split on 2026-09-08 otherwise read as a +590% day and put the
StockAnalysis line at 162 instead of 103).

Index construction (`trendIndexVals`): hold the list, weights renormalised
among the names that have a price. A snapshot is read at 16:40 ET, after the
close of its own day, so snapshot D first trades at the close of the next
trading day and earns from there to the one after. Trading it at D's own close
would use a list that did not exist yet when that price printed.

Currency (the Local/USD button above the Performance and Network charts,
one shared `ccyMode`; a click flips it): Local compounds each
listing's own-currency closes. USD converts every non-USD bar series at the
day's Yahoo `XXXUSD=X` rate first (`usdBars`, forward-filled via `fxAt`; minor
units such as GBp are divided by 100), and the holdings table converts the
entry at the entry day's rate and the live price at today's. The entry-price
sanity check still runs on the local series, since the entry price was recorded
in local currency. `parseChart` and `fetchQuote` now carry Yahoo's
`meta.currency`. Performance charts (Single, Compare, Index) read prices
through `ccySeries`/`ccyPrice`; the watchlist table and Predictions stay in
local currency.

Daily bars are dated by the exchange's own calendar day
(`meta.exchangeTimezoneName`), not the UTC day of the timestamp. Yahoo stamps
FX bars at London midnight (23:00 UTC under BST) and Sydney/Auckland opens
fall on the previous UTC day half the year, so UTC dating put each such bar a
day early and every USD conversion used the next day's rate; the trailing live
bar replaces the completed bar of the same day. Failed fetches are no longer
cached for the session: `loadFx` retries once and caches only a real series,
`loadIndexBars` retries 429/network failures once and leaves them uncached
(only an empty Yahoo answer is cached as null), `ensureSeries` /
`ensureDailySeries` drop a failed entry so the next render refetches, and a
name still lacking a rate is named in the chart note (`CCY_MISSING`) instead
of vanishing.

Capture scheduling: Supabase pg_cron (`trending-capture-a`/`-b`, 20:40 and
21:40 UTC on weekdays, migration `20260925_trending_cron.sql`) calls the edge
function via pg_net; `.github/workflows/trending-capture.yml` calls the same two
slots as a backup, and an open dashboard is a third caller. Two slots because
20:40 UTC is 16:40 ET only under EDT; under EST it is 15:40, before the close,
and the 21:40 run replaces that snapshot. The function's freshness and
"day closed" gates make duplicate calls no-ops.

Community and personal indices are point in time (`pitIndexVals`): every close
the basket is the top 10 by views recorded BEFORE that close, weighted by those
running counts. Input comes from `network_community_daily()` (views and label
counts per ticker per trading day; an event at or after 16:00 ET counts toward
the next day), or from the local events for a sole contributor
(`pitFromEvents`, same bucketing via `tradeDay`/`closeTs`). The previous
construction ranked and weighted by all-time counts, putting names into past
baskets before they were popular. The Performance index uses the same cutoff:
only events before a bar's 16:00 ET close set the weights traded at it.

None of these sources keep history and none can be backfilled, so every line
starts at 100 on the first day capture ran and is `null` before that;
`drawLineCanvas` skips nulls in its scale and breaks the path there rather than
plotting them as 0. `renderTrendNote` prints days tracked, names priced and the
return per list under the chart, and names any ticked list that has no data yet,
so a source that quietly stopped parsing reads as stale instead of as a flat
line.

Costs: the union of names a list has ever held grows with every day of history,
and each name is one Yahoo request. `trendBasket` caps a list at
`TREND_MAX_SYMBOLS` (least-seen names dropped first, the count reported),
`loadIndexBars` takes a cache (`NET.bars`, failures cached as null) so toggling
a line refetches nothing, and it fetches in batches of 8 because Yahoo answers a
burst of a hundred symbols with 429s - and a 429 silently costs that name its
line. The benchmark bars are cached the same way, keyed by start date since
enabling a line can pull the axis further back.

Filtering: `#net-src` is a checkbox strip built from the same list, with a
swatch per line so it doubles as the chart legend. Choices persist in `at_view`
(`netSrc`); everything is on until switched off.

Charts: line charts (`drawLineCanvas`) zoom the y-axis to the padded data range
(via `niceTicks(min,max)` in `drawAxes`, `lo` argument) instead of anchoring at
0, so lines far from 0 (a rebased index near 100, an overlap % near 60) fill the
plot. Bar charts keep the 0 baseline.

Rationale on charts: a written rationale (`events.rationale`) is surfaced in the
Single/Compare chart marker tooltip ("Why: ..."), and its event marker is drawn
as a 9-point star (`starPath`) instead of a filled circle. `dayAgg` carries the
day's latest rationale to the marker. The admin data-health field-fill table
(`admin_field_fill_rates`) now includes a `rationale` fill-rate row.

## 10. Constraints / gotchas

- Never create files starting with `_` in the extension directory (Chrome
  rejects them as reserved).
- Each browser/profile is a separate local store; counts converge only via
  Supabase when signed in and a sync runs with the dashboard open.
- Admin hour/weekday distributions aggregate in UTC.
- Web Store publishing (`.github/workflows/publish-extension.yml`) runs on a push
  to main that touches `manifest.json`, `src/`, `popup/`, `dashboard/`, `vendor/`
  or `icons/`; a change to the workflow file alone does not trigger it (use
  `gh workflow run publish-extension.yml`). It packages with
  `tools/pack-extension.sh` and uploads the zip matching
  `dist/stocktrails-[0-9]*.zip`, so that glob must follow the script's output
  name: the workflow still globbed the old `attention-tracker-*.zip` after the
  rename and every publish failed at upload until it was fixed. The build
  version is `<manifest major.minor>.<run number>`; a failed run is not visible
  in the store, so check the run after pushing extension changes.
</content>
</invoke>
