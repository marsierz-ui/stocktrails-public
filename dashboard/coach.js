// My Habits > Trades & research > Coach: the biases the statistics support, a
// rule for each, whether that rule would have helped on trades it had not seen,
// the rules the user adopted and how well they are kept, and a check of an
// intended buy against them. Loaded after trades.js, uses its globals (TR,
// trHours, trChip, trPts, trPct, trRange, trDate, trToggle, escapeHtml, nameOf,
// tickerSymbol, trackedTickers, renderTrades) and src/biases.js (ATBiases).
//
// Everything is computed here, in the browser, from the imported trades; the
// adopted rules are stored next to them (ATLedgerDB "commitments"). No model and
// no network is involved: the recommendations are statistics and their wording
// is fixed text with the user's own numbers filled in.

const TR_VERDICT = {
  supported: ["Held up out of sample", "st-solid", "Fitted on your earlier trades, it also helped on the later ones, and the 99% range stays above zero."],
  indicative: ["A hint out of sample", "st-indicative", "It helped on the later trades, but only the 95% range stays above zero."],
  unclear: ["Not shown out of sample", "st-none", "It looked positive on the later trades, but within what chance gives."],
  unsupported: ["Did not hold up", "st-none", "Fitted on your earlier trades, it did not help on the later ones."],
  untested: ["Too little data to test", "st-none", "There are not enough decisions to fit it on the past and judge it on the future yet."]
};

function trVerdictChip(v) {
  const t = TR_VERDICT[v] || TR_VERDICT.untested;
  return "<span class='tr-chip " + t[1] + "' title='" + escapeHtml(t[2]) + "'>" + t[0] + "</span>";
}

// The coach for the report on screen, kept until the report or the day parts change.
function trCoachState(R) {
  const hs = trHours(R), key = [TR.reportKey, TR.hourMode, JSON.stringify(TR.customParts)].join("|");
  if (TR.coachFor !== R || TR.coachKey !== key) { TR.coach = ATBiases.coach(R, { blocks: hs.defs }); TR.coachFor = R; TR.coachKey = key; }
  return TR.coach;
}

function trRuleEvidence(r) {
  const o = r.oos, pts = function (x) { return trPts(x); };
  if (!r.recommended) return "<div class='muted small'>No setting of this rule would have helped on your trades so far.</div>";
  let b = "<div class='tr-rule-ev'>";
  if (o.mean == null) b += "Not tested yet: " + escapeHtml(o.reason || "too little data") + ". ";
  else b += "Fitted on your earlier trades and applied to the later ones (" + o.folds + " rounds), it would have flagged <b>" + o.flagged + "</b> of the " + o.testN + " later decisions. " +
    "Following it would have been worth <b>" + pts(o.mean) + "</b> each against the NASDAQ (99% range " + trRange(o.ci99, pts) + "), " + pts(o.perDecision) + " spread over all of them. ";
  b += "In your whole history it would have flagged " + r.inSample.k + " of " + r.n + " (" + Math.round(r.inSample.share * 100) + "%) and been worth " + pts(r.inSample.mean) +
    " each, which flatters it because the setting was chosen on those same trades.</div>";
  return b;
}

// commits: the user's adopted (or retired) copies of this rule. An active one is shown
// under the rule with how well it is kept and its Retire and Remove buttons.
function trRuleHtml(r, commits, R) {
  const o = r.oos, own = commits || [], active = own.some(function (c) { return c.status === "active"; });
  const btn = active ? "<span class='tr-chip st-solid'>Adopted</span>"
    : "<button class='tr-primary' data-coach='adopt' data-rule='" + escapeHtml(r.id) + "'>" + (o.verdict === "supported" || o.verdict === "indicative" ? "Adopt this rule" : "Adopt anyway") + "</button>";
  return "<div class='tr-rule'><div class='tr-rule-head'><b>" + escapeHtml(r.title) + "</b> " + trVerdictChip(o.verdict) + (r.recommended ? " " + btn : "") + "</div>" +
    (r.recommended ? "<div class='tr-rule-text'>" + escapeHtml(r.text) + "</div><div class='tr-rule-do'>In short: <b>" + escapeHtml(r.do || "") + "</b></div>" : "") + trRuleEvidence(r) +
    own.map(function (c) { return trCommitHtml(c, R); }).join("") + "</div>";
}

// The rules a bias card lists.
function trBiasShown(b) { return b.rules.filter(function (r) { return r.oos.verdict !== "unsupported" && (r.recommended || b.tier === "detected"); }); }

// What each bias is, in a sentence, for the (i) next to its name.
const TR_BIAS_INFO = {
  chasing: "Buying a stock after its price has already risen, expecting the rise to continue.",
  impulse: "Buying very soon after first looking at a stock, with little time to think it over.",
  bad_hour: "Placing buys at a time of day when your buys did worse than your others.",
  turbulence: "Putting more money into a buy when the market is turbulent, which is when mistakes cost most.",
  say_do_gap: "Calling a stock Positive but not acting on it (or acting against your calls).",
  ignored_targets: "Setting a target price and then not selling when the stock reaches it.",
  no_research: "Buying without having looked at the stock beforehand.",
  disposition: "Selling winners early while keeping losers (the disposition effect).",
  size_vs_conviction: "Your biggest positions are the ones you researched least.",
  extrapolation: "Expecting a stock's recent returns to continue.",
  lottery: "Buying lottery-like stocks: cheap, very volatile, or just after a big one-day jump.",
  anchoring: "Letting round numbers, your purchase price or the 52-week high set your targets and sales.",
  homebias: "Concentrating in your home market instead of the world market.",
  volume: "Buying what trades heavily, which is what draws attention rather than what is good value.",
  crowd_buys: "Buying a stock while many other users are looking at it.",
  underreaction: "Missing a company's quarterly report (or reading it late).",
  overconfidence: "Trading more than your information supports: switching often, asking much of targets.",
  ostrich: "Looking at your positions less after they fall (the ostrich effect).",
  confirmation: "Discounting news that goes against your call and reading mainly what agrees with it.",
  herding: "Looking at a stock right after the crowd or trending lists piled into it.",
  rank: "Selling your best or worst position first and ignoring the ones in the middle.",
  myopia: "Selling long-term positions on short-term drops.",
  repurchase: "Rebuying only what fell after you sold it.",
  timing: "Choosing your moments to buy when the same money in a regular savings plan would have earned more.",
  diversification: "Holding few or similar positions, so one event can hit much of your depot."
};

function trBiasHtml(b, byRule, R) {
  const shown = trBiasShown(b);
  const hidden = b.rules.filter(function (r) { return r.oos.verdict === "unsupported" && r.recommended; }).length;
  const head = "<div class='tr-bias-head'><b>" + escapeHtml(b.name) + "</b>" + trInfo(escapeHtml(TR_BIAS_INFO[b.id] || "A habit the statistics found in your decisions.") + " Below: what your data shows and the rules that would have helped.", "About this bias") + " " + (b.tier === "rules" ? "<span class='tr-chip st-none' title='No statistic on the page above flags this, but the rule below held up on trades it had not seen.'>From the rule check</span>" : trChip(b.status, b.clear)) + "</div>";
  const sigs = b.signals.length ? "<ul class='tr-signals'>" + b.signals.map(function (s) { return "<li>" + escapeHtml(s.text) + (s.clear ? "" : " <span class='muted small'>(not proven)</span>") + "</li>"; }).join("") + "</ul>" : "";
  const adv = b.advice ? "<ul class='tr-signals tr-advice-l'>" + b.advice.map(function (a) { return "<li>" + escapeHtml(a) + "</li>"; }).join("") + "</ul>" : "";
  return "<div class='card tr-bias " + b.tier + "'>" + head + sigs + adv + shown.map(function (r) { return trRuleHtml(r, byRule[r.id], R); }).join("") +
    (hidden ? "<div class='muted small'>" + hidden + (hidden === 1 ? " other rule" : " other rules") + " for this bias did not hold up out of sample and " + (hidden === 1 ? "is" : "are") + " not recommended.</div>" : "") + "</div>";
}

// ---------- adopted rules ----------

function trCommitHtml(c, R) {
  const A = c.status === "active" || c.status === "retired" ? ATBiases.adherence(c, R, c.retiredAt || Date.now()) : null;
  const pc = function (w) { return w && w.n ? w.k + " of " + w.n + " (" + Math.round(w.p * 100) + "%)" : "-"; };
  let b = "";
  if (A) {
    if (!A.n) b = "<div class='muted small'>No decision since you adopted it yet.</div>";
    else {
      b = "<div>Since " + trDate(c.adoptedAt) + ": <b>" + A.n + "</b> decisions that this rule covers; it was broken " + pc(A.broken) + " times." +
        (A.before.n ? " In an equally long stretch before it would have been broken " + pc(A.before.broken) + (A.change ? ", a change of " + trPts(A.change.est) + " (95% range " + trRange(A.change, trPts) + ")" : "") + "." : "") + "</div>";
      b += "<div>Next month vs NASDAQ: decisions that kept it " + (A.kept.n ? trPct(A.kept.mean, true) + " (" + A.kept.n + ")" : "-") + ", decisions that broke it " + (A.broke.n ? trPct(A.broke.mean, true) + " (" + A.broke.n + ")" : "-") +
        (A.diff ? "; difference " + trPts(A.diff.est) + " (95% range " + trRange(A.diff, trPts) + ")" + (A.clear ? " - clear" : "") : "") + "." +
        (A.pending ? " " + A.pending + " recent decisions have no month of prices after them yet." : "") +
        (A.status === "none" ? " <span class='muted small'>Too few in each group (" + ATBiases.NEED.adherence.min + " needed) to compare.</span>" : "") + "</div>";
      b += "<div class='muted small'>Association, not proof " + trInfo("Nobody was assigned to follow the rule, and the decisions it flags may differ in other ways.", "Why this is not proof") + "</div>";
    }
  }
  return "<div class='tr-commit " + escapeHtml(c.status) + "'><div class='tr-rule-head'><b>" + escapeHtml(c.text) + "</b> " +
    (c.status === "active" ? "<span class='tr-chip st-solid'>Active</span>" : "<span class='tr-chip st-none'>Retired</span>") + "</div>" +
    "<div class='muted small'>Adopted " + trDate(c.adoptedAt) + (c.atAdoption && c.atAdoption.verdict ? ", then: " + escapeHtml((TR_VERDICT[c.atAdoption.verdict] || [""])[0].toLowerCase()) : "") + "</div>" + b +
    "<div class='tr-btns'>" + (c.status === "active" ? "<button data-coach='retire' data-id='" + escapeHtml(c.id) + "'>Retire</button>" : "") + "<button data-coach='remove' data-id='" + escapeHtml(c.id) + "'>Remove</button></div></div>";
}

// ---------- are you leaving your biases behind? ----------

const TR_PROGRESS = { fading: ["Fading", "st-solid"], growing: ["Getting stronger", "st-warn"], no_clear_change: ["No clear change", "st-none"], too_few: ["Too few recent", "st-none"] };

function trProgressHtml(R, C) {
  const P = ATBiases.progress(R, C, { commitments: TR.commitments || [] });
  const rows = P.habits.filter(function (x) { return x.verdict !== "too_few"; });
  if (!rows.length) return "";
  const pc = function (w) { return Math.round(w.p * 100) + "%" + (w.base != null ? " <span class='muted small' title='Share of trading days in that state in the same period'>(market " + Math.round(w.base * 100) + "%)</span>" : ""); };
  const spark = function (path) {
    const pts = path.filter(function (x) { return x.share != null; }), mx = Math.max.apply(null, pts.map(function (x) { return x.share; }).concat([0.01]));
    return "<span class='tr-spark' aria-hidden='true'>" + pts.map(function (x) { return "<i style='height:" + Math.max(2, Math.round(x.share / mx * 18)) + "px' title='" + escapeHtml(x.period + ": " + Math.round(x.share * 100) + "% of " + x.n) + "'></i>"; }).join("") + "</span>";
  };
  const sum = P.fading || P.growing ? (P.fading ? P.fading + (P.fading === 1 ? " habit is" : " habits are") + " fading" : "") + (P.fading && P.growing ? ", " : "") + (P.growing ? P.growing + (P.growing === 1 ? " is" : " are") + " getting stronger" : "") : "no clear change yet";
  const cards = rows.map(function (x) {
    const t = TR_PROGRESS[x.verdict];
    return "<div class='card tr-habit'><div class='tr-bias-head'><b>" + escapeHtml(x.habit) + "</b>" + trInfo("How often your decisions did this, before and in the last " + P.days + " days. Fading means the 99% range of the change stays below zero; getting stronger means it stays above.", "About this habit") + "" + (x.setting === "adopted" ? " <span class='muted small'>(your rule)</span>" : "") +
      " <span class='tr-chip " + t[1] + "' title='" + escapeHtml(x.change ? "Change " + trPts(x.change.est) + " (99% range " + trRange(x.change, trPts) + ")" + (x.trend ? "; over the whole history " + trPts(x.trend.perYear) + " a year" + (x.trend.clear ? ", clear" : ", not clear") : "") : "") + "'>" + t[0] + "</span></div>" +
      "<div class='tr-habit-row'><div><div class='muted small'>Before</div><div class='tr-habit-v'>" + pc(x.earlier) + " <span class='muted small'>of " + x.earlier.n + "</span></div></div>" +
      "<div class='tr-habit-arrow' aria-hidden='true'>&rarr;</div>" +
      "<div><div class='muted small'>Last " + P.days + " days</div><div class='tr-habit-v'><b>" + pc(x.recent) + "</b> <span class='muted small'>of " + x.recent.n + "</span></div></div>" +
      "<div><div class='muted small'>By half year</div>" + spark(x.path) + "</div></div></div>";
  });
  const marks = rows.map(function (x) { return { t: x.habit, st: x.verdict === "fading" ? "solid" : x.verdict === "growing" ? "warn" : "none" }; });
  return trCarHeadHtml("tr-coach-sub-h", "Are you leaving your biases behind? <span class='muted small'>the last " + P.days + " days against everything before: " + sum + "</span> " +
    trInfo("Each habit is measured the same way in every period: with the setting of your rule if you adopted it, else the coach's setting, else a fixed one. \"Fading\" means the 99% range of the change stays below zero. A habit about the market is judged against the market's own share of such days in each period. Buys come in bursts, so the ranges are somewhat optimistic."), "progress", marks) +
    trCarouselHtml("progress", cards);
}

// ---------- check an intended buy ----------

function trCheckHtml() {
  const ticks = trackedTickers().sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
  const ccys = {};
  TR.txs.forEach(function (t) { if (t.currency) ccys[t.currency] = (ccys[t.currency] || 0) + 1; });
  const ccyList = Object.keys(ccys).sort(function (a, b) { return ccys[b] - ccys[a]; });
  return "<section class='tr-check'><h3 class='tr-check-title'>Check a buy before you place it " + trInfo("Measures the stock and the market as they are now and holds them against the rules you adopted. Every check is kept on this device for later evaluation (what you entered, what was measured, what the rules and the AI agent answered). If the assistant is on, the AI agent is asked for each check and the request goes to the assistant's service (see What was sent). No order is placed.", "About the check") + "</h3>" +
    "<div class='tr-check-sub muted'>Pick a stock and an amount: see what is true of it right now, and whether one of your rules objects.</div>" +
    "<div class='tr-check-row'><label>Stock <select id='tr-check-t'>" + ticks.map(function (t) { return "<option value='" + escapeHtml(t) + "'>" + escapeHtml(nameOf(t)) + " (" + escapeHtml(t) + ")</option>"; }).join("") + "</select></label>" +
    "<label>Amount <input id='tr-check-a' type='number' min='0' step='any' placeholder='e.g. 500' size='8'></label>" +
    "<label>Currency <select id='tr-check-c'>" + (ccyList.length ? ccyList : ["EUR"]).map(function (c) { return "<option>" + escapeHtml(c) + "</option>"; }).join("") + "</select></label>" +
    "<button class='tr-primary' data-coach='check'>Check this buy</button></div><div id='tr-check-out'></div></section>";
}

// What is known now about an intended buy; null for what cannot be known.
function trCheckContext(ticker, amount, ccy, R) {
  const now = Date.now(), S = ATDecisions.stats, ctx = { hour: new Date(now).getHours() }, why = [];
  const evs = (DATA.intraday || []).filter(function (e) { return e.ticker === ticker; });
  const series = TR.prices[tickerSymbol(ticker)];
  const first = evs.length ? Math.min.apply(null, evs.map(function (e) { return e.ts; })) : null;
  ctx.leadH = first != null ? (now - first) / 3600000 : null;
  // how far the stock moved in the last 30 days (the same measure the rule was judged on)
  ctx.runup = null;
  if (series && series.length) {
    const day = isoDate(now - 30 * 86400000);
    let c0 = null;
    for (let i = 0; i < series.length && series[i].date <= day; i++) c0 = series[i].close;
    const c1 = series[series.length - 1].close;
    if (c0 > 0 && c1 > 0) ctx.runup = c1 / c0 - 1;
  }
  const recent = evs.filter(function (e) { return e.ts >= now - 30 * 86400000; });
  let maxScroll = 0, focus = 0;
  recent.forEach(function (e) { if (e.scrollDepth != null && e.scrollDepth > maxScroll) maxScroll = e.scrollDepth; if ((e.focusSwitches || 0) > focus) focus = e.focusSwitches || 0; });
  ctx.views30 = recent.length;
  ctx.conviction = Math.log2(1 + recent.length) * (0.5 + 0.5 * maxScroll) * (1 + 0.1 * focus);
  ctx.pVol = ctx.pRet = null;
  if (typeof BENCH !== "undefined" && BENCH && BENCH.length > 30 && R.market && R.market.vol.length) {
    const ms = ATDecisions.marketSeries(BENCH), i = BENCH.length - 1;
    if (ms.vol20[i] != null) ctx.pVol = S.pctRank(R.market.vol, ms.vol20[i]);
    if (ms.ret20[i] != null) ctx.pRet = S.pctRank(R.market.ret, ms.ret20[i]);
  }
  const usual = ATDecisions.usualSize(R.decisions, now, ccy);
  ctx.relSize = usual && amount > 0 ? amount / usual : null;
  // Phase-2 facts (src/indicators.js): lottery today, 12-month return among what you
  // viewed in the last 30 days, distance from the 52-week high, weight in the depot.
  ctx.lottery = ctx.pct12 = ctx.nearHigh = ctx.weight = null;
  if (self.ATIndicators && series && series.length) {
    const today = isoDate(now + 86400000), I = ATIndicators;
    const lot = I.lotteryAt(series, typeof BENCH !== "undefined" ? BENCH : null, today);
    if (lot) ctx.lottery = !!lot.lottery;
    const own = I.pastRet(series, today, 252), rs = [];
    const seen = {};
    (DATA.intraday || []).forEach(function (e) { if (e.ts >= now - 30 * 86400000) seen[e.ticker] = 1; });
    seen[ticker] = 1;
    Object.keys(seen).forEach(function (t) { const r = I.pastRet(TR.prices[tickerSymbol(t)], today, 252); if (r != null) rs.push(r); });
    rs.sort(function (a, b) { return a - b; });
    if (own != null && rs.length >= 5) ctx.pct12 = S.pctRank(rs, own);
    const h = I.high52(series, today);
    if (h) ctx.nearHigh = h.close / h.hi;
  }
  const dv = R.ind && R.ind.diversification, last = dv && dv.holdings.last;
  if (last && last.value > 0 && amount > 0 && dv.holdings.currency === ccy) ctx.weight = amount / (last.value + amount);
  // other users' attention on the stock in the last 3 days against its usual rate (rule wait_crowd)
  ctx.crowd = null;
  if (self.ATIndicators && TR.comm && TR.comm.community) {
    const c = ATIndicators.crowdAt(ATIndicators.crowdIndex(TR.comm.community, DATA.events || []), ticker, now);
    if (c) ctx.crowd = c.ratio;
  }
  return ctx;
}

function trCheckOut(R) {
  const tk = document.getElementById("tr-check-t").value, amt = parseFloat(document.getElementById("tr-check-a").value), ccy = document.getElementById("tr-check-c").value;
  const out = document.getElementById("tr-check-out");
  const active = (TR.commitments || []).filter(function (c) { return c.status === "active" && !c.kind; });
  // reminders the user set for this stock (from the assistant's proposals) come first
  const memo = (TR.commitments || []).filter(function (c) { return c.kind === "reminder" && c.status === "active" && c.ticker === tk; });
  const memoHtml = memo.length ? "<div class='tr-msg'><b>Your reminder" + (memo.length > 1 ? "s" : "") + " for this stock:</b><ul class='tr-signals'>" + memo.map(function (c) { return "<li>" + escapeHtml(c.text) + "</li>"; }).join("") + "</ul></div>" : "";
  if (TR.agent) TR.agent.check = null;
  const ctx = trCheckContext(tk, amt, ccy, R), res = ATBiases.preTrade(TR.commitments || [], ctx);
  const pc = function (x) { return x == null ? "unknown" : Math.round(x * 100) + "th percentile"; };
  const facts = [ctx.runup == null ? "no 30-day price move known" : (ctx.runup >= 0 ? "up " : "down ") + trPct(Math.abs(ctx.runup)) + " in the last 30 days", ctx.leadH == null ? "no recorded first look" : "first look " + (ctx.leadH < 48 ? Math.round(ctx.leadH) + " h" : Math.round(ctx.leadH / 24) + " d") + " ago",
    ctx.views30 + (ctx.views30 === 1 ? " visit" : " visits") + " in the last 30 days (conviction " + ctx.conviction.toFixed(1) + ")", "market volatility at the " + pc(ctx.pVol), "market 20-day return at the " + pc(ctx.pRet), ctx.relSize == null ? "size unknown (no usual buy yet, or no amount)" : ctx.relSize.toFixed(1) + "x your usual buy", "time " + ctx.hour + ":00"];
  if (ctx.lottery != null) facts.push(ctx.lottery ? "a lottery stock today (a day above +10% in the last month, or cheap and very volatile)" : "not a lottery stock today");
  if (ctx.pct12 != null) facts.push("12-month return above " + pc(ctx.pct12).replace("th percentile", "%") + " of the stocks you viewed in the last 30 days");
  if (ctx.nearHigh != null) facts.push(ctx.nearHigh >= 0.95 ? "within 5% of its 52-week high" : Math.round((1 - ctx.nearHigh) * 100) + "% below its 52-week high");
  if (ctx.weight != null) facts.push("about " + Math.round(ctx.weight * 100) + "% of your depot after the buy" + (ctx.weight > 0.2 ? " (a large single position)" : ""));
  if (ctx.crowd != null) facts.push("other users' views in the last 3 days at " + ctx.crowd.toFixed(1) + "x the stock's usual rate");
  // the size the adopted cap rules allow: the smallest cap, as a multiple of the usual buy and, on this device, in money
  const caps = res.hits.filter(function (h) { return /^cap_/.test(h.ruleId) && h.params && h.params.cap > 0; });
  let sizeHtml = "";
  if (caps.length) {
    const cap = Math.min.apply(null, caps.map(function (h) { return h.params.cap; })), usual = ATDecisions.usualSize(R.decisions, Date.now(), ccy);
    sizeHtml = "<div class='tr-msg tr-size'><b>Size:</b> at most <b>" + cap + "x</b> your usual buy" + (usual ? ", about <b>" + Math.round(usual * cap).toLocaleString() + " " + escapeHtml(ccy) + "</b>" : "") +
      (amt > 0 && usual && amt > usual * cap ? " instead of " + Math.round(amt).toLocaleString() + " " + escapeHtml(ccy) : "") + ".</div>";
  }
  out.innerHTML = memoHtml + sizeHtml + (!active.length ? "<div class='tr-msg'>No adopted rule yet: adopt one in the coach below to check against it.</div>"
    : res.hits.length
      ? "<div class='tr-msg tr-warn'><div class='tr-verdict'>" + res.hits.map(function (h) { return escapeHtml(h.do || ""); }).filter(function (x, i, a) { return x && a.indexOf(x) === i; }).join(" ") + "</div>" +
        "<ul class='tr-signals'>" + res.hits.map(function (h) { return "<li>" + escapeHtml(h.why) + "<div class='muted small'>Your rule: " + escapeHtml(h.text) + "</div></li>"; }).join("") + "</ul></div>"
      : "<div class='tr-msg'>None of your adopted rules objects to this buy" + (res.unknown.length ? ", but " + res.unknown.length + " could not be checked (not enough information)." : ".") + "</div>") +
    (res.hits.length && res.unknown.length ? "<div class='muted small'>" + res.unknown.length + " more could not be checked.</div>" : "") +
    "<div class='muted small'>Measured now: " + facts.map(escapeHtml).join("; ") + ".</div>";
  if (self.trCheckExtra) out.insertAdjacentHTML("beforeend", trCheckExtra(tk, ctx, R, amt, ccy));
  trCheckSave(tk, amt, ccy, ctx, res, memo, caps);
  // the AI agent answers directly underneath (when the assistant is on); its answer is added to the saved run
  const ai = document.getElementById("tr-agent-check-ai");
  if (ai && self.trAgentAskCheck && TR.agent && TR.agent.check) trAgentAskCheck(ai);
}

// Every run of the check is kept on this device for later evaluation: what was typed, what was
// measured, which adopted rules were in force and what they and the rules agent said. The AI
// agent's answer is added by trAgentAskCheck. Nothing here is sent anywhere.
function trCheckSave(tk, amt, ccy, ctx, res, memo, caps) {
  if (!self.ATLedgerDB || !TR.owner) return;
  const s = TR.prices[tickerSymbol(tk)], last = s && s.length ? s[s.length - 1] : null, k = TR.agent && TR.agent.check && TR.agent.check.tk === tk ? TR.agent.check : null;
  const clone = function (x) { return JSON.parse(JSON.stringify(x == null ? null : x)); };
  const rec = clone({ v: 1, ts: Date.now(), ticker: tk, amount: amt > 0 ? amt : null, currency: ccy, lastClose: last ? { date: last.date, close: last.close } : null,
    measured: k ? k.ctx : ctx,
    adopted: (TR.commitments || []).filter(function (c) { return c.status === "active" && !c.kind; }).map(function (c) { return { id: c.id, ruleId: c.ruleId, text: c.text, params: c.params || null, adoptedAt: c.adoptedAt }; }),
    hits: res.hits.map(function (h) { return { ruleId: h.ruleId, why: h.why, do: h.do || null }; }), unknown: res.unknown.map(function (u) { return u.ruleId; }),
    cap: caps.length ? Math.min.apply(null, caps.map(function (h) { return h.params.cap; })) : null, reminders: memo.map(function (c) { return c.text; }),
    rulesAgent: k ? { action: k.verdict.action, size: k.verdict.size, days: k.verdict.days || null, rules: k.verdict.rules, delaying: k.verdict.delaying, unchecked: k.verdict.unchecked, active: k.verdict.active, why: k.verdict.why || [] } : null });
  const saved = ATLedgerDB.putCheck(TR.owner, rec).catch(function () { /* storage blocked */ });
  if (TR.agent && TR.agent.check) TR.agent.check.saved = { key: TR.owner + "|" + rec.ts + "|" + rec.ticker, done: saved };
}

// ---------- the panel ----------

function trCoachHtml(R) {
  if (!self.ATBiases || !R.decisions) return "";
  const C = trCoachState(R), all = TR.commitments || [], commits = all.filter(function (c) { return !c.kind; }), memos = all.filter(function (c) { return c.kind && c.status === "active"; });
  const byRule = {};
  commits.forEach(function (c) { (byRule[c.ruleId] = byRule[c.ruleId] || []).push(c); });
  const main = C.biases.filter(function (b) { return b.tier !== "watch"; }), watch = C.biases.filter(function (b) { return b.tier === "watch"; });
  const anyData = C.rules.some(function (r) { return r.oos.verdict !== "untested"; });
  // adopted rules that no card lists (the rule stopped being recommended, say) get a card of their own
  const listed = {};
  main.concat(watch).forEach(function (b) { trBiasShown(b).forEach(function (r) { listed[r.id] = 1; }); });
  const orphans = commits.filter(function (c) { return !listed[c.ruleId]; });
  const mark = function (b) { return { t: b.name, st: b.tier === "rules" ? "none" : b.status || "none" }; };
  const cards = main.map(function (b) { return trBiasHtml(b, byRule, R); }).concat(orphans.map(function (c) {
    return "<div class='card tr-bias rules'><div class='tr-bias-head'><b>Your rule</b> <span class='tr-chip st-none'>Not on the list above</span></div>" + trCommitHtml(c, R) + "</div>";
  }));
  const marks = main.map(mark).concat(orphans.map(function (c) { return { t: c.text, st: "none" }; }));
  let h = "<section class='tr-coach tr-coach-hl'><h3 class='tr-coach-title'>Coach: what to change " + trInfo("Only patterns the statistics support, each with a rule. A rule is recommended only if, fitted on your earlier trades, it also helped on later trades it had not seen. " +
    "With many possible rules and settings, some always look good on the past by luck. Each rule is fitted on the earlier part of your history (first half, then growing), applied to the next block, and only the later blocks count; trades whose outcome was not yet known when a block began are not used to fit it. " +
    "Gains are measured against the NASDAQ and assume a skipped buy would have earned the market. Neighbouring trades overlap in time, so ranges are somewhat optimistic.", "How the coach works") + "</h3>" +
    "<div class='tr-coach-sub muted small'>Rules that held up on trades they had not seen (<a href='#' data-act='open-suff'>how much data that needs</a>). Not investment advice.</div>";
  if (TR.coachMsg) h += "<div class='tr-msg'>" + escapeHtml(TR.coachMsg) + "</div>";
  h += trCarHeadHtml("tr-coach-sub-h", "Your biases <span class='muted small'>" + (cards.length ? cards.length + (cards.length === 1 ? " card" : " cards") : "") + "</span>", "coach", marks);
  h += cards.length ? trCarouselHtml("coach", cards)
    : "<div class='card'><div class='tr-answer muted'>" + (anyData ? "No bias is clear in your trades yet, and no rule has held up out of sample. That is a result too: keep trading and recording, and this fills in as the evidence does."
      : "Not enough decisions yet to fit a rule on the past and judge it on the future (about 24 with a known outcome).") + "</div></div>";
  if (watch.length) h += trCarHeadHtml("tr-coach-sub-h", "Patterns to keep an eye on <span class='muted small'>" + watch.length + ", not proven yet</span>", "watch", watch.map(mark)) +
    trCarouselHtml("watch", watch.map(function (b) { return trBiasHtml(b, byRule, R); }));
  h += trProgressHtml(R, C);
  if (memos.length) h += "<h4 class='tr-coach-sub-h'>Reminders and notes <span class='muted small'>" + memos.length + ". A reminder pops up when you view its stock.</span></h4>" +
    "<div class='card tr-memos'><table class='adm tr-memo-t'><thead><tr><th>Type</th><th>Stock</th><th>Text</th><th>Set</th><th></th></tr></thead><tbody>" + memos.map(function (c) {
      return "<tr><td>" + (c.kind === "reminder" ? "Reminder" : "Note") + "</td><td>" + (c.ticker ? escapeHtml(nameOf(c.ticker)) : "-") + "</td><td>" + escapeHtml(c.text) + "</td><td class='muted small'>" + trDate(c.adoptedAt) +
        "</td><td><button data-coach='remove' data-id='" + escapeHtml(c.id) + "' title='Remove'>&times;</button></td></tr>";
    }).join("") + "</tbody></table></div>";
  return h + "</section>";
}

// One listener on the document: the "Adopt" buttons also appear in the assistant's side panel.
(function () {
  document.addEventListener("click", async function (ev) {
    const el = ev.target.closest("[data-coach]");
    if (!el) return;
    ev.preventDefault();
    const act = el.getAttribute("data-coach"), R = TR.report;
    try {
      if (act === "adopt") {
        const r = TR.coach.rules.find(function (x) { return x.id === el.getAttribute("data-rule"); });
        if (!r || !r.recommended) return;
        const c = ATBiases.commit(r, Date.now());
        await ATLedgerDB.putCommitments(TR.owner, [c]);
        TR.coachMsg = "Adopted: " + c.text + " From now on this page shows how often you keep it.";
        await renderTrades();
      } else if (act === "retire" || act === "remove") {
        const id = el.getAttribute("data-id"), c = (TR.commitments || []).find(function (x) { return x.id === id; });
        if (!c) return;
        if (act === "remove") { if (!confirm("Remove this rule and its record?")) return; await ATLedgerDB.deleteCommitment(TR.owner, id); }
        else await ATLedgerDB.putCommitments(TR.owner, [Object.assign({}, c, { status: "retired", retiredAt: Date.now() })]);
        TR.coachMsg = "";
        await renderTrades();
      } else if (act === "check") trCheckOut(R);
    } catch (e) { TR.coachMsg = "Could not save: " + (e && e.message || e); await renderTrades(); }
  });
})();
