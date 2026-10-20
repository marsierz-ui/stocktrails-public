# Security and compliance self-assessment

Date: 2026-10-19. Release under review: the submission build (PR 31,
`feature/hackathon-submission-all`) with this assessment's branch
`fix/security-self-assessment` on top, extension 0.4.0. Scope: the whole product:
the browser extension, the web app (PWA on GitHub Pages), the mobile app (`mobile/`),
accounts and sync, the Supabase database and its 7 edge functions, the AI layer and
bias coach (issues #15, #16), the CI/CD workflows and the legacy token server.
Background: [../PRIVACY.md](../PRIVACY.md), [../../ARCHITECTURE.md](../../ARCHITECTURE.md);
the 2026-10-17 record with its finding ids (H, M, L) is
[../SECURITY_ASSESSMENT.md](../SECURITY_ASSESSMENT.md).

## 1. Method

- Attacker-perspective code review, surface by surface: extension messaging and the
  offscreen AI run, session and sync, dashboard HTML sinks, file imports, web hosting,
  database authorization, edge functions, AI layer, CI/CD, legacy server and tools,
  mobile, secrets and data leakage. Attackers considered: anonymous caller with the
  public anon key, another signed-in user, a malicious or compromised finance site
  (where the content script runs), a crafted import file, a feedback author, a PR
  author or stolen maintainer token, a network attacker, local malware, a curious admin.
- Every finding below was checked against the code (file and line) before it was
  listed. Earlier findings were re-checked for regressions.
- Live configuration was read, never changed: GitHub (repo visibility, Pages source and
  the published `gh-pages` tree, the ruleset on `main`, collaborators, secret names) and
  the production Supabase project (applied migrations, deployed functions and their JWT
  setting, RLS policies, function grants, the security advisor, cron jobs). No request
  was sent to a production endpoint and nothing was exploited live.
- The full history of every branch was scanned for keys and secret files: none found
  (the only JWT is the public anon key).

## 2. Permission tiers, as implemented

### 2.1 The AI agent

| Tier | What the agent may do | How it is enforced | Test |
|---|---|---|---|
| T0 read-only | Name tools that read results computed on the device | The server accepts only the fixed catalogue (`TOOLS` in `supabase/functions/ai-coach/core.mjs`), checks every argument, caps at 4 per step and 5 steps per question (the last must answer; repeated calls are dropped); the browser runs only tools in `ATTools.TOOLS` | `tools/test-ai.js`: step validation, a model that never stops asking is cut at 5 |
| T0 output: paper decisions | Say buy, wait 1-10 trading days or pass, with a size share, for the user's own buys and looks (task `decide`). Runs on a click ("Check a buy") and also by itself about a minute after a viewing session on a finance site ends (an offscreen copy of the dashboard, `src/background.js` `agentMaybeRun`) | Nothing is ordered: decisions move a paper portfolio drawn in the browser and a pop-up on the stock page. The background run starts only when signed in, the Terms accepted and the assistant on (`headlessAgent` in `dashboard/dashboard.js`); only the extension's own offscreen page may talk to the worker about it (`fromHeadless`: same extension id, no tab, dashboard URL). The server validates the decisions (asked ids only, known actions, clamped days, four sizes, cleaned reason), runs `looksPrivate` on the candidates (422) and applies the names policy (403); at most 15 per request | `tools/test-ai.js`: unknown ids dropped, clamping, private candidates refused, names refused; `tools/test-shadow.js`, `tools/test-agent-session.js` |
| T1 local write, user decides | Propose an action: adopt, retire or retune a rule, set a pre-trade reminder for a stock, save a review note | Validated on the server against `ACTIONS` (known types, checked fields, rule ids and stocks that appear in the results, at most 3, a retune needs a setting); the browser shows each as a card and writes to the local store only on the user's click, logged as "You approved" | `tools/test-ai.js`: unknown types, unseen ids and stocks are dropped |
| T2 not offered | Place or change orders; hold broker or bank credentials; write trade data to any server; change account settings | No tool, endpoint, scope or code path exists. The ledger store is local only; the function's only database access is the per-user counter (`ai_usage_bump`) | Code review: `supabase/functions/ai-coach/`, `src/aitools.js` |

Who may call the AI function: a verified Supabase JWT is required. By the code default
set on 2026-10-17 as temporary (`LIMITS.allowAllByDefault`), every signed-in user may
use it; `AI_ALLOW_ALL=false` limits it to `AI_ALLOWED_USERS` (user ids, or e-mails of
Google sign-ins only). See N5.

Human in the loop: every change to the user's data, rules or reminders is a click on a
labelled button. Sending data to the model is covered by the one-time consent; after
it, both the questions the user asks and the background decisions are sent without a
further click, and all of them are listed under "What was sent".

### 2.2 The rest of the product

| Component | May | May not | How it is enforced |
|---|---|---|---|
| Content script (extension) | Run on the listed finance hosts; read the URL, title and headings to detect a ticker; show the label card, reminders and the AI verdict in closed shadow roots | Run elsewhere unless the user adds a portal; read keystrokes, form fields or cookies; read the session tokens or the broker ledger (extension IndexedDB) | `host_permissions` list the portals; `*://*/*` is optional, requested per custom portal; tickers are reduced to `[A-Z0-9.-]{1,16}` (`src/portals.js`); widgets set `textContent` only and ignore synthetic events (`isTrusted`) |
| Service worker (extension) | Store events locally; fetch prices from Yahoo; sync the user's own rows; open the offscreen AI run | Send rows anywhere else; accept agent or storage messages from a tab | Host permissions; no token-server fallback (`AT_SERVER_URL` empty); `fromHeadless` sender check for `offscreenStorage`, `agentDue`, `agentDone`, `agentProgress`, `agentClose` |
| Dashboard, web app, mobile app | Show and edit the signed-in user's own data; import a broker file or a history export; export everything as JSON | Read other users' rows; upload broker trades | RLS on every table; broker ledger has no server path (rule in `AGENTS.md`); script-src 'self' CSP on the dashboard |
| Anonymous caller (anon key) | `keepalive_ping`; `is_admin` (answers false) | Read or write any user's rows | RLS; execute revoked from PUBLIC/anon on every user-data RPC |
| Signed-in user (database) | Read and write rows where `user_id = auth.uid()`; call community RPCs that return floored aggregates | Read another user's rows; make themselves admin | RLS on all 15 tables; `is_admin` column grant revoked plus a trigger |
| Admin (database) | Read all users' rows and the World view; dispatch a feedback item to the feedback agent | Write other users' rows | Every `admin_*` function checks `public.is_admin()` and pins `search_path` (verified on production) |
| Edge functions | `yahoo`: proxy two Yahoo hosts; `geo`: country of the caller's IP; `trending`/`earnings`: snapshot public lists; `crowd-alerts`: e-mail opted-in users; `feedback-dispatch`: send a GitHub dispatch; `ai-coach`: see 2.1 | Reach other hosts through `yahoo`; store the caller's IP; force a capture without the secret | Path allowlist re-checked after normalisation, redirects refused; IP validated and not stored; force secrets; `x-cron-secret`; admin check with the caller's own JWT |
| Feedback agent (CI) | Read and edit files in a checkout of the repository; its patch becomes a PR | Run commands; hold a write token; change `.github/` or `.git/` | `implement` job: `contents: read`, `persist-credentials: false`, tools Edit/Read/Write/Glob/Grep only; `.git/config` restored and git run with hooks and fsmonitor off before the patch is made; the `publish` job (no AI) rejects any path under `.github/` or `.git/` or with `..` |
| Release pipeline | Publish the extension and deploy the web app when `main` changes | Publish from any other branch | Ruleset on `main` (PR, 1 approval, no force push); publish and deploy jobs run only for `refs/heads/main`, a manual run included. Admins can bypass the ruleset, `gh-pages` is unprotected and a write collaborator can edit a workflow in a branch: see N4 |

## 3. Controls

| Area | Control |
|---|---|
| Consent | AI off until the user turns it on; the consent lists what is and is not sent, names the providers and says the agent also decides by itself after a viewing session; withdraw in one click; notes are previewed (redacted) before they are sent |
| Authentication | Google sign-in via Supabase Auth; capture and sync need a signed-in account. The web app and mobile use PKCE; the extension's implicit redirect only reaches `launchWebAuthFlow` |
| Session storage | Extension: tokens in extension IndexedDB, out of reach of content scripts; `chrome.storage.local` holds only the `at_cloud_signed_in` flag. Mobile: AES-256-CTR ciphertext in AsyncStorage, a fresh key per write in the Keychain/Keystore. Web app: supabase-js default (localStorage of the site's origin) |
| Data isolation | RLS on all 15 tables; every SECURITY DEFINER function pins `search_path`; account switch wipes the previous account's local data; the ledger is keyed by account |
| Privilege escalation | `profiles.is_admin` cannot be set by its owner (column grant revoked, trigger) |
| Community views | Group-size floors: a ticker needs 3 distinct users, per-day cells 3 to 5, the crowd overlap days with 20 users and cells with 5 (migration `20261017_community_privacy_floors.sql`) |
| Data minimisation | Country only; IP coordinates never stored server-side; broker trades never leave the device; AI requests carry aliases, ratios and day offsets, checked by `looksPrivate` on the server |
| Output encoding | Values from other users, third-party lists, Yahoo, imports and the model go through `escapeHtml` or `textContent` (checked for the trending, community, crowd, admin, AI and agent views); dashboard CSP `script-src 'self'; object-src 'none'; base-uri 'none'`; CSV exports neutralise formulas |
| Framing | The web app refuses to run in a frame (`src/theme.js`) |
| Code integrity | MV3, no remote code; vendored libraries are files in the repo; third-party actions pinned to commit SHAs |
| Secrets | Anon key public by design (RLS is the boundary); service-role key only in function secrets; publish and agent tokens in GitHub Actions secrets |
| Errors and logs | Provider and database error text is not returned to callers (`ai-coach`; `trending` hides PostgREST errors); `ai-coach` logs metadata only |
| Auditability | "What was sent": every AI request, tool run and answer, exact bodies, downloadable; the server keeps a count per user and day |

## 4. Fixed in this assessment

| Id | Severity | Finding | Fix |
|---|---|---|---|
| N6 | medium | Login CSRF on the web app: supabase-js used the implicit flow with `detectSessionInUrl`, so any link to the app carrying `#access_token=...&refresh_token=...` signed the visitor into the account of those tokens, without a state check. The visitor's local data was wiped (account switch) and everything they recorded next synced to the attacker's account | `src/cloud.js`: web pages use `flowType: "pkce"`; a PKCE return needs the code verifier stored by the browser that started the sign-in, and the vendored supabase-js 2.108.2 rejects implicit tokens in PKCE mode |
| N7 | high | Feedback agent could run code: the prompt carries end-user feedback, and the agent could `Write` a file and run it with the allowed `node tools/test-*`, or plant a `.git/config` (`core.fsmonitor`, `diff.external`) that the allowed `git status`/`git diff` and the later export step would execute. Such code could read the private source and the environment (the Claude OAuth token) and send them out | `.github/workflows/feedback-agent.yml`: no Bash for the agent; `.git/config` saved before the agent runs and restored before the export; git runs with hooks, fsmonitor and external diff off |
| N8 | low | `trending` stored third-party symbols (Stocktwits, ApeWisdom, Yahoo) without checking their characters; the lists are shown to every user. The clients escape them, so this was one layer short, not an open XSS | `supabase/functions/trending/index.ts`: only symbol-shaped values are stored (`SAFE_TICKER`) |
| N9 | low | Clickjacking: GitHub Pages sends no `X-Frame-Options`, so another site could frame the web app and steer clicks (Clear all, AI consent, sign-out) | `src/theme.js`: on http/https the page hides itself and breaks out when framed |
| N15 | medium | "Publish extension" and "Deploy PWA" accept a manual run (`workflow_dispatch`) from any branch, so a mistaken or careless run shipped unreviewed code to every Web Store user or to the live web app | `publish-extension.yml`, `deploy-pwa.yml`: the job runs only for `refs/heads/main`. A collaborator who edits the workflow in their own branch can still remove the guard, so N4 remains |
| N14 | low | The AI consent text named a provider other than the one that answers, said the service answers only accounts the owner switched on (not true since 2026-10-17), and did not mention the background decisions | `dashboard/ai.js`: names OpenRouter (and the alternatives) and the automatic run; the allowlist claim is gone |
| H2, L5, L14 | | Fixes from the 2026-10-17 assessment whose PRs (#28, #29) targeted a branch that was closed, so they were missing from the submission build | Merged: feedback agent split into a read-only agent job and a no-AI publish job; extension tokens in IndexedDB; mobile session encrypted |
| N1 | high | Production ran without the 2026-10-17 database hardening (last applied migration `20261016_crowd_series_and_alerts`): `world_crowd_overlap` had no group floor, so any signed-in user could reconstruct other users' per-day, per-ticker views (H1); per-day community cells could hold one person (M1); users could insert feedback with an `admin_note`, which the feedback agent's prompt treats as the maintainer's guidance (H2, database half); the admin guard trigger could not fire (L6); `trending`, `earnings` ran without single-flight claims (M3); `crowd-alerts` was not deployed | Applied on 2026-10-19: `capture_claims`, `community_privacy_floors`, `definer_hardening`, `feedback_insert_lockdown`, `crowd_alerts_cron_secret`. Deployed `trending` (v15, with N8), `earnings`, `ai-coach`, `crowd-alerts`. Verified on production (tests in rolled-back transactions): floors in place, anon execute revoked, self-promotion to admin refused, a feedback insert with `admin_note` refused while a normal one passes, no existing `admin_note` rows, `crowd-alerts` answers 403 without the secret, `earnings` and `ai-coach` 401 without a JWT |
| N2 | high | The public site published full-repository snapshots: the root (deployed by `main`'s old workflow, which published `.`) and the old PR previews `pr-preview/pr-3`, `pr-26`, `pr-27`. Anyone could read the SQL and RLS, the edge-function source, the mobile app, `supabase/.temp`, internal docs (pr-27 held the previous version of this file) and `server/server.js` with its former default admin token `admin-changeme` | Removed from `gh-pages` on 2026-10-19 after a local backup (git bundle and zip): the previews (`f29205c`) and every root entry except `index.html`, `manifest.webmanifest`, `sw.js`, `dashboard`, `src`, `vendor`, `icons`, `pwa` (`573dddf`). The removed URLs answer 404; the web app still loads with no console errors. The live web app (2026-10-06 build) was then hot-fixed (`9f951d3`): no token-server fallback (`AT_SERVER_URL` empty, `doSync` stops at the cloud path, as 6cf713c), and `dashboard/privacy.html` and `terms.html` published; in the browser a signed-out sync now stops with "not signed in to the cloud" |

## 5. Open findings, most severe first

| Id | Severity | Finding | Who closes it |
|---|---|---|---|
| N3 | high | The web app shares its origin, `https://marsierz-ui.github.io`, with every Pages site of the account, including the public `World-network` site (built by a workflow from npm packages) and every PR preview. Any script on that origin can read the web app's session (localStorage) and the device-only broker ledger (IndexedDB). A compromised dependency of World-network is enough | Design: serve the web app from its own origin (custom domain, or a dedicated GitHub account or organisation), previews elsewhere. Moving the origin strands device-only ledgers, so ship an export first |
| N4 | high | The release path has bypasses. The `main` ruleset lets the Admin role bypass it always; `gh-pages` (the production web app) has no protection, so any write collaborator or leaked token with `contents: write` can push code that runs for every web-app user; the `CWS_*` publishing secrets are repository-wide, so a workflow pushed on any branch by a write collaborator can read them and publish an extension (M16) | Owner: remove the admin bypass or require 2FA and hardware keys for admins; add a ruleset on `gh-pages` that only the deploy workflows may update; move `CWS_*` to an environment limited to `main` and add `environment:` to `publish-extension.yml`; reissue the refresh token |
| N5 | medium | AI function open by default: `LIMITS` in `core.mjs` sets `allowAllByDefault: true`, `capByDefault: false`, `namesByDefault: true` ("temporary", 2026-10-17). Unless the secrets say otherwise, anyone who signs in with a Google account can call the model without a daily cap (quota or bill drained), real stock names are accepted, and users in the EEA, UK and Switzerland reach the provider on whatever plan the key has (a free-tier key's terms may forbid that; OpenRouter requests are sent with data collection denied). Earlier docs said "deny by default" | Owner decision, no redeploy: `supabase secrets set AI_ALLOW_ALL=false AI_DAILY_CAP=40 AI_NAMES_OK=false` and list users in `AI_ALLOWED_USERS`; or restore the defaults in `core.mjs` after the hackathon |
| N2c | medium | The Chrome Web Store extension (the published version) still falls back to the personal ngrok token server when the cloud declines a sync (M10), until PR 31 is merged and published; the legacy server is not running on the maintainer's machine as of 2026-10-19 | Owner: merge PR 31 (publishes the extension); keep the legacy server and the ngrok tunnel off |
| N1b | low | E-mail alerts are not switched on: `20261016_crowd_alerts_cron` (the daily `crowd-alerts` job) is held back by design until alerts go live, and `CROWD_ALERTS_SECRET` (function secret and Vault) is not set, so the deployed `crowd-alerts` refuses every call | Owner, when alerts go live: set `RESEND_API_KEY`, `MAIL_FROM` and `CROWD_ALERTS_SECRET` (and the same value in Vault), then apply `20261016_crowd_alerts_cron.sql` and `20261017_crowd_alerts_cron_secret.sql` again |
| N10 | low | Content scripts can read all of `chrome.storage.local`: the attention history with page URLs, notes, reminders and the AI verdicts. A renderer exploit on a finance site (for example through an ad) exposes them. The session tokens are no longer there | Deferred: serve the widget's reads through worker messages and set `chrome.storage.local.setAccessLevel` to trusted contexts |
| N11 | low | E-mail and password sign-in is offered next to Google (owner decision, 2026-10-19), so password guessing and leaked passwords apply: Supabase Auth's leaked-password protection is off and `pg_net` sits in schema `public` (advisor warnings) | Owner: turn on leaked-password protection and keep e-mail confirmation on in Supabase Auth; keep only production redirect URLs |
| N12 | low | `geo` falls back to `x-forwarded-for` when `cf-connecting-ip` is missing, so a caller can look up any public IP on the project's ipapi.co quota; `yahoo` returns network error text. Both functions are open by design (L3) | Accepted; set Supabase usage alerts |
| N13 | info | The dashboard CSP restricts scripts only; an HTML injection could still load images or send requests to other hosts. No injection sink was found | Hardening option: add `img-src` and `connect-src` lists once the needed hosts are settled |

## 6. Known-risk list

Likelihood and impact for the current release, after the fixes in section 4.

| # | Risk | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|
| R1 | The model states a wrong number or explains a true one wrongly | Medium | Medium | Replies come from results only; numbers checked and marked; results shown | A wrong explanation of a right number is not detected automatically |
| R2 | Personal data typed into a question or a note | Medium | High | Redaction of obvious patterns; preview of notes; consent says not to type personal information | Names and free text cannot be reliably recognised |
| R3 | Re-identification from aggregates and from the AI agent's per-decision records | Low (aggregates), Medium (`decide`) | Medium | Months not days, ratios not amounts; `decide` sends aliases, "day N" and ids of that request only | One record per buy or look with day offsets, the hour and a weekly price path: matched against public prices it can point to the stock and the day |
| R4 | Provider terms: free-tier content used by the provider; not allowed for EEA, UK and Switzerland users; 18+ | High while N5 stands | High | Owner sets the plan and the allowlist; the privacy policy names the providers | Depends on the owner's settings (N5) |
| R5 | Prompt injection through a question, a note or a page | Medium | Low | System prompts only on the server; inputs labelled as data; tool names and actions validated; the reply is plain text; actions need a click | The wording of an answer or an unhelpful proposal can still be produced |
| R6 | A rule that stopped working is followed | Medium | Medium | Out-of-sample check; adherence; rules can be retired | Markets change |
| R7 | A rule that looks good by luck | Medium | Medium | Walk-forward with an embargo; 99% range for "supported"; 0 of 216 rules recommended in worlds with no effect | Overlapping trades make ranges somewhat optimistic |
| R8 | The statistics hold in tests but not on real investors | Medium | Medium | Statuses and minimum sample sizes; "not enough data" is a result | No validation on a population of real investors yet |
| R9 | The live API differs from the documented shape | Medium | Low | One place builds and reads each request; `tools/ai-smoke.js` checks it with a key | Not run against the live API in this repository |
| R10 | Quota exhaustion of a shared key | High while N5 stands | Low | Per-user cap when set, small model for notes, caching | No cap by default (N5) |
| R11 | The local log holds the exact bodies sent | Low | Low | Only what was sent; clearable; on the device | A shared computer shows it to the next person |
| R12 | A service worker or old page keeps old code | Low | Low | Cache name bumped on each release (`attention-shell-vN`, v30 now), network first | Offline copies update on the next online visit |
| R13 | A runaway agent loop uses the quota | Low | Low | At most 5 steps, repeated calls dropped, each step counted | A question can use up to 5 calls |
| R14 | Hindsight in the AI agent's backtest | High for a backfill | Medium | Each paper decision saved once with its time; only moments at most 2 days old are asked; decisions after the fact are labelled | Few decisions at first |
| R15 | Paper decisions read as advice | Medium | Medium | Labelled paper portfolios, no orders, not investment advice | A user may still copy a "buy" |
| R16 | The background AI run sends data while the user is not looking at the dashboard | Medium (by design) | Low | Only after consent, terms and sign-in; disclosed in the consent; every request in "What was sent"; off in one click | A user who forgot the consent is surprised |
| P1 | Public functions (`yahoo`, `geo`, `trending`) have no per-caller rate limit | Medium | Medium | Strict allowlists, freshness gate, force secrets, client caching | A caller can burn the ipapi.co quota or get the proxy blocked |
| P2 | Prices come from Yahoo's unofficial, keyless endpoints | Medium | High | One module behind a proxy; failures shown | Terms and availability not guaranteed |
| P3 | Same-origin web app (N3): PR previews and other Pages sites of the account share the session and the ledger | Low | High | Previews only when a maintainer adds the label | Full separation needs an origin of its own |
| P4 | Prompt injection through feedback into the feedback agent | Low | Medium | Admin dispatches each item by hand; agent cannot run code or push; publish job rejects `.github/` and `.git/`; PR review | A malicious change can pass a careless review |
| P5 | Country and VPN detection is location-derived processing | Medium | Medium | Country only; IP and coordinates not stored server-side; World view admin-only; in the policy | No opt-out switch; VPN heuristics have false positives |
| P6 | The caller's IP goes to ipapi.co | High (by design) | Low | Server-side lookup, cached 3 h on the device | A processor sees the IP (listed in the policy) |
| P7 | Re-identification in community views of a small user base, including by Sybil accounts | Low | Medium | Group floors (live since 2026-10-19) | Floors do not stop an attacker with many accounts |
| P8 | Full page URLs are stored and synced (research data); some carry search text | High (by design) | Medium | In the policy; visible only to the user and admins; community views never return URLs | Personal text typed into a portal's search is stored |
| P9 | Web-app session in localStorage; any script injection or same-origin page exposes it | Low | High | Output encoding; script-src 'self'; frame guard | N3 |
| P10 | Admins can read every user's raw attention data | Low | Medium | Admin flag locked; admins are named project members | No audit log of admin reads |
| P11 | A merge to `main` publishes the extension to every user at once | Low | High | Review on every PR; tests | No staged rollout or automatic rollback |
| P12 | Broker data at rest in IndexedDB is not encrypted | Low | Medium | Device-only, per account, deletable | Anyone with the unlocked browser profile can read it |
| P13 | Account deletion is by request, not self-service | Medium | Medium | Export and local clear are self-service | Slower than GDPR expects; proposed: a delete-account RPC |
| P14 | Google Fonts on the dashboard and pop-up send the user's IP to Google | High (by design) | Low | Stylesheet only | Proposed: self-host the font |
| P15 | Browsing-history import on a compromised device | Low | High | The file is never stored or uploaded; only portal URLs survive the filter | A compromised device is outside what an app can defend |
| P16 | Hijacked release (N4): a maintainer account or token taken over | Low | High | `main` ruleset; publish on `main` only | Admin bypass, unprotected `gh-pages`, repo-wide publishing secrets until N4 is done |

## 7. Owner actions, in order

1. Review and merge `fix/security-self-assessment` into PR 31. Merging PR 31 publishes
   the extension (it touches `src/`, `dashboard/`, `manifest.json`) and redeploys the
   web app with only its own files.
2. Done on 2026-10-19: the migrations (N1), the four function deploys, the check of
   `admin_note` (none existed) and the removal of everything but the web app from the
   public site (N2; backup in `IT/backups/gh-pages-2026-10-19/`).
3. When e-mail alerts go live (N1b): set `RESEND_API_KEY`, `MAIL_FROM` and
   `CROWD_ALERTS_SECRET`, put the same value in Vault
   (`select vault.create_secret('<random>', 'crowd_alerts_secret');`), then apply
   `20261016_crowd_alerts_cron.sql` and `20261017_crowd_alerts_cron_secret.sql`.
4. Merge PR 31 so the site serves the current web app and the Web Store extension loses
   its token-server fallback (N2c). Keep the legacy server and the ngrok tunnel off.
5. Decide N5: `supabase secrets set AI_ALLOW_ALL=false AI_DAILY_CAP=40 AI_NAMES_OK=false`
   with the judges and testers in `AI_ALLOWED_USERS`, or keep it open for the judging
   period with a usage alert on the provider.
6. GitHub (N4): drop the admin bypass on `main`; protect `gh-pages`; move `CWS_*` to an
   environment limited to `main`; check `PROJECT_TOKEN` is fine-grained; 2FA on every
   GitHub, Google and Chrome Web Store account.
7. Supabase Auth (N11): keep e-mail confirmation on, turn on leaked-password protection; production redirect URLs only.
8. Before opening the web app to more users: give it its own origin (N3).
9. Done: the operator (Marek Szczęsny, Frankfurt am Main, Germany) is named in both pages;
   update it when a holding company takes over.

## 8. Compliance notes

- GDPR: purpose limitation (one product, no advertising, no sale of data); data
  minimisation (section 3); EU hosting (Supabase, eu-west-3, Paris); processors named
  in the privacy policy: Google (sign-in, Fonts), Supabase, Yahoo, ipapi.co,
  OpenRouter (the primary AI provider, which passes requests to the model that answers; Cerebras is an alternative), Resend (opt-in e-mail), GitHub and Anthropic (feedback
  automation). Rights: access and portability via Export JSON; erasure on request (P13).
  The AI is switched on by its own consent, separate from the Terms.
- Chrome Web Store user-data policy: data use limited to the disclosed purpose; broad
  host access only on explicit user request.
- Financial regulation: the product describes the user's own behaviour, executes no
  orders and gives no personalised investment advice; the agents' decisions are paper
  portfolios, labelled as such.
- Licences: html2canvas and supabase-js (MIT) vendored with their headers; the World map
  path data is CC BY-SA 3.0, attributed in `vendor/world-map.js`.

## 9. Evidence

- Tests after the fixes: `node tools/test-ai.js`, `test-shadow.js`, `test-biases.js`,
  `test-trades.js`, `test-indicators.js`, `test-agent-session.js`, `test-pricecache.js`,
  `test-headinfo.js` all pass; every changed JS file passes `node --check`;
  `feedback-agent.yml` parses as YAML.
- Live checks (read-only, 2026-10-18): Supabase migration list, function list with
  `verify_jwt`, RLS policies and function grants, security advisor; GitHub Pages
  settings, the `gh-pages` tree, the `main` ruleset, collaborators and secret names.
- Deployment (2026-10-19): before each function deploy the live source was compared with
  the branch (only additions: claims, the symbol filter, English-only decisions). After
  it: the security advisor lists 2 security-definer functions callable without sign-in
  (`is_admin`, `keepalive_ping`; 6 before) and the admin guard no longer runs as owner;
  each change was exercised as described for N1 in section 4.
- AI layer: [evidence/demo-run.md](evidence/demo-run.md) and
  [evidence/demo-run.json](evidence/demo-run.json) (generated by `node tools/demo-run.js`).

## 10. Known limitations of the data (not security)

- Research device and trading device differ: many users research on a desktop and
  trade in a mobile broker app, so device effects are not claimed as findings.
- Mobile capture is thinner: shared pages and screenshots, no reading time or scroll
  depth; browsing-history imports carry neither. Both are marked by `source`.
- Trades stay on the device: cross-user analysis of trades is only possible in the
  simulation.
