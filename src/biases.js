(function () {
  // Bias coach. Pure functions over the report of ATDecisions.analyze, so the
  // whole thing runs (and is tested) without a browser. Nothing here leaves the
  // device, and there is no model in it: every number is a statistic, every
  // recommendation a rule with a parameter learned from the user's own trades.
  //
  // Flow
  //   detect   - named biases the statistics support (chasing, impulse, ...)
  //   RULES    - a concrete rule per bias ("do not buy after a rise of more than
  //              X% since your first look"), with X fitted on the user's history
  //   validate - would the rule have helped on trades it had not seen? A
  //              chronological walk-forward: fit on the past, apply to the next
  //              block, repeat; only the gain on the later blocks counts
  //   adherence- once adopted: how often is the rule kept, and what did the
  //              decisions that kept it do against those that broke it
  //   preTrade - check an intended buy against the adopted rules
  //
  // A "unit" is one decision (or call) with the features known BEFORE it, its
  // outcome y (excess return vs the NASDAQ, which is only known later) and the
  // time the outcome is known (tEnd: the close of the outcome's last bar, from
  // ATDecisions.forward's `end`; a calendar margin while it is pending). The gain of a rule on a flagged unit is
  // what the user would have gained by not doing it (or by capping it); flagged
  // means "the rule says do not".
  const D = typeof module !== "undefined" && module.exports ? require("./decisions.js") : self.ATDecisions;
  const S = D.stats, DAY = 86400000;
  const mean = S.mean, wilson = S.wilson, bootstrap = S.bootstrap;
  const NEED = { units: 24, fit: 5, flagged: 8, adherence: { min: 5, solid: 15 } };
  const pc = function (x) { return Math.round(x * 100) + "%"; };

  // ---------- units ----------

  // Buys with the features a rule can use. `pending` keeps buys whose outcome is
  // not known yet (adherence counts them; a validation cannot).
  function buyUnits(R, pending) {
    return R.decisions.filter(function (d) { return !d.excluded && d.side === "buy" && (pending || (d.fwd && d.fwd[21])); }).map(function (d) {
      return {
        id: d.inst + "|" + d.date, ticker: d.ticker, t: d.cut, tEnd: d.fwd && d.fwd[21] ? d.fwd[21].end : d.cut + 35 * DAY, y: d.fwd && d.fwd[21] ? d.fwd[21].ex : null,
        f: {
          runup: d.runup30, leadH: !d.dateOnly && d.firstAtt != null ? (d.cut - d.firstAtt) / 3600000 : null,
          hour: d.dateOnly ? null : new Date(d.ts).getHours(),
          pVol: d.mkt ? d.mkt.pVol : null, pRet: d.mkt ? d.mkt.pRet : null, relSize: d.relSize, conviction: d.conviction, views30: d.views30
        }
      };
    });
  }
  const inBlock = function (b, h) { return b.from < b.to ? h >= b.from && h < b.to : h >= b.from || h < b.to; };
  const FIXED_PARTS = [{ key: "night", label: "Night", from: 22, to: 6 }, { key: "morning", label: "Morning", from: 6, to: 11 }, { key: "midday", label: "Midday", from: 11, to: 15 },
    { key: "afternoon", label: "Afternoon", from: 15, to: 18 }, { key: "evening", label: "Evening", from: 18, to: 22 }];
  // A percentile of the market's volatility (or 20-day return) in plain numbers.
  const marketAt = function (R, key, p) {
    const a = R.market && R.market[key];
    if (!a || !a.length) return null;
    return S.quantile(a, p) * (key === "vol" ? Math.sqrt(252) : 1);
  };

  // The conviction score as a number of visits: log2(1 + views) x (0.5 + 0.5 x scroll) x
  // (1 + 0.1 x focus switches). The user's own typical scroll and focus set the factor.
  function viewsFor(R, conv) {
    const fs = R.decisions.filter(function (d) { return !d.excluded && d.views30 > 0 && d.conviction > 0; }).map(function (d) { return d.conviction / Math.log2(1 + d.views30); });
    const f = fs.length >= 5 ? S.median(fs) : 0.75;
    return Math.max(1, Math.ceil(Math.pow(2, conv / f) - 1));
  }

  // ---------- rules ----------
  // grid: the settings tried; flag(u, p): does the rule say "do not" for this
  // unit; gain(u, p): what not doing it would have been worth; text(p, R): the
  // rule in plain words. maxShare: a rule that blocks most of what you do is not
  // a rule, so a setting must flag at most this share of the units.

  // Every rule says what to DO in a few words (`do`), states the rule itself (`text`)
  // and, for the pre-trade check, why it fires now (`check`). `extra` adds figures
  // to a fitted setting that are only for wording, never for the test.
  const RULES = [
    { id: "wait_runup", bias: "chasing", title: "Wait after a run-up",
      universe: buyUnits, applies: function (u) { return u.f.runup != null; },
      grid: function () { return [0.08, 0.10, 0.15, 0.20, 0.30].map(function (x) { return { th: x }; }); },
      flag: function (u, p) { return u.f.runup > p.th; }, gain: function (u) { return -u.y; },
      do: function () { return "Wait for a pullback."; },
      text: function (p) { return "Do not buy a stock that has already risen more than " + pc(p.th) + " in the last 30 days. Wait for a pullback, or skip it."; },
      check: function (p, c) { return c.runup > p.th ? "It is up " + pc(c.runup) + " in the last 30 days (the limit is " + pc(p.th) + ")." : null; } },
    { id: "sleep_on_it", bias: "impulse", title: "Sleep on it",
      universe: buyUnits, applies: function (u) { return u.f.leadH != null; },
      grid: function () { return [1, 6, 24, 72].map(function (x) { return { th: x }; }); },
      flag: function (u, p) { return u.f.leadH < p.th; }, gain: function (u) { return -u.y; },
      do: function (p) { return p.th >= 48 ? "Give it a few days before you decide." : p.th >= 24 ? "Sleep on it and decide tomorrow." : "Give it a few hours before you decide."; },
      text: function (p) { return "Sleep on it: wait at least " + (p.th >= 24 ? p.th / 24 + (p.th === 24 ? " day" : " days") : p.th + (p.th === 1 ? " hour" : " hours")) + " between first looking at a stock and buying it."; },
      check: function (p, c) { return c.leadH < p.th ? "You first looked at it " + (c.leadH < 1 ? "less than an hour" : Math.round(c.leadH) + " hours") + " ago; the rule asks for " + (p.th >= 24 ? p.th / 24 + " day(s)" : p.th + " hour(s)") + "." : null; } },
    { id: "avoid_daypart", bias: "bad_hour", title: "Avoid your worst time of day",
      universe: buyUnits, applies: function (u) { return u.f.hour != null; },
      grid: function (R, o) { return (o && o.blocks && o.blocks.length ? o.blocks : FIXED_PARTS).map(function (b) { return { block: b }; }); },
      flag: function (u, p) { return inBlock(p.block, u.f.hour); }, gain: function (u) { return -u.y; },
      do: function (p) { return "Place the order at another time of day, not in the " + p.block.label.toLowerCase() + "."; },
      text: function (p) { return "Do not place buys in the " + p.block.label.toLowerCase() + " (" + p.block.from + "-" + p.block.to + " h on your clock). Decide then if you like, and place the order at another time."; },
      check: function (p, c) { return c.hour != null && inBlock(p.block, c.hour) ? "It is " + c.hour + ":00, inside the " + p.block.label.toLowerCase() + "." : null; } },
    { id: "pause_turbulent", bias: "turbulence", title: "Pause in turbulent markets",
      universe: buyUnits, applies: function (u) { return u.f.pVol != null; },
      grid: function () { return [0.67, 0.8, 0.9].map(function (x) { return { th: x }; }); },
      flag: function (u, p) { return u.f.pVol > p.th; }, gain: function (u) { return -u.y; },
      do: function () { return "Wait for calmer markets."; },
      text: function (p, R) { const v = marketAt(R, "vol", p.th); return "Do not buy while the market is as turbulent as on the most turbulent " + pc(1 - p.th) + " of days" + (v ? " (volatility above about " + Math.round(v * 100) + "% a year)" : "") + "."; },
      check: function (p, c) { return c.pVol > p.th ? "The market is more turbulent than on " + pc(c.pVol) + " of days." : null; } },
    { id: "cap_turbulent", bias: "turbulence", title: "Cap the size in turbulent markets",
      universe: buyUnits, applies: function (u) { return u.f.pVol != null && u.f.relSize != null; },
      grid: function () { return [{ th: 0.67, cap: 1 }, { th: 0.67, cap: 1.5 }, { th: 0.67, cap: 2 }, { th: 0.8, cap: 1.5 }, { th: 0.8, cap: 2 }]; },
      flag: function (u, p) { return u.f.pVol > p.th && u.f.relSize > p.cap; }, gain: function (u, p) { return -(1 - p.cap / u.f.relSize) * u.y; },
      do: function (p) { return "Cut the buy to at most " + p.cap + "x your usual buy."; },
      text: function (p, R) { const v = marketAt(R, "vol", p.th); return "When the market is as turbulent as on the most turbulent " + pc(1 - p.th) + " of days" + (v ? " (volatility above about " + Math.round(v * 100) + "% a year)" : "") + ", keep a buy to at most " + p.cap + "x your usual buy."; },
      check: function (p, c) { return c.pVol > p.th && c.relSize > p.cap ? "The market is turbulent and this buy is " + c.relSize.toFixed(1) + "x your usual buy (the cap is " + p.cap + "x)." : null; } },
    { id: "wait_strong_market", bias: "chasing", title: "Wait after strong market stretches",
      universe: buyUnits, applies: function (u) { return u.f.pRet != null; },
      grid: function () { return [0.67, 0.8, 0.9].map(function (x) { return { th: x }; }); },
      flag: function (u, p) { return u.f.pRet > p.th; }, gain: function (u) { return -u.y; },
      do: function () { return "Wait for the market to cool off."; },
      text: function (p, R) { const v = marketAt(R, "ret", p.th); return "Do not buy right after one of the market's strongest stretches: its return over the last 20 days in the top " + pc(1 - p.th) + " of days" + (v != null ? " (above about " + (v * 100).toFixed(1) + "%)" : "") + "."; },
      check: function (p, c) { return c.pRet > p.th ? "The market's last 20 days were stronger than on " + pc(c.pRet) + " of days." : null; } },
    { id: "research_gate", bias: "no_research", title: "Research before you buy",
      universe: buyUnits, applies: function (u) { return u.f.conviction != null; },
      grid: function () { return [0.5, 1, 2, 3].map(function (x) { return { th: x }; }); },
      // the conviction score as a number of visits, at the user's own usual scroll depth and focus
      extra: function (p, R) { return { views: viewsFor(R, p.th) }; },
      flag: function (u, p) { return u.f.conviction < p.th; }, gain: function (u) { return -u.y; },
      do: function () { return "Do more research first."; },
      text: function (p) { return "Do more research before you buy: look at the stock on at least about " + p.views + (p.views === 1 ? " occasion" : " occasions") + " in the 30 days before (a conviction score of " + p.th + ", the number on the watchlist's pills)."; },
      check: function (p, c) { return c.conviction < p.th ? "You have looked at it " + c.views30 + (c.views30 === 1 ? " time" : " times") + " in the last 30 days; the rule asks for about " + p.views + "." : null; } },
    { id: "exit_at_target", bias: "ignored_targets", title: "Sell at your target",
      maxShare: 1, universe: function (R) { return (R.q11.rows || []).filter(function (r) { return r.after != null; }).map(function (r) { return { id: r.ticker + "|" + r.ts, t: r.ts, tEnd: r.end, y: r.after, f: { sold: r.sold } }; }); },
      applies: function () { return true; }, grid: function () { return [{}]; },
      flag: function (u) { return !u.f.sold; }, gain: function (u) { return -u.y; },
      do: function () { return "Sell, or move your target on purpose."; },
      text: function () { return "When a stock reaches your target price, sell (or consciously move the target) within two weeks."; },
      check: function () { return null; } },
    { id: "act_on_calls", bias: "say_do_gap", title: "Act on your calls or drop them",
      maxShare: 1, universe: function (R) { return (R.calls || []).map(function (c) { return { id: c.ticker + "|" + c.ts, t: c.ts, tEnd: c.end, y: c.ex, f: { bought: c.bought } }; }); },
      applies: function () { return true; }, grid: function () { return [{}]; },
      flag: function (u) { return !u.f.bought; }, gain: function (u) { return u.y; },
      do: function () { return "Buy a small starter position, or take the label off."; },
      text: function () { return "Within 30 days of a Positive call on a stock you do not hold, buy it (even a small starter position) or take the label off."; },
      check: function () { return null; } },
    // Phase-1 indicators (src/indicators.js), attached to the report as R.ind.
    { id: "no_quick_switch", bias: "overconfidence", title: "No quick switches",
      universe: function (R, pending) { return (R.ind && R.ind.overconfidence ? R.ind.overconfidence.buyUnits : []).filter(function (u) { return pending || u.y != null; }); },
      applies: function (u) { return u.f.sinceSell != null; },
      grid: function () { return [3, 7, 14].map(function (x) { return { th: x }; }); },
      flag: function (u, p) { return u.f.sinceSell < p.th; }, gain: function (u) { return -u.y; },
      do: function (p) { return "Wait " + p.th + " days after a sale before buying something else."; },
      text: function (p) { return "After selling, wait at least " + p.th + " days before you buy something else with the money. Switches you made faster did worse than what you sold."; },
      check: function () { return null; } },
    { id: "hold_through_dips", bias: "myopia", title: "Hold long-term positions through dips",
      universe: function (R, pending) { return (R.ind && R.ind.myopia ? R.ind.myopia.sellUnits : []).filter(function (u) { return pending || u.y != null; }); },
      applies: function (u) { return u.f.dipDays != null; },
      grid: function () { return [5, 10, 20].map(function (x) { return { th: x }; }); },
      flag: function (u, p) { return u.f.dipDays <= p.th; }, gain: function (u) { return u.y; },
      do: function (p) { return "Do not sell a long-term position within " + p.th + " days of a drop."; },
      text: function (p) { return "For a position you bought with a horizon of a year or more, do not sell within " + p.th + " days of a drop of 5% or more. Decide on the horizon you set, not on the week."; },
      check: function () { return null; } },
    // Phase 2.
    { id: "avoid_extrapolation", bias: "extrapolation", title: "Do not buy the recent top performers",
      universe: function (R, pending) { return (R.ind && R.ind.extrapolation ? R.ind.extrapolation.buyUnits : []).filter(function (u) { return pending || u.y != null; }); },
      applies: function (u) { return u.f.pct12 != null; },
      grid: function () { return [0.7, 0.8, 0.9].map(function (x) { return { th: x }; }); },
      flag: function (u, p) { return u.f.pct12 > p.th; }, gain: function (u) { return -u.y; },
      do: function () { return "Skip it, or wait: it is among the year's best performers you look at."; },
      text: function (p) { return "Do not buy a stock whose 12-month return is in the top " + pc(1 - p.th) + " of the stocks you viewed in the last 30 days."; },
      check: function (p, c) { return c.pct12 > p.th ? "Its 12-month return beats " + pc(c.pct12) + " of the stocks you viewed in the last 30 days." : null; } },
    { id: "cap_lottery", bias: "lottery", title: "Keep lottery stocks small",
      universe: function (R, pending) { return (R.ind && R.ind.lottery ? R.ind.lottery.buyUnits : []).filter(function (u) { return pending || u.y != null; }); },
      applies: function (u) { return u.f.lottery && u.f.relSize != null; },
      grid: function () { return [0.25, 0.5, 1].map(function (x) { return { cap: x }; }); },
      flag: function (u, p) { return u.f.relSize > p.cap; }, gain: function (u, p) { return -(1 - p.cap / u.f.relSize) * u.y; },
      maxShare: 1,
      do: function (p) { return "Cut it to at most " + p.cap + "x your usual buy."; },
      text: function (p) { return "Keep a buy in a lottery stock (a day above +10% in the last month, or a cheap, very volatile stock) to at most " + p.cap + "x your usual buy."; },
      check: function (p, c) { return c.lottery && c.relSize > p.cap ? "It counts as a lottery stock today and this buy is " + c.relSize.toFixed(1) + "x your usual buy (the cap is " + p.cap + "x)." : null; } },
    // Size by attention: how much you looked at a stock before buying sets how big the buy may be.
    // It only ever cuts (a cap), and only where, on your own history, big buys of little-researched
    // stocks did worse than the same buys at the cap.
    { id: "cap_low_attention", bias: "size_vs_conviction", title: "Size a buy by how much you looked at it",
      universe: buyUnits, applies: function (u) { return u.f.conviction != null && u.f.relSize != null; },
      grid: function () { return [{ th: 1, cap: 0.5 }, { th: 1, cap: 1 }, { th: 2, cap: 0.5 }, { th: 2, cap: 1 }, { th: 3, cap: 1 }, { th: 3, cap: 1.5 }]; },
      extra: function (p, R) { return { views: viewsFor(R, p.th) }; },
      flag: function (u, p) { return u.f.conviction < p.th && u.f.relSize > p.cap; }, gain: function (u, p) { return -(1 - p.cap / u.f.relSize) * u.y; },
      do: function (p) { return "Cut the buy to at most " + p.cap + "x your usual buy until you have looked at the stock more."; },
      text: function (p) { return "When you have looked at a stock on fewer than about " + p.views + (p.views === 1 ? " occasion" : " occasions") + " in the last 30 days (a conviction score under " + p.th + "), keep the buy to at most " + p.cap + "x your usual buy."; },
      check: function (p, c) { return c.conviction < p.th && c.relSize > p.cap ? "You have looked at it " + c.views30 + (c.views30 === 1 ? " time" : " times") + " in the last 30 days (the rule wants about " + p.views + ") and this buy is " + c.relSize.toFixed(1) + "x your usual buy (the cap is " + p.cap + "x)." : null; } },
    // f.crowd: other users' views of the stock in the 3 days before against its own rate in the month before (src/indicators.js crowdAt)
    { id: "wait_crowd", bias: "crowd_buys", title: "Wait for the crowd to move on",
      universe: function (R, pending) { return (R.ind && R.ind.crowdBuys ? R.ind.crowdBuys.buyUnits : []).filter(function (u) { return pending || u.y != null; }); },
      applies: function (u) { return u.f.crowd != null; },
      grid: function () { return [1.5, 2, 3].map(function (x) { return { th: x }; }); },
      flag: function (u, p) { return u.f.crowd > p.th; }, gain: function (u) { return -u.y; },
      do: function () { return "Wait until the crowd's attention fades."; },
      text: function (p) { return "Do not buy a stock while other Stocktrails users look at it more than " + p.th + "x as often as usual (the last 3 days against the month before). Wait until the crowd's attention fades."; },
      check: function (p, c) { return c.crowd > p.th ? "Other users looked at it " + c.crowd.toFixed(1) + "x as often as usual in the last 3 days (the limit is " + p.th + "x)." : null; } }
  ];
  const BY_ID = {};
  RULES.forEach(function (r) { BY_ID[r.id] = r; });

  // Best setting on the units given: the one with the largest mean gain times
  // the square root of how many it flags (a small flagged set with a lucky mean
  // does not beat a larger set with a good one), among settings that flag enough
  // but not most units and whose mean gain is positive. Null when none helps.
  function fit(rule, units, R, o) {
    let best = null;
    const maxShare = rule.maxShare || 0.6;
    rule.grid(R, o).forEach(function (p) {
      let k = 0, s = 0;
      units.forEach(function (u) { if (rule.flag(u, p)) { k++; s += rule.gain(u, p); } });
      if (k < NEED.fit || k > maxShare * units.length) return;
      const m = s / k;
      if (!(m > 0)) return;
      const score = m * Math.sqrt(k);
      if (!best || score > best.score) best = { p: p, k: k, mean: m, score: score };
    });
    return best;
  }

  // ---------- out-of-sample validation ----------

  // The recommendation as it would have been made at the time, then judged on
  // what came after. Units are in time order. The first half is only ever
  // training. The second half is cut into up to 6 blocks; for each block the
  // rule is fitted on units whose outcome was already known when the block began
  // (an embargo: a buy's return runs for weeks, so a buy just before the block
  // cannot be used to fit it), and then applied to the block. A fold where no
  // setting helped in the past recommends nothing, and that is counted.
  function walkForward(rule, units, seed, R, o) {
    const n = units.length, out = { n: n, folds: 0, recommended: 0, flagged: 0, testN: 0, detail: [] };
    const first = Math.max(12, Math.ceil(n / 2)), K = Math.min(6, Math.floor((n - first) / 6));
    if (n < NEED.units || K < 1) { out.verdict = "untested"; out.reason = n < NEED.units ? "needs " + NEED.units + " decisions with a known outcome, has " + n : "too few decisions after the first half"; return out; }
    const size = Math.ceil((n - first) / K), gains = [], flagY = [], keptY = [];
    for (let b = 0; b < K; b++) {
      const lo = first + b * size, hi = Math.min(n, lo + size);
      if (lo >= hi) break;
      const test = units.slice(lo, hi), T = test[0].t;
      const train = units.slice(0, lo).filter(function (u) { return u.tEnd <= T; });
      out.folds++; out.testN += test.length;
      const best = train.length >= 12 ? fit(rule, train, R, o) : null;
      out.detail.push({ from: T, train: train.length, test: test.length, recommended: !!best });
      if (!best) continue;
      out.recommended++;
      test.forEach(function (u) { if (rule.flag(u, best.p)) { gains.push(rule.gain(u, best.p)); flagY.push(u.y); } else keptY.push(u.y); });
    }
    out.flagged = gains.length;
    if (gains.length < NEED.flagged) { out.verdict = "untested"; out.reason = out.recommended ? "the rule would have flagged only " + gains.length + " decisions out of sample (needs " + NEED.flagged + ")" : "no setting helped in the past in any fold"; return out; }
    out.mean = mean(gains);
    out.ci99 = bootstrap(gains, null, 2000, seed, 0.99);
    out.ci95 = bootstrap(gains, null, 2000, seed + 1, 0.95);
    out.perDecision = gains.reduce(function (s, x) { return s + x; }, 0) / out.testN;
    out.flaggedMean = mean(flagY); out.keptMean = keptY.length ? mean(keptY) : null;
    out.verdict = out.ci99.lo > 0 ? "supported" : out.ci95.lo > 0 ? "indicative" : out.mean > 0 ? "unclear" : "unsupported";
    return out;
  }

  function withExtra(rule, p, R) { return rule.extra ? Object.assign({}, p, rule.extra(p, R)) : p; }
  function seedOf(id) { let h = 7; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h; }

  // Every rule on this report: the setting that would be recommended today (fitted
  // on all of it), how it did in sample, and the out-of-sample verdict.
  function validate(R, o) {
    return RULES.map(function (rule) {
      const units = rule.universe(R).filter(rule.applies).sort(function (a, b) { return a.t - b.t; });
      const best = units.length >= NEED.units ? fit(rule, units, R, o) : null;
      return {
        id: rule.id, bias: rule.bias, title: rule.title, n: units.length,
        recommended: !!best, params: best ? withExtra(rule, best.p, R) : null, text: best ? rule.text(withExtra(rule, best.p, R), R) : null, do: best ? rule.do(best.p) : null,
        inSample: best ? { k: best.k, share: best.k / units.length, mean: best.mean } : null,
        oos: walkForward(rule, units, seedOf(rule.id), R, o)
      };
    });
  }

  // ---------- biases ----------

  const RANK = { none: 0, indicative: 1, solid: 2 }, NEED_Q2_MIN = 10;
  function detect(R) {
    const out = [];
    const add = function (id, name, signals, extra) {
      signals = signals.filter(Boolean);
      if (!signals.length) return;
      const status = signals.reduce(function (b, s) { return RANK[s.status] > RANK[b] ? s.status : b; }, "none");
      out.push(Object.assign({ id: id, name: name, signals: signals, status: status, clear: signals.some(function (s) { return s.clear; }) }, extra || {}));
    };
    const sig = function (status, clear, text) { return status && status !== "none" ? { status: status, clear: !!clear, text: text } : null; };
    const pts = function (x) { return (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + " pts"; };
    const q4 = R.q4, fo = q4.fomo, ru = q4.runupPerf, q7 = R.q7, q10 = R.q10, q2 = R.q2, q5 = R.q5, q11 = R.q11, q1 = R.q1, q3 = R.q3, q8 = R.q8, d = R.disposition;

    add("chasing", "Chasing price rises", [
      ru.diff && ru.diff.est < 0 ? sig(ru.status, ru.clear, "Buys made after the price had risen since your first look did " + pts(ru.diff.est) + " against those made after a fall.") : null,
      fo.buyIfUp.n && fo.buyIfDown.n && fo.buyIfUp.p > fo.buyIfDown.p ? sig(fo.status, fo.clear, "You bought " + pc(fo.buyIfUp.p) + " of the calls whose stock rose after the call and " + pc(fo.buyIfDown.p) + " of those that fell.") : null,
      q10.dip && q10.dip.ret.verdict === "chase" ? sig(q10.status, true, "On your buy days the NASDAQ was stronger than on " + pc(q10.dip.ret.mean.est) + " of all trading days.") : null
    ]);
    add("impulse", "Trading on impulse", [
      q7.n && q7.impulse.p >= 0.15 ? sig(q7.status, q7.clear && q7.returns.diff && q7.returns.diff.est < 0,
        pc(q7.impulse.p) + " of your timed decisions came within an hour of your first look" + (q7.returns.diff ? "; impulse buys did " + pts(q7.returns.diff.est) + " against the ones you had looked at for a week or more." : ".")) : null
    ]);
    const hs = q7.hours, bad = hs && hs.blocks.filter(function (b) { return b.robust && b.diff.est < 0; })[0];
    add("bad_hour", "Buying at a bad time of day", [bad ? sig(hs.status, true, "Buys placed in the " + bad.label.toLowerCase() + " did " + pts(bad.diff.est) + " against your other buys.") : null]);
    const turb = q10.regimes && q10.regimes[2], sd = q10.size && q10.size.diff;
    add("turbulence", "Oversized buys in turbulent markets", [
      sd && sd.lo != null && sd.lo > 0 ? sig(q10.status, true, "In turbulent markets you put " + Math.pow(2, sd.est).toFixed(1) + "x as much into a buy as in calm ones.") : null,
      turb && turb.tilt === "more" ? sig(q10.status, true, pc(turb.share.p) + " of your buys came in turbulent markets, which are " + pc(turb.baseShare) + " of days.") : null
    ]);
    add("say_do_gap", "Not acting on your own calls", [
      q2.posToBuy.n >= NEED_Q2_MIN && q2.posToBuy.p < 0.5 ? sig(q2.status === "none" ? "indicative" : q2.status, q2.posToBuy.hi < 0.5, "You bought " + pc(q2.posToBuy.p) + " of your Positive calls on stocks you did not hold.") : null,
      q5.status !== "none" && q5.diff && q5.diff.est < 0 ? sig(q5.status, q5.clear, "The Positive calls you passed on did " + pts(-q5.diff.est) + " better than the stocks you bought.") : null
    ]);
    add("ignored_targets", "Targets that do not trigger a sale", [q11.status !== "none" && q11.sold.p < 0.5 ? sig(q11.status, q11.sold.hi < 0.5, "You sold within two weeks of reaching your target only " + q11.sold.k + " of " + q11.n + " times.") : null]);
    add("no_research", "Buying without research", [
      q1.status !== "none" && q1.researched.p < 0.5 ? sig(q1.status, q1.researched.hi < 0.5, pc(1 - q1.researched.p) + " of your decisions had no recorded research in the 30 days before.") : null,
      q3.clear && q3.diff.est > 0 ? sig(q3.status, true, "Researched buys did " + pts(q3.diff.est) + " against unresearched ones.") : null
    ]);
    const sv = R.ind && R.ind.survival;
    add("disposition", "Selling winners too early, keeping losers", [d.de != null && d.de > 0.05 ? sig(d.status, false, "On days you sold you realised " + pc(d.pgr) + " of your gains but only " + pc(d.plr) + " of your losses.") : null,
      sv && sv.winners.median != null && sv.losers.median != null && sv.winners.median < 0.5 * sv.losers.median ? sig(sv.status, false, "You held winners a median " + Math.round(sv.winners.median) + " days and losers " + Math.round(sv.losers.median) + ".") : null],
      { advice: ["Decide the exit when you buy: write a target price and a horizon in the label widget, and look at card D1 to see whether you keep to them.",
        "Before selling a winner, ask whether you would buy it today at this price; if yes, the reason to sell is only that it went up."] });
    add("size_vs_conviction", "Biggest positions with the least research", [q8.clear && q8.sizeVsConviction.r < 0 ? sig(q8.status, true, "Your biggest positions clearly got the least research.") : null],
      { advice: ["Size a position by how much you researched it: use the conviction bands in card E1 as a starting point for the position size."] });
    detectIndicators(R.ind, add, sig, pts);
    return out;
  }
  // Signals from the phase-1 indicators (R.ind, src/indicators.js). Absent
  // indicators (no broker import, older report) add nothing.
  function detectIndicators(X, add, sig, pts) {
    if (!X) return;
    const ex = X.extrapolation, lt = X.lottery, an = X.anchoring, cal = X.calibration, hb = X.homebias, vo = X.volume;
    if (ex && ex.clear) add("extrapolation", "Expecting past returns to continue", [
      ex.calls.clear ? sig(ex.calls.status, true, "Your Positive and Negative calls follow the stock's past return (r " + (ex.calls.m12.r != null && ex.calls.m12.lo > 0 ? ex.calls.m12.r : ex.calls.m3.r).toFixed(2) + ").") : null,
      ex.buys.clear ? sig(ex.buys.status, true, "Your buys ranked at the " + pc(ex.buys.p12.est != null ? ex.buys.p12.est : ex.buys.p3.est) + " percentile of past returns among the stocks you were viewing.") : null
    ], { advice: ["Before buying a recent winner, write down what will make it keep rising that the price does not already show."] });
    if (lt && lt.status !== "none" && (lt.tilt || lt.clear)) add("lottery", "Buying lottery tickets", [
      lt.tilt ? sig(lt.status, false, pc(lt.buys.p) + " of your buys were lottery stocks that day, against " + pc(lt.views.p) + " of the stocks you viewed.") : null,
      lt.clear ? sig(lt.status, true, "Your lottery buys did " + pts(lt.returns.diff.est) + " against your other buys over three months.") : null
    ]);
    if (an) add("anchoring", "Anchored targets and sales", [
      an.targets.clear ? sig(an.targets.status, true, pc(an.targets.round.p) + " of your targets sit on round numbers; chance would give " + pc(an.targets.chance) + ".") : null,
      an.breakEven.clear ? sig(an.breakEven.status, true, pc(an.breakEven.share.p) + " of your full sales came within 2% of your cost, where the price spent " + pc(an.breakEven.chance) + " of the time.") : null,
      an.nearHigh.clear && an.nearHigh.ex.est < 0 ? sig(an.nearHigh.status, true, "You buy near the 52-week high less often than you look at stocks there.") : null
    ], { advice: ["Derive a target from a valuation or a scenario, then round it; not the other way round."] });
    if (hb && !hb.noHome && hb.status !== "none" && hb.tilted) add("homebias", "Staying close to home", [
      sig(hb.status, false, (hb.depot ? pc(hb.depot.share) + " of your depot" : pc(hb.views.share) + " of your views") + " is in " + hb.homeName + ", " + pc(hb.acwi) + " of the world market.")
    ], { advice: ["A world ETF as the core of the depot removes most of the home bias at once."] });
    if (vo && vo.clear) add("volume", "Buying what trades heavily", [
      sig(vo.status, true, pc(vo.share.p) + " of your buys came the day after heavy trading in the stock; chance would give " + pc(vo.chance) + ".")
    ]);
    // Buys right after other users piled in, and how those buys did against the others (the first clear horizon that cost).
    const cb = X.crowdBuys, cbH = cb && cb.horizons ? [5, 21, 63, 126].filter(function (h) { const x = cb.horizons[h].diff; return x && x.lo != null && x.hi < 0; })[0] : null;
    if (cb && cb.status !== "none" && (cb.clearOn.indexOf("excess") >= 0 && cb.excess.est > 0 || cbH)) add("crowd_buys", "Buying what the crowd is looking at", [
      cb.clearOn.indexOf("excess") >= 0 && cb.excess.est > 0 ? sig(cb.status, true, pc(cb.share.p) + " of your buys came while other Stocktrails users were piling into the stock; by each stock's own rate, chance would give " + pc(cb.chance) + ".") : null,
      cbH ? sig(cb.status, true, "Those buys did " + pts(cb.horizons[cbH].diff.est) + " against your other buys over " + cbH + " trading days.") : null
    ], { advice: ["When a stock is suddenly everywhere, wait a few days for the attention to fade and decide on what you know, not on who is looking."] });
    // Timing against a savings plan (src/indicators.js timing): flagged only where a plan would have won.
    const tm = X.timing, yr = function (x) { return (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + " pts a year"; };
    if (tm && tm.status !== "none" && tm.verdict === "plan_better") add("timing", "Timing that does not beat a savings plan", [
      tm.same.clear && tm.same.effect.est < 0 ? sig(tm.same.status, true, "In the " + tm.same.stocks + " stocks you timed, the same money as a monthly plan would have earned " + yr(-tm.same.effect.est).replace(/^[+-]/, "") + " more than the moments you chose.") : null,
      tm.sleeves.clear && tm.sleeves.diff.est < 0 ? sig(tm.sleeves.status, true, "Your timed buys earned " + yr(tm.sleeves.timed.ex) + " against the index, your savings plans " + yr(tm.sleeves.plan.ex) + ".") : null
    ], { advice: ["For money you have no view on, let a savings plan do the buying: it decides the dates for you.", "Keep timed buys for the cases where you can say in one sentence why this week beats the average week."] });
    const at = X.attention;
    if (at && at.clear) add("underreaction", "Missing quarterly reports", [
      at.friday.diff && at.friday.diff.lo > 0 ? sig(at.status, true, pc(at.friday.yes.missed.p) + " of Friday releases went unread for two weeks, against " + pc(at.friday.no.missed.p) + " on other days.") : null,
      at.busy.diff && at.busy.diff.lo > 0 ? sig(at.status, true, "On days with 3 or more of your stocks reporting, " + pc(at.busy.yes.missed.p) + " went unread, against " + pc(at.busy.no.missed.p) + " on quieter days.") : null
    ], { advice: ["Put the report dates of the stocks you hold in your calendar, and block an hour the day after."] });
    const oc = X.overconfidence, os = X.ostrich, cf = X.confirmation, en = X.entropy, hd = X.herding, rk = X.rank, my = X.myopia, rp = X.repurchase, dv = X.diversification, sv = X.survival;
    if (oc || cal) add("overconfidence", "Trading more than your information supports", [
      cal && cal.clear ? sig(cal.status, true, "Your targets asked for a median " + pc(cal.medianReq) + " move where the stocks went at best " + pc(cal.medianBest) + " your way before the deadline.") : null,
      oc && oc.odean.status !== "none" && oc.odean[84].est != null && oc.odean[84].est < 0 ? sig(oc.odean.status, oc.odean.clear, "What you bought after a sale did " + pts(oc.odean[84].est) + " against what you sold, over the next four months.") : null,
      oc && oc.turnover.annual != null && oc.turnover.annual > 0.75 ? sig(oc.turnover.status, false, "You turn over " + pc(oc.turnover.annual) + " of your depot a year; the average private investor in Barber & Odean's data turned over about 75%.") : null,
      oc && oc.perTrade.clear ? sig(oc.perTrade.status, true, "In months with more trades you researched each trade less.") : null
    ], { advice: ["Before a switch, write down why the new stock beats the one you sell; the Odean test above shows how such switches turned out."] });
    if (os && os.status !== "none" && os.diff.est > 0) add("ostrich", "Looking away after losses", [
      sig(os.status, os.clear, "You looked at your positions on " + pc(os.up.p) + " of days after they rose and " + pc(os.down.p) + " after they fell.")
    ], { advice: ["Review every position on a fixed slot each week, whatever the market did."] });
    if (cf || en) add("confirmation", "Discounting news against your call", [
      cf && cf.signal ? sig(cf.status, cf.clear, "After a sharp move against your call you changed it " + pc(cf.contrary.rev.p) + " of the time, no more than after a move in its favour (" + pc(cf.confirming.rev.p) + ").") : null,
      en && en.clear ? sig(en.status, true, "On stocks you have a call on, your research is narrower (fewer kinds of pages) than on others.") : null
    ], { advice: ["After a big move against a stock you like, open its financials before the news."] });
    if (hd && hd.clear) add("herding", "Following the crowd", [
      sig(hd.status, true, pc(hd.followed.p) + " of your first looks at a stock came right after the community or a trending list piled in; chance would give " + pc(hd.chance) + ".")
    ]);
    if (rk && rk.clear) add("rank", "Selling your best or worst, ignoring the middle", [
      sig(rk.status, true, "On days you sell, you sell your best or worst position far more often (" + pc(Math.max(rk.best.p || 0, rk.worst.p || 0)) + ") than one in the middle (" + pc(rk.middle.p) + ").")
    ], { advice: ["Before selling your best or worst position, check the middle ones you never look at."] });
    if (my && my.clear) add("myopia", "Selling long-term positions on short-term drops", [
      sig(my.status, true, "Positions bought with a horizon of a year or more: you sold within a week of a 5% drop " + pc(my.dip.p) + " of the time, otherwise " + pc(my.noDip.p) + ".")
    ]);
    if (rp && rp.clear && rp.diff.est > 0) add("repurchase", "Rebuying only what fell after you sold", [
      sig(rp.status, true, "You rebought sold stocks more often once they fell below your sale price than when they rose (" + pts(rp.diff.est) + " a month).")
    ], { advice: ["Judge a stock you sold like a new one: would you buy it at today's price if you had never owned it?"] });
    if (dv) add("diversification", "A narrow depot", [
      dv.concentrated ? sig(dv.holdings.status, false, "Your depot holds " + dv.holdings.last.n + " positions, the largest at " + pc(dv.holdings.last.top) + ", and less than half in funds.") : null,
      dv.oneOverN.signal ? sig(dv.oneOverN.status, false, pc(dv.oneOverN.same.p) + " of your buys repeat the amount of a buy made within a month, whatever the stock.") : null,
      dv.sectorHeavy ? sig(dv.holdings.status, false, pc(dv.holdings.last.topSectorShare) + " of your depot is in one sector (" + dv.holdings.last.topSector + ").") : null
    ], { advice: ["Size positions by risk, not by a fixed sum."] });
  }

    // Biases with their rules attached. Tier "detected": at least one signal is
  // clear (its range rules out "no effect"). Tier "watch": a pattern with enough
  // data behind it to show, but not proven; rules for it are shown only if they
  // held up out of sample. Tier "rules": a rule held up out of sample although
  // no statistic flagged the bias. Detected first, then rules, then watch.
  function coach(R, o) {
    const rules = validate(R, o), found = detect(R), by = {};
    rules.forEach(function (r) { (by[r.bias] = by[r.bias] || []).push(r); });
    const names = { chasing: "Chasing price rises", impulse: "Trading on impulse", bad_hour: "Buying at a bad time of day", turbulence: "Oversized buys in turbulent markets",
      say_do_gap: "Not acting on your own calls", ignored_targets: "Targets that do not trigger a sale", no_research: "Buying without research",
      overconfidence: "Trading more than your information supports", myopia: "Selling long-term positions on short-term drops",
      extrapolation: "Expecting past returns to continue", lottery: "Buying lottery tickets", crowd_buys: "Buying what the crowd is looking at", size_vs_conviction: "Biggest positions with the least research" };
    const seen = {};
    const held = function (r) { return r.oos.verdict === "supported" || r.oos.verdict === "indicative"; };
    const biases = found.map(function (b) {
      seen[b.id] = 1;
      return Object.assign({ rules: by[b.id] || [], tier: b.clear ? "detected" : "watch" }, b);
    });
    Object.keys(by).forEach(function (id) {
      if (seen[id] || !by[id].some(held)) return;
      biases.push({ id: id, name: names[id] || id, signals: [], status: "indicative", clear: false, rules: by[id], tier: "rules" });
    });
    const trank = { detected: 0, rules: 1, watch: 2 }, vrank = { supported: 3, indicative: 2, unclear: 1, untested: 0, unsupported: 0 };
    const best = function (b) { return b.rules.reduce(function (m, r) { return Math.max(m, vrank[r.oos.verdict] || 0); }, 0); };
    biases.sort(function (a, b) { return trank[a.tier] - trank[b.tier] || RANK[b.status] - RANK[a.status] || best(b) - best(a); });
    return { biases: biases, rules: rules };
  }

  // ---------- commitments ----------

  function commit(ruleReport, now) {
    return { id: ruleReport.id + "|" + now, ruleId: ruleReport.id, bias: ruleReport.bias, params: ruleReport.params, text: ruleReport.text, do: ruleReport.do, adoptedAt: now, status: "active",
      atAdoption: { verdict: ruleReport.oos.verdict, mean: ruleReport.oos.mean == null ? null : ruleReport.oos.mean, flagged: ruleReport.oos.flagged, inSample: ruleReport.inSample ? ruleReport.inSample.mean : null } };
  }

  // Newcombe's interval for a difference of two shares, from the Wilson ranges.
  function diffShare(a, b) {
    if (!a.n || !b.n) return null;
    const d = a.p - b.p;
    return { est: d, lo: d - Math.sqrt(Math.pow(a.p - a.lo, 2) + Math.pow(b.hi - b.p, 2)), hi: d + Math.sqrt(Math.pow(a.hi - a.p, 2) + Math.pow(b.p - b.lo, 2)) };
  }

  // How a rule is kept after adoption: the decisions since (flagged = the rule
  // was broken), the same rule over an equally long stretch before, and the
  // result of the decisions that kept it against those that broke it. That last
  // comparison is an association: nobody was assigned to comply, and the
  // decisions a rule flags may differ in other ways. Decisions whose outcome is
  // not known yet count as pending.
  function adherence(c, R, now) {
    const rule = BY_ID[c.ruleId];
    if (!rule) return null;
    const units = rule.universe(R, true).filter(rule.applies);
    const span = Math.max(1, (now || Date.now()) - c.adoptedAt), from = c.adoptedAt - span;
    const after = units.filter(function (u) { return u.t >= c.adoptedAt; }), before = units.filter(function (u) { return u.t >= from && u.t < c.adoptedAt; });
    const broke = function (u) { return rule.flag(u, c.params); };
    const share = function (us) { return wilson(us.filter(broke).length, us.length); };
    const kept = after.filter(function (u) { return !broke(u) && u.y != null; }), brk = after.filter(function (u) { return broke(u) && u.y != null; });
    const out = { n: after.length, broken: share(after), before: { n: before.length, broken: share(before) }, pending: after.filter(function (u) { return u.y == null; }).length,
      kept: { n: kept.length, mean: kept.length ? mean(kept.map(function (u) { return u.y; })) : null },
      broke: { n: brk.length, mean: brk.length ? mean(brk.map(function (u) { return u.y; })) : null } };
    out.change = diffShare(out.broken, out.before.broken);
    const small = Math.min(kept.length, brk.length);
    out.status = small >= NEED.adherence.solid ? "solid" : small >= NEED.adherence.min ? "indicative" : "none";
    if (kept.length >= 2 && brk.length >= 2) {
      out.diff = bootstrap(kept.map(function (u) { return u.y; }), brk.map(function (u) { return u.y; }), 2000, seedOf(c.id));
      out.clear = out.status !== "none" && out.diff.lo != null && (out.diff.lo > 0 || out.diff.hi < 0);
    }
    return out;
  }

  // What the rule would have done to the whole history if it had always applied
  // (in sample: the setting was chosen on this very history, so this flatters
  // the rule; validate() is the honest number).
  function simulate(R, ruleId, params, o) {
    const rule = BY_ID[ruleId];
    if (!rule) return null;
    const p = params || (fit(rule, rule.universe(R).filter(rule.applies), R, o) || {}).p;
    if (!p) return { ruleId: ruleId, params: null, n: 0 };
    const units = rule.universe(R).filter(rule.applies);
    const fl = units.filter(function (u) { return rule.flag(u, p); }), ok = units.filter(function (u) { return !rule.flag(u, p); });
    return { ruleId: ruleId, params: p, text: rule.text(withExtra(rule, p, R), R), inSample: true, n: units.length, flagged: fl.length,
      flaggedMean: fl.length ? mean(fl.map(function (u) { return u.y; })) : null, keptMean: ok.length ? mean(ok.map(function (u) { return u.y; })) : null,
      gainPerFlagged: fl.length ? mean(fl.map(function (u) { return rule.gain(u, p); })) : null, gainPerDecision: units.length ? fl.reduce(function (s, u) { return s + rule.gain(u, p); }, 0) / units.length : null };
  }

  // An intended buy against the adopted rules. ctx holds what is known now:
  // { runup, leadH, hour, pVol, pRet, relSize, conviction } (missing = unknown).
  function preTrade(commitments, ctx) {
    const hits = [], unknown = [];
    commitments.filter(function (c) { return c.status === "active"; }).forEach(function (c) {
      const rule = BY_ID[c.ruleId];
      if (!rule || !rule.check) return;
      const needs = { avoid_extrapolation: ["pct12"], cap_lottery: ["lottery", "relSize"], cap_low_attention: ["conviction", "views30", "relSize"], wait_runup: ["runup"], sleep_on_it: ["leadH"], avoid_daypart: ["hour"], pause_turbulent: ["pVol"], cap_turbulent: ["pVol", "relSize"], wait_strong_market: ["pRet"], research_gate: ["conviction", "views30"], wait_crowd: ["crowd"] }[c.ruleId] || [];
      if (needs.some(function (k) { return ctx[k] == null; })) { unknown.push({ id: c.id, ruleId: c.ruleId, text: c.text }); return; }
      const why = rule.check(c.params, ctx);
      if (why) hits.push({ id: c.id, ruleId: c.ruleId, text: c.text, why: why, do: c.do || rule.do(c.params), params: c.params });
    });
    return { hits: hits, unknown: unknown };
  }

  // ---------- settings the user (or the assistant, with the user's click) may choose ----------
  // Bounds for each tunable setting: a share (0.15 = 15%), hours, a percentile, a score
  // or a multiple. A value given in percent (15) for a share is read as 0.15.
  const TUNE = {
    wait_runup: { th: [0.03, 0.6, "share"] }, sleep_on_it: { th: [1, 168, "hours"] }, pause_turbulent: { th: [0.5, 0.95, "share"] },
    wait_strong_market: { th: [0.5, 0.95, "share"] }, research_gate: { th: [0.25, 6, "score"] }, cap_low_attention: { th: [0.25, 6, "score"], cap: [0.5, 5, "multiple"] }, cap_turbulent: { th: [0.5, 0.95, "share"], cap: [0.5, 5, "multiple"] }
  };
  function tune(ruleId, given) {
    const spec = TUNE[ruleId];
    if (!spec || !given) return null;
    const out = {};
    let any = false;
    Object.keys(spec).forEach(function (k) {
      let v = Number(given[k]);
      if (!isFinite(v)) return;
      if (spec[k][2] === "share" && v > 1) v = v / 100;
      out[k] = Math.max(spec[k][0], Math.min(spec[k][1], v));
      any = true;
    });
    return any ? out : null;
  }

  // A fixed setting, judged without fitting: on the whole history (in sample) and on its
  // later half alone, which the user did not see when choosing it. Gains as in validate().
  function whatIf(R, ruleId, given, base) {
    const rule = BY_ID[ruleId];
    const t = tune(ruleId, given);
    if (!rule || !t) return null;
    const p = Object.assign({}, base || {}, t);
    const units = rule.universe(R).filter(rule.applies).sort(function (a, b) { return a.t - b.t; });
    const judge = function (us, seed) {
      const g = us.filter(function (u) { return rule.flag(u, p); }).map(function (u) { return rule.gain(u, p); });
      return { n: us.length, flagged: g.length, mean: g.length ? mean(g) : null, ci95: g.length >= 2 ? bootstrap(g, null, 2000, seed) : null };
    };
    const later = units.slice(Math.floor(units.length / 2));
    return { ruleId: ruleId, params: withExtra(rule, p, R), text: rule.text(withExtra(rule, p, R), R), do: rule.do(p), all: judge(units, 61), laterHalf: judge(later, 67) };
  }

  // A commitment with a setting the user chose instead of the fitted one.
  function commitTuned(R, ruleReport, given, now) {
    const rule = BY_ID[ruleReport.id], t = tune(ruleReport.id, given);
    if (!rule || !t) return null;
    const p = withExtra(rule, Object.assign({}, ruleReport.params || {}, t), R);
    const c = commit(Object.assign({}, ruleReport, { params: p, text: rule.text(p, R), do: rule.do(p) }), now);
    c.tuned = true;
    return c;
  }

  // The decisions in [from, to) that broke an adopted rule (for the weekly review).
  function brokenIn(c, R, from, to) {
    const rule = BY_ID[c.ruleId];
    if (!rule || !c.params) return [];
    return rule.universe(R, true).filter(rule.applies).filter(function (u) { return u.t >= from && u.t < to && rule.flag(u, c.params); })
      .map(function (u) { return { ticker: u.ticker || null, t: u.t }; });
  }

  // ---------- are you leaving your biases behind? ----------
  // Each rule read as a habit: how often your decisions did what it warns against.
  // The setting is the one you adopted, else the fitted one, else a fixed default, so
  // the same habit is measured the same way in every period. `ripe`: days before a
  // unit can be judged (a call is acted on within 30 days, a target within two weeks).
  const HABITS = {
    wait_runup: { def: { th: 0.10 }, label: function (p) { return "buys after a rise of more than " + pc(p.th) + " in 30 days"; } },
    sleep_on_it: { def: { th: 1 }, label: function (p) { return "buys within " + (p.th >= 24 ? p.th / 24 + " day(s)" : p.th + " hour(s)") + " of the first look"; } },
    avoid_daypart: { def: { block: FIXED_PARTS[4] }, label: function (p) { return "buys in the " + p.block.label.toLowerCase() + " (" + p.block.from + "-" + p.block.to + " h)"; } },
    pause_turbulent: { def: { th: 0.8 }, market: function (day, p) { return day.pVol > p.th; }, label: function (p) { return "buys in turbulent markets (the most turbulent " + pc(1 - p.th) + " of days)"; } },
    cap_turbulent: { def: { th: 0.67, cap: 2 }, within: function (u, p) { return u.f.pVol > p.th; }, label: function (p) { return "buys in turbulent markets that were over " + p.cap + "x your usual size"; } },
    wait_strong_market: { def: { th: 0.8 }, market: function (day, p) { return day.pRet > p.th; }, label: function (p) { return "buys after the market's strongest stretches (top " + pc(1 - p.th) + " of days)"; } },
    research_gate: { def: { th: 1 }, label: function () { return "buys with little research before"; } },
    cap_low_attention: { def: { th: 1, cap: 1 }, within: function (u, p) { return u.f.conviction < p.th; }, label: function (p) { return "buys of little-researched stocks that were over " + p.cap + "x your usual size"; } },
    wait_crowd: { def: { th: 2 }, label: function () { return "buys while other users' attention on the stock was high"; } },
    exit_at_target: { def: {}, ripe: 14, label: function () { return "targets reached without a sale"; } },
    act_on_calls: { def: {}, ripe: 30, label: function () { return "Positive calls not acted on"; } }
  };
  const VERDICT_PROGRESS = { fading: "You are leaving it behind.", growing: "It is getting stronger.", no_clear_change: "No clear change yet.", too_few: "Too few recent decisions to tell." };

  // Recent decisions (the last o.days, default 180, up to the end of the file) against
  // all earlier ones, per habit: the shares with 99% ranges (several habits are read side
  // by side), Newcombe's range for the change, a trend over the whole history (a score
  // test of the share against time, with its change per year) and the share per half
  // year. Verdict from the change: "fading" when the 99% range is below zero. Neighbouring
  // decisions are alike (buys come in bursts), so the ranges are somewhat optimistic.
  // A habit about the market (buying in turbulent markets, after strong stretches) moves
  // with the market itself, so its change is taken against the share of trading days in
  // that state in each period (`base`), and it has no whole-history trend. Oversized
  // buys in turbulent markets are counted among the buys in turbulent markets only.
  function progress(R, coachReport, o) {
    o = o || {};
    const fe = R.coverage && R.coverage.fileEnd, end = o.end || (fe != null ? fe + DAY : Date.now()), days = o.days || 180, cut = end - days * DAY, Z = 2.576;
    const fitted = {}, adopted = {};
    (coachReport ? coachReport.rules : []).forEach(function (r) { if (r.recommended) fitted[r.id] = r.params; });
    (o.commitments || []).forEach(function (c) { if (c.status === "active" && !c.kind && c.params) adopted[c.ruleId] = c.params; });
    const half = function (t) { const d = new Date(t); return d.getUTCFullYear() + (d.getUTCMonth() < 6 ? " H1" : " H2"); };
    const habits = [];
    RULES.forEach(function (rule) {
      const h = HABITS[rule.id];
      if (!h) return;
      const p = adopted[rule.id] || fitted[rule.id] || h.def, src = adopted[rule.id] ? "adopted" : fitted[rule.id] ? "fitted" : "default";
      const days = R.market && R.market.days;
      if (h.market && !(days && days.length)) return;
      const units = rule.universe(R, true).filter(rule.applies).filter(function (u) { return u.t < end - (h.ripe || 0) * DAY && (!h.within || h.within(u, p)); });
      if (units.length < NEED.units) return;
      const x = units.map(function (u) { return rule.flag(u, p) ? 1 : 0; });
      const k = function (us) { return us.filter(function (u) { return rule.flag(u, p); }).length; };
      const recent = units.filter(function (u) { return u.t >= cut; }), earlier = units.filter(function (u) { return u.t < cut; });
      const rec = wilson(k(recent), recent.length, Z), ear = wilson(k(earlier), earlier.length, Z);
      let change = rec.n && ear.n ? diffShare(rec, ear) : null;
      if (h.market) {
        const base = function (a, b) { const ds = days.filter(function (d) { return d.t >= a && d.t < b; }); return ds.length ? ds.filter(function (d) { return h.market(d, p); }).length / ds.length : null; };
        rec.base = base(cut, end); ear.base = base(units[0].t, cut);
        const sh = rec.base != null && ear.base != null ? rec.base - ear.base : null;
        change = change && sh != null ? { est: change.est - sh, lo: change.lo - sh, hi: change.hi - sh, market: sh } : null;
      }
      // trend: score test of x against time (Cochran-Armitage with each decision's own time)
      const ts = units.map(function (u) { return u.t / (365.25 * DAY); }), tb = mean(ts), pb = mean(x);
      let sxy = 0, sxx = 0;
      ts.forEach(function (t, i) { sxy += (t - tb) * (x[i] - pb); sxx += (t - tb) * (t - tb); });
      const trend = !h.market && sxx > 0 && pb > 0 && pb < 1 ? { perYear: sxy / sxx, z: sxy / Math.sqrt(pb * (1 - pb) * sxx) } : null;
      if (trend) trend.clear = Math.abs(trend.z) >= Z;
      const path = {};
      units.forEach(function (u, i) { const b = half(u.t); path[b] = path[b] || { period: b, n: 0, k: 0 }; path[b].n++; path[b].k += x[i]; });
      const verdict = rec.n < 8 || ear.n < 8 || !change ? "too_few" : change.hi < 0 ? "fading" : change.lo > 0 ? "growing" : "no_clear_change";
      habits.push({ id: rule.id, bias: rule.bias, title: rule.title, habit: h.label(p), setting: src, recent: rec, earlier: ear, change: change, trend: trend, verdict: verdict, inShort: VERDICT_PROGRESS[verdict],
        path: Object.keys(path).sort().map(function (b) { return { period: b, n: path[b].n, share: path[b].n >= 5 ? path[b].k / path[b].n : null }; }) });
    });
    const order = { fading: 0, growing: 1, no_clear_change: 2, too_few: 3 };
    habits.sort(function (a, b) { return order[a.verdict] - order[b.verdict]; });
    return { days: days, from: cut, to: end, habits: habits, fading: habits.filter(function (x) { return x.verdict === "fading"; }).length, growing: habits.filter(function (x) { return x.verdict === "growing"; }).length };
  }

  const api = { RULES: RULES, NEED: NEED, detect: detect, progress: progress, validate: validate, coach: coach, commit: commit, adherence: adherence, simulate: simulate, preTrade: preTrade, tune: tune, whatIf: whatIf, commitTuned: commitTuned, brokenIn: brokenIn, TUNE: TUNE, walkForward: walkForward, fit: fit,
    ruleById: function (id) { return BY_ID[id]; } };
  if (typeof self !== "undefined") self.ATBiases = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
