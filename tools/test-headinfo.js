// Every headline of the app (dashboard.html, signed-in part, not the admin tab) must have an
// explanation: a title attribute or an entry in dashboard/headinfo.js. Run: node tools/test-headinfo.js
const fs = require("fs"), path = require("path");
const H = require(path.join(__dirname, "..", "dashboard", "headinfo.js"));
const html = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dashboard.html"), "utf8");
const from = html.indexOf("<main>"), adminAt = html.search(/<!--[^>]*ADMIN/);
const part = html.slice(from, adminAt > from ? adminAt : undefined);
const lookup = (id, text) => {
  if (id && H.BY_ID[id]) return true;
  const t = H.norm(text);
  return !!H.BY_TEXT[t] || Object.keys(H.BY_TEXT).some((k) => t.indexOf(k) === 0);
};
let failed = 0, n = 0;
const re = /<h([2-5])([^>]*)>([\s\S]*?)<\/h\1>/g;
let m;
while ((m = re.exec(part))) {
  const attrs = m[2], text = m[3].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&rarr;/g, ">"), id = (/id="([^"]+)"/.exec(attrs) || [])[1];
  if (/^coming soon/i.test(text.trim())) continue;
  n++;
  const ok = /\btitle="/.test(attrs) || lookup(id, text);
  if (!ok) { failed++; console.log("FAIL no explanation: " + text.trim()); }
}
console.log((failed ? "FAIL " : "PASS ") + n + " headlines checked, " + failed + " without an explanation");
if (failed) process.exit(1);
console.log("all passed");
