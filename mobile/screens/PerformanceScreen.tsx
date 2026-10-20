import { useMemo } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useData } from '../lib/DataContext';
import { byTicker, computeSentimentStats } from '../lib/store';
import { Donut } from '../components/charts/Donut';
import { money, pct, SENTIMENT_COLOR } from '../lib/format';
import { PerfStackParams } from './navTypes';
import { s } from '../components/ui';

type Props = NativeStackScreenProps<PerfStackParams, 'PerfList'>;

export default function PerformanceScreen({ navigation }: Props) {
  const { doc } = useData();

  const rows = useMemo(() => {
    const g = byTicker(doc.events);
    return Object.keys(g)
      .map((t) => {
        const evs = g[t];
        const last = evs[evs.length - 1];
        const views = evs.reduce((acc, e) => acc + (e.views || 1), 0);
        return { ticker: t, views, sentiment: last.sentiment, price: last.priceAtEvent, sector: last.sector };
      })
      .sort((a, b) => b.views - a.views);
  }, [doc]);

  const stats = useMemo(() => computeSentimentStats(doc, 30), [doc]);

  const outlook = useMemo(() => {
    const c = { positive: 0, neutral: 0, negative: 0 };
    doc.events.forEach((e) => {
      if (e.sentiment) (c as Record<string, number>)[e.sentiment]++;
    });
    return [
      { label: 'positive', value: c.positive, color: SENTIMENT_COLOR.positive },
      { label: 'neutral', value: c.neutral, color: SENTIMENT_COLOR.neutral },
      { label: 'negative', value: c.negative, color: SENTIMENT_COLOR.negative },
    ];
  }, [doc]);

  return (
    <ScrollView style={s.screen}>
      <View style={s.cards}>
        <View style={s.card}>
          <Text style={s.cardLabel}>Forecast hit rate</Text>
          <Text style={s.cardValue}>{pct(stats.hitRate)}</Text>
          <Text style={s.cardSub}>
            {stats.totalLabelled} labelled · Brier {stats.brierScore != null ? stats.brierScore.toFixed(2) : '-'}
          </Text>
        </View>
        <View style={[s.card, { alignItems: 'center' }]}>
          <Text style={s.cardLabel}>Outlook mix</Text>
          <Donut data={outlook} size={84} thickness={14} />
        </View>
      </View>

      <Text style={s.h2}>Watchlist</Text>
      {rows.length === 0 ? <Text style={s.empty}>No tickers yet. Capture one.</Text> : null}
      {rows.map((item) => (
        <TouchableOpacity
          key={item.ticker}
          style={s.rowItem}
          onPress={() => navigation.navigate('StockDetail', { ticker: item.ticker })}
        >
          <View style={{ flex: 1 }}>
            <Text style={s.ticker}>{item.ticker}</Text>
            {item.sector ? <Text style={s.sub}>{item.sector}</Text> : null}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.price}>{money(item.price)}</Text>
            <Text style={s.sub}>
              {item.views} view{item.views === 1 ? '' : 's'}
              {item.sentiment ? ' · ' : ''}
              <Text style={{ color: SENTIMENT_COLOR[item.sentiment || ''] || '#888' }}>{item.sentiment || ''}</Text>
            </Text>
          </View>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}
