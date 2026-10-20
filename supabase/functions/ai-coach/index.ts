// Supabase Edge Function: ai-coach
// An opt-in assistant that explains the user's own trading habits. It receives
// results computed in the browser (never raw trades), and works in steps: at each
// step the model names more read-only results or answers, with actions the user
// may approve in the browser. Task "decide" makes the AI agent's paper decisions
// (buy, wait or pass) for the agents' paper portfolios; no order exists. All the
// logic is in core.mjs (tested by tools/test-ai.js); this file only wires Deno,
// Supabase and the model call to it.
//
// Deploy:  supabase functions deploy ai-coach        (JWT verification stays ON)
// Migration: supabase/migrations/20261010_ai_usage.sql (per-user daily counter)
//
// Function secrets (supabase secrets set ...):
//   OPENROUTER_API_KEY  key for OpenRouter (or CEREBRAS_API_KEY with AI_PROVIDER=cerebras)
//   AI_MODEL            model name, e.g. "vendor/model" (required unless AI_PROVIDER=mock)
//   AI_ALLOWED_USERS    comma-separated user ids, or e-mails of Google sign-ins, allowed to use it.
//                       Empty = nobody: the assistant is off for everyone else.
//   AI_ALLOW_ALL        "true" to allow every signed-in user (only with a provider
//                       plan that does not keep or train on prompts; see docs/AI.md)
// Optional:
//   AI_PROVIDER         "openrouter" (default), "cerebras" or "mock" (no model, no key: for demos and tests)
//   AI_MODEL_LITE       lighter model for short tasks (falls back to AI_MODEL)
//   AI_DECISION_MODEL   an OpenRouter decision model (e.g. "inception/mercury-decide") for
//                       the notes and the AI agent's decisions; needs OPENROUTER_API_KEY,
//                       whatever AI_PROVIDER is. Unset: those tasks use the text models.
//   AI_DECISION_ALLOW_TRAINING   "true" to allow a decision model whose endpoint may keep and
//                       train on the prompt (the ":free" variants); needed for those, off by default
//   AI_DECIDE_MIN_P     below this probability of its chosen action the AI agent follows
//                       the rules agent (default 0.6)
//   AI_DAILY_CAP        calls per user per UTC day (default 40)
//   AI_ALLOWED_ORIGINS  comma-separated browser origins (default: any)
//   AI_NAMES_OK         "true" to accept real stock names when the user opts in
//                       (only with a provider plan that does not keep prompts; default: refused with 403)
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.
//
// Nothing about the content is logged or stored here; the model providers are
// called without any user identifier.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handle, corsHeaders, CHAT_URLS, DECISIONS_URL } from "./core.mjs";

const ENV_KEYS = ["AI_ALLOWED_USERS", "AI_ALLOW_ALL", "AI_PROVIDER", "AI_MODEL", "AI_MODEL_LITE", "AI_DECISION_MODEL", "AI_DECISION_ALLOW_TRAINING", "AI_DECIDE_MIN_P", "AI_DAILY_CAP", "AI_ALLOWED_ORIGINS", "AI_NAMES_OK"];

Deno.serve(async (req) => {
  const env: Record<string, string> = {};
  for (const k of ENV_KEYS) env[k] = Deno.env.get(k) ?? "";
  const cors = corsHeaders(req.headers.get("Origin"), env);
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { ok: false, error: "method", message: "POST only." });

  try {
    const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!, service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const asUser = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data } = await asUser.auth.getUser();
    const admin = createClient(url, service);
    const res = await handle({
      raw: await req.text(),
      user: data?.user ?? null,
      env,
      bump: async (userId: string, cap: number) => {
        const { data: n, error } = await admin.rpc("ai_usage_bump", { p_user: userId, p_cap: cap });
        if (error) throw error;
        return n as number;
      },
      callModel: async (request: unknown, route?: string) => {
        const prov = (Deno.env.get("AI_PROVIDER") ?? "openrouter").toLowerCase();
        const k = Deno.env.get(route !== "decisions" && prov === "cerebras" ? "CEREBRAS_API_KEY" : "OPENROUTER_API_KEY");
        if (!k) throw Object.assign(new Error("API key is not set"), { status: 500 });
        const cr = await fetch(route === "decisions" ? DECISIONS_URL : CHAT_URLS[prov], { method: "POST", headers: { Authorization: "Bearer " + k, "Content-Type": "application/json" }, body: JSON.stringify(request) });
        if (!cr.ok) throw Object.assign(new Error("model http " + cr.status), { status: cr.status });
        return await cr.json();
      },
    });
    return reply(res.status, res.json);
  } catch (_e) {
    // The error text is not returned: it could carry parts of a request.
    return reply(500, { ok: false, error: "server_error", message: "Something went wrong on the server." });
  }
});
