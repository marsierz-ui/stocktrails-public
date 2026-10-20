// Google sign-in via Supabase Auth on native. Replaces the extension's
// chrome.identity.launchWebAuthFlow with expo-web-browser. PKCE only: ?code ->
// exchangeCodeForSession. Tokens in the redirect URL are rejected: on Android any
// app or link can open the callback scheme, and only a code is bound to this
// device's verifier.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import type { User } from '@supabase/supabase-js';
import { supabase, EncryptedStore } from './supabase';
import { AT_AUTH_SCHEME } from './config';

WebBrowser.maybeCompleteAuthSession();

// In a dev/standalone build: attentiontracker://auth-callback. In Expo Go this
// resolves to the exp:// proxy URL automatically. Whatever it resolves to must be
// added to Supabase Auth -> URL Configuration -> Redirect URLs.
const redirectTo = makeRedirectUri({ scheme: AT_AUTH_SCHEME, path: 'auth-callback' });

export function getRedirectUri(): string {
  return redirectTo;
}

export async function signInWithGoogle(): Promise<User | null> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data || !data.url) throw new Error('no auth url returned');

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success' || !result.url) {
    if (result.type === 'cancel' || result.type === 'dismiss') return null;
    throw new Error('authentication did not complete');
  }

  const url = new URL(result.url);
  const code = url.searchParams.get('code');
  if (!code) throw new Error(url.searchParams.get('error_description') || 'no auth code in redirect');
  const { error: e } = await supabase.auth.exchangeCodeForSession(code);
  if (e) throw e;
  return getUser();
}

// Local data and the stored session go on sign-out, as in the extension
// (ATStore.resetLocalData), so the next account on this phone starts clean.
// Returns false when the server could not revoke the session (offline): auth-js
// then keeps the stored session, so its keys (ciphertext and AES key) are removed
// here directly.
export async function signOut(): Promise<boolean> {
  const { error } = await supabase.auth.signOut();
  if (error) {
    const sessionKeys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith('sb-') && k.includes('-auth-token'));
    for (const k of sessionKeys) await EncryptedStore.removeItem(k);
  }
  await AsyncStorage.multiRemove(['attention_v1', 'attention_sync_v1', 'attention_session_v1']);
  return !error;
}

export async function getUser(): Promise<User | null> {
  const { data } = await supabase.auth.getUser();
  return data ? data.user : null;
}

export async function isAdmin(): Promise<boolean> {
  const u = await getUser();
  if (!u) return false;
  const { data } = await supabase.from('profiles').select('is_admin').eq('id', u.id).maybeSingle();
  return !!(data && (data as { is_admin?: boolean }).is_admin);
}
