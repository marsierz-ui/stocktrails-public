(function () {
  // Browsing-history backfill: turn a Google Takeout export of Chrome history
  // into attention visits on the supported portals, so research from before
  // Stocktrails was installed counts too.
  //
  // The file holds every site the person visited. Only URLs a portal pattern
  // recognises survive; everything else is dropped in memory and the file
  // itself is never stored or uploaded.
  //
  // Takeout's layout is not documented and has changed over time (Chrome
  // "History.json" with a "Browser History" list, "My Activity" JSON with
  // titleUrl + ISO time), so entries are found by shape rather than by path:
  // any object carrying a URL field and a time field.
  //
  // CSV exports (history-export extensions, Comet and other Chromium browsers)
  // list one row per PAGE, not per visit: the page's last visit time plus a
  // visit count. Each such row becomes one visit at that time; the other visits
  // of the page have no recorded time and cannot be placed, so views from these
  // files are understated (reported as `unplaced`).

  const MAX_BYTES = 300 * 1024 * 1024;
  const URL_KEYS = ["url", "titleUrl", "virtual_url"];

  function toMs(o) {
    if (o.time_usec != null) return Number(o.time_usec) / 1000;
    if (o.timestamp_msec != null) return Number(o.timestamp_msec);
    if (typeof o.time === "string") return Date.parse(o.time);
    if (o.visitTime != null) return Number(o.visitTime);
    if (o.lastVisitTime != null) return Number(o.lastVisitTime);
    return NaN;
  }

  // My Activity can link through google.com/url?q=<target>.
  function unwrap(u) {
    try {
      const x = new URL(u);
      if (/(^|\.)google\.[a-z.]+$/.test(x.hostname) && x.pathname === "/url") return x.searchParams.get("q") || x.searchParams.get("url") || u;
    } catch (e) { /* not a URL */ }
    return u;
  }

  // A number from a history export as epoch ms. Chrome's own database stores
  // microseconds since 1601 (about 1.3e16 today); everything else is Unix time
  // in seconds, ms or microseconds - told apart by magnitude.
  function numToMs(x) {
    x = Number(x);
    if (!isFinite(x) || x <= 0) return NaN;
    if (x > 1e16) return (x - 11644473600e6) / 1000;
    if (x > 1e14) return x / 1000;
    if (x > 1e11) return x;
    return x * 1000;
  }

  const CSV_URL = ["url", "titleurl", "virtual_url", "link", "address", "navigatedtourl", "navigated_to_url"];
  const CSV_TIME = ["datetime", "date_time", "timestamp", "lastvisittime", "last_visit_time", "last_visit", "visit_time", "visittime", "time_usec", "timestamp_msec"];
  const CSV_COUNT = ["visitcount", "visit_count", "visits"];

  function csvEntries(text) {
    const parse = self.ATLedger && self.ATLedger.parseCsv;
    if (!parse) throw new Error("CSV reader not loaded");
    const first = text.split(/\r?\n/, 1)[0];
    const delim = [",", ";", "\t"].map(function (d) { return [d, first.split(d).length]; }).sort(function (a, b) { return b[1] - a[1]; })[0][0];
    const rows = parse(text, delim);
    if (rows.length < 2) return [];
    const head = rows[0].map(function (h) { return String(h || "").trim().toLowerCase().replace(/^\ufeff/, ""); });
    const find = function (names) { for (let i = 0; i < names.length; i++) { const k = head.indexOf(names[i]); if (k >= 0) return k; } return -1; };
    const ui = find(CSV_URL), ti = find(CSV_TIME), ci = find(CSV_COUNT);
    if (ui < 0) throw new Error("This CSV has no URL column.");
    if (ti < 0) throw new Error("This CSV has no visit-time column (looked for: " + CSV_TIME.join(", ") + ").");
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r], url = row[ui];
      if (!url) continue;
      const raw = String(row[ti] == null ? "" : row[ti]).trim();
      const ts = /^[\d.]+$/.test(raw) ? numToMs(raw) : Date.parse(raw);
      if (!isFinite(ts) || ts <= 0) continue;
      const vc = ci >= 0 ? parseInt(row[ci], 10) : NaN;
      out.push({ url: unwrap(String(url)), ts: Math.round(ts), vc: vc > 0 ? vc : 1 });
    }
    return out;
  }

  // Iterative walk: a deep or huge export must not overflow the stack.
  function entries(root) {
    const out = [], stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (Array.isArray(n)) { for (let i = 0; i < n.length; i++) if (n[i] && typeof n[i] === "object") stack.push(n[i]); continue; }
      if (!n || typeof n !== "object") continue;
      let url = null;
      for (let k = 0; k < URL_KEYS.length; k++) { if (typeof n[URL_KEYS[k]] === "string") { url = n[URL_KEYS[k]]; break; } }
      const ts = url ? toMs(n) : NaN;
      if (url && isFinite(ts) && ts > 0) { out.push({ url: unwrap(url), ts: Math.round(ts) }); continue; }
      Object.keys(n).forEach(function (k) { const v = n[k]; if (v && typeof v === "object") stack.push(v); });
    }
    return out;
  }

  // -> { entries, visits: [{ticker, ts, source, url, section, researchType}], tickers, from, to }
  function extract(text, customPortals) {
    if (text.length > MAX_BYTES) throw new Error("The file is larger than 300 MB. Export Chrome history only.");
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const isJson = /^\s*[\[{]/.test(body.slice(0, 64));
    let all, format = isJson ? "json" : "csv";
    if (isJson) {
      let json;
      try { json = JSON.parse(body); }
      catch (e) { throw new Error("Could not read this JSON file. In Google Takeout choose Chrome (or My Activity) with JSON format, then unzip the download."); }
      all = entries(json);
    } else all = csvEntries(body);
    if (!all.length) throw new Error("No visited pages with a time found in this file. Use Chrome's History.json from Google Takeout, or a history CSV with a URL and a visit-time column.");
    const visits = [], tickers = {};
    let unplaced = 0;
    all.forEach(function (e) {
      const hit = self.ATPortals.detect(e.url, customPortals || []);
      if (!hit) return;
      visits.push({
        ticker: hit.ticker, ts: e.ts, source: "history", url: String(e.url).slice(0, 500), section: hit.section || null,
        researchType: self.ATPortals.classifyUrl(e.url, hit.source) || "overview", portalPath: null
      });
      tickers[hit.ticker] = (tickers[hit.ticker] || 0) + 1;
      if (e.vc > 1) unplaced += e.vc - 1;
    });
    visits.sort(function (a, b) { return a.ts - b.ts; });
    return { entries: all.length, visits: visits, tickers: tickers, format: format, unplaced: unplaced,
      from: visits.length ? visits[0].ts : null, to: visits.length ? visits[visits.length - 1].ts : null };
  }

  // Which visits are not already recorded. A visit of the same stock within
  // `windowMs` of an existing view (live capture, an earlier import, or the
  // same visit listed again by another export or browser) is the same visit.
  // Live capture stamps a view within seconds of the page loading, so a minute
  // is generous; a second visit of one stock inside that minute is rare and
  // costs one view at worst.
  function newVisits(existing, visits, windowMs) {
    windowMs = windowMs == null ? 60000 : windowMs;
    const by = {};
    (existing || []).forEach(function (e) { if (e && e.ticker && e.ts) (by[e.ticker] = by[e.ticker] || []).push(e.ts); });
    Object.keys(by).forEach(function (t) { by[t].sort(function (a, b) { return a - b; }); });
    const fresh = [];
    let duplicates = 0;
    visits.forEach(function (v) {
      const arr = by[v.ticker];
      if (arr) {
        let lo = 0, hi = arr.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v.ts) lo = m + 1; else hi = m; }
        if ((lo < arr.length && arr[lo] - v.ts <= windowMs) || (lo > 0 && v.ts - arr[lo - 1] <= windowMs)) { duplicates++; return; }
      }
      fresh.push(v);
    });
    return { fresh: fresh, duplicates: duplicates };
  }

  const api = { extract: extract, entries: entries, newVisits: newVisits, numToMs: numToMs };
  if (typeof self !== "undefined") self.ATHistory = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
