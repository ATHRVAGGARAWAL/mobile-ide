/**
 * Read-only file viewer: Shiki-highlighted code (DOM component) with line numbers, wrap (prose wraps
 * by default, code scrolls sideways), jump-to-line, size/truncation notice, the file's git status with
 * "Open in Changes", copy/share. Draws its own sticky header (name + middle-truncated path) so it looks
 * the same on iOS and web.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, Share, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import CodeView from '../../dom/CodeView';
import { copyText } from '../../lib/clipboard';
import { basename, dirname, formatBytes, pluralize } from '../../lib/format';
import { useDirWatch } from '../../lib/liveFs';
import { useAsync } from '../../lib/useAsync';
import { api } from '../../state/api';
import { useProjects } from '../../state/projects';
import { toast } from '../../state/toast';
import { useTheme } from '../../theme/ThemeProvider';
import { useChangesState } from '../changes/changesState';
import { findStatusEntry, summarizeEntry, toneColors } from '../changes/statusModel';
import { Banner } from '../ui/Banner';
import { Chip } from '../ui/Chip';
import { EmptyState } from '../ui/EmptyState';
import { IconButton } from '../ui/IconButton';
import { ListRow } from '../ui/ListRow';
import { Divider } from '../ui/Misc';
import { Segmented } from '../ui/Segmented';
import { Sheet } from '../ui/Sheet';
import { ErrorView } from '../ui/StatusView';
import { Tap } from '../ui/Tap';
import { T } from '../ui/Text';
import { useFilesState } from './filesState';
import { truncateMiddle } from './pathFormat';
import { PathText } from './PathText';
import { SkeletonCode } from './Skeleton';
import { effectiveWrap, useViewerPrefs, VIEWER_FONT_PX, type ViewerFontSize } from './viewerPrefs';

export interface FileViewerProps {
  root: string;
  /** path relative to root */
  path: string;
  /** 1-based line to highlight and scroll to */
  line?: number;
  onBack: () => void;
}

const FONT_OPTIONS: { key: ViewerFontSize; label: string }[] = [
  { key: 'sm', label: 'Small' },
  { key: 'md', label: 'Medium' },
  { key: 'lg', label: 'Large' },
];

export function FileViewer({ root, path, line, onBack }: FileViewerProps) {
  const t = useTheme();
  const router = useRouter();
  const file = useAsync(() => api.fsFile(root, path), [root, path]);
  // Live: the folder is watched over the daemon socket; a write to this file (an agent edit, a save on the laptop)
  // re-reads it and flashes "updated" in the meta line, so the phone shows the code changing as it happens.
  const [liveUpdatedAt, setLiveUpdatedAt] = useState<number | null>(null);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRefreshPending = useRef(false);
  useEffect(() => {
    setLiveUpdatedAt(null);
    liveRefreshPending.current = false;
    return () => {
      if (liveTimer.current) clearTimeout(liveTimer.current);
    };
  }, [root, path]);
  const onFolderChange = useCallback(
    (names: string[]) => {
      if (!names.includes(basename(path))) return;
      if (liveTimer.current) clearTimeout(liveTimer.current);
      // a save is often several inotify events; one re-read per burst
      liveTimer.current = setTimeout(() => {
        liveTimer.current = null;
        liveRefreshPending.current = true;
        void file.refresh();
      }, 80);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root, path],
  );
  useDirWatch(root, dirname(path), onFolderChange, !file.data?.binary);
  useEffect(() => {
    if (!liveRefreshPending.current || file.refreshing) return;
    if (file.data && !file.error) setLiveUpdatedAt(Date.now());
    liveRefreshPending.current = false;
  }, [file.data, file.error, file.refreshing]);
  useEffect(() => {
    if (liveUpdatedAt === null) return;
    const id = setTimeout(() => setLiveUpdatedAt(null), 4000);
    return () => clearTimeout(id);
  }, [liveUpdatedAt]);
  const wrapPref = useViewerPrefs((s) => s.wrap);
  const wrapTouched = useViewerPrefs((s) => s.wrapTouched);
  const fontSize = useViewerPrefs((s) => s.fontSize);
  const setWrap = useViewerPrefs((s) => s.setWrap);
  const setFontSize = useViewerPrefs((s) => s.setFontSize);
  const project = useProjects((s) => s.projects.find((p) => p.root === root));
  const projectName = project?.name ?? basename(root);
  const [actionsOpen, setActionsOpen] = useState(false);
  // Proportional glyphs average ≈0.56 em; the platform ellipsis stays on as the safety net for wider strings.
  const [titleWidth, setTitleWidth] = useState(0);
  const titleChars = titleWidth > 0 ? Math.max(12, Math.floor(titleWidth / (t.font.size.md * 0.56))) : Number.POSITIVE_INFINITY;
  const onTitleLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Math.abs(w - titleWidth) > 0.5) setTitleWidth(w);
  };

  // Git status for the badge + "Open in Changes". Unknown roots are tried (a non-git root simply 400s).
  const maybeGit = project ? project.isGit : true;
  const status = useAsync(() => api.gitStatus(root).then((s) => ({ root, status: s })), [root], { enabled: maybeGit });
  const gitStatus = status.data && status.data.root === root ? status.data.status : undefined;
  const change = useMemo(() => summarizeEntry(findStatusEntry(gitStatus, path)), [gitStatus, path]);
  const changeColors = change ? toneColors(change.tone, t) : null;

  const data = file.data;
  const language = data?.language ?? 'text';
  const wrap = effectiveWrap(wrapPref, wrapTouched, language);
  const name = basename(path);
  const dir = dirname(path);
  const lineCount = useMemo(() => (data && !data.binary ? countLines(data.content) : 0), [data]);
  const shownBytes = useMemo(() => (data && data.truncated ? utf8Length(data.content) : 0), [data]);
  const canCopy = !!data && !data.binary && data.content.length > 0;

  const reload = () => {
    void file.refresh();
    if (maybeGit) void status.refresh();
  };
  const copyContents = async () => {
    if (!data || !canCopy) return;
    if (await copyText(data.content)) toast.success(data.truncated ? 'Copied the loaded part of the file' : 'File contents copied');
    else toast.error("Couldn't copy to the clipboard");
  };
  const copyPath = async () => {
    if (await copyText(path)) toast.success('Path copied');
    else toast.error("Couldn't copy to the clipboard");
  };
  const share = async () => {
    if (!data || !canCopy) return;
    try {
      if (Platform.OS === 'web') {
        const nav = (globalThis as unknown as { navigator?: { share?: (d: { title?: string; text?: string }) => Promise<void> } })
          .navigator;
        if (nav?.share) await nav.share({ title: name, text: data.content });
        else await copyContents();
      } else {
        await Share.share({ message: data.content, title: name });
      }
    } catch {
      /* user dismissed the share sheet */
    }
  };
  const showInFiles = () => {
    setActionsOpen(false);
    useProjects.getState().select(root);
    useFilesState.getState().setPath(root, dir);
    router.navigate('/(tabs)/files');
  };
  const openInChanges = () => {
    if (!change) return;
    setActionsOpen(false);
    useProjects.getState().select(root);
    useChangesState.getState().requestDiff({ root, path, staged: change.staged && !change.unstaged });
    router.navigate('/(tabs)/changes');
  };

  let body: React.ReactNode;
  if (file.loading && !data) {
    body = (
      <View style={{ flex: 1, backgroundColor: t.colors.codeBg }}>
        <SkeletonCode testID="file-skeleton" />
      </View>
    );
  } else if (file.error && !data) body = <ErrorView message={file.error} onRetry={() => void file.reload()} />;
  else if (!data) body = null;
  else if (data.binary) {
    body = (
      <EmptyState
        icon="document-attach-outline"
        title="Binary file"
        message={`${formatBytes(data.size)} · this file can't be shown as text.`}
        action={{ title: 'Copy path', onPress: () => void copyPath(), icon: 'copy-outline' }}
      />
    );
  } else if (data.content.length === 0) {
    body = (
      <EmptyState
        icon="document-outline"
        title="Empty file"
        message="This file has no content yet."
        action={{ title: 'Reload', onPress: reload, icon: 'refresh' }}
      />
    );
  } else {
    const view = (
      <CodeView
        code={data.content}
        language={language}
        theme={t.name}
        wrap={wrap}
        highlightLine={line}
        fontSize={VIEWER_FONT_PX[fontSize]}
        dom={{ style: { flex: 1, backgroundColor: 'transparent' }, contentInsetAdjustmentBehavior: 'never' }}
      />
    );
    body = (
      <View style={{ flex: 1, backgroundColor: t.colors.codeBg }}>
        {Platform.OS === 'web' ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
            {view}
          </ScrollView>
        ) : (
          view
        )}
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.header, { borderBottomColor: t.colors.border, backgroundColor: t.colors.surface }]}>
        <IconButton name="chevron-back" label="Back" onPress={onBack} />
        <Tap
          onLongPress={() => void copyPath()}
          pressedColor={null}
          style={{ flex: 1, minWidth: 0 }}
          accessibilityLabel={path}
          accessibilityHint="Long press to copy the path"
          onLayout={onTitleLayout}
        >
          {/* middle truncation like the path line below, so the extension survives (RN-web ignores ellipsizeMode="middle") */}
          <T variant="heading" numberOfLines={1}>
            {truncateMiddle(name, titleChars)}
          </T>
          <PathText path={dir ? `${projectName}/${dir}` : projectName} variant="monoSmall" color="textMuted" testID="file-viewer-path" />
        </Tap>
        <IconButton
          name={wrap ? 'return-down-back-outline' : 'code-slash-outline'}
          label={wrap ? 'Turn off line wrapping' : 'Wrap long lines'}
          filled={wrap}
          color={wrap ? t.colors.accent : undefined}
          disabled={!canCopy}
          onPress={() => setWrap(!wrap)}
        />
        <IconButton name="ellipsis-horizontal" label="File options" onPress={() => setActionsOpen(true)} disabled={!data} />
      </View>

      {data && !data.binary ? (
        <View style={[styles.meta, { paddingHorizontal: t.spacing.lg }]}>
          <T variant="monoSmall" color="textMuted" numberOfLines={1} style={{ flex: 1 }}>
            {language} · {formatBytes(data.size)} · {pluralize(lineCount, 'line')}
            {line ? ` · line ${line}` : ''}
            {file.refreshing ? ' · refreshing…' : ''}
          </T>
          {liveUpdatedAt !== null && !file.refreshing ? (
            <Chip label="Updated" icon="radio-outline" bg={t.colors.accentSoft} fg={t.colors.accent} />
          ) : (
            <T variant="caption" color="textFaint">
              Read only
            </T>
          )}
        </View>
      ) : null}
      {data && change && changeColors ? (
        <Tap
          onPress={openInChanges}
          accessibilityRole="button"
          accessibilityLabel="Open in Changes"
          style={[
            styles.review,
            { backgroundColor: t.colors.surface, borderColor: t.colors.border, marginHorizontal: t.spacing.lg, borderRadius: t.radius.md },
          ]}
        >
          <Ionicons name="git-compare-outline" size={17} color={changeColors.fg} />
          <T variant="bodySmall" weight="500" style={{ flex: 1 }}>
            {capitalize(change.label)}{' '}
            <T variant="bodySmall" color="textMuted">
              · Review changes
            </T>
          </T>
          <Ionicons name="arrow-forward" size={17} color={t.colors.textMuted} />
        </Tap>
      ) : null}
      {data?.truncated ? (
        <Banner
          tone="warning"
          message={`Showing the first ${formatBytes(shownBytes)} of ${formatBytes(data.size)}. Open this file on your computer to read the rest.`}
          compact
        />
      ) : null}
      {file.error && data ? (
        <Banner tone="danger" message={file.error} actionLabel="Retry" onAction={() => void file.refresh()} compact />
      ) : null}

      {body}

      <Sheet visible={actionsOpen} onClose={() => setActionsOpen(false)} title={name} subtitle={path}>
        <View style={{ marginHorizontal: -t.spacing.lg }}>
          <ListRow
            title="Copy contents"
            subtitle={data?.truncated ? 'Only the loaded part of the file' : undefined}
            left={<ActionIcon name="copy-outline" />}
            disabled={!canCopy}
            onPress={() => {
              setActionsOpen(false);
              void copyContents();
            }}
          />
          <Divider inset={60} />
          <ListRow
            title="Copy path"
            subtitle={path}
            left={<ActionIcon name="link-outline" />}
            onPress={() => {
              setActionsOpen(false);
              void copyPath();
            }}
          />
          <Divider inset={60} />
          <ListRow
            title="Share…"
            left={<ActionIcon name="share-outline" />}
            disabled={!canCopy}
            onPress={() => {
              setActionsOpen(false);
              void share();
            }}
          />
          <Divider inset={60} />
          {change ? (
            <>
              <ListRow
                title="Open in Changes"
                subtitle={`${capitalize(change.label)} — show the diff`}
                left={<ActionIcon name="git-compare-outline" />}
                onPress={openInChanges}
              />
              <Divider inset={60} />
            </>
          ) : null}
          <ListRow
            title="Show in Files"
            subtitle={dir ? `${projectName}/${dir}` : projectName}
            left={<ActionIcon name="folder-open-outline" />}
            onPress={showInFiles}
          />
          <Divider inset={60} />
          <ListRow
            title="Reload file"
            subtitle={file.refreshing ? 'Refreshing…' : 'Get the latest version from your computer'}
            left={<ActionIcon name="refresh" />}
            onPress={() => {
              setActionsOpen(false);
              reload();
            }}
          />
        </View>
        <View style={{ paddingTop: 14, gap: 8 }}>
          <T variant="label">Text size</T>
          <Segmented options={FONT_OPTIONS} value={fontSize} onChange={setFontSize} />
        </View>
      </Sheet>
    </View>
  );
}

function ActionIcon({ name }: { name: React.ComponentProps<typeof Ionicons>['name'] }) {
  const t = useTheme();
  return (
    <View style={[styles.actionIcon, { backgroundColor: t.colors.surfaceAlt }]}>
      <Ionicons name={name} size={18} color={t.colors.textMuted} />
    </View>
  );
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function countLines(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return s.endsWith('\n') ? n - 1 : n;
}

/** UTF-8 byte length without TextEncoder (not guaranteed on every RN runtime). */
function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++; // skip the low surrogate
    } else bytes += 3;
  }
  return bytes;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 76,
  },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  review: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 12, marginBottom: 12, borderWidth: 1 },
  actionIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
