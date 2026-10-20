// Rolling 30-minute session id, stamped on intraday rows. Port of currentSession
// in src/background.js. A new uuid is minted when the gap since the last event
// exceeds 30 min (or there is no prior session).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { newId } from './store';

const SESSION_KEY = 'attention_session_v1';
const SESSION_GAP_MS = 30 * 60000;

export async function currentSession(ts: number): Promise<string> {
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  const cur = raw ? (JSON.parse(raw) as { id?: string; lastTs?: number }) : null;
  let id = cur && cur.id;
  if (!id || !cur || !cur.lastTs || ts - cur.lastTs > SESSION_GAP_MS) id = newId();
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify({ id, lastTs: ts }));
  return id;
}
