import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card, T } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';

export interface ErrorItemProps {
  message: string;
  fatal: boolean;
}

/** Inline error from the agent or the daemon; fatal ones mark the session as errored. */
export function ErrorItem({ message, fatal }: ErrorItemProps) {
  const t = useTheme();
  return (
    <Card tone="danger" style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <Ionicons name="alert-circle" size={18} color={t.colors.danger} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="subheading" color="danger">
          {fatal ? 'Session error' : 'Error'}
        </T>
        <T variant="bodySmall" selectable>
          {message}
        </T>
        {fatal ? (
          <T variant="caption" color="textMuted" style={{ marginTop: 2 }}>
            The agent stopped. Send another message to try again.
          </T>
        ) : null}
      </View>
    </Card>
  );
}
