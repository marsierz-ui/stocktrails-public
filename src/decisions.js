(function () {
  // Research -> decision analytics. Pure functions over plain arrays, so the
  // whole thing runs (and is tested) without a browser.
  //
  // Unit of analysis: a DECISION - all fills of one instrument on one side on
  // one day. Savings-plan executions are not decisions (nobody decided that
  // day), and trades from before attention capture began cannot be compared
  // with research that was never recorded, so both are set aside.
  //
  // Every question reports a sample size and a status:
  //   none        - below the minimum; nothing is concluded
  //   indicative  - enough to show an estimate, with a wide interval
  //   solid       - large enough that the interval is informative
  // and `clear` when the interval (or permutation p) rules out "no effect".

  const DAY = 86400000;
  const PRE = 30 * DAY;           // research window before a decision
  const ELIGIBLE = { STOCK: 1, ETF: 1, FUND: 1 };
  const NEED = {
    q1: { min: 10, solid: 30 },
    q2: { min: 10, solid: 30 },
    q3: { min: 8, solid: 30 },    // per group (researched / not)
    q4: { min: 10, solid: 30 },   // buys; sells need half
    q5: { min: 10, solid: 30 },   // per group (passed / bought)
    fomo: { min: 8, solid: 30 },  // per group (calls that rose / fell)
    pages: { min: 8, solid: 30 }, // per group (with / without a page type)
    impulse: { min: 10, solid: 30 },
    lead: { min: 10, solid: 30 },    // buys with a recorded first look
    hours: { min: 20, solid: 60 },   // timed buys with a month of prices after
    grid: { min: 45, solid: 150 },   // timed buys for the conviction x time-of-day grid (15 cells)
    runup: { min: 8, solid: 30 },    // per group (rose / fell since the first look)
    sizing: { min: 10, solid: 30 },
    portfolio: { min: 3, solid: 12 }, // months
    volatility: { min: 12, solid: 52 }, // weeks of views vs volatility
    market: { min: 20, solid: 60 },  // buys with market context (size by volatility, dip or chase)
    avoid: { min: 8, solid: 25 },    // Negative calls on stocks not held
    targets: { min: 5, solid: 15 },  // targets reached while held
    disposition: { min: 10, solid: 30 } // days with a sale
  };

  // ---------- small stats ----------

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
  function mean(a) { if (!a.length) return null; let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function median(a) {
    if (!a.length) return null;
    const s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // Wilson score interval: honest at small n and near 0% / 100%.
  // zz: 1.96 (95%, default) or 2.576 (99%, several ranges read side by side).
  function wilson(k, n, zz) {
    if (!n) return { p: null, lo: null, hi: null, k: k, n: n };
    const z = zz || 1.96, p = k / n, d = 1 + z * z / n;
    const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return { p: p, lo: Math.max(0, c - h), hi: Math.min(1, c + h), k: k, n: n };
  }
  // Percentile bootstrap of mean(a) - mean(b) (b omitted: of mean(a)).
  // level 0.99 widens the range where several comparisons run side by side.
  function bootstrap(a, b, R, seed, level) {
    const r = rng(seed || 7), out = [], tail = (1 - (level || 0.95)) / 2;
    const pick = function (x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[(r() * x.length) | 0]; return s / x.length; };
    for (let i = 0; i < R; i++) out.push(b ? pick(a) - pick(b) : pick(a));
    out.sort(function (x, y) { return x - y; });
    return { est: b ? mean(a) - mean(b) : mean(a), lo: out[Math.floor(R * tail)], hi: out[Math.ceil(R * (1 - tail)) - 1] };
  }
  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }
  function ranks(xs) {
    const idx = xs.map(function (v, i) { return [v, i]; }).sort(function (a, b) { return a[0] - b[0]; });
    const r = new Array(xs.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; // ties share their average rank
      i = j + 1;
    }
    return r;
  }
  // Correlation with a range from Fisher's z (1.06 widening for Spearman);
  // 95% unless `level` is 0.99 (several correlations judged side by side).
  function corr(xs, ys, spearman, level) {
    const n = xs.length, zc = level === 0.99 ? 2.576 : 1.96;
    const r = spearman ? pearson(ranks(xs), ranks(ys)) : pearson(xs, ys);
    if (r == null || n < 5) return { r: r, n: n, lo: null, hi: null, level: level || 0.95 };
    const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r))), se = (spearman ? 1.06 : 1) / Math.sqrt(n - 3);
    return { r: r, n: n, lo: Math.tanh(z - zc * se), hi: Math.tanh(z + zc * se), level: level || 0.95 };
  }
  function stdev(a) {
    if (a.length < 2) return null;
    const m = mean(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  }
  function status(n, need) { return n >= need.solid ? "solid" : n >= need.min ? "indicative" : "none"; }
  function excludesZero(ci) { return ci && ci.lo != null && (ci.lo > 0 || ci.hi < 0); }
  function numeric(a, b) { return a - b; }
  // Linear-interpolated quantile of an ascending array.
  function quantile(s, q) {
    if (!s.length) return null;
    const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return s[lo] + (s[hi] - s[lo]) * (p - lo);
  }
  // Where v falls in an ascending array: the share below it, ties counting half
  // (0.5 = the median, 0 = lower than everything).
  function pctRank(s, v) {
    if (!s.length) return null;
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < v) lo = m + 1; else hi = m; }
    let up = lo;
    while (up < s.length && s[up] === v) up++;
    return (lo + (up - lo) / 2) / s.length;
  }
  // What chance gives for a statistic of a set of buys measured against the
  // market. `at` holds each buy's position among the covered days `bd`; `stat`
  // takes the days the buys fall on (one per buy, same order) and returns an
  // array of numbers (null allowed). Every shift of the whole pattern along the
  // calendar, wrapping round, is one chance outcome: the buys keep their spacing,
  // bursts and gaps, the market keeps its calm and turbulent stretches, and only
  // how the two line up changes. Per number: est, the 0.5% and 99.5% points of
  // the chance outcomes (a 99% range), their median, and a two-sided p.
  function shiftTest(bd, at, stat) {
    const M = bd.length, obs = stat(at.map(function (i) { return bd[i]; })), cols = obs.map(function () { return []; });
    for (let s = 1; s < M; s++) {
      const v = stat(at.map(function (i) { return bd[(i + s) % M]; }));
      for (let k = 0; k < v.length; k++) if (v[k] != null && isFinite(v[k])) cols[k].push(v[k]);
    }
    return obs.map(function (o, k) {
      const c = cols[k].sort(numeric);
      if (o == null || c.length < 20) return { est: o, lo: null, hi: null, center: null, p: null };
      const mid = quantile(c, 0.5);
      let ge = 0;
      for (let i = 0; i < c.length; i++) if (Math.abs(c[i] - mid) >= Math.abs(o - mid) - 1e-12) ge++;
      return { est: o, lo: quantile(c, 0.005), hi: quantile(c, 0.995), center: mid, p: (1 + ge) / (c.length + 1) };
    });
  }
  // Percentile bootstrap of a weighted mean: pairs are resampled together.
  function bootWeighted(xs, ws, R, seed, level) {
    const r = rng(seed || 7), n = xs.length, tail = (1 - (level || 0.95)) / 2, out = [];
    let sw0 = 0, s0 = 0;
    for (let i = 0; i < n; i++) { sw0 += ws[i]; s0 += ws[i] * xs[i]; }
    for (let b = 0; b < R; b++) {
      let sw = 0, s = 0;
      for (let i = 0; i < n; i++) { const j = (r() * n) | 0; sw += ws[j]; s += ws[j] * xs[j]; }
      out.push(s / sw);
    }
    out.sort(numeric);
    return { est: sw0 ? s0 / sw0 : null, lo: out[Math.floor(R * tail)], hi: out[Math.ceil(R * (1 - tail)) - 1] };
  }

  // ---------- time + series ----------

  // 16:00 ET close of a YYYY-MM-DD date: 20:00 UTC under EDT, 21:00 UTC under EST.
  function usClose(date) {
    const t = Date.parse(date + "T20:00:00Z");
    const h = +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(t);
    return h === 16 ? t : t + 3600000;
  }
  function isoDay(ts) { return new Date(ts).toISOString().slice(0, 10); }
  function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
  function dateIdx(series, date) { // first bar on or after date
    let lo = 0, hi = series.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (series[m].date < date) lo = m + 1; else hi = m; }
    return lo < series.length ? lo : -1;
  }
  function closeOnOrBefore(series, date) {
    let lo = 0, hi = series.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (series[m].date <= date) lo = m + 1; else hi = m; }
    return lo > 0 ? series[lo - 1].close : null;
  }

  // Forward return from the close of the trade day, minus the benchmark over
  // the same bars. Yahoo closes on both ends keep the currency consistent even
  // when the broker settled in another currency than the listing trades in.
  // `end` is when the outcome is known: the end bar's date at 21:00 UTC, which is
  // 16:00 ET or later (and after the close of a non-US listing).
  function forward(series, bench, date, h) {
    if (!series || !series.length) return null;
    const i0 = dateIdx(series, date);
    if (i0 < 0 || i0 + h >= series.length) return null;
    const c0 = series[i0].close, c1 = series[i0 + h].close;
    if (!(c0 > 0)) return null;
    const r = c1 / c0 - 1;
    let br = 0;
    if (bench && bench.length) {
      const b0 = closeOnOrBefore(bench, series[i0].date), b1 = closeOnOrBefore(bench, series[i0 + h].date);
      if (!(b0 > 0) || b1 == null) return null;
      br = b1 / b0 - 1;
    }
    return { r: r, ex: r - br, end: Date.parse(series[i0 + h].date + "T21:00:00Z") };
  }

  // Excess return after every trading day from the close of the trade day, day 0
  // to day h: element h equals forward(...).ex. Null when the series is too short.
  function forwardPath(series, bench, date, h) {
    if (!series || !series.length) return null;
    const i0 = dateIdx(series, date);
    if (i0 < 0 || i0 + h >= series.length) return null;
    const c0 = series[i0].close;
    if (!(c0 > 0)) return null;
    const hasB = bench && bench.length, b0 = hasB ? closeOnOrBefore(bench, series[i0].date) : 0;
    if (hasB && !(b0 > 0)) return null;
    const out = [0];
    for (let k = 1; k <= h; k++) {
      let br = 0;
      if (hasB) { const b1 = closeOnOrBefore(bench, series[i0 + k].date); if (b1 == null) return null; br = b1 / b0 - 1; }
      out.push(series[i0 + k].close / c0 - 1 - br);
    }
    return out;
  }

  // Mean path with a bootstrap range at every day. Whole paths are resampled
  // together, so the band is coherent across days. level defaults to 95%.
  function pathBand(paths, R, seed, level) {
    const n = paths.length;
    if (!n) return null;
    const H = paths[0].length, mean = new Array(H).fill(0);
    paths.forEach(function (p) { for (let k = 0; k < H; k++) mean[k] += p[k] / n; });
    if (n < 2) return { n: n, mean: mean, lo: mean.slice(), hi: mean.slice() };
    const r = rng(seed || 5), tail = (1 - (level || 0.95)) / 2, acc = [];
    for (let k = 0; k < H; k++) acc.push(new Array(R));
    for (let b = 0; b < R; b++) {
      const s = new Array(H).fill(0);
      for (let i = 0; i < n; i++) { const p = paths[(r() * n) | 0]; for (let k = 0; k < H; k++) s[k] += p[k]; }
      for (let k = 0; k < H; k++) acc[k][b] = s[k] / n;
    }
    const lo = [], hi = [];
    for (let k = 0; k < H; k++) { acc[k].sort(numeric); lo.push(acc[k][Math.floor(R * tail)]); hi.push(acc[k][Math.ceil(R * (1 - tail)) - 1]); }
    return { n: n, mean: mean, lo: lo, hi: hi };
  }

  // ---------- market context ----------

  // For every benchmark bar, from the bars up to and including it: the return
  // over 20 bars, the volatility (stdev of the last 20 daily returns) and the
  // distance from the highest close of the last 252 bars (0 at a high, negative
  // below it).
  function marketSeries(bench) {
    const n = bench.length, ret20 = new Array(n).fill(null), vol20 = new Array(n).fill(null), dd = new Array(n).fill(null);
    const dr = new Array(n).fill(null);
    for (let i = 1; i < n; i++) dr[i] = bench[i].close / bench[i - 1].close - 1;
    for (let i = 20; i < n; i++) {
      ret20[i] = bench[i].close / bench[i - 20].close - 1;
      vol20[i] = stdev(dr.slice(i - 19, i + 1));
    }
    for (let i = 59; i < n; i++) {
      let hi = 0;
      for (let k = Math.max(0, i - 251); k <= i; k++) if (bench[k].close > hi) hi = bench[k].close;
      dd[i] = hi > 0 ? bench[i].close / hi - 1 : null;
    }
    return { ret20: ret20, vol20: vol20, dd: dd };
  }
  // Index of the last bar strictly before a date: what a trade on that day could have seen.
  function barBefore(bench, date) {
    let lo = 0, hi = bench.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (bench[m].date < date) lo = m + 1; else hi = m; }
    return lo - 1;
  }

  // Size of each buy against the user's usual buy at that time: the median of
  // their buys in the same currency over the previous 6 months (12, then 24
  // months when that holds fewer than 4 buys). The usual buy grows with wealth,
  // so a fixed median would read every later buy as large. The window is months,
  // not the last few buys, because markets stay calm or turbulent for weeks: a
  // short window would learn the regime and hide the very effect that question
  // 10 looks for. A median that trails growth by half its window leaves a
  // roughly constant factor, not a trend. Only earlier buys are used.
  function trailingSizes(decs) {
    const by = {};
    decs.forEach(function (d) {
      d.usual = null; d.relSize = null;
      if (d.side === "buy" && !d.auto && d.amount > 0 && (!d.assetClass || ELIGIBLE[d.assetClass])) (by[d.currency || "?"] = by[d.currency || "?"] || []).push(d);
    });
    const before = function (list, i, span) {
      const prior = [];
      for (let k = i - 1; k >= 0; k--) {
        if (list[i].cut - list[k].cut > span * DAY) break;
        prior.push(list[k].amount);
      }
      return prior;
    };
    Object.keys(by).forEach(function (c) {
      const list = by[c];
      list.forEach(function (d, i) {
        let prior = [];
        for (let s = 0; s < 3 && prior.length < 4; s++) prior = before(list, i, [183, 365, 730][s]);
        if (prior.length >= 4) { d.usual = median(prior); d.relSize = d.amount / d.usual; }
      });
    });
  }

  // The usual buy in a currency at a moment: the median the sizes are judged
  // against (see trailingSizes), for a buy that has not been made yet.
  function usualSize(decs, ts, currency) {
    const list = decs.filter(function (d) { return d.side === "buy" && !d.auto && d.amount > 0 && (d.currency || "?") === (currency || "?") && (!d.assetClass || ELIGIBLE[d.assetClass]) && d.cut <= ts; });
    let prior = [];
    for (let s = 0; s < 3 && prior.length < 4; s++) {
      const span = [183, 365, 730][s] * DAY;
      prior = list.filter(function (d) { return ts - d.cut <= span; }).map(function (d) { return d.amount; });
    }
    return prior.length >= 4 ? median(prior) : null;
  }

  // ---------- attention index ----------

  // Per ticker: sorted timestamps with prefix sums of views and dwell, so any
  // window count is two binary searches.
  function indexAttention(intraday, daily) {
    const src = intraday && intraday.length ? intraday : (daily || []);
    const weightOf = intraday && intraday.length ? function () { return 1; } : function (e) { return e.views || 1; };
    const by = {};
    src.forEach(function (e) { if (e && e.ticker && e.ts) (by[e.ticker] = by[e.ticker] || []).push(e); });
    const idx = {};
    Object.keys(by).forEach(function (t) {
      const arr = by[t].sort(function (a, b) { return a.ts - b.ts; });
      const ts = [], cv = [0], cd = [0];
      arr.forEach(function (e, i) { ts.push(e.ts); cv.push(cv[i] + weightOf(e)); cd.push(cd[i] + (e.dwellMs || 0)); });
      idx[t] = { ts: ts, cv: cv, cd: cd };
    });
    return idx;
  }
  function views(idx, t, from, to) {
    const x = idx[t]; if (!x) return 0;
    return x.cv[lowerBound(x.ts, to)] - x.cv[lowerBound(x.ts, from)];
  }
  function dwellMin(idx, t, from, to) {
    const x = idx[t]; if (!x) return 0;
    return (x.cd[lowerBound(x.ts, to)] - x.cd[lowerBound(x.ts, from)]) / 60000;
  }
  function lastBefore(idx, t, cut) { const x = idx[t]; if (!x) return null; const i = lowerBound(x.ts, cut) - 1; return i >= 0 ? x.ts[i] : null; }
  function firstTs(idx, t) { const x = idx[t]; return x && x.ts.length ? x.ts[0] : null; }
  function activeDays(idx, t, from, to) {
    const x = idx[t]; if (!x) return 0;
    const s = {};
    for (let i = lowerBound(x.ts, from), e = lowerBound(x.ts, to); i < e; i++) s[isoDay(x.ts[i])] = 1;
    return Object.keys(s).length;
  }

  // ---------- decisions ----------

  function instKey(t) { return t.isin || ("SYM:" + String(t.symbol || "").toUpperCase()); }

  // Fills -> decisions, with the position each one opened, added to, trimmed or
  // closed. A sale larger than the known position means the file starts after
  // the purchase; the sale is kept and flagged.
  function buildDecisions(txs) {
    const by = {};
    txs.forEach(function (t) {
      if (t.kind !== "buy" && t.kind !== "sell" && t.kind !== "adjust") return;
      (by[instKey(t)] = by[instKey(t)] || []).push(t);
    });
    // preHold: instrument -> time of its first sale larger than the position the
    // file shows. The shares sold beyond it were bought before the file starts,
    // so they were held until then.
    const out = [], timeline = {}, preHold = {};
    Object.keys(by).forEach(function (k) {
      const list = by[k].sort(function (a, b) { return a.ts - b.ts; });
      let pos = 0, cur = null;
      const tl = timeline[k] = [];
      const flush = function () {
        if (!cur) return;
        const before = pos, eps = 1e-6 * Math.max(1, cur.qty);
        if (cur.side === "buy") { pos += cur.qty; cur.cls = before <= eps ? "open" : "add"; }
        else {
          cur.incomplete = cur.qty > before + eps;
          if (cur.incomplete && preHold[k] == null) preHold[k] = cur.ts;
          pos = Math.max(0, pos - cur.qty);
          cur.cls = pos <= eps ? "close" : "trim";
          if (pos <= eps) pos = 0;
        }
        cur.posBefore = before; cur.posAfter = pos;
        tl.push({ ts: cur.ts, pos: pos });
        out.push(cur); cur = null;
      };
      list.forEach(function (t) {
        if (t.kind === "adjust") { flush(); pos = Math.max(0, pos + t.qty); tl.push({ ts: t.ts, pos: pos }); return; }
        if (cur && cur.side === t.kind && cur.date === t.date) {
          cur.qty += t.qty; cur.amount += t.amount || 0; cur.fills++;
          cur.dateOnly = cur.dateOnly && t.dateOnly; cur.plan = cur.plan || t.plan;
          return;
        }
        flush();
        cur = { inst: k, isin: t.isin, symbol: t.symbol, name: t.name, assetClass: t.assetClass, side: t.kind,
          date: t.date, ts: t.ts, dateOnly: t.dateOnly, qty: t.qty, amount: t.amount || 0, currency: t.currency,
          plan: !!t.plan, fills: 1, broker: t.broker };
      });
      flush();
    });
    markAutomatic(out);
    return { decisions: out.sort(function (a, b) { return a.ts - b.ts; }), timeline: timeline, preHold: preHold };
  }

  // Savings plans: the broker's flag where it gives one, else three or more
  // buys of one instrument at a regular cadence (weekly, bi-weekly, monthly,
  // quarterly) with amounts within +-25% of each other.
  function markAutomatic(decs) {
    const by = {};
    decs.forEach(function (d) { if (d.side === "buy") (by[d.inst] = by[d.inst] || []).push(d); });
    const bands = [[6, 8], [13, 16], [26, 35], [85, 95]];
    Object.keys(by).forEach(function (k) {
      const b = by[k];
      const reg = [];
      for (let i = 1; i < b.length; i++) {
        const gap = (b[i].ts - b[i - 1].ts) / DAY;
        const x = b[i].amount || b[i].qty, y = b[i - 1].amount || b[i - 1].qty;
        const ratio = y ? x / y : 0;
        reg.push(bands.some(function (r) { return gap >= r[0] && gap <= r[1]; }) && ratio >= 0.75 && ratio <= 1.33);
      }
      for (let i = 0; i < reg.length; i++) {
        let j = i;
        while (j < reg.length && reg[j]) j++;
        if (j - i >= 2) for (let m = i; m <= j; m++) b[m].auto = true;
        i = j;
      }
    });
    decs.forEach(function (d) { if (d.plan) d.auto = true; });
  }

  function posAt(tl, ts) {
    if (!tl || !tl.length) return 0;
    let p = 0;
    for (let i = 0; i < tl.length && tl[i].ts <= ts; i++) p = tl[i].pos;
    return p;
  }

  // Name a part of the day by the hour at its centre.
  function partName(h) {
    return h >= 22 || h < 6 ? "Night" : h < 11 ? "Morning" : h < 15 ? "Midday" : h < 18 ? "Afternoon" : "Evening";
  }

  // Cut the day where you rarely buy. Smooth the 24-hour histogram of buy times
  // (wrapping at midnight), take its peaks, and put each boundary at the deepest
  // valley between two neighbouring peaks. Needs at least two peaks and 12
  // timed buys; a part left with fewer than 3 buys loses its peak. Returns blocks
  // like the fixed ones, or null when the buys do not form separate clusters.
  function buyClusters(hours) {
    if (hours.length < 12) return null;
    const hist = new Array(24).fill(0);
    hours.forEach(function (h) { hist[h]++; });
    const K = [0.054, 0.244, 0.403, 0.244, 0.054];
    const sm = hist.map(function (_, i) { return K.reduce(function (s, k, j) { return s + k * hist[(i + j - 2 + 48) % 24]; }, 0); });
    const mx = Math.max.apply(null, sm);
    const cand = [];
    for (let i = 0; i < 24; i++) {
      if (sm[i] >= sm[(i + 23) % 24] && sm[i] > sm[(i + 1) % 24] && sm[i] >= 0.25 * mx) cand.push(i);
    }
    const dist = function (a, b) { const d = Math.abs(a - b); return Math.min(d, 24 - d); };
    let peaks = [];
    cand.sort(function (a, b) { return sm[b] - sm[a]; }).forEach(function (p) {
      if (peaks.length < 5 && peaks.every(function (q) { return dist(p, q) >= 3; })) peaks.push(p);
    });
    const cut = function (pk) {
      pk = pk.slice().sort(function (a, b) { return a - b; });
      const bounds = pk.map(function (p, i) {
        const q = pk[(i + 1) % pk.length], len = ((q - p + 24) % 24) || 24;
        let best = Infinity, at = [];
        for (let k = 1; k < len; k++) { const v = sm[(p + k) % 24]; if (v < best - 1e-9) { best = v; at = [k]; } else if (Math.abs(v - best) <= 1e-9) at.push(k); }
        return (p + at[Math.floor(at.length / 2)]) % 24;
      });
      // block i: from the boundary before peak i to the boundary after it
      return pk.map(function (p, i) { return { peak: p, from: bounds[(i - 1 + pk.length) % pk.length], to: bounds[i] }; });
    };
    const inBlock = function (b, h) { return b.from < b.to ? h >= b.from && h < b.to : h >= b.from || h < b.to; };
    let blocks;
    for (;;) {
      if (peaks.length < 2) return null;
      blocks = cut(peaks);
      const counts = blocks.map(function (b) { return hours.filter(function (h) { return inBlock(b, h); }).length; });
      const small = counts.indexOf(Math.min.apply(null, counts));
      if (counts[small] >= 3) break;
      peaks = peaks.filter(function (p) { return p !== blocks[small].peak; });
    }
    const used = {};
    return blocks.map(function (b) {
      let name = partName(b.peak), key = name.toLowerCase();
      used[key] = (used[key] || 0) + 1;
      if (used[key] > 1) { name += " " + used[key]; key += used[key]; }
      return { key: key, label: name, from: b.from, to: b.to };
    });
  }

  // Day parts the user defines: each part starts at one of the given hours and
  // runs to the next start; the last wraps past midnight. Needs at least two
  // distinct hours in 0-23 (anything else is ignored).
  function customBlocks(starts) {
    const hs = Array.from(new Set((starts || []).map(Number).filter(function (h) { return Number.isInteger(h) && h >= 0 && h <= 23; }))).sort(function (a, b) { return a - b; });
    if (hs.length < 2) return null;
    const used = {};
    return hs.map(function (h, i) {
      const to = hs[(i + 1) % hs.length], len = ((to - h + 24) % 24) || 24;
      let name = partName(Math.floor(h + len / 2) % 24), key = name.toLowerCase();
      used[key] = (used[key] || 0) + 1;
      if (used[key] > 1) { name += " " + used[key]; key += used[key]; }
      return { key: "c-" + key, label: name, from: h, to: to };
    });
  }

  // Conviction bands for a set of scores: the watchlist's fixed colours (up to 1,
  // up to 3, over 3) or thirds of this set. Ties go to the lower band, so when
  // more than a third of the scores are 0 (no research) the lowest band is
  // exactly those.
  function convBands(values, mode) {
    let c1 = 1, c2 = 3;
    if (mode !== "watchlist") {
      const s = values.slice().sort(function (a, b) { return a - b; }), n = s.length;
      c1 = n ? s[Math.max(0, Math.ceil(n / 3) - 1)] : 0;
      c2 = n ? s[Math.max(0, Math.ceil(2 * n / 3) - 1)] : 0;
    }
    const f = function (x) { return (Math.round(x * 10) / 10).toFixed(1); };
    return {
      cuts: [c1, c2],
      of: function (v) { return v <= c1 ? 0 : v <= c2 ? 1 : 2; },
      labels: [c1 === 0 ? "Low (no research)" : "Low (up to " + f(c1) + ")", "Middle (" + f(c1) + " to " + f(c2) + ")", "High (over " + f(c2) + ")"]
    };
  }

  // ---------- main ----------

  // input: { txs, links: {inst: {ticker, symbol, status}}, intraday, events,
  //          prices: {symbol: [{date, close}]}, bench, tickerSymbol: {ticker: symbol}, now }
  function analyze(input) {
    const now = input.now || Date.now();
    const txs = input.txs || [], links = input.links || {}, prices = input.prices || {};
    const bench = input.bench || [], tickerSym = input.tickerSymbol || {};
    const idx = indexAttention(input.intraday, input.events);

    const tickerOf = function (inst) { const l = links[inst]; return l && l.ticker && l.status !== "rejected" ? l.ticker : null; };
    const seriesOf = function (inst) { const l = links[inst]; return l && l.symbol ? prices[l.symbol] : null; };

    let firstAtt = null;
    Object.keys(idx).forEach(function (t) { const f = idx[t].ts[0]; if (f && (firstAtt == null || f < firstAtt)) firstAtt = f; });
    const coverStart = firstAtt == null ? null : firstAtt + PRE;
    const fileEnd = txs.length ? Math.max.apply(null, txs.map(function (t) { return t.ts; })) : null;
    const fileStart = txs.length ? Math.min.apply(null, txs.map(function (t) { return t.ts; })) : null;

    const built = buildDecisions(txs);
    const decs = built.decisions, timeline = built.timeline;
    const instsOfTicker = {};
    Object.keys(links).forEach(function (inst) { const t = tickerOf(inst); if (t) (instsOfTicker[t] = instsOfTicker[t] || []).push(inst); });

    // Held at ts: the file shows a position then, or a later sale larger than
    // anything the file bought shows shares from before the file started.
    const heldAt = function (insts, ts) {
      return insts.some(function (i) { return posAt(timeline[i], ts) > 0 || (built.preHold[i] != null && ts < built.preHold[i]); });
    };
    // A call can be judged only where the export covers it: the file has to
    // start before the call, or a purchase just after it could be missed.
    const coveredFrom = fileStart == null ? null : Math.min(fileStart, input.coveredFrom > 0 ? input.coveredFrom : fileStart);
    const callFrom = coverStart == null || coveredFrom == null ? null : Math.max(coverStart - PRE, coveredFrom);

    // What the NASDAQ looked like on the bars before each trade day (so nothing
    // from the trade day itself), and the same measures on every trading day of
    // the covered period: the base rate a buy is compared with.
    const ms = bench.length > 30 ? marketSeries(bench) : null;
    const mk = { ret: [], vol: [], dd: [] };
    if (ms && coverStart != null && fileStart != null && fileEnd != null) {
      const from = isoDay(Math.max(coverStart, fileStart)), to = isoDay(Math.min(fileEnd, now));
      for (let j = 1; j < bench.length; j++) {
        if (bench[j].date < from || bench[j].date > to) continue;
        const i = j - 1;
        if (ms.ret20[i] == null || ms.vol20[i] == null || ms.dd[i] == null) continue;
        mk.ret.push(ms.ret20[i]); mk.vol.push(ms.vol20[i]); mk.dd.push(ms.dd[i]);
      }
      mk.ret.sort(numeric); mk.vol.sort(numeric); mk.dd.sort(numeric);
    }
    // At least half a year of overlap, so that shifting the buys along the
    // calendar (the timing test of question 10) has enough positions to try.
    const haveMk = mk.vol.length >= 120;
    // The covered days in calendar order with the percentile of each measure,
    // and the position of every bench bar among them.
    const bd = [], bdAt = {};
    if (haveMk) {
      const from = isoDay(Math.max(coverStart, fileStart)), to = isoDay(Math.min(fileEnd, now));
      for (let j = 1; j < bench.length; j++) {
        if (bench[j].date < from || bench[j].date > to) continue;
        const i = j - 1;
        if (ms.ret20[i] == null || ms.vol20[i] == null || ms.dd[i] == null) continue;
        bdAt[j] = bd.length;
        bd.push({ t: Date.parse(bench[j].date), vol: ms.vol20[i], pRet: pctRank(mk.ret, ms.ret20[i]), pVol: pctRank(mk.vol, ms.vol20[i]), pDd: pctRank(mk.dd, ms.dd[i]) });
      }
    }

    // Labels from the daily set: one per (ticker, label event).
    const labels = (input.events || []).filter(function (e) { return e.sentiment === "positive" || e.sentiment === "negative" || e.sentiment === "neutral"; })
      .sort(function (a, b) { return a.ts - b.ts; });
    const labelsOf = {};
    labels.forEach(function (e) { (labelsOf[e.ticker] = labelsOf[e.ticker] || []).push(e); });
    const labelBefore = function (t, cut) {
      const arr = labelsOf[t]; if (!arr) return null;
      for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].ts < cut) return cut - arr[i].ts <= 90 * DAY ? arr[i] : null; }
      return null;
    };

    // Raw views per ticker (page type, scroll, focus) for the windowed features.
    const evBy = {};
    (input.intraday || []).forEach(function (e) { if (e && e.ticker) (evBy[e.ticker] = evBy[e.ticker] || []).push(e); });
    Object.keys(evBy).forEach(function (t) { evBy[t].sort(function (a, b) { return a.ts - b.ts; }); });
    const viewsIn = function (t, from, to) {
      const arr = evBy[t]; if (!arr) return [];
      const ts = arr.map(function (e) { return e.ts; });
      return arr.slice(lowerBound(ts, from), lowerBound(ts, to));
    };

    // Per-decision features.
    const counts = { all: decs.length, auto: 0, assetClass: 0, beforeCoverage: 0, analyzable: 0 };
    decs.forEach(function (d) {
      const t = tickerOf(d.inst);
      d.ticker = t;
      d.cut = d.dateOnly ? Date.parse(d.date + "T00:00:00Z") + DAY : d.ts;
      if (d.auto) { d.excluded = "automatic"; counts.auto++; }
      else if (d.assetClass && !ELIGIBLE[d.assetClass]) { d.excluded = "asset class"; counts.assetClass++; }
      else if (coverStart == null || d.cut < coverStart) { d.excluded = "before capture"; counts.beforeCoverage++; }
      else counts.analyzable++;
      const c = d.cut;
      d.views7 = t ? views(idx, t, c - 7 * DAY, c) : 0;
      d.views30 = t ? views(idx, t, c - PRE, c) : 0;
      d.views90 = t ? views(idx, t, c - 90 * DAY, c) : 0;
      d.dwell30 = t ? dwellMin(idx, t, c - PRE, c) : 0;
      d.days30 = t ? activeDays(idx, t, c - PRE, c) : 0;
      d.post30 = t ? views(idx, t, c, c + PRE) : 0;
      const first = t ? firstTs(idx, t) : null;
      d.firstAtt = first != null && first < c ? first : null;
      d.lastAtt = t ? lastBefore(idx, t, c) : null;
      d.researched = d.views30 > 0;
      // Spike: last 7 days against this stock's own weekly average over the 90
      // days before them. Needs some history to compare with.
      const baseFrom = Math.max(c - 97 * DAY, firstAtt || c), baseDays = (c - 7 * DAY - baseFrom) / DAY;
      d.baseline7 = t && baseDays >= 14 ? views(idx, t, baseFrom, c - 7 * DAY) / baseDays * 7 : null;
      d.spike = d.baseline7 != null ? d.views7 >= 3 && d.views7 >= 2 * Math.max(d.baseline7, 0.5) : null;
      const lab = t ? labelBefore(t, c) : null;
      d.label = lab ? lab.sentiment : null;
      d.labelTs = lab ? lab.ts : null;
      d.labelAgeDays = lab ? (c - lab.ts) / DAY : null;
      d.horizonDays = lab ? lab.horizonDays : null;
      // Page types seen in the 30 days before, and the watchlist's conviction
      // score over the same window: log2(1 + views) x (0.5 + 0.5 x max scroll)
      // x (1 + 0.1 x focus switches).
      const pre = t ? viewsIn(t, c - PRE, c) : [];
      d.types = {};
      let maxScroll = 0, focus = 0;
      pre.forEach(function (e) {
        d.types[e.researchType || "unclassified"] = 1;
        if (e.scrollDepth != null && e.scrollDepth > maxScroll) maxScroll = e.scrollDepth;
        if ((e.focusSwitches || 0) > focus) focus = e.focusSwitches || 0;
      });
      d.conviction = Math.log2(1 + d.views30) * (0.5 + 0.5 * maxScroll) * (1 + focus * 0.1);
      const s = seriesOf(d.inst);
      d.fwd = { 5: forward(s, bench, d.date, 5), 21: forward(s, bench, d.date, 21), 63: forward(s, bench, d.date, 63) };
      if (s && d.firstAtt != null) {
        const p0 = closeOnOrBefore(s, isoDay(d.firstAtt)), p1 = closeOnOrBefore(s, d.date);
        d.runup = p0 > 0 && p1 != null ? p1 / p0 - 1 : null;
      } else d.runup = null;
      // How far the stock had already moved in the 30 days before the trade day (closes
      // before that day only). Unlike the rise since the first look it does not grow
      // with how long the stock has been researched, so a rule built on it stays
      // meaningful for a patient researcher.
      {
        const dayBefore = isoDay(Date.parse(d.date + "T00:00:00Z") - DAY), a0 = s ? closeOnOrBefore(s, isoDay(Date.parse(d.date + "T00:00:00Z") - 31 * DAY)) : null, a1 = s ? closeOnOrBefore(s, dayBefore) : null;
        d.runup30 = a0 > 0 && a1 != null ? a1 / a0 - 1 : null;
      }
      d.mkt = null;
      if (haveMk) {
        const i = barBefore(bench, d.date);
        if (i >= 0 && ms.ret20[i] != null && ms.vol20[i] != null && ms.dd[i] != null) {
          const j = dateIdx(bench, d.date);
          d.mkt = { ret20: ms.ret20[i], vol20: ms.vol20[i], dd: ms.dd[i],
            pRet: pctRank(mk.ret, ms.ret20[i]), pVol: pctRank(mk.vol, ms.vol20[i]), pDd: pctRank(mk.dd, ms.dd[i]),
            bi: j >= 0 && bdAt[j] != null ? bdAt[j] : null }; // bi: this day's place among the covered days
        }
      }
    });
    trailingSizes(decs);
    const A = decs.filter(function (d) { return !d.excluded; });
    const buys = A.filter(function (d) { return d.side === "buy"; });
    const sells = A.filter(function (d) { return d.side === "sell"; });

    const monthsCovered = coverStart != null && fileEnd != null && fileEnd > coverStart ? (fileEnd - coverStart) / (30.44 * DAY) : 0;
    const rate = monthsCovered >= 1 ? A.length / monthsCovered : null; // decisions per month
    const eta = function (have, need, perMonth) {
      if (have >= need) return 0;
      return perMonth ? Math.ceil((need - have) / perMonth) : null;
    };

    // Positive calls on stocks not held at the time, where the file can show
    // the 30 days after. A repeat within 30 days of the last counted call on the
    // same stock is a reconfirmation and counts once.
    // `buy` is the buy decision that followed within 30 days, if any.
    const judgedTo = (fileEnd || 0) - PRE;
    const freshCall = function (seen, key, ts) {
      if (seen[key] != null && ts - seen[key] < PRE) return false;
      seen[key] = ts;
      return true;
    };
    const posCalls = [];
    (function () {
      const seen = {};
      labels.forEach(function (e) {
        if (e.sentiment !== "positive" || callFrom == null || e.ts < callFrom || e.ts > judgedTo) return;
        if (!freshCall(seen, e.ticker, e.ts)) return;
        const insts = instsOfTicker[e.ticker] || [];
        if (heldAt(insts, e.ts)) return;
        const buy = decs.find(function (d) { return insts.indexOf(d.inst) >= 0 && d.side === "buy" && !d.auto && d.cut >= e.ts && d.cut <= e.ts + PRE; }) || null;
        posCalls.push({ ticker: e.ticker, ts: e.ts, buy: buy });
      });
    })();

    // ---- Q1: does research come before the trade? ----
    const q1 = (function () {
      const n = A.length, k = A.filter(function (d) { return d.researched; }).length;
      const res = A.filter(function (d) { return d.researched; });
      const out = {
        n: n, researched: wilson(k, n),
        leadDays: median(res.filter(function (d) { return d.firstAtt != null; }).map(function (d) { return (d.cut - d.firstAtt) / DAY; })),
        recencyDays: median(res.filter(function (d) { return d.lastAtt != null; }).map(function (d) { return (d.cut - d.lastAtt) / DAY; })),
        status: status(n, NEED.q1), need: NEED.q1, eta: eta(n, NEED.q1.min, rate)
      };
      // Average views per day around buys, against the stock's own earlier level.
      const tb = buys.filter(function (d) { return d.ticker; });
      if (tb.length) {
        const offs = [], avg = [];
        for (let o = -30; o <= 30; o++) {
          let s = 0;
          tb.forEach(function (d) { const day0 = Date.parse(d.date + "T00:00:00Z"); s += views(idx, d.ticker, day0 + o * DAY, day0 + (o + 1) * DAY); });
          offs.push(o); avg.push(s / tb.length);
        }
        const base = mean(tb.map(function (d) {
          const from = Math.max(d.cut - 180 * DAY, firstAtt), to = d.cut - PRE, days = (to - from) / DAY;
          return days >= 14 ? views(idx, d.ticker, from, to) / days : null;
        }).filter(function (x) { return x != null; }));
        out.profile = { offsets: offs, avg: avg, baseline: base, n: tb.length };
      }
      // Timing test: move each decision to a random moment in the covered
      // window, keeping its stock, and compare the views in the 7 days before.
      // "Any view in 30 days" saturates for a stock you watch all the time, so
      // it cannot tell timing apart; intensity in the last week can. Low p =
      // research clusters right before your trades, not just on the stocks
      // you trade.
      const withT = A.filter(function (d) { return d.ticker; });
      if (withT.length >= 5 && coverStart != null) {
        const lo = coverStart, hi = Math.max(lo + DAY, Math.min(now, fileEnd || now)), R = 400, r = rng(42);
        const obs = mean(withT.map(function (d) { return d.views7; }));
        let ge = 0, sum = 0;
        for (let i = 0; i < R; i++) {
          let s = 0;
          withT.forEach(function (d) { const cut = lo + r() * (hi - lo); s += views(idx, d.ticker, cut - 7 * DAY, cut); });
          s /= withT.length; sum += s; if (s >= obs) ge++;
        }
        out.perm = { p: (ge + 1) / (R + 1), observed: obs, chance: sum / R, n: withT.length };
        out.clear = out.status !== "none" && out.perm.p < 0.05;
      }
      return out;
    })();

    // ---- Q2: do your labels predict what you do? ----
    const q2 = (function () {
      const lab = A.filter(function (d) { return d.label === "positive" || d.label === "negative"; });
      const agree = lab.filter(function (d) { return (d.side === "buy") === (d.label === "positive"); }).length;
      // Say -> do: positive calls on stocks you did not hold, bought within 30
      // days; negative calls on holdings, sold within 30 days. A Negative call on
      // a stock you do not hold cannot be acted on (selling short is not in the
      // data), so it is left out of the action rates and scored on its own as an
      // "avoid" call: did the stock lag the market afterwards?
      const pos = posCalls.map(function (c) { return !!c.buy; }), neg = [];
      const lagPos = posCalls.filter(function (c) { return c.buy; }).map(function (c) { return (c.buy.cut - c.ts) / DAY; }), lagNeg = [];
      const seen = {}, seenAvoid = {}, avoid = [];
      let notHeld = 0;
      const AV = 63;
      labels.forEach(function (e) {
        if (callFrom == null || e.ts < callFrom) return;
        const insts = instsOfTicker[e.ticker] || [];
        if (e.sentiment === "negative") {
          if (heldAt(insts, e.ts)) {
            if (e.ts <= judgedTo && freshCall(seen, e.ticker, e.ts)) {
              const sale = decs.find(function (d) { return insts.indexOf(d.inst) >= 0 && d.side === "sell" && !d.auto && d.cut >= e.ts && d.cut <= e.ts + PRE; });
              neg.push(!!sale);
              if (sale) lagNeg.push((sale.cut - e.ts) / DAY);
            }
          } else if (freshCall(seenAvoid, e.ticker, e.ts)) {
            notHeld++;
            const f = forward(prices[tickerSym[e.ticker]] || (insts[0] && seriesOf(insts[0])), bench, isoDay(e.ts), AV);
            if (f) avoid.push({ ticker: e.ticker, ts: e.ts, ex: f.ex });
          }
        }
      });
      const tr = function (a) { return wilson(a.filter(Boolean).length, a.length); };
      const av = avoid.map(function (a) { return a.ex; });
      const avoidOut = { n: av.length, notHeld: notHeld, horizon: AV, mean: mean(av), median: median(av),
        lagged: wilson(av.filter(function (x) { return x < 0; }).length, av.length),
        status: status(av.length, NEED.avoid), need: NEED.avoid,
        // wrong: the stock rose against the market anyway; right: it lagged the most
        wrong: avoid.slice().sort(function (a, b) { return b.ex - a.ex; }).slice(0, 3),
        right: avoid.slice().sort(function (a, b) { return a.ex - b.ex; }).slice(0, 3) };
      if (av.length >= 2) { avoidOut.ci = bootstrap(av, null, 2000, 37); avoidOut.clear = avoidOut.status !== "none" && excludesZero(avoidOut.ci); }
      return {
        n: lab.length, agreement: wilson(agree, lab.length),
        contradictions: lab.length - agree,
        neutral: A.filter(function (d) { return d.label === "neutral"; }).length,
        unlabelled: A.filter(function (d) { return !d.label; }).length,
        posToBuy: tr(pos), negToSell: tr(neg),
        lag: { pos: median(lagPos), neg: median(lagNeg) },
        avoid: avoidOut,
        status: status(lab.length, NEED.q2), need: NEED.q2,
        eta: eta(lab.length, NEED.q2.min, rate && A.length ? rate * lab.length / A.length : null)
      };
    })();

    // ---- Q3: do researched trades turn out better? ----
    const q3 = (function () {
      const H = 21;
      const ok = function (d) { return d.fwd[H] != null; };
      const ra = buys.filter(function (d) { return ok(d) && d.researched; }).map(function (d) { return d.fwd[H].ex; });
      const rb = buys.filter(function (d) { return ok(d) && !d.researched; }).map(function (d) { return d.fwd[H].ex; });
      const nSmall = Math.min(ra.length, rb.length);
      const out = {
        horizon: H, researched: { n: ra.length, mean: mean(ra) }, unresearched: { n: rb.length, mean: mean(rb) },
        status: status(nSmall, NEED.q3), need: NEED.q3, nSmall: nSmall
      };
      if (ra.length >= 2 && rb.length >= 2) { out.diff = bootstrap(ra, rb, 2000, 11); out.clear = out.status !== "none" && excludesZero(out.diff); }
      // Dose: researched buys split into thirds by research time (views when no dwell was measured).
      const rd = buys.filter(function (d) { return ok(d) && d.researched; })
        .map(function (d) { return { x: d.dwell30 > 0 ? d.dwell30 : d.views30, y: d.fwd[H].ex }; })
        .sort(function (a, b) { return a.x - b.x; });
      if (rd.length >= 9) {
        const t = Math.floor(rd.length / 3);
        out.dose = [rd.slice(0, t), rd.slice(t, 2 * t), rd.slice(2 * t)].map(function (g) {
          return { n: g.length, from: g[0].x, to: g[g.length - 1].x, mean: mean(g.map(function (p) { return p.y; })) };
        });
      }
      // Sales: did the stock lag the market afterwards (a good sale)?
      const sa = sells.filter(ok).map(function (d) { return -d.fwd[H].ex; });
      out.sells = { n: sa.length, mean: mean(sa) };
      const smallRate = rate && A.length ? rate * Math.max(1, nSmall) / A.length : null;
      out.eta = eta(nSmall, NEED.q3.min, smallRate);
      return out;
    })();

    // ---- Q4: behavioural patterns ----
    const q4 = (function () {
      const sb = buys.filter(function (d) { return d.spike != null; }), ss = sells.filter(function (d) { return d.spike != null; });
      const spikeBuy = wilson(sb.filter(function (d) { return d.spike; }).length, sb.length);
      const spikeSell = wilson(ss.filter(function (d) { return d.spike; }).length, ss.length);
      const ru = buys.filter(function (d) { return d.runup != null && d.runup > -0.99; }).map(function (d) { return d.runup; });
      const tb = buys.filter(function (d) { return d.ticker; });
      const pre = tb.reduce(function (s, d) { return s + d.views30; }, 0), post = tb.reduce(function (s, d) { return s + d.post30; }, 0);
      const out = {
        spikeBuy: spikeBuy, spikeSell: spikeSell,
        chase: { n: ru.length, median: median(ru), over10: wilson(ru.filter(function (x) { return x > 0.10; }).length, ru.length) },
        monitoring: { n: tb.length, ratio: pre > 0 ? post / pre : null,
          more: wilson(tb.filter(function (d) { return d.post30 > d.views30; }).length, tb.length) },
        status: sb.length >= NEED.q4.solid && ss.length >= NEED.q4.solid / 2 ? "solid"
          : sb.length >= NEED.q4.min && ss.length >= NEED.q4.min / 2 ? "indicative" : "none",
        need: NEED.q4, nBuys: sb.length, nSells: ss.length
      };
      if (spikeBuy.n && spikeSell.n) {
        out.asymmetry = spikeBuy.p - spikeSell.p;
        out.clear = out.status !== "none" && (spikeBuy.lo > spikeSell.hi || spikeSell.lo > spikeBuy.hi);
      }
      out.eta = eta(sb.length, NEED.q4.min, rate && A.length ? rate * buys.length / A.length : null);
      out.fomo = fomo();
      // Buys after the price rose since your first look vs after it fell:
      // next month against the NASDAQ. Chasing shows up as rose < fell.
      const rr = buys.filter(function (d) { return d.runup != null && d.fwd[21]; });
      const rose = rr.filter(function (d) { return d.runup > 0; }).map(function (d) { return d.fwd[21].ex; });
      const fell = rr.filter(function (d) { return d.runup <= 0; }).map(function (d) { return d.fwd[21].ex; });
      out.runupPerf = { rose: { n: rose.length, mean: mean(rose) }, fell: { n: fell.length, mean: mean(fell) },
        nSmall: Math.min(rose.length, fell.length), status: status(Math.min(rose.length, fell.length), NEED.runup), need: NEED.runup };
      if (rose.length >= 2 && fell.length >= 2) {
        out.runupPerf.diff = bootstrap(rose, fell, 2000, 29);
        out.runupPerf.clear = out.runupPerf.status !== "none" && excludesZero(out.runupPerf.diff);
      }
      return out;
    })();

    // FOMO check: do you only buy what already rose after your call?
    // (a) price move from your latest call to the buy;
    // (b) among Positive calls on stocks you did not hold, the buy rate when the
    // stock rose after the call vs when it fell. Moves are measured up to the
    // moment you decided: the buy day, or for calls you passed on, the call plus
    // your usual call-to-buy delay - so later moves cannot leak in.
    function fomo() {
      const runs = buys.filter(function (d) { return d.labelTs != null && d.label === "positive"; }).map(function (d) {
        const s = seriesOf(d.inst); if (!s) return null;
        const p0 = closeOnOrBefore(s, isoDay(d.labelTs)), p1 = closeOnOrBefore(s, d.date);
        return p0 > 0 && p1 != null ? p1 / p0 - 1 : null;
      }).filter(function (x) { return x != null; });
      const delays = posCalls.filter(function (c) { return c.buy; }).map(function (c) { return (c.buy.cut - c.ts) / DAY; });
      const delay = Math.max(1, Math.min(30, median(delays) || 7));
      const up = [], down = [];
      posCalls.forEach(function (c) {
        const s = prices[tickerSym[c.ticker]]; if (!s) return;
        const p0 = closeOnOrBefore(s, isoDay(c.ts)), p1 = closeOnOrBefore(s, c.buy ? c.buy.date : isoDay(c.ts + delay * DAY));
        if (!(p0 > 0) || p1 == null || p1 === p0) return;
        (p1 > p0 ? up : down).push(c.buy ? 1 : 0);
      });
      const sum = function (a) { return a.reduce(function (s, x) { return s + x; }, 0); };
      const bu = wilson(sum(up), up.length), bd = wilson(sum(down), down.length);
      const nSmall = Math.min(up.length, down.length);
      const st = status(nSmall, NEED.fomo);
      return {
        runs: { n: runs.length, median: median(runs), up: wilson(runs.filter(function (x) { return x > 0; }).length, runs.length),
          over10: runs.filter(function (x) { return x > 0.10; }).length },
        buyIfUp: bu, buyIfDown: bd, delayDays: delay, nSmall: nSmall, status: st, need: NEED.fomo,
        clear: st !== "none" && bu.n && bd.n && (bu.lo > bd.hi || bd.lo > bu.hi)
      };
    }

    // ---- Q5: what did the calls you passed on do? ----
    const q5 = (function () {
      const H = 63;
      const passed = [], bought = [];
      posCalls.forEach(function (c) {
        if (c.buy) return;
        const p = forwardPath(prices[tickerSym[c.ticker]], bench, isoDay(c.ts), H);
        if (p) passed.push({ ticker: c.ticker, ts: c.ts, ex: p[H], path: p });
      });
      buys.forEach(function (d) {
        if (d.fwd[H] == null) return;
        const p = forwardPath(seriesOf(d.inst), bench, d.date, H);
        if (p) bought.push({ ticker: d.ticker, ts: d.ts, ex: p[H], path: p, w: d.relSize != null ? Math.min(5, d.relSize) : 1 });
      });
      const acted = bought.map(function (b) { return b.ex; });
      const pa = passed.map(function (p) { return p.ex; });
      const nSmall = Math.min(pa.length, acted.length);
      const hit = function (a) { return wilson(a.filter(function (x) { return x > 0; }).length, a.length); };
      // Why an average can sit above zero while most buys lagged: a few big winners, and the
      // size of each buy. Both are shown next to the mean so the card explains itself.
      const sortedB = bought.slice().sort(function (a, b) { return b.ex - a.ex; });
      const wB = bought.map(function (b) { return b.w; });
      const wsum = wB.reduce(function (x, y) { return x + y; }, 0);
      const boughtExtra = { weighted: wsum ? bought.reduce(function (x, b) { return x + b.w * b.ex; }, 0) / wsum : null,
        withoutTop3: bought.length > 6 ? mean(sortedB.slice(3).map(function (b) { return b.ex; })) : null };
      const out = { horizon: H, passed: { n: pa.length, mean: mean(pa), median: median(pa), hit: hit(pa) }, bought: Object.assign({ n: acted.length, mean: mean(acted), median: median(acted), hit: hit(acted) }, boughtExtra),
        status: status(nSmall, NEED.q5), need: NEED.q5, nSmall: nSmall,
        best: passed.slice().sort(function (a, b) { return b.ex - a.ex; }).slice(0, 3).map(function (p) { return { ticker: p.ticker, ts: p.ts, ex: p.ex }; }),
        // The calls that were rightly passed on, so the card is not only about regret.
        worst: passed.slice().sort(function (a, b) { return a.ex - b.ex; }).slice(0, 3).map(function (p) { return { ticker: p.ticker, ts: p.ts, ex: p.ex }; }),
        paths: { days: passed.length || bought.length ? Array.from({ length: H + 1 }, function (_, k) { return k; }) : [],
          passed: pathBand(passed.map(function (p) { return p.path; }), 400, 53), bought: pathBand(bought.map(function (p) { return p.path; }), 400, 59) } };
      if (pa.length >= 2 && acted.length >= 2) { out.diff = bootstrap(acted, pa, 2000, 13); out.clear = out.status !== "none" && excludesZero(out.diff); }
      // One stock can carry the whole comparison (a stock that fell 80% or rose 300% and was
      // bought or called several times). Find the one whose removal moves "buys minus passed
      // calls" the most and say what the comparison looks like without it.
      if (pa.length >= 4 && acted.length >= 4) {
        const tick = {};
        passed.concat(bought).forEach(function (x) { if (x.ticker) tick[x.ticker] = 1; });
        const without = function (t) {
          const b = bought.filter(function (x) { return x.ticker !== t; }).map(function (x) { return x.ex; }), p = passed.filter(function (x) { return x.ticker !== t; }).map(function (x) { return x.ex; });
          return b.length >= 2 && p.length >= 2 ? { b: b, p: p, est: mean(b) - mean(p) } : null;
        };
        let best = null;
        Object.keys(tick).forEach(function (t) {
          const w = without(t);
          if (w && (!best || Math.abs(w.est - out.diff.est) > Math.abs(best.w.est - out.diff.est))) best = { t: t, w: w };
        });
        if (best && Math.abs(best.w.est - out.diff.est) >= 0.01) {
          const d2 = bootstrap(best.w.b, best.w.p, 2000, 17);
          out.influence = { ticker: best.t, nBought: bought.filter(function (x) { return x.ticker === best.t; }).length, nPassed: passed.filter(function (x) { return x.ticker === best.t; }).length,
            diffWithout: d2, clearWithout: status(Math.min(best.w.b.length, best.w.p.length), NEED.q5) !== "none" && excludesZero(d2) };
        }
      }
      out.eta = eta(nSmall, NEED.q5.min, rate && A.length ? rate * Math.max(1, nSmall) / A.length : null);
      return out;
    })();

    // ---- Q6: which page types come before better buys? ----
    // For each page type: researched buys whose 30 days before included it vs
    // researched buys whose did not, next-month return vs NASDAQ. Many types are
    // compared at once, so "clear" needs a 99% range to exclude zero: at 95%,
    // one type in twenty would look different by chance alone.
    const q6 = (function () {
      const rb = buys.filter(function (d) { return d.researched && d.fwd[21] != null; });
      const seen = {};
      rb.forEach(function (d) { Object.keys(d.types).forEach(function (t) { seen[t] = 1; }); });
      const rows = Object.keys(seen).map(function (t) {
        const w = rb.filter(function (d) { return d.types[t]; }).map(function (d) { return d.fwd[21].ex; });
        const wo = rb.filter(function (d) { return !d.types[t]; }).map(function (d) { return d.fwd[21].ex; });
        const r = { type: t, nWith: w.length, meanWith: mean(w), nWithout: wo.length, meanWithout: mean(wo), nSmall: Math.min(w.length, wo.length) };
        if (w.length >= 2 && wo.length >= 2) { r.diff = bootstrap(w, wo, 2000, 17, 0.99); r.clear = r.nSmall >= NEED.pages.min && excludesZero(r.diff); }
        return r;
      }).sort(function (a, b) { return b.nWith - a.nWith; });
      const best = rows.reduce(function (m, r) { return Math.max(m, r.nSmall); }, 0);
      return { rows: rows, n: rb.length, status: status(best, NEED.pages), need: NEED.pages, nSmall: best,
        clear: rows.some(function (r) { return r.clear; }) };
    })();

    // ---- Q7: when and how fast do you decide? ----
    // (a) Impulse: a decision within an hour of the first recorded view of that
    // stock. Brokers that give only a date cannot be timed to the hour; for
    // those a first look on the trade day is counted separately.
    // (b) The whole distribution of first view -> buy, with the next month's
    // return in each bucket.
    // (c) Buys by hour of day (your local time) against your views by hour,
    // and the return of buys placed in each part of the day.
    const q7 = (function () {
      const timed = A.filter(function (d) { return d.ticker && !d.dateOnly; });
      const firstLook = function (d) { return d.firstAtt != null ? d.cut - d.firstAtt : null; };
      const imp = timed.filter(function (d) { const g = firstLook(d); return g != null && g <= 3600000; });
      const considered = A.filter(function (d) { const g = firstLook(d); return d.side === "buy" && g != null && g >= 7 * DAY && d.fwd[21]; }).map(function (d) { return d.fwd[21].ex; });
      const impBuys = imp.filter(function (d) { return d.side === "buy" && d.fwd[21]; }).map(function (d) { return d.fwd[21].ex; });
      const dated = A.filter(function (d) { return d.ticker && d.dateOnly; });
      const sameDay = dated.filter(function (d) { return d.firstAtt != null && isoDay(d.firstAtt) === d.date; });
      const out = { n: timed.length, impulse: wilson(imp.length, timed.length), sides: { buy: imp.filter(function (d) { return d.side === "buy"; }).length, sell: imp.filter(function (d) { return d.side === "sell"; }).length },
        sameDay: { k: sameDay.length, n: dated.length },
        returns: { impulse: { n: impBuys.length, mean: mean(impBuys) }, considered: { n: considered.length, mean: mean(considered) } },
        status: status(timed.length, NEED.impulse), need: NEED.impulse };
      if (impBuys.length >= 2 && considered.length >= 2) {
        out.returns.diff = bootstrap(impBuys, considered, 2000, 19);
        out.returns.status = status(Math.min(impBuys.length, considered.length), NEED.q3);
        out.clear = out.returns.status !== "none" && excludesZero(out.returns.diff);
      }
      out.eta = eta(timed.length, NEED.impulse.min, rate && A.length ? rate * timed.length / A.length : null);

      // (b) First view -> buy. Date-only trades cannot be placed inside a day,
      // so anything under 24 hours counts as "same day" for them.
      const H = 3600000;
      const LEAD = [
        { key: "1h", label: "Within an hour", max: H },
        { key: "day", label: "Same day", max: 24 * H },
        { key: "week", label: "1-7 days", max: 7 * DAY },
        { key: "month", label: "1-4 weeks", max: 30 * DAY },
        { key: "quarter", label: "1-3 months", max: 91 * DAY },
        { key: "year", label: "3-12 months", max: 365 * DAY },
        { key: "long", label: "Over a year", max: Infinity }
      ];
      const lead = LEAD.map(function (b) { return { key: b.key, label: b.label, n: 0, rets: [] }; }).concat([{ key: "none", label: "No recorded view", n: 0, rets: [] }]);
      const leadDays = [];
      buys.forEach(function (d) {
        const g = firstLook(d);
        let i = g == null ? lead.length - 1 : LEAD.findIndex(function (b) { return g <= b.max; });
        if (i === 0 && d.dateOnly) i = 1;
        lead[i].n++;
        if (d.fwd[21]) lead[i].rets.push(d.fwd[21].ex);
        if (g != null) leadDays.push(g / DAY);
      });
      out.lead = { buckets: lead.map(function (b) { return { key: b.key, label: b.label, n: b.n, withRet: b.rets.length, mean: mean(b.rets) }; }),
        median: median(leadDays), n: buys.length, withLook: leadDays.length, status: status(leadDays.length, NEED.lead), need: NEED.lead };

      // (c) Hour of day. Two ways to cut the day into parts, both tested the same
      // way: fixed parts (night / morning / midday / afternoon / evening), and
      // "your clusters", cut in the valleys of your own buy-time histogram - which
      // uses only WHEN you bought, never how the buy turned out, so choosing the
      // cuts does not peek at the results. Clusters put the boundaries where you
      // rarely trade, so few buys sit next to one and the verdict depends less on
      // where the lines fall. Boundaries are arbitrary either way, so every verdict
      // is recomputed with all boundaries moved an hour earlier and later; advice
      // uses only a block that stays clear, same direction, in all three.
      const FIXED = [
        { key: "night", label: "Night", from: 22, to: 6 },
        { key: "morning", label: "Morning", from: 6, to: 11 },
        { key: "midday", label: "Midday", from: 11, to: 15 },
        { key: "afternoon", label: "Afternoon", from: 15, to: 18 },
        { key: "evening", label: "Evening", from: 18, to: 22 }
      ];
      const shifted = function (blocks, sh) { return blocks.map(function (b) { return { key: b.key, label: b.label, from: (b.from + sh + 24) % 24, to: (b.to + sh + 24) % 24 }; }); };
      const blockIn = function (blocks, h) { return blocks.find(function (b) { return b.from < b.to ? h >= b.from && h < b.to : h >= b.from || h < b.to; }); };
      const hourOf = function (d) { return new Date(d.ts).getHours(); };
      const tb = buys.filter(function (d) { return !d.dateOnly; });
      const viewsByHour = new Array(24).fill(0), buysByHour = new Array(24).fill(0);
      Object.keys(evBy).forEach(function (t) { evBy[t].forEach(function (e) { viewsByHour[new Date(e.ts).getHours()]++; }); });
      tb.forEach(function (d) { buysByHour[hourOf(d)]++; });
      const nViews = viewsByHour.reduce(function (s, x) { return s + x; }, 0);
      const withRet = tb.filter(function (d) { return d.fwd[21]; });
      const verdicts = function (blocks) {
        const v = {};
        blocks.forEach(function (b) {
          const ins = withRet.filter(function (d) { return blockIn(blocks, hourOf(d)) === b; }).map(function (d) { return d.fwd[21].ex; });
          const outs = withRet.filter(function (d) { return blockIn(blocks, hourOf(d)) !== b; }).map(function (d) { return d.fwd[21].ex; });
          const r = { n: ins.length, mean: mean(ins) };
          // Several blocks compared at once: a 99% range before calling one different.
          if (ins.length >= 2 && outs.length >= 2) { r.diff = bootstrap(ins, outs, 2000, 23, 0.99); r.clear = ins.length >= NEED.hours.min / 2 && excludesZero(r.diff); }
          v[b.key] = r;
        });
        return v;
      };
      const analyseHours = function (B0, mode) {
        const Bm = shifted(B0, -1), Bp = shifted(B0, 1);
        const v0 = verdicts(B0), vm = verdicts(Bm), vp = verdicts(Bp);
        const blocks = B0.map(function (b) {
          const r = v0[b.key];
          const impN = imp.filter(function (d) { return d.side === "buy" && blockIn(B0, hourOf(d)) === b; }).length;
          const nb = tb.filter(function (d) { return blockIn(B0, hourOf(d)) === b; }).length;
          let vb = 0;
          for (let h = 0; h < 24; h++) if (blockIn(B0, h) === b) vb += viewsByHour[h];
          const same = function (x) { return x.clear && r.diff && x.diff && (x.diff.est > 0) === (r.diff.est > 0); };
          return { key: b.key, from: b.from, to: b.to, label: b.label + " (" + b.from + "-" + b.to + " h)", buys: nb, impulse: impN, viewShare: nViews ? vb / nViews : null,
            n: r.n, mean: r.mean, diff: r.diff, clear: !!r.clear, robust: !!r.clear && same(vm[b.key]) && same(vp[b.key]),
            shifted: { earlier: vm[b.key].mean, later: vp[b.key].mean } };
        });
        // Buys close enough to a boundary to change block when the boundaries
        // move by an hour: the share that drives the sensitivity.
        const movers = withRet.filter(function (d) { const h = hourOf(d), b = blockIn(B0, h).key; return blockIn(Bm, h).key !== b || blockIn(Bp, h).key !== b; }).length;
        return { mode: mode, viewsByHour: viewsByHour, buysByHour: buysByHour, blocks: blocks, defs: B0, n: withRet.length,
          nearBoundary: withRet.length ? movers / withRet.length : null,
          peakView: nViews ? viewsByHour.indexOf(Math.max.apply(null, viewsByHour)) : null,
          status: status(withRet.length, NEED.hours), need: NEED.hours, clear: blocks.some(function (b) { return b.robust; }) };
      };
      const clusterDefs = buyClusters(tb.map(hourOf)), customDefs = customBlocks(input.customParts);
      out.hoursBy = { fixed: analyseHours(FIXED, "fixed"), clusters: clusterDefs ? analyseHours(clusterDefs, "clusters") : null,
        custom: customDefs ? analyseHours(customDefs, "custom") : null };
      out.hours = out.hoursBy.clusters || out.hoursBy.fixed;

      // (d) Conviction x time of day: next month vs NASDAQ in each cell of a
      // 3 x N grid (conviction bands x day parts), for both ways of cutting the
      // day and both ways of cutting conviction (thirds of your own buys, or the
      // watchlist's fixed colours: up to 1, up to 3, over 3). Many cells split the
      // buys thinly, so a cell shows a value only from 5 buys and the grid as a
      // whole is descriptive: it shows where to look, not a tested effect.
      const gridFor = function (defs, mode) {
        const cb = convBands(withRet.map(function (d) { return d.conviction; }), mode);
        const cells = cb.labels.map(function () { return defs.map(function () { return []; }); });
        withRet.forEach(function (d) { cells[cb.of(d.conviction)][defs.indexOf(blockIn(defs, hourOf(d)))].push(d.fwd[21].ex); });
        return { rows: cb.labels, cols: defs.map(function (b) { return b.label + " (" + b.from + "-" + b.to + " h)"; }),
          cells: cells.map(function (r) { return r.map(function (c) { return { n: c.length, mean: c.length >= 5 ? mean(c) : null }; }); }),
          n: withRet.length, status: status(withRet.length, NEED.grid), need: NEED.grid, mode: mode };
      };
      out.grids = {};
      Object.keys(out.hoursBy).forEach(function (bm) {
        if (!out.hoursBy[bm] || !withRet.length) return;
        out.grids[bm] = { thirds: gridFor(out.hoursBy[bm].defs, "thirds"), watchlist: gridFor(out.hoursBy[bm].defs, "watchlist") };
      });
      out.grid = out.grids[out.hours.mode] ? out.grids[out.hours.mode].thirds : null;
      return out;
    })();

    // ---- Q8: position size vs conviction ----
    // Size relative to your usual buy at the time (the median of your previous
    // 12 buys in the same currency, see trailingSizes; amounts in different
    // currencies are not comparable), against the conviction score over the 30
    // days before. Rank correlation, so one huge position cannot drive it.
    const q8 = (function () {
      const rows = buys.filter(function (d) { return d.relSize != null; })
        .map(function (d) { return { conv: d.conviction, size: d.relSize, ex: d.fwd[21] ? d.fwd[21].ex : null }; });
      const out = { n: rows.length, sizeVsConviction: corr(rows.map(function (r) { return r.conv; }), rows.map(function (r) { return r.size; }), true),
        status: status(rows.length, NEED.sizing), need: NEED.sizing };
      const withRet = rows.filter(function (r) { return r.ex != null; });
      out.sizeVsReturn = corr(withRet.map(function (r) { return r.size; }), withRet.map(function (r) { return r.ex; }), true);
      // Median size in each conviction band, for both ways of cutting conviction.
      out.bands = {};
      ["thirds", "watchlist"].forEach(function (mode) {
        if (rows.length < 9) return;
        const cb = convBands(rows.map(function (r) { return r.conv; }), mode);
        out.bands[mode] = cb.labels.map(function (label, i) {
          const g = rows.filter(function (r) { return cb.of(r.conv) === i; });
          return { label: label, n: g.length, size: g.length ? median(g.map(function (r) { return r.size; })) : null };
        });
      });
      out.clear = out.status !== "none" && out.sizeVsConviction.lo != null && (out.sizeVsConviction.lo > 0 || out.sizeVsConviction.hi < 0);
      out.eta = eta(rows.length, NEED.sizing.min, rate && A.length ? rate * buys.length / A.length : null);
      return out;
    })();

    // ---- Q9: your real portfolio vs your attention index ----
    const par9 = { win: input.windowDays > 0 ? input.windowDays : 30, lag: input.lagDays >= 0 ? +input.lagDays : 1 };
    const q9 = portfolioVsAttention();
    function portfolioVsAttention() {
      if (!bench.length || coverStart == null || fileStart == null) return { status: "none", need: NEED.portfolio, months: 0 };
      const start = isoDay(Math.max(coverStart, fileStart));
      const dates = bench.map(function (b) { return b.date; }).filter(function (d) { return d >= start; });
      if (dates.length < 2) return { status: "none", need: NEED.portfolio, months: 0 };
      // Real holdings, valued in the settlement currency of the purchase and
      // moved by the Yahoo close since then (no FX after the trade: weights
      // only). Holdings without a price are tracked too, so a stretch where you
      // held only unpriced instruments shows as a gap, not as a flat line.
      const tx = txs.filter(function (t) { return (t.kind === "buy" || t.kind === "sell" || t.kind === "adjust") && (!t.assetClass || ELIGIBLE[t.assetClass]); })
        .sort(function (a, b) { return a.ts - b.ts; });
      const hold = {}, unpriced = {};
      // Net dividends (after withholding) per instrument and day: the holdings
      // line is a total return, as an investor experiences it.
      const divs = {};
      txs.forEach(function (t) {
        if (t.kind !== "dividend" && t.kind !== "withholding") return;
        const k = instKey(t), net = t.kind === "dividend" ? (t.amount || 0) - (t.tax || 0) : -(t.tax || 0);
        (divs[k] = divs[k] || {})[t.date] = ((divs[k] || {})[t.date] || 0) + net;
      });
      const divBetween = function (k, d0, d1) {
        const m = divs[k]; if (!m) return 0;
        let x = 0; Object.keys(m).forEach(function (d) { if (d > d0 && d <= d1) x += m[d]; });
        return x;
      };
      let ti = 0;
      const apply = function (upTo) {
        while (ti < tx.length && tx[ti].date <= upTo) {
          const t = tx[ti++], k = instKey(t), s = seriesOf(k), c = s ? closeOnOrBefore(s, t.date) : null;
          if (!s) unpriced[k] = 1;
          const h = hold[k] = hold[k] || { qty: 0, settle: 0, y: null, s: s };
          if (t.kind === "adjust") { if (h.qty > 0 && h.qty + t.qty > 0) { h.settle *= h.qty / (h.qty + t.qty); if (h.y) h.y *= h.qty / (h.qty + t.qty); } h.qty = Math.max(0, h.qty + t.qty); }
          else if (t.kind === "buy") {
            const ps = t.amount && t.qty ? t.amount / t.qty : c;
            if (h.qty <= 0 || h.y == null) { h.settle = ps; h.y = c; } else { h.settle = (h.settle * h.qty + ps * t.qty) / (h.qty + t.qty); h.y = c != null ? (h.y * h.qty + c * t.qty) / (h.qty + t.qty) : h.y; }
            h.qty += t.qty;
          } else h.qty = Math.max(0, h.qty - t.qty);
        }
      };
      // Attention index: yesterday's weights = each stock's share of your views
      // in the 30 days up to then. With no views in that window the last basket
      // is kept - you do not sell what you stopped looking at - so quiet spells
      // (common after a history import) do not read as a flat line in cash.
      // Every viewed stock with a price is in the universe. Limiting it to the
      // most-viewed stocks over the WHOLE period would pick names by views you
      // gave them later - often because they had risen - and flatter the line.
      const att = Object.keys(idx).filter(function (t) { return prices[tickerSym[t]]; });
      let viewsAll = 0, viewsPriced = 0;
      Object.keys(idx).forEach(function (t) { const n = views(idx, t, Date.parse(dates[0]) - PRE, Date.parse(dates[dates.length - 1]) + DAY); viewsAll += n; if (prices[tickerSym[t]]) viewsPriced += n; });
      apply(dates[0]);
      let lastW = null;
      const r1s = [], r2s = [], r3s = [], kinds = [];
      const winMs = par9.win * DAY, lagMs = par9.lag * DAY;
      for (let i = 1; i < dates.length; i++) {
        const d0 = dates[i - 1], d1 = dates[i];
        let wsum = 0, rsum = 0, heldN = 0;
        Object.keys(hold).forEach(function (k) {
          const h = hold[k]; if (!(h.qty > 0)) return;
          heldN++;
          if (!h.s || !h.y) return;
          const c0 = closeOnOrBefore(h.s, d0), c1 = closeOnOrBefore(h.s, d1);
          if (!(c0 > 0) || c1 == null) return;
          const v = h.qty * h.settle * c0 / h.y;
          wsum += v; rsum += v * (c1 / c0 - 1) + divBetween(k, d0, d1);
        });
        // null = held something, but nothing with a price; 0 = all in cash.
        r1s.push(wsum > 0 ? rsum / wsum : heldN ? null : 0);
        kinds.push(wsum > 0 ? "priced" : heldN ? "unpriced" : "cash");
        // The basket held from the close of d0 is set by views at least `lag` days
        // before that 16:00 ET close (the same cutoff as the My Stocks Index), so a
        // view is never used at a price that had already printed. lag 0 is exact for
        // US listings; a later-closing exchange's views cannot leak, an earlier one
        // (Europe, Asia) can by up to a day, which is what the default lag of 1 covers.
        const t0 = usClose(d0) - lagMs;
        const w = {};
        let tot = 0;
        att.forEach(function (t) { const v = views(idx, t, t0 - winMs, t0); if (v) { w[t] = v; tot += v; } });
        if (tot > 0) lastW = w;
        let aw = 0, ars = 0;
        if (lastW) Object.keys(lastW).forEach(function (t) {
          const s = prices[tickerSym[t]], c0 = closeOnOrBefore(s, d0), c1 = closeOnOrBefore(s, d1);
          if (!(c0 > 0) || c1 == null) return;
          aw += lastW[t]; ars += lastW[t] * (c1 / c0 - 1);
        });
        r2s.push(aw > 0 ? ars / aw : null);
        // The other definition of an attention index: every stock you have viewed
        // so far, weighted by ALL its views to date, never dropped (as in the My
        // Stocks Index with "Hold everything attended" + "Attention-weighted").
        let cw = 0, crs = 0;
        att.forEach(function (t) {
          const v = views(idx, t, 0, t0); if (!v) return;
          const s = prices[tickerSym[t]], c0 = closeOnOrBefore(s, d0), c1 = closeOnOrBefore(s, d1);
          if (!(c0 > 0) || c1 == null) return;
          cw += v; crs += v * (c1 / c0 - 1);
        });
        r3s.push(cw > 0 ? crs / cw : null);
        apply(d1);
      }
      // Start where both lines exist: the first bar with priced holdings and an
      // attention basket. Before that one of them would sit flat at 100.
      const s0 = r1s.findIndex(function (r, i) { return kinds[i] === "priced" && r2s[i] != null; });
      if (s0 < 0) return { status: "none", need: NEED.portfolio, months: 0 };
      let pv = 100, av = 100, cv = 100, bv = 100;
      const out = { dates: [dates[s0]], portfolio: [100], attention: [100], attentionAll: [100], bench: [100] };
      const pr = [], ar = [], pr3 = [], ar3 = [];
      let gapDays = 0, cashDays = 0;
      for (let i = s0; i < r1s.length; i++) {
        const d0 = dates[i], d1 = dates[i + 1];
        if (r1s[i] != null) pv *= 1 + r1s[i]; else gapDays++;
        if (kinds[i] === "cash") cashDays++;
        if (r2s[i] != null) av *= 1 + r2s[i];
        if (r3s[i] != null) cv *= 1 + r3s[i];
        const b0 = closeOnOrBefore(bench, d0), b1 = closeOnOrBefore(bench, d1);
        if (b0 > 0 && b1 != null) bv *= b1 / b0;
        if (kinds[i] === "priced" && r2s[i] != null) { pr.push(r1s[i]); ar.push(r2s[i]); }
        if (kinds[i] === "priced" && r3s[i] != null) { pr3.push(r1s[i]); ar3.push(r3s[i]); }
        out.dates.push(d1);
        out.portfolio.push(r1s[i] == null ? null : pv);
        out.attention.push(r2s[i] == null ? null : av);
        out.attentionAll.push(r3s[i] == null ? null : cv);
        out.bench.push(bv);
      }
      const months = (Date.parse(out.dates[out.dates.length - 1]) - Date.parse(out.dates[0])) / (30.44 * DAY);
      out.months = months;
      out.returns = { portfolio: pv / 100 - 1, attention: av / 100 - 1, attentionAll: cv / 100 - 1, bench: bv / 100 - 1 };
      out.dailyCorr = corr(pr, ar, false);
      out.dailyCorrAll = corr(pr3, ar3, false);
      out.gapDays = gapDays; out.cashDays = cashDays; out.unpriced = Object.keys(unpriced).length;
      out.attCoverage = viewsAll ? viewsPriced / viewsAll : null;
      out.hasDividends = Object.keys(divs).length > 0;
      out.status = status(Math.floor(months), NEED.portfolio);
      out.need = NEED.portfolio;
      return out;
    }

    // ---- Q10: does the market's mood move you? ----
    // (a) Buying, per buy. Everything about the market comes from the bars BEFORE
    // the trade day: the NASDAQ's volatility (stdev of the last 20 daily returns),
    // its return over 20 days and its distance from the 52-week high. A buy is
    // placed among all trading days of the covered period by percentile (0.5 =
    // a typical day), so "you buy in turbulent markets" is judged against how
    // often markets ARE turbulent. Savings plans are not decisions and are out.
    //   size by regime: calm / normal / turbulent = thirds of the days by
    //     volatility; the size of each buy against your usual buy at the time;
    //   dip or chase: the mean percentile of the market's 20-day return (and of
    //     its distance from the high) on your buy days. Below 0.5 you buy after
    //     weak stretches, above 0.5 after strong ones.
    // What chance gives is found by moving the whole buying pattern along the
    // calendar (every possible shift, wrapping round): the buys keep their
    // spacing, bursts and gaps, the market keeps its calm and turbulent
    // stretches, and only how the two line up changes. Buying in bursts and
    // markets that stay turbulent for weeks both make neighbouring days alike,
    // so an ordinary bootstrap would show ranges that are too narrow.
    // (b) Research, per week: views against that week's volatility (no decision
    // is involved, so the week's own volatility is fine).
    const q10 = (function () {
      const wk = {};
      const monday = function (date) { const t = Date.parse(date + "T00:00:00Z"), dow = (new Date(t).getUTCDay() + 6) % 7; return isoDay(t - dow * DAY); };
      for (let i = 1; i < bench.length; i++) {
        const k = monday(bench[i].date);
        (wk[k] = wk[k] || { rets: [], views: 0 }).rets.push(bench[i].close / bench[i - 1].close - 1);
      }
      Object.keys(idx).forEach(function (t) { idx[t].ts.forEach(function (ts) { const w = wk[monday(isoDay(ts))]; if (w) w.views++; }); });
      const attW = Object.keys(wk).sort().map(function (k) { return { week: k, vol: wk[k].rets.length >= 3 ? stdev(wk[k].rets) : null, views: wk[k].views }; })
        .filter(function (r) { return r.vol != null && firstAtt != null && Date.parse(r.week) >= firstAtt - 7 * DAY && Date.parse(r.week) <= now; });
      const research = { viewsVsVol: corr(attW.map(function (r) { return r.views; }), attW.map(function (r) { return r.vol; }), false), weeks: attW.length,
        status: status(attW.length, NEED.volatility), need: NEED.volatility };
      research.clear = research.status !== "none" && research.viewsVsVol.lo != null && (research.viewsVsVol.lo > 0 || research.viewsVsVol.hi < 0);

      const bb = haveMk ? buys.filter(function (d) { return d.mkt && d.mkt.bi != null; }) : [];
      const out = { n: bb.length, baseDays: bd.length, research: research,
        viewsVsVol: research.viewsVsVol, weeksAttention: research.weeks,
        status: status(bb.length, NEED.market), need: NEED.market,
        eta: eta(bb.length, NEED.market.min, rate && A.length ? rate * buys.length / A.length : null) };
      if (!bb.length) { out.clear = false; return out; }
      const ann = function (v) { return v * Math.sqrt(252); };

      const c1 = quantile(mk.vol, 1 / 3), c2 = quantile(mk.vol, 2 / 3);
      const regimeOf = function (v) { return v <= c1 ? 0 : v <= c2 ? 1 : 2; };
      const baseN = [0, 0, 0];
      mk.vol.forEach(function (v) { baseN[regimeOf(v)]++; });
      const sized = [];
      bb.forEach(function (d, i) { if (d.relSize != null) sized.push(i); });
      const sizes = sized.map(function (i) { return bb[i].relSize; }), sizeRanks = ranks(sizes);
      const wts = bb.map(function (d) { return d.relSize == null ? null : Math.min(5, d.relSize); }); // a big buy counts more, up to 5 usual buys
      // Everything measured on the buys at once, so one pass over the shifts serves all of it:
      // 0-1 mean percentile (return, distance from high), 2-3 the same weighted by size, 4-6 share of
      // buys in calm / normal / turbulent markets, 7 Spearman volatility vs size, 8 mean log2 size
      // turbulent minus calm, 9-13 and 14-18 share of buys per fifth of days (return, distance).
      const stat = function (days) {
        const n = days.length, v = new Array(19).fill(null), reg = [0, 0, 0], f1 = [0, 0, 0, 0, 0], f2 = [0, 0, 0, 0, 0];
        let sr = 0, sd = 0, swr = 0, swd = 0, sw = 0;
        for (let i = 0; i < n; i++) {
          const x = days[i];
          sr += x.pRet; sd += x.pDd; reg[regimeOf(x.vol)]++;
          f1[Math.min(4, Math.floor(x.pRet * 5))]++; f2[Math.min(4, Math.floor(x.pDd * 5))]++;
          if (wts[i] != null) { sw += wts[i]; swr += wts[i] * x.pRet; swd += wts[i] * x.pDd; }
        }
        v[0] = sr / n; v[1] = sd / n; v[2] = sw ? swr / sw : null; v[3] = sw ? swd / sw : null;
        v[4] = reg[0] / n; v[5] = reg[1] / n; v[6] = reg[2] / n;
        if (sized.length >= 5) {
          v[7] = pearson(ranks(sized.map(function (i) { return days[i].pVol; })), sizeRanks);
          let a = 0, na = 0, b = 0, nb = 0;
          sized.forEach(function (i, k) { const r = regimeOf(days[i].vol); if (r === 2) { a += Math.log2(sizes[k]); na++; } else if (r === 0) { b += Math.log2(sizes[k]); nb++; } });
          v[8] = na && nb ? a / na - b / nb : null;
        }
        for (let q = 0; q < 5; q++) { v[9 + q] = f1[q] / n; v[14 + q] = f2[q] / n; }
        return v;
      };
      const T = shiftTest(bd, bb.map(function (d) { return d.mkt.bi; }), stat);
      out.timing = { shifts: bd.length - 1 };
      const chanceOf = function (t) { return { est: t.est, lo: t.lo, hi: t.hi, center: t.center, p: t.p }; };
      const sig = function (t) { return t && t.p != null && t.p <= 0.01; }; // 99%: several measures are read side by side

      // Size by volatility regime.
      const names = ["Calm", "Normal", "Turbulent"];
      out.regimes = [0, 1, 2].map(function (i) {
        const g = bb.filter(function (d) { return regimeOf(d.mkt.vol20) === i; });
        const sv = g.filter(function (d) { return d.relSize != null; }).map(function (d) { return d.relSize; }).sort(numeric);
        const t = T[4 + i];
        return { key: names[i].toLowerCase(), label: names[i], n: g.length, nSized: sv.length,
          share: { p: bb.length ? g.length / bb.length : null, k: g.length, n: bb.length, lo: t.lo, hi: t.hi, pval: t.p }, baseShare: baseN[i] / mk.vol.length,
          tilt: sig(t) ? (t.est > t.center ? "more" : "less") : null,
          median: median(sv), q1: quantile(sv, 0.25), q3: quantile(sv, 0.75),
          from: i === 0 ? null : ann(i === 1 ? c1 : c2), to: i === 2 ? null : ann(i === 0 ? c1 : c2),
          points: g.filter(function (d) { return d.relSize != null; }).map(function (d) { return { v: d.relSize, date: d.date, ticker: d.ticker, name: d.name, vol: ann(d.mkt.vol20) }; }) };
      });
      out.size = { n: sized.length, rho: Object.assign(chanceOf(T[7]), { r: T[7].est, n: sized.length, chance: true }), diff: T[8].est == null ? null : chanceOf(T[8]) };
      out.size.clear = status(Math.min(out.regimes[0].nSized, out.regimes[2].nSized), NEED.runup) !== "none" && (sig(T[7]) || sig(T[8]));

      // Dip or chase, two measures of how the market looked before each buy.
      const dip = function (mIdx, wIdx, fIdx, pKey, seed) {
        const t = T[mIdx], r = { n: bb.length, mean: chanceOf(t) };
        r.verdict = sig(t) ? (t.est < t.center ? "dip" : "chase") : "none";
        // Share of buys per fifth of the days, against what chance gives (about 20% each).
        r.fifths = [0, 1, 2, 3, 4].map(function (q) { const f = T[fIdx + q]; return { p: f.est, k: Math.round(f.est * bb.length), n: bb.length, lo: f.lo, hi: f.hi }; });
        if (T[wIdx].est != null && sized.length >= 5) r.weighted = chanceOf(T[wIdx]);
        // What came after, by how the market looked: weakest / middle / strongest third of days.
        const third = function (p) { return p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2; };
        r.bands = ["weak", "middle", "strong"].map(function (key, i) {
          const g = bb.filter(function (d) { return d.fwd[21] && third(d.mkt[pKey]) === i; }).map(function (d) { return d.fwd[21].ex; });
          return { key: key, n: g.length, mean: mean(g), values: g };
        });
        if (r.bands[0].n >= 2 && r.bands[2].n >= 2) {
          r.diff = bootstrap(r.bands[2].values, r.bands[0].values, 2000, seed);
          r.diffStatus = status(Math.min(r.bands[0].n, r.bands[2].n), NEED.runup);
          r.diffClear = r.diffStatus !== "none" && excludesZero(r.diff);
        }
        r.bands.forEach(function (b) { delete b.values; });
        return r;
      };
      out.dip = { ret: dip(0, 2, 9, "pRet", 45), dd: dip(1, 3, 14, "pDd", 49) };
      const tilt = out.regimes.some(function (r) { return r.tilt; });
      out.clear = out.status !== "none" && (out.size.clear || tilt || out.dip.ret.verdict !== "none" || out.dip.dd.verdict !== "none");
      return out;
    })();

    // ---- Q11: do you sell when your target is reached? ----
    // Positive calls with a target price on a stock you held: the first close
    // at or above the target while you held it, and whether a sale followed
    // within 10 trading days (14 calendar days). Holding on is then scored by
    // the next month vs NASDAQ.
    const q11 = (function () {
      const rows = [], seen = {};
      labels.forEach(function (e) {
        if (e.sentiment !== "positive" || !(e.targetPrice > 0)) return;
        const key = e.ticker + "|" + e.targetPrice;
        if (seen[key]) return;
        seen[key] = 1;
        const insts = instsOfTicker[e.ticker] || [];
        const s = prices[tickerSym[e.ticker]] || (insts[0] && seriesOf(insts[0]));
        if (!insts.length || !s) return;
        const i0 = dateIdx(s, isoDay(e.ts));
        if (i0 < 0) return;
        let heldAny = false, reach = null;
        for (let i = i0; i < s.length; i++) {
          const t = Date.parse(s[i].date + "T21:00:00Z");
          if (fileEnd != null && t > fileEnd + 14 * DAY) break;
          const held = insts.some(function (k) { return posAt(timeline[k], t) > 0; });
          if (held) heldAny = true;
          if (held && s[i].close >= e.targetPrice) { reach = s[i]; break; }
        }
        if (!heldAny) return;
        if (!reach) { rows.push({ ticker: e.ticker, reached: false }); return; }
        const rt = Date.parse(reach.date + "T00:00:00Z");
        const sold = decs.some(function (d) { return insts.indexOf(d.inst) >= 0 && d.side === "sell" && d.cut >= rt && d.cut <= rt + 14 * DAY; });
        const after = forward(s, bench, reach.date, 21);
        rows.push({ ticker: e.ticker, reached: true, sold: sold, after: after ? after.ex : null, end: after ? after.end : null, ts: rt });
      });
      const reached = rows.filter(function (r) { return r.reached; });
      const heldOn = reached.filter(function (r) { return !r.sold && r.after != null; }).map(function (r) { return r.after; });
      return { n: reached.length, notReached: rows.length - reached.length, rows: reached,
        sold: wilson(reached.filter(function (r) { return r.sold; }).length, reached.length),
        heldOnAfter: { n: heldOn.length, mean: mean(heldOn) },
        status: status(reached.length, NEED.targets), need: NEED.targets };
    })();

    return {
      coverage: {
        firstAttention: firstAtt, coverStart: coverStart, fileStart: fileStart, fileEnd: fileEnd,
        monthsCovered: monthsCovered, perMonth: rate, decisions: counts,
        buys: buys.length, sells: sells.length
      },
      q1: q1, q2: q2, q3: q3, q4: q4, q5: q5, q6: q6, q7: q7, q8: q8, q9: q9, q10: q10, q11: q11,
      // Q9 alone with another weight window / decision lag, without redoing the rest.
      recomputeQ9: function (p) { par9.win = p.windowDays > 0 ? p.windowDays : 30; par9.lag = p.lagDays >= 0 ? +p.lagDays : 1; return portfolioVsAttention(); },
      // Every Positive call on a stock not held that the file can judge, with the
      // 63-day excess return from the call day (bought or not): the rule check
      // "act on your calls" compares the two.
      calls: posCalls.map(function (c) {
        const f = forward(prices[tickerSym[c.ticker]], bench, isoDay(c.ts), 63);
        return f ? { ticker: c.ticker, ts: c.ts, bought: !!c.buy, ex: f.ex, end: f.end } : null;
      }).filter(Boolean),
      // The market on every trading day of the covered period, ascending: what a
      // percentile of volatility or of the 20-day return means in plain numbers.
      market: { vol: mk.vol, ret: mk.ret, dd: mk.dd, days: bd.map(function (x) { return { t: x.t, pVol: x.pVol, pRet: x.pRet }; }) },
      disposition: disposition(txs, links, prices),
      horizon: horizonDiscipline(A, decs),
      dividends: dividends(txs),
      decisions: decs
    };
  }

  // Disposition effect (Odean 1998): on each day with a sale, every position
  // is either realised or still on paper, at a gain or a loss against its
  // average cost. PGR - PLR > 0 = winners are sold sooner than losers. Cost is
  // measured on Yahoo closes so it shares the currency of the price it is
  // compared with.
  function disposition(txs, links, prices) {
    const ser = function (t) { const l = links[instKey(t)]; return l && l.symbol ? prices[l.symbol] : null; };
    const st = {}; // inst -> {pos, cost}
    const evs = txs.filter(function (t) { return (t.kind === "buy" || t.kind === "sell" || t.kind === "adjust") && (!t.assetClass || ELIGIBLE[t.assetClass]); })
      .sort(function (a, b) { return a.ts - b.ts; });
    let RG = 0, RL = 0, PG = 0, PL = 0, days = 0;
    let i = 0;
    while (i < evs.length) {
      const date = evs[i].date, today = [];
      while (i < evs.length && evs[i].date === date) today.push(evs[i++]);
      const soldToday = {};
      today.forEach(function (t) {
        const k = instKey(t), s = ser(t), c = s ? closeOnOrBefore(s, t.date) : null;
        const x = st[k] = st[k] || { pos: 0, cost: null, s: s };
        if (t.kind === "adjust") { if (x.pos > 0 && x.cost != null) x.cost = x.cost * x.pos / Math.max(1e-9, x.pos + t.qty); x.pos = Math.max(0, x.pos + t.qty); return; }
        if (t.kind === "buy") { if (c != null) x.cost = x.cost == null || x.pos <= 0 ? c : (x.cost * x.pos + c * t.qty) / (x.pos + t.qty); x.pos += t.qty; return; }
        if (x.pos > 0 && x.cost != null && c != null && c !== x.cost) { soldToday[k] = c > x.cost ? "g" : "l"; }
        x.pos = Math.max(0, x.pos - t.qty);
      });
      const ks = Object.keys(soldToday);
      if (!ks.length) continue;
      days++;
      ks.forEach(function (k) { if (soldToday[k] === "g") RG++; else RL++; });
      Object.keys(st).forEach(function (k) {
        if (soldToday[k] || !(st[k].pos > 0) || st[k].cost == null || !st[k].s) return;
        const c = closeOnOrBefore(st[k].s, date);
        if (c == null || c === st[k].cost) return;
        if (c > st[k].cost) PG++; else PL++;
      });
    }
    const pgr = RG + PG ? RG / (RG + PG) : null, plr = RL + PL ? RL / (RL + PL) : null;
    return { days: days, pgr: pgr, plr: plr, de: pgr != null && plr != null ? pgr - plr : null,
      realizedGains: RG, realizedLosses: RL, paperGains: PG, paperLosses: PL,
      status: status(days, NEED.disposition), need: NEED.disposition };
  }

  // Horizon discipline: buys made under a Positive call that carried a time
  // horizon, against how long the position was actually held.
  function horizonDiscipline(A, decs) {
    const rows = [];
    A.forEach(function (d) {
      if (d.side !== "buy" || d.label !== "positive" || !d.horizonDays) return;
      const close = decs.find(function (x) { return x.inst === d.inst && x.ts > d.ts && x.cls === "close"; });
      const held = ((close ? close.ts : Date.now()) - d.ts) / DAY;
      const ratio = held / d.horizonDays;
      rows.push({ held: held, horizon: d.horizonDays, open: !close,
        verdict: !close && ratio < 1.5 ? "open" : ratio < 0.5 ? "early" : ratio <= 1.5 ? "on" : "late" });
    });
    const c = function (v) { return rows.filter(function (r) { return r.verdict === v; }).length; };
    return { n: rows.length, early: c("early"), on: c("on"), late: c("late"), open: c("open"),
      status: rows.length >= 15 ? "solid" : rows.length >= 5 ? "indicative" : "none" };
  }

  function dividends(txs) {
    const by = {}, inst = {};
    let n = 0;
    txs.forEach(function (t) {
      if (t.kind !== "dividend" && t.kind !== "withholding") return;
      const c = t.currency || "?";
      by[c] = by[c] || { gross: 0, tax: 0 };
      if (t.kind === "dividend") { by[c].gross += t.amount || 0; by[c].tax += t.tax || 0; n++; inst[instKey(t)] = 1; }
      else by[c].tax += t.tax || 0;
    });
    return { count: n, instruments: Object.keys(inst).length, byCurrency: by };
  }

  const api = { analyze: analyze, buyClusters: buyClusters, customBlocks: customBlocks, convBands: convBands, buildDecisions: buildDecisions, indexAttention: indexAttention, wilson: wilson,
    bootstrap: bootstrap, forward: forward, forwardPath: forwardPath, pathBand: pathBand, marketSeries: marketSeries, barBefore: barBefore, usClose: usClose, usualSize: usualSize, instKey: instKey, NEED: NEED,
    // small statistics shared with src/biases.js
    stats: { rng: rng, mean: mean, median: median, quantile: quantile, pctRank: pctRank, wilson: wilson, bootstrap: bootstrap, bootWeighted: bootWeighted,
      corr: corr, stdev: stdev, status: status, excludesZero: excludesZero, numeric: numeric, isoDay: isoDay } };
  if (typeof self !== "undefined") self.ATDecisions = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
