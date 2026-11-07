/** One row of the file tree: kind icon, name, size/mtime, git status (folders roll up what changed inside), chevron for folders. */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { FsEntry } from '@mobile-ide/core';
import { formatBytes, relativeTime } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import { ListRow } from '../ui/ListRow';
import { T } from '../ui/Text';
import { entryIcon, gitStatusMeta, isVendoredName, type GitStatusMeta } from './fileIcons';
import type { FolderRollup } from './gitRollup';
import { isDotfile } from './treeModel';

export interface FsEntryRowProps {
  entry: FsEntry;
  /** current time for relative mtimes (pass from useNow so the list re-renders together) */
  now: number;
  /** folder-level counts from /api/git/status; falls back to the tree's propagated letter */
  rollup?: FolderRollup | null;
  onPress: () => void;
  onLongPress?: () => void;
}

export function FsEntryRow({ entry, now, rollup, onPress, onLongPress }: FsEntryRowProps) {
  const t = useTheme();
  const icon = entryIcon(entry);
  const isDir = entry.kind === 'dir';
  const git = isDir && rollup ? gitStatusMeta(rollup.letters, t) : gitStatusMeta(entry.gitStatus, t);
  const iconColor = isDir ? t.colors.text : icon.tone === 'muted' ? t.colors.textFaint : t.colors.textMuted;
  const dimmed = isVendoredName(entry.name) || isDotfile(entry.name);

  let subtitle: string | undefined;
  if (isDir) subtitle = rollup ? rollup.label : git?.label;
  else {
    const parts: string[] = [];
    if (entry.size !== undefined) parts.push(formatBytes(entry.size));
    if (entry.mtime) parts.push(relativeTime(entry.mtime, now));
    if (entry.kind === 'symlink') parts.push('symlink');
    if (entry.kind === 'other') parts.push('not a regular file');
    subtitle = parts.join(' · ') || undefined;
  }

  const count = isDir && rollup && rollup.total > 1 ? rollup.total : undefined;
  return (
    <ListRow
      title={entry.name}
      subtitle={subtitle}
      left={
        <View style={[styles.iconBox, { backgroundColor: t.colors.surfaceAlt, borderColor: t.colors.border }]}>
          <Ionicons name={icon.name} size={18} color={iconColor} />
        </View>
      }
      right={git ? <GitStatusBadge meta={git} count={count} /> : undefined}
      chevron={isDir}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={entry.kind === 'other'}
      style={[{ minHeight: 68 }, dimmed ? { opacity: 0.7 } : null]}
      testID={`fs-entry-${entry.path}`}
    />
  );
}

export function GitStatusBadge({ meta, count }: { meta: GitStatusMeta; count?: number }) {
  const t = useTheme();
  const label = count ? `${meta.label}, ${count} files` : meta.label;
  return (
    <View style={styles.badge} accessibilityLabel={label}>
      <View style={[styles.dot, { backgroundColor: meta.color }]} />
      <T variant="caption" weight="700" style={{ color: meta.color }}>
        {meta.letter}
      </T>
      {count ? (
        <View style={[styles.count, { backgroundColor: t.colors.surfaceAlt }]}>
          <T variant="caption" weight="600" color="textMuted" style={{ fontSize: 10, lineHeight: 12 }}>
            {count > 99 ? '99+' : count}
          </T>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  iconBox: {
    width: 36,
    height: 38,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 24, justifyContent: 'flex-end' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  count: { minWidth: 18, height: 16, borderRadius: 8, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
});
