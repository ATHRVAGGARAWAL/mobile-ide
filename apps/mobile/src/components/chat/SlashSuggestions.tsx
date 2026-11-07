import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { SlashCommand } from '@mobile-ide/core';
import { T, Tap } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';

export const MAX_SLASH_RESULTS = 8;

/** Prefix matches first, then substring matches on name or description. */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice(0, MAX_SLASH_RESULTS);
  const starts: SlashCommand[] = [];
  const rest: SlashCommand[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) starts.push(c);
    else if (name.includes(q) || (c.description ?? '').toLowerCase().includes(q)) rest.push(c);
  }
  return [...starts, ...rest].slice(0, MAX_SLASH_RESULTS);
}

/** Container shared by the slash and mention panels: sits above the input, scrolls when long. */
export function SuggestionPanel({ children, maxHeight = 240 }: { children: React.ReactNode; maxHeight?: number }) {
  const t = useTheme();
  return (
    <View style={[styles.panel, { backgroundColor: t.colors.bgElevated, borderColor: t.colors.border }]}>
      <ScrollView style={{ maxHeight }} keyboardShouldPersistTaps="always" showsVerticalScrollIndicator>
        {children}
      </ScrollView>
    </View>
  );
}

export interface SlashSuggestionsProps {
  commands: SlashCommand[];
  onSelect: (command: SlashCommand) => void;
}

export function SlashSuggestions({ commands, onSelect }: SlashSuggestionsProps) {
  const t = useTheme();
  if (!commands.length) return null;
  return (
    <SuggestionPanel>
      {commands.map((c) => (
        <Tap key={c.name} onPress={() => onSelect(c)} accessibilityRole="button" accessibilityLabel={`Command ${c.name}`} style={[styles.row, { borderBottomColor: t.colors.border }]}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <T variant="mono" color="accent" weight="600">
              /{c.name}
            </T>
            {c.input ? (
              <T variant="monoSmall" color="textFaint" numberOfLines={1} style={{ flexShrink: 1 }}>
                {c.input}
              </T>
            ) : null}
          </View>
          {c.description ? (
            <T variant="caption" color="textMuted" numberOfLines={2}>
              {c.description}
            </T>
          ) : null}
        </Tap>
      ))}
    </SuggestionPanel>
  );
}

const styles = StyleSheet.create({
  panel: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { paddingHorizontal: 14, paddingVertical: 9, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 44, justifyContent: 'center' },
});
