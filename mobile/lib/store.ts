// Pure port of the extension's src/store.js logic. These functions operate on an
// in-memory AttentionDoc (no platform storage). Persistence lives in lib/db.ts.
// The merge engine (collectChanges/applyRemote), market-session bucketing, and
// dedupe/dwell/label rules MUST match the extension exactly for cross-device
// merge to converge.

import {
  AttentionDoc,
  AttentionEvent,
  ChangeSet,
  CustomPortal,
  EventInput,
  RemoteSet,
  Sentiment,
  MarketSession,
} from './types';

export function defaults(): AttentionDoc {
  return {
    events: [],
    intraday: [],
    overrides: {},
    customPortals: [],
    settings: { dedupeMinutes: 60 },
    deletions: { events: {}, intraday: {} },
    metaUpdatedAt: 0,
    featureUsage: {},
    featureUsageLog: [],
    featureUsageUpdatedAt: 0,
  };
}

// Classify an epoch-ms timestamp into a US/Eastern trading session. Mirrors
// public.market_session() in SQL and classifyMarketHours in src/store.js.
export function classifyMarketHours(tsMs: number | null | undefined): MarketSession {
  if (tsMs == null || isNaN(tsMs)) return null;
  let hh = 0;
  let mm = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(Number(tsMs)));
    parts.forEach((p) => {
      if (p.type === 'hour') hh = parseInt(p.value, 10);
      else if (p.type === 'minute') mm = parseInt(p.value, 10);
    });
  } catch (e) {
    return null;
  }
  if (hh === 24) hh = 0;
  const m = hh * 60 + mm;
  if (m >= 240 && m <= 569) return 'pre_market';
  if (m >= 570 && m <= 960) return 'market_hours';
  if (m >= 961 && m <= 1199) return 'after_hours';
  return 'overnight';
}

// UUID-shaped id for feature_usage rows (the column is a uuid). Matches the
// Math.random fallback in src/store.js newId().
export function newId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Backfill updatedAt on records created before sync existed (src/store.js getAll).
export function backfillUpdatedAt(doc: AttentionDoc): void {
  doc.events.forEach((e) => {
    if (e.updatedAt == null) e.updatedAt = e.ts || 0;
  });
  (doc.intraday || []).forEach((e) => {
    if (e.updatedAt == null) e.updatedAt = e.ts || 0;
  });
}

export function ensureSync(doc: AttentionDoc): void {
  if (!doc.deletions) doc.deletions = { events: {}, intraday: {} };
  if (!doc.deletions.events) doc.deletions.events = {};
  if (!doc.deletions.intraday) doc.deletions.intraday = {};
  if (doc.metaUpdatedAt == null) doc.metaUpdatedAt = 0;
}

function latestFor(arr: AttentionEvent[], ticker: string): AttentionEvent | undefined {
  return (arr || [])
    .filter((e) => e.ticker === ticker)
    .sort((a, b) => b.ts - a.ts)[0];
}

// Repeated views inside the dedupe window refresh the existing event.
export function addEvent(doc: AttentionDoc, ev: EventInput): { added: boolean; event: AttentionEvent } {
  const windowMs = (doc.settings.dedupeMinutes || 60) * 60000;
  const recent = latestFor(doc.events, ev.ticker);
  if (recent && ev.ts - recent.ts < windowMs) {
    recent.ts = ev.ts;
    recent.views = (recent.views || 1) + 1;
    recent.updatedAt = ev.ts;
    return { added: false, event: recent };
  }
  const event: AttentionEvent = {
    id: ev.ts + '-' + ev.ticker,
    ticker: ev.ticker,
    ts: ev.ts,
    source: ev.source || 'manual',
    url: ev.url || '',
    sentiment: ev.sentiment || null,
    priceAtEvent: ev.priceAtEvent == null ? null : ev.priceAtEvent,
    views: 1,
    dwellMs: 0,
    scrollDepth: null,
    focusSwitches: 0,
    sector: null,
    industry: null,
    marketCap: null,
    marketCapBucket: null,
    week52Position: null,
    sentimentPrev: null,
    sentimentChangedAt: null,
    positionTaken: null,
    targetPrice: null,
    marketSession: ev.marketSession != null ? ev.marketSession : classifyMarketHours(ev.ts),
    priceFetchFailed: false,
    updatedAt: ev.ts,
  };
  doc.events.push(event);
  return { added: true, event };
}

// Every intraday view is recorded; only exact double-fires within 30s are skipped.
export function addIntraday(doc: AttentionDoc, ev: EventInput): { added: boolean; event: AttentionEvent } {
  if (!doc.intraday) doc.intraday = [];
  const last = latestFor(doc.intraday, ev.ticker);
  if (last && ev.ts - last.ts < 30000) return { added: false, event: last };
  const event: AttentionEvent = {
    id: 'i' + ev.ts + '-' + ev.ticker,
    ticker: ev.ticker,
    ts: ev.ts,
    source: ev.source || 'manual',
    url: ev.url || '',
    sentiment: ev.sentiment || null,
    priceAtEvent: ev.priceAtEvent == null ? null : ev.priceAtEvent,
    dwellMs: 0,
    scrollDepth: null,
    focusSwitches: 0,
    sector: null,
    industry: null,
    marketCap: null,
    marketCapBucket: null,
    week52Position: null,
    sentimentPrev: null,
    sentimentChangedAt: null,
    positionTaken: null,
    targetPrice: null,
    marketSession: ev.marketSession != null ? ev.marketSession : classifyMarketHours(ev.ts),
    priceFetchFailed: false,
    sessionId: ev.sessionId == null ? null : ev.sessionId,
    portalPath: ev.portalPath == null ? null : String(ev.portalPath).slice(0, 200),
    updatedAt: ev.ts,
  };
  doc.intraday.push(event);
  return { added: true, event };
}

// Add dwell + running-max scroll/focus to the latest row in both DBs.
export function addDwell(
  doc: AttentionDoc,
  ticker: string,
  ms: number,
  extra?: { scrollDepth?: number | null; focusSwitches?: number | null }
): void {
  if (!ms || ms <= 0) return;
  const now = Date.now();
  const ex = extra || {};
  const sd =
    ex.scrollDepth == null || isNaN(ex.scrollDepth) ? null : Math.max(0, Math.min(1, ex.scrollDepth));
  const fs =
    ex.focusSwitches == null || isNaN(ex.focusSwitches) ? null : Math.max(0, Math.round(ex.focusSwitches));
  const apply = (e: AttentionEvent | undefined) => {
    if (!e) return;
    e.dwellMs = (e.dwellMs || 0) + ms;
    if (sd != null) e.scrollDepth = e.scrollDepth == null ? sd : Math.max(e.scrollDepth, sd);
    if (fs != null) e.focusSwitches = Math.max(e.focusSwitches || 0, fs);
    e.updatedAt = now;
  };
  const d = latestFor(doc.events, ticker);
  const i = latestFor(doc.intraday, ticker);
  apply(d);
  apply(i);
}

export function setSentiment(doc: AttentionDoc, id: string, sentiment: Sentiment): AttentionEvent | undefined {
  const e = doc.events.find((x) => x.id === id);
  if (e) {
    e.sentiment = sentiment;
    e.updatedAt = Date.now();
  }
  return e;
}

// Apply one label to the latest daily + latest intraday row; record the previous
// sentiment + change time when overwriting a different non-null value.
export function labelTicker(
  doc: AttentionDoc,
  ticker: string,
  sentiment: Sentiment
): { daily: string | null; intraday: string | null } {
  const now = Date.now();
  const apply = (e: AttentionEvent | undefined) => {
    if (!e) return;
    if (e.sentiment != null && e.sentiment !== sentiment) {
      e.sentimentPrev = e.sentiment;
      e.sentimentChangedAt = now;
    }
    e.sentiment = sentiment;
    e.updatedAt = now;
  };
  const d = latestFor(doc.events, ticker);
  const i = latestFor(doc.intraday, ticker);
  apply(d);
  apply(i);
  return { daily: d ? d.id : null, intraday: i ? i.id : null };
}

export function patchById(
  doc: AttentionDoc,
  kind: 'events' | 'intraday',
  id: string,
  patch: Partial<AttentionEvent>
): boolean {
  const arr = doc[kind] || [];
  const e = arr.find((x) => x.id === id);
  if (!e) return false;
  (Object.keys(patch) as (keyof AttentionEvent)[]).forEach((k) => {
    if (patch[k] !== undefined) (e as any)[k] = patch[k];
  });
  e.updatedAt = Date.now();
  return true;
}

export function patchLatest(doc: AttentionDoc, ticker: string, patch: Partial<AttentionEvent>): boolean {
  const now = Date.now();
  const apply = (e: AttentionEvent | undefined) => {
    if (!e) return;
    (Object.keys(patch) as (keyof AttentionEvent)[]).forEach((k) => {
      if (patch[k] !== undefined) (e as any)[k] = patch[k];
    });
    e.updatedAt = now;
  };
  const d = latestFor(doc.events, ticker);
  const i = latestFor(doc.intraday, ticker);
  apply(d);
  apply(i);
  return !!(d || i);
}

export function setPositionTaken(doc: AttentionDoc, ticker: string, value: boolean): boolean {
  return patchLatest(doc, ticker, { positionTaken: !!value });
}

export function setTargetPrice(doc: AttentionDoc, ticker: string, value: number | string | null): boolean {
  const v = value == null || value === '' || isNaN(value as number) ? null : Number(value);
  return patchLatest(doc, ticker, { targetPrice: v });
}

export function setPrice(doc: AttentionDoc, id: string, price: number): void {
  const e = doc.events.find((x) => x.id === id);
  if (e && e.priceAtEvent == null) {
    e.priceAtEvent = price;
    e.updatedAt = Date.now();
  }
}

export function setIntradayPrice(doc: AttentionDoc, id: string, price: number): void {
  const e = (doc.intraday || []).find((x) => x.id === id);
  if (e && e.priceAtEvent == null) {
    e.priceAtEvent = price;
    e.updatedAt = Date.now();
  }
}

export function removeEvent(doc: AttentionDoc, id: string): void {
  ensureSync(doc);
  doc.events = doc.events.filter((x) => x.id !== id);
  doc.deletions.events[id] = Date.now();
}

// Delete a whole position: all of a ticker's events/intraday + its override.
export function removePosition(doc: AttentionDoc, ticker: string): void {
  ensureSync(doc);
  const now = Date.now();
  doc.events.filter((e) => e.ticker === ticker).forEach((e) => {
    doc.deletions.events[e.id] = now;
  });
  (doc.intraday || []).filter((e) => e.ticker === ticker).forEach((e) => {
    doc.deletions.intraday[e.id] = now;
  });
  doc.events = doc.events.filter((e) => e.ticker !== ticker);
  doc.intraday = (doc.intraday || []).filter((e) => e.ticker !== ticker);
  if (doc.overrides) delete doc.overrides[ticker];
  doc.metaUpdatedAt = now;
}

export function setOverride(doc: AttentionDoc, ticker: string, symbol: string | null): void {
  if (symbol) doc.overrides[ticker] = symbol;
  else delete doc.overrides[ticker];
  doc.metaUpdatedAt = Date.now();
}

export function addPortal(doc: AttentionDoc, portal: CustomPortal): void {
  if (!doc.customPortals) doc.customPortals = [];
  doc.customPortals.push({ name: portal.name, pattern: portal.pattern, host: portal.host });
  doc.metaUpdatedAt = Date.now();
}

export function removePortal(doc: AttentionDoc, index: number): void {
  doc.customPortals = (doc.customPortals || []).filter((_, i) => i !== index);
  doc.metaUpdatedAt = Date.now();
}

// Record a section navigation (counter + 500-entry ring buffer).
export function trackFeatureUse(doc: AttentionDoc, section: string): void {
  if (!section) return;
  if (!doc.featureUsage) doc.featureUsage = {};
  if (!doc.featureUsageLog) doc.featureUsageLog = [];
  const now = Date.now();
  doc.featureUsage[section] = (doc.featureUsage[section] || 0) + 1;
  doc.featureUsageUpdatedAt = now;
  doc.featureUsageLog.push({ id: newId(), section, ts: now });
  if (doc.featureUsageLog.length > 500) {
    doc.featureUsageLog = doc.featureUsageLog.slice(doc.featureUsageLog.length - 500);
  }
}

// ---- sync engine (pure) ----

// Everything changed strictly after `since` (ms): records + tombstones + meta.
export function collectChanges(doc: AttentionDoc, since: number, ua?: string | null): ChangeSet {
  since = since || 0;
  const pick = (map: Record<string, number>) => {
    const o: Record<string, number> = {};
    Object.keys(map || {}).forEach((k) => {
      if (map[k] > since) o[k] = map[k];
    });
    return o;
  };
  ensureSync(doc);
  return {
    events: doc.events.filter((e) => (e.updatedAt || 0) > since),
    intraday: (doc.intraday || []).filter((e) => (e.updatedAt || 0) > since),
    deletions: { events: pick(doc.deletions.events), intraday: pick(doc.deletions.intraday) },
    meta:
      (doc.metaUpdatedAt || 0) > since
        ? {
            overrides: doc.overrides,
            customPortals: doc.customPortals,
            settings: doc.settings,
            updatedAt: doc.metaUpdatedAt,
          }
        : null,
    featureUsage: doc.featureUsage || {},
    featureUsageLog: (doc.featureUsageLog || []).filter((e) => (e.ts || 0) > since),
    ua: ua == null ? null : String(ua).substring(0, 200),
  };
}

// Merge a remote change-set into doc (whole-record last-write-wins by updatedAt;
// tombstones win when newer). Returns true if anything changed.
export function applyRemote(doc: AttentionDoc, remote: RemoteSet): boolean {
  ensureSync(doc);
  let changed = false;
  (['events', 'intraday'] as const).forEach((kind) => {
    const byId: Record<string, AttentionEvent> = {};
    doc[kind].forEach((e) => {
      byId[e.id] = e;
    });
    (remote[kind] || []).forEach((r) => {
      const tomb = doc.deletions[kind][r.id] || 0;
      if (tomb >= (r.updatedAt || 0)) return; // locally deleted later
      const cur = byId[r.id];
      if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) {
        byId[r.id] = r;
        changed = true;
      }
    });
    const remDel = (remote.deletions && remote.deletions[kind]) || {};
    Object.keys(remDel).forEach((id) => {
      const t = remDel[id];
      if (t > (doc.deletions[kind][id] || 0)) {
        doc.deletions[kind][id] = t;
        changed = true;
      }
      const cur = byId[id];
      if (cur && (cur.updatedAt || 0) <= t) {
        delete byId[id];
        changed = true;
      }
    });
    doc[kind] = Object.keys(byId).map((id) => byId[id]);
  });
  if (remote.meta && (remote.meta.updatedAt || 0) > (doc.metaUpdatedAt || 0)) {
    if (remote.meta.overrides) doc.overrides = remote.meta.overrides;
    if (remote.meta.customPortals) doc.customPortals = remote.meta.customPortals;
    if (remote.meta.settings) doc.settings = remote.meta.settings;
    doc.metaUpdatedAt = remote.meta.updatedAt;
    changed = true;
  }
  return changed;
}

// Group a flat event array by ticker (chronological), used by views.
export function byTicker(events: AttentionEvent[]): Record<string, AttentionEvent[]> {
  const m: Record<string, AttentionEvent[]> = {};
  events.forEach((e) => {
    (m[e.ticker] = m[e.ticker] || []).push(e);
  });
  Object.keys(m).forEach((k) => m[k].sort((a, b) => a.ts - b.ts));
  return m;
}

export interface SentimentStats {
  hitRate: number | null;
  brierScore: number | null;
  totalLabelled: number;
  positiveHitRate: number | null;
  negativeHitRate: number | null;
  flipRate: number | null;
}

// Forecast accuracy: realized return from priceAtEvent to the most recent event
// of the same ticker >= horizonDays later. Port of src/store.js computeSentimentStats.
export function computeSentimentStats(doc: AttentionDoc, horizonDays = 30): SentimentStats {
  const byTk: Record<string, AttentionEvent[]> = {};
  doc.events.forEach((e) => {
    (byTk[e.ticker] = byTk[e.ticker] || []).push(e);
  });
  Object.keys(byTk).forEach((t) => byTk[t].sort((a, b) => a.ts - b.ts));
  const horizonMs = horizonDays * 86400000;
  const labelled = doc.events.filter(
    (e) => e.sentiment === 'positive' || e.sentiment === 'neutral' || e.sentiment === 'negative'
  );

  let hit = 0;
  let nonNeutral = 0;
  let posTotal = 0;
  let posHit = 0;
  let negTotal = 0;
  let negHit = 0;
  let brierSum = 0;
  let brierN = 0;
  let flips = 0;
  labelled.forEach((e) => {
    if (e.sentimentPrev != null) flips++;
    if (e.priceAtEvent == null) return;
    const base = e.priceAtEvent;
    const future = byTk[e.ticker].filter((x) => x.ts >= e.ts + horizonMs && x.priceAtEvent != null);
    if (!future.length) return;
    const fp = future[future.length - 1].priceAtEvent;
    if (!fp) return;
    const ret = (fp - base) / base;
    const outcome = ret > 0 ? 1 : 0;
    const p = e.sentiment === 'positive' ? 0.85 : e.sentiment === 'negative' ? 0.15 : 0.5;
    brierSum += (p - outcome) * (p - outcome);
    brierN++;
    if (e.sentiment === 'positive') {
      posTotal++;
      nonNeutral++;
      if (ret > 0) {
        posHit++;
        hit++;
      }
    } else if (e.sentiment === 'negative') {
      negTotal++;
      nonNeutral++;
      if (ret < 0) {
        negHit++;
        hit++;
      }
    }
  });
  return {
    hitRate: nonNeutral ? hit / nonNeutral : null,
    brierScore: brierN ? brierSum / brierN : null,
    totalLabelled: labelled.length,
    positiveHitRate: posTotal ? posHit / posTotal : null,
    negativeHitRate: negTotal ? negHit / negTotal : null,
    flipRate: labelled.length ? flips / labelled.length : null,
  };
}

export interface VelocityStats {
  views: number;
  totalDwellMs: number;
  avgGapHours: number | null;
  revisitCount: number;
}

// How fast attention is accruing on a ticker in the recent window. Port of
// src/store.js attentionVelocity.
export function attentionVelocity(doc: AttentionDoc, ticker: string, windowDays = 7): VelocityStats {
  const cut = Date.now() - windowDays * 86400000;
  const evs = (doc.intraday || [])
    .filter((e) => e.ticker === ticker && e.ts >= cut)
    .sort((a, b) => a.ts - b.ts);
  let totalDwellMs = 0;
  let gapSum = 0;
  let gaps = 0;
  evs.forEach((e) => {
    totalDwellMs += e.dwellMs || 0;
  });
  for (let i = 1; i < evs.length; i++) {
    gapSum += evs[i].ts - evs[i - 1].ts;
    gaps++;
  }
  return {
    views: evs.length,
    totalDwellMs,
    avgGapHours: gaps ? gapSum / gaps / 3600000 : null,
    revisitCount: Math.max(0, evs.length - 1),
  };
}
