/**
 * Data for the Changes tab: git status + recent log for the selected root.
 * - first load shows a spinner, pull-to-refresh shows the RefreshControl
 * - silent refetches (no spinner) when the tab regains focus after a while, and shortly after an
 *   agent session on this project changes (so the tab reflects what the agent just edited)
 */
import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect, useIsFocused } from 'expo-router';
import type { GitLogEntry, GitStatus } from '@mobile-ide/core';
import { useAsync, type AsyncState } from '../../lib/useAsync';
import { api } from '../../state/api';
import { useSessions } from '../../state/sessions';

const LOG_LIMIT = 30;
const FOCUS_STALE_MS = 15_000;
const SESSION_DEBOUNCE_MS = 1_500;

export interface ChangesData {
  status: AsyncState<GitStatus>;
  log: AsyncState<GitLogEntry[]>;
  /** pull-to-refresh: shows refreshing state */
  refresh: () => Promise<void>;
  /** background refetch that keeps the current data on screen and never spins */
  silentRefresh: () => Promise<void>;
}

export function useChanges(root: string | null, enabled: boolean): ChangesData {
  const active = enabled && !!root;
  const rootRef = useRef(root);
  rootRef.current = root;
  const status = useAsync(() => api.gitStatus(root ?? ''), [root], { enabled: active });
  const log = useAsync(() => api.gitLog(root ?? '', LOG_LIMIT), [root], { enabled: active });

  const statusRef = useRef(status);
  statusRef.current = status;
  const logRef = useRef(log);
  logRef.current = log;
  const lastLoadedAt = useRef(0);
  useEffect(() => {
    if (status.data) lastLoadedAt.current = Date.now();
  }, [status.data]);

  const refresh = useCallback(async () => {
    if (!active) return;
    await Promise.all([statusRef.current.refresh(), logRef.current.refresh()]);
  }, [active]);

  const silentRefresh = useCallback(async () => {
    if (!active || !root) return;
    const results = await Promise.allSettled([api.gitStatus(root), api.gitLog(root, LOG_LIMIT)]);
    if (rootRef.current !== root) return;
    const [s, l] = results;
    if (s && s.status === 'fulfilled') statusRef.current.setData(s.value);
    if (l && l.status === 'fulfilled') logRef.current.setData(l.value);
    lastLoadedAt.current = Date.now();
  }, [active, root]);

  // Coming back to the tab after a while → quiet refetch.
  useFocusEffect(
    useCallback(() => {
      if (!active) return;
      if (statusRef.current.data && Date.now() - lastLoadedAt.current > FOCUS_STALE_MS) void silentRefresh();
    }, [active, silentRefresh]),
  );

  // Agent activity on this project → quiet refetch (debounced), only while the tab is visible.
  const focused = useIsFocused();
  const sessionKey = useSessions((s) =>
    root
      ? s.sessions
          .filter((x) => x.cwd === root || x.cwd.startsWith(root.endsWith('/') ? root : root + '/'))
          .map((x) => `${x.id}:${x.status}:${x.updatedAt}`)
          .join('|')
      : '',
  );
  const lastKey = useRef(sessionKey);
  useEffect(() => {
    if (sessionKey === lastKey.current) return;
    lastKey.current = sessionKey;
    if (!active || !focused) return;
    const timer = setTimeout(() => void silentRefresh(), SESSION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sessionKey, active, focused, silentRefresh]);

  return { status, log, refresh, silentRefresh };
}
