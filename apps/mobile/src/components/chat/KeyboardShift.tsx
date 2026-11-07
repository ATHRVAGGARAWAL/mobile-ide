import React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

// Lazy so the web bundle never touches the native keyboard module; on native the root layout mounts KeyboardProvider.
const KC =
  Platform.OS === 'web'
    ? null
    : // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('react-native-keyboard-controller') as typeof import('react-native-keyboard-controller'));

export interface KeyboardShiftProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** web only: pixels of the layout viewport covered by the keyboard (see useWebKeyboardInset) */
  webInset: number;
}

/** Keeps the composer above the keyboard on every platform. */
export function KeyboardShift({ children, style, webInset }: KeyboardShiftProps) {
  if (!KC) {
    return <View style={[{ flex: 1 }, style, { paddingBottom: webInset }]}>{children}</View>;
  }
  const { KeyboardAvoidingView } = KC;
  return (
    <KeyboardAvoidingView behavior="padding" style={[{ flex: 1 }, style]}>
      {children}
    </KeyboardAvoidingView>
  );
}
