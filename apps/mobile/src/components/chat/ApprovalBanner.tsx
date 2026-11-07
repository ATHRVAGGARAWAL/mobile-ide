import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { describeTool, type ElicitationRequest, type PermissionRequest } from '@mobile-ide/core';
import { shadow } from '../../theme';
import { useTheme } from '../../theme/ThemeProvider';
import { IconButton, T, Tap } from '../ui';

export type AttentionRequest =
  { kind: 'permission'; id: string; request: PermissionRequest } | { kind: 'elicitation'; id: string; request: ElicitationRequest };

export interface ApprovalBannerProps {
  requests: AttentionRequest[];
  onReview: (item: AttentionRequest) => void;
  onLocate: (item: AttentionRequest) => void;
}

/** Questions and approvals remain reachable when their timeline cards leave the viewport. */
export function ApprovalBanner({ requests, onReview, onLocate }: ApprovalBannerProps) {
  const t = useTheme();
  const c = t.colors;
  const visible = requests.length > 0;
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  const last = useRef<AttentionRequest | undefined>(requests[0]);
  if (requests[0]) last.current = requests[0];
  useEffect(() => {
    if (visible) setMounted(true);
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 200 : 150,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [visible, progress]);
  const first = requests[0] ?? last.current;
  if (!mounted || !first) return null;
  const question = first.kind === 'elicitation';
  const title =
    requests.length > 1 ? `${requests.length} requests are waiting` : question ? 'Your answer is needed' : 'Your approval is needed';
  const detail =
    first.kind === 'permission'
      ? describeTool(first.request.title, first.request.kind ?? 'other', first.request.rawInput)
      : first.request.message;
  return (
    <Animated.View
      pointerEvents={visible ? 'box-none' : 'none'}
      style={[
        styles.wrap,
        { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }] },
      ]}
    >
      <View
        style={[
          styles.card,
          { backgroundColor: c.bgElevated, borderColor: c.accent, borderRadius: t.radius.lg, boxShadow: shadow(t, 0, 4, 14, 0.3) },
        ]}
      >
        <Tap
          onPress={() => onReview(first)}
          haptics
          accessibilityRole="button"
          accessibilityLabel={`${title}: ${detail}. ${question ? 'Answer' : 'Review'}`}
          style={styles.main}
        >
          <View style={[styles.icon, { backgroundColor: c.accentSoft }]}>
            <Ionicons name={question ? 'chatbubble-ellipses-outline' : 'hand-left-outline'} size={18} color={c.accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <T variant="bodySmall" weight="600" numberOfLines={1}>
              {title}
            </T>
            <T variant="caption" color="textMuted" numberOfLines={1}>
              {detail}
            </T>
          </View>
          <T variant="caption" weight="700" color="accent">
            {question ? 'Answer' : 'Review'}
          </T>
        </Tap>
        <IconButton name="locate-outline" label="Scroll to the request" onPress={() => onLocate(first)} size={18} color={c.textMuted} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 10, left: 16, right: 16, alignItems: 'center' },
  card: {
    width: '100%',
    maxWidth: 720,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingRight: 4,
    overflow: 'hidden',
    elevation: 6,
  },
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingLeft: 12,
    paddingRight: 4,
    minHeight: 64,
  },
  icon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
});
