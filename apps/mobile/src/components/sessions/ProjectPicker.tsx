import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ProjectInfo } from '@mobile-ide/core';
import { basename, pluralize, relativeTime } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { api } from '../../state/api';
import { useProjects } from '../../state/projects';
import { useTheme } from '../../theme/ThemeProvider';
import { Button, Card, Chip, ErrorView, IconButton, ListRow, LoadingView, SectionHeader, Sheet, T, Tap, TextField } from '../ui';
import { PathText } from '../files/PathText';

/** `root` + a root-relative folder path (as returned by /api/fs/tree) → absolute cwd. */
export function joinCwd(root: string, rel: string): string {
  const r = root.replace(/\/+$/, '');
  const p = rel.replace(/^\/+|\/+$/g, '');
  if (!p) return r || '/';
  return `${r}/${p}`;
}

function FolderIcon({ isGit, tint }: { isGit?: boolean; tint?: string }) {
  const t = useTheme();
  return (
    <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: t.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={isGit ? 'git-branch-outline' : 'folder-outline'} size={17} color={tint ?? t.colors.textMuted} />
    </View>
  );
}

/** Tappable summary of the chosen working directory (name, absolute path, branch). */
export function ProjectField({ value, onPress, disabled }: { value: string | null; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  const project = useProjects((s) => (value ? s.projects.find((p) => p.root === value) : undefined));
  const name = value ? project?.name ?? basename(value) : null;
  return (
    <Card padded={false}>
      <Tap
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={value ? `Project ${name}, ${value}. Change` : 'Choose a project'}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: t.radius.lg, opacity: disabled ? 0.6 : 1 }}
      >
        <FolderIcon isGit={project?.isGit} tint={value ? t.colors.accent : undefined} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }} color={value ? 'text' : 'textMuted'}>
              {name ?? 'Choose a project'}
            </T>
            {project?.branch ? <Chip label={project.branch} icon="git-branch-outline" mono maxWidth={150} /> : null}
          </View>
          <T variant={value ? 'monoSmall' : 'caption'} color="textFaint" numberOfLines={2} style={{ marginTop: 2 }}>
            {value ?? 'The agent reads and edits files in this folder'}
          </T>
        </View>
        <Ionicons name="chevron-forward" size={18} color={t.colors.textFaint} />
      </Tap>
    </Card>
  );
}

export interface ProjectPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  value: string | null;
  onChange: (cwd: string) => void;
}

const RECENT_LIMIT = 6;

/**
 * Project chooser: recent projects (by last session), all discovered repos, folder browsing
 * inside any project (via /api/fs/tree), and a typed absolute path for anything else.
 */
export function ProjectPickerSheet({ visible, onClose, value, onChange }: ProjectPickerSheetProps) {
  const t = useTheme();
  const projects = useProjects((s) => s.projects);
  const loading = useProjects((s) => s.loading);
  const loaded = useProjects((s) => s.loaded);
  const error = useProjects((s) => s.error);
  const load = useProjects((s) => s.load);
  const [query, setQuery] = useState('');
  const [browse, setBrowse] = useState<{ root: ProjectInfo; path: string } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      void load();
    } else {
      setBrowse(null);
      setQuery('');
      setCustomOpen(false);
      setCustomError(null);
    }
  }, [visible, load]);

  const choose = (cwd: string) => {
    onChange(cwd);
    onClose();
  };

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.root.toLowerCase().includes(q)) : projects),
    [projects, q],
  );
  const { recent, others } = useMemo(() => {
    const recent = filtered
      .filter((p) => (p.lastUsedAt ?? 0) > 0 || p.sessionCount > 0)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .slice(0, RECENT_LIMIT);
    const ids = new Set(recent.map((p) => p.root));
    const others = filtered.filter((p) => !ids.has(p.root)).sort((a, b) => a.name.localeCompare(b.name));
    return { recent, others };
  }, [filtered]);

  const submitCustom = () => {
    const v = custom.trim();
    if (!/^(~(\/|$)|\/)/.test(v)) {
      setCustomError('Enter an absolute path (starting with / or ~).');
      return;
    }
    choose(v.length > 1 ? v.replace(/\/+$/, '') : v);
  };

  const renderProject = (p: ProjectInfo) => {
    const selected = p.root === value;
    const meta = [p.sessionCount ? pluralize(p.sessionCount, 'session') : null, p.lastUsedAt ? `used ${relativeTime(p.lastUsedAt)}` : null].filter(Boolean).join(' · ');
    return (
      <View key={p.root} style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Tap
          onPress={() => choose(p.root)}
          accessibilityRole="button"
          accessibilityState={{ selected }}
          accessibilityLabel={`${p.name}, ${p.root}${p.branch ? `, branch ${p.branch}` : ''}`}
          style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingRight: 6, borderRadius: t.radius.md }}
        >
          <FolderIcon isGit={p.isGit} tint={selected ? t.colors.accent : undefined} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>
                {p.name}
              </T>
              {p.branch ? <Chip label={p.branch} icon="git-branch-outline" mono maxWidth={140} /> : null}
            </View>
            <PathText path={p.root} variant="monoSmall" color="textFaint" />
            {meta ? (
              <T variant="caption" color="textMuted" numberOfLines={1}>
                {meta}
              </T>
            ) : null}
          </View>
          {selected ? <Ionicons name="checkmark-circle" size={20} color={t.colors.accent} /> : null}
        </Tap>
        <IconButton name="folder-open-outline" label={`Browse folders inside ${p.name}`} onPress={() => setBrowse({ root: p, path: '' })} size={20} color={t.colors.textMuted} />
      </View>
    );
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={browse ? 'Choose a folder' : 'Project'}
      subtitle={browse ? joinCwd(browse.root.root, browse.path) : 'The agent works inside this folder'}
      maxHeightRatio={0.92}
    >
      {browse ? (
        <FolderBrowser root={browse.root} path={browse.path} onNavigate={(path) => setBrowse({ root: browse.root, path })} onBack={() => setBrowse(null)} onChoose={choose} />
      ) : (
        <View style={{ paddingBottom: 8 }}>
          <TextField
            value={query}
            onChangeText={setQuery}
            placeholder="Filter by name or path"
            returnKeyType="search"
            right={query ? <IconButton name="close-circle" label="Clear filter" onPress={() => setQuery('')} size={18} color={t.colors.textFaint} /> : <Ionicons name="search" size={18} color={t.colors.textFaint} />}
          />
          {loading && !loaded ? <LoadingView compact label="Scanning your projects…" /> : null}
          {error && !projects.length ? <ErrorView compact title="Couldn't list projects" message={error} onRetry={() => void load()} /> : null}
          {error && projects.length ? (
            <T variant="caption" color="warning" style={{ marginTop: 8 }}>
              Couldn't refresh the list: {error}
            </T>
          ) : null}
          {loaded && !error && !projects.length ? (
            <T variant="bodySmall" color="textMuted" style={{ marginTop: 12 }}>
              No git repositories were found under the daemon's project roots. You can still type a folder path below.
            </T>
          ) : null}
          {recent.length ? (
            <>
              <SectionHeader title="Recent" style={{ paddingHorizontal: 0 }} />
              {recent.map(renderProject)}
            </>
          ) : null}
          {others.length ? (
            <>
              <SectionHeader
                title={recent.length ? 'All projects' : 'Projects'}
                style={{ paddingHorizontal: 0 }}
                right={
                  <T variant="caption" color="textFaint">
                    {others.length}
                  </T>
                }
              />
              {others.map(renderProject)}
            </>
          ) : null}
          {q && !filtered.length && projects.length ? (
            <T variant="bodySmall" color="textMuted" align="center" style={{ paddingVertical: 16 }}>
              No project matches “{query.trim()}”.
            </T>
          ) : null}
          <SectionHeader title="Other folder" style={{ paddingHorizontal: 0 }} />
          {customOpen ? (
            <View style={{ gap: 10 }}>
              <TextField
                mono
                value={custom}
                onChangeText={(v) => {
                  setCustom(v);
                  setCustomError(null);
                }}
                placeholder="/home/you/projects/app"
                error={customError}
                hint="Must be inside the daemon's allowed project roots."
                autoFocus
                returnKeyType="go"
                onSubmitEditing={submitCustom}
              />
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                <Button title="Cancel" variant="secondary" size="sm" onPress={() => setCustomOpen(false)} />
                <Button title="Use this path" size="sm" icon="checkmark" onPress={submitCustom} disabled={!custom.trim()} />
              </View>
            </View>
          ) : (
            <ListRow title="Enter a path…" subtitle="Any folder inside the allowed roots" left={<FolderIcon />} chevron onPress={() => setCustomOpen(true)} style={{ paddingHorizontal: 0 }} />
          )}
        </View>
      )}
    </Sheet>
  );
}

const MAX_DIRS = 300;

function FolderBrowser({
  root,
  path,
  onNavigate,
  onBack,
  onChoose,
}: {
  root: ProjectInfo;
  path: string;
  onNavigate: (path: string) => void;
  onBack: () => void;
  onChoose: (cwd: string) => void;
}) {
  const t = useTheme();
  const tree = useAsync(() => api.fsTree(root.root, path), [root.root, path]);
  const [filter, setFilter] = useState('');
  useEffect(() => setFilter(''), [path]);

  const dirs = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (tree.data ?? [])
      .filter((e) => e.kind === 'dir' && !e.name.startsWith('.') && e.name !== 'node_modules')
      .filter((e) => !f || e.name.toLowerCase().includes(f))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tree.data, filter]);

  const segments = path.split('/').filter(Boolean);
  const cwd = joinCwd(root.root, path);
  const leaf = segments[segments.length - 1] ?? root.name;

  return (
    <View style={{ gap: 12, paddingBottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
        <Chip label="Projects" icon="arrow-back" size="md" onPress={onBack} />
        <Ionicons name="chevron-forward" size={14} color={t.colors.textFaint} />
        <Chip label={root.name} size="md" selected={segments.length === 0} onPress={() => onNavigate('')} maxWidth={180} />
        {segments.map((seg, i) => (
          <React.Fragment key={`${i}:${seg}`}>
            <Ionicons name="chevron-forward" size={14} color={t.colors.textFaint} />
            <Chip label={seg} size="md" selected={i === segments.length - 1} onPress={() => onNavigate(segments.slice(0, i + 1).join('/'))} maxWidth={180} />
          </React.Fragment>
        ))}
      </View>
      <Button title={`Use “${leaf}”`} icon="checkmark" full onPress={() => onChoose(cwd)} accessibilityLabel={`Use folder ${cwd}`} />
      <TextField value={filter} onChangeText={setFilter} placeholder="Filter folders" returnKeyType="search" right={<Ionicons name="search" size={18} color={t.colors.textFaint} />} />
      {tree.loading ? (
        <LoadingView compact />
      ) : tree.error ? (
        <ErrorView compact title="Couldn't read this folder" message={tree.error} onRetry={() => void tree.reload()} />
      ) : dirs.length === 0 ? (
        <T variant="bodySmall" color="textMuted" align="center" style={{ paddingVertical: 16 }}>
          {filter ? 'No folder matches.' : 'No subfolders here — use the button above to pick this folder.'}
        </T>
      ) : (
        <View style={{ marginHorizontal: -t.spacing.lg }}>
          {dirs.slice(0, MAX_DIRS).map((d) => (
            <ListRow
              key={d.path}
              title={d.name}
              left={<FolderIcon />}
              right={d.gitStatus ? <Chip label={d.gitStatus} mono /> : undefined}
              chevron
              onPress={() => onNavigate(d.path)}
            />
          ))}
          {dirs.length > MAX_DIRS ? (
            <T variant="caption" color="textFaint" align="center" style={{ paddingVertical: 10 }}>
              Showing {MAX_DIRS} of {dirs.length} folders — type to filter.
            </T>
          ) : null}
        </View>
      )}
    </View>
  );
}
