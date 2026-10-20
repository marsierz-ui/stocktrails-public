(function () {
  // Push local changes then pull+merge remote ones, using a single cursor
  // (the server's clock). Safe to call from the background worker or a page.
  let inFlight = null;

  // ngrok's free tier serves an HTML interstitial unless this header is present,
  // which would otherwise break the JSON API.
  function headers(extra) {
    return Object.assign({ "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" }, extra || {});
  }

  // Zero-config: if this device has no token yet, mint one from the server and
  // store it, so syncing "just works" with no manual URL/token entry.
  async function ensureRegistered() {
    let cfg = await self.ATStore.getSyncConfig();
    if (cfg.url && cfg.token) return cfg;
    const base = (cfg.url || self.AT_SERVER_URL || "").replace(/\/+$/, "");
    if (!base) return cfg; // manual mode, not configured
    try {
      const body = { name: cfg.name || "", key: self.AT_REGISTER_KEY || "" };
      const r = await fetch(base + "/register", { method: "POST", headers: headers(), body: JSON.stringify(body) });
      if (!r.ok) throw new Error("register HTTP " + r.status);
      const j = await r.json();
      await self.ATStore.setSyncConfig({ url: base, token: j.token, userId: j.user_id });
      return await self.ATStore.getSyncConfig();
    } catch (e) {
      await self.ATStore.setSyncConfig({ lastError: "auto-register: " + (e && e.message || e) });
      return cfg;
    }
  }

  async function syncNow() {
    if (inFlight) return inFlight;
    inFlight = doSync().finally(function () { inFlight = null; });
    return inFlight;
  }

  async function doSync() {
    // Option B: if Supabase is configured and the user is signed in, sync to the
    // cloud. Otherwise fall back to the token server (Option A).
    if (self.ATCloud && self.ATCloud.enabled()) {
      const c = await self.ATCloud.trySync();
      if (c.handled) return c.result;
      // Supabase is configured but declined (signed out, expired session, or the
      // service worker cannot see the session). Never fall back to a token
      // server here: that would upload this device's rows to whatever URL was
      // baked in or registered earlier, outside the user's account (issue #25).
      // trySync records the cause in lastError where it knows one.
      return { ok: false, reason: "not signed in to the cloud (sign in under Settings > Account to sync)" };
    }
    const cfg = await ensureRegistered();
    if (!cfg.url || !cfg.token) {
      // Reached when the cloud path declined (not signed in) and no token server
      // is configured. Returning silently here is what hid a dead cloud session
      // for days, so record it.
      await self.ATStore.setSyncConfig({ lastError: "Not syncing: no cloud session and no sync server configured." });
      return { ok: false, reason: "not configured" };
    }
    const base = cfg.url.replace(/\/+$/, "");
    const auth = headers({ "Authorization": "Bearer " + cfg.token });
    const cursor = cfg.cursor || 0;
    try {
      let data = await self.ATStore.getAll();
      const changes = self.ATStore.collectChanges(data, cursor);
      const post = await fetch(base + "/sync", { method: "POST", headers: auth, body: JSON.stringify(changes) });
      if (!post.ok) throw new Error("push HTTP " + post.status);

      const get = await fetch(base + "/sync?since=" + cursor, { headers: auth });
      if (!get.ok) throw new Error("pull HTTP " + get.status);
      const remote = await get.json();

      data = await self.ATStore.getAll(); // re-read in case it changed during the request
      const changed = self.ATStore.applyRemote(data, remote);
      if (changed) await self.ATStore.setAll(data);
      await self.ATStore.setSyncConfig({ cursor: remote.serverTime || cursor, lastSync: Date.now(), lastError: "" });
      return { ok: true, changed: changed };
    } catch (e) {
      await self.ATStore.setSyncConfig({ lastError: String(e && e.message || e) });
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  const api = { syncNow, ensureRegistered };
  if (typeof self !== "undefined") self.ATSync = api;
})();
