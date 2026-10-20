// Client config.
// Option A (self-hosted token server, server/): set AT_SERVER_URL to a STABLE URL
// you control. Empty by default: the published app syncs through Supabase only
// (Option B), and sync.js never falls back to a token server while Supabase is
// configured, so no user data can reach a developer machine or tunnel.
(function () {
  var g = (typeof self !== "undefined") ? self : window;
  g.AT_SERVER_URL = "";
  // Optional shared key gating /register; must equal the server's AT_REGISTER_KEY
  // if that is set. Baked into the client, so it only deters casual registration.
  g.AT_REGISTER_KEY = "";

  // ---- Option B: Supabase (Google accounts + cloud) ----
  // Fill these from your Supabase project (Settings -> API). When both are set,
  // the app uses Google sign-in + cloud sync instead of the token server.
  g.AT_SUPABASE_URL = "https://unymnlguicuwllkuqglm.supabase.co";
  g.AT_SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueW1ubGd1aWN1d2xsa3VxZ2xtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMzI0OTMsImV4cCI6MjA5NzYwODQ5M30.5YjbkKI7qyostBsFK2ILbeDIGPftKHbcfvl2oeNC8HM";
  g.AT_SUPABASE_FUNCTIONS = "https://unymnlguicuwllkuqglm.supabase.co/functions/v1";

  // When Supabase functions are configured, route price lookups through the
  // yahoo edge function (needed when the PWA is hosted off a static host).
  if (g.AT_SUPABASE_FUNCTIONS) g.AT_PRICE_PROXY = g.AT_SUPABASE_FUNCTIONS.replace(/\/+$/, "") + "/yahoo?path=";
})();
