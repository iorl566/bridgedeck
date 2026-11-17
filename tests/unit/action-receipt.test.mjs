import test from 'node:test';
import assert from 'node:assert/strict';
import { attachReceipt, buildActionReceipt } from '../../extension/src/lib/action-receipt.js';

test('receipt 记录方法/ref/frame/revision/effect', () => {
  const receipt = buildActionReceipt({ method: 'click', ref: '@e2', frameId: 57, revision: 9, effectState: 'committed', via: 'trusted' });
  assert.deepEqual({ ...receipt }, {
    method: 'click', ref: '@e2', frameId: 57, revision: 9, effectState: 'committed', via: 'trusted', recovery: null,
  });
});

test('unknown effect 带恢复路径', () => {
  const receipt = buildActionReceipt({ method: 'fill', ref: '@e3', effectState: 'unknown' });
  assert.equal(receipt.effectState, 'unknown');
  assert.equal(receipt.recovery, 'observe --force');
});

test('不覆盖已有 receipt', () => {
  const original = { ok: true, receipt: { from: 'inner' } };
  assert.equal(attachReceipt(original, { from: 'outer' }), original);
});
