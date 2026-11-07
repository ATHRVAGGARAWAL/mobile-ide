import React from 'react';
import { View } from 'react-native';
import { Button, T } from '../ui';
import type { PhotoSource } from './attachments';

/** Inline choices keep native photo pickers out of an already-presented modal. */
export function PhotoSources({ onPick, busy = false }: { onPick: (source: PhotoSource) => void; busy?: boolean }) {
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          title="Gallery"
          icon="images-outline"
          variant="secondary"
          disabled={busy}
          onPress={() => onPick('gallery')}
          style={{ flex: 1 }}
        />
        <Button
          title="Files"
          icon="folder-open-outline"
          variant="secondary"
          disabled={busy}
          onPress={() => onPick('files')}
          style={{ flex: 1 }}
        />
      </View>
      <T variant="caption" color="textMuted">
        {busy ? 'Preparing photos…' : 'Choose up to 4 photos. Preview them before sending.'}
      </T>
    </View>
  );
}
