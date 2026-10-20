// Tests for the bias coach (src/biases.js) on synthetic investors with planted
// effects (tools/synth-world.js). Synthetic data only.
// Run: node tools/test-biases.js (exit code 1 on failure).
const path = require("path");
const D = require(path.join(__dirname, "..", "src", "decisions.js"));
const B = require(path.join(__dirname, "..", "src", "biases.js"));
const W = require(path.join(__dirname, "synth-world.js"));
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? "PASS " : "FAIL ") + m); };
const DAY = 864e5;
const world = (o) => { const w = W.buildWorld(o); return { w, R: D.analyze(w.input) }; };
const rule = (C, id) => C.rules.find((r) => r.id === id);
const fmt = (r) => r.oos.verdict + (r.oos.mean != null ? " " + (r.oos.mean * 100).toFixed(1) + " pts [" + (r.oos.ci99.lo * 100).toFixed(1) + ", " + (r.oos.ci99.hi * 100).toFixed(1) + "] over " + r.oos.flagged : " (" + (r.oos.reason || "") + ")");

// --- a planted effect is found, and holds up out of sample ---
{
  const big = { nBuys: 150, bars: 1100, nPassed: 40 };
  const cases = [
    ["wait_runup", "chasing", Object.assign({ seed: 21, runupMean: 0.04, chase: -0.07 }, big)],
    ["sleep_on_it", "impulse", Object.assign({ seed: 22, impulse: -0.10, impulseShare: 0.3 }, big)],
    ["avoid_daypart", "bad_hour", Object.assign({ seed: 23, evening: -0.08 }, big)],
    ["pause_turbulent", "turbulence", Object.assign({ seed: 24, turbulent: -0.07 }, big)],
    ["cap_turbulent", "turbulence", Object.assign({ seed: 25, turbulent: -0.07, oversize: 2.5 }, big)],
    // skipping an average buy gains nothing, so the unresearched buys must lose to the market for the rule to pay
    ["research_gate", "no_research", Object.assign({ seed: 26, base: -0.04, research: 0.08 }, big)],
    ["act_on_calls", "say_do_gap", Object.assign({ seed: 27, passedEdge: 0.12 }, big)],
    // big buys of stocks barely looked at lose: capping them by attention pays
    ["cap_low_attention", "size_vs_conviction", Object.assign({ seed: 29, base: -0.08, research: 0.12, oversizeUnresearched: 3 }, big, { nBuys: 240, bars: 1700 })]
  ];
  cases.forEach(([id, bias, o]) => {
    const { R } = world(o), C = B.coach(R), r = rule(C, id);
    ok(r.recommended && (r.oos.verdict === "supported" || r.oos.verdict === "indicative"), id + " planted effect held up out of sample: " + fmt(r) + ", in sample " + (r.inSample ? (r.inSample.mean * 100).toFixed(1) + " pts" : "-"));
    ok(C.biases.some((b) => b.id === bias), id + " its bias (" + bias + ") is listed: " + C.biases.map((b) => b.id + "/" + b.tier).join(", "));
  });
}

// --- no effect: the out-of-sample check rarely lets a rule through ---
{
  let supported = 0, indicative = 0, rules = 0, detected = 0, worlds = 0;
  for (let seed = 101; seed <= 124; seed++) {
    const { R } = world({ seed, bars: 760, nBuys: 90 }), C = B.coach(R);
    worlds++;
    C.rules.forEach((r) => { rules++; if (r.oos.verdict === "supported") supported++; if (r.oos.verdict === "indicative") indicative++; });
    // the planted world has no buy-side bias at all (the sales are random, so "targets do not trigger a sale" is true and is not one of these)
    detected += C.biases.filter((b) => b.tier === "detected" && ["chasing", "impulse", "bad_hour", "turbulence", "no_research"].indexOf(b.id) >= 0).length;
  }
  ok(supported <= 0.02 * rules, "null worlds: " + supported + " of " + rules + " rules called supported out of sample (limit 2%), " + indicative + " indicative");
  ok(detected <= 0.1 * worlds, "null worlds: " + detected + " buy-side biases called detected in " + worlds + " worlds (limit 10% per world)");
}

// --- an effect that stops is not recommended going forward ---
{
  const { R } = world({ seed: 31, runupMean: 0.04, chase: -0.08, shiftAt: 0.5, nBuys: 220, bars: 1500 }), C = B.coach(R), r = rule(C, "wait_runup");
  ok(r.oos.verdict !== "supported", "an effect that stops halfway is not called supported out of sample: " + fmt(r));
  const { R: R2 } = world({ seed: 31, runupMean: 0.04, chase: -0.08, nBuys: 220, bars: 1500 }), r2 = rule(B.coach(R2), "wait_runup");
  ok(r2.oos.verdict === "supported", "the same effect that keeps going is supported: " + fmt(r2));
}

// --- the fit never sees outcomes that were not known yet ---
{
  const mk = (n, gainOf) => Array.from({ length: n }, (_, i) => ({ id: "u" + i, t: i * 5 * DAY, tEnd: i * 5 * DAY + 31 * DAY, y: gainOf(i), f: { flag: true } }));
  const spy = { grid: () => [{}], flag: (u) => u.f.flag, gain: (u) => u.y, maxShare: 1 };
  // units 24-29 end after the first test block begins (day 150); one of them carries a huge gain that would turn a losing rule into a winner
  const units = mk(60, (i) => (i === 26 ? 1000 : -1));
  const out = B.walkForward(spy, units, 3, {}, {});
  ok(out.detail[0].recommended === false && out.detail[0].train === 24, "embargo: the first fold trains on 24 units whose outcome was known (" + out.detail[0].train + ") and recommends nothing");
  ok(out.detail.length > 1 && out.detail.slice(1).some((d) => d.recommended), "embargo: later folds, once that outcome is known, may use it");
}

// --- adherence, simulation, pre-trade check ---
{
  const { R } = world({ seed: 41, runupMean: 0.04, chase: -0.07, nBuys: 150, bars: 1100 }), C = B.coach(R), rep = rule(C, "wait_runup");
  const buys = R.decisions.filter((d) => !d.excluded && d.side === "buy").sort((a, b) => a.cut - b.cut);
  const mid = buys[Math.floor(buys.length / 2)].cut, th = 0.08;
  const c = { id: "t1", ruleId: "wait_runup", params: { th }, adoptedAt: mid, status: "active", text: "x" };
  const A = B.adherence(c, R, buys[buys.length - 1].cut + DAY);
  const after = buys.filter((d) => d.cut >= mid && d.runup30 != null), brokenN = after.filter((d) => d.runup30 > th).length;
  ok(A.n === after.length && A.broken.k === brokenN && A.kept.n + A.broke.n + A.pending === A.n, "adherence: counts add up (" + A.n + " decisions, " + brokenN + " broke the rule, " + A.pending + " pending)");
  ok(A.before.n > 0 && A.diff && A.kept.mean > A.broke.mean, "adherence: decisions that kept the rule did better than those that broke it (" + (A.kept.mean * 100).toFixed(1) + "% vs " + (A.broke.mean * 100).toFixed(1) + "%, diff " + (A.diff.est * 100).toFixed(1) + " pts)");
  const sim = B.simulate(R, "wait_runup", { th });
  const allWith = buys.filter((d) => d.runup30 != null && d.fwd[21]);
  ok(sim.flagged === allWith.filter((d) => d.runup30 > th).length && sim.flaggedMean < sim.keptMean, "simulate: " + sim.flagged + " buys flagged, they did " + (sim.flaggedMean * 100).toFixed(1) + "% against " + (sim.keptMean * 100).toFixed(1) + "% for the rest (in sample)");
  const adopted = [B.commit(rep, mid), { id: "x", ruleId: "sleep_on_it", params: { th: 24 }, status: "active", text: "wait a day" }, { id: "y", ruleId: "wait_runup", params: { th: 0.05 }, status: "retired", text: "old" }];
  const pre = B.preTrade(adopted, { runup: 0.4, leadH: 2, hour: 10, pVol: 0.5, pRet: 0.5, relSize: 1, conviction: 3 });
  ok(pre.hits.length === 2 && pre.hits.every((h) => h.why) && !pre.hits.some((h) => h.id === "y"), "pre-trade check: both active rules fire, the retired one does not: " + pre.hits.map((h) => h.why).join(" / "));
  const calm = B.preTrade(adopted, { runup: 0.0, leadH: 100, hour: 10 });
  ok(calm.hits.length === 0, "pre-trade check: nothing fires for a considered buy");
  const unk = B.preTrade(adopted, { hour: 10 });
  ok(unk.hits.length === 0 && unk.unknown.length === 2, "pre-trade check: missing information is reported, not guessed");
}

// --- too little data ---
{
  const empty = D.analyze({ txs: [], links: {}, intraday: [], events: [], prices: {}, bench: [], tickerSymbol: {}, now: Date.now() });
  const C = B.coach(empty);
  ok(C.rules.length === B.RULES.length && C.rules.every((r) => r.oos.verdict === "untested" && !r.recommended) && C.biases.length === 0, "an empty history gives no biases and every rule untested");
  const { R } = world({ seed: 5, nBuys: 18, bars: 600 });
  ok(B.coach(R).rules.every((r) => r.oos.verdict === "untested" || r.n >= 24), "fewer than 24 decisions: rules are untested, not guessed");
}

// --- are you leaving your biases behind? the recent decisions against the earlier ones ---
{
  const big = { nBuys: 300, bars: 1500, lateAt: 0.6 }, Y = { days: 365 };
  const h = (P, id) => P.habits.find((x) => x.id === id);
  const show = (x) => x ? x.verdict + " " + Math.round(x.earlier.p * 100) + "% -> " + Math.round(x.recent.p * 100) + "% (" + x.earlier.n + "/" + x.recent.n + "), trend z " + (x.trend ? x.trend.z.toFixed(1) : "-") : "missing";
  // (in the synthetic world only about a third of impulse buys have no earlier view, so the planted shares are large)
  const fade = world(Object.assign({ seed: 41, impulseShare: 0.9, impulseShareLate: 0 }, big)), Pf = B.progress(fade.R, B.coach(fade.R), Y);
  ok(h(Pf, "sleep_on_it").verdict === "fading" && h(Pf, "sleep_on_it").trend.clear && h(Pf, "sleep_on_it").trend.perYear < 0, "a habit planted to fade is found fading: " + show(h(Pf, "sleep_on_it")));
  const grow = world(Object.assign({ seed: 42, impulseShare: 0, impulseShareLate: 0.9 }, big)), Pg = B.progress(grow.R, null, Y);
  ok(h(Pg, "sleep_on_it").verdict === "growing", "a habit planted to grow is found growing: " + show(h(Pg, "sleep_on_it")));
  ok(Pf.habits.every((x) => x.path.length >= 3 && x.habit && x.inShort) && Pf.days === 365 && B.progress(fade.R).days === 180, "each habit has a plain label, a verdict in a few words and a path by half year");
  let calls = 0, wrong = 0;
  for (let seed = 50; seed < 62; seed++) {
    const n = world({ seed, nBuys: 180, bars: 1300 }), P = B.progress(n.R, null);
    P.habits.forEach((x) => { if (x.verdict !== "too_few") { calls++; if (x.verdict === "fading" || x.verdict === "growing") wrong++; } });
  }
  ok(wrong <= Math.ceil(calls * 0.05), "with no planted change, few habits are called fading or growing: " + wrong + " of " + calls);
  const adopted = [{ ruleId: "wait_runup", status: "active", params: { th: 0.2 } }];
  ok(h(B.progress(fade.R, null, { commitments: adopted }), "wait_runup").setting === "adopted" && /20%/.test(h(B.progress(fade.R, null, { commitments: adopted }), "wait_runup").habit), "an adopted rule is measured with its adopted setting");
}

// --- buying what the crowd is looking at: the rule works on the indicator's units ---
{
  const I = require(path.join(__dirname, "..", "src", "indicators.js"));
  const { w, R } = world({ seed: 41, nBuys: 200, bars: 1100, crowd: { follow: 0.4, edge21: -0.06 } });
  R.ind = I.analyze(w.input, R);
  const C = B.coach(R), r = rule(C, "wait_crowd"), units = R.ind.crowdBuys.buyUnits.filter((u) => u.y != null);
  ok(r && r.n === units.length && r.n > 100 && r.recommended && [1.5, 2, 3].indexOf(r.params.th) >= 0, "wait_crowd is fitted on the crowd indicator's units: n " + (r && r.n) + ", " + (r ? fmt(r) : "missing"));
  ok(C.biases.some((b) => b.id === "crowd_buys" && b.signals.length === 2), "crowd_buys is listed with the share and the horizon that cost: " + C.biases.filter((b) => b.id === "crowd_buys").map((b) => b.signals.map((s) => s.text).join(" | ")).join(""));
  const adopted = [{ id: "c1", ruleId: "wait_crowd", status: "active", params: { th: 2 }, text: "t" }];
  ok(B.preTrade(adopted, { crowd: 3.2 }).hits.length === 1 && B.preTrade(adopted, { crowd: 1.1 }).hits.length === 0 && B.preTrade(adopted, { crowd: null }).unknown.length === 1, "the pre-trade check uses ctx.crowd, and says when it is unknown");
  ok(B.progress(R, C).habits.some((x) => x.id === "wait_crowd" && /other users/.test(x.habit)), "progress tracks buys made while the crowd was looking");
}

if (failed) { console.log(failed + " failed"); process.exit(1); }
console.log("all passed");
