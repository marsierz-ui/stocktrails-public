// My Habits > Trades & research > "Assistant": an optional assistant that
// puts the user's own results into words and answers questions about them, in a
// side panel (opened by the floating button), plus the analysis of the notes written
// with calls, which the AI agent does by itself and shows in its card (shadow.js).
// Loaded after coach.js; uses ATAI (src/aiclient.js), ATTools, ATRationale
// and the trades page's globals.
//
// Off until the user agrees. It never sees trades: the tools run here and send
// aggregates (stocks as "Stock 3", sizes as multiples of the usual buy, months,
// shares). Everything sent is listed under "What was sent". The assistant can
// name read-only tools; adopting a rule is a click in the page, never its call.

TR.ai = { msgs: [], busy: false, step: "", open: false, names: false, reviewDays: 7, reviewPanel: false, notes: { busy: false, msg: "" } };
try { TR.ai.open = localStorage.getItem("at_ai_open") === "1"; TR.ai.reviewPanel = localStorage.getItem("at_rv_open") === "1"; TR.ai.names = localStorage.getItem("at_ai_names") === "1"; } catch (e) { /* storage blocked */ }

const TR_AI_CHIPS = ["Review my week", "What are my biggest biases?", "Which rule should I adopt first?", "Am I leaving my biases behind?", "How would the agents have done?", "How well do I keep my rules?", "Remind me before I buy my most viewed stock"];

// Stocks held now, from the imported trades (the review lists those not looked at lately).
function trAiHeld() {
  try {
    const b = ATDecisions.buildDecisions(TR.txs || []), out = [];
    Object.keys(b.timeline).forEach(function (inst) {
      const tl = b.timeline[inst], l = TR.links[inst];
      if (tl.length && tl[tl.length - 1].pos > 0 && l && l.ticker && out.indexOf(l.ticker) < 0) out.push(l.ticker);
    });
    return out;
  } catch (e) { return []; }
}

// The review's "now": today, or the end of a demo's synthetic data (set by the sandbox).
function trAiNow() { return TR.ai.now || Date.now(); }

function trAiContext() {
  const R = TR.report, coach = trCoachState(R);
  return {
    R: R, coach: coach, commitments: TR.commitments || [], nameOf: nameOf, tickers: trackedTickers(), now: trAiNow(),
    intraday: DATA.intraday || [], events: DATA.events || [], held: trAiHeld(),
    // get_agent_portfolio: the agents' paper portfolios (dashboard/shadow.js), worked out only when asked
    shadow: function () { return self.trAgentState ? trAgentState(R) : null; },
    // get_agent_decisions: the agents' saved decisions with their reasoning, the saved pre-trade checks, and why a stock has no AI decision
    agentDecisions: function () {
      const A = TR.agent;
      return { store: A && A.store || [], checks: A && A.checks || [], skipped: function (tk) {
        try { const S = trAgentState(R), x = S ? trAgentSkipped(S).filter(function (y) { return y.ticker === tk; })[0] : null; return x ? x.why : null; } catch (e) { return null; }
      } };
    },
    // check_buy: the stock and the market as they are now, against the adopted rules; the size is the model's, as a multiple of the usual buy.
    checkBuy: function (t, size) {
      const ctx = trCheckContext(t, 0, (TR.txs[0] && TR.txs[0].currency) || "EUR", R);
      ctx.relSize = size;
      const res = ATBiases.preTrade(TR.commitments || [], ctx);
      const memo = (TR.commitments || []).filter(function (c) { return c.kind === "reminder" && c.status === "active" && c.ticker === t; }).map(function (c) { return c.text; });
      return { hits: res.hits.map(function (h) { return { rule: h.text, why: h.why, inShort: h.do }; }), couldNotCheck: res.unknown.length, reminders: memo,
        facts: [(memo.length ? "Reminder(s) for this stock: " + memo.join(" / ") + ". " : "") + (res.hits.length ? res.hits.length + " adopted rule(s) say wait: " + res.hits.map(function (h) { return h.why + " " + (h.do || ""); }).join(" ") : "None of the adopted rules objects to this buy." + (res.unknown.length ? " " + res.unknown.length + " could not be checked." : ""))] };
    }
  };
}

function trAiText(s) { return escapeHtml(s).replace(/\n/g, "<br>"); }

// ---------- the side panel ----------

function trAiConsentHtml() {
  return "<div class='card tr-ai-consent'><h4>Turn the assistant on</h4><div class='muted small'>The assistant stays off until you turn it on here or tick its box at sign-up. You can turn it off again at any time.</div>" +
    "<h5>What leaves this device</h5><ul class='tr-list'>" +
    "<li>Your question, with your stocks replaced by \"Stock 1\", \"Stock 2\" and long numbers and e-mail addresses removed.</li>" +
    "<li>Results worked out on this device that answer it: counts, shares, returns against the NASDAQ, sizes as multiples of your usual buy, dates by month.</li>" +
    "<li>If you analyse your notes: the text of the notes you wrote with your calls, with links, e-mail addresses and long numbers removed.</li>" +
    "<li>If you let the AI agent decide its paper portfolio: each of your buys and looks as it stood that day, with the stock as \"Stock 1\" and the date as \"day N\": the price path before in percent, the market, your research and calls before (their notes redacted), the rules and what the rules agent said at that moment.</li></ul>" +
    "<h5>What never leaves</h5><ul class='tr-list'><li>Amounts, quantities, prices, ISINs, tickers, the names of instruments, your broker or your account.</li>" +
    "<li>The file you imported and your list of trades.</li><li>Anything the assistant did not ask for by name: it can only request results from a fixed list, in at most 5 steps per question.</li></ul>" +
    "<ul class='tr-list'><li>The text goes to Stocktrails' AI service (a Supabase function), which asks a model through OpenRouter. Each request in the log shows which service answered. " +
    "Each request asks OpenRouter to use only endpoints that do not train on prompts, but do not type personal information.</li>" +
    "<li>Once it is on, the AI agent also decides by itself, about a minute after you finish viewing a stock on a finance site; those requests are in the log too.</li>" +
    "<li>The assistant cannot place orders or change your data. It can propose an action (adopt, retune or retire a rule, a reminder for a stock, a review note); it happens only if you click.</li>" +
    "<li>Everything sent is listed under \"What was sent\", and you can turn the assistant off at any time.</li></ul>" +
    "<div class='tr-btns'><button class='tr-primary' data-ai='consent'>Turn on the assistant</button></div>" +
    "<div class='muted small'>Later, under the chat, you can let it use your real stock names instead of \"Stock 1\": that reveals which stocks you hold and look at, so the service accepts it only on a paid model plan.</div></div>";
}

function trAiLogHtml() {
  const L = ATAI.log().slice().reverse();
  const rows = L.map(function (e) {
    const t = new Date(e.at).toLocaleTimeString(), dir = e.dir === "out" ? "sent" : e.dir === "in" ? "received" : e.dir === "tool" ? "ran here" : "note";
    const what = e.dir === "tool" ? escapeHtml(e.tool + "(" + JSON.stringify(e.args || {}) + ") - " + e.tier) : e.dir === "info" ? escapeHtml(e.note) : escapeHtml((e.task || "") + (e.bytes ? ", " + e.bytes + " bytes" : "") + (e.provider ? ", answered by " + e.provider : "") + (e.error ? ", " + e.error : ""));
    const body = e.body ? "<details><summary class='muted small'>show</summary><pre class='tr-ai-pre'>" + escapeHtml(e.body.length > 3000 && e.task !== "decide" ? e.body.slice(0, 3000) + " ..." : e.body) + "</pre></details>" : "";
    return "<tr><td>" + escapeHtml(t) + "</td><td>" + dir + "</td><td>" + what + body + "</td></tr>";
  }).join("");
  return "<details class='tr-ai-log'><summary><b>What was sent</b> <span class='muted small'>" + L.filter(function (e) { return e.dir === "out"; }).length + " requests in this log</span></summary>" +
    "<div class='muted small'>Every request to the AI service and every answer, newest first. Tools run on this device and send nothing by themselves; their results go out with the next request.</div>" +
    "<div class='tr-sample'><table class='adm'><thead><tr><th>Time</th><th></th><th>What</th></tr></thead><tbody>" + (rows || "<tr><td colspan='3' class='muted small'>Nothing yet.</td></tr>") + "</tbody></table></div>" +
    "<div class='tr-btns'><button data-ai='export-log'>Download the log</button> <button data-ai='clear-log'>Clear the log</button> <button data-ai='revoke'>Turn the assistant off</button></div></details>";
}

function trAiMsgHtml(m) {
  if (m.role === "user") return "<div class='tr-ai-msg user'>" + trAiText(m.text) + "</div>";
  if (m.error) return "<div class='tr-ai-msg err'>" + trAiText(m.error) + "</div>";
  const adopted = {};
  (TR.commitments || []).forEach(function (c) { if (c.status === "active") adopted[c.ruleId] = 1; });
  const used = m.results.map(function (r) { return r.tool + (r.args && r.args.id ? " " + r.args.id : ""); });
  return "<div class='tr-ai-msg bot'>" + trAiText(m.answer) +
    (m.unmatched && m.unmatched.length ? "<div class='tr-msg tr-warn'>Some numbers in this answer could not be found in your results: " + escapeHtml(m.unmatched.join(", ")) + ". Treat them with care.</div>" : "") +
    (m.notMatched && m.notMatched.length ? "<div class='tr-msg tr-warn'>The assistant proposed " + escapeHtml(m.notMatched.join(", ")) + ", but it could not be turned into a card. Ask again with the stock's ticker.</div>" : "") +
    (m.actions || m.proposals.map(function (p) { return Object.assign({ type: "adopt_rule" }, p); })).map(function (a, i) { return trAiActionHtml(m, a, i, adopted); }).join("") +
    "<div class='muted small'>Based on: " + escapeHtml(used.join(", ") || "nothing") + (m.steps ? " | " + m.steps + (m.steps === 1 ? " step" : " steps") : "") + (m.usage ? " | requests today: " + m.usage.used + " of " + m.usage.cap : "") + "</div>" +
    "<details><summary class='muted small'>Show the results this answer is based on</summary><pre class='tr-ai-pre'>" + escapeHtml(JSON.stringify(m.results.map(function (r) { return { tool: r.tool, args: r.args, result: r.result }; }), null, 1)) + "</pre></details></div>";
}

// A proposed action as a card. Nothing happens until the user clicks its button (tier T1).
function trAiActionHtml(m, a, i, adopted) {
  const idx = TR.ai.msgs.indexOf(m), done = m.done && m.done[i], btn = function (label) { return done ? "<span class='tr-chip st-solid'>" + escapeHtml(done) + "</span>" : "<button class='tr-primary' data-ai='act' data-m='" + idx + "' data-i='" + i + "'>" + label + "</button>"; };
  const pts = function (x) { return x == null ? "-" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + " pts"; };
  if (a.type === "adopt_rule") return "<div class='tr-rule tr-act'><div class='tr-rule-head'><span class='tr-act-kind'>Proposed: adopt a rule</span> " + trVerdictChip(a.verdict) + "</div><div class='tr-rule-text'><b>" + escapeHtml(a.title) + ".</b> " + escapeHtml(a.rule) + "</div>" +
    (a.inShort ? "<div class='tr-rule-do'>In short: <b>" + escapeHtml(a.inShort) + "</b></div>" : "") + "<div class='tr-btns'>" + (adopted[a.id] && !done ? "<span class='tr-chip st-solid'>Adopted</span>" : btn("Adopt this rule")) + "</div></div>";
  if (a.type === "retire_rule") return "<div class='tr-rule tr-act'><div class='tr-rule-head'><span class='tr-act-kind'>Proposed: retire a rule</span></div><div class='tr-rule-text'>" + escapeHtml(a.rule) + "</div><div class='tr-btns'>" + btn("Retire it") + "</div></div>";
  if (a.type === "retune_rule") return "<div class='tr-rule tr-act'><div class='tr-rule-head'><span class='tr-act-kind'>Proposed: a different setting</span></div><div class='tr-rule-text'><b>" + escapeHtml(a.title) + ".</b> " + escapeHtml(a.rule) + "</div>" +
    "<div class='tr-rule-ev'>This setting over your whole history: flags " + a.wholeHistory.flagged + " of " + a.wholeHistory.n + ", worth " + pts(a.wholeHistory.mean) + " each; over the later half alone: " + a.laterHalf.flagged + " of " + a.laterHalf.n + ", worth " + pts(a.laterHalf.mean) + " each (in sample, not judged on unseen trades)." +
    (a.replaces ? " It replaces your current setting of this rule." : "") + "</div><div class='tr-btns'>" + btn(a.replaces ? "Use this setting" : "Adopt with this setting") + "</div></div>";
  if (a.type === "set_reminder") return "<div class='tr-rule tr-act'><div class='tr-rule-head'><span class='tr-act-kind'>Proposed: a reminder for " + escapeHtml(a.stockLabel) + "</span></div><div class='tr-rule-text'>" + escapeHtml(a.text) + "</div>" +
    "<div class='muted small'>Shown when you check a buy of this stock before placing it.</div><div class='tr-btns'>" + btn("Set the reminder") + "</div></div>";
  if (a.type === "save_note") return "<div class='tr-rule tr-act'><div class='tr-rule-head'><span class='tr-act-kind'>Proposed: save a review note</span></div><div class='tr-rule-text'>" + escapeHtml(a.text) + "</div><div class='tr-btns'>" + btn("Save the note") + "</div></div>";
  return "";
}

// Does what the user clicked: a local write, recorded in the log as the user's decision.
async function trAiDo(mi, i) {
  const m = TR.ai.msgs[mi], a = m && m.actions && m.actions[i], now = Date.now();
  if (!a || (m.done && m.done[i])) return;
  const owner = TR.owner, coach = TR.coach, rule = coach && coach.rules.find(function (r) { return r.id === a.id; });
  let label = "Done";
  if (a.type === "adopt_rule" && rule) { await ATLedgerDB.putCommitments(owner, [ATBiases.commit(rule, now)]); label = "Adopted"; }
  else if (a.type === "retire_rule") {
    const c = (TR.commitments || []).find(function (x) { return x.id === a.commitmentId; });
    if (c) await ATLedgerDB.putCommitments(owner, [Object.assign({}, c, { status: "retired", retiredAt: now })]);
    label = "Retired";
  } else if (a.type === "retune_rule" && rule) {
    const c = ATBiases.commitTuned(TR.report, rule, a.given, now);
    if (!c) return;
    const old = a.replaces && (TR.commitments || []).find(function (x) { return x.id === a.replaces; });
    await ATLedgerDB.putCommitments(owner, [c].concat(old ? [Object.assign({}, old, { status: "retired", retiredAt: now })] : []));
    label = "Setting adopted";
  } else if (a.type === "set_reminder") { await ATLedgerDB.putCommitments(owner, [{ id: "reminder|" + now, kind: "reminder", ticker: a.ticker, text: a.text, adoptedAt: now, status: "active" }]); label = "Reminder set"; }
  else if (a.type === "save_note") { await ATLedgerDB.putCommitments(owner, [{ id: "note|" + now, kind: "note", text: a.text, adoptedAt: now, status: "active" }]); label = "Saved"; }
  else return;
  (m.done = m.done || {})[i] = label;
  ATAI.record({ dir: "info", note: "You approved: " + a.type + (a.id ? " " + a.id : "") + " (a local change, tier T1)." });
  await renderTrades();
}

// ---------- the weekly review ----------

function trAiReviewHtml() {
  const R = TR.report;
  if (!R || !self.ATTools) return "";
  const days = TR.ai.reviewDays, now = trAiNow();
  let rv;
  try { rv = ATTools.weeklyReview(trAiContext(), now - days * 86400000, now, nameOf); } catch (e) { return ""; }
  const a = rv.attention, tr = rv.trades, delta = function (x, y) { return y ? (x >= y ? "+" : "") + Math.round((x / y - 1) * 100) + "%" : "new"; };
  const li = function (t) { return "<li>" + t + "</li>"; };
  // the first few, and "and N more" that opens to the rest
  const some = function (list, max) {
    return list.length <= max ? list.join(", ") : list.slice(0, max).join(", ") + " <details class='tr-more'><summary>and " + (list.length - max) + " more</summary>" + list.slice(max).join(", ") + "</details>";
  };
  let b = "<div class='tr-rv-stats'><div class='stat'><b>" + a.views + "</b>views <span class='muted small'>" + delta(a.views, a.viewsBefore) + "</span></div><div class='stat'><b>" + a.minutes + "</b>minutes <span class='muted small'>" + delta(a.minutes, a.minutesBefore) + "</span></div>" +
    "<div class='stat'><b>" + a.stocks + "</b>stocks</div><div class='stat'><b>" + (a.positiveCalls.length + a.negativeCalls.length) + "</b>calls</div></div><ul class='tr-list'>";
  if (a.top.length) b += li("<b>Most looked at:</b> " + a.top.map(function (x) { return escapeHtml(x.stock) + " " + x.views + (x.before ? " <span class='muted small'>(" + x.before + " before)</span>" : " <span class='muted small'>(new)</span>"); }).join(", "));
  if (a.spikes.length) b += li("<b>Sudden interest:</b> " + a.spikes.map(function (x) { return escapeHtml(x.stock); }).join(", ") + ". Spikes like this have come before your buys; give them a day.");
  if (a.newStocks.length) b += li("<b>First looks:</b> " + some(a.newStocks.map(escapeHtml), 6));
  if (a.heldNotLookedAtFor30Days.length) b += li("<b>Held, not looked at for 30 days:</b> " + some(a.heldNotLookedAtFor30Days.map(escapeHtml), 6));
  b += li(tr.tradesEndBeforeThePeriod ? "<b>Trades:</b> your imported trades end before this period; import a newer file to see them here." : "<b>Trades:</b> " + tr.buys + " buys, " + tr.sells + " sales" + (tr.buys ? ", " + Math.round(tr.researchedShare * 100) + "% researched, " + Math.round(tr.impulseShare * 100) + "% on impulse" : ""));
  b += "</ul>";
  if (rv.rules.length) {
    // the same active rules weeklyReview used, in the same order, to say when each break happened (dates stay on this device)
    const ctx = trAiContext(), acts = (ctx.commitments || []).filter(function (x) { return x.status === "active" && !x.kind; });
    b += "<h5 class='tr-rv-h'>Your rules</h5><ul class='tr-rv-rules'>" + rv.rules.map(function (x, k) {
      const name = escapeHtml(x.inShort || x.rule);
      if (!x.broken) return "<li class='ok'><span class='tr-rv-mark ok' aria-label='Kept'>&#10003;</span><div><b>" + name + "</b> <span class='muted small'>kept</span></div></li>";
      let when = "";
      try {
        when = some(ATBiases.brokenIn(acts[k], ctx.R, now - days * 86400000, now).map(function (u) { return escapeHtml(u.ticker ? nameOf(u.ticker) : "a stock") + " (" + trDate(u.t) + ")"; }), 5);
      } catch (e) { when = ""; }
      return "<li class='bad'><span class='tr-rv-mark bad' aria-label='Broken'>&#10007;</span><div><b>" + name + "</b> <span class='muted small'>broken " + x.broken + (x.broken === 1 ? " time" : " times") + "</span>" +
        "<div class='muted small'>Why it counts: your rule says \"" + escapeHtml(x.rule) + "\" and " + (x.broken === 1 ? "this decision" : "these decisions") + " did what it warns against" + (when ? ": " + when : "") + ".</div></div></li>";
    }).join("") + "</ul>";
  }
  return "<div class='tr-review'>" +
    "<div class='tr-tog-row'>" + trToggle("ai-review", [["7", "7 days"], ["30", "30 days"]], String(days)) + (ATAI.consent() ? " <button class='tr-chipbtn' data-ai='chip' data-q='Review my " + (days === 7 ? "week" : "last " + days + " days") + "'>Ask about it</button>" : "") + "</div>" + b + "</div>";
}

function trAiNamesHtml() {
  return "<label class='tr-ai-names muted small'><input type='checkbox' data-ai-names" + (TR.ai.names ? " checked" : "") + "> Use my real stock names (reveals which stocks you hold and look at; accepted only on a paid model plan)</label>";
}

function trAiChatHtml() {
  const a = TR.ai;
  return "<div class='tr-ai-chat'><div class='tr-ai-msgs'>" +
    (a.msgs.length ? a.msgs.map(trAiMsgHtml).join("") : "<div class='muted small'>Ask about your habits in your own words. It answers from your results and says when they do not cover the question. This is a description of your habits, not investment advice. <a href='#' data-ai='how'>How it works</a></div>") + "</div>" +
    (a.busy ? "<div class='muted small tr-ai-step'>" + escapeHtml(a.step) + "</div>" : "") +
    "<div class='tr-ai-chips'>" + TR_AI_CHIPS.map(function (c) { return "<button class='tr-chipbtn' data-ai='chip' data-q='" + escapeHtml(c) + "'" + (a.busy ? " disabled" : "") + ">" + escapeHtml(c) + "</button>"; }).join("") + "</div>" +
    "<div class='tr-ai-form'><input id='tr-ai-q' type='text' maxlength='400' placeholder='Ask about your habits' aria-label='Your question'" + (a.busy ? " disabled" : "") + ">" +
    "<button class='tr-primary' data-ai='ask'" + (a.busy ? " disabled" : "") + ">Ask</button></div>" + trAiNamesHtml() + trAiLogHtml() + "</div>";
}

function trAiPanelBody() { return (ATAI.consent() ? trAiChatHtml() : trAiConsentHtml()); }

function trAiEnsurePanel() {
  let el = document.getElementById("tr-ai-panel");
  if (el) return el;
  el = document.createElement("aside");
  el.id = "tr-ai-panel"; el.className = "tr-ai-panel"; el.hidden = true; el.setAttribute("aria-label", "Assistant");
  el.innerHTML = "<div class='tr-ai-head'><b>Assistant</b>" +
    "<button class='tr-ai-x' data-ai='close' aria-label='Close the assistant'>&times;</button></div><div id='tr-ai-body' class='tr-ai-body'></div>";
  document.body.appendChild(el);
  const fab = document.createElement("button");
  fab.id = "tr-ai-fab"; fab.className = "tr-ai-fab tr-primary"; fab.hidden = true; fab.setAttribute("data-ai", "open"); fab.textContent = "Assistant";
  document.body.appendChild(fab);
  const rv = document.createElement("aside");
  rv.id = "tr-rv-panel"; rv.className = "tr-rv-panel"; rv.hidden = true; rv.setAttribute("aria-label", "Weekly report");
  rv.innerHTML = "<div class='tr-ai-head'><b id='tr-rv-title'>Your week</b><button class='tr-ai-x' data-ai='rv-close' aria-label='Close the report'>&times;</button></div><div id='tr-rv-body' class='tr-ai-body'></div>";
  document.body.appendChild(rv);
  const rfab = document.createElement("button");
  rfab.id = "tr-rv-fab"; rfab.className = "tr-rv-fab tr-primary"; rfab.hidden = true; rfab.setAttribute("data-ai", "rv-open"); rfab.textContent = "Weekly report";
  document.body.appendChild(rfab);
  // the panel belongs to the Trades pane: follow its visibility
  const watch = new MutationObserver(trAiSync);
  ["main-attention"].forEach(function (id) { const n = document.getElementById(id); if (n) watch.observe(n, { attributes: true, attributeFilter: ["hidden"] }); });
  const pane = document.querySelector("[data-pane='trades']");
  if (pane) watch.observe(pane, { attributes: true, attributeFilter: ["hidden"] });
  return el;
}

function trAiVisible() {
  const root = document.getElementById("trades-root");
  return !!(root && TR.report && root.offsetParent !== null);
}

// Show or hide the panel and its button with the Trades pane, and keep its content current.
function trAiSync() {
  if (!self.ATAI) return;
  const panel = trAiEnsurePanel(), fab = document.getElementById("tr-ai-fab"), vis = trAiVisible(), was = document.body.classList.contains("tr-ai-open");
  panel.hidden = !(vis && TR.ai.open);
  fab.hidden = !vis || TR.ai.open;
  document.body.classList.toggle("tr-ai-open", vis && TR.ai.open);
  const rp = document.getElementById("tr-rv-panel"), rf = document.getElementById("tr-rv-fab");
  rp.hidden = !(vis && TR.ai.reviewPanel);
  rf.hidden = !vis || TR.ai.reviewPanel;
  // The page narrows or widens with the panel: canvases drawn at the old width would be stretched
  // and their hover positions would no longer match the data, so draw them again.
  if (was !== document.body.classList.contains("tr-ai-open")) trAiRedraw();
}

function trAiRedraw() {
  requestAnimationFrame(function () {
    if (!TR.report || !trAiVisible()) return;
    try { if (self.trDrawCharts) trDrawCharts(TR.report); if (self.trAgentDraw) trAgentDraw(); } catch (e) { /* a chart that cannot be redrawn keeps its old picture */ }
  });
}
let trAiResizeTimer = null;
window.addEventListener("resize", function () { clearTimeout(trAiResizeTimer); trAiResizeTimer = setTimeout(trAiRedraw, 150); });

function trAiReviewOpen(on) {
  TR.ai.reviewPanel = on;
  try { localStorage.setItem("at_rv_open", on ? "1" : "0"); } catch (e) { /* storage blocked */ }
  trAiRefresh();
}

function trAiOpen(on) {
  TR.ai.open = on;
  try { localStorage.setItem("at_ai_open", on ? "1" : "0"); } catch (e) { /* storage blocked */ }
  trAiRefresh();
}

function trAiRefresh() {
  if (!self.ATAI) return;
  trAiEnsurePanel();
  const body = document.getElementById("tr-ai-body");
  if (body && TR.report) {
    const q = document.getElementById("tr-ai-q"), v = q ? q.value : "", log = body.querySelector(".tr-ai-log"), open = log && log.open, focus = q && document.activeElement === q;
    body.innerHTML = trAiPanelBody();
    const q2 = document.getElementById("tr-ai-q");
    if (q2) { if (v) q2.value = v; if (focus) q2.focus(); }
    if (open && body.querySelector(".tr-ai-log")) body.querySelector(".tr-ai-log").open = true;
    const box = body.querySelector(".tr-ai-msgs");
    if (box) box.scrollTop = box.scrollHeight;
  }
  const rvb = document.getElementById("tr-rv-body");
  if (rvb && TR.report && TR.ai.reviewPanel) {
    rvb.innerHTML = trAiReviewHtml();
    const t = document.getElementById("tr-rv-title");
    if (t) t.textContent = "Your " + (TR.ai.reviewDays === 7 ? "week" : TR.ai.reviewDays + " days");
  }
  trAiSync();
}

// Called after the Trades pane has rendered.
function trAiAfterRender() { trAiEnsurePanel(); trAiRefresh(); }

// ---------- the notes written with calls (part of the AI agent's card) ----------
// The AI agent reads the notes by itself: on entering the page, every note not yet read
// is classified once (batches of 20) and the result kept on this device. Nothing is sent
// before the user has agreed to the assistant's terms.

function trAiNotesHtml(R) {
  if (!self.ATRationale) return "";
  let b = "";
  const n = TR.ai.notes;
  if (!ATAI.consent()) b = "<div class='muted small'>With the assistant on, the AI agent reads the notes you wrote with your calls: what kind of reasoning they show and how the calls turned out.</div>";
  else {
    const items = ATRationale.collect(DATA.events || []), cache = ATRationale.loadCache(), seen = {};
    const todo = items.filter(function (i) { return !cache[i.key]; }).filter(function (i) { if (seen[i.key]) return false; seen[i.key] = 1; return true; });
    if (!items.length) b = "<div class='muted small'>No call has a written reason yet. Write one in the label widget (Rationale) and the AI agent reads it here.</div>";
    else {
      if (todo.length) b += "<div>" + todo.length + " of your " + items.length + " notes " + (n.busy ? "are being read" : "are not read yet") + ": " + Math.ceil(todo.length / 20) + " request" + (Math.ceil(todo.length / 20) > 1 ? "s" : "") + " (batches of 20), each note once and never again. As they are sent:" +
        "<ul class='tr-list'>" + todo.slice(0, 3).map(function (i) { return "<li>" + escapeHtml(i.text) + "</li>"; }).join("") + (todo.length > 3 ? "<li class='muted small'>and " + (todo.length - 3) + " more</li>" : "") + "</ul>" +
        (n.busy ? "" : "<div class='tr-btns'><button data-ai='notes-run'>Read again</button></div>") + "</div>";
      const st = ATRationale.stats(R, items, cache);
      if (st.classified) b += trAiNotesStats(st);
    }
  }
  return "<div class='tr-ai-notes'><h4 class='tr-coach-sub-h'>What your own words say " + trInfo("The notes you wrote with your Positive and Negative calls, read once by the AI and sorted by the kind of reason (valuation, momentum, news, a feeling and so on) and by wording (specific, hedged, emotional). A label you pick in the page widget settles the type. It shows which kinds of reason went with better outcomes for you. A reading of the wording, not of the stock; results stay on this device.<br><br>" +
    "The AI reads each note you wrote with a call once and keeps the result on this device. The classes are a reading of the wording, not of the stock. " +
    "Outcomes are the 63-day return against the NASDAQ from the call day, as in question 5; a difference counts as clear only when its 99% range excludes zero, because many kinds of note are compared at once, and only with " + ATRationale.NEED.min + " calls on each side. A kind of note can look worse only because the rest holds the winners.", "About your own words") + "</h4>" + (n.msg ? "<div class='tr-msg'>" + escapeHtml(n.msg) + "</div>" : "") + b + "</div>";
}

// Called when the AI agent's section refreshes (shadow.js, trAgentAuto): reads what is new, once per set of notes.
function trAiNotesAuto() {
  const n = TR.ai.notes;
  if (!self.ATRationale || !ATAI.consent() || n.busy) return;
  const cache = ATRationale.loadCache(), items = ATRationale.collect(DATA.events || []), todo = items.filter(function (i) { return !cache[i.key]; });
  const key = todo.length + "|" + (todo.length ? todo[0].key : "");
  if (!todo.length || n.autoKey === key) return;
  n.autoKey = key;
  trAiNotesRun();
}

async function trAiNotesRun() {
  const n = TR.ai.notes;
  if (n.busy) return;
  n.busy = true; n.msg = ""; trAiNotesRefresh();
  const items = ATRationale.collect(DATA.events || []), cache = ATRationale.loadCache();
  try {
    const r = await ATRationale.classify(items, cache, ATAI, { onProgress: function (d, t) { n.msg = "Read " + d + " of " + t + " notes..."; trAiNotesRefresh(); } });
    n.msg = r.sent ? "Read " + r.sent + " notes." : "";
  } catch (e) { n.msg = "Stopped: " + (e && e.message || e) + " What was read so far is kept."; }
  ATRationale.saveCache(cache); // also after a failed batch: the notes done so far are not sent again
  n.busy = false; trAiNotesRefresh();
}

function trAiNotesRefresh() { if (self.trAgentRefresh) trAgentRefresh(); }

function trAiNotesStats(st) {
  const rows = st.features.filter(function (f) { return f.count > 0; }).map(function (f) {
    const cmp = f.nSmall >= ATRationale.NEED.min && f.diff ? "<td>" + trPct(f.meanWith, true) + " (" + f.nWith + ")</td><td>" + trPct(f.meanWithout, true) + " (" + f.nWithout + ")</td><td>" + trPts(f.diff.est) + " <span class='muted small'>" + trRange(f.diff, trPts) + "</span>" + (f.clear ? " <span class='tr-chip st-solid'>clear</span>" : "") + "</td>"
      : "<td colspan='3' class='muted small'>too few calls to compare (" + f.nWith + " with, " + f.nWithout + " without; " + ATRationale.NEED.min + " needed on each side)</td>";
    return "<tr><td>" + escapeHtml(f.label) + "</td><td>" + f.count + "</td>" + cmp + "</tr>";
  }).join("");
  return "<div class='muted small'>" + st.classified + " notes analysed, " + st.withOutcome + " of them on calls with a 3-month result." + (st.mixed ? " " + st.mixed + " read the opposite way to their label (for example a Positive call with a bearish note)." : "") + "</div>" +
    "<table class='an-table tr-dose'><thead><tr><th>Kind of note</th><th>Notes</th><th>With: 3 months vs NASDAQ</th><th>Without</th><th>Difference (99% range)</th></tr></thead><tbody>" + rows + "</tbody></table>";
}

async function trAiAsk(question) {
  const a = TR.ai;
  if (a.busy || !question) return;
  a.open = true;
  a.busy = true; a.step = "Starting..."; a.msgs.push({ role: "user", text: question });
  trAiRefresh();
  try {
    // the agents' saved decisions are read by the assistant's tools: have them loaded even if the Trades page has not been opened
    if (self.trAgentEnsure) { try { await trAgentEnsure(); } catch (e) { /* the tool then says it has no record */ } }
    const r = await ATAI.ask(question, trAiContext(), { names: a.names, onStep: function (s) { a.step = s; trAiRefresh(); } });
    a.msgs.push({ role: "bot", answer: r.answer, unmatched: r.unmatched, notMatched: r.notMatched, proposals: r.proposals, actions: r.actions, results: r.results, steps: r.steps, usage: r.usage });
  } catch (e) {
    a.msgs.push({ role: "bot", error: e && e.message || "The assistant could not answer." });
  } finally { a.busy = false; trAiRefresh(); }
}

// One listener for the page and the panel: both carry data-ai attributes.
document.addEventListener("click", async function (ev) {
  const el = ev.target.closest("[data-ai]");
  if (!el) return;
  ev.preventDefault();
  const act = el.getAttribute("data-ai");
  if (act === "act") { await trAiDo(+el.getAttribute("data-m"), +el.getAttribute("data-i")); return; }
  if (act === "rv-open") trAiReviewOpen(true);
  else if (act === "rv-close") trAiReviewOpen(false);
  else if (act === "open") trAiOpen(true);
  else if (act === "close") trAiOpen(false);
  else if (act === "consent") { ATAI.grant(); trAiRefresh(); if (self.trAgentRefresh) trAgentRefresh(); }
  else if (act === "revoke") { ATAI.revoke(); TR.ai.msgs = []; trAiRefresh(); if (self.trAgentRefresh) trAgentRefresh(); }
  else if (act === "ask") { const q = document.getElementById("tr-ai-q"); const v = q ? q.value.trim() : ""; if (q) q.value = ""; trAiAsk(v); }
  else if (act === "chip") trAiAsk(el.getAttribute("data-q"));
  else if (act === "clear-log") { ATAI.clearLog(); trAiRefresh(); }
  else if (act === "export-log") {
    const url = URL.createObjectURL(new Blob([ATAI.exportLog()], { type: "application/json" })), a = document.createElement("a");
    a.href = url; a.download = "stocktrails-ai-log.json"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  } else if (act === "how") {
    TR.ai.msgs.push({ role: "bot", answer: "The assistant works in three steps. 1) It is told your question (with your stocks replaced by aliases) and a list of read-only tools, and names the ones it needs. 2) Those tools run here, on this device, on your results. 3) It is given only what they returned and writes the answer; every number in it is checked against those results. It cannot see your trades, place orders or change anything.", results: [], proposals: [], unmatched: [] });
    trAiOpen(true);
  } else if (act === "notes-run") trAiNotesRun();
});
// The review's 7 / 30 days switch, and the names opt-in.
document.addEventListener("click", function (ev) {
  const tog = ev.target.closest("[data-tog='ai-review'] button[data-val]");
  if (!tog) return;
  ev.preventDefault();
  TR.ai.reviewDays = +tog.getAttribute("data-val") || 7;
  trAiRefresh();
});
document.addEventListener("change", function (ev) {
  if (!ev.target.matches || !ev.target.matches("input[data-ai-names]")) return;
  TR.ai.names = ev.target.checked;
  try { localStorage.setItem("at_ai_names", TR.ai.names ? "1" : "0"); } catch (e) { /* storage blocked */ }
  ATAI.record({ dir: "info", note: TR.ai.names ? "Real stock names turned on." : "Real stock names turned off: stocks go out as aliases." });
  trAiRefresh();
});

document.addEventListener("keydown", function (ev) {
  if (ev.key === "Enter" && ev.target && ev.target.id === "tr-ai-q") { ev.preventDefault(); const v = ev.target.value.trim(); ev.target.value = ""; trAiAsk(v); }
});
