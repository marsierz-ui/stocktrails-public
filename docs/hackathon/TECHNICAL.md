# Technical documentation

## 1. System

```
 Chrome extension / installable web app (the same dashboard code)
   capture of research (which stock, when, how long, page type, the user's calls and notes)
   broker import (CSV/XML, read in the browser, stored only in the browser)
   ----------------------------------------------------------------------------------
   src/decisions.js   fills -> decisions, 13 questions with sample-size status      (pure)
   src/biases.js      biases, rules, out-of-sample validation, adherence, pre-trade   (pure)
   src/aitools.js     read-only tools for the assistant, privacy filter                (pure)
   src/aiclient.js    consent, request log, the agent loop (up to 5 steps), action cards
   src/rationale.js   notes written with calls: redaction, cache, statistics           (pure)
   src/shadow.js      the rules agent and the paper portfolios, point in time          (pure)
   dashboard/*.js     the UI
        |   only aggregates, aliases, ratios, months leave the device (opt-in); the AI agent's
        |   decide task sends per-decision records with day offsets and a price path (SECURITY R3)
        v
 Supabase Edge Function ai-coach      verify JWT, allowlist, daily cap, prompts, tool catalogue, privacy check
        v
 OpenRouter (chat API, data_collection: deny; Cerebras as an alternative)
```

Detecting biases, fitting rules and judging them out of sample is deterministic and tested
without a model. Two agents decide in parallel on the same statistics (section 3.1): the rules agent
is deterministic (no model; the same input gives the same decision), the AI agent is stochastic (a
language model; the same input can give a different answer, so each decision is saved once with its
time and reasoning and compared with the user and the rules agent). The model is also used to choose
which read-only tools to run for a question (step by step), to put the returned results into words,
to propose actions the user may approve, and to read the wording of notes.

## 2. Core algorithms

### 2.1 Decisions and outcomes (`src/decisions.js`)

Fills of one instrument on one side on one day form a **decision**. Savings plans,
derivatives, bonds and crypto are set aside, as are decisions before research was
recorded. Outcome of a buy: excess return against the NASDAQ Composite from the
close of the trade day, over 21 trading days (and 63 days for calls). Holdings
before the file starts are inferred from sales larger than the known position.

### 2.2 Market context without lookahead (question 10)

For each buy, from the bars **before** the trade day: volatility (stdev of 20
daily returns), 20-day return, distance from the 252-day high. A buy is placed
among all trading days of the covered period by percentile, so that "you buy in
turbulent markets" is judged against how often markets are turbulent.
Sizes are judged against the user's usual buy at the time (median of the previous
6 months), so a growing portfolio does not read as buying bigger.

### 2.3 What chance gives: the shift test

Markets stay calm or turbulent for weeks and buying comes in bursts, so
neighbouring days and buys are alike and an ordinary bootstrap gives ranges that
are too narrow. The whole pattern of buys is slid along the calendar by every
possible shift (wrapping round) and each statistic is recomputed: the buys keep
their spacing, the market keeps its stretches, only their alignment is broken.
That gives the 99% range and p of each statistic (`shiftTest`).

### 2.4 Rules and the out-of-sample check (`src/biases.js`)

Each rule has a setting grid, a flag ("the rule says do not") and a gain (what not
doing it would have been worth against the NASDAQ, assuming skipped money earns the
market). `fit` picks the setting with the largest mean gain times the square root
of the number flagged, among settings that flag at least 5 and at most 60% of the
decisions and have positive mean gain.

`walkForward`: decisions in time order; the first half is only ever training; the
rest is cut into up to 6 blocks. For each block the rule is fitted on decisions
whose outcome was **already known when the block began** (an embargo: a buy's
return runs for a month), then applied to the block. A fold in which no setting
helped recommends nothing. Only the gains on the later blocks are pooled and given a
bootstrap range: **supported** (99% above zero), **indicative** (95%),
**unclear**, **unsupported**, **untested** (fewer than 24 decisions with an outcome or
8 flagged out of sample).

Calibration (`tools/test-biases.js`): planted effects are found and hold up; in 24
worlds with no effect, 0 of 216 rules were called supported; an effect that stops
halfway is not recommended; the embargo is unit-tested.

### 2.5 Adherence

After adoption: the share of decisions that broke the rule, the same over an equally
long stretch before (Newcombe interval for the change), and the result of the
decisions that kept it against those that broke it (bootstrap range). Reported as an
association: nobody was assigned to comply.

### 2.6 Notes (`src/rationale.js`)

Each note is redacted, classified once by the assistant (kinds of reasoning, specific
or vague, hedged, emotional words, horizon, stance) and cached by hash. Calls are
grouped by kind of note and compared on the 63-day return with 99% ranges and at
least 8 calls on each side.

## 3. The agent: tools and the loop

The agent works in steps, at most five requests per question. Each request carries
the question (stocks replaced by aliases) and the results so far; the model either
names up to four more read-only tools from a fixed catalogue or answers. The tools
run in the browser (`src/aitools.js`) and their results go out with the next step,
so it can look further when a first result raises a question (for example, read a
rule's details after seeing the biases, or try a rule with another setting). The fifth
step must answer, and a call it already has is dropped. The browser then checks every
number in the reply against the results and marks the ones it cannot find.

The answer may propose actions (tier T1): adopt, retire or retune a rule, set a
reminder that appears when the user checks a buy of that stock, save a review note.
The server keeps only known types with rule ids and stocks that appear in the results;
the browser shows each as a card, a retune with what the new setting would have done
over the whole history and its later half, and writes it locally only on a click.

A weekly review opens the panel, worked out on the device: views and research
minutes against the period before, the stocks looked at most, sudden spikes of
interest, first looks, held stocks not looked at for 30 days, calls made, trades with
their research and impulse shares, and adopted rules broken. The agent can read it
through `get_weekly_review`.

Real stock names are an opt-in; the server accepts them only when `AI_NAMES_OK=true`,
which needs a paid model plan.

| Tool | Returns |
|---|---|
| get_overview, get_finding(q1..q11, disposition, horizon) | counts, shares, returns, statuses, as plain facts |
| get_biases, get_rule(id), simulate_rule(id) | biases, rule wording and the out-of-sample verdict |
| list_decisions | decisions with alias, month, size as a multiple of the usual buy, research, rise, time of day, market, result; no amounts |
| get_adherence, check_buy(stock, size) | how rules are kept; an intended buy against adopted rules and reminders |
| compare_periods(days) | whether each habit is fading: the last N days against all earlier decisions, with a verdict |
| what_if(id, limit, cap) | a rule with another setting, over the whole history and its later half |
| explain_decision(stock, month, side), stock_summary(stock) | one decision with its research, rise, size, market, time and flagging rules; one stock's views, calls and decisions |
| get_weekly_review(days) | the review above |
| propose_rule(id) | a proposal card (the user decides) |
| get_agent_portfolio(view) | the agents' paper portfolios: values as % of the money put in, paired differences with 99% ranges, before/after app use, live vs after-the-fact counts |
| get_agent_decisions(stock, limit) | what the rules agent and the AI agent decided on single moments and why: action, size, the rules that fired with their readings, the AI agent's reason and reasoning or a decision model's odds, which model decided, the pre-trade checks; months and days ago, no amounts |

### 3.1 Two agents with paper portfolios

A rules agent (`src/shadow.js`, no model) and an AI agent (task `decide`) each run a
paper portfolio on the user's own buys and on the stocks the user looked at. Monthly,
the rules agent keeps the rules that held up out of sample on units whose outcome was
known by then (point-in-time market percentiles; `avoid_daypart` on fixed day parts),
and for each candidate buys at once, waits until no active rule objects (re-checking
the features 1 to 10 trading days later) or passes; a cap rule only scales the size.
Money not in the stock earns the NASDAQ; the user's sells are mirrored as a share of the
position. Results: daily values (you, rules agent, AI agent, NASDAQ) as a share of the
money put in; per buy at 21, 63 and 126 trading days the agent's excess minus the
user's, measured to the same end bar, with a 99% bootstrap range; the same before and
after the user's first live view (association, not proof). The AI agent gets each
candidate as of that day (aliases, "day N", ratios; `ATShadow.contextFor`), with what the
rules agent said at that moment (buy, or wait until its rules no longer apply; never its
wait length or a pass), in requests of 15 under ids of that request only. Every decision is saved once with its time. The AI agent is only asked about moments at
most 2 days old, so the model cannot know what happened next; there is no backfill, and an
older stored decision is ignored.

## 4. Data minimisation, in code

- Tool results are built from allowlists (no key for amounts, quantities, prices, ISINs, tickers or names exists in them); each passes `isPrivate()`; the server runs `looksPrivate()` again and refuses (422).
- Stocks are "Stock n" per session; sizes are multiples; dates are months; questions have long numbers and e-mail addresses removed.
- `tools/test-ai.js` runs a synthetic investor through every tool and several multi-step questions and checks that no amount, ISIN, real ticker or exact date appears in any request.

## 5. Storage

Imported trades, matches, adopted rules and the agents' paper decisions: IndexedDB `stocktrails_ledger` (version 3),
per account, on the device, deleted with "Delete all". The request log and the
notes cache: localStorage. Server side: a counter per user and day, nothing else.

## 6. Tests

`tools/test-trades.js` (105), `tools/test-biases.js` (39), `tools/test-ai.js` (150), `tools/test-indicators.js` (77), `tools/test-shadow.js` (90, the agents), `tools/test-agent-session.js` (22) and `tools/test-pricecache.js` (18). No network, no key, synthetic data.
`tools/synth-world.js` builds deterministic investors with planted effects.
