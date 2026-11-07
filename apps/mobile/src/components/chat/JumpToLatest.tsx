import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { T, Tap } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';
import { shadow } from '../../theme';

export interface JumpToLatestProps {
  visible: boolean;
  /** items appended since the user scrolled away */
  count: number;
  onPress: () => void;
}

/** Floating pill shown when the user has scrolled up while the agent keeps producing output. */
export function JumpToLatest({ visible, count, onPress }: JumpToLatestProps) {
  const t = useTheme();
  if (!visible) return null;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 12, alignItems: 'center' }}>
      <Tap
        onPress={onPress}
        haptics
        accessibilityRole="button"
        accessibilityLabel={count > 0 ? `${count} new items, jump to latest` : 'Jump to latest'}
        pressedColor={null}
        pressedStyle={{ opacity: 0.85 }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          height: 34,
          paddingHorizontal: 14,
          borderRadius: t.radius.pill,
          backgroundColor: t.colors.bgElevated,
          borderWidth: 1,
          borderColor: t.colors.border,
          boxShadow: shadow(t, 0, 4, 10, 0.35),
          elevation: 6,
        }}
      >
        <Ionicons name="arrow-down" size={14} color={t.colors.accent} />
        <T variant="bodySmall" weight="600" color="accent">
          {count > 0 ? `${count} new` : 'Latest'}
        </T>
      </Tap>
    </View>
  );
}
