import { useMemo } from 'react';
import { Dimensions, ScrollView, Text, View } from 'react-native';
import { useData } from '../lib/DataContext';
import { byTicker } from '../lib/store';
import { Heatmap } from '../components/charts/Heatmap';
import { BarChart } from '../components/charts/BarChart';
import { dayKey, dwellLabel, SENTIMENT_COLOR } from '../lib/format';
import { s } from '../components/ui';

export default function AttentionScreen() {
  const { doc } = useData();
  const width = Dimensions.get('window').width - 32;

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    doc.events.forEach((e) => {
      const k = dayKey(e.ts);
      c[k] = (c[k] || 0) + (e.views || 1);
    });
    return c;
  }, [doc]);

  const sentBars = useMemo(() => {
    const c = { positive: 0, neutral: 0, negative: 0, unlabeled: 0 };
    doc.events.forEach((e) => {
      if (e.sentiment) (c as Record<string, number>)[e.sentiment]++;
      else c.unlabeled++;
    });
    return [
      { label: 'pos', value: c.positive, color: SENTIMENT_COLOR.positive },
      { label: 'neu', value: c.neutral, color: SENTIMENT_COLOR.neutral },
      { label: 'neg', value: c.negative, color: SENTIMENT_COLOR.negative },
      { label: 'none', value: c.unlabeled, color: '#bbb' },
    ];
  }, [doc]);

  const rows = useMemo(() => {
    const g = byTicker(doc.events);
    return Object.keys(g)
      .map((t) => {
        const evs = g[t];
        const views = evs.reduce((acc, e) => acc + (e.views || 1), 0);
        const dwell = evs.reduce((acc, e) => acc + (e.dwellMs || 0), 0);
        return { ticker: t, views, dwell };
      })
      .sort((a, b) => b.dwell - a.dwell);
  }, [doc]);

  return (
    <ScrollView style={s.screen}>
      <Text style={s.h2}>Activity</Text>
      <Heatmap counts={counts} width={width} />

      <Text style={s.h2}>Outlook distribution</Text>
      <BarChart data={sentBars} width={width} height={120} />

      <Text style={s.h2}>Time spent</Text>
      <View style={s.thead}>
        <Text style={[s.th, { flex: 1, textAlign: 'left' }]}>Ticker</Text>
        <Text style={s.th}>Views</Text>
        <Text style={s.th}>Time</Text>
      </View>
      {rows.map((r) => (
        <View key={r.ticker} style={s.trow}>
          <Text style={[s.td, { flex: 1, textAlign: 'left', fontWeight: '600' }]}>{r.ticker}</Text>
          <Text style={s.td}>{r.views}</Text>
          <Text style={s.td}>{dwellLabel(r.dwell)}</Text>
        </View>
      ))}
      {rows.length === 0 ? <Text style={s.empty}>No activity yet.</Text> : null}
    </ScrollView>
  );
}
