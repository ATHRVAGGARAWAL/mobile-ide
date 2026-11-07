import React from 'react';
import { View } from 'react-native';
import { Button, ConnectionDot, IconButton, T } from '../ui';

export interface SessionsHeaderProps {
  serverName: string | null;
  needsYou: number;
  onNew: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function SessionsHeader({ serverName, needsYou, onNew, onRefresh, refreshing }: SessionsHeaderProps) {
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 18, gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <ConnectionDot />
        <T variant="caption" color="textFaint" numberOfLines={1} style={{ flex: 1 }}>
          {serverName ?? 'Your workspace'}
        </T>
        {onRefresh ? (
          <IconButton name="refresh-outline" label="Refresh sessions" onPress={onRefresh} disabled={refreshing} size={18} />
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <T variant="display" style={{ fontSize: 32, lineHeight: 38, letterSpacing: -1 }} accessibilityRole="header">
            Sessions
          </T>
          <T variant="bodySmall" color="textMuted">
            {needsYou
              ? `${needsYou} ${needsYou === 1 ? 'session needs' : 'sessions need'} your input.`
              : 'Your agents. Your projects. In sync.'}
          </T>
        </View>
        <Button title="New" icon="add" onPress={onNew} accessibilityLabel="New session" />
      </View>
    </View>
  );
}
