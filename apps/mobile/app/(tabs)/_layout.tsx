/** Phone dock and desktop sidebar share the same routes and attention count. */
import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router/js-tabs';
import React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useKeyboardVisible } from '../../src/components/chat/useKeyboardInset';
import { BrandMark, ConnectionDot, T, Tap } from '../../src/components/ui';
import { useSafeInsets } from '../../src/lib/safeArea';
import { useSessions } from '../../src/state/sessions';
import { useSettings } from '../../src/state/settings';
import { useTheme } from '../../src/theme/ThemeProvider';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
type TabProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>['tabBar']>>[0];
const icons: Record<string, IconName> = {
  index: 'chatbubbles-outline',
  files: 'folder-outline',
  changes: 'git-compare-outline',
  terminal: 'terminal-outline',
  settings: 'options-outline',
};

function WorkspaceNavigation({ state, descriptors, navigation }: TabProps) {
  const t = useTheme();
  const insets = useSafeInsets();
  const wide = useWindowDimensions().width >= 900;
  const serverName = useSettings((s) => s.serverName);
  const needsYou = useSessions((s) =>
    Math.max(
      s.pending.length,
      s.sessions.reduce((n, x) => n + (x.pendingPermissions || 0), 0),
    ),
  );
  const keyboardVisible = useKeyboardVisible(0);
  // Custom tab bars do not inherit React Navigation's tabBarHideOnKeyboard handling.
  if (!wide && Platform.OS === 'android' && keyboardVisible) return null;
  return (
    <View
      role="tablist"
      style={
        wide
          ? {
              width: 196,
              paddingTop: insets.top + 28,
              paddingBottom: 24,
              paddingHorizontal: 14,
              backgroundColor: t.colors.bgElevated,
              borderRightWidth: 1,
              borderRightColor: t.colors.border,
            }
          : {
              flexDirection: 'row',
              paddingHorizontal: 10,
              paddingTop: 8,
              paddingBottom: Math.max(insets.bottom, 8),
              backgroundColor: t.colors.tabBar,
              borderTopWidth: 1,
              borderTopColor: t.colors.border,
            }
      }
    >
      {wide ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6, marginBottom: 36 }}>
          <BrandMark />
          <T weight="600" style={{ letterSpacing: -0.5 }}>
            mobile ide
          </T>
        </View>
      ) : null}
      {state.routes.map((route, index) => {
        const selected = state.index === index;
        const label = descriptors[route.key]?.options.title ?? route.name;
        const badge = route.name === 'index' ? needsYou : 0;
        return (
          <Tap
            key={route.key}
            accessibilityRole="tab"
            accessibilityLabel={badge ? `${label}, ${badge} need you` : label}
            accessibilityState={{ selected }}
            onPress={() => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!selected && !event.defaultPrevented) navigation.navigate(route.name, route.params);
            }}
            onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
            style={{
              ...(wide ? { marginBottom: 6, paddingHorizontal: 14, flexDirection: 'row', gap: 12 } : { flex: 1, gap: 4 }),
              minHeight: wide ? 50 : 54,
              borderRadius: t.radius.md,
              alignItems: 'center',
              justifyContent: wide ? 'flex-start' : 'center',
              backgroundColor: selected ? t.colors.accentSoft : 'transparent',
            }}
          >
            <View>
              <Ionicons
                name={icons[route.name] ?? 'ellipse-outline'}
                size={wide ? 20 : 21}
                color={selected ? t.colors.accent : t.colors.textMuted}
              />
              {badge > 0 ? (
                <View
                  style={{
                    position: 'absolute',
                    right: -10,
                    top: -6,
                    minWidth: 17,
                    height: 17,
                    paddingHorizontal: 4,
                    borderRadius: 9,
                    backgroundColor: t.colors.accent,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <T style={{ color: t.colors.onAccent, fontSize: 10, lineHeight: 14, fontWeight: '700' }}>{badge > 99 ? '99+' : badge}</T>
                </View>
              ) : null}
            </View>
            <T
              style={{
                fontSize: wide ? 13 : 10,
                lineHeight: wide ? 18 : 14,
                fontWeight: selected ? '600' : '500',
                color: selected ? t.colors.accent : t.colors.textMuted,
              }}
              numberOfLines={1}
            >
              {label}
            </T>
          </Tap>
        );
      })}
      {wide ? (
        <View style={{ marginTop: 'auto', paddingHorizontal: 8, paddingTop: 32, gap: 10 }}>
          <T variant="label" color="textFaint">
            Your computer
          </T>
          <T variant="bodySmall" weight="600" numberOfLines={1}>
            {serverName ?? 'Workspace'}
          </T>
          <ConnectionDot />
        </View>
      ) : null}
    </View>
  );
}

export default function TabsLayout() {
  const t = useTheme();
  const wide = useWindowDimensions().width >= 900;
  return (
    <Tabs
      tabBar={(props) => <WorkspaceNavigation {...props} />}
      screenOptions={{
        headerShown: false,
        lazy: true,
        tabBarPosition: wide ? 'left' : 'bottom',
        tabBarHideOnKeyboard: Platform.OS === 'android',
        sceneStyle: { backgroundColor: t.colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Sessions' }} />
      <Tabs.Screen name="files" options={{ title: 'Files' }} />
      <Tabs.Screen name="changes" options={{ title: 'Changes' }} />
      <Tabs.Screen name="terminal" options={{ title: 'Terminal' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
