# Chrome Web Store - submission kit

Everything you paste into the Developer Dashboard for version 0.4.0, plus the
steps. Visibility stays **Unlisted** (installable by link, not searchable) until
you decide otherwise.

---

## 0. Before you upload

1. Operator named in `dashboard/privacy.html` and `dashboard/terms.html` (done:
   Marek Szczęsny, Frankfurt am Main, Germany; update for a holding company).
2. Merge to `main` through a reviewed PR. The PWA deploy then publishes the two
   documents at the URLs in section 2; the listing needs the privacy URL to be live.
   If the `CWS_*` secrets are set, the same merge also uploads the extension
   (`.github/workflows/publish-extension.yml`); otherwise upload by hand (step 1).
3. Build the package from `main`:

```bash
bash tools/pack-extension.sh
```

The zip lands in `dist/stocktrails-0.4.0.zip` (runtime files only; key stripped).

---

## 1. Store listing tab

**Name:** Stocktrails

**Summary (132 chars max; it is the manifest "description"):**
> Track the stocks you research, log your outlook and see how your research and your trades pay off, with a coach for your biases.

**Category:** Productivity (or Tools)   **Language:** English

**Detailed description (paste):**
```
Stocktrails records which stocks you look at on finance websites and shows you
how they performed afterwards, so you can see whether your research and your
decisions line up.

Track your research
- On supported finance sites (Yahoo Finance, Google Finance, TradingView,
  Seeking Alpha, Nasdaq, Bloomberg, CNBC, MarketWatch, WSJ, Finviz, Stocktwits,
  StockAnalysis, MarketBeat, Perplexity, Holdings Channel) a small in-page widget
  lets you tag your outlook, mark a position, set a target price and note why.
  The ticker, time and price are captured automatically.
- Optional: import a browsing-history file (Google Takeout or a history CSV) so
  research done before you installed Stocktrails, or in another browser, counts
  too. Only visits to finance sites are kept; everything else in the file is
  discarded in your browser.

See how it played out
- Your watchlist, a portfolio index of what you looked at against the NASDAQ,
  prediction scorecards, attention calendars and community trends.

Trades & research (new)
- Import your broker's transaction export (Trade Republic, Scalable Capital,
  Interactive Brokers, DEGIRO, Trading 212, Revolut, Schwab and others). The file
  is read in your browser and the trades never leave your device.
- "What your trades say about you": research before buying, chasing rises,
  buying what the crowd is looking at, time-of-day effects and more, each with
  how solid the evidence is.
- A coach that proposes rules tested on trades it had not seen, and two paper
  portfolios that show how following those rules would have done.
- Optional "Assistant" that puts your own results into words.
  It sends no amounts, prices, ISINs or account details, and lists everything it
  sent so you can check.

Your data
- Sign in with Google to sync across your devices. Never sold, never used for
  ads, no tracking outside finance sites. Export or delete it at any time.
- Stocktrails describes your habits. It is not investment advice and it does
  not place orders.

Early access. Feedback welcome through the Feedback button.
```

**Single purpose (paste):**
```
Help users review their own stock research: record the stocks they
intentionally view on finance websites, and compare that research and their
own imported trades with how the stocks performed afterwards.
```

**Graphic assets (all in `store/`):**

| Slot | File |
|---|---|
| Store icon 128x128 | `icons/icon128.png` |
| Screenshot 1 | `store/screenshots/01-label-while-you-browse.png` (unchanged) |
| Screenshot 2 | `store/screenshots/02-what-your-trades-say.png` (new) |
| Screenshot 3 | `store/screenshots/03-coach-what-to-change.png` (new) |
| Screenshot 4 | `store/screenshots/04-agents-paper-portfolios.png` (new) |
| Screenshot 5 | `store/screenshots/05-ask-your-data.png` (new) |
| Small promo tile 440x280 | `store/promo/tiles/small-promo-tile-440x280.png` (unchanged) |
| Marquee 1400x560 | `store/promo/tiles/marquee-promo-tile-1400x560.png` (re-rendered) |

Screenshots 2 to 5 come from the offline sandbox (`node tools/sandbox.js`), a
synthetic investor: no real person, trade or account appears. Delete the four old
screenshots from the listing before uploading the new ones (the store allows 5).
The promo videos in `store/promo/` predate Trades & research; the YouTube link
is optional and can stay or be removed.

---

## 2. Privacy practices tab

**Privacy policy URL:**
`https://marsierz-ui.github.io/attention-tracker/dashboard/privacy.html`
(the old link to `docs/PRIVACY.md` on GitHub was a 404 for everyone else,
because the repository is private).

**Permission justifications** (one per permission):

| Permission | Justification |
|---|---|
| `storage` | Keep the user's attention records, labels and settings in the browser so the app works offline and between syncs. |
| `unlimitedStorage` | Attention history and the per-device price archive grow over time and exceed the default quota; unlimited storage prevents data loss. |
| `tabs` | Read the active tab's URL to identify which stock page the user is on, and open the dashboard. |
| `scripting` | Inject the in-page labeling widget on finance pages, including a custom finance portal the user adds. |
| `alarms` | Schedule the periodic background sync of the user's own data, the daily price update, and the timer that starts the AI agent's verdict a minute after a viewing session. |
| `offscreen` | Opens a hidden extension page (reasons `LOCAL_STORAGE`, `DOM_PARSER`) a minute after the user stops viewing a stock, so the optional AI agent can work out its verdict with the same on-device data as the dashboard. The run does nothing unless the user turned the assistant on and is signed in; the page is the extension's own, loads no remote code and is closed when done. |
| `identity` | Google sign-in through `chrome.identity`, required for the account and cross-device sync. |
| Host permissions (finance sites, Yahoo Finance, Supabase) | Detect the ticker on supported finance pages, fetch prices from Yahoo Finance, and sync the user's data to the Stocktrails backend. Holdings Channel is new in this version. |
| Optional `*://*/*` | Requested at runtime only when the user adds a custom finance portal on another site; not used otherwise. |

**Remote code:** No. All scripts are in the package.

**Data types collected** (tick these):

| Type | What | Leaves the device? |
|---|---|---|
| Personally identifiable information | Google account name and e-mail | Yes, to our backend |
| Authentication information | Google sign-in session | Yes, Supabase Auth |
| Financial and payment information | Broker transactions the user imports | No, stays in the browser (must still be declared) |
| Location | Country from the IP address (stored); an approximate ~10 km location used on the device only for VPN detection | Yes, country stored |
| Web history | Finance-page addresses viewed; finance visits from an imported history file | Yes, to our backend |
| User activity | Time on page, scroll depth, focus switches, dashboard sections used | Yes, to our backend |
| Website content | Ticker and price read from the page; the user's own notes | Yes, to our backend |

Not collected: health, personal communications.

**Certifications (tick all three):**
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

The approved use cases cover the providers that run the features: Supabase
(storage, sign-in), Google (sign-in), OpenRouter (model provider for the assistant), Yahoo Finance
(prices), ipapi.co (country), Resend (opt-in e-mail alerts). The AI assistant
sends derived, de-identified results to the model provider only for that
feature, with the user's acceptance at sign-in, and can be turned off.

---

## 3. Upload steps

1. Developer Dashboard -> Stocktrails -> **Package** -> **Upload new package** ->
   `dist/stocktrails-0.4.0.zip`.
2. **Store listing**: paste section 1, replace the screenshots and the marquee.
3. **Privacy practices**: paste section 2, set the new privacy-policy URL.
4. **Submit for review.** A new data type (financial information) and the new
   host usually mean a manual review of a few days.

---

## 4. OAuth wiring (first submission only)

Sign-in uses `chrome.identity.getRedirectURL()` = `https://<EXTENSION_ID>.chromiumapp.org/`.

1. Supabase -> Authentication -> URL Configuration -> Redirect URLs: add
   `https://<ITEM_ID>.chromiumapp.org/`.
2. Google OAuth consent screen: if it is in "Testing", only listed test users
   can sign in. Publish it (basic `email`/`profile` scopes need no Google review).

---

## Notes
- All users' data lands in one Supabase project (EU, Paris), isolated per account by
  row-level security.
- The AI assistant answers only accounts in `AI_ALLOWED_USERS` (docs/AI.md). Before
  opening it to ordinary users, check the model plan; on OpenRouter every
  request is sent with data collection denied.
- When a change adds a new use of personal data, update `dashboard/privacy.html`
  and raise `TERMS_VERSION` in `src/aiclient.js`, so every user accepts again.
