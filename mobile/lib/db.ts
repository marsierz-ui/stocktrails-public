// Local persistence over AsyncStorage. Faithful port of the extension's
// single-blob model (chrome.storage.local key "attention_v1") plus a separate,
// device-local sync-state key that is never synced. (A future milestone may move
// the document to expo-sqlite for row-level ops; the merge engine is agnostic.)
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AttentionDoc } from './types';
import { defaults, backfillUpdatedAt } from './store';

const KEY = 'attention_v1';
const SYNC_KEY = 'attention_sync_v1';

export interface SyncConfig {
  cloudCursor: number; // push watermark: this device's clock vs its own rows' updatedAt
  cloudSyncedAt: string | null; // pull watermark: server synced_at (see sync.ts)
  syncProtocol?: number;
  deepSyncAt?: number;
  lastSync: number;
  lastError: string;
  accountId?: string | null; // the account the local document belongs to
}

export async function getAll(): Promise<AttentionDoc> {
  const raw = await AsyncStorage.getItem(KEY);
  const parsed = raw ? (JSON.parse(raw) as Partial<AttentionDoc>) : {};
  const doc = Object.assign(defaults(), parsed) as AttentionDoc;
  backfillUpdatedAt(doc);
  return doc;
}

export async function setAll(doc: AttentionDoc): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(doc));
}

export async function getSyncConfig(): Promise<SyncConfig> {
  const raw = await AsyncStorage.getItem(SYNC_KEY);
  return raw
    ? (JSON.parse(raw) as SyncConfig)
    : { cloudCursor: 0, cloudSyncedAt: null, lastSync: 0, lastError: '' };
}

export async function setSyncConfig(patch: Partial<SyncConfig>): Promise<void> {
  const cur = await getSyncConfig();
  await AsyncStorage.setItem(SYNC_KEY, JSON.stringify(Object.assign(cur, patch)));
}

// Serialize all document read-modify-write access through a single-flight chain
// so concurrent mutate()/sync writes on the single AsyncStorage blob cannot
// clobber each other (the extension got this for free from the SW event loop).
let chain: Promise<unknown> = Promise.resolve();

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // Keep the chain alive and isolate it from this call's result/rejection.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// Load -> mutate the document -> save. Returns the callback's result. Atomic with
// respect to other mutate() and sync merge writes.
export async function mutate<T>(fn: (doc: AttentionDoc) => T): Promise<T> {
  return withLock(async () => {
    const doc = await getAll();
    const r = fn(doc);
    await setAll(doc);
    return r;
  });
}
