import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from 'expo-router';
import type { LaptopActivity } from '@mobile-ide/core';
import { api, errorMessage } from './api';
import { useSettings } from './settings';

export function useLaptopActivity() {
  const [data, setData] = useState<LaptopActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const serverUrl = useSettings((s) => s.serverUrl);
  const token = useSettings((s) => s.token);
  const focused = useIsFocused();
  const generation = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const refresh = useCallback((): Promise<void> => {
    if (pending.current) return pending.current;
    const current = generation.current;
    const task = (async () => {
      try {
        const result = await api.activity();
        if (current === generation.current) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (current === generation.current) setError(errorMessage(err));
      }
    })();
    pending.current = task;
    void task.finally(() => {
      if (pending.current === task) pending.current = null;
    });
    return task;
  }, []);
  useEffect(() => {
    generation.current++;
    pending.current = null;
    setData(null);
    setError(null);
    return () => {
      generation.current++;
      pending.current = null;
    };
  }, [serverUrl, token]);
  useEffect(() => {
    if (!focused) return;
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh();
    }, 8000);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, [focused, refresh, serverUrl, token]);
  return { data, error, refresh };
}
