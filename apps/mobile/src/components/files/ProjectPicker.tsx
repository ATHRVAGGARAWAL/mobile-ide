/** Project context shared by Files, Changes and Terminal, with a searchable project sheet. */
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ProjectInfo } from '@mobile-ide/core';
import { useProjects } from '../../state/projects';
import { useTheme } from '../../theme/ThemeProvider';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { EmptyState } from '../ui/EmptyState';
import { ListRow } from '../ui/ListRow';
import { Divider } from '../ui/Misc';
import { Sheet } from '../ui/Sheet';
import { ErrorView } from '../ui/StatusView';
import { SkeletonRows } from './Skeleton';
import { Tap } from '../ui/Tap';
import { T } from '../ui/Text';
import { TextField } from '../ui/TextField';
import { PathText } from './PathText';

export interface ProjectPickerButtonProps {
  project: ProjectInfo | null;
  onPress: () => void;
  compact?: boolean;
}

export function ProjectPickerButton({ project, onPress, compact }: ProjectPickerButtonProps) {
  const t = useTheme();
  return (
    <Tap
      onPress={onPress}
      haptics
      accessibilityRole="button"
      accessibilityLabel={project ? `Project ${project.name}. Change project` : 'Choose project'}
      testID="workspace-project"
      style={[
        styles.pill,
        { backgroundColor: t.colors.surface, borderColor: t.colors.border, borderRadius: t.radius.lg },
        compact ? styles.compact : null,
      ]}
    >
      <View style={[styles.iconBox, { backgroundColor: t.colors.surfaceAlt }]}>
        <Ionicons name="folder-open-outline" size={19} color={t.colors.text} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <T variant="bodySmall" weight="600" numberOfLines={1}>
          {project?.name ?? 'Choose a project'}
        </T>
        {!compact ? (
          project?.branch ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="git-branch-outline" size={12} color={t.colors.textMuted} />
              <T variant="monoSmall" color="textMuted" numberOfLines={1} style={{ flex: 1 }}>
                {project.branch}
              </T>
            </View>
          ) : (
            <PathText path={project?.root ?? 'Your workspace on this computer'} color="textMuted" />
          )
        ) : null}
      </View>
      <Ionicons name="chevron-down" size={16} color={t.colors.textMuted} />
    </Tap>
  );
}

export interface ProjectPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelect?: (project: ProjectInfo) => void;
}

export function ProjectPickerSheet({ visible, onClose, onSelect }: ProjectPickerSheetProps) {
  const t = useTheme();
  const projects = useProjects((s) => s.projects);
  const loading = useProjects((s) => s.loading);
  const loaded = useProjects((s) => s.loaded);
  const error = useProjects((s) => s.error);
  const selectedRoot = useProjects((s) => s.selectedRoot);
  const select = useProjects((s) => s.select);
  const load = useProjects((s) => s.load);
  const [query, setQuery] = useState('');

  useEffect(() => {
    // Discover repositories added since the last visit, even when a list is already loaded.
    if (visible) void load();
    if (!visible) setQuery('');
  }, [visible, load]);

  const sorted = useMemo(
    () =>
      projects
        .filter((p) => `${p.name} ${p.root}`.toLowerCase().includes(query.trim().toLowerCase()))
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.sessionCount - a.sessionCount || a.name.localeCompare(b.name)),
    [projects, query],
  );

  let body: React.ReactNode;
  if (!loaded && loading) body = <SkeletonRows rows={4} testID="projects-skeleton" style={{ marginHorizontal: -t.spacing.lg }} />;
  else if (error && projects.length === 0) body = <ErrorView message={error} onRetry={() => void load()} compact />;
  else if (projects.length === 0) {
    body = (
      <EmptyState
        compact
        icon="folder-open-outline"
        title="No projects"
        message="Connect a project from your computer to start browsing here."
        action={{ title: 'Refresh', onPress: () => void load(), icon: 'refresh', loading }}
      />
    );
  } else {
    body = (
      <View style={{ marginHorizontal: -t.spacing.lg }}>
        {error ? (
          <T variant="caption" color="danger" style={{ paddingHorizontal: t.spacing.lg, paddingBottom: 6 }}>
            Couldn't refresh: {error}
          </T>
        ) : null}
        {sorted.length === 0 ? (
          <EmptyState compact icon="search-outline" title="No matching projects" message="Try a project name or part of its path." />
        ) : null}
        {sorted.map((p, i) => {
          const selected = p.root === selectedRoot;
          return (
            <React.Fragment key={p.root}>
              {i > 0 ? <Divider inset={60} /> : null}
              <ListRow
                title={p.name}
                subtitle={p.root}
                left={
                  <View style={[styles.iconBox, { backgroundColor: selected ? t.colors.accentSoft : t.colors.surfaceAlt }]}>
                    <Ionicons
                      name={selected ? 'folder-open' : 'folder-outline'}
                      size={18}
                      color={selected ? t.colors.accent : t.colors.textMuted}
                    />
                  </View>
                }
                right={
                  <View style={styles.rowRight}>
                    {p.branch ? <Chip label={p.branch} icon="git-branch-outline" mono maxWidth={110} /> : null}
                    {selected ? <Ionicons name="checkmark" size={18} color={t.colors.accent} /> : null}
                  </View>
                }
                onPress={() => {
                  select(p.root);
                  onSelect?.(p);
                  onClose();
                }}
                testID={`project-${p.name}`}
              />
            </React.Fragment>
          );
        })}
      </View>
    );
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Your projects"
      subtitle="Files, changes and terminal stay together."
      footer={<Button title="Refresh projects" variant="secondary" icon="refresh" full loading={loading} onPress={() => void load()} />}
    >
      {projects.length > 3 ? (
        <View style={{ marginBottom: 12 }}>
          <TextField value={query} onChangeText={setQuery} placeholder="Find a project" autoCapitalize="none" />
        </View>
      ) : null}
      {body}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: 64,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    width: '100%',
  },
  compact: { flexShrink: 1, minWidth: 0, maxWidth: '100%', minHeight: 48, paddingVertical: 7 },
  iconBox: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
