import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = {
  storage: {
    session: {
      async get() { return {}; },
      async set() {},
      async remove() {},
    },
  },
  tabs: {},
  windows: {},
};

test('control guard blocks DOM actions while human has paused agent', async () => {
  const { checkControl } = await import('../../extension/src/control.js');
  const { setTakeoverState } = await import('../../extension/src/takeover.js');
  setTakeoverState(301, { paused: true });
  assert.throws(
    () => checkControl({ tabId: 301, method: 'click', ref: '@e1' }),
    (error) => error.code === 'E_SESSION_PAUSED',
  );
  assert.doesNotThrow(() => checkControl({ tabId: 301, method: 'observe' }));
  setTakeoverState(301, { paused: false });
  assert.doesNotThrow(() => checkControl({ tabId: 301, method: 'click', ref: '@e1' }));
});

test('strict policy still reports stale context after pause guard', async () => {
  const { checkControl } = await import('../../extension/src/control.js');
  const { setTakeoverState } = await import('../../extension/src/takeover.js');
  setTakeoverState(302, { paused: false });
  assert.throws(
    () => checkControl({ tabId: 302, method: 'click', ref: '@e1', context: 'wrong' }),
    (error) => error.code === 'E_CONTEXT_STALE',
  );
});
