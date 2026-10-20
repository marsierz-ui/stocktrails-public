// Execution evidence, one synthetic investor per habit: the FOMO buyer, the
// first-hour impulse buyer, the night trader, the YOLO trader and the herd
// follower (tools/synth-world.js PERSONAS), plus a control investor with no
// planted habit. Each is taken through the real pipeline: broker CSV -> ledger
// import -> analysis -> bias coach -> out-of-sample rule check. No real data,
// no network.
//
//   node tools/persona-runs.js                writes docs/hackathon/evidence/personas/
//   node tools/persona-runs.js --seed 5       other investors with the same habits
//   node tools/persona-runs.js --seeds 10     robustness over 10 seeds (default 10)
//
// Per investor: trades.csv (importable in My Habits > Trades & research, generic
// template), operations.jsonl (the sandbox account's operation log in time
// order: views, calls, orders, then the system's own steps) and report.md.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const D = require(path.join(root, "src", "decisions.js")), B = require(path.join(root, "src", "biases.js")), I = require(path.join(root, "src", "indicators.js"));
const L = require(path.join(root, "src", "ledger.js")), W = require(path.join(__dirname, "synth-world.js"));

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; };
const seed = +arg("seed", 21), nSeeds = +arg("seeds", 10);
const outDir = arg("out", path.join(root, "docs", "hackathon", "evidence", "personas"));
const SIZE = { nBuys: 140, bars: 1000, nPassed: 30 };
const TARGETS = ["chasing", "impulse", "bad_hour", "turbulence", "crowd_buys"];
const NAMES = { chasing: "FOMO (chasing rises)", impulse: "First-hour impulse", bad_hour: "Night buying", turbulence: "YOLO in turbulent markets", crowd_buys: "Herd (crowd buys)" };
const PERSONAS = Object.assign({}, W.PERSONAS, { control: { label: "Control investor", bias: null, habit: "No planted habit: every buy's return is market plus noise.", opts: {} } });
const pts = (x) => (x == null ? "-" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + " pts");
const pc = (x) => (x == null ? "-" : Math.round(x * 100) + "%");
const iso = (ts) => new Date(ts).toISOString();

function run(id, s) {
  const p = PERSONAS[id], world = W.buildWorld(Object.assign({ seed: s }, SIZE, p.opts));
  const input = world.input, R = D.analyze(input);
  R.ind = I.analyze(input, R);
  return { p, world, input, R, coach: B.coach(R) };
}

// what the coach says about one bias: tier, signals, and the rules it recommends with their out-of-sample verdict
function verdictOf(coach, bias) {
  const b = coach.biases.find((x) => x.id === bias);
  if (!b) return { tier: "none", signals: [], rules: [] };
  return { tier: b.tier, signals: b.signals.map((x) => x.text), rules: b.rules.filter((r) => r.recommended).map((r) => ({ id: r.id, title: r.title, text: r.text, verdict: r.oos.verdict,
    flagged: r.oos.flagged || 0, testN: r.oos.testN || 0, mean: r.oos.mean, ci99: r.oos.ci99 ? [r.oos.ci99.lo, r.oos.ci99.hi] : null, flaggedMean: r.oos.flaggedMean, keptMean: r.oos.keptMean })) };
}
const found = (v) => v.tier === "detected" || v.rules.some((r) => r.verdict === "supported");

function toCsv(txs) {
  const rows = ["date,type,isin,symbol,name,quantity,price,amount,fee,tax,currency"];
  txs.slice().sort((a, b) => a.ts - b.ts).forEach((t) => rows.push([iso(t.ts), t.kind, t.isin, t.symbol, t.name, t.qty, (t.amount / t.qty).toFixed(2), t.amount.toFixed(2), "1.00", "0.00", t.currency].join(",")));
  return rows.join("\n") + "\n";
}

function operations(id, x, imported) {
  const { input, world } = x, acct = "sandbox-" + id + "-" + seed, ops = [];
  const truth = {};
  world.truth.buys.forEach((b) => { truth[b.ticker] = b; });
  const first = {};
  input.intraday.forEach((e) => { if (e.id !== "seed" && (first[e.ticker] == null || e.ts < first[e.ticker])) first[e.ticker] = e.ts; });
  input.intraday.forEach((e) => { if (e.id !== "seed") ops.push({ ts: e.ts, op: "VIEW", ticker: e.ticker, page: e.researchType, dwellSec: Math.round(e.dwellMs / 1000) }); });
  input.events.forEach((e) => ops.push({ ts: e.ts, op: "CALL", ticker: e.ticker, sentiment: e.sentiment, note: e.rationale || null, targetPrice: e.targetPrice || null }));
  input.txs.forEach((t) => {
    const b = truth[t.symbol], o = { ts: t.ts, op: t.kind === "buy" ? "ORDER_BUY" : "ORDER_SELL", ticker: t.symbol, isin: t.isin, amountEur: t.amount, hour: new Date(t.ts).getHours() };
    if (t.kind === "buy" && b) Object.assign(o, { minutesSinceFirstLook: first[t.symbol] != null ? Math.round((t.ts - first[t.symbol]) / 60000) : null, runupBeforeBuy: +b.runup.toFixed(4),
      market: b.turbulent ? "turbulent" : "calm", crowdSpikeBefore: b.crowd == null ? null : b.crowd,
      planted: { fomo: b.runup > 0.1, first_hour: b.impulse, night_trader: b.evening, yolo: b.turbulent, herd: !!b.crowd }[id] || false, excess21: +b.ex21.toFixed(4) });
    ops.push(o);
  });
  ops.sort((a, b) => a.ts - b.ts);
  ops.unshift({ ts: ops[0].ts - 60000, op: "ACCOUNT_OPEN", persona: x.p.label, habit: x.p.habit, synthetic: true, seed });
  const end = input.now;
  ops.push({ ts: end, op: "IMPORT_CSV", file: "trades.csv", format: imported.format, rows: imported.rows, trades: imported.txs.length, roundTrip: imported.roundTrip });
  ops.push({ ts: end + 1000, op: "ANALYZE", decisions: x.R.decisions.length, buys: x.R.decisions.filter((d) => d.side === "buy" && !d.excluded).length, priceSeries: Object.keys(input.prices).length });
  x.coach.biases.forEach((b, i) => ops.push({ ts: end + 2000 + i, op: "BIAS", bias: b.id, name: b.name, tier: b.tier, signals: b.signals.map((s) => s.text) }));
  x.coach.rules.filter((r) => r.recommended).forEach((r, i) => ops.push({ ts: end + 3000 + i, op: "RULE_CHECK", rule: r.id, bias: r.bias, text: r.text, verdict: r.oos.verdict, flagged: r.oos.flagged, of: r.oos.testN, gainPerFlagged: r.oos.mean, ci99: r.oos.ci99 ? [r.oos.ci99.lo, r.oos.ci99.hi] : null }));
  return ops.map((o, i) => JSON.stringify(Object.assign({ seq: i + 1, at: iso(o.ts), account: acct }, o, { ts: undefined }))).join("\n") + "\n";
}

const summary = { generated: new Date().toISOString(), seed, seeds: nSeeds, size: SIZE, personas: {} };
const md = [], line = (s) => md.push(s == null ? "" : s);
fs.mkdirSync(outDir, { recursive: true });

for (const id of Object.keys(PERSONAS)) {
  const x = run(id, seed), dir = path.join(outDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const csv = toCsv(x.input.txs), parsed = L.parseFile(csv);
  const want = x.input.txs.map((t) => t.kind + "|" + t.ts + "|" + t.isin + "|" + t.amount).sort(), got = parsed.txs.map((t) => t.kind + "|" + t.ts + "|" + t.isin + "|" + t.amount).sort();
  const imported = { format: parsed.format, rows: parsed.rows, txs: parsed.txs, roundTrip: JSON.stringify(want) === JSON.stringify(got) };
  fs.writeFileSync(path.join(dir, "trades.csv"), csv);
  fs.writeFileSync(path.join(dir, "operations.jsonl"), operations(id, x, imported));

  const all = {};
  TARGETS.forEach((b) => { all[b] = verdictOf(x.coach, b); });
  const own = x.p.bias ? all[x.p.bias] : null, tb = x.world.truth.buys;
  const plantedShare = { fomo: tb.filter((b) => b.runup > 0.1).length, first_hour: tb.filter((b) => b.impulse).length, night_trader: tb.filter((b) => b.evening).length, yolo: tb.filter((b) => b.turbulent).length, herd: tb.filter((b) => b.crowd).length }[id];

  const r = [];
  r.push("# " + x.p.label + " (synthetic, seed " + seed + ")", "", "Planted habit: " + x.p.habit, "",
    "- Account: `sandbox-" + id + "-" + seed + "`, " + tb.length + " buys, " + x.input.txs.filter((t) => t.kind === "sell").length + " sells, " + x.input.intraday.length + " page views, " + x.input.events.length + " calls, " + x.input.txs[0].date + " to " + x.input.txs[x.input.txs.length - 1].date + ".",
    plantedShare != null ? "- Buys carrying the habit: " + plantedShare + " of " + tb.length + " (" + pc(plantedShare / tb.length) + ")." : "- No planted habit.",
    "- Import: `trades.csv` read as format `" + imported.format + "`, " + imported.txs.length + " trades, round trip " + (imported.roundTrip ? "exact" : "**MISMATCH**") + ".", "");
  r.push("## What the system found", "", "| Bias | Tier | Signal | Rule | Out of sample | Flagged | Gain per flagged buy (99% range) |", "|---|---|---|---|---|---|---|");
  TARGETS.forEach((b) => {
    const v = all[b], mark = b === x.p.bias ? " (planted)" : "";
    if (!v.rules.length) r.push("| " + NAMES[b] + mark + " | " + v.tier + " | " + (v.signals[0] || "-") + " | - | - | - | - |");
    v.rules.forEach((ru, k) => r.push("| " + (k ? "" : NAMES[b] + mark) + " | " + (k ? "" : v.tier) + " | " + (k ? "" : v.signals[0] || "-") + " | " + ru.title + " | " + ru.verdict + " | " + ru.flagged + " of " + ru.testN + " | " + (ru.mean != null ? pts(ru.mean) + " (" + pts(ru.ci99[0]) + " to " + pts(ru.ci99[1]) + ")" : "-") + " |"));
  });
  r.push("", "Tiers: `detected` = a statistical signal is clear; `watch` = a signal, not yet clear; `rules` = no signal, but a rule for it was fitted; `none` = nothing shown. " +
    "A rule is fitted on earlier trades and judged on later ones (walk-forward with an embargo); `supported` = its 99% range is above zero.", "");
  if (own) own.rules.forEach((ru) => r.push("Rule the coach would offer: \"" + ru.text + "\"", ""));
  r.push("Files: `trades.csv` (broker export, generic template), `operations.jsonl` (one JSON object per operation, in time order; orders carry the habit's ground truth in `planted`).");
  fs.writeFileSync(path.join(dir, "report.md"), r.join("\n") + "\n");

  summary.personas[id] = { label: x.p.label, bias: x.p.bias, habit: x.p.habit, plantedShare: plantedShare == null ? null : plantedShare / tb.length, import: { format: imported.format, trades: imported.txs.length, roundTrip: imported.roundTrip }, findings: all };
  console.log(id, "done");
}

// robustness: the same habits on other seeds
const rob = {};
for (const id of Object.keys(PERSONAS)) {
  rob[id] = { own: 0, ownDetected: 0, ownRuleSupported: 0, others: 0, n: 0 };
  for (let s = seed; s < seed + nSeeds; s++) {
    const x = run(id, s), bias = PERSONAS[id].bias;
    rob[id].n++;
    TARGETS.forEach((b) => {
      const v = verdictOf(x.coach, b);
      if (b === bias) { if (found(v)) rob[id].own++; if (v.tier === "detected") rob[id].ownDetected++; if (v.rules.some((r) => r.verdict === "supported")) rob[id].ownRuleSupported++; }
      else if (found(v)) rob[id].others++;
    });
  }
  console.log(id, "robustness", JSON.stringify(rob[id]));
}
summary.robustness = rob;

line("# Execution evidence: five investor habits in the sandbox");
line();
line("Generated by `node tools/persona-runs.js` on " + summary.generated.slice(0, 10) + ". Synthetic data only: no real person, account or trade. " +
  "Each sandbox account is built with one known habit, its trades are exported as a broker CSV, imported through the app's own ledger parser and analysed by the same code the extension runs (`src/decisions.js`, `src/indicators.js`, `src/biases.js`).");
line();
line("## The accounts (seed " + seed + ")");
line();
line("| Account | Planted habit | Buys with it | Coach tier | Rule offered | Out of sample | Gain per flagged buy (99% range) |");
line("|---|---|---|---|---|---|---|");
Object.keys(PERSONAS).forEach((id) => {
  const s = summary.personas[id], v = s.bias ? s.findings[s.bias] : null, ru = v && (v.rules.find((r) => r.verdict === "supported") || v.rules[0]);
  line("| [" + s.label + "](" + id + "/report.md) | " + s.habit + " | " + pc(s.plantedShare) + " | " + (v ? v.tier : "-") + " | " + (ru ? ru.title : "-") + " | " + (ru ? ru.verdict : "-") + " | " + (ru && ru.mean != null ? pts(ru.mean) + " (" + pts(ru.ci99[0]) + " to " + pts(ru.ci99[1]) + ")" : "-") + " |");
});
line();
line("## Does each account show its own habit, and only that?");
line();
line("A cell is the coach's tier for that bias, and the out-of-sample verdict of each rule it fitted (s = supported, i = indicative, u = unclear or unsupported).");
line();
line("| Account | " + TARGETS.map((b) => NAMES[b]).join(" | ") + " |");
line("|---|" + TARGETS.map(() => "---").join("|") + "|");
Object.keys(PERSONAS).forEach((id) => {
  const s = summary.personas[id];
  line("| " + s.label + " | " + TARGETS.map((b) => { const v = s.findings[b], c = v.tier + (v.rules.length ? " / " + v.rules.map((r) => ({ supported: "s", indicative: "i" }[r.verdict] || "u")).join("") : ""); return b === s.bias ? "**" + c + "**" : c; }).join(" | ") + " |");
});
line();
line("## Robustness over " + nSeeds + " seeds (" + seed + " to " + (seed + nSeeds - 1) + ")");
line();
line("Found = tier `detected` or a rule `supported` out of sample. Other habits = how many times one of the four habits that were NOT planted was found (out of " + nSeeds + " x 4).");
line();
line("| Account | Own habit found | Detected | Rule supported | Other habits found |");
line("|---|---|---|---|---|");
Object.keys(PERSONAS).forEach((id) => { const r = rob[id]; line("| " + PERSONAS[id].label + " | " + (PERSONAS[id].bias ? r.own + " of " + r.n : "-") + " | " + (PERSONAS[id].bias ? r.ownDetected : "-") + " | " + (PERSONAS[id].bias ? r.ownRuleSupported : "-") + " | " + r.others + " of " + (PERSONAS[id].bias ? r.n * 4 : r.n * 5) + " |"); });
line();
line("## Notes for the reader");
line();
line("- First-hour impulse means a buy within an hour of the first recorded look at the stock (Stocktrails' definition), not the first hour after the market opens.");
line("- The YOLO habit (oversized buys in turbulent markets) shows up as rules, not as a `detected` signal: turbulent stretches last weeks, and the calendar-shift test that guards the signal against that is deliberately strict. The coach offers it through its two turbulent-market rules, judged on later trades (see the robustness table).");
line("- Each habit costs money against the NASDAQ; the account's other buys are set to beat it by about as much, so the average buy roughly matches the market. Otherwise skipping any buy would look like a good rule.");
line("- Times in the CSV are UTC; the analysis reads hours in the local time zone of the machine that ran it.");
line();
line("## Reproduce, and show it in the app");
line();
line("```bash");
line("node tools/persona-runs.js");
line("```");
line();
line("```bash");
line("node tools/sandbox.js");
line("```");
line();
line("Then open `http://127.0.0.1:8780/?persona=fomo` (or `first_hour`, `night_trader`, `yolo`, `herd`) for the dashboard on that account. Each `trades.csv` can also be imported in My Habits > Trades & research as a generic CSV.");
fs.writeFileSync(path.join(outDir, "README.md"), md.join("\n") + "\n");
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
console.log(md.join("\n"));
