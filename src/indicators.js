(function () {
  // Bias indicators that complement ATDecisions.analyze (phase 1 of
  // docs/bias-indicators-design.md). Pure functions over the same input plus the
  // report analyze() returned, so they run (and are tested) without a browser.
  // Nothing here leaves the device.
  //
  // Every indicator reports n, a status (none / indicative / solid against its
  // NEED) and `clear` when its 95% range rules out "no effect", like decisions.js.
  // Several indicators work without a broker import (calls and views only):
  // ostrich (with "position taken" labels), confirmation and herding.
  const D = typeof module !== "undefined" && module.exports ? require("./decisions.js") : self.ATDecisions;
  const S = D.stats, DAY = 86400000, PRE = 30 * DAY;
  const ELIGIBLE = { STOCK: 1, ETF: 1, FUND: 1 };
  const mean = S.mean, median = S.median, wilson = S.wilson, status = S.status, isoDay = S.isoDay;
  const NEED = {
    rank: { min: 10, solid: 30 },          // sell days with 3+ positions
    repurchase: { min: 10, solid: 30 },    // full closes with prices after
    myopia: { min: 5, solid: 15 },         // positions with a horizon of a year or more
    turnover: { min: 6, solid: 18 },       // months with a depot
    odean: { min: 10, solid: 30 },         // sell -> buy switches
    perTrade: { min: 6, solid: 18 },       // months with trades
    holdings: { min: 3, solid: 12 },       // month-ends with a depot
    oneOverN: { min: 10, solid: 30 },      // buys
    ostrich: { min: 60, solid: 250 },      // held position-days on each side
    confirmation: { min: 10, solid: 30 },  // sharp moves against a standing call
    entropy: { min: 10, solid: 30 },       // stock-months in the smaller group
    herding: { min: 20, solid: 60 },       // first looks with community data
    survival: { min: 10, solid: 30 },      // closed positions
    // phase 2
    extrapolationCalls: { min: 15, solid: 40 }, // calls with a year of prices before
    extrapolationBuys: { min: 10, solid: 30 },  // buys with 5+ stocks viewed alongside
    lottery: { min: 10, solid: 30 },       // buys with a lottery verdict
    targets: { min: 10, solid: 30 },       // calls with a target price
    breakEven: { min: 10, solid: 30 },     // full sales with a cost
    nearHigh: { min: 10, solid: 30 },      // buys with a 52-week high
    calibration: { min: 10, solid: 30 },   // calls with a target and a horizon that has passed
    homebias: { min: 3, solid: 12 },       // months with views
    volume: { min: 10, solid: 30 },        // buys with volume history
    crowdBuys: { min: 20, solid: 60 },     // buys with community data for the stock
    timing: { min: 10, solid: 30 },        // timed buys with a same-money plan, or buys in the smaller of the timed and plan parts
    // phase 3
    attention: { min: 8, solid: 30 },      // earnings releases with a complete 14-day window
    community: { min: 30, solid: 120 }     // days of community first looks
  };
  // Lottery stocks, fixed thresholds (see docs/bias-indicators-design.md, decisions):
  // the best day of the last month above +10% (Bali, Cakici & Whitelaw 2011), or all
  // three of Kumar's (2009) criteria: price under 5 USD, idiosyncratic volatility above
  // 60% a year and idiosyncratic skewness above 0.5 over the last 126 trading days.
  const LOTTERY = { max: 0.10, price: 5, ivol: 0.60, iskew: 0.5, window: 126 };

  // ---------- helpers ----------

  function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
  function addDays(date, n) { return isoDay(Date.parse(date + "T00:00:00Z") + n * DAY); }
  // Index of the last bar on or before a date, -1 if none.
  function barAt(s, date) { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m].date <= date) lo = m + 1; else hi = m; } return lo - 1; }
  function closeAt(s, date) { const i = s ? barAt(s, date) : -1; return i >= 0 ? s[i].close : null; }
  function eligible(x) { return !x.assetClass || ELIGIBLE[x.assetClass]; }
  function clearOf(ci) { return S.excludesZero(ci); }

  // Percentile bootstrap of stat(units) with whole clusters resampled together
  // (days, weeks or positions), so neighbouring units that move together do not
  // narrow the range. stat returns a number or null.
  function clusterBoot(clusters, stat, R, seed, level) {
    const all = [].concat.apply([], clusters), est = stat(all);
    if (est == null || clusters.length < 3) return { est: est, lo: null, hi: null };
    const r = S.rng(seed || 11), out = [], tail = (1 - (level || 0.95)) / 2, n = clusters.length;
    for (let b = 0; b < (R || 1000); b++) {
      const pick = [];
      for (let i = 0; i < n; i++) { const c = clusters[(r() * n) | 0]; for (let j = 0; j < c.length; j++) pick.push(c[j]); }
      const v = stat(pick);
      if (v != null && isFinite(v)) out.push(v);
    }
    if (out.length < 20) return { est: est, lo: null, hi: null };
    out.sort(S.numeric);
    return { est: est, lo: out[Math.floor(out.length * tail)], hi: out[Math.ceil(out.length * (1 - tail)) - 1] };
  }
  const rateOf = function (key) { return function (us) { let k = 0, n = 0; us.forEach(function (u) { if (u[key] != null) { n++; if (u[key]) k++; } }); return n ? k / n : null; }; };

  // Kaplan-Meier median of durations with censoring ({t, done}); null when the
  // curve never falls to one half.
  function kmMedian(rows) {
    const s = rows.slice().sort(function (a, b) { return a.t - b.t || (b.done ? 1 : 0) - (a.done ? 1 : 0); });
    let at = s.length, surv = 1;
    for (let i = 0; i < s.length; i++) {
      if (s[i].done) { surv *= 1 - 1 / at; if (surv <= 0.5) return s[i].t; }
      at--;
    }
    return null;
  }

  // Views per ticker: sorted records and per-day counts (UTC day).
  function viewIndex(intraday) {
    const by = {};
    (intraday || []).forEach(function (e) { if (e && e.ticker && e.ts) (by[e.ticker] = by[e.ticker] || []).push(e); });
    const out = {};
    Object.keys(by).forEach(function (t) {
      const arr = by[t].sort(function (a, b) { return a.ts - b.ts; }), day = {};
      arr.forEach(function (e) { const d = isoDay(e.ts); day[d] = (day[d] || 0) + 1; });
      out[t] = { arr: arr, ts: arr.map(function (e) { return e.ts; }), day: day };
    });
    return out;
  }
  function viewsBetween(vi, t, from, to) { const x = vi[t]; return x ? lowerBound(x.ts, to) - lowerBound(x.ts, from) : 0; }
  function nextView(vi, t, from) { const x = vi[t]; if (!x) return null; const i = lowerBound(x.ts, from); return i < x.ts.length ? x.ts[i] : null; }

  // ---------- the book: positions with cost over time ----------

  // Per instrument, the position and its average cost (on Yahoo closes, so it
  // shares the currency of the prices it is compared with) after each trade day.
  // fxk converts a Yahoo close into the broker's settlement currency at the rate
  // of the buys (amount paid / (qty x close)), so values of different listings
  // can be added up in the currency the user sees.
  function buildBook(txs, links, prices) {
    const book = {};
    txs.filter(function (t) { return (t.kind === "buy" || t.kind === "sell" || t.kind === "adjust") && eligible(t); })
      .sort(function (a, b) { return a.ts - b.ts; })
      .forEach(function (t) {
        const k = D.instKey(t), l = links[k];
        const b = book[k] || (book[k] = { inst: k, s: l && l.symbol ? prices[l.symbol] || null : null, ticker: l && l.ticker && l.status !== "rejected" ? l.ticker : null,
          assetClass: t.assetClass || null, currency: t.currency || "?", symbol: l && l.symbol || t.symbol || null, isin: t.isin || null, steps: [], pos: 0, cost: null, fxk: null });
        const c = b.s ? closeAt(b.s, t.date) : null;
        if (t.kind === "adjust") {
          if (b.pos > 0 && b.cost != null) b.cost = b.cost * b.pos / Math.max(1e-9, b.pos + t.qty);
          b.pos = Math.max(0, b.pos + t.qty);
        } else if (t.kind === "buy") {
          if (c != null) b.cost = b.cost == null || b.pos <= 0 ? c : (b.cost * b.pos + c * t.qty) / (b.pos + t.qty);
          if (c > 0 && t.amount > 0 && t.qty > 0) { const f = t.amount / (t.qty * c); b.fxk = b.fxk == null || b.pos <= 0 ? f : (b.fxk * b.pos + f * t.qty) / (b.pos + t.qty); }
          b.pos += t.qty;
        } else b.pos = Math.max(0, b.pos - t.qty);
        if (b.pos < 1e-9) b.pos = 0;
        const st = { date: t.date, pos: b.pos, cost: b.pos > 0 ? b.cost : null, fxk: b.fxk };
        const last = b.steps[b.steps.length - 1];
        if (last && last.date === t.date) b.steps[b.steps.length - 1] = st; else b.steps.push(st);
      });
    return book;
  }
  // State at the start of a day (after every trade of earlier days).
  function stateBefore(b, date) {
    let lo = 0, hi = b.steps.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (b.steps[m].date < date) lo = m + 1; else hi = m; }
    return lo > 0 && b.steps[lo - 1].pos > 0 ? b.steps[lo - 1] : null;
  }
  // Position value at the close of a day, in the broker's currency.
  function valueAt(b, date) {
    const st = stateBefore(b, addDays(date, 1));
    if (!st || !b.s) return 0;
    const c = closeAt(b.s, date);
    return c == null ? 0 : st.pos * c * (st.fxk || 1);
  }

  // Without a broker import: a ticker counts as held from its first "position
  // taken" label until a later label unticks it, at the price of that first label.
  function labelBook(events, prices, tickerSym) {
    const by = {};
    (events || []).filter(function (e) { return e.positionTaken != null; }).sort(function (a, b) { return a.ts - b.ts; }).forEach(function (e) {
      const x = by[e.ticker] = by[e.ticker] || { spans: [], open: null };
      if (e.positionTaken === true && !x.open) x.open = { from: e.ts, cost: e.priceAtEvent || null };
      else if (e.positionTaken === false && x.open) { x.open.to = e.ts; x.spans.push(x.open); x.open = null; }
    });
    const book = {};
    Object.keys(by).forEach(function (t) {
      const x = by[t];
      if (x.open) { x.open.to = Infinity; x.spans.push(x.open); }
      const s = prices[tickerSym[t]] || null;
      if (!x.spans.length) return;
      book["L:" + t] = { inst: "L:" + t, ticker: t, s: s, spans: x.spans, fromLabels: true };
    });
    return book;
  }
  // { held, cost } of a book entry at the start of a day.
  function heldOn(b, date) {
    if (b.fromLabels) {
      const t = Date.parse(date + "T00:00:00Z");
      const sp = b.spans.find(function (x) { return x.from < t && t < x.to; });
      return sp ? { held: true, cost: sp.cost } : { held: false };
    }
    const st = stateBefore(b, date);
    return st ? { held: true, cost: st.cost } : { held: false };
  }

  // ---------- D2 extension: holding period of winners vs losers ----------

  function survival(R, book, end) {
    const rows = [];
    Object.keys(book).forEach(function (k) {
      const b = book[k];
      if (!b.s) return;
      let open = null, cost = null;
      b.steps.forEach(function (st, i) {
        const prev = i ? b.steps[i - 1].pos : 0;
        if (prev === 0 && st.pos > 0) { open = st.date; cost = st.cost; }
        if (st.pos > 0) cost = st.cost;
        if (open && st.pos === 0) {
          const px = closeAt(b.s, st.date);
          if (px != null && cost) rows.push({ t: (Date.parse(st.date) - Date.parse(open)) / DAY, done: true, win: px > cost });
          open = null;
        }
      });
      if (open && cost) {
        const px = closeAt(b.s, isoDay(end));
        if (px != null) rows.push({ t: (end - Date.parse(open)) / DAY, done: false, win: px > cost });
      }
    });
    const w = rows.filter(function (r) { return r.win; }), l = rows.filter(function (r) { return !r.win; });
    const closed = rows.filter(function (r) { return r.done; }).length;
    return { n: closed, open: rows.length - closed, winners: { n: w.length, median: kmMedian(w) }, losers: { n: l.length, median: kmMedian(l) },
      status: status(closed, NEED.survival), need: NEED.survival };
  }

  // ---------- D4: rank effect (Hartzmark 2015) ----------

  function rankEffect(R, book, vi, cal) {
    const sold = {};
    R.decisions.forEach(function (d) { if (d.side === "sell" && !d.auto && eligible(d)) (sold[d.date] = sold[d.date] || {})[d.inst] = 1; });
    const days = [];
    Object.keys(sold).sort().forEach(function (date) {
      const prev = addDays(date, -1), pos = [];
      Object.keys(book).forEach(function (k) {
        const b = book[k], st = stateBefore(b, date);
        if (!st || st.cost == null || !b.s) return;
        const c = closeAt(b.s, prev);
        if (c != null) pos.push({ inst: k, ret: c / st.cost - 1 });
      });
      if (pos.length < 3) return;
      pos.sort(function (a, b) { return a.ret - b.ret; });
      days.push(pos.map(function (p, i) { return { cat: i === 0 ? "worst" : i === pos.length - 1 ? "best" : "middle", sold: !!sold[date][p.inst] }; }));
    });
    const all = [].concat.apply([], days);
    const share = function (cat) { const u = all.filter(function (x) { return x.cat === cat; }); return wilson(u.filter(function (x) { return x.sold; }).length, u.length); };
    const diff = clusterBoot(days, function (us) {
      let ek = 0, en = 0, mk = 0, mn = 0;
      us.forEach(function (u) { if (u.cat === "middle") { mn++; if (u.sold) mk++; } else { en++; if (u.sold) ek++; } });
      return en && mn ? ek / en - mk / mn : null;
    }, 1000, 31);
    // Research side: of the views of your own positions on days with 3+ held,
    // the share going to the best and worst one against the share they are (2 of n).
    let ext = 0, tot = 0, base = 0;
    cal.forEach(function (date) {
      const pos = [];
      Object.keys(book).forEach(function (k) {
        const b = book[k], st = stateBefore(b, date);
        if (!st || st.cost == null || !b.s || !b.ticker) return;
        const c = closeAt(b.s, addDays(date, -1));
        if (c != null) pos.push({ t: b.ticker, ret: c / st.cost - 1 });
      });
      if (pos.length < 3) return;
      pos.sort(function (a, b) { return a.ret - b.ret; });
      let v = 0, ve = 0;
      pos.forEach(function (p, i) { const n = (vi[p.t] && vi[p.t].day[date]) || 0; v += n; if (i === 0 || i === pos.length - 1) ve += n; });
      if (!v) return;
      ext += ve; tot += v; base += v * 2 / pos.length;
    });
    return { n: days.length, best: share("best"), worst: share("worst"), middle: share("middle"), diff: diff,
      views: tot ? { share: ext / tot, base: base / tot, n: tot } : null,
      status: status(days.length, NEED.rank), need: NEED.rank, clear: clearOf(diff) && diff.est > 0 };
  }

  // ---------- D6: repurchase regret (Strahilevitz, Odean & Barber 2011) ----------

  function repurchase(R, book, vi, end) {
    const closes = R.decisions.filter(function (d) { return d.side === "sell" && d.cls === "close" && eligible(d); });
    const units = [], watch = { up: [], down: [] };
    let n = 0;
    closes.forEach(function (d) {
      const b = book[d.inst];
      if (!b || !b.s) return;
      const st = stateBefore(b, d.date), sellPx = closeAt(b.s, d.date);
      if (!st || !st.cost || !sellPx) return;
      const gain = sellPx > st.cost, next = R.decisions.find(function (x) { return x.inst === d.inst && x.side === "buy" && !x.auto && x.ts > d.ts; });
      const months = [];
      for (let m = 0; m < 12; m++) {
        const from = d.cut + m * PRE, to = from + PRE;
        if (to > end || (next && next.ts < from)) break;
        const px = closeAt(b.s, isoDay(from));
        if (px == null) break;
        const rebuy = !!(next && next.ts < to);
        months.push({ gain: gain, down: px < sellPx, rebuy: rebuy });
        if (rebuy) break;
      }
      if (!months.length) return;
      n++;
      units.push(months);
      if (b.ticker && !(next && next.ts < d.cut + 90 * DAY) && d.cut + 90 * DAY <= end) {
        const px30 = closeAt(b.s, isoDay(d.cut + PRE));
        if (px30 != null) (px30 < sellPx ? watch.down : watch.up).push(viewsBetween(vi, b.ticker, d.cut + DAY, d.cut + 90 * DAY));
      }
    });
    const all = [].concat.apply([], units);
    const cell = function (g, dn) { const u = all.filter(function (x) { return x.gain === g && x.down === dn; }); return wilson(u.filter(function (x) { return x.rebuy; }).length, u.length); };
    // Rebuy rate per month after the price fell below the sell price, minus after it rose.
    const diff = clusterBoot(units, function (us) {
      let dk = 0, dn = 0, uk = 0, un = 0;
      us.forEach(function (u) { if (u.down) { dn++; if (u.rebuy) dk++; } else { un++; if (u.rebuy) uk++; } });
      return dn && un ? dk / dn - uk / un : null;
    }, 1000, 37);
    return { n: n, cells: { gainDown: cell(true, true), gainUp: cell(true, false), lossDown: cell(false, true), lossUp: cell(false, false) }, diff: diff,
      watch: { up: { n: watch.up.length, mean: mean(watch.up) }, down: { n: watch.down.length, mean: mean(watch.down) } },
      status: status(n, NEED.repurchase), need: NEED.repurchase, clear: clearOf(diff) };
  }

  // ---------- D5: myopic loss aversion (Benartzi & Thaler 1995) ----------

  function myopia(R, book, vi, end, bench) {
    const LONG = 365, SHORT = 91;
    const watch = { long: [], short: [] }, react = [], sellUnits = [];
    R.decisions.forEach(function (d) {
      if (d.side !== "buy" || d.auto || !d.horizonDays || !d.ticker || !eligible(d)) return;
      const close = R.decisions.find(function (x) { return x.inst === d.inst && x.ts > d.ts && x.cls === "close"; });
      const until = close ? close.cut : end, weeks = (until - d.cut) / (7 * DAY);
      if (weeks >= 2) {
        const v = viewsBetween(vi, d.ticker, d.cut + DAY, until) / weeks;
        if (d.horizonDays >= LONG) watch.long.push(v); else if (d.horizonDays <= SHORT) watch.short.push(v);
      }
      if (d.horizonDays < LONG) return;
      const b = book[d.inst];
      if (!b || !b.s) return;
      const s = b.s, i0 = barAt(s, d.date), units = [];
      // Every 5th bar while held: did a 5-day drop of 5% or more come before a sale within 5 bars?
      for (let i = i0 + 5; i + 5 < s.length; i += 5) {
        const t = Date.parse(s[i].date + "T21:00:00Z");
        if (t > until || !stateBefore(b, addDays(s[i].date, 1))) break;
        const dip = s[i].close / s[i - 5].close - 1 <= -0.05;
        const t1 = Date.parse(s[i + 5].date + "T23:59:59Z");
        const sold = R.decisions.some(function (x) { return x.inst === d.inst && x.side === "sell" && x.cut > t && x.cut <= t1; });
        units.push({ dip: dip, sold: sold });
      }
      if (units.length) react.push(units);
    });
    // Sales of long-horizon positions, for the coach rule "hold through dips":
    // days since the last 5-day drop of 5% or more, and what the stock did next.
    R.decisions.forEach(function (d) {
      if (d.side !== "sell" || d.auto || !eligible(d)) return;
      const buy = R.decisions.slice().reverse().find(function (x) { return x.inst === d.inst && x.side === "buy" && x.ts < d.ts && x.horizonDays >= LONG; });
      const b = book[d.inst];
      if (!buy || !b || !b.s) return;
      const s = b.s, i = barAt(s, addDays(d.date, -1));
      let dipDays = null;
      for (let k = i; k >= 5 && k > i - 20; k--) if (s[k].close / s[k - 5].close - 1 <= -0.05) { dipDays = (Date.parse(d.date) - Date.parse(s[k].date)) / DAY; break; }
      const f = D.forward(s, bench, d.date, 63);
      sellUnits.push({ id: d.inst + "|" + d.date, t: d.cut, tEnd: f ? f.end : d.cut + 100 * DAY, y: f ? f.ex : null, f: { dipDays: dipDays } });
    });
    const all = [].concat.apply([], react);
    const split = function (dip) { const u = all.filter(function (x) { return x.dip === dip; }); return wilson(u.filter(function (x) { return x.sold; }).length, u.length); };
    const diff = clusterBoot(react, function (us) {
      let dk = 0, dn = 0, nk = 0, nn = 0;
      us.forEach(function (u) { if (u.dip) { dn++; if (u.sold) dk++; } else { nn++; if (u.sold) nk++; } });
      return dn && nn ? dk / dn - nk / nn : null;
    }, 1000, 41);
    const wd = watch.long.length >= 2 && watch.short.length >= 2 ? S.bootstrap(watch.long, watch.short, 2000, 43) : null;
    const n = watch.long.length;
    return { n: n, watch: { long: { n: n, mean: mean(watch.long) }, short: { n: watch.short.length, mean: mean(watch.short) }, diff: wd },
      dip: split(true), noDip: split(false), diff: diff, positions: react.length, sellUnits: sellUnits,
      status: status(n, NEED.myopia), need: NEED.myopia, clear: clearOf(diff) && diff.est > 0 };
  }

  // ---------- E3: overconfidence (Odean 1999, Barber & Odean 2000) ----------

  function overconfidence(R, book, txs, links, prices, bench, cal, end) {
    // (a) Turnover per month in the main settlement currency: value bought and
    // sold (savings plans out) over the depot value at the start of the month.
    const ccyN = {};
    R.decisions.forEach(function (d) { if (!d.auto && eligible(d)) ccyN[d.currency || "?"] = (ccyN[d.currency || "?"] || 0) + 1; });
    const ccy = Object.keys(ccyN).sort(function (a, b) { return ccyN[b] - ccyN[a]; })[0] || null;
    const insts = Object.keys(book).filter(function (k) { return book[k].currency === ccy; });
    const monthsMap = {};
    cal.forEach(function (d) { const m = d.slice(0, 7); if (!monthsMap[m]) monthsMap[m] = d; });
    const months = Object.keys(monthsMap).sort();
    const feeBy = {};
    txs.forEach(function (t) { if ((t.kind === "buy" || t.kind === "sell") && (t.currency || "?") === ccy && t.fee > 0) feeBy[t.date.slice(0, 7)] = (feeBy[t.date.slice(0, 7)] || 0) + t.fee; });
    const rows = [];
    months.forEach(function (m, i) {
      const start = addDays(monthsMap[m], -1);
      if (Date.parse(monthsMap[m]) > end) return;
      const v0 = insts.reduce(function (s, k) { return s + valueAt(book[k], start); }, 0);
      if (!(v0 > 0)) return;
      let bought = 0, soldV = 0;
      R.decisions.forEach(function (d) {
        if (d.auto || !eligible(d) || (d.currency || "?") !== ccy || d.date.slice(0, 7) !== m) return;
        if (d.side === "buy") bought += d.amount || 0; else soldV += d.amount || 0;
      });
      rows.push({ month: m, value: v0, buy: bought / v0, sell: soldV / v0, fees: feeBy[m] || 0 });
    });
    const yr = function (k) { return rows.length ? mean(rows.map(function (r) { return r[k]; })) * 12 : null; };
    const turnover = { n: rows.length, currency: ccy, buy: yr("buy"), sell: yr("sell"), annual: rows.length ? (yr("buy") + yr("sell")) / 2 : null,
      costs: rows.length ? rows.reduce(function (s, r) { return s + r.fees; }, 0) / mean(rows.map(function (r) { return r.value; })) * 12 / rows.length : null,
      months: rows.map(function (r) { return { month: r.month, turnover: (r.buy + r.sell) / 2 }; }),
      status: status(rows.length, NEED.turnover), need: NEED.turnover };

    // (b) Odean test: a sale followed within 21 days by a buy of something else.
    // Both legs measured from the buy day, against the NASDAQ: bought minus sold.
    const seriesOf = function (inst) { const l = links[inst]; return l && l.symbol ? prices[l.symbol] : null; };
    const H = [21, 84, 252], pairs = [], used = {};
    const manual = R.decisions.filter(function (d) { return !d.auto && eligible(d); });
    manual.forEach(function (s) {
      if (s.side !== "sell") return;
      const b = manual.find(function (x) { return x.side === "buy" && x.inst !== s.inst && !used[x.inst + x.date] && x.cut >= s.cut && x.cut <= s.cut + 21 * DAY; });
      if (!b) return;
      used[b.inst + b.date] = 1;
      const sb = seriesOf(b.inst), ss = seriesOf(s.inst), p = { sold: s.inst, bought: b.inst, t: b.cut, gapDays: (b.cut - s.cut) / DAY };
      H.forEach(function (h) {
        const fb = D.forward(sb, bench, b.date, h), fs = D.forward(ss, bench, b.date, h);
        p[h] = fb && fs ? fb.ex - fs.ex : null;
        if (h === 84 && fb && fs) p.end84 = Math.max(fb.end, fs.end);
      });
      pairs.push(p);
    });
    const odean = { n: pairs.filter(function (p) { return p[21] != null; }).length, pairs: pairs, status: "none", need: NEED.odean };
    H.forEach(function (h) {
      const xs = pairs.map(function (p) { return p[h]; }).filter(function (x) { return x != null; });
      odean[h] = xs.length >= 2 ? Object.assign({ n: xs.length }, S.bootstrap(xs, null, 2000, 47 + h)) : { n: xs.length, est: mean(xs), lo: null, hi: null };
    });
    odean.status = status(odean.n, NEED.odean);
    odean.clear = clearOf(odean[84]) && odean[84].est < 0 || clearOf(odean[21]) && odean[21].est < 0;

    // (c) Research per trade: months with more trades get less research per trade?
    const perM = {};
    R.decisions.forEach(function (d) {
      if (d.excluded) return;
      const m = d.date.slice(0, 7), x = perM[m] = perM[m] || { n: 0, dwell: 0 };
      x.n++; x.dwell += d.dwell30 || 0;
    });
    const ms = Object.keys(perM);
    const c = ms.length >= 5 ? S.corr(ms.map(function (m) { return perM[m].n; }), ms.map(function (m) { return perM[m].dwell / perM[m].n; }), true) : { r: null, n: ms.length };
    const perTrade = { n: ms.length, corr: c, status: status(ms.length, NEED.perTrade), need: NEED.perTrade, clear: c.lo != null && c.hi < 0 };

    // Buys with the days since the last sale of something else, for the coach
    // rule "no quick switch": y is the Odean difference when the buy was a switch
    // (84 bars, about four months), known at the later close of the two legs.
    const pairOf = {};
    pairs.forEach(function (p) { pairOf[p.bought + "|" + p.t] = p; });
    let lastSell = null;
    const buyUnits = [];
    manual.slice().sort(function (a, b) { return a.cut - b.cut; }).forEach(function (d) {
      if (d.side === "sell") { lastSell = d; return; }
      if (d.excluded) return;
      const p = pairOf[d.inst + "|" + d.cut], since = lastSell && lastSell.inst !== d.inst ? (d.cut - lastSell.cut) / DAY : null;
      const f = d.fwd && d.fwd[63];
      buyUnits.push({ id: d.inst + "|" + d.date, t: d.cut, tEnd: p ? p.end84 || d.cut + 130 * DAY : f ? f.end : d.cut + 100 * DAY, y: p && p[84] != null ? p[84] : (p ? null : f ? f.ex : null), f: { sinceSell: since } });
    });

    const st = [turnover.status, odean.status, perTrade.status].sort(function (a, b) { return ({ none: 0, indicative: 1, solid: 2 })[b] - ({ none: 0, indicative: 1, solid: 2 })[a]; })[0];
    return { turnover: turnover, odean: odean, perTrade: perTrade, buyUnits: buyUnits, status: st, clear: !!(odean.clear || perTrade.clear) };
  }

  // ---------- E4: under-diversification (Goetzmann & Kumar 2008) ----------

  function diversification(R, book, cal, end, profiles, vi, tickerSym) {
    profiles = profiles || {};
    const sectorOf = function (b) { const p = b.symbol && profiles[b.symbol]; return b.assetClass === "ETF" || b.assetClass === "FUND" ? "Funds" : (p && p.sector) || "Unknown"; };
    const ccyN = {};
    Object.keys(book).forEach(function (k) { ccyN[book[k].currency] = (ccyN[book[k].currency] || 0) + book[k].steps.length; });
    const ccy = Object.keys(ccyN).sort(function (a, b) { return ccyN[b] - ccyN[a]; })[0];
    const ends = [];
    cal.forEach(function (d, i) { if (i === cal.length - 1 || cal[i + 1].slice(0, 7) !== d.slice(0, 7)) ends.push(d); });
    const snaps = [];
    ends.forEach(function (date) {
      if (Date.parse(date) > end) return;
      const pos = [];
      Object.keys(book).forEach(function (k) {
        const b = book[k];
        if (b.currency !== ccy) return;
        const v = valueAt(b, date);
        if (v > 0) pos.push({ k: k, v: v, fund: b.assetClass === "ETF" || b.assetClass === "FUND" });
      });
      if (!pos.length) return;
      const tot = pos.reduce(function (s, p) { return s + p.v; }, 0);
      const hhi = pos.reduce(function (s, p) { return s + Math.pow(p.v / tot, 2); }, 0);
      // Mean pairwise correlation of daily returns over the 60 bars to this date (single stocks only).
      const rets = pos.filter(function (p) { return !p.fund && book[p.k].s; }).map(function (p) {
        const s = book[p.k].s, i = barAt(s, date);
        if (i < 60) return null;
        const r = [];
        for (let j = i - 59; j <= i; j++) r.push(s[j].close / s[j - 1].close - 1);
        return r;
      }).filter(Boolean);
      let cs = 0, cn = 0;
      for (let a = 0; a < rets.length; a++) for (let b = a + 1; b < rets.length; b++) { const c = S.corr(rets[a], rets[b]).r; if (c != null) { cs += c; cn++; } }
      // Sector and country weights (funds as one "Funds" sector; unknown sectors kept apart).
      const sec = {}, cty = {};
      pos.forEach(function (p) {
        const b = book[p.k], sc = sectorOf(b), cc = countryOfInst(b) || "??";
        sec[sc] = (sec[sc] || 0) + p.v / tot; cty[cc] = (cty[cc] || 0) + p.v / tot;
      });
      const hh = function (m) { return Object.keys(m).reduce(function (s, k) { return s + m[k] * m[k]; }, 0); };
      const topOf = function (m) { return Object.keys(m).sort(function (a, b) { return m[b] - m[a]; })[0]; };
      snaps.push({ date: date, n: pos.length, hhi: hhi, eff: 1 / hhi, fundShare: pos.filter(function (p) { return p.fund; }).reduce(function (s, p) { return s + p.v; }, 0) / tot,
        top: Math.max.apply(null, pos.map(function (p) { return p.v / tot; })), corr: cn ? cs / cn : null, value: tot,
        sectorHhi: hh(sec), topSector: topOf(sec), topSectorShare: sec[topOf(sec)], unknownSector: sec.Unknown || 0,
        countryHhi: hh(cty), topCountry: topOf(cty), topCountryShare: cty[topOf(cty)] });
    });
    const last = snaps[snaps.length - 1] || null;
    const holdings = { n: snaps.length, last: last, currency: ccy || null,
      medianPositions: median(snaps.map(function (s) { return s.n; })), medianHhi: median(snaps.map(function (s) { return s.hhi; })),
      series: snaps, status: status(snaps.length, NEED.holdings), need: NEED.holdings };

    // (b) 1/n: buys (savings plans out) with another buy of the same amount
    // (within 2%, same currency) less than 30 days apart, and round amounts.
    // Chance: the same count with the amounts shuffled among neighbouring buys
    // (blocks of 6 in time order, times kept). Buys of a similar usual size often
    // land within 2% of each other anyway, and the usual size drifts with wealth,
    // so a shuffle across the whole history would understate chance.
    const buys = R.decisions.filter(function (d) { return d.side === "buy" && !d.auto && eligible(d) && d.amount > 0; }).sort(function (a, b) { return a.cut - b.cut; });
    const sameCount = function (amt) {
      let k = 0;
      buys.forEach(function (d, i) {
        if (buys.some(function (x, j) { return j !== i && (x.currency || "?") === (d.currency || "?") && Math.abs(x.cut - d.cut) < PRE && Math.abs(amt[j] / amt[i] - 1) <= 0.02; })) k++;
      });
      return k;
    };
    const amts = buys.map(function (d) { return d.amount; }), same = sameCount(amts), sh = [], rr = S.rng(79);
    for (let b = 0; b < (buys.length >= 5 ? 200 : 0); b++) {
      const a = amts.slice();
      for (let s0 = 0; s0 < a.length; s0 += 6) for (let i = Math.min(a.length, s0 + 6) - 1; i > s0; i--) { const j = s0 + ((rr() * (i - s0 + 1)) | 0), x = a[i]; a[i] = a[j]; a[j] = x; }
      sh.push(sameCount(a));
    }
    sh.sort(S.numeric);
    let round = 0;
    buys.forEach(function (d) { const r = Math.round(d.amount / 500) * 500; if (r > 0 && Math.abs(d.amount - r) <= Math.max(1, 0.002 * d.amount)) round++; });
    const chance = sh.length ? mean(sh) / buys.length : null, p95 = sh.length ? S.quantile(sh, 0.95) : null;
    // Signal: at least 40% of buys repeat a nearby amount, and either more often than
    // the shuffle gives or mostly in round sums (when every buy is the same sum the
    // shuffle cannot tell: it gives the same count by construction).
    const sameW = wilson(same, buys.length), roundW = wilson(round, buys.length), above = p95 != null && same > p95;
    const oneOverN = { n: buys.length, same: sameW, chance: chance, above: above, round: roundW,
      signal: buys.length >= NEED.oneOverN.min && sameW.p >= 0.4 && (above || roundW.p >= 0.5),
      status: status(buys.length, NEED.oneOverN), need: NEED.oneOverN };
    const concentrated = last && last.n <= 5 && last.fundShare < 0.5;
    // (c) Research concentration: sector HHI of your views over the last 90 days (stocks with a known sector).
    const vsec = {};
    let vn = 0;
    Object.keys(vi || {}).forEach(function (t) {
      const p = profiles[(tickerSym || {})[t] || t], n = viewsBetween(vi, t, end - 90 * DAY, end + DAY);
      if (!n || !p || !p.sector) return;
      vsec[p.sector] = (vsec[p.sector] || 0) + n; vn += n;
    });
    const research = vn ? { n: vn, hhi: Object.keys(vsec).reduce(function (s, k) { return s + Math.pow(vsec[k] / vn, 2); }, 0),
      top: Object.keys(vsec).sort(function (a, b) { return vsec[b] - vsec[a]; })[0] } : null;
    if (research) research.topShare = vsec[research.top] / vn;
    const sectorHeavy = !!(last && last.unknownSector < 0.3 && last.topSector !== "Funds" && last.topSectorShare > 0.5 && last.n >= 3);
    return { holdings: holdings, oneOverN: oneOverN, concentrated: !!concentrated, sectorHeavy: sectorHeavy, research: research,
      status: holdings.status !== "none" ? holdings.status : oneOverN.status, clear: false };
  }

  // ---------- A5: ostrich effect (Karlsson et al. 2009, Sicherman et al. 2016) ----------

  function ostrich(book, vi, cal, from, end) {
    const weeks = {}, depth = { loss: [], gain: [] }, gaps = { loss: [], gain: [] };
    Object.keys(book).forEach(function (k) {
      const b = book[k];
      if (!b.s || !b.ticker) return;
      let lastState = null;
      cal.forEach(function (date) {
        const t = Date.parse(date + "T00:00:00Z");
        if (t < from || t > end) return;
        const h = heldOn(b, date);
        if (!h.held) { lastState = null; return; }
        const i = barAt(b.s, addDays(date, -1));
        if (i < 1) return;
        const r = b.s[i].close / b.s[i - 1].close - 1;
        const viewed = !!(vi[b.ticker] && vi[b.ticker].day[date]);
        if (r > 0.01 || r < -0.01) {
          const wk = Math.floor((t / DAY + 3) / 7);
          (weeks[wk] = weeks[wk] || []).push({ up: r > 0.01, viewed: viewed });
        }
        // Gaps: crossing 10% under or over cost, days until the next look.
        if (h.cost > 0) {
          const pnl = b.s[i].close / h.cost - 1, state = pnl <= -0.1 ? "loss" : pnl >= 0.1 ? "gain" : "flat";
          if (state !== "flat" && state !== lastState) {
            const nv = nextView(vi, b.ticker, t);
            gaps[state].push(nv != null && nv <= end ? { t: (nv - t) / DAY, done: true } : { t: (end - t) / DAY, done: false });
          }
          lastState = state;
        }
      });
      // Depth of each look at a held position: dwell and scroll, under water vs in profit.
      (vi[b.ticker] ? vi[b.ticker].arr : []).forEach(function (e) {
        if (e.ts < from || e.ts > end) return;
        const date = isoDay(e.ts), h = heldOn(b, date);
        if (!h.held || !(h.cost > 0)) return;
        const c = closeAt(b.s, addDays(date, -1));
        if (c == null) return;
        (c < h.cost ? depth.loss : depth.gain).push({ dwell: (e.dwellMs || 0) / 60000, scroll: e.scrollDepth });
      });
    });
    const clusters = Object.keys(weeks).map(function (w) { return weeks[w]; }), all = [].concat.apply([], clusters);
    const side = function (up) { const u = all.filter(function (x) { return x.up === up; }); return wilson(u.filter(function (x) { return x.viewed; }).length, u.length); };
    const up = side(true), down = side(false);
    const diff = clusterBoot(clusters, function (us) {
      let uk = 0, un = 0, dk = 0, dn = 0;
      us.forEach(function (u) { if (u.up) { un++; if (u.viewed) uk++; } else { dn++; if (u.viewed) dk++; } });
      return un && dn ? uk / un - dk / dn : null;
    }, 1000, 53);
    const n = Math.min(up.n || 0, down.n || 0);
    const dw = function (k) { return depth[k].map(function (x) { return x.dwell; }); };
    const sc = function (k) { return depth[k].filter(function (x) { return x.scroll != null; }).map(function (x) { return x.scroll; }); };
    return { n: n, up: up, down: down, diff: diff,
      depth: { loss: { n: depth.loss.length, dwell: mean(dw("loss")), scroll: mean(sc("loss")) }, gain: { n: depth.gain.length, dwell: mean(dw("gain")), scroll: mean(sc("gain")) },
        diff: depth.loss.length >= 5 && depth.gain.length >= 5 ? S.bootstrap(dw("loss"), dw("gain"), 2000, 59) : null },
      gaps: { loss: { n: gaps.loss.length, median: kmMedian(gaps.loss) }, gain: { n: gaps.gain.length, median: kmMedian(gaps.gain) } },
      positions: Object.keys(book).length, fromLabels: Object.keys(book).some(function (k) { return book[k].fromLabels; }),
      status: status(n, NEED.ostrich), need: NEED.ostrich, clear: clearOf(diff) && diff.est > 0 };
  }

  // ---------- A6: confirmation bias (Nickerson 1998, Park et al. 2013) ----------

  const CHECKING = { financials: 1, ownership: 1, short: 1, insider: 1, estimates: 1, institutional: 1, earnings: 1, analysis: 1 };
  const CONFIRMING = { news: 1, charts: 1, community: 1 };

  // A sharp move: a daily return beyond 2 standard deviations of the 60 days before, or beyond 5%.
  function shockDays(s) {
    const out = [];
    for (let i = 61; i < s.length; i++) {
      const rs = [];
      for (let j = i - 60; j < i; j++) rs.push(s[j].close / s[j - 1].close - 1);
      const sd = S.stdev(rs), r = s[i].close / s[i - 1].close - 1;
      if (Math.abs(r) > 0.05 || (sd && Math.abs(r) > 2 * sd)) out.push({ date: s[i].date, r: r });
    }
    return out;
  }

  function confirmation(events, vi, prices, tickerSym, end) {
    const labels = (events || []).filter(function (e) { return e.sentiment === "positive" || e.sentiment === "negative" || e.sentiment === "neutral"; })
      .sort(function (a, b) { return a.ts - b.ts; });
    const by = {};
    labels.forEach(function (e) { (by[e.ticker] = by[e.ticker] || []).push(e); });
    const units = [], mix = { before: [], after: [] }, shockCache = {};
    Object.keys(by).forEach(function (t) {
      const ls = by[t], s = prices[tickerSym[t]];
      ls.forEach(function (e, i) {
        if (e.sentiment === "neutral") return;
        if (i > 0 && ls[i - 1].sentiment === e.sentiment && e.ts - ls[i - 1].ts < PRE) return; // a reconfirmation, not a new call
        const next = ls.slice(i + 1).find(function (x) { return x.sentiment !== e.sentiment; });
        const standTo = Math.min(next ? next.ts : Infinity, e.ts + 90 * DAY, end);
        // (b) research mix 30 days before vs after the call
        [["before", e.ts - PRE, e.ts], ["after", e.ts, e.ts + PRE]].forEach(function (w) {
          if (w[2] > end || !vi[t]) return;
          let chk = 0, cnf = 0;
          vi[t].arr.forEach(function (v) { if (v.ts >= w[1] && v.ts < w[2]) { const d = v.dwellMs || 0; if (CHECKING[v.researchType]) chk += d; else if (CONFIRMING[v.researchType]) cnf += d; } });
          if (chk + cnf > 0) mix[w[0]].push(chk / (chk + cnf));
        });
        if (!s) return;
        const sh = shockCache[t] || (shockCache[t] = shockDays(s));
        const pos = e.sentiment === "positive";
        let gotC = false, gotF = false;
        sh.forEach(function (x) {
          const at = Date.parse(x.date + "T21:00:00Z");
          if (at <= e.ts || at >= standTo || at + 14 * DAY > end) return;
          const contrary = pos ? x.r < 0 : x.r > 0;
          if (contrary ? gotC : gotF) return;
          if (contrary) gotC = true; else gotF = true;
          const revised = ls.some(function (y) { return y.ts > at && y.ts <= at + 14 * DAY && y.sentiment !== e.sentiment; });
          const looked = viewsBetween(vi, t, at, at + 5 * DAY) > 0;
          units.push([{ contrary: contrary, revised: revised, looked: looked }]);
        });
      });
    });
    const all = [].concat.apply([], units);
    const grp = function (c) { const u = all.filter(function (x) { return x.contrary === c; }); return { rev: wilson(u.filter(function (x) { return x.revised; }).length, u.length), look: wilson(u.filter(function (x) { return x.looked; }).length, u.length) }; };
    const con = grp(true), conf = grp(false);
    const diff = clusterBoot(units, function (us) {
      let ck = 0, cn = 0, fk = 0, fn = 0;
      us.forEach(function (u) { if (u.contrary) { cn++; if (u.revised) ck++; } else { fn++; if (u.revised) fk++; } });
      return cn && fn ? ck / cn - fk / fn : null;
    }, 1000, 61);
    const n = con.rev.n || 0;
    // A rational reader revises more after news against the call than after news for it.
    // The signal: someone who does change calls (5+ changes) but whose revisions clearly
    // do not respond to contrary news (the range rules out a rise of 10 points or more).
    // Someone who never relabels anything says nothing about how news is weighed.
    let changes = 0;
    Object.keys(by).forEach(function (t) { by[t].forEach(function (e, i) { if (i && e.sentiment !== by[t][i - 1].sentiment) changes++; }); });
    const signal = changes >= 5 && n >= NEED.confirmation.min && diff.hi != null && diff.hi < 0.1;
    const md = mix.before.length >= 3 && mix.after.length >= 3 ? S.bootstrap(mix.after, mix.before, 2000, 67) : null;
    return { n: n, contrary: con, confirming: conf, diff: diff, signal: signal, changes: changes,
      mix: { before: { n: mix.before.length, mean: mean(mix.before) }, after: { n: mix.after.length, mean: mean(mix.after) }, diff: md },
      status: status(n, NEED.confirmation), need: NEED.confirmation, clear: signal };
  }

  // (c) Breadth: Shannon entropy of the page types per stock and month (3+ views),
  // months with a standing call against months without one.
  function entropy(events, vi) {
    const labels = (events || []).filter(function (e) { return e.sentiment === "positive" || e.sentiment === "negative"; });
    const callAt = function (t, ts) { return labels.some(function (e) { return e.ticker === t && e.ts <= ts && ts - e.ts <= 90 * DAY; }); };
    const withCall = [], without = [];
    Object.keys(vi).forEach(function (t) {
      const m = {};
      vi[t].arr.forEach(function (v) { const k = isoDay(v.ts).slice(0, 7); (m[k] = m[k] || []).push(v); });
      Object.keys(m).forEach(function (k) {
        const vs = m[k];
        if (vs.length < 3) return;
        const c = {};
        vs.forEach(function (v) { const r = v.researchType || "unclassified"; c[r] = (c[r] || 0) + 1; });
        let h = 0;
        Object.keys(c).forEach(function (r) { const p = c[r] / vs.length; h -= p * Math.log2(p); });
        (callAt(t, vs[vs.length - 1].ts) ? withCall : without).push(h);
      });
    });
    const n = Math.min(withCall.length, without.length);
    const diff = withCall.length >= 2 && without.length >= 2 ? S.bootstrap(withCall, without, 2000, 71) : null;
    return { n: n, withCall: { n: withCall.length, mean: mean(withCall) }, without: { n: without.length, mean: mean(without) }, diff: diff,
      status: status(n, NEED.entropy), need: NEED.entropy, clear: clearOf(diff) && diff.est < 0 };
  }

  // ---------- A7: herding (Kumar & Lee 2006, Barber, Odean & Zhu 2009) ----------

  // community: network_community_daily rows {ticker, days: [[day, views, ...]]}.
  // trending: { day: { ticker: 1 } } of the outside lists' top names.
  // A "crowd move" on a stock for a day: in the 3 days before, the community viewed it
  // at least 3 times and at least twice its own 30-day rate, or it sat on an outside
  // trending list. Chance is each stock's own share of crowd-move days over the period
  // studied, so a stock that is always popular does not count as following.
  function herding(vi, community, trending, now) {
    const cv = {};
    (community || []).forEach(function (r) { const m = cv[r.ticker] = cv[r.ticker] || {}; (r.days || []).forEach(function (d) { m[d[0]] = (m[d[0]] || 0) + (+d[1] || 0); }); });
    const tdays = Object.keys(trending || {}).sort(), cdays = {};
    Object.keys(cv).forEach(function (t) { Object.keys(cv[t]).forEach(function (d) { cdays[d] = 1; }); });
    const allDays = Object.keys(cdays).concat(tdays).sort();
    if (!allDays.length) return { n: 0, status: "none", need: NEED.herding, clear: false, noData: true };
    const from = allDays[0], to = isoDay(now);
    const sum = function (t, d0, d1) { const m = cv[t]; if (!m) return 0; let s = 0; for (let d = d0; d <= d1; d = addDays(d, 1)) s += m[d] || 0; return s; };
    const onList = function (t, d) { for (let k = 1; k <= 3; k++) { const x = trending && trending[addDays(d, -k)]; if (x && x[t]) return true; } return false; };
    const crowdMove = function (t, d) {
      const w = sum(t, addDays(d, -3), addDays(d, -1)), base = sum(t, addDays(d, -33), addDays(d, -4)) / 30 * 3;
      return (w >= 3 && w >= 2 * base) || onList(t, d);
    };
    const days = [];
    for (let d = addDays(from, 33); d <= to; d = addDays(d, 7)) days.push(d); // weekly sample for each stock's base rate
    const units = [];
    let lead = 0, leadN = 0;
    Object.keys(vi).forEach(function (t) {
      const first = isoDay(vi[t].ts[0]);
      if (first < addDays(from, 33) || first > to) return;
      const p = days.filter(function (d) { return crowdMove(t, d); }).length / days.length;
      units.push([{ hit: crowdMove(t, first) ? 1 : 0, p: p }]);
      // Ahead of the crowd: no community views in the 30 days before, 3+ in the 7 after.
      if (Date.parse(addDays(first, 7)) <= now) {
        leadN++;
        if (sum(t, addDays(first, -30), addDays(first, -1)) === 0 && sum(t, addDays(first, 1), addDays(first, 7)) >= 3) lead++;
      }
    });
    const all = [].concat.apply([], units);
    const ex = clusterBoot(units, function (us) { return us.length ? mean(us.map(function (u) { return u.hit - u.p; })) : null; }, 1000, 73);
    return { n: all.length, followed: wilson(all.filter(function (u) { return u.hit; }).length, all.length), chance: mean(all.map(function (u) { return u.p; })),
      excess: ex, lead: wilson(lead, leadN), from: from,
      status: status(all.length, NEED.herding), need: NEED.herding, clear: clearOf(ex) && ex.est > 0 };
  }

  // Your daily view mix vs the community's (world_crowd_overlap): last 30 days against the 30 before.
  function crowdTrend(rows) {
    const r = (rows || []).filter(function (x) { return x.overlap != null; }).sort(function (a, b) { return a.day < b.day ? -1 : 1; });
    if (!r.length) return null;
    const last = r.slice(-30).map(function (x) { return +x.overlap; }), prev = r.slice(-60, -30).map(function (x) { return +x.overlap; });
    return { last: mean(last), prev: prev.length ? mean(prev) : null, days: r.length, series: r.map(function (x) { return { day: x.day, v: +x.overlap }; }) };
  }

  // ---------- countries (home bias, depot by country) ----------

  // Listing country from a Yahoo symbol suffix; no suffix = a US listing.
  const SUFFIX_CC = { DE: "DE", F: "DE", BE: "DE", MU: "DE", SG: "DE", DU: "DE", HM: "DE", HA: "DE", L: "GB", IL: "GB", PA: "FR", AS: "NL", MI: "IT", MC: "ES",
    SW: "CH", VI: "AT", BR: "BE", ST: "SE", HE: "FI", CO: "DK", OL: "NO", LS: "PT", IR: "IE", WA: "PL", TO: "CA", V: "CA", NE: "CA", AX: "AU", HK: "HK", T: "JP",
    KS: "KR", KQ: "KR", TW: "TW", TWO: "TW", SS: "CN", SZ: "CN", NS: "IN", BO: "IN", SA: "BR", MX: "MX", JO: "ZA", SI: "SG", TA: "IL", NZ: "NZ", SR: "SA" };
  function countryOfSymbol(sym) {
    if (!sym) return null;
    const m = String(sym).toUpperCase().match(/\.([A-Z]{1,3})$/);
    if (!m) return /[=^]/.test(sym) ? null : "US";
    return SUFFIX_CC[m[1]] || null;
  }
  // Domicile from the ISIN prefix where there is one (XS/EU are not countries), else the listing.
  function countryOfInst(b) {
    const isin = b.isin || (/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(b.inst || "") ? b.inst : null);
    if (isin && !/^(XS|EU|XC|XD|XF)/.test(isin)) return isin.slice(0, 2);
    return countryOfSymbol(b.symbol);
  }
  // MSCI ACWI country weights, APPROXIMATE (rounded, mid-2025 factsheet level). Update
  // by hand from MSCI's quarterly factsheet; ACWI_ASOF is shown next to every use.
  const ACWI_ASOF = "2025-06 (approximate)";
  const ACWI = { US: 0.645, JP: 0.048, GB: 0.032, CA: 0.028, CN: 0.027, FR: 0.023, DE: 0.022, CH: 0.021, TW: 0.020, IN: 0.018, AU: 0.016, KR: 0.012,
    NL: 0.011, SE: 0.008, IT: 0.007, ES: 0.007, DK: 0.005, BR: 0.005, HK: 0.005, SA: 0.004, SG: 0.004, ZA: 0.003, FI: 0.002, BE: 0.002, MX: 0.002, IL: 0.002,
    IE: 0.002, NO: 0.001, PL: 0.001, AT: 0.0005, PT: 0.0004, NZ: 0.0005 };
  const COUNTRY_NAMES = { US: "United States", JP: "Japan", GB: "United Kingdom", CA: "Canada", CN: "China", FR: "France", DE: "Germany", CH: "Switzerland", TW: "Taiwan",
    IN: "India", AU: "Australia", KR: "South Korea", NL: "Netherlands", SE: "Sweden", IT: "Italy", ES: "Spain", DK: "Denmark", BR: "Brazil", HK: "Hong Kong",
    SA: "Saudi Arabia", SG: "Singapore", ZA: "South Africa", FI: "Finland", BE: "Belgium", MX: "Mexico", IL: "Israel", IE: "Ireland", NO: "Norway", PL: "Poland",
    AT: "Austria", PT: "Portugal", NZ: "New Zealand", LU: "Luxembourg" };

  // ---------- price features from the bars BEFORE a day ----------

  function pastRet(s, date, bars) {
    if (!s) return null;
    const i = barAt(s, addDays(date, -1));
    return i - bars >= 0 && s[i - bars].close > 0 ? s[i].close / s[i - bars].close - 1 : null;
  }
  // { hi, close } over the 252 bars before the day; null with less than 200 bars.
  function high52(s, date) {
    if (!s) return null;
    const i = barAt(s, addDays(date, -1));
    if (i < 200) return null;
    let hi = 0;
    for (let k = Math.max(0, i - 251); k <= i; k++) if (s[k].close > hi) hi = s[k].close;
    return { hi: hi, close: s[i].close };
  }
  // Lottery features of a stock on a day, from the bars before it (LOTTERY above).
  // The price test needs the price in USD: a USD listing, or fxUsd[currency].
  function lotteryAt(s, bench, date, fxUsd) {
    if (!s) return null;
    const i = barAt(s, addDays(date, -1));
    if (i < 22) return null;
    let mx = -Infinity;
    for (let k = i - 20; k <= i; k++) mx = Math.max(mx, s[k].close / s[k - 1].close - 1);
    const out = { max: mx, maxHit: mx > LOTTERY.max, ivol: null, skew: null, priceUsd: null, kumar: null };
    if (i >= LOTTERY.window && bench && bench.length) {
      const xs = [], ys = [];
      for (let k = i - LOTTERY.window + 1; k <= i; k++) {
        const b0 = closeAt(bench, s[k - 1].date), b1 = closeAt(bench, s[k].date);
        if (b0 > 0 && b1 > 0) { xs.push(b1 / b0 - 1); ys.push(s[k].close / s[k - 1].close - 1); }
      }
      if (xs.length >= 60) {
        const mxv = mean(xs), myv = mean(ys);
        let sxy = 0, sxx = 0;
        for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mxv) * (ys[k] - myv); sxx += (xs[k] - mxv) * (xs[k] - mxv); }
        const beta = sxx ? sxy / sxx : 0, res = ys.map(function (y, k) { return y - myv - beta * (xs[k] - mxv); });
        const sd = S.stdev(res);
        out.ivol = sd * Math.sqrt(252);
        out.skew = sd ? mean(res.map(function (r) { return Math.pow(r / sd, 3); })) : null;
      }
    }
    let ccy = s.currency || null, px = s[i].close;
    if (ccy === "GBp" || ccy === "GBX") { ccy = "GBP"; px /= 100; }
    const rate = ccy === "USD" ? 1 : fxUsd && ccy && fxUsd[ccy] > 0 ? fxUsd[ccy] : null;
    if (rate) out.priceUsd = px * rate;
    if (out.priceUsd != null && out.ivol != null && out.skew != null) out.kumar = out.priceUsd < LOTTERY.price && out.ivol > LOTTERY.ivol && out.skew > LOTTERY.iskew;
    out.lottery = out.maxHit || out.kumar === true;
    return out;
  }

  // Sessions: views less than 30 minutes apart belong together.
  function sessions(intraday) {
    const ev = (intraday || []).filter(function (e) { return e && e.ts; }).sort(function (a, b) { return a.ts - b.ts; });
    const out = [];
    let cur = null;
    ev.forEach(function (e) {
      if (!cur || e.ts - cur.last > 30 * 60000) { cur = { from: e.ts, last: e.ts, dwell: 0, tickers: {} }; out.push(cur); }
      cur.last = e.ts; cur.dwell = e.dwellMs || 0; cur.tickers[e.ticker] = 1;
    });
    return out.map(function (x) { return { from: x.from, minutes: (x.last - x.from + x.dwell) / 60000, tickers: Object.keys(x.tickers).length }; });
  }

  // Positive/Negative calls, a repeat of the same call within 30 days counting once.
  function freshCalls(events) {
    const seen = {};
    return (events || []).filter(function (e) { return e.sentiment === "positive" || e.sentiment === "negative"; }).sort(function (a, b) { return a.ts - b.ts; })
      .filter(function (e) {
        const k = e.ticker + "|" + e.sentiment, last = seen[k];
        if (last != null && e.ts - last < PRE) return false;
        seen[k] = e.ts;
        return true;
      });
  }
  function priceAtCall(e, s) { return e.priceAtEvent > 0 ? e.priceAtEvent : closeAt(s, isoDay(e.ts)); }

  // ---------- B3: extrapolation (De Bondt 1993, Greenwood & Shleifer 2014) ----------

  function extrapolation(R, events, vi, prices, tickerSym, hasTrades) {
    const H = { m1: 21, m3: 63, m12: 252 };
    // (a) Calls: the sign of the call against the stock's past return.
    const calls = [];
    freshCalls(events).forEach(function (e) {
      const s = prices[tickerSym[e.ticker]], d = isoDay(e.ts);
      const r = { sign: e.sentiment === "positive" ? 1 : -1, m1: pastRet(s, d, H.m1), m3: pastRet(s, d, H.m3), m12: pastRet(s, d, H.m12) };
      const p = priceAtCall(e, s);
      r.implied = e.targetPrice > 0 && p > 0 ? e.targetPrice / p - 1 : null;
      if (r.m3 != null) calls.push(r);
    });
    const corrOf = function (k) { const c = calls.filter(function (x) { return x[k] != null; }); return S.corr(c.map(function (x) { return x.sign; }), c.map(function (x) { return x[k]; }), false, 0.99); };
    const imp = calls.filter(function (x) { return x.implied != null; });
    const nCalls = calls.filter(function (x) { return x.m12 != null; }).length;
    const callsOut = { n: calls.length, n12: nCalls, m1: corrOf("m1"), m3: corrOf("m3"), m12: corrOf("m12"),
      implied: imp.length >= 5 ? S.corr(imp.map(function (x) { return x.implied; }), imp.map(function (x) { return x.m3; }), true) : { r: null, n: imp.length },
      status: status(calls.length, NEED.extrapolationCalls), need: NEED.extrapolationCalls };
    callsOut.clear = [callsOut.m3, callsOut.m12].some(function (c) { return c.lo != null && c.lo > 0; });
    // (b) Buys: where the bought stock's past return ranks among the stocks you viewed in the 30 days before.
    const rows = [], units = [];
    if (hasTrades) R.decisions.forEach(function (d) {
      if (d.excluded || d.side !== "buy" || !d.ticker) return;
      const s = prices[tickerSym[d.ticker]];
      const own3 = pastRet(s, d.date, H.m3), own12 = pastRet(s, d.date, H.m12);
      const uni = Object.keys(vi).filter(function (t) { return viewsBetween(vi, t, d.cut - PRE, d.cut) > 0 || t === d.ticker; });
      const r3 = [], r12 = [];
      uni.forEach(function (t) { const ss = prices[tickerSym[t]]; const a = pastRet(ss, d.date, H.m3), b = pastRet(ss, d.date, H.m12); if (a != null) r3.push(a); if (b != null) r12.push(b); });
      r3.sort(S.numeric); r12.sort(S.numeric);
      const p3 = own3 != null && r3.length >= 5 ? S.pctRank(r3, own3) : null, p12 = own12 != null && r12.length >= 5 ? S.pctRank(r12, own12) : null;
      if (p3 != null) rows.push({ p3: p3, p12: p12 });
      const f = d.fwd && d.fwd[21];
      units.push({ id: d.inst + "|" + d.date, t: d.cut, tEnd: f ? f.end : d.cut + 35 * DAY, y: f ? f.ex : null, f: { pct12: p12, relSize: d.relSize } });
    });
    const p3 = rows.map(function (r) { return r.p3; }), p12 = rows.filter(function (r) { return r.p12 != null; }).map(function (r) { return r.p12; });
    const buys = { n: rows.length, p3: p3.length >= 2 ? S.bootstrap(p3, null, 2000, 83) : { est: mean(p3), lo: null, hi: null },
      p12: p12.length >= 2 ? S.bootstrap(p12, null, 2000, 89) : { est: mean(p12), lo: null, hi: null }, n12: p12.length,
      status: status(rows.length, NEED.extrapolationBuys), need: NEED.extrapolationBuys };
    buys.clear = (buys.p3.lo != null && buys.p3.lo > 0.5) || (buys.p12.lo != null && buys.p12.lo > 0.5);
    const st = [callsOut.status, buys.status].reduce(function (b, x) { return ({ none: 0, indicative: 1, solid: 2 })[x] > ({ none: 0, indicative: 1, solid: 2 })[b] ? x : b; }, "none");
    return { calls: callsOut, buys: buys, buyUnits: units, status: st, clear: callsOut.clear || buys.clear };
  }

  // ---------- B4: lottery preference (Kumar 2009, Bali et al. 2011) ----------

  function lottery(R, events, intraday, vi, prices, tickerSym, bench, fxUsd, hasTrades) {
    const memo = {};
    const at = function (t, date) { const k = t + "|" + date; if (!(k in memo)) memo[k] = lotteryAt(prices[tickerSym[t]], bench, date, fxUsd); return memo[k]; };
    // (a) Views: share of stock-days viewed that were lottery stocks that day.
    let vd = 0, vl = 0;
    Object.keys(vi).forEach(function (t) { Object.keys(vi[t].day).forEach(function (d) { const x = at(t, d); if (!x) return; vd++; if (x.lottery) vl++; }); });
    // (b) Buys: share, and the next 3 months against the NASDAQ, lottery vs other.
    const lot = [], oth = [], units = [];
    let bn = 0, bl = 0;
    if (hasTrades) R.decisions.forEach(function (d) {
      if (d.excluded || d.side !== "buy" || !d.ticker) return;
      const x = at(d.ticker, d.date);
      if (!x) return;
      bn++; if (x.lottery) bl++;
      const f = d.fwd && d.fwd[63];
      if (f) (x.lottery ? lot : oth).push(f.ex);
      const f21 = d.fwd && d.fwd[21];
      units.push({ id: d.inst + "|" + d.date, t: d.cut, tEnd: f21 ? f21.end : d.cut + 35 * DAY, y: f21 ? f21.ex : null, f: { lottery: !!x.lottery, relSize: d.relSize } });
    });
    const diff = lot.length >= 3 && oth.length >= 3 ? S.bootstrap(lot, oth, 2000, 97) : null;
    // (c) Calls: Positive targets above +100% with a horizon of 3 months or less.
    let tn = 0, tk = 0;
    freshCalls(events).forEach(function (e) {
      if (e.sentiment !== "positive" || !(e.targetPrice > 0) || !e.horizonDays) return;
      const p = priceAtCall(e, prices[tickerSym[e.ticker]]);
      if (!(p > 0)) return;
      tn++;
      if (e.targetPrice / p - 1 > 1 && e.horizonDays <= 91) tk++;
    });
    // (d) Sessions (descriptive).
    const ss = sessions(intraday);
    const span = ss.length ? Math.max(1, (ss[ss.length - 1].from - ss[0].from) / (7 * DAY)) : null;
    return { n: bn, views: wilson(vl, vd), buys: wilson(bl, bn), returns: { lottery: { n: lot.length, mean: mean(lot) }, other: { n: oth.length, mean: mean(oth) }, diff: diff },
      calls: wilson(tk, tn), sessions: ss.length ? { perWeek: ss.length / span, minutes: median(ss.map(function (x) { return x.minutes; })), tickers: median(ss.map(function (x) { return x.tickers; })) } : null,
      thresholds: LOTTERY, buyUnits: units, status: status(bn, NEED.lottery), need: NEED.lottery,
      tilt: vd > 0 && bn >= NEED.lottery.min && bl / bn > Math.max(0.2, 2 * vl / vd),
      clear: !!(diff && diff.hi != null && diff.hi < 0) };
  }

  // ---------- C4: anchoring (Tversky & Kahneman 1974, George & Hwang 2004) ----------

  function anchoring(R, events, vi, prices, tickerSym, book, watchBook, hasTrades) {
    // (a) Targets: round numbers against what whole-number targets give by chance,
    // near the 52-week high, near your entry, exactly +10% / +20%.
    const tg = [];
    (events || []).filter(function (e) { return (e.sentiment === "positive" || e.sentiment === "negative") && e.targetPrice > 0; }).forEach(function (e) {
      const s = prices[tickerSym[e.ticker]], p = priceAtCall(e, s);
      if (!(p > 0)) return;
      const step = p >= 100 ? 10 : p >= 10 ? 5 : 1, chance = p >= 10 ? 1 / step : 0.01;
      const q = e.targetPrice / step, h = high52(s, isoDay(e.ts));
      let entry = null;
      Object.keys(watchBook).forEach(function (k) { const b = watchBook[k]; if (b.ticker === e.ticker) { const st = heldOn(b, isoDay(e.ts + DAY)); if (st.held && st.cost > 0) entry = st.cost; } });
      const m = e.targetPrice / p - 1;
      tg.push({ round: Math.abs(q - Math.round(q)) < 1e-9 ? 1 : 0, chance: chance, nearHigh: h ? Math.abs(e.targetPrice / h.hi - 1) <= 0.01 : null,
        nearEntry: entry ? Math.abs(e.targetPrice / entry - 1) <= 0.01 : null, peak: Math.abs(Math.abs(m) - 0.1) <= 0.005 || Math.abs(Math.abs(m) - 0.2) <= 0.005 });
    });
    const roundEx = tg.length >= 2 ? S.bootstrap(tg.map(function (x) { return x.round - x.chance; }), null, 2000, 101) : { est: null, lo: null, hi: null };
    const sh = function (k) { const u = tg.filter(function (x) { return x[k] != null; }); return wilson(u.filter(function (x) { return x[k]; }).length, u.length); };
    const targets = { n: tg.length, round: sh("round"), chance: mean(tg.map(function (x) { return x.chance; })), roundEx: roundEx,
      nearHigh: sh("nearHigh"), nearEntry: sh("nearEntry"), peak: sh("peak"), status: status(tg.length, NEED.targets), need: NEED.targets,
      clear: roundEx.lo != null && roundEx.lo > 0 };
    // (b) Break-even sales: full sales within 2% of cost, against the share of the
    // position's holding days on which the close sat in that band.
    const be = [];
    if (hasTrades) R.decisions.forEach(function (d) {
      if (d.side !== "sell" || d.cls !== "close" || !eligible(d)) return;
      const b = book[d.inst];
      if (!b || !b.s) return;
      const st = stateBefore(b, d.date), px = closeAt(b.s, d.date);
      if (!st || !st.cost || !px) return;
      let open = null;
      for (let i = b.steps.length - 1; i >= 0; i--) { if (b.steps[i].date >= d.date) continue; if (i === 0 || b.steps[i - 1].pos === 0) { open = b.steps[i].date; break; } }
      const i0 = open ? barAt(b.s, open) : -1, i1 = barAt(b.s, addDays(d.date, -1));
      if (i0 < 0 || i1 - i0 < 5) return;
      let k = 0;
      for (let i = i0 + 1; i <= i1; i++) if (Math.abs(b.s[i].close / st.cost - 1) <= 0.02) k++;
      be.push({ hit: Math.abs(px / st.cost - 1) <= 0.02 ? 1 : 0, p: k / (i1 - i0) });
    });
    const beEx = be.length >= 2 ? S.bootstrap(be.map(function (x) { return x.hit - x.p; }), null, 2000, 103) : { est: null, lo: null, hi: null };
    const breakEven = { n: be.length, share: wilson(be.filter(function (x) { return x.hit; }).length, be.length), chance: mean(be.map(function (x) { return x.p; })), ex: beEx,
      status: status(be.length, NEED.breakEven), need: NEED.breakEven, clear: beEx.lo != null && beEx.lo > 0 };
    // (c) Buys within 5% of the 52-week high, against your view-days on which the stock was there.
    let vn = 0, vk = 0;
    Object.keys(vi).forEach(function (t) {
      const s = prices[tickerSym[t]];
      if (!s) return;
      Object.keys(vi[t].day).forEach(function (d) { const h = high52(s, d); if (!h) return; vn++; if (h.close / h.hi >= 0.95) vk++; });
    });
    const base = vn ? vk / vn : null, hits = [];
    if (hasTrades && base != null) R.decisions.forEach(function (d) {
      if (d.excluded || d.side !== "buy" || !d.ticker) return;
      const h = high52(prices[tickerSym[d.ticker]], d.date);
      if (h) hits.push(h.close / h.hi >= 0.95 ? 1 : 0);
    });
    const hiEx = hits.length >= 2 ? S.bootstrap(hits.map(function (x) { return x - base; }), null, 2000, 107) : { est: null, lo: null, hi: null };
    const nearHigh = { n: hits.length, share: wilson(hits.filter(Boolean).length, hits.length), base: base, ex: hiEx,
      status: status(hits.length, NEED.nearHigh), need: NEED.nearHigh, clear: hiEx.lo != null && (hiEx.lo > 0 || hiEx.hi < 0) };
    // (d) Target drift: revisions of a target while the position is under water vs in profit.
    const drift = { loss: { n: 0, down: 0 }, gain: { n: 0, down: 0 } };
    const byT = {};
    (events || []).filter(function (e) { return e.targetPrice > 0; }).sort(function (a, b) { return a.ts - b.ts; }).forEach(function (e) { (byT[e.ticker] = byT[e.ticker] || []).push(e); });
    Object.keys(byT).forEach(function (t) {
      const es = byT[t], s = prices[tickerSym[t]];
      for (let i = 1; i < es.length; i++) {
        if (es[i].targetPrice === es[i - 1].targetPrice) continue;
        const d = isoDay(es[i].ts), c = closeAt(s, d);
        let cost = null;
        Object.keys(watchBook).forEach(function (k) { const b = watchBook[k]; if (b.ticker === t) { const st = heldOn(b, d); if (st.held && st.cost > 0) cost = st.cost; } });
        if (!cost || c == null) continue;
        const g = c < cost ? drift.loss : drift.gain;
        g.n++; if (es[i].targetPrice < es[i - 1].targetPrice) g.down++;
      }
    });
    const dl = wilson(drift.loss.down, drift.loss.n), dg = wilson(drift.gain.down, drift.gain.n);
    const st = [targets.status, breakEven.status, nearHigh.status].reduce(function (b, x) { return ({ none: 0, indicative: 1, solid: 2 })[x] > ({ none: 0, indicative: 1, solid: 2 })[b] ? x : b; }, "none");
    return { targets: targets, breakEven: breakEven, nearHigh: nearHigh, drift: { loss: dl, gain: dg }, status: st,
      clear: targets.clear || breakEven.clear || (nearHigh.clear && hiEx.est < 0) };
  }

  // ---------- C5: calibration of targets (overconfidence, Barber & Odean 2001) ----------

  // Calls with a target and a horizon that has passed: the move the target required
  // against the best move the stock actually made in the call's direction before the deadline.
  function calibration(events, prices, tickerSym, now) {
    const rows = [], all = (events || []).slice().sort(function (a, b) { return a.ts - b.ts; });
    freshCalls(events).forEach(function (e) {
      if (!(e.targetPrice > 0) || !e.horizonDays) return;
      const s = prices[tickerSym[e.ticker]], p = priceAtCall(e, s), dl = e.ts + e.horizonDays * DAY;
      if (!s || !(p > 0) || dl > now) return;
      const pos = e.sentiment === "positive", req = e.targetPrice / p - 1;
      if (pos ? req <= 0 : req >= 0) return; // a target on the wrong side of the call
      const i0 = barAt(s, isoDay(e.ts)), i1 = barAt(s, isoDay(dl));
      if (i0 < 0 || i1 <= i0) return;
      let best = 0;
      for (let i = i0 + 1; i <= i1; i++) { const m = s[i].close / p - 1; best = pos ? Math.max(best, m) : Math.min(best, m); }
      const ratio = Math.min(10, Math.max(0.1, Math.abs(req) / Math.max(0.001, Math.abs(best))));
      const revised = all.some(function (x) { return x.ticker === e.ticker && x.ts > e.ts && x.ts < dl && x.targetPrice > 0 && x.targetPrice !== e.targetPrice; });
      rows.push({ req: Math.abs(req), best: Math.abs(best), ratio: ratio, hit: Math.abs(best) >= Math.abs(req), revised: revised });
    });
    const lr = rows.map(function (r) { return Math.log(r.ratio); });
    const ci = lr.length >= 2 ? S.bootstrap(lr, null, 2000, 109) : { est: null, lo: null, hi: null };
    return { n: rows.length, medianRatio: median(rows.map(function (r) { return r.ratio; })), medianReq: median(rows.map(function (r) { return r.req; })), medianBest: median(rows.map(function (r) { return r.best; })),
      hit: wilson(rows.filter(function (r) { return r.hit; }).length, rows.length), revised: wilson(rows.filter(function (r) { return r.revised; }).length, rows.length),
      logRatio: ci, status: status(rows.length, NEED.calibration), need: NEED.calibration, clear: ci.lo != null && ci.lo > 0 };
  }

  // ---------- E5: home bias (French & Poterba 1991, Huberman 2001) ----------

  function homebias(home, vi, tickerSym, book, cal, end, hasTrades) {
    if (!home || home === "XV" || !/^[A-Z]{2}$/.test(home)) return { noHome: true, home: home || null, status: "none", need: NEED.homebias, clear: false };
    let hv = 0, tv = 0;
    const months = {}, perTicker = {};
    Object.keys(vi).forEach(function (t) {
      const cc = countryOfSymbol(tickerSym[t] || t);
      vi[t].arr.forEach(function (e) { const m = isoDay(e.ts).slice(0, 7); (months[m] = months[m] || {})[t] = 1; });
      if (!cc) return;
      const n = vi[t].arr.length;
      tv += n; if (cc === home) hv += n;
      perTicker[t] = n;
    });
    const acwiHome = ACWI[home] || 0, foreignAcwi = 1 - acwiHome;
    const hb = function (homeShare) { return homeShare == null ? null : 1 - (1 - homeShare) / foreignAcwi; };
    const viewsHome = tv ? hv / tv : null;
    let depot = null;
    if (hasTrades) {
      const last = cal.filter(function (d) { return Date.parse(d) <= end; }).pop();
      let h = 0, t = 0;
      if (last) Object.keys(book).forEach(function (k) { const v = valueAt(book[k], last), cc = countryOfInst(book[k]); if (!(v > 0) || !cc) return; t += v; if (cc === home) h += v; });
      if (t > 0) depot = { share: h / t, bias: hb(h / t), date: last };
    }
    const counts = Object.keys(perTicker).map(function (t) { return perTicker[t]; }).sort(function (a, b) { return b - a; });
    const top5 = tv ? counts.slice(0, 5).reduce(function (s, x) { return s + x; }, 0) / tv : null;
    const nMonths = Object.keys(months).length;
    return { home: home, homeName: COUNTRY_NAMES[home] || home, acwi: acwiHome, asOf: ACWI_ASOF, views: { share: viewsHome, bias: hb(viewsHome), n: tv }, depot: depot,
      perMonth: median(Object.keys(months).map(function (m) { return Object.keys(months[m]).length; })), top5: top5,
      status: status(nMonths, NEED.homebias), need: NEED.homebias, n: nMonths,
      clear: false, tilted: (depot ? depot.bias : hb(viewsHome)) > 0.5 && acwiHome < 0.5 };
  }

  // ---------- B5: attention from trading volume (Barber & Odean 2008) ----------

  // Abnormal volume on a day: the bar before it traded more than twice the median of the 60 bars before that.
  function abnormalVolume(s, date) {
    if (!s) return null;
    const i = barAt(s, addDays(date, -1));
    if (i < 61 || s[i].volume == null) return null;
    const vs = [];
    for (let k = i - 60; k < i; k++) if (s[k].volume > 0) vs.push(s[k].volume);
    if (vs.length < 40) return null;
    return s[i].volume > 2 * median(vs);
  }
  function volumeAttention(R, vi, prices, tickerSym, hasTrades) {
    const units = [];
    if (hasTrades) R.decisions.forEach(function (d) {
      if (d.excluded || d.side !== "buy" || !d.ticker) return;
      const s = prices[tickerSym[d.ticker]], hit = abnormalVolume(s, d.date);
      if (hit == null) return;
      // chance: the share of the 90 days before the buy with abnormal volume on this stock
      let k = 0, n = 0;
      for (let j = 1; j <= 90; j += 1) { const x = abnormalVolume(s, addDays(d.date, -j)); if (x != null) { n++; if (x) k++; } }
      if (n >= 20) units.push({ hit: hit ? 1 : 0, p: k / n });
    });
    const ex = units.length >= 2 ? S.bootstrap(units.map(function (u) { return u.hit - u.p; }), null, 2000, 113) : { est: null, lo: null, hi: null };
    // First looks on an abnormal-volume day vs a normal day: bought within 48 hours?
    const conv = { loud: { n: 0, k: 0 }, quiet: { n: 0, k: 0 } };
    if (hasTrades) Object.keys(vi).forEach(function (t) {
      const first = vi[t].ts[0], x = abnormalVolume(prices[tickerSym[t]], isoDay(first));
      if (x == null) return;
      const g = x ? conv.loud : conv.quiet;
      g.n++;
      if (R.decisions.some(function (d) { return d.ticker === t && d.side === "buy" && !d.auto && d.cut >= first && d.cut <= first + 2 * DAY; })) g.k++;
    });
    return { n: units.length, share: wilson(units.filter(function (u) { return u.hit; }).length, units.length), chance: mean(units.map(function (u) { return u.p; })), ex: ex,
      loud: wilson(conv.loud.k, conv.loud.n), quiet: wilson(conv.quiet.k, conv.quiet.n),
      status: status(units.length, NEED.volume), need: NEED.volume, clear: ex.lo != null && ex.lo > 0 };
  }

  // ---------- B6: buying what the crowd is looking at (Barber & Odean 2008, adapted) ----------

  // The New York trading day of a moment, bucketed as network_community_daily() does:
  // the ET calendar date, or the next date at or after 16:00 ET (that day's close is
  // the first one after it). As a day number (days since 1970-01-01).
  const ET_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  function nyDayNum(ts) {
    const o = {};
    ET_FMT.formatToParts(new Date(ts)).forEach(function (p) { o[p.type] = p.value; });
    const d = Date.UTC(+o.year, +o.month - 1, +o.day) / DAY;
    return +o.hour >= 16 ? d + 1 : d;
  }
  // Other users' views per ticker per NY day: the community's counts (which include
  // the user's own views) minus the user's own views counted as the RPC counts them,
  // floored at 0. The RPC sums the daily events' `views` on the NY day of the event's
  // ts, which is the LAST view of a chain merged within the dedupe window, so the
  // user's daily events are subtracted, not the intraday rows (a chain over 16:00 ET
  // puts all its views on the next day; intraday also drops repeats under 30 s).
  function crowdIndex(community, events) {
    const own = {}, by = {};
    let from = null;
    (events || []).forEach(function (e) { if (e && e.ticker && e.ts) { const m = own[e.ticker] = own[e.ticker] || {}, d = nyDayNum(e.ts); m[d] = (m[d] || 0) + (e.views == null ? 1 : +e.views); } });
    (community || []).forEach(function (r) {
      const m = by[r.ticker] = by[r.ticker] || {};
      (r.days || []).forEach(function (x) { const d = Date.parse(x[0] + "T00:00:00Z") / DAY; m[d] = (m[d] || 0) + (+x[1] || 0); if (from == null || d < from) from = d; });
    });
    Object.keys(by).forEach(function (t) { const m = by[t], o = own[t] || {}; Object.keys(m).forEach(function (d) { m[d] = Math.max(0, m[d] - (o[d] || 0)); }); });
    return { by: by, from: from };
  }
  // The crowd before day d: others' views on d-3..d-1 against the stock's own rate on
  // d-33..d-4 scaled to 3 days (the same "crowd move" as herding, without the lists).
  function crowdOn(m, d) {
    let w = 0, b = 0;
    for (let k = 1; k <= 3; k++) w += m[d - k] || 0;
    for (let k = 4; k <= 33; k++) b += m[d - k] || 0;
    const base3 = b / 30 * 3;
    return { others3: w, base3: base3, ratio: (w + 1) / (base3 + 1), hot: w >= 3 && w >= 2 * Math.max(base3, 0.5) };
  }
  // The crowd on a stock before the NY day of ts; null without community data for it.
  function crowdAt(ci, ticker, ts) {
    const m = ci && ci.by[ticker];
    return m ? crowdOn(m, nyDayNum(ts)) : null;
  }

  // Buys made when the crowd was hot, against each stock's own share of hot days in the
  // 180 days before the buy (point in time), and how those buys did next.
  function crowdBuys(R, ci, links, prices, bench) {
    if (ci.from == null) return { n: 0, status: "none", need: NEED.crowdBuys, clear: false, noData: true, buyUnits: [] };
    const H = [5, 21, 63, 126], rows = [], units = [];
    R.decisions.forEach(function (d) {
      if (d.excluded || d.side !== "buy" || !d.ticker || !ci.by[d.ticker]) return;
      const m = ci.by[d.ticker], day = nyDayNum(d.ts);
      if (day < ci.from + 33) return; // no 30-day base before the community data starts
      const c = crowdOn(m, day), l = links[d.inst], s = l && l.symbol ? prices[l.symbol] : null, cal = s || bench;
      let k = 0, n = 0;
      for (let i = barAt(cal, isoDay((day - 1) * DAY)); i >= 0; i--) {
        const di = Date.parse(cal[i].date + "T00:00:00Z") / DAY;
        if (di < day - 180 || di < ci.from + 33) break;
        n++;
        if (crowdOn(m, di).hot) k++;
      }
      const row = { id: d.inst + "|" + d.date, t: d.cut, ticker: d.ticker, hot: c.hot, ratio: c.ratio, others3: c.others3, base3: c.base3, p: n >= 20 ? k / n : null };
      let end21 = d.cut + 35 * DAY;
      H.forEach(function (h) { const f = D.forward(s, bench, d.date, h); row[h] = f ? f.ex : null; if (h === 21 && f) end21 = f.end; });
      rows.push(row);
      units.push({ id: row.id, ticker: d.ticker, t: d.cut, tEnd: end21, y: row[21], f: { crowd: c.ratio, crowdHot: c.hot, relSize: d.relSize } });
    });
    const byT = {};
    rows.filter(function (r) { return r.p != null; }).forEach(function (r) { (byT[r.ticker] = byT[r.ticker] || []).push({ hit: r.hot ? 1 : 0, p: r.p }); });
    const clusters = Object.keys(byT).map(function (t) { return byT[t]; }), all = [].concat.apply([], clusters);
    const ex = clusterBoot(clusters, function (us) { return us.length ? mean(us.map(function (u) { return u.hit - u.p; })) : null; }, 1000, 139);
    const horizons = {}, clearOn = [];
    if (clearOf(ex)) clearOn.push("excess");
    H.forEach(function (h) {
      const a = rows.filter(function (r) { return r.hot && r[h] != null; }).map(function (r) { return r[h]; });
      const b = rows.filter(function (r) { return !r.hot && r[h] != null; }).map(function (r) { return r[h]; });
      const diff = a.length >= 3 && b.length >= 3 ? S.bootstrap(a, b, 2000, 149 + h, 0.99) : null;
      horizons[h] = { hot: { n: a.length, mean: mean(a) }, other: { n: b.length, mean: mean(b) }, diff: diff };
      if (clearOf(diff)) clearOn.push(String(h));
    });
    return { n: rows.length, share: wilson(all.filter(function (u) { return u.hit; }).length, all.length), chance: mean(all.map(function (u) { return u.p; })), excess: ex,
      hot: rows.filter(function (r) { return r.hot; }).length, horizons: horizons, buys: rows, buyUnits: units,
      status: status(rows.length, NEED.crowdBuys), need: NEED.crowdBuys, clearOn: clearOn, clear: clearOn.length > 0 };
  }

  // ---------- A8: limited attention (DellaVigna & Pollet 2009, Hirshleifer et al. 2009) ----------

  // Pages that read a quarterly report.
  const REPORT_PAGES = { earnings: 1, financials: 1, news: 1, estimates: 1 };
  // earnings: { ticker: [[day, timing], ...] } from earnings_for(). A release counts for
  // a stock you viewed in the 90 days before it, or held. The clock starts at the US open
  // of the release day (the next day for a release after the close) and runs for 14 days;
  // a window still running is censored, not missed.
  function limitedAttention(vi, earnings, tickerSym, watchBook, intraday, now) {
    const releases = [], perDay = {};
    let notMeasured = 0;
    Object.keys(vi).forEach(function (t) { if (countryOfSymbol(tickerSym[t] || t) !== "US") notMeasured++; });
    if (!earnings) return { noData: true, n: 0, notMeasured: notMeasured, status: "none", need: NEED.attention, clear: false };
    Object.keys(earnings).forEach(function (t) {
      (earnings[t] || []).forEach(function (r) {
        const day = r[0], timing = r[1] || "unknown";
        const start = Date.parse((timing === "amc" ? addDays(day, 1) : day) + "T13:30:00Z");
        if (start > now) return;
        const viewed = viewsBetween(vi, t, start - 90 * DAY, start) > 0;
        let held = false;
        Object.keys(watchBook || {}).forEach(function (k) { if (watchBook[k].ticker === t && heldOn(watchBook[k], day).held) held = true; });
        if (!viewed && !held) return;
        releases.push({ t: t, day: day, start: start });
        perDay[day] = (perDay[day] || 0) + 1;
      });
    });
    const units = releases.map(function (r) {
      const x = vi[r.t], end = r.start + 14 * DAY;
      let first = null;
      if (x) for (let i = lowerBound(x.ts, r.start); i < x.arr.length && x.ts[i] < end; i++) if (REPORT_PAGES[x.arr[i].researchType]) { first = x.ts[i]; break; }
      if (first != null && first > now) first = null;
      const complete = end <= now, dow = new Date(r.day + "T12:00:00Z").getUTCDay();
      return { lat: first != null ? (first - r.start) / 3600000 : (Math.min(now, end) - r.start) / 3600000, done: first != null, complete: complete,
        missed: complete && first == null, friday: dow === 5, busy: perDay[r.day] >= 3 };
    });
    const km = function (us) { return kmMedian(us.map(function (u) { return { t: u.lat, done: u.done }; })); };
    const comp = units.filter(function (u) { return u.complete; });
    const miss = function (us) { return wilson(us.filter(function (u) { return u.missed; }).length, us.length); };
    const split = function (key) {
      const a = comp.filter(function (u) { return u[key]; }), b = comp.filter(function (u) { return !u[key]; });
      const d = a.length >= 3 && b.length >= 3 ? S.bootstrap(a.map(function (u) { return u.missed ? 1 : 0; }), b.map(function (u) { return u.missed ? 1 : 0; }), 2000, key === "friday" ? 127 : 131) : null;
      return { yes: { n: a.length, missed: miss(a), median: km(units.filter(function (u) { return u[key]; })) }, no: { n: b.length, missed: miss(b), median: km(units.filter(function (u) { return !u[key]; })) }, diff: d };
    };
    // Breadth on report days: stocks per research session on days with a release you follow vs other days.
    const relDays = {};
    releases.forEach(function (r) { relDays[isoDay(r.start)] = 1; });
    const ss = sessions(intraday), on = [], off = [];
    ss.forEach(function (x) { (relDays[isoDay(x.from)] ? on : off).push(x.tickers); });
    const fri = split("friday"), busy = split("busy");
    const clearOfSplit = function (s) { return !!(s.diff && s.diff.lo != null && s.diff.lo > 0); };
    return { n: comp.length, releases: units.length, median: km(units), missed: miss(comp), friday: fri, busy: busy, notMeasured: notMeasured,
      breadth: { release: { n: on.length, mean: mean(on) }, other: { n: off.length, mean: mean(off) } },
      status: status(comp.length, NEED.attention), need: NEED.attention, clear: clearOfSplit(fri) || clearOfSplit(busy) };
  }

  // ---------- A7c: community herding on first looks (Lakonishok, Shleifer & Vishny 1992, adapted) ----------

  // rows: community_first_looks_daily() = [{ day, active, looks: { ticker: k } }].
  // For a stock on a day with at least one first look (as LSV only scores stock-periods
  // with trading): the share of active users who looked at it for the first time,
  // against its own average share over the window, minus what binomial chance gives
  // for that gap given at least one look. Averaged over those stock-days: 0 = first
  // looks arrive as chance would scatter them; above 0 = users discover stocks together.
  function communityHerding(rows) {
    const days = (rows || []).filter(function (r) { return r && r.active > 0; });
    if (days.length < 5) return { n: days.length, status: "none", need: NEED.community, clear: false, noData: !days.length };
    const tot = {}, users = days.reduce(function (s, r) { return s + r.active; }, 0);
    days.forEach(function (r) { Object.keys(r.looks || {}).forEach(function (t) { tot[t] = (tot[t] || 0) + (+r.looks[t] || 0); }); });
    const tickers = Object.keys(tot), memo = {};
    // E[|K/n - p| | K >= 1] for K ~ Binomial(n, p), by summing the probabilities.
    const expAbs = function (n, p) {
      const key = n + "|" + p;
      if (key in memo) return memo[key];
      const p0 = Math.pow(1 - p, n);
      let pk = p0, e = 0;
      for (let k = 0; k <= n; k++) {
        if (k) e += pk * Math.abs(k / n - p);
        pk = k < n ? pk * (n - k) / (k + 1) * (p / (1 - p)) : 0;
      }
      return (memo[key] = p0 < 1 ? e / (1 - p0) : 0);
    };
    const clusters = days.map(function (r) {
      return tickers.map(function (t) {
        const p = tot[t] / users, k = +(r.looks || {})[t] || 0;
        return k > 0 && p > 0 && p < 1 ? Math.abs(k / r.active - p) - expAbs(r.active, p) : null;
      }).filter(function (h) { return h != null; });
    });
    const est = clusterBoot(clusters, function (us) { return us.length ? mean(us) : null; }, 1000, 137);
    return { n: days.length, tickers: tickers.length, h: est, series: days.map(function (r, i) { return { day: r.day, h: clusters[i].length ? mean(clusters[i]) : null }; }),
      status: status(days.length, NEED.community), need: NEED.community, clear: clearOf(est) && est.est > 0 };
  }

  // ---------- B7: timing against a savings plan ----------

  // Does choosing your moments beat handing the same money to a plan? Two readings.
  // Both measure a buy against its index twin: the same money put into the NASDAQ on
  // the same day and taken out in the same shares on the same days as the position was
  // cut. A sale takes the same share from every lot of the position (average cost, as
  // the book does), so it reaches timed and plan lots alike and is never a reason to
  // prefer one sleeve; what a lot earned includes the sales that followed it. The result
  // is the money earned beyond the twin per euro-year of money held (cost x the share
  // still held x years), so a plan that started earlier, or a lot sold early, is not
  // favoured or penalised for its length.
  //   sleeves     - timed buys (your decisions) against plan buys (savings plans)
  //   same stocks - for each stock with timed buys: the same money as a monthly plan over
  //                 the same stretch, with the same sales. Only the dates differ, so the
  //                 choice of stock cannot explain the gap.
  // Price return on both sides: dividends are left out (the twin is a price index).
  const TIMING = { buys: 3, days: 60 };
  const YEAR = 365.25 * DAY;

  function timingAgg(ls) {
    let c = 0, v = 0, vi = 0, cy = 0;
    ls.forEach(function (l) { c += l.c; v += l.v; vi += l.vi; cy += l.cy; });
    return { n: ls.length, c: c, v: v, vi: vi, cy: cy, gain: c > 0 ? v / c - 1 : null, twin: c > 0 ? vi / c - 1 : null, years: c > 0 ? cy / c : null, ex: cy > 0 ? (v - vi) / cy : null };
  }
  const timingEx = function (ls) { return timingAgg(ls).ex; };

  function timing(R, book, bench, end) {
    const endDay = isoDay(end), iEnd = closeAt(bench, endDay), ccyN = {};
    R.decisions.forEach(function (d) { if (d.side === "buy" && eligible(d)) ccyN[d.currency || "?"] = (ccyN[d.currency || "?"] || 0) + 1; });
    const ccy = Object.keys(ccyN).sort(function (a, b) { return ccyN[b] - ccyN[a]; })[0] || null;
    const by = {};
    R.decisions.forEach(function (d) { if ((d.side === "buy" || d.side === "sell") && eligible(d) && (d.currency || "?") === ccy && d.qty > 0) (by[d.inst] = by[d.inst] || []).push(d); });
    const lots = [], rows = [];
    let skipped = 0;
    Object.keys(by).forEach(function (k) {
      const b = book[k], ds = by[k].sort(function (x, y) { return x.ts - y.ts; });
      const buys = ds.filter(function (d) { return d.side === "buy" && d.amount > 0; });
      // the exchange rate the buys were made at, to put a Yahoo close into the settlement currency
      let paid = 0, worth = 0;
      buys.forEach(function (d) { const c = b && b.s ? closeAt(b.s, d.date) : null; if (c > 0) { paid += d.amount; worth += d.qty * c; } });
      const fx = worth > 0 ? paid / worth : null, pEnd = fx ? closeAt(b.s, endDay) * fx : null;
      if (!(pEnd > 0) || !(iEnd > 0)) { skipped += buys.length; return; }
      const sells = ds.filter(function (d) { return d.side === "sell" && d.posBefore > 0; }).map(function (d) {
        const c = closeAt(b.s, d.date);
        return { ts: d.ts, f: Math.min(1, d.qty / d.posBefore), px: d.amount > 0 ? d.amount / d.qty : c * fx, i: closeAt(bench, d.date) };
      });
      // One buy of `cost` at `pb` per unit on `date`, followed by every later sale of the position.
      const lotOf = function (ts, date, cost, pb) {
        const ib = closeAt(bench, date);
        if (!(ib > 0) || !(pb > 0)) return null;
        let S = 1, V = 0, VI = 0, yrs = 0, t = ts;
        for (let i = 0; i < sells.length; i++) {
          const s = sells[i];
          if (s.ts <= ts) continue;
          if (!(s.px > 0) || !(s.i > 0)) return null;
          V += S * s.f * s.px; VI += S * s.f * s.i; yrs += S * (s.ts - t) / YEAR; t = s.ts; S *= 1 - s.f;
        }
        V += S * pEnd; VI += S * iEnd; yrs += S * Math.max(0, end - t) / YEAR;
        return { inst: k, c: cost, v: cost * V / pb, vi: cost * VI / ib, cy: cost * yrs };
      };
      const mine = [];
      buys.forEach(function (d) {
        const l = lotOf(d.ts, d.date, d.amount, d.amount / d.qty);
        if (!l) { skipped++; return; }
        l.plan = !!d.auto; l.date = d.date; l.ts = d.ts;
        lots.push(l); mine.push(l);
      });
      // Same stock, same money, as a monthly plan between the first and the last timed buy.
      const timed = mine.filter(function (l) { return !l.plan; });
      if (timed.length < TIMING.buys) return;
      const first = timed[0].ts, last = timed[timed.length - 1].ts, span = (last - first) / DAY;
      if (span < TIMING.days) return;
      const cost = timed.reduce(function (s, l) { return s + l.c; }, 0), n = Math.max(2, Math.floor(span / 30.4375) + 1), cf = [];
      for (let j = 0; j < n; j++) {
        const ts = first + (last - first) * j / (n - 1), date = isoDay(ts), c = closeAt(b.s, date), l = c > 0 ? lotOf(ts, date, cost / n, c * fx) : null;
        if (!l) return;
        cf.push(l);
      }
      const tAgg = timingAgg(timed), pAgg = timingAgg(cf), l0 = timed[0];
      const dec = ds.filter(function (d) { return d.ticker; })[0];
      rows.push({ inst: k, ticker: dec ? dec.ticker : (b.ticker || null), name: ds[0].name || ds[0].symbol || k, n: timed.length, cost: cost, from: l0.date, to: timed[timed.length - 1].date,
        timed: tAgg, plan: pAgg, effect: tAgg.ex != null && pAgg.ex != null ? tAgg.ex - pAgg.ex : null });
    });

    const timedL = lots.filter(function (l) { return !l.plan; }), planL = lots.filter(function (l) { return l.plan; });
    const byQuarter = {};
    // the parts' ranges resample calendar quarters of buying (a plan is often one fund, so stocks cannot be the unit)
    lots.forEach(function (l) { const q = l.date.slice(0, 4) + "Q" + (Math.floor((+l.date.slice(5, 7) - 1) / 3) + 1); (byQuarter[q] = byQuarter[q] || []).push(l); });
    const clusters = Object.keys(byQuarter).map(function (k) { return byQuarter[k]; });
    const isPlan = function (l) { return l.plan; }, notPlan = function (l) { return !l.plan; };
    const sleeves = { timed: timingAgg(timedL), plan: timingAgg(planL) };
    sleeves.timed.ci = clusterBoot(clusters, function (us) { return timingEx(us.filter(notPlan)); }, 1000, 71);
    sleeves.plan.ci = clusterBoot(clusters, function (us) { return timingEx(us.filter(isPlan)); }, 1000, 72);
    sleeves.diff = timedL.length && planL.length ? clusterBoot(clusters, function (us) {
      const a = timingEx(us.filter(notPlan)), p = timingEx(us.filter(isPlan));
      return a != null && p != null ? a - p : null;
    }, 1000, 73) : null;
    sleeves.status = status(Math.min(timedL.length, planL.length), NEED.timing);
    sleeves.clear = sleeves.status !== "none" && !!clearOf(sleeves.diff);

    const rowsEx = function (us, key) {
      let a = 0, c = 0;
      us.forEach(function (r) { a += r[key].v - r[key].vi; c += r[key].cy; });
      return c > 0 ? a / c : null;
    };
    const buysSame = rows.reduce(function (s, r) { return s + r.n; }, 0);
    const effect = clusterBoot(rows.map(function (r) { return [r]; }), function (us) {
      const a = rowsEx(us, "timed"), p = rowsEx(us, "plan");
      return a != null && p != null ? a - p : null;
    }, 1000, 74);
    const same = { stocks: rows.length, n: buysSame, rows: rows.sort(function (a, b) { return b.cost - a.cost; }), timed: rowsEx(rows, "timed"), plan: rowsEx(rows, "plan"), effect: effect,
      status: rows.length >= 3 ? status(buysSame, NEED.timing) : "none" };
    same.clear = same.status !== "none" && !!clearOf(effect);

    const best = same.status === "none" ? sleeves.status : sleeves.status === "none" ? same.status : (same.status === "solid" || sleeves.status === "solid" ? "solid" : "indicative");
    // the verdict rests on the same-stocks test where it has data, since the sleeves also differ in what they hold
    const basis = same.status !== "none" ? "same" : sleeves.status !== "none" ? "sleeves" : null, ci = basis === "same" ? same.effect : basis === "sleeves" ? sleeves.diff : null;
    const verdict = !basis ? "too_few" : clearOf(ci) ? (ci.est > 0 ? "timing_pays" : "plan_better") : "unclear";
    return { n: timedL.length, nPlan: planL.length, currency: ccy, end: endDay, skipped: skipped, sleeves: sleeves, same: same, verdict: verdict, basis: basis,
      status: best, need: NEED.timing, clear: verdict === "timing_pays" || verdict === "plan_better" };
  }

  // ---------- entry ----------

  // input: the ATDecisions.analyze input plus optional community (network_community_daily
  // rows), trending ({day: {ticker: 1}}) and crowd (world_crowd_overlap rows).
  // R: the report analyze() returned for the same input.
  function analyze(input, R) {
    const now = input.now || Date.now();
    const txs = input.txs || [], links = input.links || {}, prices = input.prices || {}, bench = input.bench || [], tickerSym = input.tickerSymbol || {};
    const vi = viewIndex(input.intraday);
    const cal = bench.map(function (b) { return b.date; });
    const cv = R.coverage || {};
    const end = Math.min(now, cv.fileEnd != null ? cv.fileEnd : now);
    const firstAtt = cv.firstAttention != null ? cv.firstAttention : (Object.keys(vi).reduce(function (m, t) { return Math.min(m, vi[t].ts[0]); }, Infinity));
    const book = buildBook(txs, links, prices);
    const hasTrades = txs.length > 0;
    // Positions for the ostrich effect: the broker's book when there is one, else the labels.
    const watchBook = hasTrades ? book : labelBook(input.events, prices, tickerSym);
    const out = {
      hasTrades: hasTrades,
      ostrich: isFinite(firstAtt) ? ostrich(watchBook, vi, cal, firstAtt, hasTrades ? end : now) : { n: 0, status: "none", need: NEED.ostrich, clear: false },
      confirmation: confirmation(input.events, vi, prices, tickerSym, now),
      entropy: entropy(input.events, vi),
      herding: herding(vi, input.community, input.trending, now),
      crowd: crowdTrend(input.crowd)
    };
    if (hasTrades) {
      out.rank = rankEffect(R, book, vi, cal.filter(function (d) { return Date.parse(d) >= firstAtt && Date.parse(d) <= end; }));
      out.repurchase = repurchase(R, book, vi, end);
      out.myopia = myopia(R, book, vi, end, bench);
      out.overconfidence = overconfidence(R, book, txs, links, prices, bench, cal, end);
      out.diversification = diversification(R, book, cal, end, input.profiles, vi, tickerSym);
      out.survival = survival(R, book, end);
    }
    // phase 2
    out.extrapolation = extrapolation(R, input.events, vi, prices, tickerSym, hasTrades);
    out.lottery = lottery(R, input.events, input.intraday, vi, prices, tickerSym, bench, input.fxUsd, hasTrades);
    out.anchoring = anchoring(R, input.events, vi, prices, tickerSym, book, watchBook, hasTrades);
    out.calibration = calibration(input.events, prices, tickerSym, now);
    out.homebias = homebias(input.homeCountry, vi, tickerSym, book, cal, end, hasTrades);
    if (hasTrades) out.volume = volumeAttention(R, vi, prices, tickerSym, hasTrades);
    if (hasTrades) out.crowdBuys = crowdBuys(R, crowdIndex(input.community, input.events), links, prices, bench);
    if (hasTrades) out.timing = timing(R, book, bench, end);
    // phase 3
    out.attention = limitedAttention(vi, input.earnings, tickerSym, watchBook, input.intraday, now);
    out.communityHerding = communityHerding(input.firstLooks);
    return out;
  }

  const api = { analyze: analyze, NEED: NEED, buildBook: buildBook, labelBook: labelBook, kmMedian: kmMedian, shockDays: shockDays, clusterBoot: clusterBoot,
    // phase 2, also used by the pre-trade check
    LOTTERY: LOTTERY, lotteryAt: lotteryAt, pastRet: pastRet, high52: high52, abnormalVolume: abnormalVolume, countryOfSymbol: countryOfSymbol,
    ACWI: ACWI, ACWI_ASOF: ACWI_ASOF, COUNTRY_NAMES: COUNTRY_NAMES, communityHerding: communityHerding,
    // crowd attention, also used by the pre-trade check
    crowdIndex: crowdIndex, crowdAt: crowdAt, nyDayNum: nyDayNum };
  if (typeof self !== "undefined") self.ATIndicators = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
