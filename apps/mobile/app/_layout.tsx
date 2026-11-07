/**
 * Root layout: theme, gesture root, safe areas, keyboard controller (native), fonts,
 * connection bootstrap, notification routing, toasts and the root stack with an auth guard.
 */
import { Ionicons } from '@expo/vector-icons';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavigationThemeProvider, usePathname, useRootNavigationState } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import React, { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { Toasts } from '../src/components/ui';
import { openNotificationTarget, setNavigationReady } from '../src/lib/links';
import { configureNotificationHandling, syncAppBadge, useNotificationOpens } from '../src/lib/notifications';
import { initWebPush } from '../src/lib/webpush';
import { bootstrapConnection } from '../src/state/connection';
import { useSessions } from '../src/state/sessions';
import { isPaired, useSettings } from '../src/state/settings';
import { useToast } from '../src/state/toast';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import type { Theme } from '../src/theme';

export { ErrorBoundary } from 'expo-router';

// Keep the native splash up until settings are hydrated and icon fonts are ready (no-ops on web).
SplashScreen.preventAutoHideAsync().catch(() => {});
try {
  SplashScreen.setOptions({ duration: 250, fade: true });
} catch {
  /* older runtimes */
}
configureNotificationHandling();
initWebPush();

type Wrapper = ComponentType<{ children: ReactNode }>;

function PassThrough({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** react-native-keyboard-controller needs its native module; never load it on web and survive a missing link. */
function loadKeyboardProvider(): Wrapper {
  if (Platform.OS === 'web') return PassThrough;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-keyboard-controller') as { KeyboardProvider?: Wrapper };
    return mod.KeyboardProvider ?? PassThrough;
  } catch (err) {
    console.warn('[layout] react-native-keyboard-controller unavailable, falling back to plain layout', err);
    return PassThrough;
  }
}

const KeyboardProvider = loadKeyboardProvider();

export default function RootLayout() {
  useEffect(() => {
    bootstrapConnection();
  }, []);
  return (
    <ThemeProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <KeyboardProvider>
            <Shell />
          </KeyboardProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ThemeProvider>
  );
}

const READY_TIMEOUT_MS = 4000;

function Shell() {
  const t = useTheme();
  const hydrated = useSettings((s) => s.hydrated);
  const paired = useSettings((s) => isPaired(s));
  const [fontsLoaded, fontError] = useFonts({ ...Ionicons.font });
  const [timedOut, setTimedOut] = useState(false);

  // Never leave the user staring at a splash if storage or font loading hangs.
  useEffect(() => {
    const id = setTimeout(() => setTimedOut(true), READY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    if (fontError) console.warn('[layout] icon font failed to load; falling back to system glyphs', fontError);
  }, [fontError]);

  const ready = (hydrated || timedOut) && (fontsLoaded || !!fontError || timedOut);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  useEffect(() => {
    if (Platform.OS === 'web') syncWebChrome(t);
    else SystemUI.setBackgroundColorAsync(t.colors.bg).catch(() => {});
  }, [t]);

  const navTheme = useMemo(() => {
    const base = t.dark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: t.dark,
      colors: {
        ...base.colors,
        primary: t.colors.accent,
        background: t.colors.bg,
        card: t.colors.bgElevated,
        text: t.colors.text,
        border: t.colors.border,
        notification: t.colors.danger,
      },
    };
  }, [t]);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: t.colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        {Platform.OS === 'web' ? <ActivityIndicator color={t.colors.accent} /> : null}
      </View>
    );
  }

  return (
    <NavigationThemeProvider value={navTheme}>
      <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: t.colors.bg },
            animation: Platform.OS === 'web' ? 'none' : 'default',
          }}
        >
          <Stack.Screen name="index" options={{ animation: 'none' }} />
          <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
          <Stack.Protected guard={paired}>
            <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
            <Stack.Screen name="session/[id]" />
            <Stack.Screen name="new-session" options={{ presentation: 'modal', gestureEnabled: true }} />
            <Stack.Screen name="file" />
          </Stack.Protected>
          <Stack.Screen name="+not-found" />
        </Stack>
        <Toasts />
        <StatusBar style={t.dark ? 'light' : 'dark'} />
        <NotificationRouting />
        <ToastRouteReset />
        <BadgeSync />
      </View>
    </NavigationThemeProvider>
  );
}

/** Routes notification taps (native) once the navigator can accept actions. */
function NotificationRouting() {
  const navState = useRootNavigationState();
  const navReady = !!navState?.key;
  useEffect(() => {
    setNavigationReady(navReady);
    return () => setNavigationReady(false);
  }, [navReady]);
  useNotificationOpens((target) => {
    openNotificationTarget(target);
  });
  return null;
}

/** A toast fired just before navigating ("Session closed" → back) survives; anything older leaves with the screen it belonged to. */
const TOAST_CARRY_OVER_MS = 800;

function ToastRouteReset() {
  const pathname = usePathname();
  useEffect(() => {
    useToast.getState().dismissOlderThan(TOAST_CARRY_OVER_MS);
  }, [pathname]);
  return null;
}

/** App-icon badge = permissions waiting for you across sessions. */
function BadgeSync() {
  const count = useSessions((s) =>
    Math.max(
      s.pending.length,
      s.sessions.reduce((n, x) => n + (x.pendingPermissions || 0), 0),
    ),
  );
  useEffect(() => {
    void syncAppBadge(count);
  }, [count]);
  return null;
}

/** Keep the browser chrome (theme-color, root background, color-scheme) in step with the active theme. */
function syncWebChrome(t: Theme): void {
  try {
    const doc = (globalThis as unknown as { document?: Document }).document;
    if (!doc) return;
    let meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
    if (!meta) {
      meta = doc.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      doc.head.appendChild(meta);
    }
    meta.setAttribute('content', t.colors.bg);
    doc.documentElement.style.backgroundColor = t.colors.bg;
    doc.documentElement.style.setProperty('--mide-focus', t.colors.accent);
    doc.documentElement.style.colorScheme = t.dark ? 'dark' : 'light';
  } catch {
    /* not a browser */
  }
}
