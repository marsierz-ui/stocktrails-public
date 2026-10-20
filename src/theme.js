(function () {
  // Light / dark / device theme. Loaded from <head>, before the stylesheet
  // paints, so the page never flashes the wrong colours (an extension page
  // cannot use an inline script for this). The choice lives in localStorage
  // ("at_theme": dark | light | system); the stylesheet reads it through
  // html[data-theme], and canvas drawing reads the same values through
  // dashboard.js TC().
  // Clickjacking: GitHub Pages sends no X-Frame-Options and a meta CSP cannot set
  // frame-ancestors, so the web app refuses to show inside another site's frame.
  if (/^https?:$/.test(location.protocol) && window.top !== window.self) {
    document.documentElement.style.display = "none";
    try { window.top.location = window.self.location.href; } catch (e) { /* sandboxed frame: stays hidden */ }
  }
  const KEY = "at_theme", META = { dark: "#161a26", light: "#f2f4f9" };
  const listeners = [];

  function pref() {
    try { const v = localStorage.getItem(KEY); return v === "light" || v === "system" ? v : "dark"; } catch (e) { return "dark"; }
  }
  function systemTheme() {
    try { return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; } catch (e) { return "dark"; }
  }
  function resolve(p) { return p === "system" ? systemTheme() : (p === "light" ? "light" : "dark"); }

  function apply() {
    const t = resolve(pref());
    document.documentElement.setAttribute("data-theme", t);
    const m = document.querySelector("meta[name=theme-color]");
    if (m) m.setAttribute("content", META[t]);
    return t;
  }
  function notify(t) { listeners.forEach(function (fn) { try { fn(t); } catch (e) { /* a listener must not break the others */ } }); }

  function set(p) {
    try { localStorage.setItem(KEY, p === "light" || p === "system" ? p : "dark"); } catch (e) { /* private mode: applies for this page only */ }
    const t = apply();
    notify(t);
    return t;
  }

  try {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onSys = function () { if (pref() === "system") notify(apply()); };
    if (mq.addEventListener) mq.addEventListener("change", onSys); else if (mq.addListener) mq.addListener(onSys);
  } catch (e) { /* no media query support: "device" then means dark */ }

  const api = {
    pref: pref,
    resolved: function () { return document.documentElement.getAttribute("data-theme") || "dark"; },
    set: set,
    onChange: function (fn) { listeners.push(fn); }
  };
  if (typeof self !== "undefined") self.ATTheme = api;
  apply();
  document.addEventListener("DOMContentLoaded", apply); // the theme-color <meta> exists by then
})();
