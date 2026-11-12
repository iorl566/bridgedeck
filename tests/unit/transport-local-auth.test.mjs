import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeBytes, encodeBytes, fields, prove, randomBytes, transcript, uint32, verify,
} from '../../extension/src/transport/local-auth-crypto.js';
import { MAX_AUTH_MESSAGE_BYTES, parseAuthMessage, parseChallenge } from '../../extension/src/transport/local-auth-protocol.js';

test('base64url encode/decode roundtrip and reject malformed', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
  const encoded = encodeBytes(bytes);
  assert.deepEqual([...decodeBytes(encoded, 5)], [...bytes]);
  assert.throws(() => decodeBytes('bad!', 5));
  assert.throws(() => decodeBytes(encoded, 4));
});

test('uint32/fields/transcript are deterministic', () => {
  assert.deepEqual([...uint32(0x01020304)], [1, 2, 3, 4]);
  assert.throws(() => uint32(-1));
  assert.deepEqual([...fields([Uint8Array.from([1]), Uint8Array.from([2, 3])])], [0, 0, 0, 1, 1, 0, 0, 0, 2, 2, 3]);
  const value = {
    daemon_id: randomBytes(16), device_id: randomBytes(16), gen: 7, instance_id: 'i', origin: 'https://x',
    client_nonce: randomBytes(32), server_nonce: randomBytes(32),
  };
  assert.deepEqual([...transcript(value)], [...transcript({ ...value })]);
  assert.equal(transcript(value).length > 64, true);
});

test('prove/verify HMAC per purpose', async () => {
  const key = randomBytes(32);
  const value = new TextEncoder().encode('transcript');
  const proof = await prove(key, 'client', value);
  assert.equal(await verify(key, 'client', value, proof), true);
  assert.equal(await verify(key, 'server', value, proof), false);
  const txn = randomBytes(16);
  const rotate = await prove(key, 'rotate', value, txn);
  assert.equal(await verify(key, 'rotate', value, rotate, txn), true);
  await assert.rejects(() => prove(key, 'client', value, txn), /purpose/);
});

test('parseChallenge validates challenge shapes', () => {
  const daemon = randomBytes(16);
  assert.equal(parseChallenge({ type: 'busy', retry_after_ms: 10 }).retry_after_ms, 10);
  assert.equal(parseChallenge({ type: 'pairing_required', daemon_id: daemon, legacy_accepted: true }).type, 'pairing_required');
  assert.equal(parseChallenge({
    type: 'challenge', daemon_id: daemon, device_id: randomBytes(16), gen: 1,
    server_nonce: randomBytes(32), server_proof: randomBytes(32),
  }).gen, 1);
  assert.throws(() => parseChallenge({ type: 'challenge' }));
});

test('parseAuthMessage validates schema and size', () => {
  const proof = randomBytes(32);
  assert.equal(parseAuthMessage(JSON.stringify({ type: 'local.auth.prove', v: 1, client_proof: proof })).type, 'local.auth.prove');
  assert.equal(parseAuthMessage(JSON.stringify({ type: 'local.auth.ready', v: 1, commit: null, rotation: null })).v, 1);
  assert.throws(() => parseAuthMessage(JSON.stringify({ type: 'local.auth.prove', v: 2, client_proof: proof })));
  assert.throws(() => parseAuthMessage(JSON.stringify({ type: 'local.auth.ready', v: 1, commit: null, rotation: null, extra: 1 })));
  assert.throws(() => parseAuthMessage('x'.repeat(MAX_AUTH_MESSAGE_BYTES + 1)));
});
