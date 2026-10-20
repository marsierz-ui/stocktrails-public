# Stocktrails sync server (optional)

A small sync backend: **Express + SQLite** (`node:sqlite`, built in, no native build). It is an
optional fallback for private setups; clients use Supabase when it is configured and do not use this
server then. It syncs only user-authored data (events, intraday views, and a config blob of
overrides, custom portals and settings). Price bars are not synced: clients refetch from Yahoo.

## Run

Requires Node.js 22.5 or newer (uses the built-in `node:sqlite`; tested on Node 24).

```
cd server
npm install            # installs express
AT_ADMIN_TOKEN=<24+ random characters> AT_TOKEN=<24+ random characters> PORT=8787 npm start
```

The server has no default credentials and refuses to start with a weak secret.

Environment:
- `AT_ADMIN_TOKEN` - required, 24 or more random characters; the password for the admin pages.
- `AT_TOKEN` - optional single-user sync token (user id `default`), 24 or more random characters.
  Alternatively list users in `tokens.json` (see `tokens.example.json`; path overridable with `AT_TOKENS`).
- `AT_ALLOW_REGISTER=1` - lets new clients mint their own token (off by default);
  `AT_REGISTER_KEY` - if set, registration requires it.
- `PORT` - default 8787.
- `AT_DB` - SQLite file path, default `attention.db`.
- `AT_FEEDBACK_SINK`, `AT_DISCORD_WEBHOOK`, `AT_GITHUB_TOKEN`, `AT_GITHUB_REPO` - optional delivery of
  in-app feedback.

For real devices, put it behind HTTPS (a reverse proxy or tunnel) so tokens are not sent in clear text.

## API

All sync requests require `Authorization: Bearer <token>`.

- `GET /health` -> `{ ok: true }`
- `GET /sync?since=<ms>` -> changes after `since`:
  ```
  { events:[...], intraday:[...],
    deletions:{ events:{id:ts}, intraday:{id:ts} },
    meta:{ overrides, customPortals, settings, updatedAt } | null,
    serverTime }
  ```
- `POST /sync` with a client change-set (same shape minus `serverTime`): upserts by `id`,
  last-write-wins on `updatedAt`; deletions are tombstones.

## How clients use it

Both the extension and the web app call `POST /sync` (push local changes since the cursor) then
`GET /sync?since=cursor` (pull and merge), and store `serverTime` as the next cursor. The merge
(`collectChanges` / `applyRemote`) lives in `src/store.js` and is shared by both clients.

In the extension: open the dashboard, choose **Sync**, enter the server URL and token, then
**Save & connect**. It then syncs on a 5-minute alarm, on startup, and after each capture or label.
