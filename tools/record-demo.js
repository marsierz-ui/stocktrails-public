// Records the silent demo walkthrough (tools/demo-server.js + docs/hackathon/demo/fomo/)
// to frames/ via the Chrome screencast; frames.txt is an ffmpeg concat list. Needs
// playwright-core installed next to it (not a project dependency) and a Playwright Chromium:
//   node tools/demo-server.js   (another terminal)
//   node record-demo.js && ffmpeg -f concat -safe 0 -i frames.txt -vf "scale=1920:1080:flags=lanczos,fps=30,format=yuv420p" -c:v libx264 -crf 18 demo.mp4
const { chromium } = require("playwright-core");
const fs = require("fs"), path = require("path");
const DEMO = path.join(__dirname, "..", "docs", "hackathon", "demo", "fomo") + path.sep;
const EXE = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const W = 1600, H = 900, FR = path.join(__dirname, "frames");

const OVERLAY = `(() => {
  const css = "#demo-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);transition:none}" +
    "#demo-ring{position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;border:3px solid #5eead4;border-radius:50%;z-index:2147483646;pointer-events:none;opacity:0;transform:scale(.4);transition:opacity .45s,transform .45s}" +
    "#demo-ring.on{opacity:.9;transform:scale(1)}" +
    "#demo-cap{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);max-width:1100px;padding:12px 22px;border-radius:12px;background:rgba(10,14,22,.88);color:#f1f5f9;font:600 21px/1.35 system-ui,Segoe UI,sans-serif;z-index:2147483645;pointer-events:none;opacity:0;transition:opacity .35s;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.45);border:1px solid rgba(94,234,212,.35)}" +
    "#demo-cap.on{opacity:1}";
  const add = () => {
    if (document.getElementById("demo-cursor")) return;
    const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
    const c = document.createElement("div"); c.id = "demo-cursor";
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 1 L2 18 L6.5 13.8 L9.6 20.5 L12.6 19.2 L9.6 12.6 L16 12.6 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const r = document.createElement("div"); r.id = "demo-ring";
    const cap = document.createElement("div"); cap.id = "demo-cap";
    document.body.append(c, r, cap);
    c.style.left = (window.__mx || 800) + "px"; c.style.top = (window.__my || 450) + "px";
    addEventListener("mousemove", (e) => { window.__mx = e.clientX; window.__my = e.clientY; c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", (e) => { r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px"; r.classList.add("on"); setTimeout(() => r.classList.remove("on"), 380); }, true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
})();`;

(async () => {
  fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR);
  const b = await chromium.launch({ executablePath: EXE, args: ["--hide-scrollbars"] });
  const ctx = await b.newContext({ viewport: { width: W, height: H }, bypassCSP: true, colorScheme: "dark" });
  await ctx.addInitScript(OVERLAY);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  p.on("dialog", (d) => setTimeout(() => d.accept(), 900));

  // screencast
  const cdp = await ctx.newCDPSession(p), frames = [];
  let n = 0;
  cdp.on("Page.screencastFrame", async (f) => {
    const file = "f" + String(n++).padStart(5, "0") + ".jpg";
    fs.writeFileSync(path.join(FR, file), Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });

  const pause = (ms) => p.waitForTimeout(ms);
  let mx = 800, my = 450;
  const moveTo = async (x, y, steps) => {
    const n = steps || Math.max(18, Math.round(Math.hypot(x - mx, y - my) / 22));
    for (let i = 1; i <= n; i++) { const k = i / n, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; await p.mouse.move(mx + (x - mx) * e, my + (y - my) * e); await pause(12); }
    mx = x; my = y;
  };
  const box = async (sel) => { const l = p.locator(sel).first(); await l.scrollIntoViewIfNeeded(); const bb = await l.boundingBox(); return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }; };
  const click = async (sel) => { const c = await box(sel); await moveTo(c.x, c.y); await pause(250); await p.mouse.down(); await pause(80); await p.mouse.up(); await pause(400); };
  const hover = async (sel, ms) => { const c = await box(sel); await moveTo(c.x, c.y); await pause(ms || 1200); };
  const caption = (t) => p.evaluate((t) => { const c = document.getElementById("demo-cap"); if (!c) return; if (t) { c.textContent = t; c.classList.add("on"); } else c.classList.remove("on"); }, t);
  const scrollBy = async (dy, ms) => { const steps = Math.min(120, Math.max(10, Math.round(Math.abs(dy) / 25))); for (let i = 0; i < steps; i++) { await p.evaluate((d) => window.scrollBy(0, d), dy / steps); await pause((ms || 1200) / steps); } };
  const scrollToSel = async (sel, offset) => {
    const bb = await p.locator(sel).first().boundingBox(), y = bb ? bb.y - (offset || 110) : 0;
    await scrollBy(y, Math.min(2600, Math.max(900, Math.abs(y) * 1.2)));
  };
  const type = async (sel, text) => { await click(sel); for (const ch of text) { await p.keyboard.type(ch); await pause(110); } };
  const selectVia = async (sel, label) => { await hover(sel, 500);
    const ok = await p.evaluate(([s, l]) => { const e = document.querySelector(s); const o = [...e.options].find((x) => x.textContent.trim() === l); if (!o) return [...e.options].map((x) => x.textContent); e.value = o.value; e.dispatchEvent(new Event("change", { bubbles: true })); return true; }, [sel, label]);
    if (ok !== true) console.log("options", ok);
    await pause(500); };

  await p.goto("http://127.0.0.1:8781/");
  await pause(1200);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
  await p.mouse.move(mx, my);

  // 1. empty account
  await caption("A new Stocktrails account: no trades, no research recorded yet");
  await pause(3500);

  // 2. browsing history
  await caption("Step 1: bring in past research from your Chrome browsing history");
  await click("button[data-m='settings']");
  await pause(600);
  await click("#main-settings button[data-sub='data']");
  await pause(500);
  await hover("#history-import", 1500);
  const [fc] = await Promise.all([p.waitForEvent("filechooser"), click("#history-import")]);
  await caption("History.json (Google Takeout export): only visits to finance sites are kept");
  await pause(1200);
  await fc.setFiles(DEMO + "History.json");
  await p.waitForFunction(() => /Added/.test(document.getElementById("history-status").textContent), null, { timeout: 60000 });
  await hover("#history-status", 400);
  await caption("361 stock-page visits on 37 stocks became research history");
  await pause(3500);

  // 3. trades
  await caption("Step 2: import the broker's transaction export");
  await click("button[data-m='attention']");
  await click("button[data-sub='trades']");
  await pause(900);
  await selectVia("select[data-act='broker']", "Other broker");
  await pause(600);
  const [fc2] = await Promise.all([p.waitForEvent("filechooser"), click(".tr-drop u")]);
  await pause(700);
  await fc2.setFiles(DEMO + "trades.csv");
  await pause(1200);
  await caption("90 buys and 53 sales are read in the browser: nothing is uploaded");
  await pause(2500);
  await click("button:text-matches('^Import \\\\d+ records$')");
  await caption("Matching each stock and loading two years of real prices");
  await p.waitForSelector("text=What your trades say about you", { timeout: 120000 });
  await pause(800);

  // 4. what the trades say
  await caption("What your trades say about you: patterns, strongest first");
  await pause(2200);
  await hover("text=You chase the market", 2600);
  await caption("The habit: buying after the market and the stock have already run up");
  await pause(3000);
  await hover("text=Attention spikes drive your buying", 2200);
  await hover("text=Trading more than your information", 2200);
  await caption(null);

  // 5. check a buy
  await scrollToSel(".tr-check", 140);
  await caption("Before the next buy: check it against what is true right now");
  await selectVia("#tr-check-t", await p.evaluate(() => { const o = [...document.querySelectorAll("#tr-check-t option")].find((x) => /NVDA/.test(x.textContent)); return o ? o.textContent : document.querySelector("#tr-check-t option").textContent; }));
  await type("#tr-check-a", "1500");
  await click("button[data-coach='check']");
  await pause(1500);
  await p.waitForFunction(() => document.getElementById("tr-check-out").innerText.trim().length > 20, null, { timeout: 30000 }).catch(() => {});
  await pause(500);
  await scrollToSel("#tr-check-out", 260);
  await pause(5000);
  await caption(null);

  // 6. paper portfolios
  await scrollToSel("text=Paper portfolios", 100);
  await caption("Paper portfolios: your buys against the rules agent and the NASDAQ");
  await pause(2000);
  await scrollBy(420, 1500);
  await pause(3500);

  // 7. coach
  await scrollToSel("text=Coach: what to change", 90);
  await caption("Coach: the bias the data supports, tested on trades it had not seen");
  await pause(2000);
  await scrollBy(200, 900);
  await hover("text=Chasing price rises", 3500);
  await scrollBy(480, 1800);
  await pause(3000);
  await caption("Stocktrails: see how your research turns into your trades");
  await scrollBy(-(await p.evaluate(() => scrollY)), 2500);
  await pause(3500);
  await caption(null);
  await pause(800);

  await cdp.send("Page.stopScreencast");
  await pause(300);
  await b.close();
  const list = [];
  frames.forEach((f, i) => { const d = i + 1 < frames.length ? frames[i + 1].t - f.t : 1; list.push("file '" + path.join(FR, f.file).replace(/\\/g, "/") + "'", "duration " + Math.max(0.001, d).toFixed(4)); });
  list.push("file '" + path.join(FR, frames[frames.length - 1].file).replace(/\\/g, "/") + "'");
  fs.writeFileSync(path.join(__dirname, "frames.txt"), list.join("\n") + "\n");
  console.log("frames", frames.length, "seconds", (frames[frames.length - 1].t - frames[0].t).toFixed(1));
})().catch((e) => { console.error(e); process.exit(1); });
