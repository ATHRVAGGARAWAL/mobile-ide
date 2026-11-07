import React, { useState } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { T, Tap } from '../ui';

export interface ChipOption {
  id: string;
  label: string;
  description?: string;
}

export interface ChipSelectProps {
  options: ChipOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  noneLabel?: string;
  /** Keep a long model list compact while retaining the selected option. */
  maxVisible?: number;
  disabled?: boolean;
}

export function ChipSelect({ options, value, onChange, noneLabel, maxVisible, disabled }: ChipSelectProps) {
  const t = useTheme();
  const c = t.colors;
  const selected = options.find((option) => option.id === value);
  const [expanded, setExpanded] = useState(false);
  const collapsible = maxVisible !== undefined && options.length > maxVisible;
  let shown = options;
  if (collapsible && !expanded) {
    shown = options.slice(0, maxVisible);
    if (selected && !shown.includes(selected)) shown = [...shown.slice(0, Math.max(0, maxVisible - 1)), selected];
  }
  const hidden = options.length - shown.length;
  const choice = (id: string | null, label: string) => (
    <Tap
      key={id ?? '__default'}
      onPress={() => onChange(id)}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: value === id, disabled: !!disabled }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 44,
        maxWidth: '100%',
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderWidth: 1,
        borderRadius: t.radius.md,
        borderColor: value === id ? c.accent : c.border,
        backgroundColor: value === id ? c.accentSoft : c.surfaceAlt,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {value === id ? <Ionicons name="checkmark" size={16} color={c.accent} /> : null}
      <T variant="bodySmall" weight={value === id ? '600' : '400'} color={value === id ? 'accent' : 'textMuted'} style={{ flexShrink: 1 }}>
        {label}
      </T>
    </Tap>
  );
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {noneLabel ? choice(null, noneLabel) : null}
        {shown.map((option) => choice(option.id, option.label))}
        {collapsible ? (
          <Tap
            onPress={() => setExpanded((open) => !open)}
            disabled={disabled}
            accessibilityRole="button"
            aria-expanded={expanded}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 10 }}
          >
            <T variant="bodySmall" color="accent">
              {expanded ? 'Show fewer' : `+${hidden} more`}
            </T>
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={15} color={c.accent} />
          </Tap>
        ) : null}
      </View>
      {selected?.description ? (
        <T variant="caption" color="textMuted">
          {selected.description}
        </T>
      ) : null}
    </View>
  );
}
