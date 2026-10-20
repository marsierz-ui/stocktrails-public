(function () {
  // Exchange code -> Yahoo symbol suffix. "" = US (no suffix). Codes are the
  // lowercased venue tokens used by StockAnalysis/Google/MarketBeat URLs.
  const EXCH = {
    // United States
    us: "", usa: "", nasdaq: "", nyse: "", nysearca: "", arca: "", amex: "",
    nysemkt: "", nyseamerican: "", bats: "", cboe: "", otc: "", otcmkts: "", pink: "",
    // Canada
    tsx: ".TO", tse: ".TO", tor: ".TO", tsxv: ".V", cve: ".V", ven: ".V",
    // United Kingdom / Ireland
    lon: ".L", lse: ".L", ise: ".IR",
    // Western / Northern / Central Europe
    epa: ".PA", par: ".PA",
    etr: ".DE", xetra: ".DE", ger: ".DE", fra: ".F",
    ams: ".AS", ebr: ".BR", bru: ".BR", els: ".LS", lis: ".LS", eli: ".LS",
    bit: ".MI", mil: ".MI", mta: ".MI",
    bme: ".MC", mce: ".MC", mad: ".MC",
    sto: ".ST", omxsto: ".ST", hel: ".HE", omxhel: ".HE",
    cph: ".CO", omxcop: ".CO", osl: ".OL", ose: ".OL",
    swx: ".SW", six: ".SW", vtx: ".SW", ebs: ".SW",
    vie: ".VI", wbo: ".VI", wse: ".WA", gpw: ".WA", war: ".WA",
    // Asia-Pacific
    tyo: ".T", jpx: ".T", hkg: ".HK", hkex: ".HK", hk: ".HK",
    asx: ".AX", au: ".AX", nzx: ".NZ", nze: ".NZ",
    sgx: ".SI", ses: ".SI", krx: ".KS", ksc: ".KS", kse: ".KS", kosdaq: ".KQ",
    tpe: ".TW", twse: ".TW", nse: ".NS", nsi: ".NS", bse: ".BO", bom: ".BO",
    // Latin America / Africa
    bvmf: ".SA", bov: ".SA", bmv: ".MX", mex: ".MX", jse: ".JO", jnb: ".JO"
  };

  function escapeRx(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normBase(raw) {
    let t = decodeURIComponent(raw).toUpperCase().trim();
    t = t.split(":")[0];
    return t;
  }

  // Build a canonical Yahoo symbol from a captured ticker + exchange.
  // exchange === null means the source is Yahoo-native (already a Yahoo symbol).
  function buildSymbol(rawTicker, exchange) {
    const base = normBase(rawTicker);
    if (exchange == null) {
      return /^[A-Z0-9.\-]{1,16}$/.test(base) ? base : null;
    }
    const suffix = EXCH[String(exchange).toLowerCase()];
    const core = base.replace(/\./g, "-"); // class shares: Yahoo uses '-' not '.'
    if (suffix === undefined) return /^[A-Z0-9\-]{1,16}$/.test(core) ? core : null;
    const sym = core + suffix;
    return /^[A-Z0-9.\-]{1,16}$/.test(sym) ? sym : null;
  }

  // The section the URL names, taken from the path after the ticker match:
  // "/quote/MRNA/financials/" -> "financials", ".../financials/balance-sheet/" ->
  // "financials/balance-sheet". Nothing after the ticker is the quote landing page.
  function sectionAfter(u, m) {
    const segs = u.pathname.slice(m.index + m[0].length).toLowerCase().split("/").filter(Boolean).slice(0, 3);
    return segs.length ? segs.join("/").slice(0, 60) : "overview";
  }

  function pathEx(rx, exchange) {
    return function (u) {
      const m = u.pathname.match(rx);
      return m && m[1] ? { ticker: m[1], exchange: exchange, section: sectionAfter(u, m) } : null;
    };
  }
  // Query-string portals carry no section in the path; the caller names it.
  function queryEx(param, exchange, section) {
    return function (u) {
      const v = u.searchParams.get(param);
      return v ? { ticker: v, exchange: exchange, section: section || null } : null;
    };
  }

  const BUILTINS = [
    { source: "Yahoo Finance", host: /(^|\.)finance\.yahoo\.com$/,
      extract: function (u) {
        let m = u.pathname.match(/\/quote\/([A-Za-z0-9.\-]+)/);
        if (m && m[1]) return { ticker: m[1], exchange: null, section: sectionAfter(u, m) };
        // Full-screen chart: the section comes first (/chart/MRNA).
        m = u.pathname.match(/^\/chart\/([A-Za-z0-9.\-]+)/);
        return m && m[1] ? { ticker: m[1], exchange: null, section: "chart" } : null;
      } },
    { source: "Google Finance", host: /(^|\.)google\.com$/,
      extract: function (u) {
        const m = u.pathname.match(/\/finance\/quote\/([A-Za-z0-9.\-]+)(?::([A-Za-z0-9]+))?/);
        return m && m[1] ? { ticker: m[1], exchange: m[2] || "us", section: sectionAfter(u, m) } : null;
      } },
    { source: "MarketWatch", host: /(^|\.)marketwatch\.com$/,
      extract: pathEx(/\/investing\/stock\/([A-Za-z0-9.\-]+)/, "us") },
    { source: "CNBC", host: /(^|\.)cnbc\.com$/,
      extract: pathEx(/\/quotes\/([A-Za-z0-9.\-]+)/, "us") },
    { source: "Bloomberg", host: /(^|\.)bloomberg\.com$/,
      extract: function (u) {
        const m = u.pathname.match(/\/quote\/([A-Za-z0-9.\-]+)(?::([A-Za-z]+))?/);
        return m && m[1] ? { ticker: m[1], exchange: (m[2] && m[2].toLowerCase() === "us") ? "us" : (m[2] || "us"), section: sectionAfter(u, m) } : null;
      } },
    { source: "StockAnalysis", host: /(^|\.)stockanalysis\.com$/,
      extract: function (u) {
        let m = u.pathname.match(/\/(?:stocks|etf)\/([A-Za-z0-9.\-]+)/);
        if (m && m[1]) return { ticker: m[1], exchange: "us", section: sectionAfter(u, m) };
        m = u.pathname.match(/\/quote\/([A-Za-z]+)\/([A-Za-z0-9.\-]+)/);
        if (m && m[2]) return { ticker: m[2], exchange: m[1], section: sectionAfter(u, m) };
        // Chart page: the section comes first, and a non-US listing is written
        // EXCHANGE:SYMBOL (/chart/APP/, /chart/TYO:7203/).
        m = u.pathname.match(/^\/chart\/(?:([A-Za-z]+)(?::|%3A))?([A-Za-z0-9.\-]+)/i);
        if (m && m[2]) return { ticker: m[2], exchange: m[1] || "us", section: "chart" };
        return null;
      } },
    { source: "MarketBeat", host: /(^|\.)marketbeat\.com$/,
      extract: function (u) {
        const m = u.pathname.match(/\/stocks\/([A-Za-z]+)\/([A-Za-z0-9.\-]+)/);
        return m && m[2] ? { ticker: m[2], exchange: m[1], section: sectionAfter(u, m) } : null;
      } },
    { source: "Finviz", host: /(^|\.)finviz\.com$/, extract: queryEx("t", "us", "overview") },
    // Perplexity puts a full Yahoo symbol in the path (/finance/CIPLA.BO), so it
    // is Yahoo-native like finance.yahoo.com. Tagging it "us" ran the class-share
    // '.'->'-' rewrite over symbols that were already correct, turning exchange
    // suffixes into nonsense: CIPLA.BO became CIPLA-BO, which Yahoo cannot price.
    { source: "Perplexity Finance", host: /(^|\.)perplexity\.ai$/,
      extract: pathEx(/\/finance\/([A-Za-z0-9.\-]+)/, null) },
    { source: "TradingView", host: /(^|\.)tradingview\.com$/,
      extract: function (u) {
        const m = u.pathname.match(/\/symbols\/([A-Za-z]+)-([A-Za-z0-9.\-]+)/);
        if (m && m[2]) return { ticker: m[2], exchange: m[1], section: sectionAfter(u, m) };
        // Chart app (/chart/?symbol=NASDAQ:AAPL): the symbol is in the query.
        const s = u.searchParams.get("symbol");
        if (s) { const p = s.split(":"); return p.length === 2 ? { ticker: p[1], exchange: p[0], section: "chart" } : { ticker: s, exchange: "us", section: "chart" }; }
        return null;
      } },
    { source: "Seeking Alpha", host: /(^|\.)seekingalpha\.com$/,
      extract: pathEx(/\/symbol\/([A-Za-z0-9.\-]+)/, "us") },
    { source: "Nasdaq", host: /(^|\.)nasdaq\.com$/,
      extract: pathEx(/\/market-activity\/(?:stocks|etf)\/([A-Za-z0-9.\-]+)/, "us") },
    { source: "Stocktwits", host: /(^|\.)stocktwits\.com$/,
      extract: pathEx(/\/symbol\/([A-Za-z0-9.\-]+)/, "us") },
    { source: "WSJ", host: /(^|\.)wsj\.com$/,
      extract: pathEx(/\/market-data\/quotes\/([A-Za-z0-9.\-]+)/, "us") },
    // Only the institutional holders page (/institutional/holders-of-frmi/): the
    // ticker is part of the last path segment, and the page is always that one type.
    { source: "Holdings Channel", host: /(^|\.)holdingschannel\.com$/,
      extract: function (u) {
        const m = u.pathname.match(/^\/institutional\/holders-of-([A-Za-z0-9.\-]+?)\/?$/);
        return m && m[1] ? { ticker: m[1], exchange: "us", section: "institutional" } : null;
      } }
  ];

  function parsePattern(pattern) {
    let p = String(pattern).trim().replace(/^https?:\/\//i, "").replace(/^\/+/, "");
    if (!p) return null;
    const slash = p.indexOf("/");
    const host = slash === -1 ? p : p.slice(0, slash);
    const rest = slash === -1 ? "" : p.slice(slash);
    if (!host || host.indexOf("{ticker}") !== -1) return null;

    const qIdx = rest.indexOf("?");
    if (qIdx !== -1) {
      const m = rest.slice(qIdx + 1).match(/([A-Za-z0-9_]+)=\{ticker\}/);
      if (m) return { host: host, kind: "query", queryParam: m[1] };
    }
    const pathPart = qIdx === -1 ? rest : rest.slice(0, qIdx);
    if (pathPart.indexOf("{ticker}") !== -1) {
      const rxSource = "^" + escapeRx(pathPart).replace("\\{ticker\\}", "([A-Za-z0-9.\\-]+)");
      return { host: host, kind: "path", pathRx: rxSource };
    }
    return null;
  }

  function compileCustom(def) {
    const p = parsePattern(def.pattern);
    if (!p) return null;
    const host = new RegExp("(^|\\.)" + escapeRx(p.host) + "$");
    let extract;
    if (p.kind === "query") {
      extract = queryEx(p.queryParam, null);
    } else {
      const rx = new RegExp(p.pathRx);
      extract = function (u) {
        const m = u.pathname.match(rx);
        return m && m[1] ? { ticker: m[1], exchange: null, section: sectionAfter(u, m) } : null;
      };
    }
    return { source: def.name || p.host, host: host, extract: extract };
  }

  function detect(urlStr, customDefs) {
    let u;
    try { u = new URL(urlStr); } catch (e) { return null; }
    const portals = BUILTINS.concat((customDefs || []).map(compileCustom).filter(Boolean));
    for (const p of portals) {
      if (!p.host.test(u.hostname)) continue;
      const r = p.extract(u);
      if (!r) continue;
      const ticker = buildSymbol(r.ticker, r.exchange);
      if (ticker) return { ticker: ticker, source: p.source, exchange: r.exchange == null ? null : r.exchange, section: r.section || null };
    }
    return null;
  }

  // Research type from the URL alone (null when the URL says nothing specific;
  // content.js then reads the page's headings). Shared with the browsing-history
  // import, which has URLs but no page content.
  function classifyUrl(url, source) {
    // Classify on path+query only: hostnames can contain bucket keywords
    // (stockanalysis.com contains "analysis").
    let u;
    try { const x = new URL(url); u = (x.pathname + x.search).toLowerCase(); }
    catch (e) { u = String(url).toLowerCase(); }
    const s = String(source || "").toLowerCase();
    if (s.indexOf("perplexity") >= 0) return "ai";
    if (s.indexOf("stocktwits") >= 0) return "community";
    if (/insider|form-?4|insider-transactions/.test(u)) return "insider";
    if (/short-interest|short-selling|shares-short|days-to-cover|short-float/.test(u)) return "short";
    if (/institutional|13f|hedge-fund|fund-holdings/.test(u)) return "institutional";
    if (/dividend|payout|ex-div/.test(u)) return "dividends";
    if (/earnings/.test(u)) return "earnings";
    if (/estimates|price-target|ratings|forecast|consensus/.test(u)) return "estimates";
    if (/screener|screener\.ashx|\/screen\b/.test(u)) return "screener";
    if (/financial|balance-sheet|income-statement|cash-flow|statements/.test(u)) return "financials";
    if (/\/news|\/story|\/articles?\/|press-release|\/video/.test(u)) return "news";
    if (/analysis|opinion|research|\/ideas\//.test(u)) return "analysis";
    if (/\/charts?\b|interactive-chart|technical/.test(u)) return "charts";
    if (/community|forum|message-board|comments|conversations/.test(u)) return "community";
    if (/options/.test(u)) return "options";
    if (/holders|ownership/.test(u)) return "ownership";
    if (/profile|\/company\//.test(u)) return "profile";
    return null;
  }

  const api = { detect, classifyUrl, parsePattern, compileCustom, buildSymbol, normBase, escapeRx, EXCH, BUILTINS };
  if (typeof self !== "undefined") self.ATPortals = api;
})();
