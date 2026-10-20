// Demo account data on REAL tickers and REAL prices, for recording the demo
// video in the real extension (not the sandbox). The investor is made up; the
// market is not: buy dates and prices come from Yahoo daily closes, so the app
// can price every trade and the analysis runs on what the stocks really did.
//
//   node tools/demo-data.js                       FOMO buyer (default)
//   node tools/demo-data.js --persona first_hour  or night_trader
//   node tools/demo-data.js --seed 7 --buys 90
//
// Writes docs/hackathon/demo/<persona>/:
//   trades.csv        import in My Habits > Trades & research (Stocktrails template)
//   History.json      import as browsing history (Google Takeout Chrome layout)
//   operations.jsonl  the account's operation log, in time order, ending with
//                     the import, analysis, biases and rule checks the app's own
//                     code produced from these two files
//   report.md         what the analysis found
//   prices.json       the downloaded closes (reused on the next run; --refresh to refetch)
//
// Times are local to this machine, like the app's hour-of-day analysis.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
global.self = global;
require(path.join(root, "src", "portals.js"));
const H = require(path.join(root, "src", "history.js"));
const L = require(path.join(root, "src", "ledger.js"));
global.ATLedger = L;
const D = require(path.join(root, "src", "decisions.js")), B = require(path.join(root, "src", "biases.js")), I = require(path.join(root, "src", "indicators.js"));
const { rng } = require(path.join(__dirname, "synth-world.js"));

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; };
const persona = arg("persona", "fomo"), seed = +arg("seed", 6), nBuys = +arg("buys", 90);
const outDir = arg("out", path.join(root, "docs", "hackathon", "demo", persona));
const PERSONAS = {
  fomo: "Buys after a stock has already run up: about 60% of buys come after a rise of 10% or more in the 20 trading days before, on stocks first looked at before the rise.",
  first_hour: "About 40% of buys are placed within an hour of first looking at the stock.",
  night_trader: "About 55% of buys are placed at 22:00 or later."
};
if (!PERSONAS[persona]) { console.error("persona must be one of " + Object.keys(PERSONAS).join(", ")); process.exit(1); }

const UNIVERSE = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "NFLX", "AVGO", "CRM", "ORCL", "ADBE", "INTC", "QCOM", "PLTR", "COIN",
  "SHOP", "UBER", "ABNB", "SNOW", "CRWD", "PANW", "NOW", "MU", "SMCI", "ARM", "DELL", "MRNA", "PYPL", "DIS", "NKE", "SBUX", "KO", "JPM", "V", "COST", "WMT", "LLY", "UNH"];
const BENCH = "^IXIC";

async function fetchCloses(sym) {
  const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?range=3y&interval=1d", { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(sym + ": HTTP " + r.status);
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], out = [];
  res.timestamp.forEach((t, i) => { if (q.close[i] != null) out.push({ date: new Date(t * 1000).toISOString().slice(0, 10), close: +q.close[i].toFixed(4) }); });
  return { name: res.meta.longName || res.meta.shortName || sym, closes: out };
}

async function loadPrices() {
  const f = path.join(outDir, "prices.json");
  if (fs.existsSync(f) && !process.argv.includes("--refresh")) return JSON.parse(fs.readFileSync(f, "utf8"));
  const p = {};
  for (const s of UNIVERSE.concat(BENCH)) { p[s] = await fetchCloses(s); process.stdout.write(s + " "); }
  console.log();
  fs.writeFileSync(f, JSON.stringify(p));
  return p;
}

const PORTALS = [
  (t, kind) => "https://finance.yahoo.com/quote/" + t + "/" + ({ news: "news/", financials: "financials/", analysis: "analysis/", charts: "chart/", community: "community/" }[kind] || ""),
  (t, kind) => "https://stockanalysis.com/stocks/" + t.toLowerCase() + "/" + ({ financials: "financials/", analysis: "forecast/", charts: "chart/" }[kind] || ""),
  (t, kind) => "https://seekingalpha.com/symbol/" + t + ({ news: "/news", analysis: "/analysis", financials: "/income-statement", community: "/comments" }[kind] || ""),
  (t, kind) => "https://www.tradingview.com/symbols/NASDAQ-" + t + "/" + ({ news: "news/", analysis: "ideas/", financials: "financials-overview/" }[kind] || ""),
  (t) => "https://stocktwits.com/symbol/" + t
];
const KINDS = ["overview", "news", "financials", "analysis", "charts", "community"];
const NOISE = ["https://mail.google.com/mail/u/0/#inbox", "https://www.youtube.com/", "https://www.bbc.com/news", "https://github.com/", "https://www.reddit.com/r/investing/",
  "https://www.google.com/search?q=weather", "https://www.wikipedia.org/", "https://open.spotify.com/", "https://www.linkedin.com/feed/", "https://news.ycombinator.com/"];

(async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const P = await loadPrices(), r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const bench = P[BENCH].closes, dates = bench.map((b) => b.date);
  const tickers = UNIVERSE.filter((t) => P[t] && P[t].closes.length > dates.length * 0.9);
  const idx = {}; tickers.forEach((t) => { idx[t] = {}; P[t].closes.forEach((c, i) => { idx[t][c.date] = i; }); });
  const close = (t, d) => { const i = idx[t][d]; return i == null ? null : P[t].closes[i].close; };
  const at = (date, h, m) => { const [y, mo, d] = date.split("-").map(Number); return new Date(y, mo - 1, d, h, m, Math.floor(r() * 60)).getTime(); };

  // buys over the two years that have 63 trading days of prices after them
  const lo = Math.max(30, dates.findIndex((d) => d >= new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10))), hi = dates.length - 66;
  const txs = [], visits = [], plantedOf = {}, used = {};
  let hot = 0;
  for (let k = 0; k < nBuys; k++) {
    let t = pick(tickers), j = lo + Math.floor(r() * (hi - lo)), chased = false;
    if (persona === "fomo" && r() < 0.6) {
      // a day after a 10%+ rise in the 20 trading days before, on any stock
      for (let tries = 0; tries < 400; tries++) {
        const t2 = pick(tickers), j2 = lo + Math.floor(r() * (hi - lo)), c0 = close(t2, dates[j2 - 20]), c1 = close(t2, dates[j2]);
        if (c0 && c1 && c1 / c0 - 1 > 0.1 && !used[t2 + j2]) { t = t2; j = j2; chased = true; hot++; break; }
      }
    }
    if (!close(t, dates[j]) || used[t + j]) { k--; continue; }
    used[t + j] = 1;
    const impulse = persona === "first_hour" ? r() < 0.4 : r() < 0.08;
    const hours = persona === "night_trader" ? [[9, 0.25], [14, 0.2], [22, 0.55]] : [[9, 0.4], [14, 0.3], [21, 0.3]];
    let u = r(), hr = 9;
    for (let s = 0, h = 0; h < hours.length; h++) { s += hours[h][1]; if (u <= s) { hr = hours[h][0]; break; } }
    const ts = at(dates[j], hr, Math.floor(r() * 50)), price = close(t, dates[j]);
    const qty = Math.max(1, Math.round((400 + 900 * r()) / price)), amount = +(qty * price).toFixed(2);
    txs.push({ ts, kind: "buy", t, qty, price, amount });
    plantedOf[ts] = { fomo: chased, first_hour: impulse, night_trader: hr >= 22 }[persona];

    // research before the buy: chased buys were first looked at before the rise
    const nViews = impulse ? 1 + Math.floor(r() * 2) : 1 + Math.floor(r() * 6);
    const lead = chased ? 20 + Math.floor(r() * 10) : Math.max(1, Math.round(Math.exp(r() * Math.log(45))));
    const firstTs = impulse ? ts - (15 + Math.floor(r() * 35)) * 60000 : at(dates[Math.max(0, j - lead)], 8 + Math.floor(r() * 12), Math.floor(r() * 60));
    for (let v = 0; v < nViews; v++) {
      const vt = v === 0 ? firstTs : impulse ? firstTs + Math.round((ts - firstTs) * v / nViews) : at(dates[Math.max(0, j - Math.floor(r() * lead))], 8 + Math.floor(r() * 14), Math.floor(r() * 60));
      visits.push({ ts: Math.min(vt, ts - 60000), url: pick(PORTALS)(t, v === 0 ? "overview" : pick(KINDS)), t });
    }
    // 60% are sold 25 to 190 trading days later
    const sj = j + 25 + Math.floor(r() * 165);
    if (r() < 0.6 && sj < dates.length - 1 && close(t, dates[sj])) txs.push({ ts: at(dates[sj], 10, Math.floor(r() * 50)), kind: "sell", t, qty, price: close(t, dates[sj]), amount: +(qty * close(t, dates[sj])).toFixed(2) });
  }
  // looked at, never bought
  for (let m = 0; m < 60; m++) { const t = pick(tickers), j = lo + Math.floor(r() * (dates.length - lo - 1)); visits.push({ ts: at(dates[j], 8 + Math.floor(r() * 14), Math.floor(r() * 60)), url: pick(PORTALS)(t, pick(KINDS)), t }); }
  txs.sort((a, b) => a.ts - b.ts);

  // trades.csv: a sell larger than the position is fine for the parser, but keep it clean: skip sells of positions not open
  const pos = {}, kept = [];
  txs.forEach((x) => { pos[x.t] = pos[x.t] || 0; if (x.kind === "sell" && pos[x.t] < x.qty) return; pos[x.t] += x.kind === "buy" ? x.qty : -x.qty; kept.push(x); });
  const csv = ["date,type,isin,symbol,name,quantity,price,amount,fee,tax,currency"].concat(kept.map((x) =>
    [new Date(x.ts).toISOString(), x.kind, "", x.t, '"' + P[x.t].name.replace(/"/g, "") + '"', x.qty, x.price.toFixed(2), x.amount.toFixed(2), "1.00", "0.00", "USD"].join(","))).join("\n") + "\n";
  fs.writeFileSync(path.join(outDir, "trades.csv"), csv);

  // History.json, Takeout layout, with ordinary browsing mixed in (the import drops it)
  const browse = visits.map((v) => ({ ts: v.ts, url: v.url, title: v.t + " - stock research" }));
  const t0 = Math.min.apply(null, browse.map((b) => b.ts)), t1 = Math.max.apply(null, browse.map((b) => b.ts));
  for (let n = 0, nn = browse.length * 3; n < nn; n++) browse.push({ ts: t0 + Math.floor(r() * (t1 - t0)), url: pick(NOISE), title: "" });
  browse.sort((a, b) => b.ts - a.ts);
  const hist = { "Browser History": browse.map((b) => ({ favicon_url: "", page_transition: "LINK", title: b.title, url: b.url, client_id: "demo-" + seed, time_usec: b.ts * 1000 })) };
  const histText = JSON.stringify(hist, null, 1);
  fs.writeFileSync(path.join(outDir, "History.json"), histText);

  // run both files through the app's own parsers and analysis
  const parsed = L.parseFile(csv), hx = H.extract(histText, []);
  const links = {}, prices = {}, tsym = {};
  parsed.txs.forEach((x) => { links["SYM:" + x.symbol.toUpperCase()] = { ticker: x.symbol, symbol: x.symbol, status: "matched" }; });
  tickers.forEach((t) => { prices[t] = P[t].closes; tsym[t] = t; });
  const intraday = hx.visits.map((v, i) => Object.assign({ id: "h" + i, dwellMs: 0 }, v));
  const input = { txs: parsed.txs, links, intraday, events: [], prices, bench, tickerSymbol: tsym, now: Date.now() };
  const R = D.analyze(input);
  R.ind = I.analyze(input, R);
  const coach = B.coach(R);

  // operation log
  const first = {};
  intraday.forEach((e) => { if (first[e.ticker] == null || e.ts < first[e.ticker]) first[e.ticker] = e.ts; });
  const acct = "demo-" + persona + "-" + seed, ops = [];
  intraday.forEach((e) => ops.push({ ts: e.ts, op: "VIEW", ticker: e.ticker, page: e.researchType, url: e.url }));
  kept.forEach((x) => {
    const o = { ts: x.ts, op: x.kind === "buy" ? "ORDER_BUY" : "ORDER_SELL", ticker: x.t, qty: x.qty, price: x.price, amountUsd: x.amount, hour: new Date(x.ts).getHours() };
    if (x.kind === "buy") Object.assign(o, { minutesSinceFirstLook: first[x.t] != null && first[x.t] <= x.ts ? Math.round((x.ts - first[x.t]) / 60000) : null, planted: !!plantedOf[x.ts] });
    ops.push(o);
  });
  ops.sort((a, b) => a.ts - b.ts);
  ops.unshift({ ts: ops[0].ts - 60000, op: "ACCOUNT_OPEN", persona, habit: PERSONAS[persona], synthetic: true, realPrices: true, seed });
  const end = Date.now();
  ops.push({ ts: end, op: "IMPORT_CSV", file: "trades.csv", format: parsed.format, rows: parsed.rows, trades: parsed.txs.length });
  ops.push({ ts: end + 1, op: "IMPORT_HISTORY", file: "History.json", entries: hx.entries, visits: hx.visits.length, tickers: Object.keys(hx.tickers).length, from: new Date(hx.from).toISOString(), to: new Date(hx.to).toISOString() });
  ops.push({ ts: end + 2, op: "ANALYZE", decisions: R.decisions.length, buys: R.decisions.filter((d) => d.side === "buy" && !d.excluded).length, priceSeries: Object.keys(prices).length });
  coach.biases.forEach((b, i) => ops.push({ ts: end + 10 + i, op: "BIAS", bias: b.id, name: b.name, tier: b.tier, signals: b.signals.map((s) => s.text) }));
  coach.rules.filter((x) => x.recommended).forEach((x, i) => ops.push({ ts: end + 100 + i, op: "RULE_CHECK", rule: x.id, bias: x.bias, text: x.text, verdict: x.oos.verdict, flagged: x.oos.flagged, of: x.oos.testN, gainPerFlagged: x.oos.mean }));
  fs.writeFileSync(path.join(outDir, "operations.jsonl"), ops.map((o, i) => JSON.stringify(Object.assign({ seq: i + 1, at: new Date(o.ts).toISOString(), account: acct }, o, { ts: undefined }))).join("\n") + "\n");

  const buys = kept.filter((x) => x.kind === "buy"), md = [];
  md.push("# Demo account: " + persona + " (seed " + seed + ")", "", "Made-up investor, real tickers and real Yahoo closes. Habit: " + PERSONAS[persona], "",
    "- " + buys.length + " buys, " + (kept.length - buys.length) + " sells, " + new Date(kept[0].ts).toISOString().slice(0, 10) + " to " + new Date(kept[kept.length - 1].ts).toISOString().slice(0, 10) + ".",
    "- Buys carrying the habit: " + buys.filter((x) => plantedOf[x.ts]).length + " of " + buys.length + ".",
    "- trades.csv read as `" + parsed.format + "`, " + parsed.txs.length + " trades. History.json: " + hx.entries + " entries, " + hx.visits.length + " stock-page visits on " + Object.keys(hx.tickers).length + " tickers.", "",
    "## What the analysis found", "", "| Bias | Tier | Signal |", "|---|---|---|");
  coach.biases.forEach((b) => md.push("| " + b.name + " | " + b.tier + " | " + (b.signals[0] ? b.signals[0].text : "-") + " |"));
  md.push("", "| Rule | Bias | Out of sample | Flagged | Gain per flagged buy |", "|---|---|---|---|---|");
  coach.rules.filter((x) => x.recommended).forEach((x) => md.push("| " + x.title + " | " + x.bias + " | " + x.oos.verdict + " | " + (x.oos.flagged || 0) + " of " + (x.oos.testN || 0) + " | " + (x.oos.mean == null ? "-" : (x.oos.mean * 100).toFixed(1) + " pts") + " |"));
  md.push("", "Prices are real, so the result is whatever these stocks really did after the buys: a planted habit is not guaranteed to cost money here, unlike the sandbox personas.");
  fs.writeFileSync(path.join(outDir, "report.md"), md.join("\n") + "\n");
  console.log(md.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
