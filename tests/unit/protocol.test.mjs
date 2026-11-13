import test from 'node:test';
import assert from 'node:assert/strict';
import { compareProtocol, effectOf, isAllowedWhilePaused, isFileTransferMethod, shouldRejectRemoteTransfer } from '../../lib/protocol.mjs';

test('effect classification and pause policy', () => {
  assert.equal(effectOf('observe'), 'passive_read');
  assert.equal(effectOf('click'), 'browser_mutation');
  assert.equal(effectOf('unknown-method'), 'browser_mutation');
  assert.equal(isAllowedWhilePaused('observe'), true);
  assert.equal(isAllowedWhilePaused('click'), false);
  assert.equal(isAllowedWhilePaused('session.list'), true);
});

test('file transfer methods are rejected for remote instances', () => {
  assert.equal(isFileTransferMethod('upload'), true);
  assert.equal(isFileTransferMethod('download'), true);
  assert.equal(isFileTransferMethod('click'), false);
  assert.equal(shouldRejectRemoteTransfer({ remote: true }, 'upload'), true);
  assert.equal(shouldRejectRemoteTransfer({ remote: false }, 'upload'), false);
});

test('compareProtocol orders major then minor', () => {
  assert.equal(compareProtocol('1.8', '1.7') > 0, true);
  assert.equal(compareProtocol('2.0', '1.99') > 0, true);
  assert.equal(compareProtocol('1.8', '1.8'), 0);
  assert.equal(compareProtocol('bad', '1.0'), null);
});
