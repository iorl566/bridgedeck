import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRgba } from '../../extension/src/lib/pixel-diff.js';

const px = (r, g, b, a = 255) => [r, g, b, a];

test('相同像素无变化', () => {
  const a = new Uint8ClampedArray([...px(1, 2, 3), ...px(255, 255, 255)]);
  const diff = diffRgba(a, a.slice(), 2, 1);
  assert.equal(diff.changed, 0);
  assert.equal(diff.bbox, null);
});

test('单像素变化给出 bbox', () => {
  const a = new Uint8ClampedArray([...px(0, 0, 0), ...px(0, 0, 0), ...px(0, 0, 0), ...px(0, 0, 0)]);
  const b = new Uint8ClampedArray([...px(0, 0, 0), ...px(0, 0, 0), ...px(0, 0, 0), ...px(255, 0, 0)]);
  const diff = diffRgba(a, b, 2, 2);
  assert.equal(diff.changed, 1);
  assert.deepEqual(diff.bbox, { x: 1, y: 1, width: 1, height: 1 });
});

test('尺寸/输入不符返回 null', () => {
  assert.equal(diffRgba(new Uint8ClampedArray(3), new Uint8ClampedArray(3), 1, 1), null);
  assert.equal(diffRgba(null, null, 1, 1), null);
  assert.equal(diffRgba(new Uint8ClampedArray(4), new Uint8ClampedArray(4), 0, 1), null);
});
