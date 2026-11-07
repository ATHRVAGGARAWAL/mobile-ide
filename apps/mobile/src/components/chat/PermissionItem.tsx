import React from 'react';
import type { PermissionRequest, TimelineItem } from '@mobile-ide/core';
import { PermissionCard } from '../permissions';

type PermissionTimelineItem = Extract<TimelineItem, { kind: 'permission' }>;

export interface PermissionItemProps {
  request: PermissionRequest;
  resolved: PermissionTimelineItem['resolved'];
  sessionTitle?: string;
  onOpen: (request: PermissionRequest) => void;
}

/** Inline "needs your approval" card (M4's PermissionCard); tapping an unresolved one opens the PermissionSheet. */
export const PermissionItem = React.memo(function PermissionItem({ request, resolved, sessionTitle, onOpen }: PermissionItemProps) {
  return (
    <PermissionCard
      request={request}
      resolved={resolved}
      sessionTitle={sessionTitle}
      onPress={() => {
        if (!resolved) onOpen(request);
      }}
    />
  );
});
