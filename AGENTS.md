# Working agreement for humans and AI assistants

Read this before changing anything. Full human version: CONTRIBUTING.md.

## Git rules
- Never commit or push directly to `main`. It is protected: changes arrive only
  through a pull request with at least one approval.
- Before starting: `git checkout main && git pull origin main`.
- One branch per task, named `feature/<topic>`, `fix/<topic>` or `docs/<topic>`.
- Small, focused commits with clear messages. One feature or fix per branch.
- Before opening a PR, merge the latest `main` into your branch and resolve conflicts.
- Open a draft PR early for unfinished work. Describe what and why.
- Link the task in the PR body with `Closes #<issue>`. If there is no issue for
  non-trivial work, create one first. Discuss architecture changes in an issue
  before coding.
- Never force-push a shared branch. Never rewrite history that others have pulled.
- Do not merge your own PR. A teammate reviews and merges.
- Do not stage everything blindly (`git add .`). Stage the files you changed.
  Never commit secrets, `.env`, `server/tokens.json`, `server/attention.db`, or
  `node_modules`.

## Project rules that are easy to break
- Merging to `main` is a release trigger: a change touching `manifest.json`,
  `src/`, `popup/`, `dashboard/`, `vendor/` or `icons/` auto-publishes the Chrome
  Web Store extension (`.github/workflows/publish-extension.yml`), and any merge
  deploys the PWA. Do not merge extension changes unless they are release-ready.
- Three clients share one Supabase account (extension, PWA, `mobile/`). A change
  to the data model, sync or field mapping must be made in all of them and must
  stay compatible with older store versions. See ARCHITECTURE.md section 5.
- Schema changes go in `supabase/migrations/` as a new dated file. Do not edit
  applied migrations.
- Broker trades data is device-only. Do not add a Supabase table or sync path for
  it without end-to-end encryption.
- Never create files starting with `_` in the extension directory.
- Update ARCHITECTURE.md and README.md when behavior they describe changes.
