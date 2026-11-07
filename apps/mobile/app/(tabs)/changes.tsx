/** Review the working tree or browse commit history without losing project context. */
import React, { useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  ChangeRow,
  ChangesSkeleton,
  CommitRow,
  DiffSheet,
  ProjectChip,
  ProjectPickerSheet,
  describeBranch,
  findStatusEntry,
  splitStatus,
  useChanges,
  useChangesState,
  useEnsureProjects,
  type ChangeItem,
  type DiffTarget,
} from '../../src/components/changes';
import { SkeletonRows } from '../../src/components/files/Skeleton';
import {
  Banner,
  Button,
  Card,
  ConnectionBanner,
  Divider,
  EmptyState,
  ErrorView,
  IconButton,
  PageHeader,
  Screen,
  SectionHeader,
  Segmented,
  Spinner,
  T,
  Tap,
  useToastAnchor,
} from '../../src/components/ui';
import { copyText } from '../../src/lib/clipboard';
import { pluralize } from '../../src/lib/format';
import { useNow } from '../../src/lib/useNow';
import { useProjects, useSelectedProject } from '../../src/state/projects';
import { toast } from '../../src/state/toast';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function ChangesScreen() {
  const t = useTheme();
  useEnsureProjects();
  const toastAnchor = useToastAnchor({ enabled: useIsFocused() });
  const project = useSelectedProject();
  const root = project?.root ?? null;
  const projectsLoaded = useProjects((s) => s.loaded);
  const projectsLoading = useProjects((s) => s.loading);
  const projectsError = useProjects((s) => s.error);
  const projectCount = useProjects((s) => s.projects.length);
  const loadProjects = useProjects((s) => s.load);
  const listed = useProjects((s) => !!root && s.projects.some((p) => p.root === root));
  const nonGit = !!project && listed && !project.isGit;
  const { status, log, refresh } = useChanges(root, !!root && !nonGit);
  const split = useMemo(() => splitStatus(status.data), [status.data]);
  const branchLine = describeBranch(status.data);
  const fileCount = useMemo(
    () => new Set([...split.conflicts, ...split.staged, ...split.unstaged].map((item) => item.entry.path)).size,
    [split],
  );
  const now = useNow();
  const refreshing = status.refreshing || log.refreshing;
  const [view, setView] = useState<'review' | 'history'>('review');
  const [pickerOpen, setPickerOpen] = useState(false);
  // Scope the target to its project: a project switch cannot fetch the old path under a new root.
  const [selection, setSelection] = useState<{ root: string; target: DiffTarget } | null>(null);
  const target = selection?.root === root ? selection.target : null;
  const openTarget = (next: DiffTarget) => {
    if (root) setSelection({ root, target: next });
  };
  const openDiff = (item: ChangeItem) => openTarget({ path: item.entry.path, staged: item.area === 'staged', entry: item.entry });
  const reviewAll = () => {
    const conflict = split.conflicts[0];
    if (conflict && !split.staged.length && !split.unstaged.length) openDiff(conflict);
    else openTarget({ staged: !split.unstaged.length });
  };

  const requested = useChangesState((s) => s.requested);
  const clearRequested = useChangesState((s) => s.clearRequested);
  useEffect(() => {
    if (!requested || root !== requested.root) return;
    setView('review');
    setSelection({ root, target: { path: requested.path, staged: requested.staged, entry: findStatusEntry(status.data, requested.path) } });
    clearRequested();
  }, [requested, root, status.data, clearRequested]);
  useEffect(() => {
    setSelection((current) => (current?.root === root ? current : null));
  }, [root]);

  const copyHash = async (hash: string) => {
    if (await copyText(hash)) toast.success('Commit hash copied');
    else toast.error('Could not copy');
  };

  let body: React.ReactNode;
  if (!root) {
    if (projectsLoading && !projectsLoaded) body = <ChangesSkeleton />;
    else if (projectsError && projectCount === 0) body = <ErrorView message={projectsError} onRetry={() => void loadProjects()} />;
    else
      body = (
        <EmptyState
          icon="folder-open-outline"
          title={projectCount ? 'Choose a project' : 'No projects yet'}
          message="Choose a repository to review its changes."
          action={{
            title: projectCount ? 'Choose project' : 'Refresh projects',
            onPress: () => (projectCount ? setPickerOpen(true) : void loadProjects()),
          }}
        />
      );
  } else if (nonGit) {
    body = (
      <EmptyState
        icon="git-branch-outline"
        title="No Git history here"
        message={`${project?.name ?? 'This project'} is not a Git repository.`}
        action={{ title: 'Choose another project', onPress: () => setPickerOpen(true) }}
      />
    );
  } else if (view === 'review' && status.loading && !status.data) {
    body = <ChangesSkeleton />;
  } else if (view === 'review' && status.error && !status.data) {
    body = <ErrorView message={status.error} onRetry={() => void status.reload()} />;
  } else {
    body = (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={t.colors.accent} />}
        keyboardShouldPersistTaps="handled"
      >
        {status.error ? (
          <Banner tone="danger" compact message={status.error} actionLabel="Retry" onAction={() => void status.reload()} />
        ) : null}
        {view === 'review' ? (
          <>
            <Card style={{ marginHorizontal: t.spacing.lg, padding: 18, gap: 14 }}>
              <View style={styles.branch}>
                <Ionicons name="git-branch-outline" size={15} color={t.colors.textMuted} />
                <T variant="monoSmall" color="textMuted" numberOfLines={1} style={{ flex: 1 }}>
                  {branchLine || 'detached HEAD'}
                </T>
                <T variant="caption" color="textFaint">
                  Working tree
                </T>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <T variant="display">{fileCount}</T>
                <T variant="bodySmall" color="textMuted">
                  {fileCount === 1 ? 'file to review' : 'files to review'}
                </T>
              </View>
              {fileCount ? (
                <>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
                    {split.conflicts.length ? (
                      <T variant="caption" color="danger">
                        {pluralize(split.conflicts.length, 'conflict')}
                      </T>
                    ) : null}
                    <T variant="caption" color="textMuted">
                      {split.unstaged.length} unstaged
                    </T>
                    <T variant="caption" color="textMuted">
                      {split.staged.length} staged
                    </T>
                  </View>
                  <Button
                    title={
                      split.unstaged.length ? 'Review unstaged changes' : split.staged.length ? 'Review staged changes' : 'Review conflicts'
                    }
                    icon="git-compare-outline"
                    full
                    variant="secondary"
                    onPress={reviewAll}
                  />
                </>
              ) : (
                <T variant="bodySmall" color="textMuted">
                  Everything is up to date. New edits will appear here.
                </T>
              )}
            </Card>
            {split.conflicts.length ? (
              <ChangeSection title="Conflicts" detail="Resolve these before committing." items={split.conflicts} onPress={openDiff} />
            ) : null}
            {split.unstaged.length ? (
              <ChangeSection
                title="Unstaged"
                detail="Edits in your working directory."
                items={split.unstaged}
                onPress={openDiff}
                onDiffAll={() => openTarget({ staged: false })}
              />
            ) : null}
            {split.staged.length ? (
              <ChangeSection
                title="Staged"
                detail="Changes ready for your next commit."
                items={split.staged}
                onPress={openDiff}
                onDiffAll={() => openTarget({ staged: true })}
              />
            ) : null}
          </>
        ) : (
          <>
            <SectionHeader title="Recent commits" right={log.refreshing ? <Spinner /> : undefined} />
            <T variant="bodySmall" color="textMuted" style={{ marginHorizontal: t.spacing.lg, marginBottom: 14 }}>
              Tap a commit to copy its hash.
            </T>
            <Card padded={false} style={[styles.card, { marginHorizontal: t.spacing.lg }]}>
              {log.loading && !log.data ? (
                <SkeletonRows rows={5} iconBox={false} testID="log-skeleton" />
              ) : log.error && !log.data ? (
                <ErrorView compact message={log.error} onRetry={() => void log.reload()} />
              ) : !log.data?.length ? (
                <EmptyState
                  compact
                  icon="git-commit-outline"
                  title="Your history starts here"
                  message="Commits made on your computer appear in this list."
                />
              ) : (
                log.data.map((commit, i) => (
                  <React.Fragment key={commit.hash}>
                    {i > 0 ? <Divider inset={t.spacing.lg} /> : null}
                    <CommitRow commit={commit} now={now} onPress={() => void copyHash(commit.hash)} />
                  </React.Fragment>
                ))
              )}
            </Card>
            {log.error && log.data ? (
              <Banner tone="danger" compact message={log.error} actionLabel="Retry" onAction={() => void log.reload()} />
            ) : null}
          </>
        )}
      </ScrollView>
    );
  }

  return (
    <Screen edges={['top']}>
      <View style={{ flex: 1 }} ref={toastAnchor.ref} onLayout={toastAnchor.onLayout}>
        <PageHeader
          eyebrow="Workspace"
          title="Changes"
          subtitle="Review the work, one file at a time."
          right={
            <IconButton
              name="refresh"
              label="Refresh changes"
              filled
              onPress={() => void refresh()}
              disabled={!root || nonGit || refreshing}
            />
          }
        >
          <ProjectChip onPress={() => setPickerOpen(true)} />
          <Segmented
            options={[
              { key: 'review', label: 'Review' },
              { key: 'history', label: 'History' },
            ]}
            value={view}
            onChange={setView}
          />
        </PageHeader>
        <ConnectionBanner />
        {body}
      </View>
      {root ? (
        <DiffSheet key={root} root={root} projectName={project?.name ?? root} target={target} onClose={() => setSelection(null)} />
      ) : null}
      <ProjectPickerSheet visible={pickerOpen} onClose={() => setPickerOpen(false)} />
    </Screen>
  );
}

function ChangeSection({
  title,
  detail,
  items,
  onPress,
  onDiffAll,
}: {
  title: string;
  detail: string;
  items: ChangeItem[];
  onPress: (item: ChangeItem) => void;
  onDiffAll?: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ marginTop: 22 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginHorizontal: t.spacing.lg, marginBottom: 12, gap: 10 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <T variant="subheading">
            {title}{' '}
            <T variant="bodySmall" color="textFaint">
              {items.length}
            </T>
          </T>
          <T variant="caption" color="textMuted">
            {detail}
          </T>
        </View>
        {onDiffAll ? (
          <Tap
            onPress={onDiffAll}
            accessibilityRole="button"
            accessibilityLabel={`Diff all ${title.toLowerCase()} changes`}
            style={{ minHeight: 44, justifyContent: 'center', paddingLeft: 10 }}
          >
            <T variant="bodySmall" weight="600" color="accent">
              View diff
            </T>
          </Tap>
        ) : null}
      </View>
      <Card padded={false} style={[styles.card, { marginHorizontal: t.spacing.lg }]}>
        {items.map((item, i) => (
          <React.Fragment key={item.key}>
            {i > 0 ? <Divider inset={t.spacing.lg + 42} /> : null}
            <ChangeRow item={item} onPress={() => onPress(item)} />
          </React.Fragment>
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  branch: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  card: { overflow: 'hidden' },
});
