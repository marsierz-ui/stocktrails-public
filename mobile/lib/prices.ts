// Port of src/prices.js. Native clients have no CORS constraint, so we call
// Yahoo's keyless chart/search endpoints directly (query1, falling back to
// query2). AT_PRICE_PROXY stays null; AT_YAHOO_FALLBACK_PROXY is only used if a
// caller opts into the Supabase yahoo edge function on rate-limit.

import { AT_PRICE_PROXY } from './config';
import { MarketCapBucket } from './types';

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

// A browser-like UA reduces Yahoo 429s for non-browser clients.
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile';

export function marketCapBucket(mc: number | null | undefined): MarketCapBucket {
  if (mc == null || isNaN(mc)) return null;
  if (mc < 50e6) return 'nano';
  if (mc < 300e6) return 'micro';
  if (mc < 2e9) return 'small';
  if (mc < 10e9) return 'mid';
  if (mc < 200e9) return 'large';
  return 'mega';
}

export function toSymbol(ticker: string): string {
  return String(ticker).toUpperCase().trim();
}

function isoFromSec(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

async function fetchJson(path: string): Promise<any> {
  if (AT_PRICE_PROXY) {
    const res = await fetch(AT_PRICE_PROXY + encodeURIComponent(path));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  let lastErr: unknown = null;
  for (const host of HOSTS) {
    try {
      const res = await fetch(host + path, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status);
        continue;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('fetch failed');
}

export interface DailyPoint {
  date: string;
  close: number;
}

export function parseChart(json: any): DailyPoint[] {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.timestamp || !r.indicators || !r.indicators.quote) return [];
  const ts: number[] = r.timestamp;
  const closes: (number | null)[] = r.indicators.quote[0].close || [];
  const out: (DailyPoint & { ts: number })[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || isNaN(c)) continue;
    out.push({ date: isoFromSec(ts[i]), close: c, ts: ts[i] });
  }
  // Yahoo can list a split but leave closes unadjusted; see src/prices.js parseChart.
  const splits = (r.events && r.events.splits) || {};
  Object.keys(splits).forEach((k) => {
    const sp = splits[k], at = +sp.date, f = +sp.denominator / +sp.numerator;
    if (!at || !(f > 0) || f === 1) return;
    const j = out.findIndex((p) => p.ts >= at);
    if (j <= 0) return;
    const jump = out[j].close / out[j - 1].close;
    if (!(jump > 0) || Math.abs(Math.log(jump / f)) >= Math.abs(Math.log(jump))) return;
    for (let i = 0; i < j; i++) out[i].close *= f;
  });
  return out.map((p) => ({ date: p.date, close: p.close }));
}

export async function fetchDaily(symbolOrTicker: string, fromISO?: string, asSymbol?: boolean): Promise<DailyPoint[]> {
  const sym = asSymbol ? symbolOrTicker : toSymbol(symbolOrTicker);
  const p1 = fromISO
    ? Math.floor(Date.parse(fromISO) / 1000)
    : Math.floor((Date.now() - 365 * 86400000) / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const path =
    '/v8/finance/chart/' + encodeURIComponent(sym) + '?period1=' + p1 + '&period2=' + p2 + '&interval=1d&events=split';
  return parseChart(await fetchJson(path));
}

export interface Quote {
  date: string;
  close: number;
  low52w: number | null;
  high52w: number | null;
}

export async function fetchQuote(symbolOrTicker: string, asSymbol?: boolean): Promise<Quote | null> {
  const sym = asSymbol ? symbolOrTicker : toSymbol(symbolOrTicker);
  // range=1y so meta carries the 52-week high/low for week52Position.
  const path = '/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1y&interval=1d';
  const json = await fetchJson(path);
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.meta) return null;
  let price = r.meta.regularMarketPrice;
  if (price == null) {
    const closes = r.indicators && r.indicators.quote && r.indicators.quote[0].close;
    if (closes && closes.length) price = closes[closes.length - 1];
  }
  if (price == null || isNaN(price)) return null;
  const t = r.meta.regularMarketTime ? isoFromSec(r.meta.regularMarketTime) : isoFromSec(Math.floor(Date.now() / 1000));
  const low52w = r.meta.fiftyTwoWeekLow != null && !isNaN(r.meta.fiftyTwoWeekLow) ? Number(r.meta.fiftyTwoWeekLow) : null;
  const high52w =
    r.meta.fiftyTwoWeekHigh != null && !isNaN(r.meta.fiftyTwoWeekHigh) ? Number(r.meta.fiftyTwoWeekHigh) : null;
  return { date: t, close: price, low52w, high52w };
}

export interface Profile {
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapBucket: MarketCapBucket;
}

const PROFILE_TTL = 7 * 86400000;
const profileCache: Record<string, { fetchedAt: number; value: Profile }> = {};

// sector/industry from the keyless search endpoint; market cap best-effort.
export async function fetchProfile(symbolOrTicker: string, asSymbol?: boolean): Promise<Profile> {
  const sym = asSymbol ? symbolOrTicker : toSymbol(symbolOrTicker);
  const hit = profileCache[sym];
  if (hit && hit.value && Date.now() - (hit.fetchedAt || 0) < PROFILE_TTL) return hit.value;

  const value: Profile = { sector: null, industry: null, marketCap: null, marketCapBucket: null };
  try {
    const json = await fetchJson('/v1/finance/search?q=' + encodeURIComponent(sym) + '&quotesCount=6&newsCount=0');
    const quotes = (json && json.quotes) || [];
    const q =
      quotes.find((x: any) => x.symbol && x.symbol.toUpperCase() === sym.toUpperCase()) || quotes[0];
    if (q) {
      value.sector = q.sectorDisp || q.sector || null;
      value.industry = q.industryDisp || q.industry || null;
    }
  } catch (e) {
    /* sector/industry best-effort */
  }
  try {
    const path = '/v10/finance/quoteSummary/' + encodeURIComponent(sym) + '?modules=summaryDetail';
    const json = await fetchJson(path);
    const res = json && json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
    const det = (res && res.summaryDetail) || {};
    const rawMc = det.marketCap && (det.marketCap.raw != null ? det.marketCap.raw : det.marketCap);
    const mc = rawMc == null || isNaN(rawMc) ? null : Number(rawMc);
    if (mc != null) {
      value.marketCap = mc;
      value.marketCapBucket = marketCapBucket(mc);
    }
  } catch (e) {
    /* market cap unavailable keyless; leave null */
  }
  profileCache[sym] = { fetchedAt: Date.now(), value };
  return value;
}

export interface SymbolHit {
  symbol: string;
  name: string;
  exch: string;
  type: string;
}

// Resolve a company name or ISIN to candidate Yahoo symbols.
export async function searchSymbols(query: string): Promise<SymbolHit[]> {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const json = await fetchJson('/v1/finance/search?q=' + encodeURIComponent(q) + '&quotesCount=8&newsCount=0');
  const out: SymbolHit[] = [];
  ((json && json.quotes) || []).forEach((x: any) => {
    if (!x.symbol) return;
    if (x.quoteType && x.quoteType !== 'EQUITY' && x.quoteType !== 'ETF') return;
    out.push({
      symbol: x.symbol,
      name: (x.shortname || x.longname || x.symbol).replace(/\s+/g, ' ').trim(),
      exch: x.exchDisp || x.exchange || '',
      type: x.quoteType || '',
    });
  });
  return out;
}

export async function fetchName(symbolOrTicker: string, asSymbol?: boolean): Promise<string | null> {
  const sym = asSymbol ? symbolOrTicker : toSymbol(symbolOrTicker);
  try {
    const json = await fetchJson('/v1/finance/search?q=' + encodeURIComponent(sym) + '&quotesCount=6&newsCount=0');
    const quotes = (json && json.quotes) || [];
    const hit = quotes.find((x: any) => x.symbol && x.symbol.toUpperCase() === sym.toUpperCase()) || quotes[0];
    if (hit) {
      const nm = (hit.shortname || hit.longname || '').replace(/\s+/g, ' ').trim();
      if (nm) return nm;
    }
  } catch (e) {
    /* fall through */
  }
  return null;
}

// clamp01 of (close-low)/(high-low); used to stamp week52Position at capture.
export function week52Position(close: number, low52w: number | null, high52w: number | null): number | null {
  if (low52w == null || high52w == null || high52w <= low52w) return null;
  return Math.max(0, Math.min(1, (close - low52w) / (high52w - low52w)));
}
