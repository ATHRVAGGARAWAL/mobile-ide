import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from './Text';
import { EmptyState } from './EmptyState';

export function LoadingView({ label, compact }: { label?: string; compact?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', padding: compact ? 20 : 48, gap: 12 }}>
      <ActivityIndicator color={t.colors.accent} />
      {label ? (
        <T variant="bodySmall" color="textMuted">
          {label}
        </T>
      ) : null}
    </View>
  );
}

export function ErrorView({ message, onRetry, title = "Couldn't load", compact }: { message: string; onRetry?: () => void; title?: string; compact?: boolean }) {
  return (
    <EmptyState
      icon="cloud-offline-outline"
      title={title}
      message={message}
      compact={compact}
      action={onRetry ? { title: 'Retry', onPress: onRetry, icon: 'refresh' } : undefined}
    />
  );
}
