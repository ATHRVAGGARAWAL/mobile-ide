import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button, Divider, ListRow, Sheet, T } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';
import { copyText } from '../../lib/clipboard';
import { api, errorMessage } from '../../state/api';
import { toast } from '../../state/toast';
import { PathText } from '../files/PathText';
import { openProjectTab } from './files';

export interface SessionMenuProps {
  visible: boolean;
  sessionId: string;
  cwd: string;
  projectName?: string;
  onClose: () => void;
  onRename: () => void;
  onCloseSession: () => Promise<void>;
}

/** Lets the sheet finish its dismiss animation before navigating or opening another sheet. */
const AFTER_DISMISS_MS = 240;

export function SessionMenu({ visible, sessionId, cwd, projectName, onClose, onRename, onCloseSession }: SessionMenuProps) {
  const t = useTheme();
  const [confirm, setConfirm] = useState(false);
  const [closing, setClosing] = useState(false);
  const [openingStudio, setOpeningStudio] = useState(false);

  useEffect(() => {
    if (!visible) setConfirm(false);
  }, [visible]);

  const go = (tab: 'files' | 'changes' | 'terminal') => {
    onClose();
    setTimeout(() => openProjectTab(cwd, tab), AFTER_DISMISS_MS);
  };

  const rename = () => {
    onClose();
    setTimeout(onRename, AFTER_DISMISS_MS);
  };

  /** POST /api/studio/open: the daemon pops the live editor on its own screen (or the open window follows this session). */
  const openStudio = async () => {
    if (openingStudio) return;
    setOpeningStudio(true);
    try {
      const res = await api.studioOpen(sessionId);
      if (res.opened) toast.success(`Studio opened on your computer${res.browser ? ` (${res.browser})` : ''}`);
      else if (res.connected) toast.info('The Studio window on your computer is following this session');
      else toast.error(res.reason ? `Studio didn't open: ${res.reason}` : "Studio didn't open");
      onClose();
    } catch (err) {
      toast.error(`Couldn't open the Studio: ${errorMessage(err)}`);
    } finally {
      setOpeningStudio(false);
    }
  };

  const copyId = async () => {
    if (await copyText(sessionId)) toast.success('Session ID copied');
    onClose();
  };

  const closeSession = async () => {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setClosing(true);
    try {
      await onCloseSession();
    } catch (err) {
      toast.error(`Couldn't close the session: ${errorMessage(err)}`);
      setClosing(false);
    }
  };

  const icon = (name: React.ComponentProps<typeof Ionicons>['name']) => <Ionicons name={name} size={20} color={t.colors.textMuted} />;
  const rowStyle = { paddingHorizontal: 0 } as const;

  return (
    <Sheet visible={visible} onClose={onClose} title="Session" subtitle={projectName || undefined}>
      {/* the path on its own mono line, middle-truncated, instead of wrapping mid-segment in the subtitle */}
      {cwd ? <PathText path={cwd} variant="monoSmall" color="textFaint" style={{ paddingBottom: 8 }} /> : null}
      <ListRow
        title="Files"
        subtitle="Browse this project"
        left={icon('folder-open-outline')}
        chevron
        onPress={() => go('files')}
        style={rowStyle}
        disabled={!cwd}
      />
      <ListRow
        title="Changes"
        subtitle="Git status and diffs"
        left={icon('git-compare-outline')}
        chevron
        onPress={() => go('changes')}
        style={rowStyle}
        disabled={!cwd}
      />
      <ListRow
        title="Terminal"
        subtitle="Shell in this folder"
        left={icon('terminal-outline')}
        chevron
        onPress={() => go('terminal')}
        style={rowStyle}
        disabled={!cwd}
      />
      <Divider />
      <ListRow
        title={openingStudio ? 'Opening Studio…' : 'Open in Studio'}
        subtitle="Live editor window on your computer"
        left={icon('desktop-outline')}
        onPress={() => void openStudio()}
        style={rowStyle}
        disabled={openingStudio}
      />
      <Divider />
      <ListRow title="Rename" left={icon('pencil-outline')} onPress={rename} style={rowStyle} />
      <ListRow title="Copy session ID" subtitle={sessionId} left={icon('copy-outline')} onPress={copyId} style={rowStyle} />
      <Divider />
      <View style={{ paddingVertical: 12, gap: 10 }}>
        {confirm ? (
          <T variant="bodySmall" color="textMuted">
            This stops the agent for this session. You won't be able to send more prompts here.
          </T>
        ) : null}
        <Button
          title={confirm ? 'Confirm close' : 'Close session'}
          variant={confirm ? 'danger' : 'dangerSoft'}
          icon="close-circle"
          onPress={closeSession}
          loading={closing}
          full
        />
      </View>
    </Sheet>
  );
}
