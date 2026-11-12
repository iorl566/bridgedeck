import test from 'node:test';
import assert from 'node:assert/strict';
import { beginTabCreation, waitForTabCreation } from '../../extension/src/session-manager/tab-creation.js';

test('waitForTabCreation resolves after finish', async () => {
  const task = {};
  const finish = beginTabCreation(task);
  let done = false;
  const waiting = waitForTabCreation(task).then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(done, false);
  finish();
  await waiting;
  assert.equal(done, true);
});

test('multiple creations are tracked independently', async () => {
  const a = {};
  const b = {};
  const finishA = beginTabCreation(a);
  const finishB = beginTabCreation(b);
  let aDone = false;
  const waiting = waitForTabCreation(a).then(() => { aDone = true; });
  finishA();
  await waiting;
  assert.equal(aDone, true);
  finishB();
});
