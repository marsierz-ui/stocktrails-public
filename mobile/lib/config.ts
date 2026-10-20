// Backend config. The native client reuses the SAME Supabase project as the
// extension/PWA (id unymnlguicuwllkuqglm). Anon key is public + RLS-protected.
export const AT_SUPABASE_URL = 'https://unymnlguicuwllkuqglm.supabase.co';
export const AT_SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueW1ubGd1aWN1d2xsa3VxZ2xtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMzI0OTMsImV4cCI6MjA5NzYwODQ5M30.5YjbkKI7qyostBsFK2ILbeDIGPftKHbcfvl2oeNC8HM';
export const AT_SUPABASE_FUNCTIONS = 'https://unymnlguicuwllkuqglm.supabase.co/functions/v1';

// Native clients have no CORS constraint, so we call Yahoo directly (see
// lib/prices.ts). The Supabase `yahoo` edge function stays available as an
// optional fallback only if Yahoo rate-limits the device IP.
export const AT_PRICE_PROXY: string | null = null;
export const AT_YAHOO_FALLBACK_PROXY = AT_SUPABASE_FUNCTIONS.replace(/\/+$/, '') + '/yahoo?path=';

// Deep-link scheme used as the OAuth redirect target (must match app.json
// "scheme" and be added to Supabase Auth -> URL Configuration -> Redirect URLs).
export const AT_AUTH_SCHEME = 'attentiontracker';
