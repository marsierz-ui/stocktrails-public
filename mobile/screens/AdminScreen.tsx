import { useEffect, useState } from 'react';
import { ActivityIndicator, Dimensions, ScrollView, Text, View } from 'react-native';
import { useData } from '../lib/DataContext';
import {
  adminFeedback,
  adminSentiment,
  adminTopTickers,
  adminTotals,
  adminUsers,
  FeedbackRow,
  SentimentCount,
  TickerCount,
  Totals,
  UserStat,
} from '../lib/adminApi';
import { BarChart } from '../components/charts/BarChart';
import { Donut } from '../components/charts/Donut';
import { SENTIMENT_COLOR } from '../lib/format';
import { s } from '../components/ui';

export default function AdminScreen() {
  const { isAdmin } = useData();
  const width = Dimensions.get('window').width - 32;
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [totals, setTotals] = useState<Totals | null>(null);
  const [tickers, setTickers] = useState<TickerCount[]>([]);
  const [sent, setSent] = useState<SentimentCount[]>([]);
  const [users, setUsers] = useState<UserStat[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let on = true;
    (async () => {
      try {
        const [t, tk, se, us, fb] = await Promise.all([
          adminTotals(),
          adminTopTickers(),
          adminSentiment(),
          adminUsers(),
          adminFeedback(),
        ]);
        if (!on) return;
        setTotals(t);
        setTickers(tk);
        setSent(se);
        setUsers(us);
        setFeedback(fb);
      } catch (e: any) {
        if (on) setErr(e?.message || String(e));
      } finally {
        if (on) setLoading(false);
      }
    })();
    return () => {
      on = false;
    };
  }, [isAdmin]);

  if (!isAdmin) return <View style={s.screen}><Text style={s.sub}>Admin only.</Text></View>;
  if (loading) return <View style={s.screen}><ActivityIndicator /></View>;

  const tickerBars = tickers.slice(0, 8).map((t) => ({ label: t.ticker, value: Number(t.n) || 0 }));
  const sentSlices = sent.map((x) => ({
    label: x.sentiment || 'none',
    value: Number(x.n) || 0,
    color: SENTIMENT_COLOR[x.sentiment || ''] || '#bbb',
  }));

  return (
    <ScrollView style={s.screen}>
      {err ? <Text style={s.err}>{err}</Text> : null}
      <View style={s.cards}>
        <View style={s.card}>
          <Text style={s.cardValue}>{totals?.users ?? 0}</Text>
          <Text style={s.cardLabel}>users</Text>
        </View>
        <View style={s.card}>
          <Text style={s.cardValue}>{totals?.events ?? 0}</Text>
          <Text style={s.cardLabel}>events</Text>
        </View>
      </View>

      <Text style={s.h2}>Top tickers</Text>
      <BarChart data={tickerBars} width={width} height={130} />

      <Text style={s.h2}>Sentiment</Text>
      <View style={{ alignItems: 'center' }}>
        <Donut data={sentSlices} size={120} />
      </View>

      <Text style={s.h2}>Users</Text>
      {users.slice(0, 40).map((u) => (
        <View key={u.user_id} style={s.trow}>
          <Text style={[s.td, { flex: 1, textAlign: 'left' }]} numberOfLines={1}>
            {u.email || u.user_id}
          </Text>
          <Text style={s.td}>{u.events ?? 0}</Text>
        </View>
      ))}

      <Text style={s.h2}>Feedback</Text>
      {feedback.length === 0 ? <Text style={s.sub}>No feedback.</Text> : null}
      {feedback.slice(0, 40).map((f) => (
        <View key={f.id} style={s.fb}>
          <Text style={s.line} numberOfLines={3}>
            {f.text}
          </Text>
          <Text style={s.sub}>
            {f.status} · {new Date(f.created_at).toLocaleDateString()}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}
