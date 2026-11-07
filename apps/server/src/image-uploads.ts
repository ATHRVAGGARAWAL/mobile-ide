import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_UPLOAD_IMAGE_BYTES, type UploadImageRequest, type UploadImageResponse } from '@mobile-ide/core';
import { BadRequestError, HttpError } from './errors.js';
import { resolveRoot, resolveUnder, type PathPolicy } from './paths.js';

export async function saveUploadedImage(policy: PathPolicy, input: UploadImageRequest): Promise<UploadImageResponse> {
  const root = resolveRoot(policy, input.root);
  if (!(await fs.stat(root)).isDirectory()) throw new BadRequestError('Choose a project directory.');
  const bytes = Buffer.from(input.data, 'base64');
  if (bytes.length > MAX_UPLOAD_IMAGE_BYTES) throw new HttpError(413, 'Each photo must be 5 MB or smaller.', 'image_too_large');
  if (!bytes.length || bytes.toString('base64') !== input.data) throw new BadRequestError('Invalid image data.');
  const valid = {
    'image/jpeg': bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    'image/png': bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/webp': bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
    'image/gif': ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)),
  }[input.mimeType];
  if (!valid) throw new BadRequestError('This file is not a supported photo. Choose a JPEG, PNG, WebP or GIF image.');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[input.mimeType];
  const dir = resolveUnder(policy, root, '.mobile-ide-uploads');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const relative = `.mobile-ide-uploads/${randomUUID()}.${ext}`;
  const absolutePath = resolveUnder(policy, root, relative);
  await fs.writeFile(absolutePath, bytes, { flag: 'wx', mode: 0o600 });
  return { path: path.relative(root, absolutePath), absolutePath, size: bytes.length };
}
