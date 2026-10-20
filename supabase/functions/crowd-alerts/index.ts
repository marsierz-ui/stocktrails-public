// Supabase Edge Function: crowd-alerts
// Daily e-mail for users who opted in (crowd_notify.email_on): stocks that were
// trending on the platforms we track, that the user looked at around then, and
// whose attention has since subsided (see _crowd_settled in
// migrations/20261015_crowd_series_and_alerts.sql). One e-mail per user per run,
// each stock once (crowd_notified). Describes attention only; no advice.
//
// Deploy:  supabase functions deploy crowd-alerts --no-verify-jwt
// Secrets: CROWD_ALERTS_SECRET  required; callers send it as x-cron-secret (the cron
//                               reads it from Vault, migrations/20261017_crowd_alerts_cron_secret.sql).
//                               Unset means every call is refused.
//          RESEND_API_KEY   key for the Resend e-mail API (https://resend.com)
//          MAIL_FROM        sender, e.g. "Stocktrails <alerts@your-domain>"
// Without RESEND_API_KEY nothing is sent or recorded; the reply says what would be.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_USERS = 200, MAX_TICKERS = 8;
const SOURCES: Record<string, string> = { stockanalysis: "StockAnalysis", apewisdom: "ApeWisdom", stocktwits: "Stocktwits", yahoo: "Yahoo", stocktrails: "Stocktrails" };

type Row = { ticker: string; last_trend: string; peak_rank: number; sources: string[]; my_views: number; quiet_days: number };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function mail(rows: Row[]) {
  const line = (r: Row) => `${r.ticker}: trending until ${r.last_trend} (best rank ${r.peak_rank} on ${r.sources.map((s) => SOURCES[s] || s).join(", ")}); you looked ${r.my_views} time${r.my_views === 1 ? "" : "s"}; quiet for ${r.quiet_days} days.`;
  const text = "Stocks that were trending and have gone quiet:\n\n" + rows.map(line).join("\n") +
    "\n\nThis describes attention, not a reason to buy or sell. Turn these e-mails off in Stocktrails > Community > Trending.";
  const html = "<p>Stocks that were trending and have gone quiet:</p><ul>" + rows.map((r) => `<li>${esc(line(r))}</li>`).join("") +
    "</ul><p style='color:#666'>This describes attention, not a reason to buy or sell. Turn these e-mails off in Stocktrails &gt; Community &gt; Trending.</p>";
  return { text, html };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const secret = Deno.env.get("CROWD_ALERTS_SECRET") || "";
  if (!secret || req.headers.get("x-cron-secret") !== secret) return new Response("forbidden", { status: 403 });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const key = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("MAIL_FROM");
  const out = { users: 0, sent: 0, would_send: 0, errors: 0 };
  const { data: subs, error } = await admin.from("crowd_notify").select("user_id").eq("email_on", true).limit(MAX_USERS);
  if (error) return Response.json({ ok: false, error: "crowd_notify" }, { status: 500 });
  for (const s of subs || []) {
    out.users++;
    try {
      const { data: rows } = await admin.rpc("_crowd_settled", { p_user: s.user_id, p_days: 45 });
      const { data: done } = await admin.from("crowd_notified").select("ticker,last_trend").eq("user_id", s.user_id);
      const seen = new Set((done || []).map((d: { ticker: string; last_trend: string }) => d.ticker + "|" + d.last_trend));
      const fresh = ((rows || []) as Row[]).filter((r) => !seen.has(r.ticker + "|" + r.last_trend)).slice(0, MAX_TICKERS);
      if (!fresh.length) continue;
      if (!key || !from) { out.would_send++; continue; }
      const { data: u } = await admin.auth.admin.getUserById(s.user_id);
      const to = u?.user?.email;
      if (!to) continue;
      // Claim the rows before sending: of two overlapping runs only one gets them,
      // so nobody is mailed twice. A failed send gives them back for the next run.
      const { data: claimed, error: cErr } = await admin.from("crowd_notified")
        .upsert(fresh.map((x) => ({ user_id: s.user_id, ticker: x.ticker, last_trend: x.last_trend })), { onConflict: "user_id,ticker,last_trend", ignoreDuplicates: true })
        .select("ticker,last_trend");
      if (cErr) { out.errors++; continue; }
      const got = new Set((claimed || []).map((c: { ticker: string; last_trend: string }) => c.ticker + "|" + c.last_trend));
      const mine = fresh.filter((x) => got.has(x.ticker + "|" + x.last_trend));
      if (!mine.length) continue;
      const { text, html } = mail(mine);
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject: `${mine.length} stock${mine.length === 1 ? "" : "s"} you looked at went quiet`, text, html }),
      });
      if (!r.ok) {
        for (const x of mine) await admin.from("crowd_notified").delete().eq("user_id", s.user_id).eq("ticker", x.ticker).eq("last_trend", x.last_trend);
        out.errors++; continue;
      }
      out.sent++;
    } catch (_e) { out.errors++; }
  }
  return Response.json({ ok: true, ...out });
});
