import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthResolve } from '../../daemon/auth-resolve.js';

function make(trust = { token: 'local-token' }) {
  const pairing = {
    scopeForToken: (token) => (token === 'pair-read' ? 'read' : null),
    validToken: (token) => token === 'pair-ok',
    findByKeyId: (keyId) => (keyId === 'k:pair' ? { token: 'pair-ok', scope: 'read' } : null),
  };
  const deviceStore = {
    recordForToken: (token) => (token === 'dev' ? { scope: 'control', browserId: 'b1' } : null),
    verify: (token) => token === 'dev',
    secretForKeyId: (keyId) => (keyId === 'k:dev' ? 'dev' : null),
    scopeForToken: () => 'control',
    rotationForKeyId: () => null,
  };
  const resolve = createAuthResolve({
    pairing,
    deviceStore,
    getLocalTrust: () => trust,
    authKeyId: (token) => 'k:' + token,
  });
  return { resolve, trust };
}

test('auth-resolve 解析本机 token 与 rotation', () => {
  const { resolve, trust } = make();
  assert.equal(resolve.findAuthSecret('k:local-token').local, true);
  trust.rotationToken = 'rot';
  trust.rotationUntil = Date.now() + 10000;
  const rotation = resolve.findAuthSecret('k:rot');
  assert.equal(rotation.local, true);
  assert.equal(rotation.rotation, true);
});

test('auth-resolve 解析 pairing/device scope', () => {
  const { resolve } = make();
  assert.equal(resolve.scopeForRemoteToken('pair-read'), 'read');
  assert.equal(resolve.scopeForRemoteToken('unknown'), 'control');
  assert.equal(resolve.isPairTokenValid('pair-ok'), true);
  assert.equal(resolve.isPairTokenValid('nope'), false);
  const paired = resolve.findAuthSecret('k:pair');
  assert.equal(paired.remote, true);
  assert.equal(paired.scope, 'read');
  const device = resolve.findAuthSecret('k:dev');
  assert.equal(device.remote, true);
  assert.equal(device.browserId, 'b1');
});
