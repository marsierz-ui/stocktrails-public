// One-shot merge for an install still running the pre-fix client.
//
// The fixed client (src/cloud.js, SYNC_PROTOCOL 2) reconciles in full by itself
// on its first sync, so this is only for a build you cannot update yet - i.e.
// the Chrome Web Store copy, until the new version is published and rolls out.
//
// Run it once per stale install:
//   1. open that extension's dashboard (its own toolbar icon > Dashboard),
//   2. DevTools (F12) > Console,
//   3. paste this whole file, press Enter, wait for the summary.
//
// It rewinds only the sync cursor - no local data is deleted. The cloud copy is
// the union of every device, so the pull brings back whatever this install had
// missed, and the push (cursor 0 sends every local row) hands the cloud anything
// only this install had.
(async function () {
  if (typeof ATStore === "undefined" || typeof ATSync === "undefined") {
    console.error("Run this in the extension dashboard's console, not on a web page.");
    return;
  }
  const user = await ATCloud.getUser().catch(function () { return null; });
  if (!user) { console.error("Not signed in - sign in on this dashboard first."); return; }

  const before = await ATStore.getAll();
  const cfg = await ATStore.getSyncConfig();
  const tickers = function (d) { return new Set((d.events || []).map(function (e) { return e.ticker; })).size; };
  console.log("account:", user.email || user.id);
  console.log("before:", (before.events || []).length, "events,", (before.intraday || []).length, "intraday,", tickers(before), "tickers");
  if (cfg.syncProtocol >= 2) console.log("note: this build already has the sync fix - it reconciles on its own.");

  await ATStore.setSyncConfig({ cloudCursor: 0, cloudSyncedAt: null });
  const r = await ATSync.syncNow();
  if (!r || !r.ok) { console.error("sync failed:", (r && r.reason) || "unknown"); return; }

  const after = await ATStore.getAll();
  console.log("after: ", (after.events || []).length, "events,", (after.intraday || []).length, "intraday,", tickers(after), "tickers");
  console.log("gained:", (after.events || []).length - (before.events || []).length, "events,",
    tickers(after) - tickers(before), "tickers");
  // The pre-fix client pulls each table in one request, and PostgREST truncates
  // a response at 1000 rows. If either table lands exactly on the cap, the merge
  // was cut short and the rest arrives only with the updated build.
  if ((after.events || []).length === 1000 || (after.intraday || []).length === 1000) {
    console.warn("a table came back at exactly 1000 rows - the response was probably truncated; " +
      "the remainder needs the updated build, which pages through the cap.");
  }
  console.log("done - reload the dashboard to redraw.");
})();
