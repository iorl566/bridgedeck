import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLocalPairing } from '../../extension/src/transport/pairing-verifier.js';

const credential = { daemonId: 'd', deviceId: 'v', key: 'k', gen: 0, role: 'staged', endpoint: 'ws://127.0.0.1:1/' };

function socket() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) { const list = listeners.get(type) ?? []; list.push(handler); listeners.set(type, list); },
    removeEventListener(type, handler) { listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== handler)); },
    close() {},
    open() { for (const handler of listeners.get('open') ?? []) handler({}); },
  };
}

test('verifyLocalPairing returns verified status and endpoint', async () => {
  let sock;
  let discarded = 0;
  const result = await verifyLocalPairing('link', 'i', 'https://site.test', () => {
    sock = socket();
    queueMicrotask(() => sock.open());
    return sock;
  }, {
    parseLocalPairing: () => ({ ...credential }),
    stageCredential: async (value) => value,
    discardStaged: async () => { discarded += 1; },
    readLocalState: async () => ({ credentials: [] }),
    authenticateLocal: async () => ({ state: 'verified', daemonId: 'd', deviceId: 'v' }),
  });
  assert.deepEqual(result, { state: 'verified', daemonId: 'd', deviceId: 'v', endpoint: credential.endpoint });
  assert.equal(discarded, 0);
});

test('verifyLocalPairing retries once on advanced credential', async () => {
  let calls = 0;
  const result = await verifyLocalPairing('link', 'i', 'o', () => {
    const sock = socket();
    queueMicrotask(() => sock.open());
    return sock;
  }, {
    parseLocalPairing: () => ({ ...credential }),
    stageCredential: async (value) => value,
    discardStaged: async () => {},
    readLocalState: async () => ({ credentials: [{ ...credential, gen: 1 }] }),
    authenticateLocal: async () => { calls += 1; if (calls === 1) throw new Error('retry'); return { state: 'verified', daemonId: 'd', deviceId: 'v' }; },
  });
  assert.equal(calls, 2);
  assert.equal(result.state, 'verified');
});

test('verifyLocalPairing discards staged on failure', async () => {
  let discarded = 0;
  await assert.rejects(() => verifyLocalPairing('link', 'i', 'o', () => {
    const sock = socket();
    queueMicrotask(() => sock.open());
    return sock;
  }, {
    parseLocalPairing: () => ({ ...credential }),
    stageCredential: async (value) => value,
    discardStaged: async () => { discarded += 1; },
    readLocalState: async () => ({ credentials: [] }),
    authenticateLocal: async () => { throw new Error('bad'); },
  }), /bad/);
  assert.equal(discarded, 1);
});
