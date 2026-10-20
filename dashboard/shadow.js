// My Habits > Trades & research > "AI agent": two agents run a
// paper portfolio next to the user. The rules agent follows the coach's rules as they
// stood at each moment (src/shadow.js, ATShadow, point in time); the AI agent is the
// model, asked through the assistant's service (ATAI.decide) when the user lets it.
// Both act only on the user's own buys and on the stocks the user looked at; nothing
// is ordered anywhere. Loaded after coach.js; implements the trades page's hooks
// trAgentHtml, trAgentAfterRender and trCheckExtra, and uses its globals (TR, DATA,
// BENCH, trPct, trPts, trDate, trInfo, escapeHtml, nameOf, tickerSymbol, isoDate,
// trackedTickers, trCoachState, drawLineCanvas, attachCanvasHover, canvasHover).
//
// Every paper decision is saved once, when first made, in IndexedDB ("agent" store of
// ATLedgerDB) and never overwritten. The AI agent is only ever asked about a moment that
// is at most 2 days old, so a model trained before that cannot know what happened next;
// older buys and looks are never sent to it, and a stored AI decision made later than
// 2 days after its moment is ignored. (The rules agent is point in time by construction.)

// The moment the bias features launched (the bias coach, 2026-10-10): the split of the
// before/after comparison. null: the first view not from a history import (the sandbox).
TR.biasLaunch = Date.UTC(2026, 9, 10);
TR.agent = { view: "trades", h: 63, lm: 3, busy: false, stop: false, msg: "", owner: null, store: [], S: null, key: null, saved: false, input: null, check: null };
try {
  TR.agent.view = localStorage.getItem("at_agent_view") === "looks" ? "looks" : "trades";
  TR.agent.h = [21, 63, 126].indexOf(+localStorage.getItem("at_agent_h")) >= 0 ? +localStorage.getItem("at_agent_h") : 63;
  TR.agent.lm = [1, 2, 3, 6, 12].indexOf(+localStorage.getItem("at_agent_lm")) >= 0 ? +localStorage.getItem("at_agent_lm") : 3;
} catch (e) { /* storage blocked */ }

// Repeat views in a burst are decided from this day on (nothing earlier): the measurement of them starts here.
const TR_REVISIT_START = Date.UTC(2026, 9, 16);
const TR_AGENT_LIVE = 2 * 86400000, TR_AGENT_BATCH = 15, TR_AGENT_H = [21, 63, 126];
const TR_AGENT_COLORS = { you: "#3ddc97", rules: "#4e9eff", ai: "#a29bfe", aiSell: "#e056fd", att: "#f1c40f", attAll: "#e056fd", nasdaq: "#8a93a6", every: "#f1c40f", bought: "#3ddc97" };
const TR_AGENT_LM = [1, 2, 3, 6, 12];
// months as the user reads them; the prices are in trading days (21 to the month)
function trAgentHLabel(h) { const m = Math.round(h / 21); return m === 12 ? "1 year" : m + (m === 1 ? " month" : " months"); }
// The lines of the looks view: the AI agent with its own selling logic needs no holding period; the others hold for the months chosen.
const TR_AGENT_ABOUT = "Paper portfolios. Both agents only act on your own buys and the stocks you looked at, place no orders, and this is not investment advice.";

// The same input the trades page analyses, with the community data when it is loaded.
function trAgentInput() {
  const tickerSym = {};
  trackedTickers().forEach(function (t) { tickerSym[t] = tickerSymbol(t); });
  const fx = {};
  Object.keys(FX).forEach(function (c) { if (FX[c] && FX[c].bars) fx[c] = FX[c].bars; });
  return { txs: TR.txs, links: TR.links, intraday: DATA.intraday || [], events: DATA.events || [], prices: TR.prices, bench: BENCH || [], tickerSymbol: tickerSym,
    customParts: TR.customParts, windowDays: TR.winDays, lagDays: TR.lagDays, now: Date.now(), community: TR.comm ? TR.comm.community : null, biasLaunch: TR.biasLaunch, fx: fx };
}

// The paper portfolios are valued in the currency of your buys at each day's rate: the daily rates of every currency the
// prices and buys are in are loaded once (dashboard.js loadFx), then the agents are worked out again with them.
function trAgentFx() {
  const A = TR.agent;
  if (A.fxBusy || typeof loadFx !== "function" || !BENCH || !BENCH.length) return;
  const need = {};
  Object.keys(TR.prices || {}).forEach(function (s) { const b = TR.prices[s]; if (b && b.currency) need[b.currency] = 1; });
  (TR.txs || []).forEach(function (x) { if (x.currency) need[x.currency] = 1; });
  // each currency is asked once per page; the agents are worked out again only when rates arrived
  A.fxTried = A.fxTried || {};
  const from = BENCH[0].date, missing = Object.keys(need).filter(function (c) { const b = ccyBase(c).cur; return b !== "USD" && !A.fxTried[b] && !(FX[b] && FX[b].from <= from); });
  if (!missing.length) return;
  missing.forEach(function (c) { A.fxTried[ccyBase(c).cur] = 1; });
  A.fxBusy = true;
  loadFx(missing, from).then(function () {
    A.fxBusy = false;
    if (missing.some(function (c) { const b = FX[ccyBase(c).cur]; return b && b.bars && b.bars.length; })) { A.fxRev = (A.fxRev || 0) + 1; trAgentRefresh(); }
  }).catch(function () { A.fxBusy = false; });
}

// A model's text names the stock by the alias of its request ("Stock 17"), a number that changes when the list of
// stocks grows; kept as "this stock", so the saved text stays true. Real names (the names option) need no change.
function trAgentUnalias(text, input) {
  if (!text) return "";
  if (!input || !input.stock || (TR.ai && TR.ai.names)) return String(text);
  return String(text).replace(new RegExp(String(input.stock).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?!\\d)", "g"), "this stock");
}

function trAgentById(list) {
  const m = Object.create(null);
  (list || []).forEach(function (d) { if (d && d.id != null) m[d.id] = d; });
  return m;
}

// The AI agent's saved decisions, for ATShadow.run.
// An answer replaced by a later one about the same moment (supersededAt, the live verdict on stock pages) is kept but no longer counts.
function trAgentAiList() { return TR.agent.store.filter(function (d) { return d.agent === "ai" && d.action !== "unsure" && !d.supersededAt && d.decidedAt - d.t <= TR_AGENT_LIVE; }); }
// The latest "unsure" answer saved for a moment: its output is kept, but it decided nothing.
function trAgentUnsureOf(id) {
  let last = null;
  TR.agent.store.forEach(function (d) { if (d.agent === "ai" && d.action === "unsure" && d.momentId === id && (!last || d.decidedAt > last.decidedAt)) last = d; });
  return last;
}

// Live vs decided after the fact, per agent, from the saved record.
function trAgentRecord() {
  const out = { rules: { live: 0, afterTheFact: 0 }, ai: { live: 0, afterTheFact: 0 } };
  TR.agent.store.forEach(function (d) {
    const o = out[d.agent];
    if (o && d.action !== "unsure" && !d.supersededAt && (d.agent === "rules" || d.decidedAt - d.t <= TR_AGENT_LIVE)) o[d.decidedAt - d.t <= TR_AGENT_LIVE ? "live" : "afterTheFact"]++;
  });
  return out;
}

// the rules you adopted in the coach: the rules agent applies them, so adopting or dropping one works it out again
function trAgentAdopted() { return (TR.commitments || []).filter(function (c) { return c.status === "active" && !c.kind; }); }
function trAgentBase() { return [TR.reportKey, TR.comm && TR.comm.community ? 1 : 0, TR.agent.fxRev || 0, trAgentAdopted().map(function (c) { return c.id; }).join(",")].join("|"); }
// True when the result for this report is worked out already (the first run takes a moment).
function trAgentReady(R) { const A = TR.agent; return !!A.S && A.for === R && A.key === trAgentBase() + "|" + trAgentAiList().length; }

// The result of ATShadow.run for the report on screen, kept until the report, the
// community data or the AI agent's decisions change. `record` is the saved record.
// The same report keeps its input, so a run after new AI decisions reuses the rules
// agent's monthly snapshots (the costly part).
function trAgentState(R) {
  if (!self.ATShadow || !R || !R.decisions) return null;
  const A = TR.agent, ai = trAgentAiList(), base = trAgentBase();
  if (!trAgentReady(R)) {
    if (!A.input || A.base !== base || A.for !== R) A.input = trAgentInput();
    A.S = ATShadow.run({ R: R, input: A.input, coach: trCoachState(R), community: A.input.community, aiDecisions: ai, commitments: trAgentAdopted(), now: A.input.now });
    A.key = base + "|" + ai.length; A.base = base; A.for = R; A.saved = false;
  }
  A.S.record = trAgentRecord();
  return A.S;
}

function trAgentRuleTitle(id) { const r = self.ATBiases && ATBiases.ruleById(id); return r ? r.title : id; }

function trAgentMoney(v, ccy) { return Math.round(v).toLocaleString() + (ccy ? " " + ccy : ""); }

// A size is a final weight (the AI agent: the stock's share of the portfolio's value after the buy; the rest stays as it is) or, for the
// rules agent and for decisions saved before weights, the share of the buy's amount that goes into the stock. o: { amount, currency, kind }
// the amount is known on this device only (a buy you made, or the one typed in the pre-trade check), never sent anywhere.
function trAgentSizeText(size, o, weight) {
  const pct = Math.round(size * 1000) / 10 + "%";
  if (weight) return trAgentWeightMoney(o, "ai") || "final weight " + pct + " of the portfolio";
  if (o && o.amount > 0) return trAgentMoney(o.amount * size, o.currency) + " of your " + trAgentMoney(o.amount, o.currency) + " buy (" + pct + ")";
  return pct + (o && o.kind === "look" ? " of a position" : " of the amount");
}

// A final weight in money (your currency), as the simulation executed it: what the agent buys with this order, comparable with the
// share of your buy the rules agent keeps, and what the whole position and the portfolio are worth then. Known for your buys only
// (o.money); a look has no money, its portfolio is a virtual 100.
function trAgentWeightMoney(o, who) {
  const m = o && o.money && o.money[who];
  if (!m || !(m.stock > 0)) return "";
  const c = o.money.ccy, same = o.amount > 0 && o.currency === c;
  return "final weight " + trAgentPct(m.target) + " of the portfolio (a " + trAgentMoney(m.stock, c) + " position" + (m.value > 0 ? " in a " + trAgentMoney(m.value, c) + " portfolio" : "") + "): " +
    (m.bought > 0.5 ? "buys about " + trAgentMoney(m.bought, c) + (same ? ", " + Math.round(m.bought / o.amount * 100) + "% of your " + trAgentMoney(o.amount, c) + " buy" : "") : "buys nothing more");
}
// A buy whose instrument is not matched to a stock has no ticker: its name from your file, else its ISIN, else the broker's symbol.
function trAgentInstName(inst) {
  const l = inst && TR.links && TR.links[inst];
  return l ? l.name || l.isin || l.brokerSymbol || "-" : inst || "-";
}
// The stock cell: its name, and for an unmatched instrument a link to Matched stocks to give it a ticker.
function trAgentStockCell(x) {
  return escapeHtml(x.stock) + (x.inst && TR.links && TR.links[x.inst] ? " <a href='#' class='small' data-agent='assign' data-inst='" + escapeHtml(x.inst) + "'>assign a ticker</a>" : "");
}
function trAgentMoneyOf(id) {
  const S = TR.agent.S, A = S && S.agents, m = A && A.trades && A.trades.money;
  return m && (m.ai || m.rules) ? { ccy: A.currency, ai: m.ai && m.ai["ai" + id] || null, rules: m.rules && m.rules["rules" + id] || null } : null;
}

// When the order of a decision on your buy was placed in the simulation: on the day it waited for, how many days after the moment, and at what
// price; or that the day it waits for has no price yet (the buy appears as soon as the price does).
function trAgentExecText(x, d, who, o) {
  if (!d || x.kind !== "trade" || d.pending || d.action === "pass" || d.action === "unsure" || d.action === "hold" || d.action === "sell" || !o || !o.money) return "";
  const m = o.money[who];
  if (!m) return d.days ? "<div class='muted small'>Not bought yet: the day it waits for (" + d.days + " trading days after the moment) has no price yet.</div>" : "";
  const cal = Math.round((Date.parse(m.date) - Date.parse(x.date)) / 86400000);
  const p2 = function (v) { return (Math.round(v * 100) / 100).toLocaleString() + " " + escapeHtml(o.money.ccy || ""); };
  // against the price on the day of the moment (your buy), to see whether waiting paid off
  const diff = d.days && m.ref > 0 ? (m.price / m.ref - 1) * 100 : null;
  return "<div class='muted small'>Bought " + escapeHtml(m.date) + (d.days ? ", " + d.days + " trading days (" + cal + " calendar days) after the moment" : ", on the day of the moment") + ", at " + p2(m.price) +
    (diff != null ? " against " + p2(m.ref) + " on the day of the moment: " + (diff < 0 ? "waiting paid off by " + Math.abs(diff).toFixed(1) + "%" : diff > 0 ? "waiting cost " + diff.toFixed(1) + "%" : "no difference") : "") + ".</div>";
}

function trAgentActText(d, o) {
  if (!d) return "<span class='muted small'>-</span>";
  if (d.pending) return "still waiting";
  if (d.action === "hold") return "do nothing";
  if (d.action === "sell") return "sell " + Math.round((d.size || 1) * 100) + "% of the position";
  const w = d.sizeUnit === "weight", look = o && o.kind === "look";
  // on a look there is no amount: an AI decision saved before weights counts as 5% times its share; the rules agent keeps a share of the weight
  // the attention basket gives the stock
  const lw = !w && look && d.action !== "pass" && d.size != null && !Array.isArray(d.rules) ? 0.05 * d.size : null;
  const rs = !w && look && d.action !== "pass" && d.size != null && d.size < 1 && Array.isArray(d.rules) ? ", " + Math.round(d.size * 100) + "% of the basket weight" : null;
  // on your own buys both agents are sized the same way: a final weight in the portfolio, then what that means in money against your trade
  const wm = o && o.kind === "trade" && d.action !== "pass" ? trAgentWeightMoney(o, Array.isArray(d.rules) ? "rules" : "ai") : "";
  const sz = wm ? ", " + wm : rs != null ? rs : lw != null ? ", weight " + Math.round(lw * 1000) / 10 + "% of the portfolio" : d.action !== "pass" && d.size != null && (w || d.size < 1) ? ", " + trAgentSizeText(d.size, o, w) : "";
  return escapeHtml(d.action === "buy" ? "buy" + sz : d.action === "wait" ? "wait " + d.days + (d.days === 1 ? " day" : " days") + sz : "pass");
}

function trAgentPct(v) { return v == null ? "-" : Math.round(v * 1000) / 10 + "%"; }
function trAgentCi(x) { return x && x.lo != null ? " <span class='muted small'>(99% range " + trPts(x.lo) + " to " + trPts(x.hi) + ")</span>" : ""; }

// ---------- the section ----------

function trAgentLegend(keys, labels) {
  return "<div class='tr-legend muted small'>" + keys.map(function (k, i) { return "<span><i style='background:" + TR_AGENT_COLORS[k] + "'></i>" + labels[i] + "</span>"; }).join("") + "</div>";
}

// Every decision of both agents, newest first: the moments with an AI decision, always, and the
// 10 latest others; the button "All decisions side by side" lists them all. A look of the last 2 days that waits for
// its closing price is not a candidate yet, but its AI decision is saved and is listed here.
function trAgentRows(S) {
  const rules = trAgentById(S.trades.rules.concat(S.looks.rules)), ai = trAgentById(trAgentAiList());
  const cands = S.trades.candidates.concat(S.looks.candidates, trAgentRevisits()), have = {};
  const rows = cands.map(function (c) {
    have[c.id] = 1;
    return { id: c.id, t: c.t, ticker: c.ticker || null, stock: c.ticker ? nameOf(c.ticker) : trAgentInstName(c.inst), inst: c.ticker ? null : c.inst || null, date: c.date, kind: c.kind, r: rules[c.id] || null, a: ai[c.id] || null, amount: c.amount, currency: c.currency, did: c.kind === "look" ? (c.bought ? "bought within 30 days" : "did not buy") : c.kind === "revisit" ? "-" : "bought", pending: false };
  });
  Object.keys(ai).forEach(function (id) {
    const d = ai[id];
    if (!have[id]) rows.push({ id: id, t: d.t, ticker: d.ticker || null, stock: d.ticker ? nameOf(d.ticker) : "-", date: isoDate(d.t), kind: d.kind, r: null, a: d, did: "-", pending: d.kind === "look" });
  });
  // a moment of the last 2 days with no AI decision because the assistant is off
  if (self.ATAI && !ATAI.consent()) rows.forEach(function (x) { if (!x.a && !x.why && Date.now() - x.t <= TR_AGENT_LIVE && x.kind !== "trade") x.why = "the assistant is off"; });
  // stocks viewed in the last 7 days that have no moment at all: the AI agent column says why
  trAgentSkipped(S).forEach(function (x) { rows.push({ id: "skip|" + x.ticker, t: x.t, stock: x.name, date: x.date, kind: "view", r: null, a: null, why: x.why, did: "-", pending: false }); });
  return rows.sort(function (a, b) { return b.t - a.t; });
}

// What the rules agent measured at the moment, in words (the features kept with its decision).
function trAgentFeaturesText(f) {
  if (!f) return "";
  const pc = function (v) { return Math.round(v * 100) + "%"; }, out = [];
  if (f.runup30 != null) out.push((f.runup30 >= 0 ? "up " : "down ") + pc(Math.abs(f.runup30)) + " in the 30 days before");
  if (f.volPercentile != null) out.push("market volatility at the " + Math.round(f.volPercentile * 100) + "th percentile");
  if (f.ret20Percentile != null) out.push("market 20-day return at the " + Math.round(f.ret20Percentile * 100) + "th percentile");
  if (f.views30 != null) out.push(f.views30 + (f.views30 === 1 ? " view" : " views") + " in the 30 days before");
  if (f.hoursSinceFirstLook != null) out.push("first look " + (f.hoursSinceFirstLook < 48 ? Math.round(f.hoursSinceFirstLook) + " h" : Math.round(f.hoursSinceFirstLook / 24) + " d") + " before");
  if (f.sizeVsUsualBuy != null) out.push(f.sizeVsUsualBuy.toFixed(1) + "x your usual buy");
  if (f.crowdRatio != null) out.push("other users' views at " + f.crowdRatio.toFixed(1) + "x the usual rate");
  if (f.lottery === true) out.push("a lottery stock");
  return out.join("; ");
}

function trAgentEngineLabel(d) {
  const e = self.ATTools && ATTools.engineOf ? ATTools.engineOf(d) : null;
  return e === "decision" ? "decision model" : e === "text" ? "text model" : e === "mock" ? "stand-in model" : "model";
}

// What each agent says about a moment, in its own cell: the action, then the reasoning that was saved with it.
function trAgentRulesCell(x, o) {
  const r = x.r;
  if (!r) return x.pending ? "<span class='muted small'>waits for the closing price</span>" : "-";
  let h = trAgentActText(r, o) + trAgentExecText(x, r, "rules", o) + (r.reason ? "<div class='muted small'>" + escapeHtml(r.reason) + "</div>" : "");
  if (r.why && r.why.length) h += "<ul class='tr-signals'>" + r.why.map(function (w) {
    return "<li>" + escapeHtml(w.reading) + " <span class='muted small'>(" + escapeHtml(w.title) + (w.role === "cap" ? ", cuts the size" : w.role === "timing" ? ", moves the order to another time of day" : ", asks to wait") + ": " + escapeHtml(w.do) + ")</span></li>";
  }).join("") + "</ul>";
  else if (!(r.rules || []).length) h += "<div class='muted small'>No rule objected, so it buys.</div>";
  const ft = trAgentFeaturesText(r.features);
  if (ft) h += "<div class='muted small'>Measured then: " + escapeHtml(ft) + (r.active ? ". " + r.active.length + (r.active.length === 1 ? " rule" : " rules") + " in force that month" : "") + ".</div>";
  return h;
}

function trAgentAiCell(x, o) {
  const a = x.a || trAgentUnsureOf(x.id);
  if (!a) return x.why ? "<span class='muted small'>no decision: " + escapeHtml(x.why) + "</span>" : "-";
  const unsure = a.action === "unsure", live = a.decidedAt != null ? (a.decidedAt - a.t <= TR_AGENT_LIVE ? (unsure ? "answered live" : "decided live") : (unsure ? "answered after the fact" : "decided after the fact")) : "";
  let h = unsure ? "<b>not sure enough</b> <span class='muted small'>(nothing decided; it asks again when more is known)</span>" : trAgentActText(a, o) + trAgentExecText(x, a, "ai", o);
  if (a.reasoning) h += "<div class='muted small'>" + escapeHtml(a.reasoning) + "</div>";
  else if (a.reason) h += "<div class='muted small'>" + escapeHtml(a.reason) + "</div>";
  if (a.trace && a.trace.odds) {
    const od = a.trace.odds, p = function (v) { return Math.round(v * 100) + "%"; };
    h += "<div class='muted small'>Odds: buy " + p(od.buy) + ", wait " + p(od.wait) + ", pass " + p(od.pass) + (od.sell != null ? ", sell " + p(od.sell) : "") + (a.trace.confidence != null ? " (confidence " + a.trace.confidence + ")" : "") + "; it acts only on a choice with at least " + p(a.trace.minP) + ".</div>";
  }
  const sz = !unsure && (a.action === "buy" || a.action === "wait") && a.size != null ? (a.sizeUnit === "weight" ? "" :
    "Size " + Math.round(a.size * 100) + "%: " + (o.amount > 0 ? trAgentMoney(o.amount * a.size, o.currency) + " of your " + trAgentMoney(o.amount, o.currency) + " buy" : x.kind === "look" ? "that share of a position" : "that share of the amount") + " goes into the stock" + (a.size < 1 ? ", the rest stays out of it" : "") + ". (Saved before sizes were weights.) ") : "";
  h += "<div class='muted small'>" + sz + escapeHtml(trAgentEngineLabel(a)) + (a.model ? ", " + escapeHtml(a.model) : "") + (live ? ", " + live : "") + ".</div>";
  if (a.input) h += "<details><summary class='muted small'>What it was shown</summary><pre class='tr-ai-pre'>" + escapeHtml(JSON.stringify(a.input, null, 1)) + "</pre></details>";
  return h;
}

function trAgentRowHtml(x) {
  const o = { amount: x.amount, currency: x.currency, kind: x.kind, money: x.kind === "trade" ? trAgentMoneyOf(x.id) : null };
  return "<tr><td>" + trAgentStockCell(x) + "</td><td>" + escapeHtml(x.date) + "</td><td>" + (x.kind === "look" ? "Look" : x.kind === "revisit" ? "Repeat view" : x.kind === "view" ? "View" : "Buy") + "</td><td>" + trAgentRulesCell(x, o) +
    "</td><td>" + trAgentAiCell(x, o) + "</td><td>" + escapeHtml(x.did) + "</td></tr>";
}

function trAgentTableHtml(rows) {
  return "<div class='tr-sample'><table class='adm'><thead><tr><th>Stock</th><th>Date</th><th>Moment</th><th>Rules agent " + trInfo("The rules agent asks one question of every buy and every first look: would the rules that held up for you (on trades they had not seen) let this go ahead now? It buys unless one objects, waits up to 10 trading days for it to pass, passes, or only cuts the size. With no rule objecting it simply buys, so most rows read buy. It is a yardstick for your own habits, not a stock picker.", "What the rules agent decides") +
    "</th><th>AI agent " + trInfo(trAgentLatestInfo(TR.agent.S, trAgentUndecided(TR.agent.S)), "About the AI agent and its decisions") + "</th><th>What you did</th></tr></thead><tbody>" + rows.map(trAgentRowHtml).join("") + "</tbody></table></div>";
}

// The explanation of the list, with the AI agent's present state worked out here.
function trAgentLatestInfo(S, todo) {
  const rec = trAgentRecord();
  return "A language model, asked through the assistant's service, decides for each of your buys and looks: buy then, wait 1 to 10 trading days and then buy, or pass, with a size share. " +
    "It sees what was known at that moment, worked out on this device: the stock as \"Stock N\" and the date as \"day N\" (real tickers and dates only with the names option of the assistant), the price path before in percent, the market, your research and calls before, the rules that held up for you by then and what the rules agent said at that moment (buy, or wait until its rules no longer apply; not how long it then waited). " +
    "No amount, ISIN, broker or account is sent. Each request asks about up to " + TR_AGENT_BATCH + " decisions and counts against the assistant's daily requests. It also reads the notes you wrote with your calls, each once.<br><br>" +
    (todo.length ? todo.length + " of your buys and looks from the last 2 days are not decided yet." : "The AI agent has decided every buy and look from the last 2 days.") + "<br>" +
    (TR.ai && TR.ai.names ? "Real stock names and dates are on (the assistant's option): requests carry tickers and dates." : "Stocks go out as \"Stock N\" and dates as \"day N\"; the names option of the assistant sends tickers and dates instead.") + "<br>" +
    "A repeat view in an unusual burst (at least 3 views in 3 days, at least twice the usual) is decided too, from 16 October on: do nothing, sell a share of the position, or buy more (or enter), with a size. A sell closes that share of the position at that day's close, a buy opens more; the AI agent's line in the looks chart follows these decisions (no fixed holding period) and is compared with the same entries held for a fixed number of months you choose.<br><br>" +
    "It decides automatically when you open this page, but only for moments at most 2 days old, so the model cannot know what happened next. It has decided " + rec.ai.live + (rec.ai.live === 1 ? " moment" : " moments") +
    " so far; for everything earlier it follows you in the portfolio, and the comparison grows as new buys and looks arrive.<br><br>" +
    "When the AI agent is not sure enough about a moment it decides nothing: no decision is recorded, and the moment is asked again when more is known.<br><br>" +
    "Size, for your buys, is a final weight of the stock in the agent's portfolio after the buy (the rules agent: your buy's weight times the share of it that it keeps), shown with what the whole position and the portfolio are worth and the money it buys, against your own buy. When the agent waits, the same weight is bought on the day it waits for, at that day's value and price. The rest of the portfolio stays as it is. Pass: the stock is not bought at all. Do nothing: the answer to a repeat view, the position stays as it is.";
}

// Why a stock viewed in the last 7 days has no AI decision: the AI agent decides a stock's first
// look or a return after 30 days without a view, one per stock and day, for moments of the last
// 2 days, with prices, once the assistant is on.
function trAgentSkipped(S) {
  const out = [];
  try {
    const R = TR.report, ctx = ATShadow.context(R, TR.agent.input), now = Date.now(), DAY = 86400000;
    const dec = trAgentById(trAgentAiList()), cand = {};
    S.looks.candidates.concat(trAgentPending(S)).forEach(function (c) { (cand[c.ticker] = cand[c.ticker] || []).push(c); });
    Object.keys(ctx.att.by).sort().forEach(function (tk) {
      const ts = ctx.att.by[tk].ts, n = ts.length;
      if (!n || now - ts[n - 1] > 7 * DAY) return;
      if ((cand[tk] || []).length) return; // it has a moment of its own: its row says what is up
      const last = ts[n - 1], prev = n > 1 ? ts[n - 2] : null, s = ctx.seriesOfTicker(tk);
      let why;
      if (prev != null && last - prev < 30 * DAY) why = "you had looked at it within the 30 days before (" + new Date(prev).toISOString().slice(0, 10) + "), so this was not a new look, and it was not an unusual burst of views";
      else if (!s || !s.length) why = "there are no prices for this stock";
      else if (now - last > 2 * DAY) why = "the look is more than 2 days old, and the AI agent never decides older moments";
      else if (self.ATAI && !ATAI.consent()) why = "the assistant is off";
      else why = "it is not decided yet";
      out.push({ name: nameOf(tk), ticker: tk, t: last, date: new Date(last).toISOString().slice(0, 10), why: why });
    });
  } catch (e) { /* no explanation then */ }
  return out;
}

function trAgentLatestHtml(S) {
  const todo = trAgentUndecided(S), A = TR.agent, rows = trAgentRows(S), decided = trAgentAiList().length;
  const mix = trAgentModelMix();
  const head = "<h4 class='tr-coach-sub-h'>Latest decisions " + trInfo(decided + " decided by the AI agent" + (mix ? " (" + escapeHtml(mix) + ")" : "") + ".<br><br>" +
    "Each row is a moment: a buy you made, a first look at a stock, or a repeat view in a burst of views. For a buy or a look both agents answer the same question: buy now, wait some days, or pass. For a repeat view: do nothing, sell or buy more. " +
    "The rules agent answers from the rules that held up for you, the AI agent from everything known at that moment.<br><br>" +
    "The table shows every moment with an AI decision and the 10 latest others. The button All decisions side by side lists every moment with what you did, the attention index, the rules agent and the AI agent.", "About the latest decisions") + "</h4>";
  let b = "";
  if (self.ATAI) {
    if (!ATAI.consent()) b += "<div class='tr-msg'>The AI agent uses the assistant's service. <a href='#' data-ai='open'>Open the assistant</a> to turn it on.</div>";
    else {
      if (todo.length || A.busy) b += "<div class='tr-btns'>" + (A.busy ? "<button data-agent='ai-stop'>Stop after this request</button>" : "<button class='tr-primary' data-agent='ai-run'>Decide " + todo.length + (todo.length === 1 ? " moment" : " moments") + " now</button>") + "</div>";
    }
  }
  if (!rows.length) return head + b + "<div class='muted small'>No buy or look to decide yet.</div>";
  b += "<div class='tr-btns'><button type='button' data-agent='cmp'>All decisions side by side</button></div>";
  const shown = rows.filter(function (x, i) { return x.a || x.why || i < 10; });
  return head + b + trAgentTableHtml(shown);
}

// Looks of the last 2 days that wait for their day's closing price (ATShadow.pendingLooks); the
// AI agent decides them live, and they become ordinary candidates when the bar arrives.
function trAgentPending(S) {
  try {
    const have = trAgentById(S.looks.candidates);
    return ATShadow.pendingLooks(TR.report, ATShadow.context(TR.report, TR.agent.input), Date.now()).filter(function (c) { return !have[c.id]; });
  } catch (e) { return []; }
}

// Repeat views in a burst, from TR_REVISIT_START on and at most 2 days old (ATShadow.pendingRevisits).
function trAgentRevisits() {
  try { return ATShadow.pendingRevisits(TR.report, ATShadow.context(TR.report, TR.agent.input), Date.now(), trAgentAiList(), TR_REVISIT_START); } catch (e) { return []; }
}

// Candidates the AI agent has not decided yet, newest first. Only moments at most 2 days
// old: for an older one the model could know the outcome, so it is never asked.
function trAgentUndecided(S) {
  const done = trAgentById(trAgentAiList()), now = Date.now();
  return S.trades.candidates.concat(S.looks.candidates, trAgentPending(S), trAgentRevisits()).filter(function (c) { return !done[c.id] && now - c.t <= TR_AGENT_LIVE; }).sort(function (a, b) { return b.t - a.t; });
}

function trAgentInner(R) {
  let S;
  try { S = trAgentState(R); } catch (e) { return "<h3 class='tr-coach-title'>AI agent</h3><div class='tr-msg'>The AI agent section could not be built: " + escapeHtml(e && e.message || e) + "</div>"; }
  if (!S) return "";
  const rec = trAgentRecord();
  return "<h3 class='tr-coach-title'>AI agent " + trInfo("Two agents run a paper portfolio next to you on the same moments, your buys and your first looks at stocks. The AI agent is a language model; the rules agent has no model in it: it applies the coach's rules as they stood at each moment: each month it keeps the rules that, fitted on your earlier trades only, held up on later ones, plus the rules you adopted (with your setting, over the whole history), and for each of your buys it buys then, waits until no rule objects (up to 10 trading days) or passes; a cap rule only cuts the size. " +
    "Money it does not put into a stock stays in cash, and when you sell it sells the same share of its position. " +
    "The rules agent's decisions use only data from before each day (tested), so they are fair even when worked out later; the AI agent only decides moments of the last 2 days. Every decision is saved once, when first made: " + rec.rules.live + " of the rules agent's " + (rec.rules.live + rec.rules.afterTheFact) + " saved decisions were made live.<br><br>" + TR_AGENT_ABOUT, "How the agents work") + "</h3>" +
    "<div id='tr-agent-latest'>" + trAgentLatestHtml(S) + "</div>" +
    "<div id='tr-agent-pp'>" + trAgentPpSection(S) + "</div>" +
    "<div id='tr-agent-notes'>" + trAgentNotesHtml() + "</div>";
}

function trAgentNotesHtml() { return self.trAiNotesHtml ? trAiNotesHtml(TR.report) : ""; }

// The "Paper portfolios" part of the section: its heading and the card with the chart.
function trAgentPpSection(S) {
  return "<h4 class='tr-coach-sub-h'>Paper portfolios " + trInfo("Your buys, or your first looks at stocks, followed by three portfolios: yours, the rules agent's and the AI agent's, against the NASDAQ and, for your attention, the attention-weighted index (a basket of what you looked at, weighted by your views in the last 30 days, decided 1 day after the views). " +
      "All are time-weighted indices, 100 on the first day shown. Every portfolio stays fully invested: money a smaller buy leaves goes into the stocks it holds, in proportion; it is cash only while nothing is held. " +
      "On your trades: each buy of yours puts its amount into every portfolio; you put all of it into the stock, which gives your buy a weight (its share of your portfolio after the buy). The rules agent buys up to that weight times its share (or waits, or passes), the AI agent up to the final weight it chose, or your weight where it has not decided; when you sell, each sells the same share of its position and the money leaves the portfolio (it paid for your later buys, which come in as their own amounts), so your bars are your positions at their market value. Your savings-plan buys are no decision for the agents: every portfolio makes them at your weight. " +
      "On your attention: each agent runs a virtual portfolio of 100 from the first look. The attention-weighted index holds what you looked at, weighted by your views in the last 30 days, decided 1 day after them; rebalanced at every close and kept when there are no views; the rules agent holds the same basket but picks its own lag: each stock only from the day its rules let the look through (a pass buys none, a cap rule cuts its weight); the AI agent buys up to the final weight it chose and sells only when its repeat-view decisions say so. " +
      "The rules agent can be run on past data (it uses only what was known then), so its line can start anywhere; the AI agent only decides moments of the last 2 days (a model could know the outcome of older ones), so its line starts with its first decision. Paper portfolios, no orders, not investment advice.", "About the paper portfolios") + "</h4>" +
    "<div class='card'>" + trAgentPpHtml(S) + "</div>";
}

// The first run takes a moment: the page shows first, trAgentAfterRender fills the section in.
function trAgentHtml(R) {
  if (!self.ATShadow || !R || !R.decisions) return "";
  return "<section class='tr-coach tr-agent-hl tr-agents' id='tr-agents'>" + (trAgentReady(R) ? trAgentInner(R)
    : "<h3 class='tr-coach-title'>AI agent</h3><div class='muted small'>Working out the agent simulation...</div>") + "</section>";
}

// ---------- where the saved decisions came from ----------

// Where the saved AI decisions came from, by engine and model (the record keeps both for every decision).
function trAgentModelMix() {
  const m = {};
  trAgentAiList().forEach(function (d) {
    const k = trAgentEngineLabel(d) + (d.model ? " " + d.model : "");
    m[k] = (m[k] || 0) + 1;
  });
  return Object.keys(m).sort(function (a, b) { return m[b] - m[a]; }).map(function (k) { return k + " " + m[k]; }).join(", ");
}

// ---------- paper portfolios: the agents against you, the attention index and the NASDAQ ----------

TR.agent.tl = { start: null, end: null };

// The day the AI agent's first saved decision was made about (its line starts there).
function trAgentAiStart(view) {
  // on your trades only decisions about trades count; the looks view counts looks and repeat views
  const ai = trAgentAiList().filter(function (d) { return view === "trades" ? d.kind === "trade" : view === "attention" ? d.kind !== "trade" : true; });
  return ai.length ? isoDate(ai.reduce(function (m, d) { return Math.min(m, d.t); }, Infinity)) : null;
}

// The lines of the chosen view on one axis of days: { dates, lines: [{ key, label, color, vals }], unit, holdings }
function trAgentPpData(S) {
  const view = TR.agent.view === "looks" ? "attention" : "trades", G = S.agents && S.agents[view];
  if (!G || !G.dates || G.dates.length < 2) return null;
  const aiStart = trAgentAiStart(view), dates = G.dates, lines = [];
  const aiLine = G.lines.ai ? G.lines.ai.map(function (v, i) { return aiStart && dates[i] >= aiStart ? v : null; }) : null;
  if (view === "trades") {
    lines.push({ key: "you", label: "You (your buys, all in the stock)", color: TR_AGENT_COLORS.you, vals: G.lines.you });
    lines.push({ key: "rules", label: "Rules agent on your buys", color: TR_AGENT_COLORS.rules, vals: G.lines.rules });
    if (aiLine) lines.push({ key: "ai", label: "AI agent on your buys", color: TR_AGENT_COLORS.ai, vals: aiLine });
  } else {
    if (G.lines.att) lines.push({ key: "att", label: "Attention-weighted index (" + ATShadow.LOOK_WINDOW + " d window, " + ATShadow.LOOK_LAG + " d lag)", color: "#f1c40f", vals: G.lines.att });
    lines.push({ key: "rules", label: "Rules agent on your looks", color: TR_AGENT_COLORS.rules, vals: G.lines.rules });
    if (aiLine) lines.push({ key: "ai", label: "AI agent on your looks", color: TR_AGENT_COLORS.ai, vals: aiLine });
  }
  lines.push({ key: "nasdaq", label: "NASDAQ", color: TR_AGENT_COLORS.nasdaq, vals: G.lines.nasdaq });
  return { dates: dates, lines: lines, aiStart: aiStart, view: view, unit: G.unit, holdings: G.holdings, beforeBench: G.beforeBench || 0 };
}

// The window the timeline selects (indexes into the axis; the whole history unless chosen), every line rebased to 100 on
// its first common day. The AI agent's line starts later (its first decision), at 100 too; its change is counted from
// there (`from`).
function trAgentPpWindow(D) {
  const tl = TR.agent.tl, n = D.dates.length, from = function (d) { const i = D.dates.findIndex(function (x) { return x >= d; }); return i < 0 ? 0 : i; };
  let a = tl.start === "ai" ? (D.aiStart ? from(D.aiStart) : 0) : tl.start && tl.start !== "all" ? from(tl.start) : 0, b = n - 1;
  if (tl.end) { for (let i = n - 1; i >= 0; i--) if (D.dates[i] <= tl.end) { b = i; break; } }
  if (b < a + 1) b = Math.min(n - 1, a + 1);
  // the other lines start together: on the first day all of them have a value
  let e = a;
  D.lines.forEach(function (l) { if (l.key === "ai") return; const f = l.vals.findIndex(function (v, i) { return i >= a && v != null; }); if (f > e) e = f; });
  const rows = D.lines.map(function (l) { const base = l.vals[e]; return Object.assign({}, l, { vals: l.vals.slice(e, b + 1).map(function (v) { return v == null || !(base > 0) ? null : v / base * 100; }) }); });
  rows.forEach(function (l) {
    if (l.key !== "ai") return;
    const src = D.lines.find(function (x) { return x.key === "ai"; }).vals.slice(e, b + 1), j = src.findIndex(function (v) { return v != null; });
    l.vals = src.map(function (v) { return v == null || j < 0 || !(src[j] > 0) ? null : v / src[j] * 100; });
    l.from = j > 0 ? j : null;
  });
  return { a: a, b: b, e: e, dates: D.dates.slice(e, b + 1), lines: rows };
}

function trAgentPpHtml(S) {
  const D = trAgentPpData(S), A = TR.agent;
  const seg = "<div class='tr-tog-row'><div class='seg tr-seg'>" + [["trades", "Your trades"], ["looks", "Your attention"]].map(function (o) {
    return "<button type='button' data-agent='view' data-val='" + o[0] + "'" + (A.view === o[0] ? " class='on'" : "") + ">" + o[1] + "</button>"; }).join("") + "</div>" +
    "</div>";
  if (!D) return seg + "<div class='tr-answer muted'>" + (A.view === "looks" ? "No first look at a stock with prices yet." : "No buy with prices to follow yet. The agents start with your first buy of a stock with a price.") + "</div>";
  const n = D.dates.length, W = trAgentPpWindow(D);
  const tl = "<div class='tr-tl'><div class='tr-tl-lab'><b id='tr-tl-from'></b> to <b id='tr-tl-to'></b>" +
    " <button type='button' data-agent='tl' data-val='all'>The whole history</button> <button type='button' data-agent='tl' data-val='ai'>From the AI agent's first decision</button> " +
      trInfo("Drag the handles to choose the period; every line is 100 on its first day." + (D.aiStart ? " The mark on the track is the AI agent's first decision (" + escapeHtml(D.aiStart) + "): its line starts there, at 100." : " The AI agent has not decided anything yet, so it has no line."), "About the timeline") + "</div>" +
    "<div class='tr-tl-track'><input type='range' id='tr-tl-a' min='0' max='" + (n - 1) + "' value='" + W.a + "' aria-label='Start of the period'><input type='range' id='tr-tl-b' min='0' max='" + (n - 1) + "' value='" + W.b + "' aria-label='End of the period'>" +
    (D.aiStart ? "<i class='tr-tl-mark' style='left:" + (D.dates.findIndex(function (d) { return d >= D.aiStart; }) / (n - 1) * 100) + "%' title='The AI agent's first decision'></i>" : "") + "</div>" +
    "</div>";
  return seg + tl + "<div id='tr-pp-body'>" + trAgentPpBody(D, W) + "</div>";
}

// The part that follows the timeline: the chart, its legend and the table of changes.
function trAgentPpBody(D, W) {
  const last = function (l) { const v = l.vals.filter(function (x) { return x != null; }); return v.length ? (v[v.length - 1] / v[0] - 1) * 100 : null; };
  const rows = W.lines.map(function (l) { const ch = last(l); return "<tr><td><i class='tr-agent-dot' style='background:" + l.color + "'></i>" + escapeHtml(l.label) + (l.from != null ? " <span class='muted small'>(from " + escapeHtml(W.dates[l.from]) + ")</span>" : "") + "</td><td>" + (ch == null ? "-" : (ch >= 0 ? "+" : "") + ch.toFixed(1) + "%") + "</td></tr>"; }).join("");
  return "<canvas id='tr-since-chart' class='an-canvas tr-canvas tr-canvas-tall'></canvas><div id='tr-since-tip' class='muted small'></div>" +
    "<div class='tr-legend muted small'>" + W.lines.map(function (l) { return "<span><i style='background:" + l.color + "'></i>" + escapeHtml(l.label) + "</span>"; }).join("") + "</div>" +
    "<div class='tr-sample'><table class='an-table'><thead><tr><th>Change over the period</th><th>" + escapeHtml(W.dates[0]) + " to " + escapeHtml(W.dates[W.dates.length - 1]) + "</th></tr></thead><tbody>" + rows + "</tbody></table></div>" +
    (W.e > W.a ? "<div class='muted small'>The lines start on " + escapeHtml(D.dates[W.e]) + ", the first day every one of them has a value.</div>" : "") +
    (D.beforeBench ? "<div class='muted small'>" + D.beforeBench + (D.beforeBench === 1 ? " buy is" : " buys are") + " left out: made before the NASDAQ prices loaded here start.</div>" : "") +
    "<div class='tr-btns'><button type='button' data-agent='hold'>Holdings over time</button></div>";
}

function trAgentPpDraw() {
  const cv = document.getElementById("tr-since-chart"), S = TR.agent.S;
  if (!cv || !S) return;
  const D = trAgentPpData(S);
  if (!D) return;
  const W = trAgentPpWindow(D);
  const fr = document.getElementById("tr-tl-from"), to = document.getElementById("tr-tl-to");
  if (fr) fr.textContent = D.dates[W.e]; if (to) to.textContent = D.dates[W.b];
  if (W.dates.length < 2) return;
  const step = Math.max(1, Math.ceil(W.dates.length / 150)), ix = [];
  for (let i = 0; i < W.dates.length; i += step) ix.push(i);
  if (ix[ix.length - 1] !== W.dates.length - 1) ix.push(W.dates.length - 1);
  // a line that starts later (the AI agent) is drawn from its first day, where it is 100, not from the next sampled day
  W.lines.forEach(function (l) { const f = l.vals.findIndex(function (v) { return v != null; }); if (f > 0 && ix.indexOf(f) < 0) ix.push(f); });
  ix.sort(function (a, b) { return a - b; });
  const sr = W.lines.map(function (l) { return { label: l.label, color: l.color, dots: true, vals: ix.map(function (i) { return l.vals[i] == null ? null : Math.round(l.vals[i] * 10) / 10; }) }; });
  drawLineCanvas(cv, "tr-since-tip", sr, ix.map(function (i, j) { return j % Math.ceil(ix.length / 6) === 0 ? W.dates[i].slice(2, 7) : ""; }), ix.map(function (i) { return W.dates[i]; }));
  canvasHover[cv.id].html = ix.map(function (i, j) {
    return "<b>" + escapeHtml(W.dates[i]) + "</b>" + sr.filter(function (s) { return s.vals[j] != null; }).sort(function (a, b) { return b.vals[j] - a.vals[j]; })
      .map(function (s) { return "<br><span style='color:" + s.color + "'>&#9632;</span> " + escapeHtml(s.label) + " " + s.vals[j].toFixed(1); }).join("");
  });
  attachCanvasHover(cv);
}

// The timeline moved: only the chart and the table change, the rest of the section stays.
function trAgentPpRedraw() {
  const S = TR.agent.S, body = document.getElementById("tr-pp-body");
  if (!S || !body) return;
  const D = trAgentPpData(S);
  if (!D) return;
  body.innerHTML = trAgentPpBody(D, trAgentPpWindow(D));
  trAgentPpDraw();
}

document.addEventListener("input", function (ev) {
  const el = ev.target;
  if (!el || (el.id !== "tr-tl-a" && el.id !== "tr-tl-b")) return;
  const S = TR.agent.S, D = S && trAgentPpData(S);
  if (!D) return;
  let a = +document.getElementById("tr-tl-a").value, b = +document.getElementById("tr-tl-b").value;
  if (a >= b) { if (el.id === "tr-tl-a") a = Math.max(0, b - 1); else b = Math.min(D.dates.length - 1, a + 1); document.getElementById("tr-tl-a").value = a; document.getElementById("tr-tl-b").value = b; }
  TR.agent.tl = { start: D.dates[a], end: D.dates[b] };
  trAgentPpRedraw();
});

// ---------- every decision side by side ----------
// One row per moment (a buy of yours, a first look, a repeat view), oldest decisions included: what you did, what the
// attention-weighted index held of the stock then (its share of the views in the window before), and what each agent decided
// and why, so the decisions can be checked against each other at the same point in time.

function trAgentLb(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }

// The attention-weighted index at the moment: the stock's share of the views of the LOOK_WINDOW days up to LOOK_LAG days before.
function trAgentIndexData(ctx, x) {
  if (!ctx || !x.ticker) return null;
  const DAY = 86400000, t0 = x.t - ATShadow.LOOK_LAG * DAY, from = t0 - ATShadow.LOOK_WINDOW * DAY;
  let mine = 0, total = 0, stocks = 0;
  Object.keys(ctx.att.by).forEach(function (k) {
    const ts = ctx.att.by[k].ts, c = trAgentLb(ts, t0 + 1) - trAgentLb(ts, from + 1);
    if (c > 0) { stocks++; total += c; }
    if (k === x.ticker) mine = c;
  });
  return { mine: mine, total: total, stocks: stocks };
}

function trAgentIndexCell(ctx, x) {
  const ix = trAgentIndexData(ctx, x);
  if (!ix) return "<span class='muted small'>-</span>";
  const mine = ix.mine, total = ix.total, stocks = ix.stocks;
  if (!mine) return "not in the index<div class='muted small'>no views in the " + ATShadow.LOOK_WINDOW + " days before" + (total ? " (" + stocks + " other stocks were)" : "") + "</div>";
  return "<b>" + trAgentPct(mine / total) + "</b> of the index<div class='muted small'>" + mine + " of " + total + " views in the " + ATShadow.LOOK_WINDOW + " days before, " + stocks + " stocks in all</div>";
}

const TR_CMP_KIND = { trade: "Your buy", look: "First look", revisit: "Repeat view" };

function trAgentCmpRows(S) {
  return trAgentRows(S).filter(function (x) { return x.kind !== "view" && (x.r || x.a || x.kind === "trade" || x.kind === "look"); });
}

function trAgentCmpBody() {
  const S = TR.agent.S, f = TR.agent.cmpF || "all";
  if (!S) return "<div class='muted small'>Not available yet.</div>";
  let ctx = null;
  try { ctx = ATShadow.context(TR.report, TR.agent.input); } catch (e) { ctx = null; }
  const all = trAgentCmpRows(S), differ = function (x) { return x.r && x.a && x.a.action !== "unsure" && (x.r.action !== x.a.action || (x.r.action === "wait" && x.r.days !== x.a.days)); };
  const rows = all.filter(function (x) { return f === "differ" ? differ(x) : f === "trade" ? x.kind === "trade" : f === "look" ? x.kind === "look" || x.kind === "revisit" : true; });
  const seg = [["all", "All (" + all.length + ")"], ["differ", "Where the agents differ (" + all.filter(differ).length + ")"], ["trade", "Your buys"], ["look", "Looks and repeat views"]].map(function (o) {
    return "<button type='button' data-agent='cmp-f' data-val='" + o[0] + "'" + (f === o[0] ? " class='on'" : "") + ">" + o[1] + "</button>"; }).join("");
  const body = rows.map(function (x) {
    const o = { amount: x.amount, currency: x.currency, kind: x.kind, money: x.kind === "trade" ? trAgentMoneyOf(x.id) : null };
    const ai = trAgentAiCell(x, o).replace(/<details>[\s\S]*?<\/details>/g, "");
    return "<tr" + (differ(x) ? " class='tr-cmp-diff'" : "") + "><td>" + escapeHtml(x.date) + "</td><td>" + trAgentStockCell(x) + "</td><td>" + (TR_CMP_KIND[x.kind] || escapeHtml(x.kind)) + "</td>" +
      "<td>" + escapeHtml(x.kind === "trade" && x.amount > 0 ? "bought " + trAgentMoney(x.amount, x.currency) : x.did) + "</td>" +
      "<td>" + trAgentIndexCell(ctx, x) + "</td><td>" + trAgentRulesCell(x, o) + "</td><td>" + ai + "</td></tr>";
  }).join("");
  return "<div class='tr-tog-row'><div class='seg tr-seg'>" + seg + "</div></div>" +
    "<div class='tr-sample'><table class='adm tr-cmp'><thead><tr><th>Date</th><th>Stock</th><th>Moment</th><th>You</th><th>Attention index " +
    trInfo("What the attention-weighted index held of this stock at that moment: the stock's share of your views in the " + ATShadow.LOOK_WINDOW + " days up to " + ATShadow.LOOK_LAG + " day before. A buy of a stock the index did not hold shows it was not backed by your attention then.", "About the attention index column") +
    "</th><th>Rules agent</th><th>AI agent</th></tr></thead><tbody>" + (body || "<tr><td colspan='7' class='muted small'>No moment in this list.</td></tr>") + "</tbody></table></div>";
}

// Every moment as one CSV row, for studying the agents or tuning a model on this device: what you did, the attention index's share of the
// stock then, both agents' decisions with their sizes, weights, money, execution day and delay, the model that decided, and the excess return
// against the NASDAQ per buy over 21, 63 and 126 trading days (blank until that many days exist). Nothing leaves the device.
function trAgentCmpCsv() {
  const S = TR.agent.S;
  if (!S) return;
  let ctx = null;
  try { ctx = ATShadow.context(TR.report, TR.agent.input); } catch (e) { ctx = null; }
  const rules = trAgentById(S.trades.rules.concat(S.looks.rules)), ai = trAgentById(S.trades.ai.concat(S.looks.ai));
  const q = function (v) { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s; };
  const day = function (v) { return Math.round(v * 1000) / 1000; };
  const cols = ["date", "stock", "ticker", "moment", "you_amount", "you_currency", "index_share_of_views", "index_views_of_stock", "index_views_total"];
  ["rules", "ai"].forEach(function (w) {
    ["action", "wait_days", "size", "final_weight", "money_bought", "position_money", "portfolio_money", "executed_on", "executed_calendar_days_after", "executed_price", "moment_price", "price_change_vs_moment_pct"].forEach(function (c) { cols.push(w + "_" + c); });
  });
  cols.push("ai_size_unit", "ai_engine", "ai_model", "ai_decided_live");
  [21, 63, 126].forEach(function (h) { ["you", "rules", "ai"].forEach(function (w) { cols.push("excess_" + h + "d_" + w); }); });
  const lines = [cols.join(",")];
  trAgentCmpRows(S).forEach(function (x) {
    const money = x.kind === "trade" ? trAgentMoneyOf(x.id) : null, ix = trAgentIndexData(ctx, x), r = x.r, a = x.a, rr = rules[x.id], ar = ai[x.id];
    const row = [x.date, x.stock, x.ticker || "", x.kind, x.kind === "trade" ? x.amount : "", x.kind === "trade" ? x.currency : "", ix && ix.total ? day(ix.mine / ix.total) : "", ix ? ix.mine : "", ix ? ix.total : ""];
    [["rules", r], ["ai", a && a.action !== "unsure" ? a : null]].forEach(function (p) {
      const d = p[1], m = money && money[p[0]];
      row.push(d ? d.action : "", d && d.action === "wait" ? d.days : "", d && d.size != null ? d.size : "", m ? day(m.target) : "", m ? Math.round(m.bought) : "", m ? Math.round(m.stock) : "", m ? Math.round(m.value) : "",
        m ? m.date : "", m ? Math.round((Date.parse(m.date) - Date.parse(x.date)) / 86400000) : "", m ? Math.round(m.price * 100) / 100 : "",
        m && m.ref > 0 ? Math.round(m.ref * 100) / 100 : "", m && m.ref > 0 ? Math.round((m.price / m.ref - 1) * 1000) / 10 : "");
    });
    row.push(a ? a.sizeUnit || "" : "", a ? trAgentEngineLabel(a) : "", a ? a.model || "" : "", a && a.decidedAt != null ? (a.decidedAt - a.t <= TR_AGENT_LIVE ? "yes" : "no") : "");
    [21, 63, 126].forEach(function (h) {
      const e = function (rec, key) { const v = rec && rec.ex && rec.ex[h]; return v && v[key] != null ? day(v[key]) : ""; };
      row.push(e(rr, "you"), e(rr, "agent"), e(ar, "agent"));
    });
    lines.push(row.map(q).join(","));
  });
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "stocktrails-agent-decisions-" + isoDate(Date.now()) + ".csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
}

function trAgentCmpOpen() {
  trAgentHoldClose();
  TR.agent.cmpF = "all";
  const ov = document.createElement("div");
  ov.className = "tr-hold-ov"; ov.id = "tr-hold-ov";
  ov.innerHTML = "<div class='tr-hold-box tr-cmp-box' role='dialog' aria-label='All decisions side by side'><div class='tr-hold-head'><b>All decisions side by side</b> " + trInfo("Every moment, newest first: what you did, the attention index's share of the stock then, and what the rules agent and the AI agent decided and why, so the decisions can be checked against each other at the same point in time. Rows are shaded where the two agents decided differently.", "About this list") + "<button type='button' data-agent='cmp-csv' class='navbtn'>Download as CSV</button><button data-agent='hold-close' class='tr-hold-x' aria-label='Close'>&times;</button></div>" +
    "<div class='tr-hold-body' id='tr-cmp-body'>" + trAgentCmpBody() + "</div></div>";
  document.body.appendChild(ov);
}

// ---------- holdings over time (to check the lines) ----------

const TR_HOLD_COLORS = ["#4e9eff", "#f1c40f", "#3ddc97", "#e056fd", "#ff8a65", "#26c6da", "#a29bfe", "#ef5350", "#9ccc65", "#ffd54f"];

// What each line held, per month end: { dates, unit, lines: [{ key, label, bars: [{ stocks: {ticker: v}, nasdaq: v }] }] }
function trAgentHoldData() {
  const S = TR.agent.S, D = S && trAgentPpData(S);
  if (!D || !D.holdings) return null;
  return { dates: D.holdings.dates, unit: "share", lines: D.lines.filter(function (l) { return D.holdings[l.key]; }).map(function (l) { return { key: l.key, label: l.label, bars: D.holdings[l.key] }; }), rest: "cash (not invested)", basis: D.unit };
}

function trAgentHoldVal(v, unit) { return unit === "share" ? (Math.round(v * 1000) / 10) + "%" : (Math.round(v * 100) / 100) + (v === 1 ? " position" : " positions"); }
function trAgentHoldName(tk) { return tk === "untracked" ? "untracked stocks" : (typeof nameOf === "function" ? nameOf(tk) : tk); }

function trAgentHoldHtml() {
  const D = trAgentHoldData();
  if (!D || !D.dates.length) return "<div class='muted small'>Nothing was held yet.</div>";
  // the stocks that ever weigh most get a colour each; the rest share one
  const peak = {};
  D.lines.forEach(function (L) { L.bars.forEach(function (b) { Object.keys(b.stocks).forEach(function (tk) { peak[tk] = Math.max(peak[tk] || 0, b.stocks[tk]); }); }); });
  const top = Object.keys(peak).sort(function (a, b) { return peak[b] - peak[a]; }).slice(0, TR_HOLD_COLORS.length), colour = {};
  top.forEach(function (tk, i) { colour[tk] = TR_HOLD_COLORS[i]; });
  const tot = function (b) { return Object.keys(b.stocks).reduce(function (m, k) { return m + b.stocks[k]; }, 0) + (b.rest || 0); };
  const max = D.lines.reduce(function (m, L) { return L.bars.reduce(function (mm, b) { return Math.max(mm, tot(b)); }, m); }, 0) || 1;
  const W = 900, Hh = 200, L0 = 46, B0 = 22, n = D.dates.length, bw = (W - L0 - 8) / n;
  const el = function (i) { return L0 + i * bw; };
  const panels = D.lines.map(function (L, li) {
    let g = "";
    for (let t = 0; t <= 4; t++) {
      const y = Hh - B0 - (Hh - B0 - 8) * t / 4;
      g += "<line x1='" + L0 + "' x2='" + (W - 8) + "' y1='" + y + "' y2='" + y + "' class='tr-hold-grid'/><text x='" + (L0 - 4) + "' y='" + (y + 3) + "' text-anchor='end' class='tr-hold-ax'>" + escapeHtml(trAgentHoldVal(max * t / 4, D.unit).replace(" positions", "").replace(" position", "")) + "</text>";
    }
    L.bars.forEach(function (b, i) {
      let y = Hh - B0;
      const seg = function (v, fill) { if (!(v > 0)) return; const h = (Hh - B0 - 8) * v / max; y -= h; g += "<rect x='" + (el(i) + 1) + "' y='" + y + "' width='" + Math.max(1, bw - 2) + "' height='" + Math.max(0.5, h) + "' fill='" + fill + "'/>"; };
      seg(b.rest, "#2f3a52");
      const ks = Object.keys(b.stocks).sort(function (a, c) { return b.stocks[c] - b.stocks[a]; });
      ks.filter(function (k) { return !colour[k]; }).forEach(function (k) { seg(b.stocks[k], "#5b6478"); });
      ks.filter(function (k) { return colour[k]; }).forEach(function (k) { seg(b.stocks[k], colour[k]); });
      g += "<rect x='" + el(i) + "' y='0' width='" + bw + "' height='" + (Hh - B0) + "' fill='transparent' data-bar='" + li + "|" + i + "'/>";
      if (i % Math.ceil(n / 10) === 0 || i === n - 1) g += "<text x='" + (el(i) + bw / 2) + "' y='" + (Hh - 6) + "' text-anchor='middle' class='tr-hold-ax'>" + escapeHtml(D.dates[i].slice(2, 7)) + "</text>";
    });
    return "<div class='tr-hold-panel'><div class='tr-hold-title'>" + escapeHtml(L.label) + "</div><svg viewBox='0 0 " + W + " " + Hh + "' class='tr-hold-svg' role='img'>" + g + "</svg></div>";
  }).join("");
  TR.agent.hold = { D: D, colour: colour };
  return panels;
}

// The explanation of the bars, shown in the info popup of the overlay's heading.
function trAgentHoldNote() {
  const D = trAgentHoldData();
  return (D && D.unit !== "share"
    ? "Each bar is the open positions of a line on the last day of a month, in unit positions (a look is one unit; an agent's share is its size), stock by stock. The same positions as the lines above, so you can check them."
    : "Each bar is what a portfolio held on the last day of a month, stock by stock and in cash, as a share of the portfolio's value. The same portfolios as the lines above, so you can check them.") +
    " Hover a bar for the full list with each holding's colour; the mouse wheel scrolls it.";
}

function trAgentHoldOpen() {
  trAgentHoldClose();
  const ov = document.createElement("div");
  ov.className = "tr-hold-ov"; ov.id = "tr-hold-ov";
  ov.innerHTML = "<div class='tr-hold-box' role='dialog' aria-label='Holdings over time'><div class='tr-hold-head'><b>Holdings over time</b> <span class='muted small'>" + (TR.agent.view === "looks" ? "your looks" : "your trades") + "</span> " + trInfo(trAgentHoldNote(), "About the holdings") + "<button data-agent='hold-close' class='tr-hold-x' aria-label='Close'>&times;</button></div>" +
    "<div class='tr-hold-body'>" + trAgentHoldHtml() + "</div><div class='tr-hold-pop' id='tr-hold-pop' hidden></div></div>";
  document.body.appendChild(ov);
}
function trAgentHoldClose() { const o = document.getElementById("tr-hold-ov"); if (o) o.remove(); }

// The bar under the pointer: every holding of that line and month in a popup that scrolls and stays while the pointer is in it.
(function () {
  let timer = null;
  const hide = function () { const p = document.getElementById("tr-hold-pop"); if (p) p.hidden = true; };
  document.addEventListener("mouseover", function (ev) {
    const pop = document.getElementById("tr-hold-pop");
    if (!pop || !TR.agent.hold) return;
    if (ev.target.closest && ev.target.closest("#tr-hold-pop")) { clearTimeout(timer); return; }
    const bar = ev.target.closest && ev.target.closest("[data-bar]");
    if (!bar) { clearTimeout(timer); timer = setTimeout(hide, 250); return; }
    clearTimeout(timer);
    const ij = bar.getAttribute("data-bar").split("|"), D = TR.agent.hold.D, L = D.lines[+ij[0]], b = L && L.bars[+ij[1]];
    if (!b) return;
    const col = TR.agent.hold.colour || {};
    const rows = Object.keys(b.stocks).map(function (k) { return [trAgentHoldName(k), b.stocks[k], col[k] || "#5b6478"]; });
    if (D.unit === "share" && b.rest > 0) rows.push(["cash (not invested)", b.rest, "#2f3a52"]);
    rows.sort(function (a, c) { return c[1] - a[1]; });
    const total = rows.reduce(function (m, r) { return m + r[1]; }, 0);
    pop.innerHTML = "<div class='tr-hold-pop-h'><b>" + escapeHtml(D.dates[+ij[1]]) + "</b> " + escapeHtml(L.label) + "<br><span class='muted small'>" + rows.length + (rows.length === 1 ? " holding, " : " holdings, ") + escapeHtml(trAgentHoldVal(total, D.unit)) + " in all</span></div>" +
      "<div class='tr-hold-pop-l'><table class='adm'><tbody>" + (rows.map(function (r) { return "<tr><td><i class='tr-hold-sw' style='background:" + r[2] + "'></i>" + escapeHtml(r[0]) + "</td><td>" + escapeHtml(trAgentHoldVal(r[1], D.unit)) + "</td></tr>"; }).join("") || "<tr><td class='muted small'>nothing held</td></tr>") + "</tbody></table></div>";
    pop.hidden = false;
    const box = pop.parentNode.getBoundingClientRect(), r = bar.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(box.width - pop.offsetWidth - 8, r.left - box.left + r.width + 8)) + "px";
    pop.style.top = Math.max(8, Math.min(box.height - pop.offsetHeight - 8, r.top - box.top - 10)) + "px";
  });
  // the wheel over a bar scrolls its list (not the window), as on the watchlist's Compare chart
  document.addEventListener("wheel", function (ev) {
    const pop = document.getElementById("tr-hold-pop"), l = pop && !pop.hidden && pop.querySelector(".tr-hold-pop-l");
    if (!l || !ev.target.closest || !ev.target.closest("[data-bar]") || l.scrollHeight <= l.clientHeight + 1) return;
    ev.preventDefault();
    l.scrollTop += ev.deltaMode === 1 ? ev.deltaY * 18 : ev.deltaY;
  }, { passive: false });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") trAgentHoldClose(); });
  document.addEventListener("click", function (ev) { if (ev.target && ev.target.id === "tr-hold-ov") trAgentHoldClose(); });
})();

// ---------- saving, refreshing, the AI agent ----------

// The rules agent's decisions are saved the first time they are worked out, so a later
// look shows which were made live.
async function trAgentSave() {
  const A = TR.agent, S = A.S;
  if (!S || A.saved || !TR.owner) return;
  A.saved = true;
  const now = Date.now(), recs = S.trades.rules.concat(S.looks.rules).filter(function (d) { return !d.pending; }).map(function (d) {
    // why / features / active: the readings of the rules that acted and what was measured then, kept for later questions
    return { id: d.id, agent: "rules", kind: d.kind, ticker: d.ticker || null, t: d.t, action: d.action, days: d.days, size: d.size, reason: d.reason || "", rules: d.rules, why: d.why || [], features: d.features || null, active: d.active || null,
      engine: "rules", model: null, provider: null, promptVersion: null, decidedAt: now };
  });
  try {
    if (await ATLedgerDB.putAgentDecisions(TR.owner, recs)) { A.store = await ATLedgerDB.getAgentDecisions(TR.owner); trAgentRefresh(); }
  } catch (e) { /* the record is a bonus; the portfolios do not depend on it */ }
}

// The saved decisions, the saved pre-trade checks and the last model comparison of this account.
async function trAgentLoadData() {
  const A = TR.agent;
  try { A.store = await ATLedgerDB.getAgentDecisions(A.owner); } catch (e) { A.store = []; }
  try { A.checks = await ATLedgerDB.getChecks(A.owner); } catch (e) { A.checks = []; }
  A.loaded = true;
}

async function trAgentLoad() {
  await trAgentLoadData();
  trAgentRefresh();
}

// For the assistant: its tool get_agent_decisions reads the saved record, which may not be loaded when the page
// has not been opened yet on the Trades tab.
async function trAgentEnsure() {
  const A = TR.agent;
  if (A.loaded && A.owner === TR.owner) return;
  A.owner = TR.owner;
  await trAgentLoadData();
}

function trAgentDraw() { trAgentPpDraw(); }

// Puts html into a part of the section, only when it differs from what is there (a part that did not change keeps its
// scroll position, its open details and its drag in progress). Returns whether it was changed.
function trAgentSet(el, html) {
  if (el._h === html) return false;
  el._h = html; el.innerHTML = html;
  return true;
}

// New data or a new decision redraws only the parts that show them (Latest decisions, Paper portfolios, the notes), not the
// section around them and never the rest of the Trades & research page. The whole section is built when its parts are not
// on the page yet (first run, or the AI agent was not available before).
function trAgentRefresh() {
  const sec = document.getElementById("tr-agents");
  if (!sec || !TR.report) return;
  const lat = document.getElementById("tr-agent-latest"), pp = document.getElementById("tr-agent-pp"), nt = document.getElementById("tr-agent-notes");
  let S = null;
  if (lat && pp && nt) { try { S = trAgentState(TR.report); } catch (e) { S = null; } }
  if (!S) { sec.innerHTML = trAgentInner(TR.report); trAgentDraw(); }
  else {
    trAgentSet(lat, trAgentLatestHtml(S));
    if (trAgentSet(pp, trAgentPpSection(S))) trAgentDraw();
    trAgentSet(nt, trAgentNotesHtml());
  }
  if (!TR.agent.saved) trAgentSave();
  trAgentAuto();
}

// New attention or calls flowed in while the Trades & research page is open: the report is built again from them and only the
// AI agent's Latest decisions and Paper portfolios are redrawn. The cards above keep what they show until the next visit.
async function trAgentNewData() {
  if (!self.ATShadow || !TR.report || !TR.txs || !TR.txs.length || !document.getElementById("tr-agent-latest")) return false;
  const tickerSym = {};
  trackedTickers().forEach(function (t) { tickerSym[t] = tickerSymbol(t); });
  const input = { txs: TR.txs, links: TR.links, intraday: DATA.intraday || [], events: DATA.events || [],
    prices: TR.prices, bench: BENCH || [], tickerSymbol: tickerSym, customParts: TR.customParts, windowDays: TR.winDays, lagDays: TR.lagDays, now: Date.now() };
  TR.busy = true;
  try {
    const R = ATDecisions.analyze(input);
    await trAttachIndicators(R, input);
    TR.report = R; TR.reportKey = trReportKey();
  } finally { TR.busy = false; }
  trAgentRefresh();
  return true;
}

// AI decisions saved before sizes were weights, about moments still inside the 2-day live window, are asked again with the new
// meaning (the old record is dropped first, so the normal run decides the moment afresh). Older moments are never asked: the
// model could know what happened next; they keep their saved size, read as 5% times its share.
// Each moment is asked again at most once (remembered in this browser): an answer that still has no sizeUnit (an assistant
// service from before weights) is kept, not dropped again, which would re-ask it forever.
function trAgentMigrateSizes() {
  const A = TR.agent, now = Date.now(), mk = "at-agent-migrated|" + TR.owner;
  if (A.migrating || !self.ATLedgerDB || !TR.owner) return;
  if (!A.migrated || A.migratedFor !== TR.owner) {
    try { A.migrated = JSON.parse(localStorage.getItem(mk) || "{}"); } catch (e) { A.migrated = {}; }
    A.migratedFor = TR.owner;
  }
  const old = A.store.filter(function (d) { return ATAgentSession.needsSizeMigration(d, now, TR_AGENT_LIVE) && !A.migrated[d.id]; });
  if (!old.length) return;
  old.forEach(function (d) { A.migrated[d.id] = now; });
  Object.keys(A.migrated).forEach(function (id) { if (now - A.migrated[id] > 7 * 86400000) delete A.migrated[id]; });
  try { localStorage.setItem(mk, JSON.stringify(A.migrated)); } catch (e) { /* in memory only */ }
  A.migrating = true;
  ATLedgerDB.deleteAgentDecisions(TR.owner, "ai", old.map(function (d) { return d.id; })).then(function () { return ATLedgerDB.getAgentDecisions(TR.owner); })
    .then(function (rows) { A.store = rows; A.migrating = false; A.autoKey = null; trAgentRefresh(); }).catch(function () { A.migrating = false; });
}

// On entering the page, once per report and consent state: the AI agent decides what is
// new. Nothing is sent before the user has agreed to the assistant's terms.
function trAgentAuto() {
  const A = TR.agent;
  if (!self.ATAI || !ATAI.consent() || !TR.report || !A.S) return;
  if (self.trAiNotesAuto) trAiNotesAuto();
  // the headless page decides only its sessions' stocks (trAgentHeadless); the backlog waits for the open dashboard
  if (A.busy || (typeof HEADLESS !== "undefined" && HEADLESS)) return;
  trAgentMigrateSizes();
  // unsure answers are left out: saving one must not start another run
  const key = TR.reportKey + "|" + A.store.filter(function (d) { return d.action !== "unsure"; }).length;
  if (A.autoKey === key) return;
  A.autoKey = key;
  if (trAgentUndecided(trAgentState(TR.report)).length) trAgentAiRun();
}

// Called after the Trades pane has rendered: draw the chart, and load the saved decisions once per account.
function trAgentAfterRender(R) {
  if (!self.ATShadow || !R || !document.getElementById("tr-agents")) return;
  if (TR.agent.owner !== TR.owner) { TR.agent.owner = TR.owner; TR.agent.store = []; TR.agent.loaded = false; trAgentLoad(); return; }
  trAgentFx();
  if (!trAgentReady(R)) { setTimeout(trAgentRefresh, 30); return; }
  trAgentDraw();
  if (!TR.agent.saved) trAgentSave();
  trAgentAuto();
}

// What the AI agent is shown about a moment (ATShadow.contextFor), with the viewing session it belongs to when the
// live verdict runs it (TR.agent.sessions, set by trAgentHeadless; ATAgentSession.summary: counts only).
function trAgentContext(c, S, names) {
  const A = TR.agent, x = ATShadow.contextFor(c, TR.report, A.input, ATShadow.snapshotAt(S.snapshots, c.t), { names: names, nameOf: nameOf, community: A.input.community });
  const s = A.sessions && c.ticker && c.kind !== "trade" ? A.sessions[String(c.ticker).toUpperCase()] : null;
  if (s && self.ATAgentSession && ATAgentSession.momentFor([c], s)) x.session = ATAgentSession.summary(s);
  return x;
}

// The saved record of a decision; the reasoning is kept with it: the model's text, the decision model's odds, and the exact input it was shown.
function trAgentRecOf(c, d, res, input, now) {
  return { id: c.id, agent: "ai", kind: c.kind, ticker: c.ticker || null, t: c.t, action: d.action, days: d.days, size: d.size, reason: trAgentUnalias(d.reason, input), reasoning: trAgentUnalias(d.reasoning, input), rules: null,
    engine: res.engine || null, sizeUnit: res.sizeUnit || null, trace: d.trace || null, deferred: d.deferred === true, input: input || null,
    model: res.model, provider: res.provider, promptVersion: res.promptVersion, decidedAt: now };
}
// Not sure enough: no decision, the moment stays open and is asked again when the data changes; what the model answered is saved.
function trAgentUnsureRecOf(c, u, res, input, now) {
  return { id: c.id + "|unsure|" + now, momentId: c.id, agent: "ai", kind: c.kind, ticker: c.ticker || null, t: c.t, action: "unsure", days: 0, size: 0, reason: trAgentUnalias(u.reason, input), reasoning: "", rules: null,
    engine: res.engine || null, trace: u.trace || null, deferred: false, input: input || null, model: res.model, provider: res.provider, promptVersion: res.promptVersion, decidedAt: now };
}

// The AI agent decides the undecided buys and looks, in requests of 15, newest first.
// Each answered request is saved at once, so a stop, an error or the daily cap loses nothing.
// The open dashboard and the headless page may both run: one request at a time across them (a Web Lock), and each re-reads the
// saved record before its request, so a moment the other one answered meanwhile is not asked again. o.only: decide only these
// tickers' moments (the headless live verdict; the rest waits for the open dashboard).
function trAgentLocked(fn) { return self.navigator && navigator.locks ? navigator.locks.request("at-agent-ai-request", fn) : fn(); }
async function trAgentAiRun(o) {
  const A = TR.agent;
  if (A.busy || !trAgentState(TR.report)) return;
  A.busy = true; A.stop = false;
  try { await trAgentAiRunNow(o || {}); } finally { A.busy = false; A.stop = false; trAgentRefresh(); }
}

async function trAgentAiRunNow(o) {
  const A = TR.agent, S = trAgentState(TR.report), t0 = Date.now();
  if (!S) return;
  const names = !!(TR.ai && TR.ai.names), only = o.only ? o.only.map(function (t) { return String(t).toUpperCase(); }) : null;
  // an unsure moment is asked again only when its data changed since that answer
  let todo = trAgentUndecided(S).filter(function (c) { const u = trAgentUnsureOf(c.id); return !u || !self.ATAgentSession || ATAgentSession.askAgainUnsure(u, trAgentContext(c, S, names)); });
  if (only) todo = todo.filter(function (c) { return c.ticker && only.indexOf(String(c.ticker).toUpperCase()) >= 0; });
  if (!todo.length) return;
  // the stocks of the viewing sessions first; repeat views are asked apart from buys and looks: they have their own options (hold, sell, buy)
  const batches = [], ss = A.sessions || {}, mine = function (c) { return !!ss[String(c.ticker || "").toUpperCase()]; };
  [todo.filter(mine), todo.filter(function (c) { return !mine(c); })].forEach(function (part) {
    [part.filter(function (c) { return c.kind !== "revisit"; }), part.filter(function (c) { return c.kind === "revisit"; })].forEach(function (g) {
      for (let i = 0; i < g.length; i += TR_AGENT_BATCH) batches.push(g.slice(i, i + TR_AGENT_BATCH));
    });
  });
  const nReq = batches.length;
  let done = 0, k = 0, capped = false, unsure = 0;
  try {
    for (k = 0; k < nReq && !A.stop; k++) {
      A.msg = "Request " + (k + 1) + " of " + nReq + ": " + done + " of " + todo.length + " decided so far...";
      trAgentRefresh();
      const res = await trAgentLocked(async function () {
        try { A.store = await ATLedgerDB.getAgentDecisions(TR.owner); } catch (e) { /* keep what is loaded */ }
        // answered elsewhere since this run started: decided, or unsure after t0
        const decided = trAgentById(trAgentAiList());
        const batch = batches[k].filter(function (c) { const u = trAgentUnsureOf(c.id); return !decided[c.id] && !(u && u.decidedAt >= t0); }), byId = trAgentById(batch);
        if (!batch.length) return null;
        const ctxs = batch.map(function (c) { return trAgentContext(c, S, names); });
        const r = await ATAI.decide(ctxs, { names: names });
        const now = Date.now(), seen = trAgentById(ctxs);
        const recs = r.decisions.filter(function (d) { return byId[d.id]; }).map(function (d) { return trAgentRecOf(byId[d.id], d, r, seen[d.id], now); });
        const unsureRecs = (r.unsure || []).filter(function (u) { return byId[u.id]; }).map(function (u) { return trAgentUnsureRecOf(byId[u.id], u, r, seen[u.id], now); });
        await ATLedgerDB.putAgentDecisions(TR.owner, recs.concat(unsureRecs));
        A.store = await ATLedgerDB.getAgentDecisions(TR.owner);
        done += recs.length; unsure += unsureRecs.length;
        return r;
      });
      if (res && res.usage && res.usage.used >= res.usage.cap) { k++; capped = true; A.cappedAt = Date.now(); break; }
    }
    A.msg = capped ? "Today's assistant requests are used up. The AI agent decided " + done + "; continue tomorrow, what was decided is kept."
      : "The AI agent decided " + done + " of " + todo.length + (unsure ? ", " + unsure + " not sure enough yet (its answer is saved; it asks again when more is known)" : "") + (k < nReq ? ". Stopped; continue any time." : ".");
  } catch (e) {
    if (e && e.code === "daily_cap") A.cappedAt = Date.now();
    A.msg = e && e.code === "daily_cap" ? "Today's assistant requests are used up. The AI agent decided " + done + "; continue tomorrow, what was decided is kept."
      : "Stopped: " + (e && e.message || e) + " What was decided so far (" + done + ") is kept; run it again to continue.";
  }
}

// ---------- the live verdict on stock pages (issue #30) ----------
// After a viewing session ends, src/background.js opens this page headless in an offscreen document
// (dashboard.js headlessAgent). trAgentHeadless builds the Trades & research page as the open dashboard
// would, lets the AI agent decide what is undecided (trAgentAiRun, the same gates: consent, the daily
// cap, the 2-day live window), asks again about a moment whose session got more views after it was
// decided, and returns per stock the verdict the stock-page pop-up shows (src/content.js).

// Ask again about a decided moment with the merged session; the earlier answer is kept (ATAgentSession.supersededCopy).
async function trAgentRedecide(c, d, s) {
  const A = TR.agent, names = !!(TR.ai && TR.ai.names);
  const x = trAgentContext(c, A.S, names);
  x.session = ATAgentSession.summary(s);
  x.yourEarlierAnswer = { action: d.action, days: d.days, size: d.size, reason: d.reason || "" };
  const res = await ATAI.decide([x], { names: names }), now = Date.now();
  if (res.usage && res.usage.used >= res.usage.cap) A.cappedAt = now;
  const dd = res.decisions[0], u = (res.unsure || [])[0];
  if (dd) {
    const next = Object.assign(trAgentRecOf(c, dd, res, x, now), { redecided: (d.redecided || 0) + 1 });
    await ATLedgerDB.supersedeAgentDecision(TR.owner, ATAgentSession.supersededCopy(d, now), next);
  } else if (u) await ATLedgerDB.putAgentDecisions(TR.owner, [trAgentUnsureRecOf(c, u, res, x, now)]);
  A.store = await ATLedgerDB.getAgentDecisions(TR.owner);
  return !!dd;
}

// Why a session got no moment of its own (the pop-up says it): no prices, or a return within 30 days that is not a burst.
function trAgentNoMomentNote(T, s) {
  const series = TR.prices && TR.prices[tickerSymbol(T)];
  if (!series || !series.length) return "No daily prices for " + T + " here, so the AI agent cannot judge it.";
  let last = null;
  (DATA.intraday || []).forEach(function (e) { if (String(e.ticker).toUpperCase() === T && e.ts < s.start && (last == null || e.ts > last)) last = e.ts; });
  if (last != null && s.start - last < 30 * 86400000) return "Not a new look: you viewed " + T + " on " + isoDate(last) + ", and a look needs 30 days without a view. Repeat views count when they come in a burst (3 or more in 3 days, twice your usual).";
  return "The AI agent had no moment to decide in this session.";
}

// What the pop-up shows for a stock: the moment's decision, else the newest live one on the stock, and a note.
function trAgentVerdictOf(T, m, note) {
  const A = TR.agent, live = trAgentAiList().filter(function (d) { return String(d.ticker || "").toUpperCase() === T; }).sort(function (a, b) { return b.t - a.t; });
  let d = m ? live.find(function (x) { return x.id === m.id; }) : null;
  if (m && !d) {
    const u = trAgentUnsureOf(m.id);
    if (u) note = "Not sure enough yet, so nothing decided: " + (u.reason || "it asks again when more is known.");
    else if (A.cappedAt && Date.now() - A.cappedAt < 3600000) note = "Today's assistant requests are used up; it decides this tomorrow if still within 2 days.";
    else if (!note) note = "Not decided yet.";
  }
  d = d || live[0] || null;
  const v = { ticker: T, updatedAt: Date.now(), note: note || null, current: !!(d && m && d.id === m.id) };
  if (d) Object.assign(v, { action: d.action, days: d.days || 0, size: d.size, sizeUnit: d.sizeUnit || null, kind: d.kind, reason: d.reason || "", date: isoDate(d.t), decidedAt: d.decidedAt, redecided: d.redecided || 0, model: d.model || null });
  return v;
}

// ss: the sessions due (ATAgentSession), by ticker. Returns { <ticker>: { momentId, redecided, verdict } }.
async function trAgentHeadless(ss, progress) {
  const out = {}, A = TR.agent, tickers = Object.keys(ss), step = progress || function () {};
  step("building your report");
  ["main-attention"].forEach(function (id) { const el = document.getElementById(id); if (el) el.hidden = false; });
  const pane = document.querySelector("[data-pane='trades']");
  if (pane) pane.hidden = false;
  await renderTrades();
  const R = TR.report;
  if (!R || !self.ATShadow) {
    tickers.forEach(function (T) { out[T] = { momentId: null, verdict: { ticker: T, updatedAt: Date.now(), note: "The AI agent works from your broker trades: import them in My Habits > Trades & research." } }; });
    return out;
  }
  A.owner = TR.owner; A.sessions = ss;
  await trAgentLoadData();
  step("working out the paper portfolios");
  await new Promise(function (r) { setTimeout(r, 0); });
  const S = trAgentState(R);
  step("asking the AI agent");
  while (A.busy) await new Promise(function (r) { setTimeout(r, 300); });
  await trAgentAiRun({ only: tickers });
  const now = Date.now(), cands = S.looks.candidates.concat(trAgentPending(S), trAgentRevisits()).filter(function (c) { return now - c.t <= TR_AGENT_LIVE; });
  for (const T of tickers) {
    const s = ss[T], m = ATAgentSession.momentFor(cands, s);
    let redecided = s.redecided || 0;
    if (m) {
      const d = A.store.find(function (x) { return x.agent === "ai" && x.id === m.id; });
      if (ATAgentSession.needsRedecide(s, d, redecided)) {
        try { if (await trAgentRedecide(m, d, s)) redecided++; } catch (e) { if (e && e.code === "daily_cap") A.cappedAt = Date.now(); }
      }
    }
    out[T] = { momentId: m ? m.id : null, redecided: redecided, verdict: trAgentVerdictOf(T, m, m ? null : trAgentNoMomentNote(T, s)) };
  }
  A.sessions = null;
  return out;
}

// ---------- the pre-trade check ----------

// The rules agent's view of an intended buy now (ATShadow.verdictNow on the latest
// snapshot and what is measured now). A delaying rule means wait, with how long it
// typically waited for that rule in your history, or pass when, in your history, that
// rule's condition mostly did not clear within 10 trading days.
function trAgentCheckVerdict(S, R, ctx) {
  const snap = ATShadow.snapshotAt(S.snapshots, Infinity), v = ATShadow.verdictNow(snap, ctx);
  const active = snap ? snap.rules : [];
  v.active = active.length;
  v.why = v.rules.map(function (id) {
    const a = active.find(function (x) { return x.ruleId === id; }), rule = ATBiases.ruleById(id), p = rule.extra ? Object.assign({}, a.params, rule.extra(a.params, R)) : a.params;
    return { ruleId: id, why: rule.check(p, ctx) || rule.text(p, R), do: rule.do(p) };
  });
  if (v.delaying.length) {
    const past = S.trades.rules.concat(S.looks.rules).filter(function (d) { return d.action !== "buy" && d.rules.some(function (id) { return v.delaying.indexOf(id) >= 0; }); });
    v.past = past.length;
    if (past.length && past.filter(function (d) { return d.action === "pass"; }).length > past.length / 2) v.action = "pass";
    const ds = v.delaying.map(function (id) { return S.trades.waitDays[id]; }).filter(function (x) { return x != null; });
    v.days = ds.length ? Math.max.apply(null, ds) : null;
  }
  return v;
}

function trCheckExtra(tk, ctx, R, amt, ccy) {
  if (!self.ATShadow || !self.ATBiases) return "";
  let S, v;
  try {
    S = trAgentState(R);
    // days since the last sale of something else, as for the rules agent's own decisions (no_quick_switch)
    if (S) ctx = Object.assign({}, ctx, { sinceSell: ATShadow.sinceSellAt(ATShadow.context(R, TR.agent.input), Date.now(), null, tk) });
    v = S && trAgentCheckVerdict(S, R, ctx);
  } catch (e) { return ""; }
  if (!v) return "";
  TR.agent.check = { tk: tk, ctx: ctx, verdict: v, amount: amt > 0 ? amt : null, currency: ccy };
  const dos = v.why.filter(function (w) { return v.delaying.indexOf(w.ruleId) >= 0; }).map(function (w) { return w.do; });
  let head;
  // the size is a share of the amount typed in the check, so it is said in that amount
  if (v.action === "buy") {
    const w0 = ctx.weight, pc1 = function (x) { return Math.round(x * 1000) / 10 + "%"; };
    // a cap rule cuts your buy to a share of it; said as the weight in your portfolio when that is known, and in your money when an amount was typed
    head = "buy now" + (v.size < 1 ? ", but cut: " + (w0 != null ? "a weight of " + pc1(w0 * v.size) + " in your portfolio instead of " + pc1(w0) + (amt > 0 ? " (" + trAgentMoney(amt * v.size, ccy) + " of your " + trAgentMoney(amt, ccy) + ")" : "") : trAgentSizeText(v.size, TR.agent.check.amount ? { amount: amt, currency: ccy } : null)) + "." : ".");
  }
  else if (v.action === "wait") head = "wait (" + dos.join(" ") + ")" + (v.days ? ", typically " + v.days + (v.days === 1 ? " trading day" : " trading days") + " for this rule in your history." : ".");
  else head = "pass: in your history this condition mostly did not clear within 10 trading days (" + v.past + " decisions).";
  const why = v.why.length ? "<ul class='tr-signals'>" + v.why.map(function (w) { return "<li>" + escapeHtml(w.why) + " <span class='muted small'>(" + escapeHtml(trAgentRuleTitle(w.ruleId)) + ")</span></li>"; }).join("") + "</ul>" : "";
  const day = v.rules.indexOf("avoid_daypart") >= 0 ? "<div class='muted small'>Your worst time of day only moves the order to another hour; it does not change the verdict.</div>" : "";
  return "<div class='tr-msg tr-agent-check'><b>Rules agent:</b> " + escapeHtml(head) +
    (v.active ? "" : " <span class='muted small'>(no rule has held up for you yet, so it buys)</span>") + why + day +
    (v.unchecked.length ? "<div class='muted small'>" + v.unchecked.length + " of its " + v.active + " rules could not be checked now (not enough information).</div>" : "") +
    "<div class='muted small'>" + TR_AGENT_ABOUT + "</div></div>" +
    (self.ATAI ? "<div class='tr-msg tr-agent-check' id='tr-agent-check-ai'></div>" : "");
}

// One decide request for the intended buy: the stock as it stands now (last close), and
// what the rules agent says now, from the check's own measurements.
async function trAgentAskCheck(out) {
  const k = TR.agent.check, R = TR.report;
  if (!k || !out) return;
  if (!ATAI.consent()) { out.innerHTML = "<div class='muted small'>The AI agent uses the assistant's service. <a href='#' data-ai='open'>Open the assistant</a> to turn it on.</div>"; return; }
  const s = TR.prices[tickerSymbol(k.tk)];
  if (!s || !s.length) { out.innerHTML = "<div class='muted small'>No prices for this stock, so the AI agent has nothing to judge it on.</div>"; return; }
  out.innerHTML = "<div class='muted small'>Asking the AI agent...</div>";
  try {
    const S = trAgentState(R), now = Date.now(), names = !!(TR.ai && TR.ai.names);
    const views = (DATA.intraday || []).filter(function (e) { return e.ticker === k.tk; }).map(function (e) { return e.ts; });
    const cand = { id: "check", kind: "trade", ticker: k.tk, inst: null, date: isoDate(now), t: now, ts: now, dateOnly: false, hour: k.ctx.hour, amount: null, currency: null, relSize: k.ctx.relSize,
      firstAtt: views.length ? Math.min.apply(null, views) : null, sinceSell: k.ctx.sinceSell, series: s, i0: s.length - 1, excluded: null, bought: null };
    const c = ATShadow.contextFor(cand, R, TR.agent.input, ATShadow.snapshotAt(S.snapshots, now), { names: names, nameOf: nameOf, community: TR.agent.input.community });
    c.rulesAgent = ATShadow.rulesView(ATShadow.snapshotAt(S.snapshots, now), k.ctx, R);
    if (k.ctx.weight != null) c.yourWeightAfterBuy = Math.round(k.ctx.weight * 1000) / 10;
    const res = await ATAI.decide([c], { names: names }), d = res.decisions[0], u = (res.unsure || [])[0];
    if (d) d.sizeUnit = res.sizeUnit || null;
    const again = " <button data-agent='ask-check'>Ask again</button>";
    const oddsOf = function (t) { return t && t.odds ? "buy " + Math.round(t.odds.buy * 100) + "%, wait " + Math.round(t.odds.wait * 100) + "%, pass " + Math.round(t.odds.pass * 100) + "%" : ""; };
    const o = { amount: k.amount, currency: k.currency, kind: "check" }, label = trAgentEngineLabel({ engine: res.engine, model: res.model, promptVersion: res.promptVersion });
    const reason = d ? trAgentUnalias(d.reason, c) : "", reasoning = d ? trAgentUnalias(d.reasoning, c) : "";
    out.innerHTML = d ? "<div><b>AI agent:</b> " + trAgentActText(d, o) + (reason ? ". " + escapeHtml(reason) : "") + "</div>" +
      (d.action !== "pass" && d.sizeUnit === "weight" ? "<div class='muted small'>" + escapeHtml("The stock is bought up to " + Math.round(d.size * 1000) / 10 + "% of your portfolio's value; the rest of the portfolio stays as it is.") + "</div>" : d.action !== "pass" && d.size < 1 ? "<div class='muted small'>" + escapeHtml(Math.round(d.size * 100) + "% of the amount you entered goes into the stock.") + "</div>" : "") +
      (reasoning ? "<div class='muted small'>" + escapeHtml(reasoning) + "</div>" : "") +
      (d.trace && d.trace.odds ? "<div class='muted small'>The decision model writes no reasoning; its odds: buy " + Math.round(d.trace.odds.buy * 100) + "%, wait " + Math.round(d.trace.odds.wait * 100) + "%, pass " + Math.round(d.trace.odds.pass * 100) + "%.</div>" : "") +
      "<div class='muted small'>A paper decision by a " + escapeHtml(label) + " (" + escapeHtml(res.model || "?") + ") from what is known now. Not investment advice." + again + "</div>"
      : u ? "<div class='muted small'>The AI agent is not sure enough to decide this buy" + (oddsOf(u.trace) ? " (its odds: " + escapeHtml(oddsOf(u.trace)) + ")" : "") + ", so it gives no answer.<br>Model: " + escapeHtml(res.model || "?") + "." + again + "</div>"
      : "<div class='muted small'>The AI agent gave no usable answer." + again + "</div>";
    trCheckSaveAi(k, { at: Date.now(), model: res.model || null, provider: res.provider || null, promptVersion: res.promptVersion || null, engine: res.engine || null, names: names, input: c,
      decision: d ? { action: d.action, days: d.days, size: d.size, sizeUnit: d.sizeUnit || null, reason: reason, reasoning: reasoning, trace: d.trace || null } : null, unsure: u ? { reason: u.reason || "", trace: u.trace || null } : null });
  } catch (e) {
    out.innerHTML = "<div class='tr-msg'>" + escapeHtml(e && e.message || e) + " <button data-agent='ask-check'>Ask again</button></div>";
    trCheckSaveAi(k, { at: Date.now(), error: String(e && e.message || e).slice(0, 200) });
  }
}

// Adds the AI agent's answer (or why there is none) to the saved run of the check.
function trCheckSaveAi(k, ai) {
  if (!self.ATLedgerDB || !TR.owner || !k.saved) return;
  const clone = JSON.parse(JSON.stringify(ai));
  k.saved.done.then(function () { return ATLedgerDB.updateCheck(TR.owner, k.saved.key, { ai: clone }); }).catch(function () { /* storage blocked */ });
}

// ---------- events ----------

document.addEventListener("click", function (ev) {
  const el = ev.target.closest && ev.target.closest("[data-agent]");
  if (!el) return;
  ev.preventDefault();
  const act = el.getAttribute("data-agent"), A = TR.agent;
  if (act === "view" || act === "h" || act === "lm") {
    if (act === "view") A.view = el.getAttribute("data-val") === "looks" ? "looks" : "trades";
    else if (act === "lm") A.lm = TR_AGENT_LM.indexOf(+el.getAttribute("data-val")) >= 0 ? +el.getAttribute("data-val") : 3;
    else A.h = +el.getAttribute("data-val") || 63;
    try { localStorage.setItem("at_agent_view", A.view); localStorage.setItem("at_agent_h", String(A.h)); localStorage.setItem("at_agent_lm", String(A.lm)); } catch (e) { /* storage blocked */ }
    trAgentRefresh();
  } else if (act === "tl") { A.tl = el.getAttribute("data-val") === "ai" ? { start: "ai", end: null } : { start: null, end: null }; trAgentRefresh(); }
  else if (act === "ai-run") trAgentAiRun();
  else if (act === "ai-stop") { A.stop = true; A.msg = "Stopping after this request..."; trAgentRefresh(); }
  else if (act === "ask-check") trAgentAskCheck(document.getElementById("tr-agent-check-ai"));
  else if (act === "hold") trAgentHoldOpen();
  else if (act === "cmp") trAgentCmpOpen();
  else if (act === "cmp-csv") trAgentCmpCsv();
  else if (act === "assign") {
    // open Matched stocks at the instrument, where a ticker can be chosen or typed
    trAgentHoldClose();
    TR.linksOpen = true;
    const d = document.getElementById("tr-links"), inst = el.getAttribute("data-inst");
    if (d) {
      d.open = true;
      const row = Array.prototype.find.call(d.querySelectorAll("tr[data-row]"), function (r) { return r.getAttribute("data-row") === inst; });
      (row || d).scrollIntoView({ block: "center" });
      if (row) { row.style.outline = "2px solid #a29bfe"; setTimeout(function () { row.style.outline = ""; }, 2500); }
    }
  }
  else if (act === "cmp-f") { A.cmpF = el.getAttribute("data-val") || "all"; const b = document.getElementById("tr-cmp-body"); if (b) b.innerHTML = trAgentCmpBody(); }
  else if (act === "hold-close") trAgentHoldClose();

});
