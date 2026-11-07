/**
 * Chat screen for one session: streaming timeline, permission cards/sheet, composer, header with
 * rename / mode / menu. Subscribes through the sessions store (retain/release), backfills over REST
 * when the socket is down, and marks the session read while focused.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import type { ContentBlock, ElicitationRequest, PermissionRequest, SessionStatus } from '@mobile-ide/core';
import {
  Composer,
  EmptyChat,
  KeyboardShift,
  ModeSheet,
  RenameSheet,
  SessionHeader,
  SessionMenu,
  TimelineList,
  WorkspaceShortcuts,
  useKeyboardVisible,
  useWebKeyboardInset,
  type ComposerHandle,
  type TimelineListHandle,
} from '../../src/components/chat';
import { ElicitationSheet } from '../../src/components/elicitation';
import { PermissionSheet } from '../../src/components/permissions';
import { Banner, Button, ConnectionBanner, EmptyState, LoadingView, Screen, T, useToastAnchor } from '../../src/components/ui';
import { useSafeInsets } from '../../src/lib/safeArea';
import { useAsync } from '../../src/lib/useAsync';
import { api, ApiError, errorMessage } from '../../src/state/api';
import { useConnection } from '../../src/state/connection';
import { selectOutboxCount, selectSession, selectTimeline, useSessions, type SendState } from '../../src/state/sessions';
import { toast } from '../../src/state/toast';
import { useTheme } from '../../src/theme/ThemeProvider';

type Params = { id?: string | string[]; permission?: string | string[]; permissionId?: string | string[]; elicitation?: string | string[] };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** How long to wait for the socket before backfilling history over REST. */
const BACKFILL_AFTER_MS = 1500;

/** Toasts float above the composer with room for the "jump to latest" pill that sits at the list's bottom edge. */
const JUMP_PILL_CLEARANCE = 34 + 12;

export default function SessionScreen() {
  const params = useLocalSearchParams<Params>();
  const id = first(params.id) ?? '';
  const permissionParam = first(params.permission) ?? first(params.permissionId);
  const elicitationParam = first(params.elicitation);
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeInsets();
  const focused = useIsFocused();

  const timeline = useSessions(selectTimeline(id));
  const summary = useSessions(selectSession(id));
  const replayDone = useSessions((s) => s.replayDone[id] === true);
  const subscribeError = useSessions((s) => s.subscribeError[id]);
  const promptError = useSessions((s) => s.promptError[id]);
  const queuedCount = useSessions(selectOutboxCount(id));
  const permissionSubmit = useSessions((s) => s.permissionSubmit);
  const elicitationSubmit = useSessions((s) => s.elicitationSubmit);
  const connState = useConnection((s) => s.state);
  const client = useConnection((s) => s.client);

  const listRef = useRef<TimelineListHandle>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const [notFound, setNotFound] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [restLoaded, setRestLoaded] = useState(false);
  const [sheetRequest, setSheetRequest] = useState<PermissionRequest | null>(null);
  const [sheetElicitation, setSheetElicitation] = useState<ElicitationRequest | null>(null);
  const openedElicitationRef = useRef<string | null>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const openedParamRef = useRef<string | null>(null);

  const webInset = useWebKeyboardInset();
  const keyboardVisible = useKeyboardVisible(webInset);
  // Toasts float above the composer (and the keyboard) instead of over the header.
  const toastAnchor = useToastAnchor({ extraBottom: JUMP_PILL_CLEARANCE });

  // Keep the timeline subscribed while this screen is mounted.
  useEffect(() => {
    if (!id) return;
    const store = useSessions.getState();
    store.retainSession(id);
    return () => {
      store.markSeen(id);
      store.releaseSession(id);
    };
  }, [id]);

  // connection.restart() (e.g. returning from the background) builds a new MideClient whose subscription map is
  // empty; re-register this session on the fresh socket so live events keep flowing without a remount.
  useEffect(() => {
    if (!id || !client) return;
    const store = useSessions.getState();
    store.retainSession(id);
    store.releaseSession(id);
  }, [id, client]);

  // Make sure we have the session summary (cold deep link, list not loaded yet).
  useEffect(() => {
    if (!id || summary) return;
    let cancelled = false;
    api
      .session(id)
      .then((s) => {
        if (!cancelled) useSessions.getState().upsertSession(s);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === 'not_found') setNotFound(true);
        else setSummaryError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, summary]);

  // Socket down? Pull history over REST so the transcript still shows.
  useEffect(() => {
    if (!id || replayDone) return;
    const timer = setTimeout(() => {
      if (useConnection.getState().state === 'open') return;
      void useSessions
        .getState()
        .backfill(id)
        .finally(() => setRestLoaded(true));
    }, BACKFILL_AFTER_MS);
    return () => clearTimeout(timer);
  }, [id, replayDone, connState]);

  // Read marker follows the newest seq while the screen is focused.
  const lastSeq = timeline?.lastSeq ?? -1;
  useEffect(() => {
    if (focused && id && lastSeq >= 0) useSessions.getState().markSeen(id);
  }, [focused, id, lastSeq]);

  // Open the permission sheet when arriving via "Needs you" / a notification (?permission=<id>). A stale link — the
  // request was answered meanwhile, from another device or by the daemon — says so and brings the card into view
  // instead of landing on the chat silently.
  const pendingPermissions = timeline?.pendingPermissions;
  useEffect(() => {
    if (!permissionParam || openedParamRef.current === permissionParam) return;
    const req =
      pendingPermissions?.find((p) => p.permissionId === permissionParam) ??
      useSessions.getState().pending.find((p) => p.permissionId === permissionParam);
    if (req) {
      openedParamRef.current = permissionParam;
      setSheetRequest(req);
      return;
    }
    const idx = timeline?.permissionIndex[permissionParam];
    const item = idx !== undefined ? timeline?.items[idx] : undefined;
    if (item && item.kind === 'permission' && item.resolved) {
      openedParamRef.current = permissionParam;
      toast.info('That request was already answered.');
      requestAnimationFrame(() => listRef.current?.scrollToItemId(item.id));
    }
  }, [permissionParam, pendingPermissions, timeline]);

  // Open the elicitation sheet when arriving via a notification or the inbox (?elicitation=<id>; the daemon's Click
  // URL carries the request id as ?permission=<id> for both kinds, so that name is honoured too). Same stale handling.
  const pendingElicitations = timeline?.pendingElicitations;
  useEffect(() => {
    const wanted = elicitationParam ?? permissionParam;
    if (!wanted || openedElicitationRef.current === wanted) return;
    const req = pendingElicitations?.find((e) => e.elicitationId === wanted);
    if (req) {
      openedElicitationRef.current = wanted;
      setSheetElicitation(req);
      return;
    }
    const idx = timeline?.elicitationIndex[wanted];
    const item = idx !== undefined ? timeline?.items[idx] : undefined;
    if (item && item.kind === 'elicitation' && item.resolved) {
      openedElicitationRef.current = wanted;
      toast.info('That question was already answered.');
      requestAnimationFrame(() => listRef.current?.scrollToItemId(item.id));
    }
  }, [elicitationParam, permissionParam, pendingElicitations, timeline]);

  // If someone else answered the question we are looking at, close the sheet and say so.
  useEffect(() => {
    if (!sheetElicitation || !timeline) return;
    const idx = timeline.elicitationIndex[sheetElicitation.elicitationId];
    const item = idx !== undefined ? timeline.items[idx] : undefined;
    const resolved = item && item.kind === 'elicitation' ? item.resolved : undefined;
    if (resolved && elicitationSubmit[sheetElicitation.elicitationId] === undefined) {
      setSheetElicitation(null);
      toast.info('That question was answered from another device.');
    }
  }, [timeline, sheetElicitation, elicitationSubmit]);

  // If someone else answered the request we are looking at, close the sheet and say so.
  useEffect(() => {
    if (!sheetRequest || !timeline) return;
    const idx = timeline.permissionIndex[sheetRequest.permissionId];
    const item = idx !== undefined ? timeline.items[idx] : undefined;
    const resolved = item && item.kind === 'permission' ? item.resolved : undefined;
    if (resolved && permissionSubmit[sheetRequest.permissionId] === undefined) {
      setSheetRequest(null);
      toast.info('That request was answered from another device.');
    }
  }, [timeline, sheetRequest, permissionSubmit]);

  const agent = summary?.agent ?? '';
  const agentName = summary?.agentName ?? (agent || 'the agent');
  const cwd = summary?.cwd ?? '';
  const title = timeline?.title || summary?.title || '';
  const status: SessionStatus = timeline?.status ?? summary?.status ?? 'starting';
  const modes = useMemo(
    () => (timeline?.availableModes.length ? timeline.availableModes : (summary?.availableModes ?? [])),
    [timeline?.availableModes, summary?.availableModes],
  );
  const modeId = timeline?.modeId ?? summary?.modeId;
  const items = timeline?.items ?? [];
  const commands = timeline?.commands ?? [];

  const agents = useAsync(() => api.agents(), [], { enabled: !!agent });
  const imagesSupported = agents.data?.find((a) => a.id === agent)?.supportsImages !== false;

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }, [router]);

  const handleSend = useCallback(
    async (blocks: ContentBlock[]): Promise<SendState> => {
      const result = await useSessions.getState().sendPrompt(id, blocks);
      if (result !== 'error') requestAnimationFrame(() => listRef.current?.scrollToEnd(true));
      if (result === 'queued') toast.info('Offline — your prompt will send when reconnected.');
      return result;
    },
    [id],
  );

  /** Workflow starters are editable drafts; only the composer's Send action starts a turn. */
  const handleSuggestion = useCallback((text: string) => composerRef.current?.insertDraft(text), []);

  const handleStop = useCallback(async () => {
    try {
      await useSessions.getState().cancelTurn(id);
    } catch (err) {
      toast.error(`Couldn't stop the agent: ${errorMessage(err)}`);
    }
  }, [id]);

  const dismissPromptError = useCallback(() => {
    useSessions.setState((s) => ({ promptError: { ...s.promptError, [id]: undefined } }));
  }, [id]);

  const handleSetMode = useCallback(
    async (nextModeId: string) => {
      setModeBusy(true);
      try {
        await useSessions.getState().setMode(id, nextModeId);
        setModeOpen(false);
      } catch (err) {
        toast.error(`Couldn't change mode: ${errorMessage(err)}`);
      } finally {
        setModeBusy(false);
      }
    },
    [id],
  );

  const handleRename = useCallback((next: string) => useSessions.getState().renameSession(id, next), [id]);

  const handleCloseSession = useCallback(async () => {
    await useSessions.getState().closeSession(id);
    setMenuOpen(false);
    toast.success('Session closed');
    goBack();
  }, [id, goBack]);

  const openPermission = useCallback((request: PermissionRequest) => setSheetRequest(request), []);
  const openElicitation = useCallback((request: ElicitationRequest) => setSheetElicitation(request), []);

  const socketOpen = connState === 'open';
  const gone = notFound || subscribeError?.code === 'not_found';
  const loadingHistory = !!timeline && items.length === 0 && !replayDone && !restLoaded && !gone;
  const composerBottom = keyboardVisible ? 6 : Math.max(insets.bottom, 8);

  let empty: React.ReactElement | null = null;
  if (gone) {
    empty = (
      <EmptyState
        icon="help-circle-outline"
        title="Session not found"
        message="It may have been closed or the daemon was reset."
        action={{ title: 'Back to sessions', onPress: goBack, icon: 'arrow-back' }}
      />
    );
  } else if (subscribeError && items.length === 0) {
    // the daemon refused the subscription (DB error, transient failure): say so instead of spinning forever
    empty = (
      <EmptyState
        icon="cloud-offline-outline"
        title="Couldn't load the conversation"
        message={subscribeError.message}
        action={{ title: 'Retry', icon: 'refresh', onPress: () => useSessions.getState().retrySubscribe(id) }}
      />
    );
  } else if (loadingHistory) {
    empty = <LoadingView label={socketOpen ? 'Loading conversation…' : 'Waiting for the connection…'} />;
  } else if (!timeline) {
    empty = <LoadingView />;
  } else if (items.length === 0) {
    empty =
      status === 'starting' ? (
        <LoadingView label={`Starting ${agentName}… this can take a few seconds.`} />
      ) : (
        <EmptyChat
          agentName={agentName}
          projectName={summary?.projectName}
          canDraft={status !== 'closed'}
          offline={!socketOpen}
          onDraft={handleSuggestion}
        />
      );
  }

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false, title: title || 'Session' }} />
      <KeyboardShift webInset={webInset}>
        <SessionHeader
          title={title}
          agent={agent || 'agent'}
          agentName={summary?.agentName}
          projectName={summary?.projectName}
          status={status}
          modes={modes}
          modeId={modeId}
          modeBusy={modeBusy}
          onBack={goBack}
          onRename={() => setRenameOpen(true)}
          onOpenModes={() => setModeOpen(true)}
          onMenu={() => setMenuOpen(true)}
        />
        <WorkspaceShortcuts cwd={cwd} />
        <ConnectionBanner />
        {summaryError && !summary ? <Banner tone="warning" message={`Couldn't load session details: ${summaryError}`} compact /> : null}
        {status === 'starting' && items.length > 0 ? <Banner tone="info" message={`Starting ${agentName}…`} compact /> : null}

        <View style={{ flex: 1 }} ref={toastAnchor.ref} onLayout={toastAnchor.onLayout}>
          <TimelineList
            ref={listRef}
            items={items}
            cwd={cwd}
            agent={agent || 'agent'}
            agentName={agentName}
            onOpenPermission={openPermission}
            onOpenElicitation={openElicitation}
            ListEmptyComponent={empty}
          />
        </View>

        {status === 'closed' ? (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: t.colors.border,
              backgroundColor: t.colors.bgElevated,
              padding: 14,
              paddingBottom: composerBottom + 6,
              gap: 10,
            }}
          >
            <T variant="bodySmall" color="textMuted" align="center">
              This session is closed. Start a new one to keep working in {summary?.projectName ?? 'this project'}.
            </T>
            <Button title="New session" icon="add" onPress={() => router.push({ pathname: '/new-session', params: { cwd, agent } })} full />
          </View>
        ) : (
          <Composer
            ref={composerRef}
            key={id}
            sessionId={id}
            cwd={cwd}
            status={status}
            agentName={agentName}
            commands={commands}
            imagesSupported={imagesSupported}
            queuedCount={queuedCount}
            promptError={promptError}
            onSend={handleSend}
            onStop={handleStop}
            onDismissError={dismissPromptError}
            bottomInset={composerBottom}
          />
        )}
      </KeyboardShift>

      <ModeSheet
        visible={modeOpen}
        modes={modes}
        modeId={modeId}
        busy={modeBusy}
        onSelect={handleSetMode}
        onClose={() => setModeOpen(false)}
      />
      <RenameSheet visible={renameOpen} title={title} onClose={() => setRenameOpen(false)} onSave={handleRename} />
      <SessionMenu
        visible={menuOpen}
        sessionId={id}
        cwd={cwd}
        projectName={summary?.projectName}
        onClose={() => setMenuOpen(false)}
        onRename={() => setRenameOpen(true)}
        onCloseSession={handleCloseSession}
      />
      <PermissionSheet request={sheetRequest} onClose={() => setSheetRequest(null)} />
      <ElicitationSheet request={sheetElicitation} onClose={() => setSheetElicitation(null)} />
    </Screen>
  );
}
