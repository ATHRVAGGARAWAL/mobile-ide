import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MarkdownView from '../../dom/MarkdownView';
import { T, Tap } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';
import { formatTokens } from '../../lib/format';
import { STREAM_RENDER_MS } from './AssistantMessage';
import { INLINE_DOM } from './domProps';
import { useThrottledValue } from './useThrottledValue';

export interface ThoughtBlockProps {
  /** timeline item id */
  id: string;
  text: string;
  streaming: boolean;
  /**
   * Controlled: FlashList recycles cells across items of the same type, so expand state kept inside the
   * cell would wander to unrelated thoughts. The list owns it, keyed by item id.
   */
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
}

function formatChars(n: number): string {
  return n < 1000 ? `${n} chars` : `${formatTokens(n)} chars`;
}

/** Collapsed "Thinking…" disclosure; expands to the agent's reasoning rendered as muted markdown. */
export const ThoughtBlock = React.memo(function ThoughtBlock({ id, text, streaming, open, onToggle }: ThoughtBlockProps) {
  const t = useTheme();
  const shown = useThrottledValue(text, streaming && open ? STREAM_RENDER_MS : 0, id);
  return (
    <View style={{ borderLeftWidth: 2, borderLeftColor: t.colors.borderStrong, paddingLeft: 14, marginVertical: 2 }}>
      <Tap
        onPress={() => onToggle(id, !open)}
        pressedColor={null}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={`${streaming ? 'Thinking' : 'Thought'}, ${formatChars(text.length)}, ${open ? 'tap to hide' : 'tap to show'}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}
      >
        {streaming ? (
          <ActivityIndicator size="small" color={t.colors.textFaint} style={{ transform: [{ scale: 0.7 }] }} />
        ) : (
          <Ionicons name="bulb-outline" size={14} color={t.colors.textFaint} />
        )}
        <T variant="bodySmall" color="textMuted" weight="500">
          {streaming ? 'Thinking…' : 'Reasoning'}
        </T>
        <View style={{ flex: 1 }} />
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={t.colors.textFaint} />
      </Tap>
      {open ? (
        <View style={{ paddingBottom: 4 }}>
          <MarkdownView text={shown} streaming={streaming} theme={t.name} muted dom={INLINE_DOM} />
        </View>
      ) : null}
    </View>
  );
});
