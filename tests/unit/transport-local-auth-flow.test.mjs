import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateLocal, LocalAuthError } from '../../extension/src/transport/local-auth.js';
import { prove, randomBytes, transcript } from '../../extension/src/transport/local-auth-crypto.js';

function fakeSocket(onSend) {
  const listeners = new Map();
  const sent = [];
  return {
    readyState: 1,
    sent,
    onSend,
    addEventListener(type, handler) { const list = listeners.get(type) ?? []; list.push(handler); listeners.set(type, list); },
    removeEventListener(type, handler) { const list = (listeners.get(type) ?? []).filter((item) => item !== handler); listeners.set(type, list); },
    send(text) {
      const message = JSON.parse(text);
      sent.push(message);
      Promise.resolve(this.onSend?.(message)).then((reply) => {
        if (reply !== undefined) this.emit(reply);
      });
    },
    emit(data) { for (const handler of listeners.get('message') ?? []) handler({ data }); },
    close() { for (const handler of listeners.get('close') ?? []) handler({}); },
  };
}

const credential = { daemonId: randomBytes(16), deviceId: randomBytes(16), key: randomBytes(32), gen: 1, role: 'active', endpoint: 'ws://127.0.0.1:1/' };

test('authenticateLocal active credential verifies', async () => {
  let serverProof;
  const socket = fakeSocket(async (message) => {
    if (message.type === 'local.auth.prove') return JSON.stringify({ type: 'local.auth.ready', v: 1, commit: null, rotation: null });
    if (message.method !== 'system.ping') return undefined;
    const auth = message.params.local_auth;
    const challenge = {
      type: 'challenge', daemon_id: credential.daemonId, device_id: credential.deviceId, gen: 1,
      server_nonce: randomBytes(32), server_proof: '',
    };
    const t = transcript({ ...challenge, instance_id: 'i1', origin: 'https://site.test', client_nonce: auth.client_nonce });
    serverProof = await prove(credential.key, 'server', t);
    return JSON.stringify({ id: message.id, result: { local_auth: { ...challenge, server_proof: serverProof } } });
  });
  const status = await authenticateLocal(socket, new AbortController().signal, [credential], 'i1', 'https://site.test');
  assert.deepEqual(status, { state: 'verified', daemonId: credential.daemonId, deviceId: credential.deviceId });
  assert(socket.sent.some((message) => message.type === 'local.auth.prove'));
});

test('authenticateLocal reports pairing_required and busy', async () => {
  const pairing = fakeSocket(async (message) => JSON.stringify({ id: message.id, result: { local_auth: { type: 'pairing_required', daemon_id: credential.daemonId, legacy_accepted: false } } }));
  await assert.rejects(() => authenticateLocal(pairing, new AbortController().signal, [credential], 'i1', 'https://site.test'), (error) => error instanceof LocalAuthError && error.status.state === 'pairing_required');

  const busy = fakeSocket(async (message) => JSON.stringify({ id: message.id, result: { local_auth: { type: 'busy', retry_after_ms: 10 } } }));
  await assert.rejects(() => authenticateLocal(busy, new AbortController().signal, [credential], 'i1', 'https://site.test'), (error) => error.status.state === 'busy');
});

test('authenticateLocal rejects wrong server proof', async () => {
  const socket = fakeSocket(async (message) => JSON.stringify({ id: message.id, result: { local_auth: {
    type: 'challenge', daemon_id: credential.daemonId, device_id: credential.deviceId, gen: 1, server_nonce: randomBytes(32), server_proof: randomBytes(32),
  } } }));
  await assert.rejects(() => authenticateLocal(socket, new AbortController().signal, [credential], 'i1', 'https://site.test'), (error) => error.status.state === 'server_unverified');
});
