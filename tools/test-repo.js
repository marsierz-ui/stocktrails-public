// Static checks of the repository itself: the extension manifest and its permissions, what is packaged
// and published, the database migrations (row-level security, pinned search paths) and that no secret
// is committed. No network, no install, nothing is executed from the repository.
// Run: node tools/test-repo.js (exit code 1 on failure).
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const root = path.join(__dirname, "..");
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? "PASS " : "FAIL ") + m); };
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const has = (p) => fs.existsSync(path.join(root, p));

// ---- the files that belong to the repository: tracked or new-but-not-ignored (git), else a walk ----
function listFiles() {
  try {
    const out = cp.execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"] }).toString();
    const files = out.split("\0").filter(Boolean).filter((f) => has(f));
    if (files.length) return { git: true, files };
  } catch (e) { /* no git: walk */ }
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if ([".git", ".claude", "node_modules", "dist"].includes(e.name)) continue;
      const rel = dir ? dir + "/" + e.name : e.name;
      if (e.isDirectory()) walk(rel); else files.push(rel);
    }
  })("");
  return { git: false, files };
}
const { git, files } = listFiles();
console.log("# " + files.length + " repository files (" + (git ? "git" : "directory walk") + ")");

// ---------------------------------------------------------------- 1. extension manifest
const M = JSON.parse(read("manifest.json"));
ok(M.manifest_version === 3, "manifest: Manifest V3");
ok(/^\d+\.\d+\.\d+$/.test(M.version), "manifest: version is x.y.z (" + M.version + ")");
const ALLOWED_PERMISSIONS = ["storage", "unlimitedStorage", "tabs", "scripting", "alarms", "offscreen", "identity"];
const extra = (M.permissions || []).filter((p) => !ALLOWED_PERMISSIONS.includes(p));
ok(!extra.length, "manifest: only the reviewed permissions are requested" + (extra.length ? " (new: " + extra.join(", ") + "; review docs/hackathon/SECURITY.md first)" : ""));
const WIDE = ["<all_urls>", "*://*/*", "http://*/*", "https://*/*", "file:///*"];
ok((M.host_permissions || []).every((h) => /^https:\/\//.test(h) && !WIDE.includes(h)), "manifest: required host permissions are specific https hosts, none is a wildcard of everything");
ok((M.optional_host_permissions || []).length > 0, "manifest: broad site access exists only as an optional permission the user grants (own portals)");
const cs = M.content_scripts || [];
ok(cs.length > 0 && cs.every((c) => c.matches.every((u) => /^https:\/\//.test(u) && !WIDE.includes(u) && (M.host_permissions || []).includes(u))), "manifest: content scripts run only on https hosts that are also declared host permissions");
const referenced = [M.background && M.background.service_worker, M.action && M.action.default_popup]
  .concat(Object.values((M.action && M.action.default_icon) || {}), Object.values(M.icons || {}))
  .concat(...cs.map((c) => (c.js || []).concat(c.css || [])));
const missing = referenced.filter((f) => !f || !has(f));
ok(!missing.length, "manifest: every referenced file exists (" + referenced.length + " references)" + (missing.length ? " missing: " + missing.join(", ") : ""));
ok(!M.content_security_policy || !/unsafe-eval|unsafe-inline|https?:\/\//.test(JSON.stringify(M.content_security_policy)), "manifest: no relaxed content security policy");

// ---------------------------------------------------------------- 2. what is packaged: no remote code
const pack = read("tools/pack-extension.sh");
const items = ((/ITEMS=\(([^)]*)\)/.exec(pack) || [])[1] || "").trim().split(/\s+/).filter(Boolean);
ok(items.length >= 5 && items.every((i) => has(i)), "package: every item of tools/pack-extension.sh exists (" + items.join(", ") + ")");
const packaged = files.filter((f) => items.some((i) => f === i || f.startsWith(i + "/")) && f !== "vendor/supabase.min.js");
const remoteHtml = packaged.filter((f) => /\.html$/.test(f) && /<script[^>]+src=["']\s*(https?:)?\/\//i.test(read(f)));
const remoteJs = packaged.filter((f) => /\.m?js$/.test(f) && !/^vendor\//.test(f) && /importScripts\(\s*["']\s*https?:|import\(\s*["']\s*https?:/.test(read(f)));
ok(!remoteHtml.length && !remoteJs.length, "package: no page or script of the extension loads remote code" + (remoteHtml.length + remoteJs.length ? ": " + remoteHtml.concat(remoteJs).join(", ") : ""));
const underscore = files.filter((f) => items.some((i) => f === i || f.startsWith(i + "/")) && f.split("/").some((s) => s.startsWith("_")));
ok(!underscore.length, "package: no file or folder name starts with an underscore (reserved by the browser)" + (underscore.length ? ": " + underscore.join(", ") : ""));
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(read("dashboard/dashboard.html"));
ok(csp && /script-src 'self'/.test(csp[1]) && /object-src 'none'/.test(csp[1]) && !/unsafe-/.test(csp[1]), "dashboard: content security policy allows own scripts only, no plugins, no unsafe-*");

// ---------------------------------------------------------------- 3. what is published as the web app
const deploy = read(".github/workflows/deploy-pwa.yml");
const cpLine = /cp -r ([^\n]*?) site\//.exec(deploy);
const published = cpLine ? cpLine[1].trim().split(/\s+/) : [];
ok(published.length > 0 && published.every((p) => has(p)), "web app: every published path exists (" + published.join(", ") + ")");
const NEVER_PUBLISH = ["server", "supabase", "docs", "mobile", "store", "tools", ".github", ".claude", "."];
ok(!published.some((p) => NEVER_PUBLISH.includes(p.replace(/\/$/, ""))), "web app: server code, SQL, documentation, mobile and tools are not published");
ok(/refs\/heads\/main/.test(deploy), "web app: the deploy job runs only for the main branch");
for (const f of ["manifest.webmanifest", "manifest.json"]) { let good = true; try { JSON.parse(read(f)); } catch (e) { good = false; } ok(good, "web app: " + f + " is valid JSON"); }

// ---------------------------------------------------------------- 4. database
const migs = fs.readdirSync(path.join(root, "supabase", "migrations")).filter((f) => !f.startsWith("."));
ok(migs.length > 0 && migs.every((f) => /^\d{8}_[a-z0-9_]+\.sql$/.test(f)), "database: " + migs.length + " migrations, every file name is <yyyymmdd>_<name>.sql so they apply in date order");
ok(has("supabase/schema.sql"), "database: base schema present");
const sqlFiles = ["supabase/schema.sql"].concat(migs.map((f) => "supabase/migrations/" + f));
const sql = sqlFiles.map(read).join("\n").replace(/--[^\n]*/g, "");
const tables = [...new Set([...sql.matchAll(/create table(?: if not exists)?\s+(?:public\.)?([a-z_]+)/gi)].map((m) => m[1].toLowerCase()))];
const rls = new Set([...sql.matchAll(/alter table\s+(?:if exists\s+)?(?:public\.)?([a-z_]+)\s+enable row level security/gi)].map((m) => m[1].toLowerCase()));
const noRls = tables.filter((t) => !rls.has(t));
ok(tables.length > 0 && !noRls.length, "database: row-level security is enabled on all " + tables.length + " tables" + (noRls.length ? " (not on: " + noRls.join(", ") + ")" : ""));
// every SECURITY DEFINER function pins its search_path (in its definition or by a later ALTER FUNCTION)
const defs = sql.split(/\bcreate\s+(?:or\s+replace\s+)?function\b/i).slice(1);
const definers = defs.filter((d) => /security\s+definer/i.test(d.slice(0, d.search(/\$\$|\$[a-z_]+\$/) > 0 ? d.search(/\$\$|\$[a-z_]+\$/) : 600)));
const pinnedLater = [...sql.matchAll(/alter function\s+(?:public\.)?([a-z_0-9]+)[^;]*set search_path/gi)].map((m) => m[1].toLowerCase());
const unpinned = definers.filter((d) => {
  const name = (/^\s*(?:public\.)?([a-z_0-9]+)/i.exec(d) || [])[1];
  const head = d.slice(0, 2500);
  return !/set\s+search_path/i.test(head) && !pinnedLater.includes((name || "").toLowerCase());
}).map((d) => (/^\s*(?:public\.)?([a-z_0-9]+)/i.exec(d) || [])[1]);
ok(definers.length > 0 && !unpinned.length, "database: all " + definers.length + " SECURITY DEFINER function definitions pin search_path" + (unpinned.length ? " (not: " + unpinned.join(", ") + ")" : ""));
const fnDirs = fs.readdirSync(path.join(root, "supabase", "functions"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
ok(fnDirs.length > 0 && fnDirs.every((d) => has("supabase/functions/" + d + "/index.ts")), "functions: each of the " + fnDirs.length + " edge functions has an index.ts (" + fnDirs.join(", ") + ")");

// ---------------------------------------------------------------- 5. no secret in the repository
const TEXT = /\.(js|mjs|ts|tsx|json|md|sql|html|css|yml|yaml|sh|ps1|toml|txt|csv|py)$/i;
const scan = files.filter((f) => TEXT.test(f) && !/^vendor\//.test(f) && !/package-lock\.json$/.test(f) && fs.statSync(path.join(root, f)).size <= 3 << 20);
const PATTERNS = [
  ["OpenRouter key", /sk-or-v1-[A-Za-z0-9]{20,}/], ["Google API key", /AIza[0-9A-Za-z_-]{35}/], ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/], ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/], ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{20,}/], ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
];
const hits = [], jwtRoles = new Set();
for (const f of scan) {
  const t = read(f);
  for (const [name, re] of PATTERNS) if (re.test(t)) hits.push(name + " in " + f);
  for (const m of t.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
    try { jwtRoles.add(JSON.parse(Buffer.from(m[1], "base64url").toString()).role || "none"); } catch (e) { /* not a JWT */ }
  }
}
ok(!hits.length, "secrets: no provider key, token or private key in " + scan.length + " text files" + (hits.length ? " - " + hits.join("; ") : ""));
ok(!jwtRoles.has("service_role"), "secrets: no service-role JWT committed (roles found in embedded JWTs: " + ([...jwtRoles].join(", ") || "none") + "; the anon key is public by design and protected by row-level security)");
const FORBIDDEN = files.filter((f) => /(^|\/)\.env(\..*)?$/.test(f) || /^server\/(tokens\.json|attention\.db)$/.test(f) || /\.(pem|p12|pfx|keystore|jks)$/i.test(f));
ok(!FORBIDDEN.length, "secrets: no environment file, token file, local database or key store in the repository" + (FORBIDDEN.length ? ": " + FORBIDDEN.join(", ") : ""));
const cfg = read("src/config.js");
ok(/AT_SERVER_URL\s*=\s*""/.test(cfg) && /AT_REGISTER_KEY\s*=\s*""/.test(cfg), "secrets: client config carries no token-server URL or registration key");
ok(!/changeme/i.test(read("server/server.js")), "secrets: the optional sync server has no built-in default token");

console.log("\n" + (failed ? failed + " FAILED" : "all passed"));
if (failed) process.exit(1);
