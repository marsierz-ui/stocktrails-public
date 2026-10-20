(function () {
  // Local archive of price bars in IndexedDB, one record per symbol+interval.
  // Used to retain hourly history beyond Yahoo's rolling ~730-day window.
  const DB = "attention_prices", STORE = "bars", VER = 1;
  const WINDOW_SEC = 729 * 86400; // safely inside Yahoo's 730-day 1h limit

  function openDB() {
    return new Promise(function (res, rej) {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = function () {
        const db = r.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function key(symbol, interval) { return interval + "|" + String(symbol).toUpperCase(); }

  function getRecord(symbol, interval) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        const rq = db.transaction(STORE, "readonly").objectStore(STORE).get(key(symbol, interval));
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }

  function putRecord(rec) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  async function getBars(symbol, interval) {
    const r = await getRecord(symbol, interval);
    return r ? r.bars : [];
  }

  async function lastTs(symbol, interval) {
    const r = await getRecord(symbol, interval);
    return (r && r.bars.length) ? r.bars[r.bars.length - 1].t : 0;
  }

  // Merge new bars into stored ones, deduped by timestamp and kept sorted.
  // Later writes overwrite earlier values for the same bar (refreshes adjustments).
  function merge(existing, incoming) {
    const m = new Map();
    existing.forEach(function (b) { m.set(b.t, b.c); });
    incoming.forEach(function (b) { m.set(b.t, b.c); });
    return Array.from(m.keys()).sort(function (a, b) { return a - b; })
      .map(function (t) { return { t: t, c: m.get(t) }; });
  }

  async function store(symbol, interval, bars) {
    if (!bars || !bars.length) return;
    const cur = await getBars(symbol, interval);
    await putRecord({
      key: key(symbol, interval), symbol: String(symbol).toUpperCase(),
      interval: interval, bars: merge(cur, bars), updated: Date.now()
    });
  }

  // Full backfill of the available window (first time a symbol is archived).
  async function backfill(symbol, interval) {
    if (!self.ATPrices) return;
    const from = Math.floor(Date.now() / 1000) - WINDOW_SEC;
    const bars = await self.ATPrices.fetchBars(symbol, interval || "1h", from);
    await store(symbol, interval || "1h", bars);
  }

  // Incremental update: fetch only bars after the last stored one.
  async function appendSince(symbol, interval) {
    if (!self.ATPrices) return;
    const last = await lastTs(symbol, interval);
    const minFrom = Math.floor(Date.now() / 1000) - WINDOW_SEC;
    const from = last ? Math.max(Math.floor(last / 1000) + 1, minFrom) : minFrom;
    const bars = await self.ATPrices.fetchBars(symbol, interval || "1h", from);
    await store(symbol, interval || "1h", bars);
  }

  const api = { openDB, getBars, lastTs, backfill, appendSince, store, key };
  if (typeof self !== "undefined") self.ATPriceDB = api;
})();
