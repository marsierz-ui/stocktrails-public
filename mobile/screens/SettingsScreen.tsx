import { useState } from 'react';
import { Alert, Linking, ScrollView, Switch, Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useData } from '../lib/DataContext';
import { getRedirectUri } from '../lib/auth';
import { s } from '../components/ui';

const TERMS_URL = 'https://marsierz-ui.github.io/attention-tracker/dashboard/terms.html';
const PRIVACY_URL = 'https://marsierz-ui.github.io/attention-tracker/dashboard/privacy.html';

export default function SettingsScreen() {
  const { session, doc, lastSync, sync, signIn, signOut, busy, status } = useData();
  // Sign-in needs the Terms of Use and Privacy Policy accepted, as in the extension and web app.
  const [accepted, setAccepted] = useState(false);

  const exportJson = async () => {
    await Clipboard.setStringAsync(JSON.stringify(doc));
    Alert.alert('Exported', 'Copied ' + doc.events.length + ' events to the clipboard as JSON.');
  };

  const copyRedirect = async () => {
    await Clipboard.setStringAsync(getRedirectUri());
    Alert.alert('Copied', 'Add this to Supabase Auth redirect URLs:\n\n' + getRedirectUri());
  };

  return (
    <ScrollView style={s.screen}>
      <Text style={s.h2}>Account</Text>
      {session ? (
        <>
          <Text style={s.line}>{session.user.email}</Text>
          <TouchableOpacity style={s.btnGhost} onPress={signOut}>
            <Text style={s.btnGhostText}>Sign out</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <Switch value={accepted} onValueChange={setAccepted} />
            <Text style={[s.sub, { flex: 1 }]}>
              I am 18 or older and accept the{' '}
              <Text style={{ textDecorationLine: 'underline' }} onPress={() => Linking.openURL(TERMS_URL)}>Terms of Use</Text> and the{' '}
              <Text style={{ textDecorationLine: 'underline' }} onPress={() => Linking.openURL(PRIVACY_URL)}>Privacy Policy</Text>.
            </Text>
          </View>
          <TouchableOpacity style={[s.btn, !accepted && { opacity: 0.5 }]} onPress={signIn} disabled={busy || !accepted}>
            <Text style={s.btnText}>Sign in with Google</Text>
          </TouchableOpacity>
        </>
      )}

      <Text style={s.h2}>Sync</Text>
      <Text style={s.line}>Last sync: {lastSync ? new Date(lastSync).toLocaleString() : 'never'}</Text>
      <TouchableOpacity style={[s.btn, { marginTop: 6 }]} onPress={sync} disabled={busy || !session}>
        <Text style={s.btnText}>Sync now</Text>
      </TouchableOpacity>
      {status ? <Text style={s.status}>{status}</Text> : null}

      <Text style={s.h2}>Data</Text>
      <Text style={s.line}>
        {doc.events.length} daily · {doc.intraday.length} intraday events
      </Text>
      <TouchableOpacity style={s.btnGhost} onPress={exportJson}>
        <Text style={s.btnGhostText}>Copy data as JSON</Text>
      </TouchableOpacity>

      <Text style={s.h2}>Custom portals</Text>
      {(doc.customPortals || []).length === 0 ? (
        <Text style={s.sub}>None.</Text>
      ) : (
        doc.customPortals.map((p, i) => (
          <Text key={i} style={s.line}>
            {p.name} · {p.host}
          </Text>
        ))
      )}

      <Text style={s.h2}>Diagnostics</Text>
      <Text style={s.sub} selectable>
        OAuth redirect: {getRedirectUri()}
      </Text>
      <TouchableOpacity style={[s.btnGhost, { marginTop: 8 }]} onPress={copyRedirect}>
        <Text style={s.btnGhostText}>Copy redirect URI</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
