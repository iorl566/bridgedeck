import test from 'node:test';
import assert from 'node:assert/strict';
import { isStaleFrame, signature } from '../../extension/src/long-screenshot/frame-freshness.js';

function image(rows) {
  const width = 96;
  const height = 200;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = rows(y);
      const at = (y * width + x) * 4;
      pixels[at] = value;
      pixels[at + 1] = value;
      pixels[at + 2] = value;
      pixels[at + 3] = 255;
    }
  }
  return signature(width, height, pixels);
}

test('isStaleFrame rejects ambiguous/zero offset', () => {
  assert.equal(isStaleFrame(image(() => 0), image(() => 0), 0), false);
  assert.equal(isStaleFrame(image(() => 0), image(() => 0), 300), false);
});

test('isStaleFrame detects stationary exposure against shifted content', () => {
  const a = image((y) => (y < 100 ? 0 : 255));
  const b = image((y) => (y < 100 ? 0 : 255));
  assert.equal(isStaleFrame(a, b, 50), true);
});

test('isStaleFrame ignores scrolling evidence', () => {
  const a = image((y) => (y < 100 ? 0 : 255));
  const b = image((y) => (y + 50 < 100 ? 0 : 255));
  assert.equal(isStaleFrame(a, b, 50), false);
});
