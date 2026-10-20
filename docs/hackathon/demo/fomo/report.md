# Demo account: fomo (seed 6)

Made-up investor, real tickers and real Yahoo closes. Habit: Buys after a stock has already run up: about 60% of buys come after a rise of 10% or more in the 20 trading days before, on stocks first looked at before the rise.

- 90 buys, 53 sells, 2024-10-22 to 2026-10-15.
- Buys carrying the habit: 48 of 90.
- trades.csv read as `generic`, 143 trades. History.json: 1444 entries, 361 stock-page visits on 37 tickers.

## What the analysis found

| Bias | Tier | Signal |
|---|---|---|
| Chasing price rises | detected | Buys made after the price had risen since your first look did -6.5 pts against those made after a fall. |
| Trading more than your information supports | watch | You turn over 265% of your depot a year; the average private investor in Barber & Odean's data turned over about 75%. |

| Rule | Bias | Out of sample | Flagged | Gain per flagged buy |
|---|---|---|---|---|
| Wait after a run-up | chasing | unsupported | 21 of 44 | -5.5 pts |
| Avoid your worst time of day | bad_hour | unsupported | 21 of 44 | -1.2 pts |
| Pause in turbulent markets | turbulence | untested | 3 of 44 | - |
| Research before you buy | no_research | unclear | 17 of 44 | 4.6 pts |
| No quick switches | overconfidence | unclear | 11 of 38 | 5.5 pts |
| Do not buy the recent top performers | extrapolation | unsupported | 11 of 40 | -2.5 pts |
| Keep lottery stocks small | lottery | untested | 6 of 13 | - |
| Size a buy by how much you looked at it | size_vs_conviction | unclear | 15 of 43 | 2.6 pts |

Prices are real, so the result is whatever these stocks really did after the buys: a planted habit is not guaranteed to cost money here, unlike the sandbox personas.
