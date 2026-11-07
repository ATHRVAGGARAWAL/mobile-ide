/** ripgrep results grouped by file with sticky file headers, the match highlighted, pull-to-refresh. */
import React, { useMemo } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { SearchMatch } from '@mobile-ide/core';
import { basename, dirname } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import { Chip } from '../ui/Chip';
import { Tap } from '../ui/Tap';
import { T } from '../ui/Text';
import { entryIcon } from './fileIcons';
import { PathText } from './PathText';
import { KEYBOARD_DISMISS_ON_DRAG } from '../../lib/platform';

type Row = { type: 'file'; key: string; path: string; count: number } | { type: 'match'; key: string; match: SearchMatch };

export interface SearchResultsProps {
  results: SearchMatch[];
  /** the query these results belong to (used to highlight the hit) */
  query: string;
  /** server-side cap that was requested; a footer explains when it was hit */
  limit: number;
  onOpenMatch: (match: SearchMatch) => void;
  onOpenFile: (path: string) => void;
  /** pull-to-refresh re-runs the search */
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function SearchResults({ results, query, limit, onOpenMatch, onOpenFile, refreshing = false, onRefresh }: SearchResultsProps) {
  const t = useTheme();
  const { rows, fileCount, stickyIndices } = useMemo(() => {
    const byPath = new Map<string, SearchMatch[]>();
    for (const m of results) {
      const arr = byPath.get(m.path);
      if (arr) arr.push(m);
      else byPath.set(m.path, [m]);
    }
    const out: Row[] = [];
    const sticky: number[] = [];
    for (const [path, matches] of byPath) {
      sticky.push(out.length);
      out.push({ type: 'file', key: `f:${path}`, path, count: matches.length });
      matches.forEach((m, i) => out.push({ type: 'match', key: `m:${path}:${m.line}:${m.column}:${i}`, match: m }));
    }
    return { rows: out, fileCount: byPath.size, stickyIndices: sticky };
  }, [results]);

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.key}
      stickyHeaderIndices={stickyIndices.map((index) => index + 1)}
      renderItem={({ item }) =>
        item.type === 'file' ? (
          <FileHeader path={item.path} count={item.count} onPress={() => onOpenFile(item.path)} />
        ) : (
          <MatchRow match={item.match} query={query} onPress={() => onOpenMatch(item.match)} />
        )
      }
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.colors.accent} /> : undefined}
      ListHeaderComponent={
        <T variant="caption" color="textFaint" style={{ paddingHorizontal: t.spacing.lg, paddingBottom: 6 }}>
          {results.length} {results.length === 1 ? 'match' : 'matches'} in {fileCount} {fileCount === 1 ? 'file' : 'files'}
          {refreshing ? ' · refreshing…' : ''}
        </T>
      }
      ListFooterComponent={
        results.length >= limit ? (
          <T variant="caption" color="textFaint" align="center" style={{ padding: 16 }}>
            Showing the first {limit} matches — refine your search to see more.
          </T>
        ) : (
          <View style={{ height: 24 }} />
        )
      }
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={KEYBOARD_DISMISS_ON_DRAG}
      initialNumToRender={30}
    />
  );
}

function FileHeader({ path, count, onPress }: { path: string; count: number; onPress: () => void }) {
  const t = useTheme();
  const icon = entryIcon({ name: basename(path), kind: 'file' });
  const dir = dirname(path);
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${path}`}
      style={[styles.fileHeader, { backgroundColor: t.colors.bg, borderBottomColor: t.colors.border, paddingHorizontal: t.spacing.lg }]}
    >
      <Ionicons name={icon.name} size={16} color={t.colors.textMuted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="bodySmall" weight="600" numberOfLines={1}>
          {basename(path)}
        </T>
        {dir ? <PathText path={dir + '/'} variant="monoSmall" color="textFaint" /> : null}
      </View>
      <Chip label={String(count)} />
    </Tap>
  );
}

function MatchRow({ match, query, onPress }: { match: SearchMatch; query: string; onPress: () => void }) {
  const t = useTheme();
  const { text, hit } = excerpt(match, query);
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Line ${match.line}: ${text}`}
      style={[styles.matchRow, { paddingHorizontal: t.spacing.lg }]}
    >
      <T variant="monoSmall" color="textFaint" style={styles.lineNo}>
        {match.line}
      </T>
      <T variant="mono" numberOfLines={2} style={{ flex: 1, color: t.colors.codeText }}>
        {hit ? (
          <>
            {hit.pre}
            <T variant="mono" weight="700" style={{ color: t.colors.accent, backgroundColor: t.colors.accentSoft }}>
              {hit.hit}
            </T>
            {hit.post}
          </>
        ) : (
          text
        )}
      </T>
    </Tap>
  );
}

/** Characters of context kept in front of a match that sits deep inside a long line. */
const CONTEXT_BEFORE = 28;
/** Matches starting before this column are shown from the line start (two mono lines fit ~80 chars). */
const WINDOW_FROM = 44;

/**
 * The line shown for a match, windowed so the hit is always inside the two visible lines: a term that occurs
 * 200 characters into a paragraph would otherwise be lost behind the tail ellipsis. `column` (1-based, from ripgrep)
 * locates the hit; a text search is the fallback for a column that does not line up.
 */
export function excerpt(
  match: Pick<SearchMatch, 'text' | 'column'>,
  query: string,
): { text: string; hit: { pre: string; hit: string; post: string } | null } {
  const raw = match.text.replace(/[\r\n]+$/, '');
  const leading = raw.length - raw.replace(/^\s+/, '').length;
  const text = raw.slice(leading);
  const q = query.trim();
  if (!q) return { text, hit: null };
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const fromColumn = match.column - 1 - leading;
  let idx = fromColumn >= 0 && lower.startsWith(ql, fromColumn) ? fromColumn : lower.indexOf(ql);
  if (idx < 0) return { text, hit: null };
  let shown = text;
  if (idx > WINDOW_FROM) {
    const cut = idx - CONTEXT_BEFORE;
    shown = '…' + text.slice(cut);
    idx = idx - cut + 1;
  }
  return { text: shown, hit: { pre: shown.slice(0, idx), hit: shown.slice(idx, idx + q.length), post: shown.slice(idx + q.length) } };
}

const styles = StyleSheet.create({
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 56,
  },
  matchRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 12, minHeight: 48 },
  lineNo: { width: 40, textAlign: 'right', paddingTop: 1 },
});
