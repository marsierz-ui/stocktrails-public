# Control investor (synthetic, seed 21)

Planted habit: No planted habit: every buy's return is market plus noise.

- Account: `sandbox-control-21`, 140 buys, 86 sells, 458 page views, 174 calls, 2024-05-11 to 2026-07-19.
- No planted habit.
- Import: `trades.csv` read as format `generic`, 226 trades, round trip exact.

## What the system found

| Bias | Tier | Signal | Rule | Out of sample | Flagged | Gain per flagged buy (99% range) |
|---|---|---|---|---|---|---|
| FOMO (chasing rises) | none | - | - | - | - | - |
| First-hour impulse | none | - | - | - | - | - |
| Night buying | none | - | - | - | - | - |
| YOLO in turbulent markets | none | - | - | - | - | - |
| Herd (crowd buys) | none | - | - | - | - | - |

Tiers: `detected` = a statistical signal is clear; `watch` = a signal, not yet clear; `rules` = no signal, but a rule for it was fitted; `none` = nothing shown. A rule is fitted on earlier trades and judged on later ones (walk-forward with an embargo); `supported` = its 99% range is above zero.

Files: `trades.csv` (broker export, generic template), `operations.jsonl` (one JSON object per operation, in time order; orders carry the habit's ground truth in `planted`).
