import test from 'node:test';
import assert from 'node:assert/strict';
import { RefRegistry } from '../../extension/src/refs/ref-registry.js';
import { buildVisualObjects } from '../../extension/src/lib/visual-objects.js';
import { buildRefDetails } from '../../extension/src/lib/ref-details.js';
import { listMethods } from '../../lib/method-catalog.mjs';

function ms(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

test('RefRegistry 20k 注册/解析在预算内', () => {
  const registry = new RefRegistry();
  const elapsed = ms(() => {
    for (let i = 0; i < 20000; i += 1) {
      const ref = '@e' + i;
      registry.register(1, ref, { backendNodeId: i + 1, frameId: 0, documentId: 'd', revision: 1 });
      assert.equal(registry.resolve(1, ref, { documentId: 'd', revision: 1 }).ok, true);
    }
  });
  assert.ok(elapsed < 2000, 'RefRegistry 太慢：' + Math.round(elapsed) + 'ms');
});

test('visualObjects / refDetails / method catalog 构建预算', () => {
  const regions = { candidates: Array.from({ length: 200 }, (_, i) => ({ index: i, tag: 'canvas', id: '', rect: { x: i, y: i, width: 1, height: 1 } })) };
  const refs = { refs: Array.from({ length: 200 }, (_, i) => ({ ref: '@e' + i, role: 'button', name: 'x', x: i, y: i, width: 1, height: 1 })) };
  const nodes = Array.from({ length: 500 }, (_, i) => ({ ref: '@e' + i, backendNodeId: i + 1, role: 'button', name: 'x' }));
  const elapsed = ms(() => {
    for (let i = 0; i < 100; i += 1) {
      buildVisualObjects({ regions, refs });
      buildRefDetails(nodes, { frameId: 0, documentId: 'd', revision: 1 });
      listMethods();
    }
  });
  assert.ok(elapsed < 3000, '纯构建太慢：' + Math.round(elapsed) + 'ms');
});
