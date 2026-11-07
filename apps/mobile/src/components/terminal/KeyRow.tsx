/**
 * Accessory key row for the terminal: keys a phone keyboard lacks. Emits raw byte sequences
 * through `onKey`; the Ctrl chip is a one-shot modifier mirrored from the DOM terminal.
 * Arrow keys auto-repeat while held. The row scrolls horizontally; a fade on either edge hints
 * at keys hidden beyond it (and disappears once that edge is reached).
 */
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { haptic } from '../../lib/haptics';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from '../ui';

export interface KeyDef {
  label: string;
  /** bytes to send; omitted for the Ctrl modifier */
  seq?: string;
  ctrl?: boolean;
  /** auto-repeat while held (arrows) */
  repeat?: boolean;
  a11y: string;
}

export const TERMINAL_KEYS: KeyDef[] = [
  { label: 'esc', seq: '\x1b', a11y: 'Escape' },
  { label: 'tab', seq: '\t', a11y: 'Tab' },
  { label: 'ctrl', ctrl: true, a11y: 'Control modifier' },
  { label: '^C', seq: '\x03', a11y: 'Control C, interrupt' },
  { label: '^D', seq: '\x04', a11y: 'Control D, end of input' },
  { label: '↑', seq: '\x1b[A', repeat: true, a11y: 'Arrow up' },
  { label: '↓', seq: '\x1b[B', repeat: true, a11y: 'Arrow down' },
  { label: '←', seq: '\x1b[D', repeat: true, a11y: 'Arrow left' },
  { label: '→', seq: '\x1b[C', repeat: true, a11y: 'Arrow right' },
  { label: '|', seq: '|', a11y: 'Pipe' },
  { label: '-', seq: '-', a11y: 'Dash' },
  { label: '~', seq: '~', a11y: 'Tilde' },
  { label: '/', seq: '/', a11y: 'Slash' },
];

export interface KeyRowProps {
  onKey: (seq: string) => void;
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  /** copy the terminal selection / tmux selection / visible screen */
  onCopy?: () => void;
  /** paste the device clipboard into the shell */
  onPaste?: () => void;
  /** show the on-screen keyboard (focuses the terminal) */
  onShowKeyboard?: () => void;
  /** extra bottom padding (safe area / keyboard) */
  bottomInset?: number;
  disabled?: boolean;
}

const REPEAT_DELAY_MS = 380;
const REPEAT_EVERY_MS = 70;
const FADE_WIDTH = 28;
/** scroll distance under which an edge counts as reached */
const EDGE_SLACK = 4;
/** opacity ramp of the stacked slices that stand in for a gradient (no gradient dependency) */
const FADE_STEPS = [0.06, 0.16, 0.3, 0.48, 0.68, 0.88];

export function KeyRow({ onKey, ctrlArmed, onToggleCtrl, onCopy, onPaste, onShowKeyboard, bottomInset = 0, disabled }: KeyRowProps) {
  const t = useTheme();
  const metrics = useRef({ x: 0, content: 0, width: 0 });
  const [fade, setFade] = useState({ left: false, right: false });
  const recompute = () => {
    const { x, content, width } = metrics.current;
    const left = x > EDGE_SLACK;
    const right = content - width - x > EDGE_SLACK;
    setFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  };

  return (
    <View
      style={{
        backgroundColor: t.colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: t.colors.border,
        paddingBottom: bottomInset,
      }}
    >
      <View style={{ position: 'relative' }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          contentContainerStyle={{ gap: 6, paddingHorizontal: 8, paddingVertical: 6, alignItems: 'center' }}
          accessibilityRole="toolbar"
          accessibilityLabel="Terminal keys"
          scrollEventThrottle={32}
          onScroll={(e) => {
            metrics.current.x = e.nativeEvent.contentOffset.x;
            recompute();
          }}
          onContentSizeChange={(w) => {
            metrics.current.content = w;
            recompute();
          }}
          onLayout={(e) => {
            metrics.current.width = e.nativeEvent.layout.width;
            recompute();
          }}
        >
          {TERMINAL_KEYS.map((k) => (
            <Key key={k.label} def={k} armed={!!k.ctrl && ctrlArmed} disabled={disabled} onKey={onKey} onToggleCtrl={onToggleCtrl} />
          ))}
          {onCopy ? (
            <ActionKey icon="copy-outline" label="copy" a11y="Copy selection or screen" disabled={disabled} onPress={onCopy} />
          ) : null}
          {onPaste ? (
            <ActionKey icon="clipboard-outline" label="paste" a11y="Paste from clipboard" disabled={disabled} onPress={onPaste} />
          ) : null}
          {onShowKeyboard ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show keyboard"
              onPress={() => {
                void haptic.selection();
                onShowKeyboard();
              }}
              style={({ pressed }) => [
                styles.key,
                { backgroundColor: pressed ? t.colors.surfacePressed : t.colors.surfaceAlt, borderColor: t.colors.border, minWidth: 48 },
              ]}
            >
              <Ionicons name="keypad-outline" size={18} color={t.colors.text} />
            </Pressable>
          ) : null}
        </ScrollView>
        <EdgeFade side="left" visible={fade.left} color={t.colors.surface} />
        <EdgeFade side="right" visible={fade.right} color={t.colors.surface} />
      </View>
    </View>
  );
}

/** Stacked translucent slices from the edge inward — reads as a gradient without a gradient library. */
function EdgeFade({ side, visible, color }: { side: 'left' | 'right'; visible: boolean; color: string }) {
  if (!visible) return null;
  const steps = side === 'left' ? [...FADE_STEPS].reverse() : FADE_STEPS;
  return (
    <View pointerEvents="none" style={[styles.fade, side === 'left' ? { left: 0 } : { right: 0 }]}>
      {steps.map((opacity, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: color, opacity }} />
      ))}
    </View>
  );
}

function ActionKey({
  icon,
  label,
  a11y,
  disabled,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  a11y: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      disabled={disabled}
      hitSlop={2}
      onPress={() => {
        void haptic.selection();
        onPress();
      }}
      style={({ pressed }) => [
        styles.key,
        styles.actionKey,
        {
          backgroundColor: pressed ? t.colors.surfacePressed : t.colors.surfaceAlt,
          borderColor: t.colors.border,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Ionicons name={icon} size={15} color={t.colors.text} />
      <T variant="caption" weight="600" style={{ color: t.colors.text }}>
        {label}
      </T>
    </Pressable>
  );
}

function Key({
  def,
  armed,
  disabled,
  onKey,
  onToggleCtrl,
}: {
  def: KeyDef;
  armed: boolean;
  disabled?: boolean;
  onKey: (s: string) => void;
  onToggleCtrl: () => void;
}) {
  const t = useTheme();
  const delay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interval = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRepeat = () => {
    if (delay.current) clearTimeout(delay.current);
    if (interval.current) clearInterval(interval.current);
    delay.current = null;
    interval.current = null;
  };
  useEffect(() => stopRepeat, []);

  const fire = () => {
    if (def.ctrl) {
      onToggleCtrl();
      return;
    }
    if (def.seq) onKey(def.seq);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={def.a11y}
      accessibilityState={def.ctrl ? { selected: armed } : undefined}
      aria-pressed={def.ctrl ? armed : undefined}
      disabled={disabled}
      hitSlop={2}
      onPressIn={() => {
        void haptic.selection();
        fire();
        if (def.repeat) {
          stopRepeat();
          delay.current = setTimeout(() => {
            interval.current = setInterval(fire, REPEAT_EVERY_MS);
          }, REPEAT_DELAY_MS);
        }
      }}
      onPressOut={stopRepeat}
      style={({ pressed }) => [
        styles.key,
        {
          backgroundColor: armed ? t.colors.accent : pressed ? t.colors.surfacePressed : t.colors.surfaceAlt,
          borderColor: armed ? t.colors.accent : t.colors.border,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <T
        style={{
          color: armed ? t.colors.onAccent : t.colors.text,
          fontFamily: t.font.mono,
          fontSize: def.label.length > 2 ? 12 : 14,
          fontWeight: '600',
          // web: avoid text selection when tapping quickly
          ...(Platform.OS === 'web' ? ({ userSelect: 'none' } as object) : null),
        }}
      >
        {def.label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  key: {
    minWidth: 44,
    height: 44,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionKey: { flexDirection: 'row', gap: 5, paddingHorizontal: 12 },
  fade: { position: 'absolute', top: 0, bottom: 0, width: FADE_WIDTH, flexDirection: 'row' },
});
