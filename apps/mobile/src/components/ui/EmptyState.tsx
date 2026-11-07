import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from './Text';
import { Button, type ButtonProps } from './Button';

export interface EmptyStateProps {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  message?: string;
  action?: Pick<ButtonProps, 'title' | 'onPress' | 'variant' | 'icon' | 'loading'>;
  compact?: boolean;
}

export function EmptyState({ icon, title, message, action, compact }: EmptyStateProps) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingVertical: compact ? 24 : 56 }}>
      <View
        style={{
          width: compact ? 48 : 64,
          height: compact ? 48 : 64,
          borderRadius: t.radius.lg,
          borderWidth: 1,
          borderColor: t.colors.border,
          backgroundColor: t.colors.surface,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 16,
        }}
      >
        <Ionicons name={icon} size={compact ? 22 : 28} color={t.colors.textMuted} />
      </View>
      <T variant="heading" align="center" accessibilityRole="header">
        {title}
      </T>
      {message ? (
        <T variant="bodySmall" color="textMuted" align="center" style={{ marginTop: 8, maxWidth: 320, lineHeight: 21 }}>
          {message}
        </T>
      ) : null}
      {action ? (
        <View style={{ marginTop: 18 }}>
          <Button size="md" variant="secondary" {...action} />
        </View>
      ) : null}
    </View>
  );
}
