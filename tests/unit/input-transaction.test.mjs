import test from 'node:test';
import assert from 'node:assert/strict';
import { InputTransactions } from '../../extension/src/lib/input-transaction.js';

test('同一 tab 冲突，不同 tab 互不影响', () => {
  const tx = new InputTransactions({ ttlMs: 1000, now: () => 0 });
  assert.equal(tx.begin(1, 'pointer').ok, true);
  const conflict = tx.begin(1, 'key');
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'E_INPUT_BUSY');
  assert.equal(tx.begin(2, 'key').ok, true);
  tx.end(1, 'pointer');
  assert.equal(tx.begin(1, 'key').ok, true);
});

test('错误 kind 不会释放别人的事务', () => {
  const tx = new InputTransactions({ ttlMs: 1000, now: () => 0 });
  tx.begin(1, 'pointer');
  assert.equal(tx.end(1, 'key'), false);
  assert.equal(tx.get(1).kind, 'pointer');
  assert.equal(tx.end(1, 'pointer'), true);
  assert.equal(tx.get(1), null);
});

test('过期事务可回收', () => {
  let now = 0;
  const tx = new InputTransactions({ ttlMs: 100, now: () => now });
  tx.begin(1, 'pointer');
  now = 101;
  assert.equal(tx.begin(1, 'key').ok, true);
  assert.equal(tx.get(1).kind, 'key');
});
