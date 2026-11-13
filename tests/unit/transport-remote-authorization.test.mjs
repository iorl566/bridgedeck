import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteAuthorization, activateRemoteEndpoint, watchRemoteAuthorization } from '../../extension/src/transport/remote-authorization.js';
import { createRemoteStorage } from '../../extension/src/transport/remote-storage.js';

const token = 't'.repeat(32);
function harness() {
  const values = new Map();
  const endpoints = new Map();
  const local = {
    async get(keys) { const out = {}; for (const key of keys) if (values.has(key)) out[key] = values.get(key); return out; },
    async set(items) { for (const [key, value] of Object.entries(items)) values.set(key, value); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
    async setAccessLevel() {},
  };
  const endpointStore = { async get() { return endpoints.get('endpoint'); }, async put(value) { endpoints.set('endpoint', value); } };
  const storage = createRemoteStorage({ local, endpointStore });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return { status: 200, ok: true, async json() { return { device_id: 'a'.repeat(32), expires_at: '2030-01-01T00:00:00Z', renew_after: '2029-01-01T00:00:00Z' }; } };
  };
  const auth = createRemoteAuthorization({ storage, fetchImpl, now: () => Date.parse('2028-01-01T00:00:00Z') });
  return { auth, storage, endpoints, calls };
}

test('updateRemoteConnection pairs via authorize endpoint', async () => {
  const { auth, storage, calls } = harness();
  const url = await auth.updateRemoteConnection(`wss://gate.example/ws#${token}`);
  assert.equal(url, 'wss://gate.example/ws');
  assert(calls[0][0].toString().endsWith('/authorize'));
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${token}`);
  assert.equal((await storage.readRemoteConnection()).deviceId, 'a'.repeat(32));
});

test('updateRemoteConnection(null) switches local', async () => {
  const { auth, storage } = harness();
  await auth.updateRemoteConnection(`wss://gate.example/ws#${token}`);
  assert.equal(await auth.updateRemoteConnection(null), null);
  assert.equal(await storage.readRemoteConnection(), null);
});

test('renewRemoteAuthorization rotates expiring credential', async () => {
  const { auth, storage, endpoints } = harness();
  await storage.writeRemoteConnection({
    url: 'wss://gate.example/ws', token, deviceId: 'a'.repeat(32),
    expiresAt: '2029-01-01T00:00:00Z', renewAfter: '2027-01-01T00:00:00Z',
  });
  await auth.renewRemoteAuthorization();
  const updated = endpoints.get('endpoint');
  assert.equal(updated.deviceId, 'a'.repeat(32));
  assert.notEqual(updated.token, token);
});

test('module-level activateRemoteEndpoint rotates the pairing credential', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    async json() {
      return { device_id: 'a'.repeat(32), expires_at: '2030-01-01T00:00:00Z', renew_after: '2029-01-01T00:00:00Z' };
    },
  });
  try {
    const updated = await activateRemoteEndpoint({ url: 'wss://gate.example/ws', token });
    assert.equal(updated.deviceId, 'a'.repeat(32));
    assert.notEqual(updated.token, token);
    assert.equal(updated.expiresAt, '2030-01-01T00:00:00Z');
  } finally {
    globalThis.fetch = previous;
  }
});

test('watchRemoteAuthorization rejects untrusted senders and disposes', async () => {
  const listeners = [];
  const runtime = {
    id: 'ext',
    getURL: (path) => `chrome-extension://ext/${path}`,
    onMessage: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
    },
  };
  const alarms = {
    onAlarm: { addListener() {}, removeListener() {} },
    async clear() {},
    async get() { return null; },
    async create() {},
  };
  const dispose = watchRemoteAuthorization(runtime, alarms, {});
  const reply = await new Promise((resolve) => {
    listeners[0]({ kind: 'bb-remote-authorization', pairing: 'wss://evil/ws#x' }, { url: 'chrome-extension://evil/options.html', id: 'evil' }, resolve);
  });
  assert.deepEqual(reply, { error: 'Invalid authorization request' });
  dispose();
  assert.equal(listeners.length, 0);
});
