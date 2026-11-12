import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthSession } from '../../lib/auth-session.mjs';
import { authProof } from '../../lib/auth-challenge.mjs';

test('auth session verifies a valid proof once', () => {
  const session = createAuthSession({ now: () => 1000 });
  assert.equal(session.begin({ type: 'hello' }, 'secret', 'nonce'), true);
  assert.equal(session.state, 'challenging');
  const result = session.verify('nonce', authProof('secret', 'nonce'));
  assert.equal(result.ok, true);
  assert.equal(result.hello.type, 'hello');
  assert.equal(session.state, 'authenticated');
  assert.equal(session.verify('nonce', authProof('secret', 'nonce')).ok, false);
});

test('auth session rejects wrong challenge/proof and expires', () => {
  const session = createAuthSession({ ttlMs: 100, now: () => 1000 });
  session.begin({}, 'secret', 'nonce');
  assert.equal(session.verify('other', 'x').code, 'E_AUTH_CHALLENGE');
  session.reset();
  session.begin({}, 'secret', 'nonce');
  assert.equal(session.verify('nonce', 'bad').code, 'E_AUTH_PROOF');
  let now = 1000;
  const expiring = createAuthSession({ ttlMs: 100, now: () => now });
  expiring.begin({}, 'secret', 'nonce');
  now = 1200;
  assert.equal(expiring.verify('nonce', authProof('secret', 'nonce')).code, 'E_AUTH_EXPIRED');
  assert.equal(expiring.state, 'failed');
});

test('auth session refuses double begin', () => {
  const session = createAuthSession();
  assert.equal(session.begin({}, 's', 'n'), true);
  assert.equal(session.begin({}, 's', 'n'), false);
  assert.equal(session.state, 'challenging');
});
