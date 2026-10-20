// Admin analytics, gated by profiles.is_admin (enforced by RLS + SECURITY DEFINER
// RPCs server-side). Thin wrappers over the same admin_* RPCs the desktop
// dashboard uses (src/cloud.js).
import { supabase } from './supabase';

export interface Totals {
  users: number;
  events: number;
}
export interface TickerCount {
  ticker: string;
  n: number;
}
export interface SentimentCount {
  sentiment: string | null;
  n: number;
}
export interface UserStat {
  user_id: string;
  email?: string;
  events?: number;
  last_event?: number;
}
export interface FeedbackRow {
  id: number;
  user_id: string;
  text: string;
  url: string;
  status: string;
  category: string | null;
  created_at: number;
}

export async function adminTotals(): Promise<Totals> {
  const r = await supabase.rpc('admin_totals');
  if (r.error) throw r.error;
  return (r.data && (r.data as Totals[])[0]) || { users: 0, events: 0 };
}

export async function adminTopTickers(): Promise<TickerCount[]> {
  const r = await supabase.rpc('admin_top_tickers');
  if (r.error) throw r.error;
  return (r.data as TickerCount[]) || [];
}

export async function adminSentiment(): Promise<SentimentCount[]> {
  const r = await supabase.rpc('admin_sentiment');
  if (r.error) throw r.error;
  return (r.data as SentimentCount[]) || [];
}

export async function adminUsers(): Promise<UserStat[]> {
  const r = await supabase.rpc('admin_user_stats');
  if (r.error) throw r.error;
  return (r.data as UserStat[]) || [];
}

export async function adminFeedback(): Promise<FeedbackRow[]> {
  const r = await supabase.from('feedback').select('*').order('created_at', { ascending: false }).limit(200);
  if (r.error) throw r.error;
  return (r.data as FeedbackRow[]) || [];
}

export async function adminUpdateFeedback(id: number, patch: Partial<FeedbackRow>): Promise<void> {
  const r = await supabase.from('feedback').update(patch).eq('id', id);
  if (r.error) throw r.error;
}
