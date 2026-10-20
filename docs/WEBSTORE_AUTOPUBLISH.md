# Auto-publish the extension on merge

`.github/workflows/publish-extension.yml` packages the extension and uploads +
publishes it to the Chrome Web Store every time `main` changes. Store-installed
copies (yours and your testers') then auto-update within a few hours. The
workflow is a no-op until the four `CWS_*` repo secrets below are set.

This is one-time setup. None of it can be automated for you (it needs a paid
Google account and an interactive OAuth consent).

## 1. Create the Web Store item (once)
1. Register a Chrome Web Store developer account ($5 one-time):
   https://chrome.google.com/webstore/devconsole
2. Build the first package locally: `bash tools/pack-extension.sh`
3. In the dev console: **New item** -> upload `dist/stocktrails-*.zip`,
   fill the listing, set visibility to **Unlisted**, and **Publish** once by hand.
4. Copy the item's **ID** (the long id in the item URL). This is `CWS_EXTENSION_ID`.

Also do the OAuth redirect + consent-screen steps in
[WEBSTORE_SUBMISSION.md](WEBSTORE_SUBMISSION.md) so testers can sign in.

## 2. Get API credentials (once)
1. https://console.cloud.google.com -> create (or pick) a project.
2. **APIs & Services -> Library** -> enable **Chrome Web Store API**.
3. **APIs & Services -> OAuth consent screen** -> External -> add yourself as a
   test user (scope `https://www.googleapis.com/auth/chromewebstore`).
4. **APIs & Services -> Credentials -> Create credentials -> OAuth client ID** ->
   application type **Desktop app**. Save the **client ID** and **client secret**.
5. Get a refresh token (run locally, replace the two values):
   ```
   # a) open this URL in a browser, approve, copy the ?code= value from the redirect
   https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&access_type=offline&prompt=consent&redirect_uri=urn:ietf:wg:oauth:2.0:oob&client_id=CLIENT_ID

   # b) exchange the code for a refresh token
   curl -s https://oauth2.googleapis.com/token \
     -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET \
     -d code=THE_CODE -d grant_type=authorization_code \
     -d redirect_uri=urn:ietf:wg:oauth:2.0:oob
   ```
   The JSON response contains `refresh_token`.

   > Note: `urn:ietf:wg:oauth:2.0:oob` (copy/paste code) is deprecated by Google.
   > If it is rejected, add `http://localhost` as an authorized redirect URI on the
   > OAuth client and use that instead, copying the `code` from the localhost URL.

## 3. Add the repo secrets
GitHub repo -> **Settings -> Secrets and variables -> Actions -> New repository
secret**, add all four:

| Secret | Value |
|---|---|
| `CWS_EXTENSION_ID` | item ID from step 1.4 |
| `CWS_CLIENT_ID` | OAuth client ID |
| `CWS_CLIENT_SECRET` | OAuth client secret |
| `CWS_REFRESH_TOKEN` | refresh token from step 2.5 |

## How it works after setup
- Merge a PR to `main` -> `publish-extension.yml` runs.
- Version is set to `<major>.<minor>.<run-number>` (always increasing; the
  committed `manifest.json` major.minor is the base — bump it by hand when you
  want a real version jump).
- The zip is uploaded and published to the store; testers auto-update.

## Notes / gotchas
- The refresh token does not expire while the OAuth consent screen stays in
  "Testing" with you as a test user and the app is used periodically. If publishes
  start failing auth, re-run step 2.5 to mint a fresh one.
- First publish of a brand-new item must be done by hand (step 1.3); the API can
  only update an item that already exists.
- Unlisted items can still get a short review on each publish; auto-update reaches
  testers once it clears.
