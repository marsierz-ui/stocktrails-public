(function () {
  // Groups touching this file: GROUP 1 (1a scroll depth, 1b focus switches,
  // 1f portal page path) on top of the existing dwell tracking.
  //
  // Finance portals are single-page apps; the URL changes without a reload.
  // Poll the URL, auto-log the ticker, and show an in-page label widget.

  // Idempotent: if a previous injection of this script is running (e.g. the
  // extension was updated and re-injected into this open tab), tear it down
  // first so we never end up with two timers or two widgets.
  if (window.__attentionTrackerCleanup) { try { window.__attentionTrackerCleanup(); } catch (e) { /* ignore */ } }

  // Remove any widget left by an older injection that predates the id/cleanup.
  try {
    document.querySelectorAll("div").forEach(function (d) {
      if (d.shadowRoot && d.shadowRoot.querySelector(".b.pos") && d.parentNode) d.parentNode.removeChild(d);
    });
  } catch (e) { /* ignore */ }

  const STORE_KEY = "attention_v1";
  const NAME_KEY = "attention_names_v1"; // ticker -> company name cache (written by the dashboard)
  let lastUrl = "";
  let custom = [];
  let knownTickers = new Set();  // tickers the user already tracks (+ overrides + named)
  let nameIndex = [];            // [{ ticker, re }] company-name phrase matchers
  let currentHit = null;
  let currentEvent = null; // latest event for the current ticker (drives the extra fields)
  let currentAuthed = true; // whether the user is signed in (capture requires it)
  let timer = null;
  let dwellTimer = null;
  let scrollTimer = null;

  // ---- time-based attention (dwell): accumulate active time on a stock page ----
  let activeTicker = null;   // ticker currently being timed
  let activeSince = 0;       // ms timestamp timing started (0 = paused)

  // ---- per-page-visit engagement (GROUP 1a/1b): reset on each new ticker page ----
  let maxScroll = null;      // max scroll depth 0..1 reached (null = not scrollable)
  let focusSwitches = 0;     // count of hidden -> visible transitions

  function resetEngagement() { maxScroll = null; focusSwitches = 0; }

  // GROUP 1a: sample scroll depth; keep the page-visit maximum.
  function sampleScroll() {
    if (document.visibilityState !== "visible") return;
    const denom = (document.body ? document.body.scrollHeight : 0) - window.innerHeight;
    if (denom <= 0) return; // page not scrollable -> leave maxScroll as null
    const d = Math.max(0, Math.min(1, window.scrollY / denom));
    if (maxScroll == null || d > maxScroll) maxScroll = d;
  }

  function startTiming(ticker) {
    if (activeTicker === ticker && activeSince) return;
    flushDwell();
    activeTicker = ticker;
    activeSince = (document.visibilityState === "visible") ? Date.now() : 0;
  }
  function stopTiming() { flushDwell(); activeTicker = null; activeSince = 0; }
  function flushDwell() {
    if (!activeTicker || !activeSince) { if (activeTicker && document.visibilityState === "visible") activeSince = Date.now(); return; }
    sampleScroll();
    const ms = Date.now() - activeSince;
    activeSince = (document.visibilityState === "visible") ? Date.now() : 0;
    if (ms > 0 && ms < 30 * 60000) { // ignore absurd chunks (sleep/suspend)
      // GROUP 1a/1b: carry the page-visit max scroll depth + focus-switch count.
      try { chrome.runtime.sendMessage({ type: "dwell", ticker: activeTicker, ms: ms, scrollDepth: maxScroll, focusSwitches: focusSwitches }, function () { void chrome.runtime.lastError; }); } catch (e) { /* ignore */ }
    }
  }
  function onVisibility() {
    if (document.visibilityState === "visible") {
      focusSwitches++; // GROUP 1b: each hidden -> visible transition is one switch
      if (activeTicker && !activeSince) activeSince = Date.now();
    } else { flushDwell(); }
  }

  // Drop legal-form suffixes and punctuation so "Apple Inc." matches "Apple".
  function normName(n) {
    return String(n || "")
      .replace(/[.,]/g, "")
      .replace(/\b(the)\b/gi, "")
      .replace(/\s+(inc|corp|corporation|company|co|ltd|limited|plc|sa|nv|ag|holdings?|group|class [a-c]|technologies|inc)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function loadCustom() {
    chrome.storage.local.get([STORE_KEY, NAME_KEY], function (r) {
      const data = r && r[STORE_KEY];
      custom = (data && data.customPortals) || [];
      // Build the user's known-ticker universe + company-name matchers, so content
      // detection is high-precision: it only fires for names the user tracks (plus
      // any unambiguous cashtag/exchange mention).
      const known = new Set();
      const idx = [];
      if (data) {
        (data.events || []).forEach(function (e) { if (e.ticker) known.add(String(e.ticker).toUpperCase()); });
        Object.keys(data.overrides || {}).forEach(function (t) { known.add(String(t).toUpperCase()); });
      }
      const names = (r && r[NAME_KEY]) || {};
      Object.keys(names).forEach(function (t) {
        const T = String(t).toUpperCase();
        known.add(T);
        const nm = normName(names[t]);
        if (nm && nm.length >= 4) idx.push({ ticker: T, re: new RegExp("\\b" + escapeRe(nm) + "\\b", "i") });
      });
      knownTickers = known;
      nameIndex = idx;
    });
  }
  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    if (changes[STORE_KEY] || changes[NAME_KEY]) loadCustom();
    // Re-gate the widget the moment the user signs in or out.
    if (changes.at_cloud_signed_in) { lastUrl = ""; ping(); }
    // A reminder set or removed in the dashboard while this page is open.
    if (changes.at_reminders && currentHit) showReminders(currentHit.ticker);
    // A new verdict of the AI agent (decided in the background after a viewing session).
    if (changes.at_agent_verdicts && currentHit) showVerdict(currentHit.ticker);
  }
  loadCustom();
  chrome.storage.onChanged.addListener(onStorageChanged);

  // ---- content-based ticker detection (fallback when no portal URL matches) ----
  // Common all-caps words that look like tickers but almost never are, so a bare
  // token alone never triggers a false positive.
  const TICKER_STOP = new Set(("A I IT IS BE ON OR AN AS AT BY DO GO HE IF IN ME MY NO OF OK SO TO UP US WE ALL AND ANY ARE BUT CAN FOR HAS HAD HER HIS HOW ITS NEW NOT NOW ONE OUR OUT THE WAS WHO YOU CEO CFO COO USA GDP ETF IPO API EPS PE PEG YOY QOQ EV AI ESG SEC FED").split(" "));

  let lastScanUrl = "", lastScanAt = 0, lastScanResult = null;

  // Scan the visible page for a stock the content is about. Signals, strongest
  // first: cashtag ($NVDA), exchange-qualified (NASDAQ: NVDA), a tracked
  // company name, or a bare tracked ticker. Title/heading hits weigh more than
  // body hits; a bare ticker needs a title hit or corroboration to win.
  function scanContent() {
    const title = document.title || "";
    const og = (document.querySelector("meta[property='og:title']") || {}).content || "";
    let heads = "";
    try { heads = Array.prototype.slice.call(document.querySelectorAll("h1,h2"), 0, 6).map(function (e) { return e.textContent || ""; }).join("  "); } catch (e) { /* ignore */ }
    const head = (title + "  " + og + "  " + heads);
    const body = (document.body ? (document.body.innerText || "") : "").slice(0, 20000);
    const scores = {}, strong = {};
    const add = function (t, s, str) { const T = String(t).toUpperCase(); if (T) { scores[T] = (scores[T] || 0) + s; if (str) strong[T] = 1; } };
    let m;
    // URL / structured-data / meta symbol: strong signal, catches sub-pages and
    // untracked tickers the portal pattern would miss.
    const us = urlMetaSymbol();
    if (us && /^[A-Za-z]{1,5}([.\-][A-Za-z]{1,2})?$/.test(us) && !TICKER_STOP.has(us.toUpperCase())) add(us, 5, true);
    const cash = /\$([A-Za-z]{1,5})\b/g;
    while ((m = cash.exec(head))) add(m[1], 5, true);
    cash.lastIndex = 0; while ((m = cash.exec(body))) add(m[1], 2, true);
    const exch = /\b(?:NASDAQ|NYSE|NYSEARCA|AMEX|OTC|LSE|TSX|CBOE)\s*:\s*([A-Za-z]{1,5})\b/gi;
    while ((m = exch.exec(head))) add(m[1], 5, true);
    exch.lastIndex = 0; while ((m = exch.exec(body))) add(m[1], 3, true);
    nameIndex.forEach(function (n) { if (n.re.test(head)) add(n.ticker, 5, true); else if (n.re.test(body)) add(n.ticker, 3); });
    knownTickers.forEach(function (T) {
      if (TICKER_STOP.has(T) || T.length < 2) return;
      const re = new RegExp("\\b" + T + "\\b");
      if (re.test(head)) add(T, 3, true); else if (re.test(body)) add(T, 1);
    });
    // Every stock with score >= 3 and at least one strong signal (URL/meta,
    // cashtag, exchange-qualified, or any title/heading hit), best first, so an
    // article covering several stocks queues all of them. Plain body mentions of
    // a tracked name or ticker only corroborate.
    const hits = Object.keys(scores)
      .filter(function (T) { return strong[T] && scores[T] >= 3; })
      .sort(function (a, b) { return scores[b] - scores[a]; })
      .slice(0, 10)
      .map(function (T) { return { ticker: T, source: "content", score: scores[T] }; });
    return hits.length ? hits : null;
  }

  // A finance portal's page without a ticker in its URL (home, trending,
  // movers, screeners) lists many stocks without being about any of them.
  // Its articles still get the content scan.
  function portalIndexPage() {
    const P = self.ATPortals;
    if (!P) return false;
    const onPortal = P.BUILTINS.some(function (p) { return p.host.test(location.hostname); });
    return onPortal && !/\/(news|articles?|story|stories|analysis|blog)/i.test(location.pathname);
  }

  // Throttle the (innerText-reading) scan so the 1.5s ping loop stays cheap.
  function scanContentThrottled() {
    const now = Date.now(), url = location.href;
    if (url === lastScanUrl && now - lastScanAt < 2500) return lastScanResult;
    lastScanUrl = url; lastScanAt = now; lastScanResult = portalIndexPage() ? null : scanContent();
    return lastScanResult;
  }

  // Classify what kind of research this page represents. URL/portal first (fast,
  // high precision); if that yields nothing specific, scan the page's own
  // headings/tab labels for the section being viewed (financials, insider,
  // short interest, institutional ownership, dividends, estimates, ...). Feeds
  // the research-path -> returns analysis (admin_research_effectiveness).
  function classifyResearch(url, source) {
    return ATPortals.classifyUrl(url, source) || classifyByContent() || "overview";
  }

  // Content refinement: read the page's headings / tab labels (weighted) and a
  // capped innerText slice, match section-type keyword patterns, and return the
  // strongest type. Requires a heading/label hit (or two body hits) so a passing
  // mention in the body never mislabels the page.
  const RESEARCH_RULES = [
    ["insider", /insider (buying|selling|trading|transactions|activity)|form 4\b/],
    ["short", /short interest|short selling|shares short|days to cover|short float|% of float (short|sold short)/],
    ["institutional", /institutional (ownership|holders|investors)|13f|hedge fund holdings/],
    ["dividends", /dividend (yield|history|growth|payout)|ex-dividend|payout ratio/],
    ["earnings", /earnings (call|date|report|history|surprise|whisper)|quarterly earnings|eps (actual|surprise|estimate)/],
    ["estimates", /analyst (estimates|ratings|price targets?)|price target|consensus (estimate|rating|price)|wall street (estimates|forecast)/],
    ["financials", /balance sheet|income statement|cash flow statement|financial statements|gross margin|operating income/],
    ["options", /option chain|options chain|implied volatility|put\/call|open interest/],
    ["ownership", /major holders|shareholders|ownership summary|top holders/],
    ["charts", /technical analysis|moving averages?|relative strength|candlestick|support and resistance/],
    ["news", /latest news|press releases?|news headlines/],
    ["community", /message board|community sentiment|discussion forum/],
    ["profile", /company profile|business summary|about the company|company overview/]
  ];
  function classifyByContent() {
    let head = "", body = "";
    try {
      const hs = document.querySelectorAll("h1,h2,h3,[role='tab'],.tab,.active-tab,nav a,button");
      head = Array.prototype.slice.call(hs, 0, 50).map(function (e) { return e.textContent || ""; }).join("  ").toLowerCase();
      body = (document.body ? (document.body.innerText || "") : "").slice(0, 8000).toLowerCase();
    } catch (e) { return null; }
    const score = {};
    RESEARCH_RULES.forEach(function (r) {
      if (r[1].test(head)) score[r[0]] = (score[r[0]] || 0) + 3;
      else if (r[1].test(body)) score[r[0]] = (score[r[0]] || 0) + 1;
    });
    let best = null, bs = 0;
    Object.keys(score).forEach(function (k) { if (score[k] > bs) { bs = score[k]; best = k; } });
    return bs >= 2 ? best : null;
  }

  // High-precision symbol from the URL / structured data / meta tags, so a stock
  // is recognized on sub-pages the portal pattern misses (financials, insider,
  // ...) and even when it is not yet tracked. Returns a raw symbol or null.
  const URL_EXCHANGES = new Set(["NASDAQ", "NYSE", "NYSEARCA", "AMEX", "OTC", "OTCMKTS", "LSE", "TSX", "CBOE", "BATS"]);
  const URL_CONTAINERS = { quote: 1, quotes: 1, stock: 1, stocks: 1, symbol: 1, symbols: 1, companies: 1, company: 1 };
  function urlMetaSymbol() {
    try {
      const q = /[?&](?:symbol|ticker)=([A-Za-z][A-Za-z.\-]{0,6})/i.exec(location.search || "");
      if (q) return q[1];
      // Walk path segments: the one after a container keyword is the symbol,
      // skipping an intervening exchange segment (e.g. /stocks/NASDAQ/TSLA).
      const segs = (location.pathname || "").split("/").filter(Boolean);
      for (let i = 0; i < segs.length - 1; i++) {
        if (!URL_CONTAINERS[segs[i].toLowerCase()]) continue;
        let j = i + 1;
        if (URL_EXCHANGES.has(segs[j].toUpperCase()) && j + 1 < segs.length) j++;
        const cand = segs[j];
        if (/^[A-Za-z]{1,5}([.\-][A-Za-z]{1,2})?$/.test(cand) && !URL_EXCHANGES.has(cand.toUpperCase())) return cand;
      }
      const m = document.querySelector("meta[name='ticker'],meta[property='og:ticker'],meta[name='stock-symbol'],meta[name='symbol']");
      if (m && m.content) { const c = m.content.replace(/^[^:]*:\s*/, ""); if (!URL_EXCHANGES.has(c.toUpperCase())) return c; }
    } catch (e) { /* ignore */ }
    return null;
  }

  function ping() {
    const url = location.href;
    // Portal URL patterns take priority; fall back to scanning page content so
    // stocks discussed on a non-quote page (article, feed) are still recognized.
    // The content scan can return several stocks; they form the widget queue.
    const portalHit = self.ATPortals && self.ATPortals.detect(url, custom);
    const hits = portalHit ? [portalHit] : (scanContentThrottled() || []);
    // Key on url+tickers so content that loads after the URL settles still
    // fires, and so navigating between tickers within one SPA route re-logs.
    const key = url + "|" + hits.map(function (h) { return h.ticker; }).sort().join(",");
    if (key === lastUrl) {
      // Same route + tickers: re-show the widget if the SPA removed it from the DOM.
      if (currentHit && remHost && !document.documentElement.contains(remHost)) showReminders(currentHit.ticker);
      if (currentHit && aiHost && !document.documentElement.contains(aiHost)) showVerdict(currentHit.ticker);
      placeReminder(); placeVerdict();
      if (currentHit && host && !document.documentElement.contains(host)) showWidget(currentHit, currentEvent ? currentEvent.sentiment : null, currentEvent, currentAuthed);
      return;
    }
    const sameUrl = lastUrl.split("|")[0] === url;
    lastUrl = key;
    if (!hits.length) { queue = []; hideWidget(); hideReminders(); hideVerdict(); currentHit = null; stopTiming(); resetEngagement(); return; }
    // Content still loading on the same page can grow the queue: stay on the
    // stock the user is looking at if it is still there.
    const keep = currentHit && sameUrl ? hits.findIndex(function (h) { return h.ticker === currentHit.ticker; }) : -1;
    queue = hits;
    if (!sameUrl) resetEngagement();   // new page visit: fresh scroll/focus counters
    if (keep >= 0) { qIdx = keep; currentHit = hits[keep]; if (host && host.style.display !== "none") updateNav(); return; }
    selectHit(0);
  }

  let queue = [], qIdx = 0;

  // Show queue item i, time it, and log an attention event for it.
  function selectHit(i) {
    qIdx = i;
    const hit = queue[i];
    currentHit = hit;
    currentEvent = null;
    showReminders(hit.ticker);
    showVerdict(hit.ticker);
    startTiming(hit.ticker);
    sampleScroll();
    // the pop-up appears at once; the background's answer (the stored view, an earlier label, sign-in) fills it in
    if (currentAuthed) showWidget(hit, null, null, true);
    const url = location.href;
    // GROUP 1f: portal page path at the moment of the attention event (<=200 chars).
    const portalPath = String(location.pathname || "").slice(0, 200);
    chrome.runtime.sendMessage(
      { type: "attention", ticker: hit.ticker, source: hit.source, url: url, portalPath: portalPath,
        section: hit.section || null, researchType: classifyResearch(url, hit.source) },
      function (res) {
        void chrome.runtime.lastError;
        if (currentHit !== hit) return; // user already moved on in the queue
        currentAuthed = !(res && res.signedIn === false);
        currentEvent = res && res.event ? res.event : null;
        showWidget(hit, currentEvent ? currentEvent.sentiment : null, currentEvent, currentAuthed);
      }
    );
  }

  function updateNav() {
    if (!shadow) return;
    const multi = queue.length > 1;
    shadow.getElementById("nav").style.display = multi ? "flex" : "none";
    shadow.getElementById("pos").textContent = (qIdx + 1) + " / " + queue.length;
    shadow.getElementById("prev").disabled = qIdx === 0;
    shadow.getElementById("next").disabled = qIdx >= queue.length - 1;
  }

  // ---- in-page label widget (isolated via shadow DOM) ----
  let host = null, shadow = null;

  function buildWidget() {
    const existing = document.getElementById("attention-tracker-widget");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    host = document.createElement("div");
    host.id = "attention-tracker-widget";
    host.style.cssText = "position:fixed;z-index:2147483647;bottom:16px;right:16px;";
    // Closed: an open root is reachable from the page (host.shadowRoot), so the site
    // and its third-party scripts could read the user's notes or drive the controls.
    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML =
      "<style>" +
      ":host{all:initial}" +
      ".card{font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;background:#1f2435;color:#e8ebf2;" +
      "border:1px solid #343c54;border-radius:10px;padding:10px 12px;width:200px;box-shadow:0 6px 24px rgba(0,0,0,.4);opacity:.92}" +
      ".card:hover{opacity:1}" +
      ".row{display:flex;align-items:center;gap:6px}" +
      ".tk{font-weight:700;font-size:16px}" +
      ".src{color:#9aa3b8;font-size:11px;flex:1}" +
      ".nav{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11px;color:#9aa3b8}" +
      ".nav button{background:#2b3145;border:1px solid #3a4159;border-radius:5px;color:#e8ebf2;cursor:pointer;padding:1px 8px;font-size:12px}" +
      ".nav button:disabled{opacity:.35;cursor:default}" +
      ".nav span{flex:1;text-align:center}" +
      ".x{background:none;border:none;color:#9aa3b8;cursor:pointer;font-size:16px;line-height:1;padding:0}" +
      ".lbl{color:#9aa3b8;font-size:11px;margin:8px 0 4px}" +
      ".btns{display:flex;gap:5px}" +
      ".b{flex:1;border:1px solid #3a4159;border-radius:6px;padding:5px 0;cursor:pointer;background:#2b3145;color:#e8ebf2;font-size:12px}" +
      ".b.pos:hover,.b.pos.on{background:#2ecc71;color:#0c1a10;border-color:#2ecc71}" +
      ".b.neu:hover,.b.neu.on{background:#8a93a6;color:#11141c;border-color:#8a93a6}" +
      ".b.neg:hover,.b.neg.on{background:#e74c3c;color:#1a0c0c;border-color:#e74c3c}" +
      ".status{color:#2ecc71;font-size:11px;min-height:14px;margin-top:6px}" +
      ".gate{color:#f1c40f;font-size:12px;margin-top:6px;line-height:1.4}" +
      ".extra{margin-top:8px;padding-top:8px;border-top:1px solid #2c3145}" +
      ".chk{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px}" +
      ".tgt{display:flex;align-items:center;gap:6px;margin-top:6px}" +
      ".tlbl{color:#9aa3b8;font-size:11px}" +
      ".tgt input,.tgt select{flex:1;width:60px;padding:3px 5px;border-radius:5px;border:1px solid #3a4159;background:#2b3145;color:#e8ebf2;font-size:12px}" +
      ".hint{color:#9aa3b8;font-size:11px;margin-top:4px}" +
      ".extra textarea{width:100%;box-sizing:border-box;margin-top:6px;padding:4px 5px;border-radius:5px;border:1px solid #3a4159;background:#2b3145;color:#e8ebf2;font:12px sans-serif;resize:vertical}" +
      "</style>" +
      "<div class='card'>" +
      "<div class='row'><span class='tk' id='tk'></span><span class='src' id='src'></span>" +
      "<button class='x' id='x' title='Hide'>&times;</button></div>" +
      // Queue of stocks found on the page (article covering several stocks).
      "<div class='nav' id='nav' style='display:none'><button id='prev' title='Previous stock'>&lsaquo;</button>" +
      "<span id='pos'></span><button id='next' title='Next stock'>&rsaquo;</button></div>" +
      "<div class='lbl' id='lbl'>Your expectation:</div>" +
      "<div class='btns'>" +
      "<button class='b pos' data-s='positive'>Positive</button>" +
      "<button class='b neu' data-s='neutral'>Neutral</button>" +
      "<button class='b neg' data-s='negative'>Negative</button>" +
      "</div><div class='status' id='status'></div>" +
      "<div class='gate' id='gate' style='display:none'>Sign in via the extension icon to start tracking.</div>" +
      // Position taken + target price, revealed only once a sentiment is set.
      "<div class='extra' id='extra' style='display:none'>" +
      "<label class='chk'><input type='checkbox' id='postaken' /> Position taken</label>" +
      "<div class='tgt'><span class='tlbl'>Target</span>" +
      "<input id='target' type='number' step='any' inputmode='decimal' placeholder='optional' /></div>" +
      // GROUP 5c: optional horizon - by when the target should be reached.
      "<div class='tgt'><span class='tlbl'>Within</span>" +
      "<select id='horizon'><option value=''>no horizon</option><option value='7'>1 week</option>" +
      "<option value='14'>2 weeks</option><option value='30'>1 month</option><option value='90'>3 months</option>" +
      "<option value='180'>6 months</option><option value='365'>1 year</option></select></div>" +
      "<div class='hint' id='hzhint'></div>" +
      // The factor behind the call: a label from the list or the user's own; kept as a leading [Label] in the rationale.
      "<div class='tgt'><span class='tlbl'>Factor</span><select id='factor'></select></div>" +
      "<div class='tgt' id='factornewrow' style='display:none'><input id='factornew' maxlength='30' placeholder='New label' /><button id='factoradd' class='b' style='flex:none;padding:3px 8px'>Add</button></div>" +
      "<textarea id='rationale' rows='2' placeholder='Rationale (optional)'></textarea>" +
      "</div></div>";
    (document.body || document.documentElement).appendChild(host);
    try { if (typeof ResizeObserver === "function") new ResizeObserver(placeReminder).observe(host); } catch (e) { /* no observer */ }

    shadow.getElementById("x").addEventListener("click", hideWidget);
    shadow.getElementById("prev").addEventListener("click", function () { if (qIdx > 0) selectHit(qIdx - 1); });
    shadow.getElementById("next").addEventListener("click", function () { if (qIdx < queue.length - 1) selectHit(qIdx + 1); });
    shadow.querySelectorAll(".b").forEach(function (b) {
      b.addEventListener("click", function (ev) { if (!ev.isTrusted) return; onLabel(b.getAttribute("data-s")); }); // only real clicks, not page scripts
    });
    shadow.getElementById("postaken").addEventListener("change", function (ev) {
      if (!ev.isTrusted || !currentHit) return;
      if (currentEvent) currentEvent.positionTaken = this.checked;
      chrome.runtime.sendMessage({ type: "position", ticker: currentHit.ticker, value: this.checked }, function () { void chrome.runtime.lastError; });
      shadow.getElementById("status").textContent = this.checked ? "Position marked ✓" : "Position cleared";
    });
    shadow.getElementById("target").addEventListener("change", function (ev) {
      if (!ev.isTrusted || !currentHit) return;
      const v = this.value === "" ? null : Number(this.value);
      if (currentEvent) currentEvent.targetPrice = v;
      chrome.runtime.sendMessage({ type: "target", ticker: currentHit.ticker, value: v }, function () { void chrome.runtime.lastError; });
      shadow.getElementById("status").textContent = v == null ? "Target cleared" : "Target set ✓";
    });
    shadow.getElementById("factor").addEventListener("change", function (ev) {
      if (!ev.isTrusted || !currentHit) return;
      if (this.value === "__new") { shadow.getElementById("factornewrow").style.display = "flex"; shadow.getElementById("factornew").focus(); return; }
      shadow.getElementById("factornewrow").style.display = "none";
      applyFactor(this.value);
    });
    shadow.getElementById("factoradd").addEventListener("click", function (ev) {
      if (!ev.isTrusted || !currentHit) return;
      const label = shadow.getElementById("factornew").value.replace(/[\[\]]/g, "").trim().slice(0, 30);
      if (!label) return;
      if (FACTORS.indexOf(label) < 0 && customFactors.indexOf(label) < 0) { customFactors.push(label); try { chrome.storage.local.set({ at_factors: customFactors }); } catch (e) { /* storage unavailable */ } }
      shadow.getElementById("factornew").value = "";
      shadow.getElementById("factornewrow").style.display = "none";
      fillFactor(label);
      applyFactor(label);
    });
    shadow.getElementById("rationale").addEventListener("change", function (ev) {
      if (!ev.isTrusted || !currentHit) return;
      fillFactor(splitTag(this.value).label);
      if (currentEvent) currentEvent.rationale = this.value;
      chrome.runtime.sendMessage({ type: "rationale", ticker: currentHit.ticker, value: this.value }, function () { void chrome.runtime.lastError; });
      shadow.getElementById("status").textContent = this.value.trim() ? "Rationale saved ✓" : "Rationale cleared";
    });
    shadow.getElementById("horizon").addEventListener("change", function (ev) {
      if (!ev.isTrusted || !currentHit) return;
      const v = this.value === "" ? null : Number(this.value);
      if (currentEvent) currentEvent.horizonDays = v;
      chrome.runtime.sendMessage({ type: "horizon", ticker: currentHit.ticker, value: v }, function () { void chrome.runtime.lastError; });
      shadow.getElementById("status").textContent = v == null ? "Horizon cleared" : "Horizon set ✓";
      horizonHint(currentEvent, v);
    });
  }

  // GROUP 5c: show the deadline the chosen horizon implies.
  function horizonHint(ev, days) {
    const el = shadow && shadow.getElementById("hzhint");
    if (!el) return;
    if (days == null) { el.textContent = ""; return; }
    const from = (ev && ev.ts) ? ev.ts : Date.now();
    el.textContent = "Target by " + new Date(from + days * 86400000).toISOString().slice(0, 10);
  }

  // ---- reminders: their own popup, shown whenever the stock is on the page ----
  // The reminders the user set for a stock (My Habits > Trades & research mirrors them into
  // extension storage, on this device only) pop up while the stock is viewed: on a quote page, an
  // analysis page or an article about it. Independent of the label widget (still there when that is
  // closed or signed out); closed with its x until the page or the stock changes.
  let remHost = null, remShadow = null;
  const remDone = {};
  // Directly above the label widget (which sits bottom right), whatever its height.
  function placeReminder() {
    if (!remHost) return;
    const up = host && host.style.display !== "none" && document.documentElement.contains(host) ? host.getBoundingClientRect() : null;
    remHost.style.bottom = (up && up.height ? Math.round(window.innerHeight - up.top + 8) : 16) + "px";
  }
  function hideReminders() { if (remHost) remHost.style.display = "none"; }
  function showReminders(ticker) {
    const T = String(ticker || "").toUpperCase(), key = T + "@" + location.pathname;
    if (!T) { hideReminders(); return; }
    try {
      chrome.storage.local.get(["at_reminders", STORE_KEY], function (r) {
        void chrome.runtime.lastError;
        const list = (r && r.at_reminders && r.at_reminders[T]) || [];
        // the user's last written comment on this stock (the rationale of its newest label)
        const evs = ((r && r[STORE_KEY] && r[STORE_KEY].events) || []).filter(function (e) { return e && String(e.ticker).toUpperCase() === T && e.rationale && String(e.rationale).trim(); });
        evs.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
        const last = evs[0] || null;
        if ((!list.length && !last) || remDone[key] || !currentHit || String(currentHit.ticker).toUpperCase() !== T) { hideReminders(); return; }
        if (!remHost || !document.documentElement.contains(remHost)) {
          remHost = document.createElement("div");
          remHost.id = "attention-tracker-reminder";
          remHost.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;";
          remShadow = remHost.attachShadow({ mode: "closed" });
          remShadow.innerHTML = "<style>:host{all:initial}.rem{font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;background:#2a2410;color:#f4efd8;border:1px solid #f1c40f;" +
            "border-left-width:5px;border-radius:10px;padding:10px 12px;width:196px;box-shadow:0 8px 28px rgba(0,0,0,.45)}b{color:#f1c40f}ul{margin:6px 0 0;padding-left:18px}li{margin:3px 0}.c{margin-top:8px;padding-top:6px;border-top:1px solid #5a4d1c}.c i{color:#b9b08a;font-style:normal;font-size:11px;display:block}" +
            ".x{float:right;background:none;border:none;color:#f1c40f;cursor:pointer;font-size:18px;line-height:1;padding:0}.s{color:#b9b08a;font-size:11px;margin-top:6px}</style>" +
            "<div class='rem'><button class='x' id='x' title='Dismiss'>&times;</button><b id='t'></b><ul id='l'></ul><div class='c' id='c' style='display:none'><i id='ci'></i><span id='ct'></span></div><div class='s'>Stocktrails</div></div>";
          (document.body || document.documentElement).appendChild(remHost);
        }
        remShadow.getElementById("x").onclick = function () { remDone[key] = 1; hideReminders(); };
        remShadow.getElementById("t").textContent = list.length ? "Your " + (list.length === 1 ? "reminder" : "reminders") + " for " + T : "Your last comment on " + T;
        const ul = remShadow.getElementById("l");
        ul.textContent = "";
        list.forEach(function (x) { const li = document.createElement("li"); li.textContent = x.text; ul.appendChild(li); });
        const cbox = remShadow.getElementById("c");
        cbox.style.display = last ? "block" : "none";
        if (last) {
          const d = last.ts ? new Date(last.ts).toISOString().slice(0, 10) : "";
          remShadow.getElementById("ci").textContent = "Last comment" + (d ? ", " + d : "") + (last.sentiment ? ", " + last.sentiment : "") + (last.targetPrice != null ? ", target " + last.targetPrice : "");
          remShadow.getElementById("ct").textContent = String(last.rationale).slice(0, 600);
        }
        remHost.style.display = "block";
        placeReminder();
      });
    } catch (e) { /* storage unavailable */ }
  }

  // ---- the AI agent's verdict on the stock (issue #30) ----
  // Decided in the background a minute after a viewing session ends (src/background.js, the dashboard
  // headless) and kept in at_agent_verdicts: { <ticker>: { action, days, size, sizeUnit, kind, reason,
  // date, redecided, current, note, updatedAt } }. Shown above the reminder pop-up (or the label widget)
  // while the stock is viewed; a new verdict replaces it live. Closed with its x until a new verdict.
  let aiHost = null, aiShadow = null;
  const aiDone = {};
  const aiShown = {}; // verdicts the user unmasked (stock@path -> the decision); a new decision is masked again
  function placeVerdict() {
    if (!aiHost || aiHost.style.display === "none") return;
    const rect = function (h) { return h && h.style.display !== "none" && document.documentElement.contains(h) ? h.getBoundingClientRect() : null; };
    const r = rect(remHost), w = rect(host), up = r && r.height ? r : w;
    aiHost.style.bottom = (up && up.height ? Math.round(window.innerHeight - up.top + 8) : 16) + "px";
  }
  function hideVerdict() { if (aiHost) aiHost.style.display = "none"; }
  function pct(x) { return Math.round(x * 1000) / 10 + "%"; }
  function verdictText(v) {
    const n = v.days || 0;
    if (v.action === "buy") return (v.kind === "revisit" ? "Buy more" : "Buy") + (v.size > 0 ? (v.sizeUnit === "weight" ? ", up to " + pct(v.size) + " of the portfolio" : v.size < 1 ? ", " + pct(v.size) + " of the amount" : "") : "");
    if (v.action === "wait") return "Wait" + (n ? " " + n + (n === 1 ? " trading day" : " trading days") : "");
    if (v.action === "pass") return "Pass";
    if (v.action === "hold") return "Hold (do nothing)";
    if (v.action === "sell") return "Sell " + (v.size > 0 ? pct(v.size) + " of the position" : "");
    return String(v.action || "");
  }
  function showVerdict(ticker) {
    const T = String(ticker || "").toUpperCase(), key = T + "@" + location.pathname;
    if (!T) { hideVerdict(); return; }
    try {
      chrome.storage.local.get("at_agent_verdicts", function (r) {
        void chrome.runtime.lastError;
        const v = r && r.at_agent_verdicts && r.at_agent_verdicts[T];
        if (!v || (!v.action && !v.note && !v.progress) || aiDone[key] === v.updatedAt || !currentHit || String(currentHit.ticker).toUpperCase() !== T) { hideVerdict(); return; }
        if (!aiHost || !document.documentElement.contains(aiHost)) {
          aiHost = document.createElement("div");
          aiHost.id = "attention-tracker-ai-verdict";
          aiHost.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;";
          aiShadow = aiHost.attachShadow({ mode: "closed" });
          aiShadow.innerHTML = "<style>:host{all:initial}.ai{font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;background:#1e1a33;color:#ece9fb;border:1px solid #a29bfe;" +
            "border-left-width:5px;border-radius:10px;padding:10px 12px;width:196px;box-shadow:0 8px 28px rgba(0,0,0,.45)}b{color:#a29bfe}.v{font-weight:600;margin-top:4px}.r{margin-top:4px}" +
            ".m{color:#b3acd9;font-size:11px;margin-top:6px}.n{margin-top:6px;padding-top:6px;border-top:1px solid #3d3566;color:#cfc9f0;font-size:12px}" +
            ".x{float:right;background:none;border:none;color:#a29bfe;cursor:pointer;font-size:18px;line-height:1;padding:0}" +
            ".u{margin-top:8px;background:#2b2650;border:1px solid #a29bfe;border-radius:6px;color:#ece9fb;cursor:pointer;font-size:12px;padding:4px 12px}.u:hover{background:#a29bfe;color:#1e1a33}</style>" +
            "<div class='ai'><button class='x' id='x' title='Dismiss'>&times;</button><b id='t'></b>" +
            "<div id='mask'><div class='m'>Hidden until you ask, so it does not sway your own view.</div><button class='u' id='unmask'>Unmask</button></div>" +
            "<div id='body'><div class='v' id='v'></div><div class='r' id='r'></div><div class='m' id='m'></div>" +
            "<div class='n' id='n'></div></div><div class='m'>A paper decision, not investment advice. Stocktrails</div></div>";
          (document.body || document.documentElement).appendChild(aiHost);
        }
        aiShadow.getElementById("x").onclick = function () { aiDone[key] = v.updatedAt; hideVerdict(); };
        aiShadow.getElementById("t").textContent = "AI agent on " + T;
        // masked until the user clicks Unmask (only a real click, not a page script)
        const vid = [v.action, v.days, v.size, v.date, v.decidedAt].join("|"); // progress updates keep it; a new decision changes it
        const reveal = function () {
          const on = aiShown[key] === vid;
          aiShadow.getElementById("mask").style.display = on ? "none" : "block";
          aiShadow.getElementById("body").style.display = on ? "block" : "none";
          placeVerdict();
        };
        aiShadow.getElementById("unmask").onclick = function (ev) { if (!ev.isTrusted) return; aiShown[key] = vid; reveal(); };
        reveal();
        const has = !!v.action;
        aiShadow.getElementById("v").textContent = has ? verdictText(v) : v.progress ? "Deciding..." : "No verdict";
        aiShadow.getElementById("v").style.display = "block";
        aiShadow.getElementById("r").textContent = has ? String(v.reason || "").slice(0, 400) : "";
        aiShadow.getElementById("m").textContent = has ? "On your " + (v.kind === "revisit" ? "repeat views" : "look") + (v.date ? " of " + v.date : "") +
          (v.redecided ? ", decided again " + v.redecided + (v.redecided === 1 ? " time" : " times") + " as you kept reading" : "") + (v.current ? "." : "; this session has no verdict of its own.") : "";
        const nb = aiShadow.getElementById("n");
        const note = v.progress ? "Working on your last session: " + v.progress + "..." + (has ? " (above: its earlier verdict)" : "") : v.note || "";
        nb.textContent = note;
        nb.style.display = note ? "block" : "none";
        aiHost.style.display = "block";
        placeVerdict();
      });
    } catch (e) { /* storage unavailable */ }
  }

  function showWidget(hit, sentiment, ev, authed) {
    // Rebuild if missing or detached (SPAs like Perplexity replace document.body).
    if (!host || !document.documentElement.contains(host)) buildWidget();
    host.style.display = "block";
    shadow.getElementById("tk").textContent = hit.ticker;
    shadow.getElementById("src").textContent = hit.source;
    shadow.getElementById("status").textContent = "";
    updateNav();
    // Required sign-in: without a session, show a hint instead of the controls.
    const gated = authed === false;
    shadow.getElementById("lbl").style.display = gated ? "none" : "";
    shadow.querySelector(".btns").style.display = gated ? "none" : "flex";
    shadow.getElementById("gate").style.display = gated ? "block" : "none";
    if (gated) { showExtra(null, null); return; }
    setActive(sentiment);
    showExtra(sentiment, ev);
  }

  // ---- the factor behind a call ----
  const FACTORS = ["Valuation", "Growth", "Momentum", "News or event", "Social media", "Chart patterns", "Macro", "Big investors", "Gut feeling"];
  let customFactors = [];
  try { chrome.storage.local.get("at_factors", function (r) { void chrome.runtime.lastError; if (r && Array.isArray(r.at_factors)) customFactors = r.at_factors.slice(0, 30); }); } catch (e) { /* storage unavailable */ }
  function splitTag(text) {
    const m = /^\s*\[([^\]]{1,30})\]\s*/.exec(text || "");
    return m ? { label: m[1], rest: String(text).slice(m[0].length) } : { label: "", rest: text || "" };
  }
  function fillFactor(selected) {
    const sel = shadow && shadow.getElementById("factor");
    if (!sel) return;
    const all = FACTORS.concat(customFactors.filter(function (c) { return FACTORS.indexOf(c) < 0; }));
    if (selected && all.indexOf(selected) < 0) all.push(selected);
    sel.textContent = "";
    const add = function (v, label) { const o = document.createElement("option"); o.value = v; o.textContent = label; sel.appendChild(o); };
    add("", "No factor");
    all.forEach(function (l) { add(l, l); });
    add("__new", "+ Add my own label...");
    sel.value = selected || "";
  }
  function applyFactor(label) {
    const ta = shadow.getElementById("rationale"), rest = splitTag(ta.value).rest;
    ta.value = label ? "[" + label + "] " + rest : rest;
    if (currentEvent) currentEvent.rationale = ta.value;
    chrome.runtime.sendMessage({ type: "rationale", ticker: currentHit.ticker, value: ta.value }, function () { void chrome.runtime.lastError; });
  }

  // Position taken + target price are gated on having a sentiment label.
  function showExtra(sentiment, ev) {
    if (!shadow) return;
    const ex = shadow.getElementById("extra");
    const has = sentiment === "positive" || sentiment === "neutral" || sentiment === "negative";
    ex.style.display = has ? "block" : "none";
    if (has) {
      shadow.getElementById("postaken").checked = !!(ev && ev.positionTaken);
      shadow.getElementById("target").value = (ev && ev.targetPrice != null) ? ev.targetPrice : "";
      shadow.getElementById("rationale").value = (ev && ev.rationale != null) ? ev.rationale : "";
      fillFactor(splitTag(shadow.getElementById("rationale").value).label);
      const hz = (ev && ev.horizonDays != null) ? ev.horizonDays : null;
      shadow.getElementById("horizon").value = hz == null ? "" : String(hz);
      horizonHint(ev, hz);
    }
  }

  function hideWidget() {
    if (host) host.style.display = "none";
  }

  function setActive(sentiment) {
    shadow.querySelectorAll(".b").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-s") === sentiment);
    });
  }

  function onLabel(s) {
    if (!currentHit) return;
    chrome.runtime.sendMessage(
      { type: "label", ticker: currentHit.ticker, source: currentHit.source, url: location.href, sentiment: s },
      function (res) {
        void chrome.runtime.lastError;
        setActive(s);
        if (currentEvent) currentEvent.sentiment = s; else currentEvent = { sentiment: s };
        showExtra(s, currentEvent); // reveal Position taken + target now a label exists
        shadow.getElementById("status").textContent = "Saved ✓";
      }
    );
  }

  ping();
  timer = setInterval(ping, 1500);
  dwellTimer = setInterval(flushDwell, 15000); // record accrued time periodically
  scrollTimer = setInterval(sampleScroll, 5000); // GROUP 1a: sample scroll depth
  window.addEventListener("popstate", ping);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", flushDwell);

  window.__attentionTrackerCleanup = function () {
    flushDwell();
    if (timer) clearInterval(timer);
    if (dwellTimer) clearInterval(dwellTimer);
    if (scrollTimer) clearInterval(scrollTimer);
    window.removeEventListener("popstate", ping);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", flushDwell);
    chrome.storage.onChanged.removeListener(onStorageChanged);
    const ex = document.getElementById("attention-tracker-widget");
    if (ex && ex.parentNode) ex.parentNode.removeChild(ex);
    if (remHost && remHost.parentNode) remHost.parentNode.removeChild(remHost);
    if (aiHost && aiHost.parentNode) aiHost.parentNode.removeChild(aiHost);
    host = null; remHost = null; aiHost = null;
  };
})();
