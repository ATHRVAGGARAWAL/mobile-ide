import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { TimelineItem } from '@mobile-ide/core';
import { Card, Chip, T, Tap } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';

type PlanEntries = Extract<TimelineItem, { kind: 'plan' }>['entries'];

export interface PlanCardProps {
  id: string;
  entries: PlanEntries;
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
}

/** The agent's plan as a checklist with progress; collapsible. */
export const PlanCard = React.memo(function PlanCard({ id, entries, open, onToggle }: PlanCardProps) {
  const t = useTheme();
  const c = t.colors;
  const collapsed = !open;
  const done = entries.filter((e) => e.status === 'completed').length;
  const total = entries.length;
  return (
    <Card padded={false} style={{ overflow: 'hidden' }}>
      <Tap
        onPress={() => onToggle(id, !open)}
        pressedColor={null}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        style={styles.head}
      >
        <Ionicons name="list-outline" size={16} color={c.textMuted} />
        <T variant="subheading" style={{ flex: 1 }}>
          Work plan
        </T>
        <T variant="caption" color="textMuted">
          {done} of {total}
        </T>
        <Ionicons name={collapsed ? 'chevron-down' : 'chevron-up'} size={14} color={c.textFaint} />
      </Tap>
      <View style={{ flexDirection: 'row', height: 2, backgroundColor: c.surfaceAlt }}>
        <View style={{ flex: done, backgroundColor: c.accent }} />
        <View style={{ flex: Math.max(0, total - done) }} />
      </View>
      {!collapsed ? (
        <View style={styles.list}>
          {entries.map((e, i) => (
            <View key={i} style={styles.row}>
              {e.status === 'completed' ? (
                <Ionicons name="checkmark-circle" size={18} color={c.textMuted} />
              ) : e.status === 'in_progress' ? (
                <ActivityIndicator size="small" color={c.accent} style={{ transform: [{ scale: 0.8 }], width: 18, height: 18 }} />
              ) : (
                <Ionicons name="ellipse-outline" size={18} color={c.textFaint} />
              )}
              <T
                variant="bodySmall"
                style={{
                  flex: 1,
                  color: e.status === 'completed' ? c.textMuted : c.text,
                  textDecorationLine: e.status === 'completed' ? 'line-through' : 'none',
                }}
              >
                {e.content}
              </T>
              {e.priority === 'high' ? <Chip label="high" bg={c.accentSoft} fg={c.accent} /> : null}
            </View>
          ))}
          {!entries.length ? (
            <T variant="caption" color="textFaint">
              Empty plan
            </T>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
});

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  list: { paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
});
