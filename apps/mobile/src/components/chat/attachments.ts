/**
 * Image attachments for prompts: pick from the library, downscale to <= MAX_IMAGE_EDGE px on the
 * longest side, JPEG-encode, and hand back base64 ready for a core `ImageBlock`.
 */
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Image, Platform } from 'react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { MAX_UPLOAD_IMAGE_BYTES } from '@mobile-ide/core';
import { formatBytes } from '../../lib/format';
import { uid } from '../../lib/ids';

export const MAX_IMAGE_EDGE = 1600;
export const MAX_IMAGES = 4;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const JPEG_QUALITY = 0.85;
export type PhotoSource = 'gallery' | 'files';

interface ImageSource {
  uri: string;
  width?: number;
  height?: number;
  mimeType?: string | null;
  base64?: string | null;
  fileSize?: number;
}

export interface PendingImage {
  id: string;
  mimeType: string;
  /** base64 payload without a data: prefix */
  data: string;
  width: number;
  height: number;
  bytes: number;
  /** data URI for thumbnails */
  previewUri: string;
}

export type PickResult =
  { kind: 'ok'; images: PendingImage[]; failed: number } | { kind: 'cancelled' } | { kind: 'error'; message: string };

export async function pickImages(max = MAX_IMAGES): Promise<PickResult> {
  return pickPhotos('gallery', max);
}

/** Picker launch happens before any await so Safari retains the button's user gesture. */
export async function pickPhotos(source: PhotoSource, max = MAX_IMAGES): Promise<PickResult> {
  if (max <= 0) return { kind: 'error', message: `Up to ${MAX_IMAGES} photos per message.` };
  max = Math.min(max, MAX_IMAGES);
  let assets: ImageSource[];
  const temporaryUris: string[] = [];
  try {
    if (source === 'files') {
      const result = await DocumentPicker.getDocumentAsync({
        type: Platform.OS === 'web' ? '*/*' : 'image/*',
        multiple: max > 1,
        copyToCacheDirectory: true,
        base64: false,
      });
      if (result.canceled || !result.assets.length) return { kind: 'cancelled' };
      assets = result.assets.map((a) => ({ uri: a.uri, mimeType: a.mimeType, fileSize: a.size }));
      if (Platform.OS === 'web') temporaryUris.push(...assets.map((a) => a.uri).filter((uri) => uri.startsWith('blob:')));
    } else {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: max > 1,
        selectionLimit: max,
        quality: 0.92,
        base64: false,
        exif: false,
      });
      if (result.canceled || !result.assets?.length) return { kind: 'cancelled' };
      assets = result.assets;
    }
  } catch (err) {
    return { kind: 'error', message: err instanceof Error && err.message ? err.message : `Could not open ${source}.` };
  }

  const images: PendingImage[] = [];
  let failed = 0;
  let lastError = '';
  for (const asset of assets.slice(0, max)) {
    try {
      if (asset.fileSize && asset.fileSize > MAX_SOURCE_BYTES) throw new Error('Choose photos smaller than 20 MB.');
      if (asset.mimeType && !asset.mimeType.startsWith('image/')) throw new Error('Choose image files to attach as photos.');
      const image = await prepareImage(asset);
      if (image.bytes > MAX_UPLOAD_IMAGE_BYTES)
        throw new Error('This photo is too large. Choose a smaller photo (up to 5 MB after resizing).');
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(image.mimeType))
        throw new Error('This photo format could not be converted. Try a JPEG, PNG, WebP or GIF.');
      images.push(image);
    } catch (err) {
      failed++;
      lastError = err instanceof Error ? err.message : 'The selected photo could not be read.';
      console.warn('[attachments] could not prepare image', err);
    }
  }
  for (const uri of temporaryUris) URL.revokeObjectURL(uri);
  if (!images.length) return { kind: 'error', message: lastError || 'The selected photos could not be read.' };
  return { kind: 'ok', images, failed };
}

async function prepareImage(asset: ImageSource): Promise<PendingImage> {
  const dimensions =
    asset.width && asset.height
      ? { width: asset.width, height: asset.height }
      : await new Promise<{ width: number; height: number }>((resolve, reject) =>
          Image.getSize(asset.uri, (width, height) => resolve({ width, height }), reject),
        );
  const { width, height } = dimensions;
  const needsResize = Math.max(width, height) > MAX_IMAGE_EDGE;
  try {
    const ctx = ImageManipulator.manipulate(asset.uri);
    try {
      if (needsResize) {
        if (width >= height) ctx.resize({ width: MAX_IMAGE_EDGE });
        else ctx.resize({ height: MAX_IMAGE_EDGE });
      }
      const rendered = await ctx.renderAsync();
      try {
        const saved = await rendered.saveAsync({ base64: true, compress: JPEG_QUALITY, format: SaveFormat.JPEG });
        if (!saved.base64) throw new Error('manipulator returned no base64');
        const data = stripDataUrl(saved.base64);
        return {
          id: uid('img'),
          mimeType: 'image/jpeg',
          data,
          width: saved.width || width,
          height: saved.height || height,
          bytes: base64Bytes(data),
          previewUri: `data:image/jpeg;base64,${data}`,
        };
      } finally {
        release(rendered);
      }
    } finally {
      release(ctx);
    }
  } catch (err) {
    // Fall back to the original bytes (may exceed the edge limit, but the prompt still goes out).
    console.warn('[attachments] downscale failed, using original bytes', err);
  }
  const { data, mimeType } = asset.base64
    ? { data: stripDataUrl(asset.base64), mimeType: asset.mimeType ?? 'image/jpeg' }
    : await readAsBase64(asset.uri, asset.mimeType ?? undefined);
  return { id: uid('img'), mimeType, data, width, height, bytes: base64Bytes(data), previewUri: `data:${mimeType};base64,${data}` };
}

function release(obj: unknown): void {
  try {
    (obj as { release?: () => void }).release?.();
  } catch {
    /* best effort */
  }
}

function stripDataUrl(s: string): string {
  if (!s.startsWith('data:')) return s;
  const i = s.indexOf('base64,');
  return i >= 0 ? s.slice(i + 'base64,'.length) : s;
}

function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

async function readAsBase64(uri: string, hintMime?: string): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(uri);
  const blob = await res.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('could not read image'));
    reader.readAsDataURL(blob);
  });
  const mimeType = blob.type || hintMime || 'image/jpeg';
  return { data: stripDataUrl(dataUrl), mimeType };
}

export function formatImageSize(img: PendingImage): string {
  const dims = img.width && img.height ? `${img.width}×${img.height} · ` : '';
  return `${dims}${formatBytes(img.bytes)}`;
}
