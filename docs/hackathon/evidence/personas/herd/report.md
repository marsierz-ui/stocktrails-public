# Follow the throng (synthetic, seed 21)

Planted habit: 35% of buys come right after a spike in other users' attention on the stock; those buys do 8 points worse over the next month.

- Account: `sandbox-herd-21`, 140 buys, 86 sells, 458 page views, 174 calls, 2024-05-11 to 2026-07-19.
- Buys carrying the habit: 38 of 140 (27%).
- Import: `trades.csv` read as format `generic`, 226 trades, round trip exact.

## What the system found

| Bias | Tier | Signal | Rule | Out of sample | Flagged | Gain per flagged buy (99% range) |
|---|---|---|---|---|---|---|
| FOMO (chasing rises) | none | - | - | - | - | - |
| First-hour impulse | none | - | - | - | - | - |
| Night buying | rules | - | Avoid your worst time of day | supported | 15 of 70 | +4.0 pts (+0.1 pts to +8.3 pts) |
| YOLO in turbulent markets | none | - | - | - | - | - |
| Herd (crowd buys) (planted) | detected | 37% of your buys came while other Stocktrails users were piling into the stock; by each stock's own rate, chance would give 10%. | Wait for the crowd to move on | supported | 18 of 70 | +4.9 pts (+0.3 pts to +9.1 pts) |

Tiers: `detected` = a statistical signal is clear; `watch` = a signal, not yet clear; `rules` = no signal, but a rule for it was fitted; `none` = nothing shown. A rule is fitted on earlier trades and judged on later ones (walk-forward with an embargo); `supported` = its 99% range is above zero.

Rule the coach would offer: "Do not buy a stock while other Stocktrails users look at it more than 3x as often as usual (the last 3 days against the month before). Wait until the crowd's attention fades."

Files: `trades.csv` (broker export, generic template), `operations.jsonl` (one JSON object per operation, in time order; orders carry the habit's ground truth in `planted`).
