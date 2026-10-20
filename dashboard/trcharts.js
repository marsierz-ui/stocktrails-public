// Canvas drawings for the Trades & research cards: a strip plot of buy sizes
// by market regime (question 10) and a path chart with a range band (question
// 5). Loaded after dashboard.js and before trades.js; relies on its globals
// (setupCanvas, TC, canvasHover, escapeHtml). Hover goes through the shared
// attachCanvasHover, which the caller attaches after drawing.

// Sizes on a log2 scale (0.5x, 1x, 2x ...): twice as large and half as large sit
// the same distance from the usual buy.
function trSizeLabel(v) { return v >= 1 ? (Math.round(v * 100) / 100) + "x" : "1/" + (Math.round(100 / v) / 100) + "x"; }

// groups: [{ label, sub, points: [{ v, title }], q1, median, q3 }]. Dots are
// jittered sideways (the same way every time), the box spans the middle half,
// the bar is the median; the line at 1x is the user's usual buy.
function trStripPlot(cv, tipId, groups) {
  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H;
  const padL = 46, padR = 12, padT = 12, padB = 46, pw = W - padL - padR, ph = H - padT - padB;
  let lo = 0.25, hi = 4;
  groups.forEach(function (g) { g.points.forEach(function (p) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }); });
  lo = Math.max(1 / 32, lo / 1.15); hi = Math.min(32, hi * 1.15);
  const l2 = Math.log2, span = l2(hi) - l2(lo) || 1;
  const Y = function (v) { return padT + (1 - (l2(Math.max(lo, Math.min(hi, v))) - l2(lo)) / span) * ph; };
  c.font = "10px sans-serif"; c.textBaseline = "alphabetic";
  for (let e = Math.ceil(l2(lo)); e <= Math.floor(l2(hi)); e++) {
    const v = Math.pow(2, e), y = Y(v);
    c.strokeStyle = e === 0 ? TC().ink(0.45) : TC().grid; c.lineWidth = e === 0 ? 1.5 : 1; c.setLineDash(e === 0 ? [5, 4] : []);
    c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
    c.setLineDash([]); c.textAlign = "right"; c.fillStyle = e === 0 ? TC().fg : TC().muted; c.fillText(trSizeLabel(v), padL - 5, y + 3);
  }
  const n = groups.length, colW = pw / n, dots = [];
  groups.forEach(function (g, i) {
    const cx = padL + colW * (i + 0.5), bw = Math.min(colW * 0.5, 120);
    if (g.q1 != null && g.q3 != null && g.points.length >= 4) {
      c.fillStyle = "rgba(61,220,151,0.14)"; c.strokeStyle = "rgba(61,220,151,0.55)"; c.lineWidth = 1;
      c.fillRect(cx - bw / 2, Y(g.q3), bw, Math.max(1, Y(g.q1) - Y(g.q3))); c.strokeRect(cx - bw / 2, Y(g.q3), bw, Math.max(1, Y(g.q1) - Y(g.q3)));
    }
    c.fillStyle = "#4e9eff";
    g.points.forEach(function (p, k) {
      const jx = (((k + 1) * 2654435761) % 1000) / 1000 - 0.5, x = cx + jx * bw * 0.8, y = Y(p.v);
      c.globalAlpha = 0.8; c.beginPath(); c.arc(x, y, 3.2, 0, Math.PI * 2); c.fill(); c.globalAlpha = 1;
      dots.push({ x: x, y: y, title: p.title });
    });
    if (g.median != null && g.points.length) {
      c.strokeStyle = "#3ddc97"; c.lineWidth = 2.5;
      c.beginPath(); c.moveTo(cx - bw / 2 - 6, Y(g.median)); c.lineTo(cx + bw / 2 + 6, Y(g.median)); c.stroke();
    }
    c.textAlign = "center"; c.fillStyle = TC().fg; c.font = "bold 11px sans-serif"; c.fillText(g.label, cx, H - 26);
    c.fillStyle = TC().muted; c.font = "10px sans-serif"; c.fillText(g.sub || "", cx, H - 12);
  });
  canvasHover[cv.id] = { kind: "scatter", dots: dots, tipId: tipId, base: cv.width ? c.getImageData(0, 0, cv.width, cv.height) : null, geom: { padT: padT, ph: ph } };
}

// series: [{ label, color, mean[], lo[], hi[] }] over days 0..n-1 (fractions);
// html(k) gives the hover text for day k. Y axis in percent.
function trPathChart(cv, tipId, series, html) {
  const s = setupCanvas(cv), c = s.c, W = s.W, H = s.H;
  const padL = 46, padR = 12, padT = 12, padB = 24, pw = W - padL - padR, ph = H - padT - padB;
  const n = series[0].mean.length;
  let lo = 0, hi = 0;
  series.forEach(function (sr) { sr.lo.forEach(function (v) { if (v < lo) lo = v; }); sr.hi.forEach(function (v) { if (v > hi) hi = v; }); });
  const tk = niceTicks(lo * 100, hi * 100, 5);
  lo = tk.min / 100; hi = tk.max / 100;
  const X = function (k) { return padL + (k / (n - 1)) * pw; }, Y = function (v) { return padT + (1 - (v - lo) / (hi - lo || 1)) * ph; };
  c.font = "10px sans-serif";
  tk.ticks.forEach(function (t) {
    const y = Y(t / 100);
    c.strokeStyle = t === 0 ? TC().ink(0.45) : TC().grid; c.lineWidth = t === 0 ? 1.5 : 1;
    c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
    c.textAlign = "right"; c.fillStyle = TC().muted; c.fillText((t > 0 ? "+" : "") + t.toFixed(tk.step < 1 ? 1 : 0) + "%", padL - 5, y + 3);
  });
  c.textAlign = "center"; c.fillStyle = TC().muted;
  [0, 10, 21, 42, n - 1].forEach(function (k) { if (k < n) c.fillText(k === 0 ? "call day" : k + " d", Math.min(W - padR - 12, Math.max(padL + 14, X(k))), H - 7); });
  series.forEach(function (sr) {
    c.fillStyle = sr.color; c.globalAlpha = 0.16;
    c.beginPath();
    for (let k = 0; k < n; k++) { if (k === 0) c.moveTo(X(k), Y(sr.hi[k])); else c.lineTo(X(k), Y(sr.hi[k])); }
    for (let k = n - 1; k >= 0; k--) c.lineTo(X(k), Y(sr.lo[k]));
    c.closePath(); c.fill(); c.globalAlpha = 1;
    c.strokeStyle = sr.color; c.lineWidth = 2;
    c.beginPath();
    for (let k = 0; k < n; k++) { if (k === 0) c.moveTo(X(k), Y(sr.mean[k])); else c.lineTo(X(k), Y(sr.mean[k])); }
    c.stroke();
  });
  const pts = [];
  for (let k = 0; k < n; k++) pts.push({ x: X(k), y: Y(series[0].mean[k]), v: series[0].mean[k], i: k });
  canvasHover[cv.id] = { kind: "line", lines: [{ label: series[0].label, color: series[0].color, pts: pts }], titles: pts.map(function (_, k) { return "Day " + k; }),
    html: pts.map(function (_, k) { return html(k); }), multi: false, tipId: tipId, base: cv.width ? c.getImageData(0, 0, cv.width, cv.height) : null, geom: { padT: padT, ph: ph } };
}
