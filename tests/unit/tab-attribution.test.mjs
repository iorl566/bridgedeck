import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeSelfCreated, isSelfCreatedWindow, markSelfCreated, markSelfCreatedWindow } from '../../extension/src/tab-attribution.js';

test('self-created tab/window 归属', () => {
  markSelfCreated(7);
  assert.equal(consumeSelfCreated(7), true);
  assert.equal(consumeSelfCreated(7), false);
  markSelfCreatedWindow(9);
  assert.equal(isSelfCreatedWindow(9), true);
});
