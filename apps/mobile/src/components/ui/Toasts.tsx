/**
 * Toast host + placement registry.
 *
 * Toasts float near the bottom of the screen, above whatever the current screen sits on (the tab bar,
 * the chat composer, the keyboard), so they never cover a large title or header controls. Screens
 * register the bottom edge of their content area with `useToastAnchor()`; the most recently mounted
 * registration wins, so a chat pushed over the tabs takes over and hands back when it unmounts.
 * Without any registration toasts sit just above the home indicator.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Keyboard, Platform, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { create } from 'zustand';
import { useToast, type Toast, type ToastKind } from '../../state/toast';
import { useSafeInsets } from '../../lib/safeArea';
import { useTheme } from '../../theme/ThemeProvider';
import { shadow } from '../../theme';
import { useWebKeyboardInset } from '../chat/useKeyboardInset';
import { T } from './Text';
import { Tap } from './Tap';

// ---------------------------------------------------------------------------- anchors
interface Anchor {
  id: number;
  /** distance from the bottom of the window to the top of the obstruction (tab bar, composer + keyboard) */
  bottom: number;
}

interface AnchorState {
  anchors: Anchor[];
  place: (id: number, bottom: number) => void;
  remove: (id: number) => void;
}

const useAnchors = create<AnchorState>((set) => ({
  anchors: [],
  place: (id, bottom) =>
    set((s) => {
      const idx = s.anchors.findIndex((a) => a.id === id);
      if (idx === -1) return { anchors: [...s.anchors, { id, bottom }] };
      if (s.anchors[idx]?.bottom === bottom) return s;
      const anchors = s.anchors.slice();
      anchors[idx] = { id, bottom };
      return { anchors };
    }),
  remove: (id) => set((s) => (s.anchors.some((a) => a.id === id) ? { anchors: s.anchors.filter((a) => a.id !== id) } : s)),
}));

let nextAnchorId = 1;

type Measurable = { measureInWindow?: (cb: (x: number, y: number, width: number, height: number) => void) => void };

export interface ToastAnchor {
  ref: React.RefObject<View | null>;
  onLayout: (e: LayoutChangeEvent) => void;
}

export interface ToastAnchorOptions {
  /** extra clearance above the measured edge, e.g. for a floating action button that lives inside the area */
  extraBottom?: number;
  /**
   * Tab screens stay mounted while another tab is showing; pass `useIsFocused()` so only the visible screen's
   * anchor is registered (default true — a stack screen owns the window while it is mounted).
   */
  enabled?: boolean;
}

/**
 * Attach `ref` + `onLayout` to the View whose bottom edge toasts should float above (the content area of
 * a tab screen, the timeline above a chat composer). Re-measures on every layout change, so the keyboard
 * opening or a suggestion panel growing moves the toasts with it.
 */
export function useToastAnchor(options: ToastAnchorOptions = {}): ToastAnchor {
  const { extraBottom = 0, enabled = true } = options;
  const id = useRef(0);
  if (id.current === 0) id.current = nextAnchorId++;
  const ref = useRef<View>(null);
  const { height: windowHeight } = useWindowDimensions();

  const measure = useCallback(() => {
    if (!enabled) return;
    const node = ref.current as (View & Measurable) | null;
    if (!node || typeof node.measureInWindow !== 'function') return;
    node.measureInWindow((_x, y, _w, h) => {
      if (!Number.isFinite(y) || !Number.isFinite(h)) return;
      useAnchors.getState().place(id.current, Math.max(0, Math.round(windowHeight - (y + h)) + extraBottom));
    });
  }, [windowHeight, extraBottom, enabled]);

  useEffect(() => {
    if (enabled) measure();
    else useAnchors.getState().remove(id.current);
  }, [measure, enabled]);
  useEffect(() => {
    const mine = id.current;
    return () => useAnchors.getState().remove(mine);
  }, []);

  return { ref, onLayout: measure };
}

/** Height of the on-screen keyboard over the window bottom (0 when hidden); web via visualViewport, native via RN events. */
function useKeyboardHeight(): number {
  const web = useWebKeyboardInset();
  const [native, setNative] = useState(0);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow', (e) => setNative(Math.max(0, e.endCoordinates.height)));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setNative(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return Platform.OS === 'web' ? web : native;
}

// ---------------------------------------------------------------------------- host
const ENTER_MS = 220;
const EXIT_MS = 160;
const GAP_ABOVE_ANCHOR = 12;
/**
 * Without a registered anchor we cannot tell whether a tab bar is present (a deep link straight into a tab
 * screen mounts nothing that registers one), so assume it is: floating a little high on a bare screen is
 * harmless, covering the tab bar is not.
 */
const UNANCHORED_CLEARANCE = 56;

interface Shown {
  toast: Toast;
  leaving: boolean;
}

export function Toasts() {
  const toasts = useToast((s) => s.toasts);
  const dismiss = useToast((s) => s.dismiss);
  const anchors = useAnchors((s) => s.anchors);
  const insets = useSafeInsets();
  const keyboard = useKeyboardHeight();
  const [shown, setShown] = useState<Shown[]>([]);

  // Keep dismissed toasts mounted for a moment so they can fade out instead of vanishing.
  useEffect(() => {
    setShown((prev) => {
      const live = new Set(toasts.map((t) => t.id));
      const next: Shown[] = prev.map((s) => (live.has(s.toast.id) || s.leaving ? s : { ...s, leaving: true }));
      for (const t of toasts) if (!prev.some((s) => s.toast.id === t.id)) next.push({ toast: t, leaving: false });
      return next;
    });
  }, [toasts]);

  const onGone = useCallback((id: string) => setShown((prev) => (prev.some((s) => s.toast.id === id) ? prev.filter((s) => s.toast.id !== id) : prev)), []);

  if (!shown.length) return null;
  const anchored = anchors.length ? anchors[anchors.length - 1]!.bottom : insets.bottom + UNANCHORED_CLEARANCE;
  // Never below the keyboard: a screen that did not re-measure (or has no anchor) would otherwise hide its toasts behind it.
  const anchor = Math.max(anchored, keyboard);

  return (
    <View pointerEvents="box-none" style={[styles.host, { bottom: anchor + GAP_ABOVE_ANCHOR }]} accessibilityLiveRegion="polite">
      {shown.map((s) => (
        <ToastItem key={s.toast.id} toast={s.toast} leaving={s.leaving} onDismiss={() => dismiss(s.toast.id)} onGone={onGone} />
      ))}
    </View>
  );
}

function iconFor(kind: ToastKind): React.ComponentProps<typeof Ionicons>['name'] {
  switch (kind) {
    case 'error':
      return 'alert-circle';
    case 'success':
      return 'checkmark-circle';
    default:
      return 'information-circle';
  }
}

function ToastItem({ toast, leaving, onDismiss, onGone }: { toast: Toast; leaving: boolean; onDismiss: () => void; onGone: (id: string) => void }) {
  const t = useTheme();
  const c = t.colors;
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.timing(progress, {
      toValue: leaving ? 0 : 1,
      duration: leaving ? EXIT_MS : ENTER_MS,
      easing: leaving ? Easing.in(Easing.quad) : Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    anim.start(({ finished }) => {
      if (leaving && finished) onGone(toast.id);
    });
    // Never strand a leaving toast if the animation is interrupted.
    const fallback = leaving ? setTimeout(() => onGone(toast.id), EXIT_MS + 80) : null;
    return () => {
      anim.stop();
      if (fallback) clearTimeout(fallback);
    };
  }, [leaving, progress, onGone, toast.id]);

  const fg = toast.kind === 'error' ? c.danger : toast.kind === 'success' ? c.success : c.accent;
  return (
    <Animated.View
      pointerEvents={leaving ? 'none' : 'auto'}
      style={{ opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }}
    >
      <Tap
        onPress={onDismiss}
        pressedColor={null}
        pressedStyle={{ opacity: 0.85 }}
        accessibilityRole={toast.kind === 'error' ? 'alert' : 'text'}
        accessibilityLabel={toast.message}
        accessibilityHint="Tap to dismiss"
        style={[
          styles.toast,
          {
            backgroundColor: c.bgElevated,
            borderColor: c.border,
            borderRadius: t.radius.lg,
            boxShadow: shadow(t, 0, 6, 16, 0.35),
          },
        ]}
      >
        <Ionicons name={iconFor(toast.kind)} size={18} color={fg} />
        <T variant="bodySmall" style={{ flexShrink: 1 }} numberOfLines={2}>
          {toast.message}
        </T>
        {toast.actionLabel && toast.onAction ? (
          <Tap
            onPress={() => {
              toast.onAction?.();
              onDismiss();
            }}
            pressedColor={null}
            accessibilityRole="button"
            accessibilityLabel={toast.actionLabel}
            style={styles.action}
          >
            <T variant="bodySmall" weight="700" color="accent">
              {toast.actionLabel}
            </T>
          </Tap>
        ) : null}
      </Tap>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: 8 },
  toast: {
    maxWidth: 520,
    marginHorizontal: 16,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    elevation: 8,
  },
  action: { paddingHorizontal: 6, paddingVertical: 4, marginRight: -4 },
});
