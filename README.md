# Stocktrails

**A behavioural-finance agent for retail investors.** Stocktrails records which stocks an investor
researches, compares that with what they then buy and sell, and uses the comparison to decide, on the
same statistics, in two ways at once: a **deterministic rules agent** and a **stochastic AI agent** each
make their own decisions in parallel, and both are measured against what the investor actually did.
Underneath, statistical tests **recognise** the investor's own biases and **recommend a concrete rule**
for each, after checking whether the rule **would have improved results on trades it had not seen**. An
assistant explains the findings in plain language; it can only read results computed on the investor's
device and can only propose actions that happen on the investor's click.

It runs as a browser extension, an installable web app and an Android app, on one account.

Submission to FinTechathon 2026, International Track. Theme: "AI as a Financial Participant".
Topic A, Personal Finance Assistant (insights and actionable recommendations from the user's own
transactions), with parts of Topic B (explainable, compliant suggestions; risk profiling from behaviour).

> Stocktrails describes an investor's habits. It is not investment advice, places no orders and holds
> no credentials. The agents' portfolios are paper portfolios.

## The submission

| Element | Provided as |
|---|---|
| Technical documentation: system architecture, core algorithms, security design | [docs/hackathon/Stocktrails-Technical-Documentation.pdf](docs/hackathon/Stocktrails-Technical-Documentation.pdf) (source: [TECHNICAL.md](docs/hackathon/TECHNICAL.md)) |
| Presentation deck (10 minutes) | [docs/hackathon/Stocktrails-Final-Pitch.pptx](docs/hackathon/Stocktrails-Final-Pitch.pptx) |
| Demo video (under 5 minutes) | [docs/hackathon/demo/stocktrails-demo-narrated-720p.mp4](docs/hackathon/demo/stocktrails-demo-narrated-720p.mp4) |
| Source code, README, deployment instructions, test cases | this repository: this README, [DEPLOYMENT.md](DEPLOYMENT.md) (how to run and deploy it for testing), [TESTING.md](TESTING.md) (test cases; `node tools/run-tests.js`) |
| Security self-assessment: permission tiers and known-risk list | [docs/hackathon/SECURITY.md](docs/hackathon/SECURITY.md) |
| Execution evidence: sandbox operation logs and demo video | [docs/hackathon/evidence/demo-run.md](docs/hackathon/evidence/demo-run.md) and `demo-run.json` (a full run of a synthetic investor), the simulated investor accounts in [docs/hackathon/evidence/personas](docs/hackathon/evidence/personas) (broker CSV and operation log each), and the demo video above |

## What Stocktrails does

1. **Recognises biases** with tests, not opinions: chasing price rises, impulse buying, buying at a bad
   time of day, oversized buys in turbulent markets, not acting on one's own calls, ignoring one's
   targets, buying without research, and more (selling winners early, the ostrich effect, herding,
   overconfidence, lottery stocks, anchoring, home bias). Deterministic code, no model.
2. **Recommends a rule** for each and judges it **out of sample**: fitted on the past, scored on later
   trades it had not seen, with an embargo for trades whose outcome was still unknown. Example from the
   execution evidence (synthetic investor, seed 21): "Wait after a run-up" is supported out of sample at
   +16.3 points per flagged decision (99% range +10.8 to +21.5), against +14.2 in sample. In 24 worlds
   with no effect planted, 0 of 216 rules were called supported.
3. **Lets the investor adopt a rule** with one click, then **tracks adherence** (how often it was
   broken before and after adoption, and how decisions that kept it did against those that broke it,
   reported as an association, not proof) and **checks an intended buy** against the adopted rules and
   the investor's own reminders before it is placed.
4. **Decides in parallel, twice, on the same statistics.** Two agents run a paper portfolio on the
   investor's own buys and on the stocks the investor looked at:
   - the **rules agent** is **deterministic**. It contains no model: the same input always gives the same
     decision. Each month it keeps the rules that held up out of sample and, for each candidate, buys,
     waits until no active rule objects, or passes;
   - the **AI agent** is **stochastic**. It is a language model that is given what was known on that day
     (aliases instead of names, day offsets, ratios, market and research readings, the rules that held up
     with their verdicts, and what the rules agent said at that moment) and answers buy, wait or pass with
     a size and a reason (for a repeat view: hold, sell or buy more). The same input can give a different
     answer, so each decision is saved once with its time and reasoning, and it is only asked about moments
     at most two days old, so it cannot know what happened next.

   Both are compared with the investor's own results: values as shares of the money put in, paired
   differences per buy with 99% ranges, and before and after the investor first used the app. No order is
   ever placed.
5. **Explains** through an assistant that answers questions about the investor's data in up to five
   steps. It can name only read-only tools from a fixed catalogue, they run on the device, and every
   number in its answer is checked against the results. It proposes actions (adopt, retire or retune a
   rule, a reminder for a stock, a review note) as cards that happen only on a click.
6. **Reviews the week**: research against the week before, spikes of interest, held stocks not looked
   at, calls, trades, rules broken, all computed on the device.
7. **Reads the notes written with calls**: classified once each, redacted, and joined to how the calls
   turned out.

## How it works

```
 Chrome extension / installable web app / Android app   (same dashboard code, one account)
   capture of research (stock, time, active time, page type, the user's calls and notes)
   broker import (CSV/XML, read in the browser, stored only on the device)
   ------------------------------------------------------------------------------------
   src/decisions.js   fills -> decisions with outcomes, research-versus-trading questions   (pure)
   src/biases.js      biases, rules, out-of-sample validation, adherence, pre-trade check    (pure)
   src/indicators.js  further bias indicators with sample-size status                         (pure)
   src/shadow.js      the rules agent (deterministic) and the paper portfolios, point in time (pure)
   src/aitools.js     read-only tools for the assistant and the privacy filter                (pure)
   src/aiclient.js    consent, request log, the agent loop (up to 5 steps), action cards, AI agent calls
   dashboard/*.js     the UI
        |   opt-in: aggregates, aliases ("Stock 3"), ratios and months leave the device;
        |   the AI agent's decisions carry per-decision records with day offsets
        v
 Supabase Edge Function ai-coach   verify JWT, allowlist, daily cap, prompts, tool catalogue, privacy check
        v
 Model provider (OpenRouter with data collection denied; Cerebras as an alternative)
```

Core algorithms, in short (details in the technical documentation):

- **Outcome of a decision:** excess return against the NASDAQ Composite from the close of the trade
  day, over 21 trading days (63 days for calls). Market context for each buy (volatility, 20-day return,
  distance from the 52-week high) uses only bars before the trade day.
- **The shift test:** markets stay calm or turbulent for weeks and buying comes in bursts, so an
  ordinary bootstrap gives ranges that are too narrow. The whole pattern of buys is slid along the
  calendar by every possible shift and each statistic is recomputed; that gives the 99% range and the p
  value.
- **Walk-forward validation:** the first half of the history is only ever training; the rest is cut into
  up to six blocks; each block is judged by a rule fitted on decisions whose outcome was known when the
  block began. Verdicts: supported (99% above zero), indicative (95%), unclear, unsupported, untested
  (fewer than 24 decisions with an outcome or 8 flagged out of sample).

## Security and privacy by construction

- **Permission tiers.** T0: read-only tools that run on the device, and paper decisions that only move a
  paper portfolio. T1: a local write (adopt, retire or retune a rule, set a reminder, save a note), only
  on the user's click. Neither agent nor the assistant can place orders, hold credentials or change
  server data. Full table and the known-risk list: the security self-assessment.
- **Consent and deny by default.** The AI is off until the user consents; the service requires a
  signed-in user and can be restricted to an allowlist with a daily cap.
- **Data minimisation, in code.** Tool results are built from allowlists (no key for amounts, quantities,
  prices, ISINs, tickers or names exists in them). The browser and the server each test every payload
  and the server refuses raw trade data (HTTP 422). Broker trades never leave the device.
- **Auditability.** "What was sent" lists every request, tool run and answer with the exact bodies,
  downloadable.
- **Platform.** Row-level security on every table, security-definer functions with a pinned search path,
  Manifest V3 with no remote code and a content security policy that allows own scripts only.

## Product reference

### Capture and dashboard

- **Automatic capture** (after sign-in). Opening a stock page on a supported portal logs an attention
  event (ticker, time, source, page section, price at that moment, active time on page). On pages
  without a known URL pattern it falls back to content-based detection (cashtags, exchange-qualified
  symbols, tracked tickers and company names).
- **In-page label card.** Label the outlook (Positive / Neutral / Negative) and optionally record a
  position, a target price, a horizon and a rationale. The toolbar popup can label too.
- **Performance since first attention**, return per attention unit, and a NASDAQ Composite (`^IXIC`)
  benchmark rebased to the same start. Charts: Single, Compare (rebased to 100) and Index (a daily,
  no-leverage portfolio built from attention, with no look-ahead).
- **Two attention databases.** *Daily* collapses repeat views within 60 minutes into one event;
  *Intraday* records every view with its intraday price.

Dashboard sections: **My Habits** (how you research; the **Trades & research** tab imports broker files
and links them to attention, with the bias coach, the assistant and the paper portfolios), **My Stocks /
Performance**, **Predictions** (every Positive/Negative call followed to its deadline: scorecard,
accuracy by horizon, Brier score, edge versus NASDAQ), **Community** and **World** (anonymous aggregates
with minimum group sizes), and **Admin** (admin accounts only).

### Supported portals

Yahoo Finance, Google Finance, MarketWatch, CNBC, Bloomberg, StockAnalysis, MarketBeat, Finviz,
TradingView, Seeking Alpha, Nasdaq, Stocktwits, WSJ, Perplexity and Holdings Channel. International
listings are mapped to the right Yahoo symbol suffix (about 30 exchanges). Further portals can be added
under **Portals** with a URL pattern containing `{ticker}`; the browser asks for permission for that host.

### Broker trades import

CSV or XML exports from Trade Republic, Scalable Capital, Interactive Brokers, DEGIRO, Trading 212,
Revolut, Charles Schwab, Freetrade, XTB, Saxo and others. Instruments are matched by ISIN plus name
similarity. The ledger is stored only on the device (IndexedDB), is never sent to the cloud and is not
part of the JSON backup.

### Accounts, sync and data

Signing in (Google, or e-mail and password; through Supabase: Postgres, Auth, row-level security) starts capture; events,
intraday views and settings are stored locally and synced, last write wins, so the extension, the web
app and the Android app share one account. **Export JSON** makes an offline backup. Prices come from
Yahoo Finance's public chart endpoint (no API key), archived hourly on the device because Yahoo serves
hourly bars for about 730 days only. Returns use raw (unadjusted) closes.

### Repository layout

```
manifest.json          extension manifest (MV3)
manifest.webmanifest   PWA manifest;  sw.js: PWA service worker
src/                   capture, storage, sync, prices and the analytics (decisions, biases,
                       indicators, aitools, aiclient, rationale, shadow, agentsession)
popup/                 toolbar popup
dashboard/             main UI
pwa/                   share-target pages for the web app
mobile/                React Native + Expo app
supabase/              schema, migrations, Edge Functions (ai-coach, yahoo, geo, trending, ...)
server/                optional self-hosted token sync server
docs/                  design, privacy and security notes
tools/                 tests, test runner, sandbox, execution-evidence scripts, packaging scripts
.github/workflows/     PWA deploy, Web Store publish, scheduled jobs
```

## Limits

- The statistics were validated on synthetic investors with planted effects and on worlds with no
  effect. They have not been validated on a population of real investors.
- The AI agent is stochastic: two runs on the same input can differ. That is why its decisions are saved
  once with their time and reasoning rather than re-run, and why it is judged against the deterministic
  rules agent and the investor over many decisions, not on any single one.
- A rule needs about 24 decisions with a known outcome before it is tested, and 8 flagged out of sample
  before it can be called supported. "Not enough data" is a result the app shows.
- Prices come from Yahoo's unofficial endpoint, which may rate-limit; failed fetches show as `-`.
- The sandbox, the simulated investor accounts and the demo use synthetic data only: no real person,
  account or trade appears anywhere in the evidence.

Further reading in this repository: [ARCHITECTURE.md](ARCHITECTURE.md) (full design),
[docs/AI.md](docs/AI.md) (AI layer: data flow, providers, risks), [docs/PRIVACY.md](docs/PRIVACY.md).
