import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStatus, judge } from '../../lib/eval-oracle.mjs';

test('eval 三态：passed / failed / unverified', () => {
  assert.equal(judge({ checks: [{ ok: true }, { ok: true }] }).status, 'passed');
  assert.equal(judge({ checks: [{ ok: true }, { ok: false }] }).status, 'failed');
  assert.equal(judge({ checks: [{ ok: true }], unverified: ['iframe'] }).status, 'unverified');
  assert.equal(judge({ checks: [] }).status, 'unverified');
  assert.throws(() => assertStatus({ status: 'failed' }, 'passed'));
});
