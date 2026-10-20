import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Dimensions, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useData } from '../lib/DataContext';
import { mutate } from '../lib/db';
import { byTicker, labelTicker, setPositionTaken, setTargetPrice } from '../lib/store';
import { fetchDaily, DailyPoint } from '../lib/prices';
import { LineChart, LineMarker } from '../components/charts/LineChart';
import { money, pct, SENTIMENT_COLOR } from '../lib/format';
import { Sentiment } from '../lib/types';
import { PerfStackParams } from './navTypes';
import { s } from '../components/ui';

type Props = NativeStackScreenProps<PerfStackParams, 'StockDetail'>;

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.meta}>
      <Text style={s.metaVal}>{value}</Text>
      <Text style={s.metaLabel}>{label}</Text>
    </View>
  );
}

export default function StockDetailScreen({ route }: Props) {
  const { ticker } = route.params;
  const { doc, sync, refresh } = useData();
  const [series, setSeries] = useState<DailyPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const width = Dimensions.get('window').width - 32;

  const evs = useMemo(() => byTicker(doc.events)[ticker] || [], [doc, ticker]);
  const latest = evs[evs.length - 1];
  const [target, setTarget] = useState(latest && latest.targetPrice != null ? String(latest.targetPrice) : '');

  useEffect(() => {
    let on = true;
    setLoading(true);
    fetchDaily(ticker)
      .then((ser) => {
        if (on) {
          setSeries(ser);
          setLoading(false);
        }
      })
      .catch(() => {
        if (on) setLoading(false);
      });
    return () => {
      on = false;
    };
  }, [ticker]);

  const values = series.map((p) => p.close);
  const markers = useMemo<LineMarker[]>(() => {
    if (!series.length) return [];
    const idxByDate: Record<string, number> = {};
    series.forEach((p, i) => {
      idxByDate[p.date] = i;
    });
    const out: LineMarker[] = [];
    evs.forEach((e) => {
      if (!e.sentiment) return;
      const dk = new Date(e.ts).toISOString().slice(0, 10);
      const i = idxByDate[dk];
      if (i != null) out.push({ i, color: SENTIMENT_COLOR[e.sentiment] || '#888' });
    });
    return out;
  }, [series, evs]);

  const applyLabel = async (sent: Sentiment) => {
    await mutate((d) => labelTicker(d, ticker, sent));
    await refresh();
    await sync();
  };
  const togglePosition = async () => {
    await mutate((d) => setPositionTaken(d, ticker, !(latest && latest.positionTaken)));
    await refresh();
    await sync();
  };
  const saveTarget = async () => {
    await mutate((d) => setTargetPrice(d, ticker, target));
    await refresh();
    await sync();
  };

  const gated = !!(latest && latest.sentiment);
  const totalViews = evs.reduce((acc, e) => acc + (e.views || 1), 0);

  return (
    <ScrollView style={s.screen}>
      <Text style={s.title}>{ticker}</Text>
      <Text style={s.sub}>
        {latest?.sector || ''}
        {latest?.industry ? ' · ' + latest.industry : ''}
      </Text>

      {loading ? (
        <ActivityIndicator style={{ marginVertical: 24 }} />
      ) : values.length ? (
        <View style={{ marginTop: 12 }}>
          <LineChart values={values} width={width} height={140} markers={markers} />
        </View>
      ) : (
        <Text style={s.hint}>No price history available.</Text>
      )}

      <View style={s.metaRow}>
        <Meta label="Last" value={money(latest?.priceAtEvent ?? null)} />
        <Meta label="52w pos" value={latest?.week52Position != null ? pct(latest.week52Position) : '-'} />
        <Meta label="Cap" value={latest?.marketCapBucket || '-'} />
        <Meta label="Views" value={String(totalViews)} />
      </View>

      <Text style={s.h2}>Outlook</Text>
      <View style={s.row}>
        {(['positive', 'neutral', 'negative'] as const).map((sent) => (
          <TouchableOpacity
            key={sent}
            style={[s.chip, latest?.sentiment === sent ? { backgroundColor: SENTIMENT_COLOR[sent], borderColor: SENTIMENT_COLOR[sent] } : null]}
            onPress={() => applyLabel(sent)}
          >
            <Text style={[s.chipText, latest?.sentiment === sent ? { color: '#fff' } : null]}>{sent}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {gated ? (
        <>
          <Text style={s.h2}>Position</Text>
          <TouchableOpacity style={s.btnGhost} onPress={togglePosition}>
            <Text style={s.btnGhostText}>{latest && latest.positionTaken ? 'Position taken' : 'Mark position taken'}</Text>
          </TouchableOpacity>
          <View style={[s.row, { marginTop: 10 }]}>
            <TextInput
              style={s.input}
              placeholder="Target price"
              keyboardType="decimal-pad"
              value={target}
              onChangeText={setTarget}
            />
            <TouchableOpacity style={s.btn} onPress={saveTarget}>
              <Text style={s.btnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <Text style={s.hint}>Set an outlook to record a position or target price.</Text>
      )}
    </ScrollView>
  );
}
