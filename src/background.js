// Groups touching this file: GROUP 1 (1c market-cap/sector/industry capture,
// 1d 52-week position, 1f portal path passthrough, dwell now carries
// scroll/focus). All writes are additive/best-effort.
importScripts("config.js", "portals.js", "prices.js", "store.js", "pricedb.js", "sync.js", "agentsession.js");
// #5: enable direct Supabase cloud sync from the service worker. Best-effort: if
// the bundle cannot load in a worker, the SW silently falls back to the token
// server (the dashboard still handles cloud sync). Auth session is shared with
// the dashboard via IndexedDB (see cloud.js persistSession/restoreSession).
try { importScripts("../vendor/supabase.min.js", "cloud.js"); } catch (e) { /* cloud sync unavailable in SW */ }

function triggerSync() { if (self.ATSync) self.ATSync.syncNow(); }

// Required sign-in: capture only runs when a cloud session exists (the dashboard
// sets at_cloud_signed_in when it shares one). No attention data is collected before sign-in.
// If cloud is not configured (local-only fallback), there is no requirement.
// The flag survives a refresh-token death, so its presence alone is not
// proof the account still works. Capture stops as soon as a sync reports the
// session expired (ATCloud.markAuthExpired) and stays stopped until re-auth.
async function signedIn() {
  if (!(self.ATCloud && self.ATCloud.enabled && self.ATCloud.enabled())) return true;
  try {
    const r = await chrome.storage.local.get("at_cloud_signed_in");
    if (!(r && r.at_cloud_signed_in)) return false;
    const cfg = await self.ATStore.getSyncConfig();
    return !cfg.authExpired;
  } catch (e) { return false; }
}

// GROUP F-PREREQ B: session id = consecutive intraday events with <30 min gaps.
// Persisted in chrome.storage so it survives service-worker restarts.
const SESSION_KEY = "attention_session_v1";
const SESSION_GAP_MS = 30 * 60000;
async function currentSession(ts) {
  try {
    const r = await chrome.storage.local.get(SESSION_KEY);
    const s = r[SESSION_KEY] || {};
    let id = s.id;
    if (!id || !s.lastTs || (ts - s.lastTs) > SESSION_GAP_MS) {
      id = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : null;
    }
    await chrome.storage.local.set({ [SESSION_KEY]: { id: id, lastTs: ts } });
    return id; // null -> DB DEFAULT gen_random_uuid() assigns one
  } catch (e) { return null; }
}

const HOURLY = "1h";

function symbolFor(data, ticker) {
  return (data.overrides && data.overrides[ticker]) || self.ATPrices.toSymbol(ticker);
}

// Backfill the hourly archive the first time a stock is seen (no-op afterwards).
async function ensureArchive(ticker) {
  try {
    const data = await self.ATStore.getAll();
    const sym = symbolFor(data, ticker);
    const last = await self.ATPriceDB.lastTs(sym, HOURLY);
    if (!last) await self.ATPriceDB.backfill(sym, HOURLY);
  } catch (e) { /* archiving is best-effort */ }
}

// Daily: append new hourly bars for every tracked symbol so the archive stays
// current and the trailing window never lapses past Yahoo's 730-day limit.
async function updateArchives() {
  try {
    const data = await self.ATStore.getAll();
    const tickers = {};
    data.events.forEach(function (e) { tickers[e.ticker] = 1; });
    (data.intraday || []).forEach(function (e) { tickers[e.ticker] = 1; });
    const syms = { "^IXIC": 1 }; // also keep the NASDAQ benchmark archived hourly
    Object.keys(tickers).forEach(function (t) { syms[symbolFor(data, t)] = 1; });
    for (const sym of Object.keys(syms)) {
      try { await self.ATPriceDB.appendSince(sym, HOURLY); } catch (e) { /* skip one */ }
    }
  } catch (e) { /* best-effort */ }
}

chrome.alarms.create("priceUpdate", { periodInMinutes: 1440 });
chrome.alarms.create("sync", { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === "priceUpdate") updateArchives();
  else if (a.name === "sync") triggerSync();
  else if (a.name.indexOf("agent|") === 0) agentMaybeRun();
  else if (a.name === "agentClose") agentClose();
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === "attention") {
    signedIn().then(function (ok) {
      if (!ok) { sendResponse({ signedIn: false }); return; } // gated: no capture
      // answered as soon as the view is stored: the widget must not wait for the price quote that follows
      let sent = false;
      const reply = function (r) { if (!sent) { sent = true; sendResponse(r); } };
      handleAttention(msg, reply).then(reply).catch(function () { reply(null); });
      agentTouch(msg.ticker, "view", { page: msg.portalPath || msg.url });
    });
    return true; // async response
  }
  if (msg && msg.type === "label") {
    signedIn().then(function (ok) {
      if (!ok) { sendResponse({ signedIn: false }); return; }
      handleLabel(msg).then(sendResponse).catch(function () { sendResponse(null); });
    });
    return true;
  }
  if (msg && msg.type === "dwell") {
    signedIn().then(function (ok) {
      if (!ok) { sendResponse(false); return; }
      agentTouch(msg.ticker, "dwell", { ms: msg.ms });
      self.ATStore.addDwell(msg.ticker, msg.ms, { scrollDepth: msg.scrollDepth, focusSwitches: msg.focusSwitches }).then(function () { triggerSync(); sendResponse(true); }).catch(function () { sendResponse(null); });
    });
    return true;
  }
  if (msg && (msg.type === "offscreenStorage" || msg.type === "agentDue" || msg.type === "agentDone" || msg.type === "agentClose" || msg.type === "agentProgress")) {
    if (!fromHeadless(sender)) return false;
    agentMessage(msg).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
    return true;
  }
  if (msg && msg.type === "syncPortals") {
    syncCustomScripts().then(function () { sendResponse(true); }).catch(function () { sendResponse(false); });
    return true;
  }
  // GROUP 5a/5b: optional user-set fields from the popup.
  if (msg && msg.type === "position") {
    signedIn().then(function (ok) {
      if (!ok) { sendResponse(false); return; }
      self.ATStore.setPositionTaken(msg.ticker, msg.value).then(function () { triggerSync(); sendResponse(true); }).catch(function () { sendResponse(null); });
    });
    return true;
  }
  if (msg && msg.type === "target") {
    signedIn().then(function (ok) {
      if (!ok) { sendResponse(false); return; }
      self.ATStore.setTargetPrice(msg.ticker, msg.value).then(function () { triggerSync(); sendResponse(true); }).catch(function () { sendResponse(null); });
    });
    return true;
  }
  if (msg && msg.type === "rationale") {
    signedIn().then(function (ok) {
      if (!ok) { sendResponse(false); return; }
      self.ATStore.setRationale(msg.ticker, msg.value).then(function () { triggerSync(); sendResponse(true); }).catch(function () { sendResponse(null); });
    });
    return true;
  }
  // GROUP 5c: optional prediction horizon (days to reach the target).
  if (msg && msg.type === "horizon") {
    signedIn().then(function (ok) {
      if (!ok) { sendResponse(false); return; }
      self.ATStore.setHorizon(msg.ticker, msg.value).then(function () { triggerSync(); sendResponse(true); }).catch(function () { sendResponse(null); });
    });
    return true;
  }
  return false;
});

// Register/refresh dynamic content scripts for user-added portals whose host
// permission has been granted.
async function syncCustomScripts() {
  const data = await self.ATStore.getAll();
  const custom = data.customPortals || [];

  let existing = [];
  try { existing = await chrome.scripting.getRegisteredContentScripts(); } catch (e) { existing = []; }
  const ours = existing.filter(function (s) { return s.id.indexOf("cp_") === 0; }).map(function (s) { return s.id; });
  if (ours.length) {
    try { await chrome.scripting.unregisterContentScripts({ ids: ours }); } catch (e) { /* ignore */ }
  }

  const toRegister = [];
  for (let i = 0; i < custom.length; i++) {
    const p = self.ATPortals.parsePattern(custom[i].pattern);
    if (!p) continue;
    const origin = "https://" + p.host + "/*";
    let has = false;
    try { has = await chrome.permissions.contains({ origins: [origin] }); } catch (e) { has = false; }
    if (!has) continue;
    toRegister.push({
      id: "cp_" + i,
      matches: [origin],
      js: ["src/portals.js", "src/content.js"],
      runAt: "document_idle"
    });
  }
  if (toRegister.length) {
    try { await chrome.scripting.registerContentScripts(toRegister); } catch (e) { /* ignore */ }
  }
}

async function handleAttention(msg, respond) {
  const ts = Date.now();
  // GROUP 1f: portalPath flows through to the intraday row only (addEvent ignores it).
  // GROUP B1: classify the US/Eastern trading session at capture time.
  // GROUP F-PREREQ B: attach the rolling session id.
  const sessionId = await currentSession(ts);
  const ev = { ticker: msg.ticker, source: msg.source, url: msg.url, ts: ts, portalPath: msg.portalPath || null, section: msg.section || null, researchType: msg.researchType || null, marketSession: self.ATStore.classifyMarketHours(ts), sessionId: sessionId };
  const res = await self.ATStore.addEvent(ev);       // daily (deduped)
  const ires = await self.ATStore.addIntraday(ev);   // intraday (every view)
  if (respond) respond(res); // the pop-up shows now; the price, badge and sync below carry on after it
  if (res.added || ires.added) {
    let priceOk = false;
    try {
      const q = await self.ATPrices.fetchQuote(msg.ticker);
      if (q && !isNaN(q.close)) {
        priceOk = true;
        if (res.added) await self.ATStore.setPrice(res.event.id, q.close);
        if (ires.added) await self.ATStore.setIntradayPrice(ires.event.id, q.close);
        // GROUP 1d: 52-week relative position of the entry price.
        if (q.low52w != null && q.high52w != null && q.high52w > q.low52w) {
          const pos = Math.max(0, Math.min(1, (q.close - q.low52w) / (q.high52w - q.low52w)));
          if (res.added) await self.ATStore.patchById("events", res.event.id, { week52Position: pos });
          if (ires.added) await self.ATStore.patchById("intraday", ires.event.id, { week52Position: pos });
        }
      }
    } catch (e) { /* price capture is best-effort */ }
    if (!priceOk) { // GROUP F-PREREQ C: flag the failed/empty price fetch
      if (res.added) await self.ATStore.patchById("events", res.event.id, { priceFetchFailed: true });
      if (ires.added) await self.ATStore.patchById("intraday", ires.event.id, { priceFetchFailed: true });
    }
  }
  await updateBadge();
  ensureArchive(msg.ticker); // backfill hourly archive for new stocks (fire and forget)
  captureProfile(msg.ticker); // GROUP 1c: sector/industry/market-cap (fire and forget)
  triggerSync();
  return res;
}

// GROUP 1c: resolve sector/industry/market-cap (cached) and write to the latest
// rows once available. Fire-and-forget; never blocks attention capture.
async function captureProfile(ticker) {
  try {
    const data = await self.ATStore.getAll();
    const sym = symbolFor(data, ticker);
    const p = await self.ATPrices.fetchProfile(sym, true);
    if (p && (p.sector || p.industry || p.marketCap != null)) {
      await self.ATStore.patchLatest(ticker, {
        sector: p.sector, industry: p.industry, marketCap: p.marketCap, marketCapBucket: p.marketCapBucket
      });
      triggerSync();
    }
  } catch (e) { /* best-effort */ }
}

// Label the most recent event for a ticker (creating one and capturing its
// price first if none exists yet).
async function handleLabel(msg) {
  const data = await self.ATStore.getAll();
  const exists = data.events.some(function (e) { return e.ticker === msg.ticker; });
  if (!exists) await handleAttention(msg); // create the event in both databases first
  // One label, written to the latest event in both the daily and intraday databases.
  const ids = await self.ATStore.labelTicker(msg.ticker, msg.sentiment);
  triggerSync();
  return { ok: true, ids: ids, sentiment: msg.sentiment };
}

async function updateBadge() {
  // An expired session is the one state the user must act on, so it gets a red
  // "!" rather than the blank badge of a clean sign-out.
  let expired = false;
  try { expired = !!(await self.ATStore.getSyncConfig()).authExpired; } catch (e) { /* ignore */ }
  if (expired) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
    await chrome.action.setTitle({ title: "Stocktrails - session expired. Sign in again to resume tracking." });
    return;
  }
  await chrome.action.setTitle({ title: "Stocktrails" });
  if (!(await signedIn())) { await chrome.action.setBadgeText({ text: "" }); return; } // gated: no count when signed out
  const data = await self.ATStore.getAll();
  const n = new Set(data.events.map(function (e) { return e.ticker; })).size;
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#2d6cdf" });
}

// Refresh the badge whenever the shared session appears/disappears (sign in/out)
// or a sync flips the expired flag.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local" && (changes.at_cloud_signed_in || changes.attention_sync_v1)) updateBadge();
});

// Built-in portal hosts that have a static content script.
const BUILTIN_MATCHES = [
  "https://finance.yahoo.com/*", "https://www.google.com/finance/*",
  "https://www.marketwatch.com/*", "https://www.cnbc.com/*", "https://www.bloomberg.com/*",
  "https://stockanalysis.com/*", "https://www.marketbeat.com/*", "https://finviz.com/*"
];

// After an update/restart, inject the latest content script into already-open
// portal tabs so the in-page widget works without a manual reload. The content
// script is idempotent, so re-injection never duplicates the widget.
function reinjectOpenTabs() {
  chrome.tabs.query({ url: BUILTIN_MATCHES }, function (tabs) {
    if (chrome.runtime.lastError || !tabs) return;
    tabs.forEach(function (tab) {
      if (!tab.id) return;
      chrome.scripting.executeScript(
        { target: { tabId: tab.id }, files: ["src/portals.js", "src/content.js"] },
        function () { void chrome.runtime.lastError; }
      );
    });
  });
}

// Installs from before 0.4.0 kept the session tokens in storage.local; move them first.
function migrateSession() { return self.ATCloud && self.ATCloud.migrateSession ? self.ATCloud.migrateSession() : Promise.resolve(); }
chrome.runtime.onInstalled.addListener(function () { migrateSession().then(updateBadge); syncCustomScripts(); reinjectOpenTabs(); updateArchives(); triggerSync(); });
chrome.runtime.onStartup.addListener(function () { migrateSession().then(updateBadge); syncCustomScripts(); reinjectOpenTabs(); updateArchives(); triggerSync(); });

// ---------- the AI agent's live verdict on stock pages (issue #30) ----------
// Views and dwell pings form viewing sessions per stock (src/agentsession.js, in chrome.storage so a
// worker restart loses nothing). A minute after a session's last activity an alarm opens the dashboard
// headless in an offscreen document (it needs localStorage for the assistant's consent and log, IndexedDB
// for the ledger and the same code that builds the agent's input in the open dashboard). The page asks
// which sessions are due (agentDue), decides them and reports (agentDone); the verdicts land in
// at_agent_verdicts, which the stock-page pop-up reads (src/content.js). An offscreen document only has
// chrome.runtime, so its chrome.storage calls come here (offscreenStorage, src/offscreen-shim.js).
const AGENT_SESSIONS = "at_agent_sessions", AGENT_VERDICTS = "at_agent_verdicts", AGENT_ON = "at_ai_on";
const AGENT_DOC = "dashboard/dashboard.html?headless=agent", AGENT_KEEP_MS = 30 * 86400000;
let agentChain = Promise.resolve();
// Session and verdict writes one after another, so two messages never overwrite each other's change.
function agentSerial(fn) { const p = agentChain.then(fn, fn); agentChain = p.catch(function () {}); return p; }

// Only the headless dashboard of this extension: never a content script (sender.tab) or another page.
function fromHeadless(sender) {
  return !!sender && sender.id === chrome.runtime.id && !sender.tab && typeof sender.url === "string" && sender.url.indexOf(chrome.runtime.getURL("dashboard/dashboard.html")) === 0;
}

function agentTouch(ticker, kind, meta) {
  if (!ticker || !self.ATAgentSession) return Promise.resolve();
  return agentSerial(async function () {
    const now = Date.now(), SE = self.ATAgentSession;
    const r = await chrome.storage.local.get(AGENT_SESSIONS);
    const ss = SE.touch(SE.prune(r[AGENT_SESSIONS] || {}, now), ticker, now, kind, meta);
    await chrome.storage.local.set({ [AGENT_SESSIONS]: ss });
    const s = ss[String(ticker).toUpperCase()];
    if (s) chrome.alarms.create("agent|" + s.ticker, { when: SE.dueAt(s) + 1000 });
  }).catch(function () { /* the verdict is a bonus; capture never depends on it */ });
}

async function agentMaybeRun() {
  try {
    const r = await chrome.storage.local.get([AGENT_SESSIONS, AGENT_ON]);
    if (!self.ATAgentSession.due(r[AGENT_SESSIONS] || {}, Date.now()).length) return;
    // the assistant was found off: nothing until the user turns it on (aiclient.js grant() sets at_ai_on)
    if (r[AGENT_ON] === false || !chrome.offscreen || !(await signedIn())) return;
    if (await chrome.offscreen.hasDocument()) return; // the open run asks for what is due before it ends
    await chrome.offscreen.createDocument({ url: AGENT_DOC, reasons: ["LOCAL_STORAGE", "DOM_PARSER"], justification: "The AI agent decides a stock you just viewed, with the same data the dashboard uses." });
    chrome.alarms.create("agentClose", { delayInMinutes: 10 });
  } catch (e) { /* a second alarm raced this one to createDocument */ }
}

async function agentClose() {
  chrome.alarms.clear("agentClose");
  await agentSerial(async function () {
    const r = await chrome.storage.local.get(AGENT_VERDICTS), vs = Object.assign({}, r[AGENT_VERDICTS] || {});
    let changed = false;
    Object.keys(vs).forEach(function (T) {
      if (!vs[T] || !vs[T].progress) return;
      vs[T] = Object.assign({}, vs[T], { note: "The AI agent did not finish (it stopped while " + vs[T].progress + "); it tries again after your next visit.", updatedAt: Date.now() });
      delete vs[T].progress;
      changed = true;
    });
    if (changed) await chrome.storage.local.set({ [AGENT_VERDICTS]: vs });
  }).catch(function () {});
  try { if (chrome.offscreen && await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument(); } catch (e) { /* already closed */ }
}

async function agentMessage(msg) {
  if (msg.type === "offscreenStorage") {
    const L = chrome.storage.local;
    if (msg.op === "get") return { ok: true, value: await L.get(msg.arg) };
    if (msg.op === "set") { await L.set(msg.arg || {}); return { ok: true }; }
    if (msg.op === "remove") { await L.remove(msg.arg); return { ok: true }; }
    return { ok: false, error: "unknown op" };
  }
  if (msg.type === "agentDue") {
    const r = await chrome.storage.local.get(AGENT_SESSIONS), ss = r[AGENT_SESSIONS] || {}, out = {};
    self.ATAgentSession.due(ss, Date.now()).forEach(function (T) { out[T] = ss[T]; });
    return { ok: true, sessions: out };
  }
  if (msg.type === "agentDone") {
    await agentSerial(async function () {
      const SE = self.ATAgentSession, now = Date.now(), res = msg.results || {};
      const r = await chrome.storage.local.get([AGENT_SESSIONS, AGENT_VERDICTS]);
      let ss = r[AGENT_SESSIONS] || {};
      const vs = Object.assign({}, r[AGENT_VERDICTS] || {});
      Object.keys(res).forEach(function (T) {
        // ranAt is when the run started: activity during it makes the session due again
        ss = SE.markRan(ss, T, { ranAt: msg.startedAt || now, momentId: res[T].momentId, redecided: res[T].redecided });
        if (res[T].verdict) vs[T] = res[T].verdict;
      });
      Object.keys(vs).forEach(function (T) { if (!vs[T] || now - (vs[T].updatedAt || 0) > AGENT_KEEP_MS) delete vs[T]; });
      await chrome.storage.local.set({ [AGENT_SESSIONS]: ss, [AGENT_VERDICTS]: vs, [AGENT_ON]: msg.consent !== false });
    });
    return { ok: true };
  }
  // what the run is doing, shown in the pop-up while it works (cleared by agentDone, or by agentClose if it never finished)
  if (msg.type === "agentProgress") {
    await agentSerial(async function () {
      const r = await chrome.storage.local.get(AGENT_VERDICTS), vs = Object.assign({}, r[AGENT_VERDICTS] || {});
      (msg.tickers || []).forEach(function (T) { vs[T] = Object.assign({ ticker: T }, vs[T] || {}, { progress: String(msg.step || "").slice(0, 80), updatedAt: Date.now() }); });
      await chrome.storage.local.set({ [AGENT_VERDICTS]: vs });
    });
    return { ok: true };
  }
  if (msg.type === "agentClose") { await agentClose(); return { ok: true }; }
  return { ok: false };
}
