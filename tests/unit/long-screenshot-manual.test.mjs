import test from 'node:test';
import assert from 'node:assert/strict';
import { alignFrames, captureManual } from '../../extension/src/long-screenshot/manual.js';

function signature(value = 0) {
  const width = 96;
  const height = 100;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      pixels[at] = value + y;
      pixels[at + 1] = value + y;
      pixels[at + 2] = value + y;
      pixels[at + 3] = 255;
    }
  }
  return { width, height, pixels };
}

test('alignFrames accepts identical frames', () => {
  const a = signature();
  assert.deepEqual(alignFrames(a, a), { offset: 0, footer: 0 });
});

test('alignFrames rejects dimension changes', () => {
  assert.throws(() => alignFrames(signature(), { ...signature(), height: 99 }), /changed/);
});

test('captureManual writes first frame and stops when visible', async () => {
  const written = [];
  let progress = 0;
  const bitmap = { ...signature(), close() {} };
  const result = await captureManual({
    screenshot: async () => bitmap,
    write: async (...args) => written.push(args),
    checkpoint: async () => {},
    finished: () => false,
    signal: new AbortController().signal,
    visible: true,
    progress: () => { progress += 1; },
  });
  assert.deepEqual(result, { width: 96, height: 100 });
  assert.equal(written.length, 1);
  assert.equal(progress, 1);
});
