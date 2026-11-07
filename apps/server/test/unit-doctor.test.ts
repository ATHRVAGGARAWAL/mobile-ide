import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigSchema } from '../src/config.js';
import { checkDaemon } from '../src/doctor.js';

test('doctor warns when a stopped daemon cannot be reached', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('connection refused');
  });
  const result = await checkDaemon(ConfigSchema.parse({}), 'inactive');
  assert.equal(result.status, 'warn');
  assert.match(result.hint ?? '', /systemctl --user start/);
});

test('doctor fails when an active daemon cannot be reached', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('connection refused');
  });
  assert.equal((await checkDaemon(ConfigSchema.parse({}), 'active')).status, 'fail');
});
