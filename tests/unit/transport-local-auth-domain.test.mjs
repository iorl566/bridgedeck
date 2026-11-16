import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateLocal } from '../../extension/src/transport/local-auth.js';
import { AUTH_DOMAIN, prove, randomBytes, transcript, verify } from '../../extension/src/transport/local-auth-crypto.js';

function fakeSocket(onSend) {
  const listeners = new Map();
  return {
    readyState: 1,
    addEventListener(type, handler) { const list = listeners.get(type) ?? []; list.push(handler); listeners.set(type, list); },
    removeEventListener(type, handler) { const list = (listeners.get(type) ?? []).filter((item) => item !== handler); listeners.set(type, list); },
    send(text) {
      const message = JSON.parse(text);
      Promise.resolve(onSend(message)).then((reply) => {
        if (reply !== undefined) for (const handler of listeners.get('message') ?? []) handler({ data: reply });
      });
    },
  };
}

const base = () => ({ daemonId: randomBytes(16), deviceId: randomBytes(16), key: randomBytes(32), gen: 1, role: 'active', authDomain: 'bridgedeck' });

test('协议域参与 transcript：换域名会得到不同摘要', () => {
  const value = { daemon_id: randomBytes(16), device_id: randomBytes(16), gen: 1, instance_id: 'i1', origin: 'https://site.test', client_nonce: randomBytes(32), server_nonce: randomBytes(32) };
  const current = transcript(value, AUTH_DOMAIN);
  const other = transcript(value, 'other-domain');
  const fallback = transcript(value);
  assert.notDeepEqual(Array.from(current), Array.from(other));
  assert.deepEqual(Array.from(fallback), Array.from(current), '默认域必须与当前协议域一致');
});

test('authenticateLocal 在当前协议域下完成校验', async () => {
  const credential = base();
  let challengeValue = null;
  const socket = fakeSocket(async (message) => {
    if (message.type === 'local.auth.prove') {
      const ok = await verify(credential.key, 'client', transcript(challengeValue, AUTH_DOMAIN), message.client_proof);
      return JSON.stringify(ok ? { type: 'local.auth.ready', v: 1, commit: null, rotation: null } : { type: 'local.auth.rejected', v: 1, reason: 'proof_mismatch' });
    }
    if (message.method !== 'system.ping') return undefined;
    const auth = message.params.local_auth;
    challengeValue = {
      daemon_id: credential.daemonId,
      device_id: credential.deviceId,
      gen: 1,
      instance_id: 'i1',
      origin: 'https://site.test',
      client_nonce: auth.client_nonce,
      server_nonce: randomBytes(32),
    };
    const serverProof = await prove(credential.key, 'server', transcript(challengeValue, AUTH_DOMAIN));
    return JSON.stringify({
      id: message.id,
      result: { local_auth: { type: 'challenge', daemon_id: credential.daemonId, device_id: credential.deviceId, gen: 1, server_nonce: challengeValue.server_nonce, server_proof: serverProof } },
    });
  });
  const status = await authenticateLocal(socket, new AbortController().signal, [credential], 'i1', 'https://site.test');
  assert.equal(status.state, 'verified');
});

test('服务端用别的域名签证明：拒绝', async () => {
  const credential = base();
  let challengeValue = null;
  const socket = fakeSocket(async (message) => {
    if (message.method !== 'system.ping') return undefined;
    const auth = message.params.local_auth;
    challengeValue = {
      daemon_id: credential.daemonId,
      device_id: credential.deviceId,
      gen: 1,
      instance_id: 'i1',
      origin: 'https://site.test',
      client_nonce: auth.client_nonce,
      server_nonce: randomBytes(32),
    };
    const serverProof = await prove(credential.key, 'server', transcript(challengeValue, 'other-domain'));
    return JSON.stringify({
      id: message.id,
      result: { local_auth: { type: 'challenge', daemon_id: credential.daemonId, device_id: credential.deviceId, gen: 1, server_nonce: challengeValue.server_nonce, server_proof: serverProof } },
    });
  });
  await assert.rejects(
    () => authenticateLocal(socket, new AbortController().signal, [credential], 'i1', 'https://site.test'),
    (error) => error && error.status && error.status.state === 'server_unverified',
  );
});
