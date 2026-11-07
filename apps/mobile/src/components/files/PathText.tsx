/**
 * One-line monospace path that truncates in the MIDDLE and keeps the file name whole
 * (`src/comp…/files/FileViewer.tsx`). React Native Web ignores `ellipsizeMode="middle"`, so the
 * width is measured and the string is cut in JS; the platform ellipsis stays on as a safety net.
 */
import React, { useState } from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import type { ThemeColors } from '../../theme';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from '../ui/Text';
import { monoCharsThatFit, truncatePathMiddle } from './pathFormat';

export interface PathTextProps {
  path: string;
  variant?: 'mono' | 'monoSmall';
  /** colour of the directory part (and of everything when `emphasizeBase` is off) */
  color?: keyof ThemeColors | (string & {});
  /** draw the last segment semibold in `baseColor` (defaults to the primary text colour) */
  emphasizeBase?: boolean;
  baseColor?: keyof ThemeColors | (string & {});
  /** applied to the measuring wrapper — give it `flex: 1` inside a row */
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  selectable?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

export function PathText({ path, variant = 'monoSmall', color, emphasizeBase, baseColor, style, textStyle, selectable, accessibilityLabel, testID }: PathTextProps) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const fontSize = variant === 'mono' ? t.font.size.sm : t.font.size.xs + 1;
  const budget = width > 0 ? monoCharsThatFit(width, fontSize) : Number.POSITIVE_INFINITY;
  const shown = truncatePathMiddle(path, budget);
  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Math.abs(w - width) > 0.5) setWidth(w);
  };
  return (
    <View style={[{ flexShrink: 1, minWidth: 0 }, style]} onLayout={onLayout}>
      <T
        variant={variant}
        color={color ?? (emphasizeBase ? 'textMuted' : undefined)}
        numberOfLines={1}
        ellipsizeMode="middle"
        selectable={selectable}
        accessibilityLabel={accessibilityLabel ?? path}
        testID={testID}
        style={textStyle}
      >
        {emphasizeBase ? (
          <>
            {shown.dir}
            <T variant={variant} weight="600" color={baseColor ?? 'text'} style={textStyle}>
              {shown.base}
            </T>
          </>
        ) : (
          shown.dir + shown.base
        )}
      </T>
    </View>
  );
}
