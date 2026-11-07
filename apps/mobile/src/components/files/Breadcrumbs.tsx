/** Horizontal path crumbs: project root › folder › folder. The current folder is highlighted; `right` pins actions after the crumbs. */
import React, { useEffect, useMemo, useRef } from 'react';
import { ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { Chip } from '../ui/Chip';

export interface BreadcrumbsProps {
  rootName: string;
  /** relative folder path, '' for the project root */
  path: string;
  onNavigate: (path: string) => void;
  /** fixed controls at the trailing edge (hidden-files toggle, refresh) */
  right?: React.ReactNode;
}

export function Breadcrumbs({ rootName, path, onNavigate, right }: BreadcrumbsProps) {
  const t = useTheme();
  const ref = useRef<ScrollView>(null);
  const segments = useMemo(() => path.split('/').filter(Boolean), [path]);

  useEffect(() => {
    const id = setTimeout(() => ref.current?.scrollToEnd({ animated: true }), 40);
    return () => clearTimeout(id);
  }, [path]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <ScrollView
        ref={ref}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}
        contentContainerStyle={{ paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm, alignItems: 'center', gap: 2 }}
        keyboardShouldPersistTaps="handled"
      >
        <Chip label={rootName} icon="home-outline" size="md" selected={segments.length === 0} onPress={segments.length ? () => onNavigate('') : undefined} maxWidth={180} />
        {segments.map((segment, i) => {
          const isLast = i === segments.length - 1;
          const target = segments.slice(0, i + 1).join('/');
          return (
            <View key={target} style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              <Ionicons name="chevron-forward" size={13} color={t.colors.textFaint} />
              <Chip label={segment} size="md" selected={isLast} onPress={isLast ? undefined : () => onNavigate(target)} maxWidth={200} />
            </View>
          );
        })}
      </ScrollView>
      {right ? <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: t.spacing.sm, gap: 2 }}>{right}</View> : null}
    </View>
  );
}
