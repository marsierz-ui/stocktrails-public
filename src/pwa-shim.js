(function () {
  // When the dashboard runs as a PWA (served over http/https) instead of as an
  // extension page, there is no chrome.* API. This shim provides the small slice
  // the dashboard/store/sync code uses, backed by IndexedDB, so the exact same
  // code runs unchanged. In the real extension chrome.storage exists -> no-op.
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) return;

  const DB = "attention_kv", STORE = "kv";
  function open() {
    return new Promise(function (res, rej) {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  async function idbGet(keys) {
    const db = await open();
    const names = Array.isArray(keys) ? keys : (keys == null ? null : [keys]);
    return new Promise(function (res) {
      const os = db.transaction(STORE, "readonly").objectStore(STORE);
      const out = {};
      if (names === null) {
        const rq = os.getAllKeys();
        rq.onsuccess = function () {
          let n = rq.result.length; if (!n) return res({});
          rq.result.forEach(function (k) { const g = os.get(k); g.onsuccess = function () { out[k] = g.result; if (--n === 0) res(out); }; });
        };
        rq.onerror = function () { res({}); };
        return;
      }
      let n = names.length; if (!n) return res({});
      names.forEach(function (k) {
        const g = os.get(k);
        g.onsuccess = function () { if (g.result !== undefined) out[k] = g.result; if (--n === 0) res(out); };
        g.onerror = function () { if (--n === 0) res(out); };
      });
    });
  }
  async function idbSet(obj) {
    const db = await open();
    return new Promise(function (res, rej) {
      const tx = db.transaction(STORE, "readwrite"), os = tx.objectStore(STORE);
      Object.keys(obj).forEach(function (k) { os.put(obj[k], k); });
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
    });
  }

  // Without remove(), sign-out could not delete the at_cloud_signed_in flag.
  async function idbRemove(keys) {
    const db = await open();
    const names = Array.isArray(keys) ? keys : [keys];
    return new Promise(function (res, rej) {
      const tx = db.transaction(STORE, "readwrite"), os = tx.objectStore(STORE);
      names.forEach(function (k) { os.delete(k); });
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
    });
  }

  const g = (typeof window !== "undefined") ? window : self;
  g.chrome = g.chrome || {};
  g.chrome.storage = {
    local: {
      get: function (keys, cb) { const p = idbGet(keys); if (cb) p.then(cb); return p; },
      set: function (obj, cb) { const p = idbSet(obj); if (cb) p.then(cb); return p; },
      remove: function (keys, cb) { const p = idbRemove(keys); if (cb) p.then(cb); return p; }
    },
    onChanged: { addListener: function () {} }
  };
  g.chrome.runtime = g.chrome.runtime || {
    sendMessage: function (_m, cb) { if (cb) cb(); return Promise.resolve(); },
    lastError: null, getURL: function (p) { return p; }
  };
  g.chrome.permissions = g.chrome.permissions || {
    request: function () { return Promise.resolve(true); },
    contains: function () { return Promise.resolve(true); },
    remove: function () { return Promise.resolve(true); }
  };
  g.chrome.tabs = g.chrome.tabs || { query: function () { return Promise.resolve([]); } };
  g.chrome.alarms = g.chrome.alarms || { create: function () {}, onAlarm: { addListener: function () {} } };

  // Route Yahoo price requests through the backend proxy (same origin).
  if (location.protocol === "http:" || location.protocol === "https:") {
    if (!g.AT_PRICE_PROXY) g.AT_PRICE_PROXY = location.origin + "/yahoo?path="; // unless config set a Supabase function proxy
    g.AT_SERVER_URL = location.origin; // PWA token-server fallback is same-origin (overrides baked URL)
    // Site root, derived from this script's own URL (it always lives at <root>/src/).
    // Keeps the manifest and service worker resolvable when the site is deployed
    // under a subpath (GitHub Pages) rather than at the origin root.
    const self_src = (document.currentScript && document.currentScript.src) || "";
    const root = self_src ? self_src.replace(/src\/pwa-shim\.js(\?.*)?$/, "") : "/";
    if (!document.querySelector("link[rel=manifest]")) {
      const l = document.createElement("link"); l.rel = "manifest"; l.href = root + "manifest.webmanifest";
      document.head.appendChild(l);
    }
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () { navigator.serviceWorker.register(root + "sw.js").catch(function () {}); });
    }
  }
})();
