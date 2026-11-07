import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { copyText } from '../../lib/clipboard';
import { useTheme } from '../../theme/ThemeProvider';
import { T } from './Text';
import { Tap } from './Tap';

export interface CodeBlockProps {
  code: string;
  /** wrap long lines instead of horizontal scroll */
  wrap?: boolean;
  maxHeight?: number;
  label?: string;
  tone?: 'default' | 'danger';
  selectable?: boolean;
}

/** Monospace block for commands, raw tool input/output and JSON. Never truncates the text itself. */
export function CodeBlock({ code, wrap = true, maxHeight, label, tone = 'default', selectable = true }: CodeBlockProps) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (await copyText(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  const text = (
    <T
      variant="mono"
      selectable={selectable}
      style={{ color: tone === 'danger' ? t.colors.danger : t.colors.codeText, padding: 12, paddingRight: 40 }}
    >
      {code}
    </T>
  );
  return (
    <View style={[styles.box, { backgroundColor: t.colors.codeBg, borderColor: t.colors.border, borderRadius: t.radius.md }]}>
      {label ? (
        <View style={[styles.labelRow, { borderBottomColor: t.colors.border }]}>
          <T variant="label">{label}</T>
        </View>
      ) : null}
      <View style={{ maxHeight }}>
        {/* A vertical ScrollView only when the block is height-capped: an uncapped one would capture the drag and
            rubber-band instead of scrolling the sheet or the timeline. */}
        {wrap ? (
          maxHeight ? (
            <ScrollView nestedScrollEnabled showsVerticalScrollIndicator bounces={false} alwaysBounceVertical={false}>
              {text}
            </ScrollView>
          ) : (
            text
          )
        ) : (
          <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator bounces={false} alwaysBounceHorizontal={false}>
            {maxHeight ? (
              <ScrollView nestedScrollEnabled bounces={false} alwaysBounceVertical={false}>
                {text}
              </ScrollView>
            ) : (
              text
            )}
          </ScrollView>
        )}
      </View>
      <Tap onPress={onCopy} style={styles.copy} pressedColor={null} accessibilityRole="button" accessibilityLabel="Copy">
        <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={16} color={copied ? t.colors.success : t.colors.textFaint} />
      </Tap>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', position: 'relative' },
  labelRow: { paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  copy: { position: 'absolute', top: 0, right: 0, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
