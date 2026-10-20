// Tests for the two agents and their paper portfolios (src/shadow.js) on synthetic
// investors (tools/synth-world.js), and for the AI agent's request (task "decide"
// of supabase/functions/ai-coach/core.mjs, mock provider). Synthetic data only.
// Run: node tools/test-shadow.js (exit code 1 on failure).
const path = require("path");
const { pathToFileURL } = require("url");
const D = require(path.join(__dirname, "..", "src", "decisions.js"));
const I = require(path.join(__dirname, "..", "src", "indicators.js"));
const T = require(path.join(__dirname, "..", "src", "aitools.js"));
const B = require(path.join(__dirname, "..", "src", "biases.js"));
const AI = require(path.join(__dirname, "..", "src", "aiclient.js"));
const SH = require(path.join(__dirname, "..", "src", "shadow.js"));
const W = require(path.join(__dirname, "synth-world.js"));
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? "PASS " : "FAIL ") + m); };
const DAY = 864e5;
const pts = (x) => x == null ? "-" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + " pts";
const rngTxt = (ci) => ci && ci.lo != null ? " [" + pts(ci.lo) + ", " + pts(ci.hi) + "]" : "";
const report = (input) => { const R = D.analyze(input); R.ind = I.analyze(input, R); return R; };
const shadow = (input, o) => { const R = report(input); return { R, S: SH.run(Object.assign({ R, input, now: input.now }, o || {})) }; };

(async function () {
  // --- 1. no look-ahead: what happens after t does not change the agent's decisions before it ---
  // On a weekday calendar (so 21 or 84 bars are more calendar days than bars), with community
  // data and some date-only buys; after t the prices, later trades, views, calls and the
  // community's counts are all changed.
  const w1 = W.buildWorld({ seed: 71, runupMean: 0.08, chase: -0.08, nBuys: 200, bars: 1300 });
  const a = shadow(w1.input);
  {
    const w0 = W.buildWorld({ seed: 71, runupMean: 0.08, chase: -0.08, nBuys: 200, bars: 1300, weekdays: true, crowd: { follow: 0.3, edge21: -0.05 } });
    let nDateOnly = 0;
    w0.input.txs.forEach((t, i) => { if (t.kind === "buy" && i % 4 === 0) { t.dateOnly = true; t.ts = Date.parse(t.date + "T12:00:00"); nDateOnly++; } });
    const a0 = shadow(w0.input);
    // t two bars after a buy the rules agent held back for a run-up for a while, so that its wait runs past t
    const held = a0.S.trades.rules.filter((d) => d.action === "wait" && d.days >= 4 && d.rules.indexOf("wait_runup") >= 0 && d.date >= w0.dates[850]).sort((x, y) => x.t - y.t)[0], kt = w0.dates.indexOf(held.date) + 2;
    const mid = w0.dates[kt], cutT = Date.parse(mid + "T00:00:00Z"), early = Date.parse(w0.dates[kt - 15] + "T00:00:00Z");
    const input2 = JSON.parse(JSON.stringify(w0.input)), r = W.rng(99);
    const bend = (s) => s.map((b) => (b.date > mid ? { date: b.date, close: b.close * (0.6 + 0.8 * r()) } : b));
    input2.bench = bend(input2.bench);
    Object.keys(input2.prices).forEach((k) => { input2.prices[k] = bend(input2.prices[k]); });
    input2.txs = input2.txs.filter((t) => t.date <= mid || r() > 0.25);
    input2.txs.forEach((t) => { if (t.date > mid) { t.amount = Math.round(t.amount * (0.3 + 2 * r())); t.qty = t.qty * (0.5 + r()); } });
    const later = (list) => list.filter((e) => e.ts <= cutT || r() > 0.4).map((e) => (e.ts > cutT ? Object.assign({}, e, { ts: e.ts + Math.floor(r() * 3 * DAY) }) : e)).sort((x, y) => x.ts - y.ts);
    input2.intraday = later(input2.intraday);
    input2.events = later(input2.events);
    input2.community.forEach((row) => { row.days.forEach((d) => { if (d[0] > mid) d[1] = Math.round(d[1] * 3 * r()); }); });
    const b = shadow(input2);
    const key = (d) => [d.action, d.days, d.size.toFixed(12), d.rules.join(",")].join("|");
    const by = {};
    b.S.trades.rules.concat(b.S.looks.rules).forEach((d) => { by[d.id] = d; });
    const before = a0.S.trades.rules.concat(a0.S.looks.rules).filter((d) => d.t <= early);
    const diff = before.filter((d) => !by[d.id] || key(by[d.id]) !== key(d));
    const acted = before.filter((d) => d.action !== "buy").length;
    ok(nDateOnly > 30 && before.length > 100 && diff.length === 0, "no look-ahead: " + before.length + " decisions up to 15 trading days before t (" + acted + " not plain buys, " + nDateOnly + " date-only buys in the world) are identical after everything after t is changed (" + diff.length + " differ)");
    // the reasoning kept with a decision (the readings of the rules that acted, what was measured, the rules in force) is point in time too
    const whyKey = (d) => JSON.stringify([d.why, d.features, d.active]);
    const diffWhy = before.filter((d) => !by[d.id] || whyKey(by[d.id]) !== whyKey(d));
    ok(before.some((d) => d.why.length > 0) && diffWhy.length === 0, "no look-ahead: the readings, the measured features and the rules in force kept with the " + before.length + " decisions are identical too (" + diffWhy.length + " differ)");
    const sa = a0.S.snapshots.filter((s) => s.t <= cutT), sb = b.S.snapshots.filter((s) => s.t <= cutT);
    const active = sa.reduce((n, s) => n + s.rules.length, 0);
    ok(sa.length > 10 && JSON.stringify(sa) === JSON.stringify(sb), "no look-ahead: the " + sa.length + " monthly snapshots up to t (" + active + " active rule-months) are identical");
    // every buy rule, active or not: its training units known by t, and its fit and walk-forward at each month start up to t
    const cxa = SH.context(a0.R, w0.input, w0.input.community), cxb = SH.context(b.R, input2, input2.community), moved = [];
    let checks = 0;
    SH.BUY_RULES.map(B.ruleById).filter(Boolean).forEach((rule) => {
      const ua = SH.pitUnits(rule, a0.R, cxa).filter((u) => u.tEnd <= cutT), ub = SH.pitUnits(rule, b.R, cxb).filter((u) => u.tEnd <= cutT);
      if (JSON.stringify(ua) !== JSON.stringify(ub)) { moved.push(rule.id + " units"); return; }
      let n = -1;
      sa.forEach((s) => {
        const train = ua.filter((u) => u.tEnd <= s.t);
        if (train.length === n) return;
        n = train.length; checks++;
        const fa = [B.fit(rule, train, a0.R, {}), train.length ? B.walkForward(rule, train, 5, a0.R, {}) : null], fb = [B.fit(rule, train, b.R, {}), train.length ? B.walkForward(rule, train, 5, b.R, {}) : null];
        if (JSON.stringify(fa) !== JSON.stringify(fb)) moved.push(rule.id + " " + s.month);
      });
    });
    ok(!moved.length && checks > 20, "no look-ahead: every buy rule's units known by t and its fit and walk-forward at each month up to t are identical (" + SH.BUY_RULES.length + " rules, " + checks + " fits; differ: " + (moved.join(", ") || "none") + ")");
    // what the AI agent is told about every candidate before t
    const ca = a0.S.trades.candidates.concat(a0.S.looks.candidates).filter((c) => c.t < cutT), cb = {};
    b.S.trades.candidates.concat(b.S.looks.candidates).forEach((c) => { cb[c.id] = c; });
    const ctxDiff = ca.filter((c) => !cb[c.id] || JSON.stringify(SH.contextFor(c, a0.R, w0.input, SH.snapshotAt(a0.S.snapshots, c.t), { community: w0.input.community })) !==
      JSON.stringify(SH.contextFor(cb[c.id], b.R, input2, SH.snapshotAt(b.S.snapshots, c.t), { community: input2.community })));
    ok(ca.length > 200 && !ctxDiff.length, "no look-ahead: what the AI agent is told about each of the " + ca.length + " candidates before t is identical (" + ctxDiff.length + " differ)");
    const laterA = a0.S.snapshots.filter((s) => s.t > cutT + 60 * DAY), laterB = b.S.snapshots.filter((s) => s.t > cutT + 60 * DAY);
    ok(JSON.stringify(laterA) !== JSON.stringify(laterB) || laterA.every((s) => !s.rules.length), "the test can see a change: snapshots after t do move with the scrambled prices");
    // a date-only buy's crowd is read from the moment the wait_crowd units use (its own day, not the next midnight UTC)
    const units = {};
    (a0.R.ind.crowdBuys.buyUnits || []).forEach((u) => { units[u.id] = u; });
    const dOnly = a0.S.trades.candidates.filter((c) => c.dateOnly && units[c.inst + "|" + c.date]);
    ok(dOnly.length > 20 && dOnly.every((c) => SH.featuresAt(c, 0, cxa).crowd === units[c.inst + "|" + c.date].f.crowd),
      "crowd: for " + dOnly.length + " date-only buys the rules agent reads the same crowd ratio as the wait_crowd units it was fitted on");
  }

  // --- 2. accounting ---
  {
    const P = a.S.trades.portfolio, ids = a.S.trades.candidates.map((c) => c.id);
    const all = (action) => ids.map((id) => ({ id, action, days: 0, size: action === "pass" ? 0 : 1 }));
    const buy = SH.run({ R: a.R, input: w1.input, now: w1.input.now, aiDecisions: all("buy") }).trades.portfolio;
    const pass = SH.run({ R: a.R, input: w1.input, now: w1.input.now, aiDecisions: all("pass") }).trades.portfolio;
    ok(P && P.dates.length > 500 && buy.ai.every((v, i) => v === buy.you[i]), "accounting: an agent that buys everything at once equals you exactly on every day (" + P.dates.length + " days)");
    ok(pass.ai.every((v, i) => v === pass.nasdaq[i]), "accounting: an agent that passes on everything equals the NASDAQ exactly on every day");
    ok(P.nasdaq.every((v) => v > 0) && Math.abs(P.you[0] - 1) < 1e-9 && P.ai === null, "accounting: day one is the money put in, and without AI decisions there is no AI line");
    // one stock rising 1% a day, a flat NASDAQ, a buy of 10 at 150 on day 50, half sold later
    const tiny = (sellDay) => {
      const N = 300, t0 = Date.parse("2024-01-01T12:00:00Z"), dates = Array.from({ length: N }, (_, i) => new Date(t0 + i * DAY).toISOString().slice(0, 10));
      const X = dates.map((d, i) => ({ date: d, close: 100 * (1 + 0.01 * i) }));
      return { txs: [{ broker: "t", extId: "b", ts: t0 + 50 * DAY, date: dates[50], kind: "buy", isin: "XX0000000001", symbol: "X", name: "X", qty: 10, amount: 1500, currency: "EUR", assetClass: "STOCK" },
        { broker: "t", extId: "s", ts: t0 + sellDay * DAY, date: dates[sellDay], kind: "sell", isin: "XX0000000001", symbol: "X", name: "X", qty: 5, amount: 5 * X[sellDay].close, currency: "EUR", assetClass: "STOCK" }],
      links: { XX0000000001: { ticker: "X", symbol: "X" } }, intraday: [], events: [], prices: { X: X }, bench: dates.map((d) => ({ date: d, close: 100 })), tickerSymbol: { X: "X" }, now: t0 + (N - 1) * DAY };
    };
    const t1 = tiny(100), R1 = report(t1), id1 = SH.run({ R: R1, input: t1, now: t1.now }).trades.candidates[0].id;
    const half = SH.run({ R: R1, input: t1, now: t1.now, aiDecisions: [{ id: id1, action: "buy", days: 0, size: 0.5 }] }).trades.portfolio;
    const last = half.dates.length - 1;
    // agent: 5 shares + 7.5 units of the NASDAQ; half the shares sold at 200 -> 2.5 shares + 12.5 units; you: 5 shares + 10 units
    ok(Math.abs(half.ai[last] - (2.5 * 399 + 12.5 * 100) / 1500) < 1e-9 && Math.abs(half.you[last] - (5 * 399 + 10 * 100) / 1500) < 1e-9,
      "mirrored sells: a half-size agent sells the same half of its position on the day you do (" + half.ai[last].toFixed(4) + " vs you " + half.you[last].toFixed(4) + ")");
    const t2 = tiny(52), R2 = report(t2), id2 = SH.run({ R: R2, input: t2, now: t2.now }).trades.candidates[0].id;
    const wait = SH.run({ R: R2, input: t2, now: t2.now, aiDecisions: [{ id: id2, action: "wait", days: 5, size: 1 }] }).trades.portfolio;
    // you sold half before the agent bought: it buys only half, at 155, on day 55
    ok(Math.abs(wait.ai[last] - (0.5 * 1500 / 155 * 399 + 7.5 * 100) / 1500) < 1e-9, "mirrored sells: a sale before the agent's delayed buy shrinks that buy by the same fraction (" + wait.ai[last].toFixed(4) + ")");
  }

  // --- 3. planted: a chasing investor; and a world with no effect ---
  const wc = w1, c = a;
  {
    const recs = c.S.trades.rules.slice().sort((x, y) => x.t - y.t), half = recs.slice(Math.floor(recs.length / 2));
    const runupOf = {};
    c.R.decisions.forEach((d) => { if (d.side === "buy") runupOf[d.inst + "|" + d.date] = d.runup30; });
    const cand = {};
    c.S.trades.candidates.forEach((x) => { cand[x.id] = x; });
    const hot = half.filter((d) => runupOf[cand[d.id].inst + "|" + d.date] > 0.1), held = hot.filter((d) => d.action !== "buy");
    const calm = half.filter((d) => runupOf[cand[d.id].inst + "|" + d.date] < 0), calmHeld = calm.filter((d) => d.action !== "buy");
    ok(hot.length >= 8 && held.length >= 0.7 * hot.length && calmHeld.length / Math.max(1, calm.length) < held.length / hot.length,
      "planted chasing: on the later half the rules agent waits or passes on " + held.length + " of " + hot.length + " buys after a run-up of more than 10%, and on " + calmHeld.length + " of " + calm.length + " after a fall");
    const gap = (h) => { const xs = half.filter((d) => d.ex[h]).map((d) => d.ex[h].agent - d.ex[h].you); return Object.assign({ n: xs.length }, D.stats.bootstrap(xs, null, 2000, 5 + h, 0.99)); };
    const g63 = gap(63), g21 = gap(21);
    ok(g63.lo > 0 || g21.lo > 0, "planted chasing: on the later half the rules agent beats you per buy: 63 days " + pts(g63.est) + rngTxt(g63) + ", 21 days " + pts(g21.est) + rngTxt(g21) + " (99%, " + g63.n + " buys)");
    const P = c.S.trades.portfolio, i = P.dates.length - 1;
    console.log("  portfolio on the last day: you " + P.you[i].toFixed(3) + ", rules agent " + P.rules[i].toFixed(3) + ", NASDAQ " + P.nasdaq[i].toFixed(3));
  }
  {
    let inside = 0;
    const seeds = [81, 82, 83], lines = [];
    seeds.forEach((seed) => {
      const n = shadow(W.buildWorld({ seed, nBuys: 200, bars: 1300 }).input).S, p = n.trades.paired[63].rules;
      if (p.diff.lo <= 0 && p.diff.hi >= 0) inside++;
      lines.push(pts(p.diff.est) + rngTxt(p.diff) + " (" + n.trades.rules.filter((d) => d.action !== "buy").length + " not plain buys)");
    });
    ok(inside === seeds.length, "null worlds: the rules agent's 63-day difference range includes 0 in " + inside + " of " + seeds.length + ": " + lines.join("; "));
  }

  // --- 4. looks ---
  {
    const L = c.S.looks, byT = {};
    L.candidates.forEach((x) => { (byT[x.ticker] = byT[x.ticker] || []).push(x.t); });
    const close = Object.keys(byT).some((t) => byT[t].some((x, i) => i > 0 && x - byT[t][i - 1] < 30 * DAY));
    const views = {};
    wc.input.intraday.forEach((e) => { (views[e.ticker] = views[e.ticker] || []).push(e.ts); });
    const fresh = L.candidates.every((x) => !views[x.ticker].some((v) => v < x.t && x.t - v < 30 * DAY));
    ok(L.candidates.length > 100 && !close && fresh, "looks: " + L.candidates.length + " episodes, none within 30 days of another on the same stock, none with a view in the 30 days before");
    const h = L.horizons[63];
    ok(h.every.n > 0 && h.rules.n > 0 && h.rules.n <= h.every.n && h.bought.n > 0 && h.nasdaq.mean === 0 && h.every.cum.length > 0,
      "looks, 63 days: every look " + pts(h.every.mean) + rngTxt(h.every) + " (" + h.every.n + ", hit " + Math.round(h.every.hit * 100) + "%), rules agent " + pts(h.rules.mean) + " (" + h.rules.n + "), what you bought " + pts(h.bought.mean) + " (" + h.bought.n + ")");
    // a look after the 16:00 ET close enters at the next close, never at one that had already printed
    const N = 200, d0 = Date.parse("2024-05-01T00:00:00Z"), dates = Array.from({ length: N }, (_, i) => new Date(d0 + i * DAY).toISOString().slice(0, 10)).filter((d) => [0, 6].indexOf(new Date(d).getUTCDay()) < 0);
    const X = dates.map((d, i) => ({ date: d, close: 100 + i })), lin = { txs: [], links: {}, events: [], prices: { X: X }, bench: dates.map((d) => ({ date: d, close: 100 })), tickerSymbol: { X: "X" }, now: Date.parse(dates[dates.length - 1] + "T22:00:00Z"),
      intraday: [{ ticker: "X", ts: Date.parse("2024-06-03T21:00:00Z"), dwellMs: 1000 }, { ticker: "X", ts: Date.parse("2024-07-15T15:00:00Z"), dwellMs: 1000 }, { ticker: "X", ts: Date.parse("2024-08-30T20:30:00Z"), dwellMs: 1000 }] };
    const lc = SH.run({ R: report(lin), input: lin, now: lin.now }).looks.candidates.map((x) => x.date + ">" + x.series[x.i0].date);
    ok(lc.join() === "2024-06-04>2024-06-04,2024-07-15>2024-07-15,2024-08-31>2024-09-02", "looks: a look at 17:00 ET counts for the next trading day, one at 11:00 ET for its own day (" + lc.join(", ") + ")");
  }

  // --- 5. before / after the app start ---
  {
    const wb = W.buildWorld({ seed: 91, runupMean: 0.08, chase: -0.08, nBuys: 200, bars: 1300, appStartAt: 0.5, after: { runupMean: 0, impulseShare: 0.02 } });
    const ba = shadow(wb.input).S.trades.beforeAfter, x = ba.horizons[63], y = ba.horizons[21];
    const startBar = Math.floor(0.5 * 1300), t0 = Date.parse(wb.dates[0] + "T12:00:00Z");
    ok(ba.appStart != null && ba.appStart >= t0 + startBar * DAY && ba.appStart - (t0 + startBar * DAY) < 10 * DAY && ba.enough, "before/after: the app start is the first view not from a history import (bar " + Math.round((ba.appStart - t0) / DAY) + ")");
    ok(x.after.gap.est < x.before.gap.est && y.after.gap.est < y.before.gap.est, "before/after: the gap (agent minus you) shrinks once you stop chasing: 63 days " + pts(x.before.gap.est) + " (" + x.before.n + ") -> " + pts(x.after.gap.est) + " (" + x.after.n + "), change " + pts(x.change.est) + rngTxt(x.change) +
      "; 21 days " + pts(y.before.gap.est) + " -> " + pts(y.after.gap.est));
    ok(ba.habits.length > 0 && /not proof/.test(ba.note), "before/after: habits measured on each side (" + ba.habits.map((h) => h.id + " " + Math.round(h.before.p * 100) + "%->" + Math.round(h.after.p * 100) + "%").join(", ") + ")");
    const plain = W.buildWorld({ seed: 91, runupMean: 0.08, chase: -0.08, nBuys: 200, bars: 1300 }), same = W.buildWorld({ seed: 91, runupMean: 0.08, chase: -0.08, nBuys: 200, bars: 1300, after: { runupMean: 0 } });
    ok(JSON.stringify(plain.input) === JSON.stringify(same.input) && !plain.input.intraday.some((e) => e.source), "synth world: without appStartAt the world is unchanged (no history views, `after` ignored)");
  }

  // --- 6. the AI agent's request ---
  {
    const core = await import(pathToFileURL(path.join(__dirname, "..", "supabase", "functions", "ai-coach", "core.mjs")).href);
    const S = c.S, R = c.R, input = wc.input;
    const pick = S.trades.candidates.slice(-10).concat(S.looks.candidates.slice(-5));
    const ctxs = pick.map((x) => SH.contextFor(x, R, input, SH.snapshotAt(S.snapshots, x.t), {}));
    const body = { v: 1, task: "decide", candidates: ctxs }, raw = JSON.stringify(body);
    const keys = [];
    const walk = (o) => { if (o && typeof o === "object") Object.keys(o).forEach((k) => { if (!Array.isArray(o)) keys.push(k); walk(o[k]); }); };
    walk(ctxs);
    const bad = keys.filter((k) => /^(amount|amounts|isin|iban|qty|quantity|price|prices|broker|brokers|name|names|symbol|ticker|account|extid|currency|fee|fees|tax|email|password|token)$/i.test(k));
    ok(!/\b[SPN]\d+\b/.test(raw) && !/\d{4}-\d{2}-\d{2}/.test(raw) && !bad.length && !core.looksPrivate(ctxs) && !T.isPrivate(ctxs),
      "decide request without names: no ticker-like strings, no dates, no forbidden keys, passes both privacy checks (" + raw.length + " bytes for " + ctxs.length + " candidates)");
    ok(ctxs.every((x) => x.rulesAgent && x.pricePath.length > 5 && x.market && x.yourRecordThen && /^Stock \d+$/.test(x.stock) && /^day \d+$/.test(x.date)) && ctxs.some((x) => x.rulesThen.length) && ctxs.every((x) => JSON.stringify(x).length <= 5000),
      "decide request: each candidate carries the price path, market, record, rules then and what the rules agent said, within 5000 characters");
    ok(ctxs.every((x) => ["buy", "wait"].indexOf(x.rulesAgent.action) >= 0 && Object.keys(x.rulesAgent).sort().join() === "action,rules,size" && x.rulesAgent.rules.every((y) => y.id && y.now && y.do)) && ctxs.some((x) => x.rulesAgent.rules.length),
      "decide request: the rules agent as it stood at the moment (buy or wait, the size, each rule's reading and instruction), never its wait length or a pass");
    const named = SH.contextFor(pick[0], R, input, SH.snapshotAt(S.snapshots, pick[0].t), { names: true });
    ok(named.stock === pick[0].ticker && named.date === pick[0].date && named.company, "decide request with names: the ticker, company and date are given");
    const user = { id: "u-1" }, env = { AI_PROVIDER: "mock", AI_ALLOWED_USERS: "u-1" };
    const post = (b, over) => core.handle(Object.assign({ raw: JSON.stringify(b), user, env, bump: async () => 1, callModel: async () => { throw new Error("no model"); } }, over || {}));
    const m = await post(body);
    ok(m.status === 200, "decide: the service has the task (" + m.status + ")");
    const same = m.status === 200 && m.json.decisions.length === ctxs.length && m.json.decisions.every((d, i) => {
      const r = ctxs[i].rulesAgent;
      return d.id === ctxs[i].id && d.action === r.action && d.days === (r.action === "wait" ? 1 : 0) && Math.abs(d.size - 0.05 * r.size) < 1e-9;
    });
    ok(same, "decide, mock provider: follows what the rules agent said at that moment, with a weight of 5% cut by its share (" + (m.json.decisions || []).map((d) => d.action + (d.days ? d.days : "")).join(" ") + ")");
    const reply = { choices: [{ message: { content: JSON.stringify({ decisions: [{ id: "nope", action: "buy", days: 0, size: 1 }, { id: "toString", action: "buy" },
      { id: ctxs[0].id, action: "wait", days: 99, size: 7, reason: "x".repeat(500) }, { id: ctxs[1].id, action: "pass", days: 3, size: 1 }, { id: ctxs[2].id, action: "sell" }] }) } }] };
    const g = await post(body, { env: { AI_MODEL: "main-m", AI_ALLOWED_USERS: "u-1" }, callModel: async () => reply });
    const d = g.json.decisions || [];
    ok(g.status === 200 && d.length === 2 && d[0].days === 10 && d[0].size === 0.2 && d[0].reason.length <= 200 && d[1].action === "pass" && d[1].size === 0 && d[1].days === 0,
      "decide, model reply: unknown ids (also toString) and actions dropped, days and size clamped, reason cut");
    ok((await post(Object.assign({}, body, { names: true }), { env: Object.assign({}, env, { AI_NAMES_OK: "false" }) })).status === 403, "decide with names while AI_NAMES_OK is false: 403");
    // through ATAI.decide the ids go out per request (c1, c2, ...), so they cannot be hashed back to a stock and a day
    let sentRaw = null;
    const res = await AI.decide(ctxs, { consented: true, transport: async (b) => { sentRaw = b; return (await post(JSON.parse(b))).json; } });
    const sentIds = JSON.parse(sentRaw).candidates.map((x) => x.id);
    ok(sentIds.every((id, i) => id === "c" + (i + 1)) && ctxs.every((x) => sentRaw.indexOf(x.id) < 0) && res.decisions.map((x) => x.id).join() === ctxs.map((x) => x.id).join(),
      "decide through ATAI: none of the stored ids (hashes of the stock and the day) is sent; the answers come back under them");
    // call notes: other stocks' names and the own name in any case are replaced too
    const own = pick[0].ticker, other = Object.keys(input.tickerSymbol).find((t) => t !== own && /^S/.test(t));
    const input3 = Object.assign({}, input, { events: input.events.concat([{ ticker: own, ts: pick[0].t - 2 * DAY, sentiment: "positive", rationale: "Rotating out of " + other.toLowerCase() + " corp into this; " + own.toLowerCase() + " CORP leads." }]) });
    const note = SH.contextFor(pick[0], R, input3, SH.snapshotAt(S.snapshots, pick[0].t), {}).calls.map((x) => x.note).find((n) => n && /leads/.test(n));
    ok(!/corp/i.test(note) && /another stock/.test(note) && /Stock \d+ leads/.test(note), "decide request: call notes name no other stock and not the own one in another case (" + note + ")");
  }

  // --- the pre-trade check: no_quick_switch is checked from the last sale; a rule only counts as unchecked when a feature it reads is missing ---
  {
    const snap = { rules: [{ ruleId: "cap_lottery", params: { cap: 0.5 } }, { ruleId: "no_quick_switch", params: { th: 7 } }] };
    const v1 = SH.verdictNow(snap, { lottery: false, relSize: 1.5 }), v2 = SH.verdictNow(snap, { lottery: false, relSize: 1.5, sinceSell: 0.5 });
    ok(v1.action === "buy" && v1.unchecked.join() === "no_quick_switch" && v2.action === "wait" && v2.delaying.join() === "no_quick_switch" && !v2.unchecked.length,
      "check: a non-lottery stock is checked against cap_lottery; without the last sale no_quick_switch is unchecked, a sale yesterday makes it wait");
    const cx = SH.context(c.R, wc.input), sell = c.R.decisions.filter((x) => x.side === "sell" && !x.auto).sort((x, y) => x.cut - y.cut).pop();
    ok(sell && Math.abs(SH.sinceSellAt(cx, sell.cut + DAY, null, "nothing") - 1) < 1e-9 && SH.sinceSellAt(cx, sell.cut + DAY, null, sell.ticker) === null, "check: days since the last sale of something else (none when the last sale is of this stock)");
  }

  // --- crowd: the rules agent uses wait_crowd once it holds up (needs the community data) ---
  {
    const wc = W.buildWorld({ seed: 41, nBuys: 200, bars: 1100, crowd: { follow: 0.4, edge21: -0.06 } }), { R, S } = shadow(wc.input);
    const months = S.snapshots.filter((s) => s.rules.some((r) => r.ruleId === "wait_crowd"));
    const fired = S.trades.rules.filter((d) => d.rules.indexOf("wait_crowd") >= 0), ex = fired.filter((d) => d.ex[21]).map((d) => d.ex[21].agent - d.ex[21].you);
    const cx = SH.context(R, wc.input, wc.input.community), f0 = fired.length ? SH.featuresAt(S.trades.candidates.find((c) => c.id === fired[0].id), 0, cx) : null;
    ok(R.ind.crowdBuys.n > 0 && months.length > 0 && fired.length > 0 && fired.every((d) => d.action !== "buy") && f0 && f0.crowd > 1,
      "crowd: wait_crowd is active in " + months.length + " of " + S.snapshots.length + " months and holds back " + fired.length + " buys right after a crowd spike (agent minus you at 21 days " + pts(ex.length ? ex.reduce((x, y) => x + y, 0) / ex.length : null) + ", " + ex.length + " buys)");
    const bare = SH.context(R, wc.input, null);
    ok(SH.featuresAt(S.trades.candidates[0], 0, bare).crowd === null, "crowd: without community data the crowd feature is null, so wait_crowd cannot fire");
  }

  // --- speed ---
  {
    const wp = W.buildWorld({ seed: 3, nBuys: 300, bars: 1300, runupMean: 0.08, chase: -0.08 }), R = report(wp.input);
    const t = Date.now(), S = SH.run({ R, input: wp.input, now: wp.input.now }), ms = Date.now() - t;
    ok(ms < 3000, "speed: run() on " + S.trades.candidates.length + " buys and " + S.looks.candidates.length + " looks took " + ms + " ms");
    const t2 = Date.now(), S2 = SH.run({ R, input: wp.input, now: wp.input.now, aiDecisions: S.trades.rules.slice(0, 15) }), ms2 = Date.now() - t2;
    ok(ms2 < ms && S2.trades.ai.length === 15 && JSON.stringify(S2.snapshots) === JSON.stringify(S.snapshots), "speed: a run after new AI decisions on the same input reuses the monthly snapshots (" + ms2 + " ms)");
    const byId = {};
    S.trades.candidates.concat(S.looks.candidates).forEach((x) => { byId[x.id] = x; });
    const pend = S.trades.rules.concat(S.looks.rules).filter((d) => d.pending);
    // the same held-up buys with the prices ending the day after: still waiting, not passed
    const held = S.trades.rules.filter((d) => d.action === "pass" || d.days > 1).slice(0, 10), cx = SH.context(R, wp.input, null);
    const cut = held.map((d) => { const x = byId[d.id]; return SH.decide(Object.assign({}, x, { series: x.series.slice(0, x.i0 + 2) }), SH.snapshotAt(S.snapshots, x.t), cx); });
    ok(held.length === 10 && cut.every((d) => d.pending && d.action === "pass") && pend.every((d) => byId[d.id].i0 + SH.MAX_WAIT >= byId[d.id].series.length),
      "a wait cut short by the end of the prices is pending (counted as not bought so far, not saved as a final pass): " + cut.filter((d) => d.pending).length + " of " + held.length);
    S.facts.forEach((f) => console.log("  " + f));
  }

  // --- a look from the last 2 days whose trading day has no closing price yet is decided live ---
  {
    const w = W.buildWorld({ seed: 72, nBuys: 60, bars: 900 }), input = JSON.parse(JSON.stringify(w.input));
    const R = report(input), tk = Object.keys(input.prices)[0], series = input.prices[tk], last = series[series.length - 1].date;
    const now = Date.parse(last + "T00:00:00Z") + 86400000 + 15 * 3600000; // the day after the last bar, 15:00 UTC
    input.now = now;
    input.intraday = input.intraday.concat([{ id: "live-look", ticker: tk, ts: now - 3600000, dwellMs: 60000, researchType: "news", scrollDepth: 0.5, focusSwitches: 1 }]);
    const R2 = report(input), ctx = SH.context(R2, input, null), pend = SH.pendingLooks(R2, ctx, now);
    ok(pend.length >= 1 && pend.some((c) => c.ticker === tk && c.pending), "a look of the last 2 days with no bar for its day is a pending candidate: " + pend.length);
    const c = pend.find((x) => x.ticker === tk), S2 = SH.run({ R: R2, input, now });
    ok(!S2.looks.candidates.some((x) => x.id === c.id), "it is not an ordinary candidate yet (no price to enter at)");
    const cx = SH.contextFor(c, R2, input, SH.snapshotAt(S2.snapshots, c.t), { names: false });
    ok(cx.id === c.id && cx.kind === "look" && Array.isArray(cx.pricePath), "the AI agent can be given its context from the prices up to the last close");
    ok(SH.pendingLooks(R2, ctx, now + 3 * 86400000).length === 0, "three days later it is no longer live: the AI agent is not asked about it");
  }

  // --- a repeat view in an unusual burst is a moment for the AI agent: hold, sell or buy more ---
  {
    const w = W.buildWorld({ seed: 73, nBuys: 60, bars: 900 }), input = JSON.parse(JSON.stringify(w.input));
    const tk = Object.keys(input.prices)[0], series = input.prices[tk], last = series[series.length - 1].date;
    const now = Date.parse(last + "T00:00:00Z") + 86400000 + 15 * 3600000, H = 3600000, D1 = 86400000;
    input.now = now;
    input.intraday = input.intraday.filter((e) => e.ticker !== tk);
    const v = (ts, i) => ({ id: "rv" + i, ticker: tk, ts, dwellMs: 60000, researchType: "news", scrollDepth: 0.5, focusSwitches: 1 });
    // a quiet month (4 views), then a burst: 50 h, 30 h and 10 h before now
    input.intraday = input.intraday.concat([20 * D1, 12 * D1, 8 * D1, 5 * D1].map((d, i) => v(now - d, i)), [50 * H, 30 * H, 10 * H].map((d, i) => v(now - d, 10 + i)));
    const R = report(input), ctx = SH.context(R, input, null), start = Date.parse("2026-10-01T00:00:00Z");
    const ai = [{ id: "l1", agent: "ai", kind: "look", ticker: tk, t: now - 40 * D1, action: "buy", size: 0.5, decidedAt: now - 40 * D1 }];
    const a = SH.pendingRevisits(R, ctx, now, ai, 0);
    ok(a.length === 1 && a[0].kind === "revisit" && a[0].burst.views3d >= 3 && /^r/.test(a[0].id), "a burst of repeat views is one moment (the third view in 3 days), once per burst: " + a.length);
    ok(a.length === 1 && a[0].position.holding === true && a[0].position.size === 0.5, "the position comes from the AI agent's own earlier decisions: holding 0.5");
    const flat = SH.pendingRevisits(R, ctx, now, [], 0);
    ok(flat.length === 1 && flat[0].position.holding === false, "without an earlier buy decision it is flat");
    const cx = SH.contextFor(a[0], R, input, SH.snapshotAt(SH.run({ R, input, now }).snapshots, a[0].t), { names: false });
    ok(cx.kind === "revisit" && cx.revisit.views3d >= 3 && cx.revisit.position.holding === true && /^day /.test(cx.date) && JSON.stringify(cx).indexOf(tk + "\"") < 0, "its context says the burst and the position, with the stock and date as aliases");
    ok(SH.pendingRevisits(R, ctx, now, [], now - H).length === 0, "nothing before the start day is decided (the measurement starts there)");
    ok(SH.pendingRevisits(R, ctx, now + 3 * D1, [], 0).length === 0, "three days later it is no longer live");
    ok(SH.pendingRevisits(R, ctx, now + 3 * D1, [], 0, Infinity).some((x) => x.ticker === tk && x.burst.views3d >= 3) && SH.pendingRevisits(R, ctx, now + 3 * D1, [], 0, D1).length === 0, "the live window can be widened (to rebuild the moments of a model comparison) or narrowed");
    const calm = JSON.parse(JSON.stringify(input)); calm.intraday = calm.intraday.filter((e) => !/^rv1[0-2]$/.test(e.id)).concat([14 * D1, 6 * D1].map((d, i) => v(now - d, 30 + i)));
    const Rc = report(calm);
    ok(SH.pendingRevisits(Rc, SH.context(Rc, calm, null), now, [], 0).length === 0, "a few repeat views with no burst are not a moment");
  }

  // --- the AI agent's looks line follows its own selling logic, with no fixed holding period ---
  {
    const w = W.buildWorld({ seed: 74, nBuys: 80, bars: 1000 }), input = w.input, base = shadow(input), cand = base.S.looks.candidates.find((c) => c.i0 + 90 < c.series.length);
    const s = cand.series, i0 = cand.i0, last = s.length - 1, bench = input.bench;
    const cob = (arr, d) => { let r = null; for (const b of arr) { if (b.date <= d) r = b.close; else break; } return r; };
    const exb = (i, j) => s[j].close / s[i].close - cob(bench, s[j].date) / cob(bench, s[i].date);
    const at = (i) => Date.parse(s[i].date + "T16:00:00Z");
    const buy = { id: cand.id, agent: "ai", kind: "look", ticker: cand.ticker, t: cand.t, action: "buy", days: 0, size: 1, decidedAt: cand.t };
    const sell = { id: "rS", agent: "ai", kind: "revisit", ticker: cand.ticker, t: at(i0 + 10), action: "sell", days: 0, size: 0.5, decidedAt: at(i0 + 10) };
    const run = (ai) => SH.run({ R: base.R, input, now: input.now, aiDecisions: ai }).looks.horizons[63].aiSell;
    const none = run([]);
    ok(none === null, "without AI decisions there is no selling-logic line");
    const held = run([buy]);
    ok(held && held.n === 1 && Math.abs(held.cum[held.cum.length - 1].value - exb(i0, last)) < 1e-9 && held.cum[held.cum.length - 1].date === s[last].date, "a bought look with no sell is held to the last close: " + (held && held.n));
    const part = run([buy, sell]);
    const want = 0.5 * exb(i0, i0 + 10) + 0.5 * exb(i0, last);
    ok(part && part.n === 2 && Math.abs(part.cum[part.cum.length - 1].value - want) < 1e-9, "a sale of half closes that half at that day's close and the rest stays open to the last close");
    const more = run([buy, sell, { id: "rB", agent: "ai", kind: "revisit", ticker: cand.ticker, t: at(i0 + 20), action: "buy", days: 0, size: 0.25, decidedAt: at(i0 + 20) }]);
    ok(more && more.n === 3 && Math.abs(more.cum[more.cum.length - 1].value - (want + 0.25 * exb(i0 + 20, last))) < 1e-9, "a buy on a repeat view adds a position from that day");
    const early = run([buy, Object.assign({}, sell, { t: cand.t - 5 * 86400000 })]);
    ok(early && early.n === 1, "a sale dated before the position was opened sells nothing");
    const h21 = SH.run({ R: base.R, input, now: input.now, aiDecisions: [buy, sell] }).looks.horizons;
    ok(Object.keys(h21).join() === "21,42,63,126,252" && h21[21].aiSell === h21[252].aiSell, "the horizons are 1, 2, 3, 6 and 12 months of trading days, and the selling-logic line is the same under each");
  }

  // --- the rules agent keeps its reasoning, and two engines can be compared on the same moments ---
  {
    const all = a.S.trades.rules.concat(a.S.looks.rules), acted = all.filter((d) => d.rules.length > 0), roles = { held: 1, cap: 1, timing: 1 };
    ok(acted.length > 20 && acted.every((d) => d.why.length > 0 && d.why.every((w) => d.rules.indexOf(w.id) >= 0 && roles[w.role] && w.reading && w.title && w.do)) && acted.every((d) => d.features && "runup30" in d.features) && all.every((d) => Array.isArray(d.active)),
      "every rules-agent decision keeps the readings of the rules that acted (with their role and instruction), the measured features and the rules in force: " + acted.length + " acted");
    const w0 = acted.find((d) => d.action === "wait" && d.why.some((w) => w.role === "held"));
    ok(w0 && /%|hour|market|looked|views|return|lottery|crowd|limit|cap/i.test(w0.why[0].reading), "a reading is the rule's own sentence about that moment: " + (w0 && w0.why[0].reading));
    const quiet = all.find((d) => d.active.length > 0 && d.rules.length === 0);
    ok(quiet && /in force for you, but/.test(quiet.reason) && quiet.action === "buy" && quiet.why.length === 0, "with rules in force but none objecting, the reason says so instead of \"no active rule fired\": " + (quiet && quiet.reason));
    const none = all.find((d) => d.active.length === 0);
    ok(none && /No rule had held up/.test(none.reason) && none.why.length === 0, "with no rule in force yet it says that: " + (none && none.reason));
    const cap = acted.find((d) => d.why.some((w) => w.role === "cap"));
    ok(!cap || /% of the amount/.test(cap.reason), "a size cut is worded as a share of the amount: " + (cap && cap.reason));
    // outcomes of a decision can be worked out for any engine's answer in the same way
    const cx = SH.context(a.R, w1.input, w1.input.community), cand = a.S.trades.candidates.find((c) => a.S.trades.rules.some((d) => d.id === c.id && d.ex[63])), dec = a.S.trades.rules.find((d) => d.id === cand.id);
    ok(JSON.stringify(SH.outcome(cand, dec, cx)) === JSON.stringify(dec.ex), "ATShadow.outcome gives the same excess as the one saved with the decision");

    const ex = (you, agent) => ({ 21: { you: you, agent: agent } });
    const rows = [
      { id: "a", kind: "trade", rules: { action: "buy", size: 1, days: 0 }, original: { action: "buy", size: 1, days: 0, ex: ex(0.04, 0.03) }, text: { action: "wait", days: 2, size: 0.5, ex: ex(0.04, 0.02) }, decision: { action: "pass", days: 0, size: 0, ex: ex(0.04, 0), trace: { odds: { buy: 0.1, wait: 0.2, pass: 0.7 } } } },
      { id: "b", kind: "look", rules: { action: "wait", days: 1, size: 1 }, original: { action: "wait", days: 1, size: 1 }, text: { action: "wait", days: 1, size: 1 }, decision: { unsure: true, trace: { odds: { buy: 0.2, wait: 0.45, pass: 0.35 } } } },
      { id: "c", kind: "revisit", rules: null, original: { action: "hold", size: 0, days: 0 }, text: { action: "sell", size: 0.5, days: 0 }, decision: null }];
    const C = SH.compareRuns(rows, 21);
    ok(C.moments === 3 && C.per.text.n === 3 && C.per.decision.n === 1 && C.per.decision.unsure === 1 && C.per.text.unsure === 0 && C.per.rules.n === 2 && C.per.text.actions.sell === 1 && C.per.decision.actions.pass === 1, "compareRuns: what each engine decided, moment by moment, and where the model was not sure enough to decide");
    ok(Math.abs(C.per.text.meanSize - 0.75) < 1e-9 && C.per.decision.meanSize === null && Math.abs(C.per.decision.meanOdds - 0.7) < 1e-9, "compareRuns: the mean size counts only buys and waits; the mean odds are those of the chosen action");
    const g = C.agreement;
    ok(g.textVsDecision.n === 1 && g.textVsDecision.same === 0 && g.textVsDecision.sameShare === 0 && g.textVsRules.n === 2 && g.textVsRules.same === 1 && g.decisionVsRules.n === 1 && g.decisionVsRules.same === 0 && g.textVsOriginal.n === 3 && g.textVsOriginal.same === 1 && g.decisionVsOriginal.n === 1 && g.decisionVsOriginal.same === 0,
      "compareRuns: agreement on the action between the engines, the rules agent and the saved decision: " + JSON.stringify(g.textVsDecision));
    ok(C.matrix["wait | pass"] === 1 && Object.keys(C.matrix).length === 1, "compareRuns: which action the text model took where the decision model took which (an unsure answer is not counted)");
    ok(C.outcome.text.n === 1 && Math.abs(C.outcome.text.mean - 0.02) < 1e-9 && C.outcome.decision.mean === 0 && C.outcome.original.mean === 0.03 && C.outcome.you.n === 1 && C.outcome.you.mean === 0.04 && C.outcome.rules.n === 0 && C.outcome.rules.mean === null,
      "compareRuns: mean excess against the NASDAQ only over the moments that have a result, none for an engine without any");
    ok(/after the fact/.test(C.note) && SH.compareRuns([], 21).moments === 0 && SH.compareRuns([], 21).agreement.textVsDecision.sameShare === null, "compareRuns: says it is decided after the fact, and handles no rows");
  }

  // --- the paper portfolios: weights, full investment and the two views, on a hand-made world ---
  {
    const days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12", "2026-01-13"];
    const bench = days.map((d) => ({ date: d, close: 100 }));
    const aaa = days.map((d, i) => ({ date: d, close: i < 4 ? 10 : 20 })), bbb = days.map((d) => ({ date: d, close: 10 }));
    const at = (d) => Date.parse(d + "T10:00:00Z");
    // views: one of AAA and three of BBB on the first day
    const att = { by: { AAA: { ts: [at(days[0])], cv: [0, 1] }, BBB: { ts: [at(days[0]), at(days[0]) + 1, at(days[0]) + 2], cv: [0, 1, 2, 3] } } };
    const ctx = { bench, att, R: { decisions: [] }, seriesOfTicker: (t) => (t === "AAA" ? aaa : t === "BBB" ? bbb : null) };
    // a buy of BBB on the first day, then one of AAA on the second: yours is then half in each
    const z = { id: "z", kind: "trade", ticker: "BBB", inst: "BBB", ts: at(days[0]), t: at(days[0]), amount: 1000, series: bbb, i0: 0 };
    const buy = { id: "a", kind: "trade", ticker: "AAA", inst: "AAA", ts: at(days[1]), t: at(days[1]), amount: 1000, series: aaa, i0: 1 };
    const keep = (x) => Object.assign({ reason: "" }, x), all = { action: "buy", days: 0, size: 1 };
    const run = (rules, ai, more) => SH.agentPortfolios([z, buy].concat(more || []), [], Object.assign({ z: keep(all), a: keep(rules) }, more ? { b: keep(all) } : {}), Object.assign({ a: keep(ai) }, more ? { b: keep(ai) } : {}), [], ctx).trades;
    const A = run({ action: "buy", days: 0, size: 0.5 }, { action: "buy", days: 0, size: 0.1, weight: 0.1, sizeUnit: "weight" });
    const last = (X, k) => X.lines[k][X.lines[k].length - 1], hold = (X, k) => X.holdings[k][X.holdings[k].length - 1];
    ok(Math.abs(last(A, "you") - 150) < 1e-9 && Math.abs(last(A, "rules") - 125) < 1e-9 && Math.abs(last(A, "ai") - 110) < 1e-9 && last(A, "nasdaq") === 100,
      "paper portfolios (trades): your buy is half of your portfolio (AAA doubles: 150), half of your weight gives 125, a 10% weight 110, the rest stays in the other stock: " + [last(A, "you"), last(A, "rules"), last(A, "ai"), last(A, "nasdaq")].join(" / "));
    const h0 = hold(A, "ai");
    ok(A.dates[0] === "2026-01-05" && Math.abs(h0.stocks.AAA - 400 / 2200) < 1e-9 && Math.abs(h0.stocks.BBB - 1800 / 2200) < 1e-9 && h0.rest < 1e-9 && Math.abs(hold(A, "you").stocks.AAA - 2 / 3) < 1e-9,
      "paper portfolios (trades): a weight of 10% buys 10% of the portfolio in the stock, the money left goes into what it holds, no cash; holdings are shares of the portfolio's value: " + JSON.stringify(h0));
    const B = run({ action: "pass", days: 0, size: 0 }, { action: "wait", days: 2, size: 0.2, weight: 0.2, sizeUnit: "weight" });
    ok(B.lines.rules.every((v) => Math.abs(v - 100) < 1e-9) && Math.abs(hold(B, "rules").stocks.BBB - 1) < 1e-9 && hold(B, "rules").rest < 1e-9, "paper portfolios (trades): on a pass the money goes into what the portfolio holds, not into cash");
    ok(B.lines.ai[3] === 100 && Math.abs(last(B, "ai") - 120) < 1e-9 && hold(B, "ai").rest < 1e-9, "paper portfolios (trades): a wait of 2 days buys on that day, at its price, out of the other positions: " + B.lines.ai.join(","));
    const two = run({ action: "buy", days: 0, size: 1 }, { action: "buy", days: 0, size: 0.1, weight: 0.1, sizeUnit: "weight" }, [Object.assign({}, buy, { id: "b", ts: at(days[2]), t: at(days[2]), i0: 2 })]);
    ok(Math.abs(hold(two, "ai").stocks.AAA * 3300 - 600) < 1e-6, "paper portfolios (trades): a second buy of the same stock brings the weight up to the final weight, no further: 10% of 3000 is 300, worth 600 of 3300 after the doubling = " + hold(two, "ai").stocks.AAA * 3300);
    const sold = SH.agentPortfolios([z, buy], [], { z: keep(all), a: keep(all) }, {}, [], Object.assign({}, ctx, { R: { decisions: [{ side: "sell", inst: "BBB", ts: at(days[2]), date: days[2], qty: 1, posBefore: 1 }] } })).trades;
    ok(Math.abs(hold(sold, "you").stocks.AAA - 1) < 1e-9 && hold(sold, "you").rest < 1e-9 && Math.abs(last(sold, "you") - 200) < 1e-9 && Math.abs(last(sold, "rules") - 200) < 1e-9,
      "paper portfolios (trades): a sale's money leaves the portfolio (it paid for later buys), so it is neither cash nor added to what you still hold; your bars are your positions: " + JSON.stringify(hold(sold, "you")));
    const planCtx = Object.assign({}, ctx, { seriesOfInst: (i) => (i === "AAA" ? aaa : i === "BBB" ? bbb : null),
      R: { decisions: [{ side: "buy", auto: true, inst: "AAA", ticker: "AAA", ts: at(days[1]), cut: at(days[1]), date: days[1], amount: 1000 }] } });
    const plan = SH.agentPortfolios([z], [], { z: keep(all) }, {}, [], planCtx).trades;
    ok(Math.abs(hold(plan, "you").stocks.AAA - 2 / 3) < 1e-9 && Math.abs(hold(plan, "rules").stocks.AAA - 2 / 3) < 1e-9 && Math.abs(last(plan, "you") - 150) < 1e-9,
      "paper portfolios (trades): a savings-plan buy is part of your holdings and every portfolio makes it at your weight: " + JSON.stringify(hold(plan, "you")));
    const usd = Object.assign(bbb.slice(), { currency: "USD" });
    const fxCtx = Object.assign({}, ctx, { toBase: (c, d) => (c === "USD" ? (d >= days[4] ? 0.5 : 1) : 1) });
    const fxT = SH.agentPortfolios([Object.assign({}, z, { series: usd, currency: "EUR" })], [], { z: keep(all) }, {}, [], fxCtx).trades;
    ok(Math.abs(last(fxT, "you") - 50) < 1e-9 && Math.abs(last(fxT, "nasdaq") - 50) < 1e-9, "paper portfolios: prices are valued in your currency at each day's rate (a flat USD stock loses half when the dollar halves): " + last(fxT, "you"));
    // attention: a virtual portfolio of 100 each
    const lA ={ id: "l1", kind: "look", ticker: "AAA", inst: null, ts: at(days[0]), t: at(days[0]), amount: null, series: aaa, i0: 0 };
    const lB = { id: "l2", kind: "look", ticker: "BBB", inst: null, ts: at(days[0]), t: at(days[0]), amount: null, series: bbb, i0: 0 };
    const look = (rules, ai, list) => SH.agentPortfolios([], [lA, lB], rules, ai, list || [], ctx).attention;
    const w = (x) => keep(Object.assign({ action: "buy", days: 0, sizeUnit: "weight" }, x, { size: x.weight }));
    const L = look({ l1: keep(all), l2: keep({ action: "pass", days: 0, size: 0 }) }, { l1: w({ weight: 0.2 }), l2: w({ weight: 0.5 }) });
    const ll = (X, k) => X.lines[k][X.lines[k].length - 1];
    ok(Math.abs(ll(L, "att") - 125) < 1e-9 && Math.abs(hold(L, "att").stocks.AAA - 0.25) < 1e-9 && Math.abs(hold(L, "att").stocks.BBB - 0.75) < 1e-9,
      "paper portfolios (attention): the attention-weighted index holds the stocks by their views in the window (1 of AAA, 3 of BBB; AAA doubles: 125), rebalanced to those weights at every close: " + JSON.stringify(hold(L, "att")));
    ok(Math.abs(ll(L, "rules") - 200) < 1e-9 && Math.abs(ll(L, "ai") - 100 * (1 + 2 / 7)) < 1e-9 && ll(L, "nasdaq") === 100,
      "paper portfolios (attention): the rules agent holds the same basket without the look it passed on (all in AAA), the AI agent's 20% and 50% are topped up in proportion to be fully invested: " + [ll(L, "rules"), ll(L, "ai")].join(" / "));
    const Lw = look({ l1: keep({ action: "wait", days: 2, size: 1 }), l2: keep(all) }, {});
    ok(Lw.lines.rules[2] === 100 && Math.abs(ll(Lw, "rules") - 125) < 1e-9 && Math.abs(hold(Lw, "rules").stocks.AAA - 0.25) < 1e-9 && Lw.lines.ai === null,
      "paper portfolios (attention): the rules agent picks its own lag: a wait of 2 days keeps AAA out of its basket until then, at that day's price: " + Lw.lines.rules.join(","));
    const sell = [{ id: "r1", kind: "revisit", ticker: "AAA", t: Date.parse("2026-01-08T16:00:00Z"), action: "sell", size: 0.5, sizeUnit: "weight" }];
    const L2 = look({}, { l1: w({ weight: 0.2 }), l2: w({ weight: 0.5 }) }, sell);
    ok(Math.abs(ll(L2, "ai") - 100 * (1 + 1 / 7)) < 1e-9, "paper portfolios (attention): a repeat-view sale sells that share of the position and the money goes into the rest: " + ll(L2, "ai"));
    const legacy = look({}, { l1: keep(all), l2: w({ weight: 0.5 }) });
    ok(Math.abs(ll(legacy, "ai") - 100 * (1 + 1 / 11)) < 1e-9, "paper portfolios: a decision saved before weights (a share of the amount) counts as 5% times that share: " + ll(legacy, "ai"));
  }

  // --- the rules you adopted in the coach: the rules agent applies them in every month ---
  {
    const cr = B.coach(a.R, {}).rules.find((r) => r.id === "wait_runup" && r.params);
    const adopted = SH.run({ R: a.R, input: w1.input, now: w1.input.now, commitments: [{ id: "c1", ruleId: "wait_runup", params: cr.params, status: "active", adoptedAt: w1.input.now }] });
    const has = (s) => s.rules.some((r) => r.ruleId === "wait_runup" && r.verdict === "adopted");
    const acts = (L) => L.filter((d) => d.action !== "buy").length;
    ok(adopted.snapshots.length > 0 && adopted.snapshots.every(has) && acts(adopted.trades.rules) >= acts(a.S.trades.rules) && adopted.trades.rules.some((d) => d.action !== "buy" && d.rules.indexOf("wait_runup") >= 0),
      "rules agent: a rule you adopted joins every month with your setting, before you adopted it too, and makes it wait or pass: " + acts(adopted.trades.rules) + " not bought at once vs " + acts(a.S.trades.rules));
    const dropped = SH.run({ R: a.R, input: w1.input, now: w1.input.now, commitments: [{ id: "c1", ruleId: "wait_runup", params: cr.params, status: "dropped" }] });
    ok(!dropped.snapshots.some(has), "rules agent: a rule you dropped is not applied");
  }

  // --- time-weighted indices of the portfolios ---
  {
    const P = a.S.trades.portfolio, t = P.twr, n = P.dates.length;
    ok(t.you.length === n && t.you[0] === 100 && t.nasdaq[0] === 100 && t.ai === null && t.rules.every((v) => v > 0), "twr: every portfolio is an index of 100 on its first day (no AI line without AI decisions)");
    // a buy of the NASDAQ alone is the benchmark: the NASDAQ portfolio's index follows the benchmark's own closes
    const bi = (d) => w1.input.bench.find((b) => b.date === d).close, k = Math.floor(n * 0.7);
    ok(Math.abs(t.nasdaq[k] / 100 - bi(P.dates[k]) / bi(P.dates[0])) < 1e-6, "twr: the NASDAQ portfolio's index is the NASDAQ's own return, whatever money was put in on the way: " + (t.nasdaq[k]).toFixed(2));
  }

  // --- holdings over time: the bars are the lines, taken apart stock by stock ---
  {
    const P = a.S.trades.portfolio, hd = P.holdings, ix = hd.dates.map((d) => P.dates.indexOf(d));
    const sum = (o) => Object.keys(o.stocks).reduce((m, k) => m + o.stocks[k], 0) + o.nasdaq;
    const worst = (key) => Math.max.apply(null, hd[key].map((o, k) => Math.abs(sum(o) - P[key][ix[k]])));
    ok(hd.dates.length > 10 && ix.every((i) => i >= 0) && hd.dates[hd.dates.length - 1] === P.dates[P.dates.length - 1] && worst("you") < 1e-9 && worst("rules") < 1e-9 && worst("nasdaq") < 1e-9 && hd.ai === null,
      "holdings: at every month end each portfolio's stocks plus its NASDAQ add up to its line (largest gap " + worst("you").toExponential(1) + ")");
    ok(hd.nasdaq.every((o) => Object.keys(o.stocks).length === 0) && Object.keys(hd.you[hd.you.length - 1].stocks).length > 3, "holdings: the NASDAQ portfolio holds no stock, yours holds several");
    const L = a.S.looks.horizons[63], lh = SH.looksHoldings(L.positions);
    const pos = L.positions.every[5], mid = pos.from;
    ok(L.positions.every.length === L.every.n && lh.dates.length > 5 && lh.lines.every.length === lh.dates.length && lh.lines.every.every((b) => b.nasdaq === 0), "holdings (looks): the positions behind a line are the line's own, one bar per month end");
    const one = SH.looksHoldings({ x: [{ from: "2026-01-10", exit: "2026-02-20", size: 0.5, ticker: "AAA" }, { from: "2026-02-05", exit: "2026-03-05", size: 1, ticker: "BBB", open: true }] });
    ok(one.dates.join() === "2026-01-31,2026-02-28,2026-03-05" && JSON.stringify(one.lines.x.map((b) => b.stocks)) === JSON.stringify([{ AAA: 0.5 }, { BBB: 1 }, { BBB: 1 }]), "holdings (looks): held from the entry day up to the exit day (an open position through the last day): " + JSON.stringify(one.lines.x.map((b) => b.stocks)));
  }

  if (failed) { console.log(failed + " failed"); process.exit(1); }
  console.log("all passed");
})();
