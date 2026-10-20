(function () {
  // Groups touching this file: GROUP 1 (1e sentiment-change fields; new capture
  // fields on events/intraday; addDwell carries scroll/focus), GROUP 4 (4a
  // computeSentimentStats, 4b attentionVelocity), GROUP 5 (5a setPositionTaken,
  // 5b setTargetPrice).
  const KEY = "attention_v1";
  const SYNC_KEY = "attention_sync_v1"; // device-local, never synced

  async function getSyncConfig() {
    const r = await chrome.storage.local.get(SYNC_KEY);
    return r[SYNC_KEY] || { url: "", token: "", cursor: 0, lastSync: 0, lastError: "" };
  }
  async function setSyncConfig(patch) {
    const cur = await getSyncConfig();
    await chrome.storage.local.set({ [SYNC_KEY]: Object.assign(cur, patch) });
  }

  // Account isolation: wipe this device's local data and reset the sync cursor so
  // a different signed-in account starts clean and re-pulls only its own rows.
  async function resetLocalData() {
    await setAll(defaults());
    await chrome.storage.local.set({ attention_names_v1: {} }); // the previous account's ticker names
    await setSyncConfig({ cloudCursor: 0, cloudSyncedAt: null, cursor: 0, lastSync: 0, lastError: "", accountId: null, authExpired: false });
  }

  // GROUP B1: classify an epoch-ms timestamp into a US/Eastern trading session.
  // Mirrors public.market_session() in SQL so client and server agree.
  function classifyMarketHours(tsMs) {
    if (tsMs == null || isNaN(tsMs)) return null;
    let hh = 0, mm = 0;
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit"
      }).formatToParts(new Date(Number(tsMs)));
      parts.forEach(function (p) { if (p.type === "hour") hh = parseInt(p.value, 10); else if (p.type === "minute") mm = parseInt(p.value, 10); });
    } catch (e) { return null; }
    if (hh === 24) hh = 0; // some engines emit 24 for midnight
    const m = hh * 60 + mm;
    if (m >= 240 && m <= 569) return "pre_market";
    if (m >= 570 && m <= 960) return "market_hours";
    if (m >= 961 && m <= 1199) return "after_hours";
    return "overnight";
  }

  function newId() {
    try { if (self.crypto && self.crypto.randomUUID) return self.crypto.randomUUID(); } catch (e) { /* fall through */ }
    // UUID-shaped fallback (the feature_usage.id column is a uuid).
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (ch) {
      const r = Math.floor(Math.random() * 16);
      return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // GROUP E4: record a section navigation. Bumps the per-section counter and
  // appends to a 500-entry ring buffer (oldest dropped) for server-side sequence
  // analysis.
  async function trackFeatureUse(section) {
    if (!section) return;
    const data = await getAll();
    if (!data.featureUsage) data.featureUsage = {};
    if (!data.featureUsageLog) data.featureUsageLog = [];
    const now = Date.now();
    data.featureUsage[section] = (data.featureUsage[section] || 0) + 1;
    data.featureUsageUpdatedAt = now;
    data.featureUsageLog.push({ id: newId(), section: section, ts: now });
    if (data.featureUsageLog.length > 500) data.featureUsageLog = data.featureUsageLog.slice(data.featureUsageLog.length - 500);
    await setAll(data);
  }

  async function getFeatureUsage() {
    const data = await getAll();
    return { counts: data.featureUsage || {}, log: data.featureUsageLog || [] };
  }

  function defaults() {
    // `events`   = daily database (repeated views deduped within the window).
    // `intraday` = intraday database (every view recorded with its own price).
    return {
      events: [], intraday: [], overrides: {}, customPortals: [], settings: { dedupeMinutes: 60 },
      // sync bookkeeping: per-record updatedAt (on events/intraday), delete
      // tombstones, and a single timestamp for the small config blob (meta).
      deletions: { events: {}, intraday: {} }, metaUpdatedAt: 0,
      // GROUP E4: feature usage counters + a bounded navigation log (ring buffer).
      featureUsage: {}, featureUsageLog: [], featureUsageUpdatedAt: 0
    };
  }

  async function getAll() {
    const r = await chrome.storage.local.get(KEY);
    const data = r[KEY] || defaults();
    // Backfill updatedAt on records created before sync existed, so collectChanges
    // includes them (otherwise pre-sync history never uploads on first sync).
    (data.events || []).forEach(function (e) { if (e.updatedAt == null) e.updatedAt = e.ts || 0; });
    (data.intraday || []).forEach(function (e) { if (e.updatedAt == null) e.updatedAt = e.ts || 0; });
    return data;
  }

  async function setAll(data) {
    await chrome.storage.local.set({ [KEY]: data });
  }

  // Adds an attention event. Repeated views of the same ticker inside the
  // dedupe window only refresh the existing event instead of adding a point.
  async function addEvent(ev) {
    const data = await getAll();
    const windowMs = (data.settings.dedupeMinutes || 60) * 60000;
    const recent = data.events
      .filter(function (e) { return e.ticker === ev.ticker; })
      .sort(function (a, b) { return b.ts - a.ts; })[0];
    if (recent && ev.ts - recent.ts < windowMs) {
      recent.ts = ev.ts;
      recent.views = (recent.views || 1) + 1;
      recent.updatedAt = ev.ts;
      await setAll(data);
      return { added: false, event: recent };
    }
    const event = dailyRow(ev);
    data.events.push(event);
    await setAll(data);
    return { added: true, event: event };
  }

  function dailyRow(ev) {
    return {
      id: ev.ts + "-" + ev.ticker,
      ticker: ev.ticker,
      ts: ev.ts,
      source: ev.source || "manual",
      url: ev.url || "",
      sentiment: ev.sentiment || null,
      priceAtEvent: ev.priceAtEvent == null ? null : ev.priceAtEvent,
      views: 1,
      dwellMs: 0,
      researchType: ev.researchType == null ? null : ev.researchType,
      section: ev.section == null ? null : String(ev.section).slice(0, 60),
      // GROUP 1: new capture fields (all additive / nullable).
      scrollDepth: null, focusSwitches: 0,
      sector: null, industry: null, marketCap: null, marketCapBucket: null,
      week52Position: null, sentimentPrev: null, sentimentChangedAt: null,
      positionTaken: null, targetPrice: null, rationale: null, horizonDays: null,
      // GROUP B1: market session at capture time (caller may override).
      marketSession: ev.marketSession != null ? ev.marketSession : classifyMarketHours(ev.ts),
      priceFetchFailed: false, // GROUP F-PREREQ C
      updatedAt: ev.ts
    };
  }

  // Adds an intraday event. Every view is recorded (no daily dedupe); only
  // exact double-fires within 30s are skipped. A move to another section of the
  // same stock inside 30s is a real step in the research path, not a double-fire.
  async function addIntraday(ev) {
    const data = await getAll();
    if (!data.intraday) data.intraday = [];
    const last = data.intraday
      .filter(function (e) { return e.ticker === ev.ticker; })
      .sort(function (a, b) { return b.ts - a.ts; })[0];
    if (last && ev.ts - last.ts < 30000 && (last.section || null) === (ev.section || null)) return { added: false, event: last };
    const event = intradayRow(ev);
    data.intraday.push(event);
    await setAll(data);
    return { added: true, event: event };
  }

  function intradayRow(ev) {
    return {
      id: "i" + ev.ts + "-" + ev.ticker,
      ticker: ev.ticker, ts: ev.ts, source: ev.source || "manual", url: ev.url || "",
      sentiment: ev.sentiment || null, priceAtEvent: ev.priceAtEvent == null ? null : ev.priceAtEvent,
      dwellMs: 0,
      // GROUP 1: new capture fields; portalPath is intraday-only (1f).
      scrollDepth: null, focusSwitches: 0,
      sector: null, industry: null, marketCap: null, marketCapBucket: null,
      week52Position: null, sentimentPrev: null, sentimentChangedAt: null,
      positionTaken: null, targetPrice: null, rationale: null, horizonDays: null,
      // GROUP B1: market session at capture time (caller may override).
      marketSession: ev.marketSession != null ? ev.marketSession : classifyMarketHours(ev.ts),
      priceFetchFailed: false, // GROUP F-PREREQ C
      sessionId: ev.sessionId == null ? null : ev.sessionId, // GROUP F-PREREQ B (intraday only)
      portalPath: ev.portalPath == null ? null : String(ev.portalPath).slice(0, 200),
      researchType: ev.researchType == null ? null : ev.researchType,
      section: ev.section == null ? null : String(ev.section).slice(0, 60),
      updatedAt: ev.ts
    };
  }

  // Browsing-history backfill: many old visits merged in one pass (addEvent /
  // addIntraday re-read the whole store per call), with the same dedupe rules.
  // updatedAt is NOW, not the visit time: collectChanges only pushes rows newer
  // than this device's cursor, and a row stamped years back would stay local
  // forever (the Import JSON trap, see ARCHITECTURE section 5).
  async function importVisits(visits) {
    const data = await getAll();
    if (!data.intraday) data.intraday = [];
    const windowMs = (data.settings.dedupeMinutes || 60) * 60000, now = Date.now();
    const lastI = {}, dailyBy = {};
    data.events.forEach(function (e) { (dailyBy[e.ticker] = dailyBy[e.ticker] || []).push(e); });
    let daily = 0, intraday = 0, merged = 0;
    visits.slice().sort(function (a, b) { return a.ts - b.ts; }).forEach(function (v) {
      const li = lastI[v.ticker];
      if (!(li && v.ts - li.ts < 30000 && (li.section || null) === (v.section || null))) {
        const r = intradayRow(v); r.updatedAt = now;
        data.intraday.push(r); lastI[v.ticker] = r; intraday++;
      }
      // Join a daily event of this stock within the dedupe window - an existing
      // one too, since a second browser's history can fall beside a live
      // capture - else open a new one.
      const near = (dailyBy[v.ticker] || []).find(function (e) { return Math.abs(e.ts - v.ts) < windowMs; });
      if (near) { near.views = (near.views || 1) + 1; if (v.ts > near.ts) near.ts = v.ts; near.updatedAt = now; merged++; }
      else { const r = dailyRow(v); r.updatedAt = now; data.events.push(r); (dailyBy[v.ticker] = dailyBy[v.ticker] || []).push(r); daily++; }
    });
    await setAll(data);
    return { daily: daily, intraday: intraday, merged: merged };
  }

  // Add dwell (active time in ms) to the latest event for a ticker in both DBs.
  // GROUP 1a/1b: `extra` carries the page-visit max scroll depth + focus-switch
  // count, stored as running maxima on the latest rows.
  async function addDwell(ticker, ms, extra) {
    if (!ms || ms <= 0) return;
    const data = await getAll();
    const now = Date.now();
    const latest = function (arr) {
      return (arr || []).filter(function (e) { return e.ticker === ticker; })
        .sort(function (a, b) { return b.ts - a.ts; })[0];
    };
    extra = extra || {};
    const sd = (extra.scrollDepth == null || isNaN(extra.scrollDepth)) ? null : Math.max(0, Math.min(1, extra.scrollDepth));
    const fs = (extra.focusSwitches == null || isNaN(extra.focusSwitches)) ? null : Math.max(0, Math.round(extra.focusSwitches));
    const apply = function (e) {
      e.dwellMs = (e.dwellMs || 0) + ms;
      if (sd != null) e.scrollDepth = (e.scrollDepth == null) ? sd : Math.max(e.scrollDepth, sd);
      if (fs != null) e.focusSwitches = Math.max(e.focusSwitches || 0, fs);
      e.updatedAt = now;
    };
    const d = latest(data.events), i = latest(data.intraday);
    if (d) apply(d);
    if (i) apply(i);
    if (d || i) await setAll(data);
  }

  async function setSentiment(id, sentiment) {
    const data = await getAll();
    const e = data.events.find(function (x) { return x.id === id; });
    if (e) { e.sentiment = sentiment; e.updatedAt = Date.now(); await setAll(data); }
    return e;
  }

  // Apply one label to both databases: the latest daily event and the latest
  // intraday event for the ticker. Keeps the label identical across both.
  // GROUP 1e: when overwriting an existing (non-null, different) sentiment,
  // record the previous value and the change time.
  async function labelTicker(ticker, sentiment) {
    const data = await getAll();
    const latest = function (arr) {
      return (arr || []).filter(function (e) { return e.ticker === ticker; })
        .sort(function (a, b) { return b.ts - a.ts; })[0];
    };
    const d = latest(data.events), i = latest(data.intraday);
    const now = Date.now();
    const apply = function (e) {
      if (e.sentiment != null && e.sentiment !== sentiment) {
        e.sentimentPrev = e.sentiment;
        e.sentimentChangedAt = now;
      }
      e.sentiment = sentiment;
      e.updatedAt = now;
    };
    if (d) apply(d);
    if (i) apply(i);
    await setAll(data);
    return { daily: d ? d.id : null, intraday: i ? i.id : null };
  }

  // GROUP 1c/1d: patch arbitrary fields on a known row (used by background.js to
  // attach the 52-week position to the just-created event).
  async function patchById(kind, id, patch) {
    const data = await getAll();
    const arr = data[kind] || [];
    const e = arr.find(function (x) { return x.id === id; });
    if (!e) return false;
    Object.keys(patch || {}).forEach(function (k) { if (patch[k] !== undefined) e[k] = patch[k]; });
    e.updatedAt = Date.now();
    await setAll(data);
    return true;
  }

  // GROUP 1c: patch the latest row for a ticker in both DBs (used when the async
  // profile lookup resolves after the event was already written).
  async function patchLatest(ticker, patch) {
    const data = await getAll();
    const now = Date.now();
    const latest = function (arr) {
      return (arr || []).filter(function (e) { return e.ticker === ticker; })
        .sort(function (a, b) { return b.ts - a.ts; })[0];
    };
    const apply = function (e) { if (!e) return; Object.keys(patch || {}).forEach(function (k) { if (patch[k] !== undefined) e[k] = patch[k]; }); e.updatedAt = now; };
    const d = latest(data.events), i = latest(data.intraday);
    apply(d); apply(i);
    if (d || i) await setAll(data);
    return !!(d || i);
  }

  // GROUP 5a/5b: user-set optional fields on the latest row in both DBs.
  async function setPositionTaken(ticker, value) { return patchLatest(ticker, { positionTaken: !!value }); }
  async function setTargetPrice(ticker, value) {
    const v = (value == null || value === "" || isNaN(value)) ? null : Number(value);
    return patchLatest(ticker, { targetPrice: v });
  }
  // Optional free-text rationale for the current label/position.
  async function setRationale(ticker, value) {
    const v = (value == null || String(value).trim() === "") ? null : String(value).slice(0, 1000);
    return patchLatest(ticker, { rationale: v });
  }
  // GROUP 5c: optional prediction horizon (days) the user gives the stock to
  // reach its target. Deadline is derived at read time as event.ts + horizon.
  async function setHorizon(ticker, days) {
    const v = (days == null || days === "" || isNaN(days)) ? null : Math.max(1, Math.min(3650, Math.round(Number(days))));
    return patchLatest(ticker, { horizonDays: v });
  }

  async function setPrice(id, price) {
    const data = await getAll();
    const e = data.events.find(function (x) { return x.id === id; });
    if (e && e.priceAtEvent == null) { e.priceAtEvent = price; e.updatedAt = Date.now(); await setAll(data); }
  }

  async function setIntradayPrice(id, price) {
    const data = await getAll();
    const e = (data.intraday || []).find(function (x) { return x.id === id; });
    if (e && e.priceAtEvent == null) { e.priceAtEvent = price; e.updatedAt = Date.now(); await setAll(data); }
  }

  function ensureSync(data) {
    if (!data.deletions) data.deletions = { events: {}, intraday: {} };
    if (!data.deletions.events) data.deletions.events = {};
    if (!data.deletions.intraday) data.deletions.intraday = {};
    if (data.metaUpdatedAt == null) data.metaUpdatedAt = 0;
  }

  async function removeEvent(id) {
    const data = await getAll();
    ensureSync(data);
    data.events = data.events.filter(function (x) { return x.id !== id; });
    data.deletions.events[id] = Date.now();
    await setAll(data);
  }

  // Delete an entire position: all of a ticker's events and its symbol override.
  async function removePosition(ticker) {
    const data = await getAll();
    ensureSync(data);
    const now = Date.now();
    data.events.filter(function (e) { return e.ticker === ticker; }).forEach(function (e) { data.deletions.events[e.id] = now; });
    (data.intraday || []).filter(function (e) { return e.ticker === ticker; }).forEach(function (e) { data.deletions.intraday[e.id] = now; });
    data.events = data.events.filter(function (e) { return e.ticker !== ticker; });
    data.intraday = (data.intraday || []).filter(function (e) { return e.ticker !== ticker; });
    if (data.overrides) delete data.overrides[ticker];
    data.metaUpdatedAt = now;
    await setAll(data);
  }

  async function setOverride(ticker, symbol) {
    const data = await getAll();
    if (symbol) data.overrides[ticker] = symbol;
    else delete data.overrides[ticker];
    data.metaUpdatedAt = Date.now();
    await setAll(data);
  }

  async function addPortal(portal) {
    const data = await getAll();
    if (!data.customPortals) data.customPortals = [];
    data.customPortals.push({ name: portal.name, pattern: portal.pattern, host: portal.host });
    data.metaUpdatedAt = Date.now();
    await setAll(data);
  }

  async function removePortal(index) {
    const data = await getAll();
    data.customPortals = (data.customPortals || []).filter(function (_, i) { return i !== index; });
    data.metaUpdatedAt = Date.now();
    await setAll(data);
  }

  // ---- sync helpers (pure; operate on a data object) ----

  // Everything changed strictly after `since` (ms): records + tombstones + meta.
  function collectChanges(data, since) {
    since = since || 0;
    function pick(map) { const o = {}; Object.keys(map || {}).forEach(function (k) { if (map[k] > since) o[k] = map[k]; }); return o; }
    ensureSync(data);
    return {
      events: data.events.filter(function (e) { return (e.updatedAt || 0) > since; }),
      intraday: (data.intraday || []).filter(function (e) { return (e.updatedAt || 0) > since; }),
      deletions: { events: pick(data.deletions.events), intraday: pick(data.deletions.intraday) },
      meta: (data.metaUpdatedAt || 0) > since
        ? { overrides: data.overrides, customPortals: data.customPortals, settings: data.settings, updatedAt: data.metaUpdatedAt }
        : null,
      // GROUP E4: usage counters (whole object) + only the log entries past the cursor.
      featureUsage: data.featureUsage || {},
      featureUsageLog: (data.featureUsageLog || []).filter(function (e) { return (e.ts || 0) > since; }),
      // GROUP F-PREREQ A: device fingerprint for multi-device detection.
      ua: (typeof navigator !== "undefined" && navigator.userAgent) ? String(navigator.userAgent).substring(0, 200) : null
    };
  }

  // Merge a remote change-set into data (last-write-wins by updatedAt; tombstones
  // win when newer). Returns true if anything changed.
  function applyRemote(data, remote) {
    ensureSync(data);
    let changed = false;
    ["events", "intraday"].forEach(function (kind) {
      const byId = {};
      data[kind].forEach(function (e) { byId[e.id] = e; });
      (remote[kind] || []).forEach(function (r) {
        const tomb = data.deletions[kind][r.id] || 0;
        if (tomb >= (r.updatedAt || 0)) return; // locally deleted later
        const cur = byId[r.id];
        if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) { byId[r.id] = r; changed = true; }
      });
      const remDel = (remote.deletions && remote.deletions[kind]) || {};
      Object.keys(remDel).forEach(function (id) {
        const t = remDel[id];
        if (t > (data.deletions[kind][id] || 0)) { data.deletions[kind][id] = t; changed = true; }
        const cur = byId[id];
        if (cur && (cur.updatedAt || 0) <= t) { delete byId[id]; changed = true; }
      });
      data[kind] = Object.keys(byId).map(function (id) { return byId[id]; });
    });
    if (remote.meta && (remote.meta.updatedAt || 0) > (data.metaUpdatedAt || 0)) {
      if (remote.meta.overrides) data.overrides = remote.meta.overrides;
      if (remote.meta.customPortals) data.customPortals = remote.meta.customPortals;
      if (remote.meta.settings) data.settings = remote.meta.settings;
      data.metaUpdatedAt = remote.meta.updatedAt;
      changed = true;
    }
    return changed;
  }

  function byTicker(events) {
    const m = {};
    events.forEach(function (e) { (m[e.ticker] = m[e.ticker] || []).push(e); });
    Object.keys(m).forEach(function (k) { m[k].sort(function (a, b) { return a.ts - b.ts; }); });
    return m;
  }

  // GROUP 4a: forecast accuracy. For each labelled event, the realized return is
  // priceAtEvent -> the most recent event of the same ticker at least
  // `horizonDays` later (a proxy, since there is no separate price history table).
  async function computeSentimentStats(horizonDays) {
    horizonDays = horizonDays || 30;
    const data = await getAll();
    const byTk = {};
    data.events.forEach(function (e) { (byTk[e.ticker] = byTk[e.ticker] || []).push(e); });
    Object.keys(byTk).forEach(function (t) { byTk[t].sort(function (a, b) { return a.ts - b.ts; }); });
    const horizonMs = horizonDays * 86400000;
    const labelled = data.events.filter(function (e) { return e.sentiment === "positive" || e.sentiment === "neutral" || e.sentiment === "negative"; });

    let hit = 0, nonNeutral = 0, posTotal = 0, posHit = 0, negTotal = 0, negHit = 0, brierSum = 0, brierN = 0, flips = 0;
    labelled.forEach(function (e) {
      if (e.sentimentPrev != null) flips++;
      if (e.priceAtEvent == null) return;
      const future = byTk[e.ticker].filter(function (x) { return x.ts >= e.ts + horizonMs && x.priceAtEvent != null; });
      if (!future.length) return;
      const fp = future[future.length - 1].priceAtEvent;
      if (!fp) return;
      const ret = (fp - e.priceAtEvent) / e.priceAtEvent;
      const outcome = ret > 0 ? 1 : 0;
      const p = e.sentiment === "positive" ? 0.85 : (e.sentiment === "negative" ? 0.15 : 0.5);
      brierSum += (p - outcome) * (p - outcome); brierN++;
      if (e.sentiment === "positive") { posTotal++; nonNeutral++; if (ret > 0) { posHit++; hit++; } }
      else if (e.sentiment === "negative") { negTotal++; nonNeutral++; if (ret < 0) { negHit++; hit++; } }
    });
    return {
      hitRate: nonNeutral ? hit / nonNeutral : null,
      brierScore: brierN ? brierSum / brierN : null,
      totalLabelled: labelled.length,
      positiveHitRate: posTotal ? posHit / posTotal : null,
      negativeHitRate: negTotal ? negHit / negTotal : null,
      flipRate: labelled.length ? flips / labelled.length : null
    };
  }

  // GROUP 4b: how fast attention is accruing on a ticker in the recent window.
  async function attentionVelocity(ticker, windowDays) {
    windowDays = windowDays || 7;
    const data = await getAll();
    const cut = Date.now() - windowDays * 86400000;
    const evs = (data.intraday || []).filter(function (e) { return e.ticker === ticker && e.ts >= cut; })
      .sort(function (a, b) { return a.ts - b.ts; });
    let totalDwellMs = 0, gapSum = 0, gaps = 0;
    evs.forEach(function (e) { totalDwellMs += (e.dwellMs || 0); });
    for (let i = 1; i < evs.length; i++) { gapSum += (evs[i].ts - evs[i - 1].ts); gaps++; }
    return {
      views: evs.length,
      totalDwellMs: totalDwellMs,
      avgGapHours: gaps ? (gapSum / gaps) / 3600000 : null,
      revisitCount: Math.max(0, evs.length - 1)
    };
  }

  const api = { KEY, getAll, setAll, addEvent, addIntraday, importVisits, setSentiment, labelTicker, setPrice, setIntradayPrice, addDwell, patchById, patchLatest, setPositionTaken, setTargetPrice, setRationale, setHorizon, resetLocalData, computeSentimentStats, attentionVelocity, classifyMarketHours, trackFeatureUse, getFeatureUsage, removeEvent, removePosition, setOverride, addPortal, removePortal, byTicker, collectChanges, applyRemote, getSyncConfig, setSyncConfig };
  if (typeof self !== "undefined") self.ATStore = api;
})();
