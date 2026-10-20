# Bias indicators: implementation draft

Status: phases 1-3 implemented (sections 8-10). Phase 3 needs its migrations applied and the `earnings` function deployed. Source: "Verhaltensverzerrungen von Privatanlegern -
Literaturliste mit Messkonzept" (October 2026). Builds on the Trades & research
feature on `feature/trades-research` (`src/decisions.js` Q1-Q13,
`src/biases.js` bias coach, `tools/synth-world.js`, `tools/test-trades.js`).

Out of scope for now:
- Device effects (smartphone vs desktop), including trade-device tagging.
- **Later:** a Likert self-assessment (5-point scale, once and again after 3
  months). Example items: "On my phone I decide more spontaneously", "I check
  the balance sheet before a mobile buy", "Price alerts trigger my buys", "I
  trade on my phone to distract myself", "I regret mobile trades more often".
  Its value is comparing self-image with measured behaviour, so it needs the
  indicators below first.

## 1. Grouping: from a flat Q list to five stages

Today the pane renders Q1-Q13 as one grid. With 13 new indicators that becomes
26 cards. Group them by **where in the decision the bias acts**. That is the
order a user thinks in, and every group answers one plain question.

| Group | Question to the user | Existing | New |
|---|---|---|---|
| A. Research & attention | What do you look at, and what do you avoid? | Q1 research before trades, Q3 does research pay, Q6 page types, Q7 impulse / time of day | Ostrich effect, Confirmation bias, Herding, Limited attention (phase 3) |
| B. Buying | What and when do you buy? | Q4 attention spikes / FOMO, Q10 market mood | Extrapolation, Lottery preference, Timing against a savings plan (B7) |
| C. Your calls | How good and how fixed are your judgements? | Accuracy (link to Predictions), Q2 call vs action, Q5 passed-on calls | Anchoring |
| D. Selling & holding | When do you let go? | Q11 sell at target, Q12 disposition, Q13 horizon | Rank effect, Myopic loss aversion, Repurchase regret |
| E. Portfolio & activity | How much do you trade, and how is the whole depot built? | Q8 size vs conviction, Q9 holdings vs attention index | Overconfidence, Under-diversification, Home bias |

Rules:
- **One card per bias, in its main group.** A bias with signals in several stages
  keeps its sub-parts in that one card. For example, Anchoring covers targets,
  break-even sells and the 52-week high. No bias is repeated across groups.
- **Collapsible group sections.** Each header shows a count such as "2 findings,
  1 solid". Groups with no indicative or solid result start collapsed, so a new
  user sees a short page.
- **Stable ids.** Internally the keys stay `q1`...`q13`. New indicators get named
  keys (`overconfidence`, `ostrich`, ...), not `q14`+. The UI shows group ids
  (A1, A2, B1, ...), so renumbering a group never breaks stored state.
- **Two entry points.** "What your trades say about you" stays at the top. It
  aggregates by bias across groups (`biases.js detect`) and links each item to
  its card. The groups are for browsing.
- **Optional family filter.** A chip row tags each card with its literature
  family: Attention (ostrich, limited attention, herding, attention buying),
  Beliefs (overconfidence, confirmation, anchoring, extrapolation), Preferences
  (disposition, lottery, myopic loss aversion, regret) or Portfolio (home bias,
  under-diversification, rank).

## 2. Data inventory

Most indicators need **no new capture and no schema change**. That matters:
a change to `events`/`intraday` must land in the extension, the PWA and
`mobile/`, and must stay compatible with older stores.

### Already available
| Data | Where |
|---|---|
| Views, dwell, `researchType`, `section`, scroll depth, focus switches | `intraday` / `events` (scroll/focus on the trades branch, synced as `scroll_depth` / `focus_switches`) |
| Calls: sentiment, target price, horizon, position taken, rationale | `events` |
| Price at view | `events.priceAtEvent` |
| Trades: qty, price, amount, fee, tax, currency, ISIN, savings-plan flag | `ATLedgerDB` (device-only) |
| Positions over time, cost basis, decisions open/add/trim/close | `decisions.js` (`buildDecisions`, `posAt`, `disposition`) |
| Daily closes, NASDAQ, market regime (20d return, volatility, distance from high) | `ATPrices.fetchDaily`, `marketSeries` |
| Sector / industry / market cap | `ATPrices.fetchProfile` (7-day cache) |
| User country | `user_meta.country`, `user_country` intervals |
| Community views per ticker and day, crowd similarity | `network_community_daily`, `world_crowd_overlap` |
| Third-party trending lists per day | `trending_snapshots` / `trending_daily` |

### New, client-only (no schema change)
| ID | Data | How | Used by |
|---|---|---|---|
| N1 | **Price lookback**: 13 months of daily closes before the first view | Start `fetchDaily` at `firstView - 400d` instead of the first view. Same number of requests, larger payload. | 52-week high, past 1/3/12-month return, MAX, idiosyncratic volatility, skewness |
| N2 | **Daily volume** | `parseChart` keeps `indicators.quote[0].volume` (already in the response) | Abnormal-volume attention proxy (extends Q4), lottery screen |
| N3 | **Profile for held instruments** | Run `fetchProfile` on the matched Yahoo symbol of each ledger instrument. Unmatched instruments become sector "unknown". | Sector concentration, home bias |
| N4 | **Instrument country** | Trades: ISIN prefix. Views without an ISIN: map the listing exchange (Yahoo `exchange` / symbol suffix) to a country in a static table `vendor/exchange-country.js`. ADRs are flagged as a proxy. *(As built: no vendor file; the suffix table is `countryOfSymbol` in `src/indicators.js`, section 9.)* | Home bias |
| N5 | **MSCI ACWI country weights** | Static table `vendor/acwi-weights.js`, updated by hand each quarter from the public factsheet, with its as-of date shown *(As built: `ATIndicators.ACWI` and `ACWI_ASOF` in `src/indicators.js`, section 9.)* | Home bias benchmark |
| N6 | **Sessions** | Derived from `intraday` timestamps: a gap over 30 min starts a new session | Lottery (short, frequent sessions), limited attention (tickers per session) |
| N7 | **Shock days** | Derived from N1: a daily return beyond ±2 standard deviations of the stock's last 60 days, or beyond ±5% | Confirmation revision rate, ostrich gaps |

### New, server-side (new migration, non-user data)
| ID | Data | How | Used by |
|---|---|---|---|
| S1 | **Earnings dates** | Table `earnings_dates (ticker, date, timing bmo/amc/unknown, source)`, readable by signed-in users and written only by an edge function `earnings`, using the same pattern as `trending`. History: SEC EDGAR 8-K Item 2.02 filing dates (US issuers, free, needs a User-Agent header so it must run server-side). Forward: the Nasdaq earnings calendar. Non-US issuers have no source yet, so their latency is "not measured" rather than wrong. Yahoo `quoteSummary.calendarEvents` needs a crumb (401), and whether the chart endpoint's `events=earn` works is still to be tested. | Limited attention |
| S2 | **Community herding** | RPC `community_herding_daily(p_days)` computes the Lakonishok-Shleifer-Vishny measure on **first views** per ticker-day, gated like the `world_*` RPCs with a k-anonymity floor (at least 10 users per ticker-day) *(As built: `community_first_looks_daily(days)`, floors of 3+ users per ticker and 5+ active users per day; section 10.)* | Herding (community level) |

Broker trades never leave the device (AGENTS.md), so herding **on trades** is
measured only in the simulation (section 5). None of S1, S2 or N1-N7 touches
`events`/`intraday`, so the three-client sync contract is unchanged. Mobile picks
up S1/S2 only if it later shows these analyses.

## 3. Indicators

Each indicator follows the conventions of `decisions.js`:
- A pure function over the `analyze` input.
- Outcomes are excess returns vs NASDAQ via `forward()`, using only bars before
  the decision as features.
- Savings plans and non-equity instruments are excluded (`markAutomatic`,
  `ELIGIBLE`).
- Each result carries `n`, a `status` (none / indicative / solid against its
  `NEED`) and `clear` (the 95% range excludes no effect). Where several tests are
  read together, use 99% ranges, as Q6 and Q10 do.
- Every indicator gets a planted effect and a null world in
  `tools/synth-world.js`, plus a test in `tools/test-trades.js` that checks it
  finds the effect and stays quiet without it.

`NEED` values below are starting points, to be tuned on the synthetic worlds.

### A. Research & attention

**A5 Ostrich effect** (`ostrich`). Karlsson et al. 2009, Sicherman et al. 2016.
Needs held positions (ledger, or the `positionTaken` label when there are no
trades). Data: existing only.
- (a) Look-ups vs results. For each held position-day: viewed (0/1). Compare
  P(view | position return the day before > +1%) with P(view | < -1%). Do the
  same at portfolio level against the NASDAQ's prior-day return. Moving a single
  view is wrong because views cluster, so use a block bootstrap by week.
  `NEED { min: 60 position-days on each side, solid: 250 }`.
- (b) Reading depth: mean dwell and scroll depth on positions under water vs in
  profit (cost from `posAt`).
- (c) Gaps: days from a drawdown of 10% or more on cost to the next view, vs days
  from a +10% gain to the next view. Kaplan-Meier medians, and a censored
  "never" count.
- Coach: advice only ("review every position on a fixed weekly slot"). There is
  no trade rule to test walk-forward.

**A6 Confirmation bias** (`confirmation`). Nickerson 1998, Park et al. 2013.
Needs calls. Data: existing plus N7.
- (a) Revision after contrary news. For Positive calls hit by a negative shock
  day (N7), and Negative calls hit by a positive one: the share relabelled within
  10 trading days (a new label of the other sign or Neutral). Compare that with
  the revision rate after a shock in the call's direction. Asymmetry means
  contrary news is discounted. Wilson ranges, `NEED { min: 10 shocks, solid: 30 }`.
- (b) Research mix after a call: the share of dwell in `financials` /
  `ownership` / `short` / `insider` / `estimates` (checking) vs `news` / `charts`
  / `community` (confirming), in the 30 days after a call vs the 30 days before.
- (c) Breadth: Shannon entropy of `researchType` per stock and month. Months
  with a standing call vs months without.
- Coach: no trade rule. Advice: "after a big drop on a stock you like, open the
  financials before the news". The pre-trade check can show "contrary shock since
  your call, not reviewed".

**A7 Limited attention** (`underreaction`). DellaVigna & Pollet 2009,
Hirshleifer et al. 2009. Data: S1 and N6.
- (a) Latency: for tracked stocks (viewed in the prior 90 days) and held stocks,
  the time from an earnings release to the first view of `financials` /
  `earnings` / `news`. Releases after the close count from the next open. This is
  a Kaplan-Meier median; "missed" means no view within 10 trading days.
- (b) Distraction: latency on Fridays vs other days, and on busy days (3 or more
  earnings among your tracked stocks) vs quiet ones.
- (c) Tickers per session (N6) on earnings days vs normal days.
- `NEED { min: 8 releases, solid: 30 }`. Only stocks with an S1 date count, and
  the card says how many were excluded.

**A8 Herding** (`herding`). Kumar & Lee 2006, Barber et al. 2009. Data: existing
plus S2.
- (a) Follow vs lead: the share of your first views of a stock that come after
  its community first-views (`network_community_daily`) or a third-party
  trending list (`trending_daily`) spiked in the 3 days before, against the same
  share for randomly drawn days (calendar shift test, as in Q10).
- (b) Your crowd similarity (`world_crowd_overlap`, already computed) shown as
  a trend.
- (c) Community LSV (S2), on the Community tab rather than per user.
- Trades: simulation only.

### B. Buying

**B3 Extrapolation** (`extrapolation`). De Bondt 1993, Benartzi 2001,
Greenwood & Shleifer 2014. Data: N1.
- (a) Calls: point-biserial correlation of call sign with the stock's 1-, 3- and
  12-month past return at the call. Spearman of the implied return (target /
  price - 1) with past return. Three windows read together, so 99% ranges.
- (b) Buys: the past 3- and 12-month return percentile of each bought stock among
  the stocks you viewed in the 30 days before the buy. A mean above 0.5 is
  momentum exposure. Q4's run-up starts at your first look; this one starts at a
  fixed lookback, so the two are not the same.
- (c) Research before buys: chart share vs financials share. This reads Q6's
  per-buy mix; no new computation.
- Coach rule: `avoid_extrapolation`. Do not buy a stock in the top X% of your
  own universe by 12-month return. Grid {70, 80, 90}%; gain = -y. Fit
  walk-forward like the existing rules.

**B4 Lottery preference** (`lottery`). Kumar 2009, Bali et al. 2011. Data: N1, N2,
N6 and FX (exists).
- Lottery flag per stock and day, from bars before the day:
  `MAX` (highest daily return over the previous 21 bars) > 10%, **or** all three
  Kumar criteria: price < 5 USD-equivalent, idiosyncratic volatility (residual vs
  NASDAQ, 126 bars) > 60% a year, and idiosyncratic skewness > 0.5. These
  thresholds are configurable because the app has no market universe for terciles.
- (a) Share of views and of buys in lottery stocks. (b) 63-day excess return of
  lottery buys vs other buys (bootstrap). (c) Positive calls with a target over
  +100% and a horizon of 3 months or less. (d) Session pattern: sessions per week
  and median session length, shown descriptively and not tested.
- Coach rule: `cap_lottery`. Lottery buys at most Y x your usual buy, with
  Y in {0.25, 0.5, 1}, using `trailingSizes`.

**Q4 extension (attention buying).** Add abnormal volume (N2: the day's volume
over the 60-day median, above 2) as a second spike definition next to
|return| > 5%. Add the 48-hour conversion rate (first view to buy) for spike
stocks vs quiet stocks.

### C. Your calls

**C3 Anchoring** (`anchoring`). Tversky & Kahneman 1974, George & Hwang 2004,
Li & Yu 2012. Data: N1.
- (a) Targets: the distribution of target / price at the call. Measure the share
  of targets on a round number (a multiple of 10^floor(log10 P), or of 5 for
  prices under 100) against the share expected for that price level; the share
  within ±1% of the 52-week high; the share within ±1% of your entry price; and
  peaks at exactly +10% / +20%.
- (b) Break-even sells: the share of full sells within ±2% of average cost,
  against the share of the position's holding days on which the close was in
  that band. That is the null "a sell on a random holding day".
- (c) 52-week high: the share of buys made within 5% of the stock's 52-week high,
  vs the share of your view-days on which the stock was there. Fewer buys than
  views means reluctance to buy near the high.
- (d) Target drift (shared with the disposition card): on positions under water,
  the share of target revisions that move the target **down** toward the price,
  vs on winners.
- Coach: no walk-forward rule for (a). Advice in the label widget: "your target
  sits on a round number; derive it from a valuation". (b) feeds the existing
  disposition advice.

### D. Selling & holding

**D4 Rank effect** (`rank`). Hartzmark 2015. Data: existing.
- On each sell day with at least 3 positions: rank positions by unrealized return.
  P(sold | best), P(sold | worst) and P(sold | middle), with Wilson ranges.
  Optionally a logit of sold on best/worst dummies, controlling for gain sign and
  |return|. `NEED { min: 10 sell days, solid: 30 }`.
- Research side: on each day, the share of views of own positions going to the
  best and worst ranked vs the middle.
- Coach: advice ("before selling your best or worst position, check the middle
  ones you never look at").

**D5 Myopic loss aversion** (`myopia`). Benartzi & Thaler 1995, Gneezy &
Potters 1997. Data: existing.
- (a) Monitoring intensity: views per held week for positions with a stated
  horizon of 1 year or more, vs 3 months or less. More checking on long horizons
  is the signal.
- (b) Reaction: for positions with a horizon of 1 year or more, P(sell within 5
  trading days | 5-day loss of 5% or more) vs P(sell | no such loss).
- (c) Q13 already compares the horizon with the actual holding period. Its
  "early" bucket is shown in this card as a reference, not recomputed.
- Coach rule: `hold_through_dips`. No sell of a 1-year-plus horizon position
  within N days of a 5% drop, with N in {5, 10, 20}; gain = the return the
  position made over the next 63 days after the sell.

**D6 Repurchase regret** (`repurchase`). Strahilevitz et al. 2011. Data:
existing.
- For each full close of a position: rebought within 12 months? Split by
  (a) sold at a gain or a loss, and (b) price on each day after the sale above
  or below the sell price. The rate is per stock-month at risk, so a time-varying
  state is counted correctly.
- Watching sold stocks: views of the stock after the sale with no rebuy, by
  price move since the sale.
- Coach: advice only.

**Disposition extension (Q12).** Add a holding-period survival of winners vs
losers (Kaplan-Meier, time to sale) and target drift from C3(d).

### E. Portfolio & activity

**E3 Overconfidence** (`overconfidence`). Odean 1999, Barber & Odean 2000/2001.
Data: existing.
- (a) Turnover: monthly value sold over the depot value at the start of the
  month, averaged and times 12 (Barber & Odean's definition). Savings plans
  excluded. Reference line at 75% a year. Costs: fees over the average depot
  value, a year.
- (b) Odean test: pair each sell with a buy within 3 weeks (a switch). Measure
  the forward excess return of bought minus sold over 21, 84 and 252 trading
  days, with a bootstrap over pairs. Below zero means the switches cost money.
  `NEED { min: 10 pairs, solid: 30 }`.
- (c) Calibration of calls with a target and horizon: the ratio of required move
  (target / price - 1) to the best move actually reached before the deadline.
  A median above 1 means targets are systematically too far. Also the share of
  calls never revised before the deadline.
- (d) Research per trade: Spearman, across months, of trades per month vs
  research minutes per trade.
- Coach rule: `no_quick_switch`. No buy within N days of a sell, with N in
  {3, 7, 14}; gain = -(bought - sold) over 63 days.

**E4 Under-diversification** (`diversification`). Benartzi & Thaler 2001,
Goetzmann & Kumar 2008. Data: N3.
- (a) Over time: number of positions; HHI by value; sector and country HHI;
  mean pairwise correlation of holdings' daily returns over 60 days. ETFs and
  funds count as one holding but are labelled "diversified fund", and the card
  shows the ETF share so an ETF-only depot does not read as concentrated.
- (b) 1/n: the share of buys within 30 days of another buy whose amount is within
  ±2%, or which are a round amount (a multiple of 500 or 1000). Savings plans are
  excluded, since they are identical by design.
- (c) Research concentration: sector HHI of views.
- Coach: advice, plus a pre-trade check line when a buy would raise sector HHI
  above 0.25 or a single position above 20%.

**E5 Home bias** (`homebias`). French & Poterba 1991, Huberman 2001, Grinblatt
& Keloharju 2001. Data: N3, N4, N5 and user country.
- (a) Home share of views and of depot value vs the home country's ACWI weight.
  Home bias = 1 - (foreign share / ACWI foreign share).
- (b) Familiarity: distinct stocks researched per month, and the share of views
  on the top 5 stocks.
- (c) Employer or brand closeness needs a self-report, so it goes with the later
  self-assessment.
- Coach: advice only.

## 4. Coach (`biases.js`) changes

- `detect` gets one `add(...)` per new bias, with signals drawn from the cards
  above, using the existing `sig(status, clear, text)` shape.
- New walk-forward rules (`RULES`): `avoid_extrapolation`, `cap_lottery`,
  `hold_through_dips` and `no_quick_switch`. Every other new bias carries advice
  only, because it has no trade decision whose outcome a rule could be tested on.
- `preTrade` gains lines for lottery flag, 52-week-high anchoring, sector or
  position concentration, and "contrary shock since your call, not reviewed".

## 5. Simulation

`tools/synth-world.js` already plants effects for tests. Extend it with the
document's six investor types as **mixtures** of planted effects. Each synthetic
user gets type weights, for example 0.6 disposition holder + 0.4 attention
hunter, with parameters drawn around the type means:

- Attention hunter
- Overconfident high-frequency trader
- Disposition holder
- Lottery speculator
- Confirmation seeker
- Disciplined long-term investor (control group)

The calibration table in the source document gives the starting means. They are
rough values, not estimates.

Add market scenarios (rally, crash, sideways), because the ostrich effect,
disposition and herding mostly show under stress. Add measurement noise:
missing labels and gaps in broker imports.

Output is a confusion matrix of detected bias vs planted type, per indicator.
This is also where herding on trades is evaluated, since real trades never
leave the device.

## 6. Rollout

| Phase | Content | New data |
|---|---|---|
| 1 | Grouped UI (section 1); Rank effect, Repurchase regret, Overconfidence (a, b, d), Under-diversification (a without sector, b), Myopic loss aversion, Ostrich, Confirmation (a, c), Herding (a, b), Q12 survival | none |
| 2 | Extrapolation, Lottery, Anchoring, Overconfidence (c), Confirmation (b), Under-diversification sector, Home bias, Q4 volume extension | N1-N7 (client only) |
| 3 | Limited attention, community herding | S1, S2 (migrations + edge function) |
| Later | Device effects, Likert self-assessment | channel field / survey |

Each phase lands on `feature/trades-research` (or a branch off it) with its
synthetic tests. Anything touching `src/`, `dashboard/` or `vendor/` publishes
the extension when merged to `main`, so a phase merges only when it is
release-ready.

## 7. Decisions

1. **Earnings for non-US stocks:** "not measured" for now. A provider with
   global coverage, such as Quartr, can be added later as a second source for S1.
2. **Lottery thresholds: fixed.** A best day above +10% in the last month, or
   all three of price under 5 USD, idiosyncratic volatility above 60% a year
   and idiosyncratic skewness above 0.5 (126 trading days). The same label for
   everyone, explainable in one sentence. Revisit (calibrate on the community's
   viewed universe) once the community has a few hundred active users.
3. **Home country:** the IP-derived `user_meta.country`. For a VPN user (`XV`)
   home bias stays blank, with a link to set the home country in Settings
   (phase 2 adds that setting).
4. **Users without a broker import** see groups A (Research & attention) and C
   (Your calls). Indicators that need no trades are answered; the trade
   questions show as previews, to motivate an import. Ostrich reads holdings
   from "Position taken" labels.

## 8. Phase 1 as built

- `src/indicators.js` (`ATIndicators.analyze(input, R)`, attached as `R.ind`):
  ostrich, confirmation (+ entropy), herding (+ crowd trend), rank, myopia,
  repurchase, overconfidence (turnover, Odean test, research per trade),
  diversification (holdings, 1/n), survival (shown in D2).
- `dashboard/biascards.js`: groups, card labels, the new cards, the calls-only
  view, rows for "How much can your data say?", findings for the top panel.
- `src/biases.js`: `detectIndicators` and the rules `no_quick_switch`,
  `hold_through_dips`.
- `tools/test-indicators.js`: a planted and a null world per indicator.
- Card ids as built: A5 ostrich, A6 confirmation, A7 herding (limited attention
  becomes A8 in phase 3); C1 links to call accuracy in Predictions, so Q2 is C2
  and Q5 is C3. Anchoring becomes C4 in phase 2.
- Changes from the draft found while testing:
  - A user who never relabels is not flagged for confirmation bias. The signal
    needs at least 5 call changes overall.
  - Repeated buy amounts are compared with a shuffle among neighbouring buys,
    because the usual size drifts with wealth.
  - Price history is fetched from 100 days before first use, so the sharp-move
    test has 60 trading days of history behind it.

## 9. Phase 2 as built

- **Data:**
  - Price history starts 400 days before first use (N1).
  - `ATPrices.parseChart` keeps Yahoo's daily volume on each bar (N2).
  - Profiles (sector) are fetched for held instruments and the 60 most-viewed stocks, once per session (N3).
  - Instrument country comes from the ISIN prefix, or the Yahoo symbol suffix for views (N4).
  - Approximate MSCI ACWI weights live in `ATIndicators.ACWI` (N5). They are marked approximate with their as-of date and need a check against the current factsheet.
  - Sessions are views less than 30 minutes apart (N6).
  - No schema or sync change.
- **Home country:** Settings > Data has a picker, stored device-only as `at_home_country`. Unset, the app uses the IP country already resolved for sync (`at_geo_v2`); a VPN exit (`XV`) leaves home bias blank with a link to the picker.
- **Indicators and cards:**
  - B3 extrapolation: calls against past 1/3/12-month returns, at 99%; buys ranked among the stocks viewed alongside them.
  - B4 lottery: fixed thresholds. The price test runs only for USD listings until FX is passed in.
  - B5 volume: buys after abnormal volume, and the 48-hour conversion of first looks. This is a separate card, not an extension of B1.
  - C4 anchoring: round targets against whole-number chance; 52-week high; entry; +10/+20%; break-even sales against holding days; buys near the high; target drift.
  - C5 calibration: required move vs the best move before the deadline. It moved from "Overconfidence (c)" into its own card in group C, so users without trades see it. E3 links to it.
  - E4 adds sector and country concentration and the sector spread of views.
  - E5 home bias.
- **Coach:**
  - The rules `avoid_extrapolation` and `cap_lottery`.
  - The pre-trade check adds four facts: lottery today, 12-month return rank, distance from the 52-week high, and weight in the depot after the buy.
- **Tests:** `tools/test-indicators.js` covers each phase-2 indicator with a planted world and a null world, plus symbol-to-country and VPN handling.

## 10. Phase 3 as built

### Server: S1 earnings dates
- **Migration** `20261012_earnings_dates.sql`:
  - Tables `earnings_dates (ticker, day, timing bmo/amc/during/unknown, source sec/nasdaq)` and `earnings_backfill` (which tickers EDGAR has been read for).
  - `earnings_for(p_tickers, p_from)` for signed-in users: one row per ticker, so a long watchlist stays under PostgREST's 1000-row cap.
  - `earnings_universe(p_limit)`, service role only: community-viewed US tickers not read yet.
  - A pg_cron job at weekdays 12:10 UTC.
- **Edge function** `supabase/functions/earnings`:
  - The Nasdaq calendar for the last 3 and next 7 days.
  - Up to 25 EDGAR submissions files per run: 8-Ks with item 2.02, with timing from the acceptance time.
  - The secret `SEC_USER_AGENT` ("name email", SEC fair-access policy) is required for the EDGAR part. Without it, only the calendar runs.
- **Non-US listings** stay "not measured", and the card counts them. A provider with global coverage (e.g. Quartr) can be added as a second source later.

### Server: S2 community first looks
- **Migration** `20261012_community_first_looks.sql`: `community_first_looks_daily(p_days)` returns, per US Eastern day, the number of active users and each ticker's first looks.
- **Privacy floor:** a ticker needs first looks from 3+ users, and a day 5+ active users. Aggregates only.
- **Measure** (`ATIndicators.communityHerding`), computed on the client: an LSV adaptation.
  - For a stock-day with at least one first look: |share of active users who found it that day − the stock's own average share| − the binomial expectation of that gap given at least one look.
  - Averaged, with a range from resampling days.
  - It is restricted to stock-days with looks, as LSV only scores stock-periods with trading; averaging over all days let the many empty days dilute the signal.
  - Shown as a line in card A7.

### Client: A8 limited attention (`ATIndicators.analyze` → `attention`)
- **Which releases count:** releases of stocks you viewed in the 90 days before, or held.
- **Latency:** clock from the US open of the release day (the next day after an after-close release) to your first view of earnings, financials, estimates or news pages.
  - Kaplan-Meier median.
  - Unread after 14 days counts as missed; a window still open is censored.
- **Comparisons:** Friday vs other days, and busy days (3+ of your stocks reporting) vs quiet ones, with a bootstrap of the difference in missed share.
- **Breadth:** stocks per session on report days vs other days.
- **Coach:** names it "Missing quarterly reports".

### Checks
- `tools/test-indicators.js` (57 checks) adds:
  - a planted and a null world for A8 and for the community measure (the null is a true binomial draw);
  - "no data" handling;
  - the non-US count.
- The SQL could not be run locally in this session; review it before applying.

### To switch it on
1. Apply both migrations.
2. Deploy the function: `supabase functions deploy earnings` (JWT verified; the cron job sends the anon key).
3. Set the secret: `supabase secrets set SEC_USER_AGENT="Stocktrails <contact email>"`.
4. Optionally set `EARNINGS_FORCE_SECRET`.

Until then, A8 says it needs earnings data, and A7 shows no community line.

## 11. Buying with the crowd (B6, as built)

Barber & Odean (2008) find that private investors buy the stocks that grab
attention. B6 asks it of the user's buys, with the other Stocktrails users as
the crowd.
- **Data:** `network_community_daily` (stocks viewed by 3+ users; the counts
  include the user's own views). `ATIndicators.crowdIndex` subtracts the user's
  daily events exactly as the RPC adds them: each event's `views` on the New
  York day of its ts (the New York date, or the next date at or after 16:00
  ET). The ts is the last view of a chain merged within 60 minutes, so
  subtracting intraday rows would leave a chain over 16:00 ET on the wrong day
  and count the user's own research as crowd attention. Floored at 0.
- **Crowd at a buy** (`crowdAt`): others' views on d-3..d-1 (d = the buy's New
  York day) against d-33..d-4 scaled to 3 days; `ratio = (others3 + 1) /
  (base3 + 1)`; hot when others3 >= 3 and >= twice max(base3, 0.5). Only days
  before d, so later counts never change it. Buys need 33 days of community
  data before them.
- **Share vs chance:** hot buys against each stock's own share of hot trading
  days in the 180 days before the buy (point in time, at least 20 days); the
  excess has a bootstrap over stocks (`clusterBoot`).
- **Outcome:** excess return vs the NASDAQ of hot-crowd buys against the
  others at 5, 21, 63 and 126 trading days, 99% ranges (four horizons side by
  side). `clearOn` names what is clear ("excess", "21", ...).
- `NEED.crowdBuys = { min: 20, solid: 60 }` buys with community data;
  `noData` without community data.
- **Coach:** bias `crowd_buys` when the excess is clear and positive or a
  horizon's difference is clearly negative; rule `wait_crowd` (ratio above
  1.5, 2 or 3; gain -y on the 21-day excess); a habit for progress; the
  pre-trade check's `ctx.crowd`.
- **Tests:** synthetic worlds with `crowd: {follow, edge21}` (a planted world is
  found, a null world is not), the own-view subtraction and the
  earlier-days-only property.
- An association, not proof: the crowd and the user may react to the same news.

## 12. Timing against a savings plan (B7, as built)

Does choosing your moments beat handing the money to a plan? Dichev (2007)
finds investors' money-weighted returns trail buy-and-hold because of when they
put money in. B7 asks it of the user's own buys (`ATIndicators.analyze` ->
`timing`, card B7 "Does your timing beat a savings plan?").
- **Two parts.** *Timed* buys are decisions (`!d.auto`); *plan* buys are savings
  plans (`d.auto`: the broker's flag, or 3+ buys at a regular cadence, see
  `markAutomatic`). Only the main settlement currency; buys without a price
  history are counted in `skipped`.
- **Selling.** Chosen so that a sale can never favour one part. A sale takes the
  same share (`qty / posBefore`) from every lot of the position, the average-cost
  rule the book already uses. FIFO was rejected: it charges sales to the oldest
  lots, which are usually the plan's, so the user's exit timing would leak into
  the comparison. Fixed horizons (the 21-day outcome of the rules) were rejected:
  they ignore sales altogether. Each lot therefore carries its own sale path:
  value per unit bought = the sum of (share still held x share sold x sale price)
  over later sales, plus what is still held at the last close.
- **Index twin.** The same money in the NASDAQ on the buy day, cut by the same
  shares on the same days. A lot's result is `(value - twin value) / (cost x
  years held)`: money earned beyond the twin per euro-year, where years are
  weighted by the share still held. The twin makes lots of different age and
  market comparable (the idea of the public market equivalent, Kaplan & Schoar
  2005) and the euro-year makes a plan that started earlier, or a lot sold
  early, neither favoured nor penalised.
- **Same stocks** (the headline, `same`). For each stock with 3+ timed buys over
  60+ days, the timed buys are replaced by monthly instalments of the same total,
  from the first to the last timed buy, with the same sales. Only the dates
  differ, so stock choice cannot explain the gap. Works without any savings plan:
  the plan is simulated. The effect is timed minus plan, pooled over stocks by
  euro-years, range by `clusterBoot` over stocks.
- **Sleeves** (`sleeves`). The two parts as they were. They also hold different
  things (single stocks against funds), so this is the practical comparison, not
  the clean one; its ranges resample calendar quarters of buying because a plan
  is often one fund.
- `verdict`: `plan_better` / `timing_pays` when the same-stocks range excludes
  zero (the sleeves range when there is no same-stocks data, `basis`), else
  `unclear`, or `too_few`. `NEED.timing = { min: 10, solid: 30 }` timed buys in 3+
  stocks (same stocks), or buys in the smaller part (sleeves).
- **Coach:** bias `timing` ("Timing that does not beat a savings plan") only when
  a plan would have won. No rule: the question is about a whole strategy, not a
  buy that can be vetoed.
- Price return on both sides; dividends are left out (the twin is a price
  index). Values run to the last day of the import. One history is one outcome:
  a lucky stretch looks like skill.
- **Tests** (`tools/test-indicators.js`): cycling stocks bought at troughs, peaks
  and random days against a plan fund; a sale paid out and the rest valued at the
  end; a stock that tracks the index earns nothing beyond its twin however it is
  sold; a sale shortens the time money is held.

## Size by attention (`cap_low_attention`)

How much you looked at a stock before buying (the conviction score: visits in the 30 days
before, scroll depth, focus switches) sets how big the buy may be. The rule only ever cuts:
when conviction is under a threshold and the buy is over `cap` x your usual buy, it says to
keep the buy to `cap` x. It is fitted and judged like the other cap rules (walk-forward, only
trades whose outcome was known), so it is offered only when, on your own history, big buys of
little-researched stocks did worse than the same buys at the cap. Settings tried: conviction
1, 2 or 3 with caps 0.5x to 1.5x. The rules agent applies it with the other caps (a smaller
size, not a wait), and the pre-trade check shows "Size: at most Nx your usual buy, about M" from
the smallest adopted cap, the money amount computed on the device only. There is no rule that
raises a size: attention does not show that a buy deserves more. Test: `cap_low_attention` in
`tools/test-biases.js` (a planted world where big buys of never-looked-at stocks lose).
