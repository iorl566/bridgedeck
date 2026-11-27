import test from 'node:test';
import assert from 'node:assert/strict';
import { createEffectLedger, committedEffect } from '../../extension/src/lib/transaction-ledger.js';

test('effect ledger 状态机', () => {
  const ledger = createEffectLedger('pointer');
  assert.deepEqual(ledger.snapshot(), { phase: 'pointer', effectState: 'none', cleanupState: 'ok', dispatched: false });
  ledger.dispatched();
  assert.equal(ledger.snapshot().effectState, 'unknown');
  ledger.commit();
  assert.deepEqual(ledger.snapshot(), { phase: 'pointer', effectState: 'committed', cleanupState: 'ok', dispatched: true });
});

test('effect ledger 失败 cleanup', () => {
  const ledger = createEffectLedger('file');
  ledger.dispatched();
  ledger.unknown();
  assert.deepEqual(ledger.snapshot(), { phase: 'file', effectState: 'unknown', cleanupState: 'failed', dispatched: true });
  assert.deepEqual(committedEffect('file'), { effectState: 'committed', cleanupState: 'ok', phase: 'file' });
});
