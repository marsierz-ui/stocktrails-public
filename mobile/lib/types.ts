// Wire-compatible record shapes. Field names match the extension's local model
// (src/store.js) so the ported collectChanges/applyRemote merge and the
// camelCase<->snake_case mapping (lib/cloudMap.ts) behave identically. Cross-device
// merge correctness depends on this matching byte-for-byte.

export type Sentiment = 'positive' | 'neutral' | 'negative' | null;
export type MarketSession =
  | 'pre_market'
  | 'market_hours'
  | 'after_hours'
  | 'overnight'
  | null;
export type MarketCapBucket =
  | 'nano'
  | 'micro'
  | 'small'
  | 'mid'
  | 'large'
  | 'mega'
  | null;

export interface AttentionEvent {
  id: string; // events: `${ts}-${ticker}`; intraday: `i${ts}-${ticker}`
  ticker: string;
  ts: number; // epoch ms
  source: string;
  url: string;
  sentiment: Sentiment;
  priceAtEvent: number | null;
  views?: number; // daily only
  dwellMs: number;
  scrollDepth: number | null; // 0..1
  focusSwitches: number | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapBucket: MarketCapBucket;
  week52Position: number | null; // 0..1
  sentimentPrev: Sentiment;
  sentimentChangedAt: number | null; // epoch ms (ISO timestamptz on the wire)
  positionTaken: boolean | null;
  targetPrice: number | null;
  marketSession: MarketSession;
  priceFetchFailed: boolean;
  sessionId?: string | null; // intraday only
  portalPath?: string | null; // intraday only
  updatedAt: number; // epoch ms
}

export interface Settings {
  dedupeMinutes: number;
}

export interface CustomPortal {
  name: string;
  pattern: string;
  host: string;
}

export interface FeatureUsageLogEntry {
  id: string;
  section: string;
  ts: number;
}

export interface Deletions {
  events: Record<string, number>; // id -> deleteTimeMs (tombstone)
  intraday: Record<string, number>;
}

export interface AttentionDoc {
  events: AttentionEvent[];
  intraday: AttentionEvent[];
  overrides: Record<string, string>;
  customPortals: CustomPortal[];
  settings: Settings;
  deletions: Deletions;
  metaUpdatedAt: number;
  featureUsage: Record<string, number>;
  featureUsageLog: FeatureUsageLogEntry[];
  featureUsageUpdatedAt: number;
}

export interface MetaChange {
  overrides: Record<string, string>;
  customPortals: CustomPortal[];
  settings: Settings;
  updatedAt: number;
}

export interface ChangeSet {
  events: AttentionEvent[];
  intraday: AttentionEvent[];
  deletions: Deletions;
  meta: MetaChange | null;
  featureUsage: Record<string, number>;
  featureUsageLog: FeatureUsageLogEntry[];
  ua: string | null;
}

export interface RemoteSet {
  events: AttentionEvent[];
  intraday: AttentionEvent[];
  deletions: Deletions;
  meta: (Partial<MetaChange> & { updatedAt: number }) | null;
}

// Minimal input accepted by addEvent/addIntraday.
export type EventInput = Partial<AttentionEvent> & { ticker: string; ts: number };
