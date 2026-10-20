(function () {
  // Daily closes kept in this browser (IndexedDB) so opening the Trades tab does not
  // download every price series again. peek() answers from the store at once; refresh()
  // brings a stored series up to date from a few days before its last bar instead of
  // fetching it whole, and fetches it whole when the overlap shows a split or a restatement.
  // Public price data only; the page clears it together with the imported trades.
  const DB = "attention_daily", STORE = "series", VER = 1;
  const FRESH_MS = 6 * 3600000;   // a series fetched less than this long ago is not asked for again
  const OVERLAP_DAYS = 10;        // a refresh starts this many days before the last stored bar
  const RESTATE = 0.005;          // an overlapping close that moved more than this means the history changed

  function dayMinus(iso, n) { return new Date(Date.parse(iso) - n * 86400000).toISOString().slice(0, 10); }

  // ---------- the store: IndexedDB in the browser, any object with the same three methods in tests ----------

  function openDB() {
    return new Promise(function (res, rej) {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "key" }); };
      r.onsuccess = function () { r.result.onversionchange = function () { r.result.close(); }; res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  const idb = {
    getMany: function (keys) {
      return openDB().then(function (db) {
        return new Promise(function (res, rej) {
          const os = db.transaction(STORE, "readonly").objectStore(STORE), out = {};
          let n = keys.length;
          if (!n) { res(out); return; }
          keys.forEach(function (k) {
            const rq = os.get(k);
            rq.onsuccess = function () { if (rq.result) out[k] = rq.result; if (--n === 0) res(out); };
            rq.onerror = function () { rej(rq.error); };
          });
        });
      });
    },
    put: function (rec) {
      return openDB().then(function (db) {
        return new Promise(function (res, rej) {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(rec);
          tx.oncomplete = function () { res(); };
          tx.onerror = function () { rej(tx.error); };
        });
      });
    },
    clear: function () {
      return openDB().then(function (db) {
        return new Promise(function (res, rej) {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).clear();
          tx.oncomplete = function () { res(); };
          tx.onerror = function () { rej(tx.error); };
        });
      });
    }
  };

  // ---------- the cache ----------
  // opts: { store, fetchDaily(symbol, fromISO, true) -> bars with .currency, now() }

  function create(opts) {
    const store = opts.store, fetchDaily = opts.fetchDaily, now = opts.now || Date.now;

    function withCurrency(bars, currency) { bars.currency = currency || null; return bars; }

    async function save(sym, from, bars) {
      try { await store.put({ key: sym, from: from, fetchedAt: now(), currency: bars.currency || null, bars: Array.prototype.slice.call(bars) }); }
      catch (e) { /* storage blocked or full: the series is fetched again next time */ }
    }

    // fromOf: { symbol: first date wanted }. Returns { symbol: { bars, stale } } for the series
    // already stored from that date on; the others are left out. stale: older than FRESH_MS.
    async function peek(fromOf) {
      const syms = Object.keys(fromOf), out = {};
      let recs = {};
      try { recs = await store.getMany(syms); } catch (e) { return out; }
      syms.forEach(function (s) {
        const r = recs[s];
        if (!r || !r.bars || !r.bars.length || !(r.from <= fromOf[s])) return;
        const bars = r.bars.filter(function (b) { return b.date >= fromOf[s]; });
        if (bars.length) out[s] = { bars: withCurrency(bars, r.currency), stale: now() - r.fetchedAt > FRESH_MS };
      });
      return out;
    }

    // The whole series from `from`, fetched and stored.
    async function load(sym, from) {
      const bars = await fetchDaily(sym, from, true);
      if (bars && bars.length) await save(sym, from, bars);
      return bars;
    }

    // Brings a stored series up to date. Returns { bars, changed } or null when there is nothing
    // stored or nothing came back; throws when the fetch fails (the caller keeps what it has).
    // changed: a new day was added, or the history was restated. A revision of the last day's
    // close alone is saved and returned but is not "changed".
    async function refresh(sym) {
      let rec;
      try { rec = (await store.getMany([sym]))[sym]; } catch (e) { return null; }
      if (!rec || !rec.bars || !rec.bars.length) return null;
      const last = rec.bars[rec.bars.length - 1].date, inc = await fetchDaily(sym, dayMinus(last, OVERLAP_DAYS), true);
      if (!inc || !inc.length) return null;
      const old = {};
      rec.bars.forEach(function (b) { old[b.date] = b.close; });
      const restated = inc.some(function (b) { return b.date < last && old[b.date] > 0 && Math.abs(b.close / old[b.date] - 1) > RESTATE; });
      if (restated) {
        const whole = await fetchDaily(sym, rec.from, true);
        if (!whole || !whole.length) return null;
        await save(sym, rec.from, whole);
        return { bars: whole, changed: true };
      }
      const merged = withCurrency(rec.bars.filter(function (b) { return b.date < inc[0].date; }).concat(Array.prototype.slice.call(inc)), inc.currency || rec.currency);
      await save(sym, rec.from, merged);
      return { bars: merged, changed: merged.length !== rec.bars.length || merged[merged.length - 1].date !== last };
    }

    function clear() { return store.clear ? store.clear() : Promise.resolve(); }

    return { peek: peek, load: load, refresh: refresh, clear: clear };
  }

  const api = { create: create, FRESH_MS: FRESH_MS, OVERLAP_DAYS: OVERLAP_DAYS };
  if (typeof self !== "undefined" && self.indexedDB) {
    self.ATPriceCache = Object.assign({}, api, create({ store: idb, fetchDaily: function (s, f, a) { return self.ATPrices.fetchDaily(s, f, a); } }));
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
