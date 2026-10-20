import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useData } from '../lib/DataContext';
import { useShare } from '../lib/ShareContext';
import { symbolsFromImage, symbolsFromText } from '../lib/captureFlow';
import { SymbolHit } from '../lib/prices';
import { s } from '../components/ui';

export default function CaptureScreen() {
  const { capture, busy, status, setStatus } = useData();
  const share = useShare();
  const [manual, setManual] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [working, setWorking] = useState(false);

  // Process an incoming OS share (url/text or image) once.
  useEffect(() => {
    if (!share || !share.hasShareIntent) return;
    const si = share.shareIntent;
    (async () => {
      setWorking(true);
      try {
        const img = (si.files || []).find((f) => f.mimeType && f.mimeType.startsWith('image/'));
        if (img) {
          setStatus('reading screenshot...');
          const r = await symbolsFromImage(img.path);
          setHits(r.hits);
          setStatus(r.hits.length ? 'pick the matching symbol' : 'no symbols found in image');
        } else {
          // A shared link's query string and fragment never leave the phone: only its last path segment.
          let text = (si.text || '').trim();
          if (!text && si.webUrl) {
            try { text = decodeURIComponent(new URL(si.webUrl).pathname.split('/').filter(Boolean).pop() || ''); } catch { text = ''; }
          }
          text = text.slice(0, 60);
          if (text) {
            const h = await symbolsFromText(text);
            setHits(h);
            setStatus(h.length ? 'pick the matching symbol' : 'no symbols found');
          }
        }
      } catch (e: any) {
        setStatus('share failed: ' + (e?.message || e));
      } finally {
        setWorking(false);
        share.reset();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share?.hasShareIntent]);

  const runSearch = async () => {
    if (query.trim().length < 2) return;
    setWorking(true);
    setStatus('searching...');
    try {
      const h = await symbolsFromText(query.trim());
      setHits(h);
      setStatus(h.length ? '' : 'no matches');
    } catch (e: any) {
      setStatus('search failed: ' + (e?.message || e));
    } finally {
      setWorking(false);
    }
  };

  const pickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setStatus('photo permission denied');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (res.canceled) return;
    const asset = res.assets[0];
    if (!asset) return;
    setWorking(true);
    setStatus('reading screenshot...');
    try {
      const r = await symbolsFromImage(asset.uri);
      setHits(r.hits);
      setStatus(r.hits.length ? 'pick the matching symbol' : 'no symbols found in image');
    } catch (e: any) {
      setStatus('OCR failed: ' + (e?.message || e) + ' (needs a native dev build)');
    } finally {
      setWorking(false);
    }
  };

  const onPick = async (sym: string) => {
    setHits([]);
    setQuery('');
    await capture(sym);
  };

  const onManualAdd = async () => {
    if (!manual.trim()) return;
    const m = manual.trim();
    setManual('');
    await capture(m);
  };

  return (
    <ScrollView style={s.screen} keyboardShouldPersistTaps="handled">
      <Text style={s.h2}>Quick add</Text>
      <View style={s.row}>
        <TextInput
          style={s.input}
          placeholder="Ticker (AAPL)"
          autoCapitalize="characters"
          autoCorrect={false}
          value={manual}
          onChangeText={setManual}
          onSubmitEditing={onManualAdd}
          returnKeyType="done"
        />
        <TouchableOpacity style={s.btn} onPress={onManualAdd} disabled={busy}>
          <Text style={s.btnText}>Add</Text>
        </TouchableOpacity>
      </View>

      <Text style={s.h2}>Search by name or ISIN</Text>
      <View style={s.row}>
        <TextInput
          style={s.input}
          placeholder="e.g. Apple or US0378331005"
          autoCapitalize="characters"
          autoCorrect={false}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={runSearch}
          returnKeyType="search"
        />
        <TouchableOpacity style={s.btn} onPress={runSearch} disabled={busy}>
          <Text style={s.btnText}>Search</Text>
        </TouchableOpacity>
      </View>

      <Text style={s.h2}>From a screenshot</Text>
      <TouchableOpacity style={[s.btn, s.block]} onPress={pickImage} disabled={busy}>
        <Text style={s.btnText}>Pick screenshot to scan (OCR)</Text>
      </TouchableOpacity>

      {working || busy ? <ActivityIndicator style={{ marginTop: 12 }} /> : null}
      {status ? <Text style={s.status}>{status}</Text> : null}

      {hits.map((h) => (
        <TouchableOpacity key={h.symbol + h.exch} style={s.hit} onPress={() => onPick(h.symbol)}>
          <Text style={s.hitSym}>{h.symbol}</Text>
          <Text style={s.hitName} numberOfLines={1}>
            {h.name} · {h.exch}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}
