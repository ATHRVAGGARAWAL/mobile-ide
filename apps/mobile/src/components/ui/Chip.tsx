import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from './Text';
import { Tap } from './Tap';

export interface ChipProps {
  label: string;
  bg?: string;
  fg?: string;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  size?: 'sm' | 'md';
  mono?: boolean;
  onPress?: () => void;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  maxWidth?: number;
}

export function Chip({ label, bg, fg, icon, size = 'sm', mono, onPress, selected, style, maxWidth }: ChipProps) {
  const t = useTheme();
  const background = selected ? t.colors.accent : bg ?? t.colors.surfaceAlt;
  const color = selected ? t.colors.onAccent : fg ?? t.colors.textMuted;
  const h = size === 'sm' ? 22 : 30;
  const content = (
    <View
      style={[
        {
          // tappable chips may grow with dynamic type instead of clipping their label
          ...(onPress ? { minHeight: h } : { height: h }),
          paddingHorizontal: size === 'sm' ? 8 : 12,
          borderRadius: t.radius.pill,
          backgroundColor: background,
          flexDirection: 'row',
          alignItems: 'center',
          maxWidth,
        },
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={size === 'sm' ? 12 : 14} color={color} style={{ marginRight: 4 }} /> : null}
      <T
        numberOfLines={1}
        style={{ color, fontSize: size === 'sm' ? 11 : 13, fontWeight: '600', fontFamily: mono ? t.font.mono : undefined }}
      >
        {label}
      </T>
    </View>
  );
  if (!onPress) return content;
  // The pill itself is 22–30 pt tall; the slop brings every tappable chip to the 44 pt minimum touch target.
  const slop = { top: Math.ceil((44 - h) / 2), bottom: Math.ceil((44 - h) / 2), left: 6, right: 6 };
  return (
    <Tap onPress={onPress} pressedColor={null} hitSlop={slop} accessibilityRole="button" accessibilityLabel={label}>
      {content}
    </Tap>
  );
}
