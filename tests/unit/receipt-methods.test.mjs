import test from 'node:test';
import assert from 'node:assert/strict';
import { needsReceipt } from '../../extension/src/lib/receipt-methods.js';

test('receipt 方法集合', () => {
  for (const method of ['click', 'fill', 'navigate', 'scroll-to', 'shadow.click']) assert.equal(needsReceipt(method), true, method);
  for (const method of ['observe', 'status', 'cooperate.sync']) assert.equal(needsReceipt(method), false, method);
});
