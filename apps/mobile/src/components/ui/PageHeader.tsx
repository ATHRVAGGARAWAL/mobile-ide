import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from './Text';

/** Screen identity is separate from its project selector and tools. Safe areas belong to Screen. */
export function PageHeader({
  eyebrow = 'Workspace',
  title,
  subtitle,
  right,
  children,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const t = useTheme();
  return (
    <View style={{ paddingHorizontal: t.spacing.lg, paddingTop: 20, paddingBottom: 18, gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
          {eyebrow ? (
            <T variant="label" color="textFaint">
              {eyebrow}
            </T>
          ) : null}
          <T variant="display" accessibilityRole="header">
            {title}
          </T>
        </View>
        {right}
      </View>
      {subtitle ? (
        <T variant="bodySmall" color="textMuted" style={{ marginTop: -6 }}>
          {subtitle}
        </T>
      ) : null}
      {children}
    </View>
  );
}

export function BrandMark({ size = 36 }: { size?: number }) {
  const t = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        backgroundColor: t.colors.accentSoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <T variant="mono" color="accent" weight="700" style={{ fontSize: size * 0.42, lineHeight: size * 0.6, letterSpacing: -2 }}>
        {'>_'}
      </T>
    </View>
  );
}
