import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionQueue } from '../../lib/session-queue.mjs';

test('session queue serializes tasks in submission order', async () => {
  const queue = createSessionQueue({ capacity: 4 });
  const order = [];
  const first = queue.enqueue('s1', async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push('first');
    return 1;
  });
  const second = queue.enqueue('s1', async () => {
    order.push('second');
    return 2;
  });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first', 'second']);
});

test('session queue enforces capacity', async () => {
  const queue = createSessionQueue({ capacity: 1 });
  const blocker = queue.enqueue('s1', () => new Promise((resolve) => setTimeout(resolve, 20)));
  await assert.rejects(queue.enqueue('s1', async () => 2), (error) => error.code === 'E_QUEUE_FULL');
  await blocker;
  assert.equal(await queue.enqueue('s1', async () => 3), 3);
});

test('session queue drops and rejects new work', async () => {
  const queue = createSessionQueue({ capacity: 2 });
  queue.enqueue('s1', async () => 1);
  queue.drop('s1');
  await assert.rejects(queue.enqueue('s1', async () => 2), (error) => error.code === 'E_SESSION_STOPPED');
  assert.equal(queue.snapshot().length, 0);
});
