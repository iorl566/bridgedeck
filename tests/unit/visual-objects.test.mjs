import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisualObjects } from '../../extension/src/lib/visual-objects.js';

test('visualObjects 合并 region 与 ref', () => {
  const out = buildVisualObjects({
    regions: { candidates: [{ index: 1, tag: 'canvas', id: 'c', rect: { x: 1, y: 2, width: 3, height: 4 } }] },
    refs: { refs: [{ ref: '@e1', role: 'button', name: 'ok', x: 5, y: 6, width: 7, height: 8 }] },
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'region');
  assert.equal(out[1].kind, 'ref');
  assert.deepEqual(out[1].rect, { x: 5, y: 6, width: 7, height: 8 });
});
