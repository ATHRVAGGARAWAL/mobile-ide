import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { SessionSummary } from '@mobile-ide/core';
import { copyText } from '../../lib/clipboard';
import { relativeTime } from '../../lib/format';
import { errorMessage } from '../../state/api';
import { toast } from '../../state/toast';
import { useTheme } from '../../theme/ThemeProvider';
import { AgentBadge, Button, Card, Divider, ListRow, Sheet, StatusChip, T } from '../ui';

export interface SessionActionsSheetProps {
  /** the session the sheet is about; null hides the sheet */
  session: SessionSummary | null;
  /** open straight on the close confirmation (used by the swipe "Close" action) */
  confirmClose?: boolean;
  onClose: () => void;
  onOpen: (session: SessionSummary) => void;
  onRename: (session: SessionSummary) => void;
  /** resolves when the server confirmed the close; rejects with a human message */
  onCloseSession: (session: SessionSummary) => Promise<void>;
}

/**
 * Long-press menu for a session row. Closing is a two-step action inside the sheet
 * (no native Alert: react-native-web has none) and reports its own inline state.
 */
export function SessionActionsSheet({ session, confirmClose = false, onClose, onOpen, onRename, onCloseSession }: SessionActionsSheetProps) {
  const t = useTheme();
  // Keep the last session while the sheet animates out so content doesn't vanish mid-transition.
  const [shown, setShown] = useState<SessionSummary | null>(session);
  const [confirming, setConfirming] = useState(confirmClose);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session) {
      setShown(session);
      setConfirming(confirmClose);
      setClosing(false);
      setError(null);
    }
  }, [session, confirmClose]);

  const s = shown;
  if (!s) return null;
  const visible = session !== null;

  const doClose = async () => {
    setClosing(true);
    setError(null);
    try {
      await onCloseSession(s);
      toast.success(`Closed “${s.title || 'Untitled session'}”`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setClosing(false);
    }
  };

  const copyId = async () => {
    const ok = await copyText(s.id);
    // Close first: on iOS the sheet is its own window and would hide the toast behind it.
    onClose();
    if (ok) toast.success('Session ID copied');
    else toast.error("Couldn't copy the session ID");
  };

  return (
    <Sheet visible={visible} onClose={closing ? () => undefined : onClose} dismissable={!closing}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 12 }}>
        <AgentBadge agent={s.agent} name={s.agentName} size="lg" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="heading" numberOfLines={2}>
            {s.title || 'Untitled session'}
          </T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <StatusChip status={s.status} />
            <T variant="caption" color="textMuted">
              {s.agentName} · updated {relativeTime(s.updatedAt)}
            </T>
          </View>
        </View>
      </View>
      <T variant="monoSmall" color="textFaint" numberOfLines={2} selectable style={{ marginBottom: 8 }}>
        {s.cwd}
      </T>
      <Divider />

      {confirming ? (
        <Card tone="danger" style={{ marginTop: 12, gap: 12 }}>
          <T variant="subheading">Close this session?</T>
          <T variant="bodySmall" color="textMuted">
            {s.status === 'running'
              ? 'A turn is still running — closing stops the agent mid-task. The transcript stays on your laptop, but the session leaves this list.'
              : 'The agent process ends and the session leaves this list. The transcript stays on your laptop.'}
          </T>
          {error ? (
            <T variant="bodySmall" color="danger">
              {error}
            </T>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
            <Button title="Keep" variant="secondary" onPress={() => (confirmClose ? onClose() : setConfirming(false))} disabled={closing} />
            <Button title={error ? 'Try again' : 'Close session'} variant="danger" icon="close-circle-outline" onPress={() => void doClose()} loading={closing} />
          </View>
        </Card>
      ) : (
        <View style={{ marginTop: 4, marginHorizontal: -t.spacing.lg }}>
          <ListRow title="Open" left={<ActionIcon name="chatbubbles-outline" />} chevron onPress={() => onOpen(s)} />
          <ListRow title="Rename…" left={<ActionIcon name="pencil-outline" />} onPress={() => onRename(s)} />
          <ListRow title="Copy session ID" subtitle={s.id} left={<ActionIcon name="copy-outline" />} onPress={() => void copyId()} />
          <ListRow
            title="Close session"
            subtitle={s.status === 'running' ? 'Stops the running turn' : 'Ends the agent process'}
            left={<ActionIcon name="close-circle-outline" danger />}
            onPress={() => setConfirming(true)}
          />
        </View>
      )}
    </Sheet>
  );
}

function ActionIcon({ name, danger }: { name: React.ComponentProps<typeof Ionicons>['name']; danger?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: danger ? t.colors.dangerSoft : t.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={name} size={17} color={danger ? t.colors.danger : t.colors.text} />
    </View>
  );
}
