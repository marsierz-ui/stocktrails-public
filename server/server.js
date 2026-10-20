// Attention Tracker sync + admin server.
// Express + node:sqlite (built-in; no native build).
// Multi-user via per-friend tokens (no Google/Supabase yet): each token maps to
// a user_id; all data is stored centrally and the admin can view it per-user and
// aggregated. Price bars are NOT synced - clients refetch from Yahoo.
//
// Run:  AT_ADMIN_TOKEN=admin-secret node server.js
// Env:  AT_ADMIN_TOKEN  admin password for /admin (required for admin pages)
//       AT_TOKEN        fallback single-user token (user_id "default") if no tokens.json
//       AT_TOKENS       optional path to tokens.json (default ./tokens.json)
//       AT_FEEDBACK_WEBHOOK  optional Slack/Discord webhook URL for new-feedback pings
//       PORT (8787), AT_DB (attention.db)

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.AT_DB || "attention.db";
const ADMIN_TOKEN = process.env.AT_ADMIN_TOKEN || "";
// No default credentials: the admin routes return every user's events and feedback.
const weakToken = function (t) { return t.length < 24 || /change-?me/i.test(t); };
if (weakToken(ADMIN_TOKEN)) { console.error("Set AT_ADMIN_TOKEN to 24+ random characters."); process.exit(1); }
if (process.env.AT_TOKEN && weakToken(process.env.AT_TOKEN)) { console.error("AT_TOKEN is weak: unset it or use 24+ random characters."); process.exit(1); }
// Feedback delivery. Switch with AT_FEEDBACK_SINK = discord | github | both | none.
const DISCORD_WEBHOOK = process.env.AT_DISCORD_WEBHOOK || process.env.AT_FEEDBACK_WEBHOOK || "";
const GITHUB_TOKEN = process.env.AT_GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.AT_GITHUB_REPO || ""; // "owner/repo"
const SINK = (process.env.AT_FEEDBACK_SINK || (DISCORD_WEBHOOK ? "discord" : "none")).toLowerCase();
const REGISTER_KEY = process.env.AT_REGISTER_KEY || ""; // if set, /register requires it

// token -> { user_id, name }. From tokens.json, else a single fallback token.
function loadTokens() {
  const file = process.env.AT_TOKENS || path.join(__dirname, "tokens.json");
  const map = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.keys(raw).forEach(function (tok) {
      const v = raw[tok];
      map[tok] = typeof v === "string" ? { user_id: v, name: v } : { user_id: v.user_id, name: v.name || v.user_id };
    });
  } catch (e) { /* no tokens.json */ }
  if (process.env.AT_TOKEN && !map[process.env.AT_TOKEN]) map[process.env.AT_TOKEN] = { user_id: "default", name: "default" };
  return map;
}
let TOKENS = loadTokens();

const db = new DatabaseSync(DB_PATH);
// Migrate away from the old single-user schema (no user_id column): if an old
// `events` table exists without user_id, rename the stale tables so the new
// per-user schema is created fresh instead of crashing on startup.
try {
  const cols = db.prepare("PRAGMA table_info(events)").all();
  if (cols.length && !cols.some(function (c) { return c.name === "user_id"; })) {
    db.exec("ALTER TABLE events RENAME TO events_legacy");
    try { db.exec("ALTER TABLE intraday RENAME TO intraday_legacy"); } catch (e) { /* may not exist */ }
    try { db.exec("ALTER TABLE meta RENAME TO meta_legacy"); } catch (e) { /* may not exist */ }
    console.log("Migrated old single-user tables to *_legacy; per-user schema will be created fresh.");
  }
} catch (e) { /* fresh db */ }
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    user_id TEXT NOT NULL, id TEXT NOT NULL, ticker TEXT, ts INTEGER, source TEXT, url TEXT,
    sentiment TEXT, priceAtEvent REAL, views INTEGER, updatedAt INTEGER, deleted INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS intraday (
    user_id TEXT NOT NULL, id TEXT NOT NULL, ticker TEXT, ts INTEGER, source TEXT, url TEXT,
    sentiment TEXT, priceAtEvent REAL, updatedAt INTEGER, deleted INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS meta (user_id TEXT PRIMARY KEY, v TEXT, updatedAt INTEGER);
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, text TEXT, url TEXT,
    screenshot TEXT, created_at INTEGER, status TEXT DEFAULT 'new', category TEXT, issue_url TEXT
  );
  CREATE TABLE IF NOT EXISTS users (token TEXT PRIMARY KEY, user_id TEXT, name TEXT, created_at INTEGER);
  CREATE INDEX IF NOT EXISTS events_u ON events(user_id, updatedAt);
  CREATE INDEX IF NOT EXISTS intraday_u ON intraday(user_id, updatedAt);
`);
try { db.exec("ALTER TABLE feedback ADD COLUMN issue_url TEXT"); } catch (e) { /* already exists */ }
// Merge auto-registered users (Option A) into the in-memory token map.
try {
  db.prepare("SELECT token,user_id,name FROM users").all().forEach(function (r) {
    if (!TOKENS[r.token]) TOKENS[r.token] = { user_id: r.user_id, name: r.name || r.user_id };
  });
} catch (e) { /* no users yet */ }

const upsertEvent = db.prepare(`
  INSERT INTO events (user_id,id,ticker,ts,source,url,sentiment,priceAtEvent,views,updatedAt,deleted)
  VALUES (?,?,?,?,?,?,?,?,?,?,0)
  ON CONFLICT(user_id,id) DO UPDATE SET ticker=excluded.ticker, ts=excluded.ts, source=excluded.source,
    url=excluded.url, sentiment=excluded.sentiment, priceAtEvent=excluded.priceAtEvent,
    views=excluded.views, updatedAt=excluded.updatedAt, deleted=0
  WHERE excluded.updatedAt > events.updatedAt`);
const upsertIntraday = db.prepare(`
  INSERT INTO intraday (user_id,id,ticker,ts,source,url,sentiment,priceAtEvent,updatedAt,deleted)
  VALUES (?,?,?,?,?,?,?,?,?,0)
  ON CONFLICT(user_id,id) DO UPDATE SET ticker=excluded.ticker, ts=excluded.ts, source=excluded.source,
    url=excluded.url, sentiment=excluded.sentiment, priceAtEvent=excluded.priceAtEvent,
    updatedAt=excluded.updatedAt, deleted=0
  WHERE excluded.updatedAt > intraday.updatedAt`);
const tombEvent = db.prepare(`
  INSERT INTO events (user_id,id,updatedAt,deleted) VALUES (?,?,?,1)
  ON CONFLICT(user_id,id) DO UPDATE SET deleted=1, updatedAt=excluded.updatedAt
  WHERE excluded.updatedAt > events.updatedAt`);
const tombIntraday = db.prepare(`
  INSERT INTO intraday (user_id,id,updatedAt,deleted) VALUES (?,?,?,1)
  ON CONFLICT(user_id,id) DO UPDATE SET deleted=1, updatedAt=excluded.updatedAt
  WHERE excluded.updatedAt > intraday.updatedAt`);
const upsertMeta = db.prepare(`
  INSERT INTO meta (user_id,v,updatedAt) VALUES (?,?,?)
  ON CONFLICT(user_id) DO UPDATE SET v=excluded.v, updatedAt=excluded.updatedAt
  WHERE excluded.updatedAt > meta.updatedAt`);

const qLiveEvents = db.prepare("SELECT id,ticker,ts,source,url,sentiment,priceAtEvent,views,updatedAt FROM events WHERE user_id=? AND updatedAt>? AND deleted=0");
const qDelEvents = db.prepare("SELECT id,updatedAt FROM events WHERE user_id=? AND updatedAt>? AND deleted=1");
const qLiveIntra = db.prepare("SELECT id,ticker,ts,source,url,sentiment,priceAtEvent,updatedAt FROM intraday WHERE user_id=? AND updatedAt>? AND deleted=0");
const qDelIntra = db.prepare("SELECT id,updatedAt FROM intraday WHERE user_id=? AND updatedAt>? AND deleted=1");
const qMeta = db.prepare("SELECT v,updatedAt FROM meta WHERE user_id=? AND updatedAt>?");
const insFeedback = db.prepare("INSERT INTO feedback (user_id,text,url,screenshot,created_at,status) VALUES (?,?,?,?,?,'new')");

const app = express();
app.use(express.json({ limit: "24mb" }));
app.use(function (req, res, next) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function bearer(req) { const a = req.get("authorization") || ""; return a.indexOf("Bearer ") === 0 ? a.slice(7) : ""; }
function userAuth(req, res, next) {
  const u = TOKENS[bearer(req)];
  if (!u) return res.status(401).json({ error: "unauthorized" });
  req.userId = u.user_id; next();
}
function adminAuth(req, res, next) {
  if (bearer(req) !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/health", function (_req, res) { res.json({ ok: true }); });

// Zero-config provisioning: a fresh client mints its own account/token on first
// run, then syncs automatically. user_id is the durable key (maps cleanly to a
// Google/Supabase uid later); the token is just the device credential.
const insUser = db.prepare("INSERT INTO users (token,user_id,name,created_at) VALUES (?,?,?,?)");
app.post("/register", function (req, res) {
  // A register key ships inside the client, so it cannot keep strangers out: minting
  // tokens is off unless the operator opts in.
  if (process.env.AT_ALLOW_REGISTER !== "1") return res.status(403).json({ error: "registration closed" });
  if (REGISTER_KEY && (req.body || {}).key !== REGISTER_KEY) return res.status(401).json({ error: "bad register key" });
  const token = "tok_" + crypto.randomUUID().replace(/-/g, "");
  const uid = "u_" + crypto.randomUUID().slice(0, 8);
  const name = (req.body && req.body.name) ? String(req.body.name).slice(0, 40) : uid;
  insUser.run(token, uid, name, Date.now());
  TOKENS[token] = { user_id: uid, name: name };
  res.json({ user_id: uid, token: token, name: name });
});

// static PWA hosting
app.use("/src", express.static(path.join(ROOT, "src")));
app.use("/dashboard", express.static(path.join(ROOT, "dashboard")));
app.use("/icons", express.static(path.join(ROOT, "icons")));
app.use("/pwa", express.static(path.join(ROOT, "pwa")));
app.use("/vendor", express.static(path.join(ROOT, "vendor")));
// Manifest + service worker live at the repo root so the SW scope covers the
// whole site and both work unchanged under a GitHub Pages subpath.
app.get("/manifest.webmanifest", function (_req, res) { res.sendFile(path.join(ROOT, "manifest.webmanifest")); });
app.get("/sw.js", function (_req, res) { res.sendFile(path.join(ROOT, "sw.js")); });
app.get("/share", function (_req, res) { res.sendFile(path.join(ROOT, "pwa", "share.html")); });
app.post("/share-target", function (_req, res) { res.redirect(303, "/pwa/share.html"); });
app.get("/admin", function (_req, res) { res.sendFile(path.join(ROOT, "pwa", "admin.html")); });
app.get("/", function (_req, res) { res.redirect("/dashboard/dashboard.html"); });

// Yahoo proxy (PWA CORS)
app.get("/yahoo", async function (req, res) {
  const p = String(req.query.path || "");
  if (p.indexOf("/v8/finance/") !== 0 && p.indexOf("/v1/finance/search") !== 0) return res.status(400).json({ error: "bad path" });
  try {
    const r = await fetch("https://query1.finance.yahoo.com" + p, { signal: AbortSignal.timeout(8000) });
    res.type("application/json").send(await r.text());
  } catch (e) { res.status(502).json({ error: String(e) }); }
});

// --- per-user sync ---
app.get("/sync", userAuth, function (req, res) {
  const since = Number(req.query.since || 0), uid = req.userId;
  const delMap = function (rows) { const o = {}; rows.forEach(function (r) { o[r.id] = r.updatedAt; }); return o; };
  const meta = qMeta.get(uid, since);
  res.json({
    events: qLiveEvents.all(uid, since),
    intraday: qLiveIntra.all(uid, since),
    deletions: { events: delMap(qDelEvents.all(uid, since)), intraday: delMap(qDelIntra.all(uid, since)) },
    meta: meta ? Object.assign({ updatedAt: meta.updatedAt }, JSON.parse(meta.v)) : null,
    serverTime: Date.now()
  });
});

app.post("/sync", userAuth, function (req, res) {
  const b = req.body || {}, uid = req.userId;
  const nz = function (v) { return v === undefined ? null : v; };
  db.exec("BEGIN");
  try {
    (b.events || []).forEach(function (e) {
      upsertEvent.run(uid, e.id, nz(e.ticker), nz(e.ts), nz(e.source), nz(e.url), nz(e.sentiment), typeof e.priceAtEvent === "number" ? e.priceAtEvent : null, Number.isInteger(e.views) ? e.views : 1, e.updatedAt || e.ts || 0);
    });
    (b.intraday || []).forEach(function (e) {
      upsertIntraday.run(uid, e.id, nz(e.ticker), nz(e.ts), nz(e.source), nz(e.url), nz(e.sentiment), typeof e.priceAtEvent === "number" ? e.priceAtEvent : null, e.updatedAt || e.ts || 0);
    });
    const de = (b.deletions && b.deletions.events) || {};
    Object.keys(de).forEach(function (id) { tombEvent.run(uid, id, de[id]); });
    const di = (b.deletions && b.deletions.intraday) || {};
    Object.keys(di).forEach(function (id) { tombIntraday.run(uid, id, di[id]); });
    if (b.meta && b.meta.updatedAt) {
      upsertMeta.run(uid, JSON.stringify({ overrides: b.meta.overrides || {}, customPortals: b.meta.customPortals || [], settings: b.meta.settings || {} }), b.meta.updatedAt);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: String(err) });
  }
  res.json({ ok: true, serverTime: Date.now() });
});

// --- feedback delivery (Discord backup / GitHub endgame, switchable) ---
async function sendDiscord(text) {
  if (!DISCORD_WEBHOOK) return;
  try { await fetch(DISCORD_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }) }); }
  catch (e) { /* non-fatal */ }
}
async function createGithubIssue(title, body) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) throw new Error("GitHub not configured (AT_GITHUB_TOKEN, AT_GITHUB_REPO)");
  const r = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/issues", {
    method: "POST",
    headers: { "Authorization": "Bearer " + GITHUB_TOKEN, "Accept": "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "attention-tracker" },
    body: JSON.stringify({ title: title.slice(0, 250), body: body, labels: ["feedback"] })
  });
  if (!r.ok) throw new Error("GitHub HTTP " + r.status + " " + (await r.text()).slice(0, 200));
  return (await r.json()).html_url;
}
function issueBody(user, text, url) {
  return "Feedback from **" + user + "**\n\n" + text + "\n\n" + (url ? "Page: " + url + "\n" : "") + "(screenshot in the admin page)";
}

app.post("/feedback", userAuth, async function (req, res) {
  const b = req.body || {};
  const text = String(b.text || "").slice(0, 5000), url = String(b.url || "").slice(0, 500);
  const info = insFeedback.run(req.userId, text, url, String(b.screenshot || "").slice(0, 8000000), Date.now());
  const id = info.lastInsertRowid;
  if (SINK === "discord" || SINK === "both") {
    await sendDiscord("New feedback from " + req.userId + ":\n" + text.slice(0, 500) + "\n(screenshot in admin page)");
  }
  if (SINK === "github" || SINK === "both") {
    try {
      const issueUrl = await createGithubIssue("[feedback] " + (text.split("\n")[0] || "(no title)"), issueBody(req.userId, text, url));
      db.prepare("UPDATE feedback SET issue_url=?, status='dispatched' WHERE id=?").run(issueUrl, id);
    } catch (e) { /* non-fatal: stays in DB for manual dispatch */ }
  }
  res.json({ ok: true });
});

// --- admin (token-gated) ---
app.get("/admin/users", adminAuth, function (_req, res) {
  const rows = db.prepare(`
    SELECT user_id,
      (SELECT COUNT(*) FROM events e WHERE e.user_id=u.user_id AND e.deleted=0) AS events,
      (SELECT COUNT(*) FROM intraday i WHERE i.user_id=u.user_id AND i.deleted=0) AS intraday,
      (SELECT MAX(ts) FROM events e WHERE e.user_id=u.user_id) AS last_ts
    FROM (SELECT DISTINCT user_id FROM events UNION SELECT DISTINCT user_id FROM intraday) u`).all();
  const names = {}; Object.keys(TOKENS).forEach(function (t) { names[TOKENS[t].user_id] = TOKENS[t].name; });
  res.json(rows.map(function (r) { return Object.assign(r, { name: names[r.user_id] || r.user_id }); }));
});

app.get("/admin/user/:id", adminAuth, function (req, res) {
  res.json({
    events: db.prepare("SELECT id,ticker,ts,source,url,sentiment,priceAtEvent,views FROM events WHERE user_id=? AND deleted=0 ORDER BY ts DESC LIMIT 2000").all(req.params.id)
  });
});

app.get("/admin/aggregate", adminAuth, function (_req, res) {
  res.json({
    totals: db.prepare("SELECT COUNT(DISTINCT user_id) AS users, COUNT(*) AS events FROM events WHERE deleted=0").get(),
    topTickers: db.prepare("SELECT ticker, COUNT(*) AS views, COUNT(DISTINCT user_id) AS users FROM events WHERE deleted=0 GROUP BY ticker ORDER BY views DESC LIMIT 50").all(),
    sentiment: db.prepare("SELECT COALESCE(sentiment,'none') AS sentiment, COUNT(*) AS n FROM events WHERE deleted=0 GROUP BY sentiment").all()
  });
});

app.get("/admin/feedback", adminAuth, function (_req, res) {
  res.json(db.prepare("SELECT id,user_id,text,url,screenshot,created_at,status,category,issue_url FROM feedback ORDER BY created_at DESC LIMIT 500").all());
});

app.post("/admin/feedback/:id", adminAuth, function (req, res) {
  const b = req.body || {};
  db.prepare("UPDATE feedback SET status=COALESCE(?,status), category=COALESCE(?,category) WHERE id=?")
    .run(b.status == null ? null : String(b.status), b.category == null ? null : String(b.category), Number(req.params.id));
  res.json({ ok: true });
});

// On-demand dispatch to GitHub (the triage -> approve -> dispatch path).
app.post("/admin/feedback/:id/issue", adminAuth, async function (req, res) {
  const row = db.prepare("SELECT * FROM feedback WHERE id=?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "not found" });
  if (row.issue_url) return res.json({ ok: true, url: row.issue_url });
  try {
    const url = await createGithubIssue("[feedback] " + (String(row.text).split("\n")[0] || "(no title)"), issueBody(row.user_id, row.text, row.url));
    db.prepare("UPDATE feedback SET issue_url=?, status='dispatched' WHERE id=?").run(url, row.id);
    res.json({ ok: true, url: url });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.listen(PORT, function () { console.log("Attention Tracker server on :" + PORT + " (db " + DB_PATH + ", users " + Object.keys(TOKENS).length + ")"); });
