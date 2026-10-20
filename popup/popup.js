// Groups touching this file: GROUP 5 (5a "I took a position" toggle, 5b target
// price), both shown only after a sentiment label exists for the current ticker.
let activeTab = null;
let activeHit = null;

// Required sign-in: mirror the app gate. The dashboard sets at_cloud_signed_in when it shares a session.
async function isSignedIn() {
  if (!(self.AT_SUPABASE_URL && self.AT_SUPABASE_ANON)) return true; // cloud not configured
  try {
    const r = await chrome.storage.local.get("at_cloud_signed_in");
    return !!(r && r.at_cloud_signed_in);
  } catch (e) { return false; }
}

async function init() {
  document.getElementById("open-dash").addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html#performance") });
  });

  if (!(await isSignedIn())) {
    document.getElementById("auth-gate").classList.remove("hidden");
    document.getElementById("current").classList.add("hidden");
    document.querySelector(".recent").classList.add("hidden");
    return; // no tracking UI until signed in
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0] || null;
  const data = await ATStore.getAll();
  activeHit = activeTab && activeTab.url ? ATPortals.detect(activeTab.url, data.customPortals) : null;
  renderCurrent();
  renderRecent();

  document.getElementById("log-now").addEventListener("click", function () {
    logCurrent(null);
  });
  document.querySelectorAll(".sent").forEach(function (b) {
    b.addEventListener("click", function () { logCurrent(b.getAttribute("data-s")); });
  });
  document.getElementById("pos-taken").addEventListener("change", function () {
    if (!activeHit) return;
    chrome.runtime.sendMessage({ type: "position", ticker: activeHit.ticker, value: this.checked }, function () { void chrome.runtime.lastError; });
    flash(this.checked ? "Marked position taken" : "Position cleared");
  });
  document.getElementById("target-price").addEventListener("change", function () {
    if (!activeHit) return;
    const v = this.value === "" ? null : Number(this.value);
    chrome.runtime.sendMessage({ type: "target", ticker: activeHit.ticker, value: v }, function () { void chrome.runtime.lastError; });
    flash(v == null ? "Target cleared" : "Target set " + v);
  });
  document.getElementById("rationale").addEventListener("change", function () {
    if (!activeHit) return;
    chrome.runtime.sendMessage({ type: "rationale", ticker: activeHit.ticker, value: this.value }, function () { void chrome.runtime.lastError; });
    flash(this.value.trim() ? "Rationale saved" : "Rationale cleared");
  });
  document.getElementById("horizon").addEventListener("change", async function () {
    if (!activeHit) return;
    const v = this.value === "" ? null : Number(this.value);
    chrome.runtime.sendMessage({ type: "horizon", ticker: activeHit.ticker, value: v }, function () { void chrome.runtime.lastError; });
    flash(v == null ? "Horizon cleared" : "Horizon set");
    showHorizonHint(await latestEvent(activeHit.ticker), v);
  });
}

// GROUP 5c: the deadline implied by the horizon, so the choice is concrete.
function showHorizonHint(e, days) {
  const el = document.getElementById("horizon-hint");
  if (!el) return;
  if (days == null) { el.textContent = ""; return; }
  const from = (e && e.ts) ? e.ts : Date.now();
  el.textContent = "Target by " + new Date(from + days * 86400000).toISOString().slice(0, 10);
}

// Latest event for the current ticker (drives the existing-label/extra fields).
async function latestEvent(ticker) {
  const data = await ATStore.getAll();
  return data.events.filter(function (e) { return e.ticker === ticker; })
    .sort(function (a, b) { return b.ts - a.ts; })[0] || null;
}

function renderCurrent() {
  const empty = document.getElementById("current-empty");
  const body = document.getElementById("current-body");
  if (!activeHit) {
    empty.classList.remove("hidden");
    body.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  body.classList.remove("hidden");
  document.getElementById("cur-ticker").textContent = activeHit.ticker;
  document.getElementById("cur-source").textContent = activeHit.source;
  latestEvent(activeHit.ticker).then(function (e) {
    // Position taken + target price are gated on having a sentiment label.
    if (e && e.sentiment) {
      highlight(e.sentiment);
      showExtra(e);
    } else {
      document.getElementById("extra").classList.add("hidden");
      document.getElementById("cur-badges").innerHTML = "";
    }
  });
}

// GROUP 5a/5b: reveal + populate the Position taken toggle and target price.
function showExtra(e) {
  const extra = document.getElementById("extra");
  extra.classList.remove("hidden");
  document.getElementById("pos-taken").checked = !!(e && e.positionTaken);
  document.getElementById("target-price").value = (e && e.targetPrice != null) ? e.targetPrice : "";
  document.getElementById("rationale").value = (e && e.rationale != null) ? e.rationale : "";
  const hz = (e && e.horizonDays != null) ? e.horizonDays : null;
  document.getElementById("horizon").value = hz == null ? "" : String(hz);
  showHorizonHint(e, hz);
  renderBadges(e);
}

// PREREQ B: header badges. "Position" shows when a position is marked; "Target
// hit" needs the live price, fetched best-effort (direction follows the label).
async function renderBadges(e) {
  const el = document.getElementById("cur-badges");
  if (!el) return;
  let html = (e && e.positionTaken) ? "<span class='badge pos'>📌 Position</span>" : "";
  el.innerHTML = html;
  if (e && e.targetPrice != null && self.ATPrices && activeHit) {
    try {
      const q = await ATPrices.fetchQuote(activeHit.ticker);
      if (q && !isNaN(q.close)) {
        const hit = e.sentiment === "negative" ? q.close <= e.targetPrice : q.close >= e.targetPrice;
        if (hit) el.innerHTML = html + "<span class='badge tgt'>🎯 Target hit</span>";
      }
    } catch (err) { /* price best-effort */ }
  }
}

async function logCurrent(sentiment) {
  if (!activeHit) return;
  const type = sentiment ? "label" : "attention";
  await chrome.runtime.sendMessage({
    type: type, ticker: activeHit.ticker, source: activeHit.source, url: activeTab.url, sentiment: sentiment
  });
  flash(sentiment ? "Saved as " + sentiment : "Logged " + activeHit.ticker);
  highlight(sentiment);
  if (sentiment) { const e = await latestEvent(activeHit.ticker); showExtra(e); } // GROUP 5a/5b
  renderRecent();
}

function highlight(sentiment) {
  document.querySelectorAll(".sent").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-s") === sentiment);
  });
}

function flash(text) {
  const el = document.getElementById("status");
  el.textContent = text;
  setTimeout(function () { el.textContent = ""; }, 2000);
}

async function renderRecent() {
  const data = await ATStore.getAll();
  const recent = data.events.slice().sort(function (a, b) { return b.ts - a.ts; }).slice(0, 6);
  const ul = document.getElementById("recent-list");
  ul.innerHTML = "";
  if (!recent.length) {
    const li = document.createElement("li");
    li.className = "muted small";
    li.textContent = "Nothing tracked yet.";
    ul.appendChild(li);
    return;
  }
  recent.forEach(function (e) {
    const li = document.createElement("li");
    const left = document.createElement("span");
    const dot = document.createElement("span");
    dot.className = "dot " + (e.sentiment || "none");
    left.appendChild(dot);
    left.appendChild(document.createTextNode(e.ticker));
    const right = document.createElement("span");
    right.className = "muted small";
    right.textContent = timeAgo(e.ts);
    li.appendChild(left);
    li.appendChild(right);
    ul.appendChild(li);
  });
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

init();
