// Paste into the DevTools console of the Stocktrails dashboard (My Habits > Trades & research open), then copy the
// printed JSON back. Read-only: it changes nothing and sends nothing. Set NAME to the stock to check.
(function () {
  const NAME = /nebius/i;
  const S = TR.agent.S, A = TR.agent.input || trAgentInput(), R = TR.report;
  const inst = Object.keys(TR.links).filter(function (k) { const l = TR.links[k]; return NAME.test((l.name || "") + " " + (l.ticker || "") + " " + k); });
  const out = { insts: inst.map(function (k) { const l = TR.links[k]; return { inst: k, ticker: l.ticker, symbol: l.symbol, status: l.status }; }) };
  inst.forEach(function (k) {
    const l = TR.links[k], s = l.symbol ? TR.prices[l.symbol] : null;
    out[k] = {
      txs: TR.txs.filter(function (t) { return (t.isin || t.symbol) && (t.isin === k || D_inst(t) === k); }).map(function (t) { return [t.date, t.kind, t.qty, t.amount, t.currency, t.priceCcy || null, t.auto ? "auto" : ""]; }),
      decisions: R.decisions.filter(function (d) { return d.inst === k; }).map(function (d) { return [d.date, d.side, d.qty, d.amount, d.currency, d.auto ? "auto" : "", d.excluded || "", d.assetClass || ""]; }),
      series: s ? { n: s.length, currency: s.currency || null, first: s[0], last: s[s.length - 1], mid: s[Math.floor(s.length / 2)] } : null,
      candidates: S ? S.trades.candidates.filter(function (c) { return c.inst === k; }).length : null
    };
  });
  function D_inst(t) { return ATDecisions.instKey(t); }
  if (S && S.agents && S.agents.trades) {
    const H = S.agents.trades.holdings, k = H.dates.length - 1;
    out.lastHoldings = { date: H.dates[k], you: Object.keys(H.you[k].stocks).sort(function (a, b) { return H.you[k].stocks[b] - H.you[k].stocks[a]; }).slice(0, 8).map(function (t) { return [t, Math.round(H.you[k].stocks[t] * 1000) / 10]; }) };
    out.currency = S.agents.currency;
  }
  out.fx = Object.keys(A.fx || {}).map(function (c) { return c + ":" + (A.fx[c] || []).length; });
  out.version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || null;
  out.code = typeof trAgentFx === "function" && typeof ATShadow.agentPortfolios === "function" && /plans/.test(ATShadow.agentPortfolios.toString()) ? "current" : "old";
  const txt = JSON.stringify(out);
  console.log(txt);
  try { copy(txt); console.log("Copied to the clipboard."); } catch (e) { /* copy() only in DevTools */ }
})();
