(function () {
  function $(id) { return document.getElementById(id); }
  let current = null;       // chosen ticker
  let debounceTimer = null;

  // --- capture (mirrors the extension's attention handler) ---
  async function logAttention(ticker, source, src) {
    const ts = Date.now();
    const r = await ATStore.addEvent({ ticker: ticker, source: source, url: src || "", ts: ts });
    const ir = await ATStore.addIntraday({ ticker: ticker, source: source, url: src || "", ts: ts });
    try {
      const q = await ATPrices.fetchQuote(ticker);
      if (q && !isNaN(q.close)) {
        if (r.added) await ATStore.setPrice(r.event.id, q.close);
        if (ir.added) await ATStore.setIntradayPrice(ir.event.id, q.close);
      }
    } catch (e) { /* best effort */ }
    await ATSync.syncNow();
  }

  async function label(sentiment) {
    if (!current) return;
    await ATStore.labelTicker(current, sentiment);
    await ATSync.syncNow();
    $("status").textContent = "Saved as " + sentiment + " ✓";
  }

  async function start(ticker, source, src) {
    current = ticker;
    $("picker").style.display = "none";
    $("detected").innerHTML = "<div class='muted'>Tracked:</div><div class='tk'>" + esc(ticker) + "</div>";
    $("label-btns").style.display = "flex";
    $("status").textContent = "Logging…";
    await logAttention(ticker, source, src);
    $("status").textContent = "Logged " + ticker + " ✓  Add an outlook:";
  }

  function showResults(list) {
    const box = $("results");
    if (!list.length) { box.innerHTML = ""; return; }
    box.innerHTML = "";
    list.slice(0, 8).forEach(function (x) {
      const row = document.createElement("div");
      row.className = "res";
      row.innerHTML = "<span><span class='sym'>" + esc(x.symbol) + "</span> <span class='nm'>" + esc(x.name) + "</span></span><span class='ex'>" + esc(x.exch) + "</span>";
      row.addEventListener("click", function () { start(x.symbol, "Name", sharedUrl); });
      box.appendChild(row);
    });
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // --- name/ISIN search (the core name -> ticker resolution) ---
  async function runSearch(q) {
    if (!q || q.length < 2) { showResults([]); return; }
    try { showResults(await ATPrices.searchSymbols(q)); }
    catch (e) { $("ocr-status").textContent = "Search failed (is the server reachable?)."; }
  }

  $("name-input").addEventListener("input", function () {
    clearTimeout(debounceTimer);
    const v = this.value;
    debounceTimer = setTimeout(function () { runSearch(v); }, 300);
  });

  // --- screenshot OCR (read the names off a broker-app screen) ---
  function loadTesseract() {
    return new Promise(function (res, rej) {
      if (window.Tesseract) return res(window.Tesseract);
      const s = document.createElement("script");
      // Exact version with a hash, so a changed file on the CDN is refused.
      s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
      s.integrity = "sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F";
      s.crossOrigin = "anonymous";
      s.onload = function () { res(window.Tesseract); };
      s.onerror = function () { rej(new Error("load failed")); };
      document.head.appendChild(s);
    });
  }

  // Candidate lines from OCR text: drop pure numbers / noise, keep name-like text.
  function candidates(text) {
    const seen = {}, out = [];
    text.split(/\n+/).forEach(function (line) {
      const s = line.trim();
      if (s.length < 3 || s.length > 40) return;
      if (!/[A-Za-z]{3,}/.test(s)) return;
      if (/^[0-9.,%+\-\s$€£]+$/.test(s)) return;
      if (/\d{4,}/.test(s)) return; // account numbers and the like stay on the device
      const k = s.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1; out.push(s);
    });
    return out;
  }

  async function fromImage(blob) {
    $("ocr-status").textContent = "Reading screenshot…";
    let text = "";
    try { const T = await loadTesseract(); const r = await T.recognize(blob, "eng"); text = (r && r.data && r.data.text) || ""; }
    catch (e) { $("ocr-status").textContent = "On-screen reading unavailable - type the name instead."; return; }
    const isins = text.match(/[A-Z]{2}[A-Z0-9]{9}[0-9]/g) || [];
    const queries = isins.concat(candidates(text)).slice(0, 8);
    if (!queries.length) { $("ocr-status").textContent = "Couldn't read a name - type it instead."; return; }
    $("ocr-status").textContent = "Looking up " + queries.length + " candidate(s)…";
    const found = {};
    for (const q of queries) {
      try { const r = await ATPrices.searchSymbols(q); if (r[0]) found[r[0].symbol] = r[0]; } catch (e) { /* skip */ }
    }
    const list = Object.keys(found).map(function (k) { return found[k]; });
    if (list.length) { $("ocr-status").textContent = "Tap the stock you meant:"; showResults(list); }
    else $("ocr-status").textContent = "No matches - type the name instead.";
  }

  // --- entry: read shared data (stashed by the SW), then route ---
  const params = new URLSearchParams(location.search);
  // The URL comes only from a real share (the service worker's cache below), never
  // from the query string: a crafted ?url= link would log an event with no click.
  let sharedUrl = "";
  let sharedText = params.get("text") || "";

  async function init() {
    if (params.get("shared") === "1" && self.caches) {
      try {
        const c = await caches.open("shared");
        const metaResp = await c.match("/_shared_meta");
        if (metaResp) { const m = await metaResp.json(); sharedUrl = m.url || sharedUrl; sharedText = m.text || sharedText; }
        const imgResp = await c.match("/_shared_image");
        await c.delete("/_shared_meta");
        if (imgResp) { await c.delete("/_shared_image"); fromImage(await imgResp.blob()); }
      } catch (e) { /* ignore */ }
    }
    // A shared portal URL resolves directly.
    const hit = sharedUrl && self.ATPortals ? ATPortals.detect(sharedUrl) : null;
    if (hit) { start(hit.ticker, hit.source, sharedUrl); return; }
    // Otherwise seed the search from shared text (a selected name) if any.
    if (sharedText) { const q = sharedText.trim().slice(0, 60); $("name-input").value = q; runSearch(q); }
  }

  document.querySelectorAll("#label-btns button").forEach(function (b) {
    b.addEventListener("click", function () { label(b.getAttribute("data-s")); });
  });

  init();
})();
