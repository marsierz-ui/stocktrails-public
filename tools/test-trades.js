// Tests for the broker import, the decision analytics and the history reader.
// Synthetic data only. Run: node tools/test-trades.js (exit code 1 on failure).
const path = require("path");
const L = require(path.join(__dirname, "..", "src", "ledger.js"));
const D = require(path.join(__dirname, "..", "src", "decisions.js"));
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? "PASS " : "FAIL ") + m); };
// --- parsers on synthetic files ---
const sc = "date;time;status;reference;description;assetType;type;isin;shares;price;amount;fee;tax;currency\n" +
  "2024-10-23;13:10:35;Executed;\"SCAL1\";\"Uranium Energy Co\";Security;Buy;US9168961038;80;7,34;-587,20;0,00;0,00;EUR\n" +
  "2024-10-24;09:00:00;Cancelled;\"SCAL2\";\"Uranium Energy Co\";Security;Buy;US9168961038;80;7,34;-587,20;0,00;0,00;EUR\n" +
  "2024-11-01;10:00:00;Executed;\"SCAL3\";\"MSCI World\";Security;Savings plan;IE00B4L5Y983;1,234;81,03;-100,00;0,00;0,00;EUR\n" +
  "2024-12-01;10:00:00;Executed;\"SCAL4\";\"Uranium Energy Co\";Security;Sell;US9168961038;-80;8,10;648,00;0,99;12,30;EUR\n" +
  "2024-12-15;10:00:00;Executed;\"SCAL5\";\"Cash\";Cash;Deposit;;;;1000,00;;;EUR\n";
let r = L.parseFile(sc);
ok(r.format === "scalable" && r.counts.buy === 2 && r.counts.sell === 1, "scalable counts " + JSON.stringify(r.counts) + " skipped " + JSON.stringify(r.skipped));
ok(r.txs[0].price === 7.34 && r.txs[0].amount === 587.2 && Math.abs(r.txs[1].qty - 1.234) < 1e-9 && r.txs[1].plan, "scalable decimal comma + plan flag");
ok(r.txs[0].ts === Date.parse("2024-10-23T11:10:35Z"), "scalable Berlin time -> UTC (CEST)");
const dg = "Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value,,Exchange rate,Transaction and/or third,,Total,,Order ID\n" +
  "15-03-2024,15:42,APPLE INC,US0378331005,NDQ,XNAS,10,172.50,USD,-1725.00,USD,-1590.12,EUR,1.0848,-2.00,EUR,-1592.12,EUR,abc-123\n" +
  "20-04-2024,10:01,APPLE INC,US0378331005,NDQ,XNAS,-4,165.00,USD,660.00,USD,618.70,EUR,1.0667,-1.00,EUR,617.70,EUR,abc-456\n";
r = L.parseFile(dg);
ok(r.format === "degiro" && r.counts.buy === 1 && r.counts.sell === 1 && r.txs[1].qty === 4 && r.txs[0].fee === 2 && r.txs[0].amount === 1592.12, "degiro positional " + JSON.stringify(r.counts));
const dgNl = "Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Lokale waarde,,Waarde,,Wisselkoers,Transactiekosten en/of,,Totaal,,Order ID\n" +
  "15-03-2024,15:42,APPLE INC,US0378331005,NDQ,XNAS,10,\"172,50\",USD,\"-1725,00\",USD,\"-1590,12\",EUR,\"1,0848\",\"-2,00\",EUR,\"-1592,12\",EUR,abc-123\n";
r = L.parseFile(dgNl);
ok(r.format === "degiro" && r.txs[0].price === 172.5 && r.txs[0].amount === 1592.12, "degiro Dutch decimal comma");
const acct = "Datum,Tijd,Valutadatum,Product,ISIN,Omschrijving,FX,Mutatie,,Saldo,,Order Id\n19-12-2022,18:33,19-12-2022,,,iDEAL Deposit,,EUR,\"27,80\",EUR,\"1,35\",\n";
ok(/Account statement/.test(L.sniff(acct).reason || ""), "degiro account statement gets a pointer: " + L.sniff(acct).reason);
const act = "Statement,Header,Field Name,Field Value\nStatement,Data,Title,Activity Statement\n" +
  "Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n" +
  "Trades,Data,Order,Stocks,USD,AAPL,\"2024-03-15, 10:30:00\",10,172.5,173,-1725,-1,1726,0,5,O\n" +
  "Trades,SubTotal,,Stocks,USD,AAPL,,10,,,-1725,-1,1726,0,5,\n" +
  "Dividends,Header,Currency,Date,Description,Amount\nDividends,Data,USD,2024-05-16,AAPL(US0378331005) Cash Dividend USD 0.25 per Share (Ordinary Dividend),2.5\nDividends,Data,Total,,,2.5\n" +
  "Financial Instrument Information,Header,Asset Category,Symbol,Description,Conid,Security ID,Listing Exch,Multiplier,Type,Code\n" +
  "Financial Instrument Information,Data,Stocks,AAPL,APPLE INC,265598,US0378331005,NASDAQ,1,COMMON,\n";
r = L.parseFile(act);
ok(r.counts.buy === 1 && r.counts.dividend === 1 && r.txs[0].isin === "US0378331005" && r.txs[0].ts === Date.parse("2024-03-15T14:30:00Z"), "ibkr activity statement " + JSON.stringify(r.counts));
const gen = "date,type,isin,symbol,name,quantity,price,amount,fee,tax,currency\n2024-01-05,buy,US0378331005,AAPL,Apple,3,185.2,555.6,1,0,USD\n2024-02-01,dividend,US0378331005,AAPL,Apple,,,0.72,0,0.11,USD\n";
r = L.parseFile(gen);
ok(r.format === "generic" && r.counts.buy === 1 && r.counts.dividend === 1, "generic template");
const unk = "Run Date,Action,Symbol,Security Description,Quantity,Price ($),Amount ($)\n01/05/2024,YOU BOUGHT APPLE INC (AAPL),AAPL,APPLE INC,3,185.20,-555.60\n";
const sn = L.sniff(unk);
ok(sn.format === null, "unknown format refused: " + sn.reason);
const pv = L.previewColumns(unk), gm = L.guessMapping(pv.header);
r = L.parseFile(unk, { mapping: gm, headerRow: pv.headerRow, dateOrder: "mdy" });
ok(r.counts.buy === 1 && r.txs[0].date === "2024-01-05" && r.txs[0].qty === 3, "mapped CSV " + JSON.stringify(gm) + " " + JSON.stringify(r.counts));
ok(L.parseFile(gen).txs[0].extId === L.parseFile(gen).txs[0].extId, "content hash ids are stable");
// --- name similarity ---
[["NVIDIA Corp.", "NVIDIA Corporation", "same"], ["Siemens AG Namens-Aktien", "Siemens Aktiengesellschaft", "likely"],
 ["Alphabet Inc. Cl.A", "Alphabet Inc.", "same"], ["Taiwan Semiconductor Manufacturing Co. Ltd. (Sp.ADRs)", "Taiwan Semiconductor Manufacturing Company Limited", "same"],
 ["Apple Inc.", "Apple Hospitality REIT, Inc.", "different"], ["Boeing Co.", "BAE Systems plc", "different"], ["Meta Platforms Inc. Class A", "Meta Platforms, Inc.", "same"],
 ["Intl Business Machines", "International Business Machines Corporation", "same"], ["Uranium Energy Co", "Uranium Energy Corp.", "same"],
 ["SAP SE", "SAP SE", "same"], ["Alibaba Group Holding Ltd. (Sp.ADRs)", "Alibaba Group Holding Limited", "same"]
].forEach(([a, b, want]) => { const s = L.nameSimilarity(a, b); ok(L.nameVerdict(s) === want || (want === "likely" && s >= 0.6), `name "${a}" ~ "${b}" = ${s.toFixed(2)} (${L.nameVerdict(s)}, want ${want})`); });
// --- decisions on a synthetic world ---
const DAY = 864e5, t0 = Date.parse("2024-01-01T15:00:00Z");
const days = []; for (let i = 0; i < 400; i++) days.push(new Date(t0 + i * DAY).toISOString().slice(0, 10));
const series = (drift) => days.map((d, i) => ({ date: d, close: 100 * Math.pow(1 + drift, i) }));
const prices = { AAA: series(0.002), BBB: series(-0.001), CCC: series(0.0005), IXIC: series(0.0005) };
const intraday = [], events = [], txs = [];
for (let k = 0; k < 12; k++) {
  const buyDay = 40 + k * 25;
  for (let j = 1; j <= 3; j++) intraday.push({ ticker: "AAA", ts: t0 + (buyDay - j) * DAY, dwellMs: 120000 });
  events.push({ ticker: "AAA", ts: t0 + (buyDay - 2) * DAY, sentiment: "positive", views: 3 });
  txs.push({ broker: "x", extId: "a" + k, ts: t0 + buyDay * DAY + 3600e3, date: days[buyDay], kind: "buy", isin: "US0000000AAA", qty: 1, amount: 100, assetClass: "STOCK" });
  txs.push({ broker: "x", extId: "b" + k, ts: t0 + (buyDay + 3) * DAY, date: days[buyDay + 3], kind: "buy", isin: "US0000000BBB", qty: 1 + (k % 3), amount: 50 + k * 13, assetClass: "STOCK" });
}
for (let i = 0; i < 360; i += 9) intraday.push({ ticker: "CCC", ts: t0 + i * DAY, dwellMs: 60000 });
events.push({ ticker: "CCC", ts: t0 + 50 * DAY, sentiment: "positive" });
for (let m = 0; m < 6; m++) txs.push({ broker: "x", extId: "p" + m, ts: t0 + (35 + m * 30) * DAY, date: days[35 + m * 30], kind: "buy", isin: "IE00PLAN0001", qty: 1, amount: 100, assetClass: "ETF" });
// sales for the disposition effect: sell the AAA winner twice while BBB losers sit on paper
txs.push({ broker: "x", extId: "s1", ts: t0 + 330 * DAY, date: days[330], kind: "sell", isin: "US0000000AAA", qty: 2, amount: 300, assetClass: "STOCK" });
txs.push({ broker: "x", extId: "s2", ts: t0 + 360 * DAY, date: days[360], kind: "sell", isin: "US0000000AAA", qty: 2, amount: 300, assetClass: "STOCK" });
txs.push({ broker: "x", extId: "d1", ts: t0 + 200 * DAY, date: days[200], kind: "dividend", isin: "US0000000AAA", amount: 5, tax: 0.75, currency: "USD" });
const links = { US0000000AAA: { ticker: "AAA", symbol: "AAA" }, US0000000BBB: { ticker: null, symbol: "BBB" }, IE00PLAN0001: { ticker: null, symbol: null } };
const rep = D.analyze({ txs, links, intraday, events, prices, bench: prices.IXIC, tickerSymbol: { AAA: "AAA", CCC: "CCC" }, now: t0 + 399 * DAY });
console.log(JSON.stringify(rep.coverage));
ok(rep.coverage.decisions.auto === 6, "savings plan detected as automatic: " + rep.coverage.decisions.auto);
ok(Math.abs(rep.q1.researched.p - 13 / 26) < 0.01 && rep.q1.status === "indicative", "Q1 researched share " + JSON.stringify(rep.q1.researched) + " " + rep.q1.status);
ok(rep.q1.perm && rep.q1.perm.p < 0.05, "Q1 permutation p " + JSON.stringify(rep.q1.perm));
ok(rep.q2.agreement.k === 12 && rep.q2.n === 14 && rep.q2.contradictions === 2, "Q2 agreement " + JSON.stringify(rep.q2.agreement));
ok(rep.q3.researched.mean > rep.q3.unresearched.mean && rep.q3.clear, "Q3 researched beat unresearched " + JSON.stringify({ a: rep.q3.researched, b: rep.q3.unresearched, d: rep.q3.diff, st: rep.q3.status }));
ok(rep.q1.profile && rep.q1.profile.avg[29] > rep.q1.profile.avg[0], "Q1 event-time profile rises before buy");
ok(rep.q5.passed.n >= 1, "Q5 passed call scored " + JSON.stringify({ passed: rep.q5.passed, bought: rep.q5.bought, st: rep.q5.status }));
ok(rep.q9.hasDividends === true && rep.q9.attCoverage != null, "Q9 includes dividends, coverage " + rep.q9.attCoverage);
ok(rep.dividends.count === 1 && Math.abs(rep.dividends.byCurrency.USD.tax - 0.75) < 1e-9, "dividends kept " + JSON.stringify(rep.dividends));
ok(rep.disposition.days === 2 && rep.disposition.realizedGains === 2 && rep.disposition.paperLosses > 0 && rep.disposition.de > 0, "disposition " + JSON.stringify(rep.disposition));
ok(rep.q4.chase.n > 0, "Q4 chase " + JSON.stringify(rep.q4.chase) + " spike " + JSON.stringify([rep.q4.spikeBuy.n, rep.q4.spikeSell.n]));
// --- new questions on a second synthetic world ---
{
  const P = { UP: series(0.003), DN: series(-0.002), FLAT: series(0), IXIC: series(0.0005) };
  const intr = [], evs = [], tx = [], lk = {}, tsym = {};
  // 30 calls: odd ones on rising stocks (UPk), even ones on falling stocks (DNk); you buy the risers 2 days later
  for (let k = 0; k < 30; k++) {
    const rising = k % 2 === 1, tk = (rising ? "UP" : "DN") + k, sym = rising ? "UP" : "DN", d0 = 40 + k * 10;
    tsym[tk] = sym; lk["US00000000" + String(k).padStart(2, "0")] = { ticker: tk, symbol: sym };
    // research: risers via financials pages, scroll deep; fallers via community pages
    for (let j = 1; j <= (rising ? 5 : 1); j++) intr.push({ ticker: tk, ts: t0 + (d0 - j) * DAY, dwellMs: 60000, researchType: rising ? "financials" : "community", scrollDepth: rising ? 0.9 : 0.1, focusSwitches: 0 });
    evs.push({ ticker: tk, ts: t0 + (d0 - 1) * DAY, sentiment: "positive", targetPrice: rising ? 100 * Math.pow(1.003, d0 + 20) : null });
    if (rising) tx.push({ broker: "x", extId: "u" + k, ts: t0 + (d0 + 2) * DAY, date: days[d0 + 2], kind: "buy", isin: "US00000000" + String(k).padStart(2, "0"), qty: 1, amount: 200 + k, assetClass: "STOCK" });
  }
  // impulse buys: first ever look 30 minutes before the trade on fresh stocks (FLAT)
  for (let k = 0; k < 6; k++) {
    const tk = "IMP" + k, d0 = 60 + k * 30, isin = "US0000IMP00" + k;
    tsym[tk] = "FLAT"; lk[isin] = { ticker: tk, symbol: "FLAT" };
    intr.push({ ticker: tk, ts: t0 + d0 * DAY - 1800e3, dwellMs: 30000, researchType: "news" });
    tx.push({ broker: "x", extId: "i" + k, ts: t0 + d0 * DAY, date: days[d0], kind: "buy", isin: isin, qty: 1, amount: 50, assetClass: "STOCK" });
  }
  intr.push({ ticker: "UP1", ts: t0, dwellMs: 1 }); // attention starts on day 0
  const R2 = D.analyze({ txs: tx, links: lk, intraday: intr, events: evs, prices: P, bench: P.IXIC, tickerSymbol: tsym, now: t0 + 399 * DAY });
  const f = R2.q4.fomo;
  ok(f.buyIfUp.p === 1 && f.buyIfDown.p === 0 && f.clear, "FOMO: buys only risers " + JSON.stringify({ up: [f.buyIfUp.k, f.buyIfUp.n], down: [f.buyIfDown.k, f.buyIfDown.n], runs: f.runs, st: f.status }));
  const fin = R2.q6.rows.find(r => r.type === "financials");
  ok(fin && fin.nWith > 0, "Q6 page types " + JSON.stringify(R2.q6.rows.map(r => [r.type, r.nWith, r.nWithout])));
  ok(R2.q7.impulse.k === 6, "Q7 impulse " + JSON.stringify({ imp: R2.q7.impulse, st: R2.q7.status }));
  ok(R2.q8.n > 0 && R2.q8.sizeVsConviction.r != null, "Q8 sizing " + JSON.stringify(R2.q8.sizeVsConviction));
  ok(R2.q9.months > 6 && R2.q9.returns.portfolio > 0, "Q9 portfolio vs attention " + JSON.stringify({ m: R2.q9.months.toFixed(1), r: R2.q9.returns, st: R2.q9.status }));
  ok(R2.q10.weeksAttention > 12, "Q10 volatility " + JSON.stringify({ w: [R2.q10.weeksAttention, R2.q10.weeksTrading], v: R2.q10.viewsVsVol.r }));
  const ld = R2.q7.lead.buckets.reduce((m, b) => (m[b.key] = b.n, m), {});
  ok(ld["1h"] === 6 && ld.week === 14 && ld.quarter === 1 && R2.q7.lead.n === 21, "Q7 lead distribution " + JSON.stringify(ld));
  ok(R2.q7.hours.blocks.length === 5 && R2.q7.hours.viewsByHour.reduce((a, b) => a + b, 0) === intr.length, "Q7 hours " + JSON.stringify(R2.q7.hours.blocks.map(b => [b.key, b.buys, b.n])));
  ok(R2.q9.portfolio[0] === 100 && R2.q9.dates[0] >= days[42], "Q9 starts at first holding " + R2.q9.dates[0] + " gaps " + R2.q9.gapDays + " cash " + R2.q9.cashDays);
  ok(R2.q4.runupPerf.rose.n + R2.q4.runupPerf.fell.n > 0, "Q4 run-up vs performance " + JSON.stringify({ rose: R2.q4.runupPerf.rose, fell: R2.q4.runupPerf.fell, st: R2.q4.runupPerf.status }));
  ok(R2.q7.grid && R2.q7.grid.cells.length === 3 && R2.q7.grid.cells[0].length === 5 && R2.q7.hours.nearBoundary != null, "Q7 conviction x time grid " + JSON.stringify(R2.q7.grid.cells.map(r => r.map(c => c.n))) + " near boundary " + R2.q7.hours.nearBoundary);
  ok(R2.q11.n > 0, "Q11 targets " + JSON.stringify({ n: R2.q11.n, sold: R2.q11.sold, nr: R2.q11.notReached, st: R2.q11.status }));
}
// --- browsing history reader ---
{
  global.self = global;
  global.ATLedger = L; // ledger.js loaded above before `self` existed
  require(path.join(__dirname, "..", "src", "portals.js"));
  const H = require(path.join(__dirname, "..", "src", "history.js"));
  const hc = self.ATPortals.detect("https://holdingschannel.com/institutional/holders-of-frmi/"), hcb = self.ATPortals.detect("https://www.holdingschannel.com/institutional/holders-of-brk.b/");
  ok(hc && hc.ticker === "FRMI" && hc.section === "institutional" && hcb.ticker === "BRK-B" && !self.ATPortals.detect("https://holdingschannel.com/13f/latest-filings/") &&
    self.ATPortals.classifyUrl("https://holdingschannel.com/institutional/holders-of-frmi/", "Holdings Channel") === "institutional", "Holdings Channel: only the institutional holders page is tracked, as institutional research");
  const takeout = { "Browser History": [
    { title: "NVDA", url: "https://finance.yahoo.com/quote/NVDA/", time_usec: 1700000000000000, page_transition: "LINK" },
    { title: "x", url: "https://www.example.com/private", time_usec: 1700000100000000 },
    { title: "AAPL financials", url: "https://stockanalysis.com/stocks/aapl/financials/", time_usec: 1700000200000000 }] };
  const r = H.extract(JSON.stringify(takeout), []);
  ok(r.entries === 3 && r.visits.length === 2 && r.visits[0].ts === 1700000000000 && r.visits[1].researchType === "financials", "history: Chrome History.json " + JSON.stringify(r.visits.map(v => [v.ticker, v.researchType])));
  const act = [{ header: "Chrome", title: "Visited NVDA", titleUrl: "https://www.google.com/url?q=https://finance.yahoo.com/quote/NVDA/&usg=x", time: "2023-11-14T22:13:20.000Z" }];
  const r2 = H.extract(JSON.stringify(act), []);
  ok(r2.visits.length === 1 && r2.visits[0].ticker === "NVDA", "history: My Activity JSON with redirect " + JSON.stringify(r2.visits.map(v => [v.ticker, v.url])));
  const csv = ["order,id,date,time,title,url,visitCount,typedCount,transition,timestamp,domain",
    "1,1,10/9/2026,11:06:50 PM,\"NVDA, quote\",https://finance.yahoo.com/quote/NVDA/,31,0,link,1791580010494.86,finance.yahoo.com",
    "2,2,10/9/2026,11:00:00 PM,x,https://mail.example.com/inbox,3,0,link,1791579000000.1,mail.example.com",
    "3,3,10/8/2026,9:00:00 AM,AAPL fin,https://stockanalysis.com/stocks/aapl/financials/,2,0,link,1791450000000,stockanalysis.com"].join("\n") + "\n";
  const rc = H.extract(csv, []);
  ok(rc.format === "csv" && rc.entries === 3 && rc.visits.length === 2 && rc.unplaced === 31, "history: Comet-style CSV (one row per page) " + JSON.stringify({ n: rc.visits.length, unplaced: rc.unplaced }));
  ok(rc.visits[1].ts === 1791580010495 && rc.visits[0].researchType === "financials", "history: CSV fractional-ms timestamp and page type");
  const edge = ["\ufeffDateTime,NavigatedToUrl,PageTitle", "2026-10-13T14:36:01.700Z,https://stockanalysis.com/stocks/aapl/,AAPL", "2026-10-13T14:35:59.171Z,https://claude.ai/new,New session"].join("\n") + "\n";
  const re = H.extract(edge, []);
  ok(re.format === "csv" && re.entries === 2 && re.visits.length === 1 && re.visits[0].ticker === "AAPL" && re.visits[0].ts === Date.parse("2026-10-13T14:36:01.700Z"), "history: DateTime / NavigatedToUrl CSV (Edge-style, with a BOM)");
  const again = H.newVisits(rc.visits.map(v => ({ ticker: v.ticker, ts: v.ts })), rc.visits);
  ok(again.fresh.length === 0 && again.duplicates === 2, "history: the same file twice adds nothing");
  const other = H.newVisits([{ ticker: "NVDA", ts: rc.visits[1].ts + 1400 }], rc.visits);
  ok(other.fresh.length === 1 && other.duplicates === 1, "history: same visit 1.4 s apart from another browser/export is skipped, the other stock stays");
  ok(H.numToMs(13420000000000000) > 0 && new Date(H.numToMs(13420000000000000)).getUTCFullYear() === 2026, "history: Chrome 1601-epoch microseconds");
  let noTime = ""; try { H.extract("url,title\nhttps://finance.yahoo.com/quote/NVDA/,x\n", []); } catch (e) { noTime = e.message; }
  ok(/no visit-time column/.test(noTime), "history: CSV without a time column is refused with a reason");
}
// --- day parts from your own buying clusters, conviction bands ---
{
  const rep = (h, n) => new Array(n).fill(h);
  // three hills: 9-10 h, 13-14 h, 20-22 h, with valleys around 11-12 h and 16-18 h
  const hills = [].concat(rep(9, 8), rep(10, 6), rep(13, 7), rep(14, 7), rep(20, 5), rep(21, 8), rep(22, 4), rep(11, 1), rep(17, 1));
  const cl = D.buyClusters(hills);
  ok(cl && cl.length === 3, "clusters: three hills found " + (cl && JSON.stringify(cl.map(b => [b.label, b.from, b.to]))));
  const inB = (b, h) => (b.from < b.to ? h >= b.from && h < b.to : h >= b.from || h < b.to);
  ok(cl && [9, 10].every(h => cl.find(b => inB(b, h)) === cl.find(b => inB(b, 9))) && cl.find(b => inB(b, 10)) !== cl.find(b => inB(b, 13)) && cl.find(b => inB(b, 14)) !== cl.find(b => inB(b, 21)),
    "clusters: each hill sits in one block, boundaries in the valleys");
  ok(cl && cl.every(b => hills.filter(h => inB(b, h)).length >= 3), "clusters: every block holds at least 3 buys");
  ok(D.buyClusters([].concat(rep(9, 10), rep(10, 10), rep(11, 5))) === null, "clusters: a single hill gives no clusters (falls back to the fixed parts)");
  ok(D.buyClusters(rep(9, 5)) === null, "clusters: too few buys gives none");
  // hills that wrap midnight: 23-1 h and 12-13 h
  const wrap = [].concat(rep(23, 8), rep(0, 8), rep(1, 4), rep(12, 9), rep(13, 7));
  const cw = D.buyClusters(wrap);
  ok(cw && cw.length === 2 && cw.every(b => wrap.filter(h => inB(b, h)).length >= 3), "clusters: a hill across midnight stays one block " + (cw && JSON.stringify(cw.map(b => [b.from, b.to]))));
  // conviction bands: scores can never be negative; ties at 0 stay in the lowest band
  const scores = [].concat(rep(0, 6), [0.5, 1.5, 2.5, 3.5, 4.5, 6]);
  const tb = D.convBands(scores, "thirds"), wb = D.convBands(scores, "watchlist");
  ok(tb.labels[0].indexOf("-") < 0 && tb.cuts[0] >= 0 && scores.every(v => tb.of(v) >= 0 && tb.of(v) <= 2), "conviction bands: thirds never use a negative score " + tb.labels.join(" | "));
  ok(scores.filter(v => tb.of(v) === 0).length >= 6 && wb.labels.join("|") === "Low (up to 1.0)|Middle (1.0 to 3.0)|High (over 3.0)" && wb.of(1) === 0 && wb.of(3) === 1 && wb.of(3.01) === 2,
    "conviction bands: watchlist colours (up to 1, up to 3, over 3) and ties at 0 in the lowest band");
}
// --- user-defined day parts ---
{
  const cb = D.customBlocks([6, 11, 15, 19, 22]);
  ok(cb && cb.length === 5 && cb[0].from === 6 && cb[0].to === 11 && cb[4].from === 22 && cb[4].to === 6, "custom parts: five parts, the last wraps past midnight " + JSON.stringify(cb.map(b => [b.label, b.from, b.to])));
  ok(D.customBlocks([9]) === null && D.customBlocks([]) === null && D.customBlocks(["x", 99, -1]) === null, "custom parts: fewer than two valid hours gives none");
  const two = D.customBlocks([22, 6, 6, 22.5]);
  ok(two && two.length === 2 && two[0].from === 6 && two[0].to === 22 && two[1].from === 22 && two[1].to === 6, "custom parts: duplicates and non-integers are ignored");
  const names = D.customBlocks([1, 3, 5, 7]).map(b => b.key);
  ok(new Set(names).size === names.length, "custom parts: names stay unique when two parts fall in the same time of day " + names.join(","));
}
// --- Q9: the all-views basket keeps a stock the recent basket has dropped ---
{
  const DAY = 864e5, t0 = Date.parse("2024-01-01T00:00:00Z");
  const days = []; for (let i = 0; i < 140; i++) days.push(new Date(t0 + i * DAY).toISOString().slice(0, 10));
  const flat = days.map(d => ({ date: d, close: 100 }));
  const rising = days.map((d, i) => ({ date: d, close: i > 60 ? 100 * Math.pow(1.01, i - 60) : 100 }));
  const prices = { HOLD: flat, OLD: rising, NEW: flat, IXIC: flat };
  const txs = [{ broker: "x", extId: "1", ts: t0 + 12 * DAY, date: days[12], kind: "buy", isin: "US000000HOLD", qty: 1, amount: 100, assetClass: "STOCK" }];
  const links = { US000000HOLD: { ticker: "HOLD", symbol: "HOLD" } };
  // OLD was viewed once on day 10, NEW on day 70: by day 100 only NEW is in the 30-day basket
  const intraday = [{ ticker: "HOLD", ts: t0 + 10 * DAY + 3600e3 }, { ticker: "OLD", ts: t0 + 10 * DAY + 7200e3 }, { ticker: "NEW", ts: t0 + 70 * DAY + 3600e3 }];
  const R = D.analyze({ txs, links, intraday, events: [], prices, bench: flat, tickerSymbol: { HOLD: "HOLD", OLD: "OLD", NEW: "NEW" }, now: t0 + 139 * DAY });
  const q = R.q9, i = q.dates.indexOf(days[120]);
  ok(q.attentionAll && q.attentionAll.length === q.attention.length && q.returns.attentionAll != null, "Q9 second basket is returned with the same length as the first");
  const Rd = D.analyze({ txs, links, intraday, events: [], prices, bench: flat, tickerSymbol: { HOLD: "HOLD", OLD: "OLD", NEW: "NEW" }, windowDays: 365, now: t0 + 139 * DAY });
  ok(Math.abs(Rd.q9.attention[i] - q.attentionAll[i]) < 1e-9 && Rd.q9.attention[i] > q.attention[i] * 1.1, "Q9 a 365-day window keeps OLD in the recent basket (equals the all-views basket here): " + Rd.q9.attention[i].toFixed(1));
  ok(i > 0 && q.attentionAll[i] > q.attention[i] * 1.1, "Q9 the all-views basket still holds OLD (rising) on day 120, the 30-day basket does not: " + (q.attentionAll[i] || 0).toFixed(1) + " vs " + (q.attention[i] || 0).toFixed(1));
}
// --- Q9 attention index has no lookahead ---
{
  const DAY = 864e5, t0 = Date.parse("2024-01-01T00:00:00Z");
  const days = []; for (let i = 0; i < 120; i++) days.push(new Date(t0 + i * DAY).toISOString().slice(0, 10));
  const flat = days.map(d => ({ date: d, close: 100 }));
  // SPIKE jumps +50% on the close of day 51 (the day-50 -> day-51 return)
  const spike = days.map((d, i) => ({ date: d, close: i >= 51 ? 150 : 100 }));
  const prices = { AAA: flat, SPIKE: spike, IXIC: flat };
  const txs = [{ broker: "x", extId: "1", ts: t0 + 12 * DAY, date: days[12], kind: "buy", isin: "US000000000A", qty: 1, amount: 100, assetClass: "STOCK" }];
  const links = { US000000000A: { ticker: "AAA", symbol: "AAA" } };
  // one view of SPIKE at 23:00 UTC on day 50 - after any market close that day
  const intraday = [{ ticker: "AAA", ts: t0 + 10 * DAY + 15 * 3600e3 }, { ticker: "SPIKE", ts: t0 + 50 * DAY + 23 * 3600e3 }];
  const R = D.analyze({ txs, links, intraday, events: [], prices, bench: flat, tickerSymbol: { AAA: "AAA", SPIKE: "SPIKE" }, now: t0 + 119 * DAY });
  const i50 = R.q9.dates.indexOf(days[50]), i51 = R.q9.dates.indexOf(days[51]), i53 = R.q9.dates.indexOf(days[53]);
  ok(i50 > 0 && i51 > 0, "Q9 lookahead test: window covers days 50-51");
  const jumpDay = R.q9.attention[i51] / R.q9.attention[i50];
  ok(Math.abs(jumpDay - 1) < 1e-9, "Q9 a view after day 50's close does not capture the day 50 -> 51 jump (ratio " + jumpDay.toFixed(4) + ")");
  ok(R.q9.attention[i53] / R.q9.attention[i51] - 1 < 1e-9, "Q9 and from the next close on, the stock is simply held at its new price");
}

// --- Q9 decision lag and in-place recompute ---
{
  const DAY = 864e5, t0 = Date.parse("2024-01-01T00:00:00Z");
  const days = []; for (let i = 0; i < 120; i++) days.push(new Date(t0 + i * DAY).toISOString().slice(0, 10));
  const flat = days.map(d => ({ date: d, close: 100 }));
  const spike = days.map((d, i) => ({ date: d, close: i >= 51 ? 150 : 100 }));
  const prices = { AAA: flat, SPIKE: spike, IXIC: flat };
  const txs = [{ broker: "x", extId: "1", ts: t0 + 12 * DAY, date: days[12], kind: "buy", isin: "US000000000A", qty: 1, amount: 100, assetClass: "STOCK" }];
  const links = { US000000000A: { ticker: "AAA", symbol: "AAA" } };
  // viewed at 15:00 UTC on day 50: before that day's 16:00 ET close
  const intraday = [{ ticker: "AAA", ts: t0 + 10 * DAY + 15 * 3600e3 }, { ticker: "SPIKE", ts: t0 + 50 * DAY + 15 * 3600e3 }];
  const inp = { txs, links, intraday, events: [], prices, bench: flat, tickerSymbol: { AAA: "AAA", SPIKE: "SPIKE" }, now: t0 + 119 * DAY };
  const L0 = D.analyze(Object.assign({ lagDays: 0 }, inp)), L1 = D.analyze(Object.assign({ lagDays: 1 }, inp));
  const i50 = L0.q9.dates.indexOf(days[50]), i51 = L0.q9.dates.indexOf(days[51]);
  ok(L0.q9.attention[i51] / L0.q9.attention[i50] > 1.05, "Q9 lag 0: a view before the 16:00 ET close drives the basket held from that close: " + (L0.q9.attention[i51] / L0.q9.attention[i50]).toFixed(3));
  ok(Math.abs(L1.q9.attention[i51] / L1.q9.attention[i50] - 1) < 1e-9, "Q9 lag 1: the same view has to wait a day");
  const again = L0.recomputeQ9({ windowDays: 30, lagDays: 1 });
  ok(JSON.stringify(again.attention) === JSON.stringify(L1.q9.attention), "Q9 recomputeQ9 gives the same result as a full analysis with that lag");
}

// --- small statistics ---
{
  const S = D.stats;
  const w = D.wilson(5, 10), w99 = D.wilson(5, 10, 2.576);
  ok(Math.abs(w.lo - 0.2366) < 1e-3 && Math.abs(w.hi - 0.7634) < 1e-3 && w99.lo < w.lo && w99.hi > w.hi, "wilson: 95% unchanged, optional 99% is wider");
  ok(S.pctRank([1, 2, 3, 4], 2.5) === 0.5 && S.pctRank([1, 2, 2, 3], 2) === 0.5 && S.pctRank([1, 2, 3], 0) === 0 && S.pctRank([1, 2, 3], 9) === 1, "pctRank: share below, ties count half");
  ok(S.quantile([1, 2, 3, 4, 5], 0.5) === 3 && Math.abs(S.quantile([0, 10], 0.25) - 2.5) < 1e-12, "quantile: interpolated");
  const bw = S.bootWeighted([0.1, 0.9], [1, 9], 500, 3, 0.95);
  ok(Math.abs(bw.est - 0.82) < 1e-9 && bw.lo <= bw.est && bw.hi >= bw.est, "bootWeighted: weighted mean " + bw.est);
}

// --- trailing sizes, market context, Q10 / Q2 / Q5 on controlled worlds ---
{
  const DAY = 864e5, t0 = Date.parse("2024-01-01T12:00:00Z"), N = 760;
  const mulberry = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const gauss = (r) => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const dates = Array.from({ length: N }, (_, i) => new Date(t0 + i * DAY).toISOString().slice(0, 10));
  const walk = (seed, sigma, drift) => { const r = mulberry(seed); let c = 100; return dates.map((d, i) => { c *= 1 + (drift || 0) + (typeof sigma === "function" ? sigma(i) : sigma) * gauss(r); return { date: d, close: c }; }); };
  // calm and turbulent stretches of 30-90 bars (random lengths: a strictly periodic market would let a shifted pattern line up again and again)
  const turbOn = []; { const rr = mulberry(99); for (let i = 0, on = false; i < N;) { const len = 30 + Math.floor(rr() * 61); for (let k = 0; k < len && i < N; k++, i++) turbOn[i] = on; on = !on; } }
  const bench = walk(1, (i) => (turbOn[i] ? 0.018 : 0.004));
  const ms = D.marketSeries(bench);
  const col = (a) => { const o = []; for (let j = 100; j < N - 60; j++) o.push(a[j - 1]); return o.sort((x, y) => x - y); };
  const retS = col(ms.ret20), volS = col(ms.vol20);
  const qs = (s, p) => s[Math.floor(p * (s.length - 1))];
  const pickDays = (f, n, gap) => { const o = []; let last = -99; for (let j = 100; j < N - 60 && o.length < n; j++) if (j - last >= gap && f(j)) { o.push(j); last = j; } return o; };
  const build = (days, amountFn, extra) => {
    const txs = [], links = {}, prices = {}, tsym = {}, intraday = [{ ticker: "SEED", ts: t0, dwellMs: 1 }];
    days.forEach((j, k) => {
      const tk = "S" + k, isin = "US0000000" + String(k).padStart(3, "0");
      prices[tk] = walk(100 + k, 0.01); links[isin] = { ticker: tk, symbol: tk }; tsym[tk] = tk;
      intraday.push({ ticker: tk, ts: t0 + (j - 2) * DAY, dwellMs: 60000 });
      txs.push({ broker: "x", extId: "t" + k, ts: t0 + j * DAY + 3600e3, date: dates[j], kind: "buy", isin, qty: 1, amount: amountFn(j, k), assetClass: "STOCK", currency: "EUR" });
    });
    return Object.assign({ txs, links, intraday, events: [], prices, bench, tickerSymbol: tsym, now: t0 + (N - 1) * DAY }, extra || {});
  };
  const spearman = (a, b) => D.stats.corr(a, b, true).r;

  // dip buyer, chaser, and random timing
  const dipDays = pickDays((j) => ms.ret20[j - 1] <= qs(retS, 0.3), 36, 4);
  const chaseDays = pickDays((j) => ms.ret20[j - 1] >= qs(retS, 0.7), 36, 4);
  const randDays = pickDays(() => true, 36, 8);
  const Rd = D.analyze(build(dipDays, () => 100)), Rc = D.analyze(build(chaseDays, () => 100)), Rr = D.analyze(build(randDays, () => 100));
  ok(Rd.q10.n >= 30 && Rd.q10.dip.ret.verdict === "dip" && Rd.q10.dip.ret.mean.est < 0.4, "Q10 dip buyer: percentile of the market's 20-day return " + Rd.q10.dip.ret.mean.est.toFixed(2) + " (" + Rd.q10.dip.ret.verdict + ", n " + Rd.q10.n + ")");
  ok(Rc.q10.dip.ret.verdict === "chase" && Rc.q10.dip.ret.mean.est > 0.6, "Q10 chaser: percentile " + Rc.q10.dip.ret.mean.est.toFixed(2) + " (" + Rc.q10.dip.ret.verdict + ")");
  ok(Rr.q10.dip.ret.verdict === "none" && Math.abs(Rr.q10.dip.ret.mean.est - 0.5) < 0.15, "Q10 random timing is not called a tilt: " + Rr.q10.dip.ret.mean.est.toFixed(2) + " [" + Rr.q10.dip.ret.mean.lo.toFixed(2) + ", " + Rr.q10.dip.ret.mean.hi.toFixed(2) + "] " + Rr.q10.dip.ret.verdict);
  ok(Rd.q10.dip.dd.mean.est < 0.5 && Rd.q10.dip.ret.fifths.length === 5 && Rd.q10.dip.ret.fifths[0].p > Rd.q10.dip.ret.fifths[4].p, "Q10 dip buyer: most buys fall in the weakest fifth of days " + Rd.q10.dip.ret.fifths.map((f) => Math.round(f.p * 100)).join("/"));

  // bigger buys in turbulent markets
  const volCut = qs(volS, 2 / 3);
  const Rs = D.analyze(build(pickDays(() => true, 60, 5), (j) => (ms.vol20[j - 1] > volCut ? 250 : 100)));
  const reg = Rs.q10.regimes;
  ok(reg.length === 3 && reg[2].median > reg[0].median * 1.5 && Rs.q10.size.diff && Rs.q10.size.diff.est > 0.8 && Rs.q10.size.clear,
    "Q10 size by volatility: turbulent " + (reg[2].median || 0).toFixed(2) + "x vs calm " + (reg[0].median || 0).toFixed(2) + "x usual, log2 diff " + (Rs.q10.size.diff ? Rs.q10.size.diff.est.toFixed(2) : "-") + ", rho " + Rs.q10.size.rho.r.toFixed(2));
  ok(Math.abs(reg[0].baseShare + reg[1].baseShare + reg[2].baseShare - 1) < 1e-9 && reg.every((r) => r.points.length === r.nSized), "Q10 regimes: shares of days add up, one point per sized buy");
  const flat = D.analyze(build(pickDays(() => true, 60, 5), () => 100));
  ok(!flat.q10.size.clear && flat.q10.regimes[2].median > 0.9 && flat.q10.regimes[2].median < 1.1, "Q10 equal-sized buys show no size effect (turbulent median " + flat.q10.regimes[2].median.toFixed(2) + "x)");

  // the usual buy grows with wealth: sizes are judged against the buys before them
  // (3% growth per buy: the amounts nearly triple over 36 buys)
  const gDays = pickDays(() => true, 36, 8);
  const Rg = D.analyze(build(gDays, (j, k) => 100 * Math.pow(1.03, k)));
  const bs = Rg.decisions.filter((d) => d.side === "buy" && d.relSize != null);
  const med = D.stats.median(Rg.decisions.filter((d) => d.side === "buy").map((d) => d.amount));
  const thirds = (f) => { const t = Math.floor(bs.length / 3), m = (a) => a.reduce((s, x) => s + f(x), 0) / a.length; return m(bs.slice(-t)) / m(bs.slice(0, t)); };
  const driftTrail = thirds((d) => d.relSize), driftFixed = thirds((d) => d.amount / med);
  ok(bs.length >= 30 && driftTrail < 1.4 && driftFixed > 1.8,
    "sizes: growth moves the last third of buys by x" + driftTrail.toFixed(2) + " against the first when judged by the trailing median, but by x" + driftFixed.toFixed(2) + " against a fixed overall median");
  ok(Rg.decisions.filter((d) => d.side === "buy").slice(0, 4).every((d) => d.relSize == null), "sizes: the first buys have no usual size yet (fewer than 4 before them)");

  // nothing from the trade day or later reaches the market context
  {
    const inp = build(dipDays, () => 100), j = dipDays[10], when = dates[j];
    const a = D.analyze(inp).decisions.find((d) => d.date === when && d.side === "buy");
    const warped = bench.map((b) => (b.date >= when ? { date: b.date, close: b.close * 1.7 } : b));
    const b2 = D.analyze(Object.assign({}, inp, { bench: warped })).decisions.find((d) => d.date === when && d.side === "buy");
    ok(a && b2 && a.mkt && Math.abs(a.mkt.vol20 - b2.mkt.vol20) < 1e-12 && Math.abs(a.mkt.ret20 - b2.mkt.ret20) < 1e-12 && Math.abs(a.mkt.dd - b2.mkt.dd) < 1e-12,
      "market context uses only bars before the trade day (vol " + (a && a.mkt.vol20.toFixed(4)) + ")");
  }

  // Q2: only calls on holdings can be acted on; pre-file holdings come from sales beyond the file's position
  {
    const tx = (id, day, kind, isin, qty, amt) => ({ broker: "x", extId: id, ts: t0 + day * DAY + 3600e3, date: dates[day], kind, isin, qty, amount: amt, assetClass: "STOCK", currency: "EUR" });
    const I = { H1: "US00000000H1", H2: "US00000000H2", NH: "US00000000NH", PRE: "US00000000PR", OT: "US00000000OT" };
    const links = {}, tsym = {}, prices = { IXIC: bench };
    Object.keys(I).forEach((k) => { links[I[k]] = { ticker: k, symbol: k }; tsym[k] = k; });
    prices.H1 = walk(11, 0.01); prices.H2 = walk(12, 0.01); prices.PRE = walk(13, 0.01); prices.OT = walk(14, 0.01);
    prices.NH = walk(15, 0.005, -0.004); // falls against the flat market after the call
    const txs = [tx("a", 60, "buy", I.H1, 1, 100), tx("b", 110, "sell", I.H1, 1, 100), tx("c", 70, "buy", I.H2, 1, 100),
      tx("d", 150, "sell", I.PRE, 5, 500), tx("e", 300, "buy", I.OT, 1, 100)];
    const ev = (ticker, day, sentiment) => ({ ticker, ts: t0 + day * DAY, sentiment });
    const events = [ev("H1", 100, "negative"), ev("H2", 100, "negative"), ev("NH", 120, "negative"), ev("PRE", 140, "negative"), ev("PRE", 40, "negative")];
    const intraday = [{ ticker: "SEED", ts: t0, dwellMs: 1 }];
    const base = { txs, links, intraday, events, prices, bench, tickerSymbol: tsym, now: t0 + (N - 1) * DAY };
    const built = D.buildDecisions(txs);
    ok(built.preHold[I.PRE] === t0 + 150 * DAY + 3600e3 && built.preHold[I.H1] == null, "a sale beyond the file's position marks shares held from before the file");
    const R = D.analyze(base), q = R.q2;
    ok(q.negToSell.n === 3 && q.negToSell.k === 2, "Q2 Negative calls on holdings: " + q.negToSell.k + " of " + q.negToSell.n + " sold (the unheld stock is not counted; the pre-file holding is; the call before the file starts is not judged)");
    ok(q.avoid.notHeld === 1 && q.avoid.n === 1 && q.avoid.mean < 0 && q.avoid.lagged.k === 1, "Q2 'avoid' call on a stock not held scored on its own: " + (q.avoid.mean * 100).toFixed(1) + "% vs market over " + q.avoid.horizon + " days");
    ok(q.lag.neg != null && q.lag.neg <= 30, "Q2 call-to-sale lag " + q.lag.neg);
    const R2 = D.analyze(Object.assign({}, base, { coveredFrom: t0 + 30 * DAY }));
    ok(R2.q2.negToSell.n === 4, "Q2 an export that covers earlier dates lets the earlier call be judged (" + R2.q2.negToSell.n + ")");
  }

  // Q5: the path after a passed-on call ends where the single number says it does
  {
    const ser = walk(21, 0.01, 0.001);
    const p = D.forwardPath(ser, bench, dates[100], 63), f = D.forward(ser, bench, dates[100], 63);
    ok(p && p.length === 64 && p[0] === 0 && Math.abs(p[63] - f.ex) < 1e-12 && D.forwardPath(ser, bench, dates[N - 10], 63) === null, "forwardPath: day 0 is 0, day 63 equals forward(), too-short series gives null");
    const band = D.pathBand([p, p.map((x) => x + 0.02), p.map((x) => x - 0.02)], 300, 5);
    ok(band.n === 3 && band.mean.length === 64 && band.lo.every((v, k) => v <= band.mean[k] + 0.03) && band.hi.every((v, k) => v >= band.mean[k] - 0.03) && band.lo[63] < band.hi[63], "pathBand: a mean with a lower and an upper range at each day");
    const q5 = rep.q5;
    ok(q5.paths.days.length === 64 && q5.paths.passed && Math.abs(q5.paths.passed.mean[63] - q5.passed.mean) < 1e-12 && Math.abs(q5.paths.bought.mean[63] - q5.bought.mean) < 1e-12 && q5.worst.length >= 1,
      "Q5 paths end at the 63-day means (passed " + trimN(q5.passed.mean) + ", bought " + trimN(q5.bought.mean) + ")");
  }
}
function trimN(x) { return x == null ? "-" : (x * 100).toFixed(1) + "%"; }

// --- page-type report (tools/classifier-report.js) ---
{
  const C = require(path.join(__dirname, "classifier-report.js"));
  const t = C.templateOf("https://stockanalysis.com/stocks/aapl/financials/balance-sheet/?p=quarterly&x=1", "AAPL");
  ok(t.host === "stockanalysis.com" && t.template === "/stocks/:t/financials/balance-sheet", "report: a URL becomes host and template, query dropped, ticker replaced: " + t.host + t.template);
  ok(C.templateOf("https://news.example.com/articles/12345678/a-very-long-headline-slug-about-what-happened-today", "AAPL").template === "/articles/:n/:slug", "report: numbers and long slugs become placeholders");
  const visits = [
    { url: "https://finance.yahoo.com/quote/NVDA/", ticker: "NVDA" }, { url: "https://finance.yahoo.com/quote/NVDA/key-statistics/", ticker: "NVDA" },
    { url: "https://stockanalysis.com/stocks/aapl/financials/balance-sheet/", ticker: "AAPL" }, { url: "https://stockanalysis.com/stocks/aapl/financials/", ticker: "AAPL" },
    { url: "https://stockanalysis.com/stocks/aapl/statistics/", ticker: "AAPL" }];
  const rep = C.report(visits);
  ok(rep.total === 5 && rep.fallback === 3 && rep.byType.financials === 2, "report: counts visits, those that fell back to 'overview', and types " + JSON.stringify(rep.byType));
  const ev = C.evaluate(rep, [{ host: "stockanalysis.com", template: "/stocks/:t/financials/balance-sheet", label: "financials" }, { host: "stockanalysis.com", template: "/stocks/:t/statistics", label: "financials" },
    { host: "finance.yahoo.com", template: "/quote/:t", label: "overview" }, { host: "finance.yahoo.com", template: "/quote/:t/key-statistics", label: "nonsense" }]);
  ok(ev.rows === 3 && ev.rowsRight === 2 && ev.wrong.length === 1 && ev.wrong[0].template === "/stocks/:t/statistics", "report: scored against labels (an unknown label is ignored; the wrong one is listed): " + ev.right + " of " + ev.visits + " visits");
  ok(C.parseCsv(["host,template,label", "\"a,b\",/x,news"].join("\n"))[0].host === "a,b", "report: quoted CSV fields");
}

// --- Q5: one stock that carries the comparison is named ---
{
  const SW = require(path.join(__dirname, "synth-world.js"));
  const w = SW.buildWorld({ seed: 9, nBuys: 80, bars: 900, nPassed: 40, passedEdge: 0.02 }), inp = w.input;
  const isins = Object.keys(inp.links).filter((k) => /^US\d+00$/.test(k) && inp.links[k].ticker.charAt(0) === "S").slice(0, 14);
  inp.prices.MRNA = inp.prices.S0.map((b, i) => ({ date: b.date, close: 100 * Math.pow(0.992, i) }));
  isins.forEach((k) => { inp.links[k] = { ticker: "MRNA", symbol: "MRNA" }; });
  inp.tickerSymbol.MRNA = "MRNA";
  const R = D.analyze(inp), f = R.q5.influence;
  ok(f && f.ticker === "MRNA" && f.nBought >= 8 && f.diffWithout.est > R.q5.diff.est, "Q5 names the stock that moves the comparison: " + (f && f.ticker) + ", buys minus passed " + (R.q5.diff.est * 100).toFixed(1) + " pts with it, " + (f && (f.diffWithout.est * 100).toFixed(1)) + " without");
  ok(!("positionTaken" in R.q2), "Q2 no longer carries the position-taken mark");
}

if (failed) { console.log(failed + " failed"); process.exit(1); }
console.log("all passed");
