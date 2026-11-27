import test from 'node:test';
import assert from 'node:assert/strict';
import { diffNodeSignatures, summarizeNodeSignatures, NODE_BLOCKING_KINDS } from '../../extension/src/lib/node-signature.js';

function sig(extra = {}) {
  return {
    present: true,
    tag: 'button',
    id: 'submit-btn',
    name: '',
    textLength: 4,
    textHash: 'aaaa1111',
    valueHash: 'bbbb2222',
    attrsHash: 'cccc3333',
    geometry: [10, 20, 100, 30],
    disabled: false,
    checked: null,
    revision: 7,
    ...extra,
  };
}

test('签名完全一致 → 无变化', () => {
  const diff = diffNodeSignatures(sig(), sig());
  assert.equal(diff.changed, false);
  assert.deepEqual(diff.kinds, []);
  assert.deepEqual(diff.blockingKinds, []);
});

test('只有几何变化 → 记录但不阻断（滚动/重排不该拦读取）', () => {
  const diff = diffNodeSignatures(sig(), sig({ geometry: [0, 20, 100, 30] }));
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.advisoryKinds, ['geometry']);
  assert.deepEqual(diff.blockingKinds, []);
  assert.equal(diff.changes[0].kind, 'geometry');
});

test('文本/值/属性变化 → 阻断并带 before/after', () => {
  const text = diffNodeSignatures(sig(), sig({ textHash: 'dddd4444' }));
  assert.deepEqual(text.blockingKinds, ['text']);
  assert.equal(text.changes[0].before, 'aaaa1111');
  assert.equal(text.changes[0].after, 'dddd4444');

  const value = diffNodeSignatures(sig(), sig({ valueHash: 'eeee5555' }));
  assert.deepEqual(value.blockingKinds, ['value']);

  const attrs = diffNodeSignatures(sig(), sig({ attrsHash: 'ffff6666' }));
  assert.deepEqual(attrs.blockingKinds, ['attributes']);
});

test('身份字段（tag/id/name）变化 → identity 阻断', () => {
  const diff = diffNodeSignatures(sig(), sig({ tag: 'a', id: 'other' }));
  assert.ok(diff.blockingKinds.includes('identity'));
  assert.equal(diff.changes.filter((item) => item.kind === 'identity').length, 2);
});

test('disabled/checked 变化 → state', () => {
  const diff = diffNodeSignatures(sig(), sig({ disabled: true }));
  assert.deepEqual(diff.blockingKinds, ['state']);
  assert.equal(diff.changes[0].field, 'disabled');
  const checked = diffNodeSignatures(sig({ checked: false }), sig({ checked: true }));
  assert.deepEqual(checked.blockingKinds, ['state']);
});

test('文本长度不同但哈希相同（碰撞兜底）→ text', () => {
  const diff = diffNodeSignatures(sig(), sig({ textLength: 5 }));
  assert.deepEqual(diff.blockingKinds, ['text']);
  assert.equal(diff.changes[0].field, 'textLength');
});

test('节点已移除 → detached，且 detach 是阻断项', () => {
  const diff = diffNodeSignatures(sig(), { present: false, code: 'E_STALE_REF', revision: 9 });
  assert.equal(diff.detached, true);
  assert.deepEqual(diff.kinds, ['detached']);
  assert.deepEqual(diff.blockingKinds, ['detached']);
  assert.equal(diff.changes[0].after, 'E_STALE_REF');
  assert.ok(NODE_BLOCKING_KINDS.includes('detached'));
});

test('没有观测签名（before 缺失）→ 按 identity 阻断，fail-closed', () => {
  const diff = diffNodeSignatures(null, sig());
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.blockingKinds, ['identity']);
});

test('乱序/advisory 与阻断项混合时都列出', () => {
  const diff = diffNodeSignatures(sig(), sig({ textHash: 'zzzz', geometry: [1, 1, 1, 1] }));
  assert.ok(diff.blockingKinds.includes('text'));
  assert.ok(diff.advisoryKinds.includes('geometry'));
  assert.equal(diff.changed, true);
});

test('summarizeNodeSignatures 输出数量与去重，且不泄露文本', () => {
  const summary = summarizeNodeSignatures([
    sig({ ref: '@e1' }),
    sig({ ref: '@e2', id: 'b', textHash: 'x' }),
    sig({ ref: '@e3' }),
  ]);
  assert.equal(summary.count, 3);
  assert.equal(summary.unique, 2);
  assert.equal(Object.keys(summary).sort().join(','), 'count,unique');
  assert.deepEqual(summarizeNodeSignatures(null), { count: 0, unique: 0 });
});
