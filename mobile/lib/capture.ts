// Manual capture path (mobile equivalent of an attention event). Writes a daily +
// intraday row, stamps marketSession + rolling sessionId, then best-effort
// enriches with a Yahoo quote (price, 52-week position) and profile
// (sector/industry/market cap). Share-target + OCR intake (a later milestone)
// will resolve a symbol and call this same function.
import { mutate } from './db';
import { addEvent, addIntraday, patchLatest, classifyMarketHours } from './store';
import { currentSession } from './session';
import { fetchQuote, fetchProfile, week52Position, toSymbol } from './prices';
import { AttentionEvent } from './types';

export async function captureSymbol(
  symbol: string,
  opts?: { url?: string; portalPath?: string | null }
): Promise<string | null> {
  const sym = toSymbol(symbol);
  if (!sym || sym.length < 1) return null;
  const ts = Date.now();
  const ms = classifyMarketHours(ts);
  const sessionId = await currentSession(ts);
  await mutate((doc) => {
    addEvent(doc, { ticker: sym, ts, source: 'mobile', url: opts?.url || '', marketSession: ms });
    addIntraday(doc, {
      ticker: sym,
      ts,
      source: 'mobile',
      url: opts?.url || '',
      marketSession: ms,
      sessionId,
      portalPath: opts?.portalPath ?? null,
    });
  });

  try {
    const [q, prof] = await Promise.all([fetchQuote(sym), fetchProfile(sym)]);
    await mutate((doc) => {
      const patch: Partial<AttentionEvent> = {};
      if (q) {
        patch.priceAtEvent = q.close;
        const w = week52Position(q.close, q.low52w, q.high52w);
        if (w != null) patch.week52Position = w;
      } else {
        patch.priceFetchFailed = true;
      }
      if (prof.sector) patch.sector = prof.sector;
      if (prof.industry) patch.industry = prof.industry;
      if (prof.marketCap != null) {
        patch.marketCap = prof.marketCap;
        patch.marketCapBucket = prof.marketCapBucket;
      }
      patchLatest(doc, sym, patch);
    });
  } catch (e) {
    await mutate((doc) => patchLatest(doc, sym, { priceFetchFailed: true }));
  }
  return sym;
}
