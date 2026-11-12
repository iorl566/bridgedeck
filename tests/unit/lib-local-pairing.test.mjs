import test from 'node:test';
import assert from 'node:assert/strict';
import { attachLocalPairing, LOCAL_PAIRING_MESSAGE, trustedPopup } from '../../extension/src/lib/local-pairing-bridge.js';

function harness() {
  let listener;
  const runtime = { id: 'ext', getURL: (path) => `chrome-extension://ext/${path}`, onMessage: { addListener: (fn) => { listener = fn; } } };
  const calls = [];
  const deps = {
    runtime,
    async readLocalState() { return { policy: 'required', credentials: [{ role: 'active', daemonId: 'd', deviceId: 'dev', endpoint: 'ws://x' }, { role: 'pending', daemonId: 'p' }] }; },
    async verifyLocalPairing(link, id, origin) { calls.push(['verify', link, id, origin]); return { endpoint: 'ws://127.0.0.1:53001/ws' }; },
    async setDaemonPort(port) { calls.push(['port', port]); },
    async writeRemoteConnection(value) { calls.push(['remote', value]); },
    async setSkipLocalVerification(value) { calls.push(['skip', value]); },
    async getOrCreateInstanceId() { return '12345678'; },
    getURL: () => 'chrome-extension://ext/',
  };
  const transport = { resetAuthenticationBackoff() { calls.push(['reset']); } };
  const controller = { async retryConnection() { calls.push(['retry']); } };
  attachLocalPairing(controller, transport, deps);
  return { runtime, calls, send: (message, sender = { id: 'ext', url: runtime.getURL('popup.html') }) => new Promise((resolve) => { listener(message, sender, resolve); }) };
}

test('trustedPopup requires popup URL and no tab', () => {
  const runtime = { id: 'ext', getURL: (p) => `chrome-extension://ext/${p}` };
  assert.equal(trustedPopup({ id: 'ext', url: runtime.getURL('popup.html') }, runtime), true);
  assert.equal(trustedPopup({ id: 'ext', url: runtime.getURL('popup.html'), tab: {} }, runtime), false);
});

test('info returns active devices only', async () => {
  const h = harness();
  const result = await h.send({ kind: LOCAL_PAIRING_MESSAGE, action: 'info' });
  assert.equal(result.policy, 'required');
  assert.equal(result.devices.length, 1);
});

test('pair verifies, sets port, clears remote and retries', async () => {
  const h = harness();
  const result = await h.send({ kind: LOCAL_PAIRING_MESSAGE, action: 'pair', link: 'bb-local://pair#t' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(h.calls, [['verify', 'bb-local://pair#t', '12345678', 'chrome-extension://ext'], ['port', 53001], ['remote', null], ['reset'], ['retry']]);
});

test('forbidden sender and invalid skip are rejected', async () => {
  const h = harness();
  assert.deepEqual(await h.send({ kind: LOCAL_PAIRING_MESSAGE, action: 'info' }, { id: 'ext', url: 'https://x' }), { error: 'Invalid pairing request' });
  assert.deepEqual(await h.send({ kind: LOCAL_PAIRING_MESSAGE, action: 'skip', value: 'yes' }), { error: 'pairing_failed' });
});
