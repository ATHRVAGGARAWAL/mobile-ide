import React from 'react';
import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import type { ThemeColors } from '../../theme';

export type TextVariant =
  'display' | 'title' | 'heading' | 'subheading' | 'body' | 'bodySmall' | 'caption' | 'label' | 'mono' | 'monoSmall';

export interface TProps extends TextProps {
  variant?: TextVariant;
  color?: keyof ThemeColors | (string & {});
  weight?: '400' | '500' | '600' | '700';
  align?: TextStyle['textAlign'];
  children?: React.ReactNode;
}

export function T({ variant = 'body', color, weight, align, style, children, ...rest }: TProps) {
  const t = useTheme();
  const base = variantStyle(variant, t.font);
  const resolved = color
    ? color in t.colors
      ? t.colors[color as keyof ThemeColors]
      : color
    : variant === 'caption' || variant === 'label'
      ? t.colors.textMuted
      : t.colors.text;
  return (
    <RNText
      {...rest}
      style={[
        { fontFamily: t.font.sans },
        base,
        { color: resolved },
        weight ? { fontWeight: weight } : null,
        align ? { textAlign: align } : null,
        style,
      ]}
    >
      {children}
    </RNText>
  );
}

function variantStyle(v: TextVariant, font: ReturnType<typeof useTheme>['font']): TextStyle {
  switch (v) {
    case 'display':
      return { fontSize: font.size.xxl, fontWeight: '600', letterSpacing: -1.1, lineHeight: 39 };
    case 'title':
      return { fontSize: font.size.xl, fontWeight: '600', letterSpacing: -0.7, lineHeight: 31 };
    case 'heading':
      return { fontSize: font.size.lg, fontWeight: '600', letterSpacing: -0.3, lineHeight: 25 };
    case 'subheading':
      return { fontSize: font.size.md, fontWeight: '600', lineHeight: 20 };
    case 'bodySmall':
      return { fontSize: font.size.sm, lineHeight: 18 };
    case 'caption':
      return { fontSize: font.size.xs + 1, lineHeight: 16 };
    case 'label':
      return { fontSize: font.size.xs, fontWeight: '600', letterSpacing: 1.1, textTransform: 'uppercase', lineHeight: 16 };
    case 'mono':
      return { fontFamily: font.mono, fontSize: font.size.sm, lineHeight: 19 };
    case 'monoSmall':
      return { fontFamily: font.mono, fontSize: font.size.xs + 1, lineHeight: 16 };
    default:
      return { fontSize: font.size.md, lineHeight: 23 };
  }
}
