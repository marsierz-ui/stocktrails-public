// Compares the decision model and the text model on the same moments, through the ai-coach
// function's own logic (supabase/functions/ai-coach/core.mjs), with the providers' real APIs.
// The moments are a synthetic investor's (tools/synth-world.js): no real data is sent. It is the
// command-line twin of "Compare the text model and the decision model" in the AI agent section,
// which runs the same two requests on the moments of your own saved decisions.
//
//   bash:        OPENROUTER_API_KEY=... AI_PROVIDER=openrouter AI_MODEL=<text model> AI_DECISION_MODEL=typesafe/jev-1.14 node tools/compare-models.js
//   PowerShell:  $env:OPENROUTER_API_KEY="..."; $env:AI_PROVIDER="openrouter"; ...; node tools/compare-models.js
//
// Settings are the function's own (see supabase/functions/ai-coach/index.ts): AI_PROVIDER (openrouter or
// cerebras), the key of that provider (CEREBRAS_API_KEY, OPENROUTER_API_KEY), AI_MODEL,
// AI_DECISION_MODEL (with OPENROUTER_API_KEY), AI_DECIDE_MIN_P. Options: --n 12 (moments), --seed 21,
// --out file.json (the answers and the comparison). Each engine is one or two requests; nothing is stored.
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const root = path.join(__dirname, "..");
const D = require(path.join(root, "src", "decisions.js"));
const I = require(path.join(root, "src", "indicators.js"));
const SH = require(path.join(root, "src", "shadow.js"));
const W = require(path.join(__dirname, "synth-world.js"));

// What index.ts does with a request: the chat API of cerebras/openrouter, or the Decisions API.
function liveCallModel(core, env) {
  return async function (request, route) {
    const provider = String(env.AI_PROVIDER || "openrouter").toLowerCase();
    let url, headers;
    const k = env[route !== "decisions" && provider === "cerebras" ? "CEREBRAS_API_KEY" : "OPENROUTER_API_KEY"];
    if (!k) throw Object.assign(new Error("API key is not set"), { status: 500 });
    url = route === "decisions" ? core.DECISIONS_URL : core.CHAT_URLS[provider];
    headers = { Authorization: "Bearer " + k, "Content-Type": "application/json" };
    const r = await fetch(url, { method: "POST", headers: headers, body: JSON.stringify(request) });
    if (!r.ok) throw Object.assign(new Error("model http " + r.status), { status: r.status });
    return r.json();
  };
}

// o: { n, seed, env, callModel (a fake, for tests), log (false: quiet), out }. Returns { rows, summary, runs }.
async function main(o) {
  o = o || {};
  const core = await import(pathToFileURL(path.join(root, "supabase", "functions", "ai-coach", "core.mjs")).href);
  const env = Object.assign({}, o.env || process.env, { AI_ALLOW_ALL: "true" });
  const log = o.log === false ? function () {} : console.log;
  const callModel = o.callModel || liveCallModel(core, env);
  const n = Math.max(2, Math.min(30, o.n || 12)), seed = o.seed || 21;

  // moments with 21 trading days of prices after them, so the outcomes can be measured too
  const w = W.buildWorld({ seed: seed, nBuys: 140, bars: 1000, runupMean: 0.08, chase: -0.08, impulse: -0.08, impulseShare: 0.25, crowd: { follow: 0.3, edge21: -0.05 } }), input = w.input;
  const R = D.analyze(input);
  R.ind = I.analyze(input, R);
  const S = SH.run({ R: R, input: input, now: input.now });
  const okc = function (c) { return c.i0 + 22 < c.series.length; };
  const cands = S.trades.candidates.filter(okc).slice(-Math.ceil(n / 2)).concat(S.looks.candidates.filter(okc).slice(-Math.floor(n / 2)));
  const ctxs = cands.map(function (c) { return SH.contextFor(c, R, input, SH.snapshotAt(S.snapshots, c.t), { names: false, community: input.community }); });
  const rulesBy = {};
  S.trades.rules.concat(S.looks.rules).forEach(function (d) { rulesBy[d.id] = d; });
  const cx = SH.context(R, input, input.community);
  log("Synthetic investor (seed " + seed + "), " + cands.length + " moments, provider " + (env.AI_PROVIDER || "openrouter") + ", decision model " + (env.AI_DECISION_MODEL || "none") + ".");

  const runs = {}, by = {};
  for (const engine of ["text", "decision"]) {
    const t0 = Date.now();
    const body = { v: 1, task: "decide", engine: engine, candidates: ctxs.map(function (c, i) { return Object.assign({}, c, { id: "c" + (i + 1) }); }) };
    const res = await core.handle({ raw: JSON.stringify(body), user: { id: "cli" }, env: env, bump: async function () { return 1; }, callModel: callModel });
    const ms = Date.now() - t0;
    runs[engine] = { status: res.status, ms: ms, model: res.json.model || null, promptVersion: res.json.promptVersion || null, provider: res.json.provider || null, error: res.json.ok ? null : res.json.error + ": " + res.json.message, spend: res.json.spend || null };
    if (!res.json.ok) { log(engine + " model: " + runs[engine].error); continue; }
    res.json.decisions.forEach(function (d) {
      const c = cands[+d.id.slice(1) - 1];
      (by[c.id] = by[c.id] || { id: c.id, kind: c.kind })[engine] = Object.assign({}, d, { ex: SH.outcome(c, d, cx) });
    });
    // a moment the model was not sure enough to decide (the decision model under its threshold, or a text model saying unsure)
    (res.json.unsure || []).forEach(function (u) {
      const c = cands[+u.id.slice(1) - 1];
      (by[c.id] = by[c.id] || { id: c.id, kind: c.kind })[engine] = { unsure: true, reason: u.reason || "", trace: u.trace || null };
    });
    log(engine + " model " + runs[engine].model + " (prompt " + runs[engine].promptVersion + "): " + res.json.decisions.length + " of " + cands.length + " decided" + ((res.json.unsure || []).length ? ", " + res.json.unsure.length + " not sure enough" : "") + ", in " + (ms / 1000).toFixed(1) + " s" + (res.json.spend ? ", $" + res.json.spend.costUsd : "") + ".");
  }
  const rows = cands.map(function (c) { const r = by[c.id] || { id: c.id, kind: c.kind }; r.rules = rulesBy[c.id] || null; return r; });
  const summary = SH.compareRuns(rows, 21), pc = function (v) { return v == null ? "-" : Math.round(v * 100) + "%"; };
  const pts = function (v) { return v == null ? "-" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + " pts"; };
  ["rules", "text", "decision"].forEach(function (k) {
    const p = summary.per[k];
    log("  " + (k + "        ").slice(0, 9) + p.n + " moments: buy " + p.actions.buy + ", wait " + p.actions.wait + ", pass " + p.actions.pass + (p.unsure ? ", not sure enough on " + p.unsure : "") + (p.meanOdds != null ? ", mean odds " + pc(p.meanOdds) : ""));
  });
  const a = summary.agreement;
  log("  text vs decision model: the same action on " + a.textVsDecision.same + " of " + a.textVsDecision.n + " (" + pc(a.textVsDecision.sameShare) + "); text vs rules agent " + pc(a.textVsRules.sameShare) + ", decision model vs rules agent " + pc(a.decisionVsRules.sameShare) + ".");
  log("  mean excess against the NASDAQ over 21 trading days: you " + pts(summary.outcome.you.mean) + ", rules agent " + pts(summary.outcome.rules.mean) + ", text model " + pts(summary.outcome.text.mean) + " (" + summary.outcome.text.n + "), decision model " + pts(summary.outcome.decision.mean) + " (" + summary.outcome.decision.n + ").");
  log("  " + summary.note + " A synthetic investor's prices are random, so no engine is expected to beat the others here: this checks that both routes answer and how alike they are.");
  if (o.out) { fs.writeFileSync(o.out, JSON.stringify({ about: "Synthetic moments decided by the text model and the decision model.", seed: seed, runs: runs, summary: summary, answers: rows.map(function (r) { return { id: r.id, kind: r.kind, rules: r.rules && { action: r.rules.action, days: r.rules.days, size: r.rules.size }, text: r.text || null, decision: r.decision || null }; }) }, null, 2)); log("Written to " + o.out); }
  return { rows: rows, summary: summary, runs: runs };
}

module.exports = { main: main };

if (require.main === module) {
  const arg = function (k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; };
  main({ n: +arg("n", 12), seed: +arg("seed", 21), out: arg("out", null) }).then(function (r) {
    const bad = Object.keys(r.runs).filter(function (k) { return r.runs[k].error; });
    if (bad.length) { console.log(bad.length + " engine(s) did not answer."); process.exit(1); }
  }).catch(function (e) { console.error(e && e.message || e); process.exit(1); });
}
