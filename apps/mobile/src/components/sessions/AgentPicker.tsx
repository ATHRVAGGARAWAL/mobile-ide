import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentInfo } from '@mobile-ide/core';
import { useTheme } from '../../theme/ThemeProvider';
import { AgentBadge, ErrorView, LoadingView, T, Tap } from '../ui';

export type AgentAvailability =
  { kind: 'ready'; label: string } | { kind: 'on_demand'; label: string } | { kind: 'error'; label: string; detail: string };

/**
 * `available` is only true while the adapter process is ready/starting. A host that was never
 * spawned reports `reason: 'not started yet'` — it is still usable (the daemon spawns lazily),
 * so the picker must not block it. Only a failed initialize counts as a real problem.
 */
export function agentAvailability(info: AgentInfo): AgentAvailability {
  if (info.available) return { kind: 'ready', label: 'Ready' };
  const reason = (info.reason ?? '').trim();
  if (!reason || /not started/i.test(reason)) return { kind: 'on_demand', label: 'Starts on demand' };
  return { kind: 'error', label: 'Unavailable', detail: reason };
}

export function agentSelectable(info: AgentInfo): boolean {
  return agentAvailability(info).kind !== 'error';
}

export interface AgentPickerProps {
  agents: AgentInfo[] | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  value: string | null;
  onChange: (agentId: string) => void;
  disabled?: boolean;
}

/** Radio-style list of agents with a live availability line under each name. */
export function AgentPicker({ agents, loading, error, onRetry, value, onChange, disabled }: AgentPickerProps) {
  const t = useTheme();
  if (loading && !agents) return <LoadingView compact label="Checking which agents are ready…" />;
  if (error && !agents?.length) return <ErrorView compact title="Couldn't list agents" message={error} onRetry={onRetry} />;
  if (!agents?.length)
    return (
      <ErrorView
        compact
        title="No agents configured"
        message="Add at least one agent to the daemon config (claude, codex or opencode) and restart it."
        onRetry={onRetry}
      />
    );

  return (
    <View style={{ gap: 8 }}>
      {agents.map((a) => {
        const avail = agentAvailability(a);
        const selected = a.id === value;
        return (
          <React.Fragment key={a.id}>
            <Tap
              disabled={disabled}
              onPress={() => onChange(a.id)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled: !!disabled }}
              accessibilityLabel={`${a.name}, ${avail.label}${avail.kind === 'error' ? `: ${avail.detail}` : ''}`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 14,
                paddingVertical: 14,
                minHeight: 74,
                borderRadius: t.radius.lg,
                borderWidth: 1,
                borderColor: selected ? t.colors.accent : t.colors.border,
                backgroundColor: selected ? t.colors.accentSoft : t.colors.surface,
              }}
            >
              <AgentBadge agent={a.id} name={a.name} size="md" />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T variant="subheading" numberOfLines={1}>
                  {a.name}
                </T>
                <AvailabilityLine avail={avail} models={a.models?.length ?? 0} />
              </View>
              <Ionicons
                name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                size={22}
                color={selected ? t.colors.accent : t.colors.borderStrong}
              />
            </Tap>
          </React.Fragment>
        );
      })}
    </View>
  );
}

function AvailabilityLine({ avail, models }: { avail: AgentAvailability; models: number }) {
  const t = useTheme();
  const color = avail.kind === 'ready' ? t.colors.success : avail.kind === 'on_demand' ? t.colors.textFaint : t.colors.danger;
  return (
    <View style={{ marginTop: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
        <T variant="caption" style={{ color }}>
          {avail.label}
        </T>
        {models > 0 ? (
          <T variant="caption" color="textFaint">
            · {models} {models === 1 ? 'model' : 'models'}
          </T>
        ) : null}
      </View>
      {avail.kind === 'error' ? (
        <T variant="caption" color="textMuted" numberOfLines={2}>
          {avail.detail}
        </T>
      ) : null}
    </View>
  );
}
