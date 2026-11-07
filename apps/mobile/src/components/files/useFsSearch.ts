/** Debounced ripgrep search against /api/fs/search with stale-result protection. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchMatch } from '@mobile-ide/core';
import { api, errorMessage } from '../../state/api';

export interface FsSearchOptions {
  minLength?: number;
  debounceMs?: number;
  limit?: number;
}

export interface FsSearchState {
  /** null until the first completed search (kept across re-searches so the list doesn't flash) */
  results: SearchMatch[] | null;
  loading: boolean;
  error: string | null;
  /** the query the current results/error belong to */
  forQuery: string;
  limit: number;
  /** re-run the current query */
  retry: () => void;
  /** run immediately, skipping the debounce (keyboard "search" key) */
  searchNow: () => void;
}

export function useFsSearch(root: string | null, query: string, opts: FsSearchOptions = {}): FsSearchState {
  const minLength = opts.minLength ?? 2;
  const debounceMs = opts.debounceMs ?? 300;
  const limit = opts.limit ?? 200;
  const trimmed = query.trim();

  const [results, setResults] = useState<SearchMatch[] | null>(null);
  const [forQuery, setForQuery] = useState('');
  const [forRoot, setForRoot] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  const skipDebounce = useRef(false);

  useEffect(() => {
    const my = ++seq.current;
    if (!root || trimmed.length < minLength) {
      setResults(null);
      setError(null);
      setLoading(false);
      setForQuery(trimmed);
      setForRoot(root);
      return;
    }
    setLoading(true);
    const delay = skipDebounce.current ? 0 : debounceMs;
    skipDebounce.current = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const out = await api.fsSearch(root, trimmed, limit);
          if (my !== seq.current) return;
          setResults(out);
          setError(null);
        } catch (err) {
          if (my !== seq.current) return;
          setError(errorMessage(err));
        } finally {
          if (my === seq.current) {
            setForQuery(trimmed);
            setForRoot(root);
            setLoading(false);
          }
        }
      })();
    }, delay);
    return () => clearTimeout(timer);
  }, [root, trimmed, minLength, debounceMs, limit, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  const searchNow = useCallback(() => {
    skipDebounce.current = true;
    setNonce((n) => n + 1);
  }, []);

  // A project switch must never show hits from the project we just left.
  const belongs = forRoot === root;
  return {
    results: belongs ? results : null,
    loading: loading || (!!root && trimmed.length >= minLength && !belongs),
    error: belongs ? error : null,
    forQuery,
    limit,
    retry,
    searchNow,
  };
}
