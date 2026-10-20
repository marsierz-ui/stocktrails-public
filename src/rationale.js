(function () {
  // The written reasons behind calls: what kind of reasons the user gives, and
  // how calls backed by each kind turned out. A call's note can say "cheap
  // against peers" or "everyone is talking about it"; the first and the second
  // do not age the same way, and the user may never have checked.
  //
  // Each note is classified once (by the AI service, see aiclient.js) and the
  // result kept on the device under a hash of the note, so a note is sent once
  // and never again. Notes are redacted first (links, e-mail addresses, long
  // numbers) and the user sees what will be sent. The statistics here are pure
  // and use the same sample-size gates as the rest of the analytics.
  const D = typeof module !== "undefined" && module.exports ? require("./decisions.js") : self.ATDecisions;
  const T = typeof module !== "undefined" && module.exports ? require("./aitools.js") : self.ATTools;
  const S = D.stats;
  const KEY = "at_rationale_v1", MAX_CACHE = 3000, BATCH = 20, MIN_CHARS = 12, NEED = { min: 8, solid: 25 };

  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  }
  function ls() { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (e) { return null; } }
  function loadCache(store) {
    store = store || ls();
    try { const c = store && JSON.parse(store.getItem(KEY) || "{}"); return c && typeof c === "object" ? c : {}; } catch (e) { return {}; }
  }
  function saveCache(c, store) {
    store = store || ls();
    const keys = Object.keys(c);
    if (keys.length > MAX_CACHE) keys.slice(0, keys.length - MAX_CACHE).forEach(function (k) { delete c[k]; });
    if (store) try { store.setItem(KEY, JSON.stringify(c)); } catch (e) { /* storage full: classified again next time */ }
  }
  function clearCache(store) { store = store || ls(); if (store) try { store.removeItem(KEY); } catch (e) { /* ignore */ } }

  // The notes written with a Positive or Negative call, redacted, one per
  // (stock, moment). `id` is what joins a note to the call it came with.
  function collect(events) {
    const seen = {}, out = [];
    (events || []).forEach(function (e) {
      if (!e || !e.rationale || (e.sentiment !== "positive" && e.sentiment !== "negative")) return;
      const text = T.redact(e.rationale).slice(0, 400);
      if (text.length < MIN_CHARS) return;
      const id = e.ticker + "|" + e.ts;
      if (seen[id]) return;
      seen[id] = 1;
      out.push({ id: id, ticker: e.ticker, ts: e.ts, sentiment: e.sentiment, text: text, key: hash(text) });
    });
    return out;
  }

  // A label the user chose in the page widget leads the note as "[Label]". The built-in ones name
  // a type (the others are the user's own and only appear in the note's text).
  const USER_TAGS = { "valuation": "valuation", "growth": "growth", "momentum": "momentum", "news or event": "news", "social media": "social", "chart patterns": "technical",
    "macro": "macro", "big investors": "smart_money", "gut feeling": "gut" };
  function userType(text) { const m = /^\s*\[([^\]]{1,30})\]/.exec(text || ""); return m ? USER_TAGS[m[1].trim().toLowerCase()] || null : null; }

  // Classify the notes not yet in the cache, a batch at a time. ai: { call }.
  // Returns { sent, cached, failed }. Throws on the first failed batch after
  // keeping what was done, so a free-tier limit does not lose the work so far.
  async function classify(items, cache, ai, opts) {
    const todo = [], seen = {};
    items.forEach(function (it) { if (!cache[it.key] && !seen[it.key]) { seen[it.key] = 1; todo.push(it); } });
    let sent = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const res = await ai.call("classify_rationales", { notes: batch.map(function (b) { return { id: b.key, text: b.text }; }) }, opts);
      (res.items || []).forEach(function (c) { cache[c.id] = { types: c.types, specific: c.specific, horizon: c.horizon, tone: c.tone, emotion: c.emotion, stance: c.stance, v: 1 }; });
      sent += batch.length;
      if (opts && opts.onProgress) opts.onProgress(Math.min(i + BATCH, todo.length), todo.length);
    }
    // what the user chose settles the type, whatever the model said
    items.forEach(function (it) { const u = userType(it.text), c = cache[it.key]; if (u && c && (c.types || [])[0] !== u) { c.types = [u]; c.byUser = true; } });
    return { sent: sent, cached: items.length - todo.length, todo: todo.length };
  }

  const FEATURES = [
    ["type:valuation", "Valuation (cheap against peers or history)", function (c) { return c.types.indexOf("valuation") >= 0; }],
    ["type:growth", "Growth", function (c) { return c.types.indexOf("growth") >= 0; }],
    ["type:momentum", "Momentum (price is rising)", function (c) { return c.types.indexOf("momentum") >= 0; }],
    ["type:news", "A news item or event", function (c) { return c.types.indexOf("news") >= 0; }],
    ["type:social", "Social media or what others say", function (c) { return c.types.indexOf("social") >= 0; }],
    ["type:technical", "Chart patterns", function (c) { return c.types.indexOf("technical") >= 0; }],
    ["type:macro", "The wider economy", function (c) { return c.types.indexOf("macro") >= 0; }],
    ["type:smart_money", "What big investors do", function (c) { return c.types.indexOf("smart_money") >= 0; }],
    ["type:gut", "A feeling", function (c) { return c.types.indexOf("gut") >= 0; }],
    ["specific", "Names a concrete fact, number or event", function (c) { return c.specific; }],
    ["hedged", "Hedged wording (maybe, might)", function (c) { return c.tone === "hedged"; }],
    ["emotion", "Emotional words (fear, greed, FOMO)", function (c) { return c.emotion.length > 0; }],
    ["horizon", "States how long it expects to hold", function (c) { return c.horizon != null; }]
  ];

  // items: collect(); cache: key -> classification; R: report with R.calls.
  // For each feature: the calls whose note has it against those without, on the
  // 63-day return against the NASDAQ from the call (the same measure as question 5)
  // and on how often the call led to a buy. 99% ranges: many features are compared.
  function stats(R, items, cache) {
    const byCall = {};
    (R.calls || []).forEach(function (c) { byCall[c.ticker + "|" + c.ts] = c; });
    const rows = items.map(function (it) { const c = cache[it.key]; return c ? { it: it, c: c, call: byCall[it.id] || null } : null; }).filter(Boolean);
    const withOutcome = rows.filter(function (r) { return r.call; });
    const mixed = rows.filter(function (r) { return (r.it.sentiment === "positive" && r.c.stance === "bearish") || (r.it.sentiment === "negative" && r.c.stance === "bullish"); }).length;
    const out = { notes: items.length, classified: rows.length, withOutcome: withOutcome.length, mixed: mixed, features: [], need: NEED };
    FEATURES.forEach(function (f, i) {
      const w = withOutcome.filter(function (r) { return f[2](r.c); }), o = withOutcome.filter(function (r) { return !f[2](r.c); });
      const mw = w.map(function (r) { return r.call.ex; }), mo = o.map(function (r) { return r.call.ex; });
      const row = { key: f[0], label: f[1], count: rows.filter(function (r) { return f[2](r.c); }).length, nWith: w.length, nWithout: o.length, nSmall: Math.min(w.length, o.length),
        meanWith: S.mean(mw), meanWithout: S.mean(mo), boughtWith: S.wilson(w.filter(function (r) { return r.call.bought; }).length, w.length), boughtWithout: S.wilson(o.filter(function (r) { return r.call.bought; }).length, o.length) };
      row.status = S.status(row.nSmall, NEED);
      if (mw.length >= 2 && mo.length >= 2) { row.diff = S.bootstrap(mw, mo, 2000, 71 + i, 0.99); row.clear = row.status !== "none" && S.excludesZero(row.diff); }
      out.features.push(row);
    });
    out.clear = out.features.some(function (r) { return r.clear; });
    const best = out.features.reduce(function (m, r) { return Math.max(m, r.nSmall); }, 0);
    out.status = S.status(best, NEED);
    return out;
  }

  const api = { collect: collect, classify: classify, stats: stats, loadCache: loadCache, saveCache: saveCache, clearCache: clearCache, hash: hash, FEATURES: FEATURES, NEED: NEED };
  if (typeof self !== "undefined") self.ATRationale = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
