(function () {
  // Option B: Google accounts + Supabase cloud sync. Provider-isolated so a future
  // migration only touches this file. Reuses the store's collectChanges/applyRemote
  // merge logic; talks to Supabase tables (RLS scopes rows to the signed-in user).
  let client = null;

  // Sync protocol version. Bumping it makes every install run one full reconcile
  // (push everything, pull everything) on its next sync, which is how installs
  // that have already drifted apart get merged back together.
  const SYNC_PROTOCOL = 3; // 3: keyset paging; re-pull rows offset paging skipped
  const PAGE_ROWS = 1000;        // PostgREST truncates a response at 1000 rows
  const PUSH_CHUNK = 200;        // rows per upsert request
  const DEEP_SYNC_MS = 86400000; // full reconcile once a day, as a backstop
  // The server stamps synced_at from now() (transaction start), so a transaction
  // that starts before another one and commits after it can become visible after
  // a later timestamp has already been read. Rewinding the cursor by this much
  // re-reads that window; re-reading a row is free (last-write-wins merge).
  const CURSOR_OVERLAP_MS = 5000;
  // null = not probed yet, false = this project has no synced_at column (the
  // 20260813_server_sync_cursor migration has not been run), true = present.
  let serverCursor = null;

  function enabled() { return !!(self.supabase && self.AT_SUPABASE_URL && self.AT_SUPABASE_ANON); }
  // A service worker has no window/localStorage and no OAuth redirect URL, so it
  // must not persist/detect sessions the browser way. It restores the session
  // shared by the page (restoreSession) instead. The page keeps the normal flow.
  function isServiceWorker() {
    return typeof window === "undefined" && typeof importScripts === "function";
  }
  function getClient() {
    if (!enabled()) return null;
    if (!client) {
      // The web app uses PKCE: with the implicit flow, any link to the app carrying
      // #access_token=... signed the visitor into the account those tokens belong to
      // (no state check), so their next captures went to someone else's account.
      // A PKCE return is accepted only by the browser that started the sign-in.
      // The extension keeps the implicit flow: its redirect (chromiumapp.org) only
      // reaches launchWebAuthFlow, and no web page can navigate to its dashboard.
      const web = typeof location !== "undefined" && /^https?:$/.test(location.protocol);
      const auth = isServiceWorker()
        ? { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
        : { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: web ? "pkce" : "implicit" };
      client = self.supabase.createClient(self.AT_SUPABASE_URL, self.AT_SUPABASE_ANON, { auth: auth });
    }
    return client;
  }
  async function getUser() {
    const c = getClient(); if (!c) return null;
    const { data } = await c.auth.getUser();
    return data ? data.user : null;
  }

  // Background-worker support (#5): the service worker has no localStorage, so the
  // signed-in session is shared through an IndexedDB store of the extension (or
  // PWA) origin. Content scripts run in the host page's origin and cannot open it,
  // unlike chrome.storage.local, which they can read. storage.local only holds the
  // non-secret at_cloud_signed_in flag that the worker, popup and widget gate on.
  // Not chrome.storage.session: it is cleared on browser restart and extension
  // update, which would stop capture until the dashboard is opened again.
  // The page persists the session after sign-in / each sync; the worker restores it.
  const AUTH_DB = "stocktrails_auth", AUTH_STORE = "session", AUTH_KEY = "cur";
  const SIGNED_IN = "at_cloud_signed_in", LEGACY_SESSION = "at_cloud_session";
  function hasStorage() { return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local; }
  function authDB(mode, fn) {
    return new Promise(function (res, rej) {
      const r = indexedDB.open(AUTH_DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(AUTH_STORE); };
      r.onerror = function () { rej(r.error); };
      r.onsuccess = function () {
        const db = r.result, tx = db.transaction(AUTH_STORE, mode), rq = fn(tx.objectStore(AUTH_STORE));
        tx.oncomplete = function () { db.close(); res(rq.result); };
        tx.onerror = function () { db.close(); rej(tx.error); };
      };
    });
  }
  function readTokens() { return authDB("readonly", function (os) { return os.get(AUTH_KEY); }); }
  function writeTokens(s) {
    return authDB("readwrite", function (os) { return os.put({ access_token: s.access_token, refresh_token: s.refresh_token }, AUTH_KEY); });
  }
  function clearTokens() { return authDB("readwrite", function (os) { return os.delete(AUTH_KEY); }); }

  async function persistSession() {
    try {
      if (!hasStorage()) return;
      const c = getClient(); if (!c) return;
      const res = await c.auth.getSession();
      const s = res && res.data && res.data.session;
      if (s && s.access_token && s.refresh_token) {
        await writeTokens(s);
        await chrome.storage.local.set({ [SIGNED_IN]: true });
        await chrome.storage.local.remove(LEGACY_SESSION); // installs that predate the IndexedDB store
      }
    } catch (e) { /* best-effort */ }
  }
  // Installs from before 0.4.0 kept the tokens in storage.local. Move them once.
  async function migrateSession() {
    try {
      if (!hasStorage()) return;
      const r = await chrome.storage.local.get(LEGACY_SESSION);
      const s = r && r[LEGACY_SESSION];
      if (!s) return;
      if (s.access_token && s.refresh_token) {
        await writeTokens(s);
        await chrome.storage.local.set({ [SIGNED_IN]: true });
      }
      await chrome.storage.local.remove(LEGACY_SESSION);
    } catch (e) { /* best-effort */ }
  }
  async function restoreSession() {
    try {
      if (!hasStorage()) return;
      await migrateSession();
      const s = await readTokens();
      if (s && s.access_token && s.refresh_token) {
        const c = getClient(); if (c) await c.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
      }
    } catch (e) { /* best-effort */ }
  }

  // Account isolation: if a DIFFERENT account is now signed in on this device,
  // drop the previous account's local data and force a full re-pull so accounts
  // never share or cross-contaminate the device-local store.
  async function reconcileAccount(uid) {
    const cfg = await self.ATStore.getSyncConfig();
    if (cfg.accountId !== uid) {
      if (cfg.accountId) { // a different account owned this device
        await self.ATStore.resetLocalData();
        clearAiTraces();
      }
      // Both cursors have to go: keeping either one would make the new account's
      // first sync an incremental one and skip everything recorded before it.
      await self.ATStore.setSyncConfig({ accountId: uid, cloudCursor: 0, cloudSyncedAt: null });
    }
  }

  // The AI assistant's log, and whether it may use real stock names, belong to the
  // account that was signed in (localStorage; absent in the service worker).
  function clearAiTraces() {
    try { if (self.ATAI) ATAI.clearLog(); localStorage.removeItem("at_ai_names"); } catch (e) { /* no localStorage here */ }
  }

  // A stored session whose refresh token has died leaves the shared session in
  // place, so trySync returns handled:false. Sync then stops there (sync.js never
  // falls back to a token server while Supabase is configured), so the extension
  // kept capturing data it could never upload. Record it instead: this flag is
  // what gates capture and raises the re-auth prompt.
  async function markAuthExpired(reason) {
    try { await self.ATStore.setSyncConfig({ authExpired: true, lastError: reason }); } catch (e) { /* best-effort */ }
  }

  async function ensureHostPermission() {
    // Extension only: allow fetches to the Supabase origin.
    if (typeof chrome === "undefined" || !chrome.permissions || !chrome.permissions.request) return true;
    try { return await chrome.permissions.request({ origins: [new URL(self.AT_SUPABASE_URL).origin + "/*"] }); }
    catch (e) { return true; }
  }

  async function signIn() {
    const c = getClient(); if (!c) throw new Error("Supabase not configured");
    await ensureHostPermission();
    const isExtension = (typeof chrome !== "undefined" && chrome.identity && chrome.identity.launchWebAuthFlow);
    if (isExtension) {
      const redirectTo = chrome.identity.getRedirectURL();
      const { data, error } = await c.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo, skipBrowserRedirect: true } });
      if (error) throw error;
      const redirect = await chrome.identity.launchWebAuthFlow({ url: data.url, interactive: true });
      const params = new URLSearchParams(new URL(redirect).hash.replace(/^#/, ""));
      const { error: e2 } = await c.auth.setSession({ access_token: params.get("access_token"), refresh_token: params.get("refresh_token") });
      if (e2) throw e2;
    } else {
      // PWA / web: standard redirect; session is picked up on return.
      const { error } = await c.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
      if (error) throw error;
    }
    return finishSignIn();
  }

  // E-mail and password, as an alternative to Google. create=true registers the
  // address; while Supabase waits for the confirmation link there is no session
  // yet, and null is returned (the caller asks the user to confirm, then sign in).
  async function signInEmail(email, password, create) {
    const c = getClient(); if (!c) throw new Error("Supabase not configured");
    await ensureHostPermission();
    if (create) {
      const web = typeof location !== "undefined" && /^https?:$/.test(location.protocol);
      // The extension page cannot be a link target, so its confirmation link opens the web app.
      const back = web ? location.origin + location.pathname : "https://marsierz-ui.github.io/attention-tracker/dashboard/dashboard.html";
      const { data, error } = await c.auth.signUp({ email: email, password: password, options: { emailRedirectTo: back } });
      if (error) throw error;
      if (!data || !data.session) return null;
    } else {
      const { error } = await c.auth.signInWithPassword({ email: email, password: password });
      if (error) throw error;
    }
    return finishSignIn();
  }

  async function finishSignIn() {
    const u = await getUser();
    if (u) {
      await reconcileAccount(u.id); // isolate: drop another account's local data on switch
      // Clear the gate here rather than waiting for the next 5-minute sync, so
      // capture resumes the moment the user signs back in.
      await self.ATStore.setSyncConfig({ authExpired: false, lastError: "" });
    }
    await persistSession(); // share session with the background worker (#5)
    return u;
  }

  async function signOut() {
    const c = getClient();
    if (c) {
      let r;
      try { r = await c.auth.signOut(); } catch (e) { r = { error: e }; }
      // /logout failed (offline, outage): supabase-js then keeps the stored
      // session, so drop it here (as mobile/lib/auth.ts does).
      if (r && r.error) { try { localStorage.removeItem(c.auth.storageKey); } catch (e) { /* ignore */ } }
    }
    clearAiTraces();
    // Clear the shared session so the worker/popup/widget re-gate immediately.
    try { await clearTokens(); } catch (e) { /* ignore */ }
    try { if (hasStorage()) await chrome.storage.local.remove([SIGNED_IN, LEGACY_SESSION]); } catch (e) { /* ignore */ }
    // Clear this device's local data so the next account starts clean.
    try { await self.ATStore.resetLocalData(); } catch (e) { /* ignore */ }
  }

  // GROUP 1/5: new analytics fields are additive. sentiment_changed_at is a
  // TIMESTAMPTZ column, so convert to/from epoch-ms at the boundary. portal_path
  // is intraday-only, so it is only emitted when isIntraday is true.
  function mapEventOut(uid, e, deleted, isIntraday) {
    if (deleted) return { user_id: uid, id: e.id, updated_at: e.updatedAt, deleted: true };
    const row = {
      user_id: uid, id: e.id, ticker: e.ticker, ts: e.ts, source: e.source, url: e.url, sentiment: e.sentiment,
      price_at_event: e.priceAtEvent == null ? null : e.priceAtEvent,
      dwell_ms: e.dwellMs == null ? 0 : e.dwellMs,
      scroll_depth: e.scrollDepth == null ? null : e.scrollDepth,
      focus_switches: e.focusSwitches == null ? null : e.focusSwitches,
      sector: e.sector == null ? null : e.sector,
      industry: e.industry == null ? null : e.industry,
      market_cap: e.marketCap == null ? null : Math.round(e.marketCap), // bigint column: a fractional value fails the whole batch
      market_cap_bucket: e.marketCapBucket == null ? null : e.marketCapBucket,
      week52_position: e.week52Position == null ? null : e.week52Position,
      sentiment_prev: e.sentimentPrev == null ? null : e.sentimentPrev,
      sentiment_changed_at: e.sentimentChangedAt == null ? null : new Date(e.sentimentChangedAt).toISOString(),
      position_taken: e.positionTaken == null ? null : e.positionTaken,
      target_price: e.targetPrice == null ? null : e.targetPrice,
      rationale: e.rationale == null ? null : e.rationale,
      horizon_days: e.horizonDays == null ? null : e.horizonDays,
      market_session: e.marketSession == null ? null : e.marketSession,
      research_type: e.researchType == null ? null : e.researchType,
      section: e.section == null ? null : e.section,
      price_fetch_failed: e.priceFetchFailed == null ? false : e.priceFetchFailed,
      updated_at: e.updatedAt, deleted: false
    };
    if (isIntraday) {
      row.portal_path = e.portalPath == null ? null : e.portalPath;
      if (e.sessionId != null) row.session_id = e.sessionId; // else DB DEFAULT assigns one
    } else {
      row.views = e.views == null ? 1 : e.views; // events-only column
    }
    return row;
  }
  function mapRowIn(r) {
    return {
      id: r.id, ticker: r.ticker, ts: r.ts, source: r.source, url: r.url, sentiment: r.sentiment,
      priceAtEvent: r.price_at_event, views: r.views == null ? 1 : r.views, dwellMs: r.dwell_ms || 0,
      scrollDepth: r.scroll_depth == null ? null : r.scroll_depth,
      focusSwitches: r.focus_switches == null ? null : r.focus_switches,
      researchType: r.research_type == null ? null : r.research_type,
      section: r.section == null ? null : r.section,
      sector: r.sector == null ? null : r.sector,
      industry: r.industry == null ? null : r.industry,
      marketCap: r.market_cap == null ? null : r.market_cap,
      marketCapBucket: r.market_cap_bucket == null ? null : r.market_cap_bucket,
      week52Position: r.week52_position == null ? null : r.week52_position,
      sentimentPrev: r.sentiment_prev == null ? null : r.sentiment_prev,
      sentimentChangedAt: r.sentiment_changed_at == null ? null : Date.parse(r.sentiment_changed_at),
      positionTaken: r.position_taken == null ? null : r.position_taken,
      targetPrice: r.target_price == null ? null : r.target_price,
      rationale: r.rationale == null ? null : r.rationale,
      horizonDays: r.horizon_days == null ? null : r.horizon_days,
      marketSession: r.market_session == null ? null : r.market_session,
      priceFetchFailed: r.price_fetch_failed == null ? false : r.price_fetch_failed,
      sessionId: r.session_id == null ? null : r.session_id,
      portalPath: r.portal_path == null ? null : r.portal_path,
      updatedAt: r.updated_at
    };
  }

  // ---- push/pull plumbing ----

  // One upsert per chunk: a full reconcile pushes the whole local history, which
  // is far more rows than a single request should carry.
  async function upsertAll(c, table, rows) {
    for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
      const r = await c.from(table).upsert(rows.slice(i, i + PUSH_CHUNK));
      if (r.error) throw r.error;
    }
  }

  function missingSyncedAt(e) {
    return !!e && (e.code === "42703" || /synced_at/.test(String(e.message || "")));
  }

  // Pull by server arrival order (synced_at), paging past the 1000-row response
  // cap. `since` is an ISO timestamp or null for "everything". Ordering matters
  // twice over: it makes paging stable, and it stops a truncated response from
  // hiding old rows behind new ones.
  // Pages by keyset (after the last row seen), not by offset: another device
  // updating a row mid-pull re-stamps it to the end, which shifted an offset
  // window past rows that were then older than the cursor and never pulled.
  async function pullRows(c, table, uid, since) {
    const out = [];
    let last = null;
    for (;;) {
      let q = c.from(table).select("*").eq("user_id", uid)
        .order("synced_at", { ascending: true }).order("id", { ascending: true })
        .limit(PAGE_ROWS);
      if (since) q = q.gt("synced_at", since);
      if (last) q = q.or('synced_at.gt."' + last.synced_at + '",and(synced_at.eq."' + last.synced_at + '",id.gt."' + last.id + '")');
      const r = await q;
      if (r.error) throw r.error;
      const rows = r.data || [];
      for (let i = 0; i < rows.length; i++) out.push(rows[i]);
      if (rows.length < PAGE_ROWS) return out;
      last = rows[rows.length - 1];
    }
  }

  // Pre-migration fallback: the old updated_at cursor. Kept so a client that
  // ships ahead of the migration still syncs (it just keeps the old blind spot,
  // which the daily full reconcile then papers over).
  async function pullRowsLegacy(c, table, uid, sinceMs) {
    const r = await c.from(table).select("*").eq("user_id", uid).gt("updated_at", sinceMs || 0);
    if (r.error) throw r.error;
    return r.data || [];
  }

  // Newest arrival in a result set, rewound by the overlap, as an ISO string.
  function nextCursorFrom(rowSets, fallback) {
    let max = 0;
    rowSets.forEach(function (rows) {
      (rows || []).forEach(function (r) {
        const t = r && r.synced_at ? Date.parse(r.synced_at) : 0;
        if (t > max) max = t;
      });
    });
    if (!max) return fallback;
    const rewound = new Date(max - CURSOR_OVERLAP_MS).toISOString();
    // Never move the cursor backwards: a stale row cannot re-open a closed window.
    if (fallback && Date.parse(fallback) >= Date.parse(rewound)) return fallback;
    return rewound;
  }

  // Returns { handled, result }. handled=false means "not signed in / not enabled"
  // so the caller can fall back to the token server.
  async function trySync() {
    if (!enabled()) return { handled: false }; // cloud not configured: not an auth failure
    // Guard client creation/auth so a supabase bundle that cannot run in the
    // service worker degrades to the token server instead of breaking sync.
    let c, user;
    try {
      c = getClient();
      user = await getUser();
      if (!user) { await restoreSession(); user = await getUser(); } // SW path
    } catch (e) {
      await markAuthExpired("cloud auth failed: " + (e && e.message || e));
      return { handled: false };
    }
    if (!c) return { handled: false };
    if (!user) { await markAuthExpired("Session expired. Sign in again to resume tracking."); return { handled: false }; }
    const uid = user.id;
    try {
      await reconcileAccount(uid); // BEFORE any push: never push one account's local data to another
      const cfg = await self.ATStore.getSyncConfig();
      const startedAt = Date.now();
      // A full reconcile ignores both cursors: push every local row, pull every
      // server row. It runs after a protocol bump (so installs that already
      // drifted apart merge on upgrade) and once a day after that, so a gap from
      // any cause - clock jump, interrupted push, a bug not yet found - closes by
      // itself instead of living in the data forever.
      let full = cfg.syncProtocol !== SYNC_PROTOCOL || (startedAt - (cfg.deepSyncAt || 0)) > DEEP_SYNC_MS;
      if (!full && !cfg.cloudSyncedAt && serverCursor !== false) full = true; // first sync on the new cursor
      const pushSince = full ? 0 : (cfg.cloudCursor || 0);
      const pullSince = full ? null : (cfg.cloudSyncedAt || null);
      let data = await self.ATStore.getAll();
      const changes = self.ATStore.collectChanges(data, pushSince);

      // push
      const evRows = changes.events.map(function (e) { return mapEventOut(uid, e, false); })
        .concat(Object.keys(changes.deletions.events).map(function (id) { return { user_id: uid, id: id, updated_at: changes.deletions.events[id], deleted: true }; }));
      await upsertAll(c, "events", evRows);
      const inRows = changes.intraday.map(function (e) { return mapEventOut(uid, e, false, true); })
        .concat(Object.keys(changes.deletions.intraday).map(function (id) { return { user_id: uid, id: id, updated_at: changes.deletions.intraday[id], deleted: true }; }));
      await upsertAll(c, "intraday", inRows);
      if (changes.meta) {
        const r = await c.from("user_meta").upsert({ user_id: uid, config: { overrides: changes.meta.overrides, customPortals: changes.meta.customPortals, settings: changes.meta.settings }, updated_at: changes.meta.updatedAt });
        if (r.error) throw r.error;
      }
      // GROUP E4: push the navigation log entries past the cursor (id = conflict key).
      if (changes.featureUsageLog && changes.featureUsageLog.length) {
        await upsertAll(c, "feature_usage", changes.featureUsageLog.map(function (e) { return { id: e.id, user_id: uid, section: e.section, ts: new Date(e.ts).toISOString() }; }));
      }

      // pull: by server arrival (synced_at), so a row that reaches the cloud late
      // is still delivered to every other install.
      const NO_CURSOR = "Server sync cursor missing - run supabase/migrations/20260813_server_sync_cursor.sql";
      let evData, inData, metaRow, warn = "", nextSynced = cfg.cloudSyncedAt || null;
      if (serverCursor === false) {
        warn = NO_CURSOR;
        const legacySince = full ? 0 : (cfg.cloudCursor || 0);
        evData = await pullRowsLegacy(c, "events", uid, legacySince);
        inData = await pullRowsLegacy(c, "intraday", uid, legacySince);
        const m = await c.from("user_meta").select("*").eq("user_id", uid).gt("updated_at", legacySince).maybeSingle();
        metaRow = m.data;
      } else {
        try {
          evData = await pullRows(c, "events", uid, pullSince);
          inData = await pullRows(c, "intraday", uid, pullSince);
          let mq = c.from("user_meta").select("*").eq("user_id", uid);
          if (pullSince) mq = mq.gt("synced_at", pullSince);
          const m = await mq.maybeSingle();
          if (m.error) throw m.error;
          metaRow = m.data;
          serverCursor = true;
          nextSynced = nextCursorFrom([evData, inData, metaRow ? [metaRow] : []], nextSynced);
        } catch (e) {
          if (!missingSyncedAt(e)) throw e;
          // Client is ahead of the database: fall back for this run and say so.
          serverCursor = false;
          warn = NO_CURSOR;
          evData = await pullRowsLegacy(c, "events", uid, 0);
          inData = await pullRowsLegacy(c, "intraday", uid, 0);
          const m = await c.from("user_meta").select("*").eq("user_id", uid).maybeSingle();
          metaRow = m.data;
        }
      }

      const remote = {
        events: evData.filter(function (r) { return !r.deleted; }).map(mapRowIn),
        intraday: inData.filter(function (r) { return !r.deleted; }).map(mapRowIn),
        deletions: {
          events: evData.filter(function (r) { return r.deleted; }).reduce(function (o, r) { o[r.id] = r.updated_at; return o; }, {}),
          intraday: inData.filter(function (r) { return r.deleted; }).reduce(function (o, r) { o[r.id] = r.updated_at; return o; }, {})
        },
        meta: (metaRow && metaRow.config) ? Object.assign({ updatedAt: metaRow.updated_at }, metaRow.config) : null
      };
      data = await self.ATStore.getAll();
      const changed = self.ATStore.applyRemote(data, remote);
      if (changed) await self.ATStore.setAll(data);
      // GROUP E1/E4: best-effort adoption + last-seen-session tracking on user_meta.
      // Separate update (never bumps config/updated_at), so it cannot break data sync.
      try {
        let lastSess = self.ATStore.classifyMarketHours(Date.now());
        let anyPos = false, lastTarget = null, lastTs = -1, lastSessTs = -1;
        data.events.forEach(function (e) {
          if (e.positionTaken) anyPos = true;
          if (e.targetPrice != null && e.ts > lastTs) { lastTarget = e.targetPrice; lastTs = e.ts; }
          if (e.marketSession && e.ts > lastSessTs) { lastSess = e.marketSession; lastSessTs = e.ts; }
        });
        let dashMs = null;
        try {
          if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            const dr = await chrome.storage.local.get("at_dashboard_ms_v1");
            dashMs = (dr && dr.at_dashboard_ms_v1 != null) ? dr.at_dashboard_ms_v1 : null;
          }
        } catch (e) { /* ignore */ }
        const metaUpd = { last_seen_session: lastSess, position_taken: anyPos, target_price: lastTarget, last_ua: changes.ua || null, dashboard_ms: dashMs };
        // country: user_meta.country is the current value; record_country also
        // stamps the change into user_country so past rows keep the country they
        // were recorded in when the user moves.
        try {
          const cc = await resolveCountry();
          if (cc) { metaUpd.country = cc; await c.rpc("record_country", { p_country: cc }); }
        } catch (e) { /* ignore */ }
        await c.from("user_meta").update(metaUpd).eq("user_id", uid);
      } catch (e) { /* adoption tracking is best-effort */ }
      await self.ATStore.setSyncConfig({
        cloudCursor: startedAt,   // push watermark: this device's clock vs its own rows' updatedAt
        cloudSyncedAt: nextSynced, // pull watermark: the server's clock, shared by every device
        syncProtocol: SYNC_PROTOCOL,
        deepSyncAt: full ? startedAt : (cfg.deepSyncAt || startedAt),
        accountId: uid, lastSync: Date.now(), lastError: warn, authExpired: false
      });
      await persistSession(); // keep the shared session fresh for the worker
      return { handled: true, result: { ok: true, changed: changed } };
    } catch (e) {
      await self.ATStore.setSyncConfig({ lastError: "cloud: " + (e && e.message || e) });
      return { handled: true, result: { ok: false, reason: String(e && e.message || e) } };
    }
  }

  // World view: the user's country (ISO2). IP-based via the geo edge function
  // (cached 24h; only IP-derived results are cached), falling back to the
  // locale/timezone detector (vendor/tz-countries.js, loaded by pages only).
  // The cache TTL bounds how late a move is detected, and record_country() stamps
  // the interval boundary at detection time, so keep it short.
  async function geoCacheGet(KEY) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        const r = await chrome.storage.local.get(KEY);
        return r && r[KEY];
      }
      if (typeof localStorage !== "undefined") return JSON.parse(localStorage.getItem(KEY) || "null");
    } catch (e) { /* ignore */ }
    return null;
  }
  async function geoCacheSet(KEY, val) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ [KEY]: val });
      } else if (typeof localStorage !== "undefined") {
        localStorage.setItem(KEY, JSON.stringify(val));
      }
    } catch (e) { /* ignore */ }
  }
  // VPN: an IP that geolocates to a different country than the device clock's
  // timezone is recorded as "XV" (a user-assigned ISO code), which the World view
  // shows as its own VPN category. A VPN moves the IP but not the clock, while a
  // real trip moves both (OS time zones follow location). The geo function
  // already returns XV for datacenter / VPN-provider networks. Known false
  // positive: a manually pinned clock, or roaming data routed via the home
  // country. The TTL is 3h so a VPN session is caught (and left) promptly; the
  // key was bumped so a pre-VPN-detection cache entry is not reused.
  // Switching behaviour (A -> B -> A within 72h, several hops a week) is judged
  // server-side by record_country, over the recorded intervals.
  const FIX_KEY = "at_geo_fix";
  function haversineKm(la1, lo1, la2, lo2) {
    const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function deviceTzCountry() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return (self.ATGeo && self.ATGeo.tzCountry && self.ATGeo.tzCountry[tz]) || null;
    } catch (e) { return null; }
  }
  async function resolveCountry() {
    const KEY = "at_geo_v2", TTL = 3 * 3600000;
    const g = await geoCacheGet(KEY);
    if (g && g.country && Date.now() - g.ts < TTL) return g.country;
    let country = null;
    try {
      if (self.AT_SUPABASE_FUNCTIONS) {
        // This runs inside trySync (blocks app boot after sign-in): keep a hard
        // timeout so a hung edge function cannot stall the sync path.
        const ctl = new AbortController();
        const t = setTimeout(function () { ctl.abort(); }, 5000);
        const res = await fetch(self.AT_SUPABASE_FUNCTIONS.replace(/\/+$/, "") + "/geo", { signal: ctl.signal });
        clearTimeout(t);
        if (res.ok) {
          const j = await res.json();
          if (j && /^[A-Z]{2}$/.test(j.country || "")) country = j.country;
          const dev = deviceTzCountry();
          if (country && country !== "XV" && dev && j.ip_country && dev !== j.ip_country) country = "XV";
          // Impossible travel: a new country further from the last genuine fix
          // than anyone can get in the time between (faster than a plane).
          // The baseline only moves on a fix that passed every check, so a VPN
          // exit never becomes the reference point.
          if (country && country !== "XV" && typeof j.ip_lat === "number" && typeof j.ip_lon === "number") {
            const last = await geoCacheGet(FIX_KEY);
            const km = last ? haversineKm(last.lat, last.lon, j.ip_lat, j.ip_lon) : 0;
            const hours = last ? Math.max(0.25, (Date.now() - last.ts) / 3600000) : 0;
            if (last && last.cc !== country && km > 300 && km / hours > 1000) country = "XV";
            else await geoCacheSet(FIX_KEY, { lat: j.ip_lat, lon: j.ip_lon, ts: Date.now(), cc: country });
          }
        }
      }
    } catch (e) { /* ignore */ }
    if (country) {
      await geoCacheSet(KEY, { country: country, ts: Date.now() }); // cache only IP-derived results
      return country;
    }
    try { return (self.ATGeo && self.ATGeo.detectCountry()) || null; } catch (e) { return null; }
  }

  async function submitFeedback(text, screenshot, url) {
    const c = getClient(); if (!c) throw new Error("cloud not configured");
    const u = await getUser(); if (!u) throw new Error("sign in first");
    const r = await c.from("feedback").insert({ user_id: u.id, text: text, url: url || "", screenshot: screenshot || "", created_at: Date.now() });
    if (r.error) throw r.error;
    return true;
  }

  // ---- admin (works only for profiles.is_admin; gated by RLS + RPC guards) ----
  async function isAdmin() {
    const c = getClient(); if (!c) return false;
    const u = await getUser(); if (!u) return false;
    const { data } = await c.from("profiles").select("is_admin").eq("id", u.id).maybeSingle();
    return !!(data && data.is_admin);
  }
  async function adminUsers() { const c = getClient(); const r = await c.rpc("admin_user_stats"); if (r.error) throw r.error; return r.data || []; }
  async function adminTotals() { const c = getClient(); const r = await c.rpc("admin_totals"); if (r.error) throw r.error; return (r.data && r.data[0]) || { users: 0, events: 0 }; }
  async function adminTopTickers() { const c = getClient(); const r = await c.rpc("admin_top_tickers"); if (r.error) throw r.error; return r.data || []; }
  async function adminSentiment() { const c = getClient(); const r = await c.rpc("admin_sentiment"); if (r.error) throw r.error; return r.data || []; }
  async function adminUserEvents(uid) {
    const c = getClient();
    const r = await c.from("events").select("id,ticker,ts,source,sentiment,price_at_event,views").eq("user_id", uid).eq("deleted", false).order("ts", { ascending: false }).limit(2000);
    if (r.error) throw r.error; return r.data || [];
  }
  async function adminFeedback() {
    const c = getClient();
    const r = await c.from("feedback").select("*").order("created_at", { ascending: false }).limit(500);
    if (r.error) throw r.error; return r.data || [];
  }
  async function adminUpdateFeedback(id, patch) {
    const c = getClient();
    const r = await c.from("feedback").update(patch).eq("id", id);
    if (r.error) throw r.error; return true;
  }

  // Redirect sign-in (PWA / web) completes on a *later page load*, so nothing
  // after signIn() runs. Subscribing lets the page react when the session
  // actually lands instead of only checking once at boot.
  function onAuthChange(cb) {
    const c = getClient(); if (!c) return function () {};
    const sub = c.auth.onAuthStateChange(function (event, session) { cb(event, session); });
    return function () { try { sub.data.subscription.unsubscribe(); } catch (e) { /* ignore */ } };
  }

  const api = {
    enabled: enabled, migrateSession: migrateSession, getUser: getUser, signIn: signIn, signInEmail: signInEmail, signOut: signOut, trySync: trySync, submitFeedback: submitFeedback,
    onAuthChange: onAuthChange,
    isAdmin: isAdmin, adminUsers: adminUsers, adminTotals: adminTotals, adminTopTickers: adminTopTickers,
    adminSentiment: adminSentiment, adminUserEvents: adminUserEvents, adminFeedback: adminFeedback, adminUpdateFeedback: adminUpdateFeedback,
    // Feedback automation: hand an approved item to the AI agent (edge function).
    dispatchFeedback: function (id, opts) { opts = opts || {}; const c = getClient(); return c.functions.invoke("feedback-dispatch", { body: { feedback_id: id, model: opts.model, effort: opts.effort, comment: opts.comment } }).then(function (r) { if (r.error) throw r.error; return r.data; }); },
    // The opt-in AI assistant (edge function ai-coach, see docs/AI.md). Resolves with
    // the function's JSON, also for a refusal ({ ok: false, message }), so the page can
    // show the reason; only a failure to reach it at all throws.
    aiCoach: async function (body) {
      const c = getClient();
      if (!c) throw new Error("Sign in to use the assistant.");
      const r = await c.functions.invoke("ai-coach", { body: body });
      if (r.error) {
        let j = null;
        try { j = await r.error.context.json(); } catch (e) { /* no JSON body */ }
        if (j && j.error) return j;
        // No answer from our function: say what the status means instead of the library's generic text.
        const st = r.error.context && r.error.context.status;
        if (st === 404) return { ok: false, error: "not_deployed", message: "The AI service is not available yet: the ai-coach function is not deployed on this project." };
        if (st === 401) return { ok: false, error: "unauthorized", message: "Sign in to use the assistant." };
        if (st) return { ok: false, error: "http_" + st, message: "The AI service did not answer (HTTP " + st + ")." };
        throw r.error;
      }
      return r.data;
    },
    adminByHour: function () { return getClient().rpc("admin_by_hour").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminByWeekday: function () { return getClient().rpc("admin_by_weekday").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminDaily: function () { return getClient().rpc("admin_daily").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminExtras: function () { return getClient().rpc("admin_extras").then(function (r) { if (r.error) throw r.error; return (r.data && r.data[0]) || {}; }); },
    adminAttentionOverTime: function () { return getClient().rpc("admin_attention_over_time").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminOutlookOverTime: function () { return getClient().rpc("admin_outlook_over_time").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminStockDaily: function () { return getClient().rpc("admin_stock_daily").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminAttentionBuckets: function (f, t, u) { return getClient().rpc("admin_attention_buckets", { p_from: f, p_to: t, p_unit: u }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminOutlookBuckets: function (f, t, u) { return getClient().rpc("admin_outlook_buckets", { p_from: f, p_to: t, p_unit: u }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminStockBuckets: function (f, t, u) { return getClient().rpc("admin_stock_buckets", { p_from: f, p_to: t, p_unit: u }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminCalendar: function () { return getClient().rpc("admin_calendar").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    // GROUP 3 + GROUP 6 + GROUP 7 admin analytics wrappers.
    adminSentimentCalibration: function () { return getClient().rpc("admin_sentiment_calibration").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminPortalJourney: function () { return getClient().rpc("admin_portal_journey").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminAttentionVelocity: function () { return getClient().rpc("admin_attention_velocity").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    admin52wPositionBuckets: function () { return getClient().rpc("admin_52w_position_buckets").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminCohortRetention: function () { return getClient().rpc("admin_cohort_retention").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    // GROUP A-E admin analytics wrappers.
    adminPortalAttribution: function () { return getClient().rpc("admin_portal_attribution").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminFirstTouchAttribution: function () { return getClient().rpc("admin_first_touch_attribution").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminMarketSessionCalibration: function () { return getClient().rpc("admin_market_session_calibration").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminAttentionSpikes: function () { return getClient().rpc("admin_attention_spikes").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminWeekdayCalibration: function (h) { return getClient().rpc("admin_weekday_calibration", h != null ? { p_horizon_days: h } : {}).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminFeatureUsageOverTime: function (f, t, u) { return getClient().rpc("admin_feature_usage_over_time", { p_from: f, p_to: t, p_unit: u }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminSectorOverTime: function (f, t, u) { return getClient().rpc("admin_sector_over_time", { p_from: f, p_to: t, p_unit: u }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    // GROUP F admin wrappers.
    adminEngagementOverview: function () { return getClient().rpc("admin_engagement_overview").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminSentimentFunnel: function () { return getClient().rpc("admin_sentiment_funnel").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminUserQualityDistribution: function () { return getClient().rpc("admin_user_quality_distribution").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminPaperPortfolio: function () { return getClient().rpc("admin_paper_portfolio").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminReturnBySegment: function () { return getClient().rpc("admin_return_by_segment").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminTargetPriceAccuracy: function () { return getClient().rpc("admin_target_price_accuracy").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminFieldFillRates: function () { return getClient().rpc("admin_field_fill_rates").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminSyncHealth: function () { return getClient().rpc("admin_sync_health").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminSessionStats: function () { return getClient().rpc("admin_session_stats").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminSectorClustering: function () { return getClient().rpc("admin_sector_clustering").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminAttentionToActionLag: function () { return getClient().rpc("admin_attention_to_action_lag").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminRecurringVsDiscovery: function () { return getClient().rpc("admin_recurring_vs_discovery").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminWeekendUsage: function () { return getClient().rpc("admin_weekend_usage").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminConsensusSignals: function () { return getClient().rpc("admin_consensus_signals").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminLeadLagExport: function () { return getClient().rpc("admin_lead_lag_export").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminPlatformMetrics: function () { return getClient().rpc("admin_platform_metrics").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminFeatureUsage: function () { return getClient().rpc("admin_feature_usage").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminMarketingKpis: function () { return getClient().rpc("admin_marketing_kpis").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminMetricTotals: function () { return getClient().rpc("admin_metric_totals").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    adminMetricSeries: function (metric, f, t, u) { return getClient().rpc("admin_metric_series", { p_metric: metric, p_from: f, p_to: t, p_unit: u }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminAreaUsage: function () { return getClient().rpc("admin_area_usage").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    adminResearchEffectiveness: function () { return getClient().rpc("admin_research_effectiveness").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    // World/Network views: community aggregates (admin-gated while the tabs are admin-only).
    worldCountryDaily: function (days) { return getClient().rpc("world_country_daily", { p_days: days }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    worldTopStockDaily: function (days) { return getClient().rpc("world_country_top_stock_daily", { p_days: days }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    worldTrending: function () { return getClient().rpc("world_trending").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    networkPercentiles: function () { return getClient().rpc("network_percentiles").then(function (r) { if (r.error) throw r.error; return r.data || {}; }); },
    networkCommunityIndex: function () { return getClient().rpc("network_community_index").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    // Views and label counts per ticker per trading day, for the point-in-time
    // community index: one row per ticker, days as [day, views, pos, neg, labelled].
    networkCommunityDaily: function () { return getClient().rpc("network_community_daily").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    networkCommunitySentiment: function () { return getClient().rpc("network_community_sentiment").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    // Crowd overlap is the caller's own scalar (not admin-gated): powers the
    // Attention section for all users as well as the World tab.
    worldCrowdOverlap: function (days) { return getClient().rpc("world_crowd_overlap", { p_days: days }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    // Community totals per UTC day (users, views, dwell_ms), open to every user:
    // My Habits compares its own attention-vs-NASDAQ correlation against it.
    communityDailyAttention: function (days) { return getClient().rpc("community_daily_attention", { p_days: days }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    worldCountryCrowdSimilarity: function (days) { return getClient().rpc("world_country_crowd_similarity", { p_days: days }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    // Third-party attention lists (stockanalysis.com pageviews, Reddit mentions,
    // Stocktwits, Yahoo trending): one row per (source, day).
    // Bias indicators, phase 3: earnings release dates (card A8) and the community's
    // first looks per day (community herding in card A7).
    earningsFor: function (tickers, from) { return getClient().rpc("earnings_for", from ? { p_tickers: tickers, p_from: from } : { p_tickers: tickers }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    communityFirstLooks: function (days) { return getClient().rpc("community_first_looks_daily", { p_days: days }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    // Per-stock attention across the tracked platforms (no top-N cut), one row per
    // (source, day); tickers narrows it. "Back to earth": stocks that trended, that
    // the user looked at, and that have gone quiet. E-mail opt-in lives in crowd_notify.
    crowdStockDaily: function (tickers, days) { return getClient().rpc("crowd_stock_daily", { p_tickers: tickers || null, p_days: days || 60 }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    crowdSettled: function (days) { return getClient().rpc("crowd_settled", { p_days: days || 45 }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    crowdEmailGet: async function () { const u = await getUser(); if (!u) return null; const r = await getClient().from("crowd_notify").select("email_on").eq("user_id", u.id).maybeSingle(); if (r.error) throw r.error; return { on: !!(r.data && r.data.email_on), email: u.email || "" }; },
    crowdEmailSet: async function (on) { const u = await getUser(); if (!u) throw new Error("Sign in first"); const r = await getClient().from("crowd_notify").upsert({ user_id: u.id, email_on: !!on, updated_at: new Date().toISOString() }); if (r.error) throw r.error; },
    trendingDaily: function (days, top) { return getClient().rpc("trending_daily", { p_days: days, p_top: top }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    // Per (source, day): names captured and their summed views. Shares are taken
    // against this, since trending_daily only returns each day's top names.
    trendingDayTotals: function (days) { return getClient().rpc("trending_day_totals", { p_days: days }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    // Every stored row of one source, for the CSV export. Paged: PostgREST caps a
    // response at 1000 rows and stockanalysis alone stores ~500 a day.
    trendingRows: async function (source) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const r = await getClient().from("trending_snapshots").select("day,rank,ticker,views,captured_at")
          .eq("source", source).order("day").order("rank").range(from, from + 999);
        if (r.error) throw r.error;
        out.push.apply(out, r.data || []);
        if (!r.data || r.data.length < 1000) return out;
      }
    },
    trendingStatus: function () { return getClient().rpc("trending_status").then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    // Ask the edge function to snapshot today's lists. Those lists keep no
    // history, so a day nobody captures is gone; the cron is the primary
    // capture and this is the backstop for when it is not configured. The
    // function itself no-ops when the last capture is under 30 min old, so
    // calling it on every dashboard load costs one query.
    captureTrending: function () {
      if (!self.AT_SUPABASE_FUNCTIONS) return Promise.resolve(null);
      return fetch(self.AT_SUPABASE_FUNCTIONS.replace(/\/+$/, "") + "/trending", {
        method: "POST",
        headers: { apikey: self.AT_SUPABASE_ANON, Authorization: "Bearer " + self.AT_SUPABASE_ANON },
        signal: AbortSignal.timeout(20000)
      }).then(function (r) { return r.json(); }).catch(function () { return null; });
    }
  };
  if (typeof self !== "undefined") self.ATCloud = api;
})();
