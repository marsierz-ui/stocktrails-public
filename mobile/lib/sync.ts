// Supabase delta-sync orchestration. Port of cloud.js trySync: push upserts +
// tombstones, pull rows the server received since the last run, applyRemote
// merge, then advance both cursors. Single-flight so concurrent triggers
// coalesce. Keep this in step with src/cloud.js - the two clients share one
// account, so a divergence bug fixed in only one of them is not fixed.
//
// Push filters this device's rows by their own updatedAt against this device's
// clock (cloudCursor). Pull filters remote rows by synced_at, which the server
// stamps on arrival (cloudSyncedAt): updated_at is stamped by whichever device
// wrote the row, so a row captured at T and pushed later is already behind any
// device whose cursor has passed T, and pulling on updated_at hid it forever.
import { supabase } from './supabase';
import { getAll, setAll, getSyncConfig, setSyncConfig, withLock } from './db';
import { collectChanges, applyRemote, defaults } from './store';
import { mapEventOut, mapRowIn } from './cloudMap';
import { RemoteSet } from './types';

export interface SyncResult {
  ok: boolean;
  changed?: boolean;
  reason?: string;
}

// Bumping this makes every install run one full reconcile on its next sync.
const SYNC_PROTOCOL = 3; // 3: keyset paging; re-pull rows offset paging skipped
const PAGE_ROWS = 1000; // PostgREST truncates a response at 1000 rows
const PUSH_CHUNK = 200;
const DEEP_SYNC_MS = 86400000; // full reconcile once a day, as a backstop
// synced_at comes from now() (transaction start), so a transaction can commit
// after a later timestamp is already visible. Re-reading rows is free.
const CURSOR_OVERLAP_MS = 5000;

let inFlight: Promise<SyncResult> | null = null;

async function upsertAll(table: string, rows: any[]): Promise<void> {
  for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
    const r = await supabase.from(table).upsert(rows.slice(i, i + PUSH_CHUNK));
    if (r.error) throw r.error;
  }
}

// Pull by server arrival order, paging past the row cap. `since` is an ISO
// timestamp, or null for everything.
// Keyset paging (after the last row seen), not offset: a row another device
// updates mid-pull is re-stamped to the end and would shift an offset window.
async function pullRows(table: string, uid: string, since: string | null): Promise<any[]> {
  const out: any[] = [];
  let last: any = null;
  for (;;) {
    let q = supabase
      .from(table)
      .select('*')
      .eq('user_id', uid)
      .order('synced_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(PAGE_ROWS);
    if (since) q = q.gt('synced_at', since);
    if (last) q = q.or(`synced_at.gt."${last.synced_at}",and(synced_at.eq."${last.synced_at}",id.gt."${last.id}")`);
    const r = await q;
    if (r.error) throw r.error;
    const rows = r.data || [];
    for (const row of rows) out.push(row);
    if (rows.length < PAGE_ROWS) return out;
    last = rows[rows.length - 1];
  }
}

// Newest arrival seen, rewound by the overlap. Never moves backwards.
function nextCursorFrom(rowSets: any[][], fallback: string | null): string | null {
  let max = 0;
  for (const rows of rowSets) {
    for (const r of rows || []) {
      const t = r && r.synced_at ? Date.parse(r.synced_at) : 0;
      if (t > max) max = t;
    }
  }
  if (!max) return fallback;
  const rewound = new Date(max - CURSOR_OVERLAP_MS).toISOString();
  if (fallback && Date.parse(fallback) >= Date.parse(rewound)) return fallback;
  return rewound;
}

export function syncNow(): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = doSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doSync(): Promise<SyncResult> {
  const { data: ures } = await supabase.auth.getUser();
  const user = ures ? ures.user : null;
  if (!user) return { ok: false, reason: 'not signed in' };
  const uid = user.id;
  try {
    // Never push one account's local data into another (src/cloud.js
    // reconcileAccount). Older installs have no accountId and adopt this one.
    const owner = (await getSyncConfig()).accountId;
    if (owner !== uid) {
      if (owner) await withLock(() => setAll(defaults()));
      await setSyncConfig({ accountId: uid, cloudCursor: 0, cloudSyncedAt: null });
    }
    const cfg = await getSyncConfig();
    const startedAt = Date.now();
    // A full reconcile ignores both cursors: push everything, pull everything.
    // Runs on a protocol bump (merging clients that already drifted) and daily
    // after that, so any gap closes by itself instead of living in the data.
    const full =
      cfg.syncProtocol !== SYNC_PROTOCOL ||
      !cfg.cloudSyncedAt ||
      startedAt - (cfg.deepSyncAt || 0) > DEEP_SYNC_MS;
    const pushSince = full ? 0 : cfg.cloudCursor || 0;
    const pullSince = full ? null : cfg.cloudSyncedAt || null;
    const doc = await getAll();
    const changes = collectChanges(doc, pushSince);

    // push
    const evRows = changes.events
      .map((e) => mapEventOut(uid, e, false))
      .concat(
        Object.keys(changes.deletions.events).map((id) => ({
          user_id: uid,
          id,
          updated_at: changes.deletions.events[id],
          deleted: true,
        }))
      );
    await upsertAll('events', evRows);
    const inRows = changes.intraday
      .map((e) => mapEventOut(uid, e, false, true))
      .concat(
        Object.keys(changes.deletions.intraday).map((id) => ({
          user_id: uid,
          id,
          updated_at: changes.deletions.intraday[id],
          deleted: true,
        }))
      );
    await upsertAll('intraday', inRows);
    if (changes.meta) {
      const r = await supabase.from('user_meta').upsert({
        user_id: uid,
        config: {
          overrides: changes.meta.overrides,
          customPortals: changes.meta.customPortals,
          settings: changes.meta.settings,
        },
        updated_at: changes.meta.updatedAt,
      });
      if (r.error) throw r.error;
    }
    if (changes.featureUsageLog.length) {
      await upsertAll(
        'feature_usage',
        changes.featureUsageLog.map((e) => ({
          id: e.id,
          user_id: uid,
          section: e.section,
          ts: new Date(e.ts).toISOString(),
        }))
      );
    }

    // pull (by server arrival, so a row pushed late still reaches this device)
    const evData: any[] = await pullRows('events', uid, pullSince);
    const inData: any[] = await pullRows('intraday', uid, pullSince);
    let metaQ = supabase.from('user_meta').select('*').eq('user_id', uid);
    if (pullSince) metaQ = metaQ.gt('synced_at', pullSince);
    const meta = await metaQ.maybeSingle();
    if (meta.error) throw meta.error;
    const nextSynced = nextCursorFrom([evData, inData, meta.data ? [meta.data] : []], cfg.cloudSyncedAt || null);
    const remote: RemoteSet = {
      events: evData.filter((r) => !r.deleted).map(mapRowIn),
      intraday: inData.filter((r) => !r.deleted).map(mapRowIn),
      deletions: {
        events: evData
          .filter((r) => r.deleted)
          .reduce((o: Record<string, number>, r) => {
            o[r.id] = r.updated_at;
            return o;
          }, {}),
        intraday: inData
          .filter((r) => r.deleted)
          .reduce((o: Record<string, number>, r) => {
            o[r.id] = r.updated_at;
            return o;
          }, {}),
      },
      meta:
        meta.data && (meta.data as any).config
          ? Object.assign({ updatedAt: (meta.data as any).updated_at }, (meta.data as any).config)
          : null,
    };

    // Atomic read-merge-write under the same lock as mutate(), so a concurrent
    // capture/label cannot be clobbered by (or clobber) the merged remote set.
    const changed = await withLock(async () => {
      const local = await getAll();
      const c = applyRemote(local, remote);
      if (c) await setAll(local);
      return c;
    });
    await setSyncConfig({
      cloudCursor: startedAt,
      cloudSyncedAt: nextSynced,
      syncProtocol: SYNC_PROTOCOL,
      deepSyncAt: full ? startedAt : cfg.deepSyncAt || startedAt,
      lastSync: Date.now(),
      lastError: '',
    });
    return { ok: true, changed };
  } catch (e: any) {
    await setSyncConfig({ lastError: 'cloud: ' + (e && e.message ? e.message : String(e)) });
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}
