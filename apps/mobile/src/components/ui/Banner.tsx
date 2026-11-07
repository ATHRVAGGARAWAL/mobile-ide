import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from './Text';
import { Tap } from './Tap';

export interface BannerProps {
  tone: 'info' | 'warning' | 'danger' | 'success' | 'neutral';
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  compact?: boolean;
}

/** Thin inline banner (connection loss, offline queue, unauthorized). Never a modal. */
export function Banner({ tone, message, actionLabel, onAction, icon, compact }: BannerProps) {
  const t = useTheme();
  const c = t.colors;
  const pal = {
    info: { bg: c.surfaceAlt, fg: c.textMuted },
    warning: { bg: c.accentSoft, fg: c.accent },
    danger: { bg: c.dangerSoft, fg: c.danger },
    success: { bg: c.surfaceAlt, fg: c.text },
    neutral: { bg: c.surfaceAlt, fg: c.textMuted },
  }[tone];
  const iconName =
    icon ??
    ({ info: 'information-circle', warning: 'warning', danger: 'alert-circle', success: 'checkmark-circle', neutral: 'ellipse' } as const)[
      tone
    ];
  return (
    <View style={[styles.row, { backgroundColor: pal.bg, paddingVertical: compact ? 5 : 9, paddingHorizontal: 14 }]}>
      <Ionicons name={iconName} size={15} color={pal.fg} style={{ marginRight: 8 }} />
      <T variant="bodySmall" style={{ color: pal.fg, flex: 1 }} numberOfLines={2}>
        {message}
      </T>
      {actionLabel && onAction ? (
        <Tap
          onPress={onAction}
          pressedColor={null}
          style={{ paddingHorizontal: 8, minHeight: 44, justifyContent: 'center' }}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
        >
          <T variant="bodySmall" weight="700" style={{ color: pal.fg }}>
            {actionLabel}
          </T>
        </Tap>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center' } });
