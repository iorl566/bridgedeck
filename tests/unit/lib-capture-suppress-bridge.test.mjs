import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_SUPPRESS, isCaptureSuppressMessage, withExtensionOverlayHidden } from '../../extension/src/lib/capture-suppress-bridge.js';

test('capture suppress message validation', () => {
  assert.equal(isCaptureSuppressMessage({ type: CAPTURE_SUPPRESS, phase: 'begin' }), true);
  assert.equal(isCaptureSuppressMessage({ type: CAPTURE_SUPPRESS, phase: 'end' }), true);
  assert.equal(isCaptureSuppressMessage({ type: CAPTURE_SUPPRESS, phase: 'other' }), false);
  assert.equal(isCaptureSuppressMessage(null), false);
});

test('hides overlay around fn and restores', async () => {
  const sent = [];
  const result = await withExtensionOverlayHidden(7, async () => 'shot', async (tabId, message) => { sent.push([tabId, message.phase]); });
  assert.equal(result, 'shot');
  assert.deepEqual(sent, [[7, 'begin'], [7, 'end']]);
});

test('begin failure proceeds without suppression', async () => {
  const sent = [];
  const result = await withExtensionOverlayHidden(7, async () => 'shot', async (tabId, message) => {
    sent.push(message.phase);
    if (message.phase === 'begin') throw new Error('no receiver');
  });
  assert.equal(result, 'shot');
  assert.deepEqual(sent, ['begin']);
});

test('fn failure still restores overlay', async () => {
  const sent = [];
  await assert.rejects(() => withExtensionOverlayHidden(7, async () => { throw new Error('capture failed'); }, async (tabId, message) => { sent.push(message.phase); }), /capture failed/);
  assert.deepEqual(sent, ['begin', 'end']);
});
