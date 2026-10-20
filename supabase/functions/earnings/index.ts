// Supabase Edge Function: earnings release dates for the limited-attention
// indicator (card A8, docs/bias-indicators-design.md, S1).
//
// Deploy: supabase functions deploy earnings   (JWT verified: the cron job sends the anon key)
// Secrets: SEC_USER_AGENT  - "<name> <email>", required by SEC EDGAR's fair-access
//                            policy; without it the EDGAR history is skipped
//          EARNINGS_FORCE_SECRET - optional, allows ?force=1 (skip the freshness gate)
// Call:   POST <functions>/earnings   (pg_cron, weekdays 12:10 UTC)
//
// Two sources, both US only (non-US listings stay "not measured"):
//   nasdaq - the Nasdaq earnings calendar for the last 3 and next 7 days: upcoming
//            and just-past releases with their time of day.
//   sec    - EDGAR 8-K filings with Item 2.02 (results of operations), the history.
//            Each run reads up to BACKFILL submissions files for tickers the
//            community views and that have not been read yet (earnings_universe).
// Writes with the service-role key; clients read through earnings_for().

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FRESH_MS = 6 * 3600 * 1000; // a capture younger than this is left alone
const BACKFILL = 25;              // EDGAR submissions files per run (SEC allows 10 requests a second)

const REST = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "") + "/rest/v1";
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SEC_UA = Deno.env.get("SEC_USER_AGENT") || "";
const FORCE_SECRET = Deno.env.get("EARNINGS_FORCE_SECRET") || "";
const AUTH = { "apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json" };

type Row = { ticker: string; day: string; timing: string; source: string; captured_at: string };

function easternDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
function easternMinutes(ms: number): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms));
  const v = (t: string) => Number((p.find((x) => x.type === t) || { value: "0" }).value);
  return v("hour") * 60 + v("minute");
}
// Before 9:30 ET = before the open, from 16:00 = after the close.
function timingOf(ms: number): string {
  const m = easternMinutes(ms);
  return m < 9 * 60 + 30 ? "bmo" : m >= 16 * 60 ? "amc" : "during";
}

// Newest stored row from either source, so the gate also closes when one source
// is unreachable (a blocked calendar must not turn every call into SEC requests).
async function lastCapture(): Promise<number> {
  const r = await fetch(REST + "/earnings_dates?select=captured_at&order=captured_at.desc&limit=1", { headers: AUTH });
  if (!r.ok) return 0;
  const rows = await r.json();
  return rows && rows[0] ? Date.parse(rows[0].captured_at) : 0;
}

// Nasdaq calendar: one request per day. Its API refuses requests that do not
// look like the web app, hence the browser headers.
async function nasdaq(stamp: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let k = -3; k <= 7; k++) {
    const day = easternDay(Date.now() + k * 86400000);
    try {
      const r = await fetch("https://api.nasdaq.com/api/calendar/earnings?date=" + day, {
        headers: { "User-Agent": UA, "Accept": "application/json", "Origin": "https://www.nasdaq.com", "Referer": "https://www.nasdaq.com/" },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const rows = (j && j.data && j.data.rows) || [];
      for (const x of rows) {
        const t = String(x.symbol || "").toUpperCase().trim();
        if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(t)) continue;
        const tm = String(x.time || "");
        out.push({ ticker: t.replace(".", "-"), day: day, timing: /pre-market/.test(tm) ? "bmo" : /after-hours/.test(tm) ? "amc" : "unknown", source: "nasdaq", captured_at: stamp });
      }
    } catch (_e) { /* one missing day does not stop the others */ }
  }
  return out;
}

// EDGAR: ticker -> CIK from SEC's own list, then each company's submissions file;
// 8-Ks whose items include 2.02 are earnings releases.
async function sec(stamp: string, result: Record<string, unknown>): Promise<{ rows: Row[]; done: Array<Record<string, unknown>> }> {
  const rows: Row[] = [], done: Array<Record<string, unknown>> = [];
  if (!SEC_UA) { result.sec = "skipped: no SEC_USER_AGENT"; return { rows, done }; }
  const u = await fetch(REST + "/rpc/earnings_universe", { method: "POST", headers: AUTH, body: JSON.stringify({ p_limit: BACKFILL }) });
  if (!u.ok) { result.sec = "universe failed"; return { rows, done }; }
  const universe: string[] = (await u.json()).map((x: { ticker: string }) => x.ticker);
  if (!universe.length) { result.sec = 0; return { rows, done }; }
  const map = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": SEC_UA }, signal: AbortSignal.timeout(20000) });
  if (!map.ok) { result.sec = "ticker map HTTP " + map.status; return { rows, done }; }
  const cik: Record<string, string> = {};
  const m = await map.json();
  for (const k in m) cik[String(m[k].ticker).toUpperCase().replace(".", "-")] = String(m[k].cik_str).padStart(10, "0");
  for (const t of universe) {
    const c = cik[t];
    if (!c) { done.push({ ticker: t, cik: null, found: 0, done_at: stamp }); continue; }
    try {
      const r = await fetch("https://data.sec.gov/submissions/CIK" + c + ".json", { headers: { "User-Agent": SEC_UA }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue; // retried on a later run
      const f = (await r.json()).filings?.recent || {};
      let found = 0;
      (f.form || []).forEach((form: string, i: number) => {
        if (form !== "8-K" || !/(^|,)\s*2\.02/.test(String(f.items[i] || ""))) return;
        const acc = Date.parse(f.acceptanceDateTime[i]);
        rows.push({ ticker: t, day: f.filingDate[i], timing: isNaN(acc) ? "unknown" : timingOf(acc), source: "sec", captured_at: stamp });
        found++;
      });
      done.push({ ticker: t, cik: c, found: found, done_at: stamp });
    } catch (_e) { /* retried on a later run */ }
    await new Promise((res) => setTimeout(res, 150)); // well under SEC's 10 requests a second
  }
  result.sec = rows.length;
  return { rows, done };
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
  const force = new URL(req.url).searchParams.get("force") === "1" && !!FORCE_SECRET && req.headers.get("x-earnings-secret") === FORCE_SECRET;
  const now = Date.now();
  if (!force) {
    const last = await lastCapture();
    if (last && now - last < FRESH_MS) return new Response(JSON.stringify({ skipped: "fresh", last_capture: new Date(last).toISOString() }), { headers: CORS });
    if (!(await claimSlot("earnings", now))) return new Response(JSON.stringify({ skipped: "in progress" }), { headers: CORS });
  }
  const stamp = new Date(now).toISOString(), result: Record<string, unknown> = {};
  const nq = await nasdaq(stamp);
  result.nasdaq = nq.length;
  const s = await sec(stamp, result);
  // One row per (ticker, day); the calendar's time of day wins over the filing's,
  // since a filing can be accepted hours after the release.
  const uniq = new Map<string, Row>();
  s.rows.concat(nq).forEach((r) => { uniq.set(r.ticker + "|" + r.day, r); });
  if (uniq.size) {
    const up = await fetch(REST + "/earnings_dates?on_conflict=ticker,day", {
      method: "POST", headers: { ...AUTH, "Prefer": "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([...uniq.values()]),
    });
    if (!up.ok) {
      console.error("earnings upsert failed:", up.status, await up.text());
      return new Response(JSON.stringify({ error: "store failed", ...result }), { status: 500, headers: CORS });
    }
  }
  if (s.done.length) {
    const bf = await fetch(REST + "/earnings_backfill?on_conflict=ticker", {
      method: "POST", headers: { ...AUTH, "Prefer": "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(s.done),
    });
    if (!bf.ok) console.error("earnings backfill log failed:", bf.status, await bf.text());
  }
  return new Response(JSON.stringify({ rows: uniq.size, ...result }), { headers: CORS });
});
