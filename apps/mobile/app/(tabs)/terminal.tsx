/**
 * Terminal tab: xterm.js (DOM component) over /ws/terminal for the selected project. The tmux
 * session id is stable per project (persisted) so reconnects and app restarts resume the shell.
 * Native draws an accessory key row that writes through the component's imperative handle; on
 * web the DOM component keeps its own key row (it can preserve textarea focus, RN-web cannot).
 *
 * The project context and shell status stay explicit. A compact header gives the terminal more
 * room while the on-screen keyboard is open.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useIsFocused, useNavigation, useRouter } from 'expo-router';
import { API, wsUrl } from '@mobile-ide/core';
import TerminalView, { type CopySource, type TerminalHandle, type TerminalRenderer, type TerminalStatus } from '../../src/dom/TerminalView';
import { ProjectChip, ProjectPickerSheet, useEnsureProjects } from '../../src/components/changes';
import { KeyRow, TerminalMenu, TerminalStatusPill, useKeyboardInset } from '../../src/components/terminal';
import { TerminalPhotos } from '../../src/components/terminal/TerminalPhotos';
import {
  Banner,
  Button,
  EmptyState,
  ErrorView,
  IconButton,
  LoadingView,
  PageHeader,
  Screen,
  T,
  useToastAnchor,
} from '../../src/components/ui';
import { copyText } from '../../src/lib/clipboard';
import { api } from '../../src/state/api';
import { useProjects, useSelectedProject } from '../../src/state/projects';
import { isPaired, useSettings } from '../../src/state/settings';
import { toast } from '../../src/state/toast';
import { useTheme } from '../../src/theme/ThemeProvider';

const NATIVE_KEY_ROW = Platform.OS !== 'web';
/** Native accessory keys are 44 px high, with 12 px vertical padding. */
const KEY_ROW_CLEARANCE = 60;

function copyToastFor(source: CopySource): string {
  switch (source) {
    case 'selection':
      return 'Selection copied';
    case 'tmux':
      return 'Copied from tmux';
    case 'all':
      return 'All output copied';
    default:
      return 'Visible screen copied';
  }
}

export default function TerminalScreen() {
  const t = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

  useEnsureProjects();
  const serverUrl = useSettings((s) => s.serverUrl);
  const token = useSettings((s) => s.token);
  const paired = useSettings((s) => isPaired(s));
  const fontSize = useSettings((s) => s.terminalFontSize);

  const project = useSelectedProject();
  const root = project?.root ?? null;
  const projectsLoaded = useProjects((s) => s.loaded);
  const projectsLoading = useProjects((s) => s.loading);
  const projectsError = useProjects((s) => s.error);
  const projectCount = useProjects((s) => s.projects.length);
  const loadProjects = useProjects((s) => s.load);
  const terminalId = useProjects((s) => (root ? (s.terminalIds[root] ?? null) : null));
  const terminalIdFor = useProjects((s) => s.terminalIdFor);
  const resetTerminal = useProjects((s) => s.resetTerminal);
  useEffect(() => {
    // Mint (and persist) a stable id for this project the first time it is opened.
    if (root && !terminalId) terminalIdFor(root);
  }, [root, terminalId, terminalIdFor]);

  const url = useMemo(() => {
    if (!serverUrl || !root || !terminalId) return null;
    try {
      const u = new URL(wsUrl(serverUrl, API.wsTerminal));
      u.searchParams.set('id', terminalId);
      u.searchParams.set('cwd', root);
      return u.toString();
    } catch {
      return null;
    }
  }, [serverUrl, root, terminalId]);

  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [detail, setDetail] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [ctrl, setCtrl] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    setCtrl(false);
    setStatus('connecting');
    setDetail(null);
  }, [root, terminalId]);

  const handle = useRef<TerminalHandle | null>(null);
  const containerRef = useRef<View>(null);
  const keyboardInset = useKeyboardInset(containerRef);
  // Toasts ("Selection copied", "Clipboard is empty") float above the key row and the keyboard while this tab shows.
  const toastAnchor = useToastAnchor({ extraBottom: NATIVE_KEY_ROW ? KEY_ROW_CLEARANCE : 0, enabled: useIsFocused() });

  // Async so the DOM bridge can marshal them on native.
  const onStatus = useCallback(async (s: TerminalStatus, d?: string) => {
    setStatus(s);
    setDetail(d ?? null);
  }, []);
  const onCtrlArmedChange = useCallback(async (armed: boolean) => {
    setCtrl(armed);
  }, []);
  const onRenderer = useCallback(async (r: TerminalRenderer, reason?: string) => {
    if (r === 'dom' && reason) console.info('[terminal] WebGL renderer unavailable:', reason);
  }, []);
  // Native only: the WebView hands us the text, expo-clipboard does the copying.
  const onCopy = useCallback(async (text: string, source: CopySource) => {
    if (await copyText(text)) toast.success(copyToastFor(source));
    else toast.error('Could not copy');
  }, []);

  // Native: `handle.current` is a proxy whose methods exist only once the DOM side registered them.
  const call = useCallback(<K extends keyof TerminalHandle>(method: K, ...args: Parameters<TerminalHandle[K]>) => {
    const h = handle.current;
    const fn = h?.[method];
    if (typeof fn === 'function') (fn as (...a: unknown[]) => void).apply(h, args);
  }, []);
  const send = useCallback((seq: string) => call('send', seq), [call]);
  const focusTerminal = useCallback(() => call('focus'), [call]);
  const fitTerminal = useCallback(() => call('fit'), [call]);
  const clearTerminal = useCallback(() => call('clear'), [call]);
  const copySelection = useCallback(() => call('copy'), [call]);
  const copyAll = useCallback(() => call('copyAll'), [call]);
  const pasteClipboard = useCallback(async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (!text) {
        toast.info('Clipboard is empty');
        return;
      }
      call('paste', text);
    } catch (err) {
      console.warn('[terminal] clipboard read failed', err);
      toast.error('Could not read the clipboard');
    }
  }, [call]);
  const toggleCtrl = useCallback(() => {
    const next = !ctrl;
    setCtrl(next);
    call('setCtrlArmed', next);
  }, [ctrl, call]);

  const reconnect = useCallback(() => {
    setStatus('connecting');
    setDetail(null);
    setNonce((n) => n + 1);
  }, []);
  const newShell = useCallback(() => {
    if (!root) return;
    setCtrl(false);
    setStatus('connecting');
    setDetail(null);
    resetTerminal(root); // the effect above mints a fresh id → new url → remount
  }, [root, resetTerminal]);
  /** Kill the tmux session behind this tab (DELETE /api/terminals/:id), then open a fresh one in its place. */
  const closeShell = useCallback(async () => {
    if (!root || !terminalId) return;
    await api.killTerminal(terminalId);
    newShell();
    toast.success('Shell closed. A fresh one is starting.');
  }, [root, terminalId, newShell]);

  // Re-fit whenever our box changes (keyboard, rotation, tab bar); the DOM side also observes itself.
  const fitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLayout = useCallback(() => {
    if (fitTimer.current) clearTimeout(fitTimer.current);
    fitTimer.current = setTimeout(fitTerminal, 60);
  }, [fitTerminal]);
  useEffect(
    () => () => {
      if (fitTimer.current) clearTimeout(fitTimer.current);
    },
    [],
  );

  let body: React.ReactNode;
  if (!paired) {
    body = (
      <EmptyState
        icon="link-outline"
        title="Connect your computer"
        message="Pair this device to open a shell in your project."
        action={{ title: 'Pair device', onPress: () => router.push('/pair') }}
      />
    );
  } else if (!root) {
    if (projectsLoading && !projectsLoaded) body = <LoadingView label="Loading projects…" />;
    else if (projectsError && projectCount === 0) body = <ErrorView message={projectsError} onRetry={() => void loadProjects()} />;
    else if (projectCount === 0)
      body = (
        <EmptyState
          icon="folder-open-outline"
          title="No projects"
          message="Connect a project from your computer, then refresh to open its shell."
          action={{ title: 'Refresh', icon: 'refresh', onPress: () => void loadProjects() }}
        />
      );
    else
      body = (
        <EmptyState
          icon="terminal-outline"
          title="Choose a project"
          message="The shell starts in the project directory."
          action={{ title: 'Choose project', onPress: () => setPickerOpen(true) }}
        />
      );
  } else if (!url || !token) {
    body = <LoadingView label="Preparing shell…" />;
  } else {
    body = (
      <View style={{ flex: 1 }} onLayout={onLayout}>
        <View style={{ flex: 1, backgroundColor: t.colors.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.border }}>
          <TerminalView
            key={`${root}|${terminalId}`}
            ref={handle}
            wsUrl={url}
            token={token}
            theme={t.name}
            fontSize={fontSize}
            connectNonce={nonce}
            onStatus={onStatus}
            onCtrlArmedChange={onCtrlArmedChange}
            onRenderer={onRenderer}
            onCopy={NATIVE_KEY_ROW ? onCopy : undefined}
            showKeys={!NATIVE_KEY_ROW}
            showStatus={false}
            dom={{
              style: { flex: 1 },
              scrollEnabled: false,
              bounces: false,
              hideKeyboardAccessoryView: true,
              // key-row taps focus the terminal programmatically; iOS would otherwise keep the keyboard down
              keyboardDisplayRequiresUserAction: false,
              contentInsetAdjustmentBehavior: 'never',
            }}
          />
        </View>
        {status === 'closed' || status === 'unauthorized' ? (
          <View style={[styles.reconnectBar, { backgroundColor: t.colors.surface, borderTopColor: t.colors.border }]}>
            <T variant="bodySmall" color="textMuted" style={{ flex: 1 }} numberOfLines={2}>
              {status === 'unauthorized'
                ? 'Pair this device again to reconnect to your computer.'
                : detail
                  ? `Disconnected. ${detail}`
                  : 'Disconnected from the shell.'}
            </T>
            {status === 'unauthorized' ? (
              <Button title="Pair again" size="sm" variant="secondary" icon="link-outline" onPress={() => router.push('/pair')} />
            ) : (
              <Button title="Reconnect" size="sm" icon="refresh" onPress={reconnect} />
            )}
          </View>
        ) : null}
        {NATIVE_KEY_ROW ? (
          <KeyRow
            onKey={send}
            ctrlArmed={ctrl}
            onToggleCtrl={toggleCtrl}
            onCopy={copySelection}
            onPaste={() => void pasteClipboard()}
            onShowKeyboard={focusTerminal}
            bottomInset={keyboardInset}
            disabled={status !== 'open'}
          />
        ) : null}
      </View>
    );
  }

  return (
    <Screen edges={['top']}>
      <View
        ref={(node) => {
          containerRef.current = node;
          toastAnchor.ref.current = node;
        }}
        onLayout={toastAnchor.onLayout}
        style={[{ flex: 1 }, !NATIVE_KEY_ROW ? { paddingBottom: keyboardInset } : null]}
      >
        <View testID="terminal-header">
          {keyboardInset > 0 && root ? (
            <View style={{ paddingHorizontal: t.spacing.lg, paddingTop: 8, paddingBottom: 4, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <ProjectChip compact onPress={() => setPickerOpen(true)} />
                </View>
                <IconButton name="ellipsis-horizontal" label="Terminal options" onPress={() => setMenuOpen(true)} disabled={!url} />
              </View>
              <View style={styles.shellStatus}>
                <T variant="bodySmall" weight="600">
                  Terminal
                </T>
                {url ? <TerminalStatusPill status={status} detail={detail} onPress={reconnect} /> : null}
              </View>
            </View>
          ) : (
            <PageHeader
              title="Terminal"
              right={<IconButton name="ellipsis-horizontal" label="Terminal options" onPress={() => setMenuOpen(true)} disabled={!url} />}
            >
              {paired ? <ProjectChip onPress={() => setPickerOpen(true)} /> : null}
              {url ? (
                <View style={styles.shellStatus}>
                  <T variant="bodySmall" color="textMuted">
                    Project shell
                  </T>
                  <TerminalStatusPill status={status} detail={detail} onPress={reconnect} />
                </View>
              ) : null}
            </PageHeader>
          )}
        </View>
        {status === 'reconnecting' && url ? (
          <Banner
            tone="warning"
            compact
            message={detail ? `Connection lost. ${detail}` : 'Reconnecting to your shell…'}
            actionLabel="Retry"
            onAction={reconnect}
          />
        ) : null}
        {root && url && terminalId ? (
          <TerminalPhotos key={`${root}|${terminalId}`} root={root} connected={status === 'open'} onPaste={(text) => call('paste', text)} />
        ) : null}
        {body}
      </View>
      <TerminalMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        terminalId={terminalId}
        projectName={project?.name ?? null}
        onReconnect={reconnect}
        onClear={clearTerminal}
        onCopyAll={copyAll}
        onNewShell={newShell}
        onCloseShell={closeShell}
      />
      <ProjectPickerSheet visible={pickerOpen} onClose={() => setPickerOpen(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  shellStatus: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36, gap: 12 },
  reconnectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
