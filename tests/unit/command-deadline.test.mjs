import test from 'node:test';
import assert from 'node:assert/strict';

test('deadline rejects with E_TIMEOUT', async () => {
  const { createDeadline } = await import('../../extension/src/command-deadline.js');
  const deadline = createDeadline(5, 'wait');
  await assert.rejects(deadline.promise, (error) => error.code === 'E_TIMEOUT');
  assert.equal(deadline.expired, true);
});

test('deadline cancel avoids late rejection', async () => {
  const { createDeadline } = await import('../../extension/src/command-deadline.js');
  const deadline = createDeadline(1000, 'cancel-me');
  deadline.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deadline.expired, false);
});
