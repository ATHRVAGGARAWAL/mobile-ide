/**
 * Bottom sheet that shows one path's diff (or the whole tree) from /api/git/diff, rendered by the
 * unified-diff DOM component. Opens at ~90% of the screen so its height does not jump while loading;
 * hunks and files collapse on tap (inside the DOM component); word-wrap is a persisted preference;
 * very large diffs are capped client-side with a "Load full" action, and the daemon's own byte cap is
 * reported separately (nothing more can be fetched for that one).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';
import DiffView, { type DiffSource } from '../../dom/DiffView';
import { copyText } from '../../lib/clipboard';
import { basename, dirname, pluralize } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { api } from '../../state/api';
import { useTheme } from '../../theme/ThemeProvider';
import { formatCount, truncateMiddle, truncatePathMiddle } from '../files/pathFormat';
import { SkeletonDiff } from '../files/Skeleton';
import { Banner, Button, Chip, EmptyState, ErrorView, IconButton, Segmented, Sheet, Spinner, T } from '../ui';
import { useChangesState } from './changesState';
import { hasStaged, hasUnstaged, isUntracked, patchStats, type GitStatusEntry } from './statusModel';

/** Lines rendered before the sheet asks whether to load the whole diff (rendering cost, not transfer). */
export const DIFF_LINE_CAP = 1500;

export interface DiffTarget {
  /** undefined = whole tree */
  path?: string;
  staged: boolean;
  /** the status row that was tapped, when any (drives the untracked / toggle affordances) */
  entry?: GitStatusEntry;
}

export interface DiffSheetProps {
  root: string;
  projectName: string;
  target: DiffTarget | null;
  onClose: () => void;
}

function fitPath(p: string, max = 56): string {
  const d = truncatePathMiddle(p, max);
  return d.dir + d.base;
}

export function DiffSheet({ root, projectName, target, onClose }: DiffSheetProps) {
  // Keep the last target while the sheet animates out.
  const [current, setCurrent] = useState<DiffTarget | null>(target);
  useEffect(() => {
    if (target) setCurrent(target);
  }, [target]);
  const shown = target ?? current;
  // The sheet header has no line limit of its own: keep very long names on one line, extension intact.
  const title = shown?.path ? truncateMiddle(basename(shown.path), 30) : 'All changes';
  const subtitle = shown?.path ? fitPath(dirname(shown.path) || projectName) : projectName;
  return (
    <Sheet visible={!!target} onClose={onClose} title={title} subtitle={subtitle} maxHeightRatio={0.9}>
      {shown ? (
        <DiffBody key={`${root}|${shown.path ?? ''}|${shown.staged ? 's' : 'u'}`} root={root} target={shown} onClose={onClose} />
      ) : null}
    </Sheet>
  );
}

type Area = 'unstaged' | 'staged';

function DiffBody({ root, target, onClose }: { root: string; target: DiffTarget; onClose: () => void }) {
  const t = useTheme();
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();
  const [area, setArea] = useState<Area>(target.staged ? 'staged' : 'unstaged');
  const wrap = useChangesState((s) => s.diffWrap);
  const setWrap = useChangesState((s) => s.setDiffWrap);
  const [full, setFull] = useState(false);
  const staged = area === 'staged';
  const diff = useAsync(() => api.gitDiff(root, target.path, staged).then((d) => ({ staged, diff: d })), [root, target.path, staged]);
  const data = diff.data && diff.data.staged === staged ? diff.data.diff : undefined;
  const patch = data?.patch ?? '';
  const hasPatch = patch.trim().length > 0;
  const stats = useMemo(() => (hasPatch ? patchStats(patch) : null), [patch, hasPatch]);
  // Content rows, counted the same way the diff view renders them, so the notice matches the cut.
  const totalLines = stats?.lines ?? 0;
  const capped = hasPatch && !full && totalLines > DIFF_LINE_CAP;
  const source = useMemo<DiffSource>(() => ({ kind: 'patch', patch }), [patch]);

  const entry = target.entry;
  const untracked = entry ? isUntracked(entry) : false;
  // Whole tree always offers both areas; a single path only when it has both kinds of change.
  const canToggle = !target.path || (entry ? hasStaged(entry) && hasUnstaged(entry) : true);
  // The sheet is capped at 90% of the window; asking for roughly that much keeps its height stable
  // between the skeleton, a short diff and a long one (chrome ≈ handle + header + toolbar + insets).
  const bodyMinHeight = Math.max(260, Math.round(windowHeight * 0.9) - 190);

  const openFile = () => {
    if (!target.path) return;
    onClose();
    router.push({ pathname: '/file', params: { root, path: target.path } });
  };

  // Inline confirmation: the sheet is its own window (Modal), so a toast behind it would never be seen.
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const copyPatch = async () => {
    if (!hasPatch) return;
    setCopied((await copyText(patch)) ? 'ok' : 'failed');
    setTimeout(() => setCopied(null), 1600);
  };

  let body: React.ReactNode;
  if (!data && !diff.error) {
    body = <SkeletonDiff testID="diff-skeleton" />;
  } else if (diff.error && !data) {
    body = <ErrorView compact message={diff.error} onRetry={() => void diff.reload()} />;
  } else if (hasPatch) {
    body = (
      <DiffView
        source={source}
        theme={t.name}
        wrap={wrap}
        maxLines={Number.MAX_SAFE_INTEGER}
        maxTotalLines={capped ? DIFF_LINE_CAP : undefined}
        dom={{ matchContents: true, scrollEnabled: false }}
      />
    );
  } else if (untracked) {
    body = (
      <EmptyState
        compact
        icon="document-outline"
        title="New file"
        message="Git has no diff for an untracked file yet. Open it in the file viewer to read its contents."
        action={{ title: 'Open file', icon: 'document-text-outline', onPress: openFile }}
      />
    );
  } else if (!target.path) {
    body = (
      <EmptyState
        compact
        icon="checkmark-circle-outline"
        title={staged ? 'Nothing staged' : 'No unstaged changes'}
        message={
          staged
            ? 'Stage files on the laptop (git add) to see them here.'
            : 'Untracked files do not appear in the whole-tree diff; open them individually.'
        }
      />
    );
  } else {
    body = (
      <EmptyState
        compact
        icon="git-compare-outline"
        title="No textual changes"
        message={
          entry?.index === 'D' || entry?.worktree === 'D'
            ? 'The file was deleted.'
            : 'This is a binary, mode-only or whitespace-only change.'
        }
        action={{ title: 'Open file', icon: 'document-text-outline', onPress: openFile }}
      />
    );
  }

  return (
    <View style={{ gap: 12, paddingBottom: 8, minHeight: bodyMinHeight }} testID="diff-body">
      <View style={styles.toolbar}>
        <View style={{ flex: 1, minWidth: 0 }}>
          {canToggle ? (
            <Segmented<Area>
              options={[
                { key: 'unstaged', label: 'Unstaged' },
                { key: 'staged', label: 'Staged' },
              ]}
              value={area}
              onChange={setArea}
            />
          ) : (
            <Chip
              label={untracked ? 'Untracked' : staged ? 'Staged' : 'Unstaged'}
              size="md"
              icon={staged ? 'checkmark-done-outline' : 'pencil-outline'}
            />
          )}
        </View>
        {target.path ? <Button title="Open file" icon="document-text-outline" size="sm" variant="secondary" onPress={openFile} /> : null}
      </View>
      <View style={styles.toolbar}>
        <Button
          title={wrap ? 'Wrap on' : 'Wrap off'}
          icon={wrap ? 'return-down-back-outline' : 'code-slash-outline'}
          variant="secondary"
          size="sm"
          onPress={() => setWrap(!wrap)}
          disabled={!hasPatch}
        />
        <View style={{ flex: 1 }} />
        <IconButton
          name={copied === 'ok' ? 'checkmark' : copied === 'failed' ? 'alert-circle-outline' : 'copy-outline'}
          label={copied === 'ok' ? 'Patch copied' : copied === 'failed' ? 'Could not copy the patch' : 'Copy patch'}
          size={20}
          color={copied === 'ok' ? t.colors.success : copied === 'failed' ? t.colors.danger : undefined}
          onPress={() => void copyPatch()}
          disabled={!hasPatch}
        />
        {diff.refreshing ? (
          <View style={styles.spinnerBox}>
            <Spinner />
          </View>
        ) : (
          <IconButton name="refresh" label="Reload diff" size={20} onPress={() => void diff.refresh()} disabled={diff.loading} />
        )}
      </View>
      {stats ? (
        <View style={styles.stats}>
          <T variant="caption" style={{ color: t.colors.success, fontFamily: t.font.mono }}>
            +{stats.added}
          </T>
          <T variant="caption" style={{ color: t.colors.danger, fontFamily: t.font.mono }}>
            −{stats.removed}
          </T>
          {!target.path && stats.files > 0 ? (
            <T variant="caption" color="textMuted">
              {pluralize(stats.files, 'file')}
            </T>
          ) : null}
          <T variant="caption" color="textFaint">
            {formatCount(totalLines)} lines
          </T>
          {diff.refreshing ? (
            <T variant="caption" color="textFaint">
              refreshing…
            </T>
          ) : null}
        </View>
      ) : null}
      {capped ? (
        <Banner
          tone="info"
          icon="layers-outline"
          compact
          message={`Large diff — showing the first ${formatCount(DIFF_LINE_CAP)} of ${formatCount(totalLines)} lines.`}
          actionLabel="Load full"
          onAction={() => setFull(true)}
        />
      ) : null}
      {data?.truncated ? (
        <Banner tone="warning" compact message="This diff is too large to show in full. Open individual files to review more." />
      ) : null}
      {diff.error && data ? (
        <Banner tone="danger" compact message={diff.error} actionLabel="Retry" onAction={() => void diff.reload()} />
      ) : null}
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stats: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  spinnerBox: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
});
