(function () {
  // Groups touching this file: GROUP 1 (1c market-cap/sector/industry via
  // fetchProfile, 1d 52-week range added to fetchQuote) plus the existing
  // price/series/name helpers.
  //
  // Price data via Yahoo Finance's keyless chart endpoint. Extension
  // host_permissions cover these hosts so fetch is not blocked by CORS.
  const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
  const PROFILE_KEY = "profileCache";          // GROUP 1c: ticker -> { fetchedAt, value }
  const PROFILE_TTL = 7 * 86400000;            // 7-day TTL

  // GROUP 1c: standard market-cap buckets.
  function marketCapBucket(mc) {
    if (mc == null || isNaN(mc)) return null;
    if (mc < 50e6) return "nano";
    if (mc < 300e6) return "micro";
    if (mc < 2e9) return "small";
    if (mc < 10e9) return "mid";
    if (mc < 200e9) return "large";
    return "mega";
  }

  function toSymbol(ticker) {
    return String(ticker).toUpperCase().trim();
  }

  function isoFromSec(sec) {
    return new Date(sec * 1000).toISOString().slice(0, 10);
  }

  async function fetchJson(path) {
    // In the PWA (web origin), Yahoo is blocked by CORS, so route through the
    // sync server's proxy when one is configured. The extension fetches direct.
    if (typeof self !== "undefined" && self.AT_PRICE_PROXY) {
      const res = await fetch(self.AT_PRICE_PROXY + encodeURIComponent(path));
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    }
    let lastErr = null;
    for (const host of HOSTS) {
      try {
        const res = await fetch(host + path);
        if (!res.ok) { lastErr = new Error("HTTP " + res.status); continue; }
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("fetch failed");
  }

  function parseChart(json) {
    const r = json && json.chart && json.chart.result && json.chart.result[0];
    if (!r || !r.timestamp || !r.indicators || !r.indicators.quote) return [];
    const ts = r.timestamp;
    const closes = r.indicators.quote[0].close || [];
    // Daily volume (bias indicator B5: buying after abnormal volume). Not every
    // series has it (indices, FX), so a bar carries it only when Yahoo gives one.
    const vols = r.indicators.quote[0].volume || [];
    // Date each bar by the exchange's own calendar day, not the UTC one. Yahoo
    // stamps FX daily bars at London midnight (23:00 UTC under BST), and Sydney or
    // Auckland opens fall on the previous UTC day for half the year: dated in UTC,
    // every such bar landed a day early, so a USD conversion used the NEXT day's
    // rate. The trailing live bar shares its day with the last completed one and
    // replaces it.
    let fmt = null;
    try {
      const tz = r.meta && r.meta.exchangeTimezoneName;
      if (tz) fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch (e) { fmt = null; }
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || isNaN(c)) continue;
      const date = fmt ? fmt.format(new Date(ts[i] * 1000)) : isoFromSec(ts[i]);
      const bar = { date: date, close: c, ts: ts[i] };
      if (vols[i] != null && vols[i] > 0) bar.volume = vols[i];
      if (out.length && out[out.length - 1].date === date) out[out.length - 1] = bar;
      else out.push(bar);
    }
    // Yahoo sometimes lists a split under events but leaves the closes
    // unadjusted (AIXI's 1:7 reverse split on 2026-09-08 read as a +590% day).
    // For each split, if the close-to-close move across it is nearer the split
    // factor than to no move, the history before it is still in old shares:
    // rescale it. A series Yahoo already adjusted is left alone.
    const splits = (r.events && r.events.splits) || {};
    Object.keys(splits).forEach(function (k) {
      const sp = splits[k], at = +sp.date, f = +sp.denominator / +sp.numerator;
      if (!at || !(f > 0) || f === 1) return;
      const j = out.findIndex(function (p) { return p.ts >= at; });
      if (j <= 0) return;
      const jump = out[j].close / out[j - 1].close;
      if (!(jump > 0) || Math.abs(Math.log(jump / f)) >= Math.abs(Math.log(jump))) return;
      for (let i = 0; i < j; i++) out[i].close *= f;
    });
    out.forEach(function (p) { delete p.ts; });
    // Quote currency ("USD", "HKD", "GBp" = pence...), for callers that convert.
    out.currency = (r.meta && r.meta.currency) || null;
    return out;
  }

  async function fetchDaily(symbolOrTicker, fromISO, asSymbol) {
    const sym = asSymbol ? symbolOrTicker : toSymbol(symbolOrTicker);
    const p1 = fromISO
      ? Math.floor(Date.parse(fromISO) / 1000)
      : Math.floor((Date.now() - 365 * 86400000) / 1000);
    const p2 = Math.floor(Date.now() / 1000) + 86400;
    const path = "/v8/finance/chart/" + encodeURIComponent(sym) +
      "?period1=" + p1 + "&period2=" + p2 + "&interval=1d&events=split";
    const json = await fetchJson(path);
    return parseChart(json);
  }

  async function fetchQuote(symbolOrTicker, asSymbol) {
    const sym = asSymbol ? symbolOrTicker : toSymbol(symbolOrTicker);
    // GROUP 1d: range=1y so meta carries the 52-week high/low for the
    // week-52 position computed in background.js handleAttention.
    const path = "/v8/finance/chart/" + encodeURIComponent(sym) + "?range=1y&interval=1d";
    const json = await fetchJson(path);
    const r = json && json.chart && json.chart.result && json.chart.result[0];
    if (!r || !r.meta) return null;
    let price = r.meta.regularMarketPrice;
    if (price == null) {
      const closes = r.indicators && r.indicators.quote && r.indicators.quote[0].close;
      if (closes && closes.length) price = closes[closes.length - 1];
    }
    if (price == null || isNaN(price)) return null;
    const t = r.meta.regularMarketTime ? isoFromSec(r.meta.regularMarketTime) : isoFromSec(Math.floor(Date.now() / 1000));
    const low52w = (r.meta.fiftyTwoWeekLow != null && !isNaN(r.meta.fiftyTwoWeekLow)) ? Number(r.meta.fiftyTwoWeekLow) : null;
    const high52w = (r.meta.fiftyTwoWeekHigh != null && !isNaN(r.meta.fiftyTwoWeekHigh)) ? Number(r.meta.fiftyTwoWeekHigh) : null;
    return { date: t, close: price, low52w: low52w, high52w: high52w, currency: r.meta.currency || null };
  }

  // GROUP 1c: sector / industry / market cap (+ bucket) with a 7-day local cache.
  // Yahoo's quoteSummary endpoint now requires a crumb/cookie and returns 401 for
  // keyless cross-origin fetches, so sector/industry come from the keyless search
  // endpoint (which carries sectorDisp/industryDisp for equities). Market cap
  // comes from the keyless fundamentals-timeseries endpoint (trailingMarketCap,
  // in the listing's currency, converted to USD for the bucket).
  async function fetchProfile(symbolOrTicker, asSymbol) {
    const sym = asSymbol ? symbolOrTicker : toSymbol(symbolOrTicker);
    try {
      const r = await chrome.storage.local.get(PROFILE_KEY);
      const cache = (r && r[PROFILE_KEY]) || {};
      const hit = cache[sym];
      // A cached profile without a market cap (every one written before the
      // timeseries source) is retried after a day instead of a week.
      const ttl = hit && hit.value && hit.value.marketCap == null ? 86400000 : PROFILE_TTL;
      if (hit && hit.value && (Date.now() - (hit.fetchedAt || 0)) < ttl) return hit.value;
    } catch (e) { /* cache best-effort */ }

    const value = { sector: null, industry: null, marketCap: null, marketCapBucket: null };
    // Primary: search endpoint -> sector / industry (keyless, reliable).
    try {
      const json = await fetchJson("/v1/finance/search?q=" + encodeURIComponent(sym) + "&quotesCount=6&newsCount=0");
      const quotes = (json && json.quotes) || [];
      const hit = quotes.find(function (x) { return x.symbol && x.symbol.toUpperCase() === sym.toUpperCase(); }) || quotes[0];
      if (hit) {
        value.sector = hit.sectorDisp || hit.sector || null;
        value.industry = hit.industryDisp || hit.industry || null;
      }
    } catch (e) { /* sector/industry best-effort */ }
    // Market cap: latest trailingMarketCap point (quoteSummary needs a crumb and
    // answers 401 keyless). Stored in USD so the nano..mega buckets mean the same
    // thing for 0700.HK as for AAPL.
    try {
      const now = Math.floor(Date.now() / 1000);
      const json = await fetchJson("/ws/fundamentals-timeseries/v1/finance/timeseries/" + encodeURIComponent(sym) +
        "?type=trailingMarketCap&period1=" + (now - 400 * 86400) + "&period2=" + (now + 86400));
      const res = json && json.timeseries && json.timeseries.result && json.timeseries.result[0];
      const pts = ((res && res.trailingMarketCap) || []).filter(function (p) { return p && p.reportedValue && p.reportedValue.raw != null; });
      const last = pts[pts.length - 1];
      if (last) {
        let mc = Number(last.reportedValue.raw), ccy = last.currencyCode || "USD";
        if (ccy === "GBp" || ccy === "GBX") { mc /= 100; ccy = "GBP"; }
        if (ccy !== "USD") {
          const fx = await fetchQuote(ccy + "USD=X", true);
          mc = fx && fx.close ? mc * fx.close : NaN;
        }
        if (isFinite(mc) && mc > 0) { value.marketCap = Math.round(mc); value.marketCapBucket = marketCapBucket(mc); }
      }
    } catch (e) { /* market cap best-effort; leave null */ }

    try {
      const r = await chrome.storage.local.get(PROFILE_KEY);
      const cache = (r && r[PROFILE_KEY]) || {};
      cache[sym] = { fetchedAt: Date.now(), value: value };
      await chrome.storage.local.set({ [PROFILE_KEY]: cache });
    } catch (e) { /* ignore */ }
    return value;
  }

  // Bars at any interval (e.g. "1h") as [{ t: ms, c: close }], for archiving.
  // Yahoo serves 1h only for the trailing ~730 days.
  function parseBars(json) {
    const r = json && json.chart && json.chart.result && json.chart.result[0];
    if (!r || !r.timestamp || !r.indicators || !r.indicators.quote) return [];
    const ts = r.timestamp;
    const q = r.indicators.quote[0] || {};
    const closes = q.close || [];
    const adj = r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose;
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const c = (adj && adj[i] != null) ? adj[i] : closes[i];
      if (c == null || isNaN(c)) continue;
      out.push({ t: ts[i] * 1000, c: c });
    }
    return out;
  }

  async function fetchBars(symbolOrTicker, interval, fromSec, asSymbol) {
    const sym = asSymbol === false ? toSymbol(symbolOrTicker) : symbolOrTicker;
    const p1 = fromSec || Math.floor((Date.now() - 729 * 86400000) / 1000);
    const p2 = Math.floor(Date.now() / 1000) + 3600;
    const path = "/v8/finance/chart/" + encodeURIComponent(sym) +
      "?period1=" + p1 + "&period2=" + p2 + "&interval=" + (interval || "1h");
    const json = await fetchJson(path);
    return parseBars(json);
  }

  // Resolve a company name or ISIN to candidate Yahoo symbols (across exchanges),
  // so the user can pick the listing that matches their broker app.
  async function searchSymbols(query) {
    const q = String(query || "").trim();
    if (q.length < 2) return [];
    const json = await fetchJson("/v1/finance/search?q=" + encodeURIComponent(q) + "&quotesCount=8&newsCount=0");
    const out = [];
    (json && json.quotes || []).forEach(function (x) {
      if (!x.symbol) return;
      if (x.quoteType && x.quoteType !== "EQUITY" && x.quoteType !== "ETF") return;
      out.push({
        symbol: x.symbol,
        name: (x.shortname || x.longname || x.symbol).replace(/\s+/g, " ").trim(),
        exch: x.exchDisp || x.exchange || "",
        type: x.quoteType || ""
      });
    });
    return out;
  }

  // Resolve a single symbol to its company/display name (best-effort).
  async function fetchName(symbolOrTicker, asSymbol) {
    const sym = asSymbol ? symbolOrTicker : toSymbol(symbolOrTicker);
    try {
      const json = await fetchJson("/v1/finance/search?q=" + encodeURIComponent(sym) + "&quotesCount=6&newsCount=0");
      const quotes = (json && json.quotes) || [];
      let hit = quotes.find(function (x) { return x.symbol && x.symbol.toUpperCase() === sym.toUpperCase(); }) || quotes[0];
      if (hit) { const nm = (hit.shortname || hit.longname || "").replace(/\s+/g, " ").trim(); if (nm) return nm; }
    } catch (e) { /* fall through */ }
    return null;
  }

  const api = { toSymbol, fetchDaily, fetchQuote, fetchProfile, marketCapBucket, fetchBars, searchSymbols, fetchName, parseChart, parseBars };
  if (typeof self !== "undefined") self.ATPrices = api;
})();
