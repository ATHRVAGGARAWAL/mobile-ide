/**
 * Skeleton placeholders that mirror the layout they stand in for (list rows, a code page, a diff),
 * so a loading screen already has the right shape instead of a centred spinner.
 * One pulse drives every block inside a container; blocks without a pulse render static.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';

const LOW = 0.45;

export function usePulse(): Animated.Value {
  const value = useRef(new Animated.Value(LOW)).current;
  useEffect(() => {
    const native = Platform.OS !== 'web';
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: native }),
        Animated.timing(value, { toValue: LOW, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: native }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [value]);
  return value;
}

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  pulse?: Animated.Value;
  color?: string;
  style?: StyleProp<ViewStyle>;
}

/** One grey block. */
export function Skeleton({ width = '100%', height = 12, radius = 6, pulse, color, style }: SkeletonProps) {
  const t = useTheme();
  return <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: color ?? t.colors.surfaceAlt, opacity: pulse ?? 0.8 }, style]} />;
}

function Frame({ children, label = 'Loading', testID = 'skeleton', style }: { children: React.ReactNode; label?: string; testID?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} testID={testID} style={style}>
      {children}
    </View>
  );
}

const TITLE_WIDTHS = [62, 44, 71, 53, 66, 40, 58, 49, 64, 46];
const SUB_WIDTHS = [28, 36, 22, 40, 30, 26, 34, 24, 38, 32];

export interface SkeletonRowsProps {
  rows?: number;
  /** leading 32×32 icon box like FsEntryRow / ListRow */
  iconBox?: boolean;
  /** second, fainter line under the title */
  subtitle?: boolean;
  /** trailing chip-sized block (status badge / count) on some rows */
  trailing?: boolean;
  inset?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** List rows: icon box + title + subtitle, at ListRow height. */
export function SkeletonRows({ rows = 8, iconBox = true, subtitle = true, trailing = false, inset, style, testID }: SkeletonRowsProps) {
  const t = useTheme();
  const pulse = usePulse();
  const pad = inset ?? t.spacing.lg;
  return (
    <Frame style={style} testID={testID}>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[styles.row, { paddingHorizontal: pad, borderBottomColor: t.colors.border }]}>
          {iconBox ? <Skeleton width={32} height={32} radius={8} pulse={pulse} /> : null}
          <View style={{ flex: 1, gap: 7 }}>
            <Skeleton width={`${TITLE_WIDTHS[i % TITLE_WIDTHS.length] ?? 50}%`} height={12} pulse={pulse} />
            {subtitle ? <Skeleton width={`${SUB_WIDTHS[i % SUB_WIDTHS.length] ?? 30}%`} height={9} pulse={pulse} /> : null}
          </View>
          {trailing && i % 3 === 1 ? <Skeleton width={34} height={16} radius={8} pulse={pulse} /> : null}
        </View>
      ))}
    </Frame>
  );
}

const CODE_WIDTHS = [48, 72, 30, 64, 56, 22, 80, 44, 60, 36, 68, 26, 52, 74, 40, 58];
const CODE_INDENT = [0, 1, 2, 2, 1, 0, 0, 1, 2, 3, 2, 1, 0, 1, 1, 0];

/** A page of code: line-number gutter + indented text bars. */
export function SkeletonCode({ lines = 22, style, testID }: { lines?: number; style?: StyleProp<ViewStyle>; testID?: string }) {
  const t = useTheme();
  const pulse = usePulse();
  return (
    <Frame style={[{ paddingVertical: 10 }, style]} testID={testID}>
      {Array.from({ length: lines }, (_, i) => (
        <View key={i} style={styles.codeLine}>
          <View style={styles.gutter}>
            <Skeleton width={i % 10 === 9 ? 16 : 10} height={8} radius={3} pulse={pulse} color={t.colors.border} />
          </View>
          <View style={{ flex: 1, paddingLeft: (CODE_INDENT[i % CODE_INDENT.length] ?? 0) * 18 }}>
            <Skeleton width={`${CODE_WIDTHS[i % CODE_WIDTHS.length] ?? 50}%`} height={10} radius={4} pulse={pulse} />
          </View>
        </View>
      ))}
    </Frame>
  );
}

const DIFF_KIND: ('ctx' | 'add' | 'del')[] = ['ctx', 'ctx', 'del', 'add', 'add', 'ctx', 'ctx', 'del', 'del', 'add', 'ctx', 'ctx', 'add', 'ctx'];

/** A unified diff block: file header, hunk bar, tinted +/- rows. */
export function SkeletonDiff({ lines = 14, style, testID }: { lines?: number; style?: StyleProp<ViewStyle>; testID?: string }) {
  const t = useTheme();
  const pulse = usePulse();
  return (
    <Frame style={[styles.diffBox, { borderColor: t.colors.border, backgroundColor: t.colors.codeBg }, style]} testID={testID}>
      <View style={[styles.diffHead, { backgroundColor: t.colors.surfaceAlt, borderBottomColor: t.colors.border }]}>
        <Skeleton width="45%" height={11} pulse={pulse} color={t.colors.border} />
        <View style={{ flex: 1 }} />
        <Skeleton width={44} height={11} pulse={pulse} color={t.colors.border} />
      </View>
      <View style={[styles.hunk, { backgroundColor: t.colors.surfaceAlt }]}>
        <Skeleton width="38%" height={9} pulse={pulse} color={t.colors.border} />
      </View>
      {Array.from({ length: lines }, (_, i) => {
        const kind = DIFF_KIND[i % DIFF_KIND.length] ?? 'ctx';
        const bg = kind === 'add' ? t.colors.diffAdd : kind === 'del' ? t.colors.diffDel : 'transparent';
        return (
          <View key={i} style={[styles.diffLine, { backgroundColor: bg }]}>
            <View style={styles.diffGutter}>
              <Skeleton width={12} height={8} radius={3} pulse={pulse} color={t.colors.border} />
            </View>
            <View style={styles.diffGutter}>
              <Skeleton width={12} height={8} radius={3} pulse={pulse} color={t.colors.border} />
            </View>
            <View style={{ flex: 1, paddingLeft: 8 }}>
              <Skeleton width={`${CODE_WIDTHS[(i * 3) % CODE_WIDTHS.length] ?? 50}%`} height={9} radius={4} pulse={pulse} />
            </View>
          </View>
        );
      })}
    </Frame>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  codeLine: { flexDirection: 'row', alignItems: 'center', height: 20, paddingRight: 16 },
  gutter: { width: 48, alignItems: 'flex-end', paddingRight: 10 },
  diffBox: { borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  diffHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  hunk: { paddingHorizontal: 10, paddingVertical: 7 },
  diffLine: { flexDirection: 'row', alignItems: 'center', height: 18, paddingRight: 10 },
  diffGutter: { width: 34, alignItems: 'flex-end', paddingRight: 6 },
});
