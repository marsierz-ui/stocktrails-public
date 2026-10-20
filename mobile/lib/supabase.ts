// Supabase client for React Native. URL polyfill must load before createClient.
// EncryptedStore backs session + PKCE verifier persistence; detectSessionInUrl is
// off (no browser URL on native); autoRefresh is tied to app foreground state.
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import * as aesjs from 'aes-js';
import { AppState } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import { AT_SUPABASE_URL, AT_SUPABASE_ANON } from './config';

// Supabase's LargeSecureStore pattern: the session is too large for SecureStore,
// so each value is AES-256-CTR encrypted with a fresh key that lives in
// SecureStore (Keychain / Keystore), and only the ciphertext goes to AsyncStorage.
// SecureStore keeps itself out of Android Auto Backup, so a restored backup holds
// ciphertext without its key; that reads as signed out.
const ENC = 'enc1:';

export const EncryptedStore = {
  async getItem(key: string): Promise<string | null> {
    const stored = await AsyncStorage.getItem(key);
    if (stored == null) return null;
    if (!stored.startsWith(ENC)) {
      // Plaintext session from before encryption: re-store it encrypted, once.
      await EncryptedStore.setItem(key, stored);
      return stored;
    }
    const hexKey = await SecureStore.getItemAsync(key);
    if (!hexKey) {
      await AsyncStorage.removeItem(key);
      return null;
    }
    const cipher = new aesjs.ModeOfOperation.ctr(aesjs.utils.hex.toBytes(hexKey), new aesjs.Counter(1));
    return aesjs.utils.utf8.fromBytes(cipher.decrypt(aesjs.utils.hex.toBytes(stored.slice(ENC.length))));
  },
  async setItem(key: string, value: string): Promise<void> {
    const raw = getRandomBytes(32);
    const cipher = new aesjs.ModeOfOperation.ctr(raw, new aesjs.Counter(1));
    const encrypted = cipher.encrypt(aesjs.utils.utf8.toBytes(value));
    await SecureStore.setItemAsync(key, aesjs.utils.hex.fromBytes(raw));
    await AsyncStorage.setItem(key, ENC + aesjs.utils.hex.fromBytes(encrypted));
  },
  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
    await SecureStore.deleteItemAsync(key);
  },
};

export const supabase = createClient(AT_SUPABASE_URL, AT_SUPABASE_ANON, {
  auth: {
    storage: EncryptedStore,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
});

// Refresh tokens only while foregrounded (Supabase RN guidance).
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
