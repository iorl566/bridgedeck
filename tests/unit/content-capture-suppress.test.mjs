import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_HIDDEN_ATTR, CAPTURE_SUPPRESS, createCaptureSuppressController } from '../../extension/src/content/capture-suppress.js';

function harness() {
  const attrs = new Set();
  const host = { setAttribute: (name) => attrs.add(name), removeAttribute: (name) => attrs.delete(name) };
  const acks = [];
  const controller = createCaptureSuppressController(() => host, { nextFrame: async () => {} });
  return { controller, attrs, acks, host };
}

test('begin hides host and acks after frames', async () => {
  const { controller, attrs, acks } = harness();
  assert.equal(controller.handleMessage({ phase: 'begin' }, (ack) => acks.push(ack)), true);
  assert(attrs.has(CAPTURE_HIDDEN_ATTR));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(acks, [{ type: CAPTURE_SUPPRESS, ok: true }]);
  assert.equal(controller.pendingCount, 1);
});

test('end is reference counted', async () => {
  const { controller, attrs } = harness();
  controller.handleMessage({ phase: 'begin' }, () => {});
  controller.handleMessage({ phase: 'begin' }, () => {});
  controller.handleMessage({ phase: 'end' }, () => {});
  assert(attrs.has(CAPTURE_HIDDEN_ATTR));
  controller.handleMessage({ phase: 'end' }, () => {});
  assert.equal(attrs.has(CAPTURE_HIDDEN_ATTR), false);
  assert.equal(controller.pendingCount, 0);
});

test('onHostMounted keeps a rebuilt host hidden while pending', () => {
  const { controller, attrs, host } = harness();
  controller.handleMessage({ phase: 'begin' }, () => {});
  attrs.clear();
  controller.onHostMounted(host);
  assert(attrs.has(CAPTURE_HIDDEN_ATTR));
});
