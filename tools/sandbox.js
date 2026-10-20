// A local sandbox of the real dashboard on a synthetic investor: the same pages
// and scripts as the app, with generated trades instead of your own, and the AI
// assistant answered by the ai-coach function's own logic running in the page with
// a stand-in model. Nothing is sent anywhere; no account, key or network needed.
//
//   node tools/sandbox.js              then open http://127.0.0.1:8780/
//   node tools/sandbox.js --port 9000
//
// It serves only the files the dashboard needs, to this computer only, and swaps
// src/config.js for an empty one so the page cannot reach any backend.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const port = +(process.argv.indexOf("--port") >= 0 ? process.argv[process.argv.indexOf("--port") + 1] : process.env.PORT) || 8780;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webmanifest": "application/manifest+json" };
const allowed = [/^\/dashboard\//, /^\/src\//, /^\/vendor\//, /^\/icons\//, /^\/tools\/synth-world\.js$/, /^\/tools\/sandbox-boot\.js$/, /^\/supabase\/functions\/ai-coach\/core\.mjs$/];
const OFFLINE = "(function(){var g=self;g.AT_SERVER_URL='';g.AT_REGISTER_KEY='';g.AT_SUPABASE_URL='';g.AT_SUPABASE_ANON='';g.AT_SUPABASE_FUNCTIONS='';})();\n";

http.createServer(function (req, res) {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = decodeURIComponent(u.pathname);
  const send = function (code, body, type) { res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" }); res.end(body); };
  if (req.method !== "GET") return send(405, "GET only");
  if (p === "/" || p === "/sandbox") { res.writeHead(302, { Location: "/dashboard/sandbox.html" + u.search }); return res.end(); }
  if (p === "/src/config.js") return send(200, OFFLINE, types[".js"]);
  if (p === "/dashboard/sandbox.html") {
    const html = fs.readFileSync(path.join(root, "dashboard", "dashboard.html"), "utf8")
      .replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/g, "") // no request to another host, so nothing leaves this computer
      .replace("</body>", "  <script src=\"../tools/synth-world.js\"></script>\n  <script src=\"../tools/sandbox-boot.js\"></script>\n</body>");
    return send(200, html, types[".html"]);
  }
  const file = path.normalize(path.join(root, p));
  // the allowlist is checked on the resolved path, so "/src/../server/server.js" cannot slip through
  const rel = "/" + path.relative(root, file).split(path.sep).join("/");
  if (!file.startsWith(root + path.sep) || !allowed.some(function (r) { return r.test(rel); })) return send(404, "Not found");
  fs.readFile(file, function (err, data) { if (err) return send(404, "Not found"); send(200, data, types[path.extname(file)] || "application/octet-stream"); });
}).listen(port, "127.0.0.1", function () {
  console.log("Stocktrails sandbox: http://127.0.0.1:" + port + "/   (Ctrl+C to stop)");
  console.log("A synthetic investor; the assistant runs on a stand-in model; nothing leaves this computer.");
});
