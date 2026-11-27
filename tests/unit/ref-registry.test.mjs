import test from 'node:test';
import assert from 'node:assert/strict';
import { RefRegistry, makeRefKey, refKeyId, sameRef } from '../../extension/src/refs/ref-registry.js';

test('RefKey 需要 backendNodeId/documentId，并生成稳定 id', () => {
  const key = makeRefKey({ backendNodeId: 42, frameId: 7, cdpSessionId: 's1', documentId: 'doc', revision: 3 });
  assert.equal(key.backendNodeId, 42);
  assert.equal(refKeyId(key), 'doc:7:42:3');
  assert.throws(() => makeRefKey({ frameId: 7, documentId: 'doc' }), /backendNodeId/);
  assert.throws(() => makeRefKey({ backendNodeId: 1 }), /documentId/);
});

test('sameRef 允许 null revision 通配', () => {
  const a = makeRefKey({ backendNodeId: 1, frameId: 0, documentId: 'd', revision: 2 });
  const b = makeRefKey({ backendNodeId: 1, frameId: 0, documentId: 'd', revision: 2 });
  const c = makeRefKey({ backendNodeId: 1, frameId: 0, documentId: 'd', revision: null });
  assert.equal(sameRef(a, b), true);
  assert.equal(sameRef(a, c), true);
  assert.equal(sameRef(a, { ...b, revision: 4 }), false);
});

test('RefRegistry 注册/解析/版本失效', () => {
  const registry = new RefRegistry({ now: () => 1000 });
  registry.register(9, '@e1', { backendNodeId: 11, frameId: 0, documentId: 'd1', revision: 4 }, { role: 'button', name: '提交' });
  assert.equal(registry.size(9), 1);
  assert.equal(registry.resolve(9, '@e1', { documentId: 'd1', revision: 4 }).ok, true);
  assert.equal(registry.resolve(9, '@e1', { revision: 5 }).ok, false);
  assert.equal(registry.resolve(9, '@e1', { documentId: 'd2' }).ok, false);
  assert.equal(registry.resolve(9, '@e2').ok, false);
  assert.equal(registry.invalidateDocument(9, 'd1'), 1);
  assert.equal(registry.size(9), 0);
});

test('RefRegistry sweep 清理过期项', () => {
  let now = 0;
  const registry = new RefRegistry({ now: () => now });
  registry.register(1, '@e1', { backendNodeId: 1, frameId: 0, documentId: 'd', revision: 1 });
  now = 10_000;
  assert.equal(registry.sweep(5_000), 1);
  assert.equal(registry.size(1), 0);
});

test('RefRegistry 可按 stableRef 查找', () => {
  const registry = new RefRegistry();
  registry.register(1, '@e1', { backendNodeId: 1, frameId: 0, documentId: 'd', revision: 1 }, { stableRef: 's-1' });
  assert.equal(registry.getByStableRef(1, 's-1').ref, '@e1');
  assert.equal(registry.getByStableRef(1, 's-2'), null);
});
