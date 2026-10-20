# Option B setup - Google accounts + Supabase cloud

One-time setup of a Supabase project for Stocktrails. The code is built; these steps need
your own accounts. The production project is described in ARCHITECTURE.md section 2 (Cloud).

## 1. Create the project
- supabase.com -> New project. Pick a region near your users. Note the DB password.

## 2. Create the schema
- Supabase -> SQL Editor -> paste `supabase/schema.sql` -> Run. It creates the base:
  events / intraday / user_meta / feedback / profiles with RLS, last-write-wins
  triggers, an auto-profile-on-signup trigger and an admin-can-read-all policy.
- Then run every file in `supabase/migrations/` in date order (file names start with the
  date). They add the sync cursor (`synced_at`), the admin, world, network and trending RPCs,
  the earnings, crowd-alert and AI-usage tables, privacy floors and the cron jobs. The app
  needs them: without them sync, Community and the AI features fail.
- Known gap: eleven admin RPCs that `src/cloud.js` calls (`admin_totals`, `admin_user_stats`,
  `admin_calendar`, `admin_attention_buckets`, `admin_stock_buckets`,
  `admin_attention_over_time`, `admin_daily`, `admin_outlook_buckets`,
  `admin_outlook_over_time`, `admin_sentiment`, `admin_stock_daily`) are not defined in any
  repo file; they exist only in the production database. A project built from the repo has no
  admin overview until they are exported into a migration.

## 3. Make yourself admin
- After your first sign-in (step 6), run in SQL Editor:
  `update public.profiles set is_admin = true where email = 'you@example.com';`

## 4. Google sign-in
- Google Cloud Console -> create OAuth 2.0 Client (Web application).
  - Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
- Supabase -> Authentication -> Providers -> Google -> paste the client ID + secret -> enable.
- Supabase -> Authentication -> URL Configuration -> add your redirect URLs:
  - the PWA origin (e.g. `https://your-pwa.pages.dev`)
  - the extension: `https://<extension-id>.chromiumapp.org/` (from chrome.identity.getRedirectURL())

## 5. Edge Functions
- Install the Supabase CLI, then deploy what you use (all in `supabase/functions/`):
  - `supabase functions deploy yahoo --no-verify-jwt` - price proxy for the web app. Its URL
    is `https://<project-ref>.functions.supabase.co/yahoo`.
  - `geo` - country lookup (no JWT verification, see ARCHITECTURE.md section 9a).
  - `trending --no-verify-jwt` and `crowd-alerts --no-verify-jwt` - third-party attention
    lists and the daily crowd e-mail; `crowd-alerts` needs the secrets `CROWD_ALERTS_SECRET`,
    `RESEND_API_KEY`, `MAIL_FROM` (the cron job reads the same secret from Vault).
  - `earnings` (JWT verified; the cron job sends the anon key) - needs `SEC_USER_AGENT`.
  - `ai-coach` (JWT verification stays on) - secrets and settings in docs/AI.md.
  - `feedback-dispatch` - secrets in docs/FEEDBACK_AUTOMATION.md.
- Only `yahoo` is needed for sign-in, sync and the web app's prices.

## 6. Point the client at the project
- Edit `src/config.js`:
  - `AT_SUPABASE_URL` = `https://<project-ref>.supabase.co`
  - `AT_SUPABASE_ANON` = the anon/public key (Settings -> API)
  - `AT_SUPABASE_FUNCTIONS` = `https://<project-ref>.functions.supabase.co`
- Reload the extension; open the PWA. Settings -> Account -> **Sign in with Google**.
  Once both keys are set, the app uses Google + cloud sync automatically; the
  token server becomes an unused fallback.

## 7. Keepalive (avoid free-tier pause)
- Add the two repo secrets used by `.github/workflows/supabase-keepalive.yml`:
  `SUPABASE_URL`, `SUPABASE_ANON`. It runs **daily** and calls the
  `keepalive_ping()` RPC (`supabase/migrations/20260727_keepalive.sql`), which
  does a real row write. A read-only anon `SELECT` is not enough: RLS makes it
  return zero rows, and the project still auto-paused in July 2026.
- If the ping fails it opens a `keepalive-failure` GitHub issue, so a broken
  keepalive surfaces immediately rather than after the project has paused.
- If the project does pause, the API subdomain stops resolving (curl exit 6)
  and sign-in breaks everywhere. Restore it from the Supabase dashboard; data
  is retained.

## 8. Host the PWA (for mobile)
- The web app is deployed to GitHub Pages by `.github/workflows/deploy-pwa.yml` on every
  merge to `main` (it copies `index.html`, `manifest.webmanifest`, `sw.js`, `dashboard/`,
  `src/`, `vendor/`, `icons/` and `pwa/`). Any static HTTPS host works too. The app talks to
  Supabase directly; no Node server is needed in Option B.

## Notes / known limitations
- **Extension background sync:** MV3 service workers have no localStorage, so the
  Supabase session lives in the dashboard page. Cloud upload happens when the
  dashboard is open (and on the 5-min page timer); captures are always saved
  locally meanwhile. A chrome.storage auth adapter can make the worker sync too -
  follow-up if needed.
- **Migration of your existing data:** after first Google sign-in, the client
  pushes your local data to the cloud (gated on a fresh cloud cursor).
- **Admin overview:** the schema includes an admin-read-all policy; use Supabase
  Studio now, or we can repoint the custom /admin page at Supabase later.
