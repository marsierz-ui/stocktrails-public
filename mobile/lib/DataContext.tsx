// App-wide state: auth session, the local document, and the actions screens call
// (refresh / sync / capture / sign-in/out). Single source of truth so all tabs
// reflect the same data after any mutation.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { signInWithGoogle, signOut as doSignOut, isAdmin as checkAdmin } from './auth';
import { syncNow } from './sync';
import { getAll, getSyncConfig } from './db';
import { captureSymbol } from './capture';
import { defaults } from './store';
import { AttentionDoc } from './types';

interface DataCtx {
  session: Session | null;
  isAdmin: boolean;
  doc: AttentionDoc;
  busy: boolean;
  status: string;
  lastSync: number;
  setStatus: (s: string) => void;
  refresh: () => Promise<void>;
  sync: () => Promise<void>;
  capture: (symbol: string, opts?: { url?: string; portalPath?: string | null }) => Promise<string | null>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<DataCtx | null>(null);

export function useData(): DataCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useData used outside DataProvider');
  return c;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [doc, setDoc] = useState<AttentionDoc>(defaults());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [lastSync, setLastSync] = useState(0);

  const refresh = useCallback(async () => {
    const d = await getAll();
    setDoc(d);
    const cfg = await getSyncConfig();
    setLastSync(cfg.lastSync || 0);
  }, []);

  useEffect(() => {
    refresh();
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [refresh]);

  useEffect(() => {
    let active = true;
    if (session) {
      checkAdmin()
        .then((a) => {
          if (active) setIsAdmin(a);
        })
        .catch(() => {
          if (active) setIsAdmin(false);
        });
    } else {
      setIsAdmin(false);
    }
    return () => {
      active = false;
    };
  }, [session]);

  const sync = useCallback(async () => {
    setBusy(true);
    setStatus('syncing...');
    const r = await syncNow();
    await refresh();
    setStatus(r.ok ? (r.changed ? 'synced (updated)' : 'synced') : 'sync error: ' + r.reason);
    setBusy(false);
  }, [refresh]);

  // Pull on sign-in/launch and whenever the app returns to the foreground, so rows
  // captured by the extension show up without a manual Sync.
  useEffect(() => {
    if (!session) return;
    sync();
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') sync();
    });
    return () => sub.remove();
  }, [session?.user.id, sync]);

  const capture = useCallback(
    async (symbol: string, opts?: { url?: string; portalPath?: string | null }) => {
      setBusy(true);
      setStatus('capturing ' + symbol.toUpperCase() + '...');
      let sym: string | null = null;
      try {
        sym = await captureSymbol(symbol, opts);
        await refresh();
        if (sym && session) {
          const r = await syncNow();
          await refresh();
          setStatus(r.ok ? 'captured ' + sym : 'captured ' + sym + ' (sync error)');
        } else if (sym) {
          setStatus('captured ' + sym + ' (sign in to sync)');
        } else {
          setStatus('invalid symbol');
        }
      } catch (e: any) {
        setStatus('capture failed: ' + (e?.message || e));
      } finally {
        setBusy(false);
      }
      return sym;
    },
    [refresh, session]
  );

  const signIn = useCallback(async () => {
    setBusy(true);
    setStatus('');
    try {
      await signInWithGoogle();
      await refresh();
    } catch (e: any) {
      setStatus('sign-in failed: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const signOut = useCallback(async () => {
    const revoked = await doSignOut();
    setSession(null);
    if (!revoked) setStatus('signed out on this device; the server sign-out failed (offline?)');
    await refresh();
  }, [refresh]);

  const value = useMemo<DataCtx>(
    () => ({ session, isAdmin, doc, busy, status, lastSync, setStatus, refresh, sync, capture, signIn, signOut }),
    [session, isAdmin, doc, busy, status, lastSync, refresh, sync, capture, signIn, signOut]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
