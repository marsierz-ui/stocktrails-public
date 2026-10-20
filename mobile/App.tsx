import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useShareIntent } from 'expo-share-intent';
import { DataProvider, useData } from './lib/DataContext';
import { ShareContext } from './lib/ShareContext';
import CaptureScreen from './screens/CaptureScreen';
import PerformanceScreen from './screens/PerformanceScreen';
import StockDetailScreen from './screens/StockDetailScreen';
import AttentionScreen from './screens/AttentionScreen';
import SettingsScreen from './screens/SettingsScreen';
import AdminScreen from './screens/AdminScreen';
import { PerfStackParams, RootTabParams } from './screens/navTypes';

const Tab = createBottomTabNavigator<RootTabParams>();
const PerfStack = createNativeStackNavigator<PerfStackParams>();
const navRef = createNavigationContainerRef<RootTabParams>();

function PerformanceStackScreen() {
  return (
    <PerfStack.Navigator>
      <PerfStack.Screen name="PerfList" component={PerformanceScreen} options={{ title: 'My Stocks' }} />
      <PerfStack.Screen
        name="StockDetail"
        component={StockDetailScreen}
        options={({ route }) => ({ title: route.params.ticker })}
      />
    </PerfStack.Navigator>
  );
}

function Tabs() {
  const { isAdmin } = useData();
  return (
    <Tab.Navigator screenOptions={{ tabBarLabelStyle: { fontSize: 11 } }}>
      <Tab.Screen name="Capture" component={CaptureScreen} />
      <Tab.Screen name="Performance" component={PerformanceStackScreen} options={{ headerShown: false, title: 'My Stocks' }} />
      <Tab.Screen name="Attention" component={AttentionScreen} options={{ title: 'My Habits' }} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
      {isAdmin ? <Tab.Screen name="Admin" component={AdminScreen} /> : null}
    </Tab.Navigator>
  );
}

function Root() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({ debug: false });

  useEffect(() => {
    if (hasShareIntent && navRef.isReady()) navRef.navigate('Capture');
  }, [hasShareIntent]);

  return (
    <ShareContext.Provider value={{ shareIntent, hasShareIntent, reset: () => resetShareIntent() }}>
      <NavigationContainer ref={navRef}>
        <Tabs />
      </NavigationContainer>
    </ShareContext.Provider>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <DataProvider>
        <Root />
        <StatusBar style="auto" />
      </DataProvider>
    </SafeAreaProvider>
  );
}
