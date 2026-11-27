import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanRunner } from '../../daemon/plan-run.js';

function make(failAt = -1) {
  const calls = [];
  const runner = createPlanRunner({
    BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    dispatchInner: async (method, params) => {
      calls.push([method, params]);
      if (method === 'fail') { const error = new Error('boom'); error.code = 'E_BOOM'; throw error; }
      return { ok: true };
    },
    extensionDispatch: { dispatchExtension: async (method) => { calls.push(['observe', method]); return { observation: 'text', refs: 1, url: 'u' }; } },
  });
  return { runner, calls };
}

test('runPlan 顺序执行并汇总', async () => {
  const { runner, calls } = make();
  const result = await runner.runPlan({ steps: [{ method: 'click', params: {} }, { method: 'fill', params: {} }] }, 1000);
  assert.equal(result.completed, 2);
  assert.equal(result.failedAt, null);
  assert.equal(result.observation.text, 'text');
  assert.deepEqual(calls.slice(0, 2).map(([method]) => method), ['click', 'fill']);
});

test('runPlan 默认首错即停', async () => {
  const { runner } = make();
  const result = await runner.runPlan({ steps: [{ method: 'click' }, { method: 'fail' }, { method: 'click' }] }, 1000);
  assert.equal(result.completed, 1);
  assert.equal(result.failedAt, 1);
});

test('runPlan 拒绝空 steps', async () => {
  const { runner } = make();
  await assert.rejects(() => runner.runPlan({ steps: [] }, 1000), (error) => error.code === 'E_BAD_ARG');
});
