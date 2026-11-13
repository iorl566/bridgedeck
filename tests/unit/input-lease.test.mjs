import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputLeaseRegistry } from '../../extension/src/input-lease.js';

function clock(start = 1000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test('acquire returns an owned lease', () => {
  const registry = createInputLeaseRegistry({ now: () => 1000, defaultTtlMs: 5000 });
  const lease = registry.acquire(7, 'trusted:click');
  assert.equal(lease.tabId, 7);
  assert.equal(lease.owner, 'trusted:click');
  assert.ok(lease.token);
  assert.equal(registry.snapshot()[0].expiresInMs, 5000);
});

test('a second input on the same tab is rejected with E_INPUT_BUSY', () => {
  const registry = createInputLeaseRegistry({ now: () => 1000 });
  registry.acquire(7, 'trusted:click');
  assert.throws(() => registry.acquire(7, 'trusted:fill'), (error) => {
    assert.equal(error.code, 'E_INPUT_BUSY');
    assert.equal(error.data.owner, 'trusted:click');
    assert.ok(error.data.expiresInMs > 0);
    return true;
  });
});

test('release requires the matching token and frees the tab', () => {
  const registry = createInputLeaseRegistry({ now: () => 1000 });
  const lease = registry.acquire(7, 'trusted:click');
  assert.equal(registry.release(7, 'wrong'), false);
  assert.equal(registry.release(7, lease.token), true);
  assert.equal(registry.release(7, lease.token), false);
  assert.ok(registry.acquire(7, 'trusted:fill'));
});

test('expired leases are swept and do not block new input', () => {
  const tick = clock();
  const registry = createInputLeaseRegistry({ now: tick.now, defaultTtlMs: 1000 });
  registry.acquire(7, 'trusted:click');
  tick.advance(1001);
  assert.equal(registry.snapshot()[0].active, false);
  assert.ok(registry.acquire(7, 'trusted:fill'));
  tick.advance(1001);
  assert.equal(registry.sweep(), 1);
  assert.equal(registry.snapshot().length, 0);
});

test('renew extends the lease until the new expiry', () => {
  const tick = clock();
  const registry = createInputLeaseRegistry({ now: tick.now, defaultTtlMs: 1000 });
  const lease = registry.acquire(7, 'trusted:click');
  tick.advance(900);
  assert.ok(registry.renew(7, lease.token, 2000));
  tick.advance(1200);
  assert.equal(registry.snapshot()[0].active, true);
  tick.advance(900);
  assert.equal(registry.snapshot()[0].active, false);
});

test('clearTab and releaseOwner remove orphan leases', () => {
  const registry = createInputLeaseRegistry({ now: () => 1000 });
  registry.acquire(7, 'trusted:click');
  registry.acquire(8, 'download');
  assert.equal(registry.releaseOwner('trusted:click'), 1);
  assert.equal(registry.snapshot().length, 1);
  assert.equal(registry.clearTab(8), true);
  assert.equal(registry.snapshot().length, 0);
});

test('invalid tabId and missing token are rejected', () => {
  const registry = createInputLeaseRegistry({ now: () => 1000 });
  assert.throws(() => registry.acquire('7', 'x'), (error) => error.code === 'E_BAD_ARG');
  assert.equal(registry.renew(7, 'missing'), null);
  assert.equal(registry.release(7), false);
});
