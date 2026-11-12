import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLocalCredentials, parseLocalPairing, STAGED_TTL_MS } from '../../extension/src/transport/local-credentials.js';
import { randomBytes } from '../../extension/src/transport/local-auth-crypto.js';

const link = `ws://127.0.0.1:53907/#bb-local.v1.${randomBytes(16)}.${randomBytes(16)}.${randomBytes(32)}`;

test('parseLocalPairing parses loopback link', () => {
  const credential = parseLocalPairing(link, () => 100);
  assert.equal(credential.endpoint, 'ws://127.0.0.1:53907/');
  assert.equal(credential.role, 'staged');
  assert.equal(credential.gen, 0);
  assert.equal(credential.createdAt, 100);
  assert.throws(() => parseLocalPairing('ws://example.test/#bad'), /Invalid local pairing link/);
  assert.throws(() => parseLocalPairing('http://127.0.0.1:1/#bad'), /Invalid local pairing link/);
});

test('MemoryLocalCredentials stages and promotes a candidate', () => {
  const store = new MemoryLocalCredentials({ now: () => 100 });
  const credential = store.stage(parseLocalPairing(link, () => 100));
  assert.equal(store.read().credentials.length, 1);
  const candidate = store.saveCandidate(credential, { txn: randomBytes(16), gen: 1, key: randomBytes(32) });
  assert.equal(candidate.pending.gen, 1);
  const promoted = store.promoteCandidate(candidate, candidate.pending);
  assert.equal(promoted.role, 'active');
  assert.equal(promoted.gen, 1);
  assert.equal(promoted.key, candidate.pending.key);
  assert.equal(store.read().credentials[0].pending, undefined);
});

test('MemoryLocalCredentials expires unused staged and preserves pending', () => {
  const now = 1000 + STAGED_TTL_MS;
  const old = { ...parseLocalPairing(link, () => 100), createdAt: 100 };
  const pending = { ...old, createdAt: 100, pending: { txn: randomBytes(16), gen: 1, key: randomBytes(32) } };
  const store = new MemoryLocalCredentials({ credentials: [old, pending], now: () => now });
  const state = store.read();
  assert.equal(state.credentials.length, 1);
  assert.equal(state.credentials[0].pending.gen, 1);
});

test('MemoryLocalCredentials rejects active duplicate and supports skip', () => {
  const store = new MemoryLocalCredentials({ now: () => 100 });
  const credential = store.stage(parseLocalPairing(link, () => 100));
  const candidate = store.saveCandidate(credential, { txn: randomBytes(16), gen: 1, key: randomBytes(32) });
  store.promoteCandidate(candidate, candidate.pending);
  assert.throws(() => store.stage(parseLocalPairing(link, () => 100)), /already stored/);
  store.setSkip(true);
  assert.equal(store.read().policy.skip, true);
});
