(function () {
  // The assistant's tools: the ONLY things it can learn about the user's trading.
  // Pure functions over the report of ATDecisions.analyze, the coach of ATBiases
  // and the adopted rules, so they run (and are tested) without a browser.
  //
  // What a result may hold: counts, shares, returns against the market, sizes as a
  // multiple of the usual buy, dates by month, stocks as "Stock 1", "Stock 2".
  // What it never holds: amounts, quantities, prices, ISINs, tickers, names of
  // instruments or brokers, exact dates. Every result is built from an allowlist
  // and then passed through isPrivate(); one that fails is replaced by an error,
  // not sent. The server checks the same again.
  //
  // Tiers: every tool here is T0, read-only. propose_rule only returns a proposal;
  // the user adopts a rule with a click in the page (T1). Nothing here places an
  // order or writes anything.
  const B = typeof module !== "undefined" && module.exports ? require("./biases.js") : self.ATBiases;
  const pc = function (x) { return x == null ? "?" : Math.round(x * 100) + "%"; };
  const pts = function (x) { return x == null ? "?" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + " pts"; };
  const pct1 = function (x) { return x == null ? "?" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%"; };
  const r1 = function (x) { return x == null ? null : Math.round(x * 10) / 10; };
  const r3 = function (x) { return x == null ? null : Math.round(x * 1000) / 1000; };
  const DAY = 86400000;
  const month = function (ms) { return new Date(ms).toISOString().slice(0, 7); };

  // ---------- what must not leave ----------

  const FORBIDDEN_KEYS = /^(amount|amounts|isin|iban|qty|quantity|price|prices|broker|brokers|name|names|symbol|ticker|account|extid|currency|fee|fees|tax|email|password|token)$/i;
  const FORBIDDEN_TEXT = [/\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b/, /[\w.+-]+@[\w-]+\.[\w.-]+/, /\bhttps?:\/\//i, /\b\d{9,}\b/];
  // Same test as the server's looksPrivate (supabase/functions/ai-coach/core.mjs).
  function isPrivate(x, depth) {
    depth = depth || 0;
    if (depth > 8) return true;
    if (x == null || typeof x === "number" || typeof x === "boolean") return false;
    if (typeof x === "string") return FORBIDDEN_TEXT.some(function (r) { return r.test(x); });
    if (Array.isArray(x)) return x.some(function (v) { return isPrivate(v, depth + 1); });
    if (typeof x === "object") return Object.keys(x).some(function (k) { return FORBIDDEN_KEYS.test(k) || isPrivate(x[k], depth + 1); });
    return true;
  }

  // A note or a question with what should not leave taken out.
  function redact(s) {
    return String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim()
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/\bhttps?:\/\/[^\s,;)]+/gi, "[link]").replace(/\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b/g, "[id]").replace(/\d[\d.,' ]{3,}\d/g, "[number]");
  }

  // ---------- aliases ----------

  // One session: a stock is "Stock 1" the first time it is mentioned and stays so.
  // tickers: every ticker the user has, so a name typed in a question is covered too.
  // ctx.useNames (the user's opt-in, and only if the service allows it): stocks go out
  // by their ticker instead, so answers can name them; nothing else changes.
  function session(ctx) {
    const byTicker = {}, byAlias = {};
    let n = 0;
    const alias = function (t) {
      if (ctx.useNames) { byAlias[String(t).toUpperCase()] = t; return String(t); }
      if (!byTicker[t]) { byTicker[t] = "Stock " + (++n); byAlias[byTicker[t]] = t; }
      return byTicker[t];
    };
    const names = function (t) { return [t, ctx.nameOf ? ctx.nameOf(t) : null].filter(function (x) { return x && String(x).length >= 2; }); };
    return {
      alias: alias,
      ticker: function (a) {
        const k = String(a).replace(/\s+/g, " ").trim();
        if (byAlias[k] || byAlias[k.toUpperCase()]) return byAlias[k] || byAlias[k.toUpperCase()];
        // an alias in other case or with more words ("stock 4", "Stock 4 (the one I asked about)")
        const am = /\bstock (\d+)\b/i.exec(k);
        if (am && byAlias["Stock " + am[1]]) return byAlias["Stock " + am[1]];
        // names off: a real name is never resolved here, or a tool call could test which alias a guessed name is
        if (!ctx.useNames) return null;
        const all = ctx.tickers || [], up = k.toUpperCase();
        const exact = all.find(function (t) { return t.toUpperCase() === up || (ctx.nameOf && String(ctx.nameOf(t)).toUpperCase() === up); });
        if (exact) return exact;
        // a name given in part ("Cerebras" for "Cerebras Systems Inc."): the start of the name or of one of its words, a single match only
        if (up.length < 3) return null;
        const norm = function (x) { return " " + String(x).toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim(); }, want = norm(up);
        const hits = all.filter(function (t) { return ctx.nameOf && norm(ctx.nameOf(t)).indexOf(want) >= 0; });
        return hits.length === 1 ? hits[0] : null;
      },
      // The question as it may leave: known tickers and names replaced by aliases, long numbers removed.
      protect: function (q) {
        let s = redact(q);
        if (ctx.useNames) return s;
        (ctx.tickers || []).slice().sort(function (a, b) { return String(b).length - String(a).length; }).forEach(function (t) {
          names(t).forEach(function (nm) {
            const esc = String(nm).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (new RegExp("(^|[^A-Za-z0-9])" + esc + "(?![A-Za-z0-9])", "i").test(s)) s = s.replace(new RegExp("(^|[^A-Za-z0-9])" + esc + "(?![A-Za-z0-9])", "ig"), function (_, pre) { return pre + alias(t); });
          });
        });
        return s;
      },
      // Aliases in a reply turned back into the names the user knows (display only; this text never leaves).
      reveal: function (text) { return String(text).replace(/Stock (\d+)/g, function (m) { const t = byAlias[m]; return t ? (ctx.nameOf ? ctx.nameOf(t) : t) : m; }); }
    };
  }

  // ---------- the questions, as plain facts ----------

  const NAMES = { q1: "Research before trading", q2: "Calls vs actions", q3: "Researched vs unresearched buys", q4: "Attention spikes, FOMO and run-ups", q5: "Calls you passed on", q6: "Page types",
    q7: "Impulse and time of day", q8: "Size vs conviction", q9: "Portfolio vs attention", q10: "The market's mood", q11: "Selling at target", disposition: "Selling winners and losers", horizon: "Holding vs horizon" };

  function finding(R, id) {
    const f = [];
    let q = R[id], st = q && q.status, clear = !!(q && q.clear);
    if (id === "q1") {
      f.push(q.n ? "Research on the stock in the 30 days before: " + q.researched.k + " of " + q.n + " decisions (" + pc(q.researched.p) + ")." : "No decisions to judge yet.");
      if (q.leadDays != null) f.push("The median first look came " + r1(q.leadDays) + " days before the trade.");
      if (q.perm) f.push("Research " + (q.clear ? "does" : "does not clearly") + " cluster in the week before trades (p " + r3(q.perm.p) + ").");
    } else if (id === "q2") {
      f.push("Trades followed the latest call " + (q.n ? pc(q.agreement.p) + " of the time (" + q.agreement.k + " of " + q.n + ")" : "- no call-labelled decisions yet") + ".");
      if (q.posToBuy.n) f.push("Positive calls on stocks not held that led to a buy within 30 days: " + q.posToBuy.k + " of " + q.posToBuy.n + " (" + pc(q.posToBuy.p) + ").");
      if (q.negToSell.n) f.push("Negative calls on stocks held that led to a sale within 30 days: " + q.negToSell.k + " of " + q.negToSell.n + " (" + pc(q.negToSell.p) + ").");
      if (q.avoid.n) f.push("Of " + q.avoid.n + " Negative calls on stocks not held, " + q.avoid.lagged.k + " lagged the market over 3 months (average " + pct1(q.avoid.mean) + " against it).");
    } else if (id === "q3") {
      f.push("Next month against the NASDAQ: researched buys " + pct1(q.researched.mean) + " (" + q.researched.n + "), unresearched " + pct1(q.unresearched.mean) + " (" + q.unresearched.n + ")" + (q.diff ? ", a difference of " + pts(q.diff.est) + (q.clear ? ", clear." : ", not clear.") : "."));
    } else if (id === "q4") {
      if (q.spikeBuy.n) f.push("Buys that followed a spike in attention: " + q.spikeBuy.k + " of " + q.spikeBuy.n + " (" + pc(q.spikeBuy.p) + "); sales: " + q.spikeSell.k + " of " + q.spikeSell.n + ".");
      const r = q.runupPerf;
      if (r.rose.n || r.fell.n) f.push("Next month against the NASDAQ: buys after the price had risen since the first look " + pct1(r.rose.mean) + " (" + r.rose.n + "), after it had fallen " + pct1(r.fell.mean) + " (" + r.fell.n + ")" + (r.diff ? ", difference " + pts(r.diff.est) + (r.clear ? ", clear." : ", not clear.") : "."));
      const fo = q.fomo;
      if (fo.buyIfUp.n && fo.buyIfDown.n) f.push("Calls bought when the stock had risen after the call: " + fo.buyIfUp.k + " of " + fo.buyIfUp.n + " (" + pc(fo.buyIfUp.p) + "); when it had fallen: " + fo.buyIfDown.k + " of " + fo.buyIfDown.n + " (" + pc(fo.buyIfDown.p) + ")" + (fo.clear ? ", a clear difference." : "."));
      st = q.status;
    } else if (id === "q5") {
      f.push("Over 3 months against the NASDAQ: Positive calls passed on " + pct1(q.passed.mean) + " (" + q.passed.n + "), buys " + pct1(q.bought.mean) + " (" + q.bought.n + ")" + (q.diff ? ", buys minus passed " + pts(q.diff.est) + (q.clear ? ", clear." : ", not clear.") : "."));
      if (q.passed.n) f.push("Passed-on calls that beat the market: " + q.passed.hit.k + " of " + q.passed.n + "; buys: " + q.bought.hit.k + " of " + q.bought.n + ".");
    } else if (id === "q6") {
      const rows = (q.rows || []).filter(function (r) { return r.clear; });
      f.push(rows.length ? rows.map(function (r) { return "Buys researched with " + r.type + " pages did " + pts(r.diff.est) + " against buys without them (clear)."; }).join(" ") : "No page type stands out yet.");
    } else if (id === "q7") {
      f.push("Decisions within an hour of the first look: " + q.impulse.k + " of " + q.n + " (" + pc(q.impulse.p) + ").");
      if (q.returns.diff) f.push("Next month against the NASDAQ: impulse buys " + pct1(q.returns.impulse.mean) + " (" + q.returns.impulse.n + "), buys first looked at a week or more before " + pct1(q.returns.considered.mean) + " (" + q.returns.considered.n + "), difference " + pts(q.returns.diff.est) + (q.clear ? ", clear." : ", not clear."));
      const h = q.hours;
      if (h) h.blocks.filter(function (b) { return b.robust; }).forEach(function (b) { f.push("Buys in the " + b.label.split(" (")[0].toLowerCase() + " did " + pts(b.diff.est) + " against the others (clear, holds with the boundaries moved)."); });
    } else if (id === "q8") {
      f.push("Conviction vs position size (ranked): r = " + r3(q.sizeVsConviction.r) + (q.clear ? ", clear." : ", not clear.") + " " + q.n + " buys.");
    } else if (id === "q9") {
      if (q.returns) f.push("Since the first priced holding (" + r1(q.months) + " months): your holdings " + pct1(q.returns.portfolio) + ", recent-attention basket " + pct1(q.returns.attention) + ", all-attention basket " + pct1(q.returns.attentionAll) + ", NASDAQ " + pct1(q.returns.bench) + ".");
      else f.push("Not enough overlap yet.");
    } else if (id === "q10") {
      if (!q.n) f.push("Not enough buys with market data yet.");
      else {
        const t = q.regimes[2], c = q.regimes[0];
        f.push("Buys in calm / normal / turbulent markets: " + q.regimes.map(function (r) { return r.n; }).join(" / ") + "; those markets are " + q.regimes.map(function (r) { return pc(r.baseShare); }).join(" / ") + " of days.");
        if (t.median != null && c.median != null) f.push("Median buy against the usual buy: calm " + r1(c.median) + "x, turbulent " + r1(t.median) + "x" + (q.size.clear ? " (clear difference)." : " (not clear)."));
        const d = q.dip.ret;
        f.push("On buy days the NASDAQ's 20-day return sat at the " + Math.round(d.mean.est * 100) + "th percentile of all days (chance gives " + Math.round(d.mean.lo * 100) + " to " + Math.round(d.mean.hi * 100) + "): " + (d.verdict === "dip" ? "you buy weakness." : d.verdict === "chase" ? "you buy strength." : "no clear tilt."));
      }
    } else if (id === "q11") {
      f.push(q.n ? "Targets reached while held: " + q.n + "; sold within two weeks: " + q.sold.k + " (" + pc(q.sold.p) + ")." : "No target reached while held yet.");
    } else if (id === "disposition") {
      q = R.disposition; st = q.status; clear = false;
      f.push(q.pgr != null ? "On days with a sale you sold " + pc(q.pgr) + " of the holdings that were up and " + pc(q.plr) + " of those that were down." : "Not enough sales yet.");
    } else if (id === "horizon") {
      q = R.horizon; st = q.status;
      f.push(q.n ? q.n + " buys under a call with a horizon: " + q.early + " sold early, " + q.on + " around it, " + q.late + " held much longer, " + q.open + " still open." : "No buys under a call with a horizon yet.");
    } else return { error: "unknown question" };
    return { id: id, label: NAMES[id], status: st || "none", clear: clear, facts: f };
  }

  const VERDICT = { supported: "held up out of sample", indicative: "a hint out of sample", unclear: "not shown out of sample", unsupported: "did not hold up", untested: "too little data to test" };

  function ruleInfo(r) {
    const o = r.oos;
    return { id: r.id, title: r.title, verdict: o.verdict, verdictText: VERDICT[o.verdict], rule: r.recommended ? r.text : null,
      flaggedOutOfSample: o.flagged || 0, laterDecisions: o.testN || 0, gainPerFlaggedPts: o.mean == null ? null : r1(o.mean * 100), range99Pts: o.ci99 ? [r1(o.ci99.lo * 100), r1(o.ci99.hi * 100)] : null,
      inSampleGainPts: r.inSample ? r1(r.inSample.mean * 100) : null, decisions: r.n };
  }

  // ---------- the agents' saved decisions, in words ----------

  const KIND = { trade: "a buy you made", look: "a look at the stock", revisit: "a repeat view in a burst of views" };
  const ruleTitle = function (id) { const r = B.ruleById ? B.ruleById(id) : null; return r ? r.title : id; };
  // buy / wait / pass for a buy or a look, hold / sell / buy for a repeat view; size = the share of the amount that goes into the stock
  function actText(d) {
    if (!d) return null;
    const sz = Math.round((d.size == null ? 1 : d.size) * 100);
    if (d.action === "hold") return "do nothing (keeps its position as it is)";
    if (d.action === "sell") return "sell " + sz + "% of its position";
    if (d.action === "pass") return "pass (never buys; the money stays in cash)";
    const pw = Math.round((d.size == null ? 0 : d.size) * 1000) / 10;
    const into = d.sizeUnit === "weight" ? "up to a final weight of " + pw + "% of the portfolio" : sz + "% of the amount into the stock" + (sz < 100 ? ", the rest stays in cash" : "");
    return d.action === "wait" ? "wait " + d.days + (d.days === 1 ? " trading day" : " trading days") + ", then buy (" + into + ")" : "buy now (" + into + ")";
  }
  // "decision", "text" or "mock": which route made a saved decision (older records carry no `engine`)
  function engineOf(d) {
    if (!d) return null;
    if (d.engine) return d.engine;
    if (d.model === "mock") return "mock";
    if (typeof d.promptVersion === "string" && /^decisions-/.test(d.promptVersion)) return "decision";
    return d.model || d.promptVersion != null ? "text" : null;
  }
  function engineName(d) { const e = engineOf(d); return e === "decision" ? "decision model" : e === "text" ? "text model" : e === "mock" ? "stand-in model" : null; }
  // A model's own text names the stock by the alias of the request that made it ("Stock 17"); the assistant's session numbers stocks in its own order.
  function scrubStock(text, alias) { return text ? String(text).replace(/Stock \d+/g, alias) : text; }
  // What the AI agent was shown at that moment, cut to what helps to explain its choice (no alias, no date).
  function seenOf(x) {
    const o = {};
    ["runup30", "fromHigh52", "market", "research", "crowd", "earnings", "revisit", "yourRecordThen"].forEach(function (k) { if (x[k] != null) o[k] = x[k]; });
    if (x.calls && x.calls.length) o.calls = x.calls.map(function (c) { return { sentiment: c.sentiment, daysBefore: c.daysBefore, targetVsPricePct: c.targetVsPricePct == null ? null : c.targetVsPricePct, horizonDays: c.horizonDays || null }; });
    if (x.rulesAgent) o.rulesAgentThen = { action: x.rulesAgent.action, size: x.rulesAgent.size, rules: (x.rulesAgent.rules || []).map(function (r) { return { id: r.id, reading: r.now, instruction: r.do }; }) };
    if (x.rulesThen) o.rulesThatHeldUpForYou = x.rulesThen.length;
    return o;
  }

  // ---------- the tools ----------

  const TOOLS = {
    get_overview: function (c) {
      const R = c.R, cv = R.coverage, qs = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10", "q11"].map(function (id) { const q = R[id]; return { id: id, label: NAMES[id], status: q.status || "none", clear: !!q.clear }; });
      const ok = qs.filter(function (q) { return q.status !== "none"; }), clear = qs.filter(function (q) { return q.clear; });
      return { decisionsAnalysed: cv.decisions.analyzable, decisionsInTotal: cv.decisions.all, buys: cv.buys, sells: cv.sells, monthsCovered: r1(cv.monthsCovered), decisionsPerMonth: r1(cv.perMonth), questions: qs,
        facts: ["Stocktrails analysed " + cv.decisions.analyzable + " of " + cv.decisions.all + " decisions (" + cv.buys + " buys, " + cv.sells + " sales) over about " + r1(cv.monthsCovered) + " months.",
          "Questions with enough data: " + (ok.map(function (q) { return q.id; }).join(", ") || "none") + ". Clear results: " + (clear.map(function (q) { return q.id; }).join(", ") || "none") + "."] };
    },
    get_finding: function (c, a) { return finding(c.R, a.id); },
    get_biases: function (c) {
      const bs = c.coach.biases.map(function (b) {
        return { id: b.id, label: b.name, tier: b.tier, status: b.status, clear: b.clear, signals: b.signals.map(function (s) { return s.text; }), rules: b.rules.filter(function (r) { return r.recommended || b.tier === "detected"; }).map(ruleInfo) };
      });
      return { biases: bs, facts: bs.length ? bs.map(function (b) {
        const best = b.rules.filter(function (r) { return r.verdict === "supported" || r.verdict === "indicative"; })[0];
        return b.label + " (" + b.tier + ", " + b.status + (b.clear ? ", clear" : "") + ")" + (best ? ": rule \"" + best.title + "\" " + best.verdictText + (best.gainPerFlaggedPts != null ? ", worth " + best.gainPerFlaggedPts + " pts per flagged decision out of sample" : "") + "." : ".");
      }) : ["No bias is clear in the data yet."] };
    },
    get_rule: function (c, a) {
      const r = c.coach.rules.find(function (x) { return x.id === a.id; });
      if (!r) return { error: "unknown rule" };
      const i = ruleInfo(r);
      i.facts = [r.recommended ? "Rule: " + r.text : "No setting of this rule helped on the history.", "Out of sample: " + i.verdictText + (i.gainPerFlaggedPts != null ? ", " + i.gainPerFlaggedPts + " pts per flagged decision (99% range " + i.range99Pts[0] + " to " + i.range99Pts[1] + ")." : ".")];
      return i;
    },
    simulate_rule: function (c, a) {
      const r = c.coach.rules.find(function (x) { return x.id === a.id; });
      if (!r || !r.recommended) return { id: a.id, error: "no setting of this rule helped on the history" };
      const s = B.simulate(c.R, a.id, r.params, {});
      return { id: a.id, inSample: true, decisions: s.n, flagged: s.flagged, flaggedNextMonthPct: s.flaggedMean == null ? null : r1(s.flaggedMean * 100), keptNextMonthPct: s.keptMean == null ? null : r1(s.keptMean * 100),
        facts: ["In the whole history (the setting was chosen on it, so this flatters the rule) the rule would have flagged " + s.flagged + " of " + s.n + " decisions; those did " + pct1(s.flaggedMean) + " next month against the NASDAQ, the others " + pct1(s.keptMean) + "."] };
    },
    list_decisions: function (c, a, s) {
      const R = c.R, hourBand = function (h) { return h >= 22 || h < 6 ? "night" : h < 11 ? "morning" : h < 15 ? "midday" : h < 18 ? "afternoon" : "evening"; };
      let list = R.decisions.filter(function (d) { return !d.excluded && (!a.side || d.side === a.side); });
      const which = a.which || "all";
      const keep = { all: function () { return true; }, researched: function (d) { return d.researched; }, unresearched: function (d) { return !d.researched; },
        impulse: function (d) { return !d.dateOnly && d.firstAtt != null && d.cut - d.firstAtt <= 3600000; }, after_rise: function (d) { return d.runup != null && d.runup > 0.1; },
        evening: function (d) { return !d.dateOnly && hourBand(new Date(d.ts).getHours()) === "evening"; }, turbulent_market: function (d) { return d.mkt && d.mkt.pVol > 2 / 3; },
        largest: function (d) { return d.relSize != null; }, worst: function (d) { return d.fwd && d.fwd[21]; } }[which] || function () { return true; };
      list = list.filter(keep);
      if (which === "largest") list.sort(function (x, y) { return y.relSize - x.relSize; });
      else if (which === "worst") list.sort(function (x, y) { return x.fwd[21].ex - y.fwd[21].ex; });
      else list.sort(function (x, y) { return y.ts - x.ts; });
      const rows = list.slice(0, a.limit || 8).map(function (d) {
        return { stock: d.ticker ? s.alias(d.ticker) : "an untracked stock", side: d.side, month: month(d.ts), sizeVsUsualBuy: r1(d.relSize), researched: !!d.researched, viewsInThe30DaysBefore: d.views30,
          riseSinceFirstLook: r3(d.runup), timeOfDay: d.dateOnly ? null : hourBand(new Date(d.ts).getHours()), market: d.mkt ? (d.mkt.pVol < 1 / 3 ? "calm" : d.mkt.pVol < 2 / 3 ? "normal" : "turbulent") : null,
          nextMonthAgainstNasdaq: d.fwd && d.fwd[21] ? r3(d.fwd[21].ex) : null };
      });
      return { matching: list.length, shown: rows.length, decisions: rows, facts: [list.length + " analysed decisions match (" + which + (a.side ? ", " + a.side + "s" : "") + "); " + rows.length + " are listed."] };
    },
    get_adherence: function (c) {
      const now = c.now || Date.now(), act = (c.commitments || []).filter(function (x) { return x.status === "active"; });
      const rows = act.map(function (x) {
        const A = B.adherence(x, c.R, now);
        return { id: x.ruleId, rule: x.text, adoptedMonth: month(x.adoptedAt), decisionsSince: A ? A.n : 0, broken: A && A.n ? A.broken.k : 0, brokenShare: A && A.n ? r3(A.broken.p) : null,
          brokenBeforeShare: A && A.before.n ? r3(A.before.broken.p) : null, keptNextMonthPct: A && A.kept.n ? r1(A.kept.mean * 100) : null, brokeNextMonthPct: A && A.broke.n ? r1(A.broke.mean * 100) : null };
      });
      return { rules: rows, facts: rows.length ? rows.map(function (r) { return "Rule \"" + r.rule + "\" adopted " + r.adoptedMonth + ": " + r.decisionsSince + " decisions since, " + r.broken + " broke it."; }) : ["No rule has been adopted yet."] };
    },
    check_buy: function (c, a, s) {
      const t = s.ticker(a.stock);
      if (!t) return { error: "unknown stock: use the alias from an earlier result" };
      if (!c.checkBuy) return { error: "not available here" };
      return c.checkBuy(t, a.size == null ? null : a.size);
    },
    propose_rule: function (c, a) {
      const r = c.coach.rules.find(function (x) { return x.id === a.id; });
      if (!r || !r.recommended) return { id: a.id, error: "no setting of this rule helped on the history" };
      return { proposal: { id: r.id, title: r.title, rule: r.text, verdict: r.oos.verdict }, id: r.id, facts: ["Proposed for the user to decide: " + r.text + " (" + VERDICT[r.oos.verdict] + ")."] };
    },
    // Are you leaving your biases behind? Each habit in the last N days against all earlier
    // decisions, with a verdict (ATBiases.progress), and the plain counts of the period.
    compare_periods: function (c, a) {
      const days = a.days || 180, end = Math.min(c.now || Date.now(), (c.R.coverage.fileEnd || c.now || Date.now()) + DAY);
      const P = B.progress(c.R, c.coach, { days: days, end: end, commitments: c.commitments || [] }), A = periodStats(c, end - days * DAY, end);
      const ip = function (x) { return x == null ? null : Math.round(x * 100); };
      const habits = P.habits.map(function (h) {
        return { habit: h.habit, verdict: h.verdict, earlierPct: ip(h.earlier.p), earlierN: h.earlier.n, recentPct: ip(h.recent.p), recentN: h.recent.n,
          marketEarlierPct: ip(h.earlier.base), marketRecentPct: ip(h.recent.base), changePts: h.change ? r1(h.change.est * 100) : null,
          range99Pts: h.change ? [r1(h.change.lo * 100), r1(h.change.hi * 100)] : null, trendPtsPerYear: h.trend ? r1(h.trend.perYear * 100) : null, trendClear: h.trend ? h.trend.clear : null };
      });
      const facts = ["Your habits in the last " + days + " days against all your earlier decisions (99% ranges; \"fading\" means the change is clearly below zero): " + P.fading + " fading, " + P.growing + " getting stronger."];
      habits.forEach(function (h) {
        if (h.verdict === "too_few") return;
        facts.push(h.habit.charAt(0).toUpperCase() + h.habit.slice(1) + ": " + h.earlierPct + "% before (" + h.earlierN + "), " + h.recentPct + "% recently (" + h.recentN + ")" + (h.marketRecentPct != null ? ", against " + h.marketEarlierPct + "% and " + h.marketRecentPct + "% of trading days" : "") +
          ": " + { fading: "fading", growing: "getting stronger", no_clear_change: "no clear change" }[h.verdict] + (h.changePts != null ? " (change " + h.changePts + " pts, 99% range " + h.range99Pts[0] + " to " + h.range99Pts[1] + ")" : "") + ".");
      });
      facts.push("In the last " + days + " days: " + A.buys + " buys" + (A.buys ? ", " + pc(A.researchedShare) + " researched" : "") + (A.nextMonth != null ? ", next month against the NASDAQ " + pct1(A.nextMonth) + " on average (" + A.withResult + " with a result)" : "") + ".");
      return { days: days, habits: habits, period: A, facts: facts };
    },
    what_if: function (c, a) {
      const r = c.coach.rules.find(function (x) { return x.id === a.id; });
      const w = B.whatIf(c.R, a.id, { th: a.limit, cap: a.cap }, r && r.params);
      if (!w) return { id: a.id, error: "this rule has no setting to change, or the setting is missing" };
      const j = function (x) { return x.flagged + " of " + x.n + " decisions" + (x.mean != null ? ", worth " + pts(x.mean) + " each" + (x.ci95 ? " (95% range " + pts(x.ci95.lo) + " to " + pts(x.ci95.hi) + ")" : "") : ""); };
      return { id: a.id, rule: w.text, inShort: w.do, wholeHistory: { flagged: w.all.flagged, decisions: w.all.n, gainPts: w.all.mean == null ? null : r1(w.all.mean * 100) },
        laterHalf: { flagged: w.laterHalf.flagged, decisions: w.laterHalf.n, gainPts: w.laterHalf.mean == null ? null : r1(w.laterHalf.mean * 100) },
        current: r && r.recommended ? { rule: r.text, gainPtsOutOfSample: r.oos.mean == null ? null : r1(r.oos.mean * 100) } : null,
        facts: ["With this setting (\"" + w.text + "\"): over your whole history it would have flagged " + j(w.all) + "; over the later half alone " + j(w.laterHalf) + ". Gains are against the NASDAQ, assuming a skipped buy earns the market.",
          r && r.recommended ? "The fitted setting is: " + r.text : "No fitted setting exists for this rule yet."] };
    },
    explain_decision: function (c, a, s) {
      const t = s.ticker(a.stock);
      if (!t) return { error: "unknown stock: use the name from an earlier result" };
      let ds = c.R.decisions.filter(function (d) { return d.ticker === t && !d.excluded && (!a.side || d.side === a.side) && (!a.month || month(d.ts) === a.month); });
      if (!ds.length) return { error: "no analysed decision of that stock" + (a.month ? " in " + a.month : "") };
      const d = ds.sort(function (x, y) { return y.ts - x.ts; })[0], hb = d.dateOnly ? null : hourBand(new Date(d.ts).getHours());
      const flags = [];
      c.coach.rules.filter(function (r) { return r.recommended; }).forEach(function (r) {
        const rule = B.ruleById(r.id), u = rule.universe(c.R, true).filter(function (x) { return x.id === d.inst + "|" + d.date; })[0];
        if (u && rule.applies(u) && rule.flag(u, r.params)) flags.push(r.title);
      });
      const out = { stock: s.alias(t), side: d.side, month: month(d.ts), sizeVsUsualBuy: r1(d.relSize), viewsInThe30DaysBefore: d.views30, minutesInThe30DaysBefore: r1(d.dwell30),
        firstLookDaysBefore: d.firstAtt != null ? r1((d.cut - d.firstAtt) / DAY) : null, riseInThe30DaysBefore: r3(d.runup30), callBefore: d.label, timeOfDay: hb,
        market: d.mkt ? (d.mkt.pVol < 1 / 3 ? "calm" : d.mkt.pVol < 2 / 3 ? "normal" : "turbulent") : null, nextMonthAgainstNasdaq: d.fwd && d.fwd[21] ? r3(d.fwd[21].ex) : null, rulesThatFlagIt: flags };
      out.facts = [s.alias(t) + ", " + d.side + " in " + out.month + ": " + (d.views30 || 0) + " views in the 30 days before" + (out.firstLookDaysBefore != null ? ", first look " + out.firstLookDaysBefore + " days before" : ", no recorded first look") +
        (out.riseInThe30DaysBefore != null ? ", the stock had moved " + pct1(out.riseInThe30DaysBefore) + " in the 30 days before" : "") + (out.sizeVsUsualBuy != null ? ", " + out.sizeVsUsualBuy + "x your usual buy" : "") +
        (out.market ? ", in a " + out.market + " market" : "") + (hb ? ", in the " + hb : "") + "." + (out.nextMonthAgainstNasdaq != null ? " Next month against the NASDAQ: " + pct1(out.nextMonthAgainstNasdaq) + "." : "") +
        (flags.length ? " Rules that flag it: " + flags.join(", ") + "." : " None of the recommended rules flags it.")];
      return out;
    },
    stock_summary: function (c, a, s) {
      const t = s.ticker(a.stock);
      if (!t) return { error: "unknown stock: use the name from an earlier result" };
      const views = {};
      (c.intraday || []).forEach(function (e) { if (e.ticker === t) views[month(e.ts)] = (views[month(e.ts)] || 0) + 1; });
      const calls = (c.events || []).filter(function (e) { return e.ticker === t && e.sentiment; }).sort(function (x, y) { return x.ts - y.ts; });
      const decs = c.R.decisions.filter(function (d) { return d.ticker === t && !d.excluded; }).map(function (d) { return { side: d.side, month: month(d.ts), sizeVsUsualBuy: r1(d.relSize), nextMonthAgainstNasdaq: d.fwd && d.fwd[21] ? r3(d.fwd[21].ex) : null }; });
      const months = Object.keys(views).sort().slice(-12);
      const nv = Object.keys(views).reduce(function (x, k) { return x + views[k]; }, 0);
      return { stock: s.alias(t), heldNow: (c.held || []).indexOf(t) >= 0, viewsByMonth: months.map(function (m) { return { month: m, views: views[m] }; }),
        calls: calls.map(function (e) { return { month: month(e.ts), call: e.sentiment }; }).slice(-10), decisions: decs.slice(-10),
        facts: [s.alias(t) + ": " + nv + " recorded views" + (months.length ? " (most recent month " + months[months.length - 1] + ")" : "") + ", " + calls.length + " calls" + (calls.length ? " (latest " + calls[calls.length - 1].sentiment + " in " + month(calls[calls.length - 1].ts) + ")" : "") +
          ", " + decs.length + " analysed decisions; " + ((c.held || []).indexOf(t) >= 0 ? "held now." : "not held now.")] };
    },
    get_weekly_review: function (c, a, s) {
      const days = a.days || 7, to = c.now || Date.now();
      const rv = weeklyReview(c, to - days * DAY, to, s.alias);
      delete rv.from; delete rv.to;
      return rv;
    },
    // What the two agents decided on single moments and why (the saved record of dashboard/shadow.js).
    // c.agentDecisions() -> { store: saved decisions, checks: saved pre-trade checks, skipped: fn(ticker) -> why a
    // stock has no AI decision | null }. Stocks as aliases, months and "days ago" instead of dates, no amounts.
    get_agent_decisions: function (c, a, s) {
      const src = typeof c.agentDecisions === "function" ? c.agentDecisions() : c.agentDecisions;
      if (!src) return { error: "the agents' saved decisions are not available here" };
      let tk = null;
      if (a.stock) { tk = s.ticker(a.stock); if (!tk) return { error: "unknown stock: use the alias or name from an earlier result" }; }
      const now = c.now || Date.now(), limit = a.limit || 5, by = {};
      (src.store || []).forEach(function (d) {
        if (!d || !d.id || (tk && d.ticker !== tk)) return;
        const m = by[d.id] = by[d.id] || { id: d.id, kind: d.kind, ticker: d.ticker, t: d.t };
        if (d.action === "unsure") return; // an answer that decided nothing
        if (d.agent === "rules" || d.agent === "ai") m[d.agent] = d;
      });
      const moments = Object.keys(by).map(function (k) { return by[k]; }).sort(function (x, y) { return y.t - x.t; });
      const own = function (d) { return d.ticker ? s.alias(d.ticker) : "an untracked stock"; };
      const rows = moments.slice(0, limit).map(function (m, i) {
        const alias = own(m), r = m.rules, ai = m.ai;
        const row = { stock: alias, moment: KIND[m.kind] || m.kind, month: month(m.t), daysAgo: Math.max(0, Math.floor((now - m.t) / DAY)) };
        if (m.kind === "trade") row.you = "bought it";
        if (r) row.rulesAgent = { decision: actText(r), why: scrubStock(r.reason, alias), rulesInvolved: (r.rules || []).map(ruleTitle),
          readings: (r.why || []).map(function (w) { return { rule: w.title, reading: scrubStock(w.reading, alias), instruction: w.do }; }), activeRulesThatMonth: r.active ? r.active.length : null };
        if (ai) {
          row.aiAgent = { decision: actText(ai), why: scrubStock(ai.reason, alias), reasoning: ai.reasoning ? scrubStock(ai.reasoning, alias) : null, decidedBy: engineName(ai), model: ai.model || null, promptVersion: ai.promptVersion == null ? null : ai.promptVersion,
            madeLive: ai.decidedAt != null ? ai.decidedAt - ai.t <= 2 * DAY : null, followedRulesAgentBecauseUnsure: ai.deferred === true };
          if (ai.trace) row.aiAgent.decisionModelOdds = { buy: ai.trace.odds.buy, wait: ai.trace.odds.wait, pass: ai.trace.odds.pass, confidence: ai.trace.confidence, neededForItsOwnChoice: ai.trace.minP };
          if (i < 3 && ai.input) row.aiAgent.sawAtThatMoment = seenOf(ai.input);
        }
        return row;
      });
      const checks = (src.checks || []).filter(function (k) { return k && (!tk || k.ticker === tk); }).sort(function (x, y) { return y.ts - x.ts; }).slice(0, 3).map(function (k) {
        const alias = own(k), ra = k.rulesAgent, ai = k.ai && k.ai.decision;
        return { stock: alias, moment: "a pre-trade check you ran", month: month(k.ts), daysAgo: Math.max(0, Math.floor((now - k.ts) / DAY)), sizeVsUsualBuy: k.measured && k.measured.relSize != null ? r1(k.measured.relSize) : null,
          rulesAgent: ra ? { decision: actText({ action: ra.action, days: ra.days || 0, size: ra.size == null ? 1 : ra.size }), rulesInvolved: (ra.rules || []).map(ruleTitle) } : null,
          aiAgent: ai ? { decision: actText(ai), why: scrubStock(ai.reason, alias), decidedBy: engineName(k.ai), model: k.ai.model || null }
            : k.ai && k.ai.unsure ? { decision: "no decision: the decision model was not sure enough", why: null, decidedBy: engineName(k.ai), model: k.ai.model || null, decisionModelOdds: k.ai.unsure.trace && k.ai.unsure.trace.odds ? k.ai.unsure.trace.odds : null } : null };
      });
      const facts = [];
      rows.concat(checks).forEach(function (x) {
        const bits = [x.stock + ", " + x.moment + ", " + x.month + " (" + x.daysAgo + (x.daysAgo === 1 ? " day" : " days") + " ago)" + (x.sizeVsUsualBuy != null ? ", " + x.sizeVsUsualBuy + "x your usual buy" : "") + ":"];
        if (x.rulesAgent) bits.push("rules agent: " + x.rulesAgent.decision + (x.rulesAgent.why ? " (" + x.rulesAgent.why + ")" : "") + ".");
        if (x.aiAgent) bits.push("AI agent (" + (x.aiAgent.decidedBy || "model unknown") + "): " + x.aiAgent.decision + (x.aiAgent.why ? " - " + x.aiAgent.why : "") + (x.aiAgent.followedRulesAgentBecauseUnsure ? " (it was unsure, so it followed the rules agent)" : "") + ".");
        facts.push(bits.join(" "));
      });
      if (!rows.length && !checks.length) {
        const why = tk && typeof src.skipped === "function" ? src.skipped(tk) : null;
        facts.push(tk ? (own({ ticker: tk }) + " has no saved decision of either agent." + (why ? " Why: " + String(why).replace(/\d{4}-\d{2}-\d{2}/g, function (d) { return d.slice(0, 7); }) + "." : "")) : "No decision of either agent is saved yet.");
      }
      facts.push("The agents decide three kinds of moments: your buys, a first look at a stock (or a return after 30 days without a view) and, from 16 October on, a repeat view in an unusual burst of views. The AI agent decides only moments at most 2 days old.");
      facts.push("Reading the actions: buy = put money in at once; wait N trading days = buy after N days; pass = never buy this one, the money stays in cash (the answer to a buy or a first look); do nothing (hold) = the answer to a repeat view when it leaves its position as it is, neither adding nor selling. So pass means the stock is not bought at all, while do nothing means keep things as they are.");
      facts.push("Size = for the AI agent the final weight the stock has in the portfolio after the buy (1% to 20%; the rest of the portfolio stays as it is); for the rules agent, and for decisions saved before weights, the share of your buy that goes into the stock. The rules agent applies the rules that held up for you; it buys unless one objects. The decision model writes no reasoning, only odds, and when its best choice is below its threshold it decides nothing and the moment is asked again later; a text model writes a reason.");
      return { stock: tk ? s.alias(tk) : null, moments: rows, checks: checks, facts: facts };
    },
    // The agents' paper portfolios (src/shadow.js): ratios only. c.shadow is the result of
    // ATShadow.run, or a function that returns it (worked out only when asked).
    get_agent_portfolio: function (c, a, s) {
      const S = typeof c.shadow === "function" ? c.shadow() : c.shadow;
      if (!S || !S.trades) return { error: "the paper portfolios are not available here" };
      const view = a.view || "trades", rng = function (x) { return x && x.lo != null ? [r1(x.lo * 100), r1(x.hi * 100)] : null; };
      const ptsOf = function (x) { return x == null ? null : r1(x * 100); };
      const rec = S.record || null, facts = [];
      const latest = function (sec) {
        const rules = {}, ai = {};
        (sec.rules || []).forEach(function (d) { rules[d.id] = d; });
        (sec.ai || []).forEach(function (d) { ai[d.id] = d; });
        const act = function (d) { return d ? d.action + (d.action === "wait" ? " " + d.days + " days" : "") + (d.action !== "pass" && d.size < 1 ? ", size " + d.size : "") : null; };
        return (sec.candidates || []).slice().sort(function (x, y) { return y.t - x.t; }).slice(0, 8).map(function (k) {
          return { stock: k.ticker ? s.alias(k.ticker) : "an untracked stock", month: month(k.t), rulesAgent: act(rules[k.id]), aiAgent: act(ai[k.id]), you: view === "looks" ? (k.bought ? "bought within 30 days" : "did not buy") : "bought" };
        });
      };
      const sgn = function (x) { return (x >= 0 ? "+" : "") + x; }, rtxt = function (r) { return r ? " (99% range " + r[0] + " to " + r[1] + ")" : ""; };
      const out = { view: view, record: rec, latest: [] };
      if (view === "looks") {
        const L = S.looks;
        out.looks = L.candidates.length;
        out.aiCoverageShare = L.coverage == null ? null : r3(L.coverage);
        out.horizons = [21, 63, 126].map(function (h) {
          const H = L.horizons[h], lines = {};
          ["every", "rules", "ai", "bought"].forEach(function (k) {
            const x = H[k];
            if (x && x.n) lines[k] = { positions: x.n, meanExcessPts: ptsOf(x.mean), range99Pts: rng(x), beatNasdaqShare: x.hit == null ? null : r3(x.hit) };
          });
          return { horizonDays: h, lines: lines };
        });
        out.latest = latest(L);
        facts.push(out.looks + " looks (a first look at a stock, or a return after 30 days) held as paper positions; mean excess against the NASDAQ per position:");
        out.horizons.forEach(function (h) {
          const l = h.lines, f = function (k, label) { return l[k] ? label + " " + sgn(l[k].meanExcessPts) + " pts (" + l[k].positions + ")" + rtxt(l[k].range99Pts) : null; };
          const parts = [f("every", "buy every look"), f("rules", "rules agent"), f("ai", "AI agent"), f("bought", "what you bought within 30 days")].filter(Boolean);
          if (parts.length) facts.push(h.horizonDays + " trading days: " + parts.join(", ") + ".");
        });
      } else {
        const T = S.trades, P = T.portfolio, n = P ? P.dates.length : 0;
        const last = function (k) { return n && P[k] && P[k][n - 1] != null ? r1(P[k][n - 1] * 100) : null; };
        out.buys = T.candidates.length;
        out.valuePctOfMoneyIn = { you: last("you"), rulesAgent: last("rules"), aiAgent: last("ai"), nasdaq: last("nasdaq"), aiCoverageShare: T.coverage == null ? null : r3(T.coverage) };
        out.paired = [21, 63, 126].map(function (h) {
          const p = T.paired[h], o = { horizonDays: h, buys: p.n, youPts: ptsOf(p.you) };
          if (p.rules.n) { o.rulesAgentPts = ptsOf(p.rules.mean); o.rulesMinusYouPts = ptsOf(p.rules.diff.est); o.rulesRange99Pts = rng(p.rules.diff); }
          if (p.ai && p.ai.n) { o.aiDecided = p.ai.n; o.aiMinusYouPts = ptsOf(p.ai.diff.est); o.aiRange99Pts = rng(p.ai.diff); }
          return o;
        });
        const ba = T.beforeAfter;
        if (T.appStart != null) {
          const x = ba.horizons[63], est = function (v) { return v ? ptsOf(v.est) : null; };
          const per = function (s) { return { buys: s.n, youPts: ptsOf(s.you), rulesAgentPts: ptsOf(s.agent), gapPts: est(s.gap), gapRange99Pts: rng(s.gap) }; };
          out.beforeAfterAppStart = { startMonth: month(T.appStart), enough: ba.enough, horizonDays: 63, before: per(x.before), after: per(x.after), gapChangePts: est(x.change), gapChangeRange99Pts: rng(x.change),
            habits: (ba.habits || []).map(function (h) { return { habit: h.habit, beforeShare: h.before.p == null ? null : r3(h.before.p), beforeN: h.before.n, afterShare: h.after.p == null ? null : r3(h.after.p), afterN: h.after.n }; }) };
        }
        out.latest = latest(T);
        if (n) facts.push("Paper portfolios on your " + out.buys + " buys, as a share of the money put in: you " + out.valuePctOfMoneyIn.you + "%, rules agent " + out.valuePctOfMoneyIn.rulesAgent + "%" +
          (out.valuePctOfMoneyIn.aiAgent != null ? ", AI agent " + out.valuePctOfMoneyIn.aiAgent + "%" : "") + ", NASDAQ " + out.valuePctOfMoneyIn.nasdaq + "% (no currency conversion).");
        out.paired.forEach(function (p) {
          if (p.rulesMinusYouPts != null) facts.push("Per buy over " + p.horizonDays + " trading days against the NASDAQ: rules agent minus you " + sgn(p.rulesMinusYouPts) + " pts" + rtxt(p.rulesRange99Pts) + ", " + p.buys + " buys.");
          if (p.aiMinusYouPts != null) facts.push("AI agent minus you over " + p.horizonDays + " trading days: " + sgn(p.aiMinusYouPts) + " pts" + rtxt(p.aiRange99Pts) + ", " + p.aiDecided + " buys it decided.");
        });
        const b = out.beforeAfterAppStart;
        if (b && b.enough) facts.push("Gap over 63 trading days (rules agent minus you) before the bias features launched: " + b.before.gapPts + " pts (" + b.before.buys + " buys); after: " + b.after.gapPts + " pts (" + b.after.buys + " buys)" +
          (b.gapChangePts != null ? "; change " + b.gapChangePts + " pts" + rtxt(b.gapChangeRange99Pts) : "") + ". An association, not proof: one investor, different markets.");
        else if (b) facts.push("Not enough buys before and after the bias features launched to compare them.");
      }
      if (rec) facts.push("Saved decisions: rules agent " + rec.rules.live + " live and " + rec.rules.afterTheFact + " after the fact; AI agent " + rec.ai.live + " live and " + rec.ai.afterTheFact + " after the fact (the model may know what happened next for those).");
      facts.push("Paper portfolios: the agents act only on your own buys and the stocks you looked at, place no orders, and this is not investment advice.");
      out.facts = facts;
      return out;
    },
    // The page explained to the user: what each section of My Habits > Trades & research > AI agent shows and how it is
    // calculated. Static text (it mirrors dashboard/shadow.js and src/shadow.js; change them together), no data of the user.
    explain_section: function (c, a) {
      const sec = SECTIONS[a.section];
      if (!sec) return { error: "unknown section" };
      return { section: a.section, title: sec.title, where: sec.where, facts: sec.facts.slice() };
    }
  };

  // The sections of the AI agent area, in the app's own words. LOOK_WINDOW 30 days and LOOK_LAG 1 day mirror ATShadow.
  const SECTIONS = {
    overview: { title: "AI agent", where: "My Habits > Trades & research, the AI agent area",
      facts: ["Two agents run a paper portfolio next to you on the same moments: your buys, your first looks at a stock (or a return after 30 days without a view) and, from 16 October 2026, a repeat view in an unusual burst of views.",
        "The rules agent has no model in it; the AI agent is a language model (or the decision model) asked through the assistant's service. Neither places an order, and none of this is investment advice.",
        "Every decision is saved once, when first made, on this device. The area has four parts: Latest decisions, Paper portfolios (the lines), Holdings over time and What your own words say."] },
    rules_agent: { title: "Rules agent", where: "AI agent area, the Rules agent column",
      facts: ["It applies the coach's rules as they stood at each moment. Each month it keeps the rules that, fitted on your earlier trades only, held up on later ones, plus the rules you adopted (with your setting, over the whole history).",
        "For each buy it buys at once, waits until no rule objects (up to 10 trading days) or passes; a cap rule only cuts the size. With no rule objecting it simply buys, so most rows read buy.",
        "It uses only data from before each day (tested), so its decisions are fair even when worked out later, and its line can start anywhere. It is a yardstick for your own habits, not a stock picker."] },
    ai_agent: { title: "AI agent", where: "AI agent area, the AI agent column",
      facts: ["A model decides for each buy and first look: buy now, wait 1 to 10 trading days and then buy, or pass, with a final weight (1% to 20% of the portfolio). For a repeat view in a burst: do nothing, sell a share of the position (not on the day the position was opened or added to), or buy more.",
        "It sees only what was known at that moment, worked out on this device: the stock as Stock N and the date as day N (real tickers and dates only with the names option), the price path before in percent, the market, your research and calls, the rules that held up for you and what the rules agent said. No amount, ISIN, broker or account is sent.",
        "It decides only moments at most 2 days old, so a model cannot know what happened next; for everything older it follows you in the portfolio. Each request asks about up to 15 decisions and counts against the assistant's daily requests.",
        "When it is not sure enough about a moment it decides nothing; that is saved and the moment is asked again when more is known."] },
    latest_decisions: { title: "Latest decisions", where: "AI agent area, the first table",
      facts: ["Each row is a moment: a buy you made, a first look, or a repeat view in a burst, newest first, with what the rules agent decided, what the AI agent decided and what you did.",
        "It lists every moment with an AI decision and the 10 latest others. The button All decisions side by side lists every moment next to what you did and the attention index.",
        "Reading the actions: buy = put money in at once; wait N days = buy after N trading days; pass = the stock is not bought at all; do nothing = the answer to a repeat view, the position stays as it is. Size is the final weight the AI agent gives the stock after the buy; for the rules agent the share of your buy it keeps."] },
    decisions_side_by_side: { title: "All decisions side by side", where: "AI agent area, the button under the Latest decisions heading",
      facts: ["It lists every moment with its date, stock and kind, then four columns to compare at the same point in time: what you did, what the attention-weighted index held of the stock then, what the rules agent decided and why, and what the AI agent decided and why.",
        "The attention index column is the stock's share of your views in the 30 days up to 1 day before the moment; a stock with no views then shows as not in the index.",
        "Rows are shaded where the two agents decided differently, and the filters show all moments, only those where they differ, your buys, or looks and repeat views. The AI agent's cell carries its reasoning or the decision model's odds and whether it was decided live (within 2 days) or after the fact."] },
    paper_portfolios: { title: "Paper portfolios", where: "AI agent area, the chart under Paper portfolios",
      facts: ["All lines are time-weighted indices that are 100 on the first day shown: money put in on a day is taken out of that day's gain, so portfolios funded at different times, and an index of prices, can be compared. Values are in the currency of your buys at each day's rate.",
        "Your trades: each buy of yours puts its amount into every portfolio. You put all of it into the stock, which gives the buy a weight (its share of your portfolio after the buy). The rules agent buys up to that weight times its share (or waits, or passes), the AI agent up to the final weight it chose, or your weight where it has not decided.",
        "Every portfolio stays fully invested: money a smaller buy leaves goes into the stocks it holds, in proportion; it is cash only while nothing is held. When you sell, each portfolio sells the same share of its position and the money leaves the portfolio, so your bars are your positions at market value. Savings-plan buys are made by every portfolio at your weight.",
        "The AI agent's line starts at its first decision about the view shown (trades: a buy of yours; attention: a look or repeat view), at 100. If it has decided none of your buys, the trades view has no AI line.",
        "Your attention: each agent runs a virtual portfolio of 100 from the first look."] },
    attention_index: { title: "Attention-weighted index", where: "AI agent area, the Your attention view and the attention column",
      facts: ["It is a basket of the stocks you looked at, weighted by your views in the last 30 days, using views up to 1 day before each close. It is rebalanced at every close, and the last basket is kept when there are no views.",
        "The rules agent holds the same basket, but each stock only from the day its rules let the look through (a pass buys none, a cap rule cuts the weight). The AI agent buys up to the final weight it chose and sells only when its repeat-view decisions say so.",
        "The rules agent's line can start anywhere; the AI agent's starts with its first decision."] },
    timeline: { title: "Timeline", where: "AI agent area, the handles above the chart",
      facts: ["The two handles choose the period. Every line is rebased to 100 on the first day all the other lines have a value, and the AI agent's line to 100 on its own first day (the mark on the track is its first decision).",
        "The table under the chart gives each line's change over the period: its last value divided by its first, minus 1. The button From the AI agent's first decision moves the start there; The whole history resets it."] },
    holdings_over_time: { title: "Holdings over time", where: "AI agent area, the button under the chart",
      facts: ["For each portfolio, one bar per month end (and the last day) shows what it held, stock by stock and in cash. In the trades view the unit is the share of the portfolio's value; in the attention view it is unit positions (a look is one unit; an agent's share is its size).",
        "The ten stocks that ever weigh most get a colour each and the rest share grey. Hover a bar for the full list, largest first, with each holding's colour; the wheel scrolls the list.",
        "They are the same positions as behind the lines, so the lines can be checked: each bar's stocks plus cash add up to the portfolio."] },
    pre_trade_check: { title: "Pre-trade check", where: "Trades & research, the check for an intended buy",
      facts: ["Type a stock (and an amount) before you buy. The rules agent gives its verdict now from the latest rules that held up for you: buy, wait (with how long it typically waited) or pass, and which rules fire.",
        "The AI agent answers from what is known now in one request, with a button to ask again. Both are saved with the check. It is a paper decision and not investment advice."] },
    stock_page_verdict: { title: "AI verdict pop-up on stock pages", where: "A pop-up on a stock's page, above the reminder and the expectation pop-up",
      facts: ["A minute after a viewing session ends, the extension runs the AI agent in the background on the moments of your last session and keeps its verdict on this device.",
        "On the stock page the verdict stays hidden until you click Unmask, so it does not sway your own view. If you keep reading, it can be decided again; a new decision is hidden again.",
        "It is a paper decision, and it uses the same 2-day live window as the AI agent area."] },
    own_words: { title: "What your own words say", where: "AI agent area, the last part",
      facts: ["The notes you wrote with your Positive and Negative calls are read once by the AI and sorted by the kind of reason (valuation, momentum, news, a feeling and so on) and by wording (specific, hedged, emotional). A label you pick in the page widget settles the type.",
        "Outcomes are the 63-day return against the NASDAQ from the call day. A difference counts as clear only when its 99% range excludes zero, and only with enough calls on each side. It is a reading of the wording, not of the stock."] }
  };

  const hourBand = function (h) { return h >= 22 || h < 6 ? "night" : h < 11 ? "morning" : h < 15 ? "midday" : h < 18 ? "afternoon" : "evening"; };

  // Buys in [from, to): how they were made and how they did.
  function periodStats(c, from, to) {
    const bs = c.R.decisions.filter(function (d) { return !d.excluded && d.side === "buy" && d.cut >= from && d.cut < to; });
    const share = function (f) { return bs.length ? r3(bs.filter(f).length / bs.length) : null; };
    const res = bs.filter(function (d) { return d.fwd && d.fwd[21]; }).map(function (d) { return d.fwd[21].ex; });
    return { buys: bs.length, sells: c.R.decisions.filter(function (d) { return !d.excluded && d.side === "sell" && d.cut >= from && d.cut < to; }).length,
      researchedShare: share(function (d) { return d.researched; }), impulseShare: share(function (d) { return !d.dateOnly && d.firstAtt != null && d.cut - d.firstAtt <= 3600000; }),
      afterRiseShare: share(function (d) { return d.runup30 != null && d.runup30 > 0.1; }), eveningShare: share(function (d) { return !d.dateOnly && hourBand(new Date(d.ts).getHours()) === "evening"; }),
      nextMonth: res.length ? r3(res.reduce(function (x, y) { return x + y; }, 0) / res.length) : null, withResult: res.length };
  }

  // ---------- the weekly review ----------
  // What happened in [from, to): attention (views, research time, new stocks, the most
  // looked at with the change against the period before, spikes, held stocks not looked
  // at for 30 days, calls made), trades (with research or on impulse) and the adopted
  // rules that were broken. nameOf(ticker) decides how a stock is written: its name in
  // the page, an alias when it goes to the assistant. Pure; runs without the assistant.
  function weeklyReview(c, from, to, nameOf) {
    const span = to - from, prevFrom = from - span, fmt = nameOf || function (t) { return t; };
    const iv = (c.intraday || []).filter(function (e) { return e && e.ticker && e.ts >= prevFrom && e.ts < to; });
    const now = iv.filter(function (e) { return e.ts >= from; }), prev = iv.filter(function (e) { return e.ts < from; });
    const count = function (list) { const m = {}; list.forEach(function (e) { m[e.ticker] = (m[e.ticker] || 0) + 1; }); return m; };
    const cn = count(now), cp = count(prev);
    const firstSeen = {};
    (c.intraday || []).forEach(function (e) { if (e && e.ticker && (firstSeen[e.ticker] == null || e.ts < firstSeen[e.ticker])) firstSeen[e.ticker] = e.ts; });
    const top = Object.keys(cn).sort(function (x, y) { return cn[y] - cn[x]; }).slice(0, 5).map(function (t) { return { stock: fmt(t), views: cn[t], before: cp[t] || 0 }; });
    const spikes = Object.keys(cn).filter(function (t) { return cn[t] >= 3 && cn[t] >= 3 * Math.max(1, cp[t] || 0); }).map(function (t) { return { stock: fmt(t), views: cn[t], before: cp[t] || 0 }; });
    const fresh = Object.keys(cn).filter(function (t) { return firstSeen[t] >= from; }).map(fmt);
    const lastView = {};
    (c.intraday || []).forEach(function (e) { if (e && e.ticker && (lastView[e.ticker] == null || e.ts > lastView[e.ticker])) lastView[e.ticker] = e.ts; });
    const neglected = (c.held || []).filter(function (t) { return !(lastView[t] >= to - 30 * DAY); }).map(fmt);
    const calls = (c.events || []).filter(function (e) { return e.sentiment && e.ts >= from && e.ts < to; });
    const callsBy = function (sent) { return calls.filter(function (e) { return e.sentiment === sent; }).map(function (e) { return fmt(e.ticker); }); };
    const minutes = function (list) { return Math.round(list.reduce(function (x, e) { return x + (e.dwellMs || 0); }, 0) / 60000); };
    const att = { views: now.length, viewsBefore: prev.length, minutes: minutes(now), minutesBefore: minutes(prev), stocks: Object.keys(cn).length, newStocks: fresh,
      top: top, spikes: spikes, heldNotLookedAtFor30Days: neglected, positiveCalls: callsBy("positive"), negativeCalls: callsBy("negative") };
    const end = c.R.coverage.fileEnd;
    const tr = periodStats(c, from, to);
    tr.tradesEndBeforeThePeriod = end != null && end < from;
    const rules = (c.commitments || []).filter(function (x) { return x.status === "active" && !x.kind; }).map(function (x) {
      const b = B.brokenIn(x, c.R, from, to);
      return { rule: x.text, inShort: x.do || null, broken: b.length, stocks: b.map(function (u) { return u.ticker ? fmt(u.ticker) : "a stock"; }).slice(0, 5) };
    });
    const days = Math.round(span / DAY), facts = [];
    facts.push("Attention in the last " + days + " days: " + att.views + " views (" + att.viewsBefore + " in the " + days + " days before), about " + att.minutes + " minutes of research (" + att.minutesBefore + " before), " + att.stocks + " stocks.");
    if (top.length) facts.push("Most looked at: " + top.map(function (x) { return x.stock + " " + x.views + (x.before ? " (" + x.before + " before)" : " (new)"); }).join(", ") + ".");
    if (spikes.length) facts.push("Sudden interest: " + spikes.map(function (x) { return x.stock + " " + x.views + " views against " + x.before; }).join(", ") + ". Spikes like this have preceded your buys before; give them a day.");
    if (fresh.length) facts.push("First looks: " + fresh.slice(0, 6).join(", ") + (fresh.length > 6 ? " and " + (fresh.length - 6) + " more" : "") + ".");
    if (neglected.length) facts.push("Held but not looked at for 30 days: " + neglected.slice(0, 6).join(", ") + (neglected.length > 6 ? " and " + (neglected.length - 6) + " more" : "") + ".");
    if (calls.length) facts.push("Calls made: " + att.positiveCalls.length + " Positive, " + att.negativeCalls.length + " Negative.");
    facts.push(tr.tradesEndBeforeThePeriod ? "Your imported trades end before this period: import a newer file to review your trades." : "Trades: " + tr.buys + " buys and " + tr.sells + " sales" + (tr.buys ? ", " + pc(tr.researchedShare) + " researched, " + pc(tr.impulseShare) + " on impulse" : "") + ".");
    rules.forEach(function (x) { facts.push("Rule \"" + x.rule + "\": " + (x.broken ? "broken " + x.broken + " time(s)" + (x.stocks.length ? " (" + x.stocks.join(", ") + ")" : "") : "kept") + "."); });
    return { from: from, to: to, days: days, attention: att, trades: tr, rules: rules, facts: facts };
  }

  // Runs a tool on the device. Never throws; an error comes back as a result.
  function run(s, c, tool, args) {
    if (!Object.prototype.hasOwnProperty.call(TOOLS, tool)) return { error: "unknown tool" };
    let out;
    try { out = TOOLS[tool](c, args || {}, s); } catch (e) { return { error: "the tool failed" }; }
    if (!out || typeof out !== "object") return { error: "no result" };
    out = JSON.parse(JSON.stringify(out));
    if (isPrivate(out)) return { error: "withheld: the result looked like raw trade data" };
    return out;
  }

  // ---------- numbers in a reply ----------

  // Every number the reply states should be one the results hold (a share may be
  // written as a percent). Returns the ones that are not: small whole numbers
  // (1-10) pass, since words like "2 rules" are not claims about the data.
  function checkNumbers(answer, results) {
    const allowed = [];
    String(JSON.stringify(results)).replace(/-?\d+(?:\.\d+)?/g, function (m) {
      const v = Math.abs(parseFloat(m));
      allowed.push(v, v * 100);
      return m;
    });
    const unmatched = [];
    String(answer).replace(/\d+(?:[.,]\d+)?/g, function (m) {
      const txt = m.replace(",", "."), v = parseFloat(txt), dec = (txt.split(".")[1] || "").length, scale = Math.pow(10, dec);
      if (Number.isInteger(v) && v >= 1 && v <= 10) return m;
      if (!allowed.some(function (a) { return Math.abs(Math.round(a * scale) / scale - v) < 1e-9; })) unmatched.push(m);
      return m;
    });
    return { unmatched: unmatched.filter(function (x, i, a) { return a.indexOf(x) === i; }) };
  }

  const api = { session: session, run: run, TOOLS: TOOLS, weeklyReview: weeklyReview, periodStats: periodStats, isPrivate: isPrivate, redact: redact, checkNumbers: checkNumbers, NAMES: NAMES, finding: finding, engineOf: engineOf, engineName: engineName, actText: actText };
  if (typeof self !== "undefined") self.ATTools = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
