# Demo video script (5 minutes)

Record the sandbox (`node tools/sandbox.js`, open http://127.0.0.1:8780/). It needs
no account and shows no real data. Zoom the browser to 110% for legibility.

| Time | Screen | Say |
|---|---|---|
| 0:00 | Sandbox banner and the "What your trades say about you" panel | "This is Stocktrails on a synthetic investor. It compares what you research with what you buy. Today: an agent that finds your biases, checks its own advice, and explains it." |
| 0:25 | Coach panel, "Chasing price rises" | "The statistics found this. The rule: do not buy a stock that has already risen more than a set limit in the last 30 days, in short, wait for a pullback. The check: fitted on earlier trades, applied to later ones it had not seen: plus 16 points per flagged decision, 99 percent range 11 to 22. In sample it looked about the same, so it is not an artefact." |
| 1:00 | Scroll to a rule with "Did not hold up" or the "Patterns to keep an eye on" list | "Rules that look good on the past but fail on later trades are not recommended. In worlds with no effect, none of 216 was." |
| 1:25 | Click "Adopt this rule" | "Adopting is a click. The assistant can only propose." |
| 1:45 | Your rules: adherence | "Since adoption, the rule was broken 27 percent of the time against 33 before. Decisions that kept it did better than those that broke it. That is an association, and the page says so." |
| 2:15 | Check a buy before you place it | "Before a buy: it measures the stock and the market now and holds them against the adopted rules." |
| 2:45 | Click the floating "Assistant" button: the side panel opens. Turn it on (show the consent card), ask "Why do my buys after a rise do worse?" | "It is optional. The card lists what leaves and what never does." Show the answer, "Based on", then "Show the results this answer is based on". "It asked for one tool. The tool ran on this device. These aggregates are all it saw." |
| 3:30 | "What was sent" | "Every request and answer, exact bodies, downloadable. Stocks are Stock 1, Stock 2. No amounts, no ISINs, dates by month." |
| 4:00 | Terminal: `node tools/demo-run.js` output, the scan table | "The scan of everything sent: nothing found. Tests: 105, 39 and 150 checks pass." |
| 4:30 | Chips: "How well do I keep my rules?" | "Same agent, another question." |
| 4:50 | End card | "Two agents decide on the same statistics: the rules agent is deterministic, the AI agent is stochastic. Tests included." |

Habit accounts (optional, about a minute): open `http://127.0.0.1:8780/?persona=fomo`, then
`first_hour`, `night_trader`, `yolo` and `herd`. Each is a synthetic investor with one planted
habit; show the banner and the coach card that names it. Close on the robustness table in
[evidence/personas/README.md](evidence/personas/README.md).

If a live key is available, run the same questions with `node tools/demo-run.js --live`
and show that the answers are in the model's words while the numbers still match the results.
