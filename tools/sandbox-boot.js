// Loaded only by the sandbox page (tools/sandbox.js), after the dashboard's own
// scripts. Fills this browser's local ledger with a synthetic investor, points
// the assistant at the ai-coach function's logic running right here (stand-in
// model, no network), and opens My Habits > Trades & research.
(async function () {
  const q = new URLSearchParams(location.search), seed = +q.get("seed") || 21;
  // offline: the price and profile proxy is not here, so answer its lookups as "not found" without a network call
  const realFetch = self.fetch.bind(self);
  self.fetch = function (u, o) { return /\/yahoo\?/.test(String(u && u.url || u)) ? Promise.resolve(new Response("{}", { status: 404 })) : realFetch(u, o); };
  TR.biasLaunch = null; // the synthetic investor starts using the app halfway: split there
  const gate = document.getElementById("auth-gate");
  if (gate) gate.style.display = "none";
  // only the Trades pane is set up here: no other tab, totals or sign-in
  const st = document.createElement("style");
  st.textContent = "header .summary, #maintabs, #fb-open, #main-attention .att-toolbar { display: none !important; }";
  document.head.appendChild(st);

  // ?persona=fomo|first_hour|night_trader|yolo|herd: one investor with only that habit (tools/persona-runs.js), as in the execution evidence
  const persona = SynthWorld.PERSONAS[q.get("persona")] || null;
  const world = persona ? SynthWorld.buildWorld(Object.assign({ seed: seed, nBuys: 140, bars: 1000, nPassed: 30 }, persona.opts))
    : SynthWorld.buildWorld({ seed: seed, nBuys: 140, bars: 1000, appStartAt: 0.55, after: { runupMean: 0.02, impulseShare: 0.08 }, nPassed: 110, runupMean: 0.08, chase: -0.07, impulse: -0.08, impulseShare: 0.25, evening: -0.07,
      turbulent: -0.06, oversize: 2.2, passedEdge: 0.08, avoidEdge: -0.03, valuationEdge: 0.15, crowd: { follow: 0.3, edge21: -0.05 } });
  const input = world.input;

  // the ledger of the "local" owner: the synthetic trades and their stock matches
  await ATLedgerDB.clearOwner("local");
  await ATLedgerDB.addTxs("local", input.txs, "sandbox");
  await ATLedgerDB.addImport("local", { id: "sandbox", at: Date.now(), label: "Synthetic investor", fileName: "synthetic.csv", from: input.txs[0].date, to: input.txs[input.txs.length - 1].date, added: input.txs.length, duplicates: 0, counts: {} });
  await ATLedgerDB.putLinks("local", Object.keys(input.links).map(function (k) {
    const l = input.links[k];
    return { inst: k, isin: k, name: l.ticker + " Corp", brokerSymbol: l.ticker, ticker: l.ticker, symbol: l.symbol, status: "matched", manual: true, v: LINK_VER, tracked: 0, cands: [] };
  }));
  DATA = { intraday: input.intraday, events: input.events, overrides: {}, settings: {} };
  GROUPS = {}; BENCH = input.bench; NAMES = {};
  TR.prices = input.prices; TR.reportKey = null; TR.report = null;
  // other users' views per stock (synthetic, the user's own included as the RPC does), in place of the signed-in fetch
  TR.comm = { community: input.community, trending: {}, crowd: null, firstLooks: null };
  // the weekly review looks at the last days of the synthetic attention data, not today
  TR.ai.now = Math.max.apply(null, input.intraday.map(function (e) { return e.ts; })) + 3600e3;

  // the assistant: the function's own code, a stand-in model, a counter in memory
  const core = await import("/supabase/functions/ai-coach/core.mjs");
  let used = 0;
  // ?engines=1: two made-up models behind the same function logic (a "text model" and a "decision model", each answering
  // from a hash of what it is shown, so the same moment always gets the same answer), to try the comparison of the two
  // routes and the saved reasoning. They judge nothing: only the plumbing is real.
  const hash = function (s) { let x = 7; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0; return x; };
  const unit = function (c) { return (hash(JSON.stringify(Object.assign({}, c, { id: 0 }))) % 1000) / 1000; };
  const fakeModel = async function (request, route) {
    if (route === "decisions") {
      const st = request.state, answers = {};
      if (typeof st === "object" && st) {
        const u = unit(st), hot = (st.runup30 || 0) > 12, raw = { buy: hot ? 0.1 : 0.45 + 0.4 * u, wait: hot ? 0.45 + 0.35 * u : 0.2 * (1 - u), pass: hot ? 0.25 : 0.1 + 0.1 * u }, sum = raw.buy + raw.wait + raw.pass, p = {};
        Object.keys(raw).forEach(function (k) { p[k] = raw[k] / sum; });
        const choice = Object.keys(p).sort(function (a, b) { return p[b] - p[a]; })[0], lv = function (n, at) { const o = {}; for (let i = 0; i < n; i++) o[i] = i === at ? 0.7 : 0.3 / (n - 1); return o; };
        answers.action = { type: "choice", choice: choice, probabilities: p, confidence: p[choice] };
        answers.days = { type: "score", score: 1 + 3 * u, probabilities: lv(10, Math.round(1 + 3 * u)) };
        answers.size = { type: "score", score: hot ? 1 : 3, probabilities: lv(4, hot ? 1 : 3) };
      } else Object.keys(request.questions).forEach(function (k) { const q = request.questions[k]; answers[k] = q.type === "noul" ? { type: "noul", noul: 0.2 } : { type: q.type, choice: Object.keys(q.criteria || {})[0], probabilities: {}, score: 0 }; });
      return { model: "sandbox/decision-20261018", answers: answers, usage: { input_tokens: 450, output_tokens: 20, cost: 0.00002 } };
    }
    const sys = request.messages[0].content, usr = request.messages[1].content;
    let obj;
    if (/PAPER portfolio/.test(sys)) {
      const cands = JSON.parse(usr.slice(usr.indexOf("[")));
      obj = { decisions: cands.map(function (c) {
        const u = unit(c), hot = (c.runup30 || 0) > 12;
        if (c.kind === "revisit") return { id: c.id, action: u < 0.5 ? "hold" : "buy", size: 0.25, reason: "Burst of views, nothing decisive.", reasoning: c.stock + " saw a burst of views; " + (u < 0.5 ? "no change is justified by views alone." : "a small add is reasonable.") };
        return { id: c.id, action: hot ? (u < 0.5 ? "wait" : "pass") : "buy", days: 3, size: hot ? 0.5 : 1, reason: hot ? c.stock + " ran up " + c.runup30 + "% in a month." : "No warning sign.",
          reasoning: c.stock + " moved " + c.runup30 + "% in 30 days and sits " + c.fromHigh52 + "% from its 52-week high; the rules agent says " + (c.rulesAgent && c.rulesAgent.action) + ". Against: research was " + (c.research ? "present" : "thin") + "." };
      }) };
    } else obj = /Pick the smallest set of tools/.test(sys) ? { calls: [{ tool: "get_overview", args: {} }] } : { answer: "The sandbox's made-up text model has no answer; leave out ?engines=1 for the stand-in assistant." };
    return { choices: [{ message: { content: JSON.stringify(obj) } }] };
  };
  const engines = q.get("engines") === "1";
  ATCloud.aiCoach = async function (body) {
    const env = engines ? { AI_PROVIDER: "openrouter", AI_MODEL: "sandbox-text-1", AI_MODEL_LITE: "sandbox-text-lite", AI_DECISION_MODEL: "sandbox/decision", AI_ALLOWED_USERS: "sandbox" } : { AI_PROVIDER: "mock", AI_ALLOWED_USERS: "sandbox" };
    const r = await core.handle({ raw: JSON.stringify(body), user: { id: "sandbox" }, env: env, bump: async function () { return ++used; }, callModel: engines ? fakeModel : null });
    return r.json;
  };

  // show the Trades pane under a banner
  document.querySelectorAll(".mainview").forEach(function (m) { m.hidden = m.id !== "main-attention"; });
  const pane = document.querySelector('[data-pane="trades"]');
  document.querySelectorAll("#main-attention [data-pane]").forEach(function (p) { p.hidden = p !== pane; });
  const bar = document.createElement("div");
  bar.className = "tr-msg";
  bar.style.cssText = "margin:10px auto;max-width:1480px;display:flex;gap:12px;align-items:center;flex-wrap:wrap";
  bar.innerHTML = "<b>Sandbox.</b> " + (persona ? persona.label + ": " + persona.habit + " " : "") + "A synthetic investor (seed " + seed + "): no real person, trade or account. The assistant answers on a stand-in model" + (engines ? " (?engines=1: the AI agent's decisions come from a made-up text model and a made-up decision model)" : "") + " and nothing leaves this computer. " +
    "<a href='?seed=" + (seed + 1) + (persona ? "&persona=" + q.get("persona") : "") + "'>Another investor</a>";
  document.getElementById("main-attention").prepend(bar);
  await renderTrades();
})();
