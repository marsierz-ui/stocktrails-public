// My Habits > Trades & research: import broker exports and measure how
// research shows up in real decisions. Loaded after dashboard.js and uses its
// globals (DATA, GROUPS, NAMES, BENCH, DAILY, escapeHtml, nameOf, drawLineCanvas...).
//
// Privacy: the file is parsed in memory (ATLedger); only canonical trade and
// dividend fields are stored, in this browser's IndexedDB (ATLedgerDB), per
// account. Nothing here talks to Supabase. Yahoo sees ISINs/symbols when
// prices are looked up, never quantities, amounts or dates.

function trPref(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
function trPrefJson(k) { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
const TR = { customParts: trPrefJson("at_tr_custom"), winDays: +trPref("at_tr_win", "30") || 30, lagDays: +trPref("at_tr_lag", "1") || 0, partsMsg: "", hourMode: trPref("at_tr_hours", "clusters"), convMode: trPref("at_tr_conv", "thirds"), dipMode: trPref("at_tr_dip", "ret"), owner: null, txs: [], links: {}, imports: [], report: null, reportKey: null, prices: {}, pending: null, mapper: null, busy: false, msg: "", pendingLinks: {}, linksOpen: false };
const LINK_VER = 1;
const TR_INDEX_TOP = 300;  // viewed stocks priced for the attention index (all, up to this many)
const TR_PEER_MIN = 100;   // peer comparisons stay hidden below this many active users

// Largest daily active-user count the community series reports; 0 when signed
// out or the backend is older.
async function trCommunityUsers() {
  try { return (await communityDaily()).reduce(function (m, r) { return Math.max(m, +r.users || 0); }, 0); }
  catch (e) { return 0; }
}

const BROKER_HOWTO = {
  trade_republic: { label: "Trade Republic", file: "CSV",
    steps: "In the Trade Republic app tap your profile, then <b>Statements</b> &rarr; <b>Transaction export</b>. Pick the longest range and tap <b>Create</b>, then save the CSV." },
  scalable: { label: "Scalable Capital", file: "CSV",
    steps: "In the Scalable Capital broker open <b>Transactions</b>, select all transactions and choose <b>Export</b> (CSV)." },
  ibkr: { label: "Interactive Brokers", file: "XML or CSV",
    steps: "Client Portal &rarr; <b>Performance &amp; Reports</b> &rarr; <b>Flex Queries</b> &rarr; <b>+</b> next to Activity Flex Query. Tick the sections <b>Trades</b> and <b>Cash Transactions</b> (with ISIN, Symbol, Description, Quantity, TradePrice, IBCommission, Currency, DateTime), format <b>XML</b>, period <b>Last 365 Calendar Days</b>. Save, run it and download the report. A default Activity Statement CSV works too." },
  degiro: { label: "DEGIRO", file: "CSV",
    steps: "In DEGIRO open <b>Activity</b> &rarr; <b>Transactions</b>, set the date range and click <b>Export</b> &rarr; CSV. (The Account statement export is a different file; dividends are only in that one.)" },
  trading212: { label: "Trading 212", file: "CSV",
    steps: "Open <b>History</b> and click the download icon. Choose the period and download the CSV." },
  revolut: { label: "Revolut", file: "CSV",
    steps: "In the Revolut app open <b>Invest</b> &rarr; <b>More</b> &rarr; <b>Documents</b>, choose your account and <b>Account statement</b>. Pick the date range and download as CSV (if only Excel is offered, save it as CSV with commas)." },
  schwab: { label: "Charles Schwab", file: "CSV",
    steps: "Go to <b>Accounts</b> &rarr; <b>History</b>, select the account and date range, then <b>Export</b> (CSV)." },
  freetrade: { label: "Freetrade", file: "CSV",
    steps: "In the Freetrade app choose your portfolio, open <b>Activity</b> and tap the share icon at the top right to export." },
  xtb: { label: "XTB", file: "CSV",
    steps: "Open <b>Account history</b> &rarr; <b>Cash operations</b> &rarr; <b>Export</b>, choose the period, report type <b>Cash Operations</b> and format <b>csv</b>." },
  saxo: { label: "Saxo", file: "CSV",
    steps: "Open your profile &rarr; <b>Transaction overview</b> &rarr; <b>Export</b> &rarr; Excel, then save the sheet as CSV with commas." },
  other: { label: "Other broker", file: "CSV",
    steps: "Export your transaction history as CSV. If the columns are not recognised you can tell Stocktrails which column is which, or fill in the template: <code>date,type,isin,symbol,name,quantity,price,amount,fee,tax,currency</code> (type: buy, sell or dividend)." }
};

async function tradesOwner() {
  let id = "local";
  try { if (self.ATCloud && ATCloud.enabled()) { const u = await ATCloud.getUser(); if (u && u.id) id = u.id; } } catch (e) { /* signed out: local */ }
  return id;
}

// ---------- formatting ----------

function trPct(x, signed) { return x == null ? "-" : (signed && x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%"; }
function trPts(x) { return x == null ? "-" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + " pts"; }
function trRange(ci, fmt) { return ci && ci.lo != null ? fmt(ci.lo) + " to " + fmt(ci.hi) : "-"; }
function trPctRange(w) { return w && w.n ? Math.round(w.p * 100) + "% (95% range " + Math.round(w.lo * 100) + "-" + Math.round(w.hi * 100) + "%)" : "-"; }
function trDays(d) { return d == null ? "-" : d < 1 ? Math.max(1, Math.round(d * 24)) + " h" : Math.round(d) + " d"; }
function trDate(ms) { return ms == null ? "-" : isoDate(ms); }
function trMonths(m) { return m == null ? null : m === 1 ? "about 1 month" : m > 36 ? "more than 3 years" : "about " + m + " months"; }
function trMoney(v, ccy) {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy, maximumFractionDigits: 2 }).format(v); }
  catch (e) { return v.toFixed(2) + " " + ccy; }
}
const TR_STATUS = { none: "Not enough data", indicative: "Indicative", solid: "Solid" };
function trChip(st, clear) {
  return "<span class='tr-chip st-" + st + "'>" + TR_STATUS[st] + "</span>" + (clear ? "<span class='tr-chip st-clear' title='The 95% range excludes no effect.'>Clear result</span>" : "");
}

// ---------- data: matching + prices ----------

function trackedTickers() {
  const s = {};
  Object.keys(GROUPS || {}).forEach(function (t) { s[t] = 1; });
  (DATA && DATA.intraday || []).forEach(function (e) { s[e.ticker] = 1; });
  return Object.keys(s);
}
function tickerSymbol(t) { return (DATA.overrides && DATA.overrides[t]) || ATPrices.toSymbol(t); }

// One instrument per ISIN (or broker symbol when the broker gives none).
function trInstruments(txs) {
  const m = {};
  txs.forEach(function (t) {
    const k = ATDecisions.instKey(t);
    const x = m[k] = m[k] || { inst: k, isin: t.isin, symbol: t.symbol, name: null, currency: t.priceCcy || t.currency, first: t.date, n: 0 };
    if (t.name) x.name = t.name;
    if (!x.symbol && t.symbol) x.symbol = t.symbol;
    if (t.date < x.first) x.first = t.date;
    x.n++;
  });
  return m;
}

// Match an instrument to a tracked stock. ISIN -> Yahoo listings is the
// primary key; the names have to agree too, because a ticker alone is not
// unique across exchanges (BA is Boeing in New York, BA.L is BAE in London).
function trMatch(inst, cands, tickers) {
  let best = null;
  const cs = cands.map(function (c) { return String(c.symbol).toUpperCase(); });
  const bases = cs.map(ATLedger.baseSymbol).concat(inst.symbol ? [ATLedger.baseSymbol(inst.symbol)] : []);
  tickers.forEach(function (t) {
    const sym = String(tickerSymbol(t)).toUpperCase(), nm = NAMES[t] || null;
    const candName = (cands[cs.indexOf(sym)] || {}).name;
    const names = [inst.name, candName].filter(Boolean);
    const sim = nm && names.length ? Math.max.apply(null, names.map(function (n) { return ATLedger.nameSimilarity(n, nm); })) : null;
    let method = null, conf = 0;
    if (cs.indexOf(sym) >= 0) { method = "ISIN"; conf = sim == null ? 0.9 : sim >= 0.6 ? 1 : 0.5; }
    else if (inst.symbol && String(inst.symbol).toUpperCase() === sym) { method = "symbol"; conf = sim == null ? 0.8 : sim >= 0.6 ? 0.95 : 0.4; }
    else if (sim != null && sim >= 0.85 && bases.indexOf(ATLedger.baseSymbol(sym)) >= 0) { method = "ticker + name"; conf = 0.85; }
    else if (sim != null && sim >= 0.9) { method = "name"; conf = 0.7; }
    if (method && (!best || conf > best.conf)) best = { ticker: t, method: method, conf: conf, sim: sim };
  });
  return best;
}

async function trPool(items, n, fn) {
  let i = 0;
  await Promise.all(new Array(Math.min(n, items.length)).fill(0).map(async function () {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

async function ensureLinks(owner, onProgress) {
  const insts = trInstruments(TR.txs);
  const tickers = trackedTickers();
  const todo = Object.keys(insts).filter(function (k) { const l = TR.links[k]; return !l || (!l.manual && (l.v !== LINK_VER || l.tracked !== tickers.length)); });
  if (!todo.length) return;
  const out = [];
  let done = 0;
  await trPool(todo, 4, async function (k) {
    const x = insts[k], prev = TR.links[k];
    let cands = prev && prev.cands;
    if (!cands) {
      cands = [];
      try { cands = (await ATPrices.searchSymbols(x.isin || x.symbol)).slice(0, 6); } catch (e) { /* offline / rate limited: matched by name only */ }
    }
    const m = trMatch(x, cands, tickers);
    let symbol = m ? tickerSymbol(m.ticker) : null;
    if (!symbol) {
      const bs = x.symbol ? String(x.symbol).toUpperCase() : null;
      const exact = bs && cands.find(function (c) { return String(c.symbol).toUpperCase() === bs; });
      symbol = exact ? exact.symbol : (cands[0] ? cands[0].symbol : (bs && !ATLedger.isIsin(bs) ? bs : null));
    }
    out.push({ inst: k, isin: x.isin, name: x.name || (cands[0] && cands[0].name) || x.symbol || k, brokerSymbol: x.symbol || null,
      ticker: m ? m.ticker : null, method: m ? m.method : null, score: m ? m.conf : null, sim: m ? m.sim : null,
      status: !m ? "untracked" : m.conf >= 0.9 ? "matched" : "check", symbol: symbol, cands: cands, v: LINK_VER, tracked: tickers.length, manual: false });
    done++;
    if (onProgress) onProgress(done, todo.length);
  });
  await ATLedgerDB.putLinks(owner, out);
  out.forEach(function (l) { TR.links[l.inst] = l; });
}

async function ensurePrices(onProgress) {
  const firstOf = {};
  TR.txs.forEach(function (t) {
    const l = TR.links[ATDecisions.instKey(t)];
    if (l && l.symbol && (!firstOf[l.symbol] || t.date < firstOf[l.symbol])) firstOf[l.symbol] = t.date;
  });
  // Positive calls need prices too (questions 4, 5, 11), and Negative ones for
  // the "avoid" check in question 2, from the call onwards,
  // and the attention index (question 9) your 30 most-viewed stocks.
  (DATA.events || []).forEach(function (e) {
    if (e.sentiment !== "positive" && e.sentiment !== "negative") return;
    const s = tickerSymbol(e.ticker), d = isoDate(e.ts);
    if (!firstOf[s] || d < firstOf[s]) firstOf[s] = d;
  });
  const vc = {}, first = {};
  (DATA.intraday || []).forEach(function (e) { vc[e.ticker] = (vc[e.ticker] || 0) + 1; if (!first[e.ticker] || e.ts < first[e.ticker]) first[e.ticker] = e.ts; });
  Object.keys(vc).sort(function (a, b) { return vc[b] - vc[a]; }).slice(0, TR_INDEX_TOP).forEach(function (t) {
    const s = tickerSymbol(t), d = isoDate(first[t]);
    if (!firstOf[s] || d < firstOf[s]) firstOf[s] = d;
  });
  const syms = Object.keys(firstOf).filter(function (s) { return !TR.prices[s]; });
  // 400 days before the first use: a year of history for the 52-week high, the
  // 12-month past return and the lottery screen (cards B3, B4, C4), and 60 trading
  // days for the sharp-move test (A6).
  const fromOf = {};
  syms.forEach(function (s) { fromOf[s] = new Date(Date.parse(firstOf[s]) - 400 * 86400000).toISOString().slice(0, 10); });
  // Series stored in this browser (src/pricecache.js) are used at once; the ones older than a few
  // hours are brought up to date after the page is shown (trPricesRefresh). Only the rest is downloaded.
  const have = self.ATPriceCache ? await ATPriceCache.peek(fromOf) : {};
  TR.stale = TR.stale || {};
  Object.keys(have).forEach(function (s) { TR.prices[s] = have[s].bars; if (have[s].stale) TR.stale[s] = 1; });
  const todo = syms.filter(function (s) { return !TR.prices[s]; });
  let done = 0;
  await trPool(todo, 6, async function (s) {
    try {
      const bars = self.ATPriceCache ? await ATPriceCache.load(s, fromOf[s]) : await ATPrices.fetchDaily(s, fromOf[s], true);
      if (bars && bars.length) TR.prices[s] = bars;
    } catch (e) { /* retried on the next visit */ }
    done++;
    if (onProgress) onProgress(done, todo.length);
  });
  // the NASDAQ from 400 days before the first trade, as the stocks' prices: the paper portfolios and the
  // trade analysis run on its days (it used to start at the first captured view, months after the first trade)
  const firstTx = TR.txs.reduce(function (m, t) { return t.date && t.date < m ? t.date : m; }, "9999");
  await ensureBenchmark(firstTx < "9999" ? new Date(Date.parse(firstTx) - 400 * 86400000).toISOString().slice(0, 10) : undefined);
}

// Stored series that are a few hours old are updated from their last days (not downloaded whole)
// once the page is on screen. When a new day arrived the report is built again, once, with the
// new bars; if the user is typing or elsewhere, the next render does it. Offline: tried next visit.
async function trPricesRefresh() {
  const list = Object.keys(TR.stale || {});
  if (!list.length || TR.refreshing || !self.ATPriceCache) return;
  TR.refreshing = true; TR.stale = {};
  let material = false;
  try {
    await trPool(list, 6, async function (s) {
      try {
        const r = await ATPriceCache.refresh(s);
        if (r) { TR.prices[s] = r.bars; if (r.changed) material = true; }
      } catch (e) { TR.stale[s] = 1; }
    });
  } finally { TR.refreshing = false; }
  if (!material) return;
  TR.priceRev = (TR.priceRev || 0) + 1; TR.previewKey = null;
  const root = document.getElementById("trades-root"), pane = root && root.closest("[data-pane]"), ae = document.activeElement;
  if (!root || document.hidden || (pane && pane.hidden) || TR.busy || (ae && root.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) return;
  await renderTrades();
}

// ---------- render ----------

async function renderTrades() {
  const root = document.getElementById("trades-root");
  if (!root || !self.ATLedgerDB || TR.busy) return;
  const pane = root.closest("[data-pane]");
  if (pane && pane.hidden) return;
  TR.busy = true;
  try {
    const owner = await tradesOwner();
    if (TR.owner !== owner) { TR.owner = owner; TR.report = null; TR.reportKey = null; TR.pending = null; TR.mapper = null; }
    TR.txs = await ATLedgerDB.getTxs(owner);
    TR.links = await ATLedgerDB.getLinks(owner);
    TR.imports = await ATLedgerDB.getImports(owner);
    TR.commitments = await ATLedgerDB.getCommitments(owner);
    trRemindersMirror();
    if (!TR.txs.length) { await trRenderCallsOnly(root); return; }
    const key = trReportKey();
    if (TR.reportKey !== key || !TR.report) {
      const status = function (t) { root.innerHTML = "<div class='tr-wrap'><div class='muted small tr-progress'>" + t + "</div></div>"; };
      status("Matching your instruments with the stocks you track...");
      await ensureLinks(owner, function (d, n) { status("Matching your instruments with the stocks you track... " + d + " / " + n); });
      status("Loading prices...");
      await ensurePrices(function (d, n) { status("Loading prices... " + d + " / " + n); });
      const tickerSym = {};
      trackedTickers().forEach(function (t) { tickerSym[t] = tickerSymbol(t); });
      const input = { txs: TR.txs, links: TR.links, intraday: DATA.intraday || [], events: DATA.events || [],
        prices: TR.prices, bench: BENCH || [], tickerSymbol: tickerSym, customParts: TR.customParts, windowDays: TR.winDays, lagDays: TR.lagDays, now: Date.now() };
      TR.report = ATDecisions.analyze(input);
      await trAttachIndicators(TR.report, input);
      TR.reportKey = key;
      TR.users = await trCommunityUsers();
    }
    root.innerHTML = trReportHtml(TR.report);
    trDrawCharts(TR.report);
    if (self.trAgentAfterRender) trAgentAfterRender(TR.report);
    trPricesRefresh();
  } catch (e) {
    root.innerHTML = "<div class='tr-wrap'><div class='card'>Could not build this view: " + escapeHtml(e && e.message || e) + "</div></div>";
  } finally { TR.busy = false; if (self.trAiAfterRender) trAiAfterRender(); }
}

// Phase-1 bias indicators (src/indicators.js) onto the report, with the community
// data herding needs. A failure here leaves the original questions intact.
async function trAttachIndicators(R, input) {
  if (!self.ATIndicators) return;
  try {
    const comm = await trCommunityData();
    const extra = { profiles: await trProfiles(input), homeCountry: await trHomeCountry(), earnings: await trEarnings(input) };
    R.ind = ATIndicators.analyze(Object.assign({}, input, comm, extra), R);
  } catch (e) { R.ind = null; }
}

// No broker import yet: the import panel, and under it what the research and
// calls already say (the indicators that need no trades), so the value of an
// import shows before it.
async function trRenderCallsOnly(root) {
  const key = ["calls", (DATA.intraday || []).length, (DATA.events || []).length].join("|");
  if (TR.previewKey !== key) {
    root.innerHTML = trImportHtml(true) + "<div class='tr-wrap'><div class='muted small tr-progress'>Reading your research and calls...</div></div>";
    try {
      await ensurePrices();
      const tickerSym = {};
      trackedTickers().forEach(function (t) { tickerSym[t] = tickerSymbol(t); });
      const input = { txs: [], links: {}, intraday: DATA.intraday || [], events: DATA.events || [], prices: TR.prices, bench: BENCH || [], tickerSymbol: tickerSym, now: Date.now() };
      const R = ATDecisions.analyze(input);
      await trAttachIndicators(R, input);
      TR.previewHtml = R.ind ? trCallsOnlyHtml(R) : "";
    } catch (e) { TR.previewHtml = ""; }
    TR.previewKey = key;
  }
  root.innerHTML = trImportHtml(true) + (TR.previewHtml || "");
  trPricesRefresh();
}

function trImportHtml(empty) {
  const opts = Object.keys(BROKER_HOWTO).map(function (k) { return "<option value='" + k + "'" + (k === (TR.broker || "trade_republic") ? " selected" : "") + ">" + BROKER_HOWTO[k].label + "</option>"; }).join("");
  const how = BROKER_HOWTO[TR.broker || "trade_republic"];
  let body = "";
  if (TR.pending) body = trPreviewHtml(TR.pending);
  else if (TR.mapper) body = trMapperHtml(TR.mapper);
  else body =
    "<ol class='tr-steps'>" +
    "<li><b>Pick your broker</b> <select data-act='broker'>" + opts + "</select></li>" +
    "<li><b>Export your history</b> (" + how.file + ")<div class='muted small tr-howto'>" + how.steps + "</div></li>" +
    "<li><b>Add the file</b><label class='tr-drop' data-act='drop'>Drop the file here or <u>choose it</u>" +
    "<input type='file' accept='.csv,.xml,.txt,text/csv,application/xml,text/xml' data-act='file' hidden></label></li>" +
    "</ol>";
  return "<div class='tr-wrap'>" +
    (empty ? "<div class='tr-intro'><h3>Trades &amp; research</h3><p>Connect what you research with what you actually buy and sell. " +
      "Add your broker's transaction export and Stocktrails measures whether research comes before your trades, whether your calls match your actions, " +
      "and whether researched trades turn out better.</p></div>" : "") +
    "<div class='card tr-import'>" + (empty ? "" : "<h4>Import another file</h4>") +
    (TR.msg ? "<div class='tr-msg'>" + TR.msg + "</div>" : "") + body + trPrivacyHtml() + "</div>" +
    (empty ? "" : "<button data-act='close-import'>Back to results</button>") + "</div>";
}

function trPrivacyHtml() {
  return "<div class='muted small tr-privacy'><b>Stays on this device.</b> The file is read in your browser. Only trades and dividends are kept " +
    "(instrument, date, quantity, price, amount, fees, taxes); card payments, transfers, IBANs and names of people in the file are discarded while reading. " +
    "Nothing is uploaded, synced or included in the JSON backup. To chart prices, ISINs and symbols are looked up on Yahoo Finance (in the web app through Stocktrails' price relay on Supabase), without quantities, amounts or dates. " +
    "You can delete the imported data at any time.</div>";
}

function trPreviewHtml(p) {
  const r = p.result, c = r.counts;
  const list = function (o) {
    const ks = Object.keys(o);
    return ks.length ? "<ul class='tr-list'>" + ks.map(function (k) { return "<li>" + escapeHtml(k) + ": " + o[k] + "</li>"; }).join("") + "</ul>" : "<div class='muted small'>none</div>";
  };
  const n = r.txs.length;
  return "<div class='tr-preview'><h4>" + escapeHtml(r.label) + " &middot; " + escapeHtml(p.fileName) + "</h4>" +
    "<div class='usage-cards'>" +
    "<div class='stat'><b>" + c.buy + "</b>buys</div><div class='stat'><b>" + c.sell + "</b>sales</div>" +
    "<div class='stat'><b>" + c.dividend + "</b>dividends</div>" + (c.adjust ? "<div class='stat'><b>" + c.adjust + "</b>share changes</div>" : "") +
    "<div class='stat'><b>" + escapeHtml(r.from || "-") + "</b>from</div><div class='stat'><b>" + escapeHtml(r.to || "-") + "</b>to</div></div>" +
    "<div class='tr-cols'><div><h5>Discarded while reading (" + Object.keys(r.skipped).reduce(function (s, k) { return s + r.skipped[k]; }, 0) + ")</h5>" + list(r.skipped) + "</div>" +
    "<div><h5>Not understood (" + Object.keys(r.unknown).reduce(function (s, k) { return s + r.unknown[k]; }, 0) + ")</h5>" + list(r.unknown) +
    (Object.keys(r.unknown).length ? "<div class='muted small'>These rows are left out. If they are trades, tell us via Feedback which broker and row type.</div>" : "") + "</div></div>" +
    r.notes.map(function (t) { return "<div class='muted small'>" + escapeHtml(t) + "</div>"; }).join("") +
    "<div class='tr-btns'>" + (n ? "<button class='tr-primary' data-act='confirm'>Import " + n + " records</button>" : "<b>No trades found in this file.</b>") +
    " <button data-act='cancel'>Cancel</button></div></div>";
}

function trMapperHtml(m) {
  const opt = function (f) {
    return "<select data-map='" + f + "'><option value='-1'>-</option>" + m.header.map(function (h, i) {
      return "<option value='" + i + "'" + (m.mapping[f] === i ? " selected" : "") + ">" + escapeHtml(h || ("column " + (i + 1))) + "</option>";
    }).join("") + "</select>";
  };
  const sample = m.sample.map(function (r) { return "<tr>" + m.header.map(function (_, i) { return "<td>" + escapeHtml(String(r[i] == null ? "" : r[i]).slice(0, 30)) + "</td>"; }).join("") + "</tr>"; }).join("");
  const label = { date: "Date *", time: "Time", type: "Buy / sell / dividend *", isin: "ISIN", symbol: "Ticker symbol", name: "Name", quantity: "Quantity *", price: "Price", amount: "Amount", fee: "Fee", tax: "Tax", currency: "Currency" };
  return "<div class='tr-mapper'><h4>Which column is which?</h4><div class='muted small'>" + escapeHtml(m.fileName) + " was not recognised (" + escapeHtml(m.reason) + "). " +
    "Pick the matching columns; fields with * are needed, plus ISIN or ticker.</div>" +
    "<div class='tr-map-grid'>" + ATLedger.GENERIC_FIELDS.map(function (f) { return "<label>" + label[f] + opt(f) + "</label>"; }).join("") +
    "<label>Date order<select data-mapopt='dateOrder'><option value='dmy'>day first (31.12.2025)</option><option value='mdy'" + (m.dateOrder === "mdy" ? " selected" : "") + ">month first (12/31/2025)</option><option value='ymd'" + (m.dateOrder === "ymd" ? " selected" : "") + ">year first (2025-12-31)</option></select></label>" +
    "<label>Decimal mark<select data-mapopt='decimal'><option value=''>detect</option><option value=','" + (m.decimal === "," ? " selected" : "") + ">comma (1.234,56)</option><option value='.'" + (m.decimal === "." ? " selected" : "") + ">dot (1,234.56)</option></select></label></div>" +
    "<div class='tr-sample'><table class='adm'><thead><tr>" + m.header.map(function (h) { return "<th>" + escapeHtml(h) + "</th>"; }).join("") + "</tr></thead><tbody>" + sample + "</tbody></table></div>" +
    "<div class='tr-btns'><button class='tr-primary' data-act='map-preview'>Check these columns</button> <button data-act='cancel'>Cancel</button></div></div>";
}

function trReportHtml(R) {
  const cv = R.coverage;
  const nTx = TR.txs.length;
  const linkVals = Object.keys(TR.links).map(function (k) { return TR.links[k]; });
  const nCheck = linkVals.filter(function (l) { return l.status === "check"; }).length;
  const nMatched = linkVals.filter(function (l) { return l.status === "matched"; }).length;
  let h = "<div class='tr-wrap'>";
  h += "<div class='tr-topbar'><span class='muted small'>" + nTx + " imported records" + (cv.fileStart ? ", " + trDate(cv.fileStart) + " to " + trDate(cv.fileEnd) : "") + ". Stored only in this browser.</span>" +
    "<button data-act='open-import'>Import another file</button></div>";
  if (TR.msg) h += "<div class='tr-msg'>" + TR.msg + "</div>";

  // Results first: what the data says about you, then the numbers and questions behind it.
  h += trHighlights(R);
  if (self.trCheckHtml) h += trCheckHtml();
  if (self.trAgentHtml) h += trAgentHtml(R);
  if (self.trCoachHtml) {
    try { h += trCoachHtml(R); }
    catch (e) { h += "<div class='tr-msg'>The coach could not be built: " + escapeHtml(e && e.message || e) + "</div>"; }
  }
  if (nCheck) h += "<div class='tr-msg'>" + nCheck + " instrument match" + (nCheck > 1 ? "es need" : " needs") + " a quick check, see <a href='#' data-act='show-links'>Matched stocks</a> below.</div>";

  h += "<div class='usage-cards tr-summary'>" +
    trStat(cv.decisions.analyzable, "decisions analysed", "Buy or sell decisions (all fills of one stock on one day) that can be compared with recorded research: not savings plans, not derivatives/crypto/bonds, and made at least 30 days after Stocktrails started recording.") +
    trStat(R.q1.n ? Math.round(R.q1.researched.p * 100) + "%" : "-", "researched before trading", "Share of analysed decisions with at least one recorded view of that stock in the 30 days before.") +
    trStat(nMatched + " / " + linkVals.length, "instruments matched", "Instruments in your file matched to a stock you track in Stocktrails.") +
    trStat(cv.perMonth == null ? "-" : cv.perMonth.toFixed(1), "decisions / month", "Analysed decisions per month over the period where trades and recorded research overlap.") +
    trStat(R.dividends.count, "dividends", "Dividend payments in the imported files.") +
    "</div>";

  h += trSufficiencyHtml(R);
  h += trSectionHead("Questions", "Grouped by where in a decision they act: research, buying, your calls, selling, and the depot as a whole") +
    trGroupsHtml(R, false) + (TR.users > TR_PEER_MIN ? "<div class='tr-grid'>" + trPeers() + "</div>" : "");
  h += trLinksHtml(linkVals, nCheck > 0);
  h += trManageHtml();
  return h + "</div>";
}

function trSectionHead(title, sub) {
  return "<div class='tr-sechead'><h3 class='tr-sechead-title'>" + title + "</h3><div class='tr-sechead-sub muted small'>" + sub + "</div></div>";
}

function trStat(v, label, desc) { return "<div class='stat' title='" + escapeHtml(desc) + "'><b>" + v + "</b>" + label + "</div>"; }

function trSufficiencyHtml(R) {
  const cv = R.coverage, dc = cv.decisions;
  const rows = [
    ["A1. Research before trading", R.q1.n, R.q1.need, "decisions", R.q1.eta],
    ["A2. Research vs results", R.q3.nSmall, R.q3.need, "buys in the smaller group (researched / not), with a month of prices after", R.q3.eta],
    ["A3. Page types", R.q6.nSmall, R.q6.need, "researched buys in the smaller group (with / without the most common page type)", null],
    ["A4a. Impulse trades", R.q7.n, R.q7.need, "decisions with a trade time", R.q7.eta],
    ["A4b. First look to buy", R.q7.lead.withLook, R.q7.lead.need, "buys with a recorded first look", null],
    ["A4c. Buying by hour", R.q7.hours.n, R.q7.hours.need, "buys with a trade time and a month of prices after", null],
    ["A4d. Conviction x time of day", R.q7.grid ? R.q7.grid.n : 0, R.q7.grid ? R.q7.grid.need : { min: 45, solid: 150 }, "timed buys spread over the grid's cells", null],
    ["B1a. Attention spikes", R.q4.nBuys, R.q4.need, "buys (and half as many sales) with research history", R.q4.eta],
    ["B1b. FOMO check", R.q4.fomo.nSmall, R.q4.fomo.need, "Positive calls in the smaller group (stock rose / fell after the call)", null],
    ["B1c. Rise or fall before the buy", R.q4.runupPerf.nSmall, R.q4.runupPerf.need, "buys in the smaller group (rose / fell since your first look)", null],
    ["B2a-b. Buying vs the market", R.q10.n, R.q10.need, "buys with market context (size by volatility, dip or chase)", R.q10.eta],
    ["B2c. Research vs volatility", R.q10.research.weeks, R.q10.research.need, "weeks of views", null],
    ["C2a. Calls vs actions", R.q2.n, R.q2.need, "decisions made under a Positive/Negative call", R.q2.eta],
    ["C2b. Negative calls you could not act on", R.q2.avoid.n, R.q2.avoid.need, "Negative calls on stocks not held, with 3 months of prices after", null],
    ["C3. Calls you passed on", R.q5.nSmall, R.q5.need, "in the smaller group (passed calls / buys), with 3 months of prices after", R.q5.eta],
    ["D1. Selling at target", R.q11.n, R.q11.need, "targets reached while you held the stock", null],
    ["D2. Selling winners vs losers", R.disposition.days, R.disposition.need, "days with a sale", null],
    ["D3. Holding vs your horizon", R.horizon.n, { min: 5, solid: 15 }, "buys under a Positive call with a horizon", null],
    ["E1. Size vs conviction", R.q8.n, R.q8.need, "buys with an amount", R.q8.eta],
    ["E2. Portfolio vs attention", Math.floor(R.q9.months || 0), R.q9.need, "months of overlap", null]
  ].concat(self.trIndSuffRows ? trIndSuffRows(R) : []);
  let why = "";
  if (cv.firstAttention == null) why = "Stocktrails has not recorded any research yet, so no trade can be compared with research. Browse stocks on the supported sites and come back.";
  else if (cv.fileEnd != null && cv.coverStart > cv.fileEnd) why = "Your file ends on " + trDate(cv.fileEnd) + ", before trades can be compared with recorded research (from " + trDate(cv.coverStart) + "). Export a more recent period.";
  const excl = [];
  if (dc.auto) excl.push(dc.auto + " savings-plan or other automatic buys");
  if (dc.beforeCoverage) excl.push(dc.beforeCoverage + " from before " + trDate(cv.coverStart) + " (research is recorded from " + trDate(cv.firstAttention) + "; a trade needs 30 recorded days before it)");
  if (dc.assetClass) excl.push(dc.assetClass + " derivatives, bonds or crypto");
  const hist = dc.beforeCoverage ? "<div class='tr-msg'>" + dc.beforeCoverage + " decisions come from before Stocktrails recorded your research. " +
    "<a href='#' data-act='open-history'>Import your browsing history</a> (Settings &rarr; Data) to bring that earlier research in.</div>" : "";
  return "<details class='card tr-suff'" + (R.q1.status === "none" ? " open" : "") + "><summary><b>How much can your data say?</b> <span class='muted small'>" +
    dc.analyzable + " of " + dc.all + " decisions can be analysed" + (cv.perMonth ? ", about " + cv.perMonth.toFixed(1) + " per month" : "") + "</span></summary>" +
    (why ? "<div class='tr-msg'>" + why + "</div>" : "") + hist +
    (excl.length ? "<div class='muted small'>Set aside: " + excl.map(escapeHtml).join("; ") + ".</div>" : "") +
    "<div class='tr-suff-rows'>" + rows.map(function (r) {
      const st = r[1] >= r[2].solid ? "solid" : r[1] >= r[2].min ? "indicative" : "none";
      const w = Math.min(100, r[1] / r[2].solid * 100), mk = r[2].min / r[2].solid * 100;
      return "<div class='tr-suff-row'><span>" + r[0] + "</span><div class='tr-bar' title='" + r[1] + " " + escapeHtml(r[3]) + "; minimum " + r[2].min + ", solid " + r[2].solid + "'>" +
        "<i style='width:" + w + "%'></i><em style='left:" + mk + "%'></em></div><span class='muted small'>" + r[1] + " / " + r[2].min + " (" + r[2].solid + ")</span>" + trChip(st) +
        "<span class='muted small'>" + (st === "none" && r[4] ? trMonths(r[4]) + " at your pace" : "") + "</span></div>";
    }).join("") + "</div>" +
    "<div class='muted small'>Reading the labels " + trInfo("<i>Not enough data</i>: below the minimum, nothing is concluded. <i>Indicative</i>: an estimate with a wide range; " +
    "treat it as a hint. <i>Solid</i>: the range is narrow enough to rely on. A result is marked <i>Clear</i> only when its 95% range rules out \"no effect\". " +
    "Returns are noisy: if a stock's one-month return against the market varies by about 10 points from trade to trade, telling apart a 5-point difference between two groups " +
    "takes about 60 trades in each, 30 in each detects about 7 points, and 8 in each only differences of 14 points or more. Rates (like the share of researched trades) settle faster: " +
    "at 30 decisions the 95% range is about &plusmn;18 points, at 100 about &plusmn;10.", "Reading the labels") + "</div></details>";
}

// An (i) marker whose explanation opens on hover, keyboard focus or a tap. Shared by
// every card; html is trusted markup built here, never user text.
function trInfo(html, label) {
  return "<span class='tr-info' tabindex='0' role='button' aria-label='" + escapeHtml(label || "How this is measured") + "'>i<span class='tr-info-pop' role='tooltip'>" + html + "</span></span>";
}

function trCard(num, title, st, clear, body, how, extra) {
  const label = (typeof TR_CARD_LABEL !== "undefined" && TR_CARD_LABEL[num]) || num;
  return "<div class='card tr-q' data-q='" + num + "'><div class='tr-q-head'><span class='tr-q-num'>" + label + "</span><h4>" + title + "</h4>" + (st == null ? "" : trChip(st, clear)) + (how ? trInfo(how) : "") + "</div>" +
    body + (extra || "") + "</div>";
}
function trNotYet(have, min, unit, eta) {
  return "<div class='tr-answer muted'>Not enough data yet: " + have + " of the " + min + " " + unit + " needed." + (eta ? " At your pace that is " + trMonths(eta) + " away." : "") + "</div>";
}

function trQ1(R) {
  const q = R.q1;
  let body = q.status === "none" ? trNotYet(q.n, q.need.min, "decisions", q.eta) :
    "<div class='tr-answer'><b>" + Math.round(q.researched.p * 100) + "%</b> of your decisions had research on that stock in the 30 days before.</div>";
  const figs = [];
  if (q.n) figs.push("Researched: " + q.researched.k + " of " + q.n + " (" + trPctRange(q.researched) + ")");
  if (q.leadDays != null) figs.push("First look to trade, median: " + trDays(q.leadDays));
  if (q.recencyDays != null) figs.push("Last look to trade, median: " + trDays(q.recencyDays));
  if (q.perm) figs.push(q.clear
    ? "Research clusters in the week before trades: " + q.perm.observed.toFixed(1) + " views vs " + q.perm.chance.toFixed(1) + " on a random week (p = " + q.perm.p.toFixed(3) + ")."
    : "Views in the week before trades: " + q.perm.observed.toFixed(1) + " vs " + q.perm.chance.toFixed(1) + " on a random week (p = " + q.perm.p.toFixed(2) + "), " + (q.perm.p < 0.05 ? "a hint of timing, sample still small." : "not distinguishable from your usual attention to these stocks."));
  body += "<ul class='tr-figs'>" + figs.map(function (f) { return "<li>" + f + "</li>"; }).join("") + "</ul>";
  const chart = q.profile ? "<h5>Views per day around your buys (day 0 = trade day, " + q.profile.n + " buys)</h5><canvas id='tr-profile' class='an-canvas tr-canvas'></canvas><div id='tr-profile-tip' class='muted small'></div>" : "";
  return trCard(1, "Do you research before you trade?", q.status, q.clear, body,
    "A decision counts as researched when Stocktrails recorded at least one view of that stock in the 30 days before it (for brokers that give only a date, the whole trade day counts as before). " +
    "Only stocks matched to a tracked stock can be researched; untracked instruments count as not researched. Research outside the supported sites (for example in your broker's app) is not recorded, so this is a lower bound. " +
    "The timing test moves each decision to a random moment in the covered period, 400 times, keeping its stock, and compares the views in the 7 days before: a low p means research clusters right before trades, not just on the stocks you trade.", chart);
}

function trQ2(R) {
  const q = R.q2;
  let body = q.status === "none" ? trNotYet(q.n, q.need.min, "decisions made under a Positive or Negative call", q.eta) :
    "<div class='tr-answer'>Your trades followed your latest call <b>" + Math.round(q.agreement.p * 100) + "%</b> of the time; " + q.contradictions + " went against it.</div>";
  const av = q.avoid, lag = function (d) { return d == null ? "" : ", median " + trDays(d) + " after the call"; };
  const rate = function (w, what) { return w.k + " of " + w.n + " " + what + " (" + Math.round(w.p * 100) + "%)"; };
  body += "<div class='tr-sbars'>" +
    trActRow("Positive call, stock not held", q.posToBuy, q.posToBuy.n ? "bought within 30 days: " + rate(q.posToBuy, "calls") + lag(q.lag.pos) : "no such call yet") +
    trActRow("Negative call, stock held", q.negToSell, q.negToSell.n ? "sold within 30 days: " + rate(q.negToSell, "calls") + lag(q.lag.neg) : "no such call yet") +
    trActRow("Negative call, stock not held", null, av.notHeld ? av.notHeld + (av.notHeld === 1 ? " call" : " calls") + ": there is nothing to sell, so they do not count here (see 2b)" : "none") +
    "</div><div class='muted small'>Filled part: calls you acted on. The line is the 95% range.</div>";
  const figs = [];
  if (q.n) figs.push("Buys after Positive or sales after Negative: " + q.agreement.k + " of " + q.n + " (" + trPctRange(q.agreement) + ")");
  if (q.unlabelled) figs.push(q.unlabelled + " decisions had no call in the 90 days before" + (q.neutral ? ", " + q.neutral + " a Neutral one" : ""));
  body += trFigs(figs);
  return trCard(2, "Do your calls predict what you do?", null, false, trSubq("2a", "Do your trades follow your calls?", trChip(q.status, false), body) + trAvoidHtml(av),
    "For each decision, the latest Positive/Negative/Neutral label on that stock within 90 days before it. A buy agrees with Positive, a sale with Negative. " +
    "A Negative call can only be acted on when you hold the stock (the data holds no short sales), so a Negative call on a stock you do not hold never counts against you in the action rates; " +
    "it is scored on its own in 2b instead. A stock counts as held when the file shows a position at the time of the call, or when a later sale in the file is larger than anything the file bought " +
    "(the shares then came from before the file starts). " +
    "Calls are judged only where the imported file can show what happened in the 30 days after, so a call from before the file's first record is left out, and repeated calls on one stock within 30 days count once.");
}

// One row of the call-to-action bars: the filled part is the share of calls acted on, the line its 95% range.
function trActRow(label, w, note) {
  if (!w || !w.n) return "<div class='tr-sbar-row off'><div class='tr-sbar-label'>" + label + "</div><div class='tr-sbar'></div><div class='tr-sbar-val muted small'>" + note + "</div></div>";
  const pc = function (x) { return (x * 100).toFixed(1); };
  return "<div class='tr-sbar-row' title='" + escapeHtml(Math.round(w.p * 100) + "% (95% range " + Math.round(w.lo * 100) + "-" + Math.round(w.hi * 100) + "%)") + "'>" +
    "<div class='tr-sbar-label'>" + label + "</div><div class='tr-sbar'><i style='width:" + pc(w.p) + "%'></i><b class='tr-whisk' style='left:" + pc(w.lo) + "%;width:" + pc(w.hi - w.lo) + "%'></b></div>" +
    "<div class='tr-sbar-val'>" + note + "</div></div>";
}

// 2b: Negative calls on stocks the user does not hold, scored as "stay away" calls.
function trAvoidHtml(a) {
  if (!a.notHeld) return "";
  let b;
  if (a.status === "none") b = "<div class='muted small'>Not enough data yet: " + a.n + " of " + a.need.min + " Negative calls on stocks you did not hold, with 3 months of prices after" +
    (a.notHeld > a.n ? " (" + a.notHeld + " made; the rest are too recent or have no price)" : "") + ".</div>";
  else b = "<div class='tr-answer'>" + a.lagged.k + " of " + a.n + " stocks you were negative on, and did not own, lagged the NASDAQ over the next 3 months; on average they did <b>" +
    trPct(a.mean, true) + "</b> against it" + (a.ci ? " (95% range " + trRange(a.ci, function (x) { return trPct(x, true); }) + ")" : "") + ". " +
    (a.clear ? (a.mean < 0 ? "Your Negative calls were clearly right." : "The stocks you were negative on clearly beat the market.") : "No clear verdict yet.") + "</div>" +
    trFigs([a.right.length ? "Most right: " + a.right.map(function (x) { return escapeHtml(nameOf(x.ticker)) + " " + trPct(x.ex, true); }).join(", ") : "",
      a.wrong.length ? "Most wrong: " + a.wrong.map(function (x) { return escapeHtml(nameOf(x.ticker)) + " " + trPct(x.ex, true); }).join(", ") : ""].filter(Boolean));
  return trSubq("2b", "Were your Negative calls on stocks you do not hold right?", trChip(a.status, a.clear), b);
}

function trQ3(R) {
  const q = R.q3;
  let body;
  const all = q.researched.n + q.unresearched.n;
  if (q.status === "none" && all >= q.need.min && q.unresearched.n < q.need.min && q.researched.n / all >= 0.85) {
    body = "<div class='tr-answer muted'>You researched almost every buy (" + q.researched.n + " of " + all + "), so there are too few unresearched ones to compare with. " +
      (q.dose ? "The breakdown by research time below compares light and heavy research instead." : "With 9 or more researched buys, a breakdown by research time takes its place.") + "</div>";
  } else if (q.status === "none") body = trNotYet(q.nSmall, q.need.min, "buys in each group (researched and not)", q.eta);
  else {
    body = "<div class='tr-answer'>Researched buys did <b>" + trPct(q.researched.mean, true) + "</b> against the NASDAQ over the next month, unresearched ones <b>" +
      trPct(q.unresearched.mean, true) + "</b>: a difference of <b>" + trPts(q.diff && q.diff.est) + "</b> (95% range " + trRange(q.diff, trPts) + "). " +
      (q.clear ? "That is a clear difference." : "The range includes zero, so this does not show that research changed the outcome yet.") + "</div>";
  }
  const figs = ["Researched buys: " + q.researched.n + ", unresearched: " + q.unresearched.n];
  const sd = trSd(R);
  if (sd && q.researched.n >= 2 && q.unresearched.n >= 2) {
    const mde = 2.8 * sd * Math.sqrt(1 / q.researched.n + 1 / q.unresearched.n);
    figs.push("With the spread of your own trades (" + (sd * 100).toFixed(0) + " pts per trade), this sample can detect differences of about " + (mde * 100).toFixed(0) + " pts or more.");
  }
  if (q.sells.n) figs.push("After your sales the stocks did " + trPct(q.sells.mean, true) + " against the NASDAQ, sign flipped (positive = they lagged, the sale helped), " + q.sells.n + " sales.");
  body += "<ul class='tr-figs'>" + figs.map(function (f) { return "<li>" + f + "</li>"; }).join("") + "</ul>";
  if (q.dose) {
    body += "<h5>By research time before the buy (researched buys, in thirds)</h5><table class='an-table tr-dose'><thead><tr><th>Research</th><th>Buys</th><th>Next month vs NASDAQ</th></tr></thead><tbody>" +
      q.dose.map(function (g, i) {
        return "<tr><td>" + ["Least", "Middle", "Most"][i] + " (" + Math.round(g.from) + "-" + Math.round(g.to) + ")</td><td>" + g.n + "</td><td class='" + signClass(g.mean) + "'>" + trPct(g.mean, true) + "</td></tr>";
      }).join("") + "</tbody></table><div class='muted small'>Research in active minutes " + trInfo("Research measured in active minutes in the 30 days before (views where no time was measured).") + "</div>";
  }
  return trCard(3, "Do researched buys turn out better?", q.status, q.clear, body,
    "Return from the close of the trade day to the close 21 trading days later, minus the NASDAQ Composite over the same days, using Yahoo closes on both ends " +
    "(so a stock bought in euros and listed in dollars is measured in one currency). Means are compared with a bootstrap (2,000 resamples) for the 95% range. " +
    "Researched and unresearched buys can differ in other ways too (stock type, market phase), so a difference is an association, not proof that research caused it.");
}

function trSd(R) {
  const xs = (R.decisions || []).filter(function (d) { return !d.excluded && d.side === "buy" && d.fwd && d.fwd[21]; }).map(function (d) { return d.fwd[21].ex; });
  if (xs.length < 3) return null;
  const m = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
  return Math.sqrt(xs.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / (xs.length - 1));
}

function trQ4(R) {
  const q = R.q4;
  let body;
  if (q.status === "none") body = trNotYet(q.nBuys, q.need.min, "buys with enough research history (and " + q.need.min / 2 + " sales)", q.eta);
  else body = "<div class='tr-answer'><b>" + Math.round(q.spikeBuy.p * 100) + "%</b> of your buys came after a spike in your attention to that stock, against <b>" +
    Math.round(q.spikeSell.p * 100) + "%</b> of your sales." + (q.clear ? (q.spikeBuy.p > q.spikeSell.p ? " Buying follows attention spikes more than selling does: attention is driving what you buy." : " Selling follows attention spikes more than buying does.") : "") + "</div>";
  const figs = [];
  if (q.spikeBuy.n) figs.push("Buys after a spike: " + q.spikeBuy.k + " of " + q.spikeBuy.n + "; sales: " + q.spikeSell.k + " of " + q.spikeSell.n);
  if (q.chase.n) figs.push("Price move from your first look to your buy, median: " + trPct(q.chase.median, true) + "; " + q.chase.over10.k + " of " + q.chase.n + " buys came after a rise of more than 10%");
  if (q.monitoring.ratio != null) figs.push("In the 30 days after a buy you looked at the stock " + q.monitoring.ratio.toFixed(1) + "x as much as in the 30 days before");
  body += "<ul class='tr-figs'>" + figs.map(function (f) { return "<li>" + f + "</li>"; }).join("") + "</ul>";
  return trCard(4, "Which habits show up in your trades?", null, false,
    trSubq("4a", "Do attention spikes drive your buying?", trChip(q.status, q.clear), body) + trFomoHtml(q.fomo) + trRunupHtml(q.runupPerf),
    "A spike: at least 3 views in the 7 days before the decision and at least twice the stock's own weekly average over the 90 days before that. " +
    "Individual investors tend to buy stocks that grab their attention, while sales come from what they already hold; a higher spike share for buys than for sales is that pattern. " +
    "The price move uses Yahoo closes on the day of your first recorded view and on the trade day. " +
    "FOMO check: for every Positive call on a stock you did not hold, the price move from the close on the call day to the close on the day you bought; " +
    "for calls you did not buy, to the call plus your usual call-to-buy delay. Only moves up to the moment of the decision count, so what happened later cannot leak in. " +
    "If you buy mostly the calls that already rose, you are waiting for confirmation and paying for it.");
}

// A sub-question inside a card: tag (4b, 7c...), title and status chip, then its body.
function trSubq(tag, title, chipHtml, bodyHtml) {
  return "<div class='tr-sub'><div class='tr-subq'><span class='tr-subq-tag'>" + tag + "</span><span class='tr-subq-title'>" + title + "</span>" + (chipHtml || "") + "</div>" + bodyHtml + "</div>";
}

// Segmented switch inside a card; the click handler re-renders from the cached report.
function trToggle(name, options, current) {
  return "<div class='seg tr-seg' data-tog='" + name + "'>" + options.map(function (o) {
    return "<button type='button' data-val='" + o[0] + "'" + (o[0] === current ? " class='on'" : "") + ">" + o[1] + "</button>";
  }).join("") + "</div>";
}

function trRunupHtml(r) {
  let b = "";
  if (r.rose.n || r.fell.n) b += "<div>Next month vs NASDAQ: buys after the price <b>rose</b> since your first look " + trPct(r.rose.mean, true) + " (" + r.rose.n +
    "), after it <b>fell</b> " + trPct(r.fell.mean, true) + " (" + r.fell.n + ")" + (r.diff ? "; difference " + trPts(r.diff.est) + " (95% range " + trRange(r.diff, trPts) + ")" : "") + ".</div>";
  if (r.status === "none") b += "<div class='muted small'>Not enough data yet: " + r.nSmall + " of " + r.need.min + " buys needed in each group.</div>";
  else b += "<div>" + (r.clear ? (r.diff.est < 0 ? "Buying after a rise clearly did worse: chasing cost you." : "Buying after a rise clearly did better: you rode momentum.") : "No clear difference yet.") + "</div>";
  return trSubq("4c", "Did buying after a rise pay off?", trChip(r.status, r.clear), b);
}

function trFomoHtml(f) {
  let b = "";
  if (f.runs.n) b += "<div>" + f.runs.up.k + " of " + f.runs.n + " buys made under a Positive call came after the stock had risen since the call; median move between call and buy <b>" +
    trPct(f.runs.median, true) + "</b>" + (f.runs.over10 ? ", " + f.runs.over10 + " after more than +10%" : "") + ".</div>";
  if (f.status === "none") {
    b += "<div class='muted small'>Not enough data yet: " + f.nSmall + " of " + f.need.min + " Positive calls needed in each group (stock rose / fell after the call).</div>";
  } else {
    b += "<div>You bought <b>" + Math.round(f.buyIfUp.p * 100) + "%</b> of the calls whose stock rose in the " + Math.round(f.delayDays) + " days after (" + f.buyIfUp.k + " of " + f.buyIfUp.n +
      ") and <b>" + Math.round(f.buyIfDown.p * 100) + "%</b> of those that fell (" + f.buyIfDown.k + " of " + f.buyIfDown.n + "). " +
      (f.clear ? (f.buyIfUp.p > f.buyIfDown.p ? "You clearly wait for the price to confirm your call before buying." : "You clearly prefer buying after a dip.") : "No clear preference yet.") + "</div>";
  }
  return trSubq("4b", "FOMO check: do you only buy what already rose after your call?", trChip(f.status, f.clear), b);
}

function trQ5(R) {
  const q = R.q5;
  let body;
  if (q.status === "none") body = trNotYet(q.nSmall, q.need.min, "in each group (Positive calls you passed on, and buys) with 3 months of prices after", q.eta);
  else body = "<div class='tr-answer'>Stocks you called Positive but did not buy did <b>" + trPct(q.passed.mean, true) + "</b> against the NASDAQ over the next 3 months; what you bought did <b>" +
    trPct(q.bought.mean, true) + "</b>. " + (q.clear ? (q.diff.est > 0 ? "Your picks clearly beat the ones you passed on." : "The calls you passed on clearly did better than your buys.") : "No clear difference yet.") + "</div>";
  const figs = ["Passed-on Positive calls: " + q.passed.n + ", buys: " + q.bought.n];
  const hit = function (g, who) { return g.n ? who + " " + g.hit.k + " of " + g.n + " (" + Math.round(g.hit.p * 100) + "%)" : null; };
  const hits = [hit(q.passed, "passed-on calls"), hit(q.bought, "buys")].filter(Boolean);
  if (hits.length) figs.push("Beat the NASDAQ after 3 months: " + hits.join(", "));
  if (q.passed.n && q.bought.n) figs.push("Middle value (median): passed-on calls " + trPct(q.passed.median, true) + ", buys " + trPct(q.bought.median, true) + ". The average can be pulled by a few big winners; the median cannot.");
  if (q.bought.weighted != null) figs.push("Your buys, counting each by its size (up to 5 usual buys): " + trPct(q.bought.weighted, true) + (q.bought.withoutTop3 != null ? "; without your 3 best buys the average would be " + trPct(q.bought.withoutTop3, true) : "") + ".");
  if (q.bought.n >= 8 && q.bought.median < 0 && q.bought.mean > 0) figs.push("<b>Most of your buys lagged the NASDAQ over 3 months (the middle one " + trPct(q.bought.median, true) + "), but a few winners lift the average to " + trPct(q.bought.mean, true) + ".</b> That is how a portfolio can still beat the market.");
  if (q.diff) figs.push("Buys minus passed-on calls: " + trPts(q.diff.est) + " (95% range " + trRange(q.diff, trPts) + ")");
  if (q.influence) {
    const f = q.influence, nm = escapeHtml(nameOf(f.ticker)), flips = (!!q.clear) !== f.clearWithout;
    figs.push("<b>" + nm + " moves this result</b> (" + f.nBought + " of your buys, " + f.nPassed + " of the passed-on calls). Without it, buys minus passed-on calls is " + trPts(f.diffWithout.est) + " (95% range " + trRange(f.diffWithout, trPts) + ")" +
      (flips ? ", " + (f.clearWithout ? "clear, where with it the result is not." : "not clear, where with it the result is clear.") : ", the same verdict.") + " A single stock is one story, not a pattern about you.");
  }
  const list = function (a) { return a.map(function (b) { return escapeHtml(nameOf(b.ticker)) + " " + trPct(b.ex, true); }).join(", "); };
  if (q.status !== "none" && q.best.length) figs.push("Best ones you passed on: " + list(q.best) + ". Worst: " + list(q.worst) + ".");
  const chart = q.paths && q.paths.days.length && (q.passed.n >= 3 || q.bought.n >= 3)
    ? "<canvas id='tr-q5-paths' class='an-canvas tr-canvas tr-canvas-tall'></canvas><div id='tr-q5-tip' class='muted small'></div>" +
      "<div class='tr-legend muted small'>" + (q.passed.n >= 3 ? "<span><i style='background:#f1c40f'></i>Positive calls you passed on (" + q.passed.n + ")</span>" : "") +
      (q.bought.n >= 3 ? "<span><i style='background:#3ddc97'></i>Your buys (" + q.bought.n + ")</span>" : "") + "<span>shaded: 95% range</span></div>" : "";
  body += chart + trFigs(figs);
  return trCard(5, "What did the calls you passed on do?", q.status, q.clear, body,
    "A passed-on call: a Positive label on a stock you did not hold and did not buy within 30 days. Its return runs from the close on the day of the call over 63 trading days, minus the NASDAQ. " +
    "Buys are measured the same way from the trade day. This can differ from card E2 (your holdings against the NASDAQ), which is not a contradiction: card C3 looks at 63 days after each buy and counts every buy equally; " +
    "card E2 follows what you actually held for as long as you held it, weights by money, includes dividends and your sales, and compounds. Buys that lag at 63 days can still be outweighed by a few big winners held for years. The chart follows the average excess return day by day; the shaded band is a bootstrap 95% range (whole paths resampled), " +
    "so a band that includes zero all the way means no clear difference from the market yet. Best and worst are both listed so the card does not only show the ones that got away.");
}

const TR_TYPE_LABEL = { overview: "Overview", news: "News", financials: "Financials", analysis: "Analysis", charts: "Charts", community: "Community",
  screener: "Screener", options: "Options", ownership: "Ownership", profile: "Profile", ai: "AI assistant", insider: "Insider trades", short: "Short interest",
  institutional: "Institutional holders", dividends: "Dividends", earnings: "Earnings", estimates: "Estimates", unclassified: "Unclassified" };
function trFigs(figs) { return figs.length ? "<ul class='tr-figs'>" + figs.map(function (f) { return "<li>" + f + "</li>"; }).join("") + "</ul>" : ""; }
function trCorrTxt(c) {
  return c && c.r != null ? "r = " + (c.r >= 0 ? "+" : "") + c.r.toFixed(2) +
    (c.lo != null ? " (" + Math.round((c.level || 0.95) * 100) + "% range " + c.lo.toFixed(2) + " to " + c.hi.toFixed(2) + ")" : "") + ", " + c.n + " points" : "-";
}
function trCorrClear(c) { return c && c.lo != null && (c.lo > 0 || c.hi < 0); }

function trQ6(R) {
  const q = R.q6;
  let body;
  if (q.status === "none") body = trNotYet(q.nSmall, q.need.min, "researched buys with and without a page type", null);
  else {
    const best = q.rows.filter(function (r) { return r.clear; });
    body = "<div class='tr-answer'>" + (best.length
      ? best.map(function (r) { return "Buys researched with <b>" + escapeHtml(TR_TYPE_LABEL[r.type] || r.type) + "</b> pages did " + (r.diff.est > 0 ? "clearly better" : "clearly worse") + " (" + trPts(r.diff.est) + ")"; }).join("; ") + "."
      : "No page type stands out yet: the differences below are within what chance produces.") + "</div>";
  }
  if (q.rows.length) {
    body += "<table class='an-table tr-dose'><thead><tr><th>Page type before the buy</th><th>Buys with</th><th>Next month</th><th>Without</th><th>Difference (99% range)</th></tr></thead><tbody>" +
      q.rows.slice(0, 8).map(function (r) {
        return "<tr><td>" + escapeHtml(TR_TYPE_LABEL[r.type] || r.type) + "</td><td>" + r.nWith + "</td><td class='" + signClass(r.meanWith) + "'>" + trPct(r.meanWith, true) +
          "</td><td class='" + signClass(r.meanWithout) + "'>" + trPct(r.meanWithout, true) + " <span class='muted small'>(" + r.nWithout + ")</span></td><td>" +
          (r.diff ? trPts(r.diff.est) + " <span class='muted small'>" + trRange(r.diff, trPts) + "</span>" : "-") + "</td></tr>";
      }).join("") + "</tbody></table>";
  }
  return trCard(6, "Which page types come before better buys?", q.status, q.clear, body,
    "For each page type (as classified when you viewed it), researched buys whose 30 days before included that type are compared with researched buys whose did not, " +
    "on the next month's return against the NASDAQ. Because several types are compared at once, a difference counts as clear only when its 99% range excludes zero. " +
    "Views loaded from browsing history are classified from the URL alone.");
}

// The day-part analysis currently shown: the user's own buying clusters when
// they exist and are chosen, else the fixed parts.
function trHours(R) {
  const by = R.q7.hoursBy;
  if (TR.hourMode === "custom" && by.custom) return by.custom;
  if (TR.hourMode === "fixed") return by.fixed;
  return by.clusters || by.fixed;
}

// Day-part switch shared by 7c and 7d: your buying clusters, fixed parts, or
// parts you define (start hours, e.g. 6, 11, 15, 19, 22).
function trPartsControls(q, hs) {
  const opts = [];
  if (q.hoursBy.clusters) opts.push(["clusters", "Your buying clusters"]);
  opts.push(["fixed", "Fixed parts"], ["custom", "Define my own"]);
  let h = "<div class='tr-tog-row'><span class='muted small'>Parts of the day</span>" + trToggle("hours", opts, TR.hourMode === "custom" ? "custom" : hs.mode) + "</div>";
  if (TR.hourMode === "custom") {
    h += "<div class='tr-parts-edit'><span class='muted small'>Each part starts at hour</span> " + trInfo("Hours on your clock, 0 to 23. A part runs from its start hour to the next one; the last runs past midnight to the first. At least two hours.", "About the parts of the day") + " " +
      "<input type='text' class='tr-parts-in' value='" + escapeHtml(TR.customParts.join(", ")) + "' size='24' placeholder='6, 11, 15, 19, 22' aria-label='Start hours of the parts of the day'> " +
      "<button class='tr-primary' data-act='apply-parts'>Apply</button>" +
      (TR.partsMsg ? " <span class='tr-parts-msg'>" + escapeHtml(TR.partsMsg) + "</span>" : "") + "</div>";
  }
  return h;
}

function trQ7(R) {
  const q = R.q7;
  let body = q.status === "none" ? trNotYet(q.n, q.need.min, "decisions with a trade time", q.eta)
    : "<div class='tr-answer'><b>" + Math.round(q.impulse.p * 100) + "%</b> of your decisions came within an hour of your first look at the stock (" + q.impulse.k + " of " + q.n +
      ": " + q.sides.buy + " buys, " + q.sides.sell + " sales).</div>";
  const figs = [];
  const rr = q.returns;
  if (rr.impulse.n || rr.considered.n) figs.push("Next month vs NASDAQ: impulse buys " + trPct(rr.impulse.mean, true) + " (" + rr.impulse.n + "), buys first looked at a week or more before " +
    trPct(rr.considered.mean, true) + " (" + rr.considered.n + ")" + (rr.diff ? "; difference " + trPts(rr.diff.est) + " (95% range " + trRange(rr.diff, trPts) + ")" : "") +
    (rr.status === "none" || !rr.status ? ", too few to compare yet" : ""));
  if (q.sameDay.n) figs.push("Brokers that give only a date: " + q.sameDay.k + " of " + q.sameDay.n + " decisions followed a first look on the same day");
  body = trSubq("7a", "Do you trade on impulse?", trChip(q.status, q.clear), body + trFigs(figs));

  // 7b: first view -> buy, as a distribution.
  const L = q.lead;
  if (L.n) {
    const max = Math.max.apply(null, L.buckets.map(function (b) { return b.n; })) || 1;
    body += trSubq("7b", "How long from your first look to the buy?", trChip(L.status),
      "<div class='muted small'>" + L.n + " buys" + (L.median != null ? ", median " + trDays(L.median) : "") + "</div>" +
      "<table class='an-table tr-dose tr-lead'><thead><tr><th>First look before the buy</th><th>Buys</th><th></th><th>Next month vs NASDAQ</th></tr></thead><tbody>" +
      L.buckets.filter(function (b) { return b.n; }).map(function (b) {
        return "<tr><td>" + escapeHtml(b.label) + "</td><td>" + b.n + "</td><td><span class='tr-hbar' style='width:" + Math.round(b.n / max * 100) + "%'></span></td><td class='" + signClass(b.mean) + "'>" +
          (b.withRet ? trPct(b.mean, true) + " <span class='muted small'>(" + b.withRet + ")</span>" : "-") + "</td></tr>";
      }).join("") + "</tbody></table>");
  }

  // 7c: hour of day - when you research vs when you buy, and how buys at each time did.
  const hs = trHours(R), hasClusters = !!q.hoursBy.clusters;
  let hb = "";
  if (hs.buysByHour.some(function (x) { return x; })) {
    hb += trPartsControls(q, hs) +
      "<canvas id='tr-hours' class='an-canvas tr-canvas'></canvas><div id='tr-hours-tip' class='muted small'></div>" +
      "<table class='an-table tr-dose'><thead><tr><th>Time (your clock)</th><th>Buys</th><th>Impulse</th><th>Your views</th><th>Next month vs NASDAQ</th><th>Boundaries 1 h earlier / later</th><th>vs your other buys (99% range)</th></tr></thead><tbody>" +
      hs.blocks.map(function (b) {
        return "<tr><td>" + escapeHtml(b.label) + "</td><td>" + b.buys + "</td><td>" + b.impulse + "</td><td>" + (b.viewShare == null ? "-" : Math.round(b.viewShare * 100) + "%") + "</td><td class='" + signClass(b.mean) + "'>" +
          (b.n ? trPct(b.mean, true) + " <span class='muted small'>(" + b.n + ")</span>" : "-") + "</td><td class='muted small'>" + trPct(b.shifted.earlier, true) + " / " + trPct(b.shifted.later, true) + "</td><td>" +
          (b.diff ? trPts(b.diff.est) + " <span class='muted small'>" + trRange(b.diff, trPts) + "</span>" + (b.clear ? (b.robust ? " <span class='tr-chip st-solid'>robust</span>" : " <span class='tr-chip st-indicative'>moves with boundaries</span>") : "") : "-") + "</td></tr>";
      }).join("") + "</tbody></table>" +
      (hs.nearBoundary != null ? "<div class='muted small'>" + Math.round(hs.nearBoundary * 100) + "% of your timed buys sit within an hour of a boundary and change part of the day when the boundaries move by an hour. " +
        "The higher that share, the more the table depends on where the lines are drawn; advice uses only results that hold either way." +
        (hs.mode === "clusters" ? " Your clusters are cut in the valleys of your own buy times, which keeps that share low." : hs.mode === "custom" ? " These are the parts you defined." : (hasClusters ? " Switch to your buying clusters to cut the day where you rarely buy." : " Your buys do not form separate clusters yet, so the fixed parts are used.")) + "</div>" : "") +
      "<div class='tr-advice'>" + trHourAdvice(hs) + "</div>";
  } else hb += "<div class='muted small'>No buys with a trade time yet (brokers that export only dates cannot be placed in the day).</div>";
  body += trSubq("7c", "When in the day do you buy?", trChip(hs.status, hs.clear), hb);

  // 7d: conviction x time of day
  const grid = q.grids && q.grids[hs.mode] ? q.grids[hs.mode][TR.convMode === "watchlist" ? "watchlist" : "thirds"] : null;
  if (grid) body += trGridHtml(grid, trPartsControls(q, hs));
  return trCard(7, "When and how fast do you decide?", null, false, body,
    "An impulse trade: the first recorded view of that stock is less than an hour before the trade. \"First recorded\" means since Stocktrails started recording " +
    "(or since the earliest visit in an imported browsing history); research elsewhere, such as in your broker's app, is not seen. " +
    "The time-of-day table compares buys placed in each part of the day (your device's clock) with all your other buys, on the next month against the NASDAQ. " +
    "Several parts of the day are compared at once, so a difference counts only when its 99% range excludes zero. " +
    "Your buying clusters are found from when you bought, never from how the buys turned out: the 24-hour histogram of your buy times is smoothed, its peaks are located " +
    "(at least two, each holding 3 or more buys) and each boundary is put at the deepest valley between two peaks. " +
    "Advice appears only for a clear difference that holds with the boundaries moved an hour either way; otherwise the chart simply shows when you research and when you buy.");
}

// Conviction bands x parts of the day, next month vs NASDAQ per cell. Cells
// under 5 buys show their count only. Descriptive: this many cells are too thin
// for a test per cell, so the status is about whether the grid is worth reading.
function trGridHtml(g, partsHtml) {
  const all = [].concat.apply([], g.cells).map(function (c) { return c.mean; }).filter(function (v) { return v != null; });
  const lim = Math.max(0.02, Math.max.apply(null, all.map(Math.abs).concat([0])));
  const cell = function (c) {
    if (c.mean == null) return "<td class='tr-gc muted small'>" + (c.n ? c.n + (c.n === 1 ? " buy" : " buys") : "") + "</td>";
    const a = Math.min(1, Math.abs(c.mean) / lim), col = c.mean >= 0 ? "61,200,140" : "231,76,60";
    return "<td class='tr-gc' style='background:rgba(" + col + "," + (0.12 + 0.5 * a).toFixed(2) + ")'>" + trPct(c.mean, true) + "<div class='muted small'>" + c.n + "</div></td>";
  };
  const cells = g.rows.length * g.cols.length;
  return trSubq("7d", "Conviction x time of day", trChip(g.status),
    (partsHtml || "") +
    "<div class='tr-tog-row'><span class='muted small'>Conviction bands</span>" + trToggle("conv", [["thirds", "Thirds of my buys"], ["watchlist", "Watchlist colours"]], g.mode) + "</div>" +
    "<table class='an-table tr-grid-t'><thead><tr><th>Conviction in the 30 days before the buy</th>" + g.cols.map(function (c) { return "<th>" + escapeHtml(c) + "</th>"; }).join("") + "</tr></thead><tbody>" +
    g.cells.map(function (r, i) { return "<tr><td>" + escapeHtml(g.rows[i]) + "</td>" + r.map(cell).join("") + "</tr>"; }).join("") +
    "</tbody></table><div class='muted small'>Next month vs NASDAQ per cell, number of buys underneath; a value appears from 5 buys. " + trInfo(
    "Conviction is never below 0 (no recorded research). \"Watchlist colours\" use the same fixed bands as the watchlist's pills (red up to 1, amber up to 3, green over 3) but " +
    "measured over the 30 days before each buy, not over all your views; \"thirds\" cut your own buys into three equal groups, so every row has buys. " +
    "Read the grid as a map of where your better and worse buys cluster (for example low-conviction buys late at night), not as a tested result: " +
    g.n + " buys over " + cells + " cells is " + (g.n / cells).toFixed(1) + " per cell on average" + (g.status === "none" ? ", below the " + g.need.min + " this grid needs" : "") + ".", "About conviction bands") + "</div>");
}

function trHourAdvice(hs) {
  const lines = [];
  const bad = hs.blocks.filter(function (b) { return b.robust && b.diff.est < 0; });
  const good = hs.blocks.filter(function (b) { return b.robust && b.diff.est > 0; });
  bad.forEach(function (b) { lines.push("<b>Avoid buying in the " + escapeHtml(b.label.toLowerCase()) + "</b>: your buys then did " + (Math.abs(b.diff.est) * 100).toFixed(1) + " pts worse than your others."); });
  good.forEach(function (b) { lines.push("<b>Your best buys are placed in the " + escapeHtml(b.label.toLowerCase()) + "</b>: " + trPts(b.diff.est) + " against your others."); });
  if (hs.peakView != null) lines.push("You research most around " + hs.peakView + ":00.");
  const imp = hs.blocks.slice().sort(function (a, b) { return b.impulse - a.impulse; })[0];
  const nImp = hs.blocks.reduce(function (s, b) { return s + b.impulse; }, 0);
  if (nImp >= 3 && imp.impulse / nImp >= 0.5) lines.push("Most of your impulse buys (" + imp.impulse + " of " + nImp + ") happen in the " + escapeHtml(imp.label.toLowerCase()) +
    ": if you research then, sleep on it before buying.");
  if (!bad.length && !good.length) lines.push(hs.status === "none" ? "Not enough timed buys yet to say whether the time of day matters (" + hs.n + " of " + hs.need.min + ")." : "No time of day stands out yet.");
  return lines.join(" ");
}

function trQ8(R) {
  const q = R.q8;
  let body;
  const c = q.sizeVsConviction;
  if (q.status === "none") body = trNotYet(q.n, q.need.min, "buys with an amount", q.eta);
  else body = "<div class='tr-answer'>" + (trCorrClear(c) ? (c.r > 0 ? "You put clearly more money behind stocks you researched more." : "Your biggest positions clearly got the least research.")
    : "No clear link between how much you researched a stock and how much you invested in it.") + "</div>";
  const figs = ["Conviction vs position size: " + trCorrTxt(c)];
  if (q.sizeVsReturn && q.sizeVsReturn.r != null) figs.push("Position size vs next month's return against NASDAQ: " + trCorrTxt(q.sizeVsReturn));
  body += trFigs(figs);
  const mode = TR.convMode === "watchlist" ? "watchlist" : "thirds", bands = q.bands && q.bands[mode];
  if (bands) body += "<div class='tr-tog-row'><span class='muted small'>Conviction bands</span>" + trToggle("conv", [["thirds", "Thirds of my buys"], ["watchlist", "Watchlist colours"]], mode) + "</div>" +
    "<table class='an-table tr-dose'><thead><tr><th>Conviction</th><th>Buys</th><th>Median size vs your usual buy</th></tr></thead><tbody>" +
    bands.map(function (g) { return "<tr><td>" + escapeHtml(g.label) + "</td><td>" + g.n + "</td><td>" + (g.size == null ? "-" : g.size.toFixed(2) + "x") + "</td></tr>"; }).join("") + "</tbody></table>";
  return trCard(8, "Do you size positions by conviction?", q.status, q.clear, body,
    "Conviction is the watchlist's score over the 30 days before each buy: log2(1 + views) x (0.5 + 0.5 x deepest scroll) x (1 + 0.1 x focus switches). It can never be below 0; 0 means no recorded research. " +
    "The watchlist's colours use the same formula over all your views of a stock, with fixed bands (red up to 1, amber up to 3, green over 3). Here the score is measured over the 30 days before each buy, " +
    "and the bands are either the same fixed ones or thirds of your own buys. " +
    "Size is the buy's amount divided by your usual buy at that time: the median of your buys in the same currency over the previous 6 months (12 or 24 months when that holds fewer than 4), " +
    "so euro and dollar buys are comparable and a growing portfolio does not make every later buy look large; the first buys have no usual size yet and are left out. " +
    "Spearman rank correlation, so one very large position cannot drive the result.");
}

// Window or lag changed: recompute and redraw question 9 only, in place.
function trRefreshQ9() {
  const old = document.querySelector("#trades-root [data-q='9']");
  if (!TR.report || !TR.report.recomputeQ9 || !old) { TR.reportKey = null; return renderTrades(); }
  TR.report.q9 = TR.report.recomputeQ9({ windowDays: TR.winDays, lagDays: TR.lagDays });
  const tmp = document.createElement("div");
  tmp.innerHTML = trQ9(TR.report);
  old.replaceWith(tmp.firstElementChild);
  trDrawCharts(TR.report, "q9");
}

function trQ9(R) {
  const q = R.q9;
  let body;
  if (!q.returns) body = "<div class='tr-answer muted'>Not enough data yet: needs trades after Stocktrails started recording and prices for them.</div>";
  else {
    body = "<div class='tr-answer'>From " + escapeHtml(q.dates[0]) + ": your holdings <b>" + trPct(q.returns.portfolio, true) + "</b>, a basket of what you looked at in the last " + TR.winDays + " days <b>" +
      trPct(q.returns.attention, true) + "</b>, a basket of everything you have ever looked at <b>" + trPct(q.returns.attentionAll, true) + "</b>, the NASDAQ <b>" + trPct(q.returns.bench, true) + "</b>" +
      (q.status === "none" ? " (only " + q.months.toFixed(1) + " months so far)" : "") + ".</div>" +
      "<div class='tr-tog-row'><label class='muted small'>Weight window of the recent-attention basket: views in the last " +
      "<select data-win>" +
      [7, 14, 30, 60, 90, 180, 365].map(function (d) { return "<option value='" + d + "'" + (TR.winDays === d ? " selected" : "") + ">" + d + " days</option>"; }).join("") + "</select></label>" +
      "<label class='muted small'>Decision lag: a view can first drive a buy " +
      "<select data-lag>" +
      [0, 1, 2, 3, 5, 7, 14].map(function (d) { return "<option value='" + d + "'" + (TR.lagDays === d ? " selected" : "") + ">" + (d ? d + " day" + (d > 1 ? "s" : "") : "0 days (same close)") + "</option>"; }).join("") + "</select> later</label></div>" +
      "<canvas id='tr-pf' class='an-canvas tr-canvas'></canvas><div id='tr-pf-tip' class='muted small'></div>" +
      trFigs(["Daily returns of your holdings vs the recent-attention basket: " + trCorrTxt(q.dailyCorr) + "; vs the all-attention basket: " + trCorrTxt(q.dailyCorrAll) + ". Close to 1 = you own what you look at; close to 0 = your portfolio and your research live apart."]
        .concat(q.attCoverage != null && q.attCoverage < 0.98 ? ["The attention baskets price " + Math.round(q.attCoverage * 100) + "% of your views; stocks without a price are left out."] : [])
        .concat(q.hasDividends ? ["Holdings include dividends after withholding tax (a total return); the indices do not."] : [])
        .concat(q.cashDays ? ["Flat stretches of the holdings line: " + q.cashDays + " trading days fully in cash."] : [])
        .concat(q.gapDays ? ["Gaps: " + q.gapDays + " trading days when you held only instruments without a price (" + q.unpriced + " in your files have none; give them a price symbol under Matched stocks)."] : []));
  }
  return trCard(9, "Your real portfolio vs your attention", q.status, false, body,
    "Holdings: the invested part only (cash ignored), from your imported trades, valued at the purchase amount and moved by the stock's price since, so later currency moves are not included; dividends are not added. " +
    "Two ways to turn your attention into a portfolio. Recent attention: every day, the stocks you viewed in the chosen window (30 days by default), weighted by those views; a stock you stop looking at drops out once its last view leaves the window " +
    "(with no views in the window the last basket is kept rather than moving to cash). It follows what is on your mind now, so it rotates into whatever you have just been reading about. " +
    "All attention: every stock you have viewed so far, weighted by all its views to date and never dropped; a stock you stop viewing only loses weight as others collect views. " +
    "Without dropping, an unwatched stock still loses weight as your other stocks collect views, and its value moves with its price, but it stays in the basket. That is the same idea as the My Stocks Index with \"Hold everything attended\" and \"Attention-weighted\", " +
    "but the two are not identical: the Index starts at each stock's own first view (earlier than your first trade), counts views from its daily event list and can be shown in USD, " +
    "while this one starts on the first day you held a priced stock and counts every view. Every viewed stock with a price is included, not only your favourites: " +
    "picking the most-viewed names over the whole period would favour stocks you looked at more later, often because they had risen. " +
    "A view can first drive the basket held from a close at least the decision lag earlier (default 1 day: safe for exchanges that close before the US one; 0 = the same 16:00 ET close, exact only for US listings; raise it if you research for days before buying), and neither basket pays costs or spreads; a basket rebalanced daily to views has high turnover, so real trading would give up some of it. " +
    "This compares paths; it is not a test with a yes/no answer.");
}

function trVolRange(r) {
  const p = function (x) { return Math.round(x * 100) + "%"; };
  return r.from == null ? "under " + p(r.to) : r.to == null ? "over " + p(r.from) : p(r.from) + " to " + p(r.to);
}

// 10a: how much you put into a buy, by how turbulent the market was just before.
function trQ10Size(q) {
  const sz = q.size, rg = q.regimes, d = sz && sz.diff;
  let b;
  if (q.status === "none") b = trNotYet(q.n, q.need.min, "buys with market data before them", q.eta);
  else {
    const clearD = d && d.p != null && d.p <= 0.01, x = function (v) { return Math.pow(2, v).toFixed(1) + "x"; };
    b = "<div class='tr-answer'>" + (clearD ? "In turbulent markets you put <b>" + x(d.est) + "</b> as much into a buy as in calm ones; if your buying had nothing to do with the market, chance alone would give " + x(d.lo) + " to " + x(d.hi) + " (99%)."
      : "No clear link between how turbulent the market was and how much you put into a buy" + (d ? " (you put " + x(d.est) + " as much in turbulent as in calm markets; chance alone gives " + x(d.lo) + " to " + x(d.hi) + ")." : ".")) + "</div>";
    const tilted = rg.filter(function (r) { return r.tilt; });
    if (tilted.length) b += "<div>" + tilted.map(function (r) {
      return "<b>" + Math.round(r.share.p * 100) + "%</b> of your buys came in " + r.label.toLowerCase() + " markets, which are " + Math.round(r.baseShare * 100) + "% of days: you buy " + (r.tilt === "more" ? "more" : "less") + " often then.";
    }).join(" ") + "</div>";
  }
  if (rg && rg.some(function (r) { return r.nSized; })) {
    b += "<canvas id='tr-q10-size' class='an-canvas tr-canvas tr-canvas-tall'></canvas><div id='tr-q10-size-tip' class='muted small'></div>" +
      "<div class='tr-legend muted small'><span><i style='background:#4e9eff'></i>one buy</span><span><i style='background:#3ddc97'></i>median</span><span>box: middle half</span><span>dashed line: your usual buy</span></div>" +
      "<table class='an-table tr-dose'><thead><tr><th>Market before the buy</th><th>NASDAQ volatility (a year's pace)</th><th>Your buys</th><th>Share of days</th><th>Median buy</th></tr></thead><tbody>" +
      rg.map(function (r) {
        return "<tr><td>" + r.label + "</td><td>" + trVolRange(r) + "</td><td>" + r.n + " <span class='muted small'>(" + Math.round(r.share.p * 100) + "%)</span></td><td>" + Math.round(r.baseShare * 100) + "%</td><td>" +
          (r.median == null ? "-" : r.median.toFixed(2) + "x") + (r.nSized ? " <span class='muted small'>(" + r.nSized + ")</span>" : "") + "</td></tr>";
      }).join("") + "</tbody></table>";
  }
  const figs = [];
  if (sz && sz.rho && sz.rho.r != null) figs.push("Volatility vs size, ranked: r = " + (sz.rho.r >= 0 ? "+" : "") + sz.rho.r.toFixed(2) + "; if your buying had nothing to do with the market, chance alone would give " +
    sz.rho.lo.toFixed(2) + " to " + (sz.rho.hi >= 0 ? "+" : "") + sz.rho.hi.toFixed(2) + " (99%), " + sz.rho.n + " buys");
  return trSubq("10a", "Do you buy bigger when the market is turbulent?", trChip(q.status, sz && sz.clear), b + trFigs(figs));
}

// 10b: do you buy after weak stretches in the market (the dip) or after strong ones (chasing)?
function trQ10Dip(q) {
  const m = TR.dipMode === "dd" ? "dd" : "ret", d = q.dip && q.dip[m];
  const tog = "<div class='tr-tog-row'><span class='muted small'>Measure (of the NASDAQ, not of the stock; the stock's own run-up is card B1c)</span>" + trToggle("dip", [["ret", "Market return, last 20 days"], ["dd", "Distance from the 52-week high"]], m) + "</div>";
  if (q.status === "none" || !d) return trSubq("10b", "Do you buy the dip or chase the market?", trChip(q.status), trNotYet(q.n, q.need.min, "buys with market data before them", q.eta));
  const p = d.mean, pc = function (x) { return Math.round(x * 100); };
  const lowerWord = m === "dd" ? "further below its 52-week high" : "a lower 20-day return";
  const higherWord = m === "dd" ? "closer to its 52-week high" : "a higher 20-day return";
  const verdict = d.verdict === "dip" ? "You buy weakness: on your buy days the NASDAQ had " + lowerWord + " than on <b>" + pc(1 - p.est) + "%</b> of all trading days."
    : d.verdict === "chase" ? "You buy strength: on your buy days the NASDAQ had " + higherWord + " than on <b>" + pc(p.est) + "%</b> of all trading days."
    : "No clear tilt: your buys fall about where chance would put them (a typical buy day sits at the " + pc(p.est) + "th percentile; chance alone gives " + pc(p.lo) + " to " + pc(p.hi) + ").";
  let b = "<div class='tr-answer'>" + verdict + "</div>" + tog;
  const labels = m === "dd" ? ["Deepest below the high", "Well below", "Middle", "Near the high", "At the high"] : ["Weakest fifth", "Weak", "Middle", "Strong", "Strongest fifth"];
  const top = Math.max(0.4, Math.max.apply(null, d.fifths.map(function (f) { return Math.max(f.hi || 0, f.p || 0); })));
  b += "<div class='tr-fifths' style='--base:" + (0.2 / top * 100).toFixed(1) + "%'>" + d.fifths.map(function (f, i) {
    return "<div class='tr-fifth' title='" + escapeHtml(labels[i] + ": " + f.k + " of " + f.n + " buys (" + pc(f.p) + "%); chance alone gives " + pc(f.lo) + "% to " + pc(f.hi) + "%") + "'><div class='tr-fifth-bar'>" +
      (f.lo != null ? "<b class='tr-band' style='bottom:" + (f.lo / top * 100).toFixed(1) + "%;height:" + ((f.hi - f.lo) / top * 100).toFixed(1) + "%'></b>" : "") +
      "<i style='height:" + ((f.p || 0) / top * 100).toFixed(1) + "%'></i></div><span class='tr-fifth-pct'>" + (f.p == null ? "-" : pc(f.p) + "%") +
      "</span><span class='tr-fifth-l muted small'>" + labels[i] + "</span></div>";
  }).join("") + "</div><div class='tr-legend muted small'><span>share of your buys in each fifth of all trading days</span><span>dashed line: 20% each</span><span>shaded band: what chance gives (99%)</span></div>";
  const figs = ["Where your buys sit among all days: " + pc(p.est) + "th percentile on average; chance alone gives " + pc(p.lo) + " to " + pc(p.hi) + " (99%). 50 = typical day, below = after weakness, above = after strength"];
  if (d.weighted && d.weighted.est != null) figs.push("Counting each buy by its size: " + pc(d.weighted.est) + "th percentile; chance alone gives " + pc(d.weighted.lo) + " to " + pc(d.weighted.hi) + " (99%)");
  const bd = d.bands;
  if (bd.some(function (x) { return x.n; })) figs.push("Next month vs NASDAQ, by how the market looked: weakest third of days " + (bd[0].n ? trPct(bd[0].mean, true) + " (" + bd[0].n + ")" : "-") +
    ", middle " + (bd[1].n ? trPct(bd[1].mean, true) + " (" + bd[1].n + ")" : "-") + ", strongest third " + (bd[2].n ? trPct(bd[2].mean, true) + " (" + bd[2].n + ")" : "-") +
    (d.diff ? "; strongest minus weakest " + trPts(d.diff.est) + " (95% range " + trRange(d.diff, trPts) + ")" + (d.diffClear ? " - clear" : d.diffStatus === "none" ? ", too few to compare yet" : ", not clear yet") : ""));
  return trSubq("10b", "Do you buy the dip or chase the market?", trChip(q.status, d.verdict !== "none" || d.diffClear), b + trFigs(figs));
}

function trQ10(R) {
  const q = R.q10, rs = q.research;
  const body = trQ10Size(q) + trQ10Dip(q) +
    trSubq("10c", "Do you research more when the market is volatile?", trChip(rs.status, rs.clear),
      "<div class='tr-answer'>" + (rs.status === "none" ? "Not enough data yet: " + rs.weeks + " of the " + rs.need.min + " weeks needed."
        : trCorrClear(rs.viewsVsVol) ? "You look at stocks " + (rs.viewsVsVol.r > 0 ? "more" : "less") + " in volatile weeks." : "No clear link between the market's volatility and how much you look at stocks.") + "</div>" +
      trFigs(["Weekly views vs NASDAQ volatility: " + trCorrTxt(rs.viewsVsVol)]));
  return trCard(10, "Does the market's mood move you?", null, false, body,
    "For every buy (savings plans excluded) the NASDAQ is described by the bars BEFORE the trade day, never the day itself: its volatility (standard deviation of the last 20 daily returns, shown as a year's pace), its return over the last 20 trading days, and its distance from the highest close of the last 252 days. " +
    "The same numbers are worked out for every trading day of the period where your trades and recorded research overlap" + (q.baseDays ? " (" + q.baseDays + " days)" : "") + ", so a buy is placed among all those days by percentile: 50 is a typical day. " +
    "That is the base rate: buying in turbulent markets only means something compared with how often markets are turbulent. Calm, normal and turbulent are thirds of those days by volatility. " +
    "Size is the buy's amount against your usual buy at that time (the median of your buys in the same currency over the previous 6 months), so a growing portfolio does not read as buying bigger. " +
    "What chance gives is found by sliding your whole pattern of buys along the calendar (every possible shift, wrapping round) and measuring again each time: your buys keep their spacing and bursts, " +
    "the market keeps its calm and turbulent stretches, and only how the two line up changes. That is stricter than shuffling single buys, because markets stay turbulent for weeks and buying comes in bursts, which makes neighbouring days alike. " +
    "Several measures are read side by side, so a result counts as clear only when it falls outside the 99% range of chance. " +
    "This describes your habit; it does not say that buying after weakness or strength is wise, which is what the next-month figures test (those use an ordinary bootstrap, 95%). " +
    "10c: views per calendar week against that week's volatility (Pearson, 95% range); no decision is involved there, so the week's own volatility is used.");
}

function trQ11(R) {
  const q = R.q11;
  let body = q.status === "none" ? trNotYet(q.n, q.need.min, "targets reached while you held the stock", null)
    : "<div class='tr-answer'>Your target was reached while you held the stock <b>" + q.n + "</b> times; you sold within two weeks <b>" + q.sold.k + "</b> times (" + Math.round(q.sold.p * 100) + "%).</div>";
  const figs = [];
  if (q.heldOnAfter.n) figs.push("When you held on past the target, the stock then did " + trPct(q.heldOnAfter.mean, true) + " against the NASDAQ over the next month (" + q.heldOnAfter.n + ")");
  if (q.notReached) figs.push(q.notReached + " targets were not reached while you held the stock");
  if (!q.n && !q.notReached) figs.push("No Positive call with a target price on a stock you held. Set a target in the label widget to measure this.");
  return trCard(11, "Do you sell when your target is reached?", q.status, false, body + trFigs(figs),
    "Positive calls with a target price: the first daily close at or above the target while you held the stock, and whether a sale followed within 14 days. " +
    "Targets are compared with Yahoo closes, the same prices the label widget shows.");
}

// Shown only once the community is large enough for a comparison to say
// anything and to keep individuals unidentifiable. Comparing trades across
// users also needs end-to-end encrypted sync and an explicit opt-in first.
function trPeers() {
  return "<div class='card tr-q'><div class='tr-q-head'><span class='tr-q-num'>*</span><h4>How do you compare with other investors?</h4></div>" +
    "<div class='tr-answer muted'>Coming with opt-in sharing: comparing your research-to-trade habits with other Stocktrails users needs encrypted sync and your consent first. " +
    "Nothing about your trades leaves this device until then.</div></div>";
}

// Investing quotes for the patterns the questions identify. Wording and source
// checked; "attributed" marks lines that are widely credited to the person but
// have no primary source we could confirm.
const TR_QUOTES = {
  disposition: { text: "Pulling out the flowers and watering the weeds.", by: "Peter Lynch, One Up on Wall Street (1989), on selling winners and keeping losers" },
  noResearch: { text: "Investing without research is like playing stud poker and never looking at the cards.", by: "Peter Lynch (attributed)" },
  research: { text: "Know what you own, and know why you own it.", by: "Peter Lynch (attributed)" },
  self: { text: "The investor's chief problem, and even his worst enemy, is likely to be himself.", by: "Benjamin Graham, The Intelligent Investor" },
  fearGreed: { text: "Be fearful when others are greedy and greedy only when others are fearful.", by: "Warren Buffett, 1986 Berkshire Hathaway letter (condensed)" },
  popularity: { text: "In the short run, the market is a voting machine; in the long run, a weighing machine.", by: "credited to Benjamin Graham, popularised by Warren Buffett" },
  tooSoon: { text: "I made my money by selling too soon.", by: "Bernard Baruch (attributed)" }
};

// The patterns the data actually supports, strongest first. A pattern needs at
// least an indicative result; "clear" ones lead.
function trFindings(R) {
  const f = [];
  const add = function (o) { if (o.status && o.status !== "none") f.push(o); };
  const q1 = R.q1, q2 = R.q2, q3 = R.q3, q4 = R.q4, fo = q4.fomo, q7 = R.q7, q10 = R.q10, q11 = R.q11, d = R.disposition;
  if (q1.n) add(q1.researched.p < 0.5
    ? { status: q1.status, clear: q1.researched.hi < 0.5, title: "Many trades without research", text: Math.round((1 - q1.researched.p) * 100) + "% of your decisions had no recorded research in the 30 days before.", quote: TR_QUOTES.noResearch }
    : { status: q1.status, clear: q1.clear, title: "You research before you trade", text: Math.round(q1.researched.p * 100) + "% of your decisions followed research on that stock" + (q1.clear ? ", and it clusters in the week before the trade." : "."), quote: TR_QUOTES.research, good: true });
  if (d.de != null && Math.abs(d.de) > 0.05) add(d.de > 0
    ? { status: d.status, clear: false, title: "You sell winners and keep losers", text: "On days you sold, you realised " + trPct(d.pgr) + " of your gains but only " + trPct(d.plr) + " of your losses.", quote: TR_QUOTES.disposition }
    : { status: d.status, clear: false, title: "You cut losers and let winners run", text: "On days you sold, you realised " + trPct(d.plr) + " of your losses and " + trPct(d.pgr) + " of your gains.", good: true });
  if (fo.buyIfUp.n && fo.buyIfDown.n && fo.buyIfUp.p > fo.buyIfDown.p) add({ status: fo.status, clear: fo.clear, title: "FOMO: you buy after the price confirms your call",
    text: "You bought " + Math.round(fo.buyIfUp.p * 100) + "% of the calls whose stock rose after the call, " + Math.round(fo.buyIfDown.p * 100) + "% of those that fell.", quote: TR_QUOTES.fearGreed });
  if (q4.spikeBuy.n && q4.spikeSell.n && q4.spikeBuy.p > q4.spikeSell.p) add({ status: q4.status, clear: q4.clear, title: "Attention spikes drive your buying",
    text: Math.round(q4.spikeBuy.p * 100) + "% of your buys followed a spike in your attention, against " + Math.round(q4.spikeSell.p * 100) + "% of your sales.", quote: TR_QUOTES.popularity });
  if (q7.n && q7.impulse.p >= 0.2) add({ status: q7.status, clear: q7.clear, title: "Impulse trades",
    text: Math.round(q7.impulse.p * 100) + "% of your timed decisions came within an hour of your first look" + (q7.clear && q7.returns.diff.est < 0 ? ", and they did worse." : "."), quote: TR_QUOTES.self });
  const hs7 = trHours(R);
  const bad = hs7.blocks.filter(function (b) { return b.robust && b.diff.est < 0; })[0];
  if (bad) add({ status: hs7.status, clear: true, title: "A bad time to buy: the " + bad.label.toLowerCase(), text: "Buys placed then did " + (Math.abs(bad.diff.est) * 100).toFixed(1) + " pts worse over the next month than your others.", quote: TR_QUOTES.self });
  if (q10.n && q10.dip) {
    const dm = q10.dip.ret.verdict !== "none" ? q10.dip.ret : q10.dip.dd, sd = q10.size.diff;
    if (dm.verdict !== "none") {
      const dip = dm.verdict === "dip", pc = Math.round((dip ? 1 - dm.mean.est : dm.mean.est) * 100);
      add({ status: q10.status, clear: true, title: dip ? "You buy the dip" : "You chase the market",
        text: dip ? "On your buy days the NASDAQ was weaker than on " + pc + "% of all trading days." : "On your buy days the NASDAQ was stronger than on " + pc + "% of all trading days.",
        quote: TR_QUOTES.fearGreed, good: dip });
    }
    if (sd && sd.p != null && sd.p <= 0.01) add({ status: q10.status, clear: true, title: sd.est > 0 ? "You buy bigger when markets are turbulent" : "You buy smaller when markets are turbulent",
      text: "In turbulent markets you put " + Math.pow(2, sd.est).toFixed(1) + "x as much into a buy as in calm ones.", quote: TR_QUOTES.fearGreed });
  }
  if (q11.n) add(q11.sold.p >= 0.7
    ? { status: q11.status, clear: false, title: "You take profits at your target", text: "You sold within two weeks of reaching your target " + q11.sold.k + " of " + q11.n + " times.", quote: TR_QUOTES.tooSoon, good: true }
    : { status: q11.status, clear: false, title: "Your targets do not trigger sales", text: "You sold within two weeks of reaching your target only " + q11.sold.k + " of " + q11.n + " times.", quote: TR_QUOTES.self });
  if (q2.n && q2.agreement.p < 0.6) add({ status: q2.status, clear: q2.agreement.hi < 0.6, title: "Your trades often go against your calls",
    text: q2.contradictions + " of " + q2.n + " decisions went against your latest Positive or Negative call.", quote: TR_QUOTES.research });
  const ru = q4.runupPerf;
  if (ru.clear && ru.diff.est < 0) add({ status: ru.status, clear: true, title: "Chasing rises costs you",
    text: "Buys made after the price had risen since your first look did " + trPts(ru.diff.est) + " against those made after a fall.", quote: TR_QUOTES.fearGreed });
  if (q3.clear) add({ status: q3.status, clear: true, title: q3.diff.est > 0 ? "Research pays off" : "Researched buys did worse",
    text: "Researched buys did " + trPts(q3.diff.est) + " against unresearched ones over the next month.", good: q3.diff.est > 0 });
  if (self.trIndFindings) trIndFindings(R).forEach(add);
  return f.sort(function (a, b) { return (b.clear ? 1 : 0) - (a.clear ? 1 : 0) || (a.status === "solid" ? -1 : 0) - (b.status === "solid" ? -1 : 0); });
}

function trHighlights(R) {
  const f = trFindings(R);
  const body = f.length ? "<ul class='tr-hl'>" + f.map(function (x) {
    return "<li class='" + (x.good ? "good" : "watch") + "'><div class='tr-hl-head'><b>" + escapeHtml(x.title) + "</b> " + trChip(x.status, x.clear) + "</div>" +
      "<div>" + x.text + "</div>" +
      (x.quote ? "<blockquote class='tr-quote'>&ldquo;" + escapeHtml(x.quote.text) + "&rdquo;<cite>" + escapeHtml(x.quote.by) + "</cite></blockquote>" : "") + "</li>";
  }).join("") + "</ul>"
    : "<div class='tr-answer muted'>No pattern has enough data behind it yet. Findings appear here as soon as a question below reaches its minimum; " +
      "<a href='#' data-act='open-suff'>How much can your data say?</a> shows how far each one is.</div>";
  return "<section class='tr-glance'><h3 class='tr-glance-title'>What your trades say about you</h3>" +
    "<div class='tr-glance-sub muted small'>The patterns your data supports so far, strongest first. Each comes from a question further down.</div>" + body + "</section>";
}


function trQ12(R) {
  const d = R.disposition;
  const body = d.status === "none" ? trNotYet(d.days, d.need.min, "days with a sale", null) +
      (d.days ? trFigs(["So far: you sold " + trPct(d.pgr) + " of the holdings that were up on your cost and " + trPct(d.plr) + " of those that were down"]) : "")
    : "<div class='tr-answer'>On the " + d.days + " days you sold, you sold <b>" + trPct(d.pgr) + "</b> of the holdings that were up on your cost and <b>" + trPct(d.plr) + "</b> of those that were down" +
      (d.de > 0.05 ? ": you sell winners sooner than losers (the disposition effect)." : d.de < -0.05 ? ": you cut losers sooner than winners." : ": no tilt either way.") + "</div>" +
      trFigs(["Gains realised " + d.realizedGains + ", gains kept on paper " + d.paperGains + "; losses realised " + d.realizedLosses + ", losses kept " + d.paperLosses]);
  const sv = R.ind && R.ind.survival;
  const svFig = sv && (sv.winners.n || sv.losers.n) ? trFigs(["Median holding period (Kaplan-Meier, open positions counted until today): winners " + trKm(sv.winners) + ", losers " + trKm(sv.losers) +
    (sv.winners.median != null && sv.losers.median != null && sv.winners.median < 0.5 * sv.losers.median ? ". Winners leave your depot much sooner." : "")]) : "";
  return trCard(12, "Do you sell winners and keep losers?", d.status, false, body + svFig,
    "Odean (1998): on each day with a sale, every holding is either sold or still held, at a gain or a loss against its average cost (costs measured on Yahoo closes). " +
    "The share of gains realised minus the share of losses realised is the disposition effect; above zero, winners leave the portfolio sooner than losers.");
}

function trQ13(R) {
  const h = R.horizon;
  const body = h.n
    ? "<div class='tr-answer'>" + h.n + " buys made under a Positive call with a horizon: <b>" + h.early + "</b> sold before half of it, <b>" + h.on + "</b> around it, <b>" + h.late +
      "</b> held much longer, <b>" + h.open + "</b> still open.</div>"
    : "<div class='tr-answer muted'>No buy followed a Positive call that carried a horizon. Set one in the label widget to measure this.</div>";
  return trCard(13, "Do you hold as long as you planned?", h.status, false, body,
    "For buys made under a Positive call with a time horizon: the time until the position was closed, against the horizon. Early = sold before half the horizon; around = half to one and a half times it; much longer = past that.");
}

function trLinksHtml(links, open) {
  const ticks = trackedTickers().sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
  const order = { check: 0, matched: 1, untracked: 2 };
  links.sort(function (a, b) { return (order[a.status] - order[b.status]) || String(a.name).localeCompare(String(b.name)); });
  const opt = function (t, sel) { return "<option value='" + escapeHtml(t) + "'" + (t === sel ? " selected" : "") + ">" + escapeHtml(nameOf(t)) + " (" + escapeHtml(t) + ")</option>"; };
  const rows = links.map(function (l) {
    // The closest names first, so the right stock is near the top of a long list.
    const close = ticks.map(function (t) { return { t: t, s: NAMES[t] && l.name ? ATLedger.nameSimilarity(l.name, NAMES[t]) : 0 }; })
      .filter(function (x) { return x.s >= 0.5; }).sort(function (a, b) { return b.s - a.s; }).slice(0, 3).map(function (x) { return x.t; });
    const pend = TR.pendingLinks[l.inst] || {};
    const curT = "ticker" in pend ? pend.ticker : l.ticker, curS = "symbol" in pend ? pend.symbol : l.symbol;
    const sel = "<select data-link='" + escapeHtml(l.inst) + "'><option value=''>Not tracked</option>" +
      (curT && ticks.indexOf(curT) < 0 ? "<optgroup label='Set by you'>" + opt(curT, curT) + "</optgroup>" : "") +
      (close.length ? "<optgroup label='Closest names'>" + close.map(function (t) { return opt(t, curT); }).join("") + "</optgroup>" : "") +
      "<optgroup label='All stocks you have viewed'>" + ticks.filter(function (t) { return close.indexOf(t) < 0; }).map(function (t) { return opt(t, curT); }).join("") + "</optgroup></select> <input data-tkr='" + escapeHtml(l.inst) + "' maxlength='15' size='9' placeholder='or type a ticker' aria-label='Type a ticker for this instrument'>";
    const cands = (l.cands || []).map(function (c) { return c.symbol; });
    if (curS && cands.indexOf(curS) < 0) cands.unshift(curS);
    const symSel = "<select data-sym='" + escapeHtml(l.inst) + "'><option value=''>No price</option>" + cands.map(function (c) {
      const info = (l.cands || []).find(function (x) { return x.symbol === c; });
      return "<option value='" + escapeHtml(c) + "'" + (c === curS ? " selected" : "") + ">" + escapeHtml(c + (info && info.exch ? " - " + info.exch : "")) + "</option>";
    }).join("") + "</select>";
    const st = pend.confirm ? "<span class='tr-chip st-solid'>Will confirm</span>"
      : l.status === "check" ? "<span class='tr-chip st-indicative'>Check</span> <button class='navbtn' data-act='confirm-link' data-inst='" + escapeHtml(l.inst) + "'>Looks right</button>"
      : l.status === "matched" ? "<span class='tr-chip st-solid'>Matched</span>" : "<span class='muted small'>-</span>";
    const why = l.manual ? "set by you" : l.method ? "by " + l.method + (l.sim != null ? ", names " + Math.round(l.sim * 100) + "% alike" : "") : "";
    return "<tr data-row='" + escapeHtml(l.inst) + "'" + (TR.pendingLinks[l.inst] ? " class='tr-pending'" : "") + "><td>" + escapeHtml(l.name || "") + "<div class='muted small'>" + escapeHtml(l.isin || l.brokerSymbol || "") + "</div></td><td>" + sel + "</td><td>" + st +
      "<div class='muted small'>" + escapeHtml(why) + "</div></td><td>" + symSel + "</td></tr>";
  }).join("");
  const nCheck = links.filter(function (l) { return l.status === "check" && !(TR.pendingLinks[l.inst] || {}).confirm; }).length;
  return "<details class='card tr-links' id='tr-links'" + (open || TR.linksOpen ? " open" : "") + "><summary><b>Matched stocks</b> <span class='muted small'>which instrument in your file is which stock you track</span></summary>" +
    "<div class='tr-pending-bar'>" + trPendingBarHtml(nCheck) + "</div>" +
    "<div class='muted small'>Change any row if it is wrong. " + trInfo("Matched by ISIN through Yahoo's listings, confirmed by comparing names after removing legal forms and share-class words " +
    "(\"NVIDIA Corp.\" = \"NVIDIA Corporation\"). A ticker alone is never trusted: BA is Boeing in New York and BA.L is BAE Systems in London.", "How stocks are matched") +
    " Missing a stock? " + trInfo("The list holds only stocks Stocktrails has seen you research, because research can only be linked to a stock with recorded views. " +
    "An instrument you never looked at stays \"Not tracked\" and counts as unresearched, but it can still get a price symbol on the right, so its returns and your portfolio line include it.", "Why a stock is missing") + "</div>" +
    "<div class='tr-sample'><table class='adm'><thead><tr><th>In your file</th><th>Tracked stock</th><th>Match</th><th>Price symbol</th></tr></thead><tbody>" + rows + "</tbody></table></div></details>";
}

function trManageHtml() {
  const rows = TR.imports.map(function (im) {
    return "<tr><td>" + trDate(im.at) + "</td><td>" + escapeHtml(im.label || "") + "</td><td class='muted small'>" + escapeHtml(im.fileName || "") + "</td><td>" + escapeHtml((im.from || "") + " to " + (im.to || "")) +
      "</td><td>" + im.added + (im.duplicates ? " <span class='muted small'>(+" + im.duplicates + " already there)</span>" : "") + "</td><td><button class='navbtn' data-act='remove-import' data-id='" + escapeHtml(im.id) + "'>Remove</button></td></tr>";
  }).join("");
  const dv = TR.report ? TR.report.dividends : null;
  const divLine = dv && dv.count ? "<div class='muted small'>Dividends: " + dv.count + (dv.count === 1 ? " payment" : " payments") + " from " + dv.instruments + (dv.instruments === 1 ? " holding, " : " holdings, ") +
    Object.keys(dv.byCurrency).map(function (c) { const x = dv.byCurrency[c]; return trMoney(x.gross, c) + " (" + trMoney(x.tax, c) + " withheld)"; }).join(", ") +
    ". They count in the holdings line of card E2.</div>" : "";
  return "<details class='card tr-manage'><summary><b>Your imported data</b></summary>" + divLine +
    "<div class='tr-sample'><table class='adm'><thead><tr><th>Imported</th><th>Broker</th><th>File</th><th>Period</th><th>Records</th><th></th></tr></thead><tbody>" + rows + "</tbody></table></div>" +
    trPrivacyHtml() + "<div class='tr-btns'><button class='danger' data-act='delete-all'>Delete all imported trades</button></div></details>";
}

function trDrawCharts(R, only) {
  const pf = document.getElementById("tr-pf"), q9 = R.q9;
  if (pf && q9.dates) {
    // At most ~150 points: one per n trading days, always ending on the last.
    const step = Math.max(1, Math.ceil(q9.dates.length / 150)), ix = [];
    for (let i = 0; i < q9.dates.length; i += step) ix.push(i);
    if (ix[ix.length - 1] !== q9.dates.length - 1) ix.push(q9.dates.length - 1);
    const lab = ix.map(function (i, j) { return j % Math.ceil(ix.length / 6) === 0 ? q9.dates[i].slice(2, 7) : ""; });
    drawLineCanvas(pf, "tr-pf-tip", [
      { label: "Your holdings", color: "#3ddc97", vals: ix.map(function (i) { return q9.portfolio[i]; }) },
      { label: "Recent attention (" + TR.winDays + " d)", color: "#4e9eff", vals: ix.map(function (i) { return q9.attention[i]; }) },
      { label: "All attention so far", color: "#a29bfe", vals: ix.map(function (i) { return q9.attentionAll[i]; }) },
      { label: "NASDAQ", color: "#8a93a6", vals: ix.map(function (i) { return q9.bench[i]; }) }
    ], lab, ix.map(function (i) { return q9.dates[i]; }));
    attachCanvasHover(pf);
  }
  if (only === "q9") return;
  const hc = document.getElementById("tr-hours"), hs = trHours(R);
  if (hc) {
    const tv = hs.viewsByHour.reduce(function (a, b) { return a + b; }, 0) || 1, tb = hs.buysByHour.reduce(function (a, b) { return a + b; }, 0) || 1;
    const hrs = hs.viewsByHour.map(function (_, h) { return h; });
    drawLineCanvas(hc, "tr-hours-tip", [
      { label: "Your views (%)", color: "#4e9eff", vals: hs.viewsByHour.map(function (v) { return Math.round(v / tv * 1000) / 10; }) },
      { label: "Your buys (%)", color: "#3ddc97", vals: hs.buysByHour.map(function (v) { return Math.round(v / tb * 1000) / 10; }) }
    ], hrs.map(function (h) { return h % 3 === 0 ? h + "h" : ""; }), hrs.map(function (h) { return h + ":00-" + (h + 1) + ":00"; }));
    // Dashed lines where one part of the day ends and the next begins.
    const c = hc.getContext("2d"), W = hc.clientWidth, H = hc.clientHeight, padL = 36, padR = 10, padT = 10, padB = 20, pw = W - padL - padR;
    c.save(); c.strokeStyle = TC().ink(0.4); c.fillStyle = TC().muted; c.lineWidth = 1; c.setLineDash([4, 4]); c.font = "10px sans-serif";
    hs.blocks.forEach(function (b) {
      if (b.from === 0) return;
      const x = padL + (b.from - 0.5) / 23 * pw;
      c.beginPath(); c.moveTo(x, padT); c.lineTo(x, H - padB); c.stroke();
    });
    c.setLineDash([]);
    hs.blocks.forEach(function (b) {
      const span = b.to > b.from ? [[b.from, b.to]] : [[b.from, 24], [0, b.to]];
      let best = span[0];
      span.forEach(function (sp) { if (sp[1] - sp[0] > best[1] - best[0]) best = sp; });
      c.textAlign = "center"; c.fillText(b.label.split(" (")[0], padL + ((best[0] + best[1]) / 2 - 0.5) / 23 * pw, padT + 9);
    });
    c.restore();
    canvasHover[hc.id].base = c.getImageData(0, 0, hc.width, hc.height);
    attachCanvasHover(hc);
  }
  const s5 = document.getElementById("tr-q5-paths"), q5 = R.q5;
  if (s5 && q5.paths && q5.paths.days.length) {
    const ser = [];
    if (q5.passed.n >= 3 && q5.paths.passed) ser.push({ label: "Passed on", color: "#f1c40f", mean: q5.paths.passed.mean, lo: q5.paths.passed.lo, hi: q5.paths.passed.hi });
    if (q5.bought.n >= 3 && q5.paths.bought) ser.push({ label: "Bought", color: "#3ddc97", mean: q5.paths.bought.mean, lo: q5.paths.bought.lo, hi: q5.paths.bought.hi });
    if (ser.length) {
      trPathChart(s5, "tr-q5-tip", ser, function (k) {
        return "<b>" + (k === 0 ? "Call or trade day" : "Day " + k + " after") + "</b>" + ser.map(function (sr) {
          return "<br><span style='color:" + sr.color + "'>&#9632;</span> " + sr.label + " " + trPct(sr.mean[k], true) + " (" + trPct(sr.lo[k], true) + " to " + trPct(sr.hi[k], true) + ")";
        }).join("");
      });
      attachCanvasHover(s5);
    }
  }
  const s10 = document.getElementById("tr-q10-size"), q10 = R.q10;
  if (s10 && q10.regimes) {
    trStripPlot(s10, "tr-q10-size-tip", q10.regimes.map(function (r) {
      return { label: r.label, sub: r.n + " buys (" + Math.round(r.share.p * 100) + "%) vs " + Math.round(r.baseShare * 100) + "% of days", q1: r.q1, median: r.median, q3: r.q3,
        points: r.points.map(function (p) {
          return { v: p.v, title: "<b>" + escapeHtml(p.ticker ? nameOf(p.ticker) : p.name || "Buy") + "</b> " + escapeHtml(p.date) + "<br>" + p.v.toFixed(2) + "x your usual buy<br>NASDAQ volatility " + Math.round(p.vol * 100) + "% a year" };
        }) };
    }));
    attachCanvasHover(s10);
  }
  const cv = document.getElementById("tr-profile");
  if (!cv || !R.q1.profile) return;
  const p = R.q1.profile;
  const labels = p.offsets.map(function (o) { return o % 10 === 0 ? String(o) : ""; });
  const titles = p.offsets.map(function (o) { return o === 0 ? "Trade day" : o < 0 ? -o + " day" + (o === -1 ? "" : "s") + " before" : o + " day" + (o === 1 ? "" : "s") + " after"; });
  const series = [{ label: "Your views / day", color: "#4e9eff", vals: p.avg }];
  if (p.baseline != null) series.push({ label: "Usual level", color: "#8a93a6", vals: p.offsets.map(function () { return p.baseline; }) });
  drawLineCanvas(cv, "tr-profile-tip", series, labels, titles);
  attachCanvasHover(cv);
}

// ---------- actions ----------

async function trHandleFile(file) {
  TR.msg = ""; TR.pending = null; TR.mapper = null;
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) { TR.msg = "That file is larger than 25 MB. Export a shorter period."; return trRerenderImport(); }
  let text;
  try { text = await file.text(); } catch (e) { TR.msg = "Could not read the file."; return trRerenderImport(); }
  const sn = ATLedger.sniff(text);
  if (!sn.format) {
    if (/Account statement/.test(sn.reason || "")) { TR.msg = escapeHtml(sn.reason) + "."; return trRerenderImport(); }
    const pv = ATLedger.previewColumns(text);
    if (pv.header.length < 3) { TR.msg = "This does not look like a CSV with columns. Check the export format."; return trRerenderImport(); }
    TR.mapper = { text: text, fileName: file.name, reason: sn.reason, header: pv.header, sample: pv.sample, headerRow: pv.headerRow, delimiter: pv.delimiter,
      mapping: ATLedger.guessMapping(pv.header), dateOrder: "dmy", decimal: "" };
    return trRerenderImport();
  }
  try { TR.pending = { result: ATLedger.parseFile(text), fileName: file.name }; }
  catch (e) { TR.msg = escapeHtml(e && e.message || e); }
  trRerenderImport();
}

function trRerenderImport() {
  const root = document.getElementById("trades-root");
  if (root) root.innerHTML = trImportHtml(!TR.txs.length) + (!TR.txs.length && TR.previewHtml ? TR.previewHtml : "");
}

async function trConfirmImport() {
  const p = TR.pending;
  if (!p) return;
  const owner = await tradesOwner();
  const id = "imp" + Date.now().toString(36);
  const r = await ATLedgerDB.addTxs(owner, p.result.txs, id);
  await ATLedgerDB.addImport(owner, { id: id, at: Date.now(), label: p.result.label, fileName: p.fileName, from: p.result.from, to: p.result.to,
    added: r.added, duplicates: r.duplicates, counts: p.result.counts });
  TR.pending = null; TR.mapper = null; TR.importing = false; TR.reportKey = null;
  TR.msg = "Imported " + r.added + " new records" + (r.duplicates ? " (" + r.duplicates + " were already there)" : "") + ".";
  try { ATStore.trackFeatureUse("trades_import"); } catch (e) { /* usage tracking: the event name only */ }
  await renderTrades();
}

// Matching edits are collected first and applied together: every applied
// change re-runs the whole analysis, which is slow to sit through per row.
function trPendingBarHtml(nCheck) {
  const n = Object.keys(TR.pendingLinks).length;
  return (n ? "<b>" + n + " change" + (n > 1 ? "s" : "") + " not applied yet.</b> <button class='tr-primary' data-act='apply-links'>Apply and recalculate</button> <button data-act='discard-links'>Discard</button> " : "") +
    (nCheck ? "<button data-act='confirm-all-checks'>Mark all " + nCheck + " to check as right</button>" : "");
}

function trRefreshPending() {
  const root = document.getElementById("trades-root");
  const links = Object.keys(TR.links).map(function (k) { return TR.links[k]; });
  const nCheck = links.filter(function (l) { return l.status === "check" && !(TR.pendingLinks[l.inst] || {}).confirm; }).length;
  root.querySelectorAll(".tr-pending-bar").forEach(function (b) { b.innerHTML = trPendingBarHtml(nCheck); });
  root.querySelectorAll("tr[data-row]").forEach(function (tr) { tr.classList.toggle("tr-pending", !!TR.pendingLinks[tr.getAttribute("data-row")]); });
}

function trQueue(inst, patch) {
  TR.pendingLinks[inst] = Object.assign(TR.pendingLinks[inst] || {}, patch);
  TR.linksOpen = true;
}

async function trApplyLinks() {
  const changed = [];
  Object.keys(TR.pendingLinks).forEach(function (inst) {
    const l = TR.links[inst], p = TR.pendingLinks[inst];
    if (!l) return;
    if ("ticker" in p) { l.ticker = p.ticker || null; l.status = p.ticker ? "matched" : "untracked"; l.method = null; if (p.ticker && !("symbol" in p)) l.symbol = tickerSymbol(p.ticker); }
    if ("symbol" in p) l.symbol = p.symbol || null;
    if (p.confirm && l.status === "check") l.status = "matched";
    l.manual = true;
    changed.push(l);
  });
  TR.pendingLinks = {};
  if (!changed.length) return;
  await ATLedgerDB.putLinks(TR.owner, changed);
  TR.reportKey = null;
  TR.msg = "Applied " + changed.length + " matching change" + (changed.length > 1 ? "s" : "") + ".";
  await renderTrades();
}

(function () {
  const root = document.getElementById("trades-root");
  if (!root) return;
  root.addEventListener("click", async function (ev) {
    const tog = ev.target.closest("[data-tog] button[data-val]");
    if (tog) {
      const name = tog.parentNode.getAttribute("data-tog"), val = tog.getAttribute("data-val");
      if (name === "hours") {
        // First time on "Define my own": start from the parts being shown, so the
        // user edits something real instead of an empty box.
        if (val === "custom" && TR.customParts.length < 2 && TR.report) {
          TR.customParts = trHours(TR.report).blocks.map(function (b) { return b.from; }).sort(function (a, b) { return a - b; });
          try { localStorage.setItem("at_tr_custom", JSON.stringify(TR.customParts)); } catch (e) { /* ignore */ }
          TR.reportKey = null;
        }
        TR.hourMode = val; TR.partsMsg = "";
        try { localStorage.setItem("at_tr_hours", val); } catch (e) { /* ignore */ }
      }
      else if (name === "conv") { TR.convMode = val; try { localStorage.setItem("at_tr_conv", val); } catch (e) { /* ignore */ } }
      else if (name === "dip") { TR.dipMode = val; try { localStorage.setItem("at_tr_dip", val); } catch (e) { /* ignore */ } }
      await renderTrades();
      return;
    }
    const el = ev.target.closest("[data-act]");
    if (!el || el.tagName === "SELECT" || el.tagName === "INPUT") return;
    const act = el.getAttribute("data-act");
    if (act === "drop") return; // the label opens the file input itself
    ev.preventDefault();
    if (act === "confirm") await trConfirmImport();
    else if (act === "cancel") { TR.pending = null; TR.mapper = null; TR.msg = ""; trRerenderImport(); }
    else if (act === "open-import") { TR.msg = ""; root.innerHTML = trImportHtml(false); }
    else if (act === "close-import") { TR.pending = null; TR.mapper = null; TR.msg = ""; await renderTrades(); }
    else if (act === "apply-parts") {
      const box = el.closest(".tr-parts-edit").querySelector(".tr-parts-in");
      const parts = String(box.value).split(/[,;\s]+/).filter(Boolean).map(Number);
      const ok = parts.length >= 2 && parts.every(function (h) { return Number.isInteger(h) && h >= 0 && h <= 23; });
      const uniq = Array.from(new Set(parts)).sort(function (a, b) { return a - b; });
      if (!ok || uniq.length < 2) {
        TR.partsMsg = "Enter at least two different whole hours from 0 to 23, for example 6, 11, 15, 19, 22.";
        await renderTrades();
        return;
      }
      TR.customParts = uniq; TR.partsMsg = ""; TR.reportKey = null;
      try { localStorage.setItem("at_tr_custom", JSON.stringify(uniq)); } catch (e) { /* ignore */ }
      await renderTrades();
    }
    else if (act === "open-predictions") { if (self.showMain) showMain("predictions"); }
    else if (act === "open-home-country") {
      showMain("settings"); showSub("settings", "data");
      const sel = document.getElementById("home-country");
      if (sel) { sel.scrollIntoView({ block: "center" }); sel.focus(); }
    }
    else if (act === "open-suff") { const d = root.querySelector(".tr-suff"); if (d) { d.open = true; d.scrollIntoView({ block: "start" }); } }
    else if (act === "open-history") {
      showMain("settings"); showSub("settings", "data");
      const b = document.getElementById("history-import");
      if (b) b.scrollIntoView({ block: "center" });
    }
    else if (act === "show-links") { const d = document.getElementById("tr-links"); if (d) { d.open = true; d.scrollIntoView({ block: "start" }); } }
    else if (act === "confirm-link") { trQueue(el.getAttribute("data-inst"), { confirm: true }); const td = el.parentNode; td.querySelector(".tr-chip").textContent = "Will confirm"; td.querySelector(".tr-chip").className = "tr-chip st-solid"; el.remove(); trRefreshPending(); }
    else if (act === "confirm-all-checks") {
      Object.keys(TR.links).forEach(function (k) { if (TR.links[k].status === "check") trQueue(k, { confirm: true }); });
      root.querySelectorAll("[data-act='confirm-link']").forEach(function (b) { const c = b.parentNode.querySelector(".tr-chip"); c.textContent = "Will confirm"; c.className = "tr-chip st-solid"; b.remove(); });
      trRefreshPending();
    }
    else if (act === "apply-links") await trApplyLinks();
    else if (act === "discard-links") { TR.pendingLinks = {}; TR.linksOpen = true; await renderTrades(); }
    else if (act === "map-preview") {
      const m = TR.mapper, map = {};
      Object.keys(m.mapping).forEach(function (k) { if (m.mapping[k] >= 0) map[k] = m.mapping[k]; });
      const missing = ATLedger.GENERIC_REQUIRED.filter(function (f) { return map[f] == null; });
      if (missing.length || (map.isin == null && map.symbol == null)) { TR.msg = "Pick a column for: " + missing.concat(map.isin == null && map.symbol == null ? ["ISIN or ticker"] : []).join(", ") + "."; return trRerenderImport(); }
      try {
        TR.pending = { result: ATLedger.parseFile(m.text, { mapping: map, headerRow: m.headerRow, delimiter: m.delimiter, dateOrder: m.dateOrder, decimal: m.decimal || undefined }), fileName: m.fileName };
        TR.mapper = null; TR.msg = "";
      } catch (e) { TR.msg = escapeHtml(e && e.message || e); }
      trRerenderImport();
    } else if (act === "remove-import") {
      if (!confirm("Remove this import and the records it added?")) return;
      await ATLedgerDB.removeImport(TR.owner, el.getAttribute("data-id"));
      TR.reportKey = null; TR.msg = "Import removed.";
      await renderTrades();
    } else if (act === "delete-all") {
      if (!confirm("Delete all imported trades, dividends and stock matches from this browser? Your attention data is not affected.")) return;
      await ATLedgerDB.clearOwner(TR.owner);
      TR.report = null; TR.reportKey = null; TR.prices = {}; TR.stale = {}; TR.msg = "All imported trade data was deleted from this browser.";
      if (self.ATPriceCache) ATPriceCache.clear().catch(function () { /* nothing stored */ });
      await renderTrades();
    }
  });
  // Question groups remember being opened or closed (toggle does not bubble).
  root.addEventListener("toggle", function (ev) {
    const g = ev.target && ev.target.matches && ev.target.matches("details.tr-group") ? ev.target : null;
    if (g) trGroupRemember(g.getAttribute("data-group"), g.open);
  }, true);
  root.addEventListener("change", async function (ev) {
    const el = ev.target;
    if (el.matches("input[type=file][data-act=file]")) { await trHandleFile(el.files[0]); el.value = ""; }
    else if (el.matches("select[data-act=broker]")) { TR.broker = el.value; trRerenderImport(); }
    else if (el.matches("select[data-map]")) { TR.mapper.mapping[el.getAttribute("data-map")] = +el.value; }
    else if (el.matches("select[data-mapopt]")) { TR.mapper[el.getAttribute("data-mapopt")] = el.value; }
    else if (el.matches("input[data-tkr]")) {
      // a ticker typed by hand (also for a stock never viewed): its price symbol is the ticker unless one was picked
      const inst = el.getAttribute("data-tkr"), t = el.value.trim().toUpperCase();
      if (!t) return;
      if (!/^[A-Z0-9.\-^=]{1,15}$/.test(t)) { el.value = ""; return; }
      const patch = { ticker: t }, tr = el.closest("tr"), s1 = tr.querySelector("select[data-link]"), ss = tr.querySelector("select[data-sym]");
      if (!("symbol" in (TR.pendingLinks[inst] || {}))) patch.symbol = tickerSymbol(t);
      const pick = function (sel, v) { if (!sel || !v) return; if (!Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) { const o = document.createElement("option"); o.value = o.textContent = v; sel.appendChild(o); } sel.value = v; };
      pick(s1, t); pick(ss, patch.symbol);
      el.value = "";
      trQueue(inst, patch); trRefreshPending();
    }
    else if (el.matches("select[data-link]")) {
      const inst = el.getAttribute("data-link"), t = el.value || null, l = TR.links[inst];
      const patch = { ticker: t };
      // A newly chosen stock brings its own price symbol unless one was picked by hand.
      if (t && !("symbol" in (TR.pendingLinks[inst] || {}))) {
        patch.symbol = tickerSymbol(t);
        const ss = el.closest("tr").querySelector("select[data-sym]");
        if (ss && !Array.prototype.some.call(ss.options, function (o) { return o.value === patch.symbol; })) { const o = document.createElement("option"); o.value = o.textContent = patch.symbol; ss.appendChild(o); }
        if (ss) ss.value = patch.symbol;
      }
      if (l && (t || null) === (l.ticker || null)) delete patch.ticker;
      trQueue(inst, patch); trRefreshPending();
    }
    else if (el.matches("select[data-win]")) { TR.winDays = +el.value || 30; try { localStorage.setItem("at_tr_win", String(TR.winDays)); } catch (e) { /* ignore */ } trRefreshQ9(); }
    else if (el.matches("select[data-lag]")) { TR.lagDays = +el.value || 0; try { localStorage.setItem("at_tr_lag", String(TR.lagDays)); } catch (e) { /* ignore */ } trRefreshQ9(); }
    else if (el.matches("select[data-sym]")) { trQueue(el.getAttribute("data-sym"), { symbol: el.value || null }); trRefreshPending(); }
  });
  root.addEventListener("dragover", function (ev) { const z = ev.target.closest(".tr-drop"); if (z) { ev.preventDefault(); z.classList.add("over"); } });
  root.addEventListener("dragleave", function (ev) { const z = ev.target.closest(".tr-drop"); if (z) z.classList.remove("over"); });
  root.addEventListener("drop", async function (ev) {
    const z = ev.target.closest(".tr-drop");
    if (!z) return;
    ev.preventDefault(); z.classList.remove("over");
    await trHandleFile(ev.dataTransfer && ev.dataTransfer.files[0]);
  });
})();

// (i) markers: a tap opens or closes one (touch has no hover) without toggling a
// <details> it sits in; a tap elsewhere or Escape closes it.
document.addEventListener("click", function (ev) {
  const i = ev.target.closest && ev.target.closest(".tr-info");
  document.querySelectorAll(".tr-info.open").forEach(function (x) { if (x !== i) x.classList.remove("open"); });
  if (!i || ev.target.closest(".tr-info-pop")) return;
  ev.preventDefault();
  i.classList.toggle("open");
}, true);
document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") document.querySelectorAll(".tr-info.open").forEach(function (x) { x.classList.remove("open"); x.blur(); }); });
// open towards the side with room: a marker near the right edge opens to the left
function trInfoSide(ev) {
  const i = ev.target.closest && ev.target.closest(".tr-info");
  if (i) i.classList.toggle("left", i.getBoundingClientRect().left + 350 > window.innerWidth);
}
document.addEventListener("mouseover", trInfoSide);
document.addEventListener("focusin", trInfoSide);
document.addEventListener("pointerdown", trInfoSide, true);

// The active reminders by stock, copied into extension storage so the in-page widget can show
// them when the stock is viewed. They stay on this device, like the ledger they come from.
async function trRemindersSync() {
  try {
    if (!self.ATLedgerDB || !(self.chrome && chrome.storage && chrome.storage.local)) return;
    TR.commitments = await ATLedgerDB.getCommitments(await tradesOwner());
    trRemindersMirror();
  } catch (e) { /* ledger not available yet */ }
}
document.addEventListener("at-data", function () { trRemindersSync(); });
function trRemindersMirror() {
  try {
    if (!self.chrome || !chrome.storage || !chrome.storage.local) return;
    const m = {};
    (TR.commitments || []).forEach(function (c) {
      if (c.kind === "reminder" && c.status === "active" && c.ticker) (m[String(c.ticker).toUpperCase()] = m[String(c.ticker).toUpperCase()] || []).push({ text: c.text, at: c.adoptedAt });
    });
    chrome.storage.local.set({ at_reminders: m });
  } catch (e) { /* not in the extension */ }
}

// What the report is built from; a different key means new data.
function trReportKey() {
  return [TR.txs.length, JSON.stringify(Object.keys(TR.links).map(function (k) { const l = TR.links[k]; return k + l.ticker + l.status + l.symbol; })),
    (DATA.intraday || []).length, (DATA.events || []).length, JSON.stringify(TR.customParts), TR.priceRev || 0].join("|");
}

// New attention or calls flow in while the page is open: the extension writes them to storage
// (chrome.storage.onChanged), a sync or an import calls load() (which fires "at-data"). Either
// signal re-reads the data and, when the pane is showing and the data really changed, builds the
// report anew so the paper portfolios and the AI agent's latest decisions follow (only those two
// parts are redrawn, not the page; the whole page is built when they are not on screen). No timer.
// Not while the user is typing in the pane.
(function () {
  let timer = null, busy = false;
  async function check(fresh) {
    if (busy || document.hidden || typeof DATA === "undefined" || !DATA || !self.ATLedgerDB) return;
    const root = document.getElementById("trades-root"), pane = root && root.closest("[data-pane]");
    if (!root || (pane && pane.hidden) || TR.busy) return;
    const ae = document.activeElement;
    if (ae && root.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    busy = true;
    try {
      const d = fresh || (self.ATStore ? await ATStore.getAll() : null);
      if (!d || ((d.intraday || []).length === (DATA.intraday || []).length && (d.events || []).length === (DATA.events || []).length)) return;
      DATA.intraday = d.intraday; DATA.events = d.events;
      if (TR.reportKey !== null) {
        // only the AI agent's Latest decisions and Paper portfolios follow the new data; the rest of the page is not redrawn
        let part = false;
        try { part = !!(self.trAgentNewData && await trAgentNewData()); } catch (e) { part = false; }
        if (!part) await renderTrades();
      }
    } catch (e) { /* the next signal tries again */ } finally { busy = false; }
  }
  let last = null;
  const soon = function (fresh) { last = fresh || last; clearTimeout(timer); timer = setTimeout(function () { const f = last; last = null; check(f); }, 2000); };
  try { if (self.chrome && chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(function (ch, area) { if (area === "local" && ch.attention_v1) soon(ch.attention_v1.newValue); }); } catch (e) { /* not the extension */ }
  document.addEventListener("at-data", function () { soon(); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) soon(); });
})();
