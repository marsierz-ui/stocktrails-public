// How well are finance pages classified (question 6's "page type")? A report over
// a browsing-history file, run on your own computer; nothing is uploaded. Only
// visits to the supported finance sites are looked at (everything else in the
// file is dropped by the same reader the app uses), and only host and path
// templates are printed, never full URLs or query strings.
//
//   node tools/classifier-report.js history.csv              the report
//   node tools/classifier-report.js history.csv --csv t.csv  also write the templates to label
//   node tools/classifier-report.js history.csv --eval t.csv score the classifier against labels
//
// The first step of issue #17: measure how much falls back to "overview" (the
// classifier's default, which mixes "unknown" with a real overview page) before
// adding rules. The CSV has one row per host and path template with how often it
// was visited and what the classifier says now; fill the `label` column (by hand,
// or with a model that reads the templates, which carry no personal data), keep the
// rows you are sure of, and --eval tells you the share the classifier already gets
// right. Ship a new rule only if it clearly beats that on rows it was not written from.
const fs = require("fs");
const path = require("path");
global.self = global;
require(path.join(__dirname, "..", "src", "portals.js"));
global.ATLedger = require(path.join(__dirname, "..", "src", "ledger.js"));
const H = require(path.join(__dirname, "..", "src", "history.js"));

const TYPES = ["overview", "news", "financials", "analysis", "charts", "community", "screener", "options", "ownership", "profile", "ai", "insider", "short", "institutional", "dividends", "earnings", "estimates"];

// /stocks/aapl/financials/balance-sheet/?p=quarterly -> /stocks/:t/financials/balance-sheet
function templateOf(url, ticker) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  const t = String(ticker || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const segs = u.pathname.split("/").filter(Boolean).slice(0, 5).map(function (s) {
    const x = decodeURIComponent(s).toLowerCase(), flat = x.replace(/[^a-z0-9]/g, "");
    if (t && (flat === t || flat.endsWith(t) && flat.length <= t.length + 6)) return ":t";
    if (/^\d+$/.test(x)) return ":n";
    if (/\d{4,}/.test(x)) return ":id";
    if (x.length > 28) return ":slug";
    return x;
  });
  return { host: u.hostname.replace(/^www\./, ""), template: "/" + segs.join("/") };
}

function report(visits) {
  const out = { total: visits.length, byType: {}, fallback: 0, hosts: {}, templates: {} };
  visits.forEach(function (v) {
    const hit = self.ATPortals.detect(v.url, []);
    const cls = self.ATPortals.classifyUrl(v.url, hit && hit.source), type = cls || "overview";
    const tp = templateOf(v.url, v.ticker);
    out.byType[type] = (out.byType[type] || 0) + 1;
    if (!cls) out.fallback++;
    if (!tp) return;
    const h = out.hosts[tp.host] = out.hosts[tp.host] || { n: 0, fallback: 0 };
    h.n++; if (!cls) h.fallback++;
    const key = tp.host + tp.template, t = out.templates[key] = out.templates[key] || { host: tp.host, template: tp.template, n: 0, type: type, fellBack: !cls };
    t.n++;
  });
  return out;
}

// labels: [{ host, template, label }]; the share of visits the classifier gets right on them.
function evaluate(rep, labels) {
  const want = {};
  labels.forEach(function (l) { if (l.label && TYPES.indexOf(l.label) >= 0) want[l.host + l.template] = l.label; });
  let n = 0, right = 0, rowsRight = 0, rows = 0;
  const wrong = [];
  Object.keys(rep.templates).forEach(function (k) {
    const t = rep.templates[k], w = want[k];
    if (!w) return;
    n += t.n; rows++;
    if (t.type === w) { right += t.n; rowsRight++; } else wrong.push({ host: t.host, template: t.template, visits: t.n, said: t.fellBack ? t.type + " (fallback)" : t.type, label: w });
  });
  return { visits: n, right: right, share: n ? right / n : null, rows: rows, rowsRight: rowsRight, wrong: wrong.sort(function (a, b) { return b.visits - a.visits; }) };
}

function csvQuote(s) { return /[",\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s); }
function parseCsv(text) {
  const rows = text.split(/\r?\n/).filter(Boolean).map(function (l) { const a = []; let cur = "", q = false; for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ",") { a.push(cur); cur = ""; } else cur += c; } a.push(cur); return a; });
  const head = rows.shift() || [];
  return rows.map(function (r) { const o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; });
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.log("Usage: node tools/classifier-report.js <history.csv|History.json> [--csv templates.csv] [--eval labelled.csv]"); process.exit(2); }
  const arg = function (k) { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
  const res = H.extract(fs.readFileSync(file, "utf8"), []), rep = report(res.visits);
  const pc = function (x) { return (x * 100).toFixed(1) + "%"; };
  console.log("Finance-site visits: " + rep.total + " of " + res.entries + " entries in the file.");
  console.log("Fell back to the default 'overview' (the classifier did not know): " + rep.fallback + " (" + (rep.total ? pc(rep.fallback / rep.total) : "-") + ")");
  console.log("\nBy type (fallback counted as overview):");
  Object.keys(rep.byType).sort(function (a, b) { return rep.byType[b] - rep.byType[a]; }).forEach(function (k) { console.log("  " + k.padEnd(14) + rep.byType[k]); });
  console.log("\nHosts, by visits that fell back:");
  Object.keys(rep.hosts).sort(function (a, b) { return rep.hosts[b].fallback - rep.hosts[a].fallback; }).slice(0, 15).forEach(function (h) { console.log("  " + h.padEnd(32) + String(rep.hosts[h].n).padStart(6) + " visits, " + String(rep.hosts[h].fallback).padStart(6) + " fell back"); });
  console.log("\nTemplates that most often fell back:");
  Object.keys(rep.templates).map(function (k) { return rep.templates[k]; }).filter(function (t) { return t.fellBack; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 25).forEach(function (t) { console.log("  " + String(t.n).padStart(5) + "  " + t.host + t.template); });
  const out = arg("--csv");
  if (out) {
    const rows = Object.keys(rep.templates).map(function (k) { return rep.templates[k]; }).sort(function (a, b) { return b.n - a.n; });
    fs.writeFileSync(out, "host,template,visits,classifier_says,fell_back,label\n" + rows.map(function (t) { return [t.host, t.template, t.n, t.type, t.fellBack ? "yes" : "no", ""].map(csvQuote).join(","); }).join("\n") + "\n");
    console.log("\nWrote " + rows.length + " templates to " + out + ". Fill the label column with one of: " + TYPES.join(", ") + ".");
  }
  const ev = arg("--eval");
  if (ev) {
    const r = evaluate(rep, parseCsv(fs.readFileSync(ev, "utf8")));
    console.log("\nAgainst the labels: " + r.right + " of " + r.visits + " visits right (" + (r.share == null ? "-" : pc(r.share)) + "), " + r.rowsRight + " of " + r.rows + " templates.");
    r.wrong.slice(0, 15).forEach(function (w) { console.log("  wrong: " + String(w.visits).padStart(5) + "  " + w.host + w.template + "  said " + w.said + ", label " + w.label); });
  }
}

module.exports = { templateOf: templateOf, report: report, evaluate: evaluate, parseCsv: parseCsv };
