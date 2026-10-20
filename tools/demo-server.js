// The real dashboard as a local web page with an empty account, for recording
// the demo video on the files from tools/demo-data.js. Unlike tools/sandbox.js
// nothing is pre-filled: the trades and the browsing history go in through the
// app's own import buttons. Prices come live from Yahoo through a proxy here,
// as the PWA's backend proxy does. No account, sign-in or backend.
//
//   node tools/demo-server.js            then open http://127.0.0.1:8781/
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const port = +(process.argv.indexOf("--port") >= 0 ? process.argv[process.argv.indexOf("--port") + 1] : 8781);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const allowed = [/^\/dashboard\//, /^\/src\//, /^\/vendor\//, /^\/icons\//, /^\/supabase\/functions\/ai-coach\/core\.mjs$/];
const OFFLINE = "(function(){var g=self;g.AT_SERVER_URL='';g.AT_REGISTER_KEY='';g.AT_SUPABASE_URL='';g.AT_SUPABASE_ANON='';g.AT_SUPABASE_FUNCTIONS='';})();\n";
const YAHOO = /^\/(v8\/finance\/chart|v1\/finance\/search|v7\/finance\/quote|v10\/finance\/quoteSummary|ws\/fundamentals-timeseries)\//;

http.createServer(async function (req, res) {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = decodeURIComponent(u.pathname);
  const send = function (code, body, type) { res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" }); res.end(body); };
  if (req.method !== "GET") return send(405, "GET only");
  if (p === "/") { res.writeHead(302, { Location: "/dashboard/demo.html" }); return res.end(); }
  if (p === "/yahoo") {
    const yp = u.searchParams.get("path") || "";
    if (!YAHOO.test(yp)) return send(404, "{}", types[".json"]);
    try {
      const r = await fetch("https://query1.finance.yahoo.com" + yp, { headers: { "User-Agent": "Mozilla/5.0" } });
      return send(r.status, await r.text(), types[".json"]);
    } catch (e) { return send(502, "{}", types[".json"]); }
  }
  if (p === "/src/config.js") return send(200, OFFLINE, types[".js"]);
  if (p === "/dashboard/demo.html") {
    const html = fs.readFileSync(path.join(root, "dashboard", "dashboard.html"), "utf8")
      .replace("</body>", "  <script>(function(){var g=document.getElementById('auth-gate');if(g)g.style.display='none';})();</script>\n</body>");
    return send(200, html, types[".html"]);
  }
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root + path.sep) || !allowed.some(function (r) { return r.test(p); })) return send(404, "Not found");
  fs.readFile(file, function (err, data) { if (err) return send(404, "Not found"); send(200, data, types[path.extname(file)] || "application/octet-stream"); });
}).listen(port, "127.0.0.1", function () {
  console.log("Stocktrails demo (empty account): http://127.0.0.1:" + port + "/   (Ctrl+C to stop)");
});
