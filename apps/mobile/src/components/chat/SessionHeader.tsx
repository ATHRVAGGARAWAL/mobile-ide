import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { SessionMode, SessionStatus } from '@mobile-ide/core';
import { IconButton, StatusChip, T, Tap } from '../ui';
import { useSafeTop } from '../../lib/safeArea';
import { useTheme } from '../../theme/ThemeProvider';
import { ModeChip } from './ModeSelector';

export interface SessionHeaderProps {
  title: string;
  agent: string;
  agentName?: string;
  projectName?: string;
  status: SessionStatus;
  modes: SessionMode[];
  modeId?: string;
  modeBusy?: boolean;
  onBack: () => void;
  onRename: () => void;
  onOpenModes: () => void;
  onMenu: () => void;
}

/** Clear session identity above a quiet status row; native and PWA safe-area rules stay shared. */
export function SessionHeader({
  title,
  agent,
  agentName,
  projectName,
  status,
  modes,
  modeId,
  modeBusy,
  onBack,
  onRename,
  onOpenModes,
  onMenu,
}: SessionHeaderProps) {
  const t = useTheme();
  const top = useSafeTop();
  return (
    <View style={{ backgroundColor: t.colors.bg, paddingTop: top + 10 }}>
      <View style={styles.container}>
        <View style={styles.row}>
          <IconButton name="arrow-back" label="Back to sessions" onPress={onBack} size={21} />
          <Tap
            onPress={onRename}
            accessibilityRole="button"
            accessibilityLabel={`${title || 'Untitled session'}. Rename`}
            style={{ flex: 1, minWidth: 0, gap: 3 }}
          >
            <T variant="caption" color="textFaint" numberOfLines={1}>
              {projectName || 'Workspace'} · {agentName || agent}
            </T>
            <T variant="heading" numberOfLines={1}>
              {title || 'Untitled session'}
            </T>
          </Tap>
          <IconButton name="ellipsis-horizontal" label="Session menu" onPress={onMenu} size={22} />
        </View>
        <View style={styles.meta}>
          <StatusChip status={status} />
          <View style={{ flex: 1 }} />
          {modes.length ? <ModeChip modes={modes} modeId={modeId} busy={modeBusy} onPress={onOpenModes} /> : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', maxWidth: 860, alignSelf: 'center', paddingHorizontal: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 54 },
  meta: { flexDirection: 'row', alignItems: 'center', paddingLeft: 12, gap: 8, paddingTop: 2, paddingBottom: 8, minHeight: 48 },
});
