// Smoke test of the sandbox server (tools/sandbox.js): it starts, serves the dashboard on a synthetic
// investor, cannot reach any backend, serves only the files the dashboard needs, and every script the
// page loads can be fetched. Starts the server on a free local port and stops it again.
// No network, no install. Run: node tools/test-sandbox.js (exit code 1 on failure).
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? "PASS " : "FAIL ") + m); };

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });
const request = (port, p, method) => new Promise((res, rej) => {
  const r = http.request({ host: "127.0.0.1", port, path: p, method: method || "GET" }, (resp) => { const b = []; resp.on("data", (d) => b.push(d)); resp.on("end", () => res({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(b).toString("utf8") })); });
  r.on("error", rej); r.setTimeout(10000, () => r.destroy(new Error("timeout"))); r.end();
});

(async function () {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "sandbox.js"), "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const started = await new Promise((res) => { const t = setTimeout(() => res(false), 15000); const iv = setInterval(() => { if (/sandbox: http/.test(out)) { clearTimeout(t); clearInterval(iv); res(true); } }, 50); });
  try {
    ok(started, "the sandbox server starts and announces its address");
    if (!started) throw new Error("not started: " + out);

    // entry point and page
    const root = await request(port, "/?persona=fomo");
    ok(root.status === 302 && /^\/dashboard\/sandbox\.html\?persona=fomo$/.test(root.headers.location || ""), "/ redirects to the sandbox page and keeps the query (persona)");
    const page = await request(port, "/dashboard/sandbox.html?persona=herd");
    ok(page.status === 200 && /text\/html/.test(page.headers["content-type"]) && /sandbox-boot\.js/.test(page.body) && /synth-world\.js/.test(page.body), "the sandbox page is the dashboard with the synthetic investor scripts added");
    ok(page.headers["cache-control"] === "no-store", "responses are not cached");

    // offline by construction
    const cfg = await request(port, "/src/config.js");
    ok(cfg.status === 200 && /AT_SUPABASE_URL=''/.test(cfg.body) && /AT_SUPABASE_ANON=''/.test(cfg.body) && /AT_SUPABASE_FUNCTIONS=''/.test(cfg.body) && /AT_SERVER_URL=''/.test(cfg.body), "the client config is replaced by an empty one: no backend can be reached");

    // every script and stylesheet of the page can be fetched
    const refs = [...page.body.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"'#]+)["']/g)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\//.test(u) && !/^(data|mailto):/.test(u));
    const resolved = [...new Set(refs.map((u) => path.posix.normalize(path.posix.join("/dashboard/", u.split("?")[0]))))];
    const results = await Promise.all(resolved.map(async (u) => [u, (await request(port, u)).status]));
    const broken = results.filter(([, s]) => s !== 200);
    ok(resolved.length >= 10 && !broken.length, "all " + resolved.length + " local scripts and styles of the page are served" + (broken.length ? " (missing: " + broken.map((b) => b[0] + " " + b[1]).join(", ") + ")" : ""));
    ok(!/<(?:script|link)[^>]+(?:src|href)=["']\s*(?:https?:)?\/\/[^"']+/.test(page.body.replace(/<link[^>]+rel=["'](?:canonical|alternate|icon)["'][^>]*>/g, "")), "the page loads nothing from another host");
    const core = await request(port, "/supabase/functions/ai-coach/core.mjs");
    ok(core.status === 200 && /javascript/.test(core.headers["content-type"]), "the assistant's server logic (core.mjs) is served to run in the page with the stand-in model");

    // only the allowed files
    const blocked = ["/server/server.js", "/supabase/schema.sql", "/docs/hackathon/SECURITY.md", "/README.md", "/manifest.json", "/.git/config", "/mobile/lib/config.ts", "/tools/sandbox.js", "/.github/workflows/deploy-pwa.yml"];
    const bs = await Promise.all(blocked.map(async (u) => [u, (await request(port, u)).status]));
    ok(bs.every(([, s]) => s === 404), "files outside the dashboard's needs are refused (" + bs.map(([u, s]) => u + " " + s).join(", ") + ")");
    const trav = await Promise.all(["/dashboard/..%2f..%2fREADME.md", "/dashboard/%2e%2e/%2e%2e/server/server.js", "/src/..%2fserver%2fserver.js", "/dashboard/../../etc/passwd"].map(async (u) => (await request(port, u)).status));
    ok(trav.every((s) => s === 404 || s === 400), "path traversal is refused (" + trav.join(", ") + ")");
    const post = await request(port, "/dashboard/sandbox.html", "POST");
    ok(post.status === 405, "only GET is accepted");

    // reachable from this computer only
    const nets = require("os").networkInterfaces();
    const external = [].concat(...Object.values(nets)).find((i) => i && !i.internal && i.family === "IPv4");
    if (external) {
      const reach = await new Promise((res) => { const s = net.connect({ host: external.address, port, timeout: 3000 }); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); s.on("timeout", () => { s.destroy(); res(false); }); });
      ok(!reach, "the server does not listen on the network interface " + external.address + " (loopback only)");
    } else console.log("SKIP loopback-only check: no external interface on this machine");
  } catch (e) {
    ok(false, "unexpected error: " + (e && e.message));
  } finally {
    child.kill();
  }
  console.log("\n" + (failed ? failed + " FAILED" : "all passed"));
  process.exit(failed ? 1 : 0);
})();
