import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { ContentBlock } from '@mobile-ide/core';
import { Chip, T, Tap } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';
import { copyText } from '../../lib/clipboard';
import { basename } from '../../lib/format';
import { toast } from '../../state/toast';
import { openFile } from './files';

export interface UserBubbleProps {
  blocks: ContentBlock[];
  cwd: string;
}

/** The user's prompt: right-aligned bubble with text, image thumbnails and attached file links. */
export const UserBubble = React.memo(function UserBubble({ blocks, cwd }: UserBubbleProps) {
  const t = useTheme();
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
  const images = blocks.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image');
  const links = blocks.filter((b): b is Extract<ContentBlock, { type: 'resource_link' }> => b.type === 'resource_link');

  const onCopy = async () => {
    if (text && (await copyText(text))) toast.success('Copied');
  };

  const single = images.length === 1;
  return (
    <View style={styles.row}>
      <T variant="caption" color="textFaint" weight="600">
        You
      </T>
      <Tap
        onLongPress={onCopy}
        delayLongPress={350}
        pressedColor={null}
        accessibilityRole="text"
        accessibilityLabel={text || 'Attachment'}
        accessibilityHint="Long press to copy"
        style={[styles.bubble, { backgroundColor: t.colors.userBubble, borderColor: t.colors.border, borderRadius: t.radius.lg }]}
      >
        {images.length ? (
          <View style={styles.images}>
            {images.map((img, i) => (
              <Image
                key={i}
                source={{ uri: `data:${img.mimeType};base64,${img.data}` }}
                style={{ width: single ? 220 : 96, height: single ? 165 : 96, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.15)' }}
                resizeMode="cover"
                accessibilityLabel="Attached image"
              />
            ))}
          </View>
        ) : null}
        {text ? (
          <T selectable style={{ color: t.colors.onUserBubble, fontSize: 15, lineHeight: 23 }}>
            {text}
          </T>
        ) : null}
        {links.length ? (
          <View style={styles.links}>
            {links.map((l, i) => (
              <Chip
                key={`${l.uri}-${i}`}
                icon="document-text-outline"
                label={l.name || basename(l.uri)}
                bg={t.colors.surfacePressed}
                fg={t.colors.onUserBubble}
                mono
                maxWidth={240}
                onPress={() => openFile(cwd, l.uri)}
              />
            ))}
          </View>
        ) : null}
      </Tap>
    </View>
  );
});

const styles = StyleSheet.create({
  row: { alignItems: 'flex-end', gap: 6, paddingVertical: 6 },
  bubble: { maxWidth: '92%', paddingHorizontal: 16, paddingVertical: 14, gap: 10, borderWidth: StyleSheet.hairlineWidth },
  images: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
