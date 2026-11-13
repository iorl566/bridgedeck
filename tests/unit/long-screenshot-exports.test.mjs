import test from 'node:test';
import assert from 'node:assert/strict';
import { signature } from '../../extension/src/long-screenshot/manual.js';
import { exportPng } from '../../extension/src/long-screenshot/png.js';
import { readScreenshot } from '../../extension/src/long-screenshot/storage.js';

test('long screenshot exposes the reference capture helpers', async () => {
  assert.equal(typeof signature, 'function');
  assert.equal(typeof exportPng, 'function');
  assert.equal(await readScreenshot('missing'), undefined);
});

test('signature requires a canvas-capable environment', () => {
  assert.throws(() => signature({ width: 10, height: 10 }), /OffscreenCanvas|not defined|canvas/i);
});

test('exportPng rejects when screenshot storage is unavailable', async () => {
  await assert.rejects(
    exportPng({ id: 'shot-1', width: 10, height: 10, tileHeight: 10 }),
    /storage|directory|unavailable/i,
  );
});
