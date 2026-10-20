(function () {
  // The browser side of the assistant. Off until the user agrees; then every
  // exchange with the ai-coach function is written to a log the user can read
  // and export, so what left the device is never a matter of trust.
  //
  // A question is an agent loop of up to five steps: the model sees the question
  // (stocks replaced by aliases unless the user opted in to names) and the results so
  // far, and either names more read-only tools, which run here on the device
  // (src/aitools.js), or answers. Its answer may carry proposed actions; they become
  // cards the user decides on.
  // The text is checked against the results before it is shown: every number it
  // states must be one the results hold, or the reply is marked.
  const T = typeof module !== "undefined" && module.exports ? require("./aitools.js") : self.ATTools;
  const B = typeof module !== "undefined" && module.exports ? require("./biases.js") : self.ATBiases;
  // The log keeps the last KEEP entries of the chat and notes and, apart from them, the last
  // KEEP_DECIDE of the AI agent's paper decisions (a day's requests), so a backfill never
  // pushes the rest out. Decide bodies are kept whole; others are cut at BODY_MAX.
  const CONSENT = "at_ai_consent", TERMS = "at_terms", OFF = "at_ai_off", TERMS_VERSION = 2, LOG = "at_ai_log", VERSION = 1, KEEP = 80, KEEP_DECIDE = 120, BODY_MAX = 6000;
  const mem = [];
  let loaded = false;

  function ls() { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (e) { return null; } }
  // The assistant is on only when the user ticked its own box at sign-up (or pressed
  // "Turn on the assistant"), and has not switched it off. Accepting the terms is a
  // separate record (`termsAccepted`) and does not turn it on.
  function consent() {
    const s = ls();
    try {
      if (!s || s.getItem(OFF) === "1") return null;
      const v = JSON.parse(s.getItem(CONSENT) || "null");
      return v && v.v === VERSION ? v : null;
    } catch (e) { return null; }
  }
  function termsAccepted() {
    const s = ls();
    try { const t = s && JSON.parse(s.getItem(TERMS) || "null"); return !!(t && t.v === TERMS_VERSION); } catch (e) { return false; }
  }
  function acceptTerms() { const s = ls(); if (s) try { s.setItem(TERMS, JSON.stringify({ v: TERMS_VERSION, at: Date.now() })); } catch (e) { /* storage full or blocked */ } record({ dir: "info", note: "Terms of Use and Privacy Policy accepted." }); }
  // The extension's worker cannot read localStorage: it learns the state from at_ai_on (the AI agent's live verdict, src/background.js).
  function mirror(on) { try { if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) chrome.storage.local.set({ at_ai_on: on }); } catch (e) { /* not the extension */ } }
  function grant() { const s = ls(); if (s) try { s.setItem(CONSENT, JSON.stringify({ v: VERSION, at: Date.now() })); s.removeItem(OFF); } catch (e) { /* storage full or blocked */ } mirror(true); record({ dir: "info", note: "Consent given." }); }
  function revoke() { const s = ls(); if (s) try { s.removeItem(CONSENT); s.setItem(OFF, "1"); } catch (e) { /* ignore */ } mirror(false); record({ dir: "info", note: "Consent withdrawn." }); }

  function load() {
    if (loaded) return;
    loaded = true;
    const s = ls();
    try { const a = s && JSON.parse(s.getItem(LOG) || "[]"); if (Array.isArray(a)) a.forEach(function (e) { mem.push(e); }); } catch (e) { /* a damaged log is dropped */ }
  }
  function record(e) {
    load();
    mem.push(Object.assign({ at: Date.now() }, e));
    let n = 0, nd = 0;
    for (let i = mem.length - 1; i >= 0; i--) if (mem[i].task === "decide" ? ++nd > KEEP_DECIDE : ++n > KEEP) mem.splice(i, 1);
    const s = ls();
    if (s) try { s.setItem(LOG, JSON.stringify(mem)); } catch (x) { /* storage full */ }
  }
  function log() { load(); return mem.slice(); }
  function clearLog() { mem.length = 0; loaded = true; const s = ls(); if (s) try { s.removeItem(LOG); } catch (e) { /* ignore */ } }
  function exportLog() {
    load();
    return JSON.stringify({ about: "What Stocktrails sent to its AI service and what came back, newest last. Tools run on this device and send nothing by themselves.", version: VERSION, exportedAt: new Date().toISOString(), entries: mem }, null, 2);
  }

  async function defaultTransport(body) {
    if (!self.ATCloud || !ATCloud.aiCoach) throw new Error("The AI service is not available here.");
    return ATCloud.aiCoach(JSON.parse(body));
  }

  // One request to the function. opts.transport replaces the network (tests, demos).
  async function call(task, payload, opts) {
    opts = opts || {};
    if (!opts.consented && !consent()) throw Object.assign(new Error("Agree to the AI assistant's terms first."), { code: "no_consent" });
    const body = JSON.stringify(Object.assign({ v: VERSION, task: task }, payload));
    const cut = function (b) { return task === "decide" ? b : b.slice(0, BODY_MAX); };
    record({ dir: "out", task: task, bytes: body.length, body: cut(body) });
    const res = await (opts.transport || defaultTransport)(body);
    record({ dir: "in", task: task, ok: !!(res && res.ok), error: res && res.error || null, provider: res && res.provider || null, usage: res && res.usage || null, body: cut(JSON.stringify(res)) });
    if (!res || !res.ok) throw Object.assign(new Error(res && res.message || "The AI service did not answer."), { code: res && res.error || "failed" });
    return res;
  }

  // The agent loop. Each step sends the question and the results so far; the model
  // either names more tools (they run here, on the device) or answers. At most
  // MAX_STEPS requests. ctx: { R, coach, commitments, nameOf, tickers, checkBuy, now,
  // intraday, events, held, useNames }. opts.names asks the service to accept real
  // stock names (the user's opt-in; refused unless the service allows it).
  // Returns { answer, answerRaw, unmatched, notMatched, proposals, actions, results, steps, usage }.
  const MAX_STEPS = 5;
  async function ask(question, ctx, opts) {
    opts = opts || {};
    const c2 = Object.assign({}, ctx, { useNames: !!opts.names });
    const s = T.session(c2), step = opts.onStep || function () {};
    const q = s.protect(question);
    if (q.length < 3) throw new Error("Ask a question first.");
    const results = [];
    let res = null, n = 0;
    for (n = 1; n <= MAX_STEPS; n++) {
      step(n === 1 ? "Deciding which of your results to look at..." : "Step " + n + ": looking further...");
      const body = { question: q, results: results, step: n };
      if (opts.names) body.names = true;
      res = await call("step", body, opts);
      if (res.kind !== "calls") break;
      res.calls.forEach(function (c) {
        record({ dir: "tool", tool: c.tool, args: c.args, step: n, tier: c.tool === "propose_rule" ? "T1 proposal (the user decides)" : "T0 read-only", note: "Ran on this device; the result is sent only with the next request." });
        results.push({ tool: c.tool, args: c.args, result: T.run(s, c2, c.tool, c.args) });
      });
    }
    if (!res || res.kind !== "answer") throw new Error("The assistant did not finish its answer.");
    const check = T.checkNumbers(res.answer, results);
    const rules = {};
    (ctx.coach ? ctx.coach.rules : []).forEach(function (r) { rules[r.id] = r; });
    const active = {};
    (ctx.commitments || []).forEach(function (x) { if (x.status === "active" && !x.kind) active[x.ruleId] = x; });
    // Proposals and actions become cards the user can act on; nothing is done here.
    const cards = [], notMatched = [];
    const adopt = (res.proposals || []).concat(results.filter(function (r) { return r.tool === "propose_rule" && r.result && r.result.proposal; }).map(function (r) { return r.result.id; }))
      .concat((res.actions || []).filter(function (a) { return a.type === "adopt_rule"; }).map(function (a) { return a.id; }));
    adopt.filter(function (id, i, a) { return a.indexOf(id) === i && rules[id] && rules[id].recommended && !active[id]; }).forEach(function (id) {
      cards.push({ type: "adopt_rule", id: id, title: rules[id].title, rule: rules[id].text, inShort: rules[id].do, verdict: rules[id].oos.verdict });
    });
    (res.actions || []).forEach(function (a) {
      if (a.type === "retire_rule" && active[a.id]) cards.push({ type: "retire_rule", id: a.id, commitmentId: active[a.id].id, title: rules[a.id] ? rules[a.id].title : a.id, rule: active[a.id].text });
      else if (a.type === "retune_rule" && rules[a.id]) {
        const w = B && B.whatIf(ctx.R, a.id, { th: a.limit, cap: a.cap }, rules[a.id].params);
        if (w) cards.push({ type: "retune_rule", id: a.id, given: { th: a.limit, cap: a.cap }, title: rules[a.id].title, rule: w.text, inShort: w.do,
          wholeHistory: w.all, laterHalf: w.laterHalf, replaces: active[a.id] ? active[a.id].id : null });
      } else if (a.type === "set_reminder") {
        // the model may name the stock by its real ticker or name even with names off: mapped back here, on the device (the card
        // goes nowhere); a stock not among the user's own is accepted when the user typed it in the question
        const k = String(a.stock || "").trim(), esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const t = s.ticker(a.stock) || T.session(Object.assign({}, c2, { useNames: true })).ticker(k) || (/^[A-Za-z][A-Za-z0-9.-]{0,9}$/.test(k) && !/^stock$/i.test(k) && new RegExp("(^|[^A-Za-z0-9])" + esc + "(?![A-Za-z0-9])", "i").test(question) ? k.toUpperCase() : null);
        if (t) cards.push({ type: "set_reminder", ticker: t, stockLabel: ctx.nameOf ? ctx.nameOf(t) || t : t, text: s.reveal(a.text) });
        else notMatched.push("a reminder for \"" + s.reveal(k) + "\"");
      } else if (a.type === "save_note") cards.push({ type: "save_note", text: s.reveal(a.text) });
    });
    record({ dir: "info", note: "Answer after " + Math.min(n, MAX_STEPS) + " step(s), " + results.length + " tool result(s), " + cards.length + " proposal(s) for you to decide." });
    // proposals the service left out (an unknown stock, bad fields, too many): logged with the reason, and a reminder is reported
    (res.dropped || []).forEach(function (d) {
      record({ dir: "info", note: "The service left out a proposed " + (d.type || "action") + (d.stock ? " for \"" + s.reveal(d.stock) + "\" (the model wrote \"" + d.stock + "\")" : "") + ": " + d.why + (d.keys && d.keys.length ? "; its fields: " + d.keys.join(", ") : "") + "." });
      if (d.type === "set_reminder") notMatched.push("a reminder" + (d.stock ? " for \"" + s.reveal(d.stock) + "\"" : "") + " (" + d.why + ")");
    });
    if (notMatched.length) record({ dir: "info", note: "Proposal(s) dropped, the stock matched none of yours: " + notMatched.join("; ") + "." });
    return { answer: s.reveal(res.answer), answerRaw: res.answer, unmatched: check.unmatched, notMatched: notMatched, results: results, steps: Math.min(n, MAX_STEPS), usage: res.usage, actions: cards,
      proposals: cards.filter(function (x) { return x.type === "adopt_rule"; }).map(function (x) { return { id: x.id, title: x.title, rule: x.rule, verdict: x.verdict }; }) };
  }

  // The AI agent of the paper portfolios: one request for up to 15 candidates built by
  // ATShadow.contextFor (aliases, ratios, "day N"; real tickers only with opts.names).
  // Each goes out under an id of this request only ("c1", "c2", ...): the stored ids are
  // hashes of the instrument and the date, which a dictionary of tickers and days reverses.
  // Returns the server-validated decisions [{ id, action, days, size, reason }] under the
  // candidates' own ids, plus the model and prompt version. Nothing is bought or sold.
  async function decide(candidates, opts) {
    opts = opts || {};
    if (!opts.consented && !consent()) throw Object.assign(new Error("Agree to the AI assistant's terms first."), { code: "no_consent" });
    const own = new Map(), out = candidates.map(function (c, i) { own.set("c" + (i + 1), c.id); return Object.assign({}, c, { id: "c" + (i + 1) }); });
    if (T.isPrivate(out)) throw Object.assign(new Error("A candidate looked like raw trade data, so nothing was sent."), { code: "private" });
    const body = { candidates: out };
    if (opts.names) body.names = true;
    // opts.engine ("text" | "decision") forces that route; used by the comparison of the two, never for the live record
    if (opts.engine === "text" || opts.engine === "decision") body.engine = opts.engine;
    record({ dir: "info", task: "decide", tier: "T0 read-only paper decision", note: "Paper decisions asked for " + candidates.length + " candidate(s)" + (opts.names ? " (real stock names)" : "") + (body.engine ? " from the " + body.engine + " model, for a comparison" : "") + ". Nothing is bought or sold." });
    const res = await call("decide", body, opts);
    return { decisions: (res.decisions || []).filter(function (d) { return d && own.has(d.id); }).map(function (d) { return Object.assign({}, d, { id: own.get(d.id) }); }),
      unsure: (res.unsure || []).filter(function (u) { return u && own.has(u.id); }).map(function (u) { return { id: own.get(u.id), reason: u.reason || "", trace: u.trace || null }; }),
      model: res.model || null, provider: res.provider || null, promptVersion: res.promptVersion || null, engine: res.engine || null, sizeUnit: res.sizeUnit || null, spend: res.spend || null, usage: res.usage };
  }

  const api = { consent: consent, termsAccepted: termsAccepted, acceptTerms: acceptTerms, grant: grant, revoke: revoke, log: log, clearLog: clearLog, exportLog: exportLog, call: call, ask: ask, decide: decide, record: record, VERSION: VERSION };
  if (typeof self !== "undefined") self.ATAI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
