// Supabase Edge Function: feedback-dispatch
// Admin-only. Given a feedback id, sends a GitHub repository_dispatch so the
// Feedback AI Agent workflow implements it and opens a PR. Marks the feedback
// row as 'dispatched'. Free on the Supabase Edge Functions free tier.
//
// Required function secrets (supabase secrets set ...):
//   GH_REPO            owner/name of the GitHub repo
//   GH_DISPATCH_TOKEN  a fine-grained PAT with "Contents: read & write" (dispatch)
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const repo = Deno.env.get("GH_REPO");
    const ghToken = Deno.env.get("GH_DISPATCH_TOKEN");
    if (!repo || !ghToken) return json({ error: "server not configured (GH_REPO / GH_DISPATCH_TOKEN)" }, 500);

    const authHeader = req.headers.get("Authorization") || "";
    // Verify the caller is an admin using their own JWT.
    const asUser = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: isAdmin, error: aerr } = await asUser.rpc("is_admin");
    if (aerr || !isAdmin) return json({ error: "forbidden" }, 403);

    const { feedback_id, model, effort, comment } = await req.json().catch(() => ({}));
    if (!feedback_id) return json({ error: "feedback_id required" }, 400);

    const admin = createClient(url, service);
    const { data: fb, error: ferr } = await admin
      .from("feedback").select("id,text,category,url,status,admin_note").eq("id", feedback_id).maybeSingle();
    if (ferr || !fb) return json({ error: "feedback not found" }, 404);

    // The note sent with this dispatch (if any) wins; otherwise use the saved one.
    const note = (typeof comment === "string" && comment.length) ? comment : (fb.admin_note || "");

    const ghRes = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ghToken}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "attention-tracker-feedback",
      },
      body: JSON.stringify({
        event_type: "feedback",
        client_payload: {
          id: String(fb.id), text: fb.text || "", category: fb.category || "", url: fb.url || "",
          comment: note, model: model || "", effort: effort || "",
        },
      }),
    });
    if (!ghRes.ok) return json({ error: `github dispatch failed: ${ghRes.status} ${await ghRes.text()}` }, 502);

    // Persist the note (if a new one was sent) alongside the status change.
    const patch: Record<string, unknown> = { status: "dispatched" };
    if (typeof comment === "string" && comment.length) patch.admin_note = comment;
    await admin.from("feedback").update(patch).eq("id", feedback_id);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
