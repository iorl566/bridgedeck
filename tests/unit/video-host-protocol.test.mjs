import test from 'node:test';
import assert from 'node:assert/strict';
import { hostRequest, isIdempotentHostAction, parseHostReply } from '../../extension/src/video/host-protocol.js';

test('host request/reply roundtrip', () => {
  assert.deepEqual(hostRequest('1', { action: 'idle' }), { id: '1', command: { action: 'idle' } });
  assert.deepEqual(parseHostReply({ id: '1', result: true }), { id: '1', result: true });
  const error = parseHostReply({ id: '2', error: { message: 'bad' } });
  assert.equal(error.error.code, 'cdp_failed');
  assert.throws(() => parseHostReply({}), /Invalid video host reply/);
});

test('idempotent actions can retry after disconnect', () => {
  assert.equal(isIdempotentHostAction('stop'), true);
  assert.equal(isIdempotentHostAction('recover'), true);
  assert.equal(isIdempotentHostAction('idle'), true);
  assert.equal(isIdempotentHostAction('revoke_url'), true);
  assert.equal(isIdempotentHostAction('frame'), false);
});
