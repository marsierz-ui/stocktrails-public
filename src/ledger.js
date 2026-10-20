(function () {
  // Broker export import: identify a CSV/XML file, parse it into canonical
  // transactions, and match instruments to tracked stocks by name.
  //
  // Everything here runs on the device. The file is read in memory and only the
  // canonical fields below survive parsing - card spending, transfers, IBANs,
  // counterparty names and payment references never reach a record, so they
  // cannot be stored, exported or synced by mistake.
  //
  // Canonical transaction:
  //   broker, extId, ts (UTC ms), date (broker's own calendar day), dateOnly,
  //   kind: buy | sell | dividend | withholding | adjust (share delta, no decision),
  //   isin, symbol, name, assetClass, qty (> 0 for buy/sell, signed for adjust),
  //   price, priceCcy, amount (>= 0, cash value in currency), fee, tax, currency,
  //   plan (broker says it was a savings-plan execution).
  //
  // Unknown row types are counted by reason, never guessed at: a cash event read
  // as a trade, or a dividend row's position size read as a share delta, would
  // corrupt every downstream statistic without looking wrong.

  // ---------- text ----------

  function stripBom(s) { return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }

  function detectDelimiter(line) {
    let best = ",", bestN = 0;
    [",", ";", "\t"].forEach(function (d) {
      let n = 0, q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') q = !q; else if (!q && c === d) n++;
      }
      if (n > bestN) { best = d; bestN = n; }
    });
    return best;
  }

  // RFC 4180: quoted fields, "" escapes, CRLF or LF, delimiters inside quotes.
  function parseCsv(text, delim) {
    const rows = [];
    let row = [], f = "", q = false, i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { f += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        f += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === delim) { row.push(f); f = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; i++; continue; }
      f += c; i++;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ""; }); });
  }

  // ---------- numbers ----------

  // dec: "." or "," when the format fixes it, else inferred per value. "1,234"
  // alone is read as a thousands group; files that use a decimal comma pass ",".
  function num(v, dec) {
    if (v == null) return null;
    let s = String(v).trim();
    if (!s || /^(-|--|n\/?a)$/i.test(s)) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[^0-9.,+\-]/g, "");
    if (s.indexOf("-") >= 0) { neg = !neg; s = s.replace(/[-+]/g, ""); } else s = s.replace(/\+/g, "");
    if (!/\d/.test(s)) return null;
    if (!dec) {
      const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
      if (lc >= 0 && ld >= 0) dec = lc > ld ? "," : ".";
      else if (lc >= 0) dec = /^\d{1,3}(,\d{3})+$/.test(s) ? "." : ",";
      else dec = ".";
    }
    if (dec === ",") s = s.replace(/\./g, "").replace(/,(?=.*,)/g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
    const x = parseFloat(s);
    return isFinite(x) ? (neg ? -x : x) : null;
  }

  // Decimal separator of a file, from its numeric cells: a separator followed
  // by 1-2 trailing digits is a decimal mark; "1.234,5" / "1,234.5" settle it too.
  function detectDecimal(values) {
    let comma = 0, dot = 0;
    values.forEach(function (v) {
      const s = String(v == null ? "" : v).trim();
      if (/\d\.\d{3},\d/.test(s) || /\d,\d{1,2}$/.test(s)) comma++;
      else if (/\d,\d{3}\.\d/.test(s) || /\d\.\d{1,2}$/.test(s)) dot++;
    });
    return comma > dot ? "," : ".";
  }

  function absOr0(x) { return x == null ? 0 : Math.abs(x); }

  // ---------- dates ----------

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    mrz: 3, "mär": 3, mai: 5, okt: 10, dez: 12, mrt: 3, mei: 5 };

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(y, m, d) { return y + "-" + pad2(m) + "-" + pad2(d); }

  // order: "ymd" | "dmy" | "mdy". Accepts - . / separators, 2- or 4-digit years,
  // month names (02-Apr-2025) and a compact yyyymmdd.
  function parseDate(s, order) {
    s = String(s || "").trim();
    let m = /^(\d{4})(\d{2})(\d{2})(?:\D|$)/.exec(s);
    if (m) return { y: +m[1], m: +m[2], d: +m[3] };
    m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(s);
    if (m) return { y: +m[1], m: +m[2], d: +m[3] };
    m = /^(\d{1,2})[-./ ]([A-Za-zäÄ]{3,})[-./ ](\d{2,4})/.exec(s);
    if (m) {
      const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo) return { y: fixYear(+m[3]), m: mo, d: +m[1] };
    }
    m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})/.exec(s);
    if (m) {
      const a = +m[1], b = +m[2], y = fixYear(+m[3]);
      return order === "mdy" ? { y: y, m: a, d: b } : { y: y, m: b, d: a };
    }
    return null;
  }
  function fixYear(y) { return y < 100 ? 2000 + y : y; }

  function parseTime(s) {
    const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ""));
    return m ? { h: +m[1], mi: +m[2], s: +(m[3] || 0) } : null;
  }

  // Offset of an IANA zone from UTC at an instant, in ms.
  function tzOffset(ms, tz) {
    const p = {};
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  }

  // Wall-clock time in a zone -> UTC ms (two passes settle DST edges).
  function zonedMs(y, m, d, h, mi, s, tz) {
    const guess = Date.UTC(y, m - 1, d, h, mi, s);
    if (!tz || tz === "UTC") return guess;
    const off = tzOffset(guess, tz);
    let t = guess - off;
    const off2 = tzOffset(t, tz);
    if (off2 !== off) t = guess - off2;
    return t;
  }

  // Date + optional time in a zone. A missing time is stamped at local noon and
  // flagged, so the analysis can treat same-day research as "before".
  function stamp(dateStr, timeStr, order, tz) {
    const d = parseDate(dateStr, order);
    if (!d || !d.y || !d.m || !d.d || d.m > 12 || d.d > 31) return null;
    const t = parseTime(timeStr);
    return {
      date: ymd(d.y, d.m, d.d),
      ts: zonedMs(d.y, d.m, d.d, t ? t.h : 12, t ? t.mi : 0, t ? t.s : 0, tz),
      dateOnly: !t
    };
  }

  // ISO 8601 with Z/offset. Fractions are cut to milliseconds first: Trade
  // Republic writes 5-6 fractional digits, which not every engine parses.
  function stampIso(s) {
    s = String(s || "").trim();
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
    if (!m) return null;
    const frac = m[3] ? (m[3] + "000").slice(0, 4) : "";
    const ts = Date.parse(m[1] + "T" + (m[2].length === 5 ? m[2] + ":00" : m[2]) + frac + (m[4] || "Z"));
    return isFinite(ts) ? { date: m[1], ts: ts, dateOnly: false } : null;
  }

  // ---------- ids ----------

  function fnv(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return ("0000000" + h.toString(16)).slice(-8);
  }
  function hashId(parts) {
    const s = parts.map(function (p) { return p == null ? "" : String(p); }).join("|");
    return "h" + fnv(s, 2166136261) + fnv(s, 0x9e3779b9);
  }

  // ---------- result plumbing ----------

  function newResult(fmt) {
    return { format: fmt.id, label: fmt.label, txs: [], skipped: {}, unknown: {}, rows: 0, notes: [] };
  }
  function skip(res, cat) { res.skipped[cat] = (res.skipped[cat] || 0) + 1; }
  function unknown(res, reason) { res.unknown[reason] = (res.unknown[reason] || 0) + 1; }

  function isIsin(s) { return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(String(s || "").trim().toUpperCase()); }

  function pushTx(res, o) {
    const qty = o.qty == null ? null : +o.qty;
    if ((o.kind === "buy" || o.kind === "sell") && !(qty > 0)) { unknown(res, o.kind + " without a share quantity"); return; }
    if (!o.isin && !o.symbol) { unknown(res, o.kind + " without ISIN or symbol"); return; }
    let price = o.price == null ? null : Math.abs(o.price);
    let amount = o.amount == null ? null : Math.abs(o.amount);
    if (price == null && amount && qty > 0 && o.kind !== "dividend") price = amount / qty;
    // An IPO allocation arrives as a BUY with a price but a zero amount (the
    // cash left earlier with the subscription), so its value is price x shares.
    if (!amount && price != null && qty > 0 && (o.kind === "buy" || o.kind === "sell")) amount = price * qty;
    res.txs.push({
      broker: res.format, extId: o.extId || null, ts: o.ts, date: o.date, dateOnly: !!o.dateOnly,
      kind: o.kind, isin: o.isin ? String(o.isin).trim().toUpperCase() : null,
      symbol: o.symbol ? String(o.symbol).trim() : null,
      name: o.name ? String(o.name).replace(/\s+/g, " ").trim().slice(0, 120) : null,
      assetClass: o.assetClass || null,
      qty: qty, price: price, priceCcy: (o.priceCcy || o.currency || "").toUpperCase() || null,
      amount: amount, fee: absOr0(o.fee), tax: absOr0(o.tax),
      currency: (o.currency || "").toUpperCase() || null,
      plan: !!o.plan
    });
  }

  // Missing broker ids are content hashes; the nth identical row in a file gets
  // #n so two genuine identical fills stay two, and a re-import stays idempotent.
  function finalize(res) {
    const seen = {};
    res.txs.forEach(function (t) {
      let id = t.extId || hashId([t.broker, t.ts, t.kind, t.isin, t.symbol, t.qty, t.price, t.amount]);
      seen[id] = (seen[id] || 0) + 1;
      if (seen[id] > 1) id += "#" + seen[id];
      t.extId = String(id);
    });
    res.txs.sort(function (a, b) { return a.ts - b.ts; });
    if (res.txs.length) { res.from = res.txs[0].date; res.to = res.txs[res.txs.length - 1].date; }
    res.counts = { buy: 0, sell: 0, dividend: 0, withholding: 0, adjust: 0 };
    res.txs.forEach(function (t) { res.counts[t.kind] = (res.counts[t.kind] || 0) + 1; });
    return res;
  }

  // Header lookup: lower-cased, whitespace-collapsed names -> column index.
  function headerIndex(header) {
    const m = {};
    header.forEach(function (h, i) {
      const k = String(h || "").replace(/^\ufeff/, "").trim().toLowerCase().replace(/\s+/g, " ");
      if (k && !(k in m)) m[k] = i;
    });
    return m;
  }
  function has(ix, names) { return names.every(function (n) { return n in ix; }); }
  function getter(row, ix) {
    return function (name) { const i = ix[name]; return i == null ? "" : String(row[i] == null ? "" : row[i]).trim(); };
  }

  // ---------- formats ----------

  // Trade Republic: in-app transaction export (2026). A full bank statement:
  // card spending and transfers share the file with trades. The type table is
  // the whole contract, mirrored from the Portfolio app's importer.
  const TR_COLUMNS = ["datetime", "date", "account_type", "category", "type", "asset_class", "name",
    "symbol", "shares", "price", "amount", "fee", "tax", "currency", "original_amount",
    "original_currency", "fx_rate", "description", "transaction_id"];
  const TR_RULES = {
    BUY: "buy", SELL: "sell", DIVIDEND: "dividend",
    MERGER: "adjust", REVERSE_SPLIT: "adjust", WARRANT_EXERCISE: "adjust", REDEMPTION: "adjust", FREE_DELIVERY: "adjust",
    CARD_TRANSACTION: "skip:card spending", CARD_TRANSACTION_INTERNATIONAL: "skip:card spending",
    CUSTOMER_INBOUND: "skip:cash transfers", CUSTOMER_OUTBOUND_REQUEST: "skip:cash transfers",
    TRANSFER_INBOUND: "skip:cash transfers", TRANSFER_OUTBOUND: "skip:cash transfers",
    TRANSFER_DIRECT_DEBIT_INBOUND: "skip:cash transfers", TRANSFER_INSTANT_INBOUND: "skip:cash transfers",
    TRANSFER_INSTANT_OUTBOUND: "skip:cash transfers",
    INTEREST_PAYMENT: "skip:interest, fees, taxes", FEE: "skip:interest, fees, taxes",
    TAX_OPTIMIZATION: "skip:interest, fees, taxes", SEC_ACCOUNT: "skip:interest, fees, taxes",
    STOCKPERK: "skip:bonuses", BENEFITS_SAVEBACK: "skip:bonuses", BONUS: "skip:bonuses", GIFT: "skip:bonuses",
    TILG: "skip:redemption cash legs", EARLY_REDEMPTION: "skip:redemption cash legs",
    IPO_SUBSCRIPTION: "skip:subscription cash legs", PRIVATE_MARKET_BUY: "skip:subscription cash legs"
  };

  function parseTradeRepublic(rows, h, res) {
    const ix = headerIndex(rows[h]);
    for (let r = h + 1; r < rows.length; r++) {
      res.rows++;
      const g = getter(rows[r], ix);
      const type = g("type").toUpperCase();
      const rule = TR_RULES[type];
      if (!rule) { unknown(res, "unmapped Trade Republic type " + (type || "(blank)")); continue; }
      if (rule.indexOf("skip:") === 0) { skip(res, rule.slice(5)); continue; }
      const st = stampIso(g("datetime")) || stamp(g("date"), "", "ymd", "Europe/Berlin");
      if (!st) { unknown(res, "unreadable date"); continue; }
      const shares = num(g("shares"), ".");
      const sym = g("symbol");
      const ac = g("asset_class").toUpperCase() || (sym && !isIsin(sym) ? "CRYPTO" : null);
      const base = {
        extId: g("transaction_id") || null, ts: st.ts, date: g("date") || st.date, dateOnly: st.dateOnly,
        isin: isIsin(sym) ? sym : null, symbol: isIsin(sym) ? null : sym, name: g("name"), assetClass: ac,
        fee: num(g("fee"), "."), tax: num(g("tax"), "."), currency: g("currency") || "EUR"
      };
      if (rule === "dividend") {
        // `shares` on a dividend row is the position size at payout, not a delta.
        pushTx(res, Object.assign(base, { kind: "dividend", qty: null, amount: num(g("amount"), ".") }));
      } else if (rule === "adjust") {
        if (!shares) { unknown(res, type + " without a share delta"); continue; }
        pushTx(res, Object.assign(base, { kind: "adjust", qty: shares, amount: null, fee: 0, tax: 0 }));
      } else {
        pushTx(res, Object.assign(base, {
          kind: rule, qty: Math.abs(shares || 0), price: num(g("price"), "."), priceCcy: g("currency") || "EUR",
          amount: num(g("amount"), ".")
        }));
      }
    }
  }

  // Scalable Capital: "Export transactions" in the broker app/web, semicolon
  // separated with a decimal comma. Status other than Executed (cancelled,
  // pending, rejected) never moved shares.
  function parseScalable(rows, h, res) {
    const ix = headerIndex(rows[h]);
    for (let r = h + 1; r < rows.length; r++) {
      res.rows++;
      const g = getter(rows[r], ix);
      const status = g("status").toLowerCase();
      if (status && status !== "executed") { skip(res, "not executed (cancelled, pending, rejected)"); continue; }
      const type = g("type").toLowerCase();
      const st = stamp(g("date"), g("time"), "ymd", "Europe/Berlin");
      if (!st) { unknown(res, "unreadable date"); continue; }
      const base = {
        extId: g("reference") || null, ts: st.ts, date: st.date, dateOnly: st.dateOnly,
        isin: g("isin"), name: g("description"), currency: g("currency") || "EUR",
        fee: num(g("fee"), ","), tax: num(g("tax"), ",")
      };
      if (/sell|verkauf/.test(type)) {
        pushTx(res, Object.assign(base, { kind: "sell", qty: Math.abs(num(g("shares"), ",") || 0), price: num(g("price"), ","), amount: num(g("amount"), ",") }));
      } else if (/savings plan|sparplan|buy|kauf/.test(type)) {
        pushTx(res, Object.assign(base, { kind: "buy", plan: /savings plan|sparplan/.test(type), qty: Math.abs(num(g("shares"), ",") || 0), price: num(g("price"), ","), amount: num(g("amount"), ",") }));
      } else if (/distribution|dividend|aussch/.test(type)) {
        pushTx(res, Object.assign(base, { kind: "dividend", qty: null, amount: num(g("amount"), ",") }));
      } else if (/deposit|withdraw|einzahl|auszahl|interest|zins|fee|geb|tax|steuer/.test(type)) {
        skip(res, "cash, interest, fees, taxes");
      } else {
        unknown(res, "unmapped Scalable Capital type " + (g("type") || "(blank)"));
      }
    }
  }

  // Interactive Brokers Flex Query, XML. Flat elements with attributes, so a
  // tokenizer is enough - and it never resolves entities or external references.
  function xmlAttrs(s) {
    const a = {}, re = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(s))) {
      a[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); }).replace(/&amp;/g, "&");
    }
    return a;
  }
  function xmlItems(text, tag) {
    const out = [], re = new RegExp("<" + tag + "\\b([^>]*?)/?>", "g");
    let m;
    while ((m = re.exec(text))) out.push(xmlAttrs(m[1]));
    return out;
  }
  // Flex can emit one activity at two levels of detail; keep the finer one.
  function preferLevel(items, keep, drop) {
    const lv = {};
    items.forEach(function (a) { lv[(a.levelOfDetail || "").toUpperCase()] = 1; });
    if (lv[keep] && lv[drop]) return items.filter(function (a) { return (a.levelOfDetail || "").toUpperCase() !== drop; });
    return items;
  }
  const IB_CLASS = { STK: "STOCK", FUND: "FUND", BOND: "BOND", BILL: "BOND", OPT: "DERIVATIVE", FOP: "DERIVATIVE",
    FUT: "DERIVATIVE", WAR: "DERIVATIVE", IOPT: "DERIVATIVE", CFD: "DERIVATIVE", CRYPTO: "CRYPTO" };
  function ibClass(cat, sub) {
    cat = String(cat || "").toUpperCase();
    if (cat === "STK" && /ETF/i.test(sub || "")) return "ETF";
    return cat ? (IB_CLASS[cat] || "OTHER") : null;
  }
  // Flex writes the account's report zone without naming it; ET is assumed.
  function ibStamp(dt, dateOnly) {
    const s = String(dt || "").trim();
    const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[;, T]+(\d{2}):?(\d{2}):?(\d{2}))?/.exec(s);
    if (!m) return null;
    if (m[4] == null || dateOnly) return { date: ymd(+m[1], +m[2], +m[3]), ts: zonedMs(+m[1], +m[2], +m[3], 12, 0, 0, "America/New_York"), dateOnly: true };
    return { date: ymd(+m[1], +m[2], +m[3]), ts: zonedMs(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], "America/New_York"), dateOnly: false };
  }

  function ibTrade(res, a) {
    res.rows++;
    const cat = (a.assetCategory || "").toUpperCase();
    // A query without the asset-class column still marks FX conversions: they
    // have no ISIN and a pair symbol (or none).
    if (cat === "CASH" || (!isIsin(a.isin) && (!a.symbol || /^[A-Z]{3}\.[A-Z]{3}$/.test(a.symbol)))) { skip(res, "currency conversions"); return; }
    const qty = num(a.quantity, ".");
    if (!qty) { unknown(res, "IBKR trade with zero quantity"); return; }
    const st = (a.dateTime && ibStamp(a.dateTime)) || ibStamp(a.tradeDate, true);
    if (!st) { unknown(res, "unreadable date"); return; }
    const comm = num(a.ibCommission, ".") || 0;
    pushTx(res, {
      extId: a.tradeID ? "T:" + a.tradeID : null, ts: st.ts, date: st.date, dateOnly: st.dateOnly,
      kind: qty > 0 ? "buy" : "sell", qty: Math.abs(qty), price: num(a.tradePrice, "."), priceCcy: a.currency,
      amount: a.proceeds != null ? num(a.proceeds, ".") : (a.tradeMoney != null ? num(a.tradeMoney, ".") : null),
      fee: comm < 0 ? -comm : 0, tax: num(a.taxes, "."), currency: a.currency,
      isin: isIsin(a.isin) ? a.isin : null, symbol: a.symbol, name: a.description, assetClass: ibClass(cat, a.subCategory)
    });
  }

  function ibCash(res, a) {
    res.rows++;
    const type = String(a.type || "").toLowerCase();
    const amount = num(a.amount, ".");
    const st = ibStamp(a.dateTime || a.settleDate || a.reportDate, !a.dateTime);
    if (!st) { unknown(res, "unreadable date"); return; }
    const base = {
      extId: a.transactionID ? "CT:" + a.transactionID : null, ts: st.ts, date: st.date, dateOnly: st.dateOnly,
      isin: isIsin(a.isin) ? a.isin : null, symbol: a.symbol, name: a.description, currency: a.currency, qty: null
    };
    if (/withholding/.test(type)) {
      if (!base.isin && !base.symbol) { skip(res, "cash, interest, fees, taxes"); return; }
      pushTx(res, Object.assign(base, { kind: "withholding", amount: 0, tax: amount }));
    } else if (/dividend/.test(type)) {
      pushTx(res, Object.assign(base, { kind: "dividend", amount: amount }));
    } else if (type) {
      skip(res, "cash, interest, fees, taxes");
    } else {
      unknown(res, "IBKR cash row without a type");
    }
  }

  function parseIbkrXml(text, res) {
    if (/<FlexStatementResponse\b/.test(text) && !/<FlexStatement\b/.test(text)) {
      throw new Error("This is an IBKR status reply, not a statement. Run the Flex Query again and save the report itself.");
    }
    preferLevel(xmlItems(text, "Trade"), "EXECUTION", "ORDER").forEach(function (a) { ibTrade(res, a); });
    preferLevel(xmlItems(text, "CashTransaction"), "DETAIL", "SUMMARY").forEach(function (a) { ibCash(res, a); });
    xmlItems(text, "CorporateAction").forEach(function (a) {
      res.rows++;
      const qty = num(a.quantity, "."), st = ibStamp(a.dateTime || a.reportDate, !a.dateTime);
      if (!qty || !st) { skip(res, "corporate actions without a share change"); return; }
      pushTx(res, { extId: a.transactionID ? "CA:" + a.transactionID : null, ts: st.ts, date: st.date, dateOnly: st.dateOnly,
        kind: "adjust", qty: qty, isin: isIsin(a.isin) ? a.isin : null, symbol: a.symbol, name: a.description,
        assetClass: ibClass(a.assetCategory, a.subCategory), currency: a.currency });
    });
  }

  // Flex Query as CSV: the same fields as the XML, as column headers. A query
  // with several sections repeats a header row per section; BOF/BOS/EOS marker
  // rows (when enabled) are skipped.
  // CSV column (lower-cased) -> the XML attribute name the shared code reads.
  const IB_CSV_FIELDS = {
    "buy/sell": "buySell", "tradedate": "tradeDate", "datetime": "dateTime", "isin": "isin", "symbol": "symbol",
    "description": "description", "quantity": "quantity", "tradeprice": "tradePrice", "trademoney": "tradeMoney",
    "proceeds": "proceeds", "currencyprimary": "currency", "currency": "currency", "ibcommission": "ibCommission",
    "taxes": "taxes", "tradeid": "tradeID", "assetclass": "assetCategory", "assetcategory": "assetCategory",
    "subcategory": "subCategory", "levelofdetail": "levelOfDetail", "type": "type", "amount": "amount",
    "settledate": "settleDate", "reportdate": "reportDate", "transactionid": "transactionID"
  };
  function ibCsvRow(header, row) {
    const a = {};
    header.forEach(function (k, i) {
      const name = IB_CSV_FIELDS[String(k || "").trim().toLowerCase()];
      if (name) a[name] = row[i] == null ? "" : String(row[i]).trim();
    });
    return a;
  }
  function parseIbkrFlexCsv(rows, h, res) {
    let header = rows[h], trades = [], cash = [];
    for (let r = h + 1; r < rows.length; r++) {
      const row = rows[r], first = String(row[0] || "").trim().toUpperCase();
      if (/^(BOF|BOA|BOS|EOS|EOA|EOF)$/.test(first)) continue;
      if (isIbFlexHeader(row)) { header = row; continue; }
      const a = ibCsvRow(header, row);
      if (a.tradePrice != null || a.buySell != null) {
        if (a.buySell && a.quantity && !/^-/.test(a.quantity) && /^SELL/i.test(a.buySell)) a.quantity = "-" + a.quantity;
        trades.push(a);
      } else if (a.type != null && a.amount != null) cash.push(a);
      else { res.rows++; unknown(res, "IBKR row in an unrecognised section"); }
    }
    preferLevel(trades, "EXECUTION", "ORDER").forEach(function (a) { ibTrade(res, a); });
    preferLevel(cash, "DETAIL", "SUMMARY").forEach(function (a) { ibCash(res, a); });
  }
  function isIbFlexHeader(row) {
    const ix = headerIndex(row);
    return ("tradeprice" in ix && "quantity" in ix) || ("buy/sell" in ix) ||
      ("type" in ix && "amount" in ix && ("settledate" in ix || "datetime" in ix || "reportdate" in ix));
  }

  // IBKR default Activity Statement CSV: every row starts with the section name
  // and Header/Data. Trades carry the ticker only; the Financial Instrument
  // Information section supplies ISIN and name.
  // A section can restate its header (stocks and forex trades have different
  // columns), so each data row is read against the header seen last above it.
  function eachActivityRow(rows, fn) {
    const heads = {};
    rows.forEach(function (row) {
      const sec = String(row[0] || "").trim(), kind = String(row[1] || "").trim();
      if (kind === "Header") { heads[sec] = headerIndex(row.slice(2)); return; }
      if (kind === "Data" && heads[sec]) fn(sec, getter(row.slice(2), heads[sec]));
    });
  }
  function parseIbkrActivity(rows, res) {
    const instr = {};
    eachActivityRow(rows, function (sec, g) {
      if (sec !== "Financial Instrument Information") return;
      const sym = g("symbol");
      if (sym) sym.split(/,\s*/).forEach(function (s) { instr[s] = { isin: g("security id"), name: g("description") }; });
    });
    let sawTrades = false;
    eachActivityRow(rows, function (sec, g) {
      if (sec === "Trades") {
        sawTrades = true;
        const disc = g("datadiscriminator").toLowerCase();
        if (disc && disc !== "order" && disc !== "trade") return; // SubTotal / Total / ClosedLot rows
        res.rows++;
        const cat = g("asset category").toLowerCase();
        if (/forex|cash/.test(cat)) { skip(res, "currency conversions"); return; }
        const qty = num(g("quantity"), ".");
        const st = ibActivityStamp(g("date/time"));
        if (!qty || !st) { unknown(res, "IBKR trade row without quantity or date"); return; }
        const sym = g("symbol"), info = instr[sym] || {};
        const comm = num(g("comm/fee"), ".") || 0;
        pushTx(res, { ts: st.ts, date: st.date, dateOnly: st.dateOnly, kind: qty > 0 ? "buy" : "sell", qty: Math.abs(qty),
          price: num(g("t. price"), "."), priceCcy: g("currency"), amount: num(g("proceeds"), "."), fee: comm < 0 ? -comm : 0,
          currency: g("currency"), symbol: sym, isin: isIsin(info.isin) ? info.isin : null, name: info.name,
          assetClass: /etf/.test(cat) ? "ETF" : (/stock/.test(cat) ? "STOCK" : null) });
      } else if (sec === "Dividends" || sec === "Withholding Tax") {
        const desc = g("description");
        if (!desc || /^total/i.test(g("currency"))) return;
        res.rows++;
        const st = ibActivityStamp(g("date"));
        const sym = (/^([A-Z0-9.]+)\s*\(/.exec(desc) || [])[1];
        const isin = (/\(([A-Z]{2}[A-Z0-9]{9}\d)\)/.exec(desc) || [])[1] || (sym && instr[sym] && instr[sym].isin);
        if (!st || (!sym && !isin)) { unknown(res, "IBKR dividend row without date or instrument"); return; }
        const amt = num(g("amount"), ".");
        pushTx(res, sec === "Dividends"
          ? { ts: st.ts, date: st.date, dateOnly: true, kind: "dividend", amount: amt, currency: g("currency"), symbol: sym, isin: isIsin(isin) ? isin : null, name: desc }
          : { ts: st.ts, date: st.date, dateOnly: true, kind: "withholding", amount: 0, tax: amt, currency: g("currency"), symbol: sym, isin: isIsin(isin) ? isin : null, name: desc });
      }
    });
    if (!sawTrades) throw new Error("No Trades section found. In IBKR, a Flex Query (XML) export is the most reliable; see the steps above.");
  }
  function ibActivityStamp(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:,?\s*(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || "").trim());
    if (!m) return null;
    return m[4] == null
      ? { date: ymd(+m[1], +m[2], +m[3]), ts: zonedMs(+m[1], +m[2], +m[3], 12, 0, 0, "America/New_York"), dateOnly: true }
      : { date: ymd(+m[1], +m[2], +m[3]), ts: zonedMs(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), "America/New_York"), dateOnly: false };
  }

  // DEGIRO Transactions.csv (Activity -> Transactions -> Export). Headers are
  // in the account language and several are blank (each amount is followed by
  // an unnamed currency column), so columns are read by position: date, time,
  // product, ISIN, exchange, venue, quantity, price, price currency, ...,
  // order id last. Quantity is negative on a sale.
  function parseDegiro(rows, h, res) {
    const head = rows[h].map(function (x) { return String(x || "").trim().toLowerCase(); });
    const feeCol = head.findIndex(function (x) { return /transac|kosten|geb[üu]hr|frais|cost|comisi|commission|spese/.test(x); });
    const totalCol = head.findIndex(function (x, i) { return i > 8 && /^(total|totaal|gesamt|totale|totaal)/.test(x); });
    const orderCol = head.length - 1 - head.slice().reverse().findIndex(function (x) { return /order/.test(x); });
    const body = rows.slice(h + 1);
    const dec = detectDecimal([].concat.apply([], body.map(function (r) { return [r[7], r[feeCol], r[totalCol]]; })));
    body.forEach(function (row) {
      res.rows++;
      const v = function (i) { return i >= 0 && row[i] != null ? String(row[i]).trim() : ""; };
      const st = stamp(v(0), v(1), "dmy", "Europe/Amsterdam");
      const qty = num(v(6), dec);
      if (!st) { unknown(res, "unreadable date"); return; }
      if (!qty) { unknown(res, "DEGIRO row without quantity"); return; }
      pushTx(res, {
        extId: v(orderCol) ? v(orderCol) + ":" + v(1) + ":" + v(6) + ":" + v(7) : null,
        ts: st.ts, date: st.date, dateOnly: st.dateOnly, kind: qty > 0 ? "buy" : "sell", qty: Math.abs(qty),
        price: num(v(7), dec), priceCcy: v(8), isin: v(3), name: v(2),
        amount: totalCol >= 0 ? num(v(totalCol), dec) : null, currency: totalCol >= 0 ? v(totalCol + 1) : v(8),
        fee: feeCol >= 0 ? num(v(feeCol), dec) : 0
      });
    });
    res.notes.push("DEGIRO's Transactions export has no dividends. They are only in the Account statement, which this import does not read yet.");
  }

  // Trading 212: History -> Export CSV. Time is written without a zone and
  // read as UTC. Fee columns vary by region (stamp duty, FX fee, French tax).
  function parseTrading212(rows, h, res) {
    const header = rows[h], ix = headerIndex(header);
    const feeCols = header.map(function (x, i) { return { n: String(x).toLowerCase(), i: i }; })
      .filter(function (c) { return /fee|stamp duty|transaction tax|charge amount/.test(c.n) && c.n.indexOf("currency (") !== 0; });
    const totalKey = Object.keys(ix).find(function (k) { return k === "total" || k.indexOf("total (") === 0; });
    const totalCcyKey = "currency (total)" in ix ? "currency (total)" : null;
    for (let r = h + 1; r < rows.length; r++) {
      res.rows++;
      const row = rows[r], g = getter(row, ix);
      const action = g("action").toLowerCase();
      const st = stampIso(g("time").replace(" ", "T"));
      if (!st) { unknown(res, "unreadable date"); continue; }
      const base = {
        extId: g("id") || null, ts: st.ts, date: st.date, dateOnly: false, isin: g("isin"), symbol: g("ticker"),
        name: g("name"), currency: totalCcyKey ? g(totalCcyKey) : (/\((\w{3})\)/.exec(totalKey || "") || [])[1]
      };
      const fee = feeCols.reduce(function (s, c) { return s + absOr0(num(row[c.i], ".")); }, 0);
      if (/stock split|stock distribution|spin/.test(action)) {
        const q = num(g("no. of shares"), ".");
        if (!q) { unknown(res, "share change without a quantity"); continue; }
        pushTx(res, Object.assign(base, { kind: "adjust", qty: /close/.test(action) ? -Math.abs(q) : Math.abs(q) }));
      } else if (/buy/.test(action) || /sell/.test(action)) {
        pushTx(res, Object.assign(base, {
          kind: /sell/.test(action) ? "sell" : "buy", qty: Math.abs(num(g("no. of shares"), ".") || 0),
          price: num(g("price / share"), "."), priceCcy: g("currency (price / share)"),
          amount: totalKey ? num(g(totalKey), ".") : null, fee: fee
        }));
      } else if (/dividend/.test(action)) {
        pushTx(res, Object.assign(base, { kind: "dividend", qty: null, amount: totalKey ? num(g(totalKey), ".") : null, tax: num(g("withholding tax"), ".") }));
      } else if (/deposit|withdraw|interest|card|cashback|transfer|lending|fee|conversion|spending/.test(action)) {
        skip(res, "cash, interest, fees, taxes");
      } else {
        unknown(res, "unmapped Trading 212 action " + (g("action") || "(blank)"));
      }
    }
  }

  // Revolut: Invest -> More -> Documents -> Account statement (CSV). Tickers
  // only, no ISIN; amounts carry the currency symbol.
  function parseRevolut(rows, h, res) {
    const ix = headerIndex(rows[h]);
    for (let r = h + 1; r < rows.length; r++) {
      res.rows++;
      const g = getter(rows[r], ix);
      const type = g("type").toLowerCase();
      const st = stampIso(g("date"));
      if (!st) { unknown(res, "unreadable date"); continue; }
      const base = { ts: st.ts, date: st.date, dateOnly: false, symbol: g("ticker"), currency: g("currency"), priceCcy: g("currency") };
      if (/^buy|^sell/.test(type)) {
        pushTx(res, Object.assign(base, { kind: type.indexOf("sell") === 0 ? "sell" : "buy", qty: Math.abs(num(g("quantity"), ".") || 0),
          price: num(g("price per share"), "."), amount: num(g("total amount"), ".") }));
      } else if (/dividend/.test(type)) {
        pushTx(res, Object.assign(base, { kind: "dividend", qty: null, amount: num(g("total amount"), ".") }));
      } else if (/split/.test(type)) {
        const q = num(g("quantity"), ".");
        if (!q) { skip(res, "corporate actions without a share change"); continue; }
        pushTx(res, Object.assign(base, { kind: "adjust", qty: q }));
      } else if (/cash|top-up|withdraw|fee|transfer|interest/.test(type)) {
        skip(res, "cash, interest, fees, taxes");
      } else {
        unknown(res, "unmapped Revolut type " + (g("type") || "(blank)"));
      }
    }
  }

  // Charles Schwab: History -> Export (CSV). Dates are MM/DD/YYYY, sometimes
  // "as of" a second date; amounts in USD with $ signs. No times, no ISIN.
  function parseSchwab(rows, h, res) {
    const ix = headerIndex(rows[h]);
    for (let r = h + 1; r < rows.length; r++) {
      const g = getter(rows[r], ix);
      if (/^transactions total/i.test(g("date"))) continue;
      res.rows++;
      const action = g("action").toLowerCase();
      const st = stamp(g("date").split(/\s+as of\s+/i)[0], "", "mdy", "America/New_York");
      if (!st) { unknown(res, "unreadable date"); continue; }
      const base = { ts: st.ts, date: st.date, dateOnly: true, symbol: g("symbol"), name: g("description"), currency: "USD", priceCcy: "USD" };
      if (/reinvest shares|^buy/.test(action) || action === "buy to open") {
        pushTx(res, Object.assign(base, { kind: "buy", plan: /reinvest/.test(action), qty: Math.abs(num(g("quantity"), ".") || 0),
          price: num(g("price"), "."), amount: num(g("amount"), "."), fee: num(g("fees & comm"), ".") }));
      } else if (/^sell/.test(action)) {
        pushTx(res, Object.assign(base, { kind: "sell", qty: Math.abs(num(g("quantity"), ".") || 0),
          price: num(g("price"), "."), amount: num(g("amount"), "."), fee: num(g("fees & comm"), ".") }));
      } else if (/div|cash in lieu/.test(action)) {
        pushTx(res, Object.assign(base, { kind: "dividend", qty: null, amount: num(g("amount"), ".") }));
      } else if (/foreign tax/.test(action) && base.symbol) {
        pushTx(res, Object.assign(base, { kind: "withholding", qty: null, amount: 0, tax: num(g("amount"), ".") }));
      } else if (/stock split/.test(action)) {
        const q = num(g("quantity"), ".");
        if (!q) { skip(res, "corporate actions without a share change"); continue; }
        pushTx(res, Object.assign(base, { kind: "adjust", qty: q }));
      } else {
        skip(res, "cash, interest, fees, taxes");
      }
    }
  }

  // Freetrade: Activity -> Export (CSV). ORDER rows carry the side in "Buy / Sell".
  function parseFreetrade(rows, h, res) {
    const ix = headerIndex(rows[h]);
    for (let r = h + 1; r < rows.length; r++) {
      res.rows++;
      const g = getter(rows[r], ix);
      const type = g("type").toUpperCase();
      const st = stampIso(g("timestamp"));
      if (!st) { unknown(res, "unreadable date"); continue; }
      const base = { extId: g("order id") || null, ts: st.ts, date: st.date, dateOnly: false, isin: g("isin"),
        symbol: g("ticker"), name: g("title"), currency: g("account currency") };
      if (type === "ORDER" || type === "FREESHARE_ORDER") {
        const side = g("buy / sell").toLowerCase();
        pushTx(res, Object.assign(base, { kind: side === "sell" ? "sell" : "buy", qty: Math.abs(num(g("quantity"), ".") || 0),
          price: num(g("price per share"), "."), priceCcy: g("instrument currency"), amount: num(g("total amount"), "."),
          fee: absOr0(num(g("stamp duty"), ".")) + absOr0(num(g("fx fee amount"), ".")) }));
      } else if (type === "DIVIDEND" || type === "PROPERTY") {
        pushTx(res, Object.assign(base, { kind: "dividend", qty: null, amount: num(g("total amount"), "."),
          tax: num(g("dividend withheld tax amount"), ".") }));
      } else {
        skip(res, "cash, interest, fees, taxes");
      }
    }
  }

  // XTB: History -> Cash operations (export). The trade sits in the comment:
  // "OPEN BUY 34/42.5658 @ 11.7480" (filled / ordered @ price). Times are
  // written without a zone and read as Europe/Warsaw (XTB's home exchange).
  function parseXtb(rows, h, res) {
    const ix = headerIndex(rows[h]);
    for (let r = h + 1; r < rows.length; r++) {
      res.rows++;
      const g = getter(rows[r], ix);
      const type = g("type").toLowerCase();
      const st = stamp(g("time").split(" ")[0], g("time").split(" ")[1], "dmy", "Europe/Warsaw");
      if (!st) { unknown(res, "unreadable date"); continue; }
      const sym = g("symbol").replace(/\.UK$/, ".L");
      const base = { extId: g("id") || null, ts: st.ts, date: st.date, dateOnly: false, symbol: sym };
      if (/purchase|compra|sale|vende/.test(type)) {
        const m = /(?:OPEN|CLOSE)\s+(?:BUY|SELL)\s+([\d.]+)(?:\/[\d.]+)?\s*@\s*([\d.]+)/i.exec(g("comment"));
        if (!m) { unknown(res, "XTB trade comment without quantity/price"); continue; }
        pushTx(res, Object.assign(base, { kind: /sale|vende/.test(type) ? "sell" : "buy", qty: +m[1], price: +m[2], amount: num(g("amount"), ".") }));
      } else if (/dividend|divident/.test(type)) {
        pushTx(res, Object.assign(base, { kind: "dividend", qty: null, amount: num(g("amount"), ".") }));
      } else if (/withholding/.test(type)) {
        pushTx(res, Object.assign(base, { kind: "withholding", qty: null, amount: 0, tax: num(g("amount"), ".") }));
      } else {
        skip(res, "cash, interest, fees, taxes");
      }
    }
  }

  // Saxo: Account -> Historic reports -> Transactions (CSV). The trade sits in
  // Event: "Buy 5 @ 139.74 USD" / "Sell 3 @ 139.74 USD".
  function parseSaxo(rows, h, res) {
    const ix = headerIndex(rows[h]);
    const dec = detectDecimal(rows.slice(h + 1).map(function (r) { return r[ix.amount]; }));
    for (let r = h + 1; r < rows.length; r++) {
      res.rows++;
      const g = getter(rows[r], ix);
      const type = g("type").toLowerCase(), ev = g("event");
      const st = stamp(g("trade date"), "", "dmy", "Europe/Copenhagen");
      if (!st) { unknown(res, "unreadable date"); continue; }
      const base = { extId: g("order id") || null, ts: st.ts, date: st.date, dateOnly: true, isin: g("instrument isin"),
        symbol: g("instrument symbol").split(":")[0], name: g("instrument"), currency: g("instrument currency"), priceCcy: g("instrument currency") };
      const m = /^(buy|sell)\s+([\d.,]+)\s*@\s*([\d.,]+)/i.exec(ev);
      if (type === "trade" && m) {
        pushTx(res, Object.assign(base, { kind: m[1].toLowerCase(), qty: num(m[2], "."), price: num(m[3], "."), amount: num(g("amount"), dec) }));
      } else if (/dividend/i.test(ev)) {
        pushTx(res, Object.assign(base, { kind: "dividend", qty: null, amount: num(g("amount"), dec) }));
      } else if (type === "trade") {
        unknown(res, "Saxo trade event without quantity/price");
      } else {
        skip(res, "cash, interest, fees, taxes");
      }
    }
  }

  // Stocktrails template, also the target of the column mapper. type: buy,
  // sell, dividend (a few synonyms accepted). Date ISO or day-first.
  const GENERIC_FIELDS = ["date", "time", "type", "isin", "symbol", "name", "quantity", "price", "amount", "fee", "tax", "currency"];
  const GENERIC_REQUIRED = ["date", "type", "quantity"];
  function parseGeneric(rows, h, res, mapping, opts) {
    const header = rows[h];
    const ix = mapping || headerIndex(header);
    opts = opts || {};
    const body = rows.slice(h + 1);
    const dec = opts.decimal || detectDecimal([].concat.apply([], body.map(function (r) { return [r[ix.quantity], r[ix.price], r[ix.amount]]; })));
    body.forEach(function (row) {
      res.rows++;
      const v = function (k) { const i = ix[k]; return i == null || i < 0 ? "" : String(row[i] == null ? "" : row[i]).trim(); };
      const type = v("type").toLowerCase();
      const isoSt = stampIso(v("date"));
      const st = isoSt || stamp(v("date"), v("time"), opts.dateOrder || "dmy", opts.tz || "UTC");
      if (!st) { unknown(res, "unreadable date"); return; }
      const q = num(v("quantity"), dec);
      let kind = null;
      if (/sell|sold|verkauf|sale|vente|venta/.test(type)) kind = "sell";
      else if (/buy|bought|kauf|purchase|achat|compra|savings plan|sparplan/.test(type)) kind = "buy";
      else if (/div|aussch|distribution/.test(type)) kind = "dividend";
      else if (!type && q) kind = q < 0 ? "sell" : "buy";
      if (!kind) { if (type) skip(res, "other row types (" + type.slice(0, 24) + ")"); else unknown(res, "row without type or quantity"); return; }
      const sym = v("symbol"), isin = v("isin") || (isIsin(sym) ? sym : "");
      pushTx(res, {
        ts: st.ts, date: st.date, dateOnly: st.dateOnly, kind: kind, qty: kind === "dividend" ? null : Math.abs(q || 0),
        price: num(v("price"), dec), amount: num(v("amount"), dec), fee: num(v("fee"), dec), tax: num(v("tax"), dec),
        isin: isin, symbol: isIsin(sym) ? null : sym, name: v("name"), currency: v("currency"), priceCcy: v("currency"),
        plan: /savings plan|sparplan/.test(type)
      });
    });
  }

  const FORMATS = [
    { id: "trade_republic", label: "Trade Republic", csv: true,
      match: function (ix) { return has(ix, TR_COLUMNS); }, parse: parseTradeRepublic },
    { id: "scalable", label: "Scalable Capital", csv: true,
      match: function (ix) { return has(ix, ["date", "time", "status", "reference", "description", "assettype", "type", "isin", "shares", "price", "amount", "currency"]); },
      parse: parseScalable },
    { id: "ibkr", label: "Interactive Brokers (Flex Query)", csv: true,
      match: function (ix, row) { return isIbFlexHeader(row); }, parse: parseIbkrFlexCsv },
    { id: "trading212", label: "Trading 212", csv: true,
      match: function (ix) { return has(ix, ["action", "time", "isin", "ticker", "no. of shares", "price / share"]); }, parse: parseTrading212 },
    { id: "revolut", label: "Revolut", csv: true,
      match: function (ix) { return has(ix, ["date", "ticker", "type", "quantity", "price per share", "total amount", "currency"]); }, parse: parseRevolut },
    { id: "schwab", label: "Charles Schwab", csv: true,
      match: function (ix) { return has(ix, ["date", "action", "symbol", "description", "quantity", "price", "fees & comm", "amount"]); }, parse: parseSchwab },
    { id: "freetrade", label: "Freetrade", csv: true,
      match: function (ix) { return has(ix, ["title", "type", "timestamp", "buy / sell", "ticker", "isin", "quantity"]); }, parse: parseFreetrade },
    { id: "xtb", label: "XTB", csv: true,
      match: function (ix) { return has(ix, ["id", "type", "time", "symbol", "comment", "amount"]); }, parse: parseXtb },
    { id: "saxo", label: "Saxo", csv: true,
      match: function (ix) { return has(ix, ["trade date", "type", "instrument", "instrument isin", "event", "amount"]); }, parse: parseSaxo },
    { id: "degiro", label: "DEGIRO", csv: true,
      match: function (ix, row) {
        return row.length >= 17 && String(row[3] || "").trim().toUpperCase() === "ISIN" &&
          String(row[8] || "").trim() === "" && /order/i.test(String(row[row.length - 1] || "") + String(row[row.length - 2] || ""));
      }, parse: parseDegiro },
    { id: "generic", label: "Stocktrails template", csv: true,
      match: function (ix) { return has(ix, GENERIC_REQUIRED) && ("isin" in ix || "symbol" in ix); }, parse: parseGeneric }
  ];
  const BY_ID = {}; FORMATS.forEach(function (f) { BY_ID[f.id] = f; });

  // ---------- detection + entry point ----------

  const MAX_BYTES = 25 * 1024 * 1024;

  function sniff(text) {
    text = stripBom(String(text || ""));
    const head = text.slice(0, 4096).trimStart();
    if (head[0] === "<") {
      if (/<(FlexQueryResponse|FlexStatements|FlexStatement|FlexStatementResponse)\b/.test(text.slice(0, 65536))) return { format: "ibkr_xml", label: "Interactive Brokers (Flex Query XML)" };
      return { format: null, reason: "XML file that is not an IBKR Flex statement" };
    }
    const firstLine = (head.split(/\r?\n/)[0] || "");
    if (/^"?(Statement|Account Information)"?,"?(Header|Data)"?/.test(firstLine)) return { format: "ibkr_activity", label: "Interactive Brokers (Activity Statement CSV)" };
    const lines = text.split(/\r?\n/).slice(0, 25);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const delim = detectDelimiter(lines[i]);
      const row = parseCsv(lines[i] + "\n", delim)[0] || [];
      const ix = headerIndex(row);
      for (let f = 0; f < FORMATS.length; f++) {
        if (FORMATS[f].match(ix, row)) return { format: FORMATS[f].id, label: FORMATS[f].label, delimiter: delim, headerLine: i, header: row };
      }
    }
    const fl = lines.find(function (l) { return l.trim(); }) || "";
    const delim = detectDelimiter(fl);
    const header = parseCsv(fl + "\n", delim)[0] || [];
    // DEGIRO's Account statement (Date, Time, Value date, Product, ISIN,
    // Description, FX, Change, ...) holds cash movements with the trades only
    // as free text in the account language - its Transactions export is the one to use.
    if (String(header[4] || "").trim().toUpperCase() === "ISIN" && /fx/i.test(String(header[6] || ""))) {
      return { format: null, reason: "this is DEGIRO's Account statement; export Activity -> Transactions instead", delimiter: delim, headerLine: lines.indexOf(fl), header: header };
    }
    return { format: null, reason: "columns not recognised", delimiter: delim, headerLine: lines.indexOf(fl), header: header };
  }

  // opts: { format, mapping: {field: columnIndex}, dateOrder, decimal, tz }
  function parseFile(text, opts) {
    opts = opts || {};
    if (text.length > MAX_BYTES) throw new Error("File is larger than 25 MB; export a shorter period.");
    text = stripBom(String(text));
    const sn = sniff(text);
    const fmtId = opts.mapping ? "generic" : (opts.format || sn.format);
    if (!fmtId) throw new Error("Could not identify this file (" + sn.reason + ").");
    if (fmtId === "ibkr_xml") {
      const res = newResult({ id: "ibkr", label: "Interactive Brokers (Flex Query XML)" });
      parseIbkrXml(text, res);
      return finalize(res);
    }
    if (fmtId === "ibkr_activity") {
      const res = newResult({ id: "ibkr", label: "Interactive Brokers (Activity Statement)" });
      parseIbkrActivity(parseCsv(text, ","), res);
      return finalize(res);
    }
    const fmt = BY_ID[fmtId];
    if (!fmt) throw new Error("Unknown format " + fmtId);
    const delim = opts.delimiter || sn.delimiter || detectDelimiter(text.split(/\r?\n/)[0]);
    // Blank lines are dropped here as in previewColumns, so headerRow indexes agree.
    const all = parseCsv(text, delim);
    // headerLine counts raw lines; parseCsv drops blank ones, so find the header row again.
    let h = 0;
    if (!opts.mapping) {
      for (let i = 0; i < Math.min(all.length, 25); i++) { if (fmt.match(headerIndex(all[i]), all[i])) { h = i; break; } }
    } else {
      h = Math.max(0, opts.headerRow || 0);
    }
    const res = newResult(opts.mapping ? { id: "generic", label: "Mapped CSV" } : fmt);
    if (opts.mapping) parseGeneric(all, h, res, opts.mapping, opts);
    else fmt.parse(all, h, res);
    return finalize(res);
  }

  // First rows of an unrecognised CSV, for the column mapper. Exports often
  // open with a title or account line, so the header is the first line with 3+
  // fields whose next line splits into as many fields with the same delimiter.
  function previewColumns(text) {
    text = stripBom(String(text));
    const lines = text.split(/\r?\n/).slice(0, 40).filter(function (l) { return l.trim(); });
    let delim = ",";
    for (let i = 0; i < lines.length - 1; i++) {
      const d = detectDelimiter(lines[i]);
      const n = (parseCsv(lines[i] + "\n", d)[0] || []).length;
      if (n >= 3 && (parseCsv(lines[i + 1] + "\n", d)[0] || []).length === n) { delim = d; break; }
    }
    const rows = parseCsv(lines.join("\n"), delim);
    let h = 0;
    for (let i = 0; i < rows.length; i++) { if (rows[i].length >= 3) { h = i; break; } }
    return { header: rows[h] || [], sample: rows.slice(h + 1, h + 4), headerRow: h, delimiter: delim };
  }

  // Best guess of which column holds which field, from header names.
  const MAP_HINTS = {
    date: /^(date|datum|trade ?date|fecha|data|time ?stamp|execution date|activity date|run date)$/,
    time: /^(time|zeit|uhrzeit|tijd|hora)$/,
    type: /^(type|action|transaction ?type|side|buy\/sell|typ|art|activity|trans code|transaction)$/,
    isin: /^isin$/,
    symbol: /^(symbol|ticker|instrument symbol|wkn)$/,
    name: /^(name|description|security|instrument|product|produkt|wertpapier|title|security description)$/,
    quantity: /^(quantity|qty|shares|units|anzahl|stück|stueck|aantal|no\. of shares|amount of shares)$/,
    price: /^(price|kurs|koers|price per share|share price|unit price|execution price|price \(\$\)|t\. price)$/,
    amount: /^(amount|total|betrag|net amount|value|wert|amount \(\$\)|total amount|net cash)$/,
    fee: /^(fee|fees|commission|gebühr|gebühren|fees & comm|commission \(\$\))$/,
    tax: /^(tax|taxes|steuer|steuern|withholding tax)$/,
    currency: /^(currency|währung|valuta|ccy)$/
  };
  function guessMapping(header) {
    const m = {};
    GENERIC_FIELDS.forEach(function (f) {
      const i = header.findIndex(function (h) { return MAP_HINTS[f].test(String(h || "").trim().toLowerCase()); });
      if (i >= 0) m[f] = i;
    });
    return m;
  }

  // ---------- name matching ----------
  //
  // Brokers and Yahoo name one company differently: "NVIDIA Corp." vs "NVIDIA
  // Corporation", "Siemens AG Namens-Aktien", "Alphabet Inc. Cl.A", "Taiwan
  // Semiconductor Manufacturing Co. Ltd. (Sp.ADRs)". Plain cosine over the raw
  // strings scores those additions as differences. Instead: strip legal forms,
  // share-class and listing noise, expand common abbreviations, then compare
  // the remaining core tokens with fuzzy token matching (exact, prefix,
  // character trigrams), and keep the better of that and a trigram Dice over
  // the joined core.

  const NOISE = new Set(("inc incorporated corp corporation co company companies cos ltd limited llc lp llp plc ag se sa nv bv " +
    "spa sab ab asa as oyj kgaa gmbh kg sas sarl pjsc pt tbk bhd hldgs holding holdings group grp the and of " +
    "class cl shs sh share shares registered reg regd ordinary ord ords common stock com adr adrs ads sponsored sp spons " +
    "unsponsored namens aktien namensaktien inhaber inhaberaktien akt aktie vz vorzugsaktien pref preferred new npv " +
    "dl eo sf rc nam inh o n a b c dr gdr ny nyrs units unit").split(" "));
  const ABBREV = { intl: "international", int: "international", tech: "technology", techs: "technology", technologies: "technology",
    sys: "systems", svcs: "services", svc: "services", service: "services", mfg: "manufacturing", pharm: "pharmaceuticals",
    pharma: "pharmaceuticals", pharmaceutical: "pharmaceuticals", natl: "national", amer: "american", bk: "bank", fin: "financial",
    finl: "financial", ind: "industries", inds: "industries", industry: "industries", hlth: "health", healthcare: "health",
    semicond: "semiconductor", semiconductors: "semiconductor", ent: "entertainment", comms: "communications",
    communication: "communications", res: "resources", petro: "petroleum", motors: "motor", labs: "laboratories" };

  function words(s) {
    return String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/&/g, " and ").replace(/\.(?=[a-z])/g, " ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  }
  function coreTokens(s) {
    const all = words(s).map(function (w) { return ABBREV[w] || w; });
    const core = all.filter(function (w) { return !NOISE.has(w); });
    return core.length ? core : all;
  }
  function trigrams(s) {
    const g = {}, t = "  " + s + " ";
    for (let i = 0; i < t.length - 2; i++) g[t.slice(i, i + 3)] = (g[t.slice(i, i + 3)] || 0) + 1;
    return g;
  }
  function dice(a, b) {
    if (!a || !b) return 0;
    const A = trigrams(a), B = trigrams(b);
    let inter = 0, na = 0, nb = 0;
    Object.keys(A).forEach(function (k) { na += A[k]; if (B[k]) inter += Math.min(A[k], B[k]); });
    Object.keys(B).forEach(function (k) { nb += B[k]; });
    return na + nb ? 2 * inter / (na + nb) : 0;
  }
  function tokenScore(x, y) {
    if (x === y) return 1;
    if (x.length >= 3 && y.length >= 3 && (x.indexOf(y) === 0 || y.indexOf(x) === 0)) return 0.9;
    const d = dice(x, y);
    return d >= 0.7 ? d : 0;
  }
  function nameSimilarity(a, b) {
    const A = coreTokens(a), B = coreTokens(b);
    if (!A.length || !B.length) return 0;
    const used = {};
    let sum = 0;
    const small = A.length <= B.length ? A : B, big = small === A ? B : A;
    small.forEach(function (t) {
      let best = 0, bi = -1;
      big.forEach(function (u, i) { if (used[i]) return; const s = tokenScore(t, u); if (s > best) { best = s; bi = i; } });
      if (bi >= 0) used[bi] = 1;
      sum += best;
    });
    const tok = 2 * sum / (A.length + B.length);
    return Math.max(tok, dice(A.join(" "), B.join(" ")));
  }
  function nameVerdict(score) { return score >= 0.85 ? "same" : score >= 0.6 ? "likely" : "different"; }

  // Exchange suffix off a Yahoo-style symbol: "SAP.DE" -> "SAP", "BRK-B" stays.
  function baseSymbol(s) { return String(s || "").toUpperCase().replace(/\.[A-Z]{1,3}$/, ""); }

  const api = {
    FORMATS: FORMATS.map(function (f) { return { id: f.id, label: f.label }; }),
    GENERIC_FIELDS: GENERIC_FIELDS, GENERIC_REQUIRED: GENERIC_REQUIRED,
    sniff: sniff, parseFile: parseFile, previewColumns: previewColumns, guessMapping: guessMapping,
    nameSimilarity: nameSimilarity, nameVerdict: nameVerdict, coreTokens: coreTokens, baseSymbol: baseSymbol,
    isIsin: isIsin, num: num, parseCsv: parseCsv, zonedMs: zonedMs
  };
  if (typeof self !== "undefined") self.ATLedger = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
