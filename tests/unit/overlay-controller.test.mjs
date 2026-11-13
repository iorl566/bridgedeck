import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayController } from '../../extension/src/overlay-controller.js';

test('overlay controller opens once and returns stable token', () => {
  const controller = createOverlayController();
  const first = controller.open(1, 'help', { priority: 1 });
  const duplicate = controller.open(1, 'help', { priority: 1 });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.token, first.token);
});

test('overlay controller exclusive arbitration removes lower priorities', () => {
  const controller = createOverlayController();
  controller.open(1, 'help', { priority: 1 });
  controller.open(1, 'record', { priority: 2 });
  controller.open(1, 'takeover', { priority: 3, exclusive: true });
  const snapshot = controller.snapshot(1);
  assert.deepEqual(snapshot.overlays.map((entry) => entry.kind), ['takeover']);
});

test('overlay controller close honors token', () => {
  const controller = createOverlayController();
  const opened = controller.open(1, 'help', {});
  assert.equal(controller.close(1, 'help', 'wrong'), false);
  assert.equal(controller.close(1, 'help', opened.token), true);
  assert.equal(controller.snapshot(1).overlays.length, 0);
});

test('overlay controller capture lock is reference counted', () => {
  const controller = createOverlayController();
  controller.beginCapture(2);
  controller.beginCapture(2);
  assert.equal(controller.isCapturing(2), true);
  controller.endCapture(2);
  assert.equal(controller.isCapturing(2), true);
  controller.endCapture(2);
  assert.equal(controller.isCapturing(2), false);
});
