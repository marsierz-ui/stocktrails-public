# AI layer: design, data flow and risks

An optional assistant in a side panel of My Habits > Trades & research ("Assistant") that puts
the user's own results into words, answers questions about them, suggests the
rules of the bias coach, reads the notes written with calls, and opens with a review
of the last week (attention, calls, trades, rules broken). Off until the user turns
it on, and answered only for accounts the app's owner switched on. The weekly review
card is computed on the device and shown without the assistant.

Issue: #16. Branch: `feature/ai-layer`, stacked on `feature/trades-research`.

## What it is, and what it is not

Statistics and a model decide side by side. Detecting a bias, fitting a rule and
judging it on trades it had not seen is done by `src/biases.js` with no model in
it (tested in `tools/test-biases.js`). On those statistics two agents decide in parallel on
paper portfolios: the rules agent is deterministic (no model: the same input gives the same
decision), the AI agent is stochastic (a language model: the same input can give a different
answer, so every decision is saved once with its time and reasoning and compared with the user's
and the rules agent's). The assistant never produces a number of its own: it is given results
worked out on the device and writes them up, and the page checks every number in its reply
against those results.

It is an agent in a narrow sense: it decides which of the user's results to look at,
looks further when the first results raise a question (up to 5 steps), and proposes
actions. It is not an adviser and does not act on its own. It cannot place orders,
hold credentials or change data. What it proposes (adopt, retire or retune a rule,
set a pre-trade reminder for a stock, save a review note) appears as a card with its
numbers; it happens only when the user clicks, and only on the device.

## Data flow

```
 browser (device)                                  Supabase function ai-coach               OpenRouter
 ------------------------------------------        --------------------------------         ----------
 imported trades, attention data  (stay here)
        |
 src/biases.js, decisions.js  -> report, coach
        |
 question -> aliases, redaction
   +--> {task: step, question, results, n} ---> verify JWT, allowlist, daily cap,
   |                                              looksPrivate() on results, size limit
   |                                              system prompt (server side) + data --->  more tools, or answer
   |    <-- {kind: calls, calls: [tool, args]} <-- validate against the catalogue <-----
   |    run the named tools HERE (src/aitools.js):
   |      aggregates, "Stock 3", multiples, months
   +--- append to results; repeat (at most 5 steps; the 5th must answer)
        <-- {kind: answer, answer, proposals,  <-- validate, strip markup, actions:
             actions}                              known types, ids and stocks seen in results
        |
 check numbers against the results, show text; each action is a card, done on a click
 every request, tool run and answer -> local log (what was sent), exportable
```

One to five requests per question, each counted against the daily cap. A step
cannot ask again for a result it already has. The model is called with
`store: false`. The function logs nothing about the content and stores only a
counter per user and day (`ai_usage`: user id, day, number).

## What leaves the device

| Sent | Not sent, ever |
|---|---|
| The question, stocks replaced by "Stock 1", long numbers and e-mail removed | Amounts, quantities, prices |
| Results of named tools: counts, shares, returns against the NASDAQ, sizes as multiples of the usual buy, dates by month, rule texts and their statistics | ISINs, tickers, instrument names, broker, account |
| Notes written with calls (the AI agent reads them by itself once the assistant is on), links, e-mail and long numbers removed | The imported file, the trade list, exact dates |
| If asked: the weekly review (views and minutes against the period before, most looked at, spikes, held stocks not looked at, calls, trade shares, rules broken) | Page titles, URLs, the time of single visits |
| If the user lets the AI agent decide: each buy or look as of that day ("Stock N", "day N", price path in %, market percentiles, research, calls with redacted notes, rules, what the rules agent said at that moment) | Amounts, the broker, the account, the stored candidate ids |

Three layers hold this: each tool builds its result from an allowlist
(`src/aitools.js`), every result passes `isPrivate()` before it is used, and the
server runs the same test again (`looksPrivate` in `supabase/functions/ai-coach/core.mjs`)
and refuses a request that fails it (422). `tools/test-ai.js` runs a synthetic
investor through all tools and several multi-step questions and checks that no amount, ISIN, real
ticker or exact date appears in anything sent.

## The two agents and their paper portfolios ("AI agent")

Next to the user, two agents run a paper portfolio on the same money (section
"AI agent" under the pre-trade check, `dashboard/shadow.js` on
`src/shadow.js`):

- The **rules agent** has no model in it. Each month it keeps the coach's rules that,
  fitted only on the trades whose outcome was known by then, held up out of sample, and
  for each of the user's buys (and each first look at a stock) it buys then, waits until
  no rule objects (up to 10 trading days) or passes; a cap rule only cuts the size.
  The buy rules the user adopted in the coach are applied in every month too, with the adopted
  setting, also before they were adopted (chosen knowing that history, so not out of sample).
  A look is dated by its New York trading day: one at or after the 16:00 ET close
  counts for the next day, so it is never entered at a close that had already printed.
  The crowd rule (`wait_crowd`, other users' attention on the stock) can only fire
  with community data: signed in, or the sandbox's synthetic community rows.
  Everything it uses is from before the day (point in time, tested in
  `tools/test-shadow.js`). It is a yardstick, not a stock picker: it asks one question
  of every buy and every first look (would the rules that held up for you let this go ahead
  now?) and with no rule objecting it simply buys, so most of its rows read "buy". What it
  measures is how your own buys and looks would have fared had you obeyed your own rules.
- The **AI agent** is the model (task `decide`). For each candidate it gets what was
  known at that moment and says `buy` now, `wait` 1-10 trading days then buy, or
  `pass`, with a size and a reason of at most 200
  characters (and a `reasoning` of at most 600). A size is the final weight the position
  should have after the buy, as a share of the portfolio's value: 1, 2.5, 5, 10, 15 or 20%;
  the rest of the portfolio stays as it is (cash; nothing about it refers to the NASDAQ). A
  buy of yours is sent with `yourWeightAfterBuy` (the weight your own buy gives in your depot) for a moment of the
  last 2 days. Decisions saved before weights (`sizeUnit` absent) carry a share of the
  amount; they count as 5% times that share. `pass` means this stock is not bought at all; for a repeat view the answers are
  hold (do nothing: the position stays as it is), sell or buy more. It may disagree with the rules agent. With the stand-in model
  (`AI_PROVIDER=mock`) it follows what the rules agent said at that moment: buy now with a
  weight of 5% cut by the rules agent's share, or a wait of 1 trading day (it is not told how long the rules
  agent then waited), so offline its line is close to, not equal to, the rules line.

Every paper portfolio stays fully invested: money a smaller buy leaves goes into the stocks it holds, in
proportion (cash only while nothing is held); when the user sells, each portfolio sells the same share of its
position and the money leaves it (it paid for the user's later buys, which come in as their own amounts), so the
user's bars are their positions at market value. Savings-plan buys are no decision for the agents, but every
portfolio makes them at the user's weight, so the positions are the ones the user had. The NASDAQ is only the benchmark line. The
"Paper portfolios" chart (`ATShadow.agentPortfolios`, tested by hand-made worlds in `tools/test-shadow.js`)
has two views, each with a time-weighted index per portfolio, 100 on its first day, and a timeline of two
handles to choose the period (every line starts on the first day all of them have a value):
*your trades* (you, all of each buy in the stock, which gives the buy a weight in your portfolio; the rules agent
that weight times its share, or a wait or a pass; the AI agent up to its final weight, your weight where it has not
decided; the NASDAQ) and *your attention*, each a virtual portfolio of 100 from the first look (the
attention-weighted index: every stock viewed in the 30 days up to 1 day before each close, weighted by those views,
rebalanced at every close, the last basket kept when there are no views; the rules agent: the same basket, each stock
only from the day its rules let the look through, so it picks its own lag, none of a passed look, a cap rule cutting
the weight; the AI agent buys up to its weight and sells only on its own repeat-view decisions; the NASDAQ). "Holdings over time" shows each portfolio stock by
stock and in cash at every month end, to check the lines. Every portfolio is valued in the currency of the
user's buys at each day's exchange rate (Yahoo's daily rates; a price is kept as it is when its rate is missing).
The chart shows the whole history by default; the AI agent's line starts at 100 on its first decision. Values are shares of the portfolio's
value, never amounts. Both agents only act on the user's own buys and the stocks they
looked at, place no orders, and this is not investment advice.

What one candidate carries (built on the device by `ATShadow.contextFor`; key names avoid
the forbidden ones): `id`, `kind` (trade or look), `stock` ("Stock N", or the ticker in
names mode), `company` (names mode only; the server drops it otherwise), `date` ("day N"
from the first record, or YYYY-MM-DD in names mode), side, size against the usual buy,
`pricePath` (% change of the weekly closes over the 60 trading days before against the
close of the day), run-up over 30 days, distance from the 52-week high, the market
(volatility and 20-day return percentiles against earlier days only, drawdown),
research before (views and minutes in 30 days, days since the first look, page types),
calls before (sentiment, days before, target against the price in %, horizon, the note
redacted to 200 characters), other users' attention (ratio, hot) when there is
community data, the rules that held up that month with their verdicts (worded from the
decisions before the day only), the user's record up to that day, and `rulesAgent`: what
the rules agent said at that moment (`buy`, or `wait` until the rules that fire no longer
apply, the size, and each fired rule's reading and instruction). Never the rules agent's
wait length or a pass: those depend on the prices after the day. No amount, ISIN, broker
or account. `ATAI.decide` sends the candidates under ids of that request only (`c1` to
`c15`) and maps the answers back on the device: the stored ids are hashes of the
instrument and the date, which a dictionary of tickers and days would reverse. In call
notes the stock's own ticker and name (in any case) become its alias, and other tracked
stocks' tickers and names "another stock".

Request: `{v:1, task:"decide", candidates:[...at most 15], names?:true}`. The server
checks the shape (unique ids of at most 40 characters, at most 5000 characters per
candidate), runs `looksPrivate` (422), applies the names policy (403 unless
`AI_NAMES_OK=true`), and validates the reply: unknown ids dropped, days clamped to
1-10 for a wait, sizes snapped to the six weights (a sale of a repeat view to a share of the position), the reason cleaned (ids are matched as
a set, so a name such as `toString` is never taken for one). The prompt asks for the reason and
reasoning in English only, and a decision whose reason and reasoning are mostly in a non-Latin
script (more than 30% of the letters, `looksEnglish`) is not kept: it comes back under `unsure`
with the reason "Answer not in English." and is asked again later. The reply carries the model
name and `promptVersion` (2 since the rules agent is sent as of the moment; 4 added the `reasoning`
field and the definition of a size; 7 the English-only rule), the `engine` that answered (`text`, `decision` or `mock`) and, from a
decision model, each decision's odds (`trace`).

**Backfill and quota.** "Let the AI agent decide" sends the undecided buys and looks in
requests of 15, newest first, with progress; each request counts against the daily cap
(`AI_DAILY_CAP`, default 40), so 600 candidates are 40 requests, a day's cap. It stops on
an error, on the cap or on "Stop", and continues where it left off: every answered
request is saved at once.

**Repeat views in a burst.** Besides buys and first looks, the AI agent decides a repeat view of a
stock it has looked at in the last 30 days when its views in the 3 days up to it are at least 3 and
at least twice the usual (`ATShadow.pendingRevisits`; once per burst). It is asked apart from the
others, with the position the agent holds (from its own earlier decisions) and the stock's move since
its entry, and answers hold (do nothing), sell (a share of the position, only when holding) or buy
(more, or a first entry), with a size of 0.25 to 1 (`validateDecisions` with the candidates' meta; prompt
version 3). The decision model answers a repeat view with the same three questions as a first look: buy adds to the position (or enters) at the weight it picks, pass and wait together are doing nothing (hold). A position that may be sold today (`revisit.position.canSell`: not opened or added to on the day of the repeat view, which `positionAt` in `src/shadow.js` works out) also gets two more questions, sell or keep and the share to sell (25% to 100%); a position opened or added to that day is never sold, by either model. The most probable of buy, hold and sell wins; below the threshold it is unsure (prompt version `decisions-5`). Only moments from 2026-10-16 on (`TR_REVISIT_START`) and at most 2 days old are decided.
In the looks chart the AI agent's line follows this selling logic and has no fixed holding period
(`sellLogicPositions` in `src/shadow.js`): a bought look opens a position, a sale closes that share of the
whole position at that day's close, a buy adds a position from that day, and what is left is valued at the
last close. For comparison the same entries are held for a fixed number of months chosen by the user (1, 2,
3, 6 or 12; 21 trading days to the month), next to "buy every look", the rules agent and what you bought.
The horizons toggle of the trades view is shown in months too.

**Live verdict on stock pages.** The AI agent no longer waits for the dashboard to be opened. A minute
after a viewing session of a stock ends (its views and dwell across all tabs; a return within 5 minutes
continues it), the extension builds the same input in the background (the dashboard headless in an
offscreen document, see ARCHITECTURE.md, `src/background.js`) and the agent decides the undecided moments
of the last 2 days of the stocks in those sessions, so the verdict never waits behind a backlog (the other
moments are decided when the dashboard is open; the two never send the same request twice: one request at a
time, after re-reading the saved record). The moments are unchanged: first looks (no view in the
30 days before) and repeat-view bursts. A candidate whose moment falls inside the session carries `session`
(views, minutes on the page, pages, returns; counts only). When a decided moment's session gets more views
after the decision, it is asked again, with `session` and `yourEarlierAnswer`, at most 3 times per moment;
the new answer takes the moment's id and the earlier one is kept (`<moment>|prev|<decidedAt>`, `momentId`,
`supersededAt`), so the record shows both, while the portfolios use the latest. The verdict appears in a pop-up
on the stock's page; a session that is not a moment (for example a return within 30 days that is not a burst)
gets a note saying so, with the latest verdict on the stock if there is one. Same gates: the assistant's
consent, signed in, the daily cap; nothing older than 2 days.

**The live record and why there is no backfill.** Every paper decision of either agent is
saved once, when it is first made, in the device's ledger (IndexedDB store `agent`) and
never overwritten. The rules agent uses only earlier data, so it is decided over the whole
history. The AI agent is a model that may know what happened next to a stock or the market,
so it is never asked about a past moment: `trAgentUndecided` offers only buys and looks at
most 2 days old, the page asks for them automatically when it opens (once the user has agreed
to the assistant's terms), and a stored AI decision made later than 2 days after its moment
is ignored. Its portfolio follows the user before that, and grows as new moments arrive. A rules
agent decision whose wait is cut short by the end of the prices is still pending (not
bought so far) and is saved only once it is final.

The pre-trade check also shows the rules agent's verdict for the intended buy now (buy,
wait and how long it typically waited for that rule, or pass, with the rules that fired;
no quick switches is checked from the days since the last sale of another stock, and a
rule counts as not checked only when a feature it reads is missing) and an "Ask the AI
agent" button: one `decide` request for that buy, with what the rules agent says now.

## Permission tiers

| Tier | What | Who decides |
|---|---|---|
| T0 | Read-only tools on the device: overview, findings, biases, rules, simulate, list decisions (no amounts), adherence, check a buy, whether each habit is fading (recent decisions against earlier ones), what-if with another setting, explain a decision, one stock's summary, weekly review, the agents' paper portfolios, what the two agents decided on single moments and why (`get_agent_decisions`: the saved decisions with their reasoning, the model, the pre-trade checks, and why a stock has none; months and days ago, no amounts). Also the AI agent's paper decisions (task `decide`): output that only moves a paper portfolio in the browser | The model names tools; the server accepts only the catalogue, with checked arguments, at most 4 per step and 5 steps. Paper decisions are validated (known ids, buy/wait/pass, clamped days and sizes) and place no order |
| T1 | A local write: adopt, retire or retune a rule, set a pre-trade reminder, save a review note | The user, with a click on a card. The model can only propose (`proposals` and `actions` in an answer, at most 3, only ids that appear in the results and stocks that appear in the results or the question); a retune card shows the what-if numbers. A reminder's stock is matched on the device: an alias in any case, or, with names off, the real ticker or name mapped back (nothing leaves), or a stock the user typed in the question; one that matches none is reported under the answer instead of dropped. A reminder without its text (the model sometimes sends only the stock after looking things up) takes the user's own words from the question. The service lists what it left out of a reply and why (`dropped`, with the field names), which the log shows |
| T2 | Orders, broker or bank credentials, writing trade data to any server, changing settings | Not offered. There is no tool, endpoint or code path for it |

## Real stock names (opt-in)

By default stocks go out as "Stock N". A user can opt in to real tickers so answers
read naturally. The browser then sends `names: true`, and the server refuses it
(403 `names_not_allowed`) unless `AI_NAMES_OK=true` is set, which the owner sets only
with a paid key: on the free tier the content may be read by reviewers. Amounts and
ISINs stay off either way; exact dates stay off too, except in `decide` with names on,
where each candidate's date is sent as YYYY-MM-DD.

## Controls

- Off by default. Consent is explicit and stored on the device; withdrawing is one click.
- Deny by default on the server: `AI_ALLOWED_USERS` lists who may use it; empty means nobody. `AI_ALLOW_ALL=true` is for a paid key only.
- JWT verified; per-user daily cap (`AI_DAILY_CAP`, default 40) counted in the database before the model is called, so a failing counter stops the call.
- System prompts live on the server. The question and the results go in as JSON strings, labelled as data; the tool catalogue is validated server side, so an instruction hidden in a question cannot make the model call anything else.
- Replies are validated (JSON, known ids, length), markup is stripped, and the page renders text only.
- A reply that states a number the results do not hold is marked in the page.
- Errors do not echo provider text. Nothing about the content is logged.
- "What was sent" lists every request, tool run (with its tier) and answer, with the exact bodies; it can be downloaded or cleared. Bodies of chat and notes requests are kept up to 6000 characters, `decide` bodies whole; the log keeps the last 80 other entries and, apart from them, the last 120 `decide` entries (a day's requests), so a backfill does not push the chat or the consent entry out.

## Providers and the free tier

OpenRouter is the primary provider: set `AI_PROVIDER=openrouter` and the function calls
its OpenAI-format chat endpoint with `AI_MODEL` and `AI_MODEL_LITE` (ids look like
`vendor/model`; `AI_MODEL` is required, the lite one falls back to it). Every request carries
`data_collection: "deny"` and `require_parameters: true`, so an endpoint that may train on
prompts (many `:free` variants) is never used: such a model id fails with a provider error
instead. The decision models (below) go through OpenRouter as well.

Two alternatives exist. `AI_PROVIDER=cerebras` uses the same chat format against Cerebras.
`AI_PROVIDER=mock` runs the whole flow without a model and without a key, for demos and tests.
Set `AI_PROVIDER` explicitly in every deployment.

### Models per task

| Task | Model | Why |
|---|---|---|
| `plan` | lite text model (`AI_MODEL_LITE`) | picks tool names; small JSON |
| `step`, `answer` | main text model (`AI_MODEL`) | multi-step reasoning and the written answer |
| `classify_rationales` | decision model if `AI_DECISION_MODEL` is set, else the lite text model | fixed labels per note |
| `decide` | decision model if `AI_DECISION_MODEL` is set, else the main text model | buy, wait or pass, days, size |

A repeat view (kind `revisit`) is always answered by the main text model, since the decision
model knows buy, wait and pass only. On the text route the model shown with a decision
("text model, ...") is `AI_MODEL` as it is set, not a name the provider reports; to change
which model decides, set `AI_MODEL` (the chat assistant's `step` and `answer` use it too).

The pre-trade check ("Check a buy before you place it") also uses the `decide` task: when
the assistant is on, the AI agent is asked for each check, one candidate without the
amount, and its answer is shown directly beneath the rules agent's verdict. Each run of the
check is saved on the device (IndexedDB store `checks`) with what was typed and measured,
the adopted rules, the rules agent's verdict and the AI agent's answer, model and exact
input, for later evaluation. Nothing in it is synced.

The AI agent also reads the notes written with calls by itself: on entering the page, every
note not read yet is classified once (`classify_rationales`, batches of 20) and the result
kept on the device; there is no button for it. It is shown in the AI agent's card as "What your
own words say".

A decision model (OpenRouter Decisions API, `POST /api/alpha/decisions`, an alpha
endpoint) writes no text: it answers typed questions about a state with probabilities
(choice, score on an ordered list, yes/no). It needs `OPENROUTER_API_KEY` whatever
`AI_PROVIDER` is, and is sent `data_collection: "deny"` too (the free Mercury Decide
endpoint trains on prompts and is refused by the deny, unless `AI_DECISION_ALLOW_TRAINING=true` is set; the paid `inception/mercury-decide` and `typesafe/jev-1.14`
were listed as not training on 2026-10-17). One request per note or candidate, 5 at a
time; one that fails twice is left out.

- Notes: one yes/no question per note type and emotion (yes at 0.5 or more), yes/no
  for "specific", and a choice for horizon (with "none"), tone and stance.
- Decisions: a choice of buy, wait or pass, a score over 1 to 10 trading days and one
  over the final weights 1, 2.5, 5, 10, 15 and 20% of the portfolio's value (the rest of the portfolio stays as it is). When the chosen action's probability is below
  `AI_DECIDE_MIN_P` (default 0.6) the model is not sure enough: nothing is decided for that
  moment (it comes back under `unsure`, with its odds; the answer is saved as an `unsure` record with
  the input it was shown). The page asks again only when what the model would be shown for that moment
  has changed (`ATAgentSession.askAgainUnsure`), and saving an unsure answer does not start another run.
  The reason lists the three probabilities. Each decision is saved with the
  dated model id the provider reports and `promptVersion` `decisions-5` (the questions' version),
  so its record is never mixed with that of a text model. The decision model writes no reasoning
  of its own (the provider documents that it returns none), so what is saved as its reasoning is its
  odds: `trace` = { odds: buy, wait, pass; confidence; probabilities of the days and size scores;
  the threshold }.

### What is saved with each decision, so it can be explained later

Every paper decision is kept on the device (IndexedDB store `agent`) with its reasoning, and the
assistant can read it (tool `get_agent_decisions`, below), so "why did the agent pass on X?" has an answer
long after the moment:

| | Kept |
|---|---|
| Rules agent | the decision and its short reason; `why`: each rule that acted, its role (asks to wait, cuts the size, moves the time of day), the rule's own sentence about that moment ("It is up 19% in the last 30 days (the limit is 10%)") and its instruction; `features`: what was measured then (run-up, market percentiles, views, hours since the first look, size against the usual buy, the crowd, lottery); `active`: the rules in force that month. All point in time (tested like the decisions) |
| AI agent, text model | `reason` (at most 200 characters), `reasoning` (at most 600: the factors it weighed, also those against), `engine` `text`, the model and `promptVersion`, and `input`: exactly what it was shown (stock and date as aliases, no amounts) |
| AI agent, decision model | `engine` `decision`, the dated model, `promptVersion` `decisions-5`, `trace` (its odds, see above) and `input` |
| Pre-trade check | the rules agent's verdict with its readings, the AI agent's answer with the same fields, or that it was not sure enough |

A model's own text names the stock by the alias of its request ("Stock 17"), a number that changes
when the list of stocks grows; it is saved as "this stock". Decisions saved before this was kept have
no `reasoning`, `trace` or `input`; the page says so and the tool derives the engine from the
`promptVersion` (`decisions-N` is a decision model).

In the page every row has a "why" link under each agent: the readings of the rules, the model's reasoning
or odds, the size in your own money (for a buy you made: "75% = 750 of your 1,000 EUR") and the input.
In the pre-trade check the rules agent's cut is said as the weight it leaves in your portfolio (and in the amount you typed), the AI agent's size as a final weight.

### Comparing the text model and the decision model

A `decide` request may carry `engine: "text"` or `"decision"` to force that route whatever
`AI_DECISION_MODEL` says (400 `engine_unavailable` when no decision model is set); the reply names the `engine` that answered and, for the decision model,
its `spend` (tokens and cost as the Decisions API reports them). It is used by:

- `node tools/compare-models.js` does the same on a synthetic investor with the providers' real APIs
  (settings and keys as for the function: `AI_PROVIDER`, `AI_MODEL`, `AI_DECISION_MODEL`, the provider's key;
  `--n`, `--seed`, `--out`). It sends no real data. Not run against the live APIs in this repository: it needs
  keys; its logic is tested with fake models in `tools/test-ai.js`.

OpenRouter is called with `provider: {data_collection: "deny"}`, so only providers that do not
train on or retain prompts for training may answer. A model whose provider does so fails the request
on purpose. The privacy policy (docs/PRIVACY.md) names the
provider path.

## Setup (the owner does this; nothing here deploys itself)

1. Apply `supabase/migrations/20261010_ai_usage.sql` (a table and one function, additive).
2. `supabase secrets set AI_PROVIDER=openrouter OPENROUTER_API_KEY=... AI_MODEL=<vendor/model> AI_ALLOWED_USERS=<user ids, or e-mails of Google sign-ins>`; optional `AI_MODEL_LITE`, `AI_DECISION_MODEL`, `AI_DECIDE_MIN_P`, `AI_DAILY_CAP`, `AI_ALLOWED_ORIGINS`, `AI_NAMES_OK` (paid key only).
3. `supabase functions deploy ai-coach` (JWT verification stays on).
4. To try it without a key: `supabase secrets set AI_PROVIDER=mock`.

## Known risks

| Risk | Mitigation | Left over |
|---|---|---|
| A model states a wrong or invented number | Replies come from results only; numbers are checked against them and marked when unmatched | A true number can still be explained wrongly; the results are shown under every answer |
| Prompt injection in a question or a note | Data in JSON strings, prompts server side, a fixed read-only tool catalogue, no tool can write, actions are only proposals checked against the results | A model can still be talked into odd wording or an unhelpful proposal; the user sees the card before anything happens |
| A runaway agent loop | At most 5 steps, the last must answer, repeated calls are dropped, every step counts against the daily cap | A question can use up to 5 calls of the cap |
| Personal data in a free-text question or note | Redaction of links, e-mail, long numbers, ISIN-like ids; notes previewed before sending | Names and other free text cannot be recognised reliably; the consent text says not to type personal information |
| Aliases leak identity through a distinctive pattern | Months not days, ratios not amounts, 15 decisions per list at most; `decide` ids are per request | A user with very few trades is easier to recognise in aggregate. `decide` sends one record per buy or look with day offsets ("day N"), the hour and a weekly price path, plus run-up and distance from the 52-week high: matched against public prices they can point to the stock and the day, and since all share one day 0, one match dates the others |
| Provider terms (free tier) | Allowlist, deny by default, owner decides the plan | A mistake in the allowlist; see setup |
| Quota exhaustion | Per-user daily cap, small model for planning and notes, notes cached by hash and sent once | A shared free quota is small; the page shows the provider's limit message |
| Stale or wrong API shape | The request and reply are built and read in one place (`core.mjs`), tested against the documented shape | Not tested against the live API in this repository; run `tools/ai-smoke.js` with a key before relying on it |
| Rules read as advice | Every answer says it describes habits; rules show the out-of-sample result and in-sample flattery; no price predictions | Users may still follow a rule that stops working |
| Hindsight in the AI agent's backtest | Every paper decision is saved once with its time; the AI agent is only asked about moments at most 2 days old (never a backfill) and older stored decisions are ignored; the rules agent is point in time and tested for look-ahead | The AI agent has few decisions at first |
| Paper decisions read as advice | The section and the check say paper portfolios, no orders, not investment advice; the agents act only on the user's own buys and looks | A user may still copy a "buy" |
| A backfill uses the quota | Requests of 15, newest first, progress, stop and resume; each answered request is saved | A long history can use a day's cap |

## Tests

`node tools/test-ai.js` (no network, no key): access rules and caps, request limits,
the tool catalogue and argument checks, what must not arrive (server and browser use
the same corpus), prompt-injection containment, the provider request and reply shapes
against a fake model, every tool on a synthetic investor, aliasing, the number check,
the multi-step agent with a recording transport (and against a model that never stops
asking), action validation, the names policy, the weekly review, the notes
analysis with a planted effect, and the `decide` task (stand-in agent, names policy,
private candidates refused, unknown ids dropped, days and sizes clamped, consent), the decision model's
odds and spend, the `engine` switch, `get_agent_decisions` (kinds of moment, aliases, no dates or amounts,
which model decided, a name given in part) and `tools/compare-models.js` against fake models.
`node tools/test-agent-session.js`: the viewing sessions of the live verdict (several tabs, a return within
minutes merged, a later one a new session, when a session is due, its moment, when a moment is asked again and the
earlier answer kept).
`node tools/test-shadow.js`: the agents (no look-ahead, also for the readings and features kept with a
rules-agent decision, accounting, planted and null worlds, looks, before and after app use, the requests built
for `decide`, and `compareRuns`).
