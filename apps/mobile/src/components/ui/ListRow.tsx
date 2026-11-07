import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from './Text';
import { Tap } from './Tap';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
  mono?: boolean;
  titleLines?: number;
  subtitleLines?: number;
  disabled?: boolean;
  testID?: string;
}

export function ListRow({ title, subtitle, left, right, chevron, onPress, onLongPress, style, mono, titleLines = 1, subtitleLines = 1, disabled, testID }: ListRowProps) {
  const t = useTheme();
  const body = (
    <View style={[styles.row, { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md, opacity: disabled ? 0.5 : 1 }, style]}>
      {left ? <View style={{ marginRight: t.spacing.md }}>{left}</View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant={mono ? 'mono' : 'body'} numberOfLines={titleLines} weight="500">
          {title}
        </T>
        {subtitle ? (
          <T variant="bodySmall" color="textMuted" numberOfLines={subtitleLines} style={{ marginTop: 2 }}>
            {subtitle}
          </T>
        ) : null}
      </View>
      {right ? <View style={{ marginLeft: t.spacing.sm }}>{right}</View> : null}
      {chevron ? <Ionicons name="chevron-forward" size={18} color={t.colors.textFaint} style={{ marginLeft: 6 }} /> : null}
    </View>
  );
  if (!onPress && !onLongPress) return body;
  return (
    <Tap onPress={onPress} onLongPress={onLongPress} disabled={disabled} accessibilityRole="button" testID={testID}>
      {body}
    </Tap>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', minHeight: 56 } });
