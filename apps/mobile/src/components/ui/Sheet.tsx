import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeInsets } from '../../lib/safeArea';
import { useTheme } from '../../theme/ThemeProvider';
import { shadow } from '../../theme';
import { useWebKeyboardInset } from '../chat/useKeyboardInset';
import { T } from './Text';
import { IconButton } from './IconButton';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  /** footer stays pinned while the body scrolls */
  footer?: React.ReactNode;
  maxHeightRatio?: number;
  dismissable?: boolean;
}

/**
 * Bottom sheet built on Modal + Animated so it works identically on iOS and web.
 * Body scrolls; footer (action buttons) stays pinned above the home indicator.
 *
 * Keyboard: an RN Modal is its own window on iOS, so neither the root KeyboardProvider nor a screen's
 * KeyboardShift reaches inside it. The sheet avoids the keyboard itself — RN's KeyboardAvoidingView
 * (padding) on iOS, the visualViewport-measured inset on web — so text fields and the footer buttons
 * stay visible while typing (rename, project search, …).
 */
export function Sheet({ visible, onClose, title, subtitle, children, footer, maxHeightRatio = 0.9, dismissable = true }: SheetProps) {
  const t = useTheme();
  const insets = useSafeInsets();
  const webInset = useWebKeyboardInset();
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  const { height: screenH, width: screenW } = useWindowDimensions();
  const wide = screenW >= 760;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(progress, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    } else if (mounted) {
      Animated.timing(progress, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, mounted, progress]);

  if (!mounted) return null;
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [screenH, 0] });

  return (
    <Modal visible transparent animationType="none" onRequestClose={dismissable ? onClose : undefined} statusBarTranslucent>
      <KeyboardAvoidingView
        style={[styles.root, wide ? { justifyContent: 'center', padding: 24 } : null, webInset > 0 ? { paddingBottom: webInset } : null]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Animated.View style={[styles.backdrop, { backgroundColor: t.colors.overlay, opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={dismissable ? onClose : undefined}
            accessibilityLabel="Close"
            accessibilityRole="button"
          />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: t.colors.bgElevated,
              borderTopLeftRadius: t.radius.xl,
              borderTopRightRadius: t.radius.xl,
              borderBottomLeftRadius: wide ? t.radius.xl : 0,
              borderBottomRightRadius: wide ? t.radius.xl : 0,
              borderWidth: 1,
              borderColor: t.colors.borderStrong,
              maxHeight: screenH * maxHeightRatio,
              paddingBottom: Math.max(insets.bottom, 12),
              transform: [{ translateY }],
              boxShadow: shadow(t, 0, -4, 16, 0.3),
            },
          ]}
        >
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: t.colors.borderStrong }]} />
          </View>
          {title ? (
            <View style={[styles.header, { paddingHorizontal: t.spacing.lg }]}>
              <View style={{ flex: 1 }}>
                <T variant="heading" accessibilityRole="header">
                  {title}
                </T>
                {subtitle ? (
                  <T variant="bodySmall" color="textMuted" numberOfLines={2}>
                    {subtitle}
                  </T>
                ) : null}
              </View>
              {dismissable ? <IconButton name="close" label="Close" onPress={onClose} size={20} /> : null}
            </View>
          ) : null}
          <ScrollView
            style={{ flexGrow: 0, flexShrink: 1 }}
            contentContainerStyle={{ paddingHorizontal: t.spacing.lg, paddingBottom: 8 }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? (
            <View
              style={{ paddingHorizontal: t.spacing.lg, paddingTop: 14, marginTop: 8, borderTopWidth: 1, borderTopColor: t.colors.border }}
            >
              {footer}
            </View>
          ) : null}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // flexShrink so the sheet (and its body ScrollView) gives way when the keyboard shrinks the available height
  sheet: { width: '100%', maxWidth: 720, alignSelf: 'center', elevation: 12, flexShrink: 1 },
  handleWrap: { alignItems: 'center', paddingTop: 12, paddingBottom: 8 },
  handle: { width: 36, height: 4, borderRadius: 2 },
  header: { flexDirection: 'row', alignItems: 'center', paddingBottom: 16, gap: 8 },
});
