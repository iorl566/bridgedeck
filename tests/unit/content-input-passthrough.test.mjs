import test from 'node:test';
import assert from 'node:assert/strict';
import { INPUT_PASSTHROUGH_ATTR, INPUT_PASSTHROUGH, isInputPassthroughMessage, sendInputPassthrough } from '../../extension/src/lib/input-passthrough-bridge.js';
import { createInputPassthroughController } from '../../extension/src/content/input-passthrough.js';

function harness() {
  const state = { has: false };
  const host = { toggleAttribute: (name, on) => { assert.equal(name, INPUT_PASSTHROUGH_ATTR); state.has = Boolean(on); } };
  const controller = createInputPassthroughController(() => host);
  return { controller, state, host };
}

test('bridge validates message shape and sends it', async () => {
  assert.equal(isInputPassthroughMessage({ type: INPUT_PASSTHROUGH, phase: 'begin', id: 'a' }), true);
  assert.equal(isInputPassthroughMessage({ type: INPUT_PASSTHROUGH, phase: 'end', id: '' }), false);
  const sent = [];
  await sendInputPassthrough(7, { type: INPUT_PASSTHROUGH, phase: 'begin', id: 'a' }, { async sendMessage(tabId, message) { sent.push([tabId, message]); } });
  assert.equal(sent[0][0], 7);
});

test('begin/end toggles the passthrough attribute', () => {
  const { controller, state } = harness();
  controller.handleMessage({ phase: 'begin', id: 'a' }, () => {});
  assert.equal(state.has, true);
  assert.equal(controller.pendingCount, 1);
  controller.handleMessage({ phase: 'end', id: 'a' }, () => {});
  assert.equal(state.has, false);
  assert.equal(controller.pendingCount, 0);
});

test('duplicate begin keeps one lease and reset clears all', () => {
  const { controller, state } = harness();
  controller.handleMessage({ phase: 'begin', id: 'a' }, () => {});
  controller.handleMessage({ phase: 'begin', id: 'a' }, () => {});
  controller.handleMessage({ phase: 'begin', id: 'b' }, () => {});
  assert.equal(controller.pendingCount, 2);
  controller.reset();
  assert.equal(controller.pendingCount, 0);
  assert.equal(state.has, false);
});

test('onHostMounted re-applies pending state', () => {
  const { controller, state, host } = harness();
  controller.handleMessage({ phase: 'begin', id: 'a' }, () => {});
  state.has = false;
  controller.onHostMounted(host);
  assert.equal(state.has, true);
  controller.reset();
});
