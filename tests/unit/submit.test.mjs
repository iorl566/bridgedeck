import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmit } from '../../daemon/submit.js';

function make(overrides = {}) {
  const finished = [];
  const api = createSubmit({
    intentLedger: {
      begin: () => ({ id: 'i1' }),
      finish: (intent, status) => finished.push(status),
    },
    routeExtension: async () => ({ ok: true }),
    withEffectState: (error, state) => { error.data = { ...(error.data || {}), effect_state: state }; return error; },
    annotateEffectSuccess: (result) => ({ ...result, effectState: 'committed' }),
    sessions: new Map([['s1', { sessionId: 's1' }]]),
    resolveSessionByScope: () => ({ session: { sessionId: 's1' } }),
    BridgeError: class extends Error {},
    ledgerTargetFromRoute: () => null,
    ...overrides,
  });
  return { api, finished };
}

test('submitRouted 成功落账并标 committed', async () => {
  const { api, finished } = make();
  const result = await api.submitRouted({}, 'click', {}, 1000);
  assert.equal(result.effectState, 'committed');
  assert.deepEqual(finished, ['done']);
});

test('submitRouted 失败落账 unknown', async () => {
  const { api, finished } = make({
    routeExtension: async () => {
      const error = new Error('timeout');
      error.code = 'E_TIMEOUT';
      error.effectState = 'unknown';
      throw error;
    },
  });
  await assert.rejects(() => api.submitRouted({}, 'click', {}, 1000));
  assert.deepEqual(finished, ['unknown']);
});

test('applySessionScope 解析并删除 sessionScope', () => {
  const { api } = make();
  const params = { sessionScope: 'project:x' };
  api.applySessionScope(params);
  assert.equal(params.session, 's1');
  assert.equal(params.sessionScope, undefined);
});
