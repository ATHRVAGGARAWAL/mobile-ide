import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';

export interface CardProps extends ViewProps {
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  tone?: 'default' | 'warning' | 'danger' | 'accent' | 'success';
}

export function Card({ style, padded = true, tone = 'default', children, ...rest }: CardProps) {
  const t = useTheme();
  const c = t.colors;
  const border = { default: c.border, warning: c.accent, danger: c.danger, accent: c.accent, success: c.borderStrong }[tone];
  const bg = { default: c.surface, warning: c.accentSoft, danger: c.dangerSoft, accent: c.accentSoft, success: c.surface }[tone];
  return (
    <View
      {...rest}
      style={[
        {
          backgroundColor: tone === 'default' ? c.surface : bg,
          borderColor: border,
          borderWidth: 1,
          borderRadius: t.radius.lg,
        },
        padded ? { padding: 16 } : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}
