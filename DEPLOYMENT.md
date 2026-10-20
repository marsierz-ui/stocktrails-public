# Running Stocktrails for evaluation

Two ways to test it. Each stands alone.

| | Path | Time | You need | What you can verify |
|---|---|---|---|---|
| A | [Sandbox](#a-sandbox-recommended) | 5 min | Node.js 22+ | The whole agent flow on synthetic investors: findings, rules, adoption, adherence, pre-trade check, the assistant, both agents. Offline, no account, no key |
| B | [Extension and hosted web app](#b-extension-and-hosted-web-app) | 10 min | A Chromium browser, a Google account | Real capture on finance portals, the label card, the dashboard, sync |

The automated tests and a step-by-step manual walkthrough are in [TESTING.md](TESTING.md).

---

## A. Sandbox (recommended)

The real dashboard on a generated investor. It needs **Node.js 22 or newer** and nothing else: no
install, no account, no key, no network. It listens on `127.0.0.1` only, can reach no backend, and the
AI service's own code runs in the page with a stand-in model.

```bash
git clone <repository link from the submission e-mail>
cd attention-tracker
node tools/sandbox.js            # then open http://127.0.0.1:8780/
```

Variations, as query parameters on the address: `?seed=22` (another investor),
`?persona=fomo` (also `first_hour`, `night_trader`, `yolo`, `herd`: an investor with exactly one planted
habit), `?engines=1` (made-up text and decision models for the AI agent). `--port 9000` changes the port.

---

## B. Extension and hosted web app

Both talk to the project's hosted backend. Capture starts only after sign-in; before it nothing is
recorded.

1. **Web app:** open <https://marsierz-ui.github.io/attention-tracker/> and sign in (Google, or e-mail
   and password).
2. **Extension:** in the cloned repository, open `chrome://extensions`, enable Developer mode, choose
   Load unpacked and select the repository folder (Chrome, Edge, Brave or another Chromium browser). Open
   the dashboard from the toolbar icon and sign in.
3. Visit a stock page, for example `https://finance.yahoo.com/quote/AAPL`. The event appears in the
   dashboard; use the label card on the page to record an outlook, a target and a rationale.
4. In **My Habits, Trades & research** import a broker file. Each `trades.csv` of the simulated investors
   (`docs/hackathon/evidence/personas/<account>/trades.csv`) can be imported as a generic CSV.
5. The assistant (side panel "Assistant") and the AI agent need consent in the app and an AI service that
   is switched on for your account on the hosted backend. If it is not, use path A, which runs the same
   code.

Imported trades stay in your browser and are removed by "Delete all". Everything else you create is
stored under your own account.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| The extension loads but records nothing | Capture starts only after sign-in: open the dashboard from the toolbar icon and sign in, then reload the stock page |
| Prices show `-` | Yahoo's public endpoint rate-limited the request; retry in a few minutes |
| The assistant or the AI agent is unavailable in the hosted app | The AI service is not switched on for your account there. Use path A, which runs the same code on a stand-in model |
| The hosted web app or sign-in does not respond | The hosted backend may be temporarily unavailable. Path A needs no backend |
| `node` reports syntax errors on start | Node.js older than 22; install a current release |
| The sandbox port is busy | `node tools/sandbox.js --port 9000` |
