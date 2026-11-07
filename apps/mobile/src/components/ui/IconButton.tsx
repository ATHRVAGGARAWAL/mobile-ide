import React from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { haptic } from '../../lib/haptics';

export interface IconButtonProps {
  name: React.ComponentProps<typeof Ionicons>['name'];
  onPress?: () => void;
  size?: number;
  color?: string;
  label: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  filled?: boolean;
}

export function IconButton({ name, onPress, size = 22, color, label, disabled, style, filled }: IconButtonProps) {
  const t = useTheme();
  const box = Math.max(44, size + 18);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        void haptic.light();
        onPress?.();
      }}
      style={({ pressed }) => [
        {
          width: box,
          height: box,
          borderRadius: t.radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: filled ? t.colors.surfaceAlt : pressed ? t.colors.surfacePressed : 'transparent',
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      <Ionicons name={name} size={size} color={color ?? t.colors.text} />
    </Pressable>
  );
}
