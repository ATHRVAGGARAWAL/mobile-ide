/** Loading placeholder for the Changes tab: branch line, a card of change rows, a card of commits. */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { Skeleton, usePulse } from '../files/Skeleton';

export function ChangesSkeleton({ testID = 'changes-skeleton' }: { testID?: string }) {
  const t = useTheme();
  const pulse = usePulse();
  const card = [styles.card, { borderColor: t.colors.border, backgroundColor: t.colors.surface, marginHorizontal: t.spacing.lg }];
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel="Loading changes" testID={testID}>
      <View style={[styles.summary, { paddingHorizontal: t.spacing.lg }]}>
        <Skeleton width={15} height={15} radius={4} pulse={pulse} />
        <Skeleton width={96} height={12} pulse={pulse} />
        <View style={{ flex: 1 }} />
        <Skeleton width={70} height={22} radius={11} pulse={pulse} />
      </View>
      <Skeleton width={90} height={10} pulse={pulse} style={{ marginHorizontal: t.spacing.lg, marginTop: 20, marginBottom: 10 }} />
      <View style={card}>
        {[64, 46, 58].map((w, i) => (
          <View key={i} style={[styles.row, { paddingHorizontal: t.spacing.lg, borderTopColor: t.colors.border, borderTopWidth: i ? StyleSheet.hairlineWidth : 0 }]}>
            <Skeleton width={30} height={30} radius={8} pulse={pulse} />
            <View style={{ flex: 1, gap: 7 }}>
              <Skeleton width={`${w}%`} height={12} pulse={pulse} />
              <Skeleton width={52} height={9} pulse={pulse} />
            </View>
          </View>
        ))}
      </View>
      <Skeleton width={120} height={10} pulse={pulse} style={{ marginHorizontal: t.spacing.lg, marginTop: 22, marginBottom: 10 }} />
      <View style={card}>
        {[72, 55, 66, 48].map((w, i) => (
          <View key={i} style={[styles.row, { paddingHorizontal: t.spacing.lg, borderTopColor: t.colors.border, borderTopWidth: i ? StyleSheet.hairlineWidth : 0 }]}>
            <Skeleton width={58} height={22} radius={6} pulse={pulse} />
            <View style={{ flex: 1, gap: 7 }}>
              <Skeleton width={`${w}%`} height={12} pulse={pulse} />
              <Skeleton width={110} height={9} pulse={pulse} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 12, paddingBottom: 4, minHeight: 30 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10 },
});
