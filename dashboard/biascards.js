// My Habits > Trades & research: the questions grouped by decision stage, and the
// cards for the phase-1 bias indicators (src/indicators.js, R.ind). Loaded after
// trades.js and uses its helpers (trCard, trNotYet, trFigs, trPct, trPts, trChip...).
// See docs/bias-indicators-design.md.

// Cards per group. q: the key trCard gets (a number for the original questions,
// a name for the indicators); st: the card's status; calls: the card works
// without a broker import (shown to users who have not uploaded trades yet).
const TR_GROUPS = [
  { id: "A", title: "Research & attention", ask: "What do you look at, and what do you avoid?", cards: [
    { q: 1, title: "Does research come before your trades?", html: function (R) { return trQ1(R); }, st: function (R) { return R.q1.status; } },
    { q: 3, title: "Do researched trades turn out better?", html: function (R) { return trQ3(R); }, st: function (R) { return R.q3.status; } },
    { q: 6, title: "Which pages come before your buys?", html: function (R) { return trQ6(R); }, st: function (R) { return R.q6.status; } },
    { q: 7, title: "Do you trade on impulse, and when?", html: function (R) { return trQ7(R); }, st: function (R) { return R.q7.status; } },
    { q: "ostrich", title: "Do you look away after losses?", html: function (R) { return trOstrich(R); }, st: function (R) { return trInd(R, "ostrich").status; }, calls: true },
    { q: "confirmation", title: "Does news against your call change your mind?", html: function (R) { return trConfirmation(R); }, st: function (R) { return trBest(trInd(R, "confirmation").status, trInd(R, "entropy").status); }, calls: true },
    { q: "herding", title: "Do you follow the crowd?", html: function (R) { return trHerding(R); }, st: function (R) { return trInd(R, "herding").status; }, calls: true },
    { q: "attention", title: "Do you read the quarterly reports in time?", html: function (R) { return trAttention(R); }, st: function (R) { return trInd(R, "attention").status; }, calls: true }
  ] },
  { id: "B", title: "Buying", ask: "What and when do you buy?", cards: [
    { q: 4, title: "Do attention spikes and rising prices drive your buys?", html: function (R) { return trQ4(R); }, st: function (R) { return R.q4.status; } },
    { q: 10, title: "Does the market's mood move you?", html: function (R) { return trQ10(R); }, st: function (R) { return R.q10.status; } },
    { q: "extrapolation", title: "Do past returns drive your calls and buys?", html: function (R) { return trExtrapolation(R); }, st: function (R) { return trInd(R, "extrapolation").status; } },
    { q: "lottery", title: "Do you buy lottery tickets?", html: function (R) { return trLottery(R); }, st: function (R) { return trInd(R, "lottery").status; } },
    { q: "volume", title: "Does trading volume pull you in?", html: function (R) { return trVolume(R); }, st: function (R) { return trInd(R, "volume").status; } },
    { q: "crowdBuys", title: "Do you buy what the crowd is looking at?", html: function (R) { return trCrowdBuys(R); }, st: function (R) { return trInd(R, "crowdBuys").status; } },
    { q: "timing", title: "Does your timing beat a savings plan?", html: function (R) { return trTiming(R); }, st: function (R) { return trInd(R, "timing").status; } }
  ] },
  { id: "C", title: "Your calls", ask: "How good and how fixed are your judgements?", cards: [
    { q: "accuracy", title: "How often are your calls right?", html: function () { return trAccuracyLink(); }, st: function () { return null; }, calls: true, uncounted: true },
    { q: 2, title: "Do your trades follow your calls?", html: function (R) { return trQ2(R); }, st: function (R) { return R.q2.status; } },
    { q: 5, title: "How did the calls you passed on do?", html: function (R) { return trQ5(R); }, st: function (R) { return R.q5.status; } },
    { q: "anchoring", title: "Are your targets and sales anchored?", html: function (R) { return trAnchoring(R); }, st: function (R) { return trInd(R, "anchoring").status; }, calls: true },
    { q: "calibration", title: "Are your targets too far?", html: function (R) { return trCalibration(R); }, st: function (R) { return trInd(R, "calibration").status; }, calls: true }
  ] },
  { id: "D", title: "Selling & holding", ask: "When do you let go?", cards: [
    { q: 11, title: "Do you sell when your target is reached?", html: function (R) { return trQ11(R); }, st: function (R) { return R.q11.status; } },
    { q: 12, title: "Do you sell winners and keep losers?", html: function (R) { return trQ12(R); }, st: function (R) { return R.disposition.status; } },
    { q: 13, title: "Do you hold as long as you planned?", html: function (R) { return trQ13(R); }, st: function (R) { return R.horizon.status; } },
    { q: "rank", title: "Do you sell your best and worst first?", html: function (R) { return trRank(R); }, st: function (R) { return trInd(R, "rank").status; } },
    { q: "myopia", title: "Do short-term drops shake long-term positions?", html: function (R) { return trMyopia(R); }, st: function (R) { return trInd(R, "myopia").status; } },
    { q: "repurchase", title: "Which stocks you sold do you buy back?", html: function (R) { return trRepurchase(R); }, st: function (R) { return trInd(R, "repurchase").status; } }
  ] },
  { id: "E", title: "Portfolio & activity", ask: "How much do you trade, and how is the whole depot built?", cards: [
    { q: 8, title: "Do your biggest positions get the most research?", html: function (R) { return trQ8(R); }, st: function (R) { return R.q8.status; } },
    { q: 9, title: "Your holdings against your attention", html: function (R) { return trQ9(R); }, st: function (R) { return R.q9.status; } },
    { q: "overconfidence", title: "Do you trade more than your information supports?", html: function (R) { return trOverconfidence(R); }, st: function (R) { return trInd(R, "overconfidence").status; } },
    { q: "diversification", title: "How spread out is your depot?", html: function (R) { return trDiversification(R); }, st: function (R) { return trInd(R, "diversification").status; } },
    { q: "homebias", title: "Do you stay close to home?", html: function (R) { return trHomeBias(R); }, st: function (R) { return trInd(R, "homebias").status; } }
  ] }
];

// Card key -> the label shown on the card (A1, A2, ...), in group order.
const TR_CARD_LABEL = {};
TR_GROUPS.forEach(function (g) { g.cards.forEach(function (c, i) { TR_CARD_LABEL[c.q] = g.id + (i + 1); }); });

const TR_NONE = { status: "none" };
function trInd(R, k) { return (R.ind && R.ind[k]) || TR_NONE; }
function trBest() { const r = { none: 0, indicative: 1, solid: 2 }; return Array.prototype.reduce.call(arguments, function (b, s) { return (r[s] || 0) > (r[b] || 0) ? s : b; }, "none"); }
function trGroupOpen(id, def) {
  try { const v = JSON.parse(localStorage.getItem("at_tr_groups") || "{}")[id]; return v == null ? def : !!v; } catch (e) { return def; }
}
function trGroupRemember(id, open) {
  try { const m = JSON.parse(localStorage.getItem("at_tr_groups") || "{}"); m[id] = open; localStorage.setItem("at_tr_groups", JSON.stringify(m)); } catch (e) { /* ignore */ }
}

// The question groups. callsOnly: no broker import yet, so only the research and
// calls groups are shown, with the trade questions as previews of what an import adds.
function trGroupsHtml(R, callsOnly) {
  const groups = callsOnly ? TR_GROUPS.filter(function (g) { return g.id === "A" || g.id === "C"; }) : TR_GROUPS;
  return groups.map(function (g) {
    let answered = 0, solid = 0, counted = 0;
    const marks = [];
    // Without an import, what can already be answered comes first, the previews after.
    const list = callsOnly ? g.cards.filter(function (c) { return c.calls; }).concat(g.cards.filter(function (c) { return !c.calls; })) : g.cards;
    const cards = list.map(function (c) {
      if (callsOnly && !c.calls) { marks.push({ t: c.title, st: "none" }); return trTeaser(c); }
      let st = null;
      try { st = c.st(R); } catch (e) { st = null; }
      marks.push({ t: c.title, st: st || "none" });
      if (!c.uncounted) { counted++; if (st && st !== "none") answered++; if (st === "solid") solid++; }
      try { return c.html(R); }
      catch (e) { return "<div class='card tr-q'><div class='tr-q-head'><span class='tr-q-num'>" + TR_CARD_LABEL[c.q] + "</span><h4>" + c.title + "</h4></div><div class='tr-msg'>Could not build this card: " + escapeHtml(e && e.message || e) + "</div></div>"; }
    });
    const open = trGroupOpen(g.id, answered > 0 || callsOnly);
    const count = callsOnly ? (answered ? answered + " with enough data, the rest after an import" : "trade questions open after an import")
      : answered ? answered + " of " + counted + " with enough data" + (solid ? ", " + solid + " solid" : "") : "not enough data yet";
    return "<details class='tr-group' data-group='" + g.id + "'" + (open ? " open" : "") + "><summary><span class='tr-group-id'>" + g.id + "</span>" +
      "<span class='tr-group-t'><b>" + g.title + "</b><span class='muted small'>" + g.ask + "</span></span>" + trCarDotsHtml(g.id, marks) + "<span class='tr-group-n muted small'>" + count + "</span></summary>" +
      trCarouselHtml(g.id, cards) + "</details>";
  }).join("");
}

// ---------- one card at a time ----------
// Each group shows a single card; arrows, dots, the keyboard and a swipe move
// between them. The track slides, and the view eases to the height of the card
// shown so a short card leaves no gap.
const TR_CAR = {}; // group id -> index of the card shown, kept across re-renders

// The dots that say which card shows sit in the headline of the section (trCarDotsHtml), the
// arrows at the two sides of the card (trCarouselHtml); both find the carousel by its group id.
function trCarDotsHtml(gid, marks) {
  const n = marks.length;
  if (n < 2) return "";
  const i = Math.min(Math.max(TR_CAR[gid] || 0, 0), n - 1);
  return "<span class='tr-car-dots'>" + marks.map(function (m, k) {
    return "<button type='button' class='tr-car-dot st-" + m.st + (k === i ? " on" : "") + "' data-car='go' data-g='" + gid + "' data-i='" + k + "' aria-label='" + escapeHtml((m.l || gid + (k + 1)) + ": " + m.t) + "'></button>";
  }).join("") + "</span>";
}

// A section headline with the dots in its middle: title left, dots centred, extra right.
function trCarHeadHtml(cls, titleHtml, gid, marks) {
  return "<h4 class='" + cls + " tr-car-head'><span class='tr-car-h-t'>" + titleHtml + "</span>" + trCarDotsHtml(gid, marks) + "<span class='tr-car-h-r'></span></h4>";
}

function trCarouselHtml(gid, cards) {
  const n = cards.length;
  if (!n) return "";
  const i = Math.min(Math.max(TR_CAR[gid] || 0, 0), n - 1);
  return "<div class='tr-car' data-g='" + gid + "' data-i='" + i + "' tabindex='0' aria-roledescription='carousel'>" +
    (n > 1 ? "<button type='button' class='tr-car-arrow prev' data-car='prev' aria-label='Previous card'>&#8249;</button><button type='button' class='tr-car-arrow next' data-car='next' aria-label='Next card'>&#8250;</button>" : "") +
    "<div class='tr-car-view'><div class='tr-car-track' style='transform:translateX(-" + i * 100 + "%)'>" +
    cards.map(function (c, k) { return "<div class='tr-car-slide" + (k === i ? " on" : "") + "'" + (k === i ? "" : " inert") + ">" + c + "</div>"; }).join("") +
    "</div></div></div>";
}

function trCarGo(car, i) {
  const slides = car.querySelectorAll(".tr-car-slide"), n = slides.length;
  i = ((i % n) + n) % n; // endless: past the last card comes the first, before the first the last
  TR_CAR[car.getAttribute("data-g")] = i;
  car.setAttribute("data-i", i);
  car.querySelector(".tr-car-track").style.transform = "translateX(-" + i * 100 + "%)";
  slides.forEach(function (sl, k) {
    sl.classList.toggle("on", k === i);
    if (k === i) sl.removeAttribute("inert"); else sl.setAttribute("inert", "");
  });
  document.querySelectorAll(".tr-car-dot[data-g='" + car.getAttribute("data-g") + "']").forEach(function (d, k) { d.classList.toggle("on", k === i); });
  trCarFit(car);
}
function trCarFit(car) {
  const sl = car.querySelector(".tr-car-slide.on"), v = car.querySelector(".tr-car-view");
  if (sl && v && sl.offsetHeight) v.style.height = sl.offsetHeight + "px";
}
function trCarInit(car) {
  if (car._init) return;
  car._init = true;
  // A card's own height changes (a chart drawn, an explanation opened): follow it.
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(function () { trCarFit(car); }) : null;
  car.querySelectorAll(".tr-car-slide").forEach(function (sl) { if (ro) ro.observe(sl); });
  trCarFit(car);
  requestAnimationFrame(function () { car.classList.add("ready"); }); // no slide on the first paint
}
(function () {
  const scan = function () { document.querySelectorAll(".tr-car").forEach(trCarInit); };
  const start = function () { new MutationObserver(scan).observe(document.body, { childList: true, subtree: true }); scan(); };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
document.addEventListener("click", function (ev) {
  const b = ev.target.closest && ev.target.closest("[data-car]");
  if (!b) return;
  const car = b.closest(".tr-car") || document.querySelector(".tr-car[data-g='" + b.getAttribute("data-g") + "']");
  if (!car) return;
  ev.preventDefault();
  const i = +car.getAttribute("data-i"), a = b.getAttribute("data-car");
  trCarGo(car, a === "prev" ? i - 1 : a === "next" ? i + 1 : +b.getAttribute("data-i"));
});
document.addEventListener("keydown", function (ev) {
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  const t = ev.target;
  if (!t || !t.closest || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
  const car = t.closest(".tr-car");
  if (!car) return;
  ev.preventDefault();
  trCarGo(car, +car.getAttribute("data-i") + (ev.key === "ArrowRight" ? 1 : -1));
});
(function () {
  let sx = 0, sy = 0, car = null, t0 = 0;
  document.addEventListener("pointerdown", function (ev) {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    const view = ev.target.closest && ev.target.closest(".tr-car-view");
    car = view && !ev.target.closest("input, select, textarea, button, a, canvas, summary, .tr-info") ? view.closest(".tr-car") : null;
    sx = ev.clientX; sy = ev.clientY; t0 = Date.now();
  });
  document.addEventListener("pointerup", function (ev) {
    if (!car) return;
    const dx = ev.clientX - sx, dy = ev.clientY - sy, c = car;
    car = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < 1.5 * Math.abs(dy) || Date.now() - t0 > 700) return;
    trCarGo(c, +c.getAttribute("data-i") + (dx < 0 ? 1 : -1));
  });
  document.addEventListener("pointercancel", function () { car = null; });
})();

function trTeaser(c) {
  return "<div class='card tr-q tr-teaser'><div class='tr-q-head'><span class='tr-q-num'>" + TR_CARD_LABEL[c.q] + "</span><h4>" + c.title + "</h4><span class='tr-chip st-none'>Needs your trades</span></div>" +
    "<div class='tr-answer muted'>Import your broker's transaction export above to answer this. The file is read in this browser and never leaves it.</div></div>";
}

function trAccuracyLink() {
  return trCard("accuracy", "How often are your calls right?", null, false,
    "<div class='tr-answer'>Hit rates, Brier score and the pace of your targets are in <a href='#' data-act='open-predictions'>Predictions</a>. " +
    "The cards here ask what you do with those calls.</div>",
    "Predictions scores every Positive or Negative label: did the price move the way you called it, and did it reach your target before your horizon ran out.");
}

// Without a broker import: the indicators that run on views and calls alone,
// under the import panel, so the value of an import is visible before it.
function trCallsOnlyHtml(R) {
  return "<div class='tr-wrap tr-callsonly'>" + trSectionHead("What your research and calls already say",
    "These run on what Stocktrails records. The questions marked \"Needs your trades\" open once you import your broker's export.") +
    trGroupsHtml(R, true) + "</div>";
}

// ---------- A5 ostrich ----------

function trOstrich(R) {
  const o = trInd(R, "ostrich");
  let body;
  if (!o.positions) body = "<div class='tr-answer muted'>No positions known yet. Import your trades, or tick <b>Position taken</b> in the label widget on the stocks you hold.</div>";
  else if (o.status === "none") body = trNotYet(o.n, o.need.min, "held position-days after a rise and after a fall", null);
  else body = "<div class='tr-answer'>You looked at a position on <b>" + trPct(o.up.p) + "</b> of days after it rose more than 1%, and on <b>" + trPct(o.down.p) + "</b> of days after it fell more than 1%" +
    (o.clear ? ": you look away after losses (the ostrich effect)." : o.diff.lo != null && o.diff.hi < 0 ? ": you look more closely after losses." : ": no clear difference.") + "</div>";
  const figs = [];
  if (o.depth && o.depth.loss.n && o.depth.gain.n) figs.push("A look at a position under water lasted " + o.depth.loss.dwell.toFixed(1) + " min" + (o.depth.loss.scroll != null ? " (scrolled " + trPct(o.depth.loss.scroll) + ")" : "") +
    ", one in profit " + o.depth.gain.dwell.toFixed(1) + " min" + (o.depth.gain.scroll != null ? " (scrolled " + trPct(o.depth.gain.scroll) + ")" : ""));
  if (o.gaps && (o.gaps.loss.n || o.gaps.gain.n)) figs.push("After a position fell 10% below your cost, your next look came after a median of " + trKm(o.gaps.loss) + "; after it rose 10% above, " + trKm(o.gaps.gain));
  if (o.fromLabels) figs.push("Positions come from your <b>Position taken</b> labels, held from the first tick until you untick it. A broker import makes this exact.");
  return trCard("ostrich", "Do you look away after losses?", o.status, o.clear, body + trFigs(figs),
    "For every day a position was held (from your trades, or from Position taken labels without them): did you view that stock that day, after the previous day's close moved it by more than +1% or -1%? " +
    "The two shares are compared with a range that resamples whole weeks, because looks cluster. Karlsson, Loewenstein &amp; Seppi (2009) and Sicherman et al. (2016) found investors log in less after the market falls.");
}
function trKm(g) { return g.median != null ? Math.round(g.median) + " days (" + g.n + ")" : g.n ? "more than half still pending (" + g.n + ")" : "-"; }

// ---------- A6 confirmation ----------

function trConfirmation(R) {
  const c = trInd(R, "confirmation"), e = trInd(R, "entropy"), st = trBest(c.status, e.status);
  let body;
  if (c.status === "none") body = trNotYet(c.n || 0, (c.need || { min: 10 }).min, "sharp moves against a standing Positive or Negative call", null);
  else body = "<div class='tr-answer'>After a sharp move <b>against</b> your call you changed the call within two weeks <b>" + trPct(c.contrary.rev.p) + "</b> of the time; after one in its favour <b>" + trPct(c.confirming.rev.p) + "</b>" +
    (c.signal ? ". News against your view does not make you change your mind more often: a sign of confirmation bias." : c.changes < 5 ? ". You rarely change a call (" + c.changes + " changes so far), so this cannot tell yet." :
      c.diff.lo != null && c.diff.lo > 0 ? ". You do respond to news against your view." : ". No clear pattern yet.") + "</div>";
  const figs = [];
  if (c.contrary && c.contrary.look.n) figs.push("You looked at the stock within 5 days after " + trPct(c.contrary.look.p) + " of the moves against your call");
  if (c.mix && c.mix.before.n && c.mix.after.n) figs.push("Share of reading time on checking pages (financials, ownership, estimates, insider, short interest) in the 30 days before a call " + trPct(c.mix.before.mean) + ", after it " + trPct(c.mix.after.mean));
  if (e.withCall && e.withCall.n && e.without.n) figs.push("Variety of page types per stock and month: " + e.withCall.mean.toFixed(2) + " bits on stocks with a call, " + e.without.mean.toFixed(2) + " without" + (e.clear ? " (clearly narrower)" : ""));
  return trCard("confirmation", "Does news against your call change your mind?", st, c.clear || e.clear, body + trFigs(figs),
    "A sharp move is a daily return beyond 5%, or beyond twice the stock's usual daily swing over the 60 days before. For each Positive or Negative call, the first sharp move against it and the first in its favour are checked for a change of the call in the 14 days after. " +
    "A reader who weighs evidence evenly changes a call more often after news against it. The signal needs at least 5 call changes overall, and the range must rule out that news against the call raises the change rate by 10 points or more. " +
    "Variety is the Shannon entropy of the page types you read (3 or more views a month). Nickerson (1998); Park et al. (2013).");
}

// ---------- A7 herding ----------

function trHerding(R) {
  const h = trInd(R, "herding"), cr = R.ind && R.ind.crowd;
  let body;
  if (h.noData) body = "<div class='tr-answer muted'>Needs the community's views and the trending lists: sign in (Settings &rarr; Account) to compare your first looks with them.</div>";
  else if (h.status === "none") body = trNotYet(h.n || 0, h.need.min, "first looks at a stock since community data starts", null);
  else body = "<div class='tr-answer'><b>" + trPct(h.followed.p) + "</b> of your first looks at a stock came within 3 days after the Stocktrails community or an outside trending list piled in; " +
    "by each stock's own rate, chance would give " + trPct(h.chance) + (h.clear ? ". You tend to follow the crowd." : h.excess.hi != null && h.excess.hi < 0 ? ". You find stocks away from the crowd." : ".") + "</div>";
  const figs = [];
  if (h.lead && h.lead.n) figs.push(trPct(h.lead.p) + " of your first looks came before the community had viewed the stock in the previous 30 days, with 3 or more community views in the week after");
  const ch = trInd(R, "communityHerding");
  if (ch.h && ch.h.est != null) figs.push("The whole community: first looks at a stock bunch on the same days " + (ch.clear ? "more than chance would (" : "about as chance would (") +
    "herding measure " + ch.h.est.toFixed(3) + ", 95% range " + (ch.h.lo != null ? ch.h.lo.toFixed(3) + " to " + ch.h.hi.toFixed(3) : "-") + ", " + ch.n + " days, " + ch.tickers + " stocks)");
  if (cr) figs.push("Your daily mix of stocks matched the community's " + trPct(cr.last) + " over the last 30 days" + (cr.prev != null ? " (" + trPct(cr.prev) + " the 30 days before)" : ""));
  return trCard("herding", "Do you follow the crowd?", h.status, h.clear, body + trFigs(figs),
    "Your first recorded view of each stock against two crowds: the Stocktrails community (views from at least 3 users) and the outside trending lists (StockAnalysis, Stocktwits, Reddit via ApeWisdom, Yahoo). " +
    "A crowd move: in the 3 days before, the community viewed the stock at least 3 times and twice its own 30-day rate, or it was on a trending list. Chance is each stock's own share of crowd-move days, so a stock that is always popular does not count. " +
    "The community measure adapts Lakonishok, Shleifer &amp; Vishny (1992) to first looks: for a stock on a day with a first look, the share of active users who found it that day against its own average share, minus what binomial chance gives (0 = no herding). " +
    "Your trades stay on this device, so herding in trades is studied only in simulations. Kumar &amp; Lee (2006); Barber, Odean &amp; Zhu (2009).");
}

// ---------- D4 rank effect ----------

function trRank(R) {
  const k = trInd(R, "rank");
  let body = k.status === "none" ? trNotYet(k.n || 0, k.need.min, "days with a sale and at least 3 positions", null)
    : "<div class='tr-answer'>On the " + k.n + " days you sold with 3 or more positions, you sold your <b>best</b> position " + trPct(k.best.p) + " of the time, your <b>worst</b> " + trPct(k.worst.p) +
      ", and one <b>in the middle</b> " + trPct(k.middle.p) + (k.clear ? ": the extremes leave your depot first (the rank effect)." : ".") + "</div>";
  const figs = [];
  if (k.views) figs.push("Your best and worst positions got " + trPct(k.views.share) + " of your views of your own positions; as 2 of the positions held they would get " + trPct(k.views.base));
  return trCard("rank", "Do you sell your best and worst first?", k.status, k.clear, body + trFigs(figs),
    "On each day with a sale, every position is ranked by its return on cost at the previous close. The share sold among the best, the worst and the rest is compared, with a range that resamples whole sale days. " +
    "Hartzmark (2015) found investors sell their best and worst positions far more often than the middle ones, whatever the returns.");
}

// ---------- D5 myopic loss aversion ----------

function trMyopia(R) {
  const m = trInd(R, "myopia"), h = R.horizon;
  let body;
  if (!m.n && !m.positions) body = "<div class='tr-answer muted'>Needs positions bought under a Positive call with a horizon of a year or more. Set a horizon in the label widget before you buy.</div>";
  else if (m.status === "none") body = trNotYet(m.n, m.need.min, "positions bought with a horizon of a year or more", null);
  else body = "<div class='tr-answer'>Positions you bought with a horizon of a year or more: you sold within a week of a 5% drop <b>" + trPct(m.dip.p) + "</b> of the time, otherwise <b>" + trPct(m.noDip.p) + "</b>" +
    (m.clear ? ". Short drops shake positions you meant to hold for long." : ".") + "</div>";
  const figs = [];
  if (m.watch && m.watch.long.n && m.watch.short.n) figs.push("Looks per week at long-horizon positions " + m.watch.long.mean.toFixed(1) + ", at positions with a horizon of 3 months or less " + m.watch.short.mean.toFixed(1));
  if (h && h.n) figs.push("Card " + TR_CARD_LABEL[13] + ": " + h.early + " of " + h.n + " buys with a horizon were sold before half of it");
  return trCard("myopia", "Do short-term drops shake long-term positions?", m.status, m.clear, body + trFigs(figs),
    "For positions bought under a Positive call with a horizon of a year or more, every 5th trading day while held: was there a drop of 5% or more over the 5 days before, and did a sale follow within 5 trading days? " +
    "The range resamples whole positions. Benartzi &amp; Thaler (1995): checking often makes losses visible often, and investors with a long horizon then act as if it were short; Gneezy &amp; Potters (1997) showed it in an experiment.");
}

// ---------- D6 repurchase ----------

function trRepurchase(R) {
  const p = trInd(R, "repurchase");
  let body = p.status === "none" ? trNotYet(p.n || 0, p.need.min, "positions you closed", null)
    : "<div class='tr-answer'>After closing a position, the share of months in which you bought it back: sold at a gain and the price fell since <b>" + trPct(p.cells.gainDown.p) + "</b>, " +
      "sold at a gain and it rose " + trPct(p.cells.gainUp.p) + "; sold at a loss and it fell " + trPct(p.cells.lossDown.p) + ", and it rose " + trPct(p.cells.lossUp.p) + "." +
      (p.clear ? (p.diff.est > 0 ? " You come back once a stock is cheaper than where you sold it." : " You come back after it has risen further.") : "") + "</div>";
  const figs = [];
  if (p.watch && (p.watch.up.n || p.watch.down.n)) figs.push("Views in the 3 months after a sale you did not reverse: " + (p.watch.down.mean != null ? p.watch.down.mean.toFixed(1) : "-") + " when the price was below your sale price a month later, " +
    (p.watch.up.mean != null ? p.watch.up.mean.toFixed(1) : "-") + " when it was above");
  return trCard("repurchase", "Which stocks you sold do you buy back?", p.status, p.clear, body + trFigs(figs),
    "Every full sale, then each following month (up to 12) until you buy the stock again: was the price at the start of the month below or above your sale price, and did you buy it back that month? " +
    "Strahilevitz, Odean &amp; Barber (2011): investors avoid buying back what would remind them of a mistake, and prefer stocks that fell after a sale at a gain.");
}

// ---------- E3 overconfidence ----------

function trOverconfidence(R) {
  const o = trInd(R, "overconfidence");
  if (o === TR_NONE) return trCard("overconfidence", "Do you trade more than your information supports?", "none", false, "<div class='tr-answer muted'>No trades yet.</div>", "");
  const t = o.turnover, od = o.odean, pt = o.perTrade;
  let body = t.status === "none" ? trNotYet(t.n, t.need.min, "months with a depot", null)
    : "<div class='tr-answer'>You turn over <b>" + trPct(t.annual) + "</b> of your depot a year (buys " + trPct(t.buy) + ", sales " + trPct(t.sell) + ", in " + escapeHtml(t.currency || "") + ")" +
      (t.annual > 0.75 ? ", more than the average private investor in Barber &amp; Odean's data (about 75%)." : ".") + "</div>";
  const figs = [];
  if (t.costs != null && t.costs > 0) figs.push("Fees: " + trPct(t.costs) + " of your depot a year");
  if (od.n) figs.push("Switches (a sale followed within 3 weeks by a buy of something else, " + od.n + "): what you bought did " + trPts(od[21].est) + " against what you sold over 1 month, " +
    trPts(od[84].est) + " over 4 months" + (od[252].n ? ", " + trPts(od[252].est) + " over 12 months" : "") + (od.clear ? ". Your switches cost you money." : od[84].lo != null && od[84].lo > 0 ? ". Your switches paid off." : ""));
  const cal = trInd(R, "calibration");
  if (cal.n) figs.push("Card " + TR_CARD_LABEL.calibration + ": your targets asked for a median " + trPct(cal.medianReq) + " move where the stocks gave " + trPct(cal.medianBest));
  if (pt.corr && pt.corr.r != null) figs.push("Months with more trades against research minutes per trade: Spearman r " + pt.corr.r.toFixed(2) + (pt.clear ? " (clearly less research when you trade more)" : ""));
  return trCard("overconfidence", "Do you trade more than your information supports?", o.status, o.clear, body + trFigs(figs),
    "Turnover: each month, buys and sales (savings plans left out) over the depot value at the start of the month, averaged and times 12; values use Yahoo closes at the exchange rate of your buys. " +
    "Odean test: both legs of a switch measured from the buy day against the NASDAQ (Odean 1999 found the stocks bought did worse than those sold). Barber &amp; Odean (2000, 2001): the more private investors trade, the less they earn.");
}

// ---------- E4 diversification ----------

function trDiversification(R) {
  const d = trInd(R, "diversification");
  if (d === TR_NONE) return trCard("diversification", "How spread out is your depot?", "none", false, "<div class='tr-answer muted'>No trades yet.</div>", "");
  const h = d.holdings, l = h.last, n = d.oneOverN;
  let body = h.status === "none" || !l ? trNotYet(h.n, h.need.min, "month-ends with a depot", null)
    : "<div class='tr-answer'>At the end of the last month your depot held <b>" + l.n + "</b> positions; the largest was " + trPct(l.top) + ", worth as much spread as <b>" + l.eff.toFixed(1) + "</b> equal positions" +
      (l.fundShare > 0 ? ", " + trPct(l.fundShare) + " in funds and ETFs" : "") + (d.concentrated ? ". Few single stocks carry the depot." : ".") + "</div>";
  const figs = [];
  if (h.n > 1) figs.push("Over " + h.n + " months: a median of " + h.medianPositions + " positions, concentration (HHI) " + h.medianHhi.toFixed(2) + " (1 = everything in one, 0.1 = ten equal positions)");
  if (l && l.corr != null) figs.push("Average correlation between your single stocks over the last 60 trading days: " + l.corr.toFixed(2));
  if (l && l.unknownSector >= 0.5) figs.push("Sectors are not known yet for " + trPct(l.unknownSector) + " of the depot (Yahoo gives no profile for those listings)");
  else if (l && l.topSector) figs.push("Largest sector: " + escapeHtml(l.topSector) + " at " + trPct(l.topSectorShare) + " of the depot; sector concentration (HHI) " + l.sectorHhi.toFixed(2) +
    (l.unknownSector > 0 ? " (" + trPct(l.unknownSector) + " without a known sector)" : "") + (d.sectorHeavy ? ". Most of the depot rides on one sector." : ""));
  if (l && l.topCountry) figs.push("Largest country (by ISIN): " + escapeHtml(trCountryName(l.topCountry)) + " at " + trPct(l.topCountryShare) + "; country concentration (HHI) " + l.countryHhi.toFixed(2));
  if (d.research) figs.push("Your views in the last 90 days: " + trPct(d.research.topShare) + " on " + escapeHtml(d.research.top) + ", sector concentration " + d.research.hhi.toFixed(2));
  if (n.n) figs.push(trPct(n.same.p) + " of your buys repeat the amount of a buy made within a month (by chance about " + (n.chance != null ? trPct(n.chance) : "-") + "); " + trPct(n.round.p) + " are round sums of 500" +
    (n.signal ? ". You size by a fixed sum rather than by the stock (the 1/n habit)." : ""));
  return trCard("diversification", "How spread out is your depot?", d.status, false, body + trFigs(figs),
    "Month-end values of your positions (Yahoo closes at the exchange rate of your buys, main currency only). Concentration is the Herfindahl index of the weights; ETFs and funds count as one position each, so an ETF depot can read concentrated while it is not. " +
    "Repeated amounts are compared with shuffling the amounts among neighbouring buys. Sectors come from Yahoo's profile of each listing (funds count as one sector, unknown sectors are shown apart); countries from the ISIN prefix (the domicile, so an ADR counts as US). Goetzmann &amp; Kumar (2008); Benartzi &amp; Thaler (2001).");
}

// Extra rows for "How much can your data say?".
function trIndSuffRows(R) {
  const X = R.ind || {}, L = TR_CARD_LABEL, rows = [];
  const row = function (k, label, x, unit, n) { if (x && x.need) rows.push([L[k] + ". " + label, n != null ? n : x.n || 0, x.need, unit, null]); };
  row("ostrich", "Looking away after losses", X.ostrich, "held position-days on the smaller side (after a rise / after a fall)");
  row("confirmation", "News against your call", X.confirmation, "sharp moves against a standing call");
  row("herding", "Following the crowd", X.herding, "first looks with community data");
  row("rank", "Best and worst first", X.rank, "days with a sale and 3+ positions");
  row("myopia", "Drops and long horizons", X.myopia, "positions bought with a horizon of a year or more");
  row("repurchase", "Buying back", X.repurchase, "positions you closed");
  if (X.overconfidence) { row("overconfidence", "Turnover", X.overconfidence.turnover, "months with a depot"); rows.push([L.overconfidence + ". Switches", X.overconfidence.odean.n, X.overconfidence.odean.need, "sale -> buy switches", null]); }
  if (X.diversification) row("diversification", "Depot spread", X.diversification.holdings, "month-ends with a depot");
  if (X.extrapolation) { row("extrapolation", "Calls vs past returns", X.extrapolation.calls, "calls with 3 months of prices before"); row("extrapolation", "Buys vs past returns", X.extrapolation.buys, "buys with 5+ stocks viewed alongside"); }
  row("lottery", "Lottery stocks", X.lottery, "buys with a year of prices before");
  if (X.attention && !X.attention.noData) row("attention", "Reading reports in time", X.attention, "earnings releases with a complete 14-day window");
  row("volume", "Volume spikes", X.volume, "buys with volume history");
  if (X.crowdBuys && !X.crowdBuys.noData) row("crowdBuys", "Buying with the crowd", X.crowdBuys, "buys with community data for the stock");
  if (X.timing) rows.push([L.timing + ". Timing against a plan", X.timing.same.n, X.timing.need, "timed buys in 3+ stocks over 2+ months", null]);
  if (X.anchoring) { row("anchoring", "Round targets", X.anchoring.targets, "calls with a target price"); row("anchoring", "Break-even sales", X.anchoring.breakEven, "full sales with a cost"); row("anchoring", "Buys near the high", X.anchoring.nearHigh, "buys with a 52-week high"); }
  row("calibration", "Target calibration", X.calibration, "calls with a target and a horizon that has passed");
  if (X.homebias && !X.homebias.noHome) row("homebias", "Home bias", X.homebias, "months with views");
  return rows;
}

// Findings for "What your trades say about you" from the indicators, worded as the coach words them.
function trIndFindings(R) {
  if (!R.ind || !self.ATBiases) return [];
  const ids = { overconfidence: 1, ostrich: 1, confirmation: 1, herding: 1, rank: 1, myopia: 1, repurchase: 1, diversification: 1,
    extrapolation: 1, lottery: 1, anchoring: 1, homebias: 1, volume: 1, underreaction: 1, crowd_buys: 1, timing: 1 };
  return ATBiases.detect(R).filter(function (b) { return ids[b.id]; }).map(function (b) {
    return { status: b.status, clear: b.clear, title: b.name, text: b.signals.map(function (s) { return s.text; }).join(" "), quote: b.id === "herding" || b.id === "crowd_buys" ? TR_QUOTES.fearGreed : TR_QUOTES.self };
  });
}

// Community data for herding, once per session: the community's daily views per
// stock, the outside trending lists' top 20, and your daily overlap with the crowd.
async function trCommunityData() {
  if (TR.comm) return TR.comm;
  const out = { community: null, trending: null, crowd: null, firstLooks: null };
  try {
    if (self.ATCloud && ATCloud.enabled() && (await ATCloud.getUser())) {
      const res = await Promise.all([
        ATCloud.networkCommunityDaily().catch(function () { return null; }),
        ATCloud.trendingDaily(365, 20).catch(function () { return null; }),
        ATCloud.worldCrowdOverlap(120).catch(function () { return null; }),
        ATCloud.communityFirstLooks ? ATCloud.communityFirstLooks(180).catch(function () { return null; }) : null
      ]);
      out.firstLooks = res[3];
      out.community = res[0];
      if (res[1]) {
        out.trending = {};
        res[1].forEach(function (r) {
          const m = out.trending[r.day] = out.trending[r.day] || {};
          Object.keys(r.weights || {}).forEach(function (t) { m[String(t).toUpperCase()] = 1; });
        });
      }
      out.crowd = res[2];
    }
  } catch (e) { /* signed out or offline: herding says it needs community data */ }
  TR.comm = out;
  return out;
}

// ---------- phase 2 cards ----------

function trCountryName(cc) { return (self.ATIndicators && ATIndicators.COUNTRY_NAMES[cc]) || cc; }

function trExtrapolation(R) {
  const x = trInd(R, "extrapolation");
  if (x === TR_NONE) return trCard("extrapolation", "Do past returns drive your calls and buys?", "none", false, "<div class='tr-answer muted'>Not computed.</div>", "");
  const c = x.calls, b = x.buys, r = function (k) { return c[k] && c[k].r != null ? (c[k].r >= 0 ? "+" : "") + c[k].r.toFixed(2) : "-"; };
  let body = x.status === "none" ? trNotYet(Math.max(c.n, b.n), c.need.min, "calls (or buys) with 3 months of prices before", null)
    : "<div class='tr-answer'>" + (c.n ? "Your calls against the stock's past return: correlation <b>" + r("m1") + "</b> over 1 month, <b>" + r("m3") + "</b> over 3, <b>" + r("m12") + "</b> over 12 (" + c.n + " calls)" +
      (c.clear ? ". You call up what went up and down what went down." : ".") : "") +
      (b.n ? " Your buys ranked at the <b>" + trPct(b.p12.est != null ? b.p12.est : b.p3.est) + "</b> percentile of past " + (b.p12.est != null ? "12" : "3") + "-month returns among the stocks you were viewing" +
        (b.clear ? ": you pick the recent winners." : ".") : "") + "</div>";
  const figs = [];
  if (c.implied && c.implied.r != null) figs.push("How far your targets reach against the past 3 months: Spearman r " + c.implied.r.toFixed(2) + " (" + c.implied.n + " targets)");
  figs.push("Which pages you read before buys (chart vs financials) is in card " + TR_CARD_LABEL[6]);
  return trCard("extrapolation", "Do past returns drive your calls and buys?", x.status, x.clear, body + trFigs(figs),
    "Calls: the sign of each Positive (+1) or Negative (-1) call against the stock's return over the 1, 3 and 12 months before it; three correlations read together, so 99% ranges. " +
    "Buys: the bought stock's past 3- and 12-month return ranked among every stock you viewed in the 30 days before (0.5 = the middle). Unlike card " + TR_CARD_LABEL[4] + " (the rise since your first look) this uses a fixed lookback. " +
    "De Bondt (1993); Benartzi (2001); Greenwood &amp; Shleifer (2014): private investors expect past returns to continue.");
}

function trLottery(R) {
  const x = trInd(R, "lottery");
  if (x === TR_NONE) return trCard("lottery", "Do you buy lottery tickets?", "none", false, "<div class='tr-answer muted'>Not computed.</div>", "");
  let body = x.status === "none" ? trNotYet(x.n, x.need.min, "buys with a year of prices before", null)
    : "<div class='tr-answer'><b>" + trPct(x.buys.p) + "</b> of your buys were lottery stocks that day, against <b>" + trPct(x.views.p) + "</b> of the stocks you viewed" +
      (x.tilt ? ": you buy them far more than you look at them." : ".") + "</div>";
  const figs = [], rd = x.returns;
  if (rd.lottery.n && rd.other.n) figs.push("Next 3 months against the NASDAQ: lottery buys " + trPts(rd.lottery.mean) + " (" + rd.lottery.n + "), others " + trPts(rd.other.mean) + " (" + rd.other.n + ")" + (x.clear ? ". Lottery buys clearly did worse." : ""));
  if (x.calls.n) figs.push(trPct(x.calls.p) + " of your Positive calls with a target and a horizon aimed at more than +100% within 3 months");
  if (x.sessions) figs.push("Research sessions: " + x.sessions.perWeek.toFixed(1) + " a week, a median of " + x.sessions.minutes.toFixed(0) + " min and " + x.sessions.tickers + " stock(s) each");
  const t = x.thresholds;
  return trCard("lottery", "Do you buy lottery tickets?", x.status, x.clear, body + trFigs(figs),
    "A lottery stock on a day, from the bars before it, with fixed thresholds: its best day in the last month above +" + Math.round(t.max * 100) + "% (Bali, Cakici &amp; Whitelaw 2011), or all three of Kumar's (2009) criteria: a price under " + t.price + " USD, " +
    "stock-specific volatility above " + Math.round(t.ivol * 100) + "% a year and stock-specific skewness above " + t.iskew + " over the last " + t.window + " trading days (against the NASDAQ). " +
    "The price test runs only for USD listings for now. Fixed thresholds keep the label the same for everyone; they may move to community-calibrated ones once the community is large.");
}

function trVolume(R) {
  const x = trInd(R, "volume");
  if (x === TR_NONE) return trCard("volume", "Does trading volume pull you in?", "none", false, "<div class='tr-answer muted'>Needs your trades.</div>", "");
  let body = x.status === "none" ? trNotYet(x.n, x.need.min, "buys with volume history", null)
    : "<div class='tr-answer'><b>" + trPct(x.share.p) + "</b> of your buys came the day after the stock traded more than twice its usual volume; by its own rate over the 90 days before, chance gives " + trPct(x.chance) +
      (x.clear ? ". Heavy trading draws your buys." : ".") + "</div>";
  const figs = [];
  if (x.loud.n && x.quiet.n) figs.push("First looks on a heavy-volume day became a buy within 48 hours " + trPct(x.loud.p) + " of the time (" + x.loud.n + "), on other days " + trPct(x.quiet.p) + " (" + x.quiet.n + ")");
  return trCard("volume", "Does trading volume pull you in?", x.status, x.clear, body + trFigs(figs),
    "Abnormal volume: the trading day before the buy saw more than twice the median volume of the 60 days before it. Barber &amp; Odean (2008): private investors are net buyers of stocks in the news, with high volume or extreme returns. Card " +
    TR_CARD_LABEL[4] + " measures the same pull through your own attention spikes.");
}

function trCrowdBuys(R) {
  const x = trInd(R, "crowdBuys"), T = "Do you buy what the crowd is looking at?";
  if (x === TR_NONE) return trCard("crowdBuys", T, "none", false, "<div class='tr-answer muted'>Needs your trades.</div>", "");
  if (x.noData) return trCard("crowdBuys", T, "none", false, "<div class='tr-answer muted'>No community data (offline or signed out): sign in (Settings &rarr; Account) to compare your buys with what other users look at.</div>", "");
  let body = x.status === "none" ? trNotYet(x.n, x.need.min, "buys with community data for the stock", null)
    : "<div class='tr-answer'><b>" + trPct(x.share.p) + "</b> of your buys came while other Stocktrails users were piling into the stock; by each stock's own rate over the 180 days before, chance gives " + trPct(x.chance) +
      (x.clearOn.indexOf("excess") >= 0 ? (x.excess.est > 0 ? ". The crowd's attention draws your buys." : ". You buy away from the crowd.") : ".") + "</div>";
  if (x.status !== "none") body += "<div class='tr-sample'><table class='adm'><thead><tr><th>After</th><th>Buys with the crowd</th><th>Other buys</th><th>Difference (99% range)</th></tr></thead><tbody>" +
    [5, 21, 63, 126].map(function (h) {
      const r = x.horizons[h], d = r.diff;
      return "<tr><td>" + h + " trading days</td><td>" + trPct(r.hot.mean, true) + " <span class='muted small'>(" + r.hot.n + ")</span></td><td>" + trPct(r.other.mean, true) + " <span class='muted small'>(" + r.other.n + ")</span></td>" +
        "<td>" + (d ? (x.clearOn.indexOf(String(h)) >= 0 ? "<b>" + trPts(d.est) + "</b>" : trPts(d.est)) + " <span class='muted small'>(" + trRange(d, trPts) + ")</span>" : "-") + "</td></tr>";
    }).join("") + "</tbody></table></div>";
  return trCard("crowdBuys", T, x.status, x.clear, body,
    "The crowd is the other Stocktrails users: their daily views of each stock (stocks viewed by at least 3 users), with your own views taken out. A day runs from 16:00 New York time (the US close) to 16:00 the next day, as the community counts do. " +
    "A buy came with the crowd when, in the 3 days before it, other users viewed the stock at least 3 times and at least twice its own rate over the month before. Chance is each stock's own share of such days in the 180 days before the buy, so a stock that is always popular does not count. " +
    "Returns are against the NASDAQ, from the close of the buy day; several horizons are read side by side, hence 99% ranges. An association, not proof: the crowd and you may react to the same news. Card " +
    TR_CARD_LABEL.herding + " asks the same of your first looks. Barber &amp; Odean (2008).");
}

// ---------- B7 timing against a savings plan ----------

// One row per stock: how far the moments you chose beat (right, green) or trailed (left, red) the
// same money as a monthly plan, in points a year; the first row is all of them together.
function trTimingBars(rows, all) {
  const shown = rows.filter(function (r) { return r.effect != null; }).slice(0, 12);
  const max = Math.max.apply(null, shown.map(function (r) { return Math.abs(r.effect); }).concat([Math.abs(all.est), 0.01]));
  const line = function (label, tip, e, cls) {
    const w = Math.min(50, Math.abs(e) / max * 50), sg = e >= 0 ? "pos" : "neg";
    return "<div class='tm-row " + (cls || "") + "' title='" + escapeHtml(tip) + "'><span class='tm-l'>" + label + "</span><span class='tm-track'><i class='tm-bar " + sg + "' style='" + (e >= 0 ? "left" : "right") + ":50%;width:" + w + "%'></i></span>" +
      "<span class='tm-v " + sg + "'>" + trPts(e) + "</span></div>";
  };
  return "<div class='tm-chart'><div class='tm-axis muted small'><span>&larr; a plan would have done better</span><span>your timing did better &rarr;</span></div>" +
    line("All " + rows.length + " stocks", "All stocks together, weighted by the money held", all.est, "tm-all") +
    shown.map(function (r) {
      return line(escapeHtml(r.ticker ? nameOf(r.ticker) : r.name), r.n + " buys from " + r.from + " to " + r.to + ": your buys " + trPts(r.timed.ex) + " a year against the index, the same money as a plan " + trPts(r.plan.ex), r.effect);
    }).join("") + (rows.length > shown.length ? "<div class='muted small'>and " + (rows.length - shown.length) + " more with less money in them</div>" : "") + "</div>";
}

function trTiming(R) {
  const x = trInd(R, "timing"), T = "Does your timing beat a savings plan?";
  if (x === TR_NONE) return trCard("timing", T, "none", false, "<div class='tr-answer muted'>Needs your trades.</div>", "");
  const s = x.same, sl = x.sleeves, e = s.effect, pa = function (v) { return trPts(v) + " a year"; }, cur = x.currency || "";
  const how = "Timed buys are your own decisions; plan buys are savings-plan executions (flagged by the broker, or 3 or more buys of a stock at a regular cadence). " +
    "Every buy is held against an <b>index twin</b>: the same money in the NASDAQ on the same day, cut by the same share on the same days as your position was cut by sales, so a sale never favours one part. " +
    "A buy's result is the money earned beyond its twin per euro-year held. " +
    "<b>Same stocks</b>: for each stock with 3 or more timed buys over at least two months, your buys are replaced by instalments of the same total, spread evenly between your first and last buy (about monthly), with the same sales; only the dates differ, so the choice of stock cannot explain the gap. " +
    "The range of the same-stocks test resamples whole stocks, those of the two parts calendar quarters. One history, one outcome: a lucky stretch looks like skill. Dividends are left out on both sides. The twin follows the public-market-equivalent idea of Kaplan &amp; Schoar (2005); Dichev (2007) found that investors' money-weighted returns trail buy-and-hold because of when they put money in.";
  if (x.status === "none") return trCard("timing", T, "none", false, trNotYet(Math.max(s.n, Math.min(sl.timed.n, sl.plan.n)), x.need.min,
    "timed buys in 3 or more stocks over two months or more, or buys in both your timed and your savings-plan part", null), how);
  let body;
  if (x.basis === "same") {
    // ranges are stated in the direction of the sentence: how much more the winner earned
    const ci = x.verdict === "plan_better" ? { lo: -e.hi, hi: -e.lo } : e;
    const rng = " <span class='muted small'>(95% range " + trRange(ci, trPts) + " a year; " + s.n + " buys in " + s.stocks + " stocks)</span>";
    body = "<div class='tr-answer'>" + (x.verdict === "plan_better"
      ? "<b>Handing it to a plan would have paid.</b> In the stocks you timed, the same money as a monthly plan, with the same sales, earned <b>" + pa(Math.abs(e.est)).replace(/^[+-]/, "") + " more</b> than the moments you chose."
      : x.verdict === "timing_pays"
        ? "<b>Your timing pays.</b> In the stocks you timed, the moments you chose earned <b>" + pa(e.est).replace(/^[+-]/, "") + " more</b> than the same money as a monthly plan would have."
        : "<b>No clear winner yet.</b> The moments you chose earned " + trPts(Math.abs(e.est)).replace(/^[+-]/, "") + " a year " + (e.est >= 0 ? "more" : "less") + " than the same money as a monthly plan, but the range includes zero: your timing cannot be told from a plan.") + rng + "</div>" +
      trTimingBars(s.rows, e);
  } else {
    const d = sl.diff;
    body = "<div class='tr-answer'>Too few stocks timed over two months or more for the same-stocks test. Between the two parts of your depot: your timed buys earned <b>" + pa(sl.timed.ex) + "</b> against the index, your savings plans <b>" + pa(sl.plan.ex) + "</b>" +
      (x.verdict === "plan_better" ? ": the plans did better." : x.verdict === "timing_pays" ? ": your timed buys did better." : ", and the range of the difference (" + trRange(d, trPts) + ") includes zero.") + "</div>";
  }
  const labels = ["Buys", "Money in", "Years each euro was held, on average", "Gain (sales paid out, the rest at the last close)", "Gain of the index twin", "Beyond the twin, a year (95% range)"];
  const vals = function (a) {
    return a.n ? [a.n, trMoney(a.c, cur), a.years.toFixed(1), trPct(a.gain, true), trPct(a.twin, true), "<b>" + trPts(a.ex) + "</b> <span class='muted small'>(" + trRange(a.ci, trPts) + ")</span>"] : labels.map(function () { return "-"; });
  };
  const t = vals(sl.timed), p = vals(sl.plan);
  body += "<div class='tr-sample'><table class='adm'><thead><tr><th>What each part earned</th><th>Timed buys</th><th>Savings plans</th></tr></thead><tbody>" +
    labels.map(function (l, i) { return "<tr><td>" + l + "</td><td>" + t[i] + "</td><td>" + p[i] + "</td></tr>"; }).join("") + "</tbody></table></div>";
  const figs = [];
  if (!sl.plan.n) figs.push("No savings plan found in your trades, so the plan above is simulated: monthly instalments of the same total.");
  else if (x.basis === "same" && sl.diff) figs.push("Timed buys against plan buys as they were (" + trPts(sl.diff.est) + " a year, range " + trRange(sl.diff, trPts) + "): the two parts also hold different things, so the same-stocks test above is the cleaner read of timing alone.");
  figs.push("Values up to " + escapeHtml(x.end) + " (the last day of your import) in " + escapeHtml(cur) + "; dividends left out" + (x.skipped ? "; " + x.skipped + " buys without a price history are left out" : ""));
  return trCard("timing", T, x.status, x.clear, body + trFigs(figs), how);
}

function trAnchoring(R) {
  const x = trInd(R, "anchoring");
  if (x === TR_NONE) return trCard("anchoring", "Are your targets and sales anchored?", "none", false, "<div class='tr-answer muted'>Not computed.</div>", "");
  const t = x.targets, be = x.breakEven, nh = x.nearHigh;
  let body = x.status === "none" ? trNotYet(t.n, t.need.min, "calls with a target price", null)
    : "<div class='tr-answer'>" + (t.n ? "<b>" + trPct(t.round.p) + "</b> of your targets sit on a round number; whole-number targets would do that " + trPct(t.chance) + " of the time" + (t.clear ? ": your targets stick to round numbers." : ".") : "") +
      (be.n ? " <b>" + trPct(be.share.p) + "</b> of your full sales came within 2% of your cost, where the price spent " + trPct(be.chance) + " of the holding days" + (be.clear ? ": you wait to get out even." : ".") : "") + "</div>";
  const figs = [];
  if (t.nearHigh.n) figs.push(trPct(t.nearHigh.p) + " of targets within 1% of the stock's 52-week high");
  if (t.nearEntry.n) figs.push(trPct(t.nearEntry.p) + " of targets on stocks you held within 1% of your entry price");
  if (t.peak.n) figs.push(trPct(t.peak.p) + " of targets exactly 10% or 20% away");
  if (nh.n) figs.push(trPct(nh.share.p) + " of your buys came within 5% of the 52-week high, against " + trPct(nh.base) + " of your view-days" + (nh.clear ? (nh.ex.est < 0 ? ": you shy away from buying near the high." : ": you buy near the high more than you look there.") : ""));
  if (x.drift.loss.n || x.drift.gain.n) figs.push("Target changes while the position was under water: " + trPct(x.drift.loss.p) + " lowered (" + x.drift.loss.n + "); while in profit: " + trPct(x.drift.gain.p) + " lowered (" + x.drift.gain.n + ")");
  return trCard("anchoring", "Are your targets and sales anchored?", x.status, x.clear, body + trFigs(figs),
    "Round numbers: a multiple of 10 for prices of 100 or more, of 5 from 10 to 100, of 1 below 10; chance assumes targets typed as whole numbers (1 in 10, 1 in 5) or to the cent below 10. " +
    "Break-even: full sales within 2% of the average cost, against the share of the position's holding days the close spent in that band. 52-week high: buys within 5% of it, against your view-days of the same stocks. " +
    "Tversky &amp; Kahneman (1974); George &amp; Hwang (2004); Li &amp; Yu (2012).");
}

function trCalibration(R) {
  const x = trInd(R, "calibration");
  let body = x.status === "none" ? trNotYet(x.n || 0, (x.need || { min: 10 }).min, "calls with a target and a horizon that has passed", null)
    : "<div class='tr-answer'>Your targets asked for a median move of <b>" + trPct(x.medianReq) + "</b>; before the deadline the stocks went at best <b>" + trPct(x.medianBest) + "</b> your way. " +
      trPct(x.hit.p) + " of targets were reached in time" + (x.clear ? ". Your targets are systematically too far for their horizon." : ".") + "</div>";
  const figs = [];
  if (x.n) figs.push(trPct(x.revised.p) + " of these targets were changed before the deadline");
  return trCard("calibration", "Are your targets too far?", x.status, x.clear, body + trFigs(figs),
    "Calls with a target price and a horizon whose deadline has passed: the move the target required from the price at the call, against the best close in the call's direction before the deadline. " +
    "A median ratio above 1 with a range clear of it means targets are set further than the stocks go. Miscalibration is the core of overconfidence (Barber &amp; Odean 2001). Pace per call is in Predictions.");
}

function trHomeBias(R) {
  const x = trInd(R, "homebias");
  if (x === TR_NONE) return trCard("homebias", "Do you stay close to home?", "none", false, "<div class='tr-answer muted'>Not computed.</div>", "");
  if (x.noHome) return trCard("homebias", "Do you stay close to home?", null, false,
    "<div class='tr-answer muted'>" + (x.home === "XV" ? "Your connection runs through a VPN, so your home country is not known. " : "Your home country is not known yet. ") +
    "<a href='#' data-act='open-home-country'>Set it in Settings &rarr; Data</a> to see this.</div>", "Home bias compares how much of your research and depot is in your home country with that country's weight in the world market.");
  const v = x.views, d = x.depot;
  let body = x.status === "none" ? trNotYet(x.n, x.need.min, "months with views", null)
    : "<div class='tr-answer'>" + trPct(v.share) + " of your views" + (d ? " and <b>" + trPct(d.share) + "</b> of your depot" : "") + " are in " + escapeHtml(x.homeName) + ", which is " + trPct(x.acwi) + " of the world market. " +
      "Home bias <b>" + (d ? d.bias : v.bias).toFixed(2) + "</b> (0 = world weights, 1 = only home)" + (x.tilted ? ": you stay close to home." : ".") + "</div>";
  const figs = [];
  if (x.perMonth != null) figs.push("You research a median of " + x.perMonth + " different stocks a month; your top 5 get " + trPct(x.top5) + " of your views");
  figs.push("Home country: " + escapeHtml(x.homeName) + " (<a href='#' data-act='open-home-country'>change</a>)");
  return trCard("homebias", "Do you stay close to home?", x.status, false, body + trFigs(figs),
    "Countries: the listing for views (Yahoo symbol suffix; no suffix = US) and the ISIN prefix for holdings (the domicile). Home bias = 1 - (your foreign share / the world market's foreign share), with MSCI ACWI country weights as of " +
    escapeHtml(x.asOf) + ". French &amp; Poterba (1991); Huberman (2001); Grinblatt &amp; Keloharju (2001).");
}

// Yahoo profiles (sector) for held instruments and the 60 most-viewed stocks, once per session.
async function trProfiles(input) {
  TR.profiles = TR.profiles || {};
  if (!self.ATPrices || !ATPrices.fetchProfile) return TR.profiles;
  const syms = {};
  Object.keys(input.links || {}).forEach(function (k) { const l = input.links[k]; if (l && l.symbol) syms[l.symbol] = 1; });
  const vc = {};
  (input.intraday || []).forEach(function (e) { vc[e.ticker] = (vc[e.ticker] || 0) + 1; });
  Object.keys(vc).sort(function (a, b) { return vc[b] - vc[a]; }).slice(0, 60).forEach(function (t) { syms[(input.tickerSymbol || {})[t] || t] = 1; });
  const todo = Object.keys(syms).filter(function (s) { return !(s in TR.profiles); });
  await trPool(todo, 4, async function (s) { try { TR.profiles[s] = await ATPrices.fetchProfile(s, true); } catch (e) { TR.profiles[s] = null; } });
  return TR.profiles;
}

// Home country: the one set in Settings, else the IP country the sync already resolved.
// A VPN exit ("XV") is no home. Device-local on purpose: it never syncs.
async function trHomeCountry() {
  try {
    const r = await chrome.storage.local.get(["at_home_country", "at_geo_v2"]);
    if (r.at_home_country && /^[A-Z]{2}$/.test(r.at_home_country)) return r.at_home_country;
    return r.at_geo_v2 && r.at_geo_v2.country || null;
  } catch (e) { return null; }
}

// Settings > Data: the home-country picker.
(function () {
  const sec = typeof document !== "undefined" && document.getElementById("sec-settings");
  if (!sec || !self.ATIndicators) return;
  const names = ATIndicators.COUNTRY_NAMES, codes = Object.keys(names).sort(function (a, b) { return names[a].localeCompare(names[b]); });
  const box = document.createElement("div");
  box.innerHTML = "<h3 style='margin:16px 0 4px'>Home country</h3><div class='muted small'>Used by the home-bias card in Trades &amp; research. Detected from your connection unless you set it; " +
    "behind a VPN it cannot be detected. Stored on this device only.</div><div class='add-portal'><select id='home-country'><option value=''>Detect automatically</option>" +
    codes.map(function (c) { return "<option value='" + c + "'>" + names[c] + "</option>"; }).join("") + "</select> <span class='muted small' id='home-country-status'></span></div>";
  sec.appendChild(box);
  const sel = box.querySelector("#home-country"), st = box.querySelector("#home-country-status");
  try { chrome.storage.local.get("at_home_country").then(function (r) { sel.value = (r && r.at_home_country) || ""; }); } catch (e) { /* ignore */ }
  sel.addEventListener("change", async function () {
    try {
      // an empty value means "detect" (the web app's storage shim cannot remove keys)
      await chrome.storage.local.set({ at_home_country: sel.value || "" });
      st.textContent = "Saved.";
      if (typeof TR !== "undefined") { TR.reportKey = null; TR.previewKey = null; }
    } catch (e) { st.textContent = "Could not save."; }
  });
})();

// ---------- phase 3 ----------

function trAttention(R) {
  const x = trInd(R, "attention");
  let body;
  if (x === TR_NONE || x.noData) body = "<div class='tr-answer muted'>Needs earnings dates from Stocktrails' server: sign in (Settings &rarr; Account) to see this." +
    (x.notMeasured ? " " + x.notMeasured + " stocks you follow are listed outside the US and are not measured yet." : "") + "</div>";
  else if (x.status === "none") body = trNotYet(x.n, x.need.min, "earnings releases of stocks you follow, with 14 days since", null);
  else body = "<div class='tr-answer'>After a stock you follow reported, you opened its financials or news after a median of <b>" + trLatencyText(x.median) + "</b>; " +
    "<b>" + trPct(x.missed.p) + "</b> of reports went unread for two weeks" + (x.clear ? ". Some releases slip past you: see below." : ".") + "</div>";
  const figs = [];
  if (x.friday && (x.friday.yes.n || x.friday.no.n)) figs.push("Friday releases: " + trPct(x.friday.yes.missed.p) + " unread (" + x.friday.yes.n + "), other days " + trPct(x.friday.no.missed.p) + " (" + x.friday.no.n + ")" +
    (x.friday.diff && x.friday.diff.lo != null && x.friday.diff.lo > 0 ? ": Friday reports clearly slip more" : ""));
  if (x.busy && x.busy.yes.n) figs.push("Days with 3 or more of your stocks reporting: " + trPct(x.busy.yes.missed.p) + " unread (" + x.busy.yes.n + "), quieter days " + trPct(x.busy.no.missed.p) +
    (x.busy.diff && x.busy.diff.lo != null && x.busy.diff.lo > 0 ? ": busy days clearly cost attention" : ""));
  if (x.breadth && x.breadth.release.n && x.breadth.other.n) figs.push("Stocks per research session on report days " + x.breadth.release.mean.toFixed(1) + ", on other days " + x.breadth.other.mean.toFixed(1));
  if (x.notMeasured) figs.push(x.notMeasured + " stocks you viewed are listed outside the US: their reports are not measured yet");
  return trCard("attention", "Do you read the quarterly reports in time?", x.status || "none", x.clear, body + trFigs(figs),
    "Earnings dates for US companies come from SEC filings (8-K, item 2.02) and the Nasdaq calendar. A release counts for a stock you viewed in the 90 days before it, or held. " +
    "The clock starts at the US open on the release day (the next day for a release after the close) and stops at your first view of its financials, earnings, estimates or news; after 14 days a report counts as unread. " +
    "DellaVigna &amp; Pollet (2009): investors react less to Friday releases; Hirshleifer, Lim &amp; Teoh (2009): and less on days with many releases.");
}
function trLatencyText(h) { return h == null ? "more than two weeks" : h < 48 ? Math.round(h) + " hours" : (h / 24).toFixed(1) + " days"; }

// Earnings dates for the stocks you follow (US listings), once per session.
async function trEarnings(input) {
  if (TR.earnings !== undefined) return TR.earnings;
  TR.earnings = null;
  try {
    if (!(self.ATCloud && ATCloud.enabled() && ATCloud.earningsFor && (await ATCloud.getUser()))) return null;
    const ts = {};
    (input.intraday || []).forEach(function (e) { const sym = (input.tickerSymbol || {})[e.ticker] || e.ticker; if (ATIndicators.countryOfSymbol(sym) === "US") ts[e.ticker] = 1; });
    const list = Object.keys(ts), out = {};
    for (let i = 0; i < list.length; i += 200) {
      (await ATCloud.earningsFor(list.slice(i, i + 200))).forEach(function (r) { out[r.ticker] = r.dates || []; });
    }
    TR.earnings = out;
  } catch (e) { TR.earnings = null; }
  return TR.earnings;
}
