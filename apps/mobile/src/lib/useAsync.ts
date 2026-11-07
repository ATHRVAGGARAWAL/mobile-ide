import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../state/api';

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
  setData: (d: T | undefined) => void;
}

interface Snapshot<T> {
  key: object;
  data: T | undefined;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

/** Keep good data during refresh, while isolating requests for a different project or file. */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[], opts: { enabled?: boolean } = {}): AsyncState<T> {
  const enabled = opts.enabled ?? true;
  // Identity changes during render, before effects: stale data never flashes under the new title.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const key = useMemo(() => ({}), deps);
  const keyRef = useRef(key);
  keyRef.current = key;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({ key, data: undefined, loading: enabled, refreshing: false, error: null });

  const run = useCallback(async (mode: 'load' | 'refresh') => {
    const my = ++seq.current;
    const requestKey = keyRef.current;
    setSnapshot((previous) => ({
      key: requestKey,
      data: previous.key === requestKey ? previous.data : undefined,
      error: previous.key === requestKey ? previous.error : null,
      loading: mode === 'load',
      refreshing: mode === 'refresh',
    }));
    try {
      const data = await fnRef.current();
      if (my !== seq.current || keyRef.current !== requestKey) return;
      setSnapshot({ key: requestKey, data, loading: false, refreshing: false, error: null });
    } catch (err) {
      if (my !== seq.current || keyRef.current !== requestKey) return;
      setSnapshot((previous) => ({ ...previous, error: errorMessage(err), loading: false, refreshing: false }));
    }
  }, []);

  useEffect(() => {
    if (enabled) void run('load');
    return () => {
      seq.current++;
    };
  }, [enabled, key, run]);

  const setData = useCallback((data: T | undefined) => {
    const currentKey = keyRef.current;
    setSnapshot({ key: currentKey, data, loading: false, refreshing: false, error: null });
  }, []);
  const current = snapshot.key === key;
  return {
    data: current ? snapshot.data : undefined,
    loading: enabled && (current ? snapshot.loading : true),
    refreshing: enabled && current && snapshot.refreshing,
    error: current ? snapshot.error : null,
    reload: () => run('load'),
    refresh: () => run('refresh'),
    setData,
  };
}
