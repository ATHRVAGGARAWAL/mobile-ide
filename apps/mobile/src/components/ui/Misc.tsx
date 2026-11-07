import React from 'react';
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { shadow } from '../../theme';
import { T } from './Text';
import { Tap } from './Tap';

export function Divider({ inset = 0, style }: { inset?: number; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: t.colors.border, marginLeft: inset }, style]} />;
}

export function SectionHeader({ title, right, style }: { title: string; right?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View
      style={[{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.spacing.lg, paddingTop: 24, paddingBottom: 12 }, style]}
    >
      <T variant="label" style={{ flex: 1 }}>
        {title}
      </T>
      {right}
    </View>
  );
}

export function Spinner({ size = 'small' }: { size?: 'small' | 'large' }) {
  const t = useTheme();
  return <ActivityIndicator size={size} color={t.colors.accent} />;
}

export function KeyValue({ label, value, mono, onPress }: { label: string; value: string; mono?: boolean; onPress?: () => void }) {
  const t = useTheme();
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.spacing.lg, paddingVertical: 12, gap: 12 }}>
      <T variant="bodySmall" color="textMuted" style={{ width: 84 }}>
        {label}
      </T>
      <T variant={mono ? 'mono' : 'bodySmall'} style={{ flex: 1 }} numberOfLines={2} selectable>
        {value}
      </T>
      {onPress ? <Ionicons name="copy-outline" size={16} color={t.colors.textFaint} /> : null}
    </View>
  );
  return onPress ? <Tap onPress={onPress}>{body}</Tap> : body;
}

export function Fab({
  onPress,
  icon = 'add',
  label,
}: {
  onPress: () => void;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
}) {
  const t = useTheme();
  return (
    <Tap
      onPress={onPress}
      haptics
      accessibilityRole="button"
      accessibilityLabel={label}
      pressedColor={null}
      pressedStyle={{ transform: [{ scale: 0.96 }], opacity: 0.9 }}
      style={{
        position: 'absolute',
        right: 20,
        bottom: 24,
        height: 52,
        paddingHorizontal: 18,
        borderRadius: 26,
        backgroundColor: t.colors.accent,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        boxShadow: shadow(t, 0, 6, 12, 0.5),
        elevation: 6,
      }}
    >
      <Ionicons name={icon} size={22} color={t.colors.onAccent} />
      <T style={{ color: t.colors.onAccent, fontWeight: '700', fontSize: 15 }}>{label}</T>
    </Tap>
  );
}

export function UnreadDot({ visible }: { visible: boolean }) {
  const t = useTheme();
  if (!visible) return null;
  return <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: t.colors.accent }} accessibilityLabel="Unread" />;
}
