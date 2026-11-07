/** One project context for Files, Changes and Terminal. */
import { useEffect } from 'react';
import { View } from 'react-native';
import { useProjects, useSelectedProject } from '../../state/projects';
import { ProjectPickerButton } from '../files/ProjectPicker';

export { ProjectPickerSheet } from '../files/ProjectPicker';

export function useEnsureProjects(): void {
  const loaded = useProjects((s) => s.loaded);
  const loading = useProjects((s) => s.loading);
  const load = useProjects((s) => s.load);
  useEffect(() => {
    if (!loaded && !loading) void load();
  }, [loaded, loading, load]);
}

export function ProjectChip({
  onPress,
  maxWidth = '100%',
  compact,
}: {
  onPress: () => void;
  maxWidth?: number | `${number}%`;
  compact?: boolean;
}) {
  const project = useSelectedProject();
  return (
    <View style={{ width: '100%', maxWidth, minWidth: 0 }}>
      <ProjectPickerButton project={project} onPress={onPress} compact={compact} />
    </View>
  );
}
