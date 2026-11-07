import React from 'react';
import { Image, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { T, Tap } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';
import { formatImageSize, type PendingImage } from './attachments';

export interface ImageAttachmentsProps {
  images: PendingImage[];
  onRemove: (id: string) => void;
}

/** Thumbnail strip of images queued for the next prompt. */
export function ImageAttachments({ images, onRemove }: ImageAttachmentsProps) {
  const t = useTheme();
  if (!images.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 12, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 }}>
      {images.map((img) => (
        <View key={img.id} style={{ width: 72 }}>
          <Image
            source={{ uri: img.previewUri }}
            style={{ width: 72, height: 72, borderRadius: 10, backgroundColor: t.colors.surfaceAlt }}
            resizeMode="cover"
            accessibilityLabel="Attached image"
          />
          <Tap
            onPress={() => onRemove(img.id)}
            accessibilityRole="button"
            accessibilityLabel="Remove image"
            pressedColor={null}
            hitSlop={8}
            style={{ position: 'absolute', top: -7, right: -7, backgroundColor: t.colors.bgElevated, borderRadius: 12 }}
          >
            <Ionicons name="close-circle" size={24} color={t.colors.text} />
          </Tap>
          <T variant="caption" color="textFaint" numberOfLines={1} style={{ marginTop: 3, fontSize: 10 }}>
            {formatImageSize(img)}
          </T>
        </View>
      ))}
    </ScrollView>
  );
}
