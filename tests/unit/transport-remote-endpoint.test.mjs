import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRemoteEndpoint, readRemoteEndpoint, remoteAuthorizationStatus, remoteSocket,
  REMOTE_AUTH_PROTOCOL_PREFIX, REMOTE_ENDPOINT_KEY,
} from '../../extension/src/transport/remote-endpoint.js';

const token = 't'.repeat(32);

test('parseRemoteEndpoint validates scheme/host/query/token', () => {
  assert.deepEqual(parseRemoteEndpoint(`wss://gate.example/ws#${token}`), { url: 'wss://gate.example/ws', token });
  assert(parseRemoteEndpoint(`ws://127.0.0.1:1/#${token}`));
  assert.throws(() => parseRemoteEndpoint(`ws://gate.example/#${token}`), /WSS/);
  assert.throws(() => parseRemoteEndpoint(`wss://gate.example/?x=1#${token}`), /query/);
  assert.throws(() => parseRemoteEndpoint('wss://gate.example/#short'), /32/);
  assert.equal(REMOTE_ENDPOINT_KEY, 'bb_remote_endpoint');
});

test('readRemoteEndpoint validates stored device fields', () => {
  const endpoint = readRemoteEndpoint({ url: 'wss://gate.example/ws', token, deviceId: 'a'.repeat(32), expiresAt: '2030-01-01T00:00:00Z', renewAfter: '2029-01-01T00:00:00Z' });
  assert.equal(endpoint.deviceId, 'a'.repeat(32));
  assert.equal(remoteAuthorizationStatus(endpoint), 'active');
  assert.equal(remoteAuthorizationStatus({ ...endpoint, renewalFailure: 'rejected' }), 'rejected');
  assert.equal(remoteAuthorizationStatus({ ...endpoint, expiresAt: '2000-01-01T00:00:00Z' }, Date.parse('2020-01-01')), 'expired');
  assert.equal(remoteAuthorizationStatus({ ...endpoint, expiresAt: '2000-01-01T00:00:00Z', pendingToken: 'p'.repeat(43) }, Date.parse('2020-01-01')), 'unconfirmed');
  assert.throws(() => readRemoteEndpoint({ url: 'wss://x/', token, deviceId: 'bad' }), /device authorization/);
});

test('remoteSocket adds auth protocol and rejects changed/expired', () => {
  const endpoint = { url: 'wss://gate.example/ws', token };
  const calls = [];
  remoteSocket(endpoint.url, endpoint, (url, protocols) => { calls.push([url, protocols]); return {}; });
  assert.deepEqual(calls[0], [endpoint.url, [REMOTE_AUTH_PROTOCOL_PREFIX + token]]);
  assert.throws(() => remoteSocket('wss://other/', endpoint, () => ({})), /changed/);
  assert.throws(() => remoteSocket(endpoint.url, { ...endpoint, expiresAt: '2000-01-01T00:00:00Z' }, () => ({})), /expired/);
});
