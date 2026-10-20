// Tests for the viewing sessions behind the AI agent's live verdict on stock pages (src/agentsession.js, issue #30):
// splitting and merging (several tabs, a return within a few minutes, a later return), when a session is due,
// which moment it belongs to, when a decided moment is asked again, and the record kept of an earlier answer.
// Run: node tools/test-agent-session.js (exit code 1 on failure).
const path = require("path");
const SE = require(path.join(__dirname, "..", "src", "agentsession.js"));
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? "PASS " : "FAIL ") + m); };
const MIN = 60000, DAY = 864e5, t0 = Date.UTC(2026, 9, 18, 16, 13);

// --- 1. views across tabs and dwell pings form one session ---
let ss = {};
ss = SE.touch(ss, "mda", t0, "view", { page: "/stocks/mda/" });
ss = SE.touch(ss, "MDA", t0 + 20000, "view", { page: "/stocks/mda/financials/" });   // a second tab
ss = SE.touch(ss, "MDA", t0 + 35000, "dwell", { ms: 15000 });
ss = SE.touch(ss, "MDA", t0 + 50000, "view", { page: "/stocks/mda/" });              // same page again
let s = ss.MDA;
ok(s && s.views === 3 && s.dwellMs === 15000 && s.pages.length === 2 && s.parts === 1 && s.start === t0 && s.lastTs === t0 + 50000, "views in several tabs and dwell are one session (3 views, 2 pages, 15 s)");
ok(!SE.due(ss, t0 + 50000 + 30000).length, "not due while within a minute of the last activity");
ok(SE.due(ss, t0 + 50000 + SE.END_MS).join() === "MDA", "due a minute after the last activity");
ok(SE.dueAt(s) === t0 + 50000 + SE.END_MS, "dueAt is END_MS after the last activity");

// --- 2. after the run: not due again until new activity ---
const ran = t0 + 50000 + SE.END_MS;
ss = SE.markRan(ss, "MDA", { ranAt: ran, momentId: "l123", redecided: 0 });
ok(ss.MDA.momentId === "l123" && ss.MDA.ranAt === ran && !SE.due(ss, ran + 10 * MIN).length, "a session that ran is not due again without new activity");

// --- 3. a return within a few minutes continues the session ---
const back = ran + 3 * MIN;
ss = SE.touch(ss, "MDA", back, "view", { page: "/stocks/mda/statistics/" });
s = ss.MDA;
ok(s.start === t0 && s.views === 4 && s.parts === 2 && s.momentId === "l123", "a return 3 minutes after the end continues the session (merged, same moment, part 2)");
ok(!SE.due(ss, back + 30000).length && SE.due(ss, back + SE.END_MS).join() === "MDA", "the continuation is due a minute after it ends");
ok(SE.summary(s).returns === 1 && SE.summary(s).views === 4 && SE.summary(s).pages === 3, "the summary counts the return, the views and the pages");

// --- 4. a return after more than END_MS + CONTINUE_MS starts a new session ---
const later = s.lastTs + SE.END_MS + SE.CONTINUE_MS + 1000;
ss = SE.touch(ss, "MDA", later, "view", {});
ok(ss.MDA.start === later && ss.MDA.views === 1 && ss.MDA.momentId === null && ss.MDA.ranAt === null, "a return after more than 6 minutes is a new session");

// --- 5. activity during a run makes the session due again ---
let s2 = SE.touch({}, "AAPL", t0, "view", {});
s2 = SE.markRan(s2, "AAPL", { ranAt: t0 + SE.END_MS, momentId: null });
s2 = SE.touch(s2, "AAPL", t0 + SE.END_MS + 5000, "dwell", { ms: 5000 });
ok(SE.due(s2, t0 + 2 * SE.END_MS + 5000).join() === "AAPL", "dwell after the run started makes the session due again");

// --- 6. stocks are separate; prune drops old sessions ---
let s3 = SE.touch(SE.touch({}, "AAA", t0, "view", {}), "BBB", t0 + 1000, "view", {});
ok(Object.keys(s3).sort().join() === "AAA,BBB" && s3.AAA.views === 1 && s3.BBB.views === 1, "each stock has its own session");
ok(!SE.prune(s3, t0 + 4 * DAY).AAA && SE.prune(s3, t0 + DAY).AAA, "sessions older than 3 days are dropped");
ok(SE.touch(s3, "", t0, "view", {}) === s3, "a view without a ticker changes nothing");

// --- 7. the moment of a session ---
const sess = { ticker: "MDA", start: t0, lastTs: t0 + 10 * MIN, momentId: null };
const cands = [
  { id: "lold", kind: "look", ticker: "MDA", t: t0 - 5 * DAY },
  { id: "lnew", kind: "look", ticker: "MDA", t: t0 + 2000 },
  { id: "rnew", kind: "revisit", ticker: "MDA", t: t0 + 5 * MIN },
  { id: "x", kind: "look", ticker: "ZZZ", t: t0 + 1000 },
  { id: "tr", kind: "trade", ticker: "MDA", t: t0 + 6 * MIN }
];
ok(SE.momentFor(cands, sess).id === "rnew", "the latest moment of the stock inside the session (never a buy, never another stock)");
ok(SE.momentFor(cands, Object.assign({}, sess, { momentId: "lnew" })).id === "lnew", "a session that has a moment keeps it");
ok(SE.momentFor(cands, Object.assign({}, sess, { start: t0 + 20 * MIN, lastTs: t0 + 30 * MIN })) === null, "no moment when none falls inside the session (a return within 30 days, not a burst)");

// --- 8. asking again ---
const dec = { id: "lnew", action: "buy", size: 0.05, decidedAt: t0 + 2 * MIN };
ok(SE.needsRedecide({ lastTs: t0 + 9 * MIN }, dec, 0), "a decided moment whose session got activity after the decision is asked again");
ok(!SE.needsRedecide({ lastTs: t0 + MIN }, dec, 0), "not when the decision saw the whole session");
ok(!SE.needsRedecide({ lastTs: t0 + 9 * MIN }, dec, SE.MAX_REDECIDE), "at most MAX_REDECIDE times per moment");
ok(!SE.needsRedecide({ lastTs: t0 + 9 * MIN }, null, 0) && !SE.needsRedecide({ lastTs: t0 + 9 * MIN }, Object.assign({}, dec, { action: "unsure" }), 0), "not without a decision, nor for an unsure answer");

// --- 9. the earlier answer is kept under its own id ---
const kept = SE.supersededCopy(dec, t0 + 10 * MIN);
ok(kept.id === "lnew|prev|" + dec.decidedAt && kept.momentId === "lnew" && kept.supersededAt === t0 + 10 * MIN && kept.action === "buy" && dec.id === "lnew", "the earlier answer is copied to <moment>|prev|<decidedAt> with supersededAt; the original is unchanged");
ok(!SE.needsRedecide({ lastTs: t0 + 20 * MIN }, kept, 0), "a superseded answer is never asked again");

// --- 10. an unsure moment is asked again only when what the model is shown changed ---
const shown = { id: "lnew", kind: "look", stock: "Stock 3", pricePath: [1.2, -0.4], research: { viewsBefore30d: 4, pageTypes: ["overview"] }, session: { views: 3, returns: 0 } };
const unsureRec = { id: "lnew|unsure|1", momentId: "lnew", action: "unsure", input: JSON.parse(JSON.stringify(shown)) };
const reordered = { session: { returns: 0, views: 3 }, research: { pageTypes: ["overview"], viewsBefore30d: 4 }, pricePath: [1.2, -0.4], stock: "Stock 3", kind: "look", id: "lnew" };
ok(!SE.askAgainUnsure(unsureRec, shown) && !SE.askAgainUnsure(unsureRec, reordered), "an unsure moment is not asked again while its input is the same (key order does not matter)");
ok(SE.askAgainUnsure(unsureRec, Object.assign({}, shown, { session: { views: 5, returns: 1 } })) && SE.askAgainUnsure(unsureRec, Object.assign({}, shown, { pricePath: [1.2, -0.4, 2.1] })), "it is asked again when the session or the prices changed");
ok(SE.askAgainUnsure(null, shown) && SE.askAgainUnsure({ action: "unsure" }, shown), "a moment without an unsure answer, or one saved without its input, is asked");

// --- 10b. the size migration never drops an unsure answer (it would be deleted and asked again, round after round) ---
{
  const live = 2 * DAY, now = t0 + DAY, base = { agent: "ai", t: t0, action: "buy" };
  ok(SE.needsSizeMigration(base, now, live) && !SE.needsSizeMigration(Object.assign({}, base, { sizeUnit: "weight" }), now, live), "a buy saved before sizes were weights is migrated; one with a sizeUnit is not");
  ok(!SE.needsSizeMigration(Object.assign({}, base, { action: "unsure" }), now, live) && !SE.needsSizeMigration(Object.assign({}, base, { action: "hold" }), now, live) &&
    !SE.needsSizeMigration(Object.assign({}, base, { agent: "rules" }), now, live) && !SE.needsSizeMigration(base, t0 + 3 * DAY, live), "never an unsure answer, a hold, the rules agent or a moment outside the live window");
}

// --- 11. the headless dashboard starts the agent only after every script has loaded (trAgentHeadless is in dashboard/shadow.js, loaded later) ---
{
  const vm = require("vm"), fs = require("fs");
  const line = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dashboard.js"), "utf8").split(/\r?\n/).find((l) => /^\s*if \(HEADLESS\)/.test(l));
  const run = (readyState) => {
    const ev = {}, calls = [];
    const sb = { HEADLESS: true, document: { readyState }, window: { addEventListener: (n, f) => { ev[n] = f; } }, headlessAgent: () => calls.push(1) };
    vm.runInNewContext("(function () {" + line + "})()", sb);
    return { calls, ev };
  };
  const loading = run("loading"), before = loading.calls.length;
  if (loading.ev.load) loading.ev.load();
  ok(!!line && before === 0 && loading.calls.length === 1, "while the page is loading, the headless agent waits for the load event, then runs once");
  ok(run("complete").calls.length === 1, "on a page already loaded it runs at once");
}

console.log(failed ? failed + " FAILED" : "all passed");
process.exit(failed ? 1 : 0);
