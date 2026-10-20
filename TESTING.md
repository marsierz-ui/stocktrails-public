# Test cases

Stocktrails has automated tests for everything that decides (statistics, rules, privacy filters, access
control, the agents' accounting) and static checks for the repository's security properties, plus a short
manual walkthrough of the dashboard. All automated tests use **synthetic data only**, need **no network,
no API key and no installation**, and run on **Node.js 22 or newer**.

```bash
node tools/run-tests.js                  # all suites, a few at a time: one to two minutes
node tools/run-tests.js --serial         # one after the other: about 3 minutes
node tools/run-tests.js --only=biases,ai # some suites
node tools/run-tests.js --list           # what each suite covers
node tools/run-tests.js --verbose        # also print every check
node tools/test-biases.js                # or run one suite directly
```

Every check prints `PASS` or `FAIL` with a message that says what was expected. A suite exits with code 1
if any check fails; the runner exits with 0 only if every suite passes.

Last run (Node 22.23):

| Suite | File | Checks | Seconds |
|---|---|---:|---:|
| trades | `tools/test-trades.js` | 105 | 5 |
| biases | `tools/test-biases.js` | 39 | 47 |
| indicators | `tools/test-indicators.js` | 77 | 28 |
| ai | `tools/test-ai.js` | 158 | 18 |
| shadow | `tools/test-shadow.js` | 90 | 67 |
| agent-session | `tools/test-agent-session.js` | 29 | 0 |
| pricecache | `tools/test-pricecache.js` | 18 | 0 |
| headinfo | `tools/test-headinfo.js` | 1 (43 headlines) | 0 |
| repo | `tools/test-repo.js` | 27 | 8 |
| sandbox | `tools/test-sandbox.js` | 11 (12 on a machine with a network interface) | 1 |
| **total** | | **555** | |

Seconds are wall-clock per suite with suites running in parallel.

## How the statistics are tested

`tools/synth-world.js` builds deterministic synthetic investors: a price history for hundreds of stocks, a
trade list, views, calls and notes, with **planted effects** of known size (for example "buys after a rise
cost 7 points per +10% of rise"). Two kinds of world are used throughout:

- **Planted world:** the effect is there; the code must find it, and a rule that addresses it must hold up
  on trades it was not fitted on.
- **Null world:** no effect is planted, or it stops halfway; the code must stay silent. In 24 null worlds,
  0 of 216 rules were called supported.

The same seed always gives the same investor, so a failure is reproducible.

## Automated test cases

### Broker import and decision analytics: `test-trades.js`

| Case | Expected |
|---|---|
| T1 Parsers on synthetic broker files | Format detected; buys, sells and savings plans counted; cancelled orders skipped; decimal commas, positional columns and English and Dutch headers read; local broker time converted to UTC |
| T2 Instrument name similarity | The similarity used to match instruments across brokers |
| T3-T4 Decisions on synthetic worlds | Fills become decisions with outcomes against the NASDAQ, and the research-versus-trading questions give the planted answers |
| T5 Browsing-history reader | Google Takeout and CSV history files are read into attention rows |
| T6-T7 Day parts | Day parts from the investor's own buying clusters, user-defined day parts, conviction bands |
| T8-T10 Attention index (question 9) | The all-views basket keeps a stock the recent basket has dropped; **no look-ahead**; decision lag and in-place recompute |
| T11 Small statistics | The statistics helpers |
| T12 Market context and questions 10, 2, 5 | Trailing sizes and market context on controlled worlds, with the planted answers |
| T13-T14 Page types; a stock that carries a comparison | The page-type classifier report; the single stock that carries a comparison is named |

### Bias coach and rules: `test-biases.js`

| Case | Expected |
|---|---|
| B1 Planted effect found, and it holds up out of sample | Six rules (wait after a run-up, sleep on it, avoid your worst time of day, pause and cap in turbulent markets, research before you buy) are each recommended in a world with their effect planted, and judged supported on later trades |
| B2 No effect | In worlds with no planted effect the out-of-sample check rarely lets a rule through (0 of 216 rules called supported in 24 worlds, as documented in `docs/hackathon/TECHNICAL.md`) |
| B3 An effect that stops | A rule that worked in the first half but not afterwards is not recommended going forward |
| B4 The fit never sees outcomes that were not known yet | The embargo is unit-tested: no trade whose return was still running is used to fit |
| B5 Adherence, simulation, pre-trade check | Adherence to an adopted rule, simulation of a rule, and the check of an intended buy against adopted rules |
| B6 Too little data | Too little data gives "untested" (fewer than 24 decisions with an outcome, or fewer than 8 flagged out of sample), not a verdict |
| B7 Are you leaving your biases behind? | Recent decisions against earlier ones, with a verdict |
| B8 Crowd rule | The "wait for the crowd to move on" rule works on the indicator's units |

### Bias indicators: `test-indicators.js`

For each indicator a small world with the effect planted and one without it: the first must be found, the
second must not be. Indicators: rank effect (D4), repurchase regret (D6), overconfidence (E3), myopic loss
aversion (D5), ostrich effect (A5), confirmation bias (A6, A6c), herding (A7, A7c), survival (D2), 1/n and
sectors (E4), extrapolation (B3), lottery stocks (B4), anchoring (C4), target calibration (C5), home bias
(E5), volume-driven buying (B5), limited attention (A8), buying what the crowd buys (B6), and timed buys
against a savings plan (B7).

### AI service and privacy filters: `test-ai.js`

This suite runs the `ai-coach` function's own code (`supabase/functions/ai-coach/core.mjs`), the tools the
assistant may use, the browser client and the notes analysis, with a stand-in model.

| Case | Expected |
|---|---|
| AI1 Who may use it | No signed-in user: 401. With `AI_ALLOW_ALL=false`: an unlisted user 403, a listed e-mail or user id 200; `AI_ALLOW_ALL=true` opens it |
| AI2 Limits and bad input | Oversized request 413; invalid JSON 400; unknown task or missing version 400; the daily cap stops the call after the set number (429 `daily_cap`); a failing usage counter stops the call (500) instead of letting it through |
| AI3 Tool calls | Only tools from the fixed read-only catalogue; unknown tools and invalid arguments dropped, duplicates merged, at most four per step, numbers clamped to their range |
| AI4 What must not arrive | Raw trade data (amount keys, ISINs, e-mail addresses, links, long numbers, nested prices) is recognised by the server **and** the browser, which agree on the same corpus; a request whose results look like raw data is refused with 422 before any model sees it; aggregates, aliases ("Stock 4"), ratios and months pass; notes are redacted |
| AI5 A question cannot become an instruction | The question is placed inside a JSON string with quotes and line breaks escaped; the system prompt says to treat it as data and lists only real tools; whatever the question says, the plan can only name real tools; markup characters are stripped |
| AI6 The tools on a synthetic investor | A synthetic investor runs through every tool and several multi-step questions; no amount, ISIN, real ticker or exact date appears in anything sent |
| AI7 What the agents decided and why | The assistant's `get_agent_decisions` tool |
| AI8 Questions, answers and the agent loop | Multi-step questions run end to end against a local stand-in for the service, with the step task validated on the server |
| AI9 The AI agent's paper decisions (task `decide`) | Candidates and replies validated server-side: known ids, buy, wait or pass, days and sizes clamped |
| AI10 Weekly review, names, notes | The new tools, the weekly review and the real-names option; the analysis of the notes written with calls |

### The agents' paper portfolios: `test-shadow.js`

| Case | Expected |
|---|---|
| S1 No look-ahead | What happens after time t (prices, later trades, views, calls) does not change any decision the agent made before t, on a weekday calendar with community data and date-only buys |
| S2 Accounting | The paper portfolios' accounting |
| S3 Planted and null worlds | A chasing investor's world against a world with no effect |
| S4-S5 Looks; before and after first use | Decisions on a first look at a stock; results before and after the user's first live view |
| S6 The AI agent's request | The `decide` request, built with the stand-in provider |
| S7 Pre-trade check and crowd rule | The pre-trade check reads the last sale; the crowd rule is used once it holds up, and needs community data |
| S8 Speed | The run stays within its time budget |
| S9 Live moments | A look from the last two days is decided live; a repeat view in an unusual burst is a moment for hold, sell or buy more; the AI agent's looks line follows its own selling logic |
| S10 Two engines | The rules agent keeps its reasoning, and two engines can be compared on the same moments |
| S11 Paper portfolios | Weights, full investment and the two views on a hand-made world; the rules the user adopted are applied in every month; time-weighted indices; holdings over time stock by stock |

### Smaller suites

| Suite | Cases |
|---|---|
| `test-agent-session.js` | Views in several tabs and dwell pings form one session; due one minute after the last activity; a return within a few minutes continues it, a later return starts a new one; activity during a run makes it due again; stocks are separate and old sessions pruned; an unsure moment is asked again only when what the model is shown changed |
| `test-pricecache.js` | Cold start fetches once and keeps the series; a series stored from a later date does not cover an earlier start; a stale series asks only for the last days; a revised last close is saved without rebuilding reports; a split triggers a full refetch; fetch failures and a failing store never break loading |
| `test-headinfo.js` | Every headline of the signed-in dashboard has an information text (43 headlines) |

### Repository security properties: `test-repo.js`

| Area | Checks |
|---|---|
| Manifest (8) | Manifest V3; version x.y.z; only the reviewed permissions (`storage`, `unlimitedStorage`, `tabs`, `scripting`, `alarms`, `offscreen`, `identity`); required host permissions are specific https hosts, never a wildcard of everything; broad access only as an optional permission; content scripts only on declared https hosts; every referenced file exists; no relaxed content security policy |
| Packaging (4) | Every packaged item exists; no packaged page or script loads remote code; no file name starts with an underscore; the dashboard's content security policy allows own scripts only |
| Web app (5) | Every published path exists; server code, SQL, documentation, mobile and tools are not published; the deploy job runs only for `main`; both manifests are valid JSON |
| Database (5) | Migration names apply in date order; base schema present; **row-level security is enabled on every table**; **every SECURITY DEFINER function pins its search path**; every Edge Function has an entry file |
| Secrets (5) | No provider key, token or private key in any text file; no service-role JWT (the public anon key is allowed); no environment file, token file, local database or key store in the repository; the client config has no token-server URL or registration key; the sync server has no built-in default token |

The checks read files only; nothing from the repository is executed. A permission change fails the
manifest check on purpose, so that it is reviewed against the security assessment first.

### Sandbox server: `test-sandbox.js`

Starts `tools/sandbox.js` on a free local port and checks: it starts and redirects `/` to the sandbox page
keeping the query; the page is the dashboard plus the synthetic-investor scripts; responses are not
cached; the client config is replaced by an empty one so **no backend can be reached**; every local script
and style of the page is served; the page loads nothing from another host; files outside the dashboard's
needs (server code, SQL, documentation, workflows) answer 404; **path traversal is refused**; only GET
is accepted; the server does not listen on the machine's network interface.

## Manual walkthrough (sandbox)

Start `node tools/sandbox.js` and open <http://127.0.0.1:8780/?seed=21>. Zoom to 110% for legibility.
The evidence file `docs/hackathon/evidence/demo-run.md` reports a synthetic investor built with seed 21.

| # | Step | Expected |
|---|---|---|
| M1 | Open the page | A banner says this is a sandbox with a synthetic investor and that nothing leaves the computer; the "What your trades say about you" panel is filled |
| M2 | Coach panel, "Chasing price rises" | The bias is detected with its evidence; the rule "Wait after a run-up" is shown with its out-of-sample result next to the in-sample figure, which flatters |
| M3 | Scroll to the rules and the "Patterns to keep an eye on" list | Rules that did not hold up on later trades are not recommended and say so |
| M4 | Click "Adopt this rule" | The rule appears under "Your rules" |
| M5 | "Your rules": adherence | Shows how often the rule was broken since adoption against before, and the results of decisions that kept it against those that broke it, described as an association |
| M6 | "Check a buy before you place it" | A stock and a size are held against the adopted rules and reminders; the verdict names the rule that fires |
| M7 | Click the floating "Assistant" button | The side panel opens with a consent card listing what is sent and what never leaves the device; nothing is sent before the consent is given |
| M8 | Turn it on and ask "Why do my buys after a rise do worse?" | The answer names the tools it asked for, which ran on the device; "Based on" and "Show the results this answer is based on" show the aggregates; numbers not found in the results are marked |
| M9 | Open "What was sent" | Every request, tool run and answer with the exact body; stocks are "Stock 1", "Stock 2"; no amounts, ISINs or exact dates; downloadable |
| M10 | Open `?persona=fomo`, then `first_hour`, `night_trader`, `yolo`, `herd` | Each banner names one planted habit and the coach names that habit and no other (see the table in `docs/hackathon/evidence/personas/README.md`) |
| M11 | `node tools/demo-run.js` in a terminal | Regenerates the evidence report; the scan of everything sent finds no amount, ISIN, ticker or exact date |

## Reproducing the execution evidence

`node tools/demo-run.js` and `node tools/persona-runs.js` rebuild the files under
`docs/hackathon/evidence/` from seeded synthetic investors: the report, the operation logs
(`operations.jsonl`), the broker CSV per account and the robustness table over ten seeds. They overwrite the
files in place, so a diff shows whether anything changed. With a model key, `demo-run.js --live` repeats the
demo on a real model.

## What the tests do not cover

- The statistics are validated on synthetic investors, not on a population of real investors.
- No live model is called by the automated tests; `tools/compare-models.js` does that
  with an OpenRouter or Cerebras key.
- The user interface is checked by the walkthrough above, not by browser automation; the headline test is
  the only automated check of the page.
- Database policies are checked statically (row-level security present, search paths pinned); they are not
  executed against a running Postgres here.
- The mobile app and the optional token server have no automated tests.

## Adding a test

Each suite is a plain Node script: `const ok = (cond, message) => { if (!cond) failed++; console.log((cond ? "PASS " : "FAIL ") + message); };`,
no framework, and `process.exit(1)` if anything failed. Add the file to the list at the top of
`tools/run-tests.js` and to this document.
