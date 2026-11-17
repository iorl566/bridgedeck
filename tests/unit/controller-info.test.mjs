import test from 'node:test';
import assert from 'node:assert/strict';
import { controllerColor, isControllerInfo } from '../../extension/src/lib/controller-info.js';

test('isControllerInfo validates labels and color', () => {
  assert.equal(isControllerInfo({ name: 'a' }), true);
  assert.equal(isControllerInfo({ name: 'a', project: 'p', color: '#aabbcc' }), true);
  assert.equal(isControllerInfo({ name: '' }), false);
  assert.equal(isControllerInfo({ name: 'x'.repeat(81) }), false);
  assert.equal(isControllerInfo({ name: 'a', color: 'red' }), false);
  assert.equal(isControllerInfo({ name: 'a\u0000' }), false);
});

test('controllerColor prefers explicit color and avoids used colors', () => {
  assert.equal(controllerColor('s1', { color: '#123456' }), '#123456');
  const first = controllerColor('s1');
  const second = controllerColor('s1', null, [first]);
  assert.notEqual(first, second);
});
