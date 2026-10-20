// Tests for the daily price cache (src/pricecache.js): what is answered from the store, what is
// fetched, how a stale series is brought up to date, and when it is fetched whole again.
// No network: the fetch and the store are fakes. Run: node tools/test-pricecache.js (exit code 1 on failure).
const path = require("path");
const PC = require(path.join(__dirname, "..", "src", "pricecache.js"));
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? "PASS " : "FAIL ") + m); };

const DAY = 86400000, iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const T0 = Date.parse("2026-10-01T12:00:00Z");
// a series of weekdays from `from` to `to`, close = base + day index (times `scale`)
const series = (from, to, scale) => {
  const out = [];
  for (let t = Date.parse(from), i = 0; t <= Date.parse(to); t += DAY) {
    const d = new Date(t).getUTCDay();
    if (d === 0 || d === 6) continue;
    out.push({ date: iso(t), close: (100 + (t - Date.parse("2026-01-01")) / DAY) * (scale || 1) });
  }
  out.currency = "USD";
  return out;
};
const memStore = () => {
  const m = new Map();
  return { m, getMany: async (keys) => { const o = {}; keys.forEach((k) => { if (m.has(k)) o[k] = JSON.parse(JSON.stringify(m.get(k))); }); return o; }, put: async (r) => { m.set(r.key, JSON.parse(JSON.stringify(r))); }, clear: async () => { m.clear(); } };
};
const make = (world) => {
  const store = memStore(), calls = [], clock = { t: T0 };
  const fetchDaily = async (sym, from, asSym) => { calls.push({ sym, from, asSym }); if (world.fail) throw new Error("offline"); const all = world.bars(sym); const r = all.filter((b) => b.date >= from); r.currency = all.currency; return r; };
  return { store, calls, clock, cache: PC.create({ store, fetchDaily, now: () => clock.t }) };
};

(async function () {
  // --- cold: nothing stored, so the whole series is fetched once and kept
  {
    const world = { bars: () => series("2025-06-01", "2026-10-01") };
    const { cache, calls, store } = make(world);
    const none = await cache.peek({ AAA: "2025-09-01" });
    ok(Object.keys(none).length === 0, "cold: nothing stored, nothing answered");
    const b = await cache.load("AAA", "2025-09-01");
    ok(calls.length === 1 && calls[0].from === "2025-09-01" && calls[0].asSym === true && b.length > 200 && store.m.has("AAA"), "cold: one request for the whole series, then stored");
    const hit = await cache.peek({ AAA: "2025-09-01" });
    ok(hit.AAA && hit.AAA.bars.length === b.length && hit.AAA.bars.currency === "USD" && hit.AAA.stale === false && calls.length === 1, "warm: answered from the store with its currency, fresh, no request");
  }
  // --- coverage: a series stored from a later date does not cover an earlier start; an earlier one is trimmed
  {
    const world = { bars: () => series("2025-06-01", "2026-10-01") };
    const { cache } = make(world);
    await cache.load("AAA", "2026-01-05");
    ok(Object.keys(await cache.peek({ AAA: "2025-09-01" })).length === 0, "coverage: stored from 2026-01-05 does not answer a request from 2025-09-01");
    const later = (await cache.peek({ AAA: "2026-06-01" })).AAA.bars;
    ok(later[0].date >= "2026-06-01", "coverage: a later start is answered by trimming to it");
  }
  // --- stale: after the freshness window, refresh asks only for the last days and merges
  {
    let end = "2026-10-01";
    const world = { bars: () => series("2025-06-01", end) };
    const { cache, calls, clock } = make(world);
    const first = await cache.load("AAA", "2025-09-01");
    calls.length = 0;
    clock.t += PC.FRESH_MS - 1000;
    ok((await cache.peek({ AAA: "2025-09-01" })).AAA.stale === false, "freshness: just inside the window it is not stale");
    clock.t += 2000;
    ok((await cache.peek({ AAA: "2025-09-01" })).AAA.stale === true, "freshness: just past the window it is stale");
    end = "2026-10-06";
    const r = await cache.refresh("AAA");
    const lastOld = first[first.length - 1].date;
    ok(calls.length === 1 && calls[0].from === iso(Date.parse(lastOld) - PC.OVERLAP_DAYS * DAY), "refresh: one request, from " + PC.OVERLAP_DAYS + " days before the last stored bar (" + (calls[0] && calls[0].from) + ")");
    ok(r.changed === true && r.bars.length === first.length + 3 && r.bars[r.bars.length - 1].date === "2026-10-06" && r.bars.currency === "USD", "refresh: the new days are added, nothing doubled, currency kept");
    const dates = r.bars.map((b) => b.date);
    ok(dates.every((d, i) => i === 0 || d > dates[i - 1]), "refresh: the merged series is strictly increasing by date");
    ok((await cache.peek({ AAA: "2025-09-01" })).AAA.stale === false, "refresh: the series counts as fresh again");
  }
  // --- the last day's close revised: saved, but not a change that rebuilds the report
  {
    let rev = 1;
    const world = { bars: () => { const s = series("2025-06-01", "2026-10-01"); s[s.length - 1].close *= rev; return s; } };
    const { cache } = make(world);
    await cache.load("AAA", "2025-09-01");
    rev = 1.01;
    const r = await cache.refresh("AAA");
    ok(r.changed === false && r.bars.length > 0, "refresh: a revised last close alone is not a change");
  }
  // --- a split: the overlap no longer matches, so the whole history is fetched again
  {
    let scale = 1;
    const world = { bars: () => series("2025-06-01", "2026-10-06", scale) };
    const { cache, calls } = make(world);
    await cache.load("AAA", "2025-09-01");
    scale = 0.5; calls.length = 0;
    const r = await cache.refresh("AAA");
    ok(calls.length === 2 && calls[1].from === "2025-09-01" && r.changed === true && Math.abs(r.bars[0].close / (100 + (Date.parse(r.bars[0].date) - Date.parse("2026-01-01")) / DAY) - 0.5) < 1e-9,
      "split: a restated overlap leads to a second request for the whole series, which replaces the stored one");
  }
  // --- failure and gaps
  {
    const world = { bars: () => series("2025-06-01", "2026-10-01"), fail: false };
    const { cache } = make(world);
    await cache.load("AAA", "2025-09-01");
    world.fail = true;
    let threw = false;
    try { await cache.refresh("AAA"); } catch (e) { threw = true; }
    ok(threw, "offline: refresh throws, so the caller keeps the series it has");
    ok((await cache.refresh("NOPE")) === null, "refresh of a symbol that is not stored does nothing");
    world.fail = false;
    const empty = { bars: () => { const s = []; s.currency = "USD"; return s; } };
    const m = make(empty);
    ok((await m.cache.load("ZZZ", "2025-09-01")).length === 0 && !m.store.m.has("ZZZ"), "an empty answer is not stored");
  }
  // --- a store that fails must not break loading
  {
    const world = { bars: () => series("2025-06-01", "2026-10-01") };
    const bad = { getMany: async () => { throw new Error("blocked"); }, put: async () => { throw new Error("blocked"); } };
    const cache = PC.create({ store: bad, fetchDaily: async (s, f) => { const r = world.bars().filter((b) => b.date >= f); r.currency = "USD"; return r; }, now: () => T0 });
    ok(Object.keys(await cache.peek({ AAA: "2025-09-01" })).length === 0 && (await cache.load("AAA", "2025-09-01")).length > 100, "blocked storage: nothing answered from the store, the series is still fetched and returned");
  }
  // --- clear
  {
    const world = { bars: () => series("2025-06-01", "2026-10-01") };
    const { cache, store } = make(world);
    await cache.load("AAA", "2025-09-01");
    await cache.clear();
    ok(store.m.size === 0, "clear: everything stored is removed");
  }
  if (failed) { console.log(failed + " failed"); process.exit(1); }
  console.log("all passed");
})();
