import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HELP_REQUEST, isHelpAckMessage, isHelpCancelMessage, isHelpFinishMessage,
  isHelpQueryMessage, isHelpRequestMessage, isHelpResponseMessage,
} from '../../extension/src/lib/help-bridge.js';

test('help request validation', () => {
  const base = { type: HELP_REQUEST, requestId: 'r', prompt: 'p', selectors: ['#a'], timeoutMs: 1000 };
  assert.equal(isHelpRequestMessage(base), true);
  assert.equal(isHelpRequestMessage({ ...base, displayMode: 'full', title: 't', rects: [{ top: 1, left: 2, width: 3, height: 4 }] }), true);
  assert.equal(isHelpRequestMessage({ ...base, selectors: [1] }), false);
  assert.equal(isHelpRequestMessage({ ...base, rects: [{ top: 1 }] }), false);
  assert.equal(isHelpRequestMessage({ ...base, displayMode: 'compact' }), true);
  assert.equal(isHelpRequestMessage({ ...base, timeoutMs: '1' }), false);
});

test('help cancel/ack/query validation', () => {
  assert.equal(isHelpCancelMessage({ type: 'bb-help-cancel', requestId: 'r' }), true);
  assert.equal(isHelpAckMessage({ type: 'bb-help-ack', ok: true }), true);
  assert.equal(isHelpAckMessage({ type: 'bb-help-ack', ok: false }), false);
  assert.equal(isHelpQueryMessage({ type: 'bb-help-query' }), true);
});

test('help response/finish validation', () => {
  assert.equal(isHelpResponseMessage({ type: 'bb-help-response', outcome: 'continued' }), true);
  assert.equal(isHelpResponseMessage({ type: 'bb-help-response', outcome: 'other' }), false);
  assert.equal(isHelpFinishMessage({ type: 'bb-help-finish', requestId: 'r', outcome: 'cancelled', note: 'n' }), true);
  assert.equal(isHelpFinishMessage({ type: 'bb-help-finish', requestId: 'r', outcome: 'bad' }), false);
});
