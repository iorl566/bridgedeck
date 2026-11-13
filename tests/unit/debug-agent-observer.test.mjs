import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugObserver, OBSERVATION_TIMEOUT_MS } from '../../extension/src/debug/observer.js';

function cdpHarness() {
  const sends = [];
  return {
    sends,
    async sendAttached(target, method, params) {
      sends.push([target, method, params]);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 21 };
      if (method === 'Runtime.evaluate') return { result: { value: params?.returnByValue ? 'value' : undefined } };
      return {};
    },
  };
}

test('start binds a named world and evaluates the observer', async () => {
  const cdp = cdpHarness();
  const observer = new DebugObserver(cdp, 5, 'd1');
  assert.equal(observer.world, 'bb-debug-d1');
  assert.equal(observer.binding, '__bb_debug_d1');
  assert.equal(observer.isRoot('frame-1'), false);
  await observer.start();
  assert.deepEqual(cdp.sends.map(([, method]) => method), [
    'Page.getFrameTree',
    'Runtime.addBinding',
    'Page.addScriptToEvaluateOnNewDocument',
    'Page.createIsolatedWorld',
    'Runtime.evaluate',
  ]);
  assert.deepEqual(cdp.sends[0][0], { tabId: 5 });
  assert.deepEqual(cdp.sends[1][2], {
    name: '__bb_debug_d1',
    executionContextName: 'bb-debug-d1',
  });
  assert.equal(observer.isRoot('frame-1'), true);
  assert.equal(observer.isRoot(undefined), false);
  const script = cdp.sends[2][2];
  assert.equal(script.worldName, 'bb-debug-d1');
  assert.ok(script.source.includes('__bb_debug_d1'));
  assert.ok(script.source.includes('MutationObserver'));
  assert.deepEqual(cdp.sends[3][2], { frameId: 'frame-1', worldName: 'bb-debug-d1' });
  assert.equal(cdp.sends[4][2].contextId, 21);
  assert.ok(cdp.sends[4][2].expression.includes('?.snapshot'));
  await observer.dispose();
});

test('context tracking accepts only the installing world', async () => {
  const cdp = cdpHarness();
  const observer = new DebugObserver(cdp, 5, 'd1');
  await observer.start();
  observer.contextEvent('Runtime.executionContextCreated', {
    context: { id: 21, name: 'bb-debug-d1', auxData: { frameId: 'frame-1' } },
  });
  observer.contextEvent('Runtime.executionContextCreated', {
    context: { id: 99, name: 'other-world', auxData: { frameId: 'frame-1' } },
  });
  observer.contextEvent('Runtime.executionContextCreated', {
    context: { id: 77, name: 'bb-debug-d1', auxData: { frameId: 'other-frame' } },
  });
  assert.equal(observer.contexts.size, 1);
  assert.equal(observer.accepts({ name: '__bb_debug_d1', executionContextId: 21 }), true);
  assert.equal(observer.accepts({ name: '__bb_debug_d1', executionContextId: 99 }), false);
  assert.equal(observer.accepts({ name: 'wrong-binding', executionContextId: 21 }), false);
  observer.contextEvent('Runtime.executionContextDestroyed', { executionContextId: 21 });
  assert.equal(observer.contexts.size, 0);
  assert.equal(observer.accepts({ name: '__bb_debug_d1', executionContextId: 21 }), false);
  assert.equal(await observer.call('snapshot'), undefined);
  observer.contextEvent('Runtime.executionContextCreated', {
    context: { id: 21, name: 'bb-debug-d1', auxData: { frameId: 'frame-1' } },
  });
  observer.contextEvent('Runtime.executionContextsCleared', {});
  assert.equal(observer.contexts.size, 0);
  await observer.dispose();
});

test('call carries an agent revision and a bounded expiry', async () => {
  const cdp = cdpHarness();
  const observer = new DebugObserver(cdp, 5, 'd2');
  await observer.start();
  assert.equal(await observer.call('snapshot'), 'value');
  cdp.sends.length = 0;
  await observer.call('agent', true);
  const expression = cdp.sends[0][2].expression;
  assert.ok(expression.includes('.agent(true,1,'));
  const expiresAt = Number(expression.match(/,(\d+)\)$/)[1]);
  assert.ok(expiresAt >= Date.now() + OBSERVATION_TIMEOUT_MS - 1000);
  await observer.call('agent', true);
  assert.ok(cdp.sends[1][2].expression.includes('.agent(true,2,'));
  assert.deepEqual(cdp.sends[1][2].returnByValue, true);
  await observer.dispose();
});

test('dispose removes the preload script, world instances and binding', async () => {
  const cdp = cdpHarness();
  const observer = new DebugObserver(cdp, 5, 'd3');
  await observer.start();
  cdp.sends.length = 0;
  await observer.dispose();
  assert.deepEqual(cdp.sends.map(([, method]) => method), [
    'Page.removeScriptToEvaluateOnNewDocument',
    'Runtime.evaluate',
    'Runtime.removeBinding',
  ]);
  assert.deepEqual(cdp.sends[0][2], { identifier: 'script-1' });
  assert.ok(cdp.sends[1][2].expression.includes('?.dispose()'));
  assert.equal(observer.stopped, true);
  assert.equal(observer.script, undefined);
  assert.equal(observer.contexts.size, 0);
  assert.equal(await observer.call('snapshot'), undefined);
  assert.equal(OBSERVATION_TIMEOUT_MS, 600);
});

test('a stop before frames are bound disposes instead of installing a script', async () => {
  const cdp = cdpHarness();
  const observer = new DebugObserver(cdp, 5, 'd4');
  const started = observer.start();
  await observer.dispose();
  await started;
  assert.equal(observer.stopped, true);
  assert.equal(observer.script, undefined);
  assert.ok(!cdp.sends.some(([, method]) => method === 'Page.addScriptToEvaluateOnNewDocument'));
  assert.ok(cdp.sends.some(([, method]) => method === 'Runtime.removeBinding'));
});
