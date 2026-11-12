import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('runtime tabs.js uses the mirrored ExpectedTabMoves', async () => {
  const source = await readFile(new URL('../../extension/src/tabs.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/session-manager\/tab-moves\.js'/);
  assert.match(source, /expectedTabMoves\.run\(/);
});

test('runtime debugger.js uses the mirrored command deadline', async () => {
  const source = await readFile(new URL('../../extension/src/debugger.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/browser-driver\/command-deadline\.js'/);
  assert.match(source, /runCdpCommand\(/);
});
