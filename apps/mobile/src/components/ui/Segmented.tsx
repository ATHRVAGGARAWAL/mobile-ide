import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { haptic } from '../../lib/haptics';
import { T } from './Text';
import { Tap } from './Tap';

export interface SegmentedProps<K extends string> {
  options: { key: K; label: string; badge?: number }[];
  value: K;
  onChange: (k: K) => void;
}

export function Segmented<K extends string>({ options, value, onChange }: SegmentedProps<K>) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', backgroundColor: t.colors.surfaceAlt, borderRadius: t.radius.md + 2, padding: 4, gap: 3 }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Tap
            key={o.key}
            pressedColor={null}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => {
              if (!active) {
                void haptic.selection();
                onChange(o.key);
              }
            }}
            style={{
              flex: 1,
              minHeight: 44,
              paddingVertical: 8,
              paddingHorizontal: 4,
              borderRadius: t.radius.sm + 1,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              backgroundColor: active ? t.colors.surface : 'transparent',
              borderWidth: 1,
              borderColor: active ? t.colors.borderStrong : 'transparent',
            }}
          >
            <T
              variant="bodySmall"
              weight={active ? '600' : '500'}
              color={active ? 'text' : 'textMuted'}
              align="center"
              style={{ flexShrink: 1 }}
            >
              {o.label}
            </T>
            {o.badge ? (
              <View
                style={{
                  marginLeft: 6,
                  minWidth: 18,
                  height: 18,
                  borderRadius: 9,
                  backgroundColor: t.colors.accent,
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingHorizontal: 5,
                }}
              >
                <T style={{ fontSize: 11, fontWeight: '700', color: t.colors.onAccent }}>{o.badge}</T>
              </View>
            ) : null}
          </Tap>
        );
      })}
    </View>
  );
}
