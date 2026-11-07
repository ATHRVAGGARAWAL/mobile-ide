import React, { useRef } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { haptic } from '../../lib/haptics';
import { T, Tap } from '../ui';

export interface SwipeAction {
  key: string;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  bg: string;
  fg: string;
  onPress: () => void;
}

export interface SwipeableRowProps {
  children: React.ReactNode;
  /** revealed by swiping left (rendered on the right edge) */
  actions: SwipeAction[];
  enabled?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
}

export const SWIPE_ACTION_WIDTH = 76;

/**
 * Row wrapper that reveals action buttons on a left swipe. The panel closes itself
 * before invoking the action so the row is back in place when a sheet opens above it.
 */
export function SwipeableRow({ children, actions, enabled = true, containerStyle }: SwipeableRowProps) {
  const ref = useRef<SwipeableMethods>(null);
  if (!actions.length || !enabled) return <View style={containerStyle}>{children}</View>;
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={2}
      rightThreshold={SWIPE_ACTION_WIDTH / 2}
      overshootRight={false}
      enableTrackpadTwoFingerGesture
      containerStyle={containerStyle}
      onSwipeableWillOpen={() => void haptic.selection()}
      renderRightActions={() => (
        <View style={styles.panel}>
          {actions.map((a) => (
            <Tap
              key={a.key}
              onPress={() => {
                ref.current?.close();
                a.onPress();
              }}
              pressedColor={null}
              pressedStyle={{ opacity: 0.75 }}
              style={[styles.action, { backgroundColor: a.bg }]}
              accessibilityRole="button"
              accessibilityLabel={a.label}
            >
              <Ionicons name={a.icon} size={20} color={a.fg} />
              <T style={{ color: a.fg, fontSize: 12, fontWeight: '600', marginTop: 4 }} numberOfLines={1}>
                {a.label}
              </T>
            </Tap>
          ))}
        </View>
      )}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create({
  panel: { flexDirection: 'row', alignItems: 'stretch' },
  action: { width: SWIPE_ACTION_WIDTH, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
});
