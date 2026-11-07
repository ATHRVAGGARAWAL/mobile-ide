/** Shell controls, readable display settings and explicit confirmation before stopping a shell. */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { TerminalRenderer } from '../../dom/TerminalView';
import { copyText } from '../../lib/clipboard';
import { errorMessage } from '../../state/api';
import { useSettings } from '../../state/settings';
import { toast } from '../../state/toast';
import { useTheme } from '../../theme/ThemeProvider';
import { Banner, Button, Divider, IconButton, ListRow, Sheet, T } from '../ui';

export const TERMINAL_FONT_MIN = 10;
export const TERMINAL_FONT_MAX = 22;
export const TERMINAL_FONT_DEFAULT = 13;
/** Default `terminal.tmuxPrefix` in the daemon config; shown as a hint only. */
export const DEFAULT_TMUX_PREFIX = 'mide';

export interface TerminalMenuProps {
  visible: boolean;
  onClose: () => void;
  terminalId: string | null;
  projectName: string | null;
  /** Retained for existing callers; renderer diagnostics stay out of the shell controls. */
  renderer?: TerminalRenderer | null;
  onReconnect: () => void;
  onClear: () => void;
  onCopyAll?: () => void;
  /** Detach and start another tmux session; the current one keeps running. */
  onNewShell: () => void;
  /** Kill the current tmux session and its processes, then start a fresh one. */
  onCloseShell: () => Promise<void>;
}

export function TerminalMenu({
  visible,
  onClose,
  terminalId,
  projectName,
  onReconnect,
  onClear,
  onCopyAll,
  onNewShell,
  onCloseShell,
}: TerminalMenuProps) {
  const t = useTheme();
  const fontSize = useSettings((s) => s.terminalFontSize);
  const setFontSize = useSettings((s) => s.setTerminalFontSize);
  const [confirmation, setConfirmation] = useState<'new' | 'close' | null>(null);
  const [closingShell, setClosingShell] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) {
      setConfirmation(null);
      setCloseError(null);
    }
  }, [visible]);

  const closeShell = async () => {
    setClosingShell(true);
    setCloseError(null);
    try {
      await onCloseShell();
      onClose();
    } catch (err) {
      setCloseError(`Could not close this shell. ${errorMessage(err)}`);
    } finally {
      setClosingShell(false);
    }
  };

  const attachCmd = terminalId ? `tmux attach -t ${DEFAULT_TMUX_PREFIX}-${terminalId}` : null;
  const step = (d: number) => setFontSize(Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, fontSize + d)));
  const dismissThen = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      dismissable={!closingShell}
      title={confirmation === 'new' ? 'Start a new shell?' : confirmation === 'close' ? 'Close this shell?' : 'Shell options'}
      subtitle={projectName ?? undefined}
      footer={
        confirmation ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button
              title="Cancel"
              variant="secondary"
              style={{ flex: 1 }}
              disabled={closingShell}
              onPress={() => {
                setConfirmation(null);
                setCloseError(null);
              }}
            />
            {confirmation === 'new' ? (
              <Button title="New shell" icon="add" style={{ flex: 1 }} onPress={() => dismissThen(onNewShell)} />
            ) : (
              <Button
                title="Close shell"
                variant="danger"
                icon="close-circle-outline"
                style={{ flex: 1 }}
                loading={closingShell}
                onPress={() => void closeShell()}
              />
            )}
          </View>
        ) : undefined
      }
    >
      {confirmation ? (
        <View style={{ gap: 16, paddingBottom: 8 }}>
          <T color="textMuted">
            {confirmation === 'new'
              ? 'Open a fresh shell in this project. Your current shell and its processes will keep running on your computer.'
              : 'This stops the shell and everything running in it. A fresh shell will open in this project.'}
          </T>
          {confirmation === 'new' && attachCmd ? (
            <View style={{ padding: 14, gap: 8, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceAlt }}>
              <T variant="caption" color="textMuted">
                To return to the current shell on your computer
              </T>
              <T variant="monoSmall" selectable>
                {attachCmd}
              </T>
            </View>
          ) : null}
          {closeError ? <Banner tone="danger" message={closeError} /> : null}
        </View>
      ) : (
        <View style={{ marginHorizontal: -t.spacing.lg }}>
          <ListRow
            title="Reconnect"
            subtitle="Rejoin this shell and continue where you left off"
            left={<Ionicons name="refresh" size={20} color={t.colors.textMuted} />}
            onPress={() => dismissThen(onReconnect)}
          />
          <Divider inset={t.spacing.lg} />
          <ListRow
            title="Clear screen"
            subtitle="Clear this view. Your shell history stays available."
            left={<Ionicons name="remove-circle-outline" size={20} color={t.colors.textMuted} />}
            onPress={() => dismissThen(onClear)}
          />
          {onCopyAll ? (
            <>
              <Divider inset={t.spacing.lg} />
              <ListRow
                title="Copy all output"
                subtitle="Copy the screen and earlier output"
                left={<Ionicons name="copy-outline" size={20} color={t.colors.textMuted} />}
                onPress={() => dismissThen(onCopyAll)}
              />
            </>
          ) : null}
          <Divider inset={t.spacing.lg} />
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.spacing.lg, paddingVertical: 16, gap: 12 }}>
            <Ionicons name="text-outline" size={20} color={t.colors.textMuted} />
            <View style={{ flex: 1, gap: 4 }}>
              <T weight="600">Text size</T>
              <T variant="bodySmall" color="textMuted">
                {fontSize} pt{fontSize === TERMINAL_FONT_DEFAULT ? ' · Default' : ''}
              </T>
            </View>
            <IconButton name="remove" label="Smaller text" filled disabled={fontSize <= TERMINAL_FONT_MIN} onPress={() => step(-1)} />
            <IconButton name="add" label="Larger text" filled disabled={fontSize >= TERMINAL_FONT_MAX} onPress={() => step(1)} />
          </View>
          <Divider inset={t.spacing.lg} />
          <ListRow
            title="New shell"
            subtitle="Start fresh and keep the current shell running"
            left={<Ionicons name="add-circle-outline" size={20} color={t.colors.textMuted} />}
            onPress={() => setConfirmation('new')}
            disabled={!terminalId}
          />
          <Divider inset={t.spacing.lg} />
          <ListRow
            title="Close shell"
            subtitle="Stop this shell and its running processes"
            left={<Ionicons name="close-circle-outline" size={20} color={t.colors.danger} />}
            onPress={() => setConfirmation('close')}
            disabled={!terminalId}
          />
          {attachCmd ? (
            <>
              <Divider inset={t.spacing.lg} />
              <ListRow
                title="Copy attach command"
                subtitle="Continue in the same shell on your computer"
                left={<Ionicons name="laptop-outline" size={20} color={t.colors.textMuted} />}
                onPress={async () => {
                  const ok = await copyText(attachCmd);
                  onClose();
                  if (ok) toast.success('Command copied. Run it on your computer to join this shell.');
                  else toast.error('Could not copy');
                }}
              />
            </>
          ) : null}
        </View>
      )}
    </Sheet>
  );
}
