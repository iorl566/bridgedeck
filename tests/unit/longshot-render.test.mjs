import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutCanvas, planStitch } from '../../extension/src/longshot-render.js';

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

test('planStitch 新分片按 drawY 叠放（含重叠）', () => {
  const layout = planStitch([
    { drawY: 0, height: 100 },
    { drawY: 90, height: 100 },
  ], { width: 800 });
  assert.equal(layout.width, 800);
  assert.equal(layout.height, 190);
  assert.deepEqual(layout.placements.map((item) => item.drawY), [0, 90]);
});

test('planStitch 旧分片没有 drawY 时顺序累加', () => {
  const layout = planStitch([
    { height: 100 },
    { height: 50 },
  ], { width: 10 });
  assert.equal(layout.height, 150);
  assert.deepEqual(layout.placements.map((item) => item.drawY), [0, 100]);
});

test('planStitch 空分片返回最小画布', () => {
  const layout = planStitch([], { width: 10 });
  assert.equal(layout.width, 10);
  assert.equal(layout.height, 1);
  assert.deepEqual(layout.placements, []);
});
