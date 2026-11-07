import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { imagePathsForTerminal } from '../src/components/terminal/imagePaths';

test('terminal photo paths remain literal shell arguments and contain no Enter/control sequence', () => {
  const paths = ["/tmp/my photo's $(echo BAD).png", '/tmp/other `echo BAD`.jpg'];
  const text = imagePathsForTerminal(paths);
  assert.ok(!/[\r\n\x1b]/.test(text));
  const shell = spawnSync('/bin/sh', ['-c', `printf '%s\\n' ${text}`], { encoding: 'utf8' });
  assert.equal(shell.status, 0, shell.stderr);
  assert.deepEqual(shell.stdout.trimEnd().split('\n'), paths);
  assert.throws(() => imagePathsForTerminal(['/tmp/photo\nexit.jpg']), /cannot be pasted/);
});
