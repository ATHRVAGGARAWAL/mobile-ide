import React from 'react';
import { Platform, Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { haptic } from '../../lib/haptics';
import { useTheme } from '../../theme/ThemeProvider';

export interface TapProps extends Omit<PressableProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  pressedStyle?: StyleProp<ViewStyle>;
  /** background tint while pressed (defaults to theme surfacePressed) */
  pressedColor?: string | null;
  haptics?: boolean;
  children?: React.ReactNode;
}

/** Pressable with a consistent pressed state, hit slop and optional haptic. */
export function Tap({
  style,
  pressedStyle,
  pressedColor,
  haptics = false,
  onPress,
  children,
  hitSlop = 4,
  accessibilityState,
  disabled,
  ...rest
}: TapProps) {
  const t = useTheme();
  const tint = pressedColor === undefined ? t.colors.surfacePressed : pressedColor;
  // RN Web accepts individual ARIA states; it does not translate native accessibilityState.
  const webState: Partial<PressableProps> =
    Platform.OS === 'web'
      ? {
          'aria-busy': accessibilityState?.busy,
          'aria-checked': accessibilityState?.checked,
          'aria-expanded': accessibilityState?.expanded,
          ...(rest.accessibilityRole === 'button' || rest.role === 'button'
            ? { 'aria-pressed': accessibilityState?.selected }
            : { 'aria-selected': accessibilityState?.selected }),
        }
      : {};
  return (
    <Pressable
      {...webState}
      accessibilityState={accessibilityState}
      disabled={disabled ?? accessibilityState?.disabled}
      hitSlop={hitSlop}
      onPress={(e) => {
        if (haptics) void haptic.light();
        onPress?.(e);
      }}
      style={({ pressed }) => [style, pressed ? [tint ? { backgroundColor: tint } : { opacity: 0.6 }, pressedStyle] : null]}
      {...rest}
    >
      {children}
    </Pressable>
  );
}
