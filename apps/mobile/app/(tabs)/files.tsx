/**
 * Files tab: project picker, breadcrumb tree over /api/fs/tree (folders first, natural order, `.git`
 * never shown, dotfiles behind a persisted "show hidden" toggle, folder git roll-ups from
 * /api/git/status), ripgrep search over /api/fs/search, tap a file to open the viewer.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useIsFocused, useRouter } from 'expo-router';
import type { FsEntry, SearchMatch } from '@mobile-ide/core';
import {
  Breadcrumbs,
  FsEntryRow,
  ProjectPickerButton,
  ProjectPickerSheet,
  SearchResults,
  SkeletonRows,
  buildFolderRollups,
  getCachedTree,
  prepareEntries,
  setCachedTree,
  useFilesState,
  useFsSearch,
} from '../../src/components/files';
import {
  Banner,
  ConnectionBanner,
  Divider,
  EmptyState,
  ErrorView,
  IconButton,
  PageHeader,
  Screen,
  Segmented,
  Spinner,
  T,
  Tap,
  TextField,
  useToastAnchor,
} from '../../src/components/ui';
import { copyText } from '../../src/lib/clipboard';
import { pluralize } from '../../src/lib/format';
import { useAsync } from '../../src/lib/useAsync';
import { useNow } from '../../src/lib/useNow';
import { api } from '../../src/state/api';
import { useProjects, useSelectedProject } from '../../src/state/projects';
import { toast } from '../../src/state/toast';
import { useTheme } from '../../src/theme/ThemeProvider';

const MIN_QUERY = 2;

export default function FilesScreen() {
  const t = useTheme();
  // toasts float above the tab bar (and the keyboard) while this tab is showing
  const toastAnchor = useToastAnchor({ enabled: useIsFocused() });
  const router = useRouter();
  const now = useNow(60_000);

  const projects = useProjects((s) => s.projects);
  const projectsLoaded = useProjects((s) => s.loaded);
  const projectsLoading = useProjects((s) => s.loading);
  const projectsError = useProjects((s) => s.error);
  const loadProjects = useProjects((s) => s.load);
  const project = useSelectedProject();
  const root = project?.root ?? null;

  const pathByRoot = useFilesState((s) => s.pathByRoot);
  const setPathFor = useFilesState((s) => s.setPath);
  const showHidden = useFilesState((s) => s.showHidden);
  const toggleShowHidden = useFilesState((s) => s.toggleShowHidden);
  const path = root ? (pathByRoot[root] ?? '') : '';
  const setPath = useCallback(
    (p: string) => {
      if (root) setPathFor(root, p);
    },
    [root, setPathFor],
  );

  useFocusEffect(
    useCallback(() => {
      if (!projectsLoaded && !projectsLoading) void loadProjects();
    }, [projectsLoaded, projectsLoading, loadProjects]),
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<TextInput>(null);
  const search = useFsSearch(searchOpen ? root : null, query, { minLength: MIN_QUERY });

  // Tag cached listings by folder so walking back up is instant without mixing project contents.
  const tree = useAsync(() => api.fsTree(root ?? '', path).then((entries) => ({ root: root ?? '', path, entries })), [root, path], {
    enabled: !!root,
  });
  const fresh = tree.data && tree.data.root === root && tree.data.path === path ? tree.data.entries : undefined;
  useEffect(() => {
    if (root && fresh) setCachedTree(root, path, fresh);
  }, [root, path, fresh]);
  const cached = root ? getCachedTree(root, path) : undefined;
  const entries: FsEntry[] | undefined = fresh ?? cached;
  const prepared = useMemo(() => prepareEntries(entries, showHidden), [entries, showHidden]);

  // Folder roll-ups ("2 modified · 1 untracked") come from the whole-repo status; keyed by root so a
  // project switch never shows the previous repo's counts.
  const isGit = !!project?.isGit;
  const gitStatus = useAsync(() => api.gitStatus(root ?? '').then((s) => ({ root: root ?? '', status: s })), [root], {
    enabled: !!root && isGit,
  });
  const statusForRoot = gitStatus.data && gitStatus.data.root === root ? gitStatus.data.status : undefined;
  const rollupFor = useMemo(() => buildFolderRollups(statusForRoot), [statusForRoot]);
  const refreshing = tree.refreshing || gitStatus.refreshing;
  const refreshAll = () => {
    void tree.refresh();
    if (isGit) void gitStatus.refresh();
  };

  const openEntry = (entry: FsEntry) => {
    if (!root) return;
    if (entry.kind === 'dir') {
      setPath(entry.path);
      return;
    }
    if (entry.kind === 'file' || entry.kind === 'symlink') router.push({ pathname: '/file', params: { root, path: entry.path } });
  };
  const copyEntryPath = async (entry: FsEntry) => {
    if (await copyText(entry.path)) toast.success('Path copied');
    else toast.error('Could not copy the path');
  };
  const openMatch = (m: SearchMatch) => {
    if (root) router.push({ pathname: '/file', params: { root, path: m.path, line: String(m.line) } });
  };
  const openFile = (p: string) => {
    if (root) router.push({ pathname: '/file', params: { root, path: p } });
  };

  let content: React.ReactNode;
  if (!projectsLoaded && projectsLoading) {
    content = <SkeletonRows rows={8} testID="projects-skeleton" />;
  } else if (projectsError && projects.length === 0) {
    content = <ErrorView message={projectsError} onRetry={() => void loadProjects()} />;
  } else if (projects.length === 0) {
    content = (
      <EmptyState
        icon="folder-open-outline"
        title="No projects yet"
        message="Add a project on your computer, then refresh to find it here."
        action={{ title: 'Refresh', onPress: () => void loadProjects(), icon: 'refresh', loading: projectsLoading }}
      />
    );
  } else if (!root || !project) {
    content = (
      <EmptyState
        icon="folder-outline"
        title="Choose a project"
        message="Pick which project root to browse."
        action={{ title: 'Choose project', onPress: () => setPickerOpen(true), icon: 'folder-open-outline' }}
      />
    );
  } else if (searchOpen) {
    let results: React.ReactNode;
    if (query.trim().length < MIN_QUERY) {
      results = (
        <EmptyState
          compact
          icon="search-outline"
          title="Find the right line"
          message={`Search the contents of every file in this project. Enter at least ${MIN_QUERY} characters; regular expressions work too.`}
        />
      );
    } else if (search.error) {
      results = <ErrorView compact title="Search failed" message={search.error} onRetry={search.retry} />;
    } else if (!search.results) {
      results = <SkeletonRows rows={7} iconBox={false} testID="search-skeleton" />;
    } else if (search.results.length === 0) {
      results = (
        <EmptyState
          compact
          icon="search-outline"
          title={`No matches for “${search.forQuery}”`}
          message="Try a shorter query or check the spelling."
        />
      );
    } else {
      results = (
        <SearchResults
          results={search.results}
          query={search.forQuery}
          limit={search.limit}
          onOpenMatch={openMatch}
          onOpenFile={openFile}
          refreshing={search.loading}
          onRefresh={search.retry}
        />
      );
    }
    content = (
      <>
        <View style={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.sm }}>
          <TextField
            ref={searchRef}
            value={query}
            onChangeText={setQuery}
            placeholder="Search file contents…"
            accessibilityLabel={`Search file contents in ${project.name}`}
            returnKeyType="search"
            onSubmitEditing={search.searchNow}
            autoFocus
            right={
              search.loading ? (
                <Spinner />
              ) : query ? (
                <IconButton name="close-circle" size={18} label="Clear search" onPress={() => setQuery('')} />
              ) : undefined
            }
          />
        </View>
        {results}
      </>
    );
  } else {
    content = (
      <>
        <Breadcrumbs
          rootName={project.name}
          path={path}
          onNavigate={setPath}
          right={
            <>
              <IconButton
                name={showHidden ? 'eye' : 'eye-off-outline'}
                size={18}
                label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
                filled={showHidden}
                color={showHidden ? t.colors.accent : t.colors.textMuted}
                onPress={toggleShowHidden}
              />
              {refreshing ? (
                <View style={styles.spinnerBox}>
                  <Spinner />
                </View>
              ) : (
                <IconButton
                  name="refresh"
                  size={18}
                  label="Refresh folder"
                  color={t.colors.textMuted}
                  onPress={refreshAll}
                  disabled={!entries}
                />
              )}
            </>
          }
        />
        {tree.error && entries ? (
          <Banner tone="danger" message={tree.error} actionLabel="Retry" onAction={() => void tree.reload()} compact />
        ) : null}
        {!prepared ? (
          tree.error ? (
            <ErrorView message={tree.error} onRetry={() => void tree.reload()} />
          ) : (
            <SkeletonRows rows={10} trailing testID="files-skeleton" />
          )
        ) : (
          <FlashList
            data={prepared.visible}
            keyExtractor={(e) => e.path || e.name}
            getItemType={(e) => e.kind}
            renderItem={({ item }) => (
              <FsEntryRow
                entry={item}
                now={now}
                rollup={item.kind === 'dir' ? rollupFor(item.path) : undefined}
                onPress={() => openEntry(item)}
                onLongPress={() => void copyEntryPath(item)}
              />
            )}
            ItemSeparatorComponent={Separator}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshAll} tintColor={t.colors.accent} />}
            ListEmptyComponent={
              prepared.hiddenCount > 0 ? (
                <EmptyState
                  compact
                  icon="eye-off-outline"
                  title="Only hidden items here"
                  message={`${pluralize(prepared.hiddenCount, 'dotfile')} in this folder.`}
                  action={{ title: 'Show hidden files', onPress: toggleShowHidden, icon: 'eye-outline' }}
                />
              ) : (
                <EmptyState compact icon="folder-open-outline" title="Empty folder" message="Nothing in here yet." />
              )
            }
            ListFooterComponent={
              prepared.visible.length ? (
                <FolderSummary
                  dirs={prepared.dirs}
                  files={prepared.files}
                  hidden={prepared.hiddenCount}
                  showHidden={showHidden}
                  onToggleHidden={toggleShowHidden}
                />
              ) : null
            }
            contentContainerStyle={{ paddingBottom: 24 }}
            keyboardShouldPersistTaps="handled"
          />
        )}
      </>
    );
  }

  return (
    <Screen edges={['top']}>
      <View style={{ flex: 1 }} ref={toastAnchor.ref} onLayout={toastAnchor.onLayout}>
        <PageHeader eyebrow="Workspace" title="Files" subtitle="Browse and search your project.">
          {projects.length ? <ProjectPickerButton project={project} onPress={() => setPickerOpen(true)} /> : null}
          {root ? (
            <Segmented
              options={[
                { key: 'browse', label: 'Browse' },
                { key: 'search', label: 'Search' },
              ]}
              value={searchOpen ? 'search' : 'browse'}
              onChange={(mode) => setSearchOpen(mode === 'search')}
            />
          ) : null}
        </PageHeader>
        <ConnectionBanner />
        {content}
      </View>
      <ProjectPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={() => {
          setSearchOpen(false);
          setQuery('');
        }}
      />
    </Screen>
  );
}

function Separator() {
  return <Divider inset={60} />;
}

function FolderSummary({
  dirs,
  files,
  hidden,
  showHidden,
  onToggleHidden,
}: {
  dirs: number;
  files: number;
  hidden: number;
  showHidden: boolean;
  onToggleHidden: () => void;
}) {
  const parts = [pluralize(dirs, 'folder'), pluralize(files, 'file')];
  if (hidden > 0) parts.push(`${hidden} hidden`);
  return (
    <View style={styles.summary}>
      <T variant="caption" color="textFaint" align="center">
        {parts.join(' · ')}
      </T>
      {hidden > 0 || showHidden ? (
        <Tap
          onPress={onToggleHidden}
          pressedColor={null}
          accessibilityRole="button"
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}
        >
          <T variant="caption" weight="600" color="accent">
            {showHidden ? 'Hide hidden files' : `Show ${pluralize(hidden, 'hidden file')}`}
          </T>
        </Tap>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { alignItems: 'center', paddingVertical: 20, gap: 8 },
  spinnerBox: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
