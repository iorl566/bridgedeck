import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutCanvas } from '../../extension/src/longshot-render.js';

test('layoutCanvas clamps frames to canvas and computes height', () => {
  const layout = layoutCanvas([
    { drawY: 0, bitmapHeight: 100 },
    { drawY: 90, bitmapHeight: 100 },
  ], { width: 800, totalHeight: 150 });
  assert.equal(layout.width, 800);
  assert.equal(layout.height, 150);
  assert.deepEqual(layout.placements.map((item) => item.drawY), [0, 50]);
});

test('layoutCanvas handles empty frames', () => {
  const layout = layoutCanvas([], { width: 10, totalHeight: 0 });
  assert.equal(layout.width, 10);
  assert.equal(layout.height, 1);
  assert.deepEqual(layout.placements, []);
});

test('layoutCanvas keeps order and heights', () => {
  const layout = layoutCanvas([
    { drawY: 20, bitmapHeight: 40 },
    { drawY: 0, bitmapHeight: 30 },
  ], { width: 100, totalHeight: 100 });
  assert.deepEqual(layout.placements.map((item) => item.index), [0, 1]);
  assert.equal(layout.height, 60);
});
