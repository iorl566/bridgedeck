// 并发 attach 合并：session armTab 与 dialog.arm 同时挂载同一 tab 时只能 attach 一次。
import test from 'node:test';
import assert from 'node:assert/strict';

const state = { attachCalls: 0, detachCalls: 0 };
globalThis.chrome = {
  debugger: {
    attach: async () => {
      state.attachCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
    detach: async () => { state.detachCalls += 1; },
    sendCommand: async () => ({}),
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  tabs: {},
};

const { attach, detach, isAttached, attachedCount } = await import('../../extension/src/debugger.js');

test('同一 tab 并发 attach 只挂一次', async () => {
  state.attachCalls = 0;
  const [a, b] = await Promise.all([attach(11), attach(11)]);
  assert.equal(state.attachCalls, 1);
  assert.equal(a.tabId, 11);
  assert.equal(b.tabId, 11);
  assert.equal(isAttached(11), true);
  assert.equal(attachedCount() >= 1, true);
  await detach(11);
  assert.equal(isAttached(11), false);
  assert.equal(state.detachCalls, 1);
});

test('attach 进行中 detach 会等 attach 完成后再分离', async () => {
  state.attachCalls = 0;
  state.detachCalls = 0;
  const attaching = attach(12);
  const detaching = detach(12);
  await Promise.all([attaching.catch(() => {}), detaching.catch(() => {})]);
  assert.equal(state.attachCalls, 1);
  assert.equal(isAttached(12), false);
});
