# The FOMO buyer (synthetic, seed 21)

Planted habit: Buys after a stock has risen: on average +12% in the 20 days before the buy; every +10% of rise costs 7 points over the next month.

- Account: `sandbox-fomo-21`, 140 buys, 86 sells, 458 page views, 174 calls, 2024-05-11 to 2026-07-19.
- Buys carrying the habit: 47 of 140 (34%).
- Import: `trades.csv` read as format `generic`, 226 trades, round trip exact.

## What the system found

| Bias | Tier | Signal | Rule | Out of sample | Flagged | Gain per flagged buy (99% range) |
|---|---|---|---|---|---|---|
| FOMO (chasing rises) (planted) | detected | Buys made after the price had risen since your first look did -11.5 pts against those made after a fall. | Wait after a run-up | supported | 9 of 70 | +10.3 pts (+4.9 pts to +15.3 pts) |
|  |  |  | Wait after strong market stretches | unclear | 10 of 70 | +3.9 pts (-2.0 pts to +10.0 pts) |
| First-hour impulse | none | - | - | - | - | - |
| Night buying | none | - | - | - | - | - |
| YOLO in turbulent markets | none | - | - | - | - | - |
| Herd (crowd buys) | none | - | - | - | - | - |

Tiers: `detected` = a statistical signal is clear; `watch` = a signal, not yet clear; `rules` = no signal, but a rule for it was fitted; `none` = nothing shown. A rule is fitted on earlier trades and judged on later ones (walk-forward with an embargo); `supported` = its 99% range is above zero.

Rule the coach would offer: "Do not buy a stock that has already risen more than 15% in the last 30 days. Wait for a pullback, or skip it."

Rule the coach would offer: "Do not buy right after one of the market's strongest stretches: its return over the last 20 days in the top 20% of days (above about 4.3%)."

Files: `trades.csv` (broker export, generic template), `operations.jsonl` (one JSON object per operation, in time order; orders carry the habit's ground truth in `planted`).
