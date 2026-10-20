// Tests for the phase-1 bias indicators (src/indicators.js). Every indicator gets
// a small world with the effect planted and one without it: the first must be
// found, the second must not be. Synthetic data only.
// Run: node tools/test-indicators.js (exit code 1 on failure).
const path = require("path");
const D = require(path.join(__dirname, "..", "src", "decisions.js"));
const I = require(path.join(__dirname, "..", "src", "indicators.js"));
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? "PASS " : "FAIL ") + m); };
const pc = (x) => x == null ? "-" : (x * 100).toFixed(1) + "%";
const DAY = 864e5, T0 = Date.parse("2024-01-01T00:00:00Z"), N = 720;
const dates = Array.from({ length: N }, (_, i) => new Date(T0 + i * DAY).toISOString().slice(0, 10));
const at = (i, h) => T0 + i * DAY + (h == null ? 14 : h) * 3600e3;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const flat = () => dates.map((d) => ({ date: d, close: 100 }));
// A random walk with daily volatility v, from a seed.
function walk(seed, v, drift) { const r = rng(seed); let p = 100; return dates.map((d) => { p *= 1 + (drift || 0) + v * (r() - 0.5) * 3.46; return { date: d, close: p }; }); }

// A world: stocks with series, trades, views, labels. Returns the analyze input.
function world() {
  const w = { txs: [], links: {}, prices: { IXIC: flat() }, intraday: [], events: [], tickerSymbol: {}, now: at(N - 1, 18) };
  w.bench = w.prices.IXIC;
  w.stock = (tk, series) => { w.prices[tk] = series; w.links["ISIN" + tk] = { ticker: tk, symbol: tk, status: "matched" }; w.tickerSymbol[tk] = tk; };
  w.trade = (kind, tk, i, qty, amount) => w.txs.push({ broker: "t", extId: kind + tk + i + w.txs.length, ts: at(i, 10), date: dates[i], kind: kind, isin: "ISIN" + tk, symbol: tk, name: tk, qty: qty, amount: amount != null ? amount : qty * w.prices[tk][i].close, currency: "EUR", assetClass: "STOCK" });
  w.view = (tk, i, o) => w.intraday.push(Object.assign({ id: "v" + w.intraday.length, ticker: tk, ts: at(i, 12), dwellMs: 60000, researchType: "overview", scrollDepth: 0.5 }, o || {}));
  w.label = (tk, i, sentiment, o) => w.events.push(Object.assign({ id: "e" + w.events.length, ticker: tk, ts: at(i, 20), sentiment: sentiment, views: 1 }, o || {}));
  // research recorded from the start, so trades after day 30 are analysable
  w.stock("ZZZ", flat()); w.view("ZZZ", 0); w.view("ZZZ", N - 2);
  return w;
}
const run = (w, extra) => { const input = Object.assign({}, w, extra || {}); const R = D.analyze(input); return { R, X: I.analyze(input, R) }; };

// --- D4 rank effect: always selling the best position vs a random one ---
function rankWorld(planted, seed) {
  const w = world(), r = rng(seed), tks = ["A", "B", "C", "D", "E", "F"];
  tks.forEach((tk, k) => { w.stock(tk, walk(seed * 10 + k, 0.02)); w.trade("buy", tk, 40, 100); });
  for (let i = 60; i < N - 20; i += 15) {
    const rets = tks.map((tk) => ({ tk, ret: w.prices[tk][i - 1].close / w.prices[tk][40].close }));
    rets.sort((a, b) => a.ret - b.ret);
    const pick = planted ? rets[rets.length - 1].tk : rets[1 + Math.floor(r() * (rets.length - 2))].tk;
    w.trade("sell", pick, i, 1);
  }
  return w;
}
{
  const p = run(rankWorld(true, 3)).X.rank, n = run(rankWorld(false, 4)).X.rank;
  ok(p.status !== "none" && p.clear && p.best.p > 0.9, "rank: selling the best is found (best " + pc(p.best.p) + ", middle " + pc(p.middle.p) + ", n " + p.n + ")");
  ok(!(n.clear && n.diff.est > 0), "rank: selling middle positions is not flagged (diff " + pc(n.diff.est) + ")");
}

// --- D6 repurchase: rebuying only what fell after a sale at a gain ---
function repWorld(planted, seed) {
  const w = world(), r = rng(seed);
  for (let k = 0; k < 40; k++) {
    const tk = "R" + k, b = 40 + k * 12, s = b + 20, down = k % 2 === 0;
    w.stock(tk, dates.map((d, i) => ({ date: d, close: i <= b ? 100 : i <= s ? 100 + (i - b) : 120 * (1 + (down ? -0.004 : 0.004) * (i - s)) })));
    w.trade("buy", tk, b, 10); w.trade("sell", tk, s, 10);
    const rebuy = planted ? down : r() < 0.5;
    if (rebuy) w.trade("buy", tk, s + 40, 5);
  }
  w.trade("buy", "ZZZ", N - 3, 1);
  return w;
}
{
  const p = run(repWorld(true, 5)).X.repurchase, n = run(repWorld(false, 6)).X.repurchase;
  ok(p.clear && p.diff.est > 0 && p.cells.gainDown.p > p.cells.gainUp.p, "repurchase: rebuying after the price fell is found (fell " + pc(p.cells.gainDown.p) + ", rose " + pc(p.cells.gainUp.p) + " per month)");
  ok(!(n.clear && n.diff.est > 0.1), "repurchase: random rebuys are not flagged (diff " + pc(n.diff.est) + ")");
}

// --- E3 overconfidence: switches into stocks that then lag the ones sold ---
function switchWorld(edge) {
  const w = world();
  for (let k = 0; k < 24; k++) {
    const s = 40 + k * 22, sold = "X" + k, bought = "Y" + k;
    w.stock(sold, dates.map((d, i) => ({ date: d, close: i <= s + 2 ? 100 : 100 * (1 + edge * Math.min(1, (i - s - 2) / 84)) })));
    w.stock(bought, flat());
    w.trade("buy", sold, Math.max(31, s - 10), 10, 1000); w.trade("sell", sold, s, 10, 1000); w.trade("buy", bought, s + 2, 10, 1000);
  }
  return w;
}
{
  const p = run(switchWorld(0.06)).X.overconfidence, n = run(switchWorld(0)).X.overconfidence;
  ok(p.odean.status !== "none" && p.odean[84].est < -0.04 && p.odean.clear, "odean test: switches that cost 6% are found (" + pc(p.odean[84].est) + " over 84 days, " + p.odean.n + " switches)");
  ok(!n.odean.clear, "odean test: neutral switches are not flagged (" + pc(n.odean[84].est) + ")");
  ok(p.turnover.n > 6 && p.turnover.annual > 0, "turnover is computed: " + pc(p.turnover.annual) + " a year over " + p.turnover.n + " months");
}
{
  // tEnd is the close of the outcome's last bar. On a weekday calendar 21 bars from a Friday
  // end 31 days later at the close, and 84 bars (a switch's outcome) take about 120 days.
  const wd = [];
  for (let t = T0; wd.length < 300; t += DAY) { const g = new Date(t).getUTCDay(); if (g > 0 && g < 6) wd.push(new Date(t).toISOString().slice(0, 10)); }
  const ser = wd.map((d) => ({ date: d, close: 100 })), fri = wd.findIndex((d, i) => i >= 40 && new Date(d).getUTCDay() === 5);
  const tx = (kind, tk, i) => ({ broker: "t", extId: kind + tk + i, ts: Date.parse(wd[i] + "T15:00:00Z"), date: wd[i], kind: kind, isin: "ISIN" + tk, symbol: tk, name: tk, qty: 10, amount: 1000, currency: "EUR", assetClass: "STOCK" });
  const { R, X } = run({ txs: [tx("buy", "A", fri), tx("sell", "A", fri + 20), tx("buy", "B", fri + 22)], links: { ISINA: { ticker: "A", symbol: "A", status: "matched" }, ISINB: { ticker: "B", symbol: "B", status: "matched" } },
    prices: { IXIC: ser, A: ser, B: ser }, bench: ser, intraday: [{ id: "v0", ticker: "A", ts: Date.parse(wd[0] + "T15:00:00Z"), dwellMs: 60000, researchType: "overview" }], events: [], tickerSymbol: { A: "A", B: "B" }, now: Date.parse(wd[299] + "T22:00:00Z") });
  const a = R.decisions.find((d) => d.ticker === "A" && d.side === "buy"), b = R.decisions.find((d) => d.ticker === "B"), u = X.overconfidence.buyUnits.find((x) => x.t === b.cut);
  ok(a.fwd[21].end === Date.parse(wd[fri + 21] + "T21:00:00Z") && a.fwd[21].end > a.cut + 31 * DAY, "outcome time: 21 bars from a Friday are known at the close of bar 21, after 31 days");
  ok(u && u.y != null && u.tEnd === Date.parse(wd[fri + 22 + 84] + "T21:00:00Z") && u.tEnd > u.t + 115 * DAY, "outcome time: a switch's 84-bar result is known about 4 months later (" + Math.round((u.tEnd - u.t) / DAY) + " days), not after 92");
}
{
  // One position of 1000; 100 of it sold each month: sales turnover about 10% a month of a shrinking depot.
  const w = world();
  w.stock("T", flat()); w.trade("buy", "T", 31, 100, 10000);
  for (let m = 1; m <= 6; m++) w.trade("sell", "T", 31 + m * 30, 5, 500);
  const t = run(w).X.overconfidence.turnover;
  ok(t.sell > 0.5 && t.sell < 0.9, "turnover: sales of about 5-7% a month read as " + pc(t.sell) + " a year");
}

// --- D5 myopic loss aversion: long-horizon positions trimmed after a drop ---
function myoWorld(planted, seed) {
  const w = world(), r = rng(seed);
  for (let k = 0; k < 10; k++) {
    const tk = "M" + k, s = walk(seed * 7 + k, 0.035);
    w.stock(tk, s); w.label(tk, 38, "positive", { horizonDays: 365 }); w.trade("buy", tk, 40, 200);
    for (let i = 50; i < N - 10; i++) {
      const drop = s[i].close / s[i - 5].close - 1 <= -0.05;
      if (planted ? drop && r() < 0.5 : r() < 0.02) { w.trade("sell", tk, i + 1, 1); i += 5; }
    }
  }
  return w;
}
{
  const p = run(myoWorld(true, 7)).X.myopia, n = run(myoWorld(false, 8)).X.myopia;
  ok(p.status !== "none" && p.clear && p.dip.p > p.noDip.p, "myopia: trimming after drops is found (after a drop " + pc(p.dip.p) + ", otherwise " + pc(p.noDip.p) + ")");
  ok(!n.clear, "myopia: random trims are not flagged (" + pc(n.dip.p) + " vs " + pc(n.noDip.p) + ")");
  ok(p.sellUnits.length > 10 && p.sellUnits.some((u) => u.f.dipDays != null), "myopia: sales carry days since the last drop for the coach rule");
}

// --- A5 ostrich: looking only after up days, with trades and with labels only ---
function ostWorld(planted, seed, labelsOnly) {
  const w = world(), r = rng(seed);
  for (let k = 0; k < 6; k++) {
    const tk = "O" + k, s = walk(seed * 3 + k, 0.025);
    w.stock(tk, s);
    if (labelsOnly) w.label(tk, 35, "positive", { positionTaken: true, priceAtEvent: s[35].close });
    else w.trade("buy", tk, 35, 10);
    for (let i = 40; i < N - 5; i++) {
      const up = s[i - 1].close / s[i - 2].close - 1 > 0.01;
      if (planted ? up && r() < 0.6 : r() < 0.3) w.view(tk, i);
    }
  }
  if (!labelsOnly) w.trade("buy", "ZZZ", N - 3, 1);
  return w;
}
{
  const p = run(ostWorld(true, 9)).X.ostrich, n = run(ostWorld(false, 10)).X.ostrich;
  ok(p.status !== "none" && p.clear && p.up.p > p.down.p, "ostrich: looking after up days only is found (" + pc(p.up.p) + " vs " + pc(p.down.p) + ")");
  ok(!n.clear, "ostrich: looking regardless of the move is not flagged (" + pc(n.up.p) + " vs " + pc(n.down.p) + ")");
  const l = run(ostWorld(true, 11, true)).X;
  ok(!l.hasTrades && l.ostrich.fromLabels && l.ostrich.clear, "ostrich works from 'position taken' labels without a broker import (" + pc(l.ostrich.up.p) + " vs " + pc(l.ostrich.down.p) + ")");
  ok(!l.rank && !l.overconfidence, "without trades the trade-based indicators are absent, not empty");
}

// --- A6 confirmation: calls that do not move on contrary news ---
function confWorld(responsive, seed) {
  const w = world(), r = rng(seed);
  for (let k = 0; k < 30; k++) {
    const tk = "C" + k, s = walk(seed * 5 + k, 0.03);
    w.stock(tk, s);
    const pos = k % 2 === 0, start = 70 + (k % 5) * 3;
    w.label(tk, start, pos ? "positive" : "negative");
    let cur = pos ? "positive" : "negative";
    for (let i = start + 1; i < N - 20; i++) {
      const ret = s[i].close / s[i - 1].close - 1;
      if (Math.abs(ret) <= 0.05) continue;
      const contrary = cur === "positive" ? ret < 0 : ret > 0;
      if (responsive ? contrary && r() < 0.7 : r() < 0.1) { cur = cur === "positive" ? "negative" : "positive"; w.label(tk, i + 2, cur); i += 20; }
    }
  }
  return w;
}
{
  const p = run(confWorld(false, 12)).X.confirmation, n = run(confWorld(true, 13)).X.confirmation;
  ok(p.status !== "none" && p.signal, "confirmation: revisions that ignore contrary news are found (contrary " + pc(p.contrary.rev.p) + ", confirming " + pc(p.confirming.rev.p) + ", " + p.changes + " changes)");
  ok(!n.signal && n.diff.est > 0.2, "confirmation: revising on contrary news is not flagged (contrary " + pc(n.contrary.rev.p) + ", confirming " + pc(n.confirming.rev.p) + ")");
  const quiet = world();
  quiet.stock("Q", walk(99, 0.04)); quiet.label("Q", 40, "positive");
  ok(!run(quiet).X.confirmation.signal, "confirmation: someone who never relabels is not flagged");
}

// --- A6c breadth: narrow research on stocks with a call ---
{
  const w = world(), types = ["overview", "news", "financials", "analysis", "charts"];
  for (let k = 0; k < 24; k++) {
    const tk = "E" + k, call = k < 12;
    w.stock(tk, flat());
    if (call) w.label(tk, 40, "positive");
    for (let m = 0; m < 2; m++) for (let v = 0; v < 5; v++) w.view(tk, 45 + m * 31 + v, { researchType: call ? "news" : types[v] });
  }
  const e = run(w).X.entropy;
  ok(e.clear && e.diff.est < 0, "breadth: one page type on stocks with a call is found (" + e.withCall.mean.toFixed(2) + " vs " + e.without.mean.toFixed(2) + " bits)");
}

// --- A7 herding: first looks right after the community piles in ---
function herdWorld(planted, seed) {
  const w = world(), r = rng(seed), community = [];
  for (let k = 0; k < 40; k++) {
    const tk = "H" + k, spike = 100 + k * 12, days = [];
    for (let i = 40; i < N; i += 1) days.push([dates[i], i >= spike && i < spike + 3 ? 12 : (r() < 0.1 ? 1 : 0), 0, 0, 0]);
    community.push({ ticker: tk, days: days });
    w.view(tk, planted ? spike + 3 : 80 + Math.floor(r() * (N - 120)));
  }
  return { w, community };
}
{
  const a = herdWorld(true, 14), b = herdWorld(false, 15);
  const p = run(a.w, { community: a.community, trending: {} }).X.herding, n = run(b.w, { community: b.community, trending: {} }).X.herding;
  ok(p.status !== "none" && p.clear && p.followed.p > 0.9, "herding: first looks after a community spike are found (" + pc(p.followed.p) + " vs chance " + pc(p.chance) + ")");
  ok(!n.clear, "herding: first looks at random times are not flagged (" + pc(n.followed.p) + " vs chance " + pc(n.chance) + ")");
  ok(run(a.w).X.herding.noData, "herding without community data says so instead of guessing");
}

// --- D2 survival: winners sold fast, losers held ---
{
  const w = world();
  for (let k = 0; k < 20; k++) {
    const tk = "W" + k, win = k % 2 === 0, b = 40 + k * 10;
    w.stock(tk, dates.map((d, i) => ({ date: d, close: i <= b ? 100 : 100 * (1 + (win ? 0.01 : -0.01) * Math.min(i - b, 20)) })));
    w.trade("buy", tk, b, 10); w.trade("sell", tk, b + (win ? 15 : 150), 10);
  }
  const s = run(w).X.survival;
  ok(s.status !== "none" && s.winners.median < s.losers.median, "survival: winners held " + s.winners.median + " days, losers " + s.losers.median);
}

// --- E4 1/n: the same amount every time vs amounts that vary ---
function nWorld(same, seed) {
  const w = world(), r = rng(seed);
  for (let k = 0; k < 30; k++) { const tk = "N" + k; w.stock(tk, flat()); w.trade("buy", tk, 40 + k * 7, 10, same ? 1000 : 300 + Math.floor(r() * 1400)); }
  return w;
}
{
  const p = run(nWorld(true, 16)).X.diversification, n = run(nWorld(false, 17)).X.diversification;
  ok(p.oneOverN.signal && p.oneOverN.round.p > 0.9, "1/n: identical round amounts are found (" + pc(p.oneOverN.same.p) + " vs chance " + pc(p.oneOverN.chance) + ")");
  ok(!n.oneOverN.signal, "1/n: varied amounts are not flagged (" + pc(n.oneOverN.same.p) + " vs chance " + pc(n.oneOverN.chance) + ")");
  ok(p.holdings.last && p.holdings.last.n === 30 && Math.abs(p.holdings.last.hhi - 1 / 30) < 1e-6, "holdings: 30 equal positions give HHI 1/30");
}

// ===== phase 2 =====

// --- B3 extrapolation: Positive calls after rises, Negative after falls ---
function extraWorld(planted, seed) {
  const w = world(), r = rng(seed);
  for (let k = 0; k < 40; k++) {
    const tk = "X" + k, up = k % 2 === 0, c = 300 + k * 8;
    w.stock(tk, dates.map((d, i) => ({ date: d, close: 100 * (1 + (up ? 0.002 : -0.002) * Math.min(i, c)) })));
    w.label(tk, c, planted ? (up ? "positive" : "negative") : (r() < 0.5 ? "positive" : "negative"));
  }
  return w;
}
{
  const p = run(extraWorld(true, 21)).X.extrapolation, n = run(extraWorld(false, 22)).X.extrapolation;
  ok(p.calls.status !== "none" && p.clear && p.calls.m3.r > 0.5, "extrapolation: calls that follow past returns are found (r " + p.calls.m3.r.toFixed(2) + ")");
  ok(!n.calls.clear, "extrapolation: calls unrelated to past returns are not flagged (r " + n.calls.m3.r.toFixed(2) + ")");
}
function momWorld(planted, seed) {
  const w = world(), r = rng(seed);
  for (let k = 0; k < 8; k++) w.stock("U" + k, dates.map((d, i) => ({ date: d, close: 100 * Math.exp((k - 3.5) * 0.0015 * i) })));
  for (let j = 0; j < 24; j++) {
    // irregular dates and sizes, so the buys do not read as a savings plan
    const i = 300 + j * 15 + (j % 3) * 4;
    for (let k = 0; k < 8; k++) w.view("U" + k, i - 3);
    const pick = planted ? "U7" : "U" + Math.floor(r() * 8);
    w.trade("buy", pick, i, 1 + (j % 4) * 3);
  }
  return w;
}
{
  const p = run(momWorld(true, 23)).X.extrapolation.buys, n = run(momWorld(false, 24)).X.extrapolation.buys;
  ok(p.status !== "none" && p.p12.lo > 0.5 && p.p12.est > 0.85, "extrapolation: buying the best past performer is found (" + pc(p.p12.est) + " percentile)");
  ok(!(n.p12.lo > 0.5), "extrapolation: random picks among viewed stocks are not flagged (" + pc(n.p12.est) + ")");
}

// --- B4 lottery: buys in stocks with a big day last month ---
{
  const spike = (i0) => dates.map((d, i) => ({ date: d, close: i >= i0 ? 115 : 100 }));
  ok(I.lotteryAt(spike(200), null, dates[210]).maxHit === true, "lottery: a +15% day in the last month is a lottery day");
  ok(I.lotteryAt(spike(200), null, dates[260]).maxHit === false, "lottery: two months later it is not");
  const w = world();
  for (let k = 0; k < 20; k++) { const tk = "L" + k, s = spike(100 + k * 20); w.stock(tk, s); w.trade("buy", tk, 110 + k * 20, 1); }
  for (let k = 0; k < 10; k++) { const tk = "Q" + k; w.stock(tk, walk(300 + k, 0.005)); w.trade("buy", tk, 115 + k * 30, 1); }
  const l = run(w).X.lottery;
  ok(l.status !== "none" && l.buys.p > 0.6, "lottery: share of lottery buys is " + pc(l.buys.p) + " of " + l.n);
}

// --- C4 anchoring: round targets, break-even sales ---
function anchorWorld(round, seed) {
  const w = world(), r = rng(seed);
  for (let k = 0; k < 30; k++) {
    const tk = "T" + k, p = 120 + r() * 300;
    w.stock(tk, flat().map((b) => ({ date: b.date, close: p })));
    const t = round ? Math.round(p * 1.2 / 10) * 10 : Math.round(p * (1.1 + r() * 0.3) * 100) / 100;
    w.label(tk, 100 + k * 5, "positive", { targetPrice: t, priceAtEvent: p });
  }
  return w;
}
{
  const p = run(anchorWorld(true, 25)).X.anchoring.targets, n = run(anchorWorld(false, 26)).X.anchoring.targets;
  ok(p.clear && p.round.p === 1, "anchoring: targets on round tens are found (" + pc(p.round.p) + " vs chance " + pc(p.chance) + ")");
  ok(!n.clear, "anchoring: targets to the cent are not flagged (" + pc(n.round.p) + ")");
}
function beWorld(planted, seed) {
  const w = world();
  for (let k = 0; k < 24; k++) {
    const tk = "B" + k, b = 40 + k * 20, s = walk(400 + seed * 50 + k, 0.03);
    w.stock(tk, s); w.trade("buy", tk, b, 10);
    let sell = b + 60;
    if (planted) { for (let i = b + 10; i < b + 200 && i < N - 5; i++) if (Math.abs(s[i].close / s[b].close - 1) <= 0.01) { sell = i; break; } }
    w.trade("sell", tk, Math.min(sell, N - 5), 10);
  }
  return w;
}
{
  const p = run(beWorld(true, 1)).X.anchoring.breakEven, n = run(beWorld(false, 2)).X.anchoring.breakEven;
  ok(p.clear && p.share.p > 0.8, "anchoring: sales at break-even are found (" + pc(p.share.p) + " vs chance " + pc(p.chance) + ")");
  ok(!n.clear, "anchoring: sales at a fixed delay are not flagged (" + pc(n.share.p) + " vs chance " + pc(n.chance) + ")");
}

// --- C5 calibration: targets far beyond what the stock does ---
function calWorld(far) {
  const w = world();
  for (let k = 0; k < 20; k++) {
    const tk = "K" + k, c = 100 + k * 10;
    w.stock(tk, dates.map((d, i) => ({ date: d, close: i <= c ? 100 : 100 * (1 + 0.004 * Math.min(i - c, 30)) })));
    w.label(tk, c, "positive", { targetPrice: far ? 160 : 105, horizonDays: 30, priceAtEvent: 100 });
  }
  return w;
}
{
  const p = run(calWorld(true)).X.calibration, n = run(calWorld(false)).X.calibration;
  ok(p.status !== "none" && p.clear && p.medianRatio > 3 && p.hit.p === 0, "calibration: targets 60% away when stocks move 12% are found (ratio " + p.medianRatio.toFixed(1) + ")");
  ok(!n.clear && n.hit.p === 1, "calibration: reachable targets are not flagged (ratio " + n.medianRatio.toFixed(2) + ")");
}

// --- E5 home bias ---
{
  const w = world();
  for (let k = 0; k < 10; k++) { const tk = "D" + k + ".DE"; w.stock(tk, flat()); for (let m = 0; m < 6; m++) w.view(tk, 40 + m * 30 + k); }
  w.stock("AAPL", flat()); w.view("AAPL", 50);
  const h = run(w, { homeCountry: "DE" }).X.homebias;
  ok(h.status !== "none" && h.views.share > 0.9 && h.views.bias > 0.9 && h.tilted, "home bias: views almost all on German listings read as strong home bias (" + h.views.bias.toFixed(2) + ")");
  ok(run(w, { homeCountry: "XV" }).X.homebias.noHome && run(w).X.homebias.noHome, "home bias stays blank for a VPN user or an unknown home country");
  ok(I.countryOfSymbol("SAP.DE") === "DE" && I.countryOfSymbol("AAPL") === "US" && I.countryOfSymbol("7203.T") === "JP" && I.countryOfSymbol("^IXIC") === null, "listing countries from Yahoo symbols");
}

// --- E4 sectors ---
{
  const w = world();
  for (let k = 0; k < 6; k++) { const tk = "S" + k; w.stock(tk, flat()); w.trade("buy", tk, 40 + k, 10); }
  w.trade("buy", "ZZZ", N - 3, 1);
  const prof = {}; for (let k = 0; k < 6; k++) prof["S" + k] = { sector: k < 5 ? "Technology" : "Energy" };
  const d = run(w, { profiles: prof }).X.diversification;
  ok(d.sectorHeavy && d.holdings.last.topSector === "Technology" && Math.abs(d.holdings.last.topSectorShare - 5 / 6) < 1e-6, "sectors: five of six positions in one sector read as sector-heavy");
  ok(d.holdings.last.countryHhi > 0 && d.holdings.last.topCountry, "countries are assigned to every position (" + d.holdings.last.topCountry + ")");
}

// --- B5 volume: buys right after a volume spike ---
function volWorld(planted, seed) {
  const w = world(), r = rng(seed);
  for (let k = 0; k < 20; k++) {
    const tk = "V" + k, spikes = {};
    for (let j = 0; j < 12; j++) spikes[150 + k * 5 + j * 37] = 1;
    w.stock(tk, dates.map((d, i) => ({ date: d, close: 100, volume: spikes[i] ? 5e6 : 1e6 * (0.8 + 0.4 * ((i * 7919 + k) % 13) / 13) })));
    const day = planted ? 150 + k * 5 + 4 * 37 + 1 : 150 + k * 5 + 4 * 37 + 10 + Math.floor(r() * 20);
    w.view(tk, day - 1); w.trade("buy", tk, day, 1);
  }
  return w;
}
{
  const p = run(volWorld(true, 27)).X.volume, n = run(volWorld(false, 28)).X.volume;
  ok(p.status !== "none" && p.clear && p.share.p === 1, "volume: buys the day after a volume spike are found (" + pc(p.share.p) + " vs chance " + pc(p.chance) + ")");
  ok(!n.clear, "volume: buys on ordinary days are not flagged (" + pc(n.share.p) + " vs chance " + pc(n.chance) + ")");
}

// ===== phase 3 =====

// --- A8 limited attention: Friday releases read late or not at all ---
function attWorld(planted, seed) {
  const w = world(), r = rng(seed), earnings = {};
  for (let k = 0; k < 12; k++) {
    const tk = "E" + k; w.stock(tk, flat()); earnings[tk] = [];
    for (let q = 0; q < 6; q++) {
      // releases on varying weekdays; 2024-01-05 is a Friday
      const i = 60 + q * 91 + k * 3, day = dates[i], fri = new Date(day + "T12:00:00Z").getUTCDay() === 5;
      earnings[tk].push([day, "bmo"]);
      w.view(tk, i - 10);
      const late = planted ? fri : r() < 0.3;
      if (!late) w.view(tk, i + 1, { researchType: "financials" });
    }
  }
  return { w, earnings };
}
{
  const a = attWorld(true, 31), b = attWorld(false, 32);
  const p = run(a.w, { earnings: a.earnings }).X.attention, n = run(b.w, { earnings: b.earnings }).X.attention;
  ok(p.status !== "none" && p.clear && p.friday.yes.missed.p === 1 && p.friday.no.missed.p === 0, "limited attention: Friday releases left unread are found (missed " + pc(p.friday.yes.missed.p) + " vs " + pc(p.friday.no.missed.p) + ", " + p.n + " releases)");
  ok(!n.clear, "limited attention: misses on random days are not flagged (" + pc(n.friday.yes.missed.p) + " vs " + pc(n.friday.no.missed.p) + ")");
  ok(p.median != null && p.median < 48, "limited attention: median latency " + (p.median != null ? p.median.toFixed(0) + " h" : "-"));
  const nd = run(a.w).X.attention;
  ok(nd.noData && nd.status === "none", "limited attention without earnings data says so");
  const w2 = world(); w2.stock("SAP.DE", flat()); w2.view("SAP.DE", 50);
  ok(run(w2, { earnings: {} }).X.attention.notMeasured >= 1, "limited attention counts non-US stocks as not measured");
}

// --- A7c community herding: users discover the same stocks on the same days ---
function commRows(planted, seed) {
  const r = rng(seed), rows = [];
  for (let d = 0; d < 120; d++) {
    const looks = {}, active = 40;
    for (let k = 0; k < 30; k++) {
      // planted: each stock's first looks all land on one day; null: spread evenly at the same overall rate
      let n = 0;
      if (planted) n = d === 3 + k * 3 ? 8 : 0;
      else for (let u = 0; u < active; u++) if (r() < 8 / (120 * active)) n++; // each active user independently: binomial
      if (n) looks["C" + k] = n;
    }
    rows.push({ day: dates[100 + d], active: active, looks: looks });
  }
  return rows;
}
{
  const p = I.communityHerding(commRows(true, 33)), n = I.communityHerding(commRows(false, 34));
  ok(p.status !== "none" && p.clear && p.h.est > 0, "community herding: first looks bunched on one day are found (H " + p.h.est.toFixed(4) + ")");
  ok(!n.clear, "community herding: first looks scattered by chance are not flagged (H " + n.h.est.toFixed(4) + ")");
  ok(I.communityHerding([]).noData, "community herding without data says so");
}

// --- B6 crowd buys: buying right after other users piled into the stock ---
{
  const W = require(path.join(__dirname, "synth-world.js"));
  // crowdIndex takes the user's own views out of the community counts as the RPC counts them:
  // views at 15:20, 15:45 and 16:10 ET on Mar 5 are one daily event (ts 16:10, views 3), all
  // on Mar 6, though two intraday rows fall on Mar 5. Two views by others on Mar 5 stay.
  const own = [{ ticker: "A", ts: Date.parse("2024-03-05T21:10:00Z"), views: 3 }, { ticker: "A", ts: Date.parse("2024-03-07T15:00:00Z") }]; // the second: no views field counts 1
  const ci = I.crowdIndex([{ ticker: "A", days: [["2024-03-05", 2, 0, 0, 0], ["2024-03-06", 3, 0, 0, 0], ["2024-03-07", 1, 0, 0, 0]] }, { ticker: "B", days: [["2024-03-05", 4, 0, 0, 0]] }], own);
  ok(ci.by.A[Date.parse("2024-03-05") / DAY] === 2 && ci.by.A[Date.parse("2024-03-06") / DAY] === 0 && ci.by.A[Date.parse("2024-03-07") / DAY] === 0 && ci.by.B[Date.parse("2024-03-05") / DAY] === 4,
    "crowd: the user's own daily events are subtracted on the RPC's day (a chain over 16:00 ET included), others' views stay");
  ok(I.crowdAt(ci, "A", Date.parse("2024-03-08T15:00:00Z")).others3 === 2, "crowd: the user's own chain of views is not crowd attention before the next buy");
  ok(I.crowdAt(ci, "C", Date.parse("2024-03-10T15:00:00Z")) === null, "crowd: no community data for a stock gives null");
  // crowdAt reads only the days before the buy's New York day
  const days = [], ts = Date.parse("2024-06-20T15:00:00Z"); // 11:00 ET on June 20
  for (let i = 0; i < 60; i++) days.push([new Date(Date.parse("2024-05-01") + i * DAY).toISOString().slice(0, 10), i % 3, 0, 0, 0]);
  const before = I.crowdAt(I.crowdIndex([{ ticker: "A", days }], []), "A", ts);
  const later = days.map((d) => d[0] >= "2024-06-20" ? [d[0], 50, 0, 0, 0] : d);
  ok(JSON.stringify(I.crowdAt(I.crowdIndex([{ ticker: "A", days: later }], []), "A", ts)) === JSON.stringify(before) && before.others3 === days.filter((d) => d[0] >= "2024-06-17" && d[0] < "2024-06-20").reduce((a, d) => a + d[1], 0),
    "crowd: views on or after the buy's New York day do not change it (others3 " + before.others3 + ", base3 " + before.base3.toFixed(2) + ")");
  // the crowd option leaves the rest of a world as it was
  const off = W.buildWorld({ seed: 7, nBuys: 40, bars: 500 }), on0 = W.buildWorld({ seed: 7, nBuys: 40, bars: 500, crowd: { follow: 0, edge21: 0 } });
  ok(!off.input.community && on0.input.community.length > 0 && ["txs", "prices", "intraday", "events", "bench"].every((k) => JSON.stringify(off.input[k]) === JSON.stringify(on0.input[k])), "crowd: the synthetic world with the crowd option changes nothing but the community rows");
  const fmt = (c) => pc(c.share.p) + " vs chance " + pc(c.chance) + ", excess " + pc(c.excess.est) + " [" + pc(c.excess.lo) + ", " + pc(c.excess.hi) + "], 21d diff " + pc(c.horizons[21].diff.est) + " [" + pc(c.horizons[21].diff.lo) + ", " + pc(c.horizons[21].diff.hi) + "], n " + c.n;
  const big = { nBuys: 200, bars: 1100 };
  const pw = W.buildWorld(Object.assign({ seed: 41, crowd: { follow: 0.4, edge21: -0.06 } }, big)), pR = D.analyze(pw.input), p = I.analyze(pw.input, pR).crowdBuys, dec = {};
  pR.decisions.forEach((d) => { dec[d.inst + "|" + d.date] = d; });
  ok(p.status !== "none" && p.clear && p.excess.lo > 0 && p.horizons[21].diff.hi < 0 && p.clearOn.indexOf("excess") >= 0 && p.clearOn.indexOf("21") >= 0, "crowd: buys planted after crowd spikes, 6 points worse, are found: " + fmt(p));
  ok(p.buyUnits.length === p.n && p.buyUnits.every((u) => u.f.crowd > 0 && typeof u.f.crowdHot === "boolean" && (u.y == null || u.tEnd === dec[u.id].fwd[21].end)) && [5, 21, 63, 126].every((h) => p.horizons[h].hot.n > 0 && p.horizons[h].other.n > 0), "crowd: units for the rule and four horizons");
  const nw = W.buildWorld(Object.assign({ seed: 42, crowd: { follow: 0, edge21: 0 } }, big)), n = I.analyze(nw.input, D.analyze(nw.input)).crowdBuys;
  ok(!n.clear, "crowd: a world where buys ignore the crowd is not flagged: " + fmt(n));
  const nd = I.analyze(off.input, D.analyze(off.input)).crowdBuys;
  ok(nd.noData && nd.status === "none" && nd.buyUnits.length === 0, "crowd: no community data says so");
}

// --- B7 timing against a savings plan ---
// Stocks that cycle every 45 days around a slow rise. The same stocks get timed buys
// at the troughs (good timing), at the peaks (bad timing) or on random days, and a
// savings plan buys a drifting fund every 30 days. The index stays flat, so a lot's
// result beyond its twin is its own return.
function timingWorld(mode, seed) {
  const w = world(), r = rng(seed);
  for (let k = 0; k < 4; k++) {
    const tk = "C" + k, ph = k * 11;
    w.stock(tk, dates.map((d, i) => ({ date: d, close: 100 * (1 + 0.0004 * i) * (1 + 0.2 * Math.sin(2 * Math.PI * (i + ph) / 45)) })));
    for (let m = 1; m <= 12; m++) {
      const off = mode === "good" ? 33.75 : mode === "bad" ? 11.25 : r() * 45;
      const i = Math.round(off - ph + 45 * m);
      if (i > 31 && i < N - 5) w.trade("buy", tk, i, 10);
    }
  }
  w.stock("PLN", walk(seed + 9, 0.01, 0.0004));
  for (let i = 40; i < N - 5; i += 30) { w.trade("buy", "PLN", i, 5); w.txs[w.txs.length - 1].plan = true; }
  w.trade("buy", "ZZZ", N - 3, 1);
  return w;
}
{
  const good = run(timingWorld("good", 5)).X.timing, bad = run(timingWorld("bad", 5)).X.timing, rnd = run(timingWorld("rnd", 5)).X.timing;
  const fm = (t) => "effect " + pc(t.same.effect.est) + " [" + pc(t.same.effect.lo) + ", " + pc(t.same.effect.hi) + "] a year, " + t.same.stocks + " stocks, " + t.same.n + " buys, " + t.verdict;
  ok(good.same.clear && good.same.effect.est > 0 && good.verdict === "timing_pays" && good.status !== "none", "timing: buys at the troughs beat the same money as a monthly plan: " + fm(good));
  ok(bad.same.clear && bad.same.effect.est < 0 && bad.verdict === "plan_better", "timing: buys at the peaks lose to the same money as a monthly plan: " + fm(bad));
  ok(!rnd.same.clear, "timing: buys on random days are not flagged: " + fm(rnd));
  ok(bad.nPlan >= 10 && bad.sleeves.plan.n === bad.nPlan && bad.sleeves.timed.n === bad.n && bad.sleeves.diff && bad.sleeves.diff.est != null, "timing: the plan buys are a part of their own (" + bad.nPlan + " plan buys, " + bad.n + " timed)");
  ok(bad.same.rows.every((r) => r.n >= 3 && r.timed.cy > 0 && Math.abs(r.timed.c - r.plan.c) < 1e-6 * r.timed.c), "timing: the plan in each stock invests exactly the money of the timed buys");
  const B = require(path.join(__dirname, "..", "src", "biases.js")), pr = run(timingWorld("bad", 5));
  pr.R.ind = pr.X;
  const hit = B.detect(pr.R).filter((b) => b.id === "timing")[0], none = (() => { const g = run(timingWorld("good", 5)); g.R.ind = g.X; return B.detect(g.R).filter((b) => b.id === "timing").length; })();
  ok(hit && hit.signals.length > 0 && none === 0, "timing: the coach names the bias when a plan would have won, and not when the timing pays");
}
// Sales: the lot is cut by the share sold, the twin by the same share on the same days.
{
  const w = world();
  w.stock("SA", dates.map((d, i) => ({ date: d, close: i <= 100 ? 100 : i <= 300 ? 120 : 150 })));
  w.trade("buy", "SA", 50, 10); w.trade("sell", "SA", 200, 5); w.trade("buy", "ZZZ", N - 3, 1);
  const t = run(w).X.timing;
  // 10 units at 100; 5 sold at 120; the other 5 valued at the last bar of the file (day 717, 150); a flat index
  ok(Math.abs(t.sleeves.timed.gain - ((1000 * (0.5 * 120 + 0.5 * 150) / 100 + 100) / 1100 - 1)) < 1e-9 && Math.abs(t.sleeves.timed.twin) < 1e-9, "timing: a sale is paid out at its price and the rest is valued at the end (gain " + pc(t.sleeves.timed.gain) + ")");
  // a stock that moves exactly like the index earns nothing beyond its twin, whatever is sold when
  const v = world(), idx = dates.map((d, i) => ({ date: d, close: 100 * (1 + 0.001 * i) }));
  v.prices.IXIC = idx; v.bench = idx; v.stock("TRK", idx.map((x) => ({ date: x.date, close: x.close })));
  v.trade("buy", "TRK", 50, 10); v.trade("sell", "TRK", 300, 4); v.trade("buy", "TRK", 400, 7); v.trade("sell", "TRK", 600, 13); v.trade("buy", "ZZZ", N - 3, 1);
  const u = run(v).X.timing;
  ok(Math.abs(u.sleeves.timed.ex) < 1e-9 && u.sleeves.timed.gain > 0.1, "timing: a stock that tracks the index earns nothing beyond its twin, however it is sold (" + pc(u.sleeves.timed.ex) + " a year, gain " + pc(u.sleeves.timed.gain) + ")");
  // selling half the position halves the money held, not the result per euro-year
  const a = world(), b2 = world(), zig = dates.map((d, i) => ({ date: d, close: 100 * (1 + 0.3 * Math.sin(i / 20)) }));
  [a, b2].forEach((x) => { x.stock("SA", zig); x.trade("buy", "SA", 50, 10); x.trade("buy", "ZZZ", N - 3, 1); });
  b2.trade("sell", "SA", 300, 5);
  const ya = run(a).X.timing.sleeves.timed, yb = run(b2).X.timing.sleeves.timed;
  ok(yb.cy < ya.cy && Math.abs(yb.years - ya.years) > 0, "timing: a sale shortens the time the money is held (" + ya.years.toFixed(2) + " vs " + yb.years.toFixed(2) + " years per euro)");
}

// --- helpers ---
ok(I.kmMedian([{ t: 1, done: true }, { t: 2, done: true }, { t: 3, done: true }]) === 2, "Kaplan-Meier median of 1, 2, 3 is 2");
ok(I.kmMedian([{ t: 1, done: true }, { t: 5, done: false }, { t: 6, done: false }]) === null, "Kaplan-Meier median stays open while most are censored");
{
  const R = D.analyze({ txs: [], links: {}, intraday: [], events: [], prices: {}, bench: [], now: T0 });
  const X = I.analyze({ txs: [], intraday: [], events: [], prices: {}, bench: [], now: T0 }, R);
  ok(X.ostrich.status === "none" && X.confirmation.status === "none" && X.herding.status === "none", "an empty history gives no indicator and no error");
}

console.log(failed ? failed + " failed" : "all passed");
process.exit(failed ? 1 : 0);
