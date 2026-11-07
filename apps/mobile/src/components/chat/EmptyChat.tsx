import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { T, Tap } from '../ui';
import { SESSION_WORKFLOWS } from '../sessions/workflows';

export interface EmptyChatProps {
  agentName: string;
  projectName?: string;
  canDraft: boolean;
  offline?: boolean;
  onDraft: (text: string) => void;
}

/** Workflow starters fill the composer so the user can review and adapt the task before sending. */
export function EmptyChat({ agentName, projectName, canDraft, offline, onDraft }: EmptyChatProps) {
  const t = useTheme();
  const c = t.colors;
  return (
    <View style={styles.root}>
      <View style={[styles.glyph, { backgroundColor: c.accentSoft, borderColor: c.borderStrong }]}>
        <Ionicons name="terminal-outline" size={28} color={c.accent} />
      </View>
      <T variant="heading" align="center" accessibilityRole="header">
        What are we working on?
      </T>
      <T variant="bodySmall" color="textMuted" align="center" style={styles.intro}>
        {projectName ? `${agentName} is ready in ${projectName}.` : `${agentName} is ready.`} Describe a task, or choose a starting point.
      </T>
      <View style={styles.list} accessibilityRole="list">
        {SESSION_WORKFLOWS.map((workflow) => (
          <Tap
            key={workflow.id}
            onPress={() => onDraft(workflow.prompt)}
            haptics
            disabled={!canDraft}
            accessibilityRole="button"
            accessibilityLabel={`Draft ${workflow.title.toLowerCase()} workflow`}
            accessibilityHint="Adds an editable prompt to your draft"
            accessibilityState={{ disabled: !canDraft }}
            style={[
              styles.row,
              { backgroundColor: c.surface, borderColor: c.border, borderRadius: t.radius.lg, opacity: canDraft ? 1 : 0.55 },
            ]}
          >
            <View style={[styles.iconBox, { backgroundColor: c.surfaceAlt }]}>
              <Ionicons name={workflow.icon} size={20} color={c.textMuted} />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <T variant="subheading">{workflow.title}</T>
              <T variant="caption" color="textMuted">
                {workflow.hint}
              </T>
            </View>
            <Ionicons name="add-outline" size={20} color={c.accent} />
          </Tap>
        ))}
      </View>
      <T variant="caption" color={offline ? 'warning' : 'textFaint'} align="center" style={{ marginTop: 8 }}>
        {offline ? 'Offline. Messages will send when the connection returns.' : 'Make it your own before sending.'}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', paddingHorizontal: 4, paddingTop: 32, paddingBottom: 24, gap: 8 },
  glyph: { width: 64, height: 64, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  intro: { maxWidth: 350, lineHeight: 21 },
  list: { width: '100%', maxWidth: 520, gap: 10, marginTop: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, minHeight: 78, borderWidth: 1 },
  iconBox: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
