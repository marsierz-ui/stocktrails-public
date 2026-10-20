// Deterministic synthetic investors, for tests and demos. No real data.
//
// buildWorld(opts) returns the input for ATDecisions.analyze plus the effects
// that were planted, so a test can check that an analysis finds what is really
// there and stays quiet when nothing is. The market is a random walk that
// alternates calm and turbulent stretches; every stock path is built backwards
// from the return a buy is meant to have, so "buys after a run-up do 3 points
// worse" is true by construction, not by luck.
//
// Works in Node (require) and in a browser page (self.SynthWorld).
(function () {
  const DAY = 864e5;

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DEFAULTS = {
    seed: 11, bars: 900, nBuys: 110, nPassed: 30,
    base: 0.004,          // mean 21-day excess return of a buy without any planted effect
    noise: 0.06,          // sd of that excess
    runupMean: 0,         // average rise between first look and buy (0.04 = the user tends to buy after rises)
    chase: 0,             // excess per +10% run-up between first look and buy (e.g. -0.025)
    impulse: 0, impulseShare: 0.15, // extra excess of buys made within an hour of the first look
    impulseShareLate: null, lateAt: 0.75, // the impulse share for the buys after lateAt (in time): a habit that fades or grows
    evening: 0,           // extra excess of buys placed at 21 h or later
    turbulent: 0,         // extra excess of buys made in turbulent markets
    oversize: 1,          // size multiplier in turbulent markets
    research: 0,          // extra excess of buys with research in the 30 days before
    oversizeUnresearched: 1, // size multiplier of buys with no look before (a big buy of a stock never looked at)
    passedEdge: 0,        // 63-day excess of Positive calls that were passed on
    valuationEdge: 0,     // extra 63-day excess of passed-on calls whose note argues from valuation
    nAvoid: 15, avoidEdge: 0, // Negative calls on stocks never held, and their 63-day excess
    shiftAt: 1,           // planted effects hold for this share of the buys (in time), then stop
    growth: 0.25,         // yearly growth of the usual buy
    sellShare: 0.7,       // share of positions that are later sold
    appStartAt: null,     // the user starts using the app at this share of the bars: earlier views come from a history import (source "history")
    after: null,          // { runupMean, impulseShare }: how the user buys after the app start (each unset = as before)
    crowd: null,          // { follow, edge21 }: community views; a `follow` share of buys comes right after a crowd spike, with `edge21` extra 21-day excess
    weekdays: false,      // bars on weekdays only, as on a market calendar (default: one bar per calendar day)
    hours: null           // [[hour, share], ...]: when buys are placed (default: 9 h 40%, 13 h 25%, 21 h 35%)
  };

  const RATIONALES = {
    valuation: ["Trades at a discount to peers on forward earnings and the balance sheet is clean.", "Free cash flow yield of 7 percent, cheap versus its own history."],
    momentum: ["Breaking out to new highs with strong volume, want to be in before it runs.", "Everyone is talking about it and the chart is straight up."],
    news: ["Beat earnings and raised guidance, the market has not priced it all in.", "New product announcement should lift revenue next quarter."],
    hype: ["Saw it trending on social media, feels like the next big thing.", "A friend says it will double, not going to miss this one."],
    gut: ["Just have a good feeling about this one.", "Looks right to me."]
  };

  function buildWorld(o) {
    o = Object.assign({}, DEFAULTS, o || {});
    const r = rng(o.seed), N = o.bars;
    const gauss = function () { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
    const t0 = Date.parse("2024-01-02T12:00:00Z");
    const dates = [];
    for (let t = t0; dates.length < N; t += DAY) { const w = new Date(t).getUTCDay(); if (!o.weekdays || (w !== 0 && w !== 6)) dates.push(new Date(t).toISOString().slice(0, 10)); }
    const noon = function (bar) { return Date.parse(dates[bar] + "T12:00:00Z"); }; // t0 + bar days without weekdays

    // Market: calm / turbulent stretches of 30-90 bars.
    const turb = new Array(N).fill(false), bench = [];
    for (let i = 0, on = false; i < N;) { const len = 30 + Math.floor(r() * 61); for (let k = 0; k < len && i < N; k++, i++) turb[i] = on; on = !on; }
    let c = 100;
    for (let i = 0; i < N; i++) { c *= 1 + 0.0004 + (turb[i] ? 0.017 : 0.006) * gauss(); bench.push({ date: dates[i], close: c }); }
    const br = function (i, j) { return bench[j].close / bench[i].close - 1; };

    // A stock path through anchors {bar: value}, with a bridge of daily noise between them.
    const stockPath = function (anchors) {
      const idx = Object.keys(anchors).map(Number).sort(function (a, b) { return a - b; });
      const p = new Array(N);
      let v = anchors[idx[0]];
      p[idx[0]] = v;
      let back = v;
      for (let i = idx[0] - 1; i >= 0; i--) { back /= 1 + 0.01 * gauss(); p[i] = back; }
      for (let a = 0; a + 1 < idx.length; a++) {
        const i0 = idx[a], i1 = idx[a + 1], n = i1 - i0, v0 = anchors[i0], v1 = anchors[i1];
        let w = 0; const ws = [0];
        for (let k = 1; k <= n; k++) { w += 0.01 * gauss(); ws.push(w); }
        for (let k = 1; k <= n; k++) p[i0 + k] = v0 * Math.pow(v1 / v0, k / n) * Math.exp(ws[k] - (k / n) * ws[n]);
      }
      let fwd = anchors[idx[idx.length - 1]];
      for (let i = idx[idx.length - 1] + 1; i < N; i++) { fwd *= 1 + 0.01 * gauss(); p[i] = fwd; }
      return p.map(function (x, i) { return { date: dates[i], close: x }; });
    };

    const local = function (bar, hour, minute) { const d = new Date(noon(bar)); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute || 0).getTime(); };
    const txs = [], events = [], intraday = [], links = {}, prices = {}, tsym = {}, truth = { buys: [], passed: [], planted: {} };
    ["chase", "impulse", "evening", "turbulent", "oversize", "research", "passedEdge", "shiftAt"].forEach(function (k) { truth.planted[k] = o[k]; });

    // Buy bars: spread over the middle of the history, at least 3 apart.
    const lo = 130, hi = N - 70, picks = [];
    while (picks.length < o.nBuys) {
      const j = lo + Math.floor(r() * (hi - lo));
      if (picks.every(function (q) { return Math.abs(q - j) >= 3; })) picks.push(j);
    }
    picks.sort(function (a, b) { return a - b; });
    const hours = o.hours || [[9, 0.4], [13, 0.25], [21, 0.35]];
    const appBar = o.appStartAt != null ? Math.floor(o.appStartAt * N) : null;
    // the crowd option draws from its own stream, so every other world stays as it was
    const cr = o.crowd ? rng(o.seed + 1000) : null, follows = {};

    picks.forEach(function (j, k) {
      const tk = "S" + k, isin = "US" + String(1000000 + k) + "00", active = (k + 0.5) / o.nBuys <= o.shiftAt;
      const post = appBar != null && o.after && j >= appBar ? o.after : {};
      const late = (k + 0.5) / o.nBuys > o.lateAt, impulse = r() < (post.impulseShare != null ? post.impulseShare : late && o.impulseShareLate != null ? o.impulseShareLate : o.impulseShare), lead = impulse ? 0 : Math.max(1, Math.round(Math.exp(r() * Math.log(45)))), first = Math.max(2, j - lead);
      const hr = (function () { let u = r(), s = 0; for (let h = 0; h < hours.length; h++) { s += hours[h][1]; if (u <= s) return hours[h][0]; } return 9; })();
      const evening = hr >= 21, isTurb = turb[j - 1];
      const nViews = impulse ? 1 + Math.floor(r() * 3) : (r() < 0.2 ? 0 : 1 + Math.floor(r() * 7)), researched = nViews > 0;
      // no first look, or one made as the trade was placed: no stretch between look and buy to rise in
      const runup = researched && !impulse ? (post.runupMean != null ? post.runupMean : o.runupMean) + 0.09 * gauss() : 0;
      let ex = o.base + o.noise * gauss();
      if (active) ex += o.chase * (runup / 0.1) + (impulse ? o.impulse : 0) + (evening ? o.evening : 0) + (isTurb ? o.turbulent : 0) + (researched ? o.research : 0);
      const follow = !!cr && cr() < o.crowd.follow;
      if (follow) { follows[tk] = j; ex += o.crowd.edge21; }
      const pFirst = 100, pBuy = pFirst * (1 + runup), p21 = pBuy * (1 + br(j, j + 21) + ex), p63 = p21 * (1 + br(j + 21, j + 63) + 0.05 * gauss());
      const hold = 25 + Math.floor(r() * 170), sellBar = j + hold, anchors = {};
      anchors[first] = pFirst; anchors[j] = pBuy; anchors[j + 21] = p21; anchors[j + 63] = p63;
      // the rise happens in the last 20 days before the buy, so the rise since the first look and the rise in the last 30 days agree
      if (j - 20 > first) anchors[j - 20] = pFirst;
      prices[tk] = stockPath(anchors); tsym[tk] = tk; links[isin] = { ticker: tk, symbol: tk };
      const growth = Math.pow(1 + o.growth, j / 365), amount = Math.round(300 * growth * (1 + 0.25 * gauss()) * (isTurb ? o.oversize : 1) * (nViews === 0 ? o.oversizeUnresearched : 1));
      const minute = Math.floor(r() * 50);
      const ts = local(j, hr, minute);
      txs.push({ broker: "synth", extId: "b" + k, ts: ts, date: dates[j], kind: "buy", isin: isin, symbol: tk, name: tk + " Corp", qty: 1, amount: Math.max(20, amount), currency: "EUR", assetClass: "STOCK" });
      if (r() < o.sellShare && sellBar < N - 2) {
        const sp = prices[tk][sellBar].close / pBuy;
        txs.push({ broker: "synth", extId: "s" + k, ts: local(sellBar, 10, 5), date: dates[sellBar], kind: "sell", isin: isin, symbol: tk, name: tk + " Corp", qty: 1, amount: Math.round(Math.max(20, amount) * sp), currency: "EUR", assetClass: "STOCK" });
      }
      // a Negative call on the position: before most sales, and sometimes one that is not followed by a sale
      if (r() < 0.3) {
        const sold = txs[txs.length - 1].kind === "sell" && txs[txs.length - 1].extId === "s" + k;
        const callBar = sold ? Math.max(j + 3, sellBar - 3 - Math.floor(r() * 12)) : j + 10 + Math.floor(r() * 60);
        if (callBar < N - 40) events.push({ id: "ne" + k, ticker: tk, ts: local(callBar, 20, 30), sentiment: "negative", views: 1, rationale: null });
      }
      // research: a first look, then the rest spread up to the day before
      const firstTs = impulse ? ts - 20 * 60000 : local(first, 8 + Math.floor(r() * 10), Math.floor(r() * 60));
      const types = ["overview", "news", "financials", "analysis", "community", "charts"];
      if (nViews > 0) intraday.push({ id: "i" + k + "-0", ticker: tk, ts: firstTs, dwellMs: 30000 + Math.floor(r() * 150000), researchType: types[Math.floor(r() * 6)], scrollDepth: r(), focusSwitches: Math.floor(r() * 4) });
      for (let v = 1; v < nViews; v++) {
        // an impulse buy's other views fall between its first look and the buy, not on the day before
        const bar = first + Math.floor(r() * Math.max(1, j - first)), hh = 8 + Math.floor(r() * 12), mm = Math.floor(r() * 60);
        const t = impulse ? firstTs + Math.round((ts - firstTs) * v / nViews) : local(Math.min(bar, j - 1), hh, mm);
        intraday.push({ id: "i" + k + "-" + v, ticker: tk, ts: t, dwellMs: 20000 + Math.floor(r() * 200000), researchType: types[Math.floor(r() * 6)], scrollDepth: r(), focusSwitches: Math.floor(r() * 4) });
      }
      // a Positive call before most buys, with a written reason
      let rationale = null, rType = null;
      if (r() < 0.7) {
        const callBar = Math.max(first, j - 2 - Math.floor(r() * 10));
        rType = ["valuation", "momentum", "news", "hype", "gut"][Math.floor(r() * 5)];
        rationale = RATIONALES[rType][Math.floor(r() * RATIONALES[rType].length)];
        events.push({ id: "e" + k, ticker: tk, ts: local(callBar, 20, 0), sentiment: "positive", views: nViews, rationale: rationale, targetPrice: r() < 0.5 ? Math.round(pBuy * 1.15 * 100) / 100 : null });
      }
      truth.buys.push({ k: k, ticker: tk, bar: j, runup: runup, impulse: impulse, evening: evening, turbulent: isTurb, researched: researched, ex21: ex, rationaleType: rType });
      if (cr) truth.buys[truth.buys.length - 1].crowd = follow;
    });

    // Positive calls that were never acted on
    for (let m = 0; m < o.nPassed; m++) {
      const tk = "P" + m, bar = 130 + Math.floor(r() * (N - 130 - 70)), p0 = 100;
      const rType = ["valuation", "momentum", "news", "hype", "gut"][Math.floor(r() * 5)];
      const p63 = p0 * (1 + br(bar, bar + 63) + o.passedEdge + (rType === "valuation" ? o.valuationEdge : 0) + 0.12 * gauss());
      prices[tk] = stockPath({ [bar]: p0, [bar + 63]: p63 }); tsym[tk] = tk;
      links["US" + String(2000000 + m) + "00"] = { ticker: tk, symbol: tk };
      events.push({ id: "pe" + m, ticker: tk, ts: local(bar, 20, 0), sentiment: "positive", views: 2, rationale: RATIONALES[rType][0] });
      intraday.push({ id: "pi" + m, ticker: tk, ts: local(bar, 19, 0), dwellMs: 60000, researchType: "overview", scrollDepth: 0.5, focusSwitches: 0 });
      truth.passed.push({ ticker: tk, bar: bar, rationaleType: rType });
    }
    for (let m = 0; m < o.nAvoid; m++) {
      const tk = "N" + m, bar = 130 + Math.floor(r() * (N - 130 - 70)), p63 = 100 * (1 + br(bar, bar + 63) + o.avoidEdge + 0.12 * gauss());
      prices[tk] = stockPath({ [bar]: 100, [bar + 63]: p63 }); tsym[tk] = tk;
      links["US" + String(3000000 + m) + "00"] = { ticker: tk, symbol: tk };
      events.push({ id: "ae" + m, ticker: tk, ts: local(bar, 20, 0), sentiment: "negative", views: 1, rationale: null });
      intraday.push({ id: "ai" + m, ticker: tk, ts: local(bar, 19, 0), dwellMs: 40000, researchType: "news", scrollDepth: 0.4, focusSwitches: 0 });
    }
    intraday.push({ id: "seed", ticker: "S0", ts: t0, dwellMs: 1000, researchType: "overview" }); // recording starts on day 0
    if (appBar != null) intraday.forEach(function (e) { if (e.ts < noon(appBar)) e.source = "history"; });
    intraday.sort(function (a, b) { return a.ts - b.ts; });
    const input = { txs: txs, links: links, intraday: intraday, events: events, prices: prices, bench: bench, tickerSymbol: tsym, now: noon(N - 1) + 18 * 3600e3 };
    if (cr) input.community = crowdRows(cr, Object.keys(prices), follows, events, dates);
    return { input: input, truth: truth, dates: dates, options: o };
  }

  // network_community_daily() rows for every stock: small background counts (Poisson,
  // a rate of 0.2-1.5 views a day), a spike of 3 days of 4-10 views about every 150 days,
  // a spike in the 3 days before each following buy, and the user's own views, which
  // the RPC counts too: each daily event's views on the New York day of its ts (at or
  // after 16:00 ET on the next day).
  function crowdRows(cr, tickers, follows, events, dates) {
    const N = dates.length, own = {};
    const et = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    events.forEach(function (e) {
      const p = {};
      et.formatToParts(new Date(e.ts)).forEach(function (x) { p[x.type] = x.value; });
      let d = p.year + "-" + p.month + "-" + p.day;
      if (+p.hour >= 16) d = new Date(Date.parse(d) + DAY).toISOString().slice(0, 10);
      const m = own[e.ticker] = own[e.ticker] || {};
      m[d] = (m[d] || 0) + (e.views == null ? 1 : e.views);
    });
    const spike = function (v, i0) { for (let i = Math.max(0, i0); i < i0 + 3 && i < N; i++) v[i] += 4 + Math.floor(cr() * 7); };
    return tickers.map(function (tk) {
      const v = [], lam = 0.2 + cr() * 1.3;
      for (let i = 0; i < N; i++) { let k = 0, q = cr(); while (q > Math.exp(-lam)) { k++; q *= cr(); } v.push(k); }
      for (let s = 0; s < N / 150; s++) spike(v, Math.floor(cr() * N));
      if (follows[tk] != null) spike(v, follows[tk] - 3);
      const days = [];
      dates.forEach(function (d, i) { const n = v[i] + ((own[tk] || {})[d] || 0); if (n) days.push([d, n, 0, 0, 0]); });
      return { ticker: tk, entry_ts: Date.parse(dates[0] + "T15:00:00Z"), entry_price: 100, days: days };
    });
  }

  // One investor per habit, each with only that habit planted, for the execution evidence
  // (tools/persona-runs.js) and the sandbox (?persona=<id>). `bias` is the coach's bias id.
  // `base` lifts the other buys so that the average buy roughly matches the market: the
  // coach values a rule against holding the index, and if every buy lost, skipping any
  // buy would look like a good rule.
  const PERSONAS = {
    fomo: { label: "The FOMO buyer", bias: "chasing", habit: "Buys after a stock has risen: on average +12% in the 20 days before the buy; every +10% of rise costs 7 points over the next month.",
      opts: { runupMean: 0.12, chase: -0.07, base: 0.04 } },
    first_hour: { label: "The first-hour impulse buyer", bias: "impulse", habit: "40% of buys come within an hour of first looking at the stock; those buys do 9 points worse over the next month.",
      opts: { impulseShare: 0.4, impulse: -0.09, base: 0.036 } },
    night_trader: { label: "The night trader", bias: "bad_hour", habit: "About half of the buys are placed at 22:00 or later, after the market has closed; those buys do 8 points worse over the next month.",
      opts: { hours: [[9, 0.25], [13, 0.2], [22, 0.55]], evening: -0.08, base: 0.044 } },
    yolo: { label: "The YOLO trader", bias: "turbulence", habit: "Buys in turbulent markets are 2.5x the usual size and do 8 points worse over the next month.",
      opts: { turbulent: -0.08, oversize: 2.5, base: 0.025 } },
    herd: { label: "Follow the throng", bias: "crowd_buys", habit: "35% of buys come right after a spike in other users' attention on the stock; those buys do 8 points worse over the next month.",
      opts: { crowd: { follow: 0.35, edge21: -0.08 }, base: 0.02 } }
  };

  const api = { buildWorld: buildWorld, DEFAULTS: DEFAULTS, RATIONALES: RATIONALES, PERSONAS: PERSONAS, rng: rng };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof self !== "undefined") self.SynthWorld = api;
})();
