import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Spinner, T, Tap } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';
import { basename, dirname } from '../../lib/format';
import { api, errorMessage } from '../../state/api';
import { relativeToRoot } from './files';
import { SuggestionPanel } from './SlashSuggestions';

export interface MentionCandidate {
  /** root-relative path */
  path: string;
  isDir: boolean;
}

export interface MentionState {
  query: string;
  results: MentionCandidate[];
  loading: boolean;
  error: string | null;
}

const IDLE: MentionState = { query: '', results: [], loading: false, error: null };
const MAX_RESULTS = 14;
const DEBOUNCE_MS = 220;

function rank(candidates: MentionCandidate[], q: string): MentionCandidate[] {
  const ql = q.toLowerCase();
  const seen = new Set<string>();
  const uniq: MentionCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.isDir ? 'd' : 'f'}:${c.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }
  const score = (c: MentionCandidate) => {
    const b = basename(c.path).toLowerCase();
    if (b === ql) return 0;
    if (b.startsWith(ql)) return 1;
    if (b.includes(ql)) return 2;
    if (c.path.toLowerCase().includes(ql)) return 3;
    return 4;
  };
  return uniq.sort((a, b) => score(a) - score(b) || a.path.length - b.path.length).slice(0, MAX_RESULTS);
}

/**
 * Debounced file lookup for `@` mentions: completes the directory being typed via the tree endpoint
 * and adds files whose contents match via ripgrep search. `query === null` means the panel is closed.
 */
export function useFileMentions(root: string, query: string | null): MentionState {
  const [state, setState] = useState<MentionState>(IDLE);
  useEffect(() => {
    if (query === null) return;
    const q = query.trim();
    if (!q) {
      setState(IDLE);
      return;
    }
    if (!root) {
      setState({ query: q, results: [], loading: false, error: 'This session has no project folder to search.' });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, query: q, loading: true, error: null }));
    const timer = setTimeout(async () => {
      const slash = q.lastIndexOf('/');
      const dirPart = slash >= 0 ? q.slice(0, slash) : '';
      const namePart = (slash >= 0 ? q.slice(slash + 1) : q).toLowerCase();
      const [tree, search] = await Promise.allSettled([
        api.fsTree(root, dirPart),
        namePart.length >= 2 ? api.fsSearch(root, namePart, 200) : Promise.resolve([]),
      ]);
      if (cancelled) return;
      const fromTree: MentionCandidate[] =
        tree.status === 'fulfilled'
          ? tree.value
              .filter((e) => !namePart || e.name.toLowerCase().includes(namePart))
              .map((e) => ({ path: relativeToRoot(root, e.path), isDir: e.kind === 'dir' }))
          : [];
      const fromSearch: MentionCandidate[] = search.status === 'fulfilled' ? search.value.map((m) => ({ path: relativeToRoot(root, m.path), isDir: false })) : [];
      const results = rank([...fromTree, ...fromSearch], namePart || q);
      const error = !results.length && tree.status === 'rejected' && search.status === 'rejected' ? errorMessage(tree.reason) : null;
      setState({ query: q, results, loading: false, error });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [root, query]);
  return query === null ? IDLE : state;
}

export interface MentionSuggestionsProps {
  state: MentionState;
  onSelect: (candidate: MentionCandidate) => void;
}

export function MentionSuggestions({ state, onSelect }: MentionSuggestionsProps) {
  const t = useTheme();
  const { query, results, loading, error } = state;
  return (
    <SuggestionPanel>
      {!query ? (
        <T variant="caption" color="textMuted" style={styles.note}>
          Type to attach a file: matches file names and contents in this project.
        </T>
      ) : null}
      {results.map((c) => (
        <Tap
          key={`${c.isDir ? 'd' : 'f'}:${c.path}`}
          onPress={() => onSelect(c)}
          accessibilityRole="button"
          accessibilityLabel={`${c.isDir ? 'Folder' : 'File'} ${c.path}`}
          style={[styles.row, { borderBottomColor: t.colors.border }]}
        >
          <Ionicons name={c.isDir ? 'folder-open-outline' : 'document-text-outline'} size={16} color={c.isDir ? t.colors.warning : t.colors.textMuted} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="mono" numberOfLines={1}>
              {basename(c.path)}
              {c.isDir ? '/' : ''}
            </T>
            {dirname(c.path) ? (
              <T variant="caption" color="textFaint" numberOfLines={1}>
                {dirname(c.path)}
              </T>
            ) : null}
          </View>
        </Tap>
      ))}
      {loading ? (
        <View style={[styles.note, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
          <Spinner />
          <T variant="caption" color="textMuted">
            Searching…
          </T>
        </View>
      ) : null}
      {!loading && query && !results.length ? (
        <T variant="caption" color={error ? 'danger' : 'textMuted'} style={styles.note}>
          {error ?? `No files match “${query}”.`}
        </T>
      ) : null}
    </SuggestionPanel>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth },
  note: { paddingHorizontal: 14, paddingVertical: 10 },
});
