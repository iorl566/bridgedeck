import test from 'node:test';
import assert from 'node:assert/strict';
import { runInQueues } from '../../daemon/route-queue.js';

function queues() {
  const calls = [];
  return {
    calls,
    sessionQueue: { enqueue: async (key, fn) => { calls.push('session:' + key); return fn(); } },
    tabQueue: { enqueue: async (key, fn) => { calls.push('tab:' + key); return fn(); } },
  };
}

test('runInQueues 会话命令走 session/tab 队列', async () => {
  const { calls, sessionQueue, tabQueue } = queues();
  const route = { session: { sessionId: 's1', tabId: 7 } };
  const result = await runInQueues({ route, method: 'click', run: async () => 'ok', sessionQueue, tabQueue, bypass: new Set() });
  assert.equal(result, 'ok');
  assert.deepEqual(calls, ['session:s1', 'tab:tab:7']);
});

test('runInQueues bypass 方法不排队', async () => {
  const { calls, sessionQueue, tabQueue } = queues();
  const route = { session: { sessionId: 's1', tabId: 7 } };
  const result = await runInQueues({ route, method: 'observe', run: async () => 'ok', sessionQueue, tabQueue, bypass: new Set(['observe']) });
  assert.equal(result, 'ok');
  assert.deepEqual(calls, []);
});
