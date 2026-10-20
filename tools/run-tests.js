// Runs every test suite of the repository and prints one summary table.
// No install, no network, no key; synthetic data only. Needs Node 22 or newer.
//
//   node tools/run-tests.js                  all suites, a few at a time
//   node tools/run-tests.js --serial         one after the other
//   node tools/run-tests.js --only=biases,ai only the named suites
//   node tools/run-tests.js --list           what each suite covers
//   node tools/run-tests.js --verbose        also print every check
//
// Exit code 0 only if every suite exits with 0 and reports no FAIL line. See TESTING.md.
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const SUITES = [
  ["trades", "test-trades.js", "Broker import (the supported brokers' CSV and XML files), decisions and outcomes, the research-versus-trading questions, history reader"],
  ["biases", "test-biases.js", "Bias coach: planted effects found, out-of-sample validation, no rule recommended in worlds without an effect, adherence"],
  ["indicators", "test-indicators.js", "Bias indicators: every indicator finds its planted effect and stays silent without it"],
  ["ai", "test-ai.js", "AI layer: access control, privacy filters, tool catalogue, agent loop, redaction, notes analysis (no network, no key)"],
  ["shadow", "test-shadow.js", "Rules agent and AI agent paper portfolios: no look-ahead, accounting, planted and null worlds"],
  ["agent-session", "test-agent-session.js", "Viewing sessions behind the live verdict: merging, when due, re-deciding"],
  ["pricecache", "test-pricecache.js", "Daily price cache: stored series, incremental refresh, split refetch"],
  ["headinfo", "test-headinfo.js", "Every headline of the dashboard has its information text"],
  ["repo", "test-repo.js", "Manifest and permissions, packaging, published files, migrations (RLS, search_path), no committed secrets"],
  ["sandbox", "test-sandbox.js", "Sandbox server: offline, allowlisted files, no path traversal, every script of the page served"],
];

const args = process.argv.slice(2);
if (args.includes("--list")) { SUITES.forEach(([n, f, d]) => console.log(n.padEnd(14) + ("tools/" + f).padEnd(30) + d)); process.exit(0); }
const only = ((args.find((a) => a.startsWith("--only=")) || "").slice(7) || "").split(",").filter(Boolean);
const unknown = only.filter((o) => !SUITES.some(([n]) => n === o));
if (unknown.length) { console.error("Unknown suite: " + unknown.join(", ") + " (see --list)"); process.exit(2); }
const verbose = args.includes("--verbose");
const run = SUITES.filter(([n]) => !only.length || only.includes(n));
const parallel = args.includes("--serial") ? 1 : Math.max(1, Math.min(4, os.cpus().length));

const runOne = ([name, file]) => new Promise((resolve) => {
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(__dirname, file)], { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("error", (e) => resolve({ name, file, code: -1, out: String(e), secs: 0, pass: 0, fail: 0 }));
  child.on("close", (code) => {
    const lines = out.split(/\r?\n/);
    resolve({ name, file, code, out, secs: (Date.now() - t0) / 1000, pass: lines.filter((l) => l.startsWith("PASS ")).length, fail: lines.filter((l) => l.startsWith("FAIL ")).length });
  });
});

(async function () {
  console.log("Running " + run.length + " suites" + (parallel > 1 ? " (" + parallel + " at a time)" : " one after the other") + " on Node " + process.version + "\n");
  const results = new Array(run.length);
  let next = 0;
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (next < run.length) {
      const i = next++;
      results[i] = await runOne(run[i]);
      const r = results[i];
      console.log("  finished " + r.name.padEnd(14) + (r.code === 0 && !r.fail && r.pass ? "ok" : "FAILED") + "  (" + r.secs.toFixed(0) + " s)");
    }
  }));
  console.log("\n" + "suite".padEnd(15) + "passed".padStart(7) + "failed".padStart(8) + "  seconds  result");
  let bad = 0, total = 0;
  for (const r of results) {
    const good = r.code === 0 && r.fail === 0 && r.pass > 0;
    if (!good) bad++;
    total += r.pass;
    console.log(r.name.padEnd(15) + String(r.pass).padStart(7) + String(r.fail).padStart(8) + r.secs.toFixed(0).padStart(9) + "  " + (good ? "ok" : "FAILED (exit " + r.code + ")"));
  }
  console.log("-".repeat(46) + "\n" + "total".padEnd(15) + String(total).padStart(7) + "\n");
  for (const r of results) {
    const lines = r.out.split(/\r?\n/);
    const show = verbose ? lines.filter((l) => /^(PASS|FAIL|SKIP) /.test(l)) : lines.filter((l) => l.startsWith("FAIL ") || (r.code !== 0 && l.trim() && !/^PASS /.test(l)));
    if (show.length) console.log("--- " + r.name + "\n" + show.join("\n") + "\n");
  }
  console.log(bad ? bad + " suite(s) failed." : "All " + results.length + " suites passed (" + total + " checks).");
  process.exit(bad ? 1 : 0);
})();
