/** Icons, labels and tones for tool calls and turn results. Pure helpers, no React. */
import type React from 'react';
import type { Ionicons } from '@expo/vector-icons';
import type { ToolKind, ToolStatus } from '@mobile-ide/core';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

const TOOL_ICONS: Record<ToolKind, IconName> = {
  read: 'document-text-outline',
  edit: 'create-outline',
  delete: 'trash-outline',
  move: 'swap-horizontal-outline',
  search: 'search-outline',
  execute: 'terminal-outline',
  think: 'bulb-outline',
  fetch: 'globe-outline',
  switch_mode: 'options-outline',
  other: 'construct-outline',
};

const TOOL_KIND_LABEL: Record<ToolKind, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Run',
  think: 'Think',
  fetch: 'Fetch',
  switch_mode: 'Mode',
  other: 'Tool',
};

const TOOL_STATUS_LABEL: Record<ToolStatus, string> = {
  pending: 'Pending',
  in_progress: 'Running',
  completed: 'Done',
  failed: 'Failed',
};

export function toolIcon(kind: ToolKind): IconName {
  return TOOL_ICONS[kind] ?? 'construct-outline';
}

export function toolKindLabel(kind: ToolKind): string {
  return TOOL_KIND_LABEL[kind] ?? 'Tool';
}

export function toolStatusLabel(status: ToolStatus): string {
  return TOOL_STATUS_LABEL[status] ?? status;
}

export function stopReasonLabel(reason: string): string {
  switch (reason) {
    case 'end_turn':
      return 'Done';
    case 'cancelled':
      return 'Stopped';
    case 'max_tokens':
      return 'Token limit reached';
    case 'max_turn_requests':
      return 'Turn limit reached';
    case 'refusal':
      return 'Refused';
    case 'error':
      return 'Ended with an error';
    default:
      return reason;
  }
}

export function stopReasonTone(reason: string): 'neutral' | 'warning' | 'danger' {
  if (reason === 'cancelled' || reason === 'max_tokens' || reason === 'max_turn_requests') return 'warning';
  if (reason === 'error' || reason === 'refusal') return 'danger';
  return 'neutral';
}
