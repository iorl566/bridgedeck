import test from 'node:test';
import assert from 'node:assert/strict';
import { bumpControlGeneration, clearControlGeneration, controlGeneration } from '../../extension/src/control-generation.js';

test('control generation 单调递增并可清理', () => {
  clearControlGeneration(1);
  assert.equal(controlGeneration(1), 0);
  assert.equal(bumpControlGeneration(1), 1);
  assert.equal(bumpControlGeneration(1), 2);
  assert.equal(controlGeneration(1), 2);
  clearControlGeneration(1);
  assert.equal(controlGeneration(1), 0);
});
