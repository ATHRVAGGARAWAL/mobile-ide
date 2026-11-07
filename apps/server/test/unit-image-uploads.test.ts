import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { API, MAX_UPLOAD_IMAGE_BYTES, UploadImageResponse } from '@mobile-ide/core';
import { startServer } from '../src/app.js';
import type { RunningServer } from '../src/context.js';
import { generatePairingCode } from '../src/auth.js';
import { tmpDir, rmrf } from './helpers.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=';
let server: RunningServer;
let home: string;
let root: string;
let token: string;
before(async () => {
  home = tmpDir('mide-upload-home-');
  root = tmpDir('mide-upload-project-');
  server = await startServer({
    home,
    overrides: {
      port: 0,
      agents: {},
      projects: { roots: [root], denylist: [path.join(root, 'private')] },
      studio: { autoOpen: false, browser: null, dir: null, windowSize: '1200x800' },
    },
  });
  const code = generatePairingCode();
  server.ctx.db.createPairingCode(code);
  const paired = await fetch(server.url + API.pair, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'upload test', platform: 'test' }),
  });
  token = ((await paired.json()) as { token: string }).token;
});
after(async () => {
  await server?.close({ drainMs: 0, cancelTurns: true });
  rmrf(home);
  rmrf(root);
});

function upload(overrides: Record<string, unknown> = {}, authenticated = true) {
  return fetch(server.url + API.fsImage, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ root, mimeType: 'image/png', data: PNG, ...overrides }),
  });
}

test('phone photo uploads require pairing', async () => {
  assert.equal((await upload({}, false)).status, 401);
});

test('upload preserves bytes, returns a readable absolute path and never overwrites an earlier photo', async () => {
  const response = await upload();
  assert.equal(response.status, 201);
  const saved = UploadImageResponse.parse(await response.json());
  assert.ok(saved.absolutePath.startsWith(root + '/.mobile-ide-uploads/'));
  assert.deepEqual(fs.readFileSync(saved.absolutePath), Buffer.from(PNG, 'base64'));
  assert.equal(fs.statSync(saved.absolutePath).mode & 0o777, 0o600);
  const second = UploadImageResponse.parse(await (await upload()).json());
  assert.notEqual(saved.absolutePath, second.absolutePath);
});

test('upload rejects invalid base64, non-photos, MIME mismatches and oversized images', async () => {
  for (const body of [
    { data: '!!!!' },
    { data: Buffer.from('not a photo').toString('base64') },
    { mimeType: 'image/jpeg' },
    { mimeType: 'text/plain' },
    { data: Buffer.alloc(MAX_UPLOAD_IMAGE_BYTES + 3).toString('base64') },
  ])
    assert.equal((await upload(body)).status, 400);
});

test('uploads stay inside allowed projects and reject a symlink out of the project', async () => {
  assert.equal((await upload({ root: home })).status, 403);
  fs.mkdirSync(path.join(root, 'private'));
  assert.equal((await upload({ root: path.join(root, 'private') })).status, 403);
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  fs.symlinkSync(home, path.join(nested, '.mobile-ide-uploads'));
  assert.equal((await upload({ root: nested })).status, 403);
  assert.equal(
    fs.readdirSync(home).some((f) => f.endsWith('.png')),
    false,
  );
});
