// An (i) popup on every headline of the app. A headline carries its explanation in one of
// three ways: the page builds it with trInfo() itself (the Trades & research cards), it has a
// title attribute (its text moves into the popup), or it is listed here by its text (or by its
// id). Headlines are found as they appear, so those the page draws later get theirs too.
// tools/test-headinfo.js checks that every headline of dashboard.html has one of the three.
(function () {
  const BY_TEXT = {
    "watchlist": "Every stock you have looked at, with your latest label, the price when you first looked, how it moved since and your conviction in it. Click a column to sort; click a stock to see it on the chart.",
    "usage summary": "Headline numbers for the selected period: what you recorded and how much of it, so you can see at a glance how active your research was.",
    "calendar": "A heatmap with one square per day over the last year; the darker the square, the more you did that day.",
    "over time": "The selected measure per period (day, week or month) across the chosen range, so you can see when your research rose or fell.",
    "by stock over time": "One line per stock: its share of your attention per period, to see which stocks you moved to or away from.",
    "distributions": "How your research is spread: by hour of the day, by weekday, by sector and industry, and which stocks got the most.",
    "by hour": "When in the day you research, in your local time.",
    "by weekday": "Which days of the week you research most.",
    "by sector": "Which sectors your research goes to.",
    "by industry": "Which industries your research goes to.",
    "most attended": "The stocks you looked at most often in the selected period.",
    "most time": "The stocks you spent the most active minutes on in the selected period.",
    "market correlation": "How closely your day-to-day research activity moves with the NASDAQ's daily returns (Pearson r, rolling and point in time). Near zero means your activity does not follow the market.",
    "event study": "The average return after each kind of label you gave a stock, by horizon. It tests whether your Positive, Neutral and Negative calls carried information and how long the signal lasts.",
    "outlook mix over time": "How many Positive, Neutral and Negative labels you gave per period (green, grey, red), stacked, to show when you were more bullish or bearish.",
    "scorecard": "Your calls scored from the price when you made them to the price at their deadline (or today for open calls): how many were right, and by how much.",
    "pace": "One dot per open prediction: how much of its horizon is used (across) against how much of the move to your target is made (up). Above the diagonal you are ahead of schedule, below you are behind.",
    "accuracy by horizon": "The directional hit rate of your resolved calls, grouped by the horizon you chose, against a 50% coin-flip baseline. It shows which time frames you read well.",
    "track record over time": "The cumulative hit rate as each prediction resolves, against the 50% baseline. Rising means you are improving; it is noisy until about 10 calls have resolved.",
    "timing calibration": "For targets that were reached: how much of the horizon had passed when they got there. Mass on the left means your targets arrive early; on the right, only just in time.",
    "predictions": "Every call with a target price and a horizon, with its status (open, hit, missed) and result. Calls without a horizon are listed but stay out of the accuracy numbers.",
    "ranking": "Where you stand among all active users over the last 30 days, as percentiles. It describes activity, not skill.",
    "you vs the crowd": "How closely your daily mix of viewed stocks matches the whole community's and the wider internet's attention (cosine similarity; 100% means you look at exactly what they look at).",
    "trending now": "Today's community views against what each stock's trailing 7-day views per active user would predict, so you can see what is suddenly drawing attention.",
    "account": "Your sign-in. With a Google account your data syncs to the cloud across devices automatically.",
    "how you use stocktrails": "How often you used each section of the app. It is synced to improve the app; no page content or personal data is part of it.",
    "data": "Export a backup of your data, merge one back in, or clear everything on this device.",
    "research from your browsing history": "Adds research Stocktrails did not see live, from before you installed it or from another browser. The file is read on this device; every other site in it is discarded and the file is not stored or uploaded.",
    "appearance": "Choose dark, light or follow the device's setting.",
    "portals": "The finance sites Stocktrails recognises. You can add your own site with a URL pattern containing {ticker}.",
    "what your trades say about you": "The strongest patterns your imported trades and your attention support, each from a question further down. A pattern shows only when its statistics clear the bar, and strongest comes first.",
    "questions": "The questions about your decisions, grouped by stage: research and attention, buying, calls, selling and your whole portfolio. Each answers with your own numbers and says when there is not enough data.",
    "your biases": "The habits the statistics support for you, each with the rules that would have helped on trades the method had not seen. Adopt a rule here, and keep or retire it in the same card.",
    "views per day around your buys": "How many views you recorded per day around your buy days; day 0 is the day of the trade.",
    "by research time before the buy": "Your buys split into thirds by how long you had researched the stock beforehand, with the average result of each third against the NASDAQ."
  };
  const BY_ID = {
    "chart-title": "The selected stock over time: its price path indexed to 100 at the start of the shown window, with your attention and labels. With nothing selected it shows all your positions."
  };

  const norm = function (s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); };
  // exact text first, then the longest listed text the headline starts with
  function lookup(h) {
    if (h.id && BY_ID[h.id]) return BY_ID[h.id];
    const t = norm(h.textContent);
    if (BY_TEXT[t]) return BY_TEXT[t];
    let best = null;
    Object.keys(BY_TEXT).forEach(function (k) { if (t.indexOf(k) === 0 && (!best || k.length > best.length)) best = k; });
    return best ? BY_TEXT[best] : null;
  }

  const SKIP = "#auth-gate, #fb-modal, #signup-prompt, #terms-prompt, #tab-admin, .fb-box, .welcome";
  function enhance(root) {
    (root || document).querySelectorAll("h2, h3, h4, h5").forEach(function (h) {
      if (h.getAttribute("data-hi") || h.closest(SKIP)) return;
      if (h.querySelector(".tr-info") || (h.closest(".tr-q-head") && h.closest(".tr-q-head").querySelector(".tr-info"))) { h.setAttribute("data-hi", "1"); return; }
      const t = h.getAttribute("title");
      const text = (t && t.trim()) || lookup(h);
      h.setAttribute("data-hi", "1");
      if (!text) return;
      if (t) h.removeAttribute("title");
      const i = document.createElement("span");
      i.className = "tr-info"; i.tabIndex = 0; i.setAttribute("role", "button"); i.setAttribute("aria-label", "About " + (h.textContent || "").trim());
      i.appendChild(document.createTextNode("i"));
      const pop = document.createElement("span");
      pop.className = "tr-info-pop"; pop.setAttribute("role", "tooltip"); pop.textContent = text;
      i.appendChild(pop);
      h.appendChild(document.createTextNode(" "));
      h.appendChild(i);
    });
  }

  let timer = null;
  const soon = function () { clearTimeout(timer); timer = setTimeout(function () { enhance(document); }, 150); };
  const start = function () { enhance(document); new MutationObserver(soon).observe(document.body, { childList: true, subtree: true }); };
  if (typeof document !== "undefined") { if (document.body) start(); else document.addEventListener("DOMContentLoaded", start); }
  if (typeof self !== "undefined") self.ATHeadInfo = { lookup: lookup, BY_TEXT: BY_TEXT, BY_ID: BY_ID, norm: norm };
  if (typeof module !== "undefined" && module.exports) module.exports = { BY_TEXT: BY_TEXT, BY_ID: BY_ID, norm: norm };
})();
