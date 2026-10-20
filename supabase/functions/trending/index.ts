// Supabase Edge Function: daily snapshot of third-party attention lists.
//
// Deploy: supabase functions deploy trending --no-verify-jwt
// Call:   GET/POST <functions>/trending          - capture (no-op if fresh)
//         GET      <functions>/trending?force=1  - capture regardless of freshness;
//                  needs header x-trending-secret: $TRENDING_FORCE_SECRET, else
//                  the freshness gate applies as normal (see FORCE_SECRET below)
//
// Why server-side: most of the sources send no CORS headers, all of them
// rate-limit by IP, and the capture has to happen every day whether or not a
// client is open. The GitHub Action calls this once a day after the US close;
// the dashboard also calls it on load so history keeps accruing if the cron is
// not configured. Repeated calls inside FRESH_MS return without fetching, so an
// open dashboard cannot turn into a scraper.
//
// Writes with the service-role key (RLS is bypassed); reads go through the
// trending_daily() RPC from the client.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FRESH_MS = 30 * 60 * 1000; // a capture younger than this is left alone
const SA_MAX = 2000;             // upper bound on stockanalysis rows; the site lists ~500 with views
const APE_PAGES = 20;            // apewisdom serves 100 per page, ~800 stocks a day
const ST_MAX = 30;               // Stocktwits trending returns at most 30
const YH_MAX = 50;               // Yahoo trending returns ~20; ask for more in case it grows

// Every list is stored IN FULL, with what each symbol is (asset): none of these
// sources keep history, so anything dropped at capture is lost for good. The
// index lines read only equities and ETFs (trending_daily); crypto and the rest
// stay stored for later research. `raw` is the source's own response, archived
// append-only in trending_raw on every capture.
type Row = { ticker: string; rank: number; views: number; asset: string };
type Capture = { rows: Row[]; raw: unknown };
// Symbols come from third-party lists and are shown to every user, so anything not
// shaped like a symbol (^IXIC, BRK.B, BTC-USD, EURUSD=X, ES=F) is not stored.
const SAFE_TICKER = /^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/;

async function get(url: string, extra?: Record<string, string>): Promise<Response> {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/json", ...(extra || {}) },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r;
}

// SvelteKit ships its page data as a flattened value graph: every value is an
// index into one array, so shared objects appear once. Rebuild it.
function unflatten(arr: unknown[]): unknown {
  const seen = new Array(arr.length);
  const hydrate = (i: number): unknown => {
    if (i === -1) return undefined;
    if (i === -2) return null;
    if (seen[i] !== undefined) return seen[i];
    const v = arr[i];
    if (Array.isArray(v)) {
      const out: unknown[] = []; seen[i] = out;
      for (const x of v) out.push(hydrate(x as number));
      return out;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}; seen[i] = out;
      for (const k in v as object) out[k] = hydrate((v as Record<string, number>)[k]);
      return out;
    }
    seen[i] = v; return v;
  };
  return hydrate(0);
}

// stockanalysis.com/trending - "most popular stocks today based on pageviews",
// reset daily and updated hourly. The page itself shows 20 rows per page, but its
// table is fed by the site's screener endpoint, which returns every stock with a
// views figure (about 500 a day) in one call. All of them are stored: the index
// only holds the top 10, the rest is kept for research. If that endpoint moves,
// fall back to the page's own data payload, which carries the first 20.
async function stockanalysis(): Promise<Capture> {
  try {
    const r = await get("https://stockanalysis.com/_api/endpoints/screener/table" +
      "?type=s&m=views&s=desc&c=no,s,views&cn=" + SA_MAX + "&p=1&f=views-over-1&i=stocks");
    const body = await r.json();
    const rows = body && body.data && body.data.data;
    if (!Array.isArray(rows) || !rows.length || typeof rows[0].views !== "number") throw new Error("no rows");
    return { rows: saRows(rows), raw: rows };
  } catch (_) {
    return await stockanalysisPage();
  }
}

function saRows(rows: Array<Record<string, unknown>>): Row[] {
  return rows.map((x, i) => ({
    ticker: String(x.s || "").toUpperCase(),
    rank: typeof x.no === "number" ? x.no : i + 1,
    views: Number(x.views) || 0,
    asset: "equity", // i=stocks: the site's stock screener
  })).filter((x) => x.ticker && x.views > 0);
}

// The page's data payload is read instead of the rendered table: the table is
// Svelte hydration markup whose column order follows saved user settings, the
// payload is typed and ordered.
async function stockanalysisPage(): Promise<Capture> {
  const r = await get("https://stockanalysis.com/trending/__data.json");
  const body = await r.json();
  const nodes = (body && body.nodes) || [];
  for (const n of nodes) {
    if (!n || n.type !== "data" || !Array.isArray(n.data)) continue;
    const d = unflatten(n.data) as { data?: Array<Record<string, unknown>> };
    const rows = d && d.data;
    if (!Array.isArray(rows) || !rows.length || typeof rows[0].views !== "number") continue;
    return { rows: saRows(rows), raw: rows };
  }
  throw new Error("no views payload in page data");
}

// apewisdom.io - mentions per rolling 24h across the Reddit investing subs.
// Every page (100 stocks each); the raw rows also carry upvotes and the
// mentions and rank 24h earlier.
async function apewisdom(): Promise<Capture> {
  const all: Array<Record<string, unknown>> = [];
  let pages = 1;
  for (let p = 1; p <= Math.min(pages, APE_PAGES); p++) {
    const r = await get("https://apewisdom.io/api/v1.0/filter/all-stocks/page/" + p);
    const body = await r.json();
    pages = Number(body && body.pages) || 1;
    all.push(...((body && body.results) || []));
  }
  const rows = all.map((x, i) => ({
    ticker: String(x.ticker || "").toUpperCase(),
    rank: Number(x.rank) || i + 1,
    views: Number(x.mentions) || 0,
    asset: "equity", // the all-stocks filter
  })).filter((x: Row) => x.ticker);
  return { rows, raw: all };
}

// Stocktwits trending symbols. watchlist_count is a LEVEL (total followers of
// the symbol), not a flow, so it is stored for reference but the client weights
// this source by rank - see TREND_SOURCES in dashboard.js.
// instrument_class says what a symbol is: Stock, ExchangeTradedFund, CRYPTO
// (the .X symbols), ExchangeTradedCommodity...
const ST_ASSET: Record<string, string> = {
  stock: "equity", exchangetradedfund: "etf", crypto: "crypto", exchangetradedcommodity: "commodity",
  index: "index", forex: "fx",
};
async function stocktwits(): Promise<Capture> {
  // Sent with the site's own Origin/Referer: the bare API call is refused for
  // anything that does not look like the web app.
  const r = await get("https://api.stocktwits.com/api/2/trending/symbols.json?limit=" + ST_MAX, {
    "Origin": "https://stocktwits.com",
    "Referer": "https://stocktwits.com/",
    "Accept-Language": "en-US,en;q=0.9",
  });
  const body = await r.json();
  const syms = (body && body.symbols) || [];
  const rows = syms.map((x: Record<string, unknown>, i: number) => {
    const t = String(x.symbol || "").toUpperCase();
    const cls = String(x.instrument_class || "").toLowerCase();
    return { ticker: t, rank: i + 1, views: Number(x.watchlist_count) || 0,
      asset: ST_ASSET[cls] || (t.endsWith(".X") ? "crypto" : "other") };
  }).filter((x: Row) => x.ticker);
  return { rows, raw: syms };
}

// Yahoo Finance trending tickers: rank only, no magnitude at all. The list
// carries only symbols, so the kind is read off Yahoo's symbol conventions:
// ^ index, -USD crypto pair, =X currency, =F future. Anything not shaped like a
// ticker (it has listed a literal "test") is "other".
function yahooAsset(sym: string): string {
  if (sym.startsWith("^")) return "index";
  if (/-(USD|USDT|EUR|BTC|ETH)$/.test(sym)) return "crypto";
  if (sym.endsWith("=X")) return "fx";
  if (sym.endsWith("=F")) return "commodity";
  if (!/^[A-Z0-9][A-Z0-9.-]*$/.test(sym)) return "other";
  return "equity";
}
async function yahoo(): Promise<Capture> {
  const r = await get("https://query1.finance.yahoo.com/v1/finance/trending/US?count=" + YH_MAX);
  const body = await r.json();
  const res = body && body.finance && body.finance.result && body.finance.result[0];
  const quotes = (res && res.quotes) || [];
  const rows = quotes.map((x: Record<string, unknown>, i: number) => {
    const sym = String(x.symbol || "");
    return { ticker: sym.toUpperCase(), rank: i + 1, views: 0, asset: yahooAsset(sym) };
  }).filter((x: Row) => x.ticker);
  return { rows, raw: quotes };
}

const SOURCES: Record<string, () => Promise<Capture>> = {
  stockanalysis, apewisdom, stocktwits, yahoo,
};

// Wikipedia pageviews (source "wikipedia"). Wikipedia publishes no stock list,
// so the universe is borrowed: the names the other lists carry today (the top
// WIKI_UNIVERSE of StockAnalysis plus the others' top 30). Wikidata maps each
// ticker to its English article (a current NYSE/NASDAQ listing statement, P414
// with ticker qualifier P249, no end date, company not dissolved); the Wikimedia
// REST API gives that article's daily pageviews by human readers.
//
// Unlike the other lists this one has history, but a day is only complete after
// UTC midnight, so each run stores the last WIKI_BACK complete UTC days that are
// not stored yet (weekends included). Each is keyed by the UTC day the views
// accrued and holds every mapped name ranked by views; the day is public by
// ~01:00 UTC the next day, i.e. before the next US close the index trades it at.
// Two tickers of one company (GOOG, GOOGL) share an article: the first in
// universe order keeps it, so its views are not counted twice.
const WIKI_UA = "Stocktrails-trending/1.0 (https://github.com/marsierz-ui)";
const WIKI_UNIVERSE = 150;
const WIKI_BACK = 4;

async function wikiArticles(tickers: string[]): Promise<Map<string, string>> {
  const q = "SELECT ?ticker ?article ?rk WHERE { VALUES ?ticker { " +
    tickers.map((t) => JSON.stringify(t)).join(" ") + " } " +
    "?item p:P414 ?st . ?st pq:P249 ?ticker ; ps:P414 ?exch ; wikibase:rank ?rk . " +
    "VALUES ?exch { wd:Q13677 wd:Q82059 } FILTER NOT EXISTS { ?st pq:P582 ?end } " +
    "FILTER NOT EXISTS { ?item wdt:P576 ?dissolved } " +
    "?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }";
  const r = await fetch("https://query.wikidata.org/sparql?query=" + encodeURIComponent(q), {
    headers: { "User-Agent": WIKI_UA, "Accept": "application/sparql-results+json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error("wikidata HTTP " + r.status);
  const body = await r.json();
  const out = new Map<string, string>(), preferred = new Set<string>();
  for (const b of (body && body.results && body.results.bindings) || []) {
    const t = b.ticker.value, url = String(b.article.value);
    const title = decodeURIComponent(url.slice(url.indexOf("/wiki/") + 6));
    const pref = String(b.rk.value).endsWith("PreferredRank");
    if (!out.has(t) || (pref && !preferred.has(t))) { out.set(t, title); if (pref) preferred.add(t); }
  }
  return out;
}

function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

async function wikipedia(universe: string[], have: Set<string>): Promise<{ rows: Array<Record<string, unknown>>; raw: unknown }> {
  const now = Date.now();
  const days: string[] = [];
  for (let i = WIKI_BACK; i >= 1; i--) { const d = utcDay(now - i * 86400000); if (!have.has(d)) days.push(d); }
  if (!days.length) return { rows: [], raw: null };
  const art = await wikiArticles(universe);
  const owner = new Map<string, string>(); // article -> first ticker in universe order
  universe.forEach((t) => { const a = art.get(t); if (a && !owner.has(a)) owner.set(a, t); });
  const views: Record<string, Record<string, number>> = {}; // day -> ticker -> views
  days.forEach((d) => { views[d] = {}; });
  const compact = (d: string) => d.replace(/-/g, "");
  const list = [...owner.entries()];
  let answered = 0;
  for (let i = 0; i < list.length; i += 20) {
    await Promise.all(list.slice(i, i + 20).map(async ([title, t]) => {
      try {
        const r = await fetch("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/" +
          encodeURIComponent(title.replace(/ /g, "_")) + "/daily/" + compact(days[0]) + "/" + compact(days[days.length - 1]), {
          headers: { "User-Agent": WIKI_UA }, signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) return; // no data for that article: left out
        const body = await r.json();
        answered++;
        for (const it of (body && body.items) || []) {
          const ts = String(it.timestamp);
          const d = ts.slice(0, 4) + "-" + ts.slice(4, 6) + "-" + ts.slice(6, 8);
          if (views[d]) views[d][t] = Number(it.views) || 0;
        }
      } catch (_) { /* one article failing must not cost the day */ }
    }));
  }
  // A run where most lookups failed (rate limit, outage) would store thin days
  // for good: store nothing and let the next run try again.
  if (answered < list.length / 2) throw new Error("only " + answered + " of " + list.length + " articles answered");
  const rows: Array<Record<string, unknown>> = [];
  days.forEach((d) => {
    Object.keys(views[d]).filter((t) => views[d][t] > 0)
      .sort((a, b) => views[d][b] - views[d][a] || a.localeCompare(b))
      .forEach((t, i) => rows.push({ source: "wikipedia", day: d, ticker: t, rank: i + 1, views: views[d][t], asset: "equity" }));
  });
  return { rows, raw: { articles: Object.fromEntries(owner), views } };
}

async function wikiDaysStored(): Promise<Set<string>> {
  const r = await fetch(REST + "/trending_snapshots?source=eq.wikipedia&rank=eq.1&day=gte." +
    utcDay(Date.now() - (WIKI_BACK + 1) * 86400000) + "&select=day", { headers: AUTH });
  if (!r.ok) return new Set();
  return new Set(((await r.json()) || []).map((x: { day: string }) => x.day));
}

// The day these lists accumulate over is the US trading day, and it is the date
// Yahoo stamps its daily bars with - so the snapshot is keyed in US Eastern, not
// in UTC (which would roll over mid-session and split one session in two).
function easternDay(ms?: number): string {
  return new Date(ms ?? Date.now()).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// Minutes past midnight, US Eastern.
function easternMinutes(ms: number): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(ms));
  const v = (t: string) => Number((p.find((x) => x.type === t) || { value: "0" }).value);
  return v("hour") * 60 + v("minute");
}
// A day's snapshot is final once taken at or after 16:30 ET: the lists are
// cumulative, so a later read would add evening views the index could not have
// traded on at that day's close. The cron runs at 16:40 ET.
const CLOSE_MIN = 16 * 60 + 30;

const REST = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "") + "/rest/v1";
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
// force=1 skips the freshness gate, and the gate is the only thing stopping this
// endpoint - deployed --no-verify-jwt, so callable by anyone - from being turned
// into four outbound scrapes and a service-role write per request. So force is
// only honoured for a caller that knows TRENDING_FORCE_SECRET; when no secret is
// configured it is refused rather than allowed, and the freshness gate stands.
const FORCE_SECRET = Deno.env.get("TRENDING_FORCE_SECRET") || "";
const AUTH = { "apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json" };

async function lastCapture(): Promise<number> {
  const r = await fetch(REST + "/trending_snapshots?select=captured_at&order=captured_at.desc&limit=1", { headers: AUTH });
  if (!r.ok) return 0;
  const rows = await r.json();
  return rows && rows[0] ? Date.parse(rows[0].captured_at) : 0;
}

// Single flight: the freshness gate reads what a run writes at its end, so calls
// that arrive while a run is still fetching would all pass it. The first call in a
// 10-minute slot claims it (capture_claims, service role only); the rest skip. A
// failed run blocks retries for at most the rest of its slot.
async function claimSlot(job: string, now: number): Promise<boolean> {
  const r = await fetch(REST + "/capture_claims?on_conflict=job,slot", {
    method: "POST",
    headers: { ...AUTH, "Prefer": "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ job: job, slot: Math.floor(now / 600000) }),
  });
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!KEY) return new Response(JSON.stringify({ error: "no service role key" }), { status: 500, headers: CORS });

  const force = new URL(req.url).searchParams.get("force") === "1" &&
    !!FORCE_SECRET && req.headers.get("x-trending-secret") === FORCE_SECRET;
  const now = Date.now();
  if (!force) {
    const last = await lastCapture();
    if (last && now - last < FRESH_MS) {
      return new Response(JSON.stringify({ skipped: "fresh", last_capture: new Date(last).toISOString() }), { headers: CORS });
    }
    if (last && easternDay(last) === easternDay(now) && easternMinutes(last) >= CLOSE_MIN) {
      return new Response(JSON.stringify({ skipped: "day closed", last_capture: new Date(last).toISOString() }), { headers: CORS });
    }
    if (!(await claimSlot("trending", now))) return new Response(JSON.stringify({ skipped: "in progress" }), { headers: CORS });
  }

  const day = easternDay();
  const stamp = new Date(now).toISOString();
  const result: Record<string, string | number> = {};
  const payload: Array<Record<string, unknown>> = [];
  const raws: Array<Record<string, unknown>> = [];

  // One failing source must not cost the others their snapshot for the day.
  await Promise.all(Object.keys(SOURCES).map(async (src) => {
    try {
      const cap = await SOURCES[src]();
      const rows = cap.rows.filter((x) => SAFE_TICKER.test(x.ticker));
      if (!rows.length) throw new Error("empty list");
      rows.forEach((x) => payload.push({
        source: src, day: day, ticker: x.ticker, rank: x.rank, views: x.views, asset: x.asset, captured_at: stamp,
      }));
      raws.push({ source: src, day: day, captured_at: stamp, payload: cap.raw });
      result[src] = rows.length;
    } catch (e) {
      result[src] = "error: " + (e instanceof Error ? e.message : String(e));
    }
  }));

  if (!payload.length) return new Response(JSON.stringify({ day, ...result }), { status: 502, headers: CORS });

  // Wikipedia, over the universe the lists above just produced (see wikipedia()).
  // Only complete UTC days not stored yet are added, so nothing of it is deleted
  // below and a run with no new day costs one query.
  const wiki: Array<Record<string, unknown>> = [];
  try {
    const eq = payload.filter((p) => p.asset === "equity" || p.asset === "etf");
    const byRank = (a: Record<string, unknown>, b: Record<string, unknown>) => Number(a.rank) - Number(b.rank);
    const sa = eq.filter((p) => p.source === "stockanalysis").sort(byRank).slice(0, WIKI_UNIVERSE).map((p) => String(p.ticker));
    // The other lists' top 30 of the day (apewisdom stores ~800 names).
    const rest = eq.filter((p) => p.source !== "stockanalysis" && Number(p.rank) <= 30).map((p) => String(p.ticker));
    const universe = [...new Set(sa.concat(rest))];
    const w = await wikipedia(universe, await wikiDaysStored());
    w.rows.forEach((x) => wiki.push({ ...x, captured_at: stamp }));
    if (w.raw) raws.push({ source: "wikipedia", day: day, captured_at: stamp, payload: w.raw });
    result.wikipedia = wiki.length;
  } catch (e) {
    result.wikipedia = "error: " + (e instanceof Error ? e.message : String(e));
  }

  // One row per (source, day, ticker): a list that names a symbol twice would
  // make the upsert touch one row twice, which Postgres rejects for the whole batch.
  const uniq = new Map<string, Record<string, unknown>>();
  payload.concat(wiki).forEach((p) => { const k = p.source + "|" + p.day + "|" + p.ticker; if (!uniq.has(k)) uniq.set(k, p); });

  // Last capture of the day wins: the pageview counts these lists publish are
  // cumulative over the session, so the newest read is the most complete one.
  // It REPLACES the day rather than merging into it: the stockanalysis tail
  // (~500 names) churns hour to hour, and a merge would leave names that fell
  // off the list with their earlier count, inflating the day's total.
  const done = Object.keys(result).filter((s) => s !== "wikipedia" && typeof result[s] === "number");
  await fetch(REST + "/trending_snapshots?day=eq." + day + "&source=in.(" + done.join(",") + ")", {
    method: "DELETE", headers: { ...AUTH, "Prefer": "return=minimal" },
  });
  const up = await fetch(REST + "/trending_snapshots?on_conflict=source,day,ticker", {
    method: "POST",
    headers: { ...AUTH, "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([...uniq.values()]),
  });
  if (!up.ok) {
    // The body carries PostgREST's own error text (schema names, constraints)
    // and this endpoint answers unauthenticated callers: log it, return a stub.
    console.error("trending upsert failed:", up.status, await up.text());
    return new Response(JSON.stringify({ day, error: "store failed", ...result }), { status: 500, headers: CORS });
  }
  // Raw archive: appended, never replaced, so every capture of every day stays.
  const rw = await fetch(REST + "/trending_raw", {
    method: "POST", headers: { ...AUTH, "Prefer": "return=minimal" }, body: JSON.stringify(raws),
  });
  if (!rw.ok) { console.error("trending raw archive failed:", rw.status, await rw.text()); result.raw = "error"; }
  else result.raw = raws.length;
  return new Response(JSON.stringify({ day, rows: uniq.size, ...result }), { headers: CORS });
});
