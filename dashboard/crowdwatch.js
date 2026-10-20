// Community > Trending > "Back to earth": stocks that trended on the platforms we
// track, that you looked at around then, and whose attention has since subsided.
// The detection is in the database (crowd_settled); this only shows it, draws the
// platforms' attention for each stock, and holds the e-mail opt-in. It describes
// attention. It is not a reason to buy or sell.

const CW_NAMES = { stockanalysis: "StockAnalysis", apewisdom: "ApeWisdom", stocktwits: "Stocktwits", yahoo: "Yahoo", stocktrails: "Stocktrails" };
const CW_SEEN = "at_crowd_dismissed";

function cwDismissed() { try { return JSON.parse(localStorage.getItem(CW_SEEN) || "{}"); } catch (e) { return {}; } }
function cwDismiss(key) { const d = cwDismissed(); d[key] = 1; try { localStorage.setItem(CW_SEEN, JSON.stringify(d)); } catch (e) { /* storage blocked */ } }

// platforms that list the stock in their top 50, per day, for the last 30 days
function cwSpark(rows, ticker) {
  const byDay = {};
  rows.forEach(function (r) { const w = r.weights && r.weights[ticker]; if (w && w[1] <= 50) byDay[r.day] = (byDay[r.day] || 0) + 1; });
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const mx = Math.max.apply(null, days.map(function (d) { return byDay[d] || 0; }).concat([1]));
  return "<span class='tr-spark' aria-hidden='true'>" + days.map(function (d) {
    const n = byDay[d] || 0;
    return "<i style='height:" + Math.max(2, Math.round(n / mx * 18)) + "px' title='" + d + ": listed by " + n + (n === 1 ? " platform" : " platforms") + "'></i>";
  }).join("") + "</span>";
}

async function crowdWatchRender() {
  const el = document.getElementById("crowd-watch");
  if (!el) return;
  if (!(self.ATCloud && ATCloud.enabled())) { el.innerHTML = ""; return; }
  let list, series = [], opt = null;
  try { list = await ATCloud.crowdSettled(45); } catch (e) { el.innerHTML = ""; return; } // not signed in, or the backend is older
  const gone = cwDismissed();
  list = list.filter(function (r) { return !gone[r.ticker + "|" + r.last_trend]; });
  try { opt = await ATCloud.crowdEmailGet(); } catch (e) { /* no e-mail option without the table */ }
  if (list.length) { try { series = await ATCloud.crowdStockDaily(list.map(function (r) { return r.ticker; }), 45); } catch (e) { /* the list still reads without the bars */ } }
  let h = "<h4 class='wm-h net-h'>Back to earth</h4><div class='muted small'>Stocks that trended on the platforms we track and that you looked at around then, once their attention has been quiet for at least 3 days. This describes attention, not a reason to buy or sell.</div>";
  if (!list.length) h += "<div class='muted small' style='margin:8px 0'>None right now.</div>";
  else {
    h += "<table class='an-table wm-table'><thead><tr><th>Ticker</th><th>Trended until</th><th>Where</th><th>You looked</th><th>Quiet for</th><th>Last 30 days <span class='muted small'>(platforms listing it)</span></th><th></th></tr></thead><tbody>" +
      list.map(function (r) {
        const key = escapeHtml(r.ticker + "|" + r.last_trend);
        return "<tr><td><b>" + escapeHtml(r.ticker) + "</b></td><td>" + escapeHtml(r.last_trend) + " <span class='muted small'>best rank " + r.peak_rank + "</span></td><td>" +
          r.sources.map(function (s) { return escapeHtml(CW_NAMES[s] || s); }).join(", ") + "</td><td>" + r.my_views + (r.my_views === 1 ? " time" : " times") + "</td><td>" + r.quiet_days + " days</td><td>" +
          cwSpark(series, r.ticker) + "</td><td><button class='tr-chipbtn' data-cw-dismiss='" + key + "'>Dismiss</button></td></tr>";
      }).join("") + "</tbody></table>";
  }
  if (opt) h += "<label class='muted small' style='display:block;margin:8px 0'><input type='checkbox' data-cw-email" + (opt.on ? " checked" : "") + "> Also e-mail me when this happens" + (opt.email ? " (to " + escapeHtml(opt.email) + ")" : "") + "</label>";
  el.innerHTML = h;
}

document.addEventListener("click", function (ev) {
  const b = ev.target.closest && ev.target.closest("[data-cw-dismiss]");
  if (!b) return;
  cwDismiss(b.getAttribute("data-cw-dismiss"));
  crowdWatchRender();
});
document.addEventListener("change", async function (ev) {
  if (!ev.target.matches || !ev.target.matches("input[data-cw-email]")) return;
  const box = ev.target;
  try { await ATCloud.crowdEmailSet(box.checked); }
  catch (e) { box.checked = !box.checked; alert("Could not save this: " + (e && e.message || e)); }
});
