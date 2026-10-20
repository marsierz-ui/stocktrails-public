// A live check of the AI layer against the real OpenRouter API, to run once with your
// own key before relying on the assistant: the request and reply shapes in
// supabase/functions/ai-coach/core.mjs follow the public documentation but are
// otherwise only tested against a fake model (tools/test-ai.js).
//
//   PowerShell:  $env:OPENROUTER_API_KEY = "..."; $env:AI_MODEL = "vendor/model"; node tools/ai-smoke.js
//   bash:        OPENROUTER_API_KEY=... AI_MODEL=vendor/model node tools/ai-smoke.js
//
// Sends three tiny requests with made-up text (no user data): a plan, an answer
// and a note classification. Required: AI_MODEL. Optional:
// AI_MODEL_LITE. Exit code 1 if anything is unusable.
const path = require("path");
const { pathToFileURL } = require("url");

(async function () {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || !process.env.AI_MODEL) { console.log("Set OPENROUTER_API_KEY and AI_MODEL first."); process.exit(2); }
  const core = await import(pathToFileURL(path.join(__dirname, "..", "supabase", "functions", "ai-coach", "core.mjs")).href);
  const main = process.env.AI_MODEL, lite = process.env.AI_MODEL_LITE || main;
  let failed = 0;
  const ok = (c, m) => { if (!c) failed++; console.log((c ? "PASS " : "FAIL ") + m); };

  async function call(model, prompt, maxTokens) {
    const t0 = Date.now();
    const res = await fetch(core.CHAT_URLS.openrouter, {
      method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(core.chatRequest("openrouter", model, prompt, maxTokens))
    });
    const text = await res.text();
    if (!res.ok) throw new Error("HTTP " + res.status + " " + text.slice(0, 300));
    return { json: JSON.parse(text), ms: Date.now() - t0 };
  }

  try {
    const plan = await call(lite, core.planPrompt("Why do my buys after a rise do worse than the others, and which rule should I adopt?"), 400);
    const p = core.validatePlan(core.parseJsonLoose(core.chatText(plan.json)));
    ok(p.calls.length >= 1 && p.calls.every((c) => core.TOOLS[c.tool]), "plan (" + lite + ", " + plan.ms + " ms): " + p.calls.map((c) => c.tool + JSON.stringify(c.args)).join(", "));

    const results = [{ tool: "get_finding", args: { id: "q4" }, result: { id: "q4", status: "solid", clear: true, facts: ["Next month against the NASDAQ: buys after the price had risen since the first look -2.5% (40), after it had fallen +1.9% (30), difference -4.4 pts, clear."] } }];
    const ans = await call(main, core.answerPrompt("Why do my buys after a rise do worse?", results), 600);
    const a = core.validateAnswer(core.parseJsonLoose(core.chatText(ans.json)), results);
    ok(a && a.answer.length > 20, "answer (" + main + ", " + ans.ms + " ms): " + (a ? a.answer.slice(0, 200) : "unusable"));

    const notes = [{ id: "a", text: "Cheap against peers, 7 percent free cash flow yield and a clean balance sheet." }, { id: "b", text: "Everyone is talking about it, not going to miss out." }];
    const cl = await call(lite, core.notesPrompt(notes), 800);
    const items = core.validateNoteClasses(core.parseJsonLoose(core.chatText(cl.json)), ["a", "b"]);
    ok(items && items.length === 2 && items.find((i) => i.id === "a").types.indexOf("valuation") >= 0, "notes (" + lite + ", " + cl.ms + " ms): " + JSON.stringify(items));
  } catch (e) {
    ok(false, "request failed: " + e.message);
  }
  if (failed) { console.log(failed + " failed"); process.exit(1); }
  console.log("all passed");
})();
