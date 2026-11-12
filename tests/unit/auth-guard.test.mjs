import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthGuard } from '../../lib/auth-guard.mjs';

test('auth guard blocks after repeated failures and clears on success', () => {
  const guard = createAuthGuard({ maxAttempts: 2, windowMs: 1000, blockMs: 5000 });
  assert.equal(guard.checkHello('1.2.3.4', 10, 1000).ok, true);
  assert.equal(guard.fail('1.2.3.4', 1000), false);
  assert.equal(guard.fail('1.2.3.4', 1100), true);
  assert.equal(guard.isBlocked('1.2.3.4', 1200), true);
  assert.equal(guard.checkHello('1.2.3.4', 10, 1200).code, 'E_RATE_LIMITED');
  assert.equal(guard.isBlocked('1.2.3.4', 7000), false);
  guard.fail('5.6.7.8', 1000);
  guard.success('5.6.7.8');
  assert.equal(guard.isBlocked('5.6.7.8', 1100), false);
});

test('auth guard rejects oversized hello before parsing', () => {
  const guard = createAuthGuard({ maxHelloBytes: 16 });
  assert.equal(guard.checkHello('x', 16).ok, true);
  assert.equal(guard.checkHello('x', 17).code, 'E_TOO_LARGE');
});

test('auth guard snapshots blocked peers', () => {
  const guard = createAuthGuard({ maxAttempts: 1, blockMs: 1000 });
  guard.fail('peer', 100);
  const snap = guard.snapshot(200);
  assert.equal(snap.blocked.length, 1);
  assert.equal(snap.blocked[0].key, 'peer');
});
