import test from 'node:test';
import assert from 'node:assert/strict';
import { openCredentialDatabase } from '../../extension/src/transport/credential-db.js';

test('credential database rejects without IndexedDB', async () => {
  await assert.rejects(() => openCredentialDatabase(undefined), /unavailable/);
});

test('credential database creates stores on upgrade', async () => {
  const stores = [];
  const names = new Set();
  const db = {
    objectStoreNames: { contains: (name) => names.has(name) },
    createObjectStore(name) { names.add(name); stores.push(name); },
    close() {},
  };
  const factory = {
    open(name, version) {
      const request = { result: db };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  const opened = await openCredentialDatabase(factory);
  assert.equal(opened, db);
  assert.deepEqual(stores, ['connection', 'local', 'migration']);
});
