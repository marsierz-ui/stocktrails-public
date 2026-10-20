// Port of the camelCase<->snake_case mapping in src/cloud.js (mapEventOut /
// mapRowIn). sentiment_changed_at is TIMESTAMPTZ on the wire but epoch-ms locally.
// portal_path / session_id are intraday-only.

import { AttentionEvent } from './types';

export function mapEventOut(
  uid: string,
  e: AttentionEvent,
  deleted: boolean,
  isIntraday?: boolean
): Record<string, any> {
  if (deleted) return { user_id: uid, id: e.id, updated_at: e.updatedAt, deleted: true };
  const row: Record<string, any> = {
    user_id: uid,
    id: e.id,
    ticker: e.ticker,
    ts: e.ts,
    source: e.source,
    url: e.url,
    sentiment: e.sentiment,
    price_at_event: e.priceAtEvent == null ? null : e.priceAtEvent,
    views: e.views == null ? 1 : e.views,
    dwell_ms: e.dwellMs == null ? 0 : e.dwellMs,
    scroll_depth: e.scrollDepth == null ? null : e.scrollDepth,
    focus_switches: e.focusSwitches == null ? null : e.focusSwitches,
    sector: e.sector == null ? null : e.sector,
    industry: e.industry == null ? null : e.industry,
    market_cap: e.marketCap == null ? null : Math.round(e.marketCap), // bigint column
    market_cap_bucket: e.marketCapBucket == null ? null : e.marketCapBucket,
    week52_position: e.week52Position == null ? null : e.week52Position,
    sentiment_prev: e.sentimentPrev == null ? null : e.sentimentPrev,
    sentiment_changed_at: e.sentimentChangedAt == null ? null : new Date(e.sentimentChangedAt).toISOString(),
    position_taken: e.positionTaken == null ? null : e.positionTaken,
    target_price: e.targetPrice == null ? null : e.targetPrice,
    market_session: e.marketSession == null ? null : e.marketSession,
    price_fetch_failed: e.priceFetchFailed == null ? false : e.priceFetchFailed,
    updated_at: e.updatedAt,
    deleted: false,
  };
  if (isIntraday) {
    row.portal_path = e.portalPath == null ? null : e.portalPath;
    if (e.sessionId != null) row.session_id = e.sessionId; // else DB DEFAULT assigns one
  }
  return row;
}

export function mapRowIn(r: any): AttentionEvent {
  return {
    id: r.id,
    ticker: r.ticker,
    ts: r.ts,
    source: r.source,
    url: r.url,
    sentiment: r.sentiment,
    priceAtEvent: r.price_at_event,
    views: r.views,
    dwellMs: r.dwell_ms || 0,
    scrollDepth: r.scroll_depth == null ? null : r.scroll_depth,
    focusSwitches: r.focus_switches == null ? null : r.focus_switches,
    sector: r.sector == null ? null : r.sector,
    industry: r.industry == null ? null : r.industry,
    marketCap: r.market_cap == null ? null : r.market_cap,
    marketCapBucket: r.market_cap_bucket == null ? null : r.market_cap_bucket,
    week52Position: r.week52_position == null ? null : r.week52_position,
    sentimentPrev: r.sentiment_prev == null ? null : r.sentiment_prev,
    sentimentChangedAt: r.sentiment_changed_at == null ? null : Date.parse(r.sentiment_changed_at),
    positionTaken: r.position_taken == null ? null : r.position_taken,
    targetPrice: r.target_price == null ? null : r.target_price,
    marketSession: r.market_session == null ? null : r.market_session,
    priceFetchFailed: r.price_fetch_failed == null ? false : r.price_fetch_failed,
    sessionId: r.session_id == null ? null : r.session_id,
    portalPath: r.portal_path == null ? null : r.portal_path,
    updatedAt: r.updated_at,
  };
}
