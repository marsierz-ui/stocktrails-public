# Deck outline (10 minutes)

Order follows the scoring: show tasks completed (40%), then security and compliance
(30%), then what is new (30%). Put the numbers on the slides; the evidence file has them.

1. **The problem (0:45).** Retail investors lose to their own habits more than to the market. Advice tools tell them what to buy; none checks whether its advice would have worked on trades it had not seen, or whether the investor kept it.
2. **What the agent does (0:45).** Recognise the bias, recommend a rule, check it out of sample, let the user adopt it, track whether it is kept, check a buy before it is placed, explain in plain language. Seven tasks, all on the investor's own data.
3. **Demo part 1 (1:30).** Sandbox: the findings panel and the coach. A bias with its evidence; its rule; "Held up out of sample: +16.3 points per flagged decision (99% range +10.8 to +21.5), in sample +14.2".
4. **How a rule is judged (1:00).** Fit on the past, apply to the next block, repeat; an embargo for trades whose outcome was not known yet. Show the table of rules; mention the 0 of 216 in worlds with no effect.
5. **Demo part 2 (1:30).** Adopt a rule; adherence ("broke it 27% of the time, 33% before; kept: -10.1, broke: -17.0, difference +7.0 points"); check a buy before placing it.
6. **The assistant (1:15).** Open the side panel ("Assistant") and ask "Why do my buys after a rise do worse?". Show: the tools it asked for, the results, the answer, the number check, "Show the results this answer is based on".
7. **Security by construction (1:15).** What leaves (aggregates, "Stock 3", ratios, months) and what never does; the three tiers; deny-by-default; the log "What was sent"; the scan table (nothing found in 10 requests).
8. **Compliance and responsible use (0:45).** Consent, no advice, human in the loop, provider terms handled (free tier only for demo data; paid for real users), kill switch.
9. **What is new (0:45).** (a) Advice that is validated on unseen trades. (b) A timing test that respects how markets and buying cluster. (c) A privacy filter that is tested, not promised. (d) Adherence closes the loop.
10. **Limits and next (0:30).** Validated on synthetic investors, not yet on a population; the live API check; end-to-end encrypted sync is the next step before anything leaves the device in bulk; pre-trade reminder on the broker's order page.

Speaker notes: say once, early, that two agents decide in parallel on the same statistics: the
rules agent is deterministic, the AI agent is stochastic. Do not
claim the rules make money; claim they are checked before they are recommended.
