import test from 'node:test';
import assert from 'node:assert/strict';
import { createInflightOps } from '../../daemon/inflight-ops.js';

function make() {
  const inflight = new Map();
  inflight.set('c1', { id: 'c1', instanceId: 'i1', method: 'click', tabId: 7, startedAt: Date.now() - 100 });
  const calls = [];
  const ops = createInflightOps({
    inflight,
    instances: new Map([['i1', {}]]),
    sendCommand: async (instance, method, params) => { calls.push([method, params]); return { cancelled: true }; },
    BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
  });
  return { ops, calls };
}

test('inflightList 返回命令与耗时', () => {
  const { ops } = make();
  const list = ops.inflightList();
  assert.equal(list.length, 1);
  assert.equal(list[0].method, 'click');
  assert.ok(list[0].elapsedMs >= 100);
});

test('cancelInflight 转发取消，缺失 E_NOT_FOUND', async () => {
  const { ops, calls } = make();
  const result = await ops.cancelInflight({ id: 'c1' });
  assert.equal(result.forwarded, true);
  assert.equal(result.accepted, true);
  assert.ok(calls.some(([method]) => method === 'cancel'));
  await assert.rejects(() => ops.cancelInflight({ id: 'none' }), (error) => error.code === 'E_NOT_FOUND');
});
