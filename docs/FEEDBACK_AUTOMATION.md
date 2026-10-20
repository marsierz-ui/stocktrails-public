# Automated feedback loop

Turn user feedback into reviewed, deployed changes with a human approval gate.
Every component runs on a free tier.

## Flow

```
User submits feedback (dashboard "Feedback" button)
  -> Supabase `feedback` table                              (status = new)
Admin triages in dashboard -> Admin -> Feedback
  -> set category + status, then click "Send to AI agent"   (status = approved -> dispatched)
     -> Supabase Edge Function `feedback-dispatch` (admin-only)
        -> GitHub repository_dispatch (event_type = "feedback")
  -> GitHub Actions `feedback-agent.yml`
     job `implement` (read-only token)
       -> Claude Code edits the checkout, does not commit or push
       -> `git diff --binary` saved as a workflow artifact
     job `publish` (write token, no AI)
       -> rejects the patch if it touches `.github/` or `.git/`
       -> applies it, commits, pushes `feedback/<id>`
       -> opens a Pull Request (does NOT merge)
YOU review the PR on GitHub
  -> approve + merge to `main`
     -> GitHub Actions `deploy-pwa.yml` publishes the PWA to GitHub Pages
  -> (extension) bump manifest version + publish to the Chrome Web Store
```

The human gate is the **PR review/merge**: nothing reaches `main` without your merge.

Feedback text is written by end users, so the agent treats it as untrusted data:
the prompt marks it as such, the agent has no Bash at all (it only reads and edits
files; running the repo tests let it write a script and run it, and git ran
whatever a written `.git/config` named), the export step restores `.git/config`
and runs git with hooks and fsmonitor off, users cannot set the admin note or status on insert
(`20261017_feedback_insert_lockdown.sql`), and PR previews deploy only when you add
the `preview` label after reading the diff.

The agent never holds a write token. The `implement` job runs with
`contents: read`, checks out with `persist-credentials: false`, and passes its own
read-only `GITHUB_TOKEN` as the action's `github_token` input. Without that input,
claude-code-action exchanges an OIDC token for a Claude GitHub App token with
contents, pull-requests and issues write, so the input must stay set. The job has no
`id-token` permission. The feedback id must be digits only; anything else stops the
run before Claude starts.

The `publish` job holds `contents: write` and `pull-requests: write` but runs no AI
and nothing from the patch. It checks out the same commit, downloads the patch,
checks the id again, and rejects the whole patch if `git apply --numstat` lists any
path under `.github/` or `.git/` (at any depth) or with a `..` component. Then it
applies the patch, commits as `github-actions[bot]`, pushes `refs/heads/feedback/<id>`
and runs `gh pr create`. The PR body is the description the agent wrote, under a
note that it comes from end-user text. A prompt injection can still put bad code
in the PR, so read every agent PR before labelling or merging it.

The PR is opened with the workflow's `GITHUB_TOKEN`. GitHub does not trigger
other workflows from pushes or PRs made with that token, so no checks run on agent
PRs until you push to the branch or close and reopen the PR. A rerun for the same
id fails at the push if `feedback/<id>` already exists; delete the old branch first.

## Why it is free

| Component | Free tier |
|---|---|
| Supabase Edge Function (`feedback-dispatch`) | Supabase free plan |
| GitHub Actions (agent + deploy) | Free (public repos unlimited; private 2000 min/mo) |
| GitHub Pages (PWA hosting) | Free |
| Claude Code Action | Uses your Claude subscription via `CLAUDE_CODE_OAUTH_TOKEN` — no extra API billing |

## One-time setup

1. **Create a GitHub repo** and push this project (skip if it already exists on GitHub). The deploy workflow expects the default branch to be `main`.
   ```
   gh repo create <owner>/attention-tracker --private --source . --remote origin --push
   ```
2. **Claude auth (free):** generate a subscription token and add it as a repo
   secret named `CLAUDE_CODE_OAUTH_TOKEN`:
   ```
   claude setup-token              # prints the token
   gh secret set CLAUDE_CODE_OAUTH_TOKEN
   ```
   (Or, to bill the API instead, set `ANTHROPIC_API_KEY` and switch the
   `with:` input in `feedback-agent.yml` to `anthropic_api_key`.)
3. **Enable GitHub Pages:** repo Settings -> Pages -> Source = "GitHub Actions".
   The PWA will be served at `https://<owner>.github.io/<repo>/dashboard/dashboard.html`.
4. **Dispatch token for the edge function:** create a fine-grained PAT with
   *Contents: read & write* on the repo (this scope authorizes
   `repository_dispatch`). Then set the function secrets:
   ```
   supabase secrets set GH_REPO=<owner>/<repo> GH_DISPATCH_TOKEN=<pat>
   supabase functions deploy feedback-dispatch
   ```
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
   injected automatically.

## Safety / guardrails

- The edge function is **admin-gated** (`is_admin()` on the caller's JWT).
- The agent is told to make the **smallest correct change**, keep DB changes
  additive/nullable, and to open a *docs note* instead of code when the request
  is unclear or risky.
- The agent **never merges** — you do.
- `deploy-pwa.yml` only runs on `main`, so only merged (reviewed) changes ship.

## Manual fallback

You can run the agent without the edge function from the Actions tab:
**Feedback AI Agent -> Run workflow**, pasting the feedback text and a numeric
feedback id (it names the branch). Useful for
testing before wiring the Supabase secrets.
