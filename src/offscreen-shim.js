(function () {
  // The dashboard loaded headless in an offscreen document (dashboard.html?headless=agent, opened by
  // src/background.js for the AI agent's live verdict, issue #30). An offscreen document has only
  // chrome.runtime, so chrome.storage.local is provided here by asking the service worker, which does
  // the real call. Change events are not relayed (the headless run reads once and ends).
  // Loaded before pwa-shim.js; anywhere else (the extension page, the PWA) it does nothing.
  if (!/[?&]headless=agent\b/.test(location.search)) return;
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;
  if (chrome.storage && chrome.storage.local) return;
  function ask(op, arg, cb) {
    const p = new Promise(function (res, rej) {
      chrome.runtime.sendMessage({ type: "offscreenStorage", op: op, arg: arg === undefined ? null : arg }, function (r) {
        const e = chrome.runtime.lastError;
        if (e || !r || !r.ok) rej(new Error(e ? e.message : (r && r.error) || "storage unavailable"));
        else res(r.value);
      });
    });
    if (typeof cb === "function") { p.then(function (v) { cb(v); }, function () { cb(op === "get" ? {} : undefined); }); return undefined; }
    return p;
  }
  const local = {
    get: function (keys, cb) { return ask("get", keys, cb); },
    set: function (obj, cb) { return ask("set", obj, cb); },
    remove: function (keys, cb) { return ask("remove", keys, cb); }
  };
  const noop = { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } };
  chrome.storage = { local: local, onChanged: noop };
})();
