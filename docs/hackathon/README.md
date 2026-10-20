# FinTechathon 2026, International Track: submission

Theme: "AI as a Financial Participant". Deadline: 20 Oct 2026, 23:59 Beijing time
(16:00 UTC). Scoring: task completion 40%, security and compliance 30%, innovation
and interaction 30%. Issue: #18.

## What it is

Stocktrails records which stocks an investor researches and compares that with what
they then buy and sell (broker exports are imported on the device). This submission
adds a behavioural finance agent on top:

1. It **recognises** the investor's own biases with statistical tests, not opinions (chasing price rises, impulse buying, buying at a bad time of day, oversized buys in turbulent markets, not acting on one's own calls, ignoring one's targets, buying without research).
2. It **recommends a concrete rule** for each and checks, before recommending it, whether the rule **would have improved results out of sample** (fitted on the past, judged on later trades it had not seen).
3. The investor **adopts** a rule with a click. The agent then **tracks adherence** and compares the results of decisions that kept the rule with those that broke it, and can **check an intended buy** against the adopted rules before it is placed.
4. An **assistant agent** answers questions about the investor's data in up to five steps, looking further when a first result raises a question. It can only name read-only tools that run on the device; it never sees trades, and every number in its answer is checked against the results. It **proposes actions** (adopt, retire or retune a rule, a pre-trade reminder for a stock, a review note) as cards that happen only on the investor's click.
5. A **weekly review** with an attention report (research against the week before, spikes of interest, held stocks not looked at, calls, trades, rules broken), worked out on the device.
6. The **notes written with calls** are classified by the assistant (once each, redacted) and joined to how the calls turned out.

Topic: A (Personal Finance Assistant: insights and actionable recommendations from the user's own transactions), confirmed by the team. It also covers parts of B (explainable, compliant suggestions; risk profiling from behaviour).

## Deliverables

| Required | Where |
|---|---|
| Technical documentation (architecture, core algorithms, security design) | [TECHNICAL.md](TECHNICAL.md), [../AI.md](../AI.md), [../../ARCHITECTURE.md](../../ARCHITECTURE.md) section 8b and 8c |
| Presentation deck (10 minutes) | [DECK.md](DECK.md) (outline and speaker notes) |
| Demo video (5 minutes, optional) | [VIDEO.md](VIDEO.md) (script, uses the sandbox) |
| Source code with README, deployment instructions, test cases | the repository: [README](../../README.md); deployment below; tests below |
| Security self-assessment: permission tiers and known-risk list (AI layer and whole product) | [SECURITY.md](SECURITY.md) |
| Execution evidence: sandbox logs and demo | [evidence/demo-run.md](evidence/demo-run.md) and [evidence/demo-run.json](evidence/demo-run.json) |
| Execution evidence: five investor habits (FOMO, first-hour impulse, night trader, YOLO, herd), per account a broker CSV and an operation log | [evidence/personas/README.md](evidence/personas/README.md) |

## Try it in five minutes (no account, no key, no network)

Needs Node 22 or newer. Nothing is installed.

```
node tools/sandbox.js            # then open http://127.0.0.1:8780/
node tools/demo-run.js           # regenerates the execution evidence
node tools/persona-runs.js       # five habit accounts: CSV, operation log, findings, robustness
node tools/test-trades.js        # 105 checks: broker import, decision analytics
node tools/test-biases.js        # 39 checks: bias coach, out-of-sample validation, adherence
node tools/test-ai.js            # 150 checks: AI layer, privacy filters, tools
```

The sandbox is the real dashboard on a synthetic investor. The assistant runs the
ai-coach function's own code in the page with a stand-in model, so the whole flow
(consent, questions, tools, "What was sent", adopting a rule, checking a buy) works
offline.

## Deployment

1. `supabase/migrations/20261010_ai_usage.sql` (a table and a function, additive).
2. `supabase secrets set AI_PROVIDER=openrouter OPENROUTER_API_KEY=... AI_MODEL=<vendor/model> AI_ALLOWED_USERS=<demo user ids or e-mails>` (empty means nobody).
3. `supabase functions deploy ai-coach` (JWT verification stays on). `AI_PROVIDER=mock` runs it without a key.
4. The web app deploys from `main` through GitHub Pages; the extension through the Chrome Web Store workflow. The submission does not need either: the sandbox is enough.

Details and the free-tier restrictions: [../AI.md](../AI.md).

## Honest limits

- The statistics were validated on synthetic investors with planted effects, and on worlds with no effect (0 of 216 rules recommended). They have not been validated on a population of real investors.
- The sample sizes needed are real: a rule needs about 24 decisions with a known outcome before it is tested, and 8 flagged out of sample before it can be called supported.
- Team eligibility (overseas students, at least 60% non-Chinese members) is confirmed by the team.
