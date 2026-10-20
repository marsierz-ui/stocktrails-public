(function () {
  // The two agents and their paper portfolios. Pure functions over the report of
  // ATDecisions.analyze (with R.ind from ATIndicators.analyze attached) and its
  // input, so the whole thing runs (and is tested) in Node. No order is ever
  // placed: both agents act only on the user's own buys and on the stocks the
  // user looked at, and are scored against what the user did and the NASDAQ.
  //
  // THE RULES AGENT applies the coach's buy rules as they stood at the time. At
  // every month start it refits each buy rule on the units whose outcome was
  // known by then (market percentiles point-in-time) and keeps the rules whose
  // walk-forward verdict was "supported" or "indicative". A candidate is judged
  // with the snapshot of the latest month start on or before it, on features
  // computed from data before that day only. The buy rules the user adopted in
  // the coach are added to every month with the adopted setting (withAdopted).
  //
  // API
  //   ATShadow.run({ R, input, coach?, community?, aiDecisions?, commitments? (the coach's adopted rules), now }) ->
  //     { snapshots: [{ t, month, rules: [{ ruleId, params, verdict, mean }] }],    t = month start (UTC ms)
  //       trades: { candidates: [cand], rules: [decision], ai: [decision] (decided only), coverage (share decided by the AI agent, null without),
  //                 portfolio: { dates, you, rules, ai (null without AI decisions), nasdaq, note } | null,
  //                   each a daily value as a ratio to the money put in so far (1.1 = +10%); undecided candidates follow you in `ai`
  //                 paired: { 21|63|126: { h, n, you, rules: { n, mean, diff }, ai: { n, mean, diff } | null } },
  //                   excess vs the NASDAQ per decision; diff = agent - you { est, lo, hi } (99% bootstrap)
  //                 waitDays: { ruleId: median trading days the rules agent waited when that rule fired },
  //                 beforeAfter: { appStart, enough (>= 8 buys on each side at 63 days), note,
  //                   horizons: { 21|63|126: { before|after: { n, you, agent, gap: { est, lo, hi } }, change: { est, lo, hi } } },
  //                   habits: [{ id, habit, setting, before: { n, p }, after: { n, p }, change }] },
  //                 appStart },
  //       looks: { candidates: [cand], rules: [decision], ai: [decision], coverage,
  //                horizons: { 21|63|126: { every, rules, ai, bought, nasdaq } } },
  //                  each line { n, mean, lo, hi (99%), hit (share above 0), cum: [{ date, value }] } (unit positions held H days)
  //       facts: [string] }   ratios only, no currency amounts
  //   cand: { id (opaque, stable, <= 40 chars), kind: "trade"|"look", ticker, inst, date, t, ts, dateOnly, hour,
  //           amount, currency, relSize, firstAtt, sinceSell, series, i0, excluded, bought (looks: { date, t } | null) }
  //   decision: { id, kind, ticker, t, date, month, action: "buy"|"wait"|"pass", days, size, rules: [ruleId], reason,
  //               ex: { 21|63|126: { you, agent } } }   (AI decisions also carry decidedAt, model, live when given;
  //               pending: true when the prices end while the rules agent is still waiting, counted as a pass so far)
  //   ATShadow.contextFor(cand, R, input, snapshot, { names?, alias?, nameOf?, community? }) -> the AI agent's view of
  //     one candidate: no currency amounts, ISINs, broker or account; `stock` is an alias ("Stock N") and `date` is
  //     "day N" unless names is true. snapshot: run().snapshots entry for the candidate (ATShadow.snapshotAt).
  //     Everything in it is known at the candidate's moment; its rulesAgent is ATShadow.rulesView, not the decision
  //     (whose wait length or pass depends on the prices after it). ATAI.decide sends it under a per-request id.
  //   ATShadow.snapshotAt(snapshots, t) -> the snapshot in force at t (or null)
  //   ATShadow.verdictNow(snapshot, f) -> { action: "buy"|"wait", size, rules, delaying, unchecked } for an intended buy now,
  //     f = { runup, leadH, hour, pVol, pRet, relSize, conviction, views30, sinceSell, pct12, lottery, crowd, crowdHot }
  //   ATShadow.rulesView(snapshot, f, R) -> { action: "buy"|"wait", size, rules: [{ id, now, do }] } (the rules agent at that moment)
  //   ATShadow.pitMarket(bench), ATShadow.featuresAt(cand, k, ctx), ATShadow.decide(cand, snapshot, ctx), ATShadow.context(R, input, community),
  //   ATShadow.pitUnits(rule, R, ctx), ATShadow.sinceSellAt(ctx, t, inst, ticker)
  const node = typeof module !== "undefined" && module.exports;
  const D = node ? require("./decisions.js") : self.ATDecisions;
  const B = node ? require("./biases.js") : self.ATBiases;
  const I = node ? require("./indicators.js") : (typeof self !== "undefined" ? self.ATIndicators : null);
  const S = D.stats, DAY = 86400000, MAX_WAIT = 10, HS = [21, 63, 126], LOOK_HS = [21, 42, 63, 126, 252], LOOK_GAP = 30 * DAY, LIVE_MS = 2 * DAY;
  const ELIGIBLE = { STOCK: 1, ETF: 1, FUND: 1 };
  // The buy-universe rules (wait_crowd only where this build has it).
  const BUY_RULES = ["wait_runup", "sleep_on_it", "avoid_daypart", "pause_turbulent", "cap_turbulent", "wait_strong_market", "research_gate",
    "no_quick_switch", "avoid_extrapolation", "cap_lottery", "cap_low_attention", "wait_crowd"];
  const CAPS = { cap_turbulent: 1, cap_lottery: 1, cap_low_attention: 1 }, TIMING = { avoid_daypart: 1 };
  const NEEDS = { avoid_extrapolation: "pct12", cap_lottery: "lottery", wait_crowd: "crowd" };
  // the features each buy rule reads: without one of them it cannot be checked
  const FEATURES = { wait_runup: ["runup"], sleep_on_it: ["leadH"], avoid_daypart: ["hour"], pause_turbulent: ["pVol"], cap_turbulent: ["pVol", "relSize"], wait_strong_market: ["pRet"],
    research_gate: ["conviction"], cap_low_attention: ["conviction", "relSize"], no_quick_switch: ["sinceSell"], avoid_extrapolation: ["pct12"], cap_lottery: ["lottery", "relSize"], wait_crowd: ["crowd"] };
  const NOTE_BA = "Association, not proof: one investor, different markets; the agent applies the same rules in both periods, which takes out the market but not everything.";
  const NOTE_FX = "No currency conversion: buys in different currencies are added as they are.";

  // ---------- small helpers ----------

  function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
  function dateIdx(s, date) { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m].date < date) lo = m + 1; else hi = m; } return lo < s.length ? lo : -1; }
  function closeOnOrBefore(s, date) { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m].date <= date) lo = m + 1; else hi = m; } return lo > 0 ? s[lo - 1].close : null; }
  function dayMs(date) { return Date.parse(date + "T00:00:00Z"); }
  function monthStart(t) { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  function hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }
  function seedOf(id) { let h = 7; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h; }
  function withExtra(rule, p, R) { return rule.extra ? Object.assign({}, p, rule.extra(p, R)) : p; }
  function r1(x) { return x == null || !isFinite(x) ? null : Math.round(x * 10) / 10; }
  function pct1(x) { return x == null || !isFinite(x) ? null : Math.round(x * 1000) / 10; }
  function eligible(d) { return !d.assetClass || ELIGIBLE[d.assetClass]; }
  function boot(xs, seed) { return xs.length >= 2 ? S.bootstrap(xs, null, 2000, seed, 0.99) : { est: S.mean(xs), lo: null, hi: null }; }

  // ---------- point-in-time market ----------

  // For each bench bar i: the percentile of its 20-day volatility and 20-day
  // return among the values of the bars before it (at least 120), else null.
  function pitMarket(bench) {
    const ms = D.marketSeries(bench), n = bench.length, pVol = new Array(n).fill(null), pRet = new Array(n).fill(null), sv = [], sr = [];
    for (let i = 0; i < n; i++) {
      const v = ms.vol20[i], r = ms.ret20[i];
      if (v != null && sv.length >= 120) pVol[i] = S.pctRank(sv, v);
      if (r != null && sr.length >= 120) pRet[i] = S.pctRank(sr, r);
      if (v != null) sv.splice(lowerBound(sv, v), 0, v);
      if (r != null) sr.splice(lowerBound(sr, r), 0, r);
    }
    return { ms: ms, pVol: pVol, pRet: pRet };
  }

  // ---------- shared context ----------

  // Views per ticker, sorted (intraday; the daily events when there is none).
  function attIndex(input) {
    const intr = !!(input.intraday && input.intraday.length), by = {}, out = {};
    (intr ? input.intraday : (input.events || [])).forEach(function (e) { if (e && e.ticker && e.ts) (by[e.ticker] = by[e.ticker] || []).push(e); });
    Object.keys(by).forEach(function (t) {
      const rows = by[t].sort(function (a, b) { return a.ts - b.ts; });
      const cv = [0];
      rows.forEach(function (e, i) { cv.push(cv[i] + (intr ? 1 : (e.views || 1))); });
      out[t] = { ts: rows.map(function (e) { return e.ts; }), rows: rows, cv: cv };
    });
    return { by: out, intraday: intr };
  }
  // The number of views of a ticker in [from, to).
  function viewCount(att, t, from, to) { const x = att.by[t]; return x ? x.cv[lowerBound(x.ts, to)] - x.cv[lowerBound(x.ts, from)] : 0; }
  // Views of a ticker in [from, to): count, max scroll, max focus switches, minutes, page types.
  function viewsIn(att, t, from, to) {
    const x = att.by[t], out = { n: 0, scroll: 0, focus: 0, minutes: 0, types: {} };
    if (!x) return out;
    for (let i = lowerBound(x.ts, from), e = lowerBound(x.ts, to); i < e; i++) {
      const v = x.rows[i];
      out.n += att.intraday ? 1 : (v.views || 1);
      if (v.scrollDepth != null && v.scrollDepth > out.scroll) out.scroll = v.scrollDepth;
      if ((v.focusSwitches || 0) > out.focus) out.focus = v.focusSwitches || 0;
      out.minutes += (v.dwellMs || 0) / 60000;
      const k = v.researchType || "unclassified";
      out.types[k] = (out.types[k] || 0) + 1;
    }
    return out;
  }

  const CACHE = typeof WeakMap !== "undefined" ? new WeakMap() : null;
  // Everything the features need, built once per input.
  function context(R, input, community) {
    const hit = CACHE && CACHE.get(input);
    if (hit && hit.R === R && (community === undefined || hit.community === community)) return hit;
    const bench = input.bench || [], links = input.links || {}, prices = input.prices || {}, tsym = input.tickerSymbol || {};
    const att = attIndex(input);
    const sells = R.decisions.filter(function (d) { return d.side === "sell" && !d.auto && eligible(d); }).sort(function (a, b) { return a.cut - b.cut; });
    const names = {};
    (input.txs || []).forEach(function (t) { const l = links[D.instKey(t)]; if (l && l.ticker && t.name && !names[l.ticker]) names[l.ticker] = t.name; });
    let t0 = Infinity;
    (input.intraday || []).forEach(function (e) { if (e && e.ts < t0) t0 = e.ts; });
    (input.txs || []).forEach(function (e) { if (e && e.ts < t0) t0 = e.ts; });
    (input.events || []).forEach(function (e) { if (e && e.ts < t0) t0 = e.ts; });
    const tickers = Object.keys(Object.assign({}, tsym, att.by)).sort();
    const aliasNo = {};
    tickers.forEach(function (t, i) { aliasNo[t] = i + 1; });
    const ctx = {
      R: R, input: input, community: community, bench: bench, pit: pitMarket(bench), att: att, sells: sells, sellCuts: sells.map(function (d) { return d.cut; }),
      coverStart: R.coverage ? R.coverage.coverStart : null, fxUsd: input.fxUsd, names: names, t0: isFinite(t0) ? t0 : null, tickers: tickers, aliasNo: aliasNo,
      ci: I && I.crowdIndex && community ? I.crowdIndex(community, input.events) : null,
      seriesOfInst: function (inst) { const l = links[inst]; return l && l.symbol ? prices[l.symbol] : null; },
      seriesOfTicker: function (t) { return tsym[t] ? prices[tsym[t]] : null; },
      base: baseCurrency(R), toBase: null
    };
    ctx.toBase = fxConverter(input.fx || {}, ctx.base);
    if (CACHE) CACHE.set(input, ctx);
    return ctx;
  }

  // Days since the last sale of something else, at time t (null without one).
  function sinceSellAt(ctx, t, inst, ticker) {
    const i = lowerBound(ctx.sellCuts, t + 1) - 1;
    if (i < 0) return null;
    const s = ctx.sells[i];
    if ((inst && s.inst === inst) || (!inst && ticker && s.ticker === ticker)) return null;
    return (t - s.cut) / DAY;
  }

  // ---------- currencies ----------

  // The currency your buys are paid in (the most common one): the paper portfolios are valued in it.
  function baseCurrency(R) {
    const n = {};
    R.decisions.forEach(function (d) { if (d.side === "buy" && d.currency) n[d.currency] = (n[d.currency] || 0) + 1; });
    const k = Object.keys(n).sort(function (a, b) { return n[b] - n[a]; });
    return k.length ? k[0] : null;
  }
  // fx: { CUR: bars of Yahoo's CURUSD=X, USD per unit }. Returns (ccy, date) -> units of `base` per unit of ccy on that
  // date (the last rate on or before it, the first one before the series), or null when a rate is missing.
  const MINOR_CCY = { GBp: ["GBP", 100], GBX: ["GBP", 100], ZAc: ["ZAR", 100], ILA: ["ILS", 100] };
  function fxConverter(fx, base) {
    const usdPer = function (c, date) {
      const m = MINOR_CCY[c], cur = m ? m[0] : c, div = m ? m[1] : 1;
      if (cur === "USD") return 1 / div;
      const b = fx[cur];
      if (!b || !b.length) return null;
      let lo = 0, hi = b.length;
      while (lo < hi) { const md = (lo + hi) >> 1; if (b[md].date <= date) lo = md + 1; else hi = md; }
      return b[lo > 0 ? lo - 1 : 0].close / div;
    };
    return function (ccy, date) {
      if (!ccy || !base || ccy === base) return 1;
      const a = usdPer(ccy, date), b = usdPer(base, date);
      return a != null && b > 0 ? a / b : null;
    };
  }

  // ---------- point-in-time features ----------

  // The features of a candidate if it were bought on its trading day + k (k = 0:
  // the original moment), from data before that day only. need: which of the
  // costly features (pct12, lottery, crowd) to compute; all when omitted.
  // Null when the stock's series has no bar k.
  function featuresAt(cand, k, ctx, need) {
    const s = cand.series, i0 = cand.i0;
    if (!s || i0 < 0 || i0 + k >= s.length) return null;
    const day = k ? s[i0 + k].date : cand.date, shift = k ? dayMs(day) - dayMs(cand.date) : 0, t = cand.t + shift, dm = dayMs(day);
    const f = { day: day, t: t, k: k, hour: k ? null : cand.hour, relSize: cand.relSize };
    const a0 = closeOnOrBefore(s, S.isoDay(dm - 31 * DAY)), a1 = closeOnOrBefore(s, S.isoDay(dm - DAY));
    f.runup = a0 > 0 && a1 != null ? a1 / a0 - 1 : null;
    const j = D.barBefore(ctx.bench, day);
    f.pVol = j >= 0 ? ctx.pit.pVol[j] : null;
    f.pRet = j >= 0 ? ctx.pit.pRet[j] : null;
    f.dd = j >= 0 ? ctx.pit.ms.dd[j] : null;
    if (ctx.coverStart != null && t >= ctx.coverStart && cand.ticker) {
      const w = viewsIn(ctx.att, cand.ticker, t - 30 * DAY, t);
      f.views30 = w.n;
      f.conviction = Math.log2(1 + w.n) * (0.5 + 0.5 * w.scroll) * (1 + w.focus * 0.1);
      f.leadH = !cand.dateOnly && cand.firstAtt != null ? (t - cand.firstAtt) / 3600000 : null;
    } else { f.views30 = null; f.conviction = null; f.leadH = null; }
    f.sinceSell = cand.sinceSell != null ? cand.sinceSell + shift / DAY : null;
    if (!need || need.pct12) {
      if (I && I.pastRet && cand.ticker) {
        const own = I.pastRet(s, day, 252), r12 = [];
        if (own != null) {
          const uni = ctx.att.intraday ? Object.keys(ctx.att.by).filter(function (x) { const a = ctx.att.by[x].ts; return x === cand.ticker || lowerBound(a, t) > lowerBound(a, t - 30 * DAY); }) : [cand.ticker];
          if (uni.indexOf(cand.ticker) < 0) uni.push(cand.ticker);
          uni.forEach(function (x) { const v = I.pastRet(x === cand.ticker ? s : ctx.seriesOfTicker(x), day, 252); if (v != null) r12.push(v); });
          r12.sort(S.numeric);
        }
        f.pct12 = own != null && r12.length >= 5 ? S.pctRank(r12, own) : null;
      } else f.pct12 = cand.pct12 != null ? cand.pct12 : null;
    }
    if (!need || need.lottery) {
      if (I && I.lotteryAt) { const x = I.lotteryAt(s, ctx.bench, day, ctx.fxUsd); f.lottery = x ? !!x.lottery : null; }
      else f.lottery = cand.lottery != null ? cand.lottery : null;
    }
    if (!need || need.crowd) {
      // from the trade's own time, as the wait_crowd units are: a date-only trade's cut
      // (the next midnight UTC) falls after 16:00 ET and would count the trade day's views
      const c = I && I.crowdAt && ctx.ci && cand.ticker ? I.crowdAt(ctx.ci, cand.ticker, (cand.ts != null ? cand.ts : cand.t) + shift) : null;
      f.crowd = c ? c.ratio : null;
      f.crowdHot = c ? c.hot : null;
    }
    return f;
  }

  // ---------- candidates ----------

  function uniqueId(seen, base) {
    let id = base, n = 2;
    while (seen[id]) id = base + "-" + (n++);
    seen[id] = 1;
    return id;
  }

  // Every buy the user decided on (no savings plan, an eligible asset class),
  // "before capture" ones included: their attention features are null, so only
  // price and market rules can fire on them. Needs the stock's prices from the
  // trade day.
  function tradeCandidates(R, ctx, now, seen) {
    const out = [];
    R.decisions.forEach(function (d) {
      if (d.side !== "buy" || d.auto || d.excluded === "asset class" || !eligible(d) || d.cut > now) return;
      const s = ctx.seriesOfInst(d.inst);
      if (!s || !s.length || s[0].date > d.date) return;
      const i0 = dateIdx(s, d.date);
      if (i0 < 0) return;
      out.push({ id: uniqueId(seen, "t" + hash(d.inst + "|" + d.date)), kind: "trade", ticker: d.ticker || null, inst: d.inst, date: d.date, t: d.cut, ts: d.ts,
        dateOnly: !!d.dateOnly, hour: d.dateOnly ? null : new Date(d.ts).getHours(), amount: d.amount, currency: d.currency, relSize: d.relSize,
        firstAtt: d.firstAtt, sinceSell: sinceSellAt(ctx, d.cut, d.inst, d.ticker), series: s, i0: i0, excluded: d.excluded || null, bought: null });
    });
    return out;
  }

  // The New York trading day of a moment: a view at or after the 16:00 ET close
  // belongs to the next day, so it is never entered at a close that had already printed.
  function nyDate(ts) { return I && I.nyDayNum ? S.isoDay(I.nyDayNum(ts) * DAY) : S.isoDay(ts); }

  // Attention episodes: a view of a stock with no view of it in the 30 days
  // before (first looks and returns), one per stock and New York day, where the stock
  // has prices from that day. `bought`: the user's own buy of it within 30 days.
  function lookCandidates(R, ctx, now, seen) {
    const buysOf = {}, out = [];
    R.decisions.forEach(function (d) { if (d.side === "buy" && !d.auto && d.ticker) (buysOf[d.ticker] = buysOf[d.ticker] || []).push(d); });
    Object.keys(ctx.att.by).sort().forEach(function (tk) {
      const s = ctx.seriesOfTicker(tk), x = ctx.att.by[tk];
      if (!s || !s.length) return;
      const days = {};
      for (let i = 0; i < x.ts.length; i++) {
        const ts = x.ts[i];
        if (ts > now || (i > 0 && ts - x.ts[i - 1] < LOOK_GAP)) continue;
        const date = nyDate(ts);
        if (days[date] || s[0].date > date) continue;
        const i0 = dateIdx(s, date);
        if (i0 < 0) continue;
        days[date] = 1;
        const b = (buysOf[tk] || []).find(function (d) { return d.cut >= ts && d.cut <= ts + LOOK_GAP; });
        out.push({ id: uniqueId(seen, "l" + hash(tk + "|" + date)), kind: "look", ticker: tk, inst: null, date: date, t: ts, ts: ts, dateOnly: false,
          hour: new Date(ts).getHours(), amount: null, currency: null, relSize: null, firstAtt: x.ts[0], sinceSell: sinceSellAt(ctx, ts, null, tk),
          series: s, i0: i0, excluded: null, bought: b ? { date: b.date, t: b.cut } : null });
      }
    });
    return out.sort(function (a, b) { return a.t - b.t; });
  }

  // Looks of the last 2 days whose trading day has no closing price yet: lookCandidates leaves
  // them out (a position needs a bar to be entered at), but the AI agent can already decide them,
  // live, from the prices up to the last close. Same ids as the candidate they become once the bar
  // exists, so the saved decision then applies to it.
  function pendingLooks(R, ctx, now) {
    const out = [], seen = {};
    Object.keys(ctx.att.by).sort().forEach(function (tk) {
      const s = ctx.seriesOfTicker(tk), x = ctx.att.by[tk];
      if (!s || !s.length) return;
      const days = {};
      for (let i = 0; i < x.ts.length; i++) {
        const ts = x.ts[i];
        if (ts > now || now - ts > LIVE_MS || (i > 0 && ts - x.ts[i - 1] < LOOK_GAP)) continue;
        const date = nyDate(ts);
        if (days[date] || s[0].date > date || dateIdx(s, date) >= 0) continue;
        days[date] = 1;
        out.push({ id: uniqueId(seen, "l" + hash(tk + "|" + date)), kind: "look", ticker: tk, inst: null, date: date, t: ts, ts: ts, dateOnly: false,
          hour: new Date(ts).getHours(), amount: null, currency: null, relSize: null, firstAtt: x.ts[0], sinceSell: sinceSellAt(ctx, ts, null, tk),
          series: s, i0: s.length - 1, excluded: null, bought: null, pending: true });
      }
    });
    return out.sort(function (a, b) { return a.t - b.t; });
  }

  // Repeat views in an unusual burst: a view of a stock the investor already looked at in the
  // last 30 days (so not a new look), when its views in the 3 days up to it are at least 3 and at
  // least twice the usual (the month before, per 3 days), once per burst (not again within 7 days).
  // Only moments from startMs on and at most 2 days old: nothing is decided for the past.
  // aiList: the AI agent's own earlier decisions, which say whether it holds the stock.
  function positionAt(aiList, tk, t, series) {
    const mine = (aiList || []).filter(function (d) { return d.ticker === tk && d.t < t && t - d.t <= 120 * DAY && (d.kind === "look" || d.kind === "revisit"); }).sort(function (a, b) { return a.t - b.t; });
    let size = 0, entry = null, lastBuy = null;
    mine.forEach(function (d) {
      if (d.kind === "look") { if (d.action === "buy") { if (!size) entry = d.t; size = d.size; lastBuy = d.t; } else if (d.action === "pass") { size = 0; entry = null; } }
      else if (d.action === "sell") { size = Math.max(0, size - d.size); if (!size) entry = null; }
      else if (d.action === "buy") { if (!size) entry = d.t; size = Math.min(2, size + d.size); lastBuy = d.t; }
    });
    const p0 = entry != null ? closeOnOrBefore(series, S.isoDay(entry)) : null, p1 = closeOnOrBefore(series, S.isoDay(t - DAY));
    // a position opened or added to on the day of the repeat view is not sold on that day
    const canSell = size > 0 && !(lastBuy != null && nyDate(lastBuy) === nyDate(t));
    return { holding: size > 0, size: Math.round(size * 100) / 100, canSell: canSell, sinceEntryPct: p0 > 0 && p1 > 0 ? pct1(p1 / p0 - 1) : null };
  }
  function pendingRevisits(R, ctx, now, aiList, startMs, liveMs) {
    const out = [], seen = {}, live = liveMs == null ? LIVE_MS : liveMs;
    Object.keys(ctx.att.by).sort().forEach(function (tk) {
      const s = ctx.seriesOfTicker(tk), ts = ctx.att.by[tk].ts;
      if (!s || !s.length) return;
      let lastBurst = -Infinity;
      const days = {};
      for (let i = 1; i < ts.length; i++) {
        const t = ts[i];
        if (t > now || t - ts[i - 1] >= LOOK_GAP) continue;
        let n3 = 0, nb = 0;
        for (let j = i; j >= 0 && ts[j] > t - 33 * DAY; j--) { if (ts[j] > t - 3 * DAY) n3++; else nb++; }
        const usual = nb / 10;
        if (n3 < 3 || n3 < 2 * Math.max(usual, 0.5) || t - lastBurst < 7 * DAY) continue;
        lastBurst = t;
        if (t < startMs || now - t > live) continue;
        const date = nyDate(t);
        if (days[date] || s[0].date > date) continue;
        days[date] = 1;
        const i0 = dateIdx(s, date), pos = positionAt(aiList, tk, t, s);
        out.push({ id: uniqueId(seen, "r" + hash(tk + "|" + date)), kind: "revisit", ticker: tk, inst: null, date: date, t: t, ts: t, dateOnly: false, hour: new Date(t).getHours(),
          amount: null, currency: null, relSize: null, firstAtt: ts[0], sinceSell: sinceSellAt(ctx, t, null, tk), series: s, i0: i0 >= 0 ? i0 : s.length - 1, excluded: null, bought: null, pending: i0 < 0,
          burst: { views3d: n3, usualViews3d: r1(usual) }, position: pos });
      }
    });
    return out.sort(function (a, b) { return a.t - b.t; });
  }

  // ---------- the rules agent ----------

  // A rule's units with the point-in-time market percentiles in place of the
  // full-period ones.
  function pitUnits(rule, R, ctx) {
    return rule.universe(R).map(function (u) {
      if (!u.f || !("pVol" in u.f)) return u;
      const date = String(u.id).slice(String(u.id).lastIndexOf("|") + 1), j = D.barBefore(ctx.bench, date);
      return Object.assign({}, u, { f: Object.assign({}, u.f, { pVol: j >= 0 ? ctx.pit.pVol[j] : null, pRet: j >= 0 ? ctx.pit.pRet[j] : null }) });
    }).filter(rule.applies).sort(function (a, b) { return a.t - b.t; });
  }

  // At each month start: every buy rule fitted on the units whose outcome was
  // known by then; active when the fit finds a setting and the walk-forward
  // verdict is supported or indicative. fit/walkForward get o = {} so the time
  // of day uses the fixed day parts, never clusters of the whole history.
  function snapshots(R, months, ctx) {
    const per = BUY_RULES.map(B.ruleById).filter(Boolean).map(function (rule) { return { rule: rule, units: pitUnits(rule, R, ctx), n: -1, res: null }; });
    return months.map(function (M) {
      const rules = [];
      per.forEach(function (x) {
        const train = x.units.filter(function (u) { return u.tEnd <= M; });
        if (train.length !== x.n) {
          x.n = train.length; x.res = null;
          const best = B.fit(x.rule, train, R, {});
          if (best) {
            const wf = B.walkForward(x.rule, train, seedOf(x.rule.id), R, {});
            if (wf.verdict === "supported" || wf.verdict === "indicative") x.res = { ruleId: x.rule.id, params: best.p, verdict: wf.verdict, mean: wf.mean };
          }
        }
        if (x.res) rules.push(x.res);
      });
      return { t: M, month: S.isoDay(M).slice(0, 7), rules: rules };
    });
  }
  // The buy rules you adopted in the coach join every month's rules with the setting you adopted (replacing a fitted one):
  // the rules agent then shows what following them would have done. Unlike the fitted rules, they are applied to the whole
  // history, including the time before you adopted them, and were chosen knowing that history.
  function withAdopted(snaps, commitments) {
    const ad = (commitments || []).filter(function (c) { return c && c.status === "active" && !c.kind && c.params && BUY_RULES.indexOf(c.ruleId) >= 0 && B.ruleById(c.ruleId); });
    if (!ad.length) return snaps;
    return snaps.map(function (s) {
      const rules = s.rules.filter(function (r) { return !ad.some(function (c) { return c.ruleId === r.ruleId; }); })
        .concat(ad.map(function (c) { return { ruleId: c.ruleId, params: c.params, verdict: "adopted", mean: null, adoptedAt: c.adoptedAt || null }; }));
      return { t: s.t, month: s.month, rules: rules };
    });
  }

  function snapshotAt(snaps, t) {
    let lo = 0, hi = snaps.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (snaps[m].t <= t) lo = m + 1; else hi = m; }
    return lo > 0 ? snaps[lo - 1] : null;
  }

  function activeOf(snap) {
    return (snap ? snap.rules : []).map(function (a) { return { a: a, rule: B.ruleById(a.ruleId) }; }).filter(function (x) { return x.rule; });
  }
  function fires(x, f) { return !!f && x.rule.applies({ f: f }) && !!x.rule.flag({ f: f }, x.a.params); }
  function capSize(list, f) {
    let size = 1;
    list.forEach(function (x) { if (CAPS[x.a.ruleId] && fires(x, f) && f.relSize > 0) size = Math.min(size, x.a.params.cap / f.relSize); });
    return Math.min(1, size);
  }
  function titles(list) { return list.map(function (x) { return x.rule.title; }).join(", "); }

  // What the rules agent saw, kept with its decision so that it can be explained later: the reading of each
  // rule that acted (with the instruction it carries) and the point-in-time features of the moment.
  function readingsOf(list, f, role, ctx, t) {
    if (!list.length) return [];
    const Rt = { decisions: ctx.R.decisions.filter(function (d) { return d.cut < t; }) };
    return list.map(function (x) {
      const p = withExtra(x.rule, x.a.params, Rt);
      let reading = null;
      try { reading = x.rule.check(p, f) || x.rule.text(p, Rt); } catch (e) { /* the wording is a bonus */ }
      return { id: x.a.ruleId, title: x.rule.title, role: role, reading: reading || x.rule.title, do: x.rule.do(p) };
    });
  }
  function featuresOut(f) {
    const r3 = function (x) { return x == null || typeof x === "boolean" ? (typeof x === "boolean" ? x : null) : isFinite(x) ? Math.round(x * 1000) / 1000 : null; };
    return { runup30: r3(f.runup), volPercentile: r3(f.pVol), ret20Percentile: r3(f.pRet), views30: r3(f.views30), hoursSinceFirstLook: r3(f.leadH), hour: f.hour == null ? null : f.hour, sizeVsUsualBuy: r3(f.relSize),
      yearReturnPercentile: r3(f.pct12), lottery: r3(f.lottery), crowdRatio: r3(f.crowd), daysSinceSale: r3(f.sinceSell) };
  }

  // The rules agent on one candidate: buy now (a cap rule may cut the size, the
  // time-of-day rule only moves the order to another time of day), else wait for
  // the first of the next 10 trading days on which no delaying rule fires, else pass.
  function decide(cand, snap, ctx) {
    const act = activeOf(snap), active = act.map(function (x) { return x.a.ruleId; });
    if (!act.length) return { action: "buy", days: 0, size: 1, rules: [], why: [], active: active, reason: "No rule had held up for you by then." };
    const need = {};
    act.forEach(function (x) { if (NEEDS[x.a.ruleId]) need[NEEDS[x.a.ruleId]] = 1; });
    const f0 = featuresAt(cand, 0, ctx, need);
    if (!f0) return { action: "buy", days: 0, size: 1, rules: [], why: [], active: active, reason: "No prices to judge it on." };
    const fired = act.filter(function (x) { return fires(x, f0); });
    const delay = act.filter(function (x) { return !CAPS[x.a.ruleId] && !TIMING[x.a.ruleId]; });
    const held = fired.filter(function (x) { return delay.indexOf(x) >= 0; }), timing = fired.filter(function (x) { return TIMING[x.a.ruleId]; });
    let k = 0, fk = f0, ended = false;
    if (held.length) {
      k = -1;
      for (let w = 1; w <= MAX_WAIT; w++) {
        const f = featuresAt(cand, w, ctx, need);
        if (!f) { ended = true; break; }
        if (!delay.some(function (x) { return fires(x, f); })) { k = w; fk = f; break; }
      }
    }
    // the prices end inside the wait: not bought so far (the money stays in the NASDAQ),
    // still waiting; pending, so it is not saved as a final decision
    const feat = featuresOut(f0);
    if (k < 0 && ended) return { action: "pass", days: 0, size: 0, rules: held.map(function (x) { return x.a.ruleId; }), pending: true, why: readingsOf(held, f0, "held", ctx, cand.t), features: feat, active: active,
      reason: titles(held) + ": still in force on every trading day so far, so it is still waiting." };
    if (k < 0) return { action: "pass", days: 0, size: 0, rules: held.map(function (x) { return x.a.ruleId; }), why: readingsOf(held, f0, "held", ctx, cand.t), features: feat, active: active,
      reason: titles(held) + ": still in force " + MAX_WAIT + " trading days later, so it passed." };
    const caps = act.filter(function (x) { return CAPS[x.a.ruleId] && fires(x, fk); }), size = capSize(act, fk);
    const ids = held.concat(timing, caps).map(function (x) { return x.a.ruleId; });
    const parts = [];
    if (k) parts.push("Waited " + k + " trading day" + (k === 1 ? "" : "s") + " until " + titles(held) + " no longer applied.");
    if (caps.length) parts.push("Size cut to " + Math.round(size * 100) + "% of the amount (" + titles(caps) + ").");
    if (timing.length) parts.push("Placed at another time of day (" + titles(timing) + ").");
    const why = readingsOf(held, f0, "held", ctx, cand.t).concat(readingsOf(timing, f0, "timing", ctx, cand.t), readingsOf(caps, fk, "cap", ctx, cand.t));
    return { action: k ? "wait" : "buy", days: k, size: size, rules: ids, why: why, features: feat, active: active, reason: parts.length ? parts.join(" ") : act.length + (act.length === 1 ? " rule is in force for you, but it does not object to this one." : " rules are in force for you, but none objects to this one.") };
  }

  // An intended buy now against a snapshot (the pre-trade check): f as in the
  // rule units. A delaying rule that fires means "wait"; how long is not known yet.
  // unchecked: the active rules that lack a feature they read.
  function verdictNow(snap, f) {
    const act = activeOf(snap), fired = act.filter(function (x) { return fires(x, f); });
    const delaying = fired.filter(function (x) { return !CAPS[x.a.ruleId] && !TIMING[x.a.ruleId]; }).map(function (x) { return x.a.ruleId; });
    const unchecked = act.filter(function (x) { return (FEATURES[x.a.ruleId] || []).some(function (k) { return !f || f[k] == null; }); }).map(function (x) { return x.a.ruleId; });
    return { action: delaying.length ? "wait" : "buy", size: capSize(act, f), rules: fired.map(function (x) { return x.a.ruleId; }), delaying: delaying, unchecked: unchecked };
  }

  // What the rules agent says at the moment itself, for the AI agent: buy, or wait
  // until the rules that fire no longer apply, the size, and each rule's reading and
  // instruction. Never how long it then waited or whether it passed: that depends on
  // the prices after the moment. Rt: the report cut to what was known then.
  function rulesView(snap, f, Rt) {
    const v = verdictNow(snap, f || {});
    return { action: v.action, size: Math.round(v.size * 100) / 100, rules: activeOf(snap).filter(function (x) { return v.rules.indexOf(x.a.ruleId) >= 0; }).map(function (x) {
      const p = withExtra(x.rule, x.a.params, Rt);
      return { id: x.a.ruleId, now: x.rule.check(p, f) || x.rule.text(p, Rt), do: x.rule.do(p) };
    }) };
  }

  // ---------- outcomes ----------

  // Excess vs the NASDAQ of the user's buy and of the agent's version, measured
  // to the same end bar: a wait of k days runs h - k days, a pass earns 0 (the
  // money stays in the NASDAQ), a size s earns s times the stock's excess.
  function pairedEx(c, dec, h, bench) {
    const u = D.forward(c.series, bench, c.date, h);
    if (!u) return null;
    let a;
    if (dec.action === "pass") a = 0;
    else if (!dec.days) a = dec.size * u.ex;
    else if (dec.days >= h) a = null;
    else { const w = D.forward(c.series, bench, c.series[c.i0 + dec.days].date, h - dec.days); a = w ? dec.size * w.ex : null; }
    return a == null ? null : { you: u.ex, agent: a };
  }
  function exOf(c, dec, ctx) { const out = {}; HS.forEach(function (h) { out[h] = pairedEx(c, dec, h, ctx.bench); }); return out; }

  function normAi(list) {
    const by = {};
    (list || []).forEach(function (d) {
      if (!d || !d.id || ["buy", "wait", "pass"].indexOf(d.action) < 0) return;
      const days = d.action === "wait" ? Math.max(1, Math.min(MAX_WAIT, Math.round(+d.days) || 1)) : 0;
      const w = d.sizeUnit === "weight" && d.action !== "pass" ? Math.max(0, Math.min(1, +d.size || 0)) : null;
      // size is a share of the amount for the older figures (paired results, looks lines); a weight is kept apart, and 5% counts as the whole amount there
      const size = d.action === "pass" ? 0 : w != null ? Math.min(1, w / LEGACY_WEIGHT) : Math.max(0, Math.min(1, d.size == null || !isFinite(+d.size) ? 1 : +d.size));
      by[d.id] = { action: d.action, days: days, size: size, weight: w, sizeUnit: w != null ? "weight" : null, reason: d.reason || "", decidedAt: d.decidedAt != null ? d.decidedAt : null, model: d.model || null };
    });
    return by;
  }
  function record(c, dec, snap, ctx) {
    const out = Object.assign({ id: c.id, kind: c.kind, ticker: c.ticker, t: c.t, date: c.date, month: snap ? snap.month : null }, dec);
    if (!out.rules) out.rules = [];
    if (dec.decidedAt != null) out.live = dec.decidedAt - c.t <= 2 * DAY;
    out.ex = exOf(c, dec, ctx);
    return out;
  }

  // ---------- portfolio 1: your trades, money-weighted ----------

  // One buy's money from the day it is funded (bench index b0): into the stock at
  // index eb (-1: never) with share sz, the rest in the NASDAQ. Each of the
  // user's sales of the instrument sells the same fraction of what is held then
  // (before the buy: of what is still to be bought); proceeds go to the NASDAQ.
  // Adds the daily value into acc.
  function lot(A, b0, eb, sz, sales, Sv, Bv, acc, col) {
    let sh = 0, bu = A / Bv[b0], pend = 1, si = 0;
    const buy = function (d) { const x = pend * sz; sh = x * A * (Bv[d] / Bv[b0]) / Sv[d]; bu = bu * (1 - x); };
    for (let d = b0; d < Bv.length; d++) {
      if (d === eb && eb === b0) buy(d);
      while (si < sales.length && sales[si].at <= d) {
        const f = sales[si++].f;
        if (eb < 0 || d < eb || (d === eb && eb !== b0)) pend *= 1 - f;
        else { bu += sh * f * Sv[d] / Bv[d]; sh *= 1 - f; }
      }
      if (d === eb && eb !== b0) buy(d);
      acc[d] += sh * Sv[d] + bu * Bv[d];
      if (col && col.at[d] >= 0) { col.stock[col.at[d]] += sh * Sv[d]; col.cash[col.at[d]] += bu * Bv[d]; }
    }
  }

  function portfolio(cands, rulesBy, aiBy, ctx) {
    const bench = ctx.bench;
    if (!cands.length || !bench.length) return null;
    const first = cands.reduce(function (m, c) { const d = c.series[c.i0].date; return d < m ? d : m; }, "9999");
    const k0 = dateIdx(bench, first);
    if (k0 < 0) return null;
    const dates = bench.slice(k0).map(function (b) { return b.date; }), Bv = bench.slice(k0).map(function (b) { return b.close; }), n = dates.length;
    const zero = function () { return new Array(n).fill(0); };
    const acc = { you: zero(), rules: zero(), ai: zero(), nasdaq: zero(), fund: zero() };
    // the AI agent has a line on your trades only once it decided one of them (a decision on a look is no trade decision)
    const hasAi = cands.some(function (c) { return aiBy[c.id]; });
    // what each portfolio holds at every month end (and the last day), per stock and in the NASDAQ, as a share of the money put in
    const smp = [], at2 = new Array(n).fill(-1);
    for (let d = 0; d < n; d++) if (d === n - 1 || dates[d].slice(0, 7) !== dates[d + 1].slice(0, 7)) { at2[d] = smp.length; smp.push(d); }
    const hold = { you: {}, rules: {}, ai: {}, nasdaq: {} };
    const colOf = function (key, tk) {
      const h = hold[key], name = tk || "untracked";
      return h[name] || (h[name] = { at: at2, stock: new Array(smp.length).fill(0), cash: new Array(smp.length).fill(0) });
    };
    const salesOf = {};
    ctx.R.decisions.forEach(function (d) { if (d.side === "sell" && d.posBefore > 0) (salesOf[d.inst] = salesOf[d.inst] || []).push(d); });
    const at = function (date) { const i = dateIdx(bench, date); return i < 0 ? -1 : i - k0; };
    cands.forEach(function (c) {
      const A = c.amount, s = c.series, b0 = at(s[c.i0].date);
      if (!(A > 0) || b0 < 0) return;
      const Sv = new Array(n);
      let p = c.i0;
      for (let d = b0; d < n; d++) { while (p + 1 < s.length && s[p + 1].date <= dates[d]) p++; Sv[d] = s[p].close; }
      const sales = (salesOf[c.inst] || []).filter(function (d) { return d.ts > c.ts; }).map(function (d) { return { at: at(d.date), f: Math.min(1, d.qty / d.posBefore) }; })
        .filter(function (x) { return x.at >= 0; }).sort(function (a, b) { return a.at - b.at; });
      const run1 = function (dec, into) {
        const eb = dec.action === "pass" ? -1 : dec.days ? (c.i0 + dec.days < s.length ? at(s[c.i0 + dec.days].date) : -1) : b0;
        lot(A, b0, eb, dec.action === "pass" ? 0 : dec.size, sales, Sv, Bv, into, colOf(into === acc.you ? "you" : into === acc.rules ? "rules" : into === acc.ai ? "ai" : "nasdaq", c.ticker));
      };
      const you = { action: "buy", days: 0, size: 1 };
      run1(you, acc.you);
      run1(rulesBy[c.id], acc.rules);
      if (hasAi) run1(aiBy[c.id] || you, acc.ai);
      run1({ action: "pass" }, acc.nasdaq);
      for (let d = b0; d < n; d++) acc.fund[d] += A;
    });
    const ratio = function (a) { return a.map(function (v, d) { return acc.fund[d] > 0 ? v / acc.fund[d] : null; }); };
    // The same portfolios as time-weighted indices (100 on the first day): money put in on a day is taken out of that day's
    // gain, so portfolios that are funded at different times, and an index of prices, can be compared from any day on.
    const twr = function (a) {
      const out = new Array(n).fill(null);
      let idx = 100;
      out[0] = idx;
      for (let d = 1; d < n; d++) {
        const prev = a[d - 1], flow = acc.fund[d] - acc.fund[d - 1];
        if (prev > 0) idx *= (a[d] - flow) / prev;
        out[d] = idx;
      }
      return out;
    };
    // holdings: per portfolio, per sampled day: { stocks: { ticker: share }, nasdaq: share }
    const holdings = { dates: smp.map(function (d) { return dates[d]; }), unit: "share of the money put in" };
    ["you", "rules", "ai", "nasdaq"].forEach(function (key) {
      if (key === "ai" && !hasAi) { holdings.ai = null; return; }
      holdings[key] = smp.map(function (d, k) {
        const f = acc.fund[d] > 0 ? acc.fund[d] : null, o = { stocks: {}, nasdaq: 0 };
        if (!f) return o;
        Object.keys(hold[key]).forEach(function (tk) {
          const c = hold[key][tk];
          if (c.stock[k] > 1e-9) o.stocks[tk] = c.stock[k] / f;
          o.nasdaq += c.cash[k] / f;
        });
        return o;
      });
    });
    return { dates: dates, you: ratio(acc.you), rules: ratio(acc.rules), ai: hasAi ? ratio(acc.ai) : null, nasdaq: ratio(acc.nasdaq), holdings: holdings, twr: { you: twr(acc.you), rules: twr(acc.rules), ai: hasAi ? twr(acc.ai) : null, nasdaq: twr(acc.nasdaq) }, note: NOTE_FX };
  }

  function pairedStats(recs, h, seed) {
    const xs = recs.map(function (r) { return r.ex[h]; }).filter(Boolean);
    if (!xs.length) return { n: 0, mean: null, diff: { est: null, lo: null, hi: null } };
    return { n: xs.length, mean: S.mean(xs.map(function (x) { return x.agent; })), you: S.mean(xs.map(function (x) { return x.you; })),
      diff: boot(xs.map(function (x) { return x.agent - x.you; }), seed) };
  }

  // Before / after the bias features launched (appStart).
  function beforeAfter(recs, appStart, R, coach) {
    const out = { appStart: appStart, enough: false, horizons: {}, habits: [], note: NOTE_BA };
    if (appStart == null) return out;
    HS.forEach(function (h) {
      const side = function (after) {
        const xs = recs.filter(function (r) { return (r.t >= appStart) === after && r.ex[h]; }).map(function (r) { return r.ex[h]; });
        const gaps = xs.map(function (x) { return x.agent - x.you; });
        return { n: xs.length, you: S.mean(xs.map(function (x) { return x.you; })), agent: S.mean(xs.map(function (x) { return x.agent; })), gap: boot(gaps, 501 + h), gaps: gaps };
      };
      const b = side(false), a = side(true);
      const change = a.gaps.length >= 2 && b.gaps.length >= 2 ? S.bootstrap(a.gaps, b.gaps, 2000, 601 + h, 0.99) : { est: a.n && b.n ? S.mean(a.gaps) - S.mean(b.gaps) : null, lo: null, hi: null };
      delete a.gaps; delete b.gaps;
      out.horizons[h] = { before: b, after: a, change: change };
    });
    out.enough = out.horizons[63].before.n >= 8 && out.horizons[63].after.n >= 8;
    // the habits, before vs after: progress() with its cut at the app start
    const fe = R.coverage && R.coverage.fileEnd, end = fe != null ? fe + DAY : null;
    if (end != null && end > appStart) {
      const P = B.progress(R, coach || null, { end: end, days: (end - appStart) / DAY });
      out.habits = P.habits.map(function (x) { return { id: x.id, habit: x.habit, setting: x.setting, before: { n: x.earlier.n, p: x.earlier.p }, after: { n: x.recent.n, p: x.recent.p }, change: x.change }; });
    }
    return out;
  }

  // ---------- the paper portfolios ("Paper portfolios" in the page) ----------
  // Two views, each with a portfolio per agent and the NASDAQ as the benchmark. Every portfolio stays fully invested: money a
  // smaller buy leaves goes into the stocks it holds, in proportion; it is cash only while nothing is held.
  //  trades: your buys. Every buy of yours puts its amount into each portfolio on its day; you put all of it into the stock,
  //    which gives your buy a weight (the position's share of your portfolio after it). The rules agent buys the stock up to
  //    that weight times its share (a cap rule cuts it; a wait moves the day; a pass buys none), the AI agent up to the final
  //    weight it chose, or your weight where it has not decided; your sales sell the same share of each portfolio's position and
  //    take the money out (it funded your later buys, which come in as their own amounts), so your bars are your positions.
  //    Savings-plan buys are no decision: every portfolio makes them at your weight.
  //  attention: your looks. A virtual portfolio of 100 from the first look. The attention-weighted index holds, from each close,
  //    every stock you viewed in the LOOK_WINDOW days up to LOOK_LAG days before that close, weighted by those views (no views:
  //    the last basket is kept). The rules agent holds the same basket, but each stock only from the day its rules let the
  //    look through (it picks its own lag: buy at once, or wait until no rule objects), none of a look it passed on, and a cap
  //    rule cuts the stock's weight. The AI agent buys up to its chosen weight and sells on its own repeat-view decisions.
  // Compared as time-weighted indices. A weight is a share of the portfolio's value, so two agents' weights mean the same.
  const LOOK_WINDOW = 30, LOOK_LAG = 1, LEGACY_WEIGHT = 0.05;

  // The weight a saved AI decision asks for: its size when it is a final weight, else (records from before weights) a share of
  // the amount, turned into a weight of LEGACY_WEIGHT.
  function weightOf(dec) { return dec.weight != null ? dec.weight : dec.sizeUnit === "weight" ? dec.size : LEGACY_WEIGHT * dec.size; }

  // One portfolio day by day. ev[d]: deposits, sales (a share of a position), orders (an amount, or up to a weight of the value,
  // sold out of the other positions when the cash is short) and targets (the whole portfolio rebalanced to weights).
  // full: at each day's end the cash goes into what is held, in proportion (not into what a sale or an order set to a weight
  // touched that day).
  // A sale with out: true takes its money out of the portfolio (a negative flow).
  // Returns the value per day, the money put in per day, holdings on the sample days and each order's weight after it.
  function simulate(dates, priceOf, ev, sample, full) {
    const n = dates.length, P = { cash: 0, sh: {} }, val = new Array(n).fill(null), flow = new Array(n).fill(0), snaps = {}, wAt = {}, mAt = {};
    const pos = function (d, skip) { const o = {}; Object.keys(P.sh).forEach(function (k) { const px = priceOf(k)[d]; if (P.sh[k] > 1e-12 && px > 0 && !(skip && skip[k])) o[k] = P.sh[k] * px; }); return o; };
    const value = function (d) { const o = pos(d); return Object.keys(o).reduce(function (m, k) { return m + o[k]; }, P.cash); };
    const sell = function (k, f, d) { const px = priceOf(k)[d], have = P.sh[k] || 0; if (have > 0 && px > 0) { P.cash += have * f * px; P.sh[k] = have * (1 - f); } };
    const spread = function (d, fixed) {
      if (!(P.cash > 1e-12)) return;
      let o = pos(d, fixed);
      if (!Object.keys(o).length) o = pos(d);
      const tot = Object.keys(o).reduce(function (m, k) { return m + o[k]; }, 0);
      if (!(tot > 0)) return;
      Object.keys(o).forEach(function (k) { P.sh[k] += P.cash * o[k] / tot / priceOf(k)[d]; });
      P.cash = 0;
    };
    let started = false;
    for (let d = 0; d < n; d++) {
      const fixed = {};
      (ev[d] || []).slice().sort(function (a, b) { return a.pr - b.pr; }).forEach(function (e) {
        if (e.t === "dep") { P.cash += e.amt; flow[d] += e.amt; started = true; }
        else if (e.t === "sale") {
          const c0 = P.cash;
          sell(e.key, e.f, d); fixed[e.key] = 1;
          if (e.out) { flow[d] -= P.cash - c0; P.cash = c0; }
        }
        else if (e.t === "target") {
          const ks = Object.keys(e.w).filter(function (k) { return priceOf(k)[d] > 0; }), tw = ks.reduce(function (m, k) { return m + e.w[k]; }, 0);
          if (!(tw > 0)) return;
          const V = value(d);
          P.sh = {};
          ks.forEach(function (k) { P.sh[k] = V * e.w[k] / tw / priceOf(k)[d]; });
          P.cash = 0;
        } else if (e.t === "order") {
          const px = priceOf(e.key)[d];
          if (!(px > 0) || !(e.v * e.k > 0)) return;
          const cur = (P.sh[e.key] || 0) * px, want = e.mode === "weight" ? Math.max(0, e.v * e.k * value(d) - cur) : e.v * e.k;
          if (e.mode === "weight") {
            fixed[e.key] = 1;
            if (full && want > P.cash) {
              const o = pos(d, { [e.key]: 1 }), others = Object.keys(o).reduce(function (m, k) { return m + o[k]; }, 0);
              if (others > 0) { const f = Math.min(1, (want - P.cash) / others); Object.keys(o).forEach(function (k) { sell(k, f, d); }); }
            }
          }
          const buy = Math.min(P.cash, want);
          if (buy > 1e-12) { P.sh[e.key] = (P.sh[e.key] || 0) + buy / px; P.cash -= buy; }
          const v = value(d);
          wAt[e.id] = v > 0 ? (P.sh[e.key] || 0) * px / v : 0;
          mAt[e.id] = { stock: (P.sh[e.key] || 0) * px, value: v, bought: buy > 1e-12 ? buy : 0, target: e.v * e.k, date: dates[d], price: px, ref: e.b0 != null ? priceOf(e.key)[e.b0] : null }; // what the stock is worth in the portfolio after the order, and the portfolio, in your currency
        }
      });
      if (full && started) spread(d, fixed);
      val[d] = started ? value(d) : null;
      if (sample[d] != null && started) snaps[d] = { cash: P.cash, stocks: pos(d) };
    }
    return { val: val, flow: flow, snaps: snaps, wAt: wAt, mAt: mAt };
  }

  // value series and cash flows -> a time-weighted index of 100 on the first funded day (null before it)
  function indexOf(sim) {
    const n = sim.val.length, out = new Array(n).fill(null);
    let idx = 100, prev = null;
    for (let d = 0; d < n; d++) {
      const v = sim.val[d];
      if (v == null) continue;
      if (prev != null && prev > 0) idx *= (v - sim.flow[d]) / prev;
      out[d] = idx; prev = v;
    }
    return out;
  }

  function agentPortfolios(tc, lc, rulesBy, aiBy, aiList, ctx) {
    const bench = ctx.bench, att = ctx.att || { by: {} };
    if (!bench.length) return null;
    const dayOf = function (date) { const i = dateIdx(bench, date); return i; };
    const cache = {}, priceOf = function (key) { return cache[key] || (cache[key] = new Array(bench.length).fill(null)); };
    // prices in your currency at each day's rate (as is when a rate is missing); each portfolio is valued in it
    const toBase = ctx.toBase || function () { return 1; };
    const load = function (key, series, ccy) {
      if (!series || !series.length || cache[key]) return;
      const arr = priceOf(key), c = ccy || series.currency || null;
      let p = -1;
      for (let d = 0; d < bench.length; d++) {
        while (p + 1 < series.length && series[p + 1].date <= bench[d].date) p++;
        const r = p >= 0 ? toBase(c, bench[d].date) : null;
        arr[d] = p >= 0 ? series[p].close * (r != null ? r : 1) : null;
      }
    };
    // the money of a buy in your currency on its day
    const money = function (c) { const r = toBase(c.currency, c.series[c.i0].date); return c.amount * (r != null ? r : 1); };
    load("__nasdaq__", bench, bench.currency || "USD");
    const dts = bench.map(function (b) { return b.date; });
    const sampleOf = function (d0) {
      const s = {}, out = [];
      for (let d = d0; d < bench.length; d++) if (d === bench.length - 1 || bench[d].date.slice(0, 7) !== bench[d + 1].date.slice(0, 7)) { s[d] = out.length; out.push(d); }
      return { at: s, days: out };
    };
    const names = { __nasdaq__: "NASDAQ" };
    const pack = function (d0, sims) {
      const sm = sampleOf(d0), dates = bench.slice(d0).map(function (b) { return b.date; });
      const lines = {}, holdings = { dates: sm.days.map(function (d) { return bench[d].date; }) };
      Object.keys(sims).forEach(function (k) {
        if (!sims[k]) { lines[k] = null; holdings[k] = null; return; }
        lines[k] = indexOf(sims[k]).slice(d0);
        holdings[k] = sm.days.map(function (d) {
          const s = sims[k].snaps[d], tot = sims[k].val[d] || 0, o = { stocks: {}, rest: 0 };
          if (!s || !(tot > 0)) return o;
          Object.keys(s.stocks).forEach(function (key) { const nm = names[key] || key; o.stocks[nm] = (o.stocks[nm] || 0) + s.stocks[key] / tot; });
          o.rest = s.cash / tot;
          return o;
        });
      });
      return { dates: dates, lines: lines, holdings: holdings };
    };

    // ----- your trades -----
    let trades = null;
    // your savings-plan buys are no decision for the agents, but they are part of your holdings: every portfolio makes them,
    // at your weight, so the positions (and your sales' shares of them) are the ones you had
    const plans = [], seenPlan = {}, now = Date.now();
    ctx.R.decisions.forEach(function (d) {
      if (d.side !== "buy" || !d.auto || d.excluded === "asset class" || !eligible(d) || d.cut > now || !(d.amount > 0)) return;
      const s = ctx.seriesOfInst(d.inst);
      if (!s || !s.length || s[0].date > d.date) return;
      const i0 = dateIdx(s, d.date);
      if (i0 >= 0) plans.push({ id: uniqueId(seenPlan, "p" + hash(d.inst + "|" + d.ts)), kind: "plan", ticker: d.ticker || null, inst: d.inst, ts: d.ts, amount: d.amount, currency: d.currency, series: s, i0: i0 });
    });
    // a buy before the NASDAQ series starts has no day of its own: it is left out (and counted), never bought at a later price
    const early = tc.concat(plans).filter(function (c) { return c.amount > 0 && c.series && c.series[c.i0].date < bench[0].date; }).length;
    const buys = tc.concat(plans).filter(function (c) { return c.amount > 0 && c.series && c.series[c.i0].date >= bench[0].date && dayOf(c.series[c.i0].date) >= 0; }).sort(function (a, b) { return a.ts - b.ts; });
    if (buys.length) {
      const d0 = Math.min.apply(null, buys.map(function (c) { return dayOf(c.series[c.i0].date); })), n = bench.length, sm = sampleOf(d0).at;
      const mk = function () { return new Array(n); };
      const evs = { you: mk(), rules: mk(), ai: mk(), nasdaq: mk() };
      const push = function (who, d, e) { (evs[who][d] = evs[who][d] || []).push(e); };
      const salesOf = {};
      ctx.R.decisions.forEach(function (d) { if (d.side === "sell" && d.posBefore > 0) (salesOf[d.inst] = salesOf[d.inst] || []).push(d); });
      const hasAi = buys.some(function (c) { return aiBy[c.id]; });
      const soldKeys = {}, plan = [];
      buys.forEach(function (c) {
        const key = c.inst || c.ticker, b0 = dayOf(c.series[c.i0].date);
        load(key, c.series);
        if (c.ticker) names[key] = c.ticker;
        const sales = (salesOf[c.inst] || []).filter(function (s) { return s.ts > c.ts; }).map(function (s) { return { at: dayOf(s.date), f: Math.min(1, s.qty / s.posBefore) }; }).filter(function (x) { return x.at >= 0; });
        if (!soldKeys[key]) { soldKeys[key] = 1; sales.forEach(function (s) { ["you", "rules", "ai"].forEach(function (w) { push(w, s.at, { t: "sale", pr: 2, key: key, f: s.f, out: true }); }); }); }
        const amt = money(c);
        ["you", "rules", "ai", "nasdaq"].forEach(function (w) { push(w, b0, { t: "dep", pr: 0, amt: amt }); });
        push("nasdaq", b0, { t: "order", pr: 1, key: "__nasdaq__", mode: "amount", v: amt, k: 1, id: "n" + c.id });
        push("you", b0, { t: "order", pr: 1, key: key, mode: "amount", v: amt, k: 1, id: "you" + c.id });
        plan.push({ c: c, key: key, b0: b0, sales: sales });
      });
      // your weights first: the agents' sizes are shares of them
      const you = simulate(dts, priceOf, evs.you, sm, true);
      plan.forEach(function (p) {
        const c = p.c, wYou = you.wAt["you" + c.id] || 0;
        const place = function (who, dec) {
          if (!dec || dec.action === "pass") return;
          const eb = dec.days ? (c.i0 + dec.days < c.series.length ? dayOf(c.series[c.i0 + dec.days].date) : -1) : p.b0;
          if (eb < 0) return;
          let pend = 1;
          p.sales.forEach(function (s) { if (s.at < eb || (s.at === eb && eb !== p.b0)) pend *= 1 - s.f; });
          const w = who === "ai" && dec.sizeUnit === "weight" ? dec.weight : wYou * dec.size;
          push(who, eb, { t: "order", pr: eb === p.b0 ? 1 : 3, key: p.key, mode: "weight", v: w, k: pend, id: who + c.id, b0: p.b0 });
        };
        const follow = { action: "buy", days: 0, size: 1 };
        place("rules", c.kind === "plan" ? follow : rulesBy[c.id]);
        place("ai", hasAi && aiBy[c.id] ? aiBy[c.id] : follow);
      });
      const sims = { you: you, rules: simulate(dts, priceOf, evs.rules, sm, true),
        ai: hasAi ? simulate(dts, priceOf, evs.ai, sm, true) : null, nasdaq: simulate(dts, priceOf, evs.nasdaq, sm, false) };
      trades = pack(d0, sims);
      trades.money = { rules: sims.rules.mAt, ai: sims.ai ? sims.ai.mAt : null };
      trades.unit = "share of the portfolio";
      trades.beforeBench = early;
    }

    // ----- your looks: a virtual portfolio of 100 each -----
    let attention = null;
    const looks = lc.filter(function (c) { return c.series && dayOf(c.series[c.i0].date) >= 0 && c.ticker; }).sort(function (a, b) { return a.t - b.t; });
    if (looks.length) {
      const n = bench.length, d0 = Math.min.apply(null, looks.map(function (c) { return dayOf(c.series[c.i0].date); }));
      const evs = { att: new Array(n), rules: new Array(n), ai: new Array(n), nasdaq: new Array(n) }, push = function (who, d, e) { (evs[who][d] = evs[who][d] || []).push(e); };
      const hasAi = Object.keys(aiBy).length > 0 || (aiList || []).some(function (d) { return d.kind === "revisit"; });
      ["att", "rules", "ai", "nasdaq"].forEach(function (w) { push(w, d0, { t: "dep", pr: 0, amt: 100 }); });
      push("nasdaq", d0, { t: "order", pr: 1, key: "__nasdaq__", mode: "amount", v: 100, k: 1, id: "n0" });
      const eps = {};
      looks.forEach(function (c) {
        load(c.ticker, c.series);
        names[c.ticker] = c.ticker;
        (eps[c.ticker] = eps[c.ticker] || []).push(c);
        const a = aiBy[c.id];
        if (!a || a.action === "pass") return;
        const i = c.i0 + (a.days || 0);
        if (i >= c.series.length) return;
        const eb = dayOf(c.series[i].date);
        if (eb >= 0) push("ai", eb, { t: "order", pr: 3, key: c.ticker, mode: "weight", v: weightOf(a), k: 1, id: "ai" + c.id });
      });
      // the baskets: views in the window up to LOOK_LAG days before each close; the rules agent's only from the day it entered
      const tks = Object.keys(eps), at = {}, lastA = { att: null, rules: null };
      tks.forEach(function (tk) { at[tk] = -1; });
      for (let d = d0; d < n; d++) {
        const t0 = D.usClose(bench[d].date) - LOOK_LAG * DAY, wa = {}, wr = {};
        let na = 0, nr = 0;
        tks.forEach(function (tk) {
          const v = viewCount(att, tk, t0 - LOOK_WINDOW * DAY, t0);
          if (!v) return;
          wa[tk] = v; na++;
          const E = eps[tk];
          while (at[tk] + 1 < E.length && E[at[tk] + 1].t < t0) at[tk]++;
          const c = at[tk] >= 0 ? E[at[tk]] : null, r = c && rulesBy[c.id];
          if (!r || r.action === "pass" || !(r.size > 0)) return;
          const i = c.i0 + (r.days || 0);
          if (i >= c.series.length || bench[d].date < c.series[i].date) return;
          wr[tk] = v * r.size; nr++;
        });
        if (na) lastA.att = wa;
        if (nr) lastA.rules = wr;
        if (lastA.att) push("att", d, { t: "target", pr: 4, w: lastA.att });
        if (lastA.rules) push("rules", d, { t: "target", pr: 4, w: lastA.rules });
      }
      // the AI agent's repeat-view decisions: sell a share of the position, or buy up to a weight
      (aiList || []).forEach(function (r) {
        if (!r || r.kind !== "revisit" || !r.ticker || (r.action !== "sell" && r.action !== "buy")) return;
        const s = ctx.seriesOfTicker(r.ticker);
        if (!s || !s.length) return;
        load(r.ticker, s);
        names[r.ticker] = r.ticker;
        const d = dayOf(nyDate(r.t));
        if (d < 0) return;
        if (r.action === "sell") push("ai", d, { t: "sale", pr: 2, key: r.ticker, f: Math.max(0, Math.min(1, +r.size || 0)) });
        else push("ai", d, { t: "order", pr: 3, key: r.ticker, mode: "weight", v: weightOf(r), k: 1, id: "ai" + r.id });
      });
      const sm = sampleOf(d0).at;
      const sims = { att: simulate(dts, priceOf, evs.att, sm, true), rules: simulate(dts, priceOf, evs.rules, sm, true),
        ai: hasAi ? simulate(dts, priceOf, evs.ai, sm, true) : null, nasdaq: simulate(dts, priceOf, evs.nasdaq, sm, false) };
      attention = pack(d0, sims);
      attention.unit = "share of the portfolio";
    }
    return { trades: trades, attention: attention, lookWindow: LOOK_WINDOW, lookLag: LOOK_LAG, currency: ctx.base || null };
  }

  // ---------- portfolio 2: your looks, unit positions ----------

  function line(pos, seed) {
    const xs = pos.map(function (p) { return p.ex; });
    const ci = boot(xs, seed);
    let cum = 0;
    const cumOut = [];
    pos.slice().sort(function (a, b) { return a.exit < b.exit ? -1 : a.exit > b.exit ? 1 : 0; }).forEach(function (p) {
      cum += p.ex;
      if (cumOut.length && cumOut[cumOut.length - 1].date === p.exit) cumOut[cumOut.length - 1].value = cum;
      else cumOut.push({ date: p.exit, value: cum });
    });
    return { n: xs.length, mean: ci.est, lo: ci.lo, hi: ci.hi, hit: xs.length ? xs.filter(function (x) { return x > 0; }).length / xs.length : null, cum: cumOut };
  }
  function position(series, i, size, H, bench) {
    if (i < 0 || i + H >= series.length) return null;
    const f = D.forward(series, bench, series[i].date, H);
    return f ? { ex: size * f.ex, exit: series[i + H].date, from: series[i].date, size: size } : null;
  }
  // The AI agent's looks with its own selling logic and no fixed holding period: a bought look opens a
  // position (size, on its entry bar); each repeat-view decision may sell a share of the whole position
  // at that day's close (the parts sold leave then) or buy more; what is left is marked to the last
  // close. Each closed or open part is one position of excess return against the NASDAQ, exiting on
  // the day it was sold, or on the last day while open.
  function sellLogicPositions(cands, aiBy, aiList, ctx) {
    const by = {}, out = [];
    cands.forEach(function (c) {
      const dec = aiBy[c.id];
      if (!dec || dec.action === "pass" || !c.ticker) return;
      const i = c.i0 + (dec.days || 0);
      if (i < 0 || i >= c.series.length) return;
      (by[c.ticker] = by[c.ticker] || { series: c.series, ev: [] }).ev.push({ t: c.t, open: { i: i, size: dec.size } });
    });
    (aiList || []).forEach(function (d) {
      if (!d || d.kind !== "revisit" || !d.ticker || (d.action !== "sell" && d.action !== "buy")) return;
      const g = by[d.ticker] || { series: ctx.seriesOfTicker(d.ticker), ev: [] };
      if (!g.series || !g.series.length) return;
      by[d.ticker] = g;
      const j = dateIdx(g.series, nyDate(d.t));
      if (j < 0) return; // its day has no close yet
      g.ev.push({ t: d.t, rev: { j: j, action: d.action, size: Math.max(0, Math.min(1, +d.size || 0)) } });
    });
    const exBetween = function (s, i, j) {
      const c0 = s[i].close, c1 = s[j].close, b0 = closeOnOrBefore(ctx.bench, s[i].date), b1 = closeOnOrBefore(ctx.bench, s[j].date);
      return c0 > 0 && b0 > 0 && b1 != null ? c1 / c0 - b1 / b0 : null;
    };
    Object.keys(by).forEach(function (tk) {
      const g = by[tk], s = g.series, trs = [];
      g.ev.sort(function (a, b) { return a.t - b.t; }).forEach(function (e) {
        if (e.open) trs.push({ i: e.open.i, size: e.open.size });
        else if (e.rev.action === "buy") { if (e.rev.size > 0) trs.push({ i: e.rev.j, size: e.rev.size }); }
        else trs.forEach(function (tr) {
          if (tr.size <= 0 || tr.i > e.rev.j) return;
          const part = tr.size * e.rev.size, x = tr.i < e.rev.j ? exBetween(s, tr.i, e.rev.j) : 0;
          tr.size -= part;
          if (x != null && part > 0 && tr.i < e.rev.j) out.push({ ex: part * x, exit: s[e.rev.j].date, from: s[tr.i].date, size: part, ticker: tk });
        });
      });
      const last = s.length - 1;
      trs.forEach(function (tr) {
        if (tr.size <= 0 || tr.i >= last) return;
        const x = exBetween(s, tr.i, last);
        if (x != null) out.push({ ex: tr.size * x, exit: s[last].date, open: true, from: s[tr.i].date, size: tr.size, ticker: tk });
      });
    });
    return out;
  }

  function looksLines(cands, rulesBy, aiBy, ctx, aiList) {
    const out = {}, hasAi = Object.keys(aiBy).length > 0;
    const sellPos = hasAi ? sellLogicPositions(cands, aiBy, aiList, ctx) : null, aiSell = sellPos ? line(sellPos, 1101) : null;
    LOOK_HS.forEach(function (H) {
      const every = [], rules = [], ai = [], bought = [];
      const agent = function (c, dec, into) { if (!dec || dec.action === "pass") return; const p = position(c.series, c.i0 + (dec.days || 0), dec.size, H, ctx.bench); if (p) into.push(Object.assign(p, { ticker: c.ticker })); };
      cands.forEach(function (c) {
        const p = position(c.series, c.i0, 1, H, ctx.bench);
        if (p) every.push(Object.assign(p, { ticker: c.ticker }));
        agent(c, rulesBy[c.id], rules);
        if (hasAi) agent(c, aiBy[c.id], ai);
        if (c.bought) { const q = position(c.series, dateIdx(c.series, c.bought.date), 1, H, ctx.bench); if (q) bought.push(Object.assign(q, { ticker: c.ticker })); }
      });
      out[H] = { every: line(every, 701 + H), rules: line(rules, 801 + H), ai: hasAi ? line(ai, 901 + H) : null, aiSell: aiSell, bought: line(bought, 1001 + H), nasdaq: { n: 0, mean: 0, lo: 0, hi: 0, hit: null, cum: [] },
        positions: { every: every, rules: rules, ai: hasAi ? ai : null, aiSell: sellPos, bought: bought } };
    });
    return out;
  }

  // ---------- facts (ratios only) ----------

  function pc(x) { return x == null ? "-" : Math.round(x * 100) + "%"; }
  function pts(x) { return x == null ? "-" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + " pts"; }
  function rng(ci) { return ci && ci.lo != null ? " [" + pts(ci.lo) + ", " + pts(ci.hi) + "]" : ""; }
  function factsOf(res) {
    const f = [], T = res.trades, L = res.looks, P = T.portfolio;
    if (P) {
      const i = P.dates.length - 1;
      f.push("Your trades (" + T.candidates.length + " buys), value on the last day as a share of the money put in: you " + pc(P.you[i]) + ", rules agent " + pc(P.rules[i]) +
        (P.ai ? ", AI agent " + pc(P.ai[i]) + " (it decided " + pc(T.coverage) + " of the buys; the rest follow you)" : "") + ", NASDAQ " + pc(P.nasdaq[i]) + ". " + NOTE_FX);
    }
    HS.forEach(function (h) {
      const p = T.paired[h];
      if (p.rules.n) f.push("Rules agent minus you over " + h + " trading days, per buy: " + pts(p.rules.diff.est) + rng(p.rules.diff) + " (99%), " + p.rules.n + " buys.");
      if (p.ai && p.ai.n) f.push("AI agent minus you over " + h + " trading days, per buy it decided: " + pts(p.ai.diff.est) + rng(p.ai.diff) + " (99%), " + p.ai.n + " buys.");
    });
    const acts = { buy: 0, wait: 0, pass: 0 };
    T.rules.forEach(function (r) { acts[r.action]++; });
    f.push("The rules agent bought " + acts.buy + " of your buys at once, waited on " + acts.wait + " and passed on " + acts.pass + ".");
    const ba = T.beforeAfter;
    if (ba.appStart != null && ba.enough) {
      const x = ba.horizons[63];
      f.push("Gap (rules agent minus you) over 63 days: " + pts(x.before.gap.est) + " before the bias features launched (" + x.before.n + " buys), " + pts(x.after.gap.est) + " after (" + x.after.n + "); change " + pts(x.change.est) + rng(x.change) + ". " + NOTE_BA);
    } else if (ba.appStart != null) f.push("Not enough buys before and after the bias features launched to compare them.");
    const l = L.horizons[63];
    if (l.every.n) f.push("Your looks (" + L.candidates.length + "), unit positions held 63 trading days, mean excess vs the NASDAQ: every look " + pts(l.every.mean) + rng(l.every) + " (" + l.every.n + ")" +
      ", rules agent " + pts(l.rules.mean) + " (" + l.rules.n + ")" + (l.ai ? ", AI agent " + pts(l.ai.mean) + " (" + l.ai.n + ")" : "") + ", what you bought within 30 days of a look " + pts(l.bought.mean) + " (" + l.bought.n + ").");
    const live = T.ai.concat(L.ai).filter(function (d) { return d.live != null; });
    if (live.length) f.push("AI decisions: " + live.filter(function (d) { return d.live; }).length + " live, " + live.filter(function (d) { return !d.live; }).length + " decided after the fact (the model may know what happened next).");
    return f;
  }

  // ---------- main ----------

  function run(o) {
    const R = o.R, input = o.input, now = o.now || input.now || Date.now();
    const ctx = context(R, input, o.community || input.community || null);
    const seen = {}, tc = tradeCandidates(R, ctx, now, seen), lc = lookCandidates(R, ctx, now, seen);
    const all = tc.concat(lc);
    const months = [];
    if (all.length) {
      const lo = all.reduce(function (m, c) { return Math.min(m, c.t); }, Infinity), hi = all.reduce(function (m, c) { return Math.max(m, c.t); }, -Infinity);
      for (let m = monthStart(lo); m <= hi; m = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1, 1)) months.push(m);
    }
    // the snapshots are the costly part; kept on the (cached) context for the same months
    const mk = months.join();
    if (!ctx.snaps || ctx.snaps.key !== mk) ctx.snaps = { key: mk, list: snapshots(R, months, ctx) };
    const snaps = withAdopted(ctx.snaps.list, o.commitments);
    const aiBy = normAi(o.aiDecisions);
    const rulesBy = {};
    const decideAll = function (cands) {
      return cands.map(function (c) { const snap = snapshotAt(snaps, c.t), d = decide(c, snap, ctx); rulesBy[c.id] = d; return record(c, d, snap, ctx); });
    };
    const aiRecs = function (cands) { return cands.filter(function (c) { return aiBy[c.id]; }).map(function (c) { return record(c, aiBy[c.id], snapshotAt(snaps, c.t), ctx); }); };
    const tr = decideAll(tc), lr = decideAll(lc), ta = aiRecs(tc), la = aiRecs(lc);
    const hasAi = Object.keys(aiBy).length > 0;
    const paired = {};
    HS.forEach(function (h) {
      const ai = ta.length ? pairedStats(ta, h, 211 + h) : null;
      if (ai) ai.coverage = tc.length ? ta.length / tc.length : null;
      paired[h] = { h: h, n: tr.filter(function (r) { return r.ex[h]; }).length, you: S.mean(tr.filter(function (r) { return r.ex[h]; }).map(function (r) { return r.ex[h].you; })), rules: pairedStats(tr, h, 111 + h), ai: ai };
    });
    const waits = {};
    tr.concat(lr).forEach(function (r) { if (r.action === "wait") r.rules.forEach(function (id) { (waits[id] = waits[id] || []).push(r.days); }); });
    Object.keys(waits).forEach(function (id) { waits[id] = S.median(waits[id]); });
    // The split between "before" and "after" is the moment the bias features launched
    // (input.biasLaunch, set by the page); without one, the first view not from a history import.
    let appStart = null;
    if (typeof input.biasLaunch === "number") appStart = input.biasLaunch;
    else (input.intraday || []).forEach(function (e) { if (e && e.ts && e.source !== "history" && (appStart == null || e.ts < appStart)) appStart = e.ts; });
    const res = {
      snapshots: snaps,
      trades: { candidates: tc, rules: tr, ai: ta, coverage: ta.length && tc.length ? ta.length / tc.length : null, portfolio: portfolio(tc, rulesBy, aiBy, ctx), paired: paired,
        waitDays: waits, beforeAfter: beforeAfter(tr, appStart, R, o.coach), appStart: appStart },
      looks: { candidates: lc, rules: lr, ai: la, coverage: hasAi && lc.length ? la.length / lc.length : null, horizons: looksLines(lc, rulesBy, aiBy, ctx, o.aiDecisions) },
      agents: agentPortfolios(tc, lc, rulesBy, aiBy, o.aiDecisions, ctx)
    };
    res.facts = factsOf(res);
    return res;
  }

  // What the looks lines held at every month end and on the last day: per line, the open positions per stock, as
  // unit positions (a look is one unit; an agent's share is its size). positions: { line: [{ from, exit, size, ticker, open? }] }.
  // A position is held from its entry day up to, not including, its exit day (an open one up to and including the last close).
  function looksHoldings(positions) {
    const all = [];
    Object.keys(positions || {}).forEach(function (k) { (positions[k] || []).forEach(function (p) { all.push(p); }); });
    if (!all.length) return { dates: [], unit: "unit positions", lines: {} };
    const lo = all.reduce(function (m, p) { return p.from < m ? p.from : m; }, "9999"), hi = all.reduce(function (m, p) { return p.exit > m ? p.exit : m; }, "0000"), dates = [];
    for (let y = +lo.slice(0, 4), m = +lo.slice(5, 7); ; ) {
      const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      if (last >= hi) { dates.push(hi); break; }
      if (last >= lo) dates.push(last);
      if (++m > 12) { m = 1; y++; }
    }
    const lines = {};
    Object.keys(positions).forEach(function (k) {
      if (!positions[k]) return;
      lines[k] = dates.map(function (D) {
        const stocks = {};
        positions[k].forEach(function (p) { if (p.from <= D && (p.open ? D <= p.exit : D < p.exit)) { const tk = p.ticker || "untracked"; stocks[tk] = (stocks[tk] || 0) + (p.size == null ? 1 : p.size); } });
        return { stocks: stocks, nasdaq: 0 };
      });
    });
    return { dates: dates, unit: "unit positions", lines: lines };
  }

  // ---------- comparing models on the same moments ----------

  // rows: [{ id, kind, rules, original, text, decision }], each a decision { action, days, size, ex? } or null, or { unsure: true } when the model was not sure enough to decide:
  // the rules agent at that moment, the AI agent's saved decision, and the reruns by the text model and the decision model.
  // ex (ATShadow.outcome) is the excess against the NASDAQ { 21|63|126: { you, agent } } when the prices reach that far.
  // Returns what each engine decided, how often they agree, and (where outcomes exist) how they did. Pure.
  function compareRuns(rows, h) {
    h = h || 21;
    const KEYS = ["rules", "original", "text", "decision"];
    const per = {};
    KEYS.forEach(function (k) {
      const o = { n: 0, unsure: 0, actions: { buy: 0, wait: 0, pass: 0, hold: 0, sell: 0 }, meanSize: null, meanOdds: null };
      const sizes = [], conf = [];
      rows.forEach(function (r) {
        const d = r[k];
        if (!d) return;
        if (d.unsure) { o.unsure++; return; }
        o.n++;
        if (o.actions[d.action] != null) o.actions[d.action]++;
        if (d.action === "buy" || d.action === "wait") sizes.push(d.size == null ? 1 : d.size);
        if (d.trace && d.trace.odds) conf.push(d.trace.odds[d.action]);
      });
      o.meanSize = sizes.length ? S.mean(sizes) : null;
      o.meanOdds = conf.filter(function (x) { return x != null; }).length ? S.mean(conf.filter(function (x) { return x != null; })) : null;
      per[k] = o;
    });
    const agree = function (a, b) {
      let n = 0, same = 0, sameAll = 0;
      rows.forEach(function (r) {
        const x = r[a], y = r[b];
        if (!x || !y || x.unsure || y.unsure) return;
        n++;
        if (x.action === y.action) { same++; if (Math.abs((x.size || 0) - (y.size || 0)) < 1e-9 && (x.days || 0) === (y.days || 0)) sameAll++; }
      });
      return { n: n, same: same, sameShare: n ? same / n : null, sameActionSizeAndDays: sameAll };
    };
    const matrix = {};
    rows.forEach(function (r) { if (r.text && r.decision && !r.text.unsure && !r.decision.unsure) { const k = r.text.action + " | " + r.decision.action; matrix[k] = (matrix[k] || 0) + 1; } });
    const outcome = { h: h };
    KEYS.concat(["you"]).forEach(function (k) {
      const xs = rows.map(function (r) { const d = k === "you" ? (r.original || r.text || r.decision || r.rules) : r[k]; return d && d.ex && d.ex[h] ? (k === "you" ? d.ex[h].you : d.ex[h].agent) : null; }).filter(function (x) { return x != null; });
      outcome[k] = { n: xs.length, mean: xs.length ? S.mean(xs) : null };
    });
    return { moments: rows.length, per: per, matrix: matrix, outcome: outcome, agreement: { textVsDecision: agree("text", "decision"), textVsRules: agree("text", "rules"), decisionVsRules: agree("decision", "rules"),
      textVsOriginal: agree("text", "original"), decisionVsOriginal: agree("decision", "original") },
      note: "A rerun is decided after the fact: the models may know what happened next. Agreement shows how alike the engines are; only outcomes (mean excess against the NASDAQ) show which does better, and those need " + h + " trading days of prices after the moment." };
  }

  // ---------- what the AI agent sees about one candidate ----------

  // Notes as they may leave: e-mails, links, ids, long numbers and dates out; the
  // stock's own ticker and name as its alias, other known tickers and their names as
  // "another stock" (names in any case).
  function cleanNote(s, own, alias, ctx, names, nameOf) {
    let x = String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim()
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/\bhttps?:\/\/[^\s,;)]+/gi, "[link]").replace(/\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b/g, "[id]")
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "[date]").replace(/\d[\d.,' ]{3,}\d/g, "[number]");
    if (!names) {
      const esc = function (t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
      const sub = function (t, by, fl) { if (t && String(t).length >= 2) x = x.replace(new RegExp("(^|[^A-Za-z0-9])" + esc(t) + "(?![A-Za-z0-9])", fl || "g"), function (_, pre) { return pre + by; }); };
      const byLen = function (a, b) { return String(b).length - String(a).length; };
      // company names in any case first (the own one as the alias), then the tickers as written
      const nm = {};
      ctx.tickers.concat([own]).forEach(function (t) { const n = nameOf(t); if (n && (!nm[n] || t === own)) nm[n] = t === own ? alias : "another stock"; });
      Object.keys(nm).sort(byLen).forEach(function (n) { sub(n, nm[n], "gi"); });
      ctx.tickers.slice().sort(byLen).forEach(function (t) { sub(t, t === own ? alias : "another stock"); });
    }
    return x.slice(0, 200);
  }

  function contextFor(cand, R, input, snapshot, o) {
    o = o || {};
    const ctx = context(R, input, o.community);
    const names = o.names === true, tk = cand.ticker;
    const nameOf = function (t) { return o.nameOf ? o.nameOf(t) : ctx.names[t] || null; };
    const alias = names ? String(tk) : o.alias ? o.alias(tk) : "Stock " + (ctx.aliasNo[tk] || 0);
    const f = featuresAt(cand, 0, ctx) || {}, s = cand.series, t = cand.t;
    const out = { id: cand.id, kind: cand.kind, stock: alias };
    if (names && nameOf(tk)) out.company = nameOf(tk);
    out.date = names ? cand.date : "day " + Math.floor((t - (ctx.t0 != null ? ctx.t0 : t)) / DAY);
    if (cand.kind === "trade") { out.side = "buy"; out.sizeVsUsualBuy = r1(cand.relSize); }
    if (cand.hour != null) out.hourOfDay = cand.hour;
    const ib = D.barBefore(s, cand.date), path = [];
    if (ib >= 0) for (let j = ib - 60; j < ib; j += 5) if (j >= 0) path.push(pct1(s[j].close / s[ib].close - 1));
    out.pricePath = path;
    out.runup30 = pct1(f.runup);
    const h52 = I && I.high52 ? I.high52(s, cand.date) : null;
    out.fromHigh52 = h52 && h52.hi > 0 ? pct1(h52.close / h52.hi - 1) : null;
    out.market = { volPercentile: f.pVol != null ? Math.round(f.pVol * 100) : null, ret20Percentile: f.pRet != null ? Math.round(f.pRet * 100) : null, drawdown: pct1(f.dd) };
    if (f.views30 != null) {
      const w = viewsIn(ctx.att, tk, t - 30 * DAY, t);
      out.research = { viewsBefore30d: w.n, minutesBefore30d: r1(w.minutes), daysSinceFirstLook: cand.firstAtt != null && cand.firstAtt <= t ? r1((t - cand.firstAtt) / DAY) : null, pageTypes: w.types };
    } else out.research = null;
    out.calls = (input.events || []).filter(function (e) { return e.ticker === tk && e.ts < t && t - e.ts <= 365 * DAY && (e.sentiment === "positive" || e.sentiment === "negative" || e.sentiment === "neutral"); })
      .sort(function (a, b) { return b.ts - a.ts; }).slice(0, 5).map(function (e) {
        const px = e.priceAtEvent > 0 ? e.priceAtEvent : closeOnOrBefore(s, S.isoDay(e.ts));
        const c = { sentiment: e.sentiment, daysBefore: r1((t - e.ts) / DAY) };
        if (e.targetPrice > 0 && px > 0) c.targetVsPricePct = pct1(e.targetPrice / px - 1);
        if (e.horizonDays) c.horizonDays = e.horizonDays;
        if (e.rationale) c.note = cleanNote(e.rationale, tk, alias, ctx, names, nameOf);
        return c;
      });
    if (f.crowd != null) out.crowd = { ratio: r1(f.crowd), hot: !!f.crowdHot };
    if (cand.kind === "revisit") out.revisit = { views3d: cand.burst.views3d, usualViews3d: cand.burst.usualViews3d, position: { holding: cand.position.holding, size: cand.position.size, canSell: cand.position.canSell !== false }, sinceEntryPct: cand.position.sinceEntryPct };
    const er = input.earnings && input.earnings[tk];
    if (er && er.length) {
      const ds = er.map(function (r) { return Array.isArray(r) ? r[0] : r && r.day ? r.day : r; }).filter(function (d) { return typeof d === "string"; }).sort();
      const next = ds.find(function (d) { return d >= cand.date; }), last = ds.filter(function (d) { return d < cand.date; }).pop();
      out.earnings = { daysToNext: next ? Math.round((dayMs(next) - dayMs(cand.date)) / DAY) : null, daysSinceLast: last ? Math.round((dayMs(cand.date) - dayMs(last)) / DAY) : null };
    }
    // the rules' wording from the decisions before t only (no market figures of the whole period)
    const Rt = { decisions: R.decisions.filter(function (d) { return d.cut < t; }) };
    out.rulesThen = (snapshot ? snapshot.rules : []).map(function (a) {
      const rule = B.ruleById(a.ruleId);
      return rule ? { rule: rule.text(withExtra(rule, a.params, Rt), Rt), verdict: a.verdict, meanPts: r1(a.mean * 100) } : null;
    }).filter(Boolean);
    const prior = Rt.decisions.filter(function (d) { return d.side === "buy" && !d.auto; }), cov = prior.filter(function (d) { return !d.excluded; });
    const known = cov.filter(function (d) { return d.fwd && d.fwd[21] && d.fwd[21].end <= t; });
    out.yourRecordThen = { buys: prior.length, researchedShare: cov.length ? r1(cov.filter(function (d) { return d.views30 > 0; }).length / cov.length * 100) : null,
      impulseShare: cov.length ? r1(cov.filter(function (d) { return !d.dateOnly && d.firstAtt != null && d.cut - d.firstAtt < 3600000; }).length / cov.length * 100) : null,
      meanExcess21: known.length ? pct1(S.mean(known.map(function (d) { return d.fwd[21].ex; }))) : null };
    // what weight your own buy gives the position in your depot (only for a moment of the last 2 days: the depot's latest value would be look-ahead for an older one; the model chooses its own final weight with this in view)
    const dv = R.ind && R.ind.diversification, last = dv && dv.holdings && dv.holdings.last;
    if (cand.kind === "trade" && cand.amount > 0 && (input.now || Date.now()) - cand.t <= LIVE_MS && last && last.value > 0 && dv.holdings.currency === cand.currency) out.yourWeightAfterBuy = pct1(cand.amount / (last.value + cand.amount));
    out.rulesAgent = rulesView(snapshot, f, Rt);
    return out;
  }

  const api = { run: run, contextFor: contextFor, snapshotAt: snapshotAt, verdictNow: verdictNow, rulesView: rulesView, pitMarket: pitMarket, featuresAt: featuresAt, decide: decide, context: context,
    pitUnits: pitUnits, sinceSellAt: sinceSellAt, pendingLooks: pendingLooks, pendingRevisits: pendingRevisits, compareRuns: compareRuns, looksHoldings: looksHoldings, agentPortfolios: agentPortfolios, LOOK_WINDOW: LOOK_WINDOW, LOOK_LAG: LOOK_LAG, outcome: exOf, LOOK_HS: LOOK_HS,
    BUY_RULES: BUY_RULES, MAX_WAIT: MAX_WAIT, HORIZONS: HS };
  if (typeof self !== "undefined") self.ATShadow = api;
  if (node) module.exports = api;
})();
