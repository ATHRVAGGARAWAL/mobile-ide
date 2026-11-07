import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeInsets } from '../../lib/safeArea';
import { useTheme } from '../../theme/ThemeProvider';

export interface ScreenProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** which safe-area edges to pad; tabs and stacks already handle top/bottom in most cases */
  edges?: ('top' | 'bottom')[];
  elevated?: boolean;
}

export function Screen({ children, style, edges = [], elevated }: ScreenProps) {
  const t = useTheme();
  const insets = useSafeInsets();
  return (
    <View
      style={[
        {
          flex: 1,
          width: '100%',
          maxWidth: 1180,
          alignSelf: 'center',
          backgroundColor: elevated ? t.colors.bgElevated : t.colors.bg,
          paddingTop: edges.includes('top') ? insets.top : 0,
          paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
