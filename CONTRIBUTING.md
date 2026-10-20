# Contributing to Stocktrails

How we work together on this repository. Read it once; it takes five minutes.
AI assistants read `AGENTS.md`, which carries the same rules in short form.

## The idea in one paragraph

`main` is always in a working state and is protected. Nobody commits to it
directly (except the owner in emergencies). Every change is made on its own short
branch, proposed with a pull request (PR), reviewed by the other person, and then
merged. Every piece of work starts as an issue, so the board always shows who is
doing what.

## One-time setup

1. Accept the invitation to the repository (email or github.com notifications).
2. Clone and open it:
   ```
   git clone git@github.com:marsierz-ui/attention-tracker.git
   cd attention-tracker
   ```
3. Load the extension: `chrome://extensions` > Developer mode > Load unpacked >
   select the folder. Read README.md for the other clients (web app, mobile).
4. Make sure `git config user.name` and `user.email` are set to your own GitHub identity.

## Daily workflow

1. **Find or create an issue.** Use the New issue button (Bug or Feature template).
   Assign yourself. The issue appears on the board in **To do**; when you are
   assigned it moves to **In progress**. For anything large or architectural,
   describe the plan in the issue and wait for a reply before coding.
2. **Sync, then branch:**
   ```
   git checkout main
   git pull origin main
   git checkout -b feature/short-topic
   ```
   Names: `feature/...`, `fix/...`, `docs/...`. One feature or fix per branch.
3. **Commit small and often** with clear messages ("Fix hourly chart gap on
   holidays", not "changes"). Stage the files you changed rather than `git add .`.
4. **Push and open a PR early:**
   ```
   git push -u origin feature/short-topic
   ```
   Open the PR into `main`. Mark it **Draft** while unfinished: it shows as
   **In progress** and cannot be merged by accident. Put `Closes #<issue>` in the
   description so the issue closes when the PR merges.
5. **Update before review.** Bring in the latest `main`, resolve any conflicts,
   run the app, then push:
   ```
   git checkout main && git pull origin main
   git checkout feature/short-topic && git merge main
   ```
   Conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) must be edited out by hand;
   then `git add` the file, `git commit`, and push.
6. **Request review.** Click **Ready for review**. The card moves to **Review**.
   Tell your teammate; GitHub does not always notify reliably.
7. **Review and merge.** The other person reads the diff, tries the branch if it
   touches behavior, comments or approves. At least one approval is required.
   After approval the reviewer (not the author) merges using **Squash and merge**
   and deletes the branch. The card moves to **Done**.

## Reviewing

- Review within a day if you can; small PRs make this easy.
- Check: does it do what the issue says, is it small and readable, does it break
  sync or the other clients, are README.md / ARCHITECTURE.md updated if behavior changed.
- Ask questions in the PR rather than chat so the reasoning stays with the code.

## Rules

- Never push to `main`. Never force-push a shared branch. Never rewrite history others have pulled.
- Do not merge your own PR.
- Never commit secrets or personal data: `.env`, `server/tokens.json`,
  `server/attention.db`, API keys, tokens.
- Keep PRs small. If a PR needs more than a few hundred changed lines, split it.

## Project-specific warnings

- **Merging is releasing.** A merge to `main` that touches `manifest.json`,
  `src/`, `popup/`, `dashboard/`, `vendor/` or `icons/` automatically publishes a
  new version to the Chrome Web Store, and every merge redeploys the web app.
  Only merge extension changes that are ready for real users.
- **Three clients, one account.** The extension, the web app and `mobile/` all sync
  the same Supabase account. Changes to the data model or sync must work in all
  three and stay compatible with older store versions (see ARCHITECTURE.md, section 5).
- **Database changes** go in a new dated file in `supabase/migrations/`; never edit an applied one.
- **Broker trades data stays on the device.** Do not sync it to Supabase without end-to-end encryption.
- Do not create files whose names start with `_` in the extension folder; Chrome rejects them.

## The board

https://github.com/users/marsierz-ui/projects/2 moves by itself:

| Event | Column |
|---|---|
| New issue | To do |
| Issue assigned, or PR opened as draft | In progress |
| PR opened or marked ready for review | Review |
| PR merged or closed, issue closed | Done |

You never drag cards by hand. If a card is in the wrong place, the PR or issue
state is wrong.

## Working with an AI assistant

Your assistant should read `AGENTS.md` (Claude Code reads `CLAUDE.md`, which points
to it). You stay responsible for what it commits: review its diff, keep the
branch small, and do not let it push to `main` or force-push.
