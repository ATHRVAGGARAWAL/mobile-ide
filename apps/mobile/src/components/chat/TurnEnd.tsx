import React from 'react';
import { StyleSheet, View } from 'react-native';
import { T } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';
import { formatCost, formatDuration, formatTokens } from '../../lib/format';
import { stopReasonLabel, stopReasonTone } from './toolMeta';

export interface TurnEndProps {
  stopReason: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  durationMs?: number;
}

/** Thin divider closing a turn: stop reason, duration, tokens and cost when the agent reports them. */
export function TurnEnd({ stopReason, usage, durationMs }: TurnEndProps) {
  const t = useTheme();
  const tone = stopReasonTone(stopReason);
  const color = tone === 'danger' ? t.colors.danger : tone === 'warning' ? t.colors.warning : t.colors.textFaint;
  const parts: string[] = [stopReasonLabel(stopReason)];
  if (durationMs !== undefined && durationMs > 0) parts.push(formatDuration(durationMs));
  if (usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
    parts.push(`${formatTokens(usage.inputTokens ?? 0)} in · ${formatTokens(usage.outputTokens ?? 0)} out`);
  }
  if (usage?.costUsd !== undefined) parts.push(formatCost(usage.costUsd));
  return (
    <View style={styles.row} accessibilityLabel={`Turn ended: ${parts.join(', ')}`}>
      <View style={[styles.line, { backgroundColor: t.colors.border }]} />
      <T variant="caption" style={{ color, flexShrink: 1 }}>
        {parts.join('  ·  ')}
      </T>
      <View style={[styles.line, { backgroundColor: t.colors.border }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14 },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
});
