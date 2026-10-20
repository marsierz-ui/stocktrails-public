# The night trader (synthetic, seed 21)

Planted habit: About half of the buys are placed at 22:00 or later, after the market has closed; those buys do 8 points worse over the next month.

- Account: `sandbox-night_trader-21`, 140 buys, 86 sells, 458 page views, 174 calls, 2024-05-11 to 2026-07-19.
- Buys carrying the habit: 68 of 140 (49%).
- Import: `trades.csv` read as format `generic`, 226 trades, round trip exact.

## What the system found

| Bias | Tier | Signal | Rule | Out of sample | Flagged | Gain per flagged buy (99% range) |
|---|---|---|---|---|---|---|
| FOMO (chasing rises) | watch | Buys made after the price had risen since your first look did -0.0 pts against those made after a fall. | - | - | - | - |
| First-hour impulse | none | - | - | - | - | - |
| Night buying (planted) | detected | Buys placed in the night (18-4 h) did -8.5 pts against your other buys. | Avoid your worst time of day | supported | 36 of 70 | +5.1 pts (+2.9 pts to +7.7 pts) |
| YOLO in turbulent markets | none | - | - | - | - | - |
| Herd (crowd buys) | none | - | - | - | - | - |

Tiers: `detected` = a statistical signal is clear; `watch` = a signal, not yet clear; `rules` = no signal, but a rule for it was fitted; `none` = nothing shown. A rule is fitted on earlier trades and judged on later ones (walk-forward with an embargo); `supported` = its 99% range is above zero.

Rule the coach would offer: "Do not place buys in the night (22-6 h on your clock). Decide then if you like, and place the order at another time."

Files: `trades.csv` (broker export, generic template), `operations.jsonl` (one JSON object per operation, in time order; orders carry the habit's ground truth in `planted`).
