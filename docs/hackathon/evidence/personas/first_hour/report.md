# The first-hour impulse buyer (synthetic, seed 21)

Planted habit: 40% of buys come within an hour of first looking at the stock; those buys do 9 points worse over the next month.

- Account: `sandbox-first_hour-21`, 140 buys, 90 sells, 438 page views, 181 calls, 2024-05-11 to 2026-07-19.
- Buys carrying the habit: 56 of 140 (40%).
- Import: `trades.csv` read as format `generic`, 230 trades, round trip exact.

## What the system found

| Bias | Tier | Signal | Rule | Out of sample | Flagged | Gain per flagged buy (99% range) |
|---|---|---|---|---|---|---|
| FOMO (chasing rises) | none | - | - | - | - | - |
| First-hour impulse (planted) | detected | 24% of your timed decisions came within an hour of your first look; impulse buys did -9.2 pts against the ones you had looked at for a week or more. | Sleep on it | supported | 23 of 63 | +5.9 pts (+2.0 pts to +9.8 pts) |
| Night buying | none | - | - | - | - | - |
| YOLO in turbulent markets | none | - | - | - | - | - |
| Herd (crowd buys) | none | - | - | - | - | - |

Tiers: `detected` = a statistical signal is clear; `watch` = a signal, not yet clear; `rules` = no signal, but a rule for it was fitted; `none` = nothing shown. A rule is fitted on earlier trades and judged on later ones (walk-forward with an embargo); `supported` = its 99% range is above zero.

Rule the coach would offer: "Sleep on it: wait at least 1 hour between first looking at a stock and buying it."

Files: `trades.csv` (broker export, generic template), `operations.jsonl` (one JSON object per operation, in time order; orders carry the habit's ground truth in `planted`).
