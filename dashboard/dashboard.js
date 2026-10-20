let DATA = null;
let GROUPS = {};
let QUOTES = {};     // ticker -> { close } current price
let SERIES = {};     // ticker -> [{date, close}] at the selected resolution (chart)
let DAILY = {};      // ticker -> daily [{date, close}] (event study; always daily)
let BENCH = null;    // NASDAQ Composite daily series (cached)
let selected = null;
let viewMode = "single";   // single | compare | index
let basis = "intraday";    // daily | intraday (which database stats are based on)
let resolution = "daily";  // daily | hourly (chart price resolution)
let period = 0;            // Single view lookback in days (0 = since first view)

function gapMs() { return resolution === "hourly" ? 1.5 * 3600000 : 1.5 * 86400000; }
let markers = [];    // screen-space markers for hover hit-testing
let hoverLines = []; // screen-space polylines for line hover (label + value)
let chartTable = false; // Compare: show a per-stock return table on hover
let chartBase = null, chartGeom = null; // main chart snapshot + plot geometry for hover guide
let compareLines = null, compareOpts = null; // Compare: kept for hover re-render with line isolation
let atGran = "month"; // attention-over-time period: day|week|month|year (full aligned period)
let atOffset = 0;     // periods back from the current one (0 = current)
let omGran = "week"; // outlook-mix granularity: day|week|month
let faGran = "month"; // forecast-accuracy timeline granularity: day|week|month
const FA_HORIZON = 21; // trading days a call gets to resolve on the timeline
let autoSynced = false;   // cloud auto-sync runs once per dashboard load
let fuGran = "week", fuOffset = 0; // admin feature-usage-over-time window
let soGran = "week", soOffset = 0; // admin sector-attention-over-time window
let mmMetric = null, mmGran = "month", mmOffset = 0; // KPI drilldown modal state
let wdHorizon = 30;       // admin weekday hit-rate return-proxy horizon (days)

const PALETTE = ["#4e9eff", "#2ecc71", "#e74c3c", "#f1c40f", "#9b59b6",
  "#1abc9c", "#e67e22", "#e84393", "#00cec9", "#a29bfe", "#fd79a8", "#55efc4"];

// Theme colours for canvas drawing, read from the same CSS variables as the
// stylesheet (src/theme.js sets html[data-theme]); cached until the theme changes.
let _TC = null;
function TC() {
  if (_TC) return _TC;
  const cs = getComputedStyle(document.documentElement), v = function (n) { return cs.getPropertyValue(n).trim(); };
  const rgb = v("--ink-rgb") || "255,255,255";
  _TC = { bg: v("--bg"), fg: v("--fg"), muted: v("--muted"), grid: v("--grid"), line: v("--line"), mapfill: v("--mapfill"),
    ink: function (a) { return "rgba(" + rgb + "," + a + ")"; } };
  return _TC;
}

const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d", { willReadFrequently: true }); // hover redraws read pixels back

// Floating tooltip shown next to the cursor for all chart hovers.
const hoverTip = document.getElementById("hover-tip");
const TIP_PAD = 38; // ~1cm at 96dpi: keeps the tip clear of the pointer
// A Compare hover lists one row per plotted stock. Spread over several columns
// a long watchlist covered the chart, so the rows stay ONE column, capped in
// height, and the mouse wheel scrolls them while the pointer rests on the
// chart (the tip itself is pointer-events: none). The scroll offset survives
// the tip's re-render on every mousemove and resets when the hovered day
// (the tip's bold header) changes.
const TIP_SCROLL = { key: null, top: 0 };
function showTip(html, x, y) {
  hoverTip.innerHTML = html;
  hoverTip.style.display = "block";
  const rows = hoverTip.querySelector(".tip-rows");
  if (rows) {
    const key = html.slice(0, html.indexOf("</b>") + 4);
    if (key !== TIP_SCROLL.key) { TIP_SCROLL.key = key; TIP_SCROLL.top = 0; }
    rows.style.maxHeight = Math.max(120, Math.min(300, window.innerHeight * 0.45)) + "px";
    if (rows.scrollHeight > rows.clientHeight + 1) {
      rows.scrollTop = TIP_SCROLL.top;
      const more = document.createElement("div");
      more.className = "tip-more muted";
      more.textContent = "Scroll the wheel for all " + rows.children.length + " rows";
      hoverTip.appendChild(more);
    }
  }
  const w = hoverTip.offsetWidth, h = hoverTip.offsetHeight;
  let left = x + TIP_PAD, top = y + TIP_PAD;
  if (left + w > window.innerWidth - 8) left = x - TIP_PAD - w;
  if (top + h > window.innerHeight - 8) top = y - TIP_PAD - h;
  hoverTip.style.left = Math.max(4, Math.min(left, window.innerWidth - w - 4)) + "px";
  hoverTip.style.top = Math.max(4, Math.min(top, window.innerHeight - h - 4)) + "px";
}
function hideTip() { hoverTip.style.display = "none"; }
// Wheel over a chart while its tip has more rows than fit: scroll the tip, not
// the page. Anywhere else, or with a tip that fits, the page scrolls as usual.
document.addEventListener("wheel", function (ev) {
  if (hoverTip.style.display !== "block" || !ev.target || ev.target.tagName !== "CANVAS") return;
  const rows = hoverTip.querySelector(".tip-rows");
  if (!rows || rows.scrollHeight <= rows.clientHeight + 1) return;
  ev.preventDefault();
  rows.scrollTop += ev.deltaMode === 1 ? ev.deltaY * 18 : ev.deltaY;
  TIP_SCROLL.top = rows.scrollTop;
}, { passive: false });

function currentEvents() {
  return basis === "intraday" ? (DATA.intraday || []) : DATA.events;
}

// ---- company-name cache (ticker -> display name), persisted locally ----
const NAMES_KEY = "attention_names_v1";
let NAMES = {};
// Trailing corporate-form words that add no information in a compact list.
const NAME_SUFFIXES = {
  inc: 1, incorporated: 1, corp: 1, corporation: 1, co: 1, company: 1, llc: 1,
  plc: 1, lp: 1, llp: 1, ltd: 1, limited: 1, holdings: 1, holding: 1, group: 1,
  technologies: 1, technology: 1, systems: 1, sa: 1, nv: 1, ag: 1, se: 1
};
function shortenName(name) {
  if (!name) return name;
  let toks = name.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  while (toks.length > 1 && NAME_SUFFIXES[toks[toks.length - 1].toLowerCase().replace(/\./g, "")]) toks.pop();
  if (toks.length > 1 && toks[0].toLowerCase() === "the") toks.shift();
  return toks.join(" ");
}
function nameOf(t) { return NAMES[t] ? shortenName(NAMES[t]) : t; }
function loadNames() {
  return new Promise(function (resolve) {
    try { chrome.storage.local.get(NAMES_KEY, function (r) { NAMES = (r && r[NAMES_KEY]) || {}; resolve(); }); }
    catch (e) { NAMES = {}; resolve(); }
  });
}
function saveNames() { try { chrome.storage.local.set({ [NAMES_KEY]: NAMES }); } catch (e) { /* ignore */ } }
async function resolveNames(tickers) {
  const missing = tickers.filter(function (t) { return !NAMES[t]; });
  if (!missing.length) return;
  await Promise.all(missing.map(async function (t) {
    const sym = DATA.overrides[t] || ATPrices.toSymbol(t);
    try { const nm = await ATPrices.fetchName(sym, true); if (nm) NAMES[t] = nm; } catch (e) { /* ignore */ }
  }));
  saveNames();
}

function rebuildGroups() {
  GROUPS = ATStore.byTicker(currentEvents());
  document.getElementById("watchlist-empty").classList.toggle("hidden", Object.keys(GROUPS).length > 0);
}

async function load() {
  DATA = await ATStore.getAll();
  BENCH = null;
  // The community rows/labels/prices are snapshots of the same events this just
  // re-read. Only NET.rendered was ever reset, so after a sync added events the
  // personal basket rebuilt from fresh DATA while the community basket stayed
  // frozen at whatever the RPC returned on first render - the two then disagree
  // for the rest of the session even with a single user.
  NET.rows = null; NET.daily = null; NET.live = null;

  // Quotes for the union of tickers across both databases.
  const union = {};
  DATA.events.forEach(function (e) { union[e.ticker] = 1; });
  (DATA.intraday || []).forEach(function (e) { union[e.ticker] = 1; });
  const tickers = Object.keys(union);
  await loadNames();
  await Promise.all(tickers.map(async function (t) {
    try {
      const sym = DATA.overrides[t] || ATPrices.toSymbol(t);
      QUOTES[t] = await ATPrices.fetchQuote(sym, true);
    } catch (e) { QUOTES[t] = null; }
  }));
  // Resolve company names in the background; re-render the name-bearing views
  // once they arrive (no await so the dashboard paints immediately).
  resolveNames(tickers).then(function () {
    renderSummary(); renderTable(); render(); renderAnalytics(); renderUsageStats();
  });

  rebuildGroups();
  renderSummary();
  renderTable();
  renderPortals();
  renderAccount();
  if (Object.keys(GROUPS).length && (!selected || !GROUPS[selected])) selected = Object.keys(GROUPS).sort()[0];
  render();
  renderAnalytics();
  renderForecast();
  renderSentimentMix();
  renderUsageStats();
  refreshPredictionRows(); // the watchlist's Target hit badge reads the same rows as Predictions
  document.dispatchEvent(new Event("at-data")); // new data: the trades pane may need to follow

  // PREREQ A / metric fix: backfill sector/industry for tickers captured before
  // the profile fix, so the categorization metrics are not empty.
  backfillProfiles();
  backfillPrices();

  // Fix: push fresh local data to the cloud on open so the admin aggregate is
  // not stale relative to the local watchlist. Runs once per load.
  if (!autoSynced && self.ATCloud && ATCloud.enabled()) {
    autoSynced = true;
    ATCloud.getUser().then(function (u) {
      if (!u) return;
      ATSync.syncNow().then(function (r) {
        if (r && r.changed) { load(); return; }
        try { if (localStorage.getItem("at_main") === "admin" && !document.getElementById("tab-admin").hidden) renderAdmin(); } catch (e) { /* ignore */ }
      });
    }).catch(function () { /* not signed in */ });
  }
}

// Fetch sector/industry/market-cap for watchlist tickers that have none yet
// (events captured before the profile fix), then re-render the affected views.
async function backfillProfiles() {
  // Also names with a sector but no market cap: caps had no working source
  // before, so every existing ticker is missing one.
  const need = Object.keys(GROUPS).filter(function (t) {
    const evs = GROUPS[t] || [];
    return !evs.some(function (e) { return e.sector || e.industry; }) || !evs.some(function (e) { return e.marketCapBucket; });
  });
  if (!need.length || !self.ATPrices) return;
  let patched = false;
  for (let i = 0; i < need.length; i++) {
    const t = need[i];
    try {
      const sym = DATA.overrides[t] || ATPrices.toSymbol(t);
      const p = await ATPrices.fetchProfile(sym, true);
      if (p && (p.sector || p.industry || p.marketCap != null)) {
        // Only fields that resolved: a null must not overwrite a sector the
        // latest event already carries.
        const patch = {};
        ["sector", "industry", "marketCap", "marketCapBucket"].forEach(function (k) { if (p[k] != null) patch[k] = p[k]; });
        await ATStore.patchLatest(t, patch);
        patched = true;
      }
    } catch (e) { /* best-effort */ }
  }
  if (patched) {
    DATA = await ATStore.getAll();
    rebuildGroups();
    renderTable();
    render();
    renderUsageStats();
  }
}


// A price lookup that failed at capture time (Yahoo hiccup, offline) used to
// leave the event without an entry price forever, so its return was never
// computed. Fill those from the daily close on the event's day.
let pricesBackfilled = false;
async function backfillPrices() {
  if (pricesBackfilled || !self.ATPrices) return;
  pricesBackfilled = true;
  const need = {};
  ["events", "intraday"].forEach(function (kind) {
    (DATA[kind] || []).forEach(function (e) {
      if (e.priceAtEvent == null) (need[e.ticker] = need[e.ticker] || []).push({ kind: kind, e: e });
    });
  });
  const tickers = Object.keys(need);
  let patched = false;
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i], rows = need[t];
    try {
      const first = Math.min.apply(null, rows.map(function (r) { return r.e.ts; }));
      const bars = await ATPrices.fetchDaily(DATA.overrides[t] || ATPrices.toSymbol(t), isoDate(first - 10 * 86400000), true);
      if (!bars || !bars.length) continue;
      for (let j = 0; j < rows.length; j++) {
        const c = closeOnOrBefore(bars, Date.parse(isoDate(rows[j].e.ts)));
        if (c == null) continue;
        await ATStore.patchById(rows[j].kind, rows[j].e.id, { priceAtEvent: c, priceFetchFailed: false });
        patched = true;
      }
    } catch (e) { /* symbol unknown to Yahoo: set an override in the watchlist */ }
  }
  if (patched) {
    DATA = await ATStore.getAll();
    rebuildGroups();
    renderTable();
    render();
    renderUsageStats();
  }
}

// ---------- watchlist / stats ----------

function tickerStats(t) {
  const evs = GROUPS[t];
  const first = evs[0];
  const quote = QUOTES[t];
  const cur = quote ? quote.close : null;
  let retSince = null;
  if (cur != null && first.priceAtEvent != null) {
    retSince = (cur - first.priceAtEvent) / first.priceAtEvent;
  }
  let labeled = 0, correct = 0;
  evs.forEach(function (e) {
    if ((e.sentiment === "positive" || e.sentiment === "negative") &&
        e.priceAtEvent != null && cur != null) {
      labeled++;
      const up = cur > e.priceAtEvent;
      if ((e.sentiment === "positive" && up) || (e.sentiment === "negative" && !up)) correct++;
    }
  });
  let attUnits = 0, dwellMs = 0;
  evs.forEach(function (e) { attUnits += (e.views || 1); dwellMs += (e.dwellMs || 0); });
  const retPerView = (retSince != null && attUnits > 0) ? retSince / attUnits : null;
  const daysSince = Math.max(1, (Date.now() - first.ts) / 86400000);
  const retPerViewDay = (retSince != null && attUnits > 0) ? retSince / attUnits / daysSince : null;
  const hours = dwellMs / 3600000;
  const retPerHour = (retSince != null && hours > 0) ? retSince / hours : null;
  return {
    first: first, count: evs.length, cur: cur, retSince: retSince,
    labeled: labeled, correct: correct,
    hitRate: labeled ? correct / labeled : null,
    attUnits: attUnits, retPerView: retPerView, retPerViewDay: retPerViewDay, daysSince: daysSince,
    dwellMs: dwellMs, hours: hours, retPerHour: retPerHour
  };
}

function renderSummary() {
  const tickers = Object.keys(GROUPS);
  let labeled = 0, correct = 0, rvSum = 0, rvN = 0;
  tickers.forEach(function (t) {
    const s = tickerStats(t);
    labeled += s.labeled; correct += s.correct;
    if (s.retPerViewDay != null) { rvSum += s.retPerViewDay; rvN++; }
  });
  const el = document.getElementById("summary");
  el.innerHTML = "";
  // Count distinct tickers across BOTH databases so this matches the extension
  // badge regardless of the active basis (intraday/daily).
  const allTk = {};
  DATA.events.forEach(function (e) { allTk[e.ticker] = 1; });
  (DATA.intraday || []).forEach(function (e) { allTk[e.ticker] = 1; });
  addStat(el, "Tickers", String(Object.keys(allTk).length), "Distinct stocks you have tracked (across both databases; matches the toolbar badge).");
  addStat(el, "Daily events", String(DATA.events.length), "Attention events in the daily database (repeat views within 60 min merge into one).");
  addStat(el, "Intraday views", String((DATA.intraday || []).length), "Every individual view, recorded in the intraday database.");
  addStat(el, "Hit rate (" + basis + ")", labeled ? pct(correct / labeled) : "-", "Share of Positive/Negative labels whose direction matched the move from the price when viewed to the current price.");
  addStat(el, "Avg return / view / day", rvN ? pct(rvSum / rvN) : "-", "Average across stocks of (return since first attention) / (total views) / (days since first view) - normalizes return by attention and by how long ago you first looked.");
}

function addStat(parent, label, value, desc) {
  const d = document.createElement("div");
  d.className = "stat";
  if (desc) d.title = desc;
  d.innerHTML = "<b>" + value + "</b>" + label;
  parent.appendChild(d);
}

// ---------- analytics: forward return after a label (signal persistence) ----------

const HORIZONS = [
  { d: 1, label: "1d" }, { d: 5, label: "1w" }, { d: 10, label: "2w" },
  { d: 21, label: "1m" }, { d: 63, label: "3m" }, { d: 126, label: "6m" }, { d: 252, label: "1y" }
];

function labeledTickers() {
  return Object.keys(GROUPS).filter(function (t) {
    return GROUPS[t].some(function (e) { return e.sentiment === "positive" || e.sentiment === "negative"; });
  });
}

// For each Positive/Negative label, return = price-at-label -> close N trading
// days later. Bucketed per horizon; "signed" aligns the return with the call.
function computeEventStudy() {
  const buckets = {};
  HORIZONS.forEach(function (h) { buckets[h.d] = { pos: [], neg: [], signed: [] }; });
  labeledTickers().forEach(function (t) {
    const series = DAILY[t] || [];
    if (!series.length) return;
    GROUPS[t].forEach(function (e) {
      if (e.sentiment !== "positive" && e.sentiment !== "negative") return;
      const i0 = firstSeriesIndexAtOrAfter(series, e.ts);
      if (i0 < 0) return;
      const entry = e.priceAtEvent != null ? e.priceAtEvent : series[i0].close;
      if (!entry) return;
      HORIZONS.forEach(function (h) {
        const i1 = i0 + h.d;
        if (i1 >= series.length) return;
        const ret = series[i1].close / entry - 1;
        if (e.sentiment === "positive") { buckets[h.d].pos.push(ret); buckets[h.d].signed.push(ret); }
        else { buckets[h.d].neg.push(ret); buckets[h.d].signed.push(-ret); }
      });
    });
  });
  return buckets;
}

function avg(a) {
  if (!a.length) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

async function renderAnalytics() {
  const body = document.getElementById("analytics-body");
  const tks = labeledTickers();
  if (!tks.length) {
    body.innerHTML = "<div class='muted small'>No Positive/Negative labels yet. Label some stocks to build this.</div>";
    return;
  }
  body.innerHTML = "<div class='muted small'>Computing...</div>";
  await ensureDailySeries(tks);
  const b = computeEventStudy();
  let rows = "";
  HORIZONS.forEach(function (h) {
    rows += "<tr><td>" + h.label + "</td>" +
      anCell(avg(b[h.d].pos), b[h.d].pos.length) +
      anCell(avg(b[h.d].neg), b[h.d].neg.length) +
      anCell(avg(b[h.d].signed), b[h.d].signed.length) + "</tr>";
  });
  body.innerHTML =
    "<table class='an-table'><thead><tr>" +
    "<th>Horizon</th><th>After Positive</th><th>After Negative</th><th>Signal edge</th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table>" +
    "<div class='muted small an-note'>" +
    "<b>After Positive</b> / <b>After Negative</b>: average return from the price when you labeled to N trading days later. " +
    "<b>Signal edge</b>: return aligned with your call (Positive adds +return, Negative adds &minus;return); above 0 means your labels add value. " +
    "Each row needs labels old enough to have that much history; N = sample size. Basis: " + basis + "." +
    "</div>";
}

function anCell(v, n) {
  if (v == null) return "<td>-</td>";
  return "<td class='" + signClass(v) + "'>" + pct(v) + " <span class='n'>(" + n + ")</span></td>";
}

// One resolved outcome per Positive/Negative label: did the price move the way
// the call said over the next `horizon` trading days? Same forward-return
// machinery as the Event study, reduced to a hit/miss with its timestamp.
function forecastOutcomes(horizon) {
  const out = [];
  labeledTickers().forEach(function (t) {
    const series = DAILY[t] || [];
    if (!series.length) return;
    GROUPS[t].forEach(function (e) {
      if (e.sentiment !== "positive" && e.sentiment !== "negative") return;
      const i0 = firstSeriesIndexAtOrAfter(series, e.ts);
      if (i0 < 0) return;
      const entry = e.priceAtEvent != null ? e.priceAtEvent : series[i0].close;
      const i1 = i0 + horizon;
      if (!entry || i1 >= series.length) return;
      const ret = series[i1].close / entry - 1;
      out.push({ ts: e.ts, sentiment: e.sentiment, hit: e.sentiment === "positive" ? ret > 0 : ret < 0 });
    });
  });
  return out;
}

// Hit rates bucketed over time, plus the NASDAQ return of each bucket and a
// rolling correlation between the two. Buckets with no resolved call carry null
// so the lines break rather than reading as 0%.
function forecastTimeline(gran, horizon) {
  const cfg = trendBuckets(gran);
  const rows = cfg.buckets.map(function (b) { return { t: b.t, next: b.next, posN: 0, posH: 0, negN: 0, negH: 0 }; });
  forecastOutcomes(horizon).forEach(function (o) {
    for (let i = 0; i < rows.length; i++) {
      if (o.ts >= rows[i].t && o.ts < rows[i].next) {
        if (o.sentiment === "positive") { rows[i].posN++; if (o.hit) rows[i].posH++; }
        else { rows[i].negN++; if (o.hit) rows[i].negH++; }
        break;
      }
    }
  });
  const bs = (BENCH || []).map(function (p) { return { t: Date.parse(p.date), close: p.close }; });
  rows.forEach(function (r) {
    r.pos = r.posN ? r.posH / r.posN * 100 : null;
    r.neg = r.negN ? r.negH / r.negN * 100 : null;
    const n = r.posN + r.negN;
    r.all = n ? (r.posH + r.negH) / n * 100 : null;
    const c0 = closeAtOrBefore(bs, r.t), c1 = closeAtOrBefore(bs, r.next - 1);
    r.bench = (c0 != null && c1 != null && c0 > 0) ? c1 / c0 - 1 : null;
  });
  // Rolling Pearson r of the overall hit rate against the NASDAQ return over the
  // same buckets: does your reading get better or worse as the market moves?
  // pearson() needs 3 pairs, so the line starts once enough buckets carry both.
  const W = gran === "month" ? 6 : gran === "week" ? 8 : 10;
  rows.forEach(function (r, i) {
    // Only buckets that resolved a call of their own get a point: otherwise the
    // line runs on past the last data, recomputing r over a window that is only
    // shedding old buckets - a trend drawn from nothing.
    if (r.all == null) { r.corr = null; return; }
    const xs = [], ys = [];
    for (let j = Math.max(0, i - W + 1); j <= i; j++) {
      if (rows[j].all != null && rows[j].bench != null) { xs.push(rows[j].all); ys.push(rows[j].bench); }
    }
    r.corr = pearson(xs, ys);
  });
  return { rows: rows, labels: cfg.labels, titles: cfg.titles, W: W };
}

// Two scales in one plot: hit rates and the coin-flip baseline on the left axis
// (0-100%), the NASDAQ correlation on its own right axis (-1..1, labelled in the
// line's colour so it is clear which axis it reads against).
function drawForecastTimelineCanvas(cv, tipId, rows, labels, htmls) {
  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H;
  const padL = 40, padR = 34, padT = 12, padB = 22, pw = W - padL - padR, ph = H - padT - padB;
  const n = rows.length;
  const X = function (i) { return n <= 1 ? padL + pw / 2 : padL + (i / (n - 1)) * pw; };
  const YL = function (v) { return padT + (1 - v / 100) * ph; };
  const YR = function (v) { return padT + (1 - (v + 1) / 2) * ph; };
  c.font = "10px sans-serif";
  [0, 25, 50, 75, 100].forEach(function (g) {
    const y = YL(g);
    c.strokeStyle = TC().grid; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
    c.textAlign = "end"; c.fillStyle = TC().muted; c.fillText(g + "%", padL - 4, y + 3);
  });
  c.textAlign = "start"; c.fillStyle = "#4e9eff";
  [-1, -0.5, 0, 0.5, 1].forEach(function (g) { c.fillText(g.toFixed(1), W - padR + 4, YR(g) + 3); });
  c.save(); c.strokeStyle = "#8a93a6"; c.setLineDash([5, 4]); c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(padL, YL(50)); c.lineTo(W - padR, YL(50)); c.stroke(); c.restore();
  c.textAlign = "center"; c.fillStyle = TC().muted;
  labels.forEach(function (lab, i) { if (lab) c.fillText(String(lab), X(i), H - 6); });

  const draw = function (key, color, Y) {
    c.strokeStyle = color; c.fillStyle = color; c.lineWidth = 1.8;
    let pen = false;
    c.beginPath();
    rows.forEach(function (r, i) {
      if (r[key] == null) { pen = false; return; }
      const x = X(i), y = Y(r[key]);
      if (pen) c.lineTo(x, y); else { c.moveTo(x, y); pen = true; }
    });
    c.stroke();
    rows.forEach(function (r, i) { if (r[key] != null) { c.beginPath(); c.arc(X(i), Y(r[key]), 2.5, 0, Math.PI * 2); c.fill(); } });
  };
  draw("pos", "#2ecc71", YL);
  draw("neg", "#e74c3c", YL);
  draw("corr", "#4e9eff", YR);

  canvasHover[cv.id] = {
    kind: "line",
    lines: [{ label: "", color: "#4e9eff", pts: rows.map(function (r, i) { return { x: X(i), y: padT, v: 0, i: i }; }) }],
    titles: labels, html: htmls, multi: false, tipId: tipId,
    base: cv.width ? c.getImageData(0, 0, cv.width, cv.height) : null, geom: { padT: padT, ph: ph }
  };
}

// Brier score help: how to read your own number. A Positive call is scored as a 85% bet, a
// Negative as 15%, a Neutral as 50%; the score is the mean squared miss. With those fixed
// confidences a right call costs 0.023 and a wrong one 0.723, so the score follows the hit rate.
const BRIER_HELP = [
  "Brier score = average squared miss of your calls (Positive counts as an 85% bet, Negative as 15%, Neutral as 50%). Lower is better.",
  "",
  "How to read yours:",
  "  0.00 - 0.09  excellent: about 90%+ of calls right",
  "  0.09 - 0.16  good: about 80-90% right",
  "  0.16 - 0.25  fair: about 68-80% right",
  "  0.25         no skill: what answering Neutral (50%) every time scores",
  "  0.25 - 0.37  worse than not forecasting; 68% right is the break-even",
  "  above 0.37   worse than a coin flip (under 50% right)",
  "",
  "Each right call costs 0.02 and each wrong one 0.72, so one miss undoes about 30 hits: a few wrong calls move it a lot. " +
  "Neutral labels count 0.25 each and pull the score toward 0.25. Trust it only from about 30 resolved calls."
].join("\n");

// GROUP 4d: forecast accuracy card (hit rate, Brier, accuracy timeline).
async function renderForecast() {
  const el = document.getElementById("forecast-card");
  if (!el) return;
  let s;
  try { s = await ATStore.computeSentimentStats(30); } catch (e) { el.innerHTML = ""; return; }
  if (!s || !s.totalLabelled) { el.innerHTML = ""; return; }
  el.innerHTML =
    "<div class='att-head'>" +
    "<h3 id='sec-forecast' title='Realized accuracy of your Positive/Negative calls using a 30-day return proxy.'>Forecast Accuracy</h3>" +
    "<select id='fa-gran' class='span-sel'><option value='day'>Daily</option><option value='week'>Weekly</option><option value='month'>Monthly</option></select>" +
    "</div>" +
    "<div class='usage-cards'>" +
    admCard(s.hitRate == null ? "-" : pct(s.hitRate), "Overall hit rate", "Positive calls that rose + Negative calls that fell, over non-neutral labelled events with 30d history.") +
    admCard(s.brierScore == null ? "-" : s.brierScore.toFixed(3), "Brier score", BRIER_HELP) +
    admCard(String(s.totalLabelled), "Labelled events", "Total Positive/Neutral/Negative labels recorded.") +
    admCard(s.flipRate == null ? "-" : pct(s.flipRate), "Flip rate", "Share of labels that overwrote a different earlier label.") +
    "</div>" +
    "<canvas id='forecast-canvas' class='an-canvas'></canvas><div id='forecast-tip' class='muted small'></div>";
  const sel = document.getElementById("fa-gran");
  sel.value = faGran;
  sel.addEventListener("change", function () { faGran = sel.value; saveView(); drawForecastTimeline(); });
  await drawForecastTimeline();
}

async function drawForecastTimeline() {
  const cv = document.getElementById("forecast-canvas");
  const tip = document.getElementById("forecast-tip");
  if (!cv || !tip) return;
  const tks = labeledTickers();
  if (!tks.length) { tip.textContent = "No Positive/Negative labels yet."; return; }
  tip.textContent = "Computing...";
  await ensureDailySeries(tks);
  await ensureBenchmark();
  const tl = forecastTimeline(faGran, FA_HORIZON);
  const resolved = tl.rows.reduce(function (a, r) { return a + r.posN + r.negN; }, 0);
  if (!resolved) {
    clearAnCanvas(cv);
    tip.textContent = "No call is old enough to resolve yet: each one needs " + FA_HORIZON + " trading days of price history after the label.";
    return;
  }
  const rowHtml = function (color, label, v, sfx) {
    return "<span><span style='color:" + color + "'>&#9632;</span> " + label + " " + (v == null ? "n/a" : v) + (sfx || "") + "</span>";
  };
  const htmls = tl.rows.map(function (r, i) {
    return "<b>" + escapeHtml(tl.titles[i]) + "</b><div class='tip-rows'>" +
      rowHtml("#2ecc71", "Positive hit rate", r.pos == null ? null : r.pos.toFixed(0) + "% (" + r.posN + ")") +
      rowHtml("#e74c3c", "Negative hit rate", r.neg == null ? null : r.neg.toFixed(0) + "% (" + r.negN + ")") +
      rowHtml("#8a93a6", "Coin flip", "50%") +
      rowHtml("#4e9eff", "r vs NASDAQ", r.corr == null ? null : (r.corr >= 0 ? "+" : "") + r.corr.toFixed(2)) +
      "<span class='muted'>NASDAQ this period " + (r.bench == null ? "n/a" : pct(r.bench)) + "</span></div>";
  });
  drawForecastTimelineCanvas(cv, "forecast-tip", tl.rows, tl.labels, htmls);
  attachCanvasHover(cv);
  tip.innerHTML =
    "<span style='color:#2ecc71'>&#9632;</span> Positive hit rate &nbsp; " +
    "<span style='color:#e74c3c'>&#9632;</span> Negative hit rate &nbsp; " +
    "<span style='color:#8a93a6'>&#9632;</span> coin flip (50%, dashed) &nbsp; " +
    "<span style='color:#4e9eff'>&#9632;</span> rolling " + tl.W + "-bucket correlation of the overall hit rate with the NASDAQ return, right axis. " +
    "A call counts once it has " + FA_HORIZON + " trading days of history; " + resolved + " resolved so far.";
}

// ---------- usage analytics (calendar, distributions, timeline) ----------

function renderViewsStats() {
  renderUsageSummary();
  renderCalendar("cal-heat", viewsOf, "views");
  renderAttentionOverTime();
  renderAttentionByStock();
  renderHourDist("hour-dist", viewsOf, "views");
  renderDowDist("dow-dist", viewsOf, "views");
  renderCategoryDist("sector-dist", "sector", viewsOf, "views");
  renderCategoryDist("industry-dist", "industry", viewsOf, "views");
  renderTopStocks("top-stocks", viewsOf, "views");
  renderMarketCorr("market-corr", viewsOf, "Attention");
}
function renderTimeStats() {
  renderTimeSummary();
  renderTimeOverTime();
  renderTimeByStock();
  renderCalendar("cal-heat-time", minOf, "min");
  renderHourDist("hour-dist-time", minOf, "min");
  renderDowDist("dow-dist-time", minOf, "min");
  renderCategoryDist("sector-dist-time", "sector", minOf, "min");
  renderCategoryDist("industry-dist-time", "industry", minOf, "min");
  renderTopStocks("top-stocks-time", minOf, "min");
  renderMarketCorr("market-corr-time", minOf, "Time");
}

// Sector/industry categorization: attention (views or minutes) grouped by the
// event's captured sector/industry.
function renderCategoryDist(targetId, field, valOf, unit) {
  const el = document.getElementById(targetId); if (!el) return;
  const evs = currentEvents();
  const m = {}, sec = {}; // sec: category -> its sector (an industry's parent)
  evs.forEach(function (e) {
    const k = e[field] || "Unknown";
    m[k] = (m[k] || 0) + valOf(e);
    if (!sec[k] && e.sector) sec[k] = e.sector;
  });
  let arr = Object.keys(m).map(function (k) { return { t: k, v: m[k] }; }).sort(function (a, b) { return b.v - a.v; }).slice(0, 8);
  const known = arr.filter(function (x) { return x.t !== "Unknown"; });
  if (!known.length) { el.innerHTML = "<div class='muted small'>No " + field + " data yet (captured as you browse).</div>"; return; }
  const max = arr[0].v || 1;
  let html = "<ul class='toplist'>";
  arr.forEach(function (x) {
    const s = x.t === "Unknown" ? null : sec[x.t];
    html += "<li title='" + escapeHtml(x.t + (field === "industry" && s ? " (" + s + ")" : "")) + "'><span>" + escapeHtml(x.t) +
      "</span><span class='tbar' style='width:" + Math.round(x.v / max * 100) + "%;background-color:" + sectorColor(s) +
      "'></span><span class='tnum'>" + fmtVal(x.v, unit) + "</span></li>";
  });
  html += "</ul>";
  // Industry bars are colored by sector, so they need the key; sector rows name themselves.
  if (field === "industry") html += sectorLegendHtml(arr.map(function (x) { return sec[x.t]; }).filter(Boolean));
  el.innerHTML = html;
}
function renderUsageStats() { renderViewsStats(); renderTimeStats(); }


const viewsOf = function (e) { return e.views || 1; };
const minOf = function (e) { return (e.dwellMs || 0) / 60000; };
function fmtVal(v, unit) { return unit === "min" ? (Math.round(v * 10) / 10) : v; }

function renderCalendar(targetId, valOf, unit) {
  targetId = targetId || "cal-heat"; valOf = valOf || viewsOf; unit = unit || "views";
  const evs = currentEvents();
  const byDay = {};
  evs.forEach(function (e) { const d = isoDate(e.ts); byDay[d] = (byDay[d] || 0) + valOf(e); });
  let max = 1;
  Object.keys(byDay).forEach(function (d) { if (byDay[d] > max) max = byDay[d]; });
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const cur = new Date(end); cur.setDate(cur.getDate() - 7 * 52);
  cur.setDate(cur.getDate() - cur.getDay()); // align to Sunday
  let html = "<div class='cal-grid'>";
  while (cur <= end) {
    const d = isoDate(cur.getTime());
    const v = byDay[d] || 0;
    const lvl = v === 0 ? 0 : v >= max * 0.75 ? 4 : v >= max * 0.5 ? 3 : v >= max * 0.25 ? 2 : 1;
    html += "<div class='cal-cell lvl" + lvl + "' title='" + d + ": " + fmtVal(v, unit) + " " + unit + "'></div>";
    cur.setDate(cur.getDate() + 1);
  }
  html += "</div><div class='cal-legend'>Less " +
    "<span class='cal-cell lvl0'></span><span class='cal-cell lvl1'></span>" +
    "<span class='cal-cell lvl2'></span><span class='cal-cell lvl3'></span><span class='cal-cell lvl4'></span> More</div>";
  document.getElementById(targetId).innerHTML = html;
}

function barChartHtml(bars, wide) {
  let max = 1;
  bars.forEach(function (b) { if (b.v > max) max = b.v; });
  let html = "<div class='bars" + (wide ? " wide" : "") + "'>";
  bars.forEach(function (b) {
    const h = Math.round(b.v / max * 100);
    // The fill sizes against its own track, not the whole bar: the bar also holds
    // the label, so a 100% fill used to overflow and sit below the baseline.
    html += "<div class='bar' title='" + b.title + "'><div class='track'><div class='fill' style='height:" + h + "%'></div></div>" +
      "<div class='blab'>" + (b.label || "") + "</div></div>";
  });
  return html + "</div>";
}

function renderHourDist(targetId, valOf, unit) {
  targetId = targetId || "hour-dist"; valOf = valOf || viewsOf; unit = unit || "views";
  const evs = currentEvents();
  const h = new Array(24).fill(0);
  evs.forEach(function (e) { h[new Date(e.ts).getHours()] += valOf(e); });
  document.getElementById(targetId).innerHTML = barChartHtml(h.map(function (v, i) {
    return { v: v, label: (i % 6 === 0 ? i : ""), title: i + ":00 - " + fmtVal(v, unit) + " " + unit };
  }), true);
}

function renderDowDist(targetId, valOf, unit) {
  targetId = targetId || "dow-dist"; valOf = valOf || viewsOf; unit = unit || "views";
  const evs = currentEvents();
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const d = new Array(7).fill(0);
  evs.forEach(function (e) { d[new Date(e.ts).getDay()] += valOf(e); });
  document.getElementById(targetId).innerHTML = barChartHtml(d.map(function (v, i) {
    return { v: v, label: names[i], title: names[i] + " - " + fmtVal(v, unit) + " " + unit };
  }), false);
}

function renderTopStocks(targetId, valOf, unit) {
  targetId = targetId || "top-stocks"; valOf = valOf || viewsOf; unit = unit || "views";
  const evs = currentEvents();
  const m = {};
  evs.forEach(function (e) { m[e.ticker] = (m[e.ticker] || 0) + valOf(e); });
  const arr = Object.keys(m).map(function (t) { return { t: t, v: m[t] }; })
    .sort(function (a, b) { return b.v - a.v; }).slice(0, 8);
  if (!arr.length) { document.getElementById(targetId).innerHTML = "<div class='muted small'>No data.</div>"; return; }
  const max = arr[0].v;
  let html = "<ul class='toplist'>";
  arr.forEach(function (x) {
    const p = tickerProfile(x.t);
    html += "<li title='" + escapeHtml(nameOf(x.t) + (p.sector ? " - " + p.sector : "")) + "'><span>" + escapeHtml(nameOf(x.t)) +
      "</span><span class='tbar' style='width:" + Math.round(x.v / max * 100) + "%;background-color:" + sectorColor(p.sector) +
      "'></span><span class='tnum'>" + fmtVal(x.v, unit) + "</span></li>";
  });
  html += "</ul>" + sectorLegendHtml(arr.map(function (x) { return tickerProfile(x.t).sector; }).filter(Boolean));
  document.getElementById(targetId).innerHTML = html;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// One full, calendar-aligned period (day/week/month/year), `offset` periods back
// from the current one. Always spans first→last unit, never starting mid-period.
function buildAttBuckets(period, offset) {
  const now = new Date();
  const buckets = [];
  let labelFn, titleFn, kind, range;
  if (period === "day") {
    const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - offset);
    for (let i = 0; i < 24; i++) { const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), i).getTime(); buckets.push({ t: t, next: t + 3600000 }); }
    labelFn = function (t) { const h = new Date(t).getHours(); return h % 3 === 0 ? h + "h" : ""; };
    titleFn = function (t) { return isoDate(t) + " " + new Date(t).getHours() + ":00"; };
    kind = "line"; range = isoDate(d.getTime());
  } else if (period === "week") {
    const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay() - offset * 7);
    for (let i = 0; i < 7; i++) { const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i); buckets.push({ t: dd.getTime(), next: dd.getTime() + 86400000 }); }
    labelFn = function (t) { return DOW[new Date(t).getDay()]; };
    titleFn = function (t) { return isoDate(t); };
    kind = "line"; range = isoDate(buckets[0].t) + "  –  " + isoDate(buckets[6].t);
  } else if (period === "month") {
    const base = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    for (let i = 0; i < days; i++) { const dd = new Date(base.getFullYear(), base.getMonth(), 1 + i); buckets.push({ t: dd.getTime(), next: dd.getTime() + 86400000 }); }
    labelFn = function (t) { const day = new Date(t).getDate(); return (day === 1 || day % 5 === 0) ? day : ""; };
    titleFn = function (t) { return isoDate(t); };
    kind = "line"; range = MON[base.getMonth()] + " " + base.getFullYear();
  } else { // year
    const y = now.getFullYear() - offset;
    for (let m = 0; m < 12; m++) buckets.push({ t: new Date(y, m, 1).getTime(), next: new Date(y, m + 1, 1).getTime() });
    labelFn = function (t) { return MON[new Date(t).getMonth()]; };
    titleFn = function (t) { return MON[new Date(t).getMonth()] + " " + new Date(t).getFullYear(); };
    kind = "bar"; range = String(y);
  }
  return {
    buckets: buckets, kind: kind, range: range,
    labels: buckets.map(function (b, i) { return labelFn(b.t, i); }),
    titles: buckets.map(function (b) { return titleFn(b.t); })
  };
}

// Rolling multi-period trend (for Outlook mix): n buckets of `gran` ending now.
function trendBuckets(gran) {
  const buckets = [];
  let labelFn, titleFn;
  if (gran === "day") {
    const n = 30, step = 86400000; const d = new Date(); d.setHours(0, 0, 0, 0); const last = d.getTime();
    for (let i = 0; i < n; i++) { const t = last - (n - 1 - i) * step; buckets.push({ t: t, next: t + step }); }
    labelFn = function (t, i) { const dt = new Date(t); return i % 5 === 0 ? (dt.getMonth() + 1) + "/" + dt.getDate() : ""; };
    titleFn = function (t) { return isoDate(t); };
  } else if (gran === "month") {
    const n = 12; const base = new Date(); base.setDate(1); base.setHours(0, 0, 0, 0);
    const sIdx = base.getFullYear() * 12 + base.getMonth() - (n - 1);
    for (let i = 0; i < n; i++) { const mi = sIdx + i, y = Math.floor(mi / 12), m = ((mi % 12) + 12) % 12; buckets.push({ t: new Date(y, m, 1).getTime(), next: new Date(y, m + 1, 1).getTime() }); }
    labelFn = function (t) { const dt = new Date(t); return dt.getMonth() % 2 === 0 ? MON[dt.getMonth()] : ""; };
    titleFn = function (t) { return MON[new Date(t).getMonth()] + " " + new Date(t).getFullYear(); };
  } else { // week
    const n = 26, step = 7 * 86400000; const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); const last = d.getTime();
    for (let i = 0; i < n; i++) { const t = last - (n - 1 - i) * step; buckets.push({ t: t, next: t + step }); }
    labelFn = function (t) { const dt = new Date(t); return dt.getDate() <= 7 ? MON[dt.getMonth()] : ""; };
    titleFn = function (t) { return "week of " + isoDate(t); };
  }
  return { buckets: buckets, labels: buckets.map(function (b, i) { return labelFn(b.t, i); }), titles: buckets.map(function (b) { return titleFn(b.t); }) };
}

function assignViews(buckets, evs) {
  const vals = new Array(buckets.length).fill(0);
  evs.forEach(function (e) {
    for (let i = 0; i < buckets.length; i++) {
      if (e.ts >= buckets[i].t && e.ts < buckets[i].next) { vals[i] += (e.views || 1); break; }
    }
  });
  return vals;
}

// ---- shared analytics canvas drawing (line+dots or bars) with hover ----
const canvasHover = {}; // canvasId -> { kind, lines|bars, titles, tipId, base, geom }

// Dashed vertical guide marking the hovered time point. `c` already carries the
// dpr transform, so x/padT/ph are CSS pixels.
function drawVGuide(c, x, padT, ph) {
  c.save(); c.strokeStyle = TC().ink(0.35); c.lineWidth = 1; c.setLineDash([3, 3]);
  c.beginPath(); c.moveTo(x, padT); c.lineTo(x, padT + ph); c.stroke(); c.restore();
}

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  // willReadFrequently: hover re-renders read back via getImageData
  const c = cv.getContext("2d", { willReadFrequently: true }); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  return { c: c, W: W, H: H };
}

// "Nice numbers" axis ticks: round bounds + regular steps (100, not 99).
function niceNum(x, round) {
  if (!(x > 0)) return 1;
  const exp = Math.floor(Math.log10(x)), f = x / Math.pow(10, exp);
  let nf;
  if (round) { nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10; }
  else { nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10; }
  return nf * Math.pow(10, exp);
}
function niceTicks(min, max, count) {
  if (!(max > min)) max = min + 1;
  const range = niceNum(max - min, false);
  const step = niceNum(range / Math.max(1, count - 1), true);
  const nmin = Math.floor(min / step) * step, nmax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = nmin; v <= nmax + step * 0.5; v += step) ticks.push(parseFloat(v.toFixed(6)));
  return { min: nmin, max: nmax, step: step, ticks: ticks };
}

// lo defaults to 0 (bars); line charts pass a padded data-min so the plot zooms
// to the value range instead of wasting vertical space above a 0 baseline.
function drawAxes(c, W, H, padL, padR, padT, ph, max, labels, X, lo) {
  lo = lo || 0;
  const span = (max - lo) || 1;
  c.font = "10px sans-serif"; c.textAlign = "start";
  const tk = niceTicks(lo, max, 5);
  // Fractional axes (step < 1) need decimals or labels collapse to 0/1 dupes.
  const dec = tk.step >= 1 ? 0 : (tk.step >= 0.1 ? 1 : 2);
  tk.ticks.forEach(function (v) {
    if (v > max + 0.0001 || v < lo - 0.0001) return;
    const y = padT + (1 - (v - lo) / span) * ph;
    c.strokeStyle = TC().grid; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
    c.fillStyle = TC().muted; c.fillText(v.toFixed(dec), 4, y + 3);
  });
  c.textAlign = "center"; c.fillStyle = TC().muted;
  labels.forEach(function (lab, i) { if (lab !== "") c.fillText(String(lab), X(i), H - 6); });
}

function drawLineCanvas(cv, tipId, series, labels, titles) {
  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H;
  const padL = 36, padR = 10, padT = 10, padB = 20, pw = W - padL - padR, ph = H - padT - padB;
  const n = labels.length;
  // Zoom the y-axis to the value range (padded), not always to 0, so lines that
  // sit far from 0 (e.g. an index rebased near 100) fill the plot.
  // null = the line has no value at that x (it starts later than the axis, or a
  // bucket is empty). Those points are skipped by the scale and break the path,
  // so a line that has not started yet does not read as a value of 0.
  let lo = Infinity, hi = -Infinity;
  series.forEach(function (sr) { sr.vals.forEach(function (v) { if (v == null) return; if (v < lo) lo = v; if (v > hi) hi = v; }); });
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (hi === lo) { const pad = Math.abs(lo) * 0.05 || 1; lo -= pad; hi += pad; } // symmetric, keep negatives in range
  const tk = niceTicks(lo, hi, 5); lo = tk.min; hi = tk.max;
  const max = hi, span = (hi - lo) || 1;
  const X = function (i) { return n <= 1 ? padL + pw / 2 : padL + (i / (n - 1)) * pw; };
  const Y = function (v) { return padT + (1 - (v - lo) / span) * ph; };
  drawAxes(c, W, H, padL, padR, padT, ph, max, labels, X, lo);
  const lines = [];
  series.forEach(function (sr) {
    c.strokeStyle = sr.color; c.fillStyle = sr.color; c.lineWidth = 1.5;
    c.beginPath();
    let pen = false;
    sr.vals.forEach(function (v, i) {
      if (v == null) { pen = false; return; }
      const x = X(i), y = Y(v);
      if (pen) c.lineTo(x, y); else c.moveTo(x, y);
      pen = true;
    });
    c.stroke();
    // a dot on each value of a series that can be zero or negative (sr.dots), else on positive ones only;
    // with sr.dots a repeated value (a line carried forward) gets no new dot
    sr.vals.forEach(function (v, i) {
      if (sr.dotAt ? (v != null && sr.dotAt[i]) : sr.dots ? (v != null && (i === 0 || v !== sr.vals[i - 1])) : v > 0) { c.beginPath(); c.arc(X(i), Y(v), 2.5, 0, Math.PI * 2); c.fill(); }
    });
    lines.push({ label: sr.label, color: sr.color, pts: sr.vals.map(function (v, i) { return { x: X(i), y: Y(v), v: v, i: i }; }) });
  });
  canvasHover[cv.id] = { kind: "line", lines: lines, titles: titles, multi: series.length > 1, tipId: tipId, base: cv.width ? c.getImageData(0, 0, cv.width, cv.height) : null, geom: { padT: padT, ph: ph } };
}

// rotate: draw the x labels at -45 deg in a taller bottom margin. Long category
// names (feature sections) are wider than their bar, so drawn flat they run into
// each other and out of the canvas.
function drawBarCanvas(cv, tipId, vals, labels, titles, rotate) {
  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H;
  const padL = 36, padR = 10, padT = 10, padB = rotate ? 68 : 20, pw = W - padL - padR, ph = H - padT - padB;
  const n = vals.length; let max = 1; vals.forEach(function (v) { if (v > max) max = v; });
  max = niceTicks(0, max, 5).max;
  const bw = pw / n, X = function (i) { return padL + i * bw + bw / 2; };
  drawAxes(c, W, H, padL, padR, padT, ph, max, rotate ? [] : labels, X);
  if (rotate) drawRotatedLabels(c, labels, X, padT + ph + 6, padB - 12);
  const bars = [];
  c.fillStyle = "#4e9eff";
  vals.forEach(function (v, i) {
    const h = (v / max) * ph, x = padL + i * bw + 1, y = padT + ph - h, w = Math.max(1, bw - 2);
    c.fillRect(x, y, w, h);
    bars.push({ x: x, w: w, v: v, i: i });
  });
  canvasHover[cv.id] = { kind: "bar", bars: bars, titles: titles, tipId: tipId, base: cv.width ? c.getImageData(0, 0, cv.width, cv.height) : null, geom: { padT: padT, ph: ph } };
}

// Right-aligned at the bar so the text ends under it and grows up-left. At -45
// deg a label's vertical reach is width/sqrt(2), so budget clips it to the
// bottom margin; the hover title carries the full name.
function drawRotatedLabels(c, labels, X, top, budget) {
  const maxW = budget * Math.SQRT2;
  c.save();
  c.font = "10px sans-serif"; c.fillStyle = TC().muted; c.textAlign = "end"; c.textBaseline = "middle";
  labels.forEach(function (lab, i) {
    let t = String(lab == null ? "" : lab);
    if (!t) return;
    while (t.length > 1 && c.measureText(t).width > maxW) t = t.slice(0, -1);
    c.save(); c.translate(X(i), top); c.rotate(-Math.PI / 4); c.fillText(t, 0, 0); c.restore();
  });
  c.restore();
}

// Scatter with an "on-pace" diagonal, used by the Predictions pace chart. x is a
// 0..1 fraction; y is a fraction too but may go below 0 or above 1.
function drawScatterCanvas(cv, tipId, pts) {
  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H;
  const padL = 40, padR = 12, padT = 12, padB = 26, pw = W - padL - padR, ph = H - padT - padB;
  let lo = -0.1, hi = 1.1;
  pts.forEach(function (p) { if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; });
  const tk = niceTicks(lo, hi, 5); lo = tk.min; hi = tk.max;
  const span = (hi - lo) || 1;
  const X = function (v) { return padL + Math.max(0, Math.min(1, v)) * pw; };
  const Y = function (v) { return padT + (1 - (v - lo) / span) * ph; };
  c.font = "10px sans-serif";
  tk.ticks.forEach(function (v) {
    if (v > hi + 1e-6 || v < lo - 1e-6) return;
    const y = Y(v);
    c.strokeStyle = TC().grid; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
    c.textAlign = "start"; c.fillStyle = TC().muted; c.fillText(Math.round(v * 100) + "%", 4, y + 3);
  });
  c.textAlign = "center"; c.fillStyle = TC().muted;
  [0, 0.25, 0.5, 0.75, 1].forEach(function (v) { c.fillText(Math.round(v * 100) + "%", X(v), H - 8); });
  if (lo < 0 && hi > 0) { c.strokeStyle = TC().line; c.beginPath(); c.moveTo(padL, Y(0)); c.lineTo(W - padR, Y(0)); c.stroke(); }
  c.save(); c.strokeStyle = "#6b7590"; c.setLineDash([4, 4]);
  c.beginPath(); c.moveTo(X(0), Y(0)); c.lineTo(X(1), Y(1)); c.stroke(); c.restore();
  const dots = [];
  pts.forEach(function (p) {
    const x = X(p.x), y = Y(p.y);
    c.fillStyle = p.color; c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fill();
    dots.push({ x: x, y: y, title: p.title });
  });
  canvasHover[cv.id] = { kind: "scatter", dots: dots, tipId: tipId, base: cv.width ? c.getImageData(0, 0, cv.width, cv.height) : null, geom: { padT: padT, ph: ph } };
}

// Blank a chart canvas and drop its hover state (used when a panel has no data).
function clearAnCanvas(cv) { try { setupCanvas(cv); delete canvasHover[cv.id]; } catch (e) { /* ignore */ } }

function fmtTipNum(v) { return Math.round(v * 100) / 100; }

function attachCanvasHover(cv) {
  // The handler reads canvasHover[cv.id] fresh each move, so it only needs to be
  // bound once; guard against re-binding (some views re-render on a timer).
  if (cv.__hoverAttached) return;
  cv.__hoverAttached = true;
  cv.addEventListener("mousemove", function (ev) {
    const Hv = canvasHover[cv.id]; if (!Hv) { hideTip(); return; }
    const c = cv.getContext("2d");
    if (Hv.base) c.putImageData(Hv.base, 0, 0);
    if (Hv.kind === "scatter") {
      let best = null, bd = 169; // 13px pick radius
      Hv.dots.forEach(function (d) {
        const dx = d.x - ev.offsetX, dy = d.y - ev.offsetY, q = dx * dx + dy * dy;
        if (q < bd) { bd = q; best = d; }
      });
      if (!best) { hideTip(); cv.style.cursor = "default"; return; }
      c.strokeStyle = TC().fg; c.lineWidth = 1.5;
      c.beginPath(); c.arc(best.x, best.y, 6.5, 0, Math.PI * 2); c.stroke();
      cv.style.cursor = "crosshair";
      showTip(best.title, ev.clientX, ev.clientY);
      return;
    }
    if (Hv.kind === "line") {
      const pts = Hv.lines[0].pts; if (!pts.length) { hideTip(); cv.style.cursor = "default"; return; }
      let bi = 0, bd = Infinity;
      for (let i = 0; i < pts.length; i++) { const d = Math.abs(pts[i].x - ev.offsetX); if (d < bd) { bd = d; bi = i; } }
      drawVGuide(c, pts[bi].x, Hv.geom.padT, Hv.geom.ph);
      cv.style.cursor = "crosshair";
      let html;
      // Pre-built per-point HTML (charts whose series share no single scale, so
      // there is nothing sensible for the generic row formatter to print).
      if (Hv.html) {
        html = Hv.html[bi];
      } else if (Hv.multi) {
        const items = Hv.lines.map(function (L) { return { label: L.label, v: L.pts[bi].v, color: L.color }; })
          .filter(function (o) { return o.v > 0; }).sort(function (a, b) { return b.v - a.v; });
        html = "<b>" + escapeHtml(Hv.titles[bi]) + "</b>" + (items.length
          ? "<br>" + items.map(function (o) { return "<span style='color:" + (o.color || TC().muted) + "'>&#9632;</span> " + escapeHtml(o.label) + " " + fmtTipNum(o.v); }).join("<br>")
          : "");
      } else {
        html = escapeHtml(Hv.titles[bi] + " — " + fmtTipNum(Hv.lines[0].pts[bi].v));
      }
      showTip(html, ev.clientX, ev.clientY);
      return;
    } else {
      const x = ev.offsetX;
      for (const b of Hv.bars) {
        if (x >= b.x && x <= b.x + b.w) {
          drawVGuide(c, b.x + b.w / 2, Hv.geom.padT, Hv.geom.ph);
          cv.style.cursor = "crosshair"; showTip(escapeHtml(Hv.titles[b.i] + " — " + b.v), ev.clientX, ev.clientY); return;
        }
      }
    }
    hideTip(); cv.style.cursor = "default";
  });
  cv.addEventListener("mouseleave", function () {
    hideTip();
    const Hv = canvasHover[cv.id];
    if (Hv && Hv.base) cv.getContext("2d").putImageData(Hv.base, 0, 0);
  });
}

function renderAttentionOverTime() {
  const b = buildAttBuckets(atGran, atOffset);
  document.getElementById("at-range").textContent = b.range;
  document.getElementById("at-next").disabled = atOffset <= 0;
  const vals = assignViews(b.buckets, currentEvents());
  const cv = document.getElementById("att-time-canvas");
  if (b.kind === "line") {
    drawLineCanvas(cv, "att-time-tip", [{ label: "Attention", color: "#4e9eff", vals: vals }], b.labels, b.titles);
  } else {
    drawBarCanvas(cv, "att-time-tip", vals, b.labels, b.titles);
  }
}

// Stock-specific attention over time: one line+dots per ticker (same window).
function renderAttentionByStock() {
  const b = buildAttBuckets(atGran, atOffset);
  const colors = tickerColors();
  const evs = currentEvents();
  const series = {};
  Object.keys(colors).forEach(function (t) { series[t] = new Array(b.buckets.length).fill(0); });
  evs.forEach(function (e) {
    for (let i = 0; i < b.buckets.length; i++) {
      if (e.ts >= b.buckets[i].t && e.ts < b.buckets[i].next) { if (series[e.ticker]) series[e.ticker][i] += (e.views || 1); break; }
    }
  });
  const active = Object.keys(colors).filter(function (t) { return series[t].some(function (v) { return v > 0; }); });
  drawLineCanvas(document.getElementById("att-by-stock-canvas"), "att-by-stock-tip",
    active.map(function (t) { return { label: nameOf(t), color: colors[t], vals: series[t] }; }), b.labels, b.titles);
}

// ---- time-based attention (dwell) equivalents ----
function assignMetric(buckets, evs, fn) {
  const vals = new Array(buckets.length).fill(0);
  evs.forEach(function (e) {
    for (let i = 0; i < buckets.length; i++) {
      if (e.ts >= buckets[i].t && e.ts < buckets[i].next) { vals[i] += fn(e); break; }
    }
  });
  return vals;
}
function dwellMin(e) { return (e.dwellMs || 0) / 60000; }

function renderTimeOverTime() {
  const b = buildAttBuckets(atGran, atOffset);
  const vals = assignMetric(b.buckets, currentEvents(), dwellMin);
  const cv = document.getElementById("time-over-time-canvas");
  if (b.kind === "line") drawLineCanvas(cv, "time-over-time-tip", [{ label: "Minutes", color: "#2ecc71", vals: vals }], b.labels, b.titles);
  else drawBarCanvas(cv, "time-over-time-tip", vals, b.labels, b.titles);
}

function renderTimeByStock() {
  const b = buildAttBuckets(atGran, atOffset);
  const colors = tickerColors();
  const evs = currentEvents();
  const series = {};
  Object.keys(colors).forEach(function (t) { series[t] = new Array(b.buckets.length).fill(0); });
  evs.forEach(function (e) {
    for (let i = 0; i < b.buckets.length; i++) {
      if (e.ts >= b.buckets[i].t && e.ts < b.buckets[i].next) { if (series[e.ticker]) series[e.ticker][i] += dwellMin(e); break; }
    }
  });
  const active = Object.keys(colors).filter(function (t) { return series[t].some(function (v) { return v > 0; }); });
  drawLineCanvas(document.getElementById("time-by-stock-canvas"), "time-by-stock-tip",
    active.map(function (t) { return { label: nameOf(t), color: colors[t], vals: series[t] }; }), b.labels, b.titles);
}

function renderTimeSummary() {
  const el = document.getElementById("time-summary");
  const evs = currentEvents();
  let total = 0; const m = {};
  evs.forEach(function (e) { const d = e.dwellMs || 0; total += d; m[e.ticker] = (m[e.ticker] || 0) + d; });
  if (!total) { el.innerHTML = "<div class='muted small'>No time recorded yet. Time spent is measured as you browse stock pages (from this update onward).</div>"; return; }
  const views = evs.reduce(function (a, e) { return a + (e.views || 1); }, 0);
  let hhi = 0; Object.keys(m).forEach(function (t) { const s = m[t] / total; hhi += s * s; });
  // Shared attention categories (parity with the Views usage summary).
  const byTk = ATStore.byTicker(evs);
  let discovery = 0, revisit = 0;
  Object.keys(byTk).forEach(function (t) { discovery++; revisit += byTk[t].length - 1; });
  const lags = [];
  Object.keys(byTk).forEach(function (t) {
    const arr = byTk[t];
    const lab = arr.find(function (e) { return e.sentiment === "positive" || e.sentiment === "negative" || e.sentiment === "neutral"; });
    if (lab) lags.push(lab.ts - arr[0].ts);
  });
  const avgLag = lags.length ? lags.reduce(function (a, b) { return a + b; }, 0) / lags.length : null;
  const byDay = {};
  evs.forEach(function (e) { const d = isoDate(e.ts); byDay[d] = (byDay[d] || 0) + (e.dwellMs || 0); });
  const sortedDays = Object.keys(byDay).sort();
  const st = streaks(sortedDays);
  let bday = null, bmax = 0; sortedDays.forEach(function (d) { if (byDay[d] > bmax) { bmax = byDay[d]; bday = d; } });
  el.innerHTML = "";
  addStat(el, "Total time", fmtDur(total), "Total active time spent on stock pages (visible tab only), summed across all stocks.");
  addStat(el, "Avg time / view", fmtDur(views ? total / views : 0), "Total time divided by total views - how long an average view lasts.");
  addStat(el, "Concentration (HHI)", hhi.toFixed(2), "Herfindahl index of time by stock: sum of each stock's time-share squared. 1 = all time on one stock; near 0 = spread evenly.");
  addStat(el, "Effective # stocks", (hhi > 0 ? 1 / hhi : 0).toFixed(1), "1 / HHI - the equivalent number of stocks if your time were spread evenly.");
  addStat(el, "Discovery / revisit", discovery + " / " + revisit, "Discovery = distinct stocks (first views). Revisit = all later views of stocks already seen.");
  addStat(el, "Avg attention→label", avgLag == null ? "-" : fmtDur(avgLag), "Average time from a stock's first view to when you first labeled it.");
  addStat(el, "Current streak", st.current + "d", "Consecutive days up to today (or yesterday) with any time on stock pages.");
  addStat(el, "Longest streak", st.longest + "d", "Longest run of consecutive days with any time on stock pages.");
  addStat(el, "Longest no-attention", longestGap(sortedDays) + "d", "Longest gap (in days) with no time, including any current dry spell.");
  addStat(el, "Busiest day (time)", bday ? bday + " (" + fmtDur(bmax) + ")" : "-", "The single day with the most active time on stock pages.");
}

function tickerColors() {
  const ts = Object.keys(GROUPS).sort();
  const m = {};
  ts.forEach(function (t, i) { m[t] = PALETTE[i % PALETTE.length]; });
  return m;
}

function dailyViews(evs) {
  const m = {};
  evs.forEach(function (e) { const d = isoDate(e.ts); m[d] = (m[d] || 0) + (e.views || 1); });
  return m;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; syy += ys[i] * ys[i]; sxy += xs[i] * ys[i]; }
  const cov = n * sxy - sx * sy, dx = Math.sqrt(n * sxx - sx * sx), dy = Math.sqrt(n * syy - sy * sy);
  if (dx === 0 || dy === 0) return null;
  return cov / (dx * dy);
}

function shiftDay(iso, delta) {
  const p = iso.split("-");
  const d = new Date(+p[0], +p[1] - 1, +p[2]);
  d.setDate(d.getDate() + delta);
  return isoDate(d.getTime());
}

function daysBetween(a, b) {
  const pa = a.split("-"), pb = b.split("-");
  return Math.round((new Date(+pb[0], +pb[1] - 1, +pb[2]) - new Date(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
}

// Longest stretch (in days) with no attention, including the current dry spell.
function longestGap(days) {
  if (!days.length) return 0;
  let g = 0;
  for (let i = 1; i < days.length; i++) g = Math.max(g, daysBetween(days[i - 1], days[i]) - 1);
  return Math.max(g, daysBetween(days[days.length - 1], isoDate(Date.now())));
}

function streaks(days) {
  if (!days.length) return { current: 0, longest: 0 };
  const set = {}; days.forEach(function (d) { set[d] = 1; });
  let longest = 0;
  days.forEach(function (d) {
    if (set[shiftDay(d, -1)]) return; // not a run start
    let len = 1, cur = d;
    while (set[shiftDay(cur, 1)]) { len++; cur = shiftDay(cur, 1); }
    if (len > longest) longest = len;
  });
  let current = 0, d = isoDate(Date.now());
  if (!set[d]) d = shiftDay(d, -1); // a streak ending yesterday still counts as current
  while (set[d]) { current++; d = shiftDay(d, -1); }
  return { current: current, longest: longest };
}

function fmtDur(ms) {
  const h = ms / 3600000;
  if (h < 1) return Math.max(1, Math.round(ms / 60000)) + "m";
  if (h < 24) return h.toFixed(1) + "h";
  return (h / 24).toFixed(1) + "d";
}

function renderUsageSummary() {
  const el = document.getElementById("usage-summary");
  el.innerHTML = "";
  const evs = currentEvents();
  if (!evs.length) { el.innerHTML = "<div class='muted small'>No data.</div>"; return; }
  const m = {};
  evs.forEach(function (e) { m[e.ticker] = (m[e.ticker] || 0) + (e.views || 1); });
  const total = Object.keys(m).reduce(function (a, t) { return a + m[t]; }, 0);
  let hhi = 0; Object.keys(m).forEach(function (t) { const s = m[t] / total; hhi += s * s; });
  const byTk = ATStore.byTicker(evs);
  let discovery = 0, revisit = 0;
  Object.keys(byTk).forEach(function (t) { discovery++; revisit += byTk[t].length - 1; });
  const lags = [];
  Object.keys(byTk).forEach(function (t) {
    const arr = byTk[t];
    const lab = arr.find(function (e) { return e.sentiment === "positive" || e.sentiment === "negative" || e.sentiment === "neutral"; });
    if (lab) lags.push(lab.ts - arr[0].ts);
  });
  const avgLag = lags.length ? lags.reduce(function (a, b) { return a + b; }, 0) / lags.length : null;
  const byDay = dailyViews(evs);
  const sortedDays = Object.keys(byDay).sort();
  const st = streaks(sortedDays);
  let bday = null, bmax = 0;
  Object.keys(byDay).forEach(function (d) { if (byDay[d] > bmax) { bmax = byDay[d]; bday = d; } });

  addStat(el, "Concentration (HHI)", hhi.toFixed(2), "Herfindahl index of views by stock: sum of each stock's view-share squared. 1 = all attention on one stock; near 0 = spread evenly.");
  addStat(el, "Effective # stocks", (hhi > 0 ? 1 / hhi : 0).toFixed(1), "1 / HHI - the equivalent number of stocks if your attention were spread evenly.");
  addStat(el, "Discovery / revisit", discovery + " / " + revisit, "Discovery = distinct stocks (first views). Revisit = all later views of stocks already seen.");
  addStat(el, "Avg attention→label", avgLag == null ? "-" : fmtDur(avgLag), "Average time from a stock's first view to when you first labeled it.");
  addStat(el, "Current streak", st.current + "d", "Consecutive days up to today (or yesterday) with at least one view.");
  addStat(el, "Longest streak", st.longest + "d", "Longest run of consecutive days with at least one view.");
  addStat(el, "Longest no-attention", longestGap(sortedDays) + "d", "Longest gap (in days) with no views, including any current dry spell.");
  addStat(el, "Busiest day", bday ? bday + " (" + bmax + ")" : "-", "The single day with the most views.");
}

// Outlook mix over time: weekly stacked positive/neutral/negative.
// omBars keeps the plotted buckets so the hover tooltip can list the whole mix
// for a period, not just the segment the cursor happens to be over.
let omBars = [];

function renderSentimentMix() {
  const evs = currentEvents().filter(function (e) { return e.sentiment; });
  omBars = [];
  if (!evs.length) { document.getElementById("sentiment-mix").innerHTML = "<div class='muted small'>No labeled events yet.</div>"; return; }
  const cfg = trendBuckets(omGran);
  const buckets = cfg.buckets.map(function (b) { return { t: b.t, next: b.next, pos: 0, neu: 0, neg: 0, total: 0 }; });
  evs.forEach(function (e) {
    for (let i = 0; i < buckets.length; i++) {
      if (e.ts >= buckets[i].t && e.ts < buckets[i].next) {
        const b = buckets[i], w = (e.views || 1);
        if (e.sentiment === "positive") b.pos += w; else if (e.sentiment === "negative") b.neg += w; else b.neu += w;
        b.total += w; break;
      }
    }
  });
  // Each bar shows the MIX (share of that bucket's total outlooks), so bars are
  // comparable regardless of volume; each stacks to 100%.
  let html = "<div class='bars wide'>";
  buckets.forEach(function (b, i) {
    const tot = b.total || 0;
    omBars.push({ title: cfg.titles[i], pos: b.pos, neu: b.neu, neg: b.neg, total: tot });
    const seg = function (v, c) { return v ? "<div class='seg' style='height:" + (v / tot * 100) + "%;background:" + c + "'></div>" : ""; };
    html += "<div class='bar' data-i='" + i + "'><div class='stack'>" +
      (tot ? (seg(b.neg, "#e74c3c") + seg(b.neu, "#8a93a6") + seg(b.pos, "#2ecc71")) : "") +
      "</div><div class='blab'>" + cfg.labels[i] + "</div></div>";
  });
  document.getElementById("sentiment-mix").innerHTML = html + "</div>";
}

// Full mix for one period: every label is listed, including the ones with no
// outlooks that period, so the tooltip reads the same way bar to bar.
function omTipHtml(b) {
  const row = function (color, label, v) {
    const share = b.total ? Math.round(v / b.total * 100) + "%" : "-";
    return "<span><span style='color:" + color + "'>&#9632;</span> " + label + " " + share + " (" + v + ")</span>";
  };
  return "<b>" + escapeHtml(b.title) + "</b><div class='tip-rows'>" +
    row("#2ecc71", "positive", b.pos) + row("#8a93a6", "neutral", b.neu) + row("#e74c3c", "negative", b.neg) +
    "<span class='muted'>" + b.total + " outlook(s)</span></div>";
}

(function () {
  const host = document.getElementById("sentiment-mix");
  if (!host) return;
  host.addEventListener("mousemove", function (ev) {
    const bar = ev.target.closest(".bar");
    const b = bar ? omBars[+bar.getAttribute("data-i")] : null;
    if (!b) { hideTip(); return; }
    showTip(omTipHtml(b), ev.clientX, ev.clientY);
  });
  host.addEventListener("mouseleave", hideTip);
})();

// How attention and outlooks correlate with NASDAQ returns.
function dailyMetric(evs, valOf) {
  const m = {};
  evs.forEach(function (e) { const d = isoDate(e.ts); m[d] = (m[d] || 0) + valOf(e); });
  return m;
}

async function renderMarketCorr(targetId, valOf, noun) {
  targetId = targetId || "market-corr"; valOf = valOf || viewsOf; noun = noun || "Attention";
  const el = document.getElementById(targetId);
  el.innerHTML = "<div class='muted small'>Computing...</div>";
  await ensureBenchmark();
  if (!BENCH || BENCH.length < 5) { el.innerHTML = "<div class='muted small'>Not enough market data.</div>"; return; }
  // Steer by the attention period selector (Day/Week/Month/Year + nav). A
  // correlation over a handful of days is noise, so a period with fewer than
  // MC_MIN_DAYS trading days so far (any Day or Week, the first days of a
  // month) shows the rolling MC_ROLL_DAYS calendar days to the period's end.
  const win = buildAttBuckets(atGran, atOffset);
  let from = win.buckets[0].t, to = win.buckets[win.buckets.length - 1].next;
  const tradingDays = function (a, b) { return BENCH.filter(function (x) { const ms = Date.parse(x.date); return ms >= a && ms < b; }).length; };
  const inPeriod = tradingDays(from, to);
  let rolled = null;
  if (inPeriod < MC_MIN_DAYS) {
    to = Math.min(to, Date.parse(BENCH[BENCH.length - 1].date) + 86400000);
    from = to - MC_ROLL_DAYS * 86400000;
    rolled = { days: inPeriod, end: isoDate(to - 86400000) };
  }
  // The rolling chart reads MC_W trading days back from each point, so it is
  // fed from before the window too: its line then covers the whole window.
  const warmFrom = from - Math.ceil(MC_W * 1.6) * 86400000;
  const sameRet = {}, pastRet = {}, nextRet = {};
  for (let i = 1; i < BENCH.length; i++) sameRet[BENCH[i].date] = BENCH[i].close / BENCH[i - 1].close - 1;
  for (let i = 2; i < BENCH.length; i++) pastRet[BENCH[i].date] = BENCH[i - 1].close / BENCH[i - 2].close - 1;
  for (let i = 0; i < BENCH.length - 1; i++) nextRet[BENCH[i].date] = BENCH[i + 1].close / BENCH[i].close - 1;
  const evs = currentEvents().filter(function (e) { return e.ts >= from && e.ts < to; });
  // Measured exactly like the community line so a sole user gets identical
  // numbers: every view (the intraday set, whatever the Daily/Intraday basis),
  // one row = one view, bucketed by UTC day. The basis-dependent counts keyed by
  // local date (dailyMetric) disagreed with community_daily_attention on both.
  const att = {};
  (DATA.intraday || []).forEach(function (e) {
    const d = new Date(e.ts).toISOString().slice(0, 10), ms = Date.parse(d);
    if (ms < warmFrom || ms >= to) return;
    att[d] = (att[d] || 0) + (noun === "Time" ? (e.dwellMs || 0) / 60000 : 1);
  });
  const net = {};
  evs.forEach(function (e) {
    if (e.sentiment !== "positive" && e.sentiment !== "negative") return;
    const d = isoDate(e.ts);
    net[d] = (net[d] || 0) + (e.sentiment === "positive" ? 1 : -1);
  });
  function corr(map, retMap) {
    const xs = [], ys = [];
    Object.keys(map).forEach(function (d) { if (retMap[d] != null) { xs.push(map[d]); ys.push(retMap[d]); } });
    return { r: pearson(xs, ys), n: xs.length };
  }
  // The day switch picks which NASDAQ return a day's attention is paired with:
  // the previous trading day's (does yesterday's move drive today's research?),
  // the same day's (chasing / fear), or the next day's (does research lead?).
  const retAt = mcLag < 0 ? pastRet : (mcLag > 0 ? nextRet : sameRet);
  const lagTxt = MC_LAG_TXT[mcLag];
  // Community line (moved here from World): every user's attention per active
  // user that day, so a growing user base does not read as rising attention.
  const comm = {};
  (await communityDaily()).forEach(function (r) {
    const ms = Date.parse(r.day), u = +r.users || 0;
    if (!u || ms < warmFrom || ms >= to) return;
    comm[String(r.day)] = (noun === "Time" ? (+r.dwell_ms || 0) / 60000 : (+r.views || 0)) / u;
  });
  const hasComm = Object.keys(comm).some(function (d) { return Date.parse(d) >= from; });
  // Point-in-time values cover the window only; the warm-up days feed the chart.
  const inWin = function (m) { const o = {}; Object.keys(m).forEach(function (d) { if (Date.parse(d) >= from) o[d] = m[d]; }); return o; };
  const a = corr(inWin(att), retAt), cm = corr(inWin(comm), retAt), c = corr(net, nextRet);
  function row(label, o, color) {
    const v = o.r == null ? "-" : (o.r >= 0 ? "+" : "") + o.r.toFixed(2);
    const cls = o.r == null ? "" : (o.r >= 0 ? "pos" : "neg");
    return "<div class='corr-row'><span>" + (color ? "<span style='color:" + color + "'>&#9632;</span> " : "") + label +
      "</span><b class='" + cls + "'>" + v + "</b><span class='n'>n=" + o.n + "</span></div>";
  }
  // Rolling correlation of daily attention vs the chosen NASDAQ return over
  // MC_W trading days, warm-up included; with less history than that the
  // window shrinks to what there is (minimum 5).
  const days = BENCH.slice(1).map(function (x) { return x.date; })
    .filter(function (d) { const ms = Date.parse(d); return ms >= warmFrom && ms < to && retAt[d] != null; });
  const aArr = days.map(function (d) { return att[d] || 0; });
  const cArr = days.map(function (d) { return comm[d] || 0; });
  const rArr = days.map(function (d) { return retAt[d]; });
  const W = days.length >= MC_W + 5 ? MC_W : Math.min(30, Math.max(5, Math.floor(days.length / 2)));
  const mine = [], crowd = [], rlabels = [], htmls = [];
  const fmtR = function (p) { return p == null ? "-" : (p >= 0 ? "+" : "") + p.toFixed(2); };
  for (let i = W - 1; i < days.length; i++) {
    if (Date.parse(days[i]) < from) continue;
    const p = pearson(aArr.slice(i - W + 1, i + 1), rArr.slice(i - W + 1, i + 1));
    const q = hasComm ? pearson(cArr.slice(i - W + 1, i + 1), rArr.slice(i - W + 1, i + 1)) : null;
    const j = mine.length;
    mine.push(p); crowd.push(q);
    rlabels.push(j % 10 === 0 ? days[i].slice(5) : "");
    htmls.push("<b>" + escapeHtml(days[i]) + "</b> <span class='muted'>(" + W + "-day window)</span><br>" +
      "<span style='color:#4e9eff'>&#9632;</span> You r = " + fmtR(p) +
      (hasComm ? "<br><span style='color:#a29bfe'>&#9632;</span> Community r = " + fmtR(q) : ""));
  }
  const cid = targetId + "-rc";
  const haveChart = mine.length >= 2;
  const lagBtn = function (v, txt) { return "<button data-lag='" + v + "'" + (mcLag === v ? " class='on'" : "") + ">" + txt + "</button>"; };
  el.innerHTML =
    "<div class='seg mc-lag' title='Which NASDAQ return each day of attention is paired with.'>" +
      lagBtn(-1, "Previous day") + lagBtn(0, "Same day") + lagBtn(1, "Next day") + "</div>" +
    (rolled ? "<div class='muted small mc-rolled'>The selected " + atGran + " has " + (rolled.days ? "only " + rolled.days + " trading day" + (rolled.days === 1 ? "" : "s") : "no trading days") +
      " so far, so this shows the rolling " + MC_ROLL_DAYS + " days to " + rolled.end + ".</div>" : "") +
    (haveChart
      ? "<div class='muted small'>Rolling " + W + "-trading-day correlation: " + noun.toLowerCase() + " vs NASDAQ " + lagTxt + " return, yours" +
          (hasComm ? " and the community's (per active user)" : "") + ".</div>" +
        "<canvas id='" + cid + "' class='an-canvas'></canvas><div id='" + cid + "-tip' class='muted small'></div>"
      : "<div class='muted small'>Rolling-correlation chart needs more history (about two weeks); point-in-time values below for now.</div>") +
    row("You: " + noun.toLowerCase() + " vs NASDAQ " + lagTxt + " return", a, "#4e9eff") +
    row("Community: " + noun.toLowerCase() + " per user vs NASDAQ " + lagTxt + " return", cm, "#a29bfe") +
    row("Net outlook vs NASDAQ next-day return", c) +
    "<div class='muted small' style='margin-top:6px'>Pearson r over days with data. " +
    (mcLag < 0 ? "Previous-day r shows whether yesterday's move drives today's attention. "
      : mcLag > 0 ? "Next-day r shows whether attention runs ahead of the market: positive = heavy research days precede up days. "
      : "Positive same-day r = more research on up days (chasing); negative = on down days (fear). ") +
    "Compare the two lines: a gap means your reaction to the market differs from the crowd's. " +
    "Positive outlook r = your bullish/bearish days tend to precede matching NASDAQ moves.</div>";
  if (haveChart) {
    try {
      const series = [{ label: "You", color: "#4e9eff", vals: mine }];
      if (hasComm) series.push({ label: "Community", color: "#a29bfe", vals: crowd });
      drawCorrCanvas(document.getElementById(cid), cid + "-tip", series, rlabels, htmls);
      attachCanvasHover(document.getElementById(cid));
    } catch (e) { /* ignore */ }
  }
}

// Market-correlation day switch (shared by the Views and Time panels) and the
// community daily totals it compares against (cached 5 min).
let mcLag = (function () { try { const v = +localStorage.getItem("at_mc_lag"); return v === -1 || v === 1 ? v : 0; } catch (e) { return 0; } })();
const MC_MIN_DAYS = 10, MC_ROLL_DAYS = 30, MC_W = 20;
const MC_LAG_TXT = { "-1": "previous-day", "0": "same-day", "1": "next-day" };
const COMM_DAILY = { rows: null, ts: 0 };
async function communityDaily() {
  if (COMM_DAILY.rows && Date.now() - COMM_DAILY.ts < 300000) return COMM_DAILY.rows;
  if (!(self.ATCloud && ATCloud.enabled())) return [];
  try { COMM_DAILY.rows = await ATCloud.communityDailyAttention(800); COMM_DAILY.ts = Date.now(); }
  catch (e) { return COMM_DAILY.rows || []; } // not signed in / older backend: no community line
  return COMM_DAILY.rows;
}
["market-corr", "market-corr-time"].forEach(function (id) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", function (ev) {
    const b = ev.target.closest && ev.target.closest(".mc-lag button[data-lag]");
    if (!b) return;
    mcLag = +b.getAttribute("data-lag");
    try { localStorage.setItem("at_mc_lag", String(mcLag)); } catch (e) { /* ignore */ }
    renderMarketCorr("market-corr", viewsOf, "Attention");
    renderMarketCorr("market-corr-time", minOf, "Time");
  });
});

// GROUP 5b: "Target hit" badge when the current price has crossed the target
// price set for the ticker (direction follows the label: Negative = at/below).
function targetBadge(t) {
  const evs = GROUPS[t]; if (!evs || !evs.length) return "";
  // Only a call that Predictions also lists: Positive or Negative, with a target price.
  let e = null;
  for (let i = evs.length - 1; i >= 0; i--) {
    const x = evs[i];
    if (x.targetPrice != null && (x.sentiment === "positive" || x.sentiment === "negative")) { e = x; break; }
  }
  if (!e) return "";
  // Predictions' own verdict for this call, once its rows are built: Hit, Expired or Open.
  const row = PRED.rows.find(function (r) { return r.id === e.id; });
  if (row) {
    return row.status === "hit"
      ? " <span class='tgt-badge' title='Target " + row.target.toFixed(2) + " reached " + isoDate(row.touchTs) + ". See Predictions.'>Target hit</span>" : "";
  }
  // Rows not built yet: the same rules on the live quote alone.
  const dir = e.sentiment === "positive" ? 1 : -1, tp = e.targetPrice;
  if (e.priceAtEvent != null && (tp - e.priceAtEvent) * dir <= 0) return ""; // wrong side of the call: not scored
  if (e.horizonDays != null && Date.now() >= e.ts + e.horizonDays * 86400000) return ""; // judged at its deadline
  const q = QUOTES[t]; const cur = q ? q.close : null; if (cur == null) return "";
  if (!(dir > 0 ? cur >= tp : cur <= tp)) return "";
  return " <span class='tgt-badge' title='Current " + cur.toFixed(2) + " crossed target " + tp.toFixed(2) + ". See Predictions.'>Target hit</span>";
}

// Build the prediction rows in the background (daily prices for the called stocks,
// cached for the session) and redraw the watchlist, so its badge and the
// Predictions tab are always the same verdict.
async function refreshPredictionRows() {
  if (PRED.refreshing) return;
  const tks = predictionTickers();
  if (!tks.length) { PRED.rows = []; return; }
  PRED.refreshing = true;
  try { await ensureDailySeries(tks); await ensureBenchmark(); } catch (e) { /* the quote rule stays in force */ }
  finally { PRED.refreshing = false; }
  PRED.rows = buildPredictions();
  renderTable();
}

// GROUP 4c: conviction score per position, over every view of the stock.
// It used to be log2(1 + revisits) x max scroll x (...) over the latest day
// only, so a stock seen once that day (0 revisits) or not scrolled (depth 0,
// or not measurable, e.g. Perplexity) scored exactly 0 and showed "-" - most of
// the watchlist. Now views count from the first one and depth only scales the
// score between 0.5x and 1x, so every position gets a number.
function convictionFor(t) {
  let evs = (DATA.intraday || []).filter(function (e) { return e.ticker === t; });
  if (!evs.length) evs = GROUPS[t] || []; // daily events only (older captures)
  if (!evs.length) return null;
  let views = 0, maxScroll = null, focus = 0;
  evs.forEach(function (e) {
    views += e.views || 1;
    if (e.scrollDepth != null && (maxScroll == null || e.scrollDepth > maxScroll)) maxScroll = e.scrollDepth;
    if ((e.focusSwitches || 0) > focus) focus = e.focusSwitches || 0;
  });
  const score = Math.log2(1 + views) * (0.5 + 0.5 * (maxScroll || 0)) * (1 + focus * 0.1);
  return { score: score, views: views, maxScroll: maxScroll, focus: focus };
}
function convictionPill(t) {
  const c = convictionFor(t);
  if (!c) return "<span class='muted'>-</span>";
  const cls = c.score <= 1 ? "conv-red" : (c.score <= 3 ? "conv-amber" : "conv-green");
  const tip = ("Conviction = log2(1 + views) x (0.5 + 0.5 x max scroll depth) x (1 + focus switches x 0.1), over every view of this stock. " +
    c.views + " view(s), scroll " + (c.maxScroll == null ? "not measured" : Math.round(c.maxScroll * 100) + "%") + ", " +
    c.focus + " focus switch(es).").replace(/'/g, "&#39;");
  return "<span class='conv-pill " + cls + "' title='" + tip + "'>" + c.score.toFixed(1) + "</span>";
}

// PREREQ B: per-ticker captured metadata for the watchlist (sector, cap bucket,
// max scroll depth, max focus switches). Uses the latest non-null value.
function tickerMeta(t) {
  const evs = GROUPS[t] || [];
  let sector = null, cap = null, maxScroll = null, maxFocus = 0;
  evs.forEach(function (e) {
    if (e.sector) sector = e.sector;
    if (e.marketCapBucket) cap = e.marketCapBucket;
    if (e.scrollDepth != null && (maxScroll == null || e.scrollDepth > maxScroll)) maxScroll = e.scrollDepth;
    if ((e.focusSwitches || 0) > maxFocus) maxFocus = e.focusSwitches || 0;
  });
  return { sector: sector, cap: cap, maxScroll: maxScroll, maxFocus: maxFocus };
}

// Watchlist sort: click a column heading to sort by it, click again to reverse.
// null = the original order (by symbol). Remembered across visits.
const WL_COLS = {
  ticker: { text: true }, first: {}, events: {}, ret: {}, retview: {}, rethour: {}, hit: {}, sector: { text: true }, cap: {},
  scroll: {}, focus: {}, conviction: {}
};
const CAP_ORDER = { nano: 1, micro: 2, small: 3, mid: 4, large: 5, mega: 6 };
let WL_SORT = (function () {
  try { const v = JSON.parse(localStorage.getItem("at_wl_sort") || "null"); return v && WL_COLS[v.key] ? { key: v.key, dir: v.dir < 0 ? -1 : 1 } : null; } catch (e) { return null; }
})();

function wlValue(t, key, s, m) {
  switch (key) {
    case "ticker": return nameOf(t).toLowerCase();
    case "first": return s.first.ts;
    case "events": return s.count;
    case "ret": return s.retSince;
    case "retview": return s.retPerView;
    case "rethour": return s.retPerHour;
    case "hit": return s.hitRate;
    case "sector": return m.sector ? m.sector.toLowerCase() : null;
    case "cap": return m.cap ? (CAP_ORDER[String(m.cap).toLowerCase()] || null) : null;
    case "scroll": return m.maxScroll;
    case "focus": return m.maxFocus;
    case "conviction": { const c = convictionFor(t); return c ? c.score : null; }
  }
  return null;
}

function sortedWatchlist() {
  const keys = Object.keys(GROUPS).sort();
  if (!WL_SORT) return keys;
  const memo = {};
  keys.forEach(function (t) { memo[t] = wlValue(t, WL_SORT.key, tickerStats(t), tickerMeta(t)); });
  return keys.sort(function (a, b) {
    const x = memo[a], y = memo[b];
    // Stocks without a value go last whichever way the column is sorted.
    if (x == null && y == null) return a < b ? -1 : 1;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === "string" ? x.localeCompare(y) : x - y;
    return c !== 0 ? c * WL_SORT.dir : (a < b ? -1 : 1);
  });
}

function markWatchlistSort() {
  document.querySelectorAll("#watchlist thead th[data-sort]").forEach(function (th) {
    const on = WL_SORT && WL_SORT.key === th.getAttribute("data-sort");
    th.classList.toggle("sorted", !!on);
    th.setAttribute("aria-sort", on ? (WL_SORT.dir > 0 ? "ascending" : "descending") : "none");
    th.setAttribute("data-dir", on ? (WL_SORT.dir > 0 ? "\u25B2" : "\u25BC") : "");
  });
}

document.querySelector("#watchlist thead").addEventListener("click", function (ev) {
  const th = ev.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.getAttribute("data-sort");
  // First click: the natural direction (A to Z for text, largest first for numbers).
  if (WL_SORT && WL_SORT.key === key) WL_SORT = { key: key, dir: -WL_SORT.dir };
  else WL_SORT = { key: key, dir: WL_COLS[key].text ? 1 : -1 };
  try { localStorage.setItem("at_wl_sort", JSON.stringify(WL_SORT)); } catch (e) { /* ignore */ }
  renderTable();
});

function renderTable() {
  const tbody = document.querySelector("#watchlist tbody");
  tbody.innerHTML = "";
  markWatchlistSort();
  sortedWatchlist().forEach(function (t) {
    const s = tickerStats(t);
    const m = tickerMeta(t);
    const tr = document.createElement("tr");
    tr.dataset.ticker = t;
    if (t === selected && viewMode === "single") tr.classList.add("selected");
    tr.innerHTML =
      "<td><b>" + escapeHtml(nameOf(t)) + "</b>" + (NAMES[t] ? " <span class='muted small'>" + escapeHtml(t) + "</span>" : "") + targetBadge(t) + "</td>" +
      "<td>" + isoDate(s.first.ts) + "</td>" +
      "<td>" + s.count + "</td>" +
      "<td class='" + signClass(s.retSince) + "'>" + (s.retSince == null ? "-" : pct(s.retSince)) + "</td>" +
      "<td class='" + signClass(s.retPerView) + "'>" + (s.retPerView == null ? "-" : pct(s.retPerView)) + "</td>" +
      "<td class='" + signClass(s.retPerHour) + "'>" + (s.retPerHour == null ? "-" : pct(s.retPerHour)) + "</td>" +
      "<td>" + (s.hitRate == null ? "-" : pct(s.hitRate) + " (" + s.correct + "/" + s.labeled + ")") + "</td>" +
      "<td class='muted small'>" + (m.sector ? escapeHtml(m.sector) : "-") + "</td>" +
      "<td class='muted small'>" + (m.cap ? escapeHtml(m.cap) : "-") + "</td>" +
      "<td>" + (m.maxScroll == null ? "-" : Math.round(m.maxScroll * 100) + "%") + "</td>" +
      "<td>" + (m.maxFocus || 0) + "</td>" +
      "<td>" + convictionPill(t) + "</td>" +
      "<td><button class='del' title='Delete position'>&times;</button></td>";
    tr.querySelector(".del").addEventListener("click", function (ev) {
      ev.stopPropagation();
      deletePosition(t);
    });
    tr.addEventListener("click", function () { selectTicker(t); });
    tbody.appendChild(tr);
  });
}

async function deletePosition(t) {
  if (!confirm("Delete " + t + " and all its attention events?")) return;
  await ATStore.removePosition(t);
  delete SERIES[t]; delete DAILY[t]; delete QUOTES[t];
  if (selected === t) selected = null;
  await load();
}

// ---------- data fetching ----------

async function ensureSeries(tickers) {
  await Promise.all(tickers.map(async function (t) {
    if (SERIES[t]) return;
    const sym = DATA.overrides[t] || ATPrices.toSymbol(t);
    try {
      if (resolution === "hourly") {
        let bars = await ATPriceDB.getBars(sym, "1h");
        if (!bars.length) { await ATPriceDB.backfill(sym, "1h"); bars = await ATPriceDB.getBars(sym, "1h"); }
        SERIES[t] = bars.map(function (b) { return { date: new Date(b.t).toISOString(), close: b.c }; });
      } else {
        const fromISO = isoDate(GROUPS[t][0].ts - 7 * 86400000);
        SERIES[t] = await ATPrices.fetchDaily(sym, fromISO, true);
      }
    } catch (e) { delete SERIES[t]; } // transient (429, offline): retried on the next render instead of lost for the session
  }));
}

// Always-daily series for the event study (horizons are in trading days, so it
// must not use the resolution-dependent SERIES, which can be hourly).
async function ensureDailySeries(tickers) {
  await Promise.all(tickers.map(async function (t) {
    if (DAILY[t]) return;
    const sym = DATA.overrides[t] || ATPrices.toSymbol(t);
    try {
      const fromISO = isoDate(GROUPS[t][0].ts - 7 * 86400000);
      DAILY[t] = await ATPrices.fetchDaily(sym, fromISO, true);
    } catch (e) { delete DAILY[t]; }
  }));
}

// ---------- view switching ----------

function setView(v) {
  viewMode = v;
  try { ATStore.trackFeatureUse(v); } catch (e) { /* GROUP E4: usage tracking */ }
  document.querySelectorAll("#view-seg button").forEach(function (b) {
    b.classList.toggle("on", b.getAttribute("data-v") === v);
  });
  document.getElementById("idx-opts").classList.toggle("hidden", v !== "index");
  document.getElementById("period-ctl").classList.remove("hidden"); // period applies to all views
  document.getElementById("sym-edit").classList.toggle("hidden", v !== "single" || !selected);
  saveView();
  renderTable();
  render();
}

function selectTicker(t) {
  selected = t;
  viewMode = "single";
  saveView();
  document.querySelectorAll("#view-seg button").forEach(function (b) {
    b.classList.toggle("on", b.getAttribute("data-v") === "single");
  });
  document.getElementById("idx-opts").classList.add("hidden");
  document.getElementById("period-ctl").classList.remove("hidden");
  renderTable();
  render();
}

// Sticky view options: remember the user's chosen view/controls across sessions
// and logins (only the main tab was persisted before).
function saveView() {
  try {
    localStorage.setItem("at_view", JSON.stringify({
      viewMode: viewMode, selected: selected, resolution: resolution, period: period,
      method: (document.getElementById("method") || {}).value,
      rule: (document.getElementById("rule") || {}).value,
      win: (document.getElementById("win") || {}).value,
      lag: (document.getElementById("lag") || {}).value,
      netMethod: (document.getElementById("net-method") || {}).value,
      netRule: (document.getElementById("net-rule") || {}).value,
      netSrc: netSrcOn,
      ccy: ccyMode,
      atGran: atGran, omGran: omGran, faGran: faGran
    }));
  } catch (e) { /* ignore */ }
}

function restoreView() {
  const setSel = function (id, val) { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  let v = null;
  try { v = JSON.parse(localStorage.getItem("at_view") || "null"); } catch (e) { v = null; }
  if (v) {
    if (v.viewMode) viewMode = v.viewMode;
    if (v.selected != null) selected = v.selected;
    if (v.resolution) resolution = v.resolution;
    if (typeof v.period === "number") period = v.period;
    if (v.netSrc) netSrcOn = v.netSrc;
    const cm = v.ccy || v.netCcy;
    if (cm === "usd" || cm === "local") { ccyMode = cm; syncCcyButtons(); }
    if (v.atGran) atGran = v.atGran;
    if (v.omGran) omGran = v.omGran;
    if (v.faGran) faGran = v.faGran;
    setSel("resolution", resolution);
    setSel("period", String(period));
    setSel("method", v.method);
    setSel("rule", v.rule);
    setSel("win", v.win);
    setSel("lag", v.lag);
    setSel("net-method", v.netMethod);
    setSel("net-rule", v.netRule);
    setSel("at-gran", atGran);
    setSel("om-gran", omGran);
  }
  document.querySelectorAll("#view-seg button").forEach(function (b) {
    b.classList.toggle("on", b.getAttribute("data-v") === viewMode);
  });
  const idx = document.getElementById("idx-opts"); if (idx) idx.classList.toggle("hidden", viewMode !== "index");
}

async function render() {
  resetZoom(); // a new view/period/ticker starts from the full window
  const ist = document.getElementById("idx-stats");
  if (ist) { ist.classList.add("hidden"); ist.innerHTML = ""; }
  if (viewMode === "single") return renderSingle();
  if (viewMode === "compare") return renderCompare();
  return renderIndex();
}

// ---------- single ----------

// PREREQ B: captured metadata strip for the single-stock view.
function singleMetaHtml(t) {
  const evs = GROUPS[t] || [];
  let sector = null, industry = null, cap = null, w52 = null;
  evs.forEach(function (e) {
    if (e.sector) sector = e.sector;
    if (e.industry) industry = e.industry;
    if (e.marketCapBucket) cap = e.marketCapBucket;
    if (e.week52Position != null) w52 = e.week52Position;
  });
  const parts = [];
  if (sector) parts.push(escapeHtml(sector));
  if (industry) parts.push(escapeHtml(industry));
  if (cap) parts.push(escapeHtml(cap) + " cap");
  let bar = "";
  if (w52 != null) {
    const pv = Math.round(Math.max(0, Math.min(1, w52)) * 100);
    bar = "<span class='w52' title='Entry price sat at " + pv + "% of the 52-week range (0% = 52w low, 100% = 52w high).'>" +
      "<span class='w52-fill' style='width:" + pv + "%'></span></span> <span class='muted'>52w " + pv + "%</span>";
  }
  if (!parts.length && !bar) return "";
  return parts.join(" &middot; ") + (bar ? (parts.length ? " &middot; " : "") + bar : "");
}

async function renderSingle() {
  const symEdit = document.getElementById("sym-edit");
  const metaEl = document.getElementById("single-meta");
  if (!selected) {
    symEdit.classList.add("hidden");
    document.getElementById("chart-title").textContent = "Select a ticker";
    document.getElementById("chart-msg").textContent = "";
    if (metaEl) metaEl.innerHTML = "";
    setLegend("");
    clearCanvas();
    return;
  }
  symEdit.classList.remove("hidden");
  if (metaEl) metaEl.innerHTML = singleMetaHtml(selected);
  document.getElementById("chart-title").textContent = nameOf(selected) + " (indexed to 100 at the start of the shown window)";
  document.getElementById("sym-input").value = DATA.overrides[selected] || ATPrices.toSymbol(selected);
  document.getElementById("chart-msg").textContent = "Loading price history...";
  clearCanvas();

  await ensureSeries([selected]);
  await ensureFx([selected]);
  const firstTs = GROUPS[selected][0].ts; // default start = your first view of this stock
  let series = ccySeries(selected);
  // "Since first view" includes the whole first-view day so a freshly-tracked
  // stock still has at least one daily close to plot.
  const cut = period ? Math.max(firstTs, Date.now() - period * 86400000)
    : (resolution === "hourly" ? firstTs : utcDay(firstTs));
  series = series.filter(function (p) { return Date.parse(p.date) >= cut; });
  if (!series.length) {
    document.getElementById("chart-msg").textContent =
      "No price data for \"" + (DATA.overrides[selected] || ATPrices.toSymbol(selected)) + "\" in this period.";
    setLegend("");
    return;
  }
  document.getElementById("chart-msg").textContent = "";

  // Rebase to 100 at the price recorded the moment you first viewed it. On the
  // full window the line begins with an explicit 100 anchor (snapped to the
  // grid); subsequent points are bars strictly after the first view, plus the
  // live quote, all relative to that entry price. Under a Period the first view
  // is usually outside the window, so the anchor is dropped and the window's own
  // first bar starts the line - drawMulti re-anchors it to 100 from there.
  const g0 = GROUPS[selected][0];
  const base = g0.priceAtEvent != null ? ccyPrice(selected, g0.priceAtEvent, g0.ts) : series[0].close;
  const sx = series.map(function (p) { return Date.parse(p.date); });
  const cur = QUOTES[selected] ? ccyPrice(selected, QUOTES[selected].close, Date.now()) : null;
  const startT = period ? Date.parse(series[0].date) : snapGrid(firstTs);
  const pts = [];
  if (!period) pts.push({ t: startT, v: 100 });
  series.forEach(function (p) {
    const t = Date.parse(p.date);
    if (!period && t <= firstTs) return;
    pts.push({ t: t, v: p.close / base * 100 });
  });
  if (cur != null) { const nowT = snapGrid(Date.now()); if (nowT > pts[pts.length - 1].t) pts.push({ t: nowT, v: cur / base * 100 }); }
  const line = { color: "#4e9eff", label: nameOf(selected), points: pts };
  const lineXs = pts.map(function (p) { return p.t; });
  const ptVal = {}; pts.forEach(function (p) { ptVal[p.t] = p.v; });
  const mk = dayAgg(GROUPS[selected]).filter(function (d) { return d.t >= startT; }).map(function (d) {
    const markerT = nearestT(lineXs, d.t); // sit on a plotted line point
    const price = d.price != null ? d.price : interp(series, sx, d.t);
    let ret = "";
    const dp = ccyPrice(selected, d.price, d.t);
    if (dp != null && cur != null) ret = " | since: " + pct((cur - dp) / dp);
    return {
      t: markerT, v: ptVal[markerT], r: intensityRadius(d.dwellMin), vline: true,
      color: sentColor(d.sentiment), star: d.rationales.length > 0,
      text: d.date + " | " + fmtDur(d.dwellMin * 60000) + " spent, " + d.views + " view(s) | label: " +
        (d.sentiment || "none") + " | price@event: " + (d.price != null ? d.price.toFixed(2) : "n/a") + ret +
        rationaleLines(d.rationales)
    };
  });
  const lines = [line];
  const bench = await benchLine(startT, 100);
  if (bench) lines.push(bench);
  drawMulti(lines, { markers: mk, baseline: 100, gapMs: gapMs(), intraday: resolution === "hourly" });
  setLegend(sentimentLegend() + " " + benchLegend() +
    "<span class='muted small'>&nbsp; marker size = time spent that day; &#10022; = rationale attached. " +
    ccyNoteText() + " price@event is in the listing's currency.</span>");
}

// ---------- compare (separate, rebased to 100) ----------

async function renderCompare() {
  document.getElementById("sym-edit").classList.add("hidden");
  document.getElementById("chart-title").textContent = "All positions (each indexed to 100 at the start of the shown window)";
  document.getElementById("chart-msg").textContent = "Loading price history...";
  clearCanvas();

  const tickers = Object.keys(GROUPS).sort();
  if (!tickers.length) { document.getElementById("chart-msg").textContent = "Nothing tracked yet."; setLegend(""); return; }
  await ensureSeries(tickers);
  await ensureFx(tickers);

  const lines = [], allMarkers = [], legend = [];
  const cut = period ? Date.now() - period * 86400000 : 0; // Period trims the visible window
  let ci = 0, used = 0;
  tickers.forEach(function (t) {
    const series = ccySeries(t);
    if (!series.length) return;
    const firstTs = GROUPS[t][0].ts;
    const startIdx = firstSeriesIndexAtOrAfter(series, firstTs);
    // Anchor at the price recorded the moment you first viewed it (not a bar's
    // open/close), so the rebase is identical at daily and hourly resolution.
    // startIdx < 0 (first viewed after the last bar) leaves priceAtEvent as the
    // only sound anchor.
    const base = GROUPS[t][0].priceAtEvent != null ? ccyPrice(t, GROUPS[t][0].priceAtEvent, firstTs) : (startIdx < 0 ? null : series[startIdx].close);
    if (!base) return;
    const color = PALETTE[ci % PALETTE.length]; ci++; used++;
    const sx = series.map(function (p) { return Date.parse(p.date); });
    // Rebased to 100 at first attention: the line begins at 100 and shows only
    // the since-attention path, extended to the current price. Weekends/holidays
    // dash via drawMulti's gap rule.
    // Anchor (100) snapped to the chart grid (hour for hourly, UTC day for
    // daily) so every stock first viewed in the same period shares one x column
    // instead of each contributing a distinct intraday timestamp.
    const anchorT = snapGrid(firstTs);
    const pts = [{ t: anchorT, v: 100 }];
    for (let i = Math.max(0, startIdx); i < series.length; i++) {
      if (sx[i] > firstTs) pts.push({ t: sx[i], v: series[i].close / base * 100 });
    }
    const q = QUOTES[t];
    const qc = q && q.close ? ccyPrice(t, q.close, Date.now()) : null;
    if (qc) {
      const nowT = snapGrid(Date.now());
      if (nowT > pts[pts.length - 1].t) pts.push({ t: nowT, v: qc / base * 100 });
    }
    const vpts = cut ? pts.filter(function (p) { return p.t >= cut; }) : pts;
    if (!vpts.length) { ci--; used--; return; } // nothing in the window
    lines.push({ color: color, points: vpts, label: nameOf(t) });

    const lineXs = vpts.map(function (p) { return p.t; });
    const ptVal = {}; vpts.forEach(function (p) { ptVal[p.t] = p.v; });
    dayAgg(GROUPS[t]).forEach(function (d) {
      if (cut && d.t < cut) return;
      // Dots mark attention events on the return line, snapped to a plotted point.
      const markerT = nearestT(lineXs, d.t);
      allMarkers.push({
        t: markerT, v: ptVal[markerT], r: Math.max(3, intensityRadius(d.dwellMin) - 1),
        color: sentColor(d.sentiment), label: nameOf(t), star: d.rationales.length > 0,
        text: nameOf(t) + " " + d.date + " | " + fmtDur(d.dwellMin * 60000) + " spent, " + d.views + " view(s) | " + (d.sentiment || "none") +
          (d.price != null ? " | price@event " + d.price.toFixed(2) : "") +
          rationaleLines(d.rationales)
      });
    });
  });

  if (!used) { document.getElementById("chart-msg").textContent = "No price data available for tracked tickers."; setLegend(""); return; }
  document.getElementById("chart-msg").textContent = "";
  let earliest = Infinity;
  lines.forEach(function (L) { if (L.points.length && L.points[0].t < earliest) earliest = L.points[0].t; });
  const bench = await benchLine(earliest, 100);
  if (bench) lines.push(bench);
  compareLines = lines;
  compareOpts = { markers: allMarkers, baseline: 100, gapMs: gapMs(), intraday: resolution === "hourly", hideLabels: true, table: true };
  comparePinned = null; compareHover = null;
  drawCompare(null);
  setCompareLegend();
}

function setCompareLegend() {
  setLegend(benchLegend() + " <span class='muted small'>&nbsp; hover to isolate a stock, click to pin it" +
    (comparePinned ? " (pinned: <b>" + escapeHtml(comparePinned) + "</b>, click again to release)" : "") +
    "; the float lists all returns at that time; &#10022; = rationale attached. " + ccyNoteText() + "</span>");
}

// ---------- index (portfolio) ----------

async function renderIndex() {
  document.getElementById("sym-edit").classList.add("hidden");
  document.getElementById("chart-msg").textContent = "Building index...";
  clearCanvas();

  const tickers = Object.keys(GROUPS);
  if (!tickers.length) { document.getElementById("chart-title").textContent = "Index"; document.getElementById("chart-msg").textContent = "Nothing tracked yet."; setLegend(""); return; }
  await ensureSeries(tickers);
  await ensureFx(tickers);

  const method = document.getElementById("method").value;
  const rule = document.getElementById("rule").value;
  const winDays = +document.getElementById("win").value || 0;
  const lagDays = +document.getElementById("lag").value || 0;
  const res = computeIndex(method, rule, winDays, lagDays);
  if (!res.curve.length) {
    document.getElementById("chart-title").textContent = "Index";
    document.getElementById("chart-msg").textContent = res.note || "Not enough data.";
    setLegend("");
    return;
  }
  // Period: trim to the last N days and re-anchor that window to 100.
  let curve = res.curve;
  if (period) {
    const cut = Date.now() - period * 86400000;
    let idx = curve.findIndex(function (p) { return p.t >= cut; });
    if (idx > 0) { const b = curve[idx].v || 1; curve = curve.slice(idx).map(function (p) { return { t: p.t, v: p.v / b * 100 }; }); }
  }
  const first = curve[0].v, last = curve[curve.length - 1].v;
  const ret = (last - first) / first;
  document.getElementById("chart-title").textContent =
    methodLabel(method) + " index: " + pct(ret) + " (100 → " + last.toFixed(1) + ")";
  document.getElementById("chart-msg").textContent = res.trimmedFrom
    ? "Starts " + isoDate(curve[0].t) + ", the first day this rule held a stock (attention since " + isoDate(res.trimmedFrom) + ")."
    : "";
  const lines = [{ color: "#4e9eff", label: "Index", points: curve }];
  const bench = await benchLine(curve[0].t, 100);
  if (bench) lines.push(bench);
  drawMulti(lines, { baseline: 100, gapMs: gapMs(), intraday: resolution === "hourly" });
  setLegend(
    benchLegend() +
    " <span class='muted small'>Dashed = start (100). " + holdingNote(rule) + " " +
    (method === "attention" ? "Weights track each name's share of total attention." : "Equal weight across held names.") +
    (winDays && method === "attention" ? " Weights use only the last " + winDays + " days of views." : "") +
    (lagDays ? " Decision lag " + lagDays + " d: a view or label acts " + lagDays + " days later." : "") +
    " No leverage. " + ccyNoteText() + "</span>"
  );
  try { await renderIndexStats(res.bars, curve, method); } catch (e) { /* stats are best-effort */ }
}

function computeIndex(method, rule, winDays, lagDays) {
  const lagMs = lagDays > 0 ? lagDays * 86400000 : 0;
  const winMs = winDays > 0 ? winDays * 86400000 : 0;
  let lastW = null;
  const cs = {};
  Object.keys(GROUPS).forEach(function (t) { cs[t] = ccySeries(t); });
  const tks = Object.keys(GROUPS).filter(function (t) { return cs[t].length; });
  if (!tks.length) return { curve: [], note: "No price data available." };

  const arrs = {}, entryTime = {};
  tks.forEach(function (t) {
    arrs[t] = cs[t].map(function (p) { return { t: Date.parse(p.date), close: p.close }; });
    entryTime[t] = Math.max(GROUPS[t][0].ts, arrs[t][0].t);
  });

  const set = new Set();
  tks.forEach(function (t) { cs[t].forEach(function (p) { set.add(p.date); }); });
  const startTime = Math.min.apply(null, tks.map(function (t) { return entryTime[t]; }));
  const md = Array.from(set).sort().filter(function (d) { return Date.parse(d) >= startTime - 86400000; });
  if (md.length < 2) return { curve: [], note: "Not enough overlapping price history yet." };

  function weightsAt(dateStr) {
    const priceTime = Date.parse(dateStr);
    // Only what happened before this bar's 16:00 ET close can set the weights
    // traded at it. The end of the UTC day (19:59/18:59 ET) let an after-hours
    // view or label trade at a close that had already printed.
    const sigTime = closeTs(dateStr) - 1 - lagMs;
    const held = tks.filter(function (t) {
      return sigTime >= entryTime[t] && closeAtOrBefore(arrs[t], priceTime) != null && heldAt(GROUPS[t], sigTime, rule);
    });
    const w = {};
    if (!held.length) return w;
    if (method === "equal") {
      held.forEach(function (t) { w[t] = 1 / held.length; });
    } else {
      let tot = 0; const sh = {};
      held.forEach(function (t) { sh[t] = attentionAt(GROUPS[t], sigTime, winMs); tot += sh[t]; });
      if (tot > 0) { held.forEach(function (t) { w[t] = sh[t] / tot; }); lastW = w; }
      else {
        // Nothing viewed inside the window: keep the previous basket (the names
        // still held) instead of moving to cash, as Q9's recent basket does.
        let pt = 0;
        if (lastW) held.forEach(function (t) { pt += lastW[t] || 0; });
        held.forEach(function (t) { w[t] = pt > 0 ? (lastW[t] || 0) / pt : 1 / held.length; });
      }
    }
    return w;
  }

  let equity = 100;
  const curve = [{ t: Date.parse(md[0]), v: 100 }];
  const bars = []; // per-bar detail (weights, return, contributions) for the stats panel
  let wPrev = weightsAt(md[0]);
  let dPrev = md[0];
  for (let i = 1; i < md.length; i++) {
    const d = md[i];
    let r = 0;
    const contrib = {};
    for (const t in wPrev) {
      const p0 = closeAtOrBefore(arrs[t], Date.parse(dPrev));
      const p1 = closeAtOrBefore(arrs[t], Date.parse(d));
      if (p0 != null && p1 != null && p0 > 0) { const cr = wPrev[t] * (p1 / p0 - 1); r += cr; contrib[t] = cr; }
    }
    equity *= (1 + r);
    curve.push({ t: Date.parse(d), v: equity });
    const wNext = weightsAt(d);
    bars.push({ t: Date.parse(d), r: r, w: wPrev, wNext: wNext, contrib: contrib });
    wPrev = wNext;
    dPrev = d;
  }
  // Start where the index first holds something. Before that it sits flat at
  // 100 in cash - e.g. "Long only on Positive" before the first Positive label,
  // or a stretch of label-less views loaded from browsing history - and a long
  // flat run squeezes everything that actually moved into a corner.
  const firstHeld = bars.findIndex(function (b) { return Object.keys(b.w).length > 0; });
  if (firstHeld < 0) return { curve: [], note: "The index has not held any stock yet under this rule" + (rule === "positive" ? " (no Positive label so far)." : ".") };
  if (firstHeld > 0) return { curve: curve.slice(firstHeld), bars: bars.slice(firstHeld), note: "", trimmedFrom: curve[0].t };
  return { curve: curve, bars: bars, note: "" };
}

// held(t) per rule, considering events up to `time`
function heldAt(events, time, rule) {
  const evs = events.filter(function (e) { return e.ts <= time; });
  if (!evs.length) return false;
  if (rule === "all") return true;
  if (rule === "positive") {
    let s = false;
    evs.forEach(function (e) {
      if (e.sentiment === "positive") s = true;
      else if (e.sentiment === "negative") s = false;
    });
    return s;
  }
  // "attended": held from first attention unless explicitly negative; positive re-buys, neutral maintains
  let s = evs[0].sentiment !== "negative";
  for (let i = 1; i < evs.length; i++) {
    if (evs[i].sentiment === "positive") s = true;
    else if (evs[i].sentiment === "negative") s = false;
  }
  return s;
}

function attentionAt(events, time, winMs) {
  let n = 0;
  events.forEach(function (e) { if (e.ts <= time && (!winMs || e.ts > time - winMs)) n += (e.views || 1); });
  return n;
}

function closeAtOrBefore(arr, time) {
  if (!arr.length || arr[0].t > time) return null;
  let lo = 0, hi = arr.length - 1, res = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= time) { res = arr[mid].close; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res;
}

// ---------- index allocation statistics ----------

function fmtStat(x, f) { return (x == null || !isFinite(x)) ? "-" : f(x); }

// Holdings scattered by current weight (x) against contribution to the window
// return in percentage points (y). Reads the allocation table at a glance: names
// far right carry the portfolio, names low-right are the ones costing it.
// pts: [{ label, w, c }]. Registers a canvasHover entry so attachCanvasHover
// gives the same floating tooltip the other analytics charts use.
// Dots are colored by sector (industry in the tooltip). The dashed line is the
// proportional contribution, weight x the basket's total contribution: a name on
// it pulled exactly its weight, so the distance from the line is what makes an
// outlier. Names are drawn only where there is room (a label never overlaps
// another label or dot), furthest-from-the-line first; crowded dots stay
// unlabeled and show their name on hover. big = the full-screen view.
function drawWeightContribCanvas(cv, tipId, pts, big) {
  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H;
  const padL = 46, padR = 16, padT = 12, padB = 32, pw = W - padL - padR, ph = H - padT - padB;
  let wMax = 0, cLo = 0, cHi = 0, tot = 0;
  pts.forEach(function (p) {
    if (p.w > wMax) wMax = p.w;
    if (p.c < cLo) cLo = p.c;
    if (p.c > cHi) cHi = p.c;
    tot += p.c;
  });
  const xt = niceTicks(0, wMax || 0.01, 5);
  // Keep the proportional line inside the plot across the whole x range.
  cLo = Math.min(cLo, xt.max * tot); cHi = Math.max(cHi, xt.max * tot);
  if (cHi === cLo) { cHi = cLo + 0.01; } // all-flat contributions still need a range
  const yt = niceTicks(cLo, cHi, 5);
  const xSpan = (xt.max - xt.min) || 1, ySpan = (yt.max - yt.min) || 1;
  const X = function (v) { return padL + (v - xt.min) / xSpan * pw; };
  const Y = function (v) { return padT + (1 - (v - yt.min) / ySpan) * ph; };

  c.font = "10px sans-serif";
  yt.ticks.forEach(function (v) {
    const y = Y(v);
    c.strokeStyle = TC().grid; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
    c.textAlign = "end"; c.fillStyle = TC().muted; c.fillText((v * 100).toFixed(1), padL - 5, y + 3);
  });
  c.textAlign = "center"; c.fillStyle = TC().muted;
  xt.ticks.forEach(function (v) {
    if (v < xt.min - 1e-9 || v > xt.max + 1e-9) return;
    c.fillText(Math.round(v * 100) + "%", X(v), H - padB + 14);
  });
  if (yt.min < 0 && yt.max > 0) {
    c.strokeStyle = "#6b7590"; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, Y(0)); c.lineTo(W - padR, Y(0)); c.stroke();
  }
  c.fillStyle = TC().muted; c.textAlign = "center";
  c.fillText("Weight", padL + pw / 2, H - 4);
  c.save(); c.translate(11, padT + ph / 2); c.rotate(-Math.PI / 2);
  c.fillText("Contribution (pp)", 0, 0); c.restore();

  // Proportional contribution: y = weight x total.
  c.save(); c.strokeStyle = "#c9a24a"; c.lineWidth = 1.2; c.setLineDash([5, 4]);
  c.beginPath(); c.moveTo(X(0), Y(0)); c.lineTo(X(xt.max), Y(xt.max * tot)); c.stroke(); c.restore();
  c.save(); c.fillStyle = "#c9a24a"; c.font = "10px sans-serif"; c.textAlign = "end";
  c.fillText("proportional", X(xt.max) - 4, Y(xt.max * tot) + (tot >= 0 ? 12 : -5)); c.restore();

  const r = big ? 6 : 5;
  const at = pts.map(function (p) { return { p: p, x: X(p.w), y: Y(p.c), ex: p.c - p.w * tot }; });
  at.forEach(function (d) {
    c.fillStyle = sectorColor(d.p.sector);
    c.beginPath(); c.arc(d.x, d.y, r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = TC().bg; c.lineWidth = 2; c.stroke(); // surface ring keeps overlapping dots apart
  });

  // Labels: greedy, most informative first, each placed right of its dot (or
  // left near the right edge) only if its box is clear of every placed label,
  // every other dot and the plot edge.
  c.font = (big ? 11 : 10) + "px sans-serif";
  const lh = big ? 13 : 12, placed = [];
  const hit = function (a, b) { return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; };
  at.slice().sort(function (a, b) { return (Math.abs(b.ex) - Math.abs(a.ex)) || (b.p.w - a.p.w); }).forEach(function (d) {
    const tw = c.measureText(d.p.label).width;
    const right = { x0: d.x + r + 3, x1: d.x + r + 3 + tw, y0: d.y - lh / 2, y1: d.y + lh / 2, align: "start" };
    const left = { x0: d.x - r - 3 - tw, x1: d.x - r - 3, y0: d.y - lh / 2, y1: d.y + lh / 2, align: "end" };
    const box = [right, left].find(function (bx) {
      if (bx.x0 < padL || bx.x1 > W - padR || bx.y0 < padT - 2 || bx.y1 > padT + ph + 2) return false;
      if (placed.some(function (q) { return hit(bx, q); })) return false;
      return !at.some(function (o) {
        return o !== d && hit(bx, { x0: o.x - r, x1: o.x + r, y0: o.y - r, y1: o.y + r });
      });
    });
    if (!box) return;
    placed.push(box);
    c.fillStyle = TC().muted; c.textAlign = box.align;
    c.fillText(d.p.label, box.align === "start" ? box.x0 : box.x1, d.y + 3);
  });

  const ppf = function (v) { return (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + " pp"; };
  const dots = at.map(function (d) {
    const p = d.p;
    return { x: d.x, y: d.y, title: "<b>" + escapeHtml(p.label) + "</b><br>" +
      escapeHtml(p.industry ? p.industry + " (" + (p.sector || "no sector") + ")" : (p.sector || "no sector data")) +
      "<br>weight " + pct(p.w) + "<br>contribution " + ppf(p.c) +
      "<br>proportional to weight " + ppf(p.w * tot) + " &middot; excess " + ppf(d.ex) };
  });
  canvasHover[cv.id] = { kind: "scatter", dots: dots, tipId: tipId, base: cv.width ? c.getImageData(0, 0, cv.width, cv.height) : null, geom: { padT: padT, ph: ph } };
}

// Allocation, performance, and benchmark-relative statistics for the Index
// view, computed over the displayed (period-trimmed) window. `bars` comes from
// computeIndex (untrimmed); bar returns are trim-invariant, so filtering by the
// trimmed curve's start time yields the window's return series.
async function renderIndexStats(bars, curve, method) {
  const el = document.getElementById("idx-stats");
  if (!el) return;
  el.innerHTML = "";
  if (!bars || !curve || curve.length < 2) return;
  const startT = curve[0].t;
  const wb = bars.filter(function (b) { return b.t > startT; });
  if (!wb.length) return;

  const perYr = resolution === "hourly" ? 252 * 6.5 : 252; // trading bars per year
  const rets = wb.map(function (b) { return b.r; });
  const n = rets.length;
  const mean = rets.reduce(function (a, b) { return a + b; }, 0) / n;
  const sd = n > 1 ? Math.sqrt(rets.reduce(function (a, r) { return a + (r - mean) * (r - mean); }, 0) / (n - 1)) : null;
  const dsd = n > 1 ? Math.sqrt(rets.reduce(function (a, r) { return a + Math.min(0, r) * Math.min(0, r); }, 0) / (n - 1)) : null;
  const first = curve[0].v, last = curve[curve.length - 1].v;
  const totRet = last / first - 1;
  const annRet = Math.pow(last / first, perYr / n) - 1;
  const vol = sd != null ? sd * Math.sqrt(perYr) : null;
  const sharpe = sd ? mean / sd * Math.sqrt(perYr) : null;
  const sortino = dsd ? mean / dsd * Math.sqrt(perYr) : null;
  let peak = -Infinity, maxDD = 0;
  curve.forEach(function (p) { if (p.v > peak) peak = p.v; const dd = p.v / peak - 1; if (dd < maxDD) maxDD = dd; });
  const hitRate = rets.filter(function (r) { return r > 0; }).length / n;
  const best = Math.max.apply(null, rets), worst = Math.min.apply(null, rets);

  // Current allocation = target weights after the last bar's rebalance.
  const wNow = wb[wb.length - 1].wNext || {};
  const held = Object.keys(wNow).filter(function (t) { return wNow[t] > 0; })
    .sort(function (a, b) { return wNow[b] - wNow[a]; });
  const hhi = held.reduce(function (a, t) { return a + wNow[t] * wNow[t]; }, 0);
  const effN = hhi > 0 ? 1 / hhi : null;
  const top1 = held.length ? wNow[held[0]] : null;
  const top3 = held.length ? held.slice(0, 3).reduce(function (a, t) { return a + wNow[t]; }, 0) : null;
  let toSum = 0;
  wb.forEach(function (b) {
    const keys = {};
    Object.keys(b.w).forEach(function (t) { keys[t] = 1; });
    Object.keys(b.wNext).forEach(function (t) { keys[t] = 1; });
    let s = 0;
    Object.keys(keys).forEach(function (t) { s += Math.abs((b.wNext[t] || 0) - (b.w[t] || 0)); });
    toSum += s / 2;
  });
  const turnover = toSum / wb.length;

  // Per-holding contribution over the window (arithmetic, ignores compounding).
  const contrib = {};
  wb.forEach(function (b) { for (const t in b.contrib) contrib[t] = (contrib[t] || 0) + b.contrib[t]; });

  // Benchmark-relative stats vs NASDAQ over the same window.
  let beta = null, corr = null, alphaAnn = null, teAnn = null, benchTot = null;
  try {
    const bser = (await benchSeries()).map(function (p) { return { t: p.t, close: p.c }; });
    const aRets = [], bRets = [];
    let prevT = startT;
    wb.forEach(function (b) {
      const c0 = closeAtOrBefore(bser, prevT), c1 = closeAtOrBefore(bser, b.t);
      if (c0 != null && c1 != null && c0 > 0) { bRets.push(c1 / c0 - 1); aRets.push(b.r); }
      prevT = b.t;
    });
    const b0 = closeAtOrBefore(bser, startT), b1 = closeAtOrBefore(bser, wb[wb.length - 1].t);
    if (b0 != null && b1 != null && b0 > 0) benchTot = b1 / b0 - 1;
    if (bRets.length > 1) {
      const mA = aRets.reduce(function (a, x) { return a + x; }, 0) / aRets.length;
      const mB = bRets.reduce(function (a, x) { return a + x; }, 0) / bRets.length;
      let cov = 0, vA = 0, vB = 0, te = 0;
      for (let i = 0; i < bRets.length; i++) {
        cov += (aRets[i] - mA) * (bRets[i] - mB);
        vA += (aRets[i] - mA) * (aRets[i] - mA);
        vB += (bRets[i] - mB) * (bRets[i] - mB);
        const d = (aRets[i] - bRets[i]) - (mA - mB);
        te += d * d;
      }
      cov /= (bRets.length - 1); vA /= (bRets.length - 1); vB /= (bRets.length - 1);
      if (vB > 0) { beta = cov / vB; alphaAnn = (mA - beta * mB) * perYr; }
      if (vA > 0 && vB > 0) corr = cov / Math.sqrt(vA * vB);
      teAnn = Math.sqrt(te / (bRets.length - 1)) * Math.sqrt(perYr);
    }
  } catch (e) { /* benchmark stats are optional */ }

  // The benchmark await can outlive a view switch; never un-hide the panel
  // under the Single/Compare views.
  if (viewMode !== "index") return;

  const f2 = function (x) { return x.toFixed(2); };
  const f1 = function (x) { return x.toFixed(1); };
  const head = function (txt) { const h = document.createElement("h4"); h.textContent = txt; el.appendChild(h); };
  const cards = function () { const d = document.createElement("div"); d.className = "usage-cards"; el.appendChild(d); return d; };

  head("Allocation statistics");
  const sub = document.createElement("div");
  sub.className = "muted small";
  sub.textContent = methodLabel(method) + ", " + n + (resolution === "hourly" ? " hourly" : " daily") +
    " bars in the displayed window. Annualized at " + Math.round(perYr) + " bars/yr, risk-free rate 0.";
  el.appendChild(sub);

  let g = cards();
  addStat(g, "Holdings", String(held.length), "Names currently held (weight > 0) under the selected holding rule.");
  addStat(g, "Concentration (HHI)", fmtStat(held.length ? hhi : null, f2), "Sum of squared weights. 1 = everything in one name; 1/N = spread equally over N names.");
  addStat(g, "Effective holdings", fmtStat(effN, f1), "1 / HHI: how many equal-weight names would give the same concentration.");
  addStat(g, "Top holding", fmtStat(top1, pct), "Weight of the largest position.");
  addStat(g, "Top 3 weight", fmtStat(top3, pct), "Combined weight of the three largest positions.");
  addStat(g, "Avg turnover / bar", fmtStat(turnover, pct), "Average share of the portfolio reallocated per bar: 0.5 x sum of |weight changes|.");

  head("Performance");
  g = cards();
  addStat(g, "Total return", pct(totRet), "Index return over the displayed window.");
  addStat(g, "Annualized return", fmtStat(n >= 5 ? annRet : null, pct), "Geometric return scaled to one year (needs at least 5 bars).");
  addStat(g, "Volatility (ann.)", fmtStat(vol, pct), "Standard deviation of bar returns, annualized.");
  addStat(g, "Sharpe (rf=0)", fmtStat(sharpe, f2), "Annualized mean bar return / annualized volatility.");
  addStat(g, "Sortino", fmtStat(sortino, f2), "Like Sharpe, but only downside deviation in the denominator.");
  addStat(g, "Max drawdown", pct(maxDD), "Largest peak-to-trough decline of the index in the window.");
  addStat(g, "Hit rate", pct(hitRate), "Share of bars with a positive return.");
  addStat(g, "Best bar", pct(best), "Best single-bar return in the window.");
  addStat(g, "Worst bar", pct(worst), "Worst single-bar return in the window.");

  head("Vs NASDAQ");
  g = cards();
  addStat(g, "NASDAQ return", fmtStat(benchTot, pct), "NASDAQ buy-and-hold over the same window.");
  addStat(g, "Active return", fmtStat(benchTot == null ? null : totRet - benchTot, pct), "Index return minus NASDAQ return.");
  addStat(g, "Beta", fmtStat(beta, f2), "Sensitivity of index bar returns to NASDAQ bar returns.");
  addStat(g, "Correlation", fmtStat(corr, f2), "Pearson r of index vs NASDAQ bar returns.");
  addStat(g, "Alpha (ann.)", fmtStat(alphaAnn, pct), "Annualized mean return not explained by beta x NASDAQ.");
  addStat(g, "Tracking error (ann.)", fmtStat(teAnn, pct), "Annualized std deviation of (index - NASDAQ) bar returns.");

  const inCash = Object.keys(contrib).filter(function (t) { return !(wNow[t] > 0); }).sort();
  let scatterPts = null;
  if (held.length || inCash.length) {
    const ppf = function (c) { return (c >= 0 ? "+" : "") + (c * 100).toFixed(1) + " pp"; };
    let rows = "";
    held.forEach(function (t) {
      rows += "<tr><td>" + escapeHtml(nameOf(t)) + "</td><td>" + pct(wNow[t]) + "</td><td>" +
        (contrib[t] == null ? "-" : ppf(contrib[t])) + "</td></tr>";
    });
    inCash.forEach(function (t) {
      rows += "<tr><td>" + escapeHtml(nameOf(t)) + " <span class='n'>(cash now)</span></td><td>0.0%</td><td>" + ppf(contrib[t]) + "</td></tr>";
    });

    const pt = function (t, w) { const p = tickerProfile(t); return { label: nameOf(t), w: w, c: contrib[t] || 0, sector: p.sector, industry: p.industry }; };
    scatterPts = held.map(function (t) { return pt(t, wNow[t]); })
      .concat(inCash.map(function (t) { return pt(t, 0); }));
    head("Weight vs contribution");
    const csub = document.createElement("div");
    csub.className = "muted small";
    csub.textContent = "Each holding at its current weight against what it added to the window return. " +
      "Names at weight 0 are in cash now but contributed earlier in the window. Dashed line = contribution proportional to weight (weight x the basket total): dots far above or below it are the outliers. Crowded dots are left unlabeled; hover for the name.";
    el.appendChild(csub);

    // Chart and table side by side: the table carries the same numbers the dots
    // do, so stacking them wasted a screen of height for no extra information.
    // It stays a <details> so a wide basket can still be folded away, and its own
    // scroll box keeps the row no taller than the chart.
    const row = document.createElement("div");
    row.className = "idx-alloc-row";
    row.innerHTML =
      "<div class='idx-alloc-chart'><button type='button' class='navbtn wc-expand' id='idx-wc-expand' title='Open the chart full screen: more room, so more names fit'>&#10530; Expand</button>" +
      "<canvas id='idx-wc-canvas' class='an-canvas'></canvas>" +
      sectorLegendHtml(held.concat(inCash).map(function (t) { return tickerProfile(t).sector; }).filter(Boolean)) + "</div>" +
      "<details class='idx-holdings' open><summary>Holdings table (" + (held.length + inCash.length) + ")</summary>" +
      "<div class='idx-holdings-scroll'><table class='an-table'><thead><tr><th title='Name held by the index in the displayed window.'>Holding</th>" +
      "<th title='Current portfolio weight.'>Weight</th>" +
      "<th title='Approximate contribution to the window return, in percentage points: sum of weight x bar return (ignores compounding).'>Contribution</th></tr></thead><tbody>" +
      rows + "</tbody></table></div></details>";
    el.appendChild(row);
  }
  el.classList.remove("hidden");
  // Canvas sizing reads clientWidth, so draw only once the panel is visible.
  if (scatterPts && scatterPts.length) {
    const cv = document.getElementById("idx-wc-canvas");
    drawWeightContribCanvas(cv, "idx-wc-tip", scatterPts);
    attachCanvasHover(cv);
    const pts = scatterPts;
    document.getElementById("idx-wc-expand").addEventListener("click", function () { openWeightContribFull(pts); });
  }
}

// Full-screen weight vs contribution: same points, more room so more dots get
// a name. Esc, the close button or a backdrop click closes it.
function openWeightContribFull(pts) {
  const ov = document.createElement("div");
  ov.className = "wc-full";
  ov.innerHTML = "<div class='wc-full-box'><div class='wc-full-head'><strong>Weight vs contribution</strong>" +
    "<button type='button' class='mm-x' title='Close (Esc)'>&times;</button></div>" +
    "<canvas id='idx-wc-full' class='an-canvas'></canvas>" +
    sectorLegendHtml(pts.map(function (p) { return p.sector; }).filter(Boolean)) + "</div>";
  document.body.appendChild(ov);
  function close() { document.removeEventListener("keydown", onKey); delete canvasHover["idx-wc-full"]; ov.remove(); }
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
  ov.querySelector(".mm-x").addEventListener("click", close);
  const cv = document.getElementById("idx-wc-full");
  drawWeightContribCanvas(cv, "idx-wc-tip", pts, true);
  attachCanvasHover(cv);
}

// ---------- shared helpers ----------

// Feature-usage keys are raw internals: tab ids ("performance"), chart view
// modes ("index"), data-area slugs ("att-by-stock") and the area:/click:
// prefixes the IntersectionObserver adds. usageLabel maps them to the heading
// the user actually sees; mergeUsageCounts folds the area:/click: variants of a
// section, and any keys sharing a label, into one entry.
const USAGE_LABELS = {
  performance: "My Stocks tab", attention: "My Habits tab", predictions: "Predictions tab",
  world: "World tab", network: "Community tab", settings: "Settings tab", admin: "Admin tab",
  single: "Chart: single", compare: "Chart: compare", index: "Chart: index",
  feedback_open: "Feedback form opened", feedback_sent: "Feedback sent",
  account: "Account", portals: "Portals", watchlist: "Watchlist", chart: "Chart",
  "event-study": "Event study",
  "att-usage": "Usage summary", "att-calendar": "Calendar", "att-over-time": "Over time",
  "att-by-stock": "By stock over time", "att-distributions": "Distributions",
  "att-market": "Market correlation", "att-crowd": "You vs the crowd",
  "pred-pace": "Pace to target", "pred-horizon": "Accuracy by horizon",
  "pred-curve": "Track record over time", "pred-timing": "Timing calibration"
};
function usageLabel(key) {
  const k = String(key == null ? "" : key).replace(/^(area|click):/, "");
  if (USAGE_LABELS[k]) return USAGE_LABELS[k];
  const w = k.replace(/[-_]/g, " ").trim();
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : "Other";
}
// counts: { rawKey: n } -> [{ label, count }] sorted by count desc.
function mergeUsageCounts(counts) {
  const m = {};
  Object.keys(counts || {}).forEach(function (k) {
    const l = usageLabel(k);
    m[l] = (m[l] || 0) + (Number(counts[k]) || 0);
  });
  return Object.keys(m).map(function (l) { return { label: l, count: m[l] }; })
    .sort(function (a, b) { return b.count - a.count; });
}

function dayAgg(events) {
  const m = {};
  events.forEach(function (e) {
    const d = isoDate(e.ts);
    const o = m[d] || (m[d] = { date: d, count: 0, views: 0, dwell: 0, price: 0, pn: 0, last: null, lastTs: 0, rationales: [] });
    o.count++;
    o.views += (e.views || 1);
    o.dwell += (e.dwellMs || 0);
    if (e.priceAtEvent != null) { o.price += e.priceAtEvent; o.pn++; }
    if (e.ts >= o.lastTs) { o.lastTs = e.ts; o.last = e.sentiment; }
    // Every rationale written that day, in time order. Separate events past the
    // dedupe window each carry their own, so a day can hold several.
    if (e.rationale) o.rationales.push({ ts: e.ts, text: e.rationale });
  });
  return Object.keys(m).sort().map(function (d) {
    const o = m[d];
    o.rationales.sort(function (a, b) { return a.ts - b.ts; });
    return { date: d, t: Date.parse(d) + 12 * 3600000, count: o.count, views: o.views,
      dwellMin: o.dwell / 60000, price: o.pn ? o.price / o.pn : null, sentiment: o.last, rationales: o.rationales };
  });
}

// Marker-tooltip lines for a day's rationales. A single one stays unlabelled;
// several are stamped with the time each was written so they can be told apart.
function rationaleLines(rs) {
  if (!rs || !rs.length) return "";
  if (rs.length === 1) return "\nWhy: " + rs[0].text;
  return rs.map(function (r) {
    const d = new Date(r.ts);
    return "\nWhy (" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + "): " + r.text;
  }).join("");
}

function intensityRadius(views) {
  return Math.min(13, 4 + 2.2 * Math.log2(1 + views));
}

function sentColor(s) {
  return s === "positive" ? "#2ecc71" : s === "negative" ? "#e74c3c" : s === "neutral" ? "#8a93a6" : "#7d869e";
}

// One fixed hue per sector (color follows the sector, never its rank), from the
// validated 8-slot categorical palette, dark steps checked against #161a26.
// Slots go to the most-viewed sectors; the rest share the "Other" gray.
// Industries take their parent sector's hue: 100+ industries cannot each get a
// distinguishable color, and the sector grouping is the useful one.
const SECTOR_COLORS = {
  "Technology": "#3987e5", "Communication Services": "#d95926", "Industrials": "#199e70",
  "Financial Services": "#c98500", "Consumer Cyclical": "#d55181", "Healthcare": "#008300",
  "Real Estate": "#9085e9", "Basic Materials": "#e66767"
};
const OTHER_SECTOR_COLOR = "#7d869e";
function sectorColor(sector) { return SECTOR_COLORS[sector] || OTHER_SECTOR_COLOR; }
// { sector, industry } for a ticker, from the first of its events that carries one.
function tickerProfile(t) {
  const e = (GROUPS[t] || []).find(function (x) { return x.sector || x.industry; });
  return { sector: (e && e.sector) || null, industry: (e && e.industry) || null };
}
// Legend chips for the sectors present, in palette order, "Other" last.
function sectorLegendHtml(sectors) {
  const has = {}; sectors.forEach(function (s) { has[SECTOR_COLORS[s] ? s : "Other"] = 1; });
  const keys = Object.keys(SECTOR_COLORS).filter(function (s) { return has[s]; });
  if (has.Other) keys.push("Other");
  return "<div class='sec-legend'>" + keys.map(function (s) {
    return "<span><i style='background:" + (s === "Other" ? OTHER_SECTOR_COLOR : SECTOR_COLORS[s]) + "'></i>" + escapeHtml(s) + "</span>";
  }).join("") + "</div>";
}

// ---------- NASDAQ benchmark + attention heat map ----------

// Only a non-empty series is cached. An empty one (called before GROUPS is
// built, or Yahoo failed/rate-limited during the quote burst in load()) used to
// stick for the whole session: no NASDAQ line and no market correlation until
// a reload. Concurrent callers share one in-flight fetch.
let BENCH_P = null;
// From 10 days before the first view, or from `from` (YYYY-MM-DD) when that is earlier: the trades
// pane asks for its first trade, which can be long before the first view was captured.
async function ensureBenchmark(from) {
  if (BENCH && BENCH.length && (!from || BENCH[0].date <= from)) return BENCH;
  const tickers = Object.keys(GROUPS);
  let start = from || null;
  if (tickers.length) {
    const v = isoDate(Math.min.apply(null, tickers.map(function (t) { return GROUPS[t][0].ts; })) - 10 * 86400000);
    if (!start || v < start) start = v;
  }
  if (!start) return BENCH || [];
  if (BENCH_P) await BENCH_P;
  if (BENCH && BENCH.length && BENCH[0].date <= start) return BENCH;
  BENCH_P = ATPrices.fetchDaily("^IXIC", start, true)
    .catch(function () { return []; })
    .then(function (b) { if (b && b.length && (!BENCH || !BENCH.length || b[0].date <= BENCH[0].date)) BENCH = b; else if (!BENCH) BENCH = []; BENCH_P = null; return BENCH; });
  return BENCH_P;
}

// NASDAQ series at the current resolution as [{ t, c }]. Hourly comes from the
// local archive (backfilled on demand); daily is fetched live.
async function benchSeries() {
  if (resolution === "hourly") {
    let bars = await ATPriceDB.getBars("^IXIC", "1h");
    if (!bars.length) { await ATPriceDB.backfill("^IXIC", "1h"); bars = await ATPriceDB.getBars("^IXIC", "1h"); }
    return bars.map(function (b) { return { t: b.t, c: b.c }; });
  }
  await ensureBenchmark();
  return (BENCH || []).map(function (p) { return { t: Date.parse(p.date), c: p.close }; });
}

// Returns a heat-colored NASDAQ buy-and-hold line rebased to `baseValue` at `startTime`.
async function benchLine(startTime, baseValue) {
  const ser = await benchSeries();
  if (!ser.length) return null;
  // Base = the last bar at/before the start (the entry reference); plot from an
  // explicit anchor at startTime so the benchmark begins at exactly the same x
  // and value (100) as the stock line, at both daily and hourly resolution.
  let baseIdx = 0;
  for (let i = 0; i < ser.length; i++) { if (ser[i].t <= startTime) baseIdx = i; else break; }
  const base = ser[baseIdx].c;
  if (!base) return null;
  const pts = [{ t: startTime, v: baseValue }];
  for (let i = 0; i < ser.length; i++) { if (ser[i].t > startTime) pts.push({ t: ser[i].t, v: ser[i].c / base * baseValue }); }
  attachAttentionHeat(pts);
  return { heat: true, width: 2, color: "#8a93a6", points: pts, label: "NASDAQ" };
}

function attachAttentionHeat(points) {
  // Aggregate attention across ALL tracked stocks, per calendar day, normalized
  // by the busiest day. drawMulti paints it as the chart's background bands -
  // nothing about the index itself.
  const evs = currentEvents();
  const byDay = {};
  evs.forEach(function (e) { const d = isoDate(e.ts); byDay[d] = (byDay[d] || 0) + (e.views || 1); });
  let max = 1;
  Object.keys(byDay).forEach(function (d) { if (byDay[d] > max) max = byDay[d]; });
  points.forEach(function (p) { p.heat = (byDay[isoDate(p.t)] || 0) / max; });
  return points;
}

function heatColor(v) {
  v = Math.max(0, Math.min(1, v));
  const stops = [[59, 111, 181], [241, 196, 15], [231, 76, 60]]; // blue -> yellow -> red
  const c = v < 0.5 ? lerpRGB(stops[0], stops[1], v / 0.5) : lerpRGB(stops[1], stops[2], (v - 0.5) / 0.5);
  return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
}
function lerpRGB(a, b, t) {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}
function benchLegend() {
  return "<span><span style='color:#8a93a6'>&#9632;</span> NASDAQ B&amp;H &middot; background: your attention <span style='display:inline-block;width:64px;height:9px;border-radius:2px;" +
    "background:linear-gradient(90deg,rgba(59,111,181,.25),rgba(241,196,15,.45),rgba(231,76,60,.6));vertical-align:middle'></span> low&rarr;high</span>";
}

// UTC midnight of a timestamp, matching the daily series grid (Yahoo daily bar
// dates are UTC). Used to snap intraday anchors/quotes onto the daily x-grid so
// the ordinal axis has exactly one column per trading day.
function utcDay(ms) { return Date.parse(new Date(ms).toISOString().slice(0, 10)); }
function hourStart(ms) { return Math.floor(ms / 3600000) * 3600000; }
// Snap a timestamp onto the active chart grid (hour for hourly, UTC day for
// daily) so anchors/quotes align to one column per period across all stocks.
function snapGrid(ms) { return resolution === "hourly" ? hourStart(ms) : utcDay(ms); }
// Nearest existing series timestamp to t, so event markers sit on a real plotted
// point instead of inserting an extra ordinal column.
function nearestT(sx, t) {
  if (!sx.length) return t;
  let b = sx[0], bd = Math.abs(sx[0] - t);
  for (let i = 1; i < sx.length; i++) { const d = Math.abs(sx[i] - t); if (d < bd) { bd = d; b = sx[i]; } }
  return b;
}

function interp(series, sx, ts) {
  let best = series[0], bestD = Infinity;
  for (let i = 0; i < series.length; i++) {
    const d = Math.abs(sx[i] - ts);
    if (d < bestD) { bestD = d; best = series[i]; }
  }
  return best.close;
}

// -1 when every bar predates ts (a label newer than the price history). Falling
// back to index 0 there would price the event off the OLDEST bar in the series
// and resolve it against a window months in the past.
function firstSeriesIndexAtOrAfter(series, ts) {
  for (let i = 0; i < series.length; i++) if (Date.parse(series[i].date) >= ts - 86400000) return i;
  return -1;
}

function methodLabel(m) { return m === "attention" ? "Attention-weighted" : "Equal-weight"; }
function holdingNote(r) {
  return r === "all" ? "Holds every attended name."
    : r === "positive" ? "Holds only names whose last label is Positive."
    : "Holds attended names; Negative sells to cash, Positive re-buys.";
}

function sentimentLegend() {
  return "<span><i class='dot positive'></i>Positive</span> <span><i class='dot negative'></i>Negative</span> " +
    "<span><i class='dot neutral'></i>Neutral</span> <span><i class='dot none'></i>No label</span>";
}

function setLegend(html) { document.getElementById("legend").innerHTML = html; }

// ---------- generic canvas chart ----------

function clearCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  markers = [];
}

// N-point star path (alternating outer/inner radius); used to mark attention
// events that carry a written rationale.
function starPath(c, cx, cy, rOut, rIn, points) {
  c.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? rIn : rOut, a = -Math.PI / 2 + i * Math.PI / points;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath();
}

// ---------- chart time brush ----------

let zoom = { a: 0, b: 1 };  // visible slice of the chart's own time axis, as fractions
let lastDraw = null;        // last (lines, opts) passed to drawMulti, for brush redraws

function resetZoom() { zoom = { a: 0, b: 1 }; }

// Paint the brush to match what was just drawn: the track spans exactly the
// plot area (so handles sit above the x-axis positions they select), and the
// labels show the window's real start/end dates.
function syncBrush(full, t0, t1, padL, padR) {
  const wrap = document.getElementById("chart-range");
  if (!wrap) return;
  const track = document.getElementById("cr-track");
  const usable = full.length > 2;
  wrap.classList.toggle("disabled", !usable);
  track.style.marginLeft = padL + "px";
  track.style.marginRight = padR + "px";
  const pct0 = (usable ? zoom.a : 0) * 100, pct1 = (usable ? zoom.b : 1) * 100;
  document.getElementById("cr-sel").style.left = pct0 + "%";
  document.getElementById("cr-sel").style.right = (100 - pct1) + "%";
  document.getElementById("cr-h0").style.left = pct0 + "%";
  document.getElementById("cr-h1").style.left = pct1 + "%";
  document.getElementById("cr-from").textContent = usable ? chartXLabel(t0) : "";
  document.getElementById("cr-to").textContent = usable ? chartXLabel(t1) : "";
  document.getElementById("cr-reset").classList.toggle("hidden", zoom.a === 0 && zoom.b === 1);
}

function redrawBrushed() { if (lastDraw) drawMulti(lastDraw.lines, lastDraw.opts); }

(function initBrush() {
  const track = document.getElementById("cr-track");
  if (!track) return;
  const MIN = 0.02;
  let mode = null, grabDx = 0;
  const fracAt = function (ev) {
    const r = track.getBoundingClientRect();
    return r.width ? Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) : 0;
  };
  track.addEventListener("pointerdown", function (ev) {
    const f = fracAt(ev);
    if (ev.target.id === "cr-h0") mode = "a";
    else if (ev.target.id === "cr-h1") mode = "b";
    // Dragging inside an existing window pans it; on a full window there is
    // nothing to pan, so a drag there sweeps out a new one instead.
    else if (f > zoom.a && f < zoom.b && (zoom.a > 0 || zoom.b < 1)) { mode = "pan"; grabDx = f - zoom.a; }
    else { mode = "b"; zoom.a = f; zoom.b = Math.min(1, f + MIN); }
    track.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  track.addEventListener("pointermove", function (ev) {
    if (!mode) return;
    const f = fracAt(ev);
    if (mode === "a") zoom.a = Math.min(f, zoom.b - MIN);
    else if (mode === "b") zoom.b = Math.max(f, zoom.a + MIN);
    else {
      const w = zoom.b - zoom.a;
      zoom.a = Math.max(0, Math.min(1 - w, f - grabDx));
      zoom.b = zoom.a + w;
    }
    zoom.a = Math.max(0, zoom.a); zoom.b = Math.min(1, zoom.b);
    redrawBrushed();
  });
  const end = function () { mode = null; };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);
  document.getElementById("cr-reset").addEventListener("click", function () {
    resetZoom(); redrawBrushed();
  });
})();

function drawMulti(lines, opts) {
  clearCanvas();
  hoverLines = [];
  opts = opts || {};
  chartTable = !!opts.table;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  const hasLabels = lines.some(function (L) { return L.label; });
  const padL = 56, padR = hasLabels ? 70 : 16, padT = 14, padB = 28;
  const plotW = cssW - padL - padR, plotH = cssH - padT - padB;

  lastDraw = { lines: lines, opts: opts };
  let mks = opts.markers || [];
  // Time brush ("swipe") under the chart: zoom.a/zoom.b are fractions of the
  // full ordinal axis (one slot per plotted timestamp), so the handles line up
  // with what is drawn. Filtering here means every view - single, compare,
  // index - is zoomable through the same control.
  {
    const set = {};
    lines.forEach(function (L) { L.points.forEach(function (p) { set[p.t] = 1; }); });
    mks.forEach(function (m) { set[m.t] = 1; });
    const full = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    const n = full.length - 1;
    if (n >= 2 && (zoom.a > 0 || zoom.b < 1)) {
      const i0 = Math.max(0, Math.min(n - 1, Math.round(zoom.a * n)));
      const i1 = Math.max(i0 + 1, Math.min(n, Math.round(zoom.b * n)));
      const t0 = full[i0], t1 = full[i1];
      lines = lines.map(function (L) {
        return Object.assign({}, L, { points: L.points.filter(function (p) { return p.t >= t0 && p.t <= t1; }) });
      }).filter(function (L) { return L.points.length; });
      mks = mks.filter(function (m) { return m.t >= t0 && m.t <= t1; });
      syncBrush(full, t0, t1, padL, padR);
    } else {
      syncBrush(full, full[0], full[n], padL, padR);
    }
    if (!lines.length) return;
  }

  // Re-anchor the visible window: every indexed line restarts at the baseline at
  // the left edge of what is shown, so the chart always reads as "return over
  // the window on screen" - whether that window came from the Period selector or
  // from dragging the brush. Each line re-anchors at its OWN first visible point,
  // since a name that enters mid-window has no earlier price to measure from.
  // Markers ride their line's scale so they stay on it.
  if (opts.baseline != null) {
    const scale = {};
    let firstK = 1;
    lines = lines.map(function (L, i) {
      const b = L.points[0].v;
      if (!b) return L;
      const k = opts.baseline / b;
      if (i === 0) firstK = k;
      if (L.label) scale[L.label] = k;
      if (k === 1) return L;
      return Object.assign({}, L, {
        points: L.points.map(function (p) { return Object.assign({}, p, { v: p.v * k }); })
      });
    });
    mks = mks.map(function (m) {
      const k = (m.label != null && scale[m.label] != null) ? scale[m.label] : firstK;
      return k === 1 ? m : Object.assign({}, m, { v: m.v * k });
    });
  }

  let xmin = Infinity, xmax = -Infinity, lo = Infinity, hi = -Infinity;
  lines.forEach(function (L) {
    L.points.forEach(function (p) {
      if (p.t < xmin) xmin = p.t; if (p.t > xmax) xmax = p.t;
      if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v;
    });
  });
  mks.forEach(function (m) {
    if (m.t < xmin) xmin = m.t; if (m.t > xmax) xmax = m.t;
    if (m.v < lo) lo = m.v; if (m.v > hi) hi = m.v;
  });
  if (opts.baseline != null) { lo = Math.min(lo, opts.baseline); hi = Math.max(hi, opts.baseline); }
  if (!isFinite(xmin)) return;
  if (xmax === xmin) xmax = xmin + 86400000;

  // Ordinal x-axis: place data points by index so non-trading periods (overnight,
  // weekends, holidays) take no space - the line connects close -> next open
  // directly. xs = sorted unique timestamps across all lines + markers.
  let xs = null;
  function fracIdx(t) {
    if (t <= xs[0]) return 0;
    if (t >= xs[xs.length - 1]) return xs.length - 1;
    let a = 0, b = xs.length - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (xs[m] <= t) a = m; else b = m; }
    const span = xs[b] - xs[a];
    return a + (span ? (t - xs[a]) / span : 0);
  }
  {
    const set = {};
    lines.forEach(function (L) { L.points.forEach(function (p) { set[p.t] = 1; }); });
    mks.forEach(function (m) { set[m.t] = 1; });
    xs = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    if (xs.length < 2) xs = null; // fall back to time axis
  }
  const padv = (hi - lo) * 0.04 || hi * 0.02 || 1;
  lo -= padv; hi += padv;
  if (hi === lo) hi = lo + 1;
  // Ticks are rounded (e.g. 100, not 99) but the plot bounds stay at the padded
  // data range: rounding the bounds out to tick multiples can waste most of the
  // height (a 25-185 range would become 0-200). Ticks outside the range are
  // skipped when drawn. Tick count scales with plot height.
  const nt = niceTicks(lo, hi, Math.max(5, Math.min(10, Math.round(plotH / 40))));

  const mapX = xs
    ? function (t) { return xs.length <= 1 ? padL + plotW / 2 : padL + (fracIdx(t) / (xs.length - 1)) * plotW; }
    : function (t) { return padL + ((t - xmin) / (xmax - xmin)) * plotW; };
  const mapY = function (v) { return padT + (1 - (v - lo) / (hi - lo)) * plotH; };
  const dec = nt.step >= 1 ? 0 : (nt.step >= 0.1 ? 1 : 2);

  // Attention heat as the plot's background: one band per bar, more opaque and
  // redder the more you looked at stocks that day. Days without attention stay
  // clear, so the lines on top keep their own colours and stay readable.
  lines.forEach(function (L) {
    if (!L.heat) return;
    for (let i = 1; i < L.points.length; i++) {
      const p0 = L.points[i - 1], p1 = L.points[i], h = Math.max(p0.heat || 0, p1.heat || 0);
      if (!(h > 0)) continue;
      const x0 = mapX(p0.t), x1 = mapX(p1.t);
      ctx.globalAlpha = 0.08 + 0.32 * h;
      ctx.fillStyle = heatColor(h);
      ctx.fillRect(x0, padT, Math.max(1, x1 - x0), plotH);
    }
    ctx.globalAlpha = 1;
  });

  ctx.font = "11px sans-serif";
  nt.ticks.forEach(function (v) {
    const y = mapY(v);
    if (y < padT - 0.5 || y > padT + plotH + 0.5) return;
    ctx.strokeStyle = TC().grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
    ctx.fillStyle = TC().muted; ctx.fillText(v.toFixed(dec), 6, y + 3);
  });
  ctx.textAlign = "center";
  let prevLabel = null;
  for (let i = 0; i <= 4; i++) {
    let t, lab;
    if (xs) {
      const idx = Math.round((xs.length - 1) * i / 4); t = xs[idx];
      lab = opts.intraday ? (isoDate(t).slice(5) + " " + new Date(t).getHours() + "h") : isoDate(t);
    } else {
      t = xmin + (xmax - xmin) * (i / 4); lab = isoDate(t);
    }
    if (lab === prevLabel) continue; // avoid duplicate labels on short windows
    prevLabel = lab;
    ctx.fillStyle = TC().muted; ctx.fillText(lab, mapX(t), cssH - 8);
  }
  ctx.textAlign = "start";

  // Trading-day separators: faint dashed verticals where the calendar day changes
  // (useful on the intraday/hourly chart where non-trading periods are skipped).
  if (xs && opts.intraday) {
    let prevDay = null;
    for (let i = 0; i < xs.length; i++) {
      const day = isoDate(xs[i]);
      if (prevDay !== null && day !== prevDay) {
        const x = (mapX(xs[i - 1]) + mapX(xs[i])) / 2;
        ctx.strokeStyle = TC().ink(0.07); ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
        ctx.setLineDash([]);
      }
      prevDay = day;
    }
  }

  if (opts.baseline != null) {
    const y = mapY(opts.baseline);
    ctx.strokeStyle = TC().ink(0.25); ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Non-trading periods are skipped (ordinal axis), so just connect each point to
  // the next with a solid line (last close -> next open).
  const usedYs = [];
  lines.forEach(function (L) {
    // Compare hover-isolate: when a line is highlighted, dim all the others.
    const dim = opts.highlight && L.label && L.label !== opts.highlight;
    ctx.globalAlpha = dim ? 0.12 : 1;
    ctx.lineWidth = (opts.highlight && L.label === opts.highlight) ? (L.width || 1.6) + 1 : (L.width || 1.6);
    if (L.label) hoverLines.push({ label: L.label, color: L.color, pts: L.points.map(function (p) { return { x: mapX(p.t), y: mapY(p.v), v: p.v, t: p.t }; }) });
    ctx.setLineDash([]);
    for (let i = 1; i < L.points.length; i++) {
      const p0 = L.points[i - 1], p1 = L.points[i];
      const x0 = mapX(p0.t), y0 = mapY(p0.v), x1 = mapX(p1.t), y1 = mapY(p1.v);
      ctx.strokeStyle = L.color;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (!opts.hideLabels && L.label && L.points.length) {
      const last = L.points[L.points.length - 1];
      let ly = mapY(last.v) + 3;
      while (usedYs.some(function (yy) { return Math.abs(yy - ly) < 11; })) ly += 11;
      usedYs.push(ly);
      ctx.fillStyle = L.color || TC().muted;
      ctx.font = "11px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(L.label, Math.min(mapX(last.t) + 5, cssW - padR + 4), ly);
      ctx.textAlign = "start";
    }
    ctx.globalAlpha = 1;
  });

  mks.forEach(function (m) {
    const x = mapX(m.t), y = mapY(m.v), r = m.r || 5;
    ctx.globalAlpha = (opts.highlight && m.label && m.label !== opts.highlight) ? 0.12 : 1;
    if (m.vline) {
      ctx.strokeStyle = TC().ink(0.06); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    }
    ctx.fillStyle = m.color;
    if (m.star) { starPath(ctx, x, y, r + 1.5, (r + 1.5) * 0.46, 9); ctx.fill(); } // rationale attached
    else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = TC().bg; ctx.lineWidth = 1.5; ctx.stroke();
    markers.push({ x: x, y: y, r: m.star ? r + 2 : r, text: m.text });
  });
  ctx.globalAlpha = 1;

  chartGeom = { padT: padT, plotH: plotH, intraday: !!opts.intraday };
  chartBase = canvas.width ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
}

function pointSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function nearestLine(lns, mx, my) {
  let best = null, bestD = Infinity, bestPt = null;
  lns.forEach(function (L) {
    if (L.pts.length === 1) {
      const d = Math.hypot(mx - L.pts[0].x, my - L.pts[0].y);
      if (d < bestD) { bestD = d; best = L; bestPt = L.pts[0]; }
      return;
    }
    for (let i = 1; i < L.pts.length; i++) {
      const a = L.pts[i - 1], b = L.pts[i];
      const d = pointSegDist(mx, my, a.x, a.y, b.x, b.y);
      if (d < bestD) {
        bestD = d; best = L;
        bestPt = Math.hypot(mx - a.x, my - a.y) < Math.hypot(mx - b.x, my - b.y) ? a : b;
      }
    }
  });
  return { line: best, dist: bestD, pt: bestPt };
}

function restoreChart() { if (chartBase) ctx.putImageData(chartBase, 0, 0); }

function chartXLabel(t) {
  if (t == null) return "";
  return (chartGeom && chartGeom.intraday) ? (isoDate(t).slice(5) + " " + new Date(t).getHours() + "h") : isoDate(t);
}

let compareHighlight = null; // currently isolated stock label on the Compare chart
let comparePinned = null;    // click-pinned stock: isolation survives the cursor moving off
let compareHover = null;     // stock the cursor is actually over, pinned or not

// Compare has no cached base image (every frame is a full redraw), so all of its
// repaints go through here to keep the pinned isolation applied.
function drawCompare(label) {
  compareHighlight = label || null;
  drawMulti(compareLines, compareHighlight
    ? Object.assign({}, compareOpts, { highlight: compareHighlight })
    : compareOpts);
}

canvas.addEventListener("mousemove", function (ev) {
  const mx = ev.offsetX, my = ev.offsetY;
  // Outlook bubbles: show the marker's own annotation.
  for (const m of markers) {
    const rr = (m.r + 3) * (m.r + 3);
    if ((mx - m.x) * (mx - m.x) + (my - m.y) * (my - m.y) <= rr && m.text) {
      if (!chartTable) restoreChart();
      else drawCompare(comparePinned);
      if (chartGeom) drawVGuide(ctx, m.x, chartGeom.padT, chartGeom.plotH);
      canvas.style.cursor = "pointer"; showTip(escapeHtml(m.text).replace(/\n/g, "<br>"), ev.clientX, ev.clientY); return;
    }
  }
  if (!hoverLines.length) { hideTip(); canvas.style.cursor = "default"; return; }
  // Snap to the nearest x across all lines; pick the line nearest the cursor (y).
  let snapX = null, snapD = Infinity, snapT = null, hi = null, hiD = Infinity;
  const rows = hoverLines.map(function (L) {
    if (!L.pts.length) return null;
    let best = L.pts[0], bd = Math.abs(L.pts[0].x - mx);
    for (const p of L.pts) { const d = Math.abs(p.x - mx); if (d < bd) { bd = d; best = p; } }
    if (bd < snapD) { snapD = bd; snapX = best.x; snapT = best.t; }
    if (bd < 60 && L.label !== "NASDAQ") { const yd = Math.abs(best.y - my); if (yd < hiD) { hiD = yd; hi = L.label; } }
    return { label: L.label, color: L.color, v: best.v };
  }).filter(Boolean);
  if (!rows.length || snapD > 60) {
    hideTip(); canvas.style.cursor = "default";
    compareHover = null;
    if (chartTable) drawCompare(comparePinned);
    else restoreChart();
    return;
  }
  if (chartTable) {
    // Compare: isolate the nearest stock (others dimmed). A pinned stock holds
    // the isolation regardless of where the cursor wanders.
    compareHover = hi;
    drawCompare(comparePinned || hi);
  } else {
    restoreChart();
  }
  if (chartGeom) drawVGuide(ctx, snapX, chartGeom.padT, chartGeom.plotH);
  rows.sort(function (a, b) { return b.v - a.v; });
  showTip("<b>" + escapeHtml(chartXLabel(snapT)) + "</b><div class='tip-rows'>" +
    rows.map(function (r) {
      const em = chartTable && r.label === compareHighlight;
      return "<span><span style='color:" + (r.color || TC().muted) + (em ? "" : "; opacity:.6") + "'>&#9632;</span> " +
        (em ? "<b>" : "") + escapeHtml(r.label) + " " + r.v.toFixed(2) + (em ? "</b>" : "") + "</span>";
    }).join("") + "</div>",
    ev.clientX, ev.clientY);
  canvas.style.cursor = "crosshair";
});
canvas.addEventListener("mouseleave", function () {
  hideTip();
  compareHover = null;
  if (chartTable) drawCompare(comparePinned);
  else restoreChart();
});

// Compare: click the stock under the cursor to pin its isolation so it stays
// while you read the chart; click it again (or an empty area) to release it.
canvas.addEventListener("click", function () {
  if (!chartTable || !compareLines) return;
  comparePinned = (compareHover && compareHover !== comparePinned) ? compareHover : null;
  drawCompare(comparePinned || compareHover);
  setCompareLegend();
});

// ---------- controls ----------

document.querySelectorAll("#view-seg button").forEach(function (b) {
  b.addEventListener("click", function () { setView(b.getAttribute("data-v")); });
});
document.getElementById("method").addEventListener("change", function () { saveView(); if (viewMode === "index") render(); });
document.getElementById("rule").addEventListener("change", function () { saveView(); if (viewMode === "index") render(); });
document.getElementById("win").addEventListener("change", function () { saveView(); if (viewMode === "index") render(); });
document.getElementById("lag").addEventListener("change", function () { saveView(); if (viewMode === "index") render(); });
document.getElementById("resolution").addEventListener("change", function () {
  resolution = document.getElementById("resolution").value;
  SERIES = {}; // re-fetch series at the new resolution
  saveView();
  render();
  renderAnalytics();
});
document.getElementById("period").addEventListener("change", function () {
  period = parseInt(document.getElementById("period").value, 10) || 0;
  saveView();
  render();
});
function renderAttTime() {
  renderAttentionOverTime(); renderAttentionByStock(); renderTimeOverTime(); renderTimeByStock();
  renderMarketCorr("market-corr", viewsOf, "Attention"); renderMarketCorr("market-corr-time", minOf, "Time");
}
document.getElementById("at-gran").addEventListener("change", function () {
  atGran = document.getElementById("at-gran").value; atOffset = 0; saveView(); renderAttTime();
});
document.getElementById("at-prev").addEventListener("click", function () { atOffset++; renderAttTime(); });
document.getElementById("at-next").addEventListener("click", function () { if (atOffset > 0) { atOffset--; renderAttTime(); } });
document.getElementById("om-gran").addEventListener("change", function () {
  omGran = document.getElementById("om-gran").value; saveView(); renderSentimentMix();
});
attachCanvasHover(document.getElementById("att-time-canvas"));
attachCanvasHover(document.getElementById("att-by-stock-canvas"));
attachCanvasHover(document.getElementById("time-over-time-canvas"));
attachCanvasHover(document.getElementById("time-by-stock-canvas"));

document.getElementById("sym-save").addEventListener("click", async function () {
  const sym = document.getElementById("sym-input").value.trim().toUpperCase();
  await ATStore.setOverride(selected, sym);
  DATA = await ATStore.getAll();
  delete SERIES[selected]; delete DAILY[selected];
  QUOTES[selected] = await ATPrices.fetchQuote(sym, true).catch(function () { return null; });
  renderTable();
  render();
});

function downloadBackup(name) {
  const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name || ("attention-tracker-backup-" + isoDate(Date.now()) + ".json");
  a.click();
}

document.getElementById("export").addEventListener("click", function () { downloadBackup("attention-tracker.json"); });

document.getElementById("clear").addEventListener("click", async function () {
  const status = document.getElementById("settings-status");
  const counts = (DATA.events || []).length + " events, " + (DATA.intraday || []).length + " intraday views";
  // Guardrail 1: know whether a cloud copy exists - local clear alone re-syncs back.
  let signedIn = false;
  try { signedIn = !!(self.ATCloud && ATCloud.enabled() && (await ATCloud.getUser())); } catch (e) { /* treat as signed out */ }
  // Guardrail 2: typed confirmation (not a single click) after a clear warning.
  const warn = "Permanently delete ALL local attention data (" + counts + ")?\n\n" +
    (signedIn
      ? "NOTE: you are signed in. This clears this device only - your cloud copy is NOT deleted and will sync back on the next sync. To remove it everywhere, sign out first or delete your account.\n\n"
      : "") +
    "A JSON backup will be downloaded automatically before deleting. Imported broker trades on this device are deleted too (they are not in the backup; import the files again to restore them).\n\n" +
    "Type DELETE to confirm.";
  const typed = window.prompt(warn);
  if (typed == null) { status.textContent = "Clear cancelled."; return; }
  if (typed.trim().toUpperCase() !== "DELETE") { status.textContent = "Clear cancelled - you did not type DELETE."; return; }
  // Guardrail 3: always take a backup before wiping.
  try { downloadBackup(); } catch (e) { /* backup best-effort; proceed */ }
  await ATStore.setAll({ events: [], intraday: [], overrides: {}, customPortals: DATA.customPortals || [], settings: DATA.settings });
  try { if (self.ATLedgerDB) { await ATLedgerDB.clearOwner(await tradesOwner()); TR.report = null; TR.reportKey = null; } } catch (e) { /* ledger best-effort */ }
  selected = null; QUOTES = {}; SERIES = {}; DAILY = {};
  await load();
  status.textContent = "All local data cleared. A backup was downloaded" + (signedIn ? "; cloud copy untouched." : ".");
});

// Browsing-history backfill (Google Takeout JSON, or a history CSV such as a
// Comet export). Visits already recorded are skipped by time (ATHistory.
// newVisits) instead of by a cutoff date, so research done in another browser
// after the extension was installed still counts. Synced first so the check
// sees this account's other devices too.
document.getElementById("history-import").addEventListener("click", function () { document.getElementById("history-file").click(); });
document.getElementById("history-file").addEventListener("change", async function (ev) {
  const file = ev.target.files[0];
  const status = document.getElementById("history-status");
  ev.target.value = "";
  if (!file) return;
  status.textContent = "Reading " + file.name + "...";
  try {
    const found = ATHistory.extract(await file.text(), DATA.customPortals || []);
    let signedIn = false;
    try { signedIn = !!(self.ATCloud && ATCloud.enabled() && (await ATCloud.getUser())); } catch (e) { /* signed out */ }
    if (signedIn) { status.textContent = "Syncing first..."; await ATSync.syncNow(); }
    const data = await ATStore.getAll();
    const nT = Object.keys(found.tickers).length;
    if (!found.visits.length) { status.textContent = "Read " + found.entries + " visited pages; none were on a supported finance site."; return; }
    // Every visit not already recorded is added, from whichever file or browser
    // it comes: the same visit listed in two exports (Chrome and Comet), or one
    // the extension captured live, matches an existing view of that stock within
    // a minute and is skipped.
    const nv = ATHistory.newVisits(data.intraday || [], found.visits);
    const add = nv.fresh;
    if (!add.length) { status.textContent = "Found " + found.visits.length + " finance-page visits for " + nT + " stocks; all " + nv.duplicates + " are already recorded, so nothing to add."; return; }
    const addT = {}; add.forEach(function (v) { addT[v.ticker] = 1; });
    const ok = confirm("Found " + found.visits.length + " visits to finance pages for " + nT + " stocks among " + found.entries + " " + (found.format === "csv" ? "rows" : "visited pages") + ".\n\n" +
      (nv.duplicates ? nv.duplicates + " are already recorded (same stock within a minute) and are skipped.\n" : "") +
      add.length + " new visits for " + Object.keys(addT).length + " stocks from " + isoDate(add[0].ts) + " to " + isoDate(add[add.length - 1].ts) + " will be added as attention.\n\n" +
      (found.unplaced ? "Note: this file lists each page once, with its last visit time and a visit count. " + found.unplaced + " further visits to these pages have no recorded time and cannot be added, so views are understated.\n\n" : "") +
      "They sync to your account like live views. Every other site in the file is discarded; the file is not stored. Continue?");
    if (!ok) { status.textContent = "History import cancelled."; return; }
    // Price at the time of the view: that day's close (live capture takes a quote).
    status.textContent = "Looking up prices...";
    const byT = {}; add.forEach(function (v) { (byT[v.ticker] = byT[v.ticker] || []).push(v); });
    const ts = Object.keys(byT);
    for (let i = 0; i < ts.length; i += 6) {
      await Promise.all(ts.slice(i, i + 6).map(async function (t) {
        try {
          const bars = await ATPrices.fetchDaily(DATA.overrides[t] || ATPrices.toSymbol(t), isoDate(byT[t][0].ts - 10 * 86400000), true);
          byT[t].forEach(function (v) { const c = closeOnOrBefore(bars, Date.parse(new Date(v.ts).toISOString().slice(0, 10))); v.priceAtEvent = c; v.priceFetchFailed = c == null; });
        } catch (e) { /* left without a price, like a failed live quote */ }
      }));
      status.textContent = "Looking up prices... " + Math.min(ts.length, i + 6) + " / " + ts.length;
    }
    const r = await ATStore.importVisits(add);
    try { ATStore.trackFeatureUse("history_import"); } catch (e) { /* usage tracking */ }
    let note = "";
    if (signedIn) { const post = await ATSync.syncNow(); note = post && post.ok ? " Uploaded to your account." : " Saved here; upload will retry on the next sync."; }
    status.textContent = "Added " + r.intraday + " views (" + r.daily + " daily events" + (r.merged ? ", " + r.merged + " joined existing events" : "") + ") for " + Object.keys(addT).length + " stocks" +
      (nv.duplicates ? "; skipped " + nv.duplicates + " already recorded" : "") + "." + note;
    await load();
  } catch (e) { status.textContent = "History import failed: " + (e && e.message || e); }
});

document.getElementById("import").addEventListener("click", function () { document.getElementById("import-file").click(); });
document.getElementById("import-file").addEventListener("change", async function (ev) {
  const file = ev.target.files[0];
  const status = document.getElementById("settings-status");
  if (!file) return;
  status.textContent = "Importing...";
  try {
    const imported = JSON.parse(await file.text());
    const remote = {
      events: imported.events || [],
      intraday: imported.intraday || [],
      deletions: imported.deletions || { events: {}, intraday: {} },
      meta: { overrides: imported.overrides || {}, customPortals: imported.customPortals || [], settings: imported.settings || {}, updatedAt: imported.metaUpdatedAt || Date.now() }
    };
    // An imported row keeps the updatedAt stamped when it was first recorded, so
    // it is OLDER than this device's sync cursor - and collectChanges only pushes
    // rows past the cursor. Merging alone therefore left the import in
    // chrome.storage.local forever: it rendered, so it looked saved, but it never
    // reached the cloud and was lost on the next sign-out or account switch.
    // Fix: sync first (so local already holds the newest cloud copy of anything
    // the catch-up push is about to overwrite), merge, then rewind the cursor so
    // the next push carries every row regardless of age.
    let signedIn = false;
    try { signedIn = !!(self.ATCloud && ATCloud.enabled() && (await ATCloud.getUser())); } catch (e) { /* treat as signed out */ }
    const pre = signedIn ? await ATSync.syncNow() : null;

    const data = await ATStore.getAll();
    ATStore.applyRemote(data, remote);
    await ATStore.setAll(data);
    await ATStore.setSyncConfig({ cloudCursor: 0 });
    ev.target.value = "";

    let note;
    if (!signedIn) {
      note = " Not signed in, so it is on this device only - it uploads on your first sync.";
    } else {
      const post = await ATSync.syncNow();
      note = (post && post.ok)
        ? " Uploaded to your account."
        : " Saved on this device, but the upload failed (" + ((post && post.reason) || "unknown") + "). It retries on the next sync.";
      if (!(pre && pre.ok)) note += " The pre-import sync also failed, so any edit made on another device since this one last synced may have been overwritten.";
    }
    await load();
    status.textContent = "Imported and merged " + (remote.events.length) + " events." + note;
  } catch (e) { status.textContent = "Import failed: " + e.message; }
});

// ---------- portals ----------

function renderPortals() {
  document.getElementById("builtin-portals").textContent =
    ATPortals.BUILTINS.map(function (b) { return b.source; }).join(", ");
  const ul = document.getElementById("custom-portals");
  ul.innerHTML = "";
  const custom = DATA.customPortals || [];
  custom.forEach(function (p, i) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.innerHTML = "<b>" + escapeHtml(p.name) + "</b> &nbsp;<span class='pat'>" + escapeHtml(p.pattern) + "</span>";
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.addEventListener("click", function () { removePortal(i, p.host); });
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

async function addPortal() {
  const name = document.getElementById("portal-name").value.trim();
  const pattern = document.getElementById("portal-pattern").value.trim();
  const msg = document.getElementById("portal-msg");
  if (!name || !pattern) { msg.textContent = "Enter a name and a pattern."; return; }
  const parsed = ATPortals.parsePattern(pattern);
  if (!parsed) {
    msg.textContent = "Invalid pattern. Use {ticker} in the path or a query value, e.g. example.com/quote/{ticker}";
    return;
  }
  const origin = "https://" + parsed.host + "/*";
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [origin] }); } catch (e) { granted = false; }
  if (!granted) { msg.textContent = "Permission for " + parsed.host + " was not granted."; return; }

  await ATStore.addPortal({ name: name, pattern: pattern, host: parsed.host });
  await chrome.runtime.sendMessage({ type: "syncPortals" });
  DATA = await ATStore.getAll();
  renderPortals();
  document.getElementById("portal-name").value = "";
  document.getElementById("portal-pattern").value = "";
  msg.textContent = "Added " + name + ". Reload any open " + parsed.host + " tab to start capturing.";
}

async function removePortal(index, host) {
  await ATStore.removePortal(index);
  DATA = await ATStore.getAll();
  const stillUsed = (DATA.customPortals || []).some(function (p) { return p.host === host; });
  if (!stillUsed) {
    try { await chrome.permissions.remove({ origins: ["https://" + host + "/*"] }); } catch (e) { /* ignore */ }
  }
  await chrome.runtime.sendMessage({ type: "syncPortals" });
  renderPortals();
}

document.getElementById("portal-add").addEventListener("click", addPortal);

// ---------- sync ----------

async function renderSync() {
  const cfg = await ATStore.getSyncConfig();
  document.getElementById("sync-url").value = cfg.url || (self.AT_PRICE_PROXY ? location.origin : "");
  document.getElementById("sync-token").value = cfg.token || "";
  const s = document.getElementById("sync-status");
  if (cfg.lastError) s.textContent = "Last error: " + cfg.lastError;
  else if (cfg.lastSync) s.textContent = "Last synced " + new Date(cfg.lastSync).toLocaleString();
  else s.textContent = cfg.url ? "Configured." : "Not connected.";
}

async function saveSync() {
  const url = document.getElementById("sync-url").value.trim();
  const token = document.getElementById("sync-token").value.trim();
  const s = document.getElementById("sync-status");
  if (!url || !token) { s.textContent = "Enter server URL and token."; return; }
  let origin;
  try { origin = new URL(url).origin; } catch (e) { s.textContent = "Invalid URL."; return; }
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [origin + "/*"] }); } catch (e) { granted = false; }
  if (!granted) { s.textContent = "Permission for " + origin + " was not granted."; return; }
  document.getElementById("sync-url").value = origin; // store only the origin (no /admin or other path)
  await ATStore.setSyncConfig({ url: origin, token: token });
  s.textContent = "Connecting...";
  const r = await ATSync.syncNow();
  if (r.ok) { await load(); s.textContent = "Connected and synced."; }
  else { s.textContent = "Sync failed: " + (r.reason || ""); }
}

async function syncNowUI() {
  const s = document.getElementById("sync-status");
  s.textContent = "Syncing...";
  const r = await ATSync.syncNow();
  if (r.ok) { await load(); s.textContent = "Synced" + (r.changed ? " (data updated)" : ""); }
  else { s.textContent = "Sync failed: " + (r.reason || ""); }
}

async function renderAccount() {
  const s = document.getElementById("account-status");
  const inBtn = document.getElementById("google-signin");
  const outBtn = document.getElementById("google-signout");
  if (!self.ATCloud || !ATCloud.enabled()) {
    s.textContent = "Cloud not configured (using local/token sync). Add Supabase keys in src/config.js to enable Google accounts.";
    inBtn.disabled = true; outBtn.style.display = "none";
    return;
  }
  inBtn.disabled = false;
  const user = await ATCloud.getUser().catch(function () { return null; });
  if (user) {
    s.textContent = "Signed in as " + (user.email || user.id);
    inBtn.style.display = "none"; outBtn.style.display = "";
  } else {
    s.textContent = "Not signed in.";
    inBtn.style.display = ""; outBtn.style.display = "none";
  }
}

async function googleSignIn() {
  const s = document.getElementById("account-status");
  s.textContent = "Opening Google sign-in...";
  try {
    await ATCloud.signIn();
    await renderAccount();
    await maybeShowAdminTab();
    s.textContent = "Signed in. Syncing...";
    autoSynced = false;
    await ATSync.syncNow();
    await load();
    s.textContent = "Signed in and synced.";
  } catch (e) { s.textContent = "Sign-in failed: " + (e && e.message || e); }
}

async function googleSignOut() {
  await ATCloud.signOut();
  // Reload so nothing of this account stays in memory (the assistant's chat, names
  // opt-in, per-account stats); the page comes back at the sign-in gate.
  location.reload();
}

async function reuploadAll() {
  const s = document.getElementById("sync-status");
  const cfg = await ATStore.getSyncConfig();
  if (!cfg.url || !cfg.token) { s.textContent = "Connect Sync first (server URL + token)."; return; }
  s.textContent = "Re-uploading all local data...";
  await ATStore.setSyncConfig({ cursor: 0 }); // force collectChanges to include everything
  const r = await ATSync.syncNow();
  if (r.ok) { await load(); s.textContent = "Re-uploaded. The server now has all your local data."; }
  else { s.textContent = "Re-upload failed: " + (r.reason || ""); }
}

document.getElementById("google-signin").addEventListener("click", googleSignIn);
document.getElementById("google-signout").addEventListener("click", googleSignOut);

// ---------- feedback ----------
// Flow: user selects an area on the LIVE page first (big + accurate, no modal in
// shot), we capture the full page and crop to that area, then open the window.

let fbShot = null; // selected screenshot as a data URL

function loadHtml2Canvas() {
  return new Promise(function (res, rej) {
    if (window.html2canvas) return res(window.html2canvas);
    const s = document.createElement("script");
    s.src = "../vendor/html2canvas.min.js";
    s.onload = function () { res(window.html2canvas); };
    s.onerror = function () { rej(new Error("screenshot library failed to load")); };
    document.head.appendChild(s);
  });
}

function startSelection() {
  document.getElementById("fb-modal").classList.add("fb-hidden");
  document.getElementById("fb-open").style.visibility = "hidden";
  const overlay = document.createElement("div");
  overlay.id = "fb-select-overlay";
  overlay.innerHTML = "<div class='fb-sel-hint'>Drag to select the area your feedback is about &middot; click once for the whole screen &middot; Esc to cancel</div><div id='fb-sel-rect'></div>";
  document.body.appendChild(overlay);
  const rectEl = overlay.querySelector("#fb-sel-rect");
  let start = null, drawing = false, rect = null;

  function cleanup() { document.removeEventListener("keydown", onKey); overlay.remove(); }
  function onKey(e) { if (e.key === "Escape") { cleanup(); document.getElementById("fb-open").style.visibility = "visible"; } }
  document.addEventListener("keydown", onKey);

  overlay.addEventListener("pointerdown", function (e) {
    drawing = true; start = { x: e.clientX, y: e.clientY }; rect = null;
    rectEl.style.display = "block"; rectEl.style.left = start.x + "px"; rectEl.style.top = start.y + "px";
    rectEl.style.width = "0px"; rectEl.style.height = "0px";
  });
  overlay.addEventListener("pointermove", function (e) {
    if (!drawing) return;
    const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
    const w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
    rect = { x: x, y: y, w: w, h: h };
    rectEl.style.left = x + "px"; rectEl.style.top = y + "px"; rectEl.style.width = w + "px"; rectEl.style.height = h + "px";
  });
  overlay.addEventListener("pointerup", function () { drawing = false; cleanup(); captureSelection(rect); });
}

async function captureSelection(rect) {
  const toast = document.createElement("div");
  toast.id = "fb-toast"; toast.textContent = "Capturing...";
  document.body.appendChild(toast);
  try {
    const h2c = await loadHtml2Canvas();
    const docEl = document.documentElement;
    const fullW = docEl.clientWidth, fullH = Math.max(docEl.scrollHeight, docEl.clientHeight);
    // Region to grab, in document coordinates (so scroll position is respected).
    let dx, dy, dw, dh;
    if (rect && rect.w > 8 && rect.h > 8) { dx = window.scrollX + rect.x; dy = window.scrollY + rect.y; dw = rect.w; dh = rect.h; }
    else { dx = window.scrollX; dy = window.scrollY; dw = window.innerWidth; dh = window.innerHeight; }
    // Force a full-document render (windowHeight = scrollHeight) and crop to the
    // region via x/y/width/height, so below-the-fold content is captured.
    // [data-private] regions (imported trades) are left out of the picture:
    // feedback screenshots are stored server-side and can reach a GitHub issue.
    const canvas = await h2c(document.body, {
      backgroundColor: TC().bg, logging: false, useCORS: true, scale: 1,
      x: dx, y: dy, width: dw, height: dh,
      scrollX: 0, scrollY: 0, windowWidth: fullW, windowHeight: fullH,
      ignoreElements: function (el) { return !!(el.hasAttribute && el.hasAttribute("data-private")); }
    });
    fbShot = canvas.toDataURL("image/jpeg", 0.8);
    document.getElementById("fb-preview").src = fbShot;
    document.getElementById("fb-status").textContent = "";
  } catch (e) {
    fbShot = null;
    document.getElementById("fb-preview").removeAttribute("src");
    document.getElementById("fb-status").textContent = "Screenshot unavailable; you can still send a note.";
  } finally {
    toast.remove();
    document.getElementById("fb-open").style.visibility = "visible";
    document.getElementById("fb-modal").classList.remove("fb-hidden");
  }
}

async function sendFeedback() {
  const status = document.getElementById("fb-status");
  const text = document.getElementById("fb-text").value.trim();
  if (!text) { status.textContent = "Write something first."; return; }
  const include = document.getElementById("fb-include").checked;
  const shot = include && fbShot ? fbShot : "";
  status.textContent = "Sending...";
  try {
    if (self.ATCloud && ATCloud.enabled()) {
      const u = await ATCloud.getUser();
      if (!u) { status.textContent = "Sign in (Settings -> Account) to send feedback."; return; }
      await ATCloud.submitFeedback(text, shot, location.href);
    } else {
      const cfg = await ATStore.getSyncConfig();
      if (!cfg.url || !cfg.token) { status.textContent = "Connect Sync first (server URL + token)."; return; }
      const res = await fetch(cfg.url.replace(/\/+$/, "") + "/feedback", {
        method: "POST",
        headers: { "Authorization": "Bearer " + cfg.token, "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
        body: JSON.stringify({ text: text, screenshot: shot, url: location.href })
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
    }
    try { ATStore.trackFeatureUse("feedback_sent"); } catch (e) { /* usage tracking */ }
    status.textContent = "Thanks! Feedback sent.";
    setTimeout(function () { document.getElementById("fb-modal").classList.add("fb-hidden"); }, 900);
  } catch (e) { status.textContent = "Failed to send: " + (e && e.message || e); }
}

function openFeedback() {
  try { ATStore.trackFeatureUse("feedback_open"); } catch (e) { /* usage tracking: denominator for the feedback completion ratio */ }
  fbShot = null;
  document.getElementById("fb-preview").removeAttribute("src");
  document.getElementById("fb-text").value = "";
  document.getElementById("fb-status").textContent = "";
  startSelection();
}

document.getElementById("fb-open").addEventListener("click", openFeedback);
document.getElementById("fb-retake").addEventListener("click", startSelection);
document.getElementById("fb-cancel").addEventListener("click", function () { document.getElementById("fb-modal").classList.add("fb-hidden"); });
document.getElementById("fb-send").addEventListener("click", sendFeedback);

// Single quotes are escaped too: most attributes in this file are written with
// single delimiters (title='...', value='...'), so leaving ' alone let any
// escaped value break out of its attribute and add an event handler.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Feedback screenshots are whatever the reporting client sent, rendered in the
// admin's own session - so an <img src> is only ever built from a value that is
// actually an inline image. Anything else (a javascript: URL, a crafted string
// closing the attribute) is dropped rather than escaped into the page.
function safeImageSrc(s) {
  return /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/.test(String(s || "")) ? String(s) : null;
}

// ---------- formatting ----------

function pct(x) { return (x * 100).toFixed(1) + "%"; }
function signClass(x) { return x == null ? "" : (x >= 0 ? "pos" : "neg"); }
function isoDate(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function pad2(n) { return n < 10 ? "0" + n : "" + n; }

// ---------- admin (in-app, admins only, reads Supabase) ----------

let adminTab = "users";
let admGran = "month", admOffset = 0; // admin aggregate time window
let admCorrW = 30; // admin market-correlation rolling window (trading days)
function admUnit() { return admGran === "day" ? "hour" : admGran === "year" ? "month" : "day"; }
function admFmt(ms, unit) {
  const d = new Date(ms);
  if (unit === "hour") return d.getHours() + "h";
  if (unit === "month") return MON[d.getMonth()];
  return (d.getMonth() + 1) + "/" + d.getDate();
}
function admFmtFull(ms, unit) {
  return unit === "hour" ? (isoDate(ms) + " " + new Date(ms).getHours() + ":00") : (unit === "month" ? MON[new Date(ms).getMonth()] + " " + new Date(ms).getFullYear() : isoDate(ms));
}
const PROCESSES = [
  { name: "Attention capture", what: "Opening a stock page on a supported portal logs an attention event automatically.", flow: ["Portal page", "Content script reads ticker", "Background worker", "Dedupe + Daily & Intraday DBs", "Sync"] },
  { name: "Price at event", what: "Each event stores the price when you viewed it.", flow: ["New event", "Yahoo quote", "Store priceAtEvent"] },
  { name: "Hourly archive", what: "Keeps hourly bars past Yahoo's ~730-day limit.", flow: ["First sight", "Backfill", "IndexedDB", "Daily alarm appends"] },
  { name: "Sync (cloud)", what: "Per-user push/pull to Supabase; last-write-wins; RLS isolation.", flow: ["collectChanges", "upsert tables", "select since cursor", "applyRemote"] },
  { name: "Accounts", what: "Google sign-in; user_id = auth uid; admins can read all via RLS.", flow: ["Google OAuth", "profiles row", "RLS per user", "admin overview"] },
  { name: "Feedback", what: "Select area -> screenshot -> stored; optional Discord/GitHub.", flow: ["Select area", "html2canvas", "store", "Discord / GitHub issue"] }
];

// Overview of every statistic/field collected per user. Extend as features ship.
const COLLECTED = [
  { section: "Account", note: "From Google sign-in.", items: [
    { name: "Email, name", how: "Provided by Google OAuth; stored in profiles." },
    { name: "user_id", how: "Stable account id (auth uid) that keys all of a user's rows." }
  ] },
  { section: "Raw attention (per view)", items: [
    { name: "Ticker", how: "Parsed from the stock-page URL on a supported portal." },
    { name: "Timestamp", how: "When the page was viewed." },
    { name: "Source / URL", how: "Which portal and page." },
    { name: "Price at view", how: "Yahoo quote captured at view time (basis for return math)." },
    { name: "Label", how: "Positive / Neutral / Negative expectation, if the user set one." },
    { name: "Dwell time", how: "Active time on the page (visible tab only), accumulated." },
    { name: "Views", how: "Repeat views within 60 min merge into one daily event with a counter; intraday keeps each." }
  ] },
  { section: "Watchlist (per stock)", items: [
    { name: "First seen", how: "Date of first view." },
    { name: "Events / views", how: "Count of attention events." },
    { name: "Return since", how: "(current price − price at first view) / price at first view." },
    { name: "Ret / view", how: "Return since ÷ total views." },
    { name: "Ret / hour", how: "Return since ÷ hours of dwell." },
    { name: "Label hit rate", how: "Share of labels whose direction matched the move since viewing." }
  ] },
  { section: "Summary (header)", items: [
    { name: "Tickers, daily events, intraday views", how: "Counts of stocks and recorded events." },
    { name: "Hit rate", how: "Correct labels ÷ labeled events (per basis)." },
    { name: "Avg return / view / day", how: "Averaged across stocks." }
  ] },
  { section: "Stocks viewed (event-based)", items: [
    { name: "Usage summary", how: "HHI concentration, effective # stocks, discovery/revisit, avg attention→label, current/longest streak, longest no-attention gap, busiest day." },
    { name: "Calendar", how: "Views per day (1-year heatmap)." },
    { name: "Attention over time", how: "Views per bucket over the chosen period." },
    { name: "By stock over time", how: "Views per stock per bucket." },
    { name: "Distributions", how: "Views by hour of day, by weekday, most attended." },
    { name: "Market correlation", how: "Pearson r of daily views vs NASDAQ same/previous-day returns; net outlook vs next-day." }
  ] },
  { section: "Time spent (dwell-based)", items: [
    { name: "Summary", how: "Total time, avg time/view, time concentration (HHI), effective # stocks, busiest day by time." },
    { name: "Time over time, by stock, calendar, distributions", how: "Same as event-based, weighted by active minutes." },
    { name: "Market correlation (time)", how: "Pearson r of daily minutes vs NASDAQ returns." }
  ] },
  { section: "Outlook", items: [
    { name: "Outlook mix over time", how: "Positive / neutral / negative label counts per period." }
  ] },
  { section: "Predictions", note: "Only for stocks where the user sets these fields.", items: [
    { name: "Position taken, target price, rationale", how: "Optional fields set in the popup or in-page widget alongside a label." },
    { name: "Horizon", how: "Optional number of days given to reach the target; the deadline is the view time plus the horizon." },
    { name: "Direction / target hit rate", how: "Whether the price moved as called, and whether the target was reached before the deadline." },
    { name: "Pace, time used, Brier score, edge vs NASDAQ", how: "Derived on the dashboard from the stored prices; nothing extra is recorded." }
  ] },
  { section: "Feedback", items: [
    { name: "Note + screenshot + page", how: "Stored only when the user submits feedback." }
  ] }
];
function collectedHtml() {
  return "<p class='muted small'>Every statistic and field the app records for a user, by section. Updated as features ship.</p>" +
    COLLECTED.map(function (s) {
      return "<div class='proc'><h3>" + escapeHtml(s.section) + "</h3>" +
        (s.note ? "<div class='what'>" + escapeHtml(s.note) + "</div>" : "") +
        "<table class='adm'>" + s.items.map(function (it) {
          return "<tr><td style='white-space:nowrap'><b>" + escapeHtml(it.name) + "</b></td><td class='muted'>" + escapeHtml(it.how) + "</td></tr>";
        }).join("") + "</table></div>";
    }).join("");
}

function systemHtml() {
  return "<p class='muted small'>What the app does, end to end.</p>" + PROCESSES.map(function (p) {
    const flow = p.flow.map(function (s, i) { return (i ? "<span class='proc-arrow'>&rarr;</span>" : "") + "<span class='proc-step'>" + escapeHtml(s) + "</span>"; }).join(" ");
    return "<div class='proc'><h3>" + escapeHtml(p.name) + "</h3><div class='what'>" + escapeHtml(p.what) + "</div><div class='proc-flow'>" + flow + "</div></div>";
  }).join("");
}

function adminWhen(ts) { return ts ? new Date(ts).toLocaleString() : "-"; }

async function renderAdminUsers(v) {
  const rows = await ATCloud.adminUsers();
  let h = "<table class='adm'><tr><th>User</th><th>Email</th><th>Events</th><th>Intraday</th><th>Last activity</th></tr>";
  rows.forEach(function (r) {
    h += "<tr class='click' data-u='" + escapeHtml(r.user_id) + "'><td>" + escapeHtml(r.name || "-") + "</td><td class='muted'>" + escapeHtml(r.email || "-") + "</td><td>" + r.events + "</td><td>" + r.intraday + "</td><td class='muted'>" + adminWhen(r.last_ts) + "</td></tr>";
  });
  v.innerHTML = h + "</table><div id='adm-detail'></div>";
  v.querySelectorAll("tr.click").forEach(function (tr) {
    tr.addEventListener("click", async function () {
      const evs = await ATCloud.adminUserEvents(tr.getAttribute("data-u"));
      let d = "<h3>Latest events</h3><table class='adm'><tr><th>Ticker</th><th>Time</th><th>Source</th><th>Label</th><th>Price</th><th>Views</th></tr>";
      evs.forEach(function (e) { d += "<tr><td>" + escapeHtml(e.ticker) + "</td><td class='muted'>" + adminWhen(e.ts) + "</td><td class='muted'>" + escapeHtml(e.source || "") + "</td><td>" + escapeHtml(e.sentiment || "-") + "</td><td>" + (e.price_at_event == null ? "-" : e.price_at_event) + "</td><td>" + (e.views || 1) + "</td></tr>"; });
      document.getElementById("adm-detail").innerHTML = d + "</table>";
    });
  });
}

function admCard(val, label, desc) { return "<div class='stat'" + (desc ? " title='" + escapeHtml(desc) + "'" : "") + "><b>" + escapeHtml(String(val)) + "</b>" + escapeHtml(label) + "</div>"; }

// Line chart on a fixed -1..1 domain (for rolling correlation), with a zero line.
// `vals` is one r series (numbers), or several lines as [{ label, color, vals }]
// whose null points break the line. With several lines `titles` is per-point
// HTML: the generic multi tooltip hides values <= 0, which for r are real.
function drawCorrCanvas(cv, tipId, vals, labels, titles) {
  const multi = vals.length && typeof vals[0] === "object" && vals[0] !== null && vals[0].vals;
  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H;
  const padL = 36, padR = 10, padT = 10, padB = 20, pw = W - padL - padR, ph = H - padT - padB;
  const n = multi ? vals[0].vals.length : vals.length, lo = -1, hi = 1;
  const X = function (i) { return n <= 1 ? padL + pw / 2 : padL + (i / (n - 1)) * pw; };
  const Y = function (v) { return padT + (1 - (v - lo) / (hi - lo)) * ph; };
  c.font = "10px sans-serif"; c.textAlign = "start";
  [-1, -0.5, 0, 0.5, 1].forEach(function (g) {
    const y = Y(g);
    c.strokeStyle = g === 0 ? TC().line : TC().grid; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
    c.fillStyle = TC().muted; c.fillText(g.toFixed(1), 4, y + 3);
  });
  c.textAlign = "center"; c.fillStyle = TC().muted;
  labels.forEach(function (lab, i) { if (lab) c.fillText(String(lab), X(i), H - 6); });
  if (multi) {
    const lines = vals.map(function (sr) {
      c.strokeStyle = sr.color; c.lineWidth = 1.5; c.beginPath();
      let pen = false;
      sr.vals.forEach(function (v, i) {
        if (v == null) { pen = false; return; }
        if (pen) c.lineTo(X(i), Y(v)); else c.moveTo(X(i), Y(v));
        pen = true;
      });
      c.stroke();
      return { label: sr.label, color: sr.color, pts: sr.vals.map(function (v, i) { return { x: X(i), y: Y(v == null ? 0 : v), v: v, i: i }; }) };
    });
    canvasHover[cv.id] = { kind: "line", lines: lines, titles: titles, html: titles, multi: true, tipId: tipId, base: cv.width ? c.getImageData(0, 0, cv.width, cv.height) : null, geom: { padT: padT, ph: ph } };
    return;
  }
  c.strokeStyle = "#4e9eff"; c.lineWidth = 1.5; c.beginPath();
  vals.forEach(function (v, i) { const x = X(i), y = Y(v); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); });
  c.stroke();
  canvasHover[cv.id] = { kind: "line", lines: [{ label: "r", color: "#4e9eff", pts: vals.map(function (v, i) { return { x: X(i), y: Y(v), v: v, i: i }; }) }], titles: titles, multi: false, tipId: tipId, base: cv.width ? c.getImageData(0, 0, cv.width, cv.height) : null, geom: { padT: padT, ph: ph } };
}

// ---- admin aggregate: mirror the user Attention window (Views | Time), aggregated ----
function admMin(ms) { const m = Number(ms) / 60000; return m >= 60 ? (m / 60).toFixed(1) + "h" : Math.round(m) + "m"; }
function admMetricVal(x, metric) { return metric === "time" ? Number(x.dwell || 0) / 60000 : Number(x.events != null ? x.events : (x.views != null ? x.views : x.n)) || 0; }

function admCalHtml(targetId, rows, metric) {
  const unit = metric === "time" ? "min" : "views";
  const byDay = {};
  rows.forEach(function (x) { byDay[x.cday] = metric === "time" ? Number(x.dwell || 0) / 60000 : Number(x.views || 0); });
  let max = 1; Object.keys(byDay).forEach(function (d) { if (byDay[d] > max) max = byDay[d]; });
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const cur = new Date(end); cur.setDate(cur.getDate() - 7 * 52); cur.setDate(cur.getDate() - cur.getDay());
  let html = "<div class='cal-grid'>";
  while (cur <= end) {
    const d = isoDate(cur.getTime()), val = byDay[d] || 0;
    const lvl = val === 0 ? 0 : val >= max * 0.75 ? 4 : val >= max * 0.5 ? 3 : val >= max * 0.25 ? 2 : 1;
    html += "<div class='cal-cell lvl" + lvl + "' title='" + d + ": " + fmtVal(val, unit) + " " + unit + "'></div>";
    cur.setDate(cur.getDate() + 1);
  }
  document.getElementById(targetId).innerHTML = html + "</div>";
}

function drawAdminOverTime(canvasId, tipId, rows, unit, kind, metric) {
  const cv = document.getElementById(canvasId);
  rows = rows.slice().sort(function (a, b) { return a.bucket - b.bucket; });
  const step = Math.max(1, Math.ceil(rows.length / 8));
  const vals = rows.map(function (x) { const u = Number(x.users) || 0; return u ? admMetricVal(x, metric) / u : 0; });
  const labels = rows.map(function (x, i) { return i % step === 0 ? admFmt(x.bucket, unit) : ""; });
  const noun = metric === "time" ? " min" : "";
  const titles = rows.map(function (x, i) { return admFmtFull(x.bucket, unit) + ": " + vals[i].toFixed(1) + noun + " / user (n=" + x.users + ")"; });
  if (kind === "line") drawLineCanvas(cv, tipId, [{ label: "avg/user", color: metric === "time" ? "#2ecc71" : "#4e9eff", vals: vals }], labels, titles);
  else drawBarCanvas(cv, tipId, vals, labels, titles);
  attachCanvasHover(cv);
}

function drawAdminStockChart(canvasId, tableId, rows, unit, metric) {
  const cv = document.getElementById(canvasId), tableDiv = document.getElementById(tableId);
  if (!rows.length) { setupCanvas(cv); tableDiv.textContent = "No data."; return; }
  const bset = {}; rows.forEach(function (x) { bset[x.bucket] = 1; });
  const buckets = Object.keys(bset).map(Number).sort(function (a, b) { return a - b; });
  const bIdx = {}; buckets.forEach(function (b, i) { bIdx[b] = i; });
  const valOf = function (x) { return metric === "time" ? Number(x.dwell || 0) / 60000 : Number(x.views || 0); };
  const tot = {}; rows.forEach(function (x) { tot[x.ticker] = (tot[x.ticker] || 0) + valOf(x); });
  const tickers = Object.keys(tot).sort(function (a, b) { return tot[b] - tot[a]; }).slice(0, 10);
  const colorOf = {}; tickers.forEach(function (t, i) { colorOf[t] = PALETTE[i % PALETTE.length]; });
  const series = {}; tickers.forEach(function (t) { series[t] = new Array(buckets.length).fill(0); });
  rows.forEach(function (x) { if (series[x.ticker] !== undefined) { const u = Number(x.users) || 1; series[x.ticker][bIdx[x.bucket]] = valOf(x) / u; } });

  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H;
  const padL = 36, padR = 10, padT = 10, padB = 20, pw = W - padL - padR, ph = H - padT - padB;
  const n = buckets.length;
  let max = 1; tickers.forEach(function (t) { series[t].forEach(function (val) { if (val > max) max = val; }); });
  max = niceTicks(0, max, 5).max;
  const X = function (i) { return n <= 1 ? padL + pw / 2 : padL + (i / (n - 1)) * pw; };
  const Y = function (val) { return padT + (1 - val / max) * ph; };
  const step = Math.max(1, Math.ceil(n / 8));
  drawAxes(c, W, H, padL, padR, padT, ph, max, buckets.map(function (b, i) { return i % step === 0 ? admFmt(b, unit) : ""; }), X);
  // Snapshot the axes alone so hover can redraw lines with one ticker isolated.
  const axesBase = cv.width ? c.getImageData(0, 0, cv.width, cv.height) : null;
  function drawLines(highlight) {
    tickers.forEach(function (t) {
      c.globalAlpha = (highlight && t !== highlight) ? 0.12 : 1;
      c.strokeStyle = colorOf[t]; c.lineWidth = (highlight && t === highlight) ? 2.5 : 1.5; c.beginPath();
      series[t].forEach(function (val, i) { const x = X(i), y = Y(val); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); });
      c.stroke();
    });
    c.globalAlpha = 1;
  }
  drawLines(null);
  const unitLab = metric === "time" ? "m/u" : "/u";
  const base = cv.width ? c.getImageData(0, 0, cv.width, cv.height) : null;
  cv.onmousemove = function (ev) {
    const rect = cv.getBoundingClientRect(), mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    let i = Math.round((mx - padL) / (pw || 1) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    // Isolate the ticker whose value at this column is nearest the cursor (y).
    let hi = null, hiD = Infinity;
    tickers.forEach(function (t) { if (series[t][i] > 0) { const d = Math.abs(Y(series[t][i]) - my); if (d < hiD) { hiD = d; hi = t; } } });
    if (axesBase) c.putImageData(axesBase, 0, 0);
    drawLines(hi);
    drawVGuide(c, X(i), padT, ph);
    const r2 = tickers.map(function (t) { return { t: t, v: series[t][i] }; }).filter(function (x) { return x.v > 0; }).sort(function (a, b) { return b.v - a.v; });
    showTip("<b>" + admFmtFull(buckets[i], unit) + "</b><br>" + (r2.length
      ? r2.map(function (x) { const em = x.t === hi; return "<span style='color:" + colorOf[x.t] + (em ? "" : "; opacity:.6") + "'>&#9632;</span> " + (em ? "<b>" : "") + escapeHtml(x.t) + " " + x.v.toFixed(1) + unitLab + (em ? "</b>" : ""); }).join("<br>")
      : "<span class='muted'>none</span>"), ev.clientX, ev.clientY);
  };
  cv.onmouseleave = function () { hideTip(); if (base) c.putImageData(base, 0, 0); };
  tableDiv.innerHTML = "<span class='muted'>" + tickers.map(function (t) { return "<span style='color:" + colorOf[t] + "'>&#9632;</span> " + escapeHtml(t); }).join("  ") + "</span>";
}

async function drawAdminCorr(canvasId, tipId, calRows, metric) {
  await ensureBenchmark();
  const cv = document.getElementById(canvasId);
  const W = admCorrW;
  if (!BENCH || BENCH.length < W + 5) { setupCanvas(cv); document.getElementById(tipId).textContent = "Not enough market data for a " + W + "-day window yet."; return; }
  const att = {}; calRows.forEach(function (x) { att[x.cday] = metric === "time" ? Number(x.dwell || 0) / 60000 : Number(x.views || 0); });
  const ret = {}; for (let i = 1; i < BENCH.length; i++) ret[BENCH[i].date] = BENCH[i].close / BENCH[i - 1].close - 1;
  const days = BENCH.slice(1).map(function (b) { return b.date; });
  const a = days.map(function (d) { return att[d] || 0; });
  const rr = days.map(function (d) { return ret[d]; });
  const vals = [], labels = [], titles = [];
  for (let i = W - 1; i < days.length; i++) {
    const p = pearson(a.slice(i - W + 1, i + 1), rr.slice(i - W + 1, i + 1));
    const j = vals.length;
    vals.push(p == null ? 0 : p);
    labels.push(j % 10 === 0 ? days[i].slice(5) : "");
    titles.push(days[i] + ": r=" + (p == null ? "-" : p.toFixed(2)));
  }
  drawCorrCanvas(cv, tipId, vals, labels, titles);
  attachCanvasHover(cv);
}

function admDistBars(rows, keyName, len, labelFn, metric) {
  const map = {}; rows.forEach(function (x) { map[x[keyName]] = metric === "time" ? Number(x.dwell || 0) / 60000 : Number(x.n || 0); });
  const unit = metric === "time" ? "min" : "views";
  const bars = [];
  for (let i = 0; i < len; i++) { const v = map[i] || 0; bars.push({ v: v, label: labelFn(i), title: labelFn(i, true) + " - " + fmtVal(v, unit) + " " + unit }); }
  return bars;
}

// ---------- GROUP A-E admin panels (Aggregate view) ----------

// GROUP E3: platform health cards + section-usage sub-table.
function platformHealthHtml(m, fu) {
  m = m || {};
  const fmtMin = function (vv) { return vv == null ? "-" : (Math.round(vv * 10) / 10) + "m"; };
  const q = m.avg_fields_filled;
  const quality = q == null ? "-" : Math.round(q / 7 * 100) + "%";
  const top = (m.top_custom_portals && m.top_custom_portals[0]) ? m.top_custom_portals[0].source : "-";
  let h = "<h3 title='Platform-wide health and data quality.'>Platform health</h3><div class='usage-cards'>" +
    admCard(fmtMin(m.sync_latency_p50_minutes), "Sync latency P50", "Median minutes from event creation to cloud arrival.") +
    admCard(fmtMin(m.sync_latency_p95_minutes), "Sync latency P95", "95th percentile event-to-cloud latency.") +
    admCard(quality, "Data quality", "Average share of the 7 enrichment fields populated per event.") +
    admCard(m.pct_events_with_sentiment == null ? "-" : pct(m.pct_events_with_sentiment), "Sentiment adoption", "Fraction of events carrying a sentiment label.") +
    admCard(m.pct_events_with_position_taken == null ? "-" : pct(m.pct_events_with_position_taken), "Position adoption", "Fraction of events marked as a position taken.") +
    admCard((m.custom_portal_count == null ? "-" : m.custom_portal_count) + (top !== "-" ? " (" + escapeHtml(String(top)) + ")" : ""), "Custom portals", "User-added (non-built-in) sources, with the busiest one.") +
    admCard(m.avg_dashboard_minutes == null ? "-" : (Math.round(m.avg_dashboard_minutes * 10) / 10) + "m", "Dashboard time / user", "Average active minutes users spend on the dashboard.") +
    "</div>";
  return h + sectionUsageTableHtml(fu);
}

function sectionUsageTableHtml(fu) {
  // area:/click: sections are shown in the dedicated area-usage panel, not here.
  const rows = ((fu && fu.section_totals) || []).filter(function (r) { return !/^(area|click):/.test(String(r.section)); });
  if (!rows.length) return "";
  const cls = function (vv) { return vv == null ? "" : (vv >= 0.6 ? "calib-green" : (vv >= 0.3 ? "calib-amber" : "calib-red")); };
  let h = "<h5>Section usage</h5><table class='an-table'><thead><tr><th>Section</th><th>Events</th><th>Users</th><th>% active users</th></tr></thead><tbody>";
  rows.forEach(function (r) {
    h += "<tr><td>" + escapeHtml(usageLabel(r.section)) + "</td><td>" + (r.total_events || 0) + "</td><td>" + (r.unique_users || 0) +
      "</td><td class='" + cls(r.pct_of_active_users) + "'>" + (r.pct_of_active_users == null ? "-" : pct(r.pct_of_active_users)) + "</td></tr>";
  });
  return h + "</tbody></table>";
}

// GROUP A3: portal attribution.
function portalAttributionHtml(rows, ft) {
  let h = "<h3 title='How each portal drives attention and sentiment.'>Portal attribution</h3>";
  if (!rows || !rows.length) return h + "<div class='muted small'>No portal data yet.</div>";
  h += "<div class='adm-two'>" +
    "<div><h5>Attention density (dwell / ticker)</h5><canvas id='adm-portal-density' class='an-canvas'></canvas></div>" +
    "<div><h5>Sentiment mix per portal</h5><canvas id='adm-portal-sent' class='an-canvas'></canvas>" +
    "<div class='muted small'><span class='swatch' style='background:#2ecc71'></span>pos " +
    "<span class='swatch' style='background:#8a93a6'></span>neu <span class='swatch' style='background:#e74c3c'></span>neg</div></div></div>";
  if (ft && ft.length) {
    h += "<h5>First-touch discovery</h5><table class='an-table'><thead><tr><th>Portal</th><th>First touches</th><th>% of discoveries</th><th>Avg subsequent views</th></tr></thead><tbody>";
    ft.forEach(function (r) {
      h += "<tr><td>" + escapeHtml(String(r.source)) + "</td><td>" + (r.first_touch_count || 0) + "</td><td>" +
        (r.pct_of_all_discoveries == null ? "-" : pct(r.pct_of_all_discoveries)) + "</td><td>" +
        (r.avg_subsequent_views == null ? "-" : (Math.round(r.avg_subsequent_views * 10) / 10)) + "</td></tr>";
    });
    h += "</tbody></table>";
  }
  return h;
}

function drawPortalDensity(canvasId, rows) {
  const cv = document.getElementById(canvasId); if (!cv) return;
  const data = (rows || []).slice().sort(function (a, b) { return (b.attention_density || 0) - (a.attention_density || 0); });
  if (!data.length) return;
  cv.style.height = (data.length * 26 + 8) + "px";
  const s = setupCanvas(cv), c = s.c, W = s.W, padL = 96, padR = 44, rowH = 26;
  const max = Math.max.apply(null, data.map(function (d) { return d.attention_density || 0; })) || 1;
  c.font = "11px sans-serif";
  data.forEach(function (d, i) {
    const y = 4 + i * rowH, bw = (W - padL - padR) * ((d.attention_density || 0) / max);
    c.fillStyle = TC().muted; c.textAlign = "end"; c.fillText(String(d.source).slice(0, 16), padL - 6, y + rowH / 2 + 3);
    c.fillStyle = "#4e9eff"; c.fillRect(padL, y + 3, Math.max(1, bw), rowH - 8);
    c.fillStyle = TC().fg; c.textAlign = "start"; c.fillText(Math.round((d.attention_density || 0) / 1000) + "s", padL + bw + 4, y + rowH / 2 + 3);
  });
}

function drawPortalSentiment(canvasId, rows) {
  const cv = document.getElementById(canvasId); if (!cv) return;
  const data = (rows || []).filter(function (d) { return d.sentiment_distribution; });
  if (!data.length) return;
  cv.style.height = (data.length * 26 + 8) + "px";
  const s = setupCanvas(cv), c = s.c, W = s.W, padL = 96, padR = 8, rowH = 26;
  c.font = "11px sans-serif";
  data.forEach(function (d, i) {
    const sd = d.sentiment_distribution || {}, pos = +sd.positive || 0, neu = +sd.neutral || 0, neg = +sd.negative || 0, tot = pos + neu + neg;
    const y = 4 + i * rowH, fullW = W - padL - padR;
    c.fillStyle = TC().muted; c.textAlign = "end"; c.fillText(String(d.source).slice(0, 16), padL - 6, y + rowH / 2 + 3);
    let x = padL;
    if (tot) {
      const seg = function (val, col) { const w = fullW * val / tot; c.fillStyle = col; c.fillRect(x, y + 3, w, rowH - 8); x += w; };
      seg(pos, "#2ecc71"); seg(neu, "#8a93a6"); seg(neg, "#e74c3c");
    } else { c.fillStyle = TC().grid; c.fillRect(padL, y + 3, fullW, rowH - 8); }
  });
}

// GROUP B5: temporal patterns.
function temporalHtml(sessRows, spikeRows) {
  let h = "<h3 title='When attention happens and whether timing predicts calibration.'>Temporal patterns</h3>";
  const order = ["pre_market", "market_hours", "after_hours", "overnight"];
  const byS = {}; (sessRows || []).forEach(function (r) { byS[r.market_session] = r; });
  const cls = function (vv) { return vv == null ? "" : (vv >= 0.55 ? "calib-green" : (vv >= 0.45 ? "calib-amber" : "calib-red")); };
  h += "<div class='usage-cards'>";
  order.forEach(function (k) {
    const r = byS[k], hr = r ? r.hit_rate_30d : null;
    h += "<div class='stat' title='" + k + ": event count and 30-day hit rate.'><b class='" + cls(hr) + "'>" +
      (r ? r.event_count : 0) + (hr == null ? "" : " / " + pct(hr)) + "</b>" + k.replace(/_/g, " ") + "</div>";
  });
  h += "</div>";
  if (spikeRows && spikeRows.length) {
    h += "<h5>Attention spikes (&ge;3 users within one hour)</h5><table class='an-table'><thead><tr><th>Ticker</th><th>Hour (UTC)</th><th>Users</th><th>Bull%</th><th>Clustered</th></tr></thead><tbody>";
    spikeRows.slice(0, 20).forEach(function (r) {
      h += "<tr><td>" + escapeHtml(String(r.ticker)) + "</td><td>" + escapeHtml(String(r.spike_hour || "").replace("T", " ").slice(0, 16)) +
        "</td><td>" + (r.unique_users_in_hour || 0) + "</td><td>" + (r.sentiment_bull_pct == null ? "-" : pct(r.sentiment_bull_pct)) +
        "</td><td>" + (r.is_earnings_week ? "<span class='tgt-badge'>cluster</span>" : "") + "</td></tr>";
    });
    h += "</tbody></table>";
  } else {
    h += "<div class='muted small'>No attention spikes yet (needs &ge;3 distinct users on one ticker within an hour).</div>";
  }
  h += "<h5>Hit rate by weekday (return-proxy horizon " +
    "<select id='adm-wd-horizon' class='span-sel'>" +
    [7, 30, 90, 180].map(function (d) { return "<option value='" + d + "'" + (d === wdHorizon ? " selected" : "") + ">" + d + "d</option>"; }).join("") +
    "</select>; dashed = 50%)</h5><canvas id='adm-weekday-hit' class='an-canvas'></canvas>";
  return h;
}

function drawWeekdayHit(canvasId, rows) {
  const cv = document.getElementById(canvasId); if (!cv) return;
  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H, padL = 26, padR = 8, padT = 8, padB = 18, pw = W - padL - padR, ph = H - padT - padB;
  const byd = {}; (rows || []).forEach(function (r) { byd[r.dow] = r; });
  const bw = pw / 7;
  c.font = "10px sans-serif"; c.textAlign = "start";
  [0, 0.25, 0.5, 0.75, 1].forEach(function (vv) {
    const y = padT + (1 - vv) * ph; c.strokeStyle = TC().grid; c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
    c.fillStyle = TC().muted; c.fillText(Math.round(vv * 100) + "", 2, y + 3);
  });
  c.save(); c.strokeStyle = TC().ink(0.4); c.setLineDash([4, 3]);
  const yb = padT + 0.5 * ph; c.beginPath(); c.moveTo(padL, yb); c.lineTo(W - padR, yb); c.stroke(); c.restore();
  for (let i = 0; i < 7; i++) {
    const r = byd[i], hr = (r && r.hit_rate_30d != null) ? r.hit_rate_30d : null, x = padL + i * bw + 2, w = Math.max(1, bw - 4);
    if (hr != null) { const hh = hr * ph, y = padT + ph - hh; c.fillStyle = hr >= 0.55 ? "#2ecc71" : (hr >= 0.45 ? "#f1c40f" : "#e74c3c"); c.fillRect(x, y, w, hh); }
    c.fillStyle = TC().muted; c.textAlign = "center"; c.fillText(DOW[i], x + w / 2, H - 6);
  }
}

// GROUP C2: consensus signals (table only; the scatter is rendered separately).
function consensusTableHtml(rows) {
  let h = "<h3 title='Cross-user crowding and contrarian signals by ticker-week.'>Consensus signals</h3>";
  if (!rows || !rows.length) return h + "<div class='muted small'>No multi-user ticker-weeks yet.</div>";
  h += "<div class='adm-scroll'><table class='an-table'><thead><tr><th>Ticker</th><th>Week</th>" +
    "<th title='Distinct users who viewed this ticker that week.'>Users</th>" +
    "<th title='Positive / (Positive + Negative) labels that week.'>Bull%</th>" +
    "<th title='crowd+ = >=75% bull & >=3 users; crowd- = <=25% bull & >=3 users; split = evenly divided.'>Signal</th>" +
    "<th title='Average 30-day return proxy for that ticker-week.'>30d ret</th></tr></thead><tbody>";
  rows.slice(0, 30).forEach(function (r) {
    const bp = r.sentiment_bull_pct;
    let badges = "";
    if (r.is_crowded_bull) badges += "<span class='conv-pill conv-green'>crowd+</span> ";
    if (r.is_crowded_bear) badges += "<span class='conv-pill conv-red'>crowd-</span> ";
    if (r.is_divergent) badges += "<span class='conv-pill conv-amber'>split</span> ";
    const bar = bp == null ? "-" : "<span class='w52' style='width:60px'><span class='w52-fill' style='width:" + Math.round(bp * 100) + "%'></span></span> " + pct(bp);
    h += "<tr><td>" + escapeHtml(String(r.ticker)) + "</td><td>" + escapeHtml(String(r.week || "").slice(0, 10)) + "</td><td>" +
      (r.unique_users || 0) + "</td><td>" + bar + "</td><td>" + badges + "</td><td class='" + signClass(r.return_proxy_30d) + "'>" +
      (r.return_proxy_30d == null ? "-" : pct(r.return_proxy_30d)) + "</td></tr>";
  });
  return h + "</tbody></table></div>";
}

function drawConsensusScatter(canvasId, rows) {
  const cv = document.getElementById(canvasId); if (!cv) return;
  const pts = (rows || []).filter(function (r) { return r.sentiment_bull_pct != null && r.return_proxy_30d != null; });
  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H, padL = 40, padR = 10, padT = 10, padB = 22, pw = W - padL - padR, ph = H - padT - padB;
  let maxAbs = 0.05; pts.forEach(function (p) { maxAbs = Math.max(maxAbs, Math.abs(p.return_proxy_30d)); });
  const X = function (vv) { return padL + vv * pw; }, Y = function (vv) { return padT + ph / 2 - (vv / maxAbs) * (ph / 2); };
  c.strokeStyle = TC().grid; c.font = "10px sans-serif";
  c.beginPath(); c.moveTo(padL, Y(0)); c.lineTo(W - padR, Y(0)); c.stroke();
  c.beginPath(); c.moveTo(X(0.5), padT); c.lineTo(X(0.5), padT + ph); c.stroke();
  c.fillStyle = TC().muted; c.textAlign = "center";
  c.fillText("0%", X(0), H - 6); c.fillText("50%", X(0.5), H - 6); c.fillText("100%", X(1), H - 6);
  c.textAlign = "start"; c.fillText("+" + Math.round(maxAbs * 100) + "%", 2, padT + 8); c.fillText("-" + Math.round(maxAbs * 100) + "%", 2, padT + ph);
  if (!pts.length) { c.fillStyle = TC().muted; c.textAlign = "center"; c.fillText("No labelled ticker-weeks with 30d history yet.", W / 2, H / 2); return; }
  pts.forEach(function (p) {
    const x = X(Math.max(0, Math.min(1, p.sentiment_bull_pct))), y = Y(Math.max(-maxAbs, Math.min(maxAbs, p.return_proxy_30d)));
    c.beginPath(); c.fillStyle = p.return_proxy_30d >= 0 ? "rgba(46,204,113,0.85)" : "rgba(231,76,60,0.85)"; c.arc(x, y, 3, 0, Math.PI * 2); c.fill();
  });
}

// GROUP D2: lead-lag CSV export.
// CSV cell for the admin exports. A text cell starting with = + - @ would run as a
// formula in a spreadsheet (users write these columns on their own rows), so it gets
// a leading quote; plain numbers, negative ones included, stay numbers.
function csvCell(v) {
  if (v == null) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportLeadLagCsv() {
  const st = document.getElementById("admin-status");
  if (st) st.textContent = "Building export...";
  try {
    const rows = await ATCloud.adminLeadLagExport();
    const cols = ["ticker", "ts", "source", "market_session", "sentiment", "views", "dwell_ms", "scroll_depth",
      "focus_switches", "week52_position", "market_cap_bucket", "sector", "price_at_event",
      "return_1d_proxy", "return_7d_proxy", "return_30d_proxy"];
    const esc = csvCell;
    const lines = [cols.join(",")];
    (rows || []).forEach(function (r) { lines.push(cols.map(function (cc) { return esc(r[cc]); }).join(",")); });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "lead_lag_export_" + isoDate(Date.now()).replace(/-/g, "") + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    if (st) st.textContent = "Exported " + (rows ? rows.length : 0) + " rows.";
  } catch (e) { if (st) st.textContent = "Export failed: " + (e && e.message || e); }
}

// "How people use Stocktrails": per-bucket section share over the selected
// window, drawn as one line per section (each bucket totals 100%).
async function renderFeatureUsageOverTime() {
  const cv = document.getElementById("fuot-canvas"); if (!cv) return;
  const b = buildAttBuckets(fuGran, fuOffset);
  const rangeEl = document.getElementById("fuot-range"); if (rangeEl) rangeEl.textContent = b.range;
  const nextEl = document.getElementById("fuot-next"); if (nextEl) nextEl.disabled = fuOffset <= 0;
  const from = b.buckets[0].t, to = b.buckets[b.buckets.length - 1].next;
  const unit = fuGran === "day" ? "hour" : (fuGran === "year" ? "month" : "day");
  let rows = [];
  try { rows = await ATCloud.adminFeatureUsageOverTime(from, to, unit); } catch (e) { rows = []; }
  // area:/click: sections belong to the area-usage panel, not the section-share chart.
  rows = (rows || []).filter(function (r) { return !/^(area|click):/.test(String(r.section)); });
  const sections = {};
  rows.forEach(function (r) {
    const t = Date.parse(r.bucket);
    for (let i = 0; i < b.buckets.length; i++) {
      if (t >= b.buckets[i].t && t < b.buckets[i].next) {
        (sections[r.section] = sections[r.section] || new Array(b.buckets.length).fill(0))[i] += Number(r.n) || 0;
        break;
      }
    }
  });
  const keys = Object.keys(sections).sort();
  const legend = document.getElementById("fuot-legend");
  if (!keys.length) {
    const s = setupCanvas(cv); s.c.fillStyle = TC().muted; s.c.font = "12px sans-serif";
    s.c.fillText("No section-usage data synced yet.", 8, 18);
    if (legend) legend.innerHTML = "";
    return;
  }
  const totals = new Array(b.buckets.length).fill(0);
  keys.forEach(function (s) { sections[s].forEach(function (v, i) { totals[i] += v; }); });
  const series = keys.map(function (s, idx) {
    return { label: usageLabel(s), color: PALETTE[idx % PALETTE.length], vals: sections[s].map(function (v, i) { return totals[i] ? (v / totals[i] * 100) : 0; }) };
  });
  drawLineCanvas(cv, "fuot-tip", series, b.labels, b.titles);
  if (legend) legend.innerHTML = keys.map(function (s, idx) { return "<span><span class='swatch' style='background:" + PALETTE[idx % PALETTE.length] + "'></span>" + escapeHtml(usageLabel(s)) + "</span>"; }).join(" ");
}

async function renderAdminAggregate(v) {
  v.innerHTML = "<p class='muted small'>Loading...</p>";
  const win = buildAttBuckets(admGran, admOffset);
  const from = win.buckets[0].t, to = win.buckets[win.buckets.length - 1].next, unit = admUnit();
  const r = await Promise.all([
    ATCloud.adminTotals(), ATCloud.adminExtras(), ATCloud.adminTopTickers(),
    ATCloud.adminByHour(), ATCloud.adminByWeekday(),
    ATCloud.adminAttentionBuckets(from, to, unit), ATCloud.adminStockBuckets(from, to, unit),
    ATCloud.adminCalendar()
  ]);
  const totals = r[0], ex = r[1], top = r[2], hour = r[3], wd = r[4], attB = r[5], stkB = r[6], cal = r[7];
  const hhi = Number(ex.hhi) || 0, dhhi = Number(ex.dwell_hhi) || 0;
  const events = Number(totals.events) || 0, dwellTot = Number(ex.dwell_total) || 0;

  // GROUP A-E data (each best-effort: one failing RPC must not blank the view).
  const z = function (p, d) { return p.then(function (x) { return x; }).catch(function () { return d; }); };
  const g = await Promise.all([
    z(ATCloud.adminPortalAttribution(), []), z(ATCloud.adminFirstTouchAttribution(), []),
    z(ATCloud.adminMarketSessionCalibration(), []), z(ATCloud.adminAttentionSpikes(), []),
    z(ATCloud.adminWeekdayCalibration(wdHorizon), []), z(ATCloud.adminConsensusSignals(), [])
  ]);
  const portalAttr = g[0] || [], firstTouch = g[1] || [],
    sessCal = g[2] || [], spikes = g[3] || [], wdCal = g[4] || [], consensus = g[5] || [];

  const cellHead = "<div class='vt-head'>Views</div><div class='vt-head'>Time</div>";
  const usageV = "<div class='usage-cards'>" +
    admCard(totals.users, "Users", "Distinct accounts with data.") +
    admCard(events, "Total events", "All attention events across users.") +
    admCard((ex.discovery == null ? "-" : ex.discovery) + " / " + (ex.revisit == null ? "-" : ex.revisit), "Discovery / revisit", "Distinct (user, ticker) pairs vs. later repeat views.") +
    admCard(hhi.toFixed(2), "Concentration (HHI)", "Herfindahl index of views by ticker across all users.") +
    admCard((hhi > 0 ? 1 / hhi : 0).toFixed(1), "Effective # stocks", "1 / HHI for views.") +
    admCard(ex.busiest_day ? (ex.busiest_day + " (" + ex.busiest_n + ")") : "-", "Busiest day", "Day with the most events across all users.") + "</div>";
  const usageT = "<div class='usage-cards'>" +
    admCard(totals.users, "Users", "Distinct accounts with data.") +
    admCard(admMin(dwellTot), "Total time", "Sum of time-on-page across all users.") +
    admCard(events ? Math.round(dwellTot / 60000 / events * 10) / 10 + "m" : "-", "Avg time / view", "Total time divided by total events.") +
    admCard(dhhi.toFixed(2), "Concentration (HHI)", "Herfindahl index of time-spent by ticker across all users.") +
    admCard((dhhi > 0 ? 1 / dhhi : 0).toFixed(1), "Effective # stocks", "1 / HHI for time.") +
    admCard(ex.dwell_busiest_day ? (ex.dwell_busiest_day + " (" + admMin(ex.dwell_busiest) + ")") : "-", "Busiest day", "Day with the most time across all users.") + "</div>";

  const hrLabel = function (i, full) { return full ? i + ":00 (UTC)" : (i % 6 === 0 ? i + "h" : ""); };
  const wdLabel = function (i, full) { return full ? DOW[i] : DOW[i]; };
  const distV = "<h5>By hour (UTC)</h5>" + barChartHtml(admDistBars(hour, "hour", 24, hrLabel, "views"), true) +
    "<h5>By weekday</h5>" + barChartHtml(admDistBars(wd, "dow", 7, wdLabel, "views"), false);
  const distT = "<h5>By hour (UTC)</h5>" + barChartHtml(admDistBars(hour, "hour", 24, hrLabel, "time"), true) +
    "<h5>By weekday</h5>" + barChartHtml(admDistBars(wd, "dow", 7, wdLabel, "time"), false);
  const topHtml = function (metric) {
    const valOf = function (t) { return metric === "time" ? Number(t.dwell || 0) / 60000 : Number(t.views || 0); };
    const arr = top.slice().sort(function (a, b) { return valOf(b) - valOf(a); }).slice(0, 8);
    const mx = (arr[0] && valOf(arr[0])) || 1;
    return "<h5>Most attended</h5><div class='bars-v'>" + arr.map(function (t) {
      return "<div class='barrow'><span>" + escapeHtml(t.ticker) + "</span><span class='barv' style='width:" + (valOf(t) / mx * 100) + "%'></span><span class='muted'>" + (metric === "time" ? admMin(t.dwell) : t.views) + " / " + t.users + "u</span></div>";
    }).join("") + "</div>";
  };

  // Platform health + "How people use" now live in the Insights tab.
  let h = "<div class='att-toolbar'>" +
    "<select id='adm-gran' class='span-sel'>" +
    ["day", "week", "month", "year"].map(function (g) { return "<option value='" + g + "'" + (g === admGran ? " selected" : "") + ">" + g.charAt(0).toUpperCase() + g.slice(1) + "</option>"; }).join("") +
    "</select><button id='adm-prev' class='navbtn' title='Earlier'>&#9664;</button><span id='adm-range' class='muted small'>" + escapeHtml(win.range) + "</span><button id='adm-next' class='navbtn' title='Later'" + (admOffset <= 0 ? " disabled" : "") + ">&#9654;</button>" +
    "<select id='adm-corrw' class='span-sel' title='Market-correlation rolling window (trading days)'>" +
    [10, 20, 30, 60].map(function (w) { return "<option value='" + w + "'" + (w === admCorrW ? " selected" : "") + ">corr " + w + "d</option>"; }).join("") + "</select></div>";
  h += "<div class='vt-grid'>" + cellHead +
    "<div class='vt-cell'><h4 title='Aggregate usage across all users for the selected window. Left column counts views; right column counts active minutes.'>Usage summary</h4>" + usageV + "</div><div class='vt-cell'><h4>Usage summary</h4>" + usageT + "</div>" +
    "<div class='vt-cell'><h4 title='Daily activity heatmap over the last year.'>Calendar</h4><div id='adm-cal-v'></div></div><div class='vt-cell'><h4>Calendar</h4><div id='adm-cal-t'></div></div>" +
    "<div class='vt-cell'><h4 title='Average attention per user per bucket across the selected window.'>Over time (avg / user)</h4><canvas id='adm-att-v' class='an-canvas'></canvas><div id='adm-att-tip-v' class='muted small'></div></div>" +
    "<div class='vt-cell'><h4 title='Average attention per user per bucket across the selected window.'>Over time (avg / user)</h4><canvas id='adm-att-t' class='an-canvas'></canvas><div id='adm-att-tip-t' class='muted small'></div></div>" +
    "<div class='vt-cell'><h4 title='One line per stock: average attention per user per bucket.'>By stock over time (/ user)</h4><canvas id='adm-stock-v' class='an-canvas'></canvas><div id='adm-stock-tbl-v' class='muted small'></div></div>" +
    "<div class='vt-cell'><h4 title='One line per stock: average attention per user per bucket.'>By stock over time (/ user)</h4><canvas id='adm-stock-t' class='an-canvas'></canvas><div id='adm-stock-tbl-t' class='muted small'></div></div>" +
    "<div class='vt-cell'><h4 title='Breakdown of attention by hour, weekday and most-attended stocks.'>Distributions</h4>" + distV + topHtml("views") + "</div>" +
    "<div class='vt-cell'><h4 title='Breakdown of attention by hour, weekday and most-attended stocks.'>Distributions</h4>" + distT + topHtml("time") + "</div>" +
    "<div class='vt-cell'><h4>Market correlation (rolling " + admCorrW + "d)</h4><canvas id='adm-corr-v' class='an-canvas'></canvas><div id='adm-corr-tip-v' class='muted small'></div></div>" +
    "<div class='vt-cell'><h4>Market correlation (rolling " + admCorrW + "d)</h4><canvas id='adm-corr-t' class='an-canvas'></canvas><div id='adm-corr-tip-t' class='muted small'></div></div>" +
    "</div>";
  // Quick-fix #3: aggregate sector attention over time (% share), adjustable.
  h += "<h3 title='Aggregate attention by sector over time across users. Each bucket sums to 100%.'>Sector attention over time</h3>" +
    "<div class='att-toolbar'><select id='so-gran' class='span-sel'>" +
    ["day", "week", "month", "year"].map(function (gg) { return "<option value='" + gg + "'" + (gg === soGran ? " selected" : "") + ">" + gg.charAt(0).toUpperCase() + gg.slice(1) + "</option>"; }).join("") +
    "</select><button id='so-prev' class='navbtn' title='Earlier'>&#9664;</button><span id='so-range' class='muted small'></span>" +
    "<button id='so-next' class='navbtn' title='Later'>&#9654;</button></div>" +
    "<canvas id='so-canvas' class='an-canvas'></canvas><div id='so-tip' class='muted small'></div><div id='so-legend' class='an-legend'></div>";
  // GROUP A3 / B5 / C2: portal attribution, temporal patterns, consensus signals.
  h += portalAttributionHtml(portalAttr, firstTouch);
  h += temporalHtml(sessCal, spikes);
  // Quick-fix #4: sentiment calibration next to consensus signals (scatter below).
  h += "<div class='adm-two'>" +
    "<div><h3 title='Realized accuracy of Positive/Negative calls (30-day return proxy). Top 20 tickers by labelled events.'>Sentiment calibration</h3><div id='adm-calib' class='adm-scroll'><p class='muted small'>Loading...</p></div></div>" +
    "<div>" + consensusTableHtml(consensus) + "</div>" +
    "</div>";
  h += "<h5>Consensus vs 30d return (x = bull %, y = return)</h5><canvas id='adm-consensus-scatter' class='an-canvas'></canvas>";
  // GROUP 7b: cohort retention.
  h += "<h3 title='Share of each weekly signup cohort still active W+0..W+12 weeks later.'>Cohort retention</h3><div class='cohort-wrap'><canvas id='adm-cohort'></canvas></div><div id='adm-cohort-tip' class='muted small'></div>";
  v.innerHTML = h;

  document.getElementById("adm-gran").addEventListener("change", function () { admGran = this.value; admOffset = 0; renderAdmin(); });
  document.getElementById("adm-prev").addEventListener("click", function () { admOffset++; renderAdmin(); });
  document.getElementById("adm-next").addEventListener("click", function () { if (admOffset > 0) { admOffset--; renderAdmin(); } });

  try { admCalHtml("adm-cal-v", cal, "views"); admCalHtml("adm-cal-t", cal, "time"); } catch (e) { /* ignore */ }
  try { drawAdminOverTime("adm-att-v", "adm-att-tip-v", attB, unit, win.kind, "views"); drawAdminOverTime("adm-att-t", "adm-att-tip-t", attB, unit, win.kind, "time"); } catch (e) { /* ignore */ }
  try { drawAdminStockChart("adm-stock-v", "adm-stock-tbl-v", stkB, unit, "views"); drawAdminStockChart("adm-stock-t", "adm-stock-tbl-t", stkB, unit, "time"); } catch (e) { /* ignore */ }
  try { await drawAdminCorr("adm-corr-v", "adm-corr-tip-v", cal, "views"); await drawAdminCorr("adm-corr-t", "adm-corr-tip-t", cal, "time"); } catch (e) { /* ignore */ }
  try { renderAdminCalibration(await ATCloud.adminSentimentCalibration()); } catch (e) { document.getElementById("adm-calib").innerHTML = "<div class='muted small'>Unavailable.</div>"; }
  try { drawCohortHeatmap("adm-cohort", await ATCloud.adminCohortRetention()); } catch (e) { /* ignore */ }
  // GROUP A3/B5/C2 canvases (data already fetched above).
  try { drawPortalDensity("adm-portal-density", portalAttr); drawPortalSentiment("adm-portal-sent", portalAttr); } catch (e) { /* ignore */ }
  try { drawWeekdayHit("adm-weekday-hit", wdCal); } catch (e) { /* ignore */ }
  try { drawConsensusScatter("adm-consensus-scatter", consensus); } catch (e) { /* ignore */ }

  // Weekday hit-rate horizon control: re-fetch just that series and redraw.
  const wdSel = document.getElementById("adm-wd-horizon");
  if (wdSel) wdSel.addEventListener("change", function () {
    wdHorizon = parseInt(this.value, 10) || 30;
    ATCloud.adminWeekdayCalibration(wdHorizon).then(function (rowsW) { drawWeekdayHit("adm-weekday-hit", rowsW); }).catch(function () { /* ignore */ });
  });

  // Quick-fix #7: market-correlation rolling-window control (full re-render).
  const cw = document.getElementById("adm-corrw");
  if (cw) cw.addEventListener("change", function () { admCorrW = parseInt(this.value, 10) || 30; renderAdmin(); });

  // Quick-fix #3: sector-attention-over-time controls + initial render.
  const sog = document.getElementById("so-gran");
  if (sog) sog.addEventListener("change", function () { soGran = this.value; soOffset = 0; renderSectorOverTime(); });
  const sop = document.getElementById("so-prev");
  if (sop) sop.addEventListener("click", function () { soOffset++; renderSectorOverTime(); });
  const son = document.getElementById("so-next");
  if (son) son.addEventListener("click", function () { if (soOffset > 0) { soOffset--; renderSectorOverTime(); } });
  try { await renderSectorOverTime(); attachCanvasHover(document.getElementById("so-canvas")); } catch (e) { /* ignore */ }
}

// Quick-fix #3: aggregate sector attention over time as % share (one line/sector).
async function renderSectorOverTime() {
  const cv = document.getElementById("so-canvas"); if (!cv) return;
  const b = buildAttBuckets(soGran, soOffset);
  const re = document.getElementById("so-range"); if (re) re.textContent = b.range;
  const ne = document.getElementById("so-next"); if (ne) ne.disabled = soOffset <= 0;
  const from = b.buckets[0].t, to = b.buckets[b.buckets.length - 1].next;
  const unit = soGran === "day" ? "hour" : (soGran === "year" ? "month" : "day");
  let rows = [];
  try { rows = await ATCloud.adminSectorOverTime(from, to, unit); } catch (e) { rows = []; }
  const sectors = {};
  rows.forEach(function (r) {
    const t = Date.parse(r.bucket);
    for (let i = 0; i < b.buckets.length; i++) {
      if (t >= b.buckets[i].t && t < b.buckets[i].next) {
        (sectors[r.sector] = sectors[r.sector] || new Array(b.buckets.length).fill(0))[i] += Number(r.n) || 0;
        break;
      }
    }
  });
  const keys = Object.keys(sectors).sort();
  const legend = document.getElementById("so-legend");
  if (!keys.length) {
    const s = setupCanvas(cv); s.c.fillStyle = TC().muted; s.c.font = "12px sans-serif";
    s.c.fillText("No sector attention in this window yet.", 8, 18);
    if (legend) legend.innerHTML = ""; return;
  }
  const totals = new Array(b.buckets.length).fill(0);
  keys.forEach(function (s) { sectors[s].forEach(function (v, i) { totals[i] += v; }); });
  const series = keys.map(function (s, idx) {
    return { label: s, color: PALETTE[idx % PALETTE.length], vals: sectors[s].map(function (v, i) { return totals[i] ? (v / totals[i] * 100) : 0; }) };
  });
  drawLineCanvas(cv, "so-tip", series, b.labels, b.titles);
  if (legend) legend.innerHTML = keys.map(function (s, idx) { return "<span><span class='swatch' style='background:" + PALETTE[idx % PALETTE.length] + "'></span>" + escapeHtml(s) + "</span>"; }).join(" ");
}

// GROUP 7a: aggregate the per-(user,ticker) calibration rows to per-ticker and
// show the top 20 by labelled events.
function renderAdminCalibration(rows) {
  const el = document.getElementById("adm-calib");
  if (!el) return;
  if (!rows || !rows.length) { el.innerHTML = "<div class='muted small'>No labelled events with 30-day history yet.</div>"; return; }
  const byT = {};
  rows.forEach(function (r) {
    const pos = Number(r.positive_count) || 0, neg = Number(r.negative_count) || 0, neu = Number(r.neutral_count) || 0;
    const tot = pos + neg + neu;
    const o = byT[r.ticker] || (byT[r.ticker] = { ticker: r.ticker, pos: 0, neg: 0, neu: 0, phN: 0, phD: 0, nhN: 0, nhD: 0, brN: 0, brD: 0, flN: 0, flD: 0 });
    o.pos += pos; o.neg += neg; o.neu += neu;
    if (r.positive_hit_rate != null) { o.phN += r.positive_hit_rate * pos; o.phD += pos; }
    if (r.negative_hit_rate != null) { o.nhN += r.negative_hit_rate * neg; o.nhD += neg; }
    if (r.aggregate_brier_score != null) { o.brN += r.aggregate_brier_score * tot; o.brD += tot; }
    if (r.sentiment_flip_rate != null) { o.flN += r.sentiment_flip_rate * tot; o.flD += tot; }
  });
  const arr = Object.keys(byT).map(function (k) {
    const o = byT[k]; o.events = o.pos + o.neg + o.neu;
    o.ph = o.phD ? o.phN / o.phD : null; o.nh = o.nhD ? o.nhN / o.nhD : null;
    o.brier = o.brD ? o.brN / o.brD : null; o.flip = o.flD ? o.flN / o.flD : null;
    return o;
  }).sort(function (a, b) { return b.events - a.events; }).slice(0, 20);
  const cls = function (v) { return v == null ? "" : (v >= 0.55 ? "calib-green" : (v >= 0.45 ? "calib-amber" : "calib-red")); };
  let html = "<table class='an-table'><thead><tr><th>Ticker</th><th title='Positive/Neutral/Negative labels with 30d history.'>Events</th>" +
    "<th title='Share of Positive calls where the price rose over the 30d proxy.'>Pos hit</th>" +
    "<th title='Share of Negative calls where the price fell over the 30d proxy.'>Neg hit</th>" +
    "<th title='" + escapeHtml(BRIER_HELP) + "'>Brier</th>" +
    "<th title='Share of labels that overwrote a different earlier label.'>Flip</th></tr></thead><tbody>";
  arr.forEach(function (o) {
    html += "<tr><td>" + escapeHtml(o.ticker) + "</td><td>" + o.events + "</td>" +
      "<td class='" + cls(o.ph) + "'>" + (o.ph == null ? "-" : pct(o.ph)) + "</td>" +
      "<td class='" + cls(o.nh) + "'>" + (o.nh == null ? "-" : pct(o.nh)) + "</td>" +
      "<td>" + (o.brier == null ? "-" : o.brier.toFixed(3)) + "</td>" +
      "<td>" + (o.flip == null ? "-" : pct(o.flip)) + "</td></tr>";
  });
  el.innerHTML = html + "</tbody></table>";
}

// GROUP 7b: cohort retention heatmap (white -> accent by retention rate).
function drawCohortHeatmap(canvasId, rows) {
  const cv = document.getElementById(canvasId);
  if (!cv) return;
  const tip = document.getElementById("adm-cohort-tip");
  if (!rows || !rows.length) { cv.width = 10; cv.height = 10; cv.getContext("2d").clearRect(0, 0, 10, 10); if (tip) tip.textContent = "No cohort data yet."; return; }
  if (tip) tip.textContent = "Each row = a signup-week cohort; each column = weeks since. Cell = % of the cohort active that week.";
  const weeks = [], seen = {}, map = {}, size = {};
  rows.forEach(function (r) {
    if (!seen[r.cohort_week]) { seen[r.cohort_week] = 1; weeks.push(r.cohort_week); }
    (map[r.cohort_week] = map[r.cohort_week] || {})[r.week_offset] = (r.retention_rate == null ? null : Number(r.retention_rate));
    size[r.cohort_week] = Number(r.cohort_size) || 0;
  });
  weeks.sort();
  const cols = 13, cell = 34, padL = 96, padT = 24;
  const W = padL + cols * cell + 8, H = padT + weeks.length * cell + 6;
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = W + "px"; cv.style.height = H + "px"; cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  c.font = "10px sans-serif";
  c.textAlign = "center"; c.fillStyle = TC().muted;
  for (let j = 0; j < cols; j++) c.fillText("W+" + j, padL + j * cell + (cell - 2) / 2, padT - 9);
  weeks.forEach(function (wk, i) {
    c.textAlign = "end"; c.fillStyle = TC().muted;
    c.fillText(String(wk).slice(5) + " (" + (size[wk] || 0) + ")", padL - 8, padT + i * cell + (cell - 2) / 2 + 3);
    for (let j = 0; j < cols; j++) {
      const v = (map[wk] && map[wk][j] != null) ? map[wk][j] : null;
      const x = padL + j * cell, y = padT + i * cell;
      if (v == null) { c.fillStyle = TC().bg; c.fillRect(x, y, cell - 2, cell - 2); continue; }
      const col = lerpRGB([255, 255, 255], [78, 158, 255], Math.max(0, Math.min(1, v)));
      c.fillStyle = "rgb(" + col[0] + "," + col[1] + "," + col[2] + ")";
      c.fillRect(x, y, cell - 2, cell - 2);
      if (v >= 0.10) {
        c.fillStyle = v < 0.5 ? "#11141c" : "#fff";
        c.textAlign = "center";
        c.fillText(Math.round(v * 100) + "%", x + (cell - 2) / 2, y + (cell - 2) / 2 + 3);
      }
    }
  });
}

async function renderAdminFeedback(v) {
  const rows = await ATCloud.adminFeedback();
  if (!rows.length) { v.innerHTML = "<p class='muted small'>No feedback yet.</p>"; return; }
  const statuses = ["new", "triaged", "approved", "dispatched", "done"];
  const MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
  const EFFORTS = ["low", "medium", "high", "xhigh"];
  function opts(list, def) { return list.map(function (x) { return "<option" + (x === def ? " selected" : "") + ">" + x + "</option>"; }).join(""); }
  v.innerHTML = rows.map(function (f) {
    const sel = "<select class='adm-status' data-id='" + f.id + "'>" + statuses.map(function (s) { return "<option" + (s === f.status ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select>";
    const modelSel = "<select class='adm-model' data-id='" + f.id + "' title='Model the AI agent uses'>" + opts(MODELS, "claude-opus-4-8") + "</select>";
    const effortSel = "<select class='adm-effort' data-id='" + f.id + "' title='Reasoning effort the AI agent uses'>" + opts(EFFORTS, "high") + "</select>";
    return "<div class='card'><div class='fb-head'><b>" + escapeHtml(f.user_id) + "</b><span class='muted'>" + adminWhen(f.created_at) + "</span>" + sel +
      "<input class='adm-cat' data-id='" + f.id + "' placeholder='category' value='" + escapeHtml(f.category || "") + "' /><button class='adm-save' data-id='" + f.id + "'>Save</button>" +
      modelSel + effortSel +
      "<button class='adm-dispatch' data-id='" + f.id + "' title='Hand this feedback to the AI agent: it implements the change on a branch and opens a PR for your review.'>Send to AI agent</button></div>" +
      "<div class='fb-text'>" + escapeHtml(f.text || "") + "</div>" + (f.url ? "<div class='muted small'>" + escapeHtml(f.url) + "</div>" : "") +
      "<textarea class='adm-note' data-id='" + f.id + "' placeholder='Admin note / extra guidance for the agent (saved with this item and sent on dispatch)'>" + escapeHtml(f.admin_note || "") + "</textarea>" +
      (safeImageSrc(f.screenshot) ? "<img class='fb-shot' src='" + escapeHtml(f.screenshot) + "' />" : "") + "</div>";
  }).join("");
  v.querySelectorAll(".adm-save").forEach(function (b) {
    b.addEventListener("click", async function () {
      const id = b.getAttribute("data-id");
      const status = v.querySelector(".adm-status[data-id='" + id + "']").value;
      const category = v.querySelector(".adm-cat[data-id='" + id + "']").value;
      const admin_note = v.querySelector(".adm-note[data-id='" + id + "']").value;
      try { await ATCloud.adminUpdateFeedback(Number(id), { status: status, category: category, admin_note: admin_note }); b.textContent = "Saved"; }
      catch (e) { alert(e.message || e); }
    });
  });
  // Feedback automation: dispatch an item to the AI agent (opens a PR for review).
  v.querySelectorAll(".adm-dispatch").forEach(function (b) {
    b.addEventListener("click", async function () {
      const id = b.getAttribute("data-id");
      b.disabled = true; b.textContent = "Dispatching...";
      const model = v.querySelector(".adm-model[data-id='" + id + "']").value;
      const effort = v.querySelector(".adm-effort[data-id='" + id + "']").value;
      const comment = v.querySelector(".adm-note[data-id='" + id + "']").value;
      try {
        await ATCloud.dispatchFeedback(Number(id), { model: model, effort: effort, comment: comment });
        b.textContent = "Dispatched";
        const selEl = v.querySelector(".adm-status[data-id='" + id + "']");
        if (selEl) selEl.value = "dispatched";
      } catch (e) {
        b.disabled = false; b.textContent = "Send to AI agent";
        alert("Dispatch failed: " + (e && e.message || e));
      }
    });
  });
}

// ---------- GROUP F6: Platform Insights (admin) ----------

function insFieldFillTableHtml(rows) {
  if (!rows || !rows.length) return "<div class='muted small'>No field-fill data yet.</div>";
  const weeks = [], wseen = {}, fields = [], fseen = {}, m = {};
  rows.forEach(function (r) {
    const w = String(r.week).slice(0, 10);
    if (!wseen[w]) { wseen[w] = 1; weeks.push(w); }
    if (!fseen[r.field_name]) { fseen[r.field_name] = 1; fields.push(r.field_name); }
    (m[r.field_name] = m[r.field_name] || {})[w] = (r.fill_rate == null ? null : Number(r.fill_rate));
  });
  weeks.sort().reverse();
  const cols = weeks.slice(0, 4);
  const cls = function (vv) { return vv == null ? "" : (vv >= 0.8 ? "calib-green" : (vv >= 0.5 ? "calib-amber" : "calib-red")); };
  let h = "<table class='an-table'><thead><tr><th>Field</th>" + cols.map(function (w) { return "<th>" + escapeHtml(w.slice(5)) + "</th>"; }).join("") + "</tr></thead><tbody>";
  fields.forEach(function (f) {
    h += "<tr><td>" + escapeHtml(f) + "</td>" + cols.map(function (w) {
      const vv = (m[f] && m[f][w] != null) ? m[f][w] : null;
      return "<td class='" + cls(vv) + "'>" + (vv == null ? "-" : Math.round(vv * 100) + "%") + "</td>";
    }).join("") + "</tr>";
  });
  return h + "</tbody></table>";
}

function insSectorClusterHtml(clus) {
  const rows = (clus && clus.by_sector) || [];
  let h = "<h5>Sector clustering (cross-sector sessions: " + (clus && clus.cross_sector_session_pct != null ? pct(clus.cross_sector_session_pct) : "-") + ")</h5>";
  if (!rows.length) return h + "<div class='muted small'>No session data yet.</div>";
  h += "<div class='adm-scroll'><table class='an-table'><thead><tr><th>Sector</th><th>% sessions</th><th>Avg tickers</th><th>Avg dwell</th></tr></thead><tbody>";
  rows.forEach(function (r) {
    h += "<tr><td>" + escapeHtml(String(r.sector)) + "</td><td>" + (r.pct_of_all_sessions == null ? "-" : pct(r.pct_of_all_sessions)) +
      "</td><td>" + (r.avg_tickers_in_session == null ? "-" : Math.round(r.avg_tickers_in_session * 10) / 10) +
      "</td><td>" + (r.avg_dwell_ms == null ? "-" : Math.round(r.avg_dwell_ms / 60000 * 10) / 10 + "m") + "</td></tr>";
  });
  return h + "</tbody></table></div>";
}

function drawFunnel(canvasId, stages) {
  const cv = document.getElementById(canvasId); if (!cv) return;
  if (!stages.length) { const s = setupCanvas(cv); s.c.fillStyle = TC().muted; s.c.font = "12px sans-serif"; s.c.fillText("No data", 8, 18); return; }
  cv.style.height = (stages.length * 30 + 8) + "px";
  const s = setupCanvas(cv), c = s.c, W = s.W, padL = 130, padR = 10, rowH = 30;
  const max = Math.max.apply(null, stages.map(function (x) { return x.count || 0; })) || 1;
  c.font = "11px sans-serif";
  stages.forEach(function (st, i) {
    const y = 4 + i * rowH, bw = (W - padL - padR) * ((st.count || 0) / max);
    c.fillStyle = TC().muted; c.textAlign = "end"; c.fillText(st.label, padL - 6, y + rowH / 2 + 3);
    c.fillStyle = PALETTE[i % PALETTE.length]; c.fillRect(padL, y + 3, Math.max(1, bw), rowH - 8);
    c.fillStyle = TC().fg; c.textAlign = "start";
    c.fillText((st.count || 0) + (st.pct != null ? "  (" + Math.round(st.pct * 100) + "%)" : ""), padL + bw + 4, y + rowH / 2 + 3);
  });
}

function drawSignedVBars(canvasId, items) {
  const cv = document.getElementById(canvasId); if (!cv) return;
  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H, padL = 36, padR = 8, padT = 10, padB = 22, pw = W - padL - padR, ph = H - padT - padB;
  if (!items.length) { c.fillStyle = TC().muted; c.font = "12px sans-serif"; c.fillText("No data", 8, 18); return; }
  let maxAbs = 0.01; items.forEach(function (x) { if (x.value != null) maxAbs = Math.max(maxAbs, Math.abs(x.value)); });
  const n = items.length, bw = pw / n, Y = function (v) { return padT + ph / 2 - (v / maxAbs) * (ph / 2); };
  c.strokeStyle = TC().grid; c.beginPath(); c.moveTo(padL, Y(0)); c.lineTo(W - padR, Y(0)); c.stroke();
  c.font = "10px sans-serif";
  items.forEach(function (x, i) {
    const v = x.value || 0, xx = padL + i * bw + 2, w = Math.max(1, bw - 4), y0 = Y(0), y1 = Y(v);
    c.fillStyle = v >= 0 ? "#2ecc71" : "#e74c3c"; c.fillRect(xx, Math.min(y0, y1), w, Math.abs(y1 - y0));
    c.fillStyle = TC().muted; c.textAlign = "center"; c.fillText(String(x.label).slice(0, 6), xx + w / 2, H - 6);
  });
  c.fillStyle = TC().muted; c.textAlign = "start";
  c.fillText("+" + Math.round(maxAbs * 100) + "%", 2, padT + 8); c.fillText("-" + Math.round(maxAbs * 100) + "%", 2, padT + ph);
}

function drawHBars(canvasId, items) {
  const cv = document.getElementById(canvasId); if (!cv) return;
  const data = items.filter(function (x) { return x.value != null; }).sort(function (a, b) { return b.value - a.value; });
  if (!data.length) { const s = setupCanvas(cv); s.c.fillStyle = TC().muted; s.c.font = "12px sans-serif"; s.c.fillText("No data", 8, 18); return; }
  cv.style.height = (data.length * 24 + 8) + "px";
  const s = setupCanvas(cv), c = s.c, W = s.W, padL = 110, padR = 40, rowH = 24;
  c.font = "11px sans-serif";
  data.forEach(function (x, i) {
    const y = 4 + i * rowH, bw = (W - padL - padR) * Math.max(0, Math.min(1, x.value));
    c.fillStyle = TC().muted; c.textAlign = "end"; c.fillText(String(x.label).slice(0, 16), padL - 6, y + rowH / 2 + 3);
    c.fillStyle = x.value >= 0.55 ? "#2ecc71" : (x.value >= 0.45 ? "#f1c40f" : "#e74c3c"); c.fillRect(padL, y + 3, Math.max(1, bw), rowH - 8);
    c.fillStyle = TC().fg; c.textAlign = "start"; c.fillText(Math.round(x.value * 100) + "%", padL + bw + 4, y + rowH / 2 + 3);
  });
}

function drawLagBar(canvasId, buckets) {
  const cv = document.getElementById(canvasId); if (!cv) return;
  cv.style.height = "64px";
  const s = setupCanvas(cv), c = s.c, W = s.W, padL = 8, padR = 8, y = 8, hh = 22;
  const total = buckets.reduce(function (a, b) { return a + (Number(b.count) || 0); }, 0);
  if (!total) { c.fillStyle = TC().muted; c.font = "12px sans-serif"; c.fillText("No position-taken events yet.", 8, 30); return; }
  let x = padL; const fullW = W - padL - padR;
  c.font = "10px sans-serif";
  buckets.forEach(function (b, i) {
    const w = fullW * ((Number(b.count) || 0) / total);
    c.fillStyle = PALETTE[i % PALETTE.length]; c.fillRect(x, y, w, hh);
    if (w > 28) { c.fillStyle = "#0c1116"; c.textAlign = "center"; c.fillText(b.bucket, x + w / 2, y + hh / 2 + 3); }
    x += w;
  });
  let lx = padL; c.textAlign = "start";
  buckets.forEach(function (b, i) {
    c.fillStyle = PALETTE[i % PALETTE.length]; c.fillRect(lx, y + hh + 10, 8, 8);
    c.fillStyle = TC().muted; c.fillText(b.bucket, lx + 11, y + hh + 17);
    lx += 22 + c.measureText(b.bucket).width + 14;
  });
}

function drawDonut(canvasId, frac, label) {
  const cv = document.getElementById(canvasId); if (!cv) return;
  cv.style.height = "160px";
  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H, cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 12, ir = r * 0.6;
  if (frac == null) { c.fillStyle = TC().muted; c.font = "12px sans-serif"; c.textAlign = "center"; c.fillText("No data", cx, cy); return; }
  const a0 = -Math.PI / 2, a1 = a0 + frac * 2 * Math.PI;
  c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, r, a0, a1); c.closePath(); c.fillStyle = "#4e9eff"; c.fill();
  c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, r, a1, a0 + 2 * Math.PI); c.closePath(); c.fillStyle = "#2b3145"; c.fill();
  c.beginPath(); c.arc(cx, cy, ir, 0, 2 * Math.PI); c.fillStyle = TC().bg; c.fill();
  c.fillStyle = TC().fg; c.textAlign = "center"; c.font = "16px sans-serif"; c.fillText(Math.round(frac * 100) + "%", cx, cy + 2);
  c.fillStyle = TC().muted; c.font = "10px sans-serif"; c.fillText(label, cx, cy + 16);
}

// ---------- KPI catalogue: dashboard / event / attention metrics ----------
// Each clickable card carries a metric key; clicking opens a time-series
// drilldown (renderMetricModal) backed by admin_metric_series. Card values are
// 30-day totals from admin_metric_totals.
const KPI_GROUPS = [
  { label: "Dashboard metrics", desc: "Usage of the app itself.",
    metrics: ["active_users", "new_users", "feature_navigations", "feedback_open", "feedback_sent", "feedback_ratio"] },
  { label: "Event metrics", desc: "The attention events users log and enrich.",
    metrics: ["events", "labelled", "label_rate", "position_taken", "target_price"] },
  { label: "Attention metrics", desc: "Volume and depth of attention paid to stocks.",
    metrics: ["views", "dwell_min", "avg_dwell_min", "active_tickers"] }
];
// Count metrics are per active user (total / distinct active users), so they
// stay comparable as the user base grows; active_users / new_users are the user
// base itself (absolute), and ratios / avg-per-event are already normalized.
const METRIC_META = {
  active_users: { label: "Active users", fmt: "int", desc: "Distinct users with at least one event in the bucket (absolute)." },
  new_users: { label: "New users", fmt: "int", desc: "Users whose first-ever event fell in the bucket (absolute)." },
  feature_navigations: { label: "Actions / user", fmt: "num", desc: "Section navigations per active user." },
  feedback_open: { label: "Feedback opens / user", fmt: "num", desc: "Feedback button clicks per active user." },
  feedback_sent: { label: "Feedback sends / user", fmt: "num", desc: "Feedback messages submitted per active user." },
  feedback_ratio: { label: "Feedback completion", fmt: "pct", desc: "Feedback sent / feedback button clicked." },
  events: { label: "Events / user", fmt: "num", desc: "Attention events per active user." },
  labelled: { label: "Labelled / user", fmt: "num", desc: "Labelled events per active user." },
  label_rate: { label: "Label rate", fmt: "pct", desc: "Labelled events divided by all events." },
  position_taken: { label: "Positions / user", fmt: "num", desc: "Position-taken events per active user." },
  target_price: { label: "Targets / user", fmt: "num", desc: "Events with a target price, per active user." },
  views: { label: "Views / user", fmt: "num", desc: "Total views per active user." },
  dwell_min: { label: "Active min / user", fmt: "min", desc: "Active minutes on stock pages per active user." },
  avg_dwell_min: { label: "Avg min / event", fmt: "min", desc: "Active minutes divided by events." },
  active_tickers: { label: "Tickers / user", fmt: "num", desc: "Average distinct tickers attended per user." }
};
function fmtMetric(metric, v) {
  if (v == null) return "-";
  const f = (METRIC_META[metric] || {}).fmt;
  if (f === "pct") return pct(Number(v));
  if (f === "min") return (Math.round(Number(v) * 10) / 10) + "m";
  if (f === "num") return String(Math.round(Number(v) * 100) / 100);
  return String(v);
}
function metricCard(metric, totals) {
  const meta = METRIC_META[metric]; if (!meta) return "";
  const v = totals ? totals[metric] : null;
  return "<div class='stat metric-card' data-metric='" + metric + "' title='" + escapeHtml(meta.desc + " Click for the trend.") + "'>" +
    "<b>" + escapeHtml(fmtMetric(metric, v)) + "</b>" + escapeHtml(meta.label) + "</div>";
}
function kpiGroupsHtml(totals) {
  let h = "<h2 class='ins-h2'>Product KPIs</h2><div class='muted small'>Last 30 days, per active user (except user counts and ratios). Click any metric for its time series (customizable horizon).</div>";
  KPI_GROUPS.forEach(function (gp) {
    h += "<div class='kpi-group-label' title='" + escapeHtml(gp.desc) + "'>" + escapeHtml(gp.label) + "</div>" +
      "<div class='usage-cards'>" + gp.metrics.map(function (m) { return metricCard(m, totals); }).join("") + "</div>";
  });
  return h;
}

function openMetricModal(metric) {
  const meta = METRIC_META[metric]; if (!meta) return;
  mmMetric = metric; mmOffset = 0;
  document.getElementById("mm-title").textContent = meta.label;
  document.getElementById("mm-desc").textContent = meta.desc;
  document.getElementById("mm-gran").value = mmGran;
  document.getElementById("metric-modal").classList.remove("mm-hidden");
  renderMetricModal();
}
function closeMetricModal() { mmMetric = null; document.getElementById("metric-modal").classList.add("mm-hidden"); }

async function renderMetricModal() {
  const cv = document.getElementById("mm-canvas"); if (!cv || !mmMetric) return;
  const metric = mmMetric;
  const b = buildAttBuckets(mmGran, mmOffset);
  document.getElementById("mm-range").textContent = b.range;
  document.getElementById("mm-next").disabled = mmOffset <= 0;
  const from = b.buckets[0].t, to = b.buckets[b.buckets.length - 1].next;
  const unit = mmGran === "day" ? "hour" : (mmGran === "year" ? "month" : "day");
  let rows = [];
  try { rows = await ATCloud.adminMetricSeries(metric, from, to, unit); } catch (e) { rows = []; }
  if (mmMetric !== metric) return; // a later open/gran change superseded this fetch
  const vals = new Array(b.buckets.length).fill(0);
  rows.forEach(function (r) {
    const t = Date.parse(r.bucket);
    for (let i = 0; i < b.buckets.length; i++) {
      if (t >= b.buckets[i].t && t < b.buckets[i].next) { vals[i] = Number(r.value) || 0; break; }
    }
  });
  const meta = METRIC_META[metric] || {};
  drawLineCanvas(cv, "mm-tip", [{ label: meta.label || metric, color: PALETTE[0], vals: vals }], b.labels, b.titles);
}

// One-time wiring for the KPI drilldown modal (delegated so it survives re-renders).
(function wireMetricModal() {
  const modal = document.getElementById("metric-modal");
  const av = document.getElementById("admin-view");
  if (!modal || !av) return;
  av.addEventListener("click", function (e) {
    const card = e.target.closest && e.target.closest(".metric-card");
    if (card && card.getAttribute("data-metric")) openMetricModal(card.getAttribute("data-metric"));
  });
  document.getElementById("mm-close").addEventListener("click", closeMetricModal);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeMetricModal(); });
  document.getElementById("mm-gran").addEventListener("change", function () { mmGran = this.value; mmOffset = 0; renderMetricModal(); });
  document.getElementById("mm-prev").addEventListener("click", function () { mmOffset++; renderMetricModal(); });
  document.getElementById("mm-next").addEventListener("click", function () { if (mmOffset > 0) { mmOffset--; renderMetricModal(); } });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.classList.contains("mm-hidden")) closeMetricModal(); });
  attachCanvasHover(document.getElementById("mm-canvas")); // registry-driven; attach once
})();

// Area-usage tracking: credit an area when it is prominently visible for a beat
// (dwell) and when it is clicked, routed through the same feature_usage pipeline
// as section navigation but under area:/click: prefixes. Per-area throttled so
// the 500-entry sync ring buffer is not flooded; area popularity reads from the
// unbounded per-section counts server-side (admin_area_usage).
(function trackAreas() {
  if (typeof IntersectionObserver === "undefined") return;
  const CREDIT_MS = 2000, DWELL_THROTTLE = 15000, CLICK_THROTTLE = 2000;
  const pending = {}, lastDwell = {}, lastClick = {};
  function credit(section, map, throttle) {
    const now = Date.now();
    if (now - (map[section] || 0) < throttle) return;
    map[section] = now;
    try { ATStore.trackFeatureUse(section); } catch (e) { /* usage tracking */ }
  }
  const io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      const area = e.target.getAttribute("data-area"); if (!area) return;
      if (e.isIntersecting && e.intersectionRatio >= 0.6) {
        if (pending[area]) return;
        pending[area] = setTimeout(function () {
          pending[area] = null;
          if (document.visibilityState === "visible") credit("area:" + area, lastDwell, DWELL_THROTTLE);
        }, CREDIT_MS);
      } else if (pending[area]) { clearTimeout(pending[area]); pending[area] = null; }
    });
  }, { threshold: [0, 0.6] });
  document.querySelectorAll("[data-area]").forEach(function (el) { io.observe(el); });
  document.addEventListener("click", function (ev) {
    const el = ev.target.closest && ev.target.closest("[data-area]"); if (!el) return;
    credit("click:" + el.getAttribute("data-area"), lastClick, CLICK_THROTTLE);
  }, true);
})();

async function renderAdminInsights(v) {
  v.innerHTML = "<p class='muted small'>Loading...</p>";
  const z = function (p, d) { return p.then(function (x) { return x; }).catch(function () { return d; }); };
  const g = await Promise.all([
    z(ATCloud.adminEngagementOverview(), {}), z(ATCloud.adminSentimentFunnel(), {}),
    z(ATCloud.adminPaperPortfolio(), {}), z(ATCloud.adminReturnBySegment(), []), z(ATCloud.adminTargetPriceAccuracy(), {}),
    z(ATCloud.adminFieldFillRates(), []), z(ATCloud.adminSyncHealth(), {}),
    z(ATCloud.adminSessionStats(), {}), z(ATCloud.adminSectorClustering(), {}),
    z(ATCloud.adminAttentionToActionLag(), {}), z(ATCloud.adminRecurringVsDiscovery(), {}), z(ATCloud.adminWeekendUsage(), {}),
    z(ATCloud.adminPlatformMetrics(), {}), z(ATCloud.adminFeatureUsage(), {}),
    z(ATCloud.adminMarketingKpis(), {}), z(ATCloud.adminCohortRetention(), []),
    z(ATCloud.adminMetricTotals(), {}), z(ATCloud.adminAreaUsage(), []),
    z(ATCloud.adminResearchEffectiveness(), [])
  ]);
  const eng = g[0] || {}, fun = g[1] || {}, paper = g[2] || {}, seg = g[3] || [], tgt = g[4] || {}, fill = g[5] || [],
    sync = g[6] || {}, sess = g[7] || {}, clus = g[8] || {}, lag = g[9] || {}, recur = g[10] || {}, wknd = g[11] || {},
    pmetrics = g[12] || {}, fusage = g[13] || {}, mkt = g[14] || {}, cohort = g[15] || [], totals = g[16] || {},
    areaUse = g[17] || [], reff = g[18] || [];

  // Funnel stages: each pct is of the previous stage.
  const order = [["Total events", "total_events"], ["Dwell >30s", "events_with_dwell_30s"], ["Labelled", "events_with_sentiment"],
    ["Position taken", "events_with_position_taken"], ["Target price", "events_with_target_price"]];
  const fstages = []; let prev = null;
  order.forEach(function (o) { const cnt = Number(fun[o[1]] || 0); fstages.push({ label: o[0], count: cnt, pct: prev != null ? (prev > 0 ? cnt / prev : 0) : null }); prev = cnt; });

  const dmCls = function (r) { return r == null ? "" : (r >= 0.2 ? "calib-green" : (r >= 0.1 ? "calib-amber" : "calib-red")); };
  const rateCls = function (r) { return r == null ? "" : (r < 0.02 ? "calib-green" : (r <= 0.10 ? "calib-amber" : "calib-red")); };
  const m1 = function (x) { return x == null ? "-" : (Math.round(x * 10) / 10); };

  // Product KPIs grouped as dashboard / event / attention metrics; each card
  // opens a time-series drilldown on click.
  let h = kpiGroupsHtml(totals);
  // Platform health (E3) + How people use (moved here from Aggregate).
  h += platformHealthHtml(pmetrics, fusage);
  h += "<h3 title='Share of section navigations over time across users. Each bucket sums to 100%.'>How people use Stocktrails</h3>" +
    "<div class='att-toolbar'><select id='fuot-gran' class='span-sel'>" +
    ["day", "week", "month", "year"].map(function (gg) { return "<option value='" + gg + "'" + (gg === fuGran ? " selected" : "") + ">" + gg.charAt(0).toUpperCase() + gg.slice(1) + "</option>"; }).join("") +
    "</select><button id='fuot-prev' class='navbtn' title='Earlier'>&#9664;</button><span id='fuot-range' class='muted small'></span>" +
    "<button id='fuot-next' class='navbtn' title='Later'>&#9654;</button></div>" +
    "<canvas id='fuot-canvas' class='an-canvas'></canvas><div id='fuot-tip' class='muted small'></div><div id='fuot-legend' class='an-legend'></div>";

  // Most-used dashboard areas (IntersectionObserver dwell credits + clicks), per user.
  h += "<h3 title='Which dashboard areas users dwell on and click, last 30 days, normalized per user.'>Most-used areas (per user, 30d)</h3>";
  if (!areaUse.length) {
    h += "<div class='muted small'>No area-usage data synced yet. Areas are credited as users view and click them (instrumented build required).</div>";
  } else {
    h += "<div class='adm-scroll'><table class='an-table'><thead><tr><th>Area</th>" +
      "<th title='Average sustained-view credits per user who viewed the area (one credit ~ a 2s+ prominent view, throttled).'>Dwell / user</th>" +
      "<th title='Average clicks per user who clicked in the area.'>Clicks / user</th>" +
      "<th title='Distinct users who used this area.'>Users</th></tr></thead><tbody>";
    areaUse.forEach(function (r) {
      h += "<tr><td>" + escapeHtml(usageLabel(r.area)) + "</td><td>" + (r.dwell_per_user == null ? "-" : r.dwell_per_user) +
        "</td><td>" + (r.clicks_per_user == null ? "-" : r.clicks_per_user) + "</td><td>" + (r.users == null ? "-" : r.users) + "</td></tr>";
    });
    h += "</tbody></table></div>";
  }

  h += "<h2 class='ins-h2'>Engagement Overview</h2><div class='usage-cards'>" +
    admCard(eng.dau == null ? "-" : eng.dau, "DAU", "Distinct users with an event in the last day.") +
    admCard(eng.wau == null ? "-" : eng.wau, "WAU", "Distinct users in the last 7 days.") +
    admCard(eng.mau == null ? "-" : eng.mau, "MAU", "Distinct users in the last 30 days.") +
    "<div class='stat' title='DAU / MAU stickiness.'><b class='" + dmCls(eng.dau_mau_ratio) + "'>" + (eng.dau_mau_ratio == null ? "-" : pct(eng.dau_mau_ratio)) + "</b>DAU/MAU</div>" +
    admCard(eng.new_users_this_week == null ? "-" : eng.new_users_this_week, "New users (wk)", "First-ever event within the last 7 days.") +
    admCard(eng.churned_users_this_week == null ? "-" : eng.churned_users_this_week, "Churned (wk)", "Active 8-14 days ago but not in the last 7.") +
    "</div>";
  h += "<h5>Sentiment adoption funnel</h5><canvas id='ins-funnel' class='an-canvas'></canvas>";

  // Digital-marketing KPIs: retention, churn, growth accounting, engagement depth.
  const nm = function (x) { return x == null ? null : Number(x); };
  const pctOr = function (x) { return x == null ? "-" : pct(Number(x)); };
  const churnCls = function (r) { return r == null ? "" : (r <= 0.05 ? "calib-green" : (r <= 0.15 ? "calib-amber" : "calib-red")); };
  const qrCls = function (r) { return r == null ? "" : (r >= 1 ? "calib-green" : "calib-red"); };
  h += "<h2 class='ins-h2'>Growth &amp; Marketing</h2><h5>Retention &amp; churn</h5><div class='usage-cards'>" +
    admCard(pctOr(mkt.d1_retention), "D1 retention", "Users active on the day after their first event (" + (mkt.d1_eligible == null ? "-" : mkt.d1_eligible) + " eligible).") +
    admCard(pctOr(mkt.w1_retention), "W1 retention", "Users active in days 7-13 after their first event (" + (mkt.w1_eligible == null ? "-" : mkt.w1_eligible) + " eligible).") +
    admCard(pctOr(mkt.m1_retention), "M1 retention", "Users active in days 30-59 after their first event (" + (mkt.m1_eligible == null ? "-" : mkt.m1_eligible) + " eligible).") +
    "<div class='stat' title='Share of users active 8-14 days ago with no event in the last 7 days.'><b class='" + churnCls(nm(mkt.churn_rate_week)) + "'>" + pctOr(mkt.churn_rate_week) + "</b>Churn rate (wk)</div>" +
    "<div class='stat' title='(New + resurrected) / churned users this week. Above 1 = the user base is growing.'><b class='" + qrCls(nm(mkt.quick_ratio)) + "'>" + (mkt.quick_ratio == null ? "-" : mkt.quick_ratio) + "</b>Quick ratio</div>" +
    admCard(mkt.resurrected_week == null ? "-" : mkt.resurrected_week, "Resurrected (wk)", "Users active in the last 7 days after 3+ weeks of inactivity.") +
    "</div>";
  h += "<h5>Growth &amp; engagement depth</h5><div class='usage-cards'>" +
    "<div class='stat' title='Active users last 7 days vs the 7 days before.'><b class='" + signClass(nm(mkt.wau_wow_growth)) + "'>" + pctOr(mkt.wau_wow_growth) + "</b>WAU WoW</div>" +
    "<div class='stat' title='Active users last 30 days vs the 30 days before.'><b class='" + signClass(nm(mkt.mau_mom_growth)) + "'>" + pctOr(mkt.mau_mom_growth) + "</b>MAU MoM</div>" +
    admCard(pctOr(mkt.wau_mau_ratio), "WAU/MAU", "Weekly stickiness: how much of the monthly base returns every week.") +
    admCard(mkt.events_per_wau == null ? "-" : mkt.events_per_wau, "Events / WAU", "Events in the last 7 days per weekly active user.") +
    admCard(mkt.dwell_min_per_wau == null ? "-" : mkt.dwell_min_per_wau + "m", "Dwell / WAU", "Active minutes in the last 7 days per weekly active user.") +
    admCard(mkt.active_days_per_mau == null ? "-" : mkt.active_days_per_mau, "Active days / MAU", "Average active days in the last 30 days per monthly active user.") +
    admCard(pctOr(mkt.power_user_pct), "Power users", "Share of monthly active users with 10+ active days in the last 30.") +
    admCard(mkt.avg_lifetime_days == null ? "-" : mkt.avg_lifetime_days + "d", "Avg lifetime", "Average days between first and latest event, per user.") +
    "</div>";
  const wkRows = Array.isArray(mkt.weekly) ? mkt.weekly : [];
  if (wkRows.length) {
    h += "<h5>Weekly acquisition &amp; activity (last 12 weeks)</h5><div class='adm-scroll'><table class='an-table'><thead><tr>" +
      "<th>Week</th><th title='Users whose first-ever event fell in this week.'>New users</th>" +
      "<th title='Distinct users with an event in this week.'>Active users</th><th>Events</th>" +
      "<th title='Active users vs the previous week.'>Active WoW</th></tr></thead><tbody>";
    for (let i = wkRows.length - 1; i >= 0; i--) {
      const w = wkRows[i], pw = i > 0 ? wkRows[i - 1] : null;
      // Only compare truly adjacent weeks: zero-activity weeks are absent from the array.
      const adjacent = pw && Date.parse(String(w.week)) - Date.parse(String(pw.week)) === 7 * 86400000;
      const wow = adjacent && Number(pw.active_users) > 0 ? Number(w.active_users) / Number(pw.active_users) - 1 : null;
      h += "<tr><td>" + escapeHtml(String(w.week)) + "</td><td>" + w.new_users + "</td><td>" + w.active_users + "</td><td>" + w.events +
        "</td><td class='" + (wow == null ? "" : (wow >= 0 ? "calib-green" : "calib-red")) + "'>" + (wow == null ? "-" : pct(wow)) + "</td></tr>";
    }
    h += "</tbody></table></div>";
  }
  h += "<h5>Weekly cohort retention</h5><div class='cohort-wrap'><canvas id='adm-cohort'></canvas></div><div id='adm-cohort-tip' class='muted small'></div>";

  h += "<h2 class='ins-h2'>Portfolio Signal Quality</h2><div class='usage-cards'>" +
    "<div class='stat' title='Average 30-day return proxy across paper positions.'><b class='" + signClass(paper.avg_30d_return_proxy) + "'>" + (paper.avg_30d_return_proxy == null ? "-" : pct(paper.avg_30d_return_proxy)) + "</b>Avg 30d return</div>" +
    admCard(paper.pct_positions_profitable == null ? "-" : pct(paper.pct_positions_profitable), "% profitable", "Share of paper positions with a positive 30d return proxy.") +
    admCard(paper.best_ticker || "-", "Best ticker", "Highest 30d return proxy.") +
    admCard(paper.worst_ticker || "-", "Worst ticker", "Lowest 30d return proxy.") +
    admCard(paper.total_positions == null ? "-" : paper.total_positions, "Positions", "Distinct (user, ticker) first-attention paper buys.") +
    "</div>";
  h += "<div class='adm-two'><div><h5>Avg 30d return by market cap</h5><canvas id='ins-cap' class='an-canvas'></canvas></div>" +
    "<div><h5>Hit rate by sector</h5><canvas id='ins-sector-hr' class='an-canvas'></canvas></div></div>";
  h += "<h5>Target price accuracy</h5><div class='usage-cards'>" +
    admCard(tgt.total_with_target == null ? "-" : tgt.total_with_target, "Targets set", "Events with a target price.") +
    admCard(tgt.pct_target_hit_90d == null ? "-" : pct(tgt.pct_target_hit_90d), "Hit within 90d", "Share whose target was crossed within 90 days.") +
    admCard(tgt.avg_distance_pct == null ? "-" : pct(tgt.avg_distance_pct), "Avg distance", "Average |target - price| / price at label time.") +
    admCard(tgt.median_days_to_hit == null ? "-" : m1(tgt.median_days_to_hit) + "d", "Median days to hit", "For targets that were hit.") +
    "</div>";

  // Research paths -> returns: which (portal, research type) combinations
  // precede the best 30d forward returns. Proxy-based (event prices), like the
  // other return panels.
  h += "<h5 title='Events grouped by portal and page type at capture. Return = 30d forward proxy from later same-ticker event prices; Hit rate = share of Positive/Negative labels whose direction matched the move.'>Research paths &rarr; returns</h5>";
  const reffRows = (reff || []).filter(function (r) { return Number(r.event_count) > 0; });
  if (!reffRows.length) {
    h += "<div class='muted small'>No research-type data yet. New events are classified at capture (instrumented build required); returns need a later same-ticker price 30d+ out.</div>";
  } else {
    h += "<div class='adm-scroll'><table class='an-table'><thead><tr><th>Portal</th><th>Research type</th>" +
      "<th title='Distinct users with events on this path.'>Users</th>" +
      "<th title='Events per user on this path.'>Events / user</th>" +
      "<th title='Active minutes per user on this path.'>Dwell / user</th>" +
      "<th title='Share of events labelled on this path.'>Label rate</th>" +
      "<th title='Share of Positive/Negative labels whose direction matched the 30d move.'>Hit rate</th>" +
      "<th title='Average 30d forward return proxy of events on this path.'>Avg 30d ret</th></tr></thead><tbody>";
    reffRows.slice(0, 25).forEach(function (r) {
      const hr = r.hit_rate == null ? null : Number(r.hit_rate);
      const ar = r.avg_30d_return == null ? null : Number(r.avg_30d_return);
      h += "<tr><td>" + escapeHtml(String(r.source)) + "</td><td>" + escapeHtml(String(r.research_type)) + "</td>" +
        "<td>" + r.users + "</td><td>" + (r.events_per_user == null ? "-" : r.events_per_user) + "</td>" +
        "<td>" + (r.dwell_min_per_user == null ? "-" : r.dwell_min_per_user + "m") + "</td>" +
        "<td>" + (r.label_rate == null ? "-" : pct(Number(r.label_rate))) + "</td>" +
        "<td class='" + (hr == null ? "" : (hr >= 0.55 ? "calib-green" : (hr >= 0.45 ? "calib-amber" : "calib-red"))) + "'>" + (hr == null ? "-" : pct(hr)) + "</td>" +
        "<td class='" + signClass(ar) + "'>" + (ar == null ? "-" : pct(ar)) + "</td></tr>";
    });
    h += "</tbody></table></div>";
    if (reffRows.length > 25) h += "<div class='muted small'>Showing top 25 of " + reffRows.length + " paths (sorted by avg 30d return).</div>";
  }

  h += "<h2 class='ins-h2'>Data Health</h2><h5>Field fill rate (last 4 weeks)</h5>" + insFieldFillTableHtml(fill);
  h += "<h5>Sync health</h5><div class='usage-cards'>" +
    admCard(m1(sync.sync_latency_p50_minutes) + "m", "Latency P50", "Median event-to-cloud latency.") +
    admCard(m1(sync.sync_latency_p95_minutes) + "m", "Latency P95", "95th percentile latency.") +
    "<div class='stat' title='Failed/empty Yahoo price fetches.'><b class='" + rateCls(sync.price_fetch_failure_rate) + "'>" + (sync.price_fetch_failure_rate == null ? "-" : pct(sync.price_fetch_failure_rate)) + "</b>Price fetch fail</div>" +
    "<div class='stat' title='Intraday rows sharing user+ticker+minute.'><b class='" + rateCls(sync.duplicate_event_rate_intraday) + "'>" + (sync.duplicate_event_rate_intraday == null ? "-" : pct(sync.duplicate_event_rate_intraday)) + "</b>Duplicate rate</div>" +
    "<div class='stat' title='Users whose sync appears stalled (>24h behind).'><b class='" + rateCls(sync.orphan_proxy ? 1 : 0) + "'>" + (sync.orphan_proxy == null ? "-" : sync.orphan_proxy) + "</b>Orphan users</div>" +
    "</div>";

  h += "<h2 class='ins-h2'>Behavioural Patterns</h2><div class='usage-cards'>" +
    admCard(m1(sess.avg_tickers_per_session), "Tickers / session", "Average distinct tickers per session.") +
    admCard(sess.avg_session_dwell_ms == null ? "-" : m1(sess.avg_session_dwell_ms / 60000) + "m", "Dwell / session", "Average active minutes per session.") +
    admCard(m1(sess.avg_portals_per_session), "Portals / session", "Average distinct portals per session.") +
    admCard(m1(sess.avg_sessions_per_active_user_per_week), "Sessions / user / wk", "Sessions per active user per week (last 30d).") +
    "</div>";
  h += insSectorClusterHtml(clus);
  h += "<h5>Attention-to-action lag (same-day decisions: " + (lag.pct_same_day_decisions == null ? "-" : pct(lag.pct_same_day_decisions)) + ")</h5><canvas id='ins-lag' class='an-canvas'></canvas>";
  h += "<div class='adm-two'><div><h5>Recurring vs discovery (avg recurring rate)</h5><canvas id='ins-donut' class='an-canvas'></canvas></div>" +
    "<div><h5>Weekend vs weekday</h5><div class='usage-cards'>" +
    "<div class='stat' title='30d hit-rate proxy for weekend events.'><b>" + (wknd.weekend_hit_rate_30d == null ? "-" : pct(wknd.weekend_hit_rate_30d)) + "</b>Weekend hit rate</div>" +
    "<div class='stat' title='30d hit-rate proxy for weekday events.'><b>" + (wknd.weekday_hit_rate_30d == null ? "-" : pct(wknd.weekday_hit_rate_30d)) + "</b>Weekday hit rate</div>" +
    admCard(wknd.pct_events_on_weekend == null ? "-" : pct(wknd.pct_events_on_weekend), "% on weekend", "Share of events on Sat/Sun (UTC).") +
    "</div></div></div>";

  v.innerHTML = h;
  try { drawFunnel("ins-funnel", fstages); } catch (e) { /* ignore */ }
  try { drawCohortHeatmap("adm-cohort", cohort); } catch (e) { /* ignore */ }
  try { drawSignedVBars("ins-cap", seg.filter(function (s) { return s.segment_type === "cap_bucket"; }).map(function (s) { return { label: s.segment_value, value: s.avg_30d_return }; })); } catch (e) { /* ignore */ }
  try { drawHBars("ins-sector-hr", seg.filter(function (s) { return s.segment_type === "sector"; }).map(function (s) { return { label: s.segment_value, value: s.hit_rate }; })); } catch (e) { /* ignore */ }
  try { drawLagBar("ins-lag", (lag.lag_distribution) || []); } catch (e) { /* ignore */ }
  try { drawDonut("ins-donut", recur.avg_recurring_rate == null ? null : Number(recur.avg_recurring_rate), "recurring"); } catch (e) { /* ignore */ }

  // How people use: controls + initial render.
  const fg = document.getElementById("fuot-gran");
  if (fg) fg.addEventListener("change", function () { fuGran = this.value; fuOffset = 0; renderFeatureUsageOverTime(); });
  const fp = document.getElementById("fuot-prev");
  if (fp) fp.addEventListener("click", function () { fuOffset++; renderFeatureUsageOverTime(); });
  const fn = document.getElementById("fuot-next");
  if (fn) fn.addEventListener("click", function () { if (fuOffset > 0) { fuOffset--; renderFeatureUsageOverTime(); } });
  try { await renderFeatureUsageOverTime(); attachCanvasHover(document.getElementById("fuot-canvas")); } catch (e) { /* ignore */ }
}

async function renderAdmin() {
  const v = document.getElementById("admin-view");
  const st = document.getElementById("admin-status");
  if (adminTab === "system") { v.innerHTML = systemHtml(); return; }
  if (adminTab === "collected") { v.innerHTML = collectedHtml(); return; }
  st.textContent = "Loading...";
  try {
    if (adminTab === "users") await renderAdminUsers(v);
    else if (adminTab === "aggregate") await renderAdminAggregate(v);
    else if (adminTab === "insights") await renderAdminInsights(v);
    else if (adminTab === "feedback") await renderAdminFeedback(v);
    st.textContent = "";
  } catch (e) { v.innerHTML = "<p class='muted small'>Error: " + escapeHtml(e && e.message || String(e)) + "</p>"; st.textContent = ""; }
}

document.querySelectorAll("#admin-seg button").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("#admin-seg button").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on"); adminTab = b.getAttribute("data-a"); renderAdmin();
  });
});

// GROUP D2: lead-lag CSV export.
(function () {
  const eb = document.getElementById("adm-export-leadlag");
  if (eb) eb.addEventListener("click", exportLeadLagCsv);
})();

// Quick-fix #1: accumulate active time on the dashboard (visible only) into a
// device-local counter; cloud.js writes it to user_meta.dashboard_ms on sync.
(function () {
  if (/[?&]headless=agent\b/.test(location.search)) return; // the headless AI agent run is not time on the dashboard
  const DKEY = "at_dashboard_ms_v1";
  let activeSince = (document.visibilityState === "visible") ? Date.now() : 0;
  async function flush() {
    if (!activeSince) return;
    const now = Date.now(), add = now - activeSince;
    activeSince = (document.visibilityState === "visible") ? now : 0;
    if (add <= 0 || add > 30 * 60000) return; // ignore sleep/suspend chunks
    try {
      const r = await chrome.storage.local.get(DKEY);
      const cur = (r && r[DKEY]) || 0;
      await chrome.storage.local.set({ [DKEY]: cur + add });
    } catch (e) { /* ignore */ }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { if (!activeSince) activeSince = Date.now(); }
    else flush();
  });
  window.addEventListener("pagehide", flush);
  setInterval(flush, 30000);
})();

// GROUP E4: local "how you use the app" chart in the Account section.
async function renderAccountUsageChart() {
  const cv = document.getElementById("acct-usage-canvas");
  if (!cv) return;
  let counts = {};
  try { counts = (await ATStore.getFeatureUsage()).counts || {}; } catch (e) { counts = {}; }
  const rows = mergeUsageCounts(counts);
  if (!rows.length) { document.getElementById("acct-usage-tip").textContent = "No section usage recorded yet."; cv.width = 10; cv.height = 10; cv.getContext("2d").clearRect(0, 0, 10, 10); return; }
  try {
    // Labels are drawn rotated (last arg); still cap the length so the longest
    // names do not eat the whole plot - the hover title carries the full name.
    drawBarCanvas(cv, "acct-usage-tip", rows.map(function (r) { return r.count; }),
      rows.map(function (r) { return r.label.length > 18 ? r.label.slice(0, 17).trim() + "..." : r.label; }),
      rows.map(function (r) { return r.label + ": " + r.count + " visit(s)"; }), true);
    attachCanvasHover(cv);
  } catch (e) { /* ignore */ }
}

async function maybeShowAdminTab() {
  let admin = false;
  try { admin = !!(self.ATCloud && ATCloud.enabled() && await ATCloud.isAdmin()); } catch (e) { admin = false; }
  IS_ADMIN = admin; // also gates the World tab content (map vs Coming soon)
  document.getElementById("tab-admin").hidden = !admin;
  return admin;
}

// ---------- World: community aggregates on a country map ----------
// The tab is visible to everyone; while the feature bakes, only admins see the
// map (world_* RPCs are admin-gated server-side too) - others get Coming soon.
// A replayable time axis animates per-country aggregates over the last
// WORLD_DAYS UTC days, trimmed to start at the first day that actually has data;
// when the replay reaches today it hands off to the live feed (today's
// still-accumulating data, refreshed every 60s while visible). Play resumes from
// the current day, restart (⏮) always begins at the first day on the axis.
let IS_ADMIN = false;
const WORLD_DAYS = 60;
const WORLD = {
  built: false, mode: "attention", names: null, bench: null,
  days: [], byDay: {}, topByDay: {}, max: {}, frame: 0, loaded: false, loading: false,
  playing: false, playTimer: 0, liveTimer: 0,
  // Layout floor for the per-country table while the day axis is in motion.
  scrubbing: false, tableMinH: 0
};

const VPN_CC = "XV"; // user-assigned ISO code for the VPN category (see buildWorldMap)
function worldCountryName(cc) {
  if (cc === VPN_CC) return "VPN (location hidden)";
  try {
    if (!WORLD.names) WORLD.names = new Intl.DisplayNames(["en"], { type: "region" });
    return WORLD.names.of(cc) || cc;
  } catch (e) { return cc; }
}

function worldVisible() {
  const mv = document.getElementById("main-world");
  return !!(mv && !mv.hidden && document.visibilityState === "visible");
}

function buildWorldMap() {
  if (WORLD.built) return;
  const host = document.getElementById("world-map");
  if (!host || !self.AT_WORLD_MAP) return;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", self.AT_WORLD_MAP.viewBox);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  Object.keys(self.AT_WORLD_MAP.countries).forEach(function (cc) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", self.AT_WORLD_MAP.countries[cc]);
    p.setAttribute("class", "wm-c");
    p.setAttribute("data-cc", cc);
    svg.appendChild(p);
  });
  // VPN: users whose IP pointed to another country than their device clock, or
  // to a VPN / datacenter network, are recorded as "XV" (cloud.js
  // resolveCountry) and drawn as one bubble in the empty south-west corner. It
  // carries the wm-c class, so the fill loop and the tooltip treat it exactly
  // like a country.
  const vb = String(self.AT_WORLD_MAP.viewBox).split(/\s+/).map(Number);
  const vr = 20, vx = vb[0] + vr + 22, vy = vb[1] + vb[3] - vr - 22;
  const vpn = document.createElementNS(NS, "circle");
  vpn.setAttribute("cx", vx); vpn.setAttribute("cy", vy); vpn.setAttribute("r", vr);
  vpn.setAttribute("class", "wm-c wm-vpn");
  vpn.setAttribute("data-cc", VPN_CC);
  svg.appendChild(vpn);
  const vt = document.createElementNS(NS, "text");
  vt.setAttribute("x", vx); vt.setAttribute("y", vy + 3);
  vt.setAttribute("class", "wm-pop wm-vpn-lbl");
  vt.textContent = "VPN";
  svg.appendChild(vt);
  const pops = document.createElementNS(NS, "g");
  pops.setAttribute("id", "world-pops");
  svg.appendChild(pops);
  host.appendChild(svg);
  svg.addEventListener("mousemove", function (ev) {
    const t = ev.target && ev.target.classList && ev.target.classList.contains("wm-c") ? ev.target : null;
    if (!t) { hideTip(); return; }
    showTip(worldTipHtml(t.getAttribute("data-cc")), ev.clientX, ev.clientY);
  });
  svg.addEventListener("mouseleave", hideTip);
  WORLD.built = true;
}

function worldTipHtml(cc) {
  const name = "<b>" + escapeHtml(worldCountryName(cc)) + "</b><br>";
  const spark = worldSparkline(cc); // last-30-day mini chart of this country
  if (WORLD.mode === "corr") {
    const cr = (WORLD.corrByCC || {})[cc];
    return name + (cr == null ? "not enough overlapping days" : "r = " + cr.toFixed(2) + " (views vs prev-day NASDAQ)") + spark;
  }
  if (WORLD.mode === "vscrowd") {
    const sv = (WORLD.simByCC || {})[cc], me = (WORLD.simMeta || {})[cc];
    return name + (sv == null ? "no research recorded in the window" :
      Math.round(sv * 100) + "% similar to the global research mix" +
      (me ? " &middot; " + me.users + " user(s) &middot; " + me.views + " views" : "")) + spark;
  }
  const d = WORLD.days[WORLD.frame];
  const r = (WORLD.byDay[d] || {})[cc];
  if (!r) return name + "No activity on this day" + spark;
  if (WORLD.mode === "attention" || WORLD.mode === "topstock") {
    const top = (WORLD.topByDay[d] || {})[cc];
    return name + r.views + " view(s) &middot; " + Math.round(r.dwell_ms / 60000) + " active min &middot; " + r.users + " user(s)"
      + (top ? " &middot; top: <b>" + escapeHtml(top.ticker) + "</b>" : "") + spark;
  }
  if (WORLD.mode === "time")
    return name + (r.users ? ((r.dwell_ms / 60000) / r.users).toFixed(1) : "-") + " min/user &middot; " + r.users + " user(s)" + spark;
  if (WORLD.mode === "hit")
    return name + (r.labelled ? Math.round(100 * r.hits / r.labelled) + "% hit rate (" + r.hits + "/" + r.labelled + " labels)" : "no labels this day") + spark;
  return name + (r.ret_n ? pct(r.ret_sum / r.ret_n) + " avg return / view (" + r.ret_n + " priced views)" : "no priced views this day") + spark;
}

// Per-day metric value for one country record, in the current mode. For 'corr'
// the value is a whole-window scalar keyed by country (cc), not a per-day one.
function worldValue(r, cc) {
  if (WORLD.mode === "corr") { const v = (WORLD.corrByCC || {})[cc]; return v == null ? null : v; }
  if (WORLD.mode === "vscrowd") { const v = (WORLD.simByCC || {})[cc]; return v == null ? null : v; }
  if (!r) return null;
  if (WORLD.mode === "time") return r.users ? (r.dwell_ms / 60000) / r.users : null;
  if (WORLD.mode === "hit") return r.labelled ? r.hits / r.labelled : null;
  if (WORLD.mode === "ret") return r.ret_n ? r.ret_sum / r.ret_n : null;
  return r.views || null;
}

// The per-day value used by the tooltip sparkline (mode-specific; corr and
// topstock fall back to daily views since they have no per-day scalar).
function worldDayMetric(r) {
  if (!r) return 0;
  if (WORLD.mode === "time") return r.users ? (r.dwell_ms / 60000) / r.users : 0;
  if (WORLD.mode === "hit") return r.labelled ? r.hits / r.labelled : 0;
  if (WORLD.mode === "ret") return r.ret_n ? r.ret_sum / r.ret_n : 0;
  return r.views || 0;
}

// Format a per-day metric value for the current mode (sparkline labels + tip).
function worldMetricFmt(v) {
  if (WORLD.mode === "time") return v.toFixed(1);
  if (WORLD.mode === "hit") return Math.round(v * 100) + "%";
  if (WORLD.mode === "ret") return (v * 100).toFixed(1) + "%";
  return String(Math.round(v));
}
function worldMetricUnit() {
  return WORLD.mode === "time" ? "min/user" : WORLD.mode === "hit" ? "hit rate"
    : WORLD.mode === "ret" ? "ret/view" : "views/day";
}

// Inline SVG sparkline of a country's last-30-day values for the current mode,
// with min/max y-axis labels, the latest point marked, and a precise caption.
function worldSparkline(cc) {
  const days = WORLD.days.slice(-30);
  const vals = days.map(function (d) { return worldDayMetric((WORLD.byDay[d] || {})[cc]); });
  if (!vals.some(function (v) { return v; })) return "";
  const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), span = (hi - lo) || 1;
  const W = 208, H = 48, padL = 40, padR = 4, padT = 6, padB = 12, pw = W - padL - padR, ph = H - padT - padB, n = vals.length;
  const X = function (i) { return n <= 1 ? padL + pw / 2 : padL + (i / (n - 1)) * pw; };
  const Y = function (v) { return padT + (1 - (v - lo) / span) * ph; };
  const pts = vals.map(function (v, i) { return X(i).toFixed(1) + "," + Y(v).toFixed(1); }).join(" ");
  const col = WORLD.mode === "time" ? "#2ecc71" : (WORLD.mode === "hit" ? "#f1c40f" : (WORLD.mode === "ret" ? "#e67e22" : "#4e9eff"));
  const last = vals[n - 1], yHi = Y(hi).toFixed(1), yLo = Y(lo).toFixed(1);
  return "<div class='wm-spark'><svg viewBox='0 0 " + W + " " + H + "'>" +
    "<line x1='" + padL + "' y1='" + yHi + "' x2='" + (W - padR) + "' y2='" + yHi + "' stroke='#2c3145' stroke-width='0.5'/>" +
    "<line x1='" + padL + "' y1='" + yLo + "' x2='" + (W - padR) + "' y2='" + yLo + "' stroke='#2c3145' stroke-width='0.5'/>" +
    "<text x='" + (padL - 3) + "' y='" + (Y(hi) + 3).toFixed(1) + "' text-anchor='end' class='wm-spk-lbl'>" + worldMetricFmt(hi) + "</text>" +
    "<text x='" + (padL - 3) + "' y='" + (Y(lo) + 3).toFixed(1) + "' text-anchor='end' class='wm-spk-lbl'>" + worldMetricFmt(lo) + "</text>" +
    "<polyline points='" + pts + "' fill='none' stroke='" + col + "' stroke-width='1.5'/>" +
    "<circle cx='" + X(n - 1).toFixed(1) + "' cy='" + Y(last).toFixed(1) + "' r='2.2' fill='" + col + "'/>" +
    "</svg><span class='muted'>" + worldMetricUnit() + " &middot; last " + n + " days &middot; latest " + worldMetricFmt(last) + "</span></div>";
}

// Per-country correlation of daily community views with the PREVIOUS trading
// day's NASDAQ return, over the loaded window (the 'vs NASDAQ' map mode).
function computeWorldCorrByCC() {
  WORLD.corrByCC = {};
  const bench = WORLD.bench || [];
  if (bench.length < 5) return;
  const ret = {};
  for (let i = 1; i < bench.length; i++) ret[bench[i].date] = bench[i].close / bench[i - 1].close - 1;
  const bdates = bench.map(function (b) { return b.date; });
  // prev-trading-day return for each world day
  const prevRet = {};
  WORLD.days.forEach(function (d) {
    for (let i = bdates.length - 1; i >= 0; i--) { if (bdates[i] < d && ret[bdates[i]] != null) { prevRet[d] = ret[bdates[i]]; break; } }
  });
  const ccs = {};
  WORLD.days.forEach(function (d) { const m = WORLD.byDay[d] || {}; Object.keys(m).forEach(function (cc) { ccs[cc] = 1; }); });
  Object.keys(ccs).forEach(function (cc) {
    const xs = [], ys = [];
    WORLD.days.forEach(function (d) {
      if (prevRet[d] == null) return;
      const r = (WORLD.byDay[d] || {})[cc];
      xs.push(r ? (r.views || 0) : 0); ys.push(prevRet[d]);
    });
    const p = pearson(xs, ys);
    if (p != null) WORLD.corrByCC[cc] = p;
  });
}

// Colour domains are fixed across the whole window so replay frames compare.
function computeWorldMax() {
  const mx = { attention: 0, time: 0, ret: 0, hit: 1 };
  WORLD.days.forEach(function (d) {
    const m = WORLD.byDay[d] || {};
    Object.keys(m).forEach(function (cc) {
      const r = m[cc];
      mx.attention = Math.max(mx.attention, r.views || 0);
      if (r.users) mx.time = Math.max(mx.time, (r.dwell_ms / 60000) / r.users);
      if (r.ret_n) mx.ret = Math.max(mx.ret, Math.abs(r.ret_sum / r.ret_n));
    });
  });
  mx.topstock = mx.attention;
  WORLD.max = mx;
}

function worldFill(v) {
  if (v == null) return null;
  const base = [38, 45, 66], green = [46, 204, 113], red = [231, 76, 60], blue = [78, 158, 255], purple = [162, 155, 254];
  const lerp = function (a, b, t) { return "rgb(" + a.map(function (x, i) { return Math.round(x + (b[i] - x) * t); }).join(",") + ")"; };
  if (WORLD.mode === "corr") { // correlation, diverging around 0 on a fixed -1..1 domain
    const t = Math.max(-1, Math.min(1, v));
    return t >= 0 ? lerp(base, blue, t) : lerp(base, red, -t);
  }
  if (WORLD.mode === "vscrowd") { // cosine similarity 0..1, sequential purple
    return lerp(base, purple, Math.max(0, Math.min(1, v)));
  }
  if (WORLD.mode === "hit") { // diverging around 50%
    const t = Math.max(0, Math.min(1, v));
    return t >= 0.5 ? lerp(base, green, (t - 0.5) * 2) : lerp(base, red, (0.5 - t) * 2);
  }
  if (WORLD.mode === "ret") { // diverging around 0
    const t = Math.max(-1, Math.min(1, v / (WORLD.max.ret || 1e-9)));
    return t >= 0 ? lerp(base, green, t) : lerp(base, red, -t);
  }
  const mx = WORLD.max[WORLD.mode] || 0;
  if (!mx) return null;
  const top = WORLD.mode === "time" ? green : [78, 158, 255];
  return lerp(base, top, Math.sqrt(Math.max(0, Math.min(1, v / mx)))); // sqrt: keep small countries visible
}

// Label anchor: the bbox of the largest landmass subpath, not of the whole
// country (the US bbox centre with Alaska+Hawaii lands in Canada). Safe split:
// every subpath in vendor/world-map.js starts with an absolute M.
function worldLabelBox(p) {
  const parts = (p.getAttribute("d") || "").split(/(?=M)/g).filter(function (s) { return s.length > 1; });
  try {
    if (parts.length <= 1) return p.getBBox();
  } catch (e) { return null; } // hidden mid-switch
  const tmp = document.createElementNS("http://www.w3.org/2000/svg", "path");
  tmp.setAttribute("visibility", "hidden");
  p.ownerSVGElement.appendChild(tmp);
  let best = null;
  try {
    parts.forEach(function (seg) {
      tmp.setAttribute("d", seg);
      const b = tmp.getBBox();
      if (!best || b.width * b.height > best.width * best.height) best = b;
    });
  } catch (e) { best = null; } finally { tmp.remove(); }
  return best;
}

async function loadWorldData() {
  if (WORLD.loading) return;
  WORLD.loading = true;
  const st = document.getElementById("world-status");
  try {
    if (!WORLD.loaded) st.textContent = "Loading...";
    const res = await Promise.all([ATCloud.worldCountryDaily(WORLD_DAYS), ATCloud.worldTopStockDaily(WORLD_DAYS)]);
    const byDay = {}, topByDay = {};
    (res[0] || []).forEach(function (r) {
      // country is client-written text: accept only ISO2 shapes (also keeps the
      // attribute-selector lookups safe from crafted values).
      const cc = String(r.country || "").toUpperCase();
      if (!/^[A-Z]{2}$/.test(cc)) return;
      (byDay[String(r.day)] = byDay[String(r.day)] || {})[cc] = {
        cc: cc, users: +r.users || 0, views: +r.views || 0, dwell_ms: +r.dwell_ms || 0,
        labelled: +r.labelled || 0, hits: +r.hits || 0, ret_sum: +r.ret_sum || 0, ret_n: +r.ret_n || 0
      };
    });
    (res[1] || []).forEach(function (r) {
      const cc = String(r.country || "").toUpperCase();
      if (!/^[A-Z]{2}$/.test(cc)) return;
      (topByDay[String(r.day)] = topByDay[String(r.day)] || {})[cc] = { ticker: r.ticker, views: +r.views || 0 };
    });
    // Contiguous UTC day axis ending today, so the replay runs smoothly over gaps.
    let days = [];
    const now = new Date();
    for (let i = WORLD_DAYS - 1; i >= 0; i--) {
      days.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)).toISOString().slice(0, 10));
    }
    // Start the axis on the first day that HAS data. The window is a fixed 60
    // days but the history behind it is younger than that, so the axis opened on
    // a long run of empty days: a replay from frame 0 sat on a blank map for
    // most of its length and read as broken rather than as "no data yet". Gaps
    // after the first day are kept - those are real quiet days, and the axis
    // stays contiguous so the replay speed still means something.
    const firstData = days.findIndex(function (d) { return byDay[d] || topByDay[d]; });
    if (firstData > 0) days = days.slice(firstData);
    const stayLive = !WORLD.loaded || WORLD.frame >= WORLD.days.length - 1;
    const heldDay = WORLD.days[WORLD.frame]; // the DATE a scrubbed frame is parked on
    WORLD.days = days; WORLD.byDay = byDay; WORLD.topByDay = topByDay;
    computeWorldMax();
    if (stayLive) {
      WORLD.frame = days.length - 1; // open on (and keep tracking) today
    } else {
      // Hold the day, not the index. The window rolls forward and its start can
      // now move by more than a day at a time, so keeping the index would slide
      // a parked frame onto a different date on every 60s refresh.
      const at = days.indexOf(heldDay);
      WORLD.frame = at >= 0 ? at : Math.max(0, Math.min(WORLD.frame, days.length - 1));
    }
    WORLD.loaded = true;
    const today = byDay[days[days.length - 1]] || {};
    let users = 0; Object.keys(today).forEach(function (cc) { users += today[cc].users; });
    const n = Object.keys(today).length;
    st.textContent = "today: " + n + " countr" + (n === 1 ? "y" : "ies") + " · " + users + " user(s) · updated " + new Date().toLocaleTimeString();
  } catch (e) { st.textContent = "Error: " + (e && e.message || e); }
  finally { WORLD.loading = false; }
}

function renderWorldFrame() {
  if (!WORLD.loaded || !WORLD.built) return;
  const d = WORLD.days[WORLD.frame];
  const m = WORLD.byDay[d] || {};
  document.querySelectorAll("#world-map .wm-c").forEach(function (p) {
    const cc = p.getAttribute("data-cc");
    const fill = worldFill(worldValue(m[cc], cc));
    if (fill) { p.style.fill = fill; p.classList.add("has-data"); }
    else { p.style.fill = ""; p.classList.remove("has-data"); }
  });
  const pops = document.getElementById("world-pops");
  while (pops.firstChild) pops.removeChild(pops.firstChild);
  if (WORLD.mode === "topstock") {
    const tops = WORLD.topByDay[d] || {};
    Object.keys(tops).forEach(function (cc) {
      const p = document.querySelector('#world-map .wm-c[data-cc="' + cc + '"]');
      if (!p) return;
      const b = worldLabelBox(p);
      if (!b || (!b.width && !b.height)) return;
      const tx = document.createElementNS("http://www.w3.org/2000/svg", "text");
      tx.setAttribute("x", b.x + b.width / 2);
      // The VPN bubble already carries its own label: put the ticker under it.
      tx.setAttribute("y", cc === VPN_CC ? b.y + b.height + 10 : b.y + b.height / 2);
      tx.setAttribute("class", "wm-pop");
      tx.textContent = tops[cc].ticker;
      pops.appendChild(tx);
    });
  }
  const sl = document.getElementById("world-slider");
  sl.max = String(Math.max(0, WORLD.days.length - 1));
  sl.value = String(WORLD.frame);
  const live = WORLD.frame === WORLD.days.length - 1;
  // Keep the badge and suffix in the layout at all times, hidden rather than
  // removed. This label is the last flex item in .world-strap and the slider is
  // flex:1, so changing its width would resize the slider mid-drag and slide the
  // thumb out from under the pointer. The date itself is fixed-width.
  document.getElementById("world-day").innerHTML =
    "<span class='wm-live" + (live ? "" : " wm-hold") + "'>LIVE</span> " + escapeHtml(d) +
    "<span" + (live ? "" : " class='wm-hold'") + "> (today)</span>";
  renderWorldLegend();
  renderWorldTable(Object.keys(m).map(function (cc) { return m[cc]; }));
  holdWorldTableHeight(document.getElementById("world-table"));
}

// Replay: step through the day axis; on reaching today, stop and stay live.
// Halt the replay without touching the scrub state - used when a manual drag
// takes over, where the layout floor must stay pinned for the rest of the drag.
function worldPauseTimer() {
  if (WORLD.playTimer) { clearInterval(WORLD.playTimer); WORLD.playTimer = 0; }
  WORLD.playing = false;
  const b = document.getElementById("world-play");
  if (b) b.innerHTML = "&#9654;";
}

function worldStop() {
  worldPauseTimer();
  endWorldScrub();
}

// Send the axis back to its first day and play from there. The play button
// resumes wherever it was paused - right for a mid-replay pause, but it left no
// way back to the start once the frame had moved off it, so a replay could only
// be restarted by first dragging the slider all the way down or by letting it
// run to today.
function worldRestart() {
  if (!WORLD.days.length) return;
  worldPauseTimer(); // may be mid-replay: worldPlay() would bail on the guard
  WORLD.frame = 0;
  if (WORLD.days.length < 2) { renderWorldFrame(); return; } // nothing to animate
  worldPlay();
}

function worldPlay() {
  if (WORLD.playing || WORLD.days.length < 2) return;
  WORLD.playing = true;
  document.getElementById("world-play").innerHTML = "&#10074;&#10074;";
  if (WORLD.frame >= WORLD.days.length - 1) WORLD.frame = 0; // replay from the start
  beginWorldScrub(); // the replay steps frames too, so pin the layout for it as well
  renderWorldFrame();
  WORLD.playTimer = setInterval(function () {
    if (!worldVisible()) return; // pause while the tab is hidden; resume on return
    WORLD.frame++;
    if (WORLD.frame >= WORLD.days.length - 1) { WORLD.frame = WORLD.days.length - 1; worldStop(); }
    renderWorldFrame();
  }, 350);
}

function renderWorldLegend() {
  const el = document.getElementById("world-legend");
  const grad = function (a, b) { return "<span class='wm-grad' style='background:linear-gradient(90deg," + a + "," + b + ")'></span>"; };
  const gray = " <span class='muted'>&middot; gray = no data</span>";
  if (WORLD.mode === "corr") {
    el.innerHTML = "-1 " + grad("#e74c3c", TC().mapfill) + grad(TC().mapfill, "#4e9eff") + " +1 &nbsp;correlation of daily views vs prev-day NASDAQ return" + gray;
    return;
  }
  if (WORLD.mode === "vscrowd") {
    el.innerHTML = "distinct " + grad(TC().mapfill, "#a29bfe") + " mainstream &nbsp;how similar a country's research mix is to the global mix" + gray;
    return;
  }
  if (WORLD.mode === "hit") {
    el.innerHTML = "0% " + grad("#e74c3c", TC().mapfill) + grad(TC().mapfill, "#2ecc71") + " 100% hit rate" + gray;
    return;
  }
  if (WORLD.mode === "ret") {
    const mx = WORLD.max.ret || 0;
    el.innerHTML = escapeHtml(pct(-mx)) + " " + grad("#e74c3c", TC().mapfill) + grad(TC().mapfill, "#2ecc71") + " " + escapeHtml(pct(mx)) + " avg return / view" + gray;
    return;
  }
  const mx = WORLD.max[WORLD.mode] || 0;
  if (!mx) { el.innerHTML = ""; return; }
  const top = WORLD.mode === "time" ? "#2ecc71" : "#4e9eff";
  const unit = WORLD.mode === "time" ? "min/user/day" : (WORLD.mode === "topstock" ? "views/day (label = top stock)" : "views/day");
  el.innerHTML = "0 " + grad(TC().mapfill, top) + " " + escapeHtml(String(WORLD.mode === "time" ? mx.toFixed(1) : Math.round(mx))) + " " + unit + gray;
}

// While the day axis is being scrubbed or replayed, pin the table block to the
// tallest frame seen so far. Each day has a different row count, and letting the
// block resize per frame drags the whole page around under the slider. The floor
// is released as soon as the interaction ends, so a short table does not leave a
// permanent gap.
function holdWorldTableHeight(el) {
  if (!el || !WORLD.scrubbing) return;
  const h = el.offsetHeight;
  if (h > WORLD.tableMinH) { WORLD.tableMinH = h; el.style.minHeight = h + "px"; }
}
function resetWorldTableHeight() {
  WORLD.tableMinH = 0;
  const el = document.getElementById("world-table");
  if (el) el.style.minHeight = "";
}
function beginWorldScrub() {
  if (WORLD.scrubbing) return;
  WORLD.scrubbing = true;
  const el = document.getElementById("world-table");
  if (el) { WORLD.tableMinH = el.offsetHeight; el.style.minHeight = WORLD.tableMinH + "px"; }
}
function endWorldScrub() {
  if (!WORLD.scrubbing) return;
  WORLD.scrubbing = false;
  resetWorldTableHeight();
}

function renderWorldTable(rows) {
  const el = document.getElementById("world-table");
  const d = WORLD.days[WORLD.frame];
  const cname = function (r) { return "<td>" + escapeHtml(worldCountryName(r.cc)) + "</td>"; };
  // corr is a whole-window per-country scalar, independent of the current frame.
  if (WORLD.mode === "corr") {
    const cs = Object.keys(WORLD.corrByCC || {}).map(function (cc) { return { cc: cc, v: WORLD.corrByCC[cc] }; })
      .sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); }).slice(0, 12);
    if (!cs.length) { el.innerHTML = "<div class='muted small'>Not enough overlapping days for correlations yet.</div>"; return; }
    el.innerHTML = "<table class='an-table wm-table'><thead><tr><th>Country</th><th>r (views vs prev-day NASDAQ)</th></tr></thead><tbody>"
      + cs.map(function (r) { return "<tr>" + cname(r) + "<td class='" + (r.v >= 0 ? "pos" : "neg") + "'>" + r.v.toFixed(2) + "</td></tr>"; }).join("")
      + "</tbody></table>";
    return;
  }
  if (WORLD.mode === "vscrowd") {
    const cs = Object.keys(WORLD.simByCC || {}).map(function (cc) { return { cc: cc, v: WORLD.simByCC[cc], me: (WORLD.simMeta || {})[cc] }; })
      .sort(function (a, b) { return b.v - a.v; }).slice(0, 12);
    if (!cs.length) { el.innerHTML = "<div class='muted small'>No country research recorded in the window yet.</div>"; return; }
    el.innerHTML = "<table class='an-table wm-table'><thead><tr><th>Country</th><th>Similarity to global</th><th>Views</th></tr></thead><tbody>"
      + cs.map(function (r) { return "<tr>" + cname(r) + "<td>" + Math.round(r.v * 100) + "%</td><td>" + (r.me ? r.me.views : "-") + "</td></tr>"; }).join("")
      + "</tbody></table>";
    return;
  }
  const withVal = rows.filter(function (r) { return worldValue(r, r.cc) != null; })
    .sort(function (a, b) { return Math.abs(worldValue(b, b.cc)) - Math.abs(worldValue(a, a.cc)); }).slice(0, 12);
  if (!withVal.length) { el.innerHTML = "<div class='muted small'>No community data for this day/mode.</div>"; return; }
  let head, cells;
  if (WORLD.mode === "topstock") {
    head = "<th>Country</th><th>Top stock</th><th>Views</th><th>Users</th>";
    cells = function (r) {
      const top = (WORLD.topByDay[d] || {})[r.cc];
      return cname(r) + "<td><b>" + escapeHtml(top ? top.ticker : "-") + "</b></td><td>" + r.views + "</td><td>" + r.users + "</td>";
    };
  } else if (WORLD.mode === "time") {
    head = "<th>Country</th><th>Min/user</th><th>Users</th>";
    cells = function (r) { return cname(r) + "<td>" + ((r.dwell_ms / 60000) / r.users).toFixed(1) + "</td><td>" + r.users + "</td>"; };
  } else if (WORLD.mode === "hit") {
    head = "<th>Country</th><th>Hit rate</th><th>Labels</th>";
    cells = function (r) { const hr = r.hits / r.labelled; return cname(r) + "<td class='" + (hr >= 0.5 ? "pos" : "neg") + "'>" + Math.round(hr * 100) + "%</td><td>" + r.labelled + "</td>"; };
  } else if (WORLD.mode === "ret") {
    head = "<th>Country</th><th>Avg return / view</th><th>Priced views</th>";
    cells = function (r) { const v = r.ret_sum / r.ret_n; return cname(r) + "<td class='" + signClass(v) + "'>" + pct(v) + "</td><td>" + r.ret_n + "</td>"; };
  } else {
    head = "<th>Country</th><th>Views</th><th>Active min</th><th>Users</th>";
    cells = function (r) { return cname(r) + "<td>" + r.views + "</td><td>" + Math.round(r.dwell_ms / 60000) + "</td><td>" + r.users + "</td>"; };
  }
  el.innerHTML = "<table class='an-table wm-table'><thead><tr>" + head + "</tr></thead><tbody>"
    + withVal.map(function (r) { return "<tr>" + cells(r) + "</tr>"; }).join("")
    + "</tbody></table>";
}

async function renderTrending() {
  const el = document.getElementById("net-trending");
  if (!el) return;
  if (self.crowdWatchRender) crowdWatchRender();
  try {
    const rows = await ATCloud.worldTrending();
    if (!rows.length) { el.innerHTML = "<div class='muted small'>Nothing to show yet today: a ticker appears once at least 3 users have viewed it (smaller counts stay private).</div>"; return; }
    // Heat is per user (see world_trending): today's views against what the
    // ticker's trailing 7-day views-per-active-user would give at today's
    // audience, so platform growth alone does not make everything look hot.
    const act = rows[0].active_today;
    el.innerHTML = "<table class='an-table wm-table'><thead><tr><th>Ticker</th><th>Views today</th><th>Users</th>" +
      "<th title='Raw average views per day over the previous 7 days.'>7d avg/day</th>" +
      "<th title='Views today expected at the previous 7 days&#39; views per active user, times today&#39;s active users.'>Expected today</th>" +
      "<th title='(views today + 1) / (expected today + 1).'>Heat</th></tr></thead><tbody>" +
      rows.map(function (r) {
        const hot = +r.score >= 2;
        return "<tr><td><b>" + escapeHtml(r.ticker) + "</b></td><td>" + r.views_today + "</td><td>" + r.users_today + "</td><td>" + r.avg_prior +
          "</td><td>" + (r.expected == null ? "-" : r.expected) +
          "</td><td class='" + (hot ? "pos" : "muted") + "'>" + (hot ? "&#9650; " : "") + r.score + "x</td></tr>";
      }).join("") + "</tbody></table>" +
      (act != null ? "<div class='muted small'>" + act + " active user(s) today. Heat compares today with each ticker's usual views per user, so a growing community does not make every ticker look hot.</div>" : "");
  } catch (e) { el.innerHTML = "<div class='muted small'>Error: " + escapeHtml(e && e.message || String(e)) + "</div>"; }
}

// "You vs the crowd": daily cosine similarity between the signed-in user's
// ticker view-mix and the whole community's, on Community > Standing (nowId is
// optional). Result cached ~60s.
const CROWD = { rows: null, ts: 0 };
async function crowdRows() {
  if (CROWD.rows && Date.now() - CROWD.ts < 60000) return CROWD.rows;
  CROWD.rows = await ATCloud.worldCrowdOverlap(WORLD_DAYS); CROWD.ts = Date.now();
  return CROWD.rows;
}
async function renderCrowdOverlap(canvasId, tipId, nowId) {
  const cv = document.getElementById(canvasId); if (!cv) return;
  const tip = document.getElementById(tipId), nowEl = nowId ? document.getElementById(nowId) : null;
  try {
    const rows = await crowdRows();
    if (!rows.length) {
      if (nowEl) nowEl.innerHTML = "<div class='muted small'>No overlap yet. It appears on days when at least 20 people used Stocktrails, so no one's research can be singled out.</div>";
      setupCanvas(cv); if (tip) tip.textContent = ""; return;
    }
    const last = rows[rows.length - 1];
    // Rows only exist for days the user actually researched, so the latest row
    // may not be today; label it precisely.
    const when = String(last.day) === new Date().toISOString().slice(0, 10) ? "today" : String(last.day);
    if (nowEl) nowEl.innerHTML = "<div class='usage-cards'><div class='stat'><b>" + pct(+last.overlap) + "</b>overlap " + when + "</div>" +
      "<div class='stat'><b>" + last.my_views + "</b>your views " + when + "</div></div>";
    // Outside attention sources on the same scale: per day, the cosine similarity
    // of your ticker view mix with each list's weights that day (views share for
    // StockAnalysis and Reddit, 1/rank for Stocktwits and Yahoo - the same
    // weighting their index lines use). Only days you researched AND the list was
    // captured have a point.
    try { await ensureTrendData(); } catch (e) { /* community line only */ }
    const myDay = {};
    (DATA.intraday || []).forEach(function (e) {
      const d = new Date(e.ts).toISOString().slice(0, 10); // UTC day, like world_crowd_overlap
      const t = trendYahooSym(e.ticker);
      const m = myDay[d] || (myDay[d] = {});
      m[t] = (m[t] || 0) + 1;
    });
    const cosine = function (a, b) {
      let dot = 0, na = 0, nb = 0;
      Object.keys(a).forEach(function (k) { na += a[k] * a[k]; if (b[k]) dot += a[k] * b[k]; });
      Object.keys(b).forEach(function (k) { nb += b[k] * b[k]; });
      return na && nb ? dot / Math.sqrt(na * nb) : null;
    };
    const srcSim = TREND_SOURCES.map(function (s) {
      const by = {};
      ((NET.trendAll || {})[s.id] || []).forEach(function (d) {
        const mine = myDay[d.day];
        if (!mine) return;
        const w = {};
        Object.keys(d.w).forEach(function (t) { w[t] = s.weight === "views" ? (d.w[t].views || 0) : 1 / Math.max(1, d.w[t].rank); });
        const v = cosine(mine, w);
        if (v != null) by[d.day] = v;
      });
      return { src: s, by: by };
    });
    const byComm = {};
    rows.forEach(function (r) { byComm[String(r.day)] = r; });
    const dset = {};
    Object.keys(byComm).forEach(function (d) { dset[d] = 1; });
    srcSim.forEach(function (x) { Object.keys(x.by).forEach(function (d) { dset[d] = 1; }); });
    const days = Object.keys(dset).sort();
    const series = [{ label: "Community", color: "#a29bfe", vals: days.map(function (d) { return byComm[d] ? +byComm[d].overlap * 100 : null; }) }];
    srcSim.forEach(function (x) {
      if (!Object.keys(x.by).length) return;
      series.push({ label: x.src.label, color: x.src.color, vals: days.map(function (d) { return x.by[d] == null ? null : x.by[d] * 100; }) });
    });
    const step = Math.max(1, Math.ceil(days.length / 8));
    const labels = days.map(function (d, i) { return i % step === 0 ? d.slice(5) : ""; });
    const htmls = days.map(function (d, i) {
      const r = byComm[d];
      return "<b>" + escapeHtml(d) + "</b>" + series.map(function (s) {
        const v = s.vals[i];
        return "<br><span style='color:" + s.color + "'>&#9632;</span> " + escapeHtml(s.label) + " " + (v == null ? "-" : Math.round(v) + "%");
      }).join("") + (r ? "<br><span class='muted'>" + r.my_views + " of " + r.community_views + " community views</span>" : "");
    });
    drawLineCanvas(cv, tipId, series, labels, days);
    if (canvasHover[cv.id]) canvasHover[cv.id].html = htmls;
    attachCanvasHover(cv);
    if (tip) tip.innerHTML = series.map(function (s) { return "<span style='color:" + s.color + "'>&#9632;</span> " + escapeHtml(s.label); }).join(" &nbsp; ") +
      "<br>Cosine similarity of your daily ticker mix with the community's and with each outside attention list; higher = more aligned. " +
      "An outside list only has a point on days it was captured and you researched something.";
  } catch (e) {
    if (nowEl) nowEl.innerHTML = "<div class='muted small'>Error: " + escapeHtml(e && e.message || String(e)) + "</div>";
    setupCanvas(cv); if (tip) tip.textContent = "";
  }
}

// NASDAQ benchmark for the whole window; loaded once, drives the corr map mode
// (per-country). The community-wide rolling correlation moved to My Habits >
// Market correlation (renderMarketCorr).
async function ensureWorldBench() {
  if (WORLD.bench) return WORLD.bench;
  try {
    const from = WORLD.days.length ? WORLD.days[0] : isoDate(Date.now() - WORLD_DAYS * 86400000);
    WORLD.bench = await ATPrices.fetchDaily("^IXIC", isoDate(Date.parse(from) - 10 * 86400000), true) || [];
  } catch (e) { WORLD.bench = []; }
  computeWorldCorrByCC();
  return WORLD.bench;
}

// Per-country similarity of research mix vs the global mix ('Country vs crowd'
// map mode). Fetched once (force=true on the live refresh); populates simByCC +
// simMeta (users/views per country) for the map, tooltip and table.
async function ensureWorldSim(force) {
  if (WORLD.simByCC && !force) return WORLD.simByCC;
  const sim = {}, meta = {};
  try {
    const rows = await ATCloud.worldCountryCrowdSimilarity(WORLD_DAYS);
    (rows || []).forEach(function (r) {
      const cc = String(r.country || "").toUpperCase();
      if (!/^[A-Z]{2}$/.test(cc) || r.similarity == null) return;
      sim[cc] = +r.similarity; meta[cc] = { users: +r.users || 0, views: +r.views || 0 };
    });
  } catch (e) { /* leave empty; map shows gray */ }
  WORLD.simByCC = sim; WORLD.simMeta = meta;
  return sim;
}

async function renderWorld() {
  document.getElementById("world-coming").hidden = IS_ADMIN;
  document.getElementById("world-content").hidden = !IS_ADMIN;
  if (!IS_ADMIN) return;
  if (!self.AT_WORLD_MAP) { document.getElementById("world-status").textContent = "Map data missing (vendor/world-map.js)."; return; }
  buildWorldMap();
  if (!WORLD.liveTimer) WORLD.liveTimer = setInterval(async function () {
    if (!worldVisible() || WORLD.playing) return;
    await loadWorldData(); // live feed: keep today's frame and panels fresh
    computeWorldCorrByCC();
    await ensureWorldSim(true);
    renderWorldFrame();
  }, 60000);
  await loadWorldData();
  renderWorldFrame();
  await ensureWorldBench();      // loads NASDAQ + computes per-country correlations
  if (WORLD.mode === "corr") renderWorldFrame(); // now that corrByCC is ready
  if (WORLD.mode === "vscrowd") { await ensureWorldSim(); renderWorldFrame(); }
}

document.querySelectorAll("#world-seg button").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("#world-seg button").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on");
    WORLD.mode = b.getAttribute("data-w");
    resetWorldTableHeight(); // each mode has its own table shape; re-measure it
    renderWorldFrame();
    // corr / vscrowd need extra data (NASDAQ benchmark / similarity RPC): load it
    // lazily on first use, then repaint.
    if (WORLD.mode === "corr" && !(WORLD.corrByCC && Object.keys(WORLD.corrByCC).length)) {
      ensureWorldBench().then(function () { if (WORLD.mode === "corr") renderWorldFrame(); });
    }
    if (WORLD.mode === "vscrowd" && !(WORLD.simByCC && Object.keys(WORLD.simByCC).length)) {
      ensureWorldSim().then(function () { if (WORLD.mode === "vscrowd") renderWorldFrame(); });
    }
  });
});
(function () {
  const play = document.getElementById("world-play");
  if (play) play.addEventListener("click", function () { if (WORLD.playing) worldStop(); else worldPlay(); });
  const rst = document.getElementById("world-restart");
  if (rst) rst.addEventListener("click", worldRestart);
  const sl = document.getElementById("world-slider");
  if (sl) sl.addEventListener("input", function () {
    worldPauseTimer(); // scrubbing takes over from the replay, but stays a scrub
    beginWorldScrub(); // covers keyboard stepping too, which fires no pointer events
    const f = Math.max(0, Math.min(WORLD.days.length - 1, parseInt(this.value, 10) || 0));
    if (f === WORLD.frame) return; // same day: skip a full repaint
    WORLD.frame = f;
    renderWorldFrame();
  });
  if (sl) sl.addEventListener("pointerdown", beginWorldScrub);
  // Release on the window: the pointer is very often outside the slider by the
  // time it is lifted, and a drag that ends off-element still ends the scrub.
  ["pointerup", "pointercancel"].forEach(function (ev) {
    window.addEventListener(ev, function () { if (!WORLD.playing) endWorldScrub(); });
  });
  if (sl) sl.addEventListener("blur", function () { if (!WORLD.playing) endWorldScrub(); });
})();

// ---------- Network: personal percentiles + community index ----------
// Same gate as World: tab for everyone, content admin-only for now.
const NET = { rendered: false, loading: false, rows: null, daily: null, live: null, trend: null, trendAll: null, trendTot: null, saDay: null, trendErr: null, bars: null, bench: null };

// Current price per community ticker, for the holdings table and the summary.
//
// network_community_index() can only report `last_price` = the newest
// price_at_event, i.e. the price captured the last time SOMEONE LOOKED at the
// stock. That is as stale as the community's attention: FLY's was 37 days old,
// GOOGL's 28. Pairing that with a live, price-history-based chart line made the
// two disagree even with a single user. The browser has the Yahoo proxy, so
// price the basket live here and use the RPC only for entry/first_ts/views.
async function netLivePrices(tickers) {
  const live = NET.live || (NET.live = {});
  // Dedupe up front: these run concurrently, so two entries for the same ticker
  // would both pass the cache check before either of them writes to it.
  const uniq = Object.keys((tickers || []).reduce(function (o, t) { o[t] = 1; return o; }, {}));
  await Promise.all(uniq.map(async function (t) {
    if (live[t] !== undefined) return; // already resolved (null counts as resolved)
    const q = QUOTES[t];
    if (q && q.close != null) { live[t] = q.close; return; }
    try {
      const ov = DATA && DATA.overrides && DATA.overrides[t]; // ticker -> Yahoo symbol
      const r = await ATPrices.fetchQuote(ov || t, !!ov);
      live[t] = (r && r.close != null) ? r.close : null;
      if (r && r.currency) (NET.liveCcy || (NET.liveCcy = {}))[t] = r.currency;
    } catch (e) { live[t] = null; } // delisted / unresolvable: shown as "-", not counted
  }));
  return live;
}

// ---------- returns in local currency or USD (Performance + Network charts) ----------
// Yahoo prices every listing in its own currency (0700.HK in HKD, BGS.L in
// pence). "Local" compounds those prices as they are: the return a holder in
// that market saw. "USD" converts every price at that day's USD rate first, so a
// Hong Kong name also carries the HKD/USD move: the return a dollar investor saw.
// One setting for both tabs, flipped by any [data-ccy-toggle] button.
let ccyMode = "local";
const FX = {}; // currency -> { from, bars } of Yahoo XXXUSD=X daily closes
const MINOR_CCY = { GBp: ["GBP", 100], GBX: ["GBP", 100], ZAc: ["ZAR", 100], ILA: ["ILS", 100] };
function ccyBase(c) { const m = MINOR_CCY[c]; return m ? { cur: m[0], div: m[1] } : { cur: c, div: 1 }; }
function tickerCcy(t) {
  const b = NET.bars && NET.bars[t];
  return (QUOTES[t] && QUOTES[t].currency) || (SERIES[t] && SERIES[t].currency) || (b && b.currency) ||
    (NET.liveCcy && NET.liveCcy[t]) || "USD";
}

// Daily USD-per-unit rates for each currency, from Yahoo's XXXUSD=X pairs.
// Cached on FX; refetched only when a render needs an earlier start.
async function loadFx(currencies, from) {
  const fx = FX;
  const curs = {};
  currencies.forEach(function (c) { const b = ccyBase(c).cur; if (b && b !== "USD") curs[b] = 1; });
  await Promise.all(Object.keys(curs).map(async function (cur) {
    if (fx[cur] && fx[cur].from <= from) return;
    // Only a real series is cached. A failed or rate-limited fetch used to be
    // stored as an empty series, and every name in that currency then vanished
    // from the USD charts for the rest of the session. One retry, then the next
    // render tries again; an older, shorter series is kept meanwhile.
    for (let a = 0; a < 2; a++) {
      try {
        const bars = await ATPrices.fetchDaily(cur + "USD=X", from, true);
        if (bars && bars.length) { fx[cur] = { from: from, bars: bars }; return; }
      } catch (e) { /* retried below */ }
      if (!a) await new Promise(function (r) { setTimeout(r, 1200); });
    }
  }));
}

// USD per ONE unit of the quote currency on a date: the last FX close on or
// before it (FX trades on days a local exchange is shut, and the reverse), the
// first one if the date precedes the series. null = no rate, cannot convert.
function fxAt(c, date) {
  const base = ccyBase(c);
  if (base.cur === "USD") return 1 / base.div;
  const s = FX[base.cur];
  const b = s && s.bars;
  if (!b || !b.length) return null;
  let lo = 0, hi = b.length - 1, hit = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m].date <= date) { hit = m; lo = m + 1; } else hi = m - 1; }
  return b[hit < 0 ? 0 : hit].close / base.div;
}

// A bar series in USD. A name whose currency has no rate is left out (null),
// the same as a name with no price history, rather than mixed in unconverted.
function usdBars(b) {
  if (!b || !b.length || !b.currency || b.currency === "USD") return b;
  const out = [];
  for (let i = 0; i < b.length; i++) {
    const r = fxAt(b.currency, b[i].date);
    if (r == null) return null;
    out.push({ date: b[i].date, close: b[i].close * r });
  }
  out.currency = "USD";
  return out;
}

// A local price recorded at `ts` (ms or a bar date) in the current mode: as is
// under Local, at that day's rate under USD. null = no rate for that currency.
function ccyPrice(t, price, ts) {
  if (price == null || ccyMode !== "usd") return price;
  const r = fxAt(tickerCcy(t), typeof ts === "number" ? new Date(ts).toISOString().slice(0, 10) : String(ts));
  return r == null ? null : price * r;
}
// SERIES[t] in the current mode ([] when a USD rate is missing: not plotted,
// and named in the chart note by ccyNoteText rather than dropped silently).
const CCY_MISSING = {};
function ccySeries(t) {
  const b = SERIES[t] || [];
  delete CCY_MISSING[t];
  if (ccyMode !== "usd" || !b.length) return b;
  const c = tickerCcy(t);
  if (c === "USD") return b;
  const out = [];
  for (let i = 0; i < b.length; i++) {
    const r = fxAt(c, b[i].date);
    if (r == null) { CCY_MISSING[t] = c; return []; }
    out.push({ date: b[i].date, close: b[i].close * r });
  }
  return out;
}
// Rates for every currency these tickers trade in, from before their first view.
async function ensureFx(tickers) {
  Object.keys(CCY_MISSING).forEach(function (t) { delete CCY_MISSING[t]; }); // per render
  if (ccyMode !== "usd" || !tickers.length) return;
  let from = Infinity;
  tickers.forEach(function (t) {
    if (GROUPS[t] && GROUPS[t][0]) from = Math.min(from, GROUPS[t][0].ts);
    const b = SERIES[t]; if (b && b.length) from = Math.min(from, Date.parse(b[0].date));
  });
  if (!isFinite(from)) return;
  await loadFx(tickers.map(tickerCcy), isoDate(from - 10 * 86400000));
}
function ccyNoteText() {
  if (ccyMode !== "usd") return "Returns in each listing's local currency.";
  const miss = Object.keys(CCY_MISSING);
  return "Returns in USD: non-USD listings converted at daily FX rates." +
    (miss.length ? " Left out for want of a USD rate (Yahoo did not answer; retried on the next redraw): " +
      miss.map(function (t) { return escapeHtml(nameOf(t)) + " (" + escapeHtml(CCY_MISSING[t]) + ")"; }).join(", ") + "." : "");
}
function syncCcyButtons() {
  document.querySelectorAll("[data-ccy-toggle]").forEach(function (b) {
    b.textContent = ccyMode === "usd" ? "USD" : "Local";
    b.classList.toggle("on", ccyMode === "usd");
  });
}
// One click flips the mode; whichever tab is visible redraws now, a hidden
// Network index redraws on its next visit (Performance redraws on every visit).
document.querySelectorAll("[data-ccy-toggle]").forEach(function (b) {
  b.addEventListener("click", function () {
    ccyMode = ccyMode === "usd" ? "local" : "usd";
    syncCcyButtons();
    saveView();
    if (!document.getElementById("main-performance").hidden) render();
    if (!document.getElementById("main-network").hidden) renderNetworkIndex();
    else NET.rendered = false;
  });
});
syncCcyButtons();

async function renderNetworkPercentiles() {
  const el = document.getElementById("net-pct");
  // "top X%" is meaningless in a tiny community (a sole user is not "top 100%"),
  // so under 10 users show the literal standing instead.
  const badge = function (rank, n) {
    if (rank == null || !n) return "";
    const txt = n >= 10 ? "top " + Math.max(1, Math.round(rank / n * 100)) + "%" : "#" + rank + " of " + n;
    return "<span class='net-top'>" + txt + "</span>";
  };
  const card = function (value, label, rank, n, desc) {
    return "<div class='stat' title='" + escapeHtml(desc) + "'><b>" + escapeHtml(String(value)) + badge(rank, n) + "</b>" + escapeHtml(label) + "</div>";
  };
  try {
    const p = await ATCloud.networkPercentiles();
    if (!p || !p.users || p.views == null) { el.innerHTML = "<div class='muted small'>No activity recorded in the last 30 days.</div>"; return; }
    el.innerHTML =
      card(p.views, "Views", p.views_rank, p.users, "Your recorded views, last 30 days, vs " + p.users + " active user(s).") +
      card(p.dwell_min >= 90 ? (p.dwell_min / 60).toFixed(1) + "h" : p.dwell_min + "m", "Research time", p.dwell_rank, p.users, "Active minutes on stock pages, last 30 days.") +
      card(p.tickers, "Stocks covered", p.tickers_rank, p.users, "Distinct tickers researched, last 30 days.") +
      card(p.hit_rate == null ? "-" : pct(p.hit_rate), "Label hit rate", p.hit_rate == null ? null : p.hit_rank, p.hit_users, "Share of your Positive/Negative calls matching the move since the view.") +
      "<div class='stat'><b>" + p.users + "</b>active users (base)</div>";
  } catch (e) { el.innerHTML = "<div class='muted small'>Error: " + escapeHtml(e && e.message || String(e)) + "</div>"; }
}

// Both index baskets cut at a top-10 boundary, and view counts tie there often
// (GOOGL, MU and ZETA all sat on 8 views competing for the 10th slot). Neither
// the SQL `order by views desc` nor a bare numeric sort breaks those ties, so
// the two sides could pick different names from identical data. Ticker is an
// arbitrary but stable tie-break, and both sides now use it.
function byWeightThenTicker(a, b) {
  const wa = +(a.weight != null ? a.weight : a.views) || 0;
  const wb = +(b.weight != null ? b.weight : b.views) || 0;
  return (wb - wa) || String(a.ticker).localeCompare(String(b.ticker));
}

// ---------- point-in-time inputs for the community and personal indices ----------
// Both lines are rebuilt every day from what was known by that day's close:
// the basket is the top 10 by views counted SO FAR, and attention weights are
// those running counts. Ranking and weighting by all-time counts instead put a
// stock that only became popular in September into the July basket, weighted by
// views that had not happened yet.
//
// An event belongs to the trading day whose close is the first one after it:
// a view or label at 15:59 ET can still be traded at that day's close, one at
// 16:00 or later cannot. network_community_daily() buckets the same way.
const ET_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
});
function etParts(ts) {
  const o = {};
  ET_FMT.formatToParts(new Date(ts)).forEach(function (p) { o[p.type] = p.value; });
  return o;
}
// The 16:00 ET close of a YYYY-MM-DD date: 20:00 UTC under EDT, 21:00 UTC under EST.
function closeTs(date) {
  const t = Date.parse(date + "T20:00:00Z");
  return +etParts(t).hour === 16 ? t : t + 3600000;
}
function tradeDay(ts) {
  const p = etParts(ts);
  const d = p.year + "-" + p.month + "-" + p.day;
  return ts < closeTs(d) ? d : new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10);
}

// One ticker's input: entry (first priced view), and per trading day its views
// and label counts as [day, views, pos, neg, labelled] - the RPC's row shape.
// The label timeline for heldAt is one majority label per day, stamped at the
// start of that day so heldAt(.., end of dt) sees exactly the days <= dt, and is
// seeded with an unlabelled entry so "attended" holds a name before its first label.
function pitEntry(entryTs, entryPrice, days) {
  const entryDay = tradeDay(entryTs);
  const labels = [{ ts: Date.parse(entryDay), sentiment: null }];
  days.forEach(function (d) {
    if (!(+d[4])) return;
    labels.push({ ts: Date.parse(d[0]), sentiment: +d[2] > +d[3] ? "positive" : (+d[3] > +d[2] ? "negative" : "neutral") });
  });
  labels.sort(function (a, b) { return a.ts - b.ts; });
  return { entryTs: entryTs, entryPrice: entryPrice, entryDay: entryDay, days: days, labels: labels };
}

// Local events -> the same shape network_community_daily() returns. Only
// tickers with a priced view: nothing else can enter either basket.
function pitFromEvents(byTicker) {
  const out = {};
  Object.keys(byTicker).forEach(function (t) {
    const evs = byTicker[t];
    const priced = evs.find(function (e) { return e.priceAtEvent != null; });
    if (!priced) return;
    const days = {};
    evs.forEach(function (e) {
      const d = tradeDay(e.ts);
      const x = days[d] || (days[d] = [d, 0, 0, 0, 0]);
      x[1] += e.views || 1;
      if (e.sentiment) {
        x[4]++;
        if (e.sentiment === "positive") x[2]++;
        else if (e.sentiment === "negative") x[3]++;
      }
    });
    const list = Object.keys(days).sort().map(function (d) { return days[d]; });
    out[t] = pitEntry(priced.ts, priced.priceAtEvent, list);
  });
  return out;
}

function pitFromRpc(rows) {
  const out = {};
  (rows || []).forEach(function (r) {
    const days = (r.days || []).slice().sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    out[r.ticker] = pitEntry(+r.entry_ts, +r.entry_price, days);
  });
  return out;
}

// Names that could make a basket: the top `n` by running views on any day,
// ignoring prices. n is above the basket size so a few names without Yahoo
// history can drop out and the next ones still have bars fetched.
function pitCandidates(pit, n) {
  const keys = Object.keys(pit);
  const allDays = {};
  keys.forEach(function (t) { pit[t].days.forEach(function (d) { allDays[d[0]] = 1; }); });
  const ptr = {}, cum = {}, seen = {};
  keys.forEach(function (t) { ptr[t] = 0; cum[t] = 0; });
  Object.keys(allDays).sort().forEach(function (dt) {
    keys.forEach(function (t) {
      const ds = pit[t].days;
      while (ptr[t] < ds.length && ds[ptr[t]][0] <= dt) { cum[t] += +ds[ptr[t]][1] || 0; ptr[t]++; }
    });
    keys.filter(function (t) { return pit[t].entryDay <= dt; })
      .sort(function (a, b) { return (cum[b] - cum[a]) || a.localeCompare(b); })
      .slice(0, n).forEach(function (t) { seen[t] = 1; });
  });
  return Object.keys(seen).map(function (t) { return { ticker: t, first_ts: pit[t].entryTs }; });
}

// A symbol Yahoo resolves to a different instrument shows up as a nearest bar
// far from the price recorded at entry; such a name is left out entirely.
function barsMatchEntry(b, ts, price) {
  if (!b || !b.length || !+price) return false;
  let near = null;
  b.forEach(function (x) { if (near == null || Math.abs(Date.parse(x.date) - ts) < Math.abs(Date.parse(near.date) - ts)) near = x; });
  const ratio = near.close / +price;
  return ratio >= 0.55 && ratio <= 1.8;
}

// Index level (100 at the start of the axis) with the basket and weights reset
// at every close from that day's running counts. Each day's return is earned on
// the weights set at the PREVIOUS close. Prices are forward-filled, so a missing
// bar holds a name at its last close; a day with nothing held is a day in cash.
// checkBars: the same series in the currency the entry price was recorded in
// (they differ when `bars` has been converted to USD).
function pitIndexVals(pit, dates, bars, method, rule, checkBars) {
  const keys = Object.keys(pit).filter(function (t) {
    return bars[t] && bars[t].length && barsMatchEntry((checkBars || bars)[t], pit[t].entryTs, pit[t].entryPrice);
  });
  const px = {};
  keys.forEach(function (t) { const m = {}; bars[t].forEach(function (b) { m[b.date] = b.close; }); px[t] = m; });
  const ptr = {}, cum = {}, last = {};
  keys.forEach(function (t) { ptr[t] = 0; cum[t] = 0; });
  const vals = [];
  let equity = 100, wPrev = null, pPrev = null, basket = [];
  dates.forEach(function (dt) {
    keys.forEach(function (t) {
      if (px[t][dt] != null) last[t] = px[t][dt];
      const ds = pit[t].days;
      while (ptr[t] < ds.length && ds[ptr[t]][0] <= dt) { cum[t] += +ds[ptr[t]][1] || 0; ptr[t]++; }
    });
    const prices = {};
    keys.forEach(function (t) { if (last[t] != null) prices[t] = last[t]; });
    if (wPrev) {
      let r = 0;
      for (const t in wPrev) {
        const p0 = pPrev[t], p1 = prices[t];
        if (p0 != null && p1 != null && p0 > 0) r += wPrev[t] * (p1 / p0 - 1);
      }
      equity *= (1 + r);
    }
    vals.push(equity);
    basket = keys.filter(function (t) { return pit[t].entryDay <= dt && prices[t] != null; })
      .sort(function (a, b) { return (cum[b] - cum[a]) || a.localeCompare(b); })
      .slice(0, 10);
    const held = basket.filter(function (t) { return rule === "all" || heldAt(pit[t].labels, Date.parse(dt) + 86399999, rule); });
    const w = {};
    if (held.length) {
      let tot = 0;
      held.forEach(function (t) { tot += cum[t]; });
      held.forEach(function (t) { w[t] = method === "equal" || !tot ? 1 / held.length : cum[t] / tot; });
    }
    wPrev = w; pPrev = prices;
  });
  return { vals: vals, weights: wPrev || {}, basket: basket, plotted: keys.length };
}

// ---------- third-party attention lists ----------
// Other sites publish their own "what is everyone looking at right now" list.
// Each one becomes an index by the same rule as the community line: hold that
// day's list, weighted by its share of whatever attention the list measures,
// rebalanced daily. A snapshot is read at 16:40 ET, after the close it would
// otherwise trade at, so the earliest close it can act on is the NEXT trading
// day's: snapshot D sets the weights at close D+1, which earn close D+1 -> D+2.
// Anything faster would trade on a list that did not exist yet at that close.
//
// weight: "views" = the source publishes a per-day magnitude (pageviews,
// mentions) that is a flow and turns into a share directly. "rank" = it
// publishes an ordering only, so weights decay as 1/rank. Stocktwits is ranked
// rather than counted on purpose: its watcher count is a running total, not a
// daily flow, so weighting by it would just tilt every basket towards whichever
// mega-cap happened to be trending.
const TREND_SOURCES = [
  { id: "stockanalysis", label: "StockAnalysis views", color: "#e0a33e", weight: "views",
    note: "stockanalysis.com/trending - pageviews on the site that day." },
  { id: "apewisdom", label: "Reddit mentions", color: "#ef6b5b", weight: "views",
    note: "apewisdom.io - mentions across the Reddit investing subs over 24h." },
  { id: "stocktwits", label: "Stocktwits trending", color: "#b07bff", weight: "rank",
    note: "Stocktwits trending symbols. Weighted by rank: its watcher count is a running total, not a daily flow." },
  { id: "yahoo", label: "Yahoo trending", color: "#3ec6a0", weight: "rank",
    note: "Yahoo Finance trending tickers. The list is rank-only, so weights decay by rank." },
  { id: "wikipedia", label: "Wikipedia pageviews", color: "#f28ec2", weight: "views",
    note: "Daily English Wikipedia pageviews of each company's article (UTC day), over the ~150 names the other lists carry. Brand-level attention: mega-caps lead. Has history, so it starts a few days before capture did." }
];
const TREND_DAYS = 180;       // history window pulled from the cloud
const TREND_TOP = 10;         // names held per list per day - same cap as the community basket
const TREND_STORED = 20;      // names pulled per list per day (the composition views and the crowd overlap)
const TREND_MAX_SYMBOLS = 50; // price fetches per list; see trendBasket

// A list ticker as Yahoo spells it: a one-letter class suffix is a dash there
// (BRK.B -> BRK-B), while a longer suffix is already a Yahoo exchange code
// (BNS.TO) and has to be left alone.
function trendYahooSym(t) { return String(t).toUpperCase().replace(/\.([A-Z])$/, "-$1"); }

// trending_daily() rows -> per source, days ascending, each {ticker: {views, rank}}.
// top: keep only names ranked at or above it that day.
function trendGroup(rows, top) {
  const by = {};
  (rows || []).forEach(function (r) {
    const w = {};
    Object.keys(r.weights || {}).forEach(function (t) {
      const v = r.weights[t] || [];
      const rank = +v[1] || 99;
      if (top && rank > top) return;
      w[trendYahooSym(t)] = { views: +v[0] || 0, rank: rank };
    });
    (by[r.source] || (by[r.source] = [])).push({ day: r.day, w: w });
  });
  Object.keys(by).forEach(function (s) {
    by[s].sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });
  });
  return by;
}

// Every name a list has ever held, with the first day it appeared - that is
// where its price history has to start. Capped, because the union grows with
// every day of history and each name costs one Yahoo request; the least-seen
// names go first (they carried the least weight) and the count is reported.
function trendBasket(days) {
  const seen = {};
  days.forEach(function (d) {
    Object.keys(d.w).forEach(function (t) {
      const e = seen[t] || (seen[t] = { ticker: t, first_ts: Date.parse(d.day + "T00:00:00Z"), n: 0 });
      e.n++;
    });
  });
  const all = Object.keys(seen).map(function (t) { return seen[t]; })
    .sort(function (a, b) { return (b.n - a.n) || a.ticker.localeCompare(b.ticker); });
  return { held: all.slice(0, TREND_MAX_SYMBOLS), dropped: Math.max(0, all.length - TREND_MAX_SYMBOLS) };
}

// Index level for one list over the shared date axis, starting at 100 on the
// first captured day. Dates before that are null: none of these sources keep
// history, so there is nothing to plot there and a flat 100 would be an
// invented one. Same compounding as pitIndexVals.
function trendIndexVals(days, dates, bars, method, mode) {
  const px = {};
  days.forEach(function (d) {
    Object.keys(d.w).forEach(function (t) {
      if (px[t] !== undefined) return;
      const b = bars[t];
      if (!b || !b.length) { px[t] = null; return; } // no Yahoo history: weighted out
      const m = {}; b.forEach(function (x) { m[x.date] = x.close; }); px[t] = m;
    });
  });
  const keys = Object.keys(px).filter(function (t) { return px[t]; });
  const weightsOn = function (d, prices) {
    const held = Object.keys(d.w).filter(function (t) { return prices[t] != null; });
    const w = {};
    if (!held.length) return w;
    const flat = function () { held.forEach(function (t) { w[t] = 1 / held.length; }); return w; };
    if (method === "equal") return flat();
    const raw = {}; let tot = 0;
    held.forEach(function (t) {
      const v = mode === "views" ? (d.w[t].views || 0) : 1 / Math.max(1, d.w[t].rank);
      raw[t] = v; tot += v;
    });
    if (!tot) return flat(); // a source that stopped reporting counts: don't divide by zero
    held.forEach(function (t) { w[t] = raw[t] / tot; });
    return w;
  };

  const first = days.length ? days[0].day : null;
  const last = {}, vals = [];
  let equity = 100, wPrev = null, pPrev = null, cur = null, di = 0;
  dates.forEach(function (dt) {
    if (first == null || dt < first) { vals.push(null); return; }
    keys.forEach(function (t) { if (px[t][dt] != null) last[t] = px[t][dt]; });
    const prices = {};
    keys.forEach(function (t) { if (last[t] != null) prices[t] = last[t]; });
    if (wPrev) {
      let r = 0;
      for (const t in wPrev) {
        const p0 = pPrev[t], p1 = prices[t];
        if (p0 != null && p1 != null && p0 > 0) r += wPrev[t] * (p1 / p0 - 1);
      }
      equity *= (1 + r);
    }
    vals.push(equity);
    // The newest snapshot taken strictly BEFORE this date (see the section
    // comment). Walked forward, since snapshots can fall on non-trading dates.
    while (di < days.length && days[di].day < dt) { cur = days[di]; di++; }
    wPrev = cur ? weightsOn(cur, prices) : null;
    pPrev = prices;
  });
  return { vals: vals, priced: keys.length };
}

// The third-party lists, loaded once per dashboard load (NET.trend = the top
// TREND_TOP each index holds, NET.trendAll = the TREND_STORED pulled per day,
// NET.trendTot = full-day totals). Shared by the index chart, the summary line,
// the composition views and the You vs the crowd chart; concurrent callers
// share one request.
let TREND_P = null;
function ensureTrendData() {
  if (NET.trend != null) return Promise.resolve();
  if (TREND_P) return TREND_P;
  TREND_P = (async function () {
    try { await ATCloud.captureTrending(); } catch (e) { /* read what is already stored */ }
    let trend = {}, all = {}, tot = {};
    try {
      const raw = await ATCloud.trendingDaily(TREND_DAYS, TREND_STORED);
      all = trendGroup(raw);
      trend = trendGroup(raw, TREND_TOP);
    }
    catch (e) { NET.trendErr = (e && e.message) || String(e); }
    // Optional: an older backend without the RPC falls back to summing the top names.
    try {
      (await ATCloud.trendingDayTotals(TREND_DAYS)).forEach(function (r) {
        (tot[r.source] || (tot[r.source] = {}))[r.day] = { names: +r.names || 0, views: +r.views || 0 };
      });
    } catch (e) { tot = {}; }
    // NET.trend last: it is the "loaded" flag the early return above reads.
    NET.trendAll = all; NET.trendTot = tot; NET.trend = trend;
  })();
  return TREND_P.finally(function () { TREND_P = null; });
}

// Which lines are drawn. null = nothing chosen yet, i.e. all of them.
let netSrcOn = null;
function netSrcEnabled(id) { return !netSrcOn || netSrcOn[id] !== false; }

function renderNetSrcToggles() {
  const el = document.getElementById("net-src");
  if (!el || el.getAttribute("data-built")) return;
  const items = [
    { id: "community", label: "Community index", color: "#4e9eff", note: "This app's users, by their own views." },
    { id: "mine", label: "Your index", color: "#2ecc71", note: "Your own attended stocks." },
    { id: "bench", label: "NASDAQ", color: "#8a93a6", note: "Buy-and-hold benchmark." }
  ].concat(TREND_SOURCES);
  el.innerHTML = "<span class=\"muted small\">Lines</span>" + items.map(function (it) {
    return "<label class=\"net-src-item\" title=\"" + escapeHtml(it.note || "") + "\">" +
      "<input type=\"checkbox\" data-src=\"" + it.id + "\"" + (netSrcEnabled(it.id) ? " checked" : "") + ">" +
      "<i style=\"background:" + it.color + "\"></i>" + escapeHtml(it.label) + "</label>";
  }).join("");
  el.setAttribute("data-built", "1");
  el.addEventListener("change", function (ev) {
    const cb = ev.target;
    const id = cb && cb.getAttribute && cb.getAttribute("data-src");
    if (!id) return;
    netSrcOn = netSrcOn || {};
    netSrcOn[id] = cb.checked;
    saveView();
    renderNetworkIndex(); // everything is cached on NET; this only redoes the maths
  });
}

async function renderNetworkIndex() {
  const cv = document.getElementById("net-index-canvas");
  const tbl = document.getElementById("net-index-table");
  const tip = document.getElementById("net-index-tip");
  const method = (document.getElementById("net-method") || {}).value || "attention";
  const rule = (document.getElementById("net-rule") || {}).value || "all";
  renderNetSrcToggles();
  try {
    // Third-party attention lists. Captured first: none of the sources keep
    // history, so a load that reads before capturing loses today's snapshot if
    // nothing else runs today. The edge function no-ops when it already has a
    // fresh one, so this costs one query on all but the first load of the hour.
    await ensureTrendData();
    renderTrendViews();
    const rows = NET.rows || (NET.rows = await ATCloud.networkCommunityIndex());
    // Point-in-time daily views and labels per ticker (see pitIndexVals).
    // Optional: an older backend without the RPC just has no community line.
    if (NET.daily == null) {
      try { NET.daily = await ATCloud.networkCommunityDaily(); } catch (e) { NET.daily = []; }
    }
    // Local copy of the same events the RPC aggregates. Built first because the
    // community side is re-based on it when there is only one contributor.
    const myByTicker = ATStore.byTicker((DATA && DATA.events) || []);
    const soleUser = rows.every(function (r) { return (+r.users || 1) <= 1; });

    // One contributor means the cloud rows describe THIS user's events - and the
    // RPC only sees what has been synced, so its view counts lag the local store.
    // Re-base the holdings table on the local copy; the index lines below are
    // built from the local copy too, for the same reason. With a real crowd the
    // RPCs stay authoritative.
    if (soleUser) {
      const have = {};
      rows.forEach(function (r) { have[r.ticker] = 1; });
      Object.keys(myByTicker).forEach(function (t) {
        if (have[t] || !myByTicker[t].some(function (e) { return e.priceAtEvent != null; })) return;
        rows.push({ ticker: t, users: 1, views: 0, first_ts: null, entry_price: null });
      });
      rows.forEach(function (r) {
        const evs = myByTicker[r.ticker];
        if (!evs || !evs.length) return;
        r.views = evs.reduce(function (s, e) { return s + (e.views || 1); }, 0);
        const priced = evs.find(function (e) { return e.priceAtEvent != null; });
        if (priced) { r.first_ts = priced.ts; r.entry_price = priced.priceAtEvent; }
      });
    }
    rows.sort(byWeightThenTicker);

    // Personal line: the signed-in user's own events, built by exactly the same
    // rules as the community line, so with a single contributor the two coincide.
    // Always from the daily `events` set, never from GROUPS: GROUPS follows the
    // Performance basis toggle.
    const minePit = pitFromEvents(myByTicker);
    const commPit = soleUser ? minePit : pitFromRpc(NET.daily);

    tip.textContent = "Pricing community holdings...";
    const live = await netLivePrices(rows.map(function (r) { return r.ticker; }));
    tip.textContent = "Loading price history...";
    // The enabled third-party lists price their names in the SAME call as the
    // two community baskets, so a symbol several lists hold is fetched once.
    const trend = TREND_SOURCES.filter(function (s) { return netSrcEnabled(s.id) && (NET.trend[s.id] || []).length; })
      .map(function (s) {
        const b = trendBasket(NET.trend[s.id]);
        return { src: s, days: NET.trend[s.id], held: b.held, dropped: b.dropped };
      });
    // Nothing ticked: say so, rather than pricing baskets nobody asked to see.
    if (!netSrcEnabled("community") && !netSrcEnabled("mine") && !netSrcEnabled("bench") &&
        !TREND_SOURCES.some(function (s) { return netSrcEnabled(s.id); })) {
      setupCanvas(cv); tip.textContent = "Every line is switched off."; renderTrendNote([]); return;
    }
    const cands = pitCandidates(commPit, 15).concat(soleUser ? [] : pitCandidates(minePit, 15));
    const bars = await loadIndexBars([cands].concat(trend.map(function (t) { return t.held; })),
      NET.bars || (NET.bars = {}));
    // Shared date axis = union of every candidate's and every list name's bars,
    // so all the lines line up column-for-column.
    const dset = {};
    cands.forEach(function (h) { (bars[h.ticker] || []).forEach(function (b) { dset[b.date] = 1; }); });
    trend.forEach(function (t) {
      t.held.forEach(function (h) { (bars[h.ticker] || []).forEach(function (b) { dset[b.date] = 1; }); });
    });
    const dates = Object.keys(dset).sort();
    if (!dates.length) { setupCanvas(cv); tip.textContent = "No price history available for the index line."; renderTrendNote([]); return; }
    // USD mode: every non-USD series is converted at the day's rate before any
    // return is taken. `bars` stays in local currency for the entry-price check,
    // which compares against a price recorded in that currency.
    let pbars = bars, ccyNote = "";
    if (ccyMode === "usd") {
      const need = {};
      Object.keys(bars).forEach(function (t) { if (bars[t] && bars[t].currency) need[bars[t].currency] = 1; });
      rows.forEach(function (r) { need[tickerCcy(r.ticker)] = 1; });
      await loadFx(Object.keys(need), isoDate(Date.parse(dates[0]) - 10 * 86400000));
      pbars = {};
      let conv = 0, lost = 0;
      Object.keys(bars).forEach(function (t) {
        pbars[t] = usdBars(bars[t]);
        if (bars[t] && bars[t].currency && bars[t].currency !== "USD") { if (pbars[t]) conv++; else lost++; }
      });
      ccyNote = " Returns in USD: " + conv + " non-USD " + (conv === 1 ? "listing" : "listings") + " converted at daily FX rates" +
        (lost ? ", " + lost + " left out for want of a rate" : "") + ".";
    } else {
      ccyNote = " Returns in each listing's local currency.";
    }
    // Return since the community's entry, marked to the CURRENT price, so this
    // column and the summary below are on the same footing as the chart lines.
    // In USD both ends are converted: entry at the entry day's rate, now at the latest.
    const today = isoDate(Date.now());
    const liveRet = function (r) {
      const p = live[r.ticker], e = +r.entry_price;
      if (p == null || !e) return null;
      if (ccyMode !== "usd") return (p - e) / e;
      const c = tickerCcy(r.ticker), f0 = fxAt(c, isoDate(+r.first_ts)), f1 = fxAt(c, today);
      return (f0 && f1) ? (p * f1) / (e * f0) - 1 : null;
    };
    let wsum = 0, wret = 0, eq = 0, eqn = 0, unpriced = 0;
    rows.forEach(function (r) {
      const rr = liveRet(r);
      if (rr == null) { unpriced++; return; } // no live quote: never silently counted as 0%
      wsum += +r.views; wret += +r.views * rr; eq += rr; eqn++;
    });
    const comm = pitIndexVals(commPit, dates, pbars, method, rule, bars);
    const mine = soleUser ? comm : pitIndexVals(minePit, dates, pbars, method, rule, bars);
    const commVals = comm.vals, mineVals = mine.vals;
    const hasComm = comm.plotted > 0, hasMine = mine.plotted > 0;
    const tw = comm.weights;
    // Holdings can be long: keep the table in a fixed-height scroll box.
    tbl.innerHTML = !rows.length ? "<div class='muted small'>No community holdings yet.</div>" :
      "<div class='net-index-scroll'><table class='an-table'><thead><tr><th>Stock</th>" +
      "<th title='Weight in the community index as of the latest close, under the selected weighting and holding rule. Names outside that day&#39;s top-10 basket are not held.'>Weight</th>" +
      "<th>Users</th><th>First community view</th>" +
      "<th title='Current price vs the price at the community&#39;s first view.'>Return since</th></tr></thead><tbody>" +
      rows.map(function (r) {
        const rr = liveRet(r);
        return "<tr><td><b>" + escapeHtml(r.ticker) + "</b></td><td>" + (tw[r.ticker] == null ? "-" : pct(tw[r.ticker])) + "</td><td>" + r.users +
          "</td><td class='muted'>" + isoDate(+r.first_ts) + "</td><td class='" + signClass(rr) + "'>" + (rr == null ? "-" : pct(rr)) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    NET.trendIdx = {}; // src id -> { date: level }, for the full-screen composition view
    trend.forEach(function (t) {
      const r = trendIndexVals(t.days, dates, pbars, method, t.src.weight);
      t.vals = r.vals; t.priced = r.priced;
      const m = NET.trendIdx[t.src.id] = {};
      dates.forEach(function (dt, i) { if (r.vals[i] != null) m[dt] = r.vals[i]; });
    });
    renderTrendViews();
    const step = Math.max(1, Math.ceil(dates.length / 8));
    const labels = dates.map(function (dt, i) { return i % step === 0 ? dt.slice(5) : ""; });
    const titles = dates.map(function (dt, i) {
      const parts = [];
      if (hasComm && netSrcEnabled("community")) parts.push("community " + commVals[i].toFixed(1));
      if (hasMine && netSrcEnabled("mine")) parts.push("you " + mineVals[i].toFixed(1));
      trend.forEach(function (t) { if (t.vals[i] != null) parts.push(t.src.label + " " + t.vals[i].toFixed(1)); });
      return dt + ": " + parts.join(" · ");
    });
    let benchVals = null;
    try {
      // Cached like the holdings' bars: toggling a line must not refetch it.
      // Keyed by start date - enabling a line can pull the axis further back,
      // and reusing bars that begin after it would read as a flat benchmark.
      const bFrom = isoDate(Date.parse(dates[0]) - 5 * 86400000);
      if (!NET.bench || NET.bench.from !== bFrom) NET.bench = { from: bFrom, bars: await ATPrices.fetchDaily("^IXIC", bFrom, true) };
      const nb = NET.bench.bars;
      const bm = {};
      (nb || []).forEach(function (b) { bm[b.date] = b.close; });
      let base = null, prev = 100;
      benchVals = dates.map(function (dt) {
        if (bm[dt] != null && base == null) base = bm[dt];
        const v = (bm[dt] != null && base) ? bm[dt] / base * 100 : null;
        if (v == null) return prev;
        prev = v; return v;
      });
    } catch (e) { benchVals = null; }
    const lines = [];
    if (hasComm && netSrcEnabled("community")) lines.push({ label: "Community index", color: "#4e9eff", vals: commVals });
    if (hasMine && netSrcEnabled("mine")) lines.push({ label: "Your index", color: "#2ecc71", vals: mineVals });
    if (benchVals && netSrcEnabled("bench")) lines.push({ label: "NASDAQ", color: "#8a93a6", vals: benchVals });
    trend.forEach(function (t) { lines.push({ label: t.src.label, color: t.src.color, vals: t.vals }); });
    if (!lines.length) { setupCanvas(cv); tip.textContent = "Every line is switched off."; renderTrendNote(trend); return; }
    drawLineCanvas(cv, "net-index-tip", lines, labels, titles);
    attachCanvasHover(cv);
    const myRet = hasMine ? " · your index: " + pct(mineVals[mineVals.length - 1] / 100 - 1) : "";
    tip.textContent = methodLabel(method) + ", " + holdingNote(rule) +
      " Community buy-and-hold at live prices, attention-weighted: " + (wsum ? pct(wret / wsum) : "-") +
      " · equal-weight: " + (eqn ? pct(eq / eqn) : "-") + myRet +
      " · basket at the latest close: " + (comm.basket.length ? comm.basket.join(", ") : "none") +
      (unpriced ? " · " + unpriced + " with no live quote, excluded" : "") + "." + ccyNote;
    renderTrendNote(trend);
  } catch (e) { setupCanvas(cv); tip.textContent = "Error: " + (e && e.message || e); }
}

// One line per third-party list under the chart: how much history exists, how
// much of it could be priced, and where the line stands. A list that is ticked
// but draws nothing is called out rather than left as a silent gap.
function renderTrendNote(trend) {
  const el = document.getElementById("net-src-note");
  if (!el) return;
  const parts = trend.map(function (t) {
    const v = (t.vals || []).filter(function (x) { return x != null; });
    // One captured day is a starting value, not a line: say so instead of
    // printing a 0.0% that reads as "the crowd went nowhere".
    const ret = v.length > 1 ? " · <span class='" + signClass(v[v.length - 1] - 100) + "'>" + pct(v[v.length - 1] / 100 - 1) + "</span>"
      : " · needs a second captured day before the line can move";
    return "<div><i style=\"background:" + t.src.color + "\"></i><b>" + escapeHtml(t.src.label) + "</b> " +
      escapeHtml(t.src.note) + " " + t.days.length + (t.days.length === 1 ? " day" : " days") +
      " tracked (from " + escapeHtml(t.days[0].day) + ") · " + t.priced + " names priced" +
      (t.dropped ? " · " + t.dropped + " rarely-listed names left out" : "") + ret + "</div>";
  });
  const missing = TREND_SOURCES.filter(function (s) { return netSrcEnabled(s.id) && !((NET.trend || {})[s.id] || []).length; });
  if (missing.length) parts.push("<div>Nothing captured yet for " +
    missing.map(function (s) { return escapeHtml(s.label); }).join(", ") +
    ". None of these lists publish history, so each one starts on the first day it is captured.</div>");
  if (NET.trendErr) parts.push("<div>Attention lists unavailable: " + escapeHtml(NET.trendErr) + "</div>");
  el.innerHTML = parts.join("");
}

// Summary line for the composition section (StockAnalysis sample of the latest
// day) and the default composition day: the newest day any list was captured.
function renderTrendViews() {
  const tip = document.getElementById("net-sa-tip");
  if (!tip) return;
  const tot = (NET.trendTot || {}).stockanalysis || {};
  const sa = (NET.trendAll || {}).stockanalysis || [];
  const days = trendCompDays();
  if (!days.length) {
    tip.textContent = NET.trendErr ? "Unavailable: " + NET.trendErr : "Nothing captured yet.";
    renderTrendComp();
    return;
  }
  if (!NET.saDay || days.indexOf(NET.saDay) < 0) NET.saDay = days[0];
  const last = sa[sa.length - 1], t = last && tot[last.day];
  tip.textContent = days.length + (days.length === 1 ? " day" : " days") + " captured, from " + days[days.length - 1] + "." +
    (t ? " StockAnalysis on " + last.day + ": " + t.views.toLocaleString() + " views across " + t.names + " stocks." : "");
  renderTrendComp();
}

// Every day at least one list was captured, newest first.
function trendCompDays() {
  const set = {};
  TREND_SOURCES.forEach(function (s) { ((NET.trend || {})[s.id] || []).forEach(function (d) { set[d.day] = 1; }); });
  return Object.keys(set).sort().reverse();
}

// One list's index weights on one snapshot day, as trendIndexVals weights it
// (same method and mode; names with no Yahoo history dropped and the rest
// renormalised). names = every listed name by rank; w has only the priced ones.
function trendDayWeights(s, d, method) {
  const bars = NET.bars || {};
  const names = Object.keys(d.w).sort(function (a, b) { return d.w[a].rank - d.w[b].rank; });
  const priced = names.filter(function (t) { return bars[t] !== null; }); // undefined = not fetched yet, counted
  const raw = {}; let tot = 0;
  priced.forEach(function (t) {
    raw[t] = method === "equal" ? 1 : (s.weight === "views" ? (d.w[t].views || 0) : 1 / Math.max(1, d.w[t].rank));
    tot += raw[t];
  });
  const w = {};
  priced.forEach(function (t) { w[t] = tot ? raw[t] / tot : 1 / priced.length; });
  return { names: names, w: w };
}

// What every attention index held on the selected day, one column per list.
function renderTrendComp() {
  const el = document.getElementById("net-sa-comp");
  if (!el) return;
  const day = NET.saDay;
  if (!day) { el.innerHTML = ""; return; }
  const method = (document.getElementById("net-method") || {}).value || "attention";
  const cols = TREND_SOURCES.map(function (s) {
    const list = (NET.trend || {})[s.id] || [];
    const i = list.findIndex(function (d) { return d.day === day; });
    const head = "<div class='net-sa-src'><div class='net-sa-src-h'><i style='background:" + s.color + "'></i>" + escapeHtml(s.label) + "</div>";
    if (i < 0) return head + "<div class='muted small'>Not captured on this day.</div></div>";
    const d = list[i];
    const dw = trendDayWeights(s, d, method);
    return head + "<table class='an-table net-sa-comp-t'><thead><tr><th>#</th><th>Stock</th><th>Weight</th></tr></thead><tbody>" +
      dw.names.map(function (t) {
        const w = dw.w[t];
        return "<tr" + (w == null ? " class='muted' title='No Yahoo price history: left out, the rest re-weighted'" : "") + "><td>" + d.w[t].rank +
          "</td><td><b>" + escapeHtml(t) + "</b></td><td>" + (w == null ? "no price" : pct(w)) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  });
  el.innerHTML = "<div class='net-sa-comp-h'>Index composition on <select id='net-comp-day' class='span-sel' title='Captured day'>" +
    trendCompDays().map(function (dd) { return "<option" + (dd === day ? " selected" : "") + ">" + escapeHtml(dd) + "</option>"; }).join("") +
    "</select> <span class='muted small'>(" + escapeHtml(methodLabel(method)) + ")</span>" +
    " <button type='button' class='navbtn' id='net-comp-full' title='Every captured day of every list, with sample sizes and a CSV download'>&#10530; Full screen</button></div>" +
    "<div class='net-sa-comp-grid'>" + cols.join("") + "</div>";
}

// Full-screen composition history: one list at a time (tabs), stocks x captured
// days, newest first. Header rows carry the sample behind each day (names the
// site listed, total views, names the index held and could price) and the
// index level; cells are the index weight or, for the two view-counting lists,
// optionally the share of that day's total views - the same matrix design as the
// StockAnalysis views table. The CSV holds every list, day and name.
const COMP = { src: "stockanalysis", show: "weight" };
function compHistory(s, method) {
  const list = (NET.trendAll || {})[s.id] || [];
  const held = {};
  ((NET.trend || {})[s.id] || []).forEach(function (d) { held[d.day] = d; });
  const tot = (NET.trendTot || {})[s.id] || {};
  const idx = (NET.trendIdx || {})[s.id] || {};
  const idxAt = function (day) { let v = null; Object.keys(idx).forEach(function (dt) { if (dt <= day) v = idx[dt]; }); return v; };
  return list.slice().reverse().map(function (d) {
    const h = held[d.day];
    const dw = h ? trendDayWeights(s, h, method) : { names: [], w: {} };
    const sum = Object.keys(d.w).reduce(function (a, t) { return a + (d.w[t].views || 0); }, 0);
    const t = tot[d.day];
    return {
      day: d.day, all: d.w, heldNames: dw.names, w: dw.w,
      listed: t ? t.names : Object.keys(d.w).length, views: t ? t.views : sum,
      held: dw.names.length, priced: Object.keys(dw.w).length, level: idxAt(d.day)
    };
  });
}

function openCompFull() {
  const ov = document.createElement("div");
  ov.className = "wc-full";
  ov.innerHTML = "<div class='wc-full-box comp-full'><div class='wc-full-head'><strong>Index composition over time</strong>" +
    "<div class='comp-full-ctl'><button type='button' class='navbtn' id='comp-csv' title='Every list, every captured day, every stored name: rank, views, share, index weight, whether it was held and priced, the day&#39;s sample size and the index level.'>&#11015; Download CSV</button>" +
    "<button type='button' class='mm-x' title='Close (Esc)'>&times;</button></div></div>" +
    "<div class='comp-full-bar'><div class='seg' id='comp-src'></div><div class='seg' id='comp-show'></div><span class='muted small' id='comp-csv-msg'></span></div>" +
    "<div id='comp-sum' class='usage-cards'></div><div id='comp-body' class='comp-full-body'></div></div>";
  document.body.appendChild(ov);
  function close() { document.removeEventListener("keydown", onKey); ov.remove(); }
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
  ov.querySelector(".mm-x").addEventListener("click", close);
  ov.querySelector("#comp-src").addEventListener("click", function (e) {
    const b = e.target.closest("button[data-src]"); if (!b) return;
    COMP.src = b.getAttribute("data-src"); draw();
  });
  ov.querySelector("#comp-show").addEventListener("click", function (e) {
    const b = e.target.closest("button[data-show]"); if (!b) return;
    COMP.show = b.getAttribute("data-show"); draw();
  });
  ov.querySelector("#comp-csv").addEventListener("click", compCsv);

  function draw() {
    const method = (document.getElementById("net-method") || {}).value || "attention";
    const s = TREND_SOURCES.find(function (x) { return x.id === COMP.src; }) || TREND_SOURCES[0];
    const views = s.weight === "views";
    const show = views ? COMP.show : "weight";
    ov.querySelector("#comp-src").innerHTML = TREND_SOURCES.map(function (x) {
      return "<button data-src='" + x.id + "'" + (x.id === s.id ? " class='on'" : "") + "><i class='comp-sw' style='background:" + x.color + "'></i>" + escapeHtml(x.label) + "</button>";
    }).join("");
    ov.querySelector("#comp-show").innerHTML = views
      ? "<button data-show='weight'" + (show === "weight" ? " class='on'" : "") + " title='Index weight under the selected Weighting'>Index weight</button>" +
        "<button data-show='share'" + (show === "share" ? " class='on'" : "") + " title='Share of every view the site counted that day (all stored names, not just the ones the index holds)'>Share of views</button>"
      : "";
    ov.querySelector("#comp-show").hidden = !views;
    const rows = compHistory(s, method);
    const sum = ov.querySelector("#comp-sum"), body = ov.querySelector("#comp-body");
    if (!rows.length) {
      sum.innerHTML = "";
      body.innerHTML = "<div class='muted'>Nothing captured yet for " + escapeHtml(s.label) + ".</div>";
      return;
    }
    const ever = {}, heldDays = {};
    rows.forEach(function (r) {
      r.heldNames.forEach(function (t) { ever[t] = 1; heldDays[t] = (heldDays[t] || 0) + 1; });
      if (show === "share") Object.keys(r.all).forEach(function (t) { ever[t] = 1; });
    });
    const avg = function (f) { return rows.reduce(function (a, r) { return a + f(r); }, 0) / rows.length; };
    const lv = rows.filter(function (r) { return r.level != null; });
    const card = function (v, l, tip) { return "<div class='stat' title='" + escapeHtml(tip) + "'><b>" + v + "</b>" + escapeHtml(l) + "</div>"; };
    sum.innerHTML =
      card(rows.length, "days captured", "Snapshots stored, " + rows[rows.length - 1].day + " to " + rows[0].day + ".") +
      card(Math.round(avg(function (r) { return r.listed; })).toLocaleString(), "names listed / day", "Average number of stocks the source listed per captured day - the sample each day's list is drawn from.") +
      (views ? card(Math.round(avg(function (r) { return r.views; })).toLocaleString(), "views / day", "Average total " + (s.id === "apewisdom" ? "mentions" : "pageviews") + " the source counted per day.") : "") +
      card(avg(function (r) { return r.held; }).toFixed(1), "names held / day", "Average names in the index (top " + TREND_TOP + ").") +
      card(avg(function (r) { return r.priced; }).toFixed(1), "names priced / day", "Average held names with a Yahoo price history; the others are left out and the rest re-weighted.") +
      card(Object.keys(heldDays).length, "names ever held", "Distinct stocks the index has held on any captured day.") +
      card(lv.length > 1 ? pct(lv[0].level / 100 - 1) : "-", "index return", lv.length > 1 ? "Level " + lv[0].level.toFixed(1) + " on " + lv[0].day + " (100 = first captured day)." : "Needs the index line on the chart (ticked) and two captured days.");
    const stocks = Object.keys(ever).sort(function (a, b) {
      return ((heldDays[b] || 0) - (heldDays[a] || 0)) || a.localeCompare(b);
    });
    const tr = function (label, tip, f) {
      return "<tr class='net-sa-total'><td title='" + escapeHtml(tip) + "'>" + label + "</td>" + rows.map(function (r) { return "<td>" + f(r) + "</td>"; }).join("") + "</tr>";
    };
    body.innerHTML = "<div class='net-index-scroll net-sa-scroll comp-full-scroll'><table class='an-table'><thead><tr><th>Stock</th>" +
      rows.map(function (r) { return "<th>" + escapeHtml(r.day) + "</th>"; }).join("") + "</tr></thead><tbody>" +
      tr("Names listed", "Stocks the source listed that day (the sample).", function (r) { return r.listed.toLocaleString(); }) +
      (views ? tr("Total views", "Views / mentions the source counted that day across every listed stock.", function (r) { return r.views.toLocaleString(); }) : "") +
      tr("Held / priced", "Names in the index that day / of those, names with a Yahoo price.", function (r) { return r.held + " / " + r.priced; }) +
      tr("Index", "Index level on the chart (100 = first captured day), under the selected Weighting.", function (r) { return r.level == null ? "-" : r.level.toFixed(1); }) +
      stocks.map(function (t) {
        return "<tr><td title='Held on " + (heldDays[t] || 0) + " of " + rows.length + " captured days'><b>" + escapeHtml(t) + "</b></td>" +
          rows.map(function (r) {
            const e = r.all[t];
            if (show === "share") {
              if (!e) return "<td class='muted'>-</td>";
              return "<td title='" + (e.views || 0).toLocaleString() + " views, rank " + e.rank + "'>" + pct(r.views ? (e.views || 0) / r.views : 0) + "</td>";
            }
            if (r.heldNames.indexOf(t) < 0) return "<td class='muted'>-</td>";
            const w = r.w[t];
            return "<td" + (w == null ? " class='muted'" : "") + " title='Rank " + e.rank + (views ? ", " + (e.views || 0).toLocaleString() + " views" : "") +
              (w == null ? " - no Yahoo price, left out" : "") + "'>" + (w == null ? "no price" : pct(w)) + "</td>";
          }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>" +
      "<div class='muted small'>" + escapeHtml(s.note) + " " + escapeHtml(methodLabel(method)) + " weighting. " +
      "Each day's list is read after that day's US close and first trades at the next trading close.</div>";
  }
  draw();
}

function compCsv() {
  const msg = document.getElementById("comp-csv-msg");
  const method = (document.getElementById("net-method") || {}).value || "attention";
  const cols = ["source", "day", "rank", "ticker", "views", "share_of_day_views", "held", "priced", "index_weight",
    "names_listed", "day_total_views", "index_level", "weighting"];
  const q = csvCell;
  const lines = [cols.join(",")];
  TREND_SOURCES.forEach(function (s) {
    compHistory(s, method).slice().reverse().forEach(function (r) {
      Object.keys(r.all).sort(function (a, b) { return r.all[a].rank - r.all[b].rank; }).forEach(function (t) {
        const e = r.all[t], held = r.heldNames.indexOf(t) >= 0;
        lines.push([s.id, r.day, e.rank, t, e.views || 0, r.views ? ((e.views || 0) / r.views).toFixed(6) : "",
          held ? 1 : 0, held ? (r.w[t] != null ? 1 : 0) : "", r.w[t] != null ? r.w[t].toFixed(6) : "",
          r.listed, r.views, r.level == null ? "" : r.level.toFixed(4), method].map(q).join(","));
      });
    });
  });
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url; a.download = "index_composition_" + isoDate(Date.now()).replace(/-/g, "") + ".csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  if (msg) msg.textContent = (lines.length - 1).toLocaleString() + " rows exported (top " + TREND_STORED + " stored names per list per day; the full StockAnalysis list is the other download).";
}

document.getElementById("net-sa-comp").addEventListener("click", function (ev) {
  if (ev.target.closest && ev.target.closest("#net-comp-full")) openCompFull();
});
document.getElementById("net-sa-comp").addEventListener("change", function (ev) {
  if (ev.target.id !== "net-comp-day") return;
  NET.saDay = ev.target.value;
  renderTrendComp();
});


document.getElementById("net-sa-csv").addEventListener("click", async function () {
  const msg = document.getElementById("net-sa-csv-msg");
  msg.textContent = "Collecting rows...";
  try {
    const rows = await ATCloud.trendingRows("stockanalysis");
    const cols = ["day", "rank", "ticker", "views", "captured_at"];
    const lines = [cols.join(",")];
    rows.forEach(function (r) { lines.push(cols.map(function (c) { return csvCell(r[c]); }).join(",")); });
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "stockanalysis_views_" + isoDate(Date.now()).replace(/-/g, "") + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    msg.textContent = rows.length.toLocaleString() + " rows exported.";
  } catch (e) { msg.textContent = "Export failed: " + (e && e.message || e); }
});

// Daily bars for every symbol either index basket needs, fetched ONCE each.
// ATPrices.fetchDaily has no cache, so loading the two baskets separately fired
// an independent Yahoo request per symbol per basket - the same ten symbols
// twice for a sole user. Yahoo rate-limits bursts, and a duplicate that came
// back 429 silently dropped that holding from ONE line: identical baskets, two
// different lines, and which line lost a name changed on every reload. Each
// symbol is fetched from the earliest entry that needs it; bars before a
// basket's own entry are inert, since heldOn() holds nothing until then.
// `cache` is a ticker -> bars map kept across renders (NET.bars): the third-party
// lists add tens of symbols, and re-fetching all of them every time a line is
// toggled would be both slow and a good way to get rate-limited. A symbol that
// failed is cached as null so it is not retried on every toggle either, and every
// reader here already treats a missing/empty bar list as "not plotted".
async function loadIndexBars(baskets, cache) {
  const from = {}; // ticker -> earliest first_ts across the baskets
  (baskets || []).forEach(function (hs) {
    (hs || []).forEach(function (r) {
      const ts = +r.first_ts;
      if (from[r.ticker] == null || ts < from[r.ticker]) from[r.ticker] = ts;
    });
  });
  const bars = cache || {};
  let todo = Object.keys(from).filter(function (t) { return bars[t] === undefined; });
  // In batches: Yahoo answers a burst of a hundred symbols with 429s, and a 429
  // silently costs that name its line. A name Yahoo answered with no history is
  // cached as null (not resolvable); a request that FAILED (429, network) gets
  // one retry after a pause and is otherwise left uncached, so the next render
  // asks again instead of the name staying lost for the whole session.
  for (let pass = 0; pass < 2 && todo.length; pass++) {
    if (pass) await new Promise(function (r) { setTimeout(r, 1500); });
    const failed = [];
    for (let i = 0; i < todo.length; i += 8) {
      await Promise.all(todo.slice(i, i + 8).map(async function (t) {
        try {
          const ov = DATA && DATA.overrides && DATA.overrides[t]; // ticker -> Yahoo symbol
          const b = await ATPrices.fetchDaily(ov || t, isoDate(from[t] - 5 * 86400000), !!ov);
          bars[t] = (b && b.length) ? b : null;
        } catch (e) { failed.push(t); }
      }));
    }
    todo = failed;
  }
  return bars;
}

async function renderNetwork() {
  // Render once per load - but a canvas drawn while its tab or sub-view was
  // hidden is 0-size and blank: render again when one of them is now visible.
  const blank = Array.prototype.some.call(document.querySelectorAll("#main-network canvas:not(#net-crowd-canvas)"), function (c) {
    return c.offsetParent && c.width <= 10;
  });
  if (NET.loading || (NET.rendered && !blank)) return;
  NET.loading = true;
  try { await Promise.all([renderNetworkPercentiles(), renderNetworkIndex()]); NET.rendered = true; }
  finally { NET.loading = false; }
}

// Weighting/holding switches: the community rows and label timeline are cached
// on NET, so a switch only re-runs the index maths (and the cached price fetch).
["net-method", "net-rule"].forEach(function (id) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", function () { saveView(); renderNetworkIndex(); });
});

// ---------- predictions (label + target price + horizon) ----------
// A prediction is a Positive/Negative label carrying a horizon: "this reaches my
// target within N days". Two independent scores: DIRECTION (did it move the way
// you called it by the judging moment) and TARGET (did it actually reach the
// price in time). Prices come from the always-daily DAILY series, so the horizon
// is judged on closes regardless of the chart resolution.

const PRED = { filter: "open", loading: false, refreshing: false, rows: [] };

const PRED_BUCKETS = [
  { max: 7, label: "<=1w" }, { max: 31, label: "<=1m" }, { max: 93, label: "<=3m" },
  { max: 186, label: "<=6m" }, { max: Infinity, label: ">6m" }
];
function predBucket(days) {
  for (let i = 0; i < PRED_BUCKETS.length; i++) if (days <= PRED_BUCKETS[i].max) return PRED_BUCKETS[i].label;
  return PRED_BUCKETS[PRED_BUCKETS.length - 1].label;
}

// Last close at or before `time` in a [{date, close}] series (DAILY / BENCH).
function closeOnOrBefore(series, time) {
  let res = null;
  for (let i = 0; i < series.length; i++) {
    if (Date.parse(series[i].date) > time) break;
    res = series[i].close;
  }
  return res;
}

// A prediction is a Positive/Negative call with a horizon, a target price, or both.
// With a target but no horizon it has no deadline ("open-ended"): it can only end
// in a hit, so it is listed but kept out of the accuracy numbers.
function isPredictionCall(e) {
  return (e.horizonDays != null || e.targetPrice != null) && (e.sentiment === "positive" || e.sentiment === "negative");
}

function predictionTickers() {
  return Object.keys(GROUPS).filter(function (t) { return GROUPS[t].some(isPredictionCall); });
}

function buildPredictions() {
  const now = Date.now();
  const rows = [];
  predictionTickers().forEach(function (t) {
    const series = DAILY[t] || [];
    const q = QUOTES[t];
    const live = q ? q.close : null;
    GROUPS[t].forEach(function (e) {
      if (!isPredictionCall(e)) return;
      const openEnded = e.horizonDays == null;
      const dir = e.sentiment === "positive" ? 1 : -1;
      let entry = e.priceAtEvent;
      if (entry == null && series.length) {
        const i0 = firstSeriesIndexAtOrAfter(series, e.ts);
        entry = i0 >= 0 ? series[i0].close : null;
      }
      if (!entry) return;
      const deadline = openEnded ? null : e.ts + e.horizonDays * 86400000;
      const done = !openEnded && now >= deadline;
      let target = e.targetPrice != null ? e.targetPrice : null;
      let required = target != null ? (target - entry) / entry : null;
      // A target on the wrong side of the call makes the progress math meaningless,
      // so it is dropped from the target scoring (the direction call still counts).
      const badTarget = required != null && required * dir <= 0;
      if (badTarget) { target = null; required = null; }
      if (openEnded && target == null) return; // no deadline and no usable target: nothing to score

      // First close (or the live quote) that reached the target inside the window.
      let touchTs = null, touchPx = null;
      if (target != null) {
        const cap = openEnded ? now : Math.min(deadline, now);
        for (let i = 0; i < series.length; i++) {
          const d = Date.parse(series[i].date);
          if (d < e.ts) continue;
          if (d > cap) break;
          if (dir > 0 ? series[i].close >= target : series[i].close <= target) { touchTs = d; touchPx = series[i].close; break; }
        }
        if (touchTs == null && !done && live != null && (dir > 0 ? live >= target : live <= target)) { touchTs = now; touchPx = live; }
      }

      // Judging price: the touch close if the target was reached, else the
      // deadline close once the deadline has passed, else the live price.
      let endPx = touchPx;
      if (endPx == null) endPx = done ? closeOnOrBefore(series, deadline) : live;
      if (endPx == null) endPx = live != null ? live : closeOnOrBefore(series, now);
      if (endPx == null) return;
      const realized = (endPx - entry) / entry;
      const judgeTs = touchTs != null ? touchTs : (openEnded ? now : Math.min(now, deadline));

      // NASDAQ over the same window, so the call can be compared to just holding.
      let bench = null;
      if (BENCH && BENCH.length) {
        const b0 = closeOnOrBefore(BENCH, e.ts), b1 = closeOnOrBefore(BENCH, judgeTs);
        if (b0 && b1) bench = (b1 - b0) / b0;
      }

      rows.push({
        id: e.id, ticker: t, ts: e.ts, deadline: deadline, horizonDays: e.horizonDays,
        sentiment: e.sentiment, entry: entry, target: target, required: required, badTarget: badTarget,
        endPx: endPx, realized: realized, signed: realized * dir,
        alpha: bench == null ? null : (realized - bench) * dir,
        progress: required ? realized / required : null,
        timeProg: openEnded ? null : Math.max(0, Math.min(1, (judgeTs - e.ts) / Math.max(1, deadline - e.ts))),
        touchTs: touchTs, openEnded: openEnded,
        timeUsed: touchTs == null || openEnded ? null : Math.max(0, Math.min(1, (touchTs - e.ts) / Math.max(1, deadline - e.ts))),
        status: touchTs != null ? "hit" : (done ? "expired" : "open"),
        resolvedAt: touchTs != null ? touchTs : (done ? deadline : null),
        correct: realized * dir > 0,
        rationale: e.rationale || null
      });
    });
  });
  // Calls with a deadline first, soonest first; open-ended ones after, newest first.
  rows.sort(function (a, b) { return (a.openEnded ? 1 : 0) - (b.openEnded ? 1 : 0) || (a.openEnded ? b.ts - a.ts : a.deadline - b.deadline); });
  return rows;
}

function predStats(all) {
  const rows = all.filter(function (r) { return !r.openEnded; });
  const oe = all.filter(function (r) { return r.openEnded; });
  const open = rows.filter(function (r) { return r.status === "open"; });
  const resolved = rows.filter(function (r) { return r.status !== "open"; });
  const withTarget = resolved.filter(function (r) { return r.required != null; });
  const hits = withTarget.filter(function (r) { return r.status === "hit"; });
  let brier = null;
  if (resolved.length) {
    let s = 0;
    resolved.forEach(function (r) {
      const p = r.sentiment === "positive" ? 0.85 : 0.15, o = r.correct ? 1 : 0;
      s += (p - o) * (p - o);
    });
    brier = s / resolved.length;
  }
  const alphas = resolved.map(function (r) { return r.alpha; }).filter(function (v) { return v != null; });
  const missed = withTarget.filter(function (r) { return r.status === "expired"; }).map(function (r) { return r.progress; });
  const used = hits.map(function (r) { return r.timeUsed; }).sort(function (a, b) { return a - b; });
  const week = Date.now() + 7 * 86400000;
  return {
    oeN: oe.length, oeHit: oe.filter(function (r) { return r.status === "hit"; }).length,
    open: open.length,
    dueSoon: open.filter(function (r) { return r.deadline <= week; }).length,
    resolved: resolved.length,
    dirHit: resolved.length ? resolved.filter(function (r) { return r.correct; }).length / resolved.length : null,
    tgtHit: withTarget.length ? hits.length / withTarget.length : null,
    tgtN: withTarget.length,
    brier: brier,
    alpha: alphas.length ? avg(alphas) : null,
    missProgress: missed.length ? avg(missed) : null,
    medUsed: used.length ? used[Math.floor((used.length - 1) / 2)] : null
  };
}

function renderPredCards(rows) {
  const s = predStats(rows);
  const el = document.getElementById("pred-cards");
  el.innerHTML = "";
  addStat(el, "Open", String(s.open), "Predictions whose deadline has not passed and whose target has not been reached yet.");
  addStat(el, "Due within 7d", String(s.dueSoon), "Open predictions whose deadline falls in the next seven days.");
  addStat(el, "Resolved", String(s.resolved), "Predictions that reached their target or ran past their deadline.");
  addStat(el, "Direction hit rate", s.dirHit == null ? "-" : pct(s.dirHit),
    "Share of resolved predictions where the price moved the way you called it, measured at the target touch or at the deadline.");
  addStat(el, "Target hit rate", s.tgtHit == null ? "-" : pct(s.tgtHit) + " (" + s.tgtN + ")",
    "Share of resolved predictions that carried a usable target price and actually reached it before the deadline.");
  addStat(el, "Progress when missed", s.missProgress == null ? "-" : pct(s.missProgress),
    "On predictions that expired without reaching the target: how much of the required move was actually made. Negative means it went the other way.");
  addStat(el, "Median time used", s.medUsed == null ? "-" : pct(s.medUsed),
    "On targets that were reached: the median share of the horizon that had elapsed. Well under 50% means your horizons are longer than they need to be.");
  addStat(el, "Brier score", s.brier == null ? "-" : s.brier.toFixed(3),
    BRIER_HELP);
  addStat(el, "Edge vs NASDAQ", s.alpha == null ? "-" : pct(s.alpha),
    "Average return of the call minus NASDAQ over the same window, signed by the call direction. Above 0 = the calls beat simply holding the index.");
  if (s.oeN) addStat(el, "Target-only calls", s.oeN + " (" + s.oeHit + " reached)",
    "Calls with a target price but no horizon. They have no deadline, so they can only end in a hit; they are listed below but kept out of the accuracy numbers, which would otherwise count only their wins.");
}

function renderPredPace(rows) {
  const cv = document.getElementById("pred-pace-canvas"), tip = document.getElementById("pred-pace-tip");
  if (!cv) return;
  const pts = rows.filter(function (r) { return r.status === "open" && r.progress != null && !r.openEnded; }).map(function (r) {
    return {
      x: r.timeProg, y: r.progress,
      color: r.sentiment === "positive" ? "#2ecc71" : "#e74c3c",
      title: "<b>" + escapeHtml(nameOf(r.ticker)) + "</b><br>" + r.sentiment + " &rarr; " + r.target.toFixed(2) +
        " by " + isoDate(r.deadline) + "<br>" + Math.round(r.progress * 100) + "% of the move, " +
        Math.round(r.timeProg * 100) + "% of the time"
    };
  });
  if (!pts.length) { clearAnCanvas(cv); if (tip) tip.textContent = "No open predictions with a target price."; return; }
  if (tip) tip.textContent = "";
  drawScatterCanvas(cv, "pred-pace-tip", pts);
  attachCanvasHover(cv);
}

function renderPredHorizon(rows) {
  const cv = document.getElementById("pred-horizon-canvas"), tip = document.getElementById("pred-horizon-tip");
  if (!cv) return;
  const resolved = rows.filter(function (r) { return r.status !== "open" && !r.openEnded; });
  if (!resolved.length) { clearAnCanvas(cv); if (tip) tip.textContent = "No resolved predictions yet."; return; }
  if (tip) tip.textContent = "";
  const vals = [], labels = [], titles = [];
  PRED_BUCKETS.forEach(function (b) {
    const inB = resolved.filter(function (r) { return predBucket(r.horizonDays) === b.label; });
    if (!inB.length) return;
    const hr = inB.filter(function (r) { return r.correct; }).length / inB.length;
    vals.push(Math.round(hr * 1000) / 10);
    labels.push(b.label);
    titles.push(b.label + " horizon: " + pct(hr) + " of " + inB.length + " resolved");
  });
  vals.push(50); labels.push("Coin"); titles.push("Coin-flip baseline: 50%");
  drawBarCanvas(cv, "pred-horizon-tip", vals, labels, titles);
  attachCanvasHover(cv);
}

function renderPredCurve(rows) {
  const cv = document.getElementById("pred-curve-canvas"), tip = document.getElementById("pred-curve-tip");
  if (!cv) return;
  const res = rows.filter(function (r) { return r.status !== "open" && !r.openEnded; })
    .slice().sort(function (a, b) { return a.resolvedAt - b.resolvedAt; });
  if (res.length < 2) { clearAnCanvas(cv); if (tip) tip.textContent = "Needs at least two resolved predictions."; return; }
  if (tip) tip.textContent = "";
  const vals = [], base = [], labels = [], titles = [];
  let ok = 0;
  res.forEach(function (r, i) {
    if (r.correct) ok++;
    vals.push(Math.round((ok / (i + 1)) * 1000) / 10);
    base.push(50);
    labels.push((i === 0 || i === res.length - 1) ? isoDate(r.resolvedAt) : "");
    titles.push(isoDate(r.resolvedAt) + " " + nameOf(r.ticker) + " " + (r.correct ? "correct" : "wrong") +
      " - running " + pct(ok / (i + 1)) + " over " + (i + 1));
  });
  drawLineCanvas(cv, "pred-curve-tip", [
    { label: "Hit rate %", color: "#4e9eff", vals: vals },
    { label: "Coin flip", color: "#6b7590", vals: base }
  ], labels, titles);
  attachCanvasHover(cv);
}

function renderPredTiming(rows) {
  const cv = document.getElementById("pred-timing-canvas"), tip = document.getElementById("pred-timing-tip");
  if (!cv) return;
  const hits = rows.filter(function (r) { return r.status === "hit" && r.timeUsed != null; });
  if (!hits.length) { clearAnCanvas(cv); if (tip) tip.textContent = "No targets reached yet."; return; }
  if (tip) tip.textContent = "";
  const bins = [0, 0, 0, 0, 0];
  hits.forEach(function (r) { bins[Math.min(4, Math.floor(r.timeUsed * 5))]++; });
  const labels = ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%"];
  drawBarCanvas(cv, "pred-timing-tip", bins, labels, labels.map(function (l, i) {
    return bins[i] + " target(s) reached within " + l + " of the horizon";
  }));
  attachCanvasHover(cv);
}

// Progress bar: `frac` is signed (negative = moving away from the target).
function predBarHtml(frac, kind) {
  if (frac == null) return "<span class='muted'>-</span>";
  const w = Math.max(0, Math.min(1, Math.abs(frac))) * 100;
  const cls = frac < 0 ? "neg" : (kind === "time" ? "time" : "pos");
  return "<span class='pred-bar'><i class='" + cls + "' style='width:" + w.toFixed(0) + "%'></i></span>" +
    "<span class='pred-bar-n'>" + Math.round(frac * 100) + "%</span>";
}

function predStatusPill(r) {
  if (r.status === "hit") {
    return "<span class='pred-pill hit' title='Target reached " + isoDate(r.touchTs) + (r.openEnded ? ". No horizon was set." : ", after " + Math.round(r.timeUsed * 100) + "% of the horizon.") + "'>Hit</span>";
  }
  if (r.openEnded) return "<span class='pred-pill open' title='A target but no horizon: there is no deadline, so this stays open until the target is reached.'>no deadline</span>";
  if (r.status === "expired") {
    const lab = r.required == null ? (r.correct ? "Right" : "Wrong") : (r.correct ? "Partial" : "Missed");
    return "<span class='pred-pill " + (r.correct ? "part" : "miss") + "' title='Deadline passed " +
      isoDate(r.deadline) + " without reaching the target.'>" + lab + "</span>";
  }
  const d = Math.max(0, Math.ceil((r.deadline - Date.now()) / 86400000));
  return "<span class='pred-pill open' title='Deadline " + isoDate(r.deadline) + "'>" + d + "d left</span>";
}

function predTableHtml(rows) {
  if (!rows.length) return "<div class='muted small'>Nothing in this filter.</div>";
  let h = "<table class='an-table pred-table'><thead><tr>" +
    "<th>Stock</th><th>Call</th><th>Made</th><th>Deadline</th><th>Entry</th><th>Target</th><th>Price</th>" +
    "<th title='Share of the move from entry to target that has been made.'>To target</th>" +
    "<th title='Share of the horizon spent at the target touch, the deadline, or now.'>Time used</th>" +
    "<th>Return</th><th title='Return minus NASDAQ over the same window, signed by the call.'>vs NASDAQ</th>" +
    "<th>Status</th></tr></thead><tbody>";
  rows.forEach(function (r) {
    const tgt = r.target != null ? r.target.toFixed(2)
      : (r.badTarget ? "<span class='muted' title='The target you set is on the wrong side of a " + r.sentiment + " call, so it is not scored.'>n/a</span>" : "-");
    h += "<tr>" +
      "<td><b" + (r.rationale ? " title='" + escapeHtml(r.rationale).replace(/'/g, "&#39;") + "'" : "") + ">" +
        escapeHtml(nameOf(r.ticker)) + "</b>" + (r.rationale ? " <span class='pred-why'>why</span>" : "") + "</td>" +
      "<td><i class='dot " + r.sentiment + "'></i>" + (r.sentiment === "positive" ? "Pos" : "Neg") + "</td>" +
      "<td>" + isoDate(r.ts) + "</td>" +
      "<td>" + (r.openEnded ? "<span class='muted'>none</span>" : isoDate(r.deadline) + " <span class='n'>(" + r.horizonDays + "d)</span>") + "</td>" +
      "<td>" + r.entry.toFixed(2) + "</td>" +
      "<td>" + tgt + "</td>" +
      "<td>" + r.endPx.toFixed(2) + "</td>" +
      "<td>" + predBarHtml(r.progress, "price") + "</td>" +
      "<td>" + predBarHtml(r.timeProg, "time") + "</td>" +
      "<td class='" + signClass(r.signed) + "'>" + pct(r.signed) + "</td>" +
      "<td class='" + signClass(r.alpha) + "'>" + (r.alpha == null ? "-" : pct(r.alpha)) + "</td>" +
      "<td>" + predStatusPill(r) + "</td></tr>";
  });
  return h + "</tbody></table>";
}

function renderPredTable() {
  const el = document.getElementById("pred-table");
  if (!el) return;
  const rows = PRED.rows.filter(function (r) {
    return PRED.filter === "all" || (PRED.filter === "open" ? r.status === "open" : r.status !== "open");
  });
  el.innerHTML = predTableHtml(rows);
}

async function renderPredictions() {
  const empty = document.getElementById("pred-empty"), body = document.getElementById("pred-body");
  if (!empty || !body) return;
  const tks = predictionTickers();
  if (!tks.length) { empty.hidden = false; body.hidden = true; PRED.rows = []; return; }
  empty.hidden = true; body.hidden = false;
  if (PRED.loading) return;
  PRED.loading = true;
  try {
    await ensureDailySeries(tks);
    await ensureBenchmark();
  } finally { PRED.loading = false; }
  PRED.rows = buildPredictions();
  renderPredCards(PRED.rows);
  renderPredPace(PRED.rows);
  renderPredHorizon(PRED.rows);
  renderPredCurve(PRED.rows);
  renderPredTiming(PRED.rows);
  renderPredTable();
}

document.querySelectorAll("#pred-seg button").forEach(function (b) {
  b.addEventListener("click", function () {
    PRED.filter = b.getAttribute("data-p");
    document.querySelectorAll("#pred-seg button").forEach(function (x) { x.classList.toggle("on", x === b); });
    renderPredTable();
  });
});

// ---------- main tabs + sub-views ----------
// Tab ids are the original internal names (performance = My Stocks,
// attention = My Habits, network = Community): they key at_main and the synced
// feature-usage history, so only the visible labels changed.

const MAIN_TABS = ["performance", "attention", "predictions", "network", "world", "settings", "admin"];

function showMain(name) {
  if (name === "admin" && document.getElementById("tab-admin").hidden) name = "performance";
  MAIN_TABS.forEach(function (m) {
    const el = document.getElementById("main-" + m);
    if (el) el.hidden = (m !== name);
  });
  document.querySelectorAll("#maintabs button").forEach(function (b) {
    b.classList.toggle("on", b.getAttribute("data-m") === name);
  });
  try { localStorage.setItem("at_main", name); } catch (e) { /* ignore */ }
  try { ATStore.trackFeatureUse(name); } catch (e) { /* GROUP E4: usage tracking */ }
  renderMain(name);
}

// Re-render the now-visible view's canvases (canvases size to 0 while hidden),
// on every tab visit and every sub-view switch.
function renderMain(name) {
  if (name === "performance") render();
  else if (name === "attention") { renderUsageStats(); if (typeof renderTrades === "function") renderTrades(); }
  else if (name === "predictions") { renderPredictions(); renderAnalytics(); renderSentimentMix(); renderForecast(); }
  else if (name === "world") renderWorld();
  else if (name === "network") { renderNetwork(); renderTrending(); renderCrowdOverlap("net-crowd-canvas", "net-crowd-tip", "net-crowd-now"); }
  else if (name === "admin") renderAdmin();
  else if (name === "settings") renderAccountUsageChart();
}

// A tab's .subtabs bar (data-for = tab id) shows one [data-pane] block at a time.
function showSub(tab, sub) {
  const bar = document.querySelector(".subtabs[data-for='" + tab + "']");
  if (!bar.querySelector("[data-sub='" + sub + "']")) sub = bar.querySelector("button").getAttribute("data-sub");
  bar.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-sub") === sub); });
  const main = document.getElementById("main-" + tab);
  main.querySelectorAll("[data-pane]").forEach(function (p) {
    p.hidden = p.getAttribute("data-pane") !== sub;
  });
  main.setAttribute("data-sub", sub); // lets CSS drop controls a sub-view does not use
  try { localStorage.setItem("at_sub_" + tab, sub); } catch (e) { /* ignore */ }
}

document.querySelectorAll(".subtabs").forEach(function (bar) {
  const tab = bar.getAttribute("data-for");
  let saved = null;
  if (tab !== "attention") { // My Habits always opens on its first sub-view, Trades & research
    try { saved = localStorage.getItem("at_sub_" + tab); } catch (e) { /* ignore */ }
  }
  showSub(tab, saved);
  bar.querySelectorAll("button").forEach(function (b) {
    b.addEventListener("click", function () {
      showSub(tab, b.getAttribute("data-sub"));
      if (!document.getElementById("main-" + tab).hidden) renderMain(tab);
    });
  });
});

document.querySelectorAll("#maintabs button").forEach(function (b) {
  b.addEventListener("click", function () { showMain(b.getAttribute("data-m")); });
});

// Light / dark / device switch (Settings > Appearance). The stylesheet follows
// html[data-theme] on its own; canvases are redrawn so they pick up the new colours.
(function () {
  const seg = document.getElementById("theme-seg");
  if (!seg || !self.ATTheme) return;
  const mark = function () {
    const p = ATTheme.pref();
    seg.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-theme-pref") === p); });
  };
  mark();
  seg.addEventListener("click", function (ev) {
    const b = ev.target.closest("button[data-theme-pref]");
    if (b) ATTheme.set(b.getAttribute("data-theme-pref"));
  });
  ATTheme.onChange(function () {
    _TC = null; hideTip(); mark();
    const on = document.querySelector("#maintabs button.on");
    if (on) renderMain(on.getAttribute("data-m"));
  });
})();

// Required sign-in: the whole app is gated behind Google sign-in.
// The app opens on My Habits > Trades & research; a #tab hash (the popup's
// "My Stocks" link opens #performance) wins.
function currentMainTab() {
  const h = location.hash.replace(/^#/, "");
  return MAIN_TABS.indexOf(h) >= 0 ? h : "attention";
}

async function requireAuth() {
  const gate = document.getElementById("auth-gate");
  if (!(self.ATCloud && ATCloud.enabled())) { if (gate) gate.hidden = true; return true; } // no cloud -> no gate (local-only fallback)
  let user = null;
  try { user = await ATCloud.getUser(); } catch (e) { user = null; }
  if (gate) gate.hidden = !!user;
  return !!user;
}

async function startApp() {
  restoreView(); // sticky view options (before the first render)
  await load();
  await maybeShowAdminTab();
  showMain(currentMainTab());
  if (MAIN_TABS.indexOf(location.hash.replace(/^#/, "")) >= 0) history.replaceState(null, "", location.pathname + location.search);
}

// Sign-in opens a small sign-up window first: the Terms of Use and Privacy Policy must be
// ticked (required), the AI assistant has its own, optional box. The welcome page itself
// carries no tick boxes.
function askSignup(then) {
  const box = document.getElementById("signup-prompt"), tick = document.getElementById("signup-accept"), ai = document.getElementById("signup-ai");
  const go = document.getElementById("signup-continue"), cancel = document.getElementById("signup-cancel");
  const em = document.getElementById("signup-email"), pw = document.getElementById("signup-password");
  const eIn = document.getElementById("signup-email-in"), eUp = document.getElementById("signup-email-up"), msg = document.getElementById("signup-email-msg");
  tick.checked = false; ai.checked = false; go.disabled = eIn.disabled = eUp.disabled = true; pw.value = ""; msg.textContent = "";
  box.classList.remove("fb-hidden");
  const close = function () { box.classList.add("fb-hidden"); tick.removeEventListener("change", onTick); go.removeEventListener("click", onGo); cancel.removeEventListener("click", onCancel); eIn.removeEventListener("click", onIn); eUp.removeEventListener("click", onUp); };
  const onTick = function () { go.disabled = eIn.disabled = eUp.disabled = !tick.checked; };
  const onGo = function () { if (!tick.checked) return; const wantAi = ai.checked; close(); then(wantAi, null); };
  // E-mail: the address and password are checked here; Supabase checks them again.
  const viaEmail = function (create) {
    if (!tick.checked) return;
    const e = em.value.trim(), p = pw.value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { msg.textContent = "Enter a valid e-mail address."; return; }
    if (p.length < 8) { msg.textContent = "The password needs at least 8 characters."; return; }
    const wantAi = ai.checked; close(); pw.value = ""; then(wantAi, { email: e, password: p, create: create });
  };
  const onIn = function () { viaEmail(false); }, onUp = function () { viaEmail(true); };
  const onCancel = function () { close(); };
  tick.addEventListener("change", onTick); go.addEventListener("click", onGo); cancel.addEventListener("click", onCancel);
  eIn.addEventListener("click", onIn); eUp.addEventListener("click", onUp);
}

// Accounts signed in before the terms existed (or on a new device) accept them
// once before the app opens; the alternative is signing out.
function termsAccepted() { return !(self.ATCloud && ATCloud.enabled()) || !self.ATAI || ATAI.termsAccepted(); }
function askTerms(then) {
  const box = document.getElementById("terms-prompt");
  const tick = document.getElementById("terms-prompt-accept");
  const go = document.getElementById("terms-prompt-continue");
  box.classList.remove("fb-hidden");
  tick.addEventListener("change", function () { go.disabled = !tick.checked; });
  go.addEventListener("click", function () {
    if (!tick.checked) return;
    ATAI.acceptTerms();
    if (document.getElementById("terms-prompt-ai").checked) ATAI.grant();
    box.classList.add("fb-hidden");
    then();
  });
  document.getElementById("terms-prompt-signout").addEventListener("click", async function () {
    try { await ATCloud.signOut(); } catch (e) { /* signed out locally anyway */ }
    location.reload();
  });
}

(function () {
  // The sign-in button sits at the top of the welcome page and again below the
  // walkthrough; each reports progress in the status line next to it.
  [["gate-signin-top", "gate-status"], ["gate-signin-bottom", "gate-status-bottom"]].forEach(function (pair) {
    const b = document.getElementById(pair[0]);
    if (b) b.addEventListener("click", async function () {
      const st = document.getElementById(pair[1]);
      const choice = await new Promise(function (resolve) { askSignup(function (ai, em) { resolve({ ai: ai, em: em }); }); });
      // Recorded before signIn(): in the PWA the page leaves for Google and does not return here.
      if (self.ATAI) { ATAI.acceptTerms(); if (choice.ai) ATAI.grant(); }
      if (st) st.textContent = choice.em ? (choice.em.create ? "Creating your account..." : "Signing in...") : "Opening Google sign-in...";
      try {
        if (choice.em) {
          const u = await ATCloud.signInEmail(choice.em.email, choice.em.password, choice.em.create);
          if (!u) { if (st) st.textContent = "Check your inbox: confirm the address with the link we sent, then sign in."; return; }
        } else await ATCloud.signIn();
        document.getElementById("auth-gate").hidden = true;
        if (st) st.textContent = "Syncing your data...";
        autoSynced = false;        // this account may differ from a prior load's
        NET.rendered = false;      // per-account Network stats: never show a prior account's
        await ATSync.syncNow();    // pull this account's rows BEFORE rendering
        if (st) st.textContent = "";
        await startApp();
      } catch (e) { if (st) st.textContent = "Sign-in failed: " + (e && e.message || e); }
    });
  });
})();

// Welcome-page walkthrough: section jump buttons, click-to-enlarge screenshots,
// and the tour video stops when the gate closes (hidden elements keep playing).
(function () {
  const gate = document.getElementById("auth-gate");
  if (!gate) return;
  gate.addEventListener("click", function (ev) {
    const jump = ev.target.closest && ev.target.closest("[data-scroll]");
    if (jump) {
      const el = document.getElementById(jump.getAttribute("data-scroll"));
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const img = ev.target.closest && ev.target.closest(".we-shot img");
    if (img) img.classList.toggle("we-zoomed");
  });
  new MutationObserver(function () {
    if (gate.hidden) gate.querySelectorAll("video").forEach(function (v) { v.pause(); });
  }).observe(gate, { attributes: true, attributeFilter: ["hidden"] });
})();

// A failed OAuth return carries the reason in the URL (hash for the implicit
// flow Supabase uses here, query string otherwise). Without reading it the gate
// simply reappears and the failure is indistinguishable from nothing happening.
function oauthUrlError() {
  const parts = [location.hash.replace(/^#/, ""), location.search.replace(/^\?/, "")];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const p = new URLSearchParams(parts[i]);
    const msg = p.get("error_description") || p.get("error");
    if (msg) return msg;
  }
  return null;
}

// An installed PWA stays alive in the background, so reopening it never reloads
// the page and the once-per-load auto-sync above goes stale. Pull again whenever
// the app comes back to the foreground (throttled).
let lastForegroundSync = 0;
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState !== "visible" || !DATA) return;
  if (!self.ATCloud || !ATCloud.enabled()) return;
  if (Date.now() - lastForegroundSync < 30000) return;
  lastForegroundSync = Date.now();
  ATCloud.getUser().then(function (u) {
    if (!u) return;
    return ATSync.syncNow().then(function (r) { if (r && r.changed) load(); });
  }).catch(function () { /* offline or signed out */ });
});

// Headless (dashboard.html?headless=agent in an offscreen document, src/background.js): the AI agent's live
// verdict after a viewing session (issue #30). Asks the worker which sessions are due, decides them
// (shadow.js trAgentHeadless) and reports back, at most 3 rounds, then asks to be closed. Signed out,
// terms not accepted or the assistant off: nothing is sent anywhere; the worker learns the consent state.
const HEADLESS = /[?&]headless=agent\b/.test(location.search);
async function headlessAgent() {
  const send = function (m) { return new Promise(function (res) { chrome.runtime.sendMessage(m, function (r) { void chrome.runtime.lastError; res(r); }); }); };
  try {
    const consent = !!(self.ATAI && ATAI.consent());
    if (!(await requireAuth()) || !termsAccepted() || !consent) { await send({ type: "agentDone", startedAt: Date.now(), results: {}, consent: consent && termsAccepted() }); return; }
    for (let round = 0; round < 3; round++) {
      const due = await send({ type: "agentDue" }), ss = due && due.sessions || {};
      if (!Object.keys(ss).length) break;
      const t0 = Date.now();
      let results = {};
      // a run that fails says so in the pop-up instead of leaving the stock without a word
      try {
        DATA = await ATStore.getAll();
        BENCH = null;
        await loadNames();
        const tks = Object.keys(ss);
        results = await trAgentHeadless(ss, function (s) { send({ type: "agentProgress", tickers: tks, step: s }); });
      } catch (e) {
        const note = "The AI agent could not run in the background: " + String(e && e.message || e).slice(0, 200);
        Object.keys(ss).forEach(function (T) { results[T] = { momentId: null, verdict: { ticker: T, updatedAt: Date.now(), note: note } }; });
      }
      await send({ type: "agentDone", startedAt: t0, results: results, consent: true });
    }
  } finally { send({ type: "agentClose" }); }
}

(async function boot() {
  // trAgentHeadless is in shadow.js, which loads after this file: start once every script is in
  if (HEADLESS) { if (document.readyState === "complete") headlessAgent(); else window.addEventListener("load", function () { headlessAgent(); }, { once: true }); return; }
  // requireAuth() touches the client first, which is what lets supabase-js
  // consume an #access_token from the URL. Only look for errors afterwards.
  const authed = await requireAuth();
  if (!authed) {
    const err = oauthUrlError();
    const st = document.getElementById("gate-status");
    if (err && st) st.textContent = "Sign-in failed: " + err;
    if (err) history.replaceState(null, "", location.pathname);
  }
  // The redirect flow can resolve after boot; hide the gate when it does.
  if (self.ATCloud && ATCloud.enabled()) {
    ATCloud.onAuthChange(function (event) {
      if (event !== "SIGNED_IN") return;
      const gate = document.getElementById("auth-gate");
      if (!gate || gate.hidden) return; // already inside the app
      gate.hidden = true;
      autoSynced = false;
      NET.rendered = false;
      ATSync.syncNow().then(startApp);
    });
  }
  if (authed) { if (termsAccepted()) startApp(); else askTerms(startApp); }
})();
