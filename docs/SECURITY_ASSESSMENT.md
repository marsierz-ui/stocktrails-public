# Stocktrails - cybersecurity self-assessment

> Superseded on 2026-10-19 by [hackathon/SECURITY.md](hackathon/SECURITY.md), which lists
> the current state: permission tiers, what is fixed, what is open and the known-risk list.
> This file is the 2026-10-17 record. The 20261017 migrations and the function deploys it
> lists were applied to production on 2026-10-19 (N1 there); the crowd-alerts cron waits
> until e-mail alerts go live.

Date: 2026-10-17. Release under review: extension 0.4.0 (branch `test/all-features`),
the web app (PWA on GitHub Pages), the Supabase backend (database, 7 edge functions),
the CI/CD workflows, the legacy token server (`server/`) and the Expo app (`mobile/`).

## 1. Method

- Read-only code review in five areas (database authorization, edge functions,
  browser clients, build/CI/hosting, mobile). Each reported issue was then re-checked
  against the code by a second, independent reviewer; only confirmed issues are listed.
- No requests were sent to the production backend; nothing was tested live. Where a
  conclusion depends on live configuration (Supabase Auth settings, secrets, Pages
  settings), it is marked as an owner check.
- After the fixes: `tools/test-ai.js`, `test-shadow.js`, `test-biases.js`,
  `test-trades.js`, `test-indicators.js` pass; all changed JS passes `node --check`;
  `mobile/` passes `tsc --noEmit`; the dashboard loads with the new Content Security
  Policy and no console errors; the sign-in gate was exercised in a browser.

## 2. What already held up

- Row-level security is enabled on every table. Owner policies use
  `user_id = auth.uid()` for both reading and writing; admin reads go through
  `is_admin()`, which a user cannot set (column-level UPDATE grant on `profiles`).
- Every `admin_*` function in the repository filters through `public.is_admin()`.
- Service-only tables (`ai_usage`, `crowd_notified`, `keepalive`) have no policies;
  their functions are revoked from `anon`/`authenticated`.
- No secret in the repository: the only JWTs are the public anon key.
- Extension: MV3 default CSP, no remote code, no `externally_connectable`, every
  HTML sink fed by other users, imports, AI replies or admin data is escaped
  (`escapeHtml`, `safeImageSrc`).
- Broker trades are read in the browser and stored only in IndexedDB, keyed by account.
- The AI assistant is deny-by-default (allowlist), sends de-identified results only
  and logs every exchange for the user.
- The Yahoo proxy is pinned to Yahoo hosts with redirects refused (no SSRF).

## 3. Findings

Severity: high = one user's data or an admin capability exposed to others, or a
secret exposed; medium = needs unusual conditions or limited impact; low = hardening.
Status: **Fixed** (in this change), **Partly fixed**, **Owner** (needs an action in a
console or a decision), **Deferred**, **Accepted**.

| ID | Sev | Finding | Status |
|---|---|---|---|
| H1 | high | `world_crowd_overlap` had no minimum group size; its 4-decimal result let any user reconstruct other users' per-day, per-ticker views | Fixed |
| H2 | high | User feedback text, and an admin note users could set themselves, steered the feedback AI agent that has a repo-write token and unrestricted Bash | Fixed |
| H3 | high | GitHub Pages is public although the repo is private, and the deploy published the whole repo (server code, SQL and RLS, edge functions, internal docs, mobile app) | Fixed, Owner |
| M1 | med | Community per-day series (`network_community_daily`, `network_community_sentiment`, `community_daily_attention`) returned cells that could hold one person | Fixed |
| M2 | med | `crowd-alerts` could be called by anyone; parallel calls sent duplicate e-mails | Fixed, Owner |
| M3 | med | `trending`/`earnings`: concurrent calls each ran a full scrape (and grew `trending_raw`) | Fixed |
| M4 | med | `ai-coach` temporary defaults: no daily cap, real stock names accepted | Owner |
| M5 | med | Mobile: sign-out kept local data and the next account's sync uploaded it | Fixed |
| M6 | med | Mobile: OAuth callback accepted tokens without PKCE (sign-in into an attacker's account via a deep link on Android) | Fixed |
| M7 | med | Web: a failed sign-out (offline) left the session stored; the PWA never removed its token copy | Fixed |
| M8 | med | Web: the previous account's AI log, chat and names opt-in stayed for the next account | Fixed |
| M9 | med | In-page widget used an open shadow root: finance sites could read the user's notes and drive the controls | Fixed |
| M10 | med | Extension fell back to a personal ngrok server for signed-out users (undisclosed beacon, possible upload) | Fixed |
| M11 | med | PR previews ran unreviewed code on the production origin (same storage) | Partly fixed, Owner |
| M12 | med | Old PR preview folders still publish full-repo snapshots | Owner |
| M13 | med | Legacy server: default admin and sync tokens committed in the repo | Fixed |
| M14 | med | Legacy server: open registration, unauthenticated abuse of the owner's Discord/GitHub sinks | Fixed |
| M15 | med | Legacy admin page: stored XSS through `priceAtEvent`/`views` | Fixed |
| M16 | med | Chrome Web Store publishing secrets readable from any branch | Owner |
| L1 | low | `ai-coach` wrote up to 600 characters of model output to function logs | Fixed |
| L2 | low | `ai-coach` allowlist matched e-mails from any sign-in provider | Fixed |
| L3 | low | `yahoo` and `geo` functions are open proxies on the project's quotas | Accepted |
| L4 | low | Privacy text said "country only" while a ~10 km location is kept on the device | Fixed |
| L5 | low | Mobile: session in plain AsyncStorage, Android backup on | Fixed |
| L6 | low | `profiles_guard_admin` (second lock on `is_admin`) could never fire | Fixed |
| L7 | low | 11 legacy admin RPCs (one returns every user's e-mail) exist only in the live database | Owner |
| L8 | low | Screenshot OCR lines and shared links went to Yahoo search, undisclosed | Fixed |
| L9 | low | Mobile: offline sign-out silently kept the session | Fixed |
| L10 | low | Cross-user community RPCs callable with the anon key, no account | Fixed |
| L11 | low | `is_admin()`, `handle_new_user()` SECURITY DEFINER without pinned `search_path` | Fixed |
| L12 | low | Workflows: third-party actions on movable tags, a job without a `permissions` block | Fixed, Owner |
| L13 | low | `supabase/.temp` (project ref, pooler URL, no password) tracked in git | Fixed |
| L14 | low | Extension session tokens in `chrome.storage.local` are readable from content-script contexts after a renderer compromise | Fixed |
| L15 | low | Admin CSV exports: spreadsheet formula injection from user-written columns | Fixed |
| L16 | low | PWA share page: unescaped ticker, auto-logging from `?url=`, unpinned CDN script | Fixed |

## 4. What changed

Database (new migrations; apply in this order before deploying the functions):
- `20261017_capture_claims.sql` - single-flight claims for trending/earnings (M3).
- `20261017_community_privacy_floors.sql` - 20-user day and 5-user cell floors for
  the crowd overlap, 3-user cells for the per-day community series, 5-user days for
  `community_daily_attention`, anon revoked on cross-user RPCs (H1, M1, L10).
- `20261017_feedback_insert_lockdown.sql` - users insert feedback only as new, without
  admin note, category or issue URL (H2).
- `20261017_definer_hardening.sql` - `profiles_guard_admin` as invoker, pinned
  `search_path` (L6, L11). `supabase/schema.sql` mirrors these.
- `20261017_crowd_alerts_cron_secret.sql` - the alert cron sends the secret (M2).

Edge functions: `crowd-alerts` requires `x-cron-secret` and claims alerts before
sending; `trending`/`earnings` claim a 10-minute slot; `ai-coach` logs metadata only
and accepts e-mail allowlist entries only for Google sign-ins.

Clients: sign-in requires accepting the Terms of Use and Privacy Policy (extension,
PWA, mobile); sign-out clears the session even offline, the AI log and names
opt-in, and reloads; the widget uses a closed shadow root and ignores synthetic
events; no token-server fallback (`AT_SERVER_URL` empty); dashboard CSP
`script-src 'self'; object-src 'none'; base-uri 'none'`; CSV cells neutralise formulas;
mobile is PKCE-only, guards the account before syncing and sends less OCR text.
The extension keeps session tokens in extension-origin IndexedDB and only a
signed-in flag in `chrome.storage.local`, migrating older installs once (L14);
mobile encrypts the stored session with a per-key AES key held in
`expo-secure-store`, migrating a plaintext session once (L5).

Hosting and CI: Pages publishes only the web app's files; previews deploy only when
a maintainer adds the `preview` label; third-party actions pinned to commit SHAs;
the feedback agent's Bash limited to read-only git and the repo tests, with user
feedback marked as untrusted data; the agent job has only a read token and hands a
patch to a separate publish job that rejects `.github/` and `.git/` paths, pushes
`feedback/<id>` and opens the PR; `trending-capture` runs with no token.

Legacy server: refuses to start without a strong `AT_ADMIN_TOKEN`; registration is
off unless `AT_ALLOW_REGISTER=1`; numeric fields stored only as numbers; Discord
posts cannot ping everyone.

## 5. Owner actions, in order

1. Merge through a reviewed PR. Note: the change touches `src/`, `dashboard/` and
   `manifest.json`, so the merge publishes the extension if the `CWS_*` secrets are set.
2. Apply the five migrations (capture_claims first), then deploy `trending`,
   `earnings`, `crowd-alerts` and `ai-coach`. A function deployed before its
   migration skips every run (capture_claims) or refuses the cron (crowd-alerts).
3. `supabase secrets set CROWD_ALERTS_SECRET=<random>` and the same value in Vault:
   `select vault.create_secret('<random>', 'crowd_alerts_secret');`
4. `select id, admin_note from public.feedback where admin_note is not null;` and clear
   any note you did not write.
5. Decide M4: `supabase secrets set AI_DAILY_CAP=40 AI_NAMES_OK=false` (no redeploy),
   or restore `capByDefault: true, namesByDefault: false` in `core.mjs`. Keep
   `AI_ALLOW_ALL` unset and no EEA/UK/CH users in `AI_ALLOWED_USERS` while on a free plan.
6. L7: dump the 11 legacy admin RPCs (read-only) and commit them as a migration,
   checking each filters on `public.is_admin()`:
   `select p.proname, p.prosecdef, pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'admin\_%';`
7. After the Pages deploy runs: delete `pr-preview/pr-3, pr-10, pr-20, pr-26, pr-27`
   from the `gh-pages` branch (M12), and confirm the site root holds only the web app.
8. M16: move the four `CWS_*` secrets to a GitHub environment limited to `main`, add
   `environment:` to `publish-extension.yml`, and reissue the refresh token. (Environment
   branch rules need a paid plan for private repos; otherwise publish by hand.)
9. Supabase Auth: turn off the Email provider (all clients use Google only); keep
   only production redirect URLs (no Expo Go `exp://` entries).
10. Stop the legacy server and the ngrok tunnel, or run it only with strong tokens.
11. Check `PROJECT_TOKEN` is a fine-grained token, not a classic `repo` PAT.
12. `git rm -r --cached supabase/.temp` when committing (the folder is now ignored).

## 6. Residual and accepted risks

- Group-size floors raise the cost of re-identification but not against an attacker
  with many accounts (self-service sign-up). Noise or rate limits would be the next step.
- M11: previews still share the production origin once labelled. Full separation
  needs production on its own domain and previews hosted elsewhere; moving the origin
  strands device-only trade ledgers, so plan an export first.
- H2: injected feedback can still steer the code in an agent PR, so the PR review is
  the control. The agent cannot push, change workflows or reach `gh-pages`: it runs
  with a read-only token, and only the publish job, which runs no AI, can write.
- L3: `yahoo` and `geo` must stay open for installed versions; set Supabase usage alerts.
- Data in transit is HTTPS only; data at rest is encrypted by the hosting providers;
  imported trades are not encrypted on the device beyond the browser's own storage.

## 7. Privacy and compliance

- Terms of Use (`dashboard/terms.html`) and Privacy Policy (`dashboard/privacy.html`)
  ship in the extension and are published with the web app; acceptance is required
  before sign-in and prompted once for accounts signed in before.
- The previous privacy-policy link pointed to the private repository and was a 404 for
  users; the new URL is the published `privacy.html`.
- The operator (Marek Szczęsny, Frankfurt am Main, Germany) is named in both pages as
  GDPR requires; contact address spendtrails@gmail.com.
- The AI assistant is switched on by accepting the Terms. Under GDPR, consent bundled
  with a contract may not count as freely given; a separate, unticked opt-in at first
  use would be safer if the assistant is opened to EEA users.
- The policy commits to deletion within 30 days and feedback retention of 12 months;
  these need a manual process until deletion is self-service.
