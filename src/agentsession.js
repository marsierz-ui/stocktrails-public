(function () {
  // Viewing sessions of a stock, for the AI agent's live verdict on stock pages (issue #30).
  // A session is the views and dwell pings of one stock across all tabs. It ends END_MS after the
  // last activity; the agent then decides it in the background (src/background.js opens the
  // dashboard headless, dashboard/shadow.js trAgentHeadless). Activity within CONTINUE_MS of the end
  // continues the same session: its views are merged and, if the agent already decided its moment,
  // it is asked again (at most MAX_REDECIDE times per moment). Pure functions: tested in node
  // (tools/test-agent-session.js), used by the service worker and the dashboard.
  const END_MS = 60000, CONTINUE_MS = 5 * 60000, MAX_REDECIDE = 3, KEEP_MS = 3 * 86400000, MAX_PAGES = 20;

  // One view ("view") or dwell ping ("dwell", meta.ms) of ticker at ts. Returns a new sessions object.
  // A session: { ticker, start, lastTs, views, dwellMs, pages, parts, momentId, ranAt, ranViews, redecided }.
  function touch(sessions, ticker, ts, kind, meta) {
    const T = String(ticker || "").toUpperCase();
    if (!T) return sessions;
    const out = Object.assign({}, sessions), s0 = out[T];
    meta = meta || {};
    let s;
    if (s0 && ts - s0.lastTs <= END_MS + CONTINUE_MS && ts >= s0.start) {
      s = Object.assign({}, s0, { pages: (s0.pages || []).slice() });
      // activity after the session ended (and after it was decided) is a continuation
      if (ts - s0.lastTs > END_MS) s.parts = (s0.parts || 1) + 1;
      s.lastTs = Math.max(s0.lastTs, ts);
    } else {
      s = { ticker: T, start: ts, lastTs: ts, views: 0, dwellMs: 0, pages: [], parts: 1, momentId: null, ranAt: null, ranViews: 0, redecided: 0 };
    }
    if (kind === "view") {
      s.views++;
      const p = meta.page ? String(meta.page).slice(0, 120) : null;
      if (p && s.pages.indexOf(p) < 0 && s.pages.length < MAX_PAGES) s.pages.push(p);
    } else if (kind === "dwell" && meta.ms > 0) s.dwellMs += meta.ms;
    out[T] = s;
    return out;
  }

  // When to look again at a session: END_MS after its last activity.
  function dueAt(s) { return s.lastTs + END_MS; }

  // Sessions that have ended and have activity the agent has not seen: never ran, or views or dwell came in after its run.
  function due(sessions, now) {
    return Object.keys(sessions).filter(function (T) {
      const s = sessions[T];
      return now >= dueAt(s) && (s.ranAt == null || s.lastTs > s.ranAt);
    });
  }

  // Drops sessions older than KEEP_MS (the agent decides nothing older than 2 days).
  function prune(sessions, now) {
    const out = {};
    Object.keys(sessions).forEach(function (T) { if (now - sessions[T].lastTs <= KEEP_MS) out[T] = sessions[T]; });
    return out;
  }

  // The result of a headless run for a session: the moment it belongs to (or null) and when it ran.
  function markRan(sessions, T, r) {
    const s0 = sessions[T];
    if (!s0) return sessions;
    const out = Object.assign({}, sessions);
    out[T] = Object.assign({}, s0, { ranAt: r.ranAt, ranViews: s0.views, momentId: r.momentId != null ? r.momentId : s0.momentId, redecided: r.redecided != null ? r.redecided : s0.redecided });
    return out;
  }

  // The moment of a session among the AI agent's candidates (looks, pending looks, repeat-view bursts):
  // the session's own moment when it already has one, else the latest of this stock whose time falls
  // inside the session. Returns the candidate or null.
  function momentFor(cands, s) {
    let best = null;
    (cands || []).forEach(function (c) {
      if (!c || String(c.ticker || "").toUpperCase() !== s.ticker || c.kind === "trade") return;
      if (s.momentId && c.id === s.momentId) { best = c; return; }
      if (best && s.momentId && best.id === s.momentId) return;
      if (c.t >= s.start - 1000 && c.t <= s.lastTs && (!best || c.t > best.t)) best = c;
    });
    return best;
  }

  // Ask again? The moment was decided before activity of this session that the decision did not see,
  // and it was asked again fewer than MAX_REDECIDE times.
  function needsRedecide(s, decision, redecided) {
    if (!decision || decision.action === "unsure" || decision.supersededAt) return false;
    return s.lastTs > decision.decidedAt && (redecided || 0) < MAX_REDECIDE;
  }

  // Ask an unsure moment again? Only when what the model would be shown now differs from what it was shown
  // for its latest unsure answer (the saved input; keys sorted, since a synced record may come back reordered).
  function askAgainUnsure(unsure, input) {
    if (!unsure || !unsure.input) return true;
    const canon = function (v) {
      if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
      if (v && typeof v === "object") return "{" + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort().map(function (k) { return JSON.stringify(k) + ":" + canon(v[k]); }).join(",") + "}";
      return JSON.stringify(v === undefined ? null : v);
    };
    return canon(unsure.input) !== canon(input);
  }

  // An AI decision saved before sizes were weights (no sizeUnit), about a moment still inside the live window: dropped once and asked
  // again (dashboard/shadow.js trAgentMigrateSizes). An unsure answer never has a sizeUnit and decided nothing: it is never dropped,
  // or every unsure answer would be deleted and asked again, round after round.
  function needsSizeMigration(d, now, liveMs) {
    return !!d && d.agent === "ai" && !d.sizeUnit && d.action !== "hold" && d.action !== "unsure" && now - d.t <= liveMs;
  }

  // What the model is told about the session: counts only, no times (the request speaks in "day N").
  function summary(s) {
    return { views: s.views, minutesOnPage: Math.round(s.dwellMs / 6000) / 10, pages: (s.pages || []).length, returns: Math.max(0, (s.parts || 1) - 1) };
  }

  // The record kept of an earlier answer when a moment is decided again: same fields, its own id.
  function supersededCopy(d, at) {
    return Object.assign({}, d, { id: d.id + "|prev|" + d.decidedAt, momentId: d.id, supersededAt: at });
  }

  const api = { touch: touch, due: due, dueAt: dueAt, prune: prune, markRan: markRan, momentFor: momentFor, needsRedecide: needsRedecide, askAgainUnsure: askAgainUnsure, needsSizeMigration: needsSizeMigration, summary: summary, supersededCopy: supersededCopy,
    END_MS: END_MS, CONTINUE_MS: CONTINUE_MS, MAX_REDECIDE: MAX_REDECIDE };
  if (typeof self !== "undefined") self.ATAgentSession = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
