import React, { forwardRef, useState } from 'react';
import { Platform, StyleSheet, TextInput, View, type TextInputProps, type TextStyle } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from './Text';

export interface TextFieldProps extends TextInputProps {
  label?: string;
  hint?: string;
  error?: string | null;
  mono?: boolean;
  right?: React.ReactNode;
}

/**
 * The browser draws its focus ring on the inner <input>, which ends before the `right` slot and clashes with the
 * palette; the rounded container paints the focus state instead (same on native, where there is no ring at all).
 */
const webNoOutline: TextStyle | null = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null;

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, hint, error, mono, right, style, onFocus, onBlur, ...rest },
  ref,
) {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      {label ? <T variant="label">{label}</T> : null}
      <View
        style={[
          styles.box,
          {
            backgroundColor: t.colors.surface,
            borderColor: error ? t.colors.danger : focused ? t.colors.accent : t.colors.border,
            borderWidth: 1,
            borderRadius: t.radius.md,
          },
        ]}
      >
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          placeholderTextColor={t.colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          {...rest}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, webNoOutline, { color: t.colors.text, fontFamily: mono ? t.font.mono : t.font.sans, fontSize: 16 }, style]}
        />
        {right ? <View style={{ marginRight: 8 }}>{right}</View> : null}
      </View>
      {error ? (
        <T variant="caption" color="danger" accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : hint ? (
        <T variant="caption" color="textFaint">
          {hint}
        </T>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', minHeight: 52 },
  input: { flex: 1, minWidth: 0, paddingHorizontal: 14, paddingVertical: 13, minHeight: 52 },
});
