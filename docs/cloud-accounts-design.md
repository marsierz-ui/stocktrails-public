# Attention Tracker - cloud accounts (multi-user SaaS) design

> Status: implemented (Supabase Auth with Google sign-in, row-level security, last-write-wins
> triggers, admin RPCs). Kept as the original design record; current behavior is in
> ARCHITECTURE.md section 2 (Cloud) and section 5 (Sync). Supersedes the single-token
> self-hosted sync for the public product; the local extension keeps working standalone.

## Context & goals
Move from a personal, self-hosted, shared-token sync to a real multi-user product:
- Users sign in with **Google**.
- **One cloud source of truth**; any device sees the same data after login.
- **Per-user isolation** (no user can read another's data).
- **Admin overview** for the operator (you): list accounts, inspect usage.
- **Consent-gated data collection later**, jurisdiction-aware (GDPR/CCPA). Built
  to support it; collect nothing extra now.

Reuse what already exists: the delta-sync engine (`collectChanges`/`applyRemote`,
`updatedAt` + tombstones in `src/store.js`) is provider-agnostic and carries over
unchanged. Only the transport and auth change.

## Architecture overview
```
   Extension (Chrome)         PWA (browser / installed)
        │  Google login            │  Google login
        │  (chrome.identity)       │  (supabase-js OAuth)
        ▼                          ▼
                 Supabase (managed)
        ┌───────────────────────────────────────┐
        │  Auth (GoTrue, Google OIDC) → JWT      │
        │  Postgres (source of truth)            │
        │    events / intraday / meta (+user_id) │
        │    Row-Level Security: user_id=auth.uid│
        │    trigger: keep row with max updatedAt│
        │  Edge Function: /yahoo price proxy     │
        └───────────────────────────────────────┘
        Admin: Supabase Studio (now) → custom admin page (later)
   PWA static files hosted on Cloudflare Pages / Vercel / Netlify
```

## Stack: what we use, what we avoid (for portability)
Use:
- **Postgres** - the data. Plain SQL, fully portable.
- **Auth (GoTrue)** - Google sign-in, issues standard JWTs (`sub`, `email`).
- **Row-Level Security** - standard Postgres; the tenant-isolation mechanism.
- **One Edge Function** - the Yahoo price proxy (PWA can't call Yahoo: CORS).
- **Studio** - the admin console, day one.

Deliberately avoid / isolate (to keep migration cheap):
- Don't spread `supabase-js` calls across the app. Put every cloud call behind a
  single client module `src/cloud.js` (sign-in/out, session, `pullSince`, `push`).
  Swapping providers later = rewrite this one file.
- Keep sync/merge logic in `store.js` (already provider-agnostic) and in Postgres
  (the LWW trigger is portable SQL), not in Supabase-specific glue.
- Avoid Realtime, Storage, and deep PostgREST-specific query features for core
  flows; a periodic pull is enough.

## Data model (sketch)
Reuse today's shape, add `user_id` and standard timestamps:
```sql
-- profiles: 1 row per auth user (app-level user record + flags)
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  email text, created_at timestamptz default now(),
  is_admin boolean default false,
  region text,                  -- for data-residency/consent logic
  consent_version int default 0 -- policy version this user has accepted (0 = none)
);

-- consent: one row per (user, scope) the user has acted on; versioned + revocable.
-- scope in: 'core'(A), 'aggregate'(B), 'sold_data'(C), 'research'(D), 'profiling_ads'(E)
create table consent (
  user_id uuid not null references auth.users on delete cascade,
  scope text not null,
  granted boolean not null,
  policy_version int not null,
  granted_at timestamptz default now(),
  revoked_at timestamptz,
  method text,                  -- e.g. 'signup-gate', 'settings-toggle'
  primary key (user_id, scope)
);
-- A/B are the baseline required to enable cloud at all; C/D/E default to granted=false
-- and are only ever set true by an explicit, separate opt-in. Server-side use of
-- data for B-E must check a current granted row before processing.

create table events (
  id text not null, user_id uuid not null references auth.users on delete cascade,
  ticker text, ts bigint, source text, url text, sentiment text,
  price_at_event double precision, views int,
  updated_at bigint, deleted boolean default false,
  primary key (user_id, id)
);
-- intraday: same columns minus views
-- user_meta: user_id pk, config jsonb (overrides/customPortals/settings), updated_at

create index on events(user_id, updated_at);
```
Row-Level Security (the isolation guarantee), same policy on every table:
```sql
alter table events enable row level security;
create policy own_rows on events
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- user_id defaults to auth.uid() via a trigger/default so clients can't spoof it
```
Last-write-wins enforced in the DB so even direct upserts are safe:
```sql
create function keep_newer() returns trigger as $$
begin
  if new.updated_at <= old.updated_at then return old; end if;
  return new;
end $$ language plpgsql;
create trigger events_lww before update on events
  for each row execute function keep_newer();
```

## Sync (reuse the delta engine)
Unchanged: `collectChanges(data, cursor)` and `applyRemote(data, remote)` in
`store.js`. New transport in `src/cloud.js`:
- **push(changes):** `upsert` events/intraday (RLS checks user_id; trigger keeps
  the newer row); upsert tombstones (`deleted=true`); upsert `user_meta`.
- **pullSince(cursor):** `select * where synced_at > cursor` (RLS scopes to the
  user) for events/intraday + meta, paged in 1000-row blocks ordered by
  `synced_at`. This shipped as `updated_at > cursor` against a client-clock
  cursor, which permanently hid any row pushed after another device's cursor had
  moved past its capture time; see ARCHITECTURE.md section 5 and
  `supabase/migrations/20260813_server_sync_cursor.sql`.
- Cursor stored per device (as today). Auth header is the user JWT, not a shared
  token; the server derives the user from it - no `user_id` trust from the client.

This keeps the exact two-step push-then-pull loop already in `src/sync.js`.

## Auth flows
- **PWA:** `supabase.auth.signInWithOAuth({ provider: 'google' })` (redirect),
  session cached by `supabase-js`; `cloud.js` attaches the JWT.
- **Extension (MV3):** browsers don't allow the web redirect well. Use
  `chrome.identity.getAuthToken` / `launchWebAuthFlow` to get a Google ID token,
  then `supabase.auth.signInWithIdToken({ provider:'google', token })`. Requires
  an OAuth client ID for the extension. Login UI added to popup + dashboard.

## Price proxy
The PWA still can't call Yahoo (CORS). Reimplement today's `/yahoo` proxy as a
**Supabase Edge Function** (same allowlist: `/v8/finance/`, `/v1/finance/search`;
8s timeout). The extension keeps fetching Yahoo directly via host permissions.

## PWA hosting
Supabase isn't a static host. Serve the PWA (`dashboard/`, `src/`, `pwa/`,
`icons/`) from **Cloudflare Pages / Vercel / Netlify** (free, HTTPS, custom
domain). HTTPS is required for the service worker, install, and share-target.

## Interim model: local-first, consent-gated cloud (recommended for now)
Until concrete use cases + a data policy exist, keep all data on-device and pull
it to the cloud only after the user reviews the policy. Lowest legal exposure:
data the user never sends you largely doesn't make you a controller.

- **Phase 0 (now):** local-only. Extension uses `chrome.storage`; PWA uses
  IndexedDB. No accounts, no server-side user data. Ship a short honest notice
  ("your data stays on your device; we don't collect it") and add **Import JSON
  (merge)** alongside Export, since local-only data is lost on uninstall/clear.
  - One caveat to keep it truly no-collection: the PWA price proxy transits
    tickers to your server (CORS). **Do not log proxy requests** (no IP/ticker
    logs); the extension fetches Yahoo directly and touches nothing of yours.
  - Tradeoff: no cross-device sync in this phase (each device is independent).
- **Phase 1 (cloud rollout):** on update, present a **required policy/consent
  review** before any upload. Accepting the baseline (A/B) enables cloud; C/D/E
  are separate, default-off opt-ins. Only after a current `consent` row exists,
  offer **"upload my data"** (the migration push below). **Declining keeps the
  app fully working locally** - never force the upload, never auto-upload on
  update. Re-prompt when `policy_version` changes.

## Migrating existing local data
On first login *after consent*, the client reads the existing local store
(`chrome.storage` / IndexedDB) and runs the normal `push` once (the `getAll`
backfill already stamps `updated_at` on pre-sync records). No special importer
needed; the device's local data becomes the seed for the account. The push is
gated on a current baseline-consent record - no consent, no upload.

## Admin overview
- **Now:** Supabase Studio - Authentication (user list, sign-ins), Table editor,
  SQL editor for ad-hoc usage queries. Zero code.
- **Later:** a small admin page behind `profiles.is_admin`, calling a server with
  the **service-role key** (never in the browser) for cross-user aggregates.

## Privacy / consent (deferred, schema-ready)
Build core first; design so consent slots in without a rewrite:
- `profiles.region` + a future `consent(user_id, policy_version, scopes jsonb,
  granted_at)` table.
- Data minimization now: store only what the app needs (the attention data the
  user creates). Collect nothing for analytics until consent + policy exist.
- A privacy-policy placeholder + a consent checkbox at signup.
- Region: pick one Supabase region to start; EU region if EU users are a near-term
  priority (GDPR right-to-export/delete map to a `pull` export + cascade delete).
- Note: this is engineering guidance, not legal advice; GDPR/CCPA compliance and
  the privacy policy/DPA need real legal review before collecting beyond app data.

## What changes vs. today
- **Retire** `server/` (Express + node:sqlite) and the single-token Sync panel for
  the hosted product. (Keep them only if you still want a self-host option.)
- **Add** `src/cloud.js` (provider-isolated), Google login UI (popup + dashboard +
  PWA), a consent/privacy placeholder, the Supabase schema + RLS + trigger + Edge
  Function, and a static-host deploy for the PWA.
- **Unchanged** `store.js` merge engine, `prices.js`, all dashboard charts/analytics.

## Anti-lock-in: when and how to migrate off Supabase
What's portable vs. coupled:
- **Fully portable:** the data (Postgres `pg_dump`), the schema, RLS policies, the
  LWW trigger - all standard Postgres. Google identities are external, mapped by
  `email`/`sub`, so no password migration.
- **Coupled (kept small on purpose):** `supabase-js` usage (confined to
  `cloud.js`), the Auth (GoTrue) session/JWT issuance, and the Edge Function
  runtime (Deno). Re-pointing means rewriting `cloud.js` and re-hosting one
  function.

When migrating makes sense:
- Cost crosses self-host break-even at scale, or you need infra/region/compliance
  control Supabase can't give.
- You hit platform limits (connection caps, Edge Function constraints) or want to
  remove vendor risk.

What a migration takes (estimate: days, not weeks, if `cloud.js` is the only glue):
1. `pg_dump` -> restore into managed Postgres (Neon / RDS / Cloud SQL).
2. Replace Auth: stand up Auth0/Clerk/own GoTrue; users re-login with Google
   (identities map by email/sub; no secrets to move).
3. Rewrite `src/cloud.js` against the new API (or a thin Express/PostgREST layer);
   the sync logic in `store.js` and the SQL (RLS, trigger) move as-is.
4. Re-host the one Edge Function as a small endpoint.
Keeping RLS + triggers + a single client glue module is the whole anti-lock-in
strategy: the expensive parts (data, merge logic, isolation rules) never leave
standard Postgres.

## Phasing
- **M0 - Local-first (now):** ship local-only (no accounts/cloud); add Import JSON
  (merge) + a short "data stays on your device" notice; don't log the price proxy.
- **M1 - Auth + cloud sync MVP:** schema + RLS + trigger + consent table; `cloud.js`;
  Google login (PWA + extension); the consent-review gate before any upload; swap
  `sync.js` transport; Edge Function proxy; deploy PWA. Multi-device, per-user.
- **M2 - Admin:** custom admin page (or stay on Studio) + usage queries.
- **M3 - Consent/privacy depth:** C/D/E opt-in toggles, export/delete (DSAR),
  region handling, anonymisation layer for B/C/D.

## Open items / cost
- Supabase free tier pauses inactive projects and caps DB/MAU; budget Pro for a
  real launch.
- Domain for the PWA + OAuth consent screen (Google verification for >100 users).
- Decide self-host-option retention (keep `server/` or drop it).

## Verification (when M1 is built)
1. Two browsers, two Google accounts: each sees only its own data (RLS check -
   try to read the other's `user_id` via the API; must return nothing).
2. Log in on device A, add stocks; log in same account on device B -> data
   appears; edit/delete on B -> reflects on A after sync.
3. Re-sync twice -> no duplicate rows / no re-upload churn (cursor + trigger).
4. Existing local extension data uploads once on first login.
5. PWA price charts load via the Edge Function proxy; extension loads direct.
