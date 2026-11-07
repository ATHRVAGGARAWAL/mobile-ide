import React from 'react';
import { StyleSheet, View } from 'react-native';
import { agentColor } from '../../theme';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from './Text';

/** Agent identity, monochrome: an outlined name chip (sm) or a bordered initials tile (md / lg). */
export function AgentBadge({ agent, name, size = 'sm' }: { agent: string; name?: string; size?: 'sm' | 'md' | 'lg' }) {
  const t = useTheme();
  const col = agentColor(agent, t);
  const label = (name ?? agent).trim();
  const initials = label
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);
  if (size !== 'sm') {
    const box = size === 'lg' ? 40 : 32;
    return (
      <View
        style={{
          width: box,
          height: box,
          borderRadius: size === 'lg' ? t.radius.md : t.radius.sm + 1,
          backgroundColor: col.bg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <T style={{ color: t.colors.text, fontWeight: '600', fontSize: size === 'lg' ? 14 : 12, letterSpacing: 0.2 }}>{initials}</T>
      </View>
    );
  }
  return (
    <View
      style={{
        paddingHorizontal: 7,
        height: 20,
        borderRadius: t.radius.sm,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.colors.borderStrong,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <T style={{ color: col.fg, fontWeight: '600', fontSize: 11 }} numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}
