import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteStorage, REMOTE_CONNECTION_MODE } from '../../extension/src/transport/remote-storage.js';
import { REMOTE_ENDPOINT_KEY } from '../../extension/src/transport/remote-endpoint.js';

const token = 't'.repeat(32);
function harness(initial = {}) {
  const values = new Map(Object.entries(initial));
  const endpoints = new Map();
  const local = {
    async get(keys) { const out = {}; for (const key of keys) if (values.has(key)) out[key] = values.get(key); return out; },
    async set(valuesToSet) { for (const [key, value] of Object.entries(valuesToSet)) values.set(key, value); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
    async setAccessLevel() {},
  };
  const endpointStore = {
    async get() { return endpoints.get('endpoint'); },
    async put(value) { endpoints.set('endpoint', value); },
  };
  return { storage: createRemoteStorage({ local, endpointStore }), values, endpoints };
}

test('fresh local profile returns null', async () => {
  const { storage } = harness();
  assert.equal(await storage.readRemoteConnection(), null);
});

test('writeRemoteConnection stores endpoint then selects remote', async () => {
  const { storage, values, endpoints } = harness();
  await storage.writeRemoteConnection({ url: 'wss://gate.example/ws', token });
  assert.equal(values.get(REMOTE_CONNECTION_MODE), 'remote');
  assert.equal(endpoints.get('endpoint').token, token);
  assert.equal((await storage.readRemoteConnection()).url, 'wss://gate.example/ws');
  await storage.writeRemoteConnection(null);
  assert.equal(values.get(REMOTE_CONNECTION_MODE), 'local');
  assert.equal(await storage.readRemoteConnection(), null);
});

test('initialize migrates legacy endpoint key', async () => {
  const { storage, values, endpoints } = harness({ [REMOTE_ENDPOINT_KEY]: { url: 'wss://gate.example/ws', token } });
  await storage.initializeRemoteStorage();
  assert.equal(endpoints.get('endpoint').token, token);
  assert.equal(values.has(REMOTE_ENDPOINT_KEY), false);
  assert.equal((await storage.readSavedRemoteConnection()).token, token);
});
