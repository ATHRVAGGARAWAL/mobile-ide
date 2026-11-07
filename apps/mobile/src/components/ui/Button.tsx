import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { haptic } from '../../lib/haptics';
import { T } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSoft' | 'success' | 'warning';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  loading?: boolean;
  disabled?: boolean;
  full?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  loading,
  disabled,
  full,
  style,
  accessibilityLabel,
}: ButtonProps) {
  const t = useTheme();
  const c = t.colors;
  const palette = {
    primary: { bg: c.accent, fg: c.onAccent, border: c.accent },
    secondary: { bg: c.surface, fg: c.text, border: c.borderStrong },
    ghost: { bg: 'transparent', fg: c.text, border: 'transparent' },
    danger: { bg: c.danger, fg: c.bg, border: c.danger },
    dangerSoft: { bg: c.dangerSoft, fg: c.danger, border: c.dangerSoft },
    // "confirm" actions: inverted neutral (white-on-black in dark mode) so the accent stays reserved for attention
    success: { bg: c.text, fg: c.bg, border: c.text },
    warning: { bg: c.accentSoft, fg: c.accent, border: c.accentSoft },
  }[variant];
  const dims = { sm: { h: 44, px: 12, fs: 13 }, md: { h: 48, px: 18, fs: 15 }, lg: { h: 54, px: 22, fs: 16 } }[size];
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      aria-busy={!!loading}
      disabled={isDisabled}
      onPress={() => {
        void haptic.light();
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: dims.h,
          paddingHorizontal: dims.px,
          backgroundColor: palette.bg,
          borderColor: palette.border,
          borderRadius: t.radius.md,
          opacity: isDisabled ? 0.42 : pressed ? 0.8 : 1,
          alignSelf: full ? 'stretch' : 'flex-start',
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} size="small" />
      ) : (
        <View style={styles.row}>
          {icon ? <Ionicons name={icon} size={dims.fs + 3} color={palette.fg} style={{ marginRight: 6 }} /> : null}
          <T style={{ fontSize: dims.fs, fontWeight: '600', color: palette.fg }} numberOfLines={1}>
            {title}
          </T>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
