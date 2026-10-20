# The YOLO trader (synthetic, seed 21)

Planted habit: Buys in turbulent markets are 2.5x the usual size and do 8 points worse over the next month.

- Account: `sandbox-yolo-21`, 140 buys, 86 sells, 458 page views, 174 calls, 2024-05-11 to 2026-07-19.
- Buys carrying the habit: 78 of 140 (56%).
- Import: `trades.csv` read as format `generic`, 226 trades, round trip exact.

## What the system found

| Bias | Tier | Signal | Rule | Out of sample | Flagged | Gain per flagged buy (99% range) |
|---|---|---|---|---|---|---|
| FOMO (chasing rises) | watch | Buys made after the price had risen since your first look did -0.2 pts against those made after a fall. | Wait after a run-up | untested | 5 of 70 | - |
|  |  |  | Wait after strong market stretches | supported | 10 of 70 | +3.2 pts (+0.1 pts to +6.8 pts) |
| First-hour impulse | rules | - | Sleep on it | indicative | 24 of 57 | +2.7 pts (-0.3 pts to +5.7 pts) |
| Night buying | rules | - | Avoid your worst time of day | indicative | 15 of 70 | +5.3 pts (-0.0 pts to +10.2 pts) |
| YOLO in turbulent markets (planted) | rules | - | Pause in turbulent markets | indicative | 26 of 70 | +3.2 pts (-0.6 pts to +7.1 pts) |
|  |  |  | Cap the size in turbulent markets | supported | 19 of 68 | +1.7 pts (+0.2 pts to +3.1 pts) |
| Herd (crowd buys) | none | - | - | - | - | - |

Tiers: `detected` = a statistical signal is clear; `watch` = a signal, not yet clear; `rules` = no signal, but a rule for it was fitted; `none` = nothing shown. A rule is fitted on earlier trades and judged on later ones (walk-forward with an embargo); `supported` = its 99% range is above zero.

Rule the coach would offer: "Do not buy while the market is as turbulent as on the most turbulent 33% of days (volatility above about 23% a year)."

Rule the coach would offer: "When the market is as turbulent as on the most turbulent 33% of days (volatility above about 23% a year), keep a buy to at most 1x your usual buy."

Files: `trades.csv` (broker export, generic template), `operations.jsonl` (one JSON object per operation, in time order; orders carry the habit's ground truth in `planted`).
