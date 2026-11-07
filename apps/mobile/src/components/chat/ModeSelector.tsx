import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { SessionMode } from '@mobile-ide/core';
import { ListRow, Sheet, T, Tap } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';

export interface ModeChipProps {
  modes: SessionMode[];
  modeId?: string;
  busy?: boolean;
  onPress: () => void;
}

/** Header trigger showing the current mode; opens ModeSheet. */
export function ModeChip({ modes, modeId, busy, onPress }: ModeChipProps) {
  const t = useTheme();
  const current = modes.find((m) => m.id === modeId);
  const label = current?.name ?? modeId ?? 'Mode';
  return (
    <Tap
      onPress={onPress}
      disabled={busy}
      pressedColor={null}
      pressedStyle={{ opacity: 0.7 }}
      accessibilityRole="button"
      accessibilityLabel={`Mode: ${label}. Change mode`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minHeight: 44,
        paddingHorizontal: 10,
        borderRadius: t.radius.pill,
        backgroundColor: t.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.colors.borderStrong,
        maxWidth: 190,
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={t.colors.textMuted} style={{ transform: [{ scale: 0.7 }] }} />
      ) : (
        <Ionicons name="options-outline" size={14} color={t.colors.textMuted} />
      )}
      <T numberOfLines={1} style={{ color: t.colors.text, fontSize: 12, fontWeight: '600', flexShrink: 1 }}>
        {label}
      </T>
      <Ionicons name="chevron-down" size={12} color={t.colors.textFaint} />
    </Tap>
  );
}

export interface ModeSheetProps {
  visible: boolean;
  modes: SessionMode[];
  modeId?: string;
  busy?: boolean;
  onSelect: (modeId: string) => void;
  onClose: () => void;
}

/** Bottom sheet listing `availableModes`; selecting one calls set_mode. */
export function ModeSheet({ visible, modes, modeId, busy, onSelect, onClose }: ModeSheetProps) {
  const t = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} title="Mode" subtitle="How much the agent may do without asking">
      {modes.map((m) => {
        const selected = m.id === modeId;
        return (
          <ListRow
            key={m.id}
            title={m.name}
            subtitle={m.description}
            subtitleLines={3}
            disabled={busy}
            onPress={() => {
              if (!selected) onSelect(m.id);
              else onClose();
            }}
            style={{ paddingHorizontal: 0 }}
            right={
              <Ionicons
                name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                size={22}
                color={selected ? t.colors.accent : t.colors.textFaint}
              />
            }
          />
        );
      })}
      {!modes.length ? (
        <View style={{ paddingVertical: 16 }}>
          <T variant="bodySmall" color="textMuted">
            This agent does not expose modes.
          </T>
        </View>
      ) : null}
    </Sheet>
  );
}
