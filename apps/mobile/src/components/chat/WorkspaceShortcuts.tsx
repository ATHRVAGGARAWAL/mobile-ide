import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { T, Tap } from '../ui';
import { openProjectTab } from './files';

const DESTINATIONS = [
  { tab: 'files', label: 'Files', icon: 'folder-open-outline' },
  { tab: 'changes', label: 'Changes', icon: 'git-compare-outline' },
  { tab: 'terminal', label: 'Terminal', icon: 'terminal-outline' },
] as const;

/** Keep project tools within one tap of the conversation, with the session's folder selected. */
export function WorkspaceShortcuts({ cwd }: { cwd: string }) {
  const t = useTheme();
  if (!cwd) return null;
  return (
    <View style={{ backgroundColor: t.colors.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.border }}>
      <View
        style={{
          width: '100%',
          maxWidth: 860,
          alignSelf: 'center',
          flexDirection: 'row',
          paddingHorizontal: 20,
          gap: 6,
          paddingBottom: 10,
        }}
      >
        {DESTINATIONS.map((item) => (
          <Tap
            key={item.tab}
            onPress={() => openProjectTab(cwd, item.tab)}
            accessibilityRole="button"
            accessibilityLabel={`Open project ${item.label.toLowerCase()}`}
            style={{
              flex: 1,
              minHeight: 44,
              gap: 7,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: t.colors.surfaceAlt,
              borderRadius: t.radius.md,
            }}
          >
            <Ionicons name={item.icon} size={16} color={t.colors.textMuted} />
            <T variant="caption" weight="600">
              {item.label}
            </T>
          </Tap>
        ))}
      </View>
    </View>
  );
}
