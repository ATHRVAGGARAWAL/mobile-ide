import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { UploadImageRequest } from '@mobile-ide/core';
import { api, errorMessage } from '../../state/api';
import { useTheme } from '../../theme/ThemeProvider';
import { Button, IconButton, T } from '../ui';
import { ImageAttachments } from '../chat/ImageAttachments';
import { PhotoSources } from '../chat/PhotoSources';
import { MAX_IMAGES, pickPhotos, type PendingImage, type PhotoSource } from '../chat/attachments';
import { imagePathsForTerminal } from './imagePaths';

export function TerminalPhotos({ root, connected, onPaste }: { root: string; connected: boolean; onPaste: (text: string) => void }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const online = useRef(connected);
  online.current = connected;
  const uploaded = useRef(new Map<string, string>());
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const pick = async (source: PhotoSource) => {
    if (picking || uploading) return;
    setPicking(true);
    setError(null);
    try {
      const result = await pickPhotos(source, MAX_IMAGES - images.length);
      if (!active.current) return;
      if (result.kind === 'ok') {
        setImages((current) => [...current, ...result.images].slice(0, MAX_IMAGES));
        if (result.failed) setError(`${result.failed} selected photo(s) could not be read.`);
      } else if (result.kind === 'error') setError(result.message);
    } finally {
      if (active.current) setPicking(false);
    }
  };

  const upload = async () => {
    if (!connected || picking || uploading || !images.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const [index, image] of images.entries()) {
        if (!active.current) return;
        setProgress(`Uploading ${index + 1} of ${images.length}…`);
        if (!uploaded.current.has(image.id)) {
          const body = UploadImageRequest.parse({ root, mimeType: image.mimeType, data: image.data });
          const saved = await api.uploadImage(body);
          uploaded.current.set(image.id, saved.absolutePath);
        }
      }
      if (!active.current) return;
      if (!online.current) throw new Error('Photos uploaded. Reconnect your shell, then tap Upload & paste to insert their paths.');
      const paths = images.map((image) => uploaded.current.get(image.id));
      if (paths.some((p) => !p)) throw new Error('A photo did not finish uploading. Try again.');
      onPaste(imagePathsForTerminal(paths.filter((p): p is string => !!p)));
      setImages([]);
      uploaded.current.clear();
      setOpen(false);
      setProgress('Photo paths pasted. Add your message, then press Enter when ready.');
    } catch (err) {
      if (active.current) setError(errorMessage(err));
    } finally {
      if (active.current) setUploading(false);
    }
  };

  return (
    <View style={{ paddingHorizontal: t.spacing.lg, paddingBottom: 6, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Button
          title="Add photos"
          icon="image-outline"
          variant="ghost"
          size="sm"
          onPress={() => setOpen(true)}
          disabled={uploading || picking}
        />
        {open ? (
          <IconButton name="close" label="Close photo attachments" onPress={() => setOpen(false)} disabled={uploading || picking} />
        ) : null}
      </View>
      {open ? (
        <View style={{ gap: 8 }}>
          <PhotoSources busy={picking || uploading} onPick={(source) => void pick(source)} />
          <ImageAttachments
            images={images}
            onRemove={(id) => {
              if (!uploading) setImages((current) => current.filter((image) => image.id !== id));
            }}
          />
          {images.length ? (
            <Button
              title="Upload & paste"
              icon="cloud-upload-outline"
              loading={uploading}
              disabled={!connected || picking}
              onPress={() => void upload()}
            />
          ) : null}
          <T variant="caption" color="textMuted">
            Photos are saved to your project. Their paths are pasted without pressing Enter.
          </T>
          {!connected ? (
            <T variant="caption" color="warning">
              Reconnect the terminal to upload and paste.
            </T>
          ) : null}
        </View>
      ) : null}
      {error ? (
        <T variant="caption" color="danger">
          {error}
        </T>
      ) : progress ? (
        <T variant="caption" color="textMuted">
          {progress}
        </T>
      ) : null}
    </View>
  );
}
