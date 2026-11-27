import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionDispatch } from '../../daemon/extension-dispatch.js';

function make() {
  const calls = [];
  const route = { instance: { instanceId: 'i1' }, session: { sessionId: 's1', tabId: 7, paused: true, pausedBy: 'auto' }, params: {} };
  const dispatch = createExtensionDispatch({
    prepareRoute: async () => route,
    routePolicy: { enforceSessionPolicy: async (r, method) => calls.push(['policy', method]) },
    requireFeatures: () => calls.push(['features']),
    verifyDecision: () => calls.push(['verify']),
    submitApi: { submitRouted: async (r, method, params) => ({ ok: true, method }) },
    saveSessions: () => calls.push(['save']),
    sendInstanceEvent: (instance, event, payload) => calls.push(['event', event, payload]),
  });
  return { dispatch, route, calls };
}

test('dispatchExtension 走 policy/features/verify/submit', async () => {
  const { dispatch, calls } = make();
  const result = await dispatch.dispatchExtension('click', {}, 1000);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.slice(0, 3).map(([kind]) => kind), ['policy', 'features', 'verify']);
});

test('cooperate.handback 同步解除暂停并发 takeover.state', async () => {
  const { dispatch, route, calls } = make();
  await dispatch.dispatchExtension('cooperate.handback', {}, 1000);
  assert.equal(route.session.paused, false);
  assert.ok(calls.some(([kind, event]) => kind === 'event' && event === 'takeover.state'));
  assert.ok(calls.some(([kind]) => kind === 'save'));
});
