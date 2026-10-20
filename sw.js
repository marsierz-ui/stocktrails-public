// App-shell cache for the Stocktrails PWA. Network-first for everything
// (so updates always show), falling back to cache only when offline.
//
// Lives at the repo root so its scope covers the whole site. Every path is
// resolved against registration.scope, so the same file works when the site is
// served from the origin root (node server) and from a GitHub Pages subpath
// (https://<owner>.github.io/<repo>/).
const CACHE = "attention-shell-v30";
const ROOT = new URL("./", self.registration.scope); // e.g. "/" or "/Attention_tracker/"
const SHELL = [
  "dashboard/dashboard.html",
  "dashboard/dashboard.css",
  "dashboard/dashboard.js",
  "dashboard/trcharts.js",
  "dashboard/trades.js",
  "dashboard/biascards.js",
  "dashboard/crowdwatch.js",
  "dashboard/coach.js",
  "dashboard/shadow.js",
  "dashboard/headinfo.js",
  "dashboard/ai.js",
  "src/config.js",
  "src/offscreen-shim.js",
  "src/pwa-shim.js",
  "src/portals.js",
  "src/prices.js",
  "src/pricecache.js",
  "src/pricedb.js",
  "src/store.js",
  "src/cloud.js",
  "src/sync.js",
  "src/ledger.js",
  "src/ledgerdb.js",
  "src/decisions.js",
  "src/indicators.js",
  "src/biases.js",
  "src/aitools.js",
  "src/aiclient.js",
  "src/rationale.js",
  "src/history.js",
  "src/shadow.js",
  "src/agentsession.js",
  "src/theme.js",
  "vendor/supabase.min.js",
  "vendor/world-map.js",
  "vendor/tz-countries.js",
  "pwa/share.js",
  "manifest.webmanifest",
  "icons/icon192.png"
].map(function (p) { return new URL(p, ROOT).href; });

const SHARE_TARGET = new URL("share-target", ROOT).pathname;
const SHARE_PAGE = new URL("pwa/share.html?shared=1", ROOT).href;
const FALLBACK = new URL("dashboard/dashboard.html", ROOT).href;

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== "shared"; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Receive a shared screenshot/text/url (POST share target), stash it in a cache,
// then redirect to the share page which reads + processes it.
self.addEventListener("fetch", function (e) {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname === SHARE_TARGET) {
    e.respondWith((async function () {
      try {
        const form = await e.request.formData();
        const meta = { text: form.get("text") || "", url: form.get("url") || "", title: form.get("title") || "" };
        const image = form.get("image");
        const cache = await caches.open("shared");
        await cache.put("/_shared_meta", new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
        if (image && image.size) await cache.put("/_shared_image", new Response(image));
        else await cache.delete("/_shared_image");
      } catch (err) { /* fall through to the page anyway */ }
      return Response.redirect(SHARE_PAGE, 303);
    })());
    return;
  }
  if (e.request.method !== "GET") return;
  if (url.origin !== location.origin) return;                 // Supabase / Yahoo: always network, never cached
  if (/\/(sync|yahoo)$/.test(url.pathname)) return;           // let network handle data
  // Network-first: always try the server, update the cache, fall back to cache offline.
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        if (hit) return hit;
        // Deep-linked navigation with nothing cached: serve the app shell.
        if (e.request.mode === "navigate") return caches.match(FALLBACK);
        return Response.error();
      });
    })
  );
});
