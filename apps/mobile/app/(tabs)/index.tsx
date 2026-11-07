import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { Ionicons } from '@expo/vector-icons';
import { Tabs, useFocusEffect, useIsFocused, useRouter } from 'expo-router';
import type { PermissionRequest, SessionSummary } from '@mobile-ide/core';
import { useShallow } from 'zustand/react/shallow';
import {
  NeedsYouSection,
  RenameSheet,
  SessionActionsSheet,
  SessionRow,
  SessionsHeader,
  countNeedsYou,
  filterSessions,
  SESSION_WORKFLOWS,
  type SessionFilter,
  flattenGroups,
  groupSessions,
  type SessionListRow,
} from '../../src/components/sessions';
import {
  Banner,
  ConnectionBanner,
  EmptyState,
  ErrorView,
  IconButton,
  LoadingView,
  Screen,
  SectionHeader,
  T,
  Tap,
  TextField,
  useToastAnchor,
} from '../../src/components/ui';
import { useNow } from '../../src/lib/useNow';
import { isUnread, useReadState } from '../../src/state/readState';
import { useSessions } from '../../src/state/sessions';
import { useSettings } from '../../src/state/settings';
import { useTheme } from '../../src/theme/ThemeProvider';
import { useLaptopActivity } from '../../src/state/laptopActivity';
import { LaptopActivitySection } from '../../src/components/sessions/LaptopActivitySection';

/** Delay between one Modal sheet closing and the next opening; iOS refuses to present during a dismissal. */
const SHEET_HANDOFF_MS = 280;

/**
 * The read markers are persisted and hydrate asynchronously; until they have, every session would flash
 * as unread. Rows show the dot only once the stored markers are in.
 */
function useReadStateReady(): boolean {
  const [ready, setReady] = useState(() => useReadState.persist.hasHydrated());
  useEffect(() => {
    if (ready) return;
    const unsubscribe = useReadState.persist.onFinishHydration(() => setReady(true));
    if (useReadState.persist.hasHydrated()) setReady(true);
    return unsubscribe;
  }, [ready]);
  return ready;
}

interface ActionsTarget {
  session: SessionSummary;
  confirmClose: boolean;
}

export default function SessionsScreen() {
  const router = useRouter();
  const t = useTheme();
  const now = useNow();
  const serverName = useSettings((s) => s.serverName);
  const sessions = useSessions((s) => s.sessions);
  const loaded = useSessions((s) => s.sessionsLoaded);
  const error = useSessions((s) => s.sessionsError);
  const pending = useSessions((s) => s.pending);
  const questions = useSessions(useShallow((s) => Object.values(s.timelines).flatMap((timeline) => timeline.pendingElicitations)));
  const refreshSessions = useSessions((s) => s.refreshSessions);
  const refreshPending = useSessions((s) => s.refreshPending);
  const renameSession = useSessions((s) => s.renameSession);
  const closeSession = useSessions((s) => s.closeSession);
  const lastSeen = useReadState((s) => s.lastSeen);
  const readReady = useReadStateReady();
  // Keep toasts above navigation while this tab is visible.
  const focused = useIsFocused();
  const toastAnchor = useToastAnchor({ enabled: focused });

  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [actions, setActions] = useState<ActionsTarget | null>(null);
  const [renameFor, setRenameFor] = useState<SessionSummary | null>(null);
  const laptop = useLaptopActivity();

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshSessions(), refreshPending(), laptop.refresh()]);
  }, [refreshSessions, refreshPending, laptop.refresh]);

  // Live updates arrive over the socket; refreshing on focus covers the REST-only/offline-return cases.
  useFocusEffect(
    useCallback(() => {
      void refreshAll();
    }, [refreshAll]),
  );

  const onPullRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshAll();
    } finally {
      setRefreshing(false);
    }
  }, [refreshAll]);

  const filtered = useMemo(() => filterSessions(sessions, query, filter), [sessions, query, filter]);
  const rows = useMemo(() => flattenGroups(groupSessions(filtered)), [filtered]);
  const visibleIds = useMemo(() => new Set(filtered.map((session) => session.id)), [filtered]);
  const needsYou = useMemo(() => countNeedsYou(sessions), [sessions]);

  const openSession = useCallback(
    (id: string, permissionId?: string) => {
      router.push({ pathname: '/session/[id]', params: permissionId ? { id, permission: permissionId } : { id } });
    },
    [router],
  );
  const openPermission = useCallback((p: PermissionRequest) => openSession(p.sessionId, p.permissionId), [openSession]);
  const openNewSession = useCallback(() => router.push('/new-session'), [router]);

  const startRename = useCallback((s: SessionSummary, afterSheet: boolean) => {
    if (afterSheet) setTimeout(() => setRenameFor(s), SHEET_HANDOFF_MS);
    else setRenameFor(s);
  }, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SessionListRow>) => {
      if (item.type === 'header') {
        return (
          <SectionHeader
            title={item.title}
            right={
              <T variant="caption" color="textFaint">
                {item.count}
              </T>
            }
          />
        );
      }
      const s = item.session;
      return (
        <SessionRow
          session={s}
          now={now}
          unread={readReady && isUnread(lastSeen, s.id, s.lastSeq)}
          first={item.first}
          last={item.last}
          onPress={() => openSession(s.id)}
          onLongPress={() => setActions({ session: s, confirmClose: false })}
          onRename={() => startRename(s, false)}
          onClose={() => setActions({ session: s, confirmClose: true })}
        />
      );
    },
    [now, lastSeen, readReady, openSession, startRename],
  );

  const listHeader = (
    <View>
      {!query && filter === 'all' ? (
        <LaptopActivitySection data={laptop.data} error={laptop.error} sessions={sessions} refresh={laptop.refresh} />
      ) : null}
      {error && sessions.length ? (
        <Banner
          tone="warning"
          message={`Couldn't refresh sessions: ${error}`}
          actionLabel="Retry"
          onAction={() => void refreshAll()}
          compact
        />
      ) : null}
      {filter === 'all' || filter === 'needs_you' ? (
        <NeedsYouSection
          pending={pending.filter((request) => visibleIds.has(request.sessionId))}
          questions={questions.filter((request) => visibleIds.has(request.sessionId))}
          sessions={filtered}
          onOpenPermission={openPermission}
          onOpenQuestion={(request) =>
            router.push({ pathname: '/session/[id]', params: { id: request.sessionId, elicitation: request.elicitationId } })
          }
          onOpenSession={(s) => openSession(s.id)}
        />
      ) : null}
      {!query && filter === 'all' ? (
        <View style={{ paddingTop: 4, paddingBottom: 12 }}>
          <SectionHeader title="Start with a workflow" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 10 }}>
            {SESSION_WORKFLOWS.map((workflow) => (
              <Tap
                key={workflow.id}
                onPress={() => router.push({ pathname: '/new-session', params: { prompt: workflow.prompt } })}
                accessibilityRole="button"
                accessibilityLabel={`Start ${workflow.title.toLowerCase()} workflow`}
                style={{
                  width: 148,
                  padding: 14,
                  gap: 7,
                  backgroundColor: t.colors.surface,
                  borderColor: t.colors.border,
                  borderWidth: 1,
                  borderRadius: t.radius.lg,
                }}
              >
                <Ionicons name={workflow.icon} size={20} color={t.colors.accent} />
                <T variant="subheading">{workflow.title}</T>
                <T variant="caption" color="textFaint">
                  {workflow.hint}
                </T>
              </Tap>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );

  let body: React.ReactNode;
  if (!loaded) {
    body = (
      <ScrollView>
        {listHeader}
        <LoadingView label="Loading sessions…" />
      </ScrollView>
    );
  } else if (error && !sessions.length) {
    body = (
      <ScrollView>
        {listHeader}
        <ErrorView title="Couldn't load sessions" message={error} onRetry={() => void refreshAll()} />
      </ScrollView>
    );
  } else {
    body = (
      <FlashList
        data={rows}
        keyExtractor={(r) => r.key}
        getItemType={(row) => row.type}
        renderItem={renderItem}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          sessions.length ? (
            <EmptyState
              icon="search-outline"
              title="No matching sessions"
              message="Try a different name, project, or filter."
              action={{
                title: 'Clear filters',
                onPress: () => {
                  setQuery('');
                  setFilter('all');
                },
              }}
            />
          ) : (
            <EmptyState
              icon="chatbubbles-outline"
              title="Make room for your next idea"
              message="Start a session with your coding agent. Follow its progress and pick up wherever you leave off."
              action={{ title: 'New session', icon: 'add', onPress: openNewSession }}
            />
          )
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onPullRefresh()}
            tintColor={t.colors.accent}
            colors={[t.colors.accent]}
            progressBackgroundColor={t.colors.surface}
          />
        }
        contentContainerStyle={{ paddingBottom: 28 }}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
      />
    );
  }

  return (
    <Screen edges={['top']}>
      <Tabs.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, width: '100%', maxWidth: 820, alignSelf: 'center' }} ref={toastAnchor.ref} onLayout={toastAnchor.onLayout}>
        <SessionsHeader
          serverName={serverName}
          needsYou={needsYou}
          onNew={openNewSession}
          onRefresh={() => void onPullRefresh()}
          refreshing={refreshing}
        />
        <ConnectionBanner />
        {sessions.length ? (
          <View style={{ paddingHorizontal: 20, gap: 10, paddingBottom: 12 }}>
            <TextField
              value={query}
              onChangeText={setQuery}
              placeholder="Find a session or project"
              accessibilityLabel="Search sessions"
              right={
                query ? (
                  <IconButton name="close-circle" label="Clear search" onPress={() => setQuery('')} size={18} />
                ) : (
                  <Ionicons name="search-outline" size={18} color={t.colors.textFaint} />
                )
              }
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 6 }}
              keyboardShouldPersistTaps="handled"
            >
              {(
                [
                  { id: 'all', label: 'All', count: sessions.length },
                  {
                    id: 'running',
                    label: 'Working',
                    count: sessions.filter((s) => s.status === 'running' || s.status === 'starting').length,
                  },
                  { id: 'needs_you', label: 'Needs you', count: needsYou },
                  { id: 'idle', label: 'Ready', count: sessions.filter((s) => s.status === 'idle' || s.status === 'error').length },
                ] as const
              ).map((item) => (
                <Tap
                  key={item.id}
                  onPress={() => setFilter(item.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: filter === item.id }}
                  style={{
                    minHeight: 44,
                    paddingHorizontal: 12,
                    borderRadius: t.radius.md,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 7,
                    backgroundColor: filter === item.id ? t.colors.text : t.colors.surfaceAlt,
                  }}
                >
                  <T variant="bodySmall" weight="600" color={filter === item.id ? 'bg' : 'textMuted'}>
                    {item.label}
                  </T>
                  <T variant="caption" color={filter === item.id ? 'bg' : 'textFaint'}>
                    {item.count}
                  </T>
                </Tap>
              ))}
            </ScrollView>
          </View>
        ) : null}
        {body}
      </View>
      <SessionActionsSheet
        session={actions?.session ?? null}
        confirmClose={actions?.confirmClose ?? false}
        onClose={() => setActions(null)}
        onOpen={(s) => {
          setActions(null);
          openSession(s.id);
        }}
        onRename={(s) => {
          setActions(null);
          startRename(s, true);
        }}
        onCloseSession={(s) => closeSession(s.id)}
      />
      <RenameSheet session={renameFor} onClose={() => setRenameFor(null)} onSubmit={renameSession} />
    </Screen>
  );
}
