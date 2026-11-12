import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getConnectionEnabled, getControlHintsHidden, getDaemonPort, getLabel, getOrCreateInstanceId,
  setConnectionEnabled, setDaemonPort, setLabel, SHORT_INSTANCE_ID_PATTERN, STORAGE_KEYS,
} from '../../extension/src/lib/instance-id.js';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(key) { return { [key]: values.get(key) }; },
    async set(items) { for (const [key, value] of Object.entries(items)) values.set(key, value); },
  };
}

test('getOrCreateInstanceId generates and persists an 8-hex id', async () => {
  const store = storage();
  const id = await getOrCreateInstanceId(store);
  assert.match(id, SHORT_INSTANCE_ID_PATTERN);
  assert.equal(store.values.get(STORAGE_KEYS.INSTANCE_ID), id);
  assert.equal(await getOrCreateInstanceId(store), id);
});

test('legacy instance id is replaced', async () => {
  const store = storage({ [STORAGE_KEYS.INSTANCE_ID]: 'legacy-uuid' });
  assert.match(await getOrCreateInstanceId(store), SHORT_INSTANCE_ID_PATTERN);
});

test('label and boolean preferences default and roundtrip', async () => {
  const store = storage();
  assert.equal(await getLabel(store), '');
  await setLabel('工作账号', store);
  assert.equal(await getLabel(store), '工作账号');
  assert.equal(await getConnectionEnabled(store), true);
  assert.equal(await getControlHintsHidden(store), false);
  await setConnectionEnabled(false, store);
  assert.equal(await getConnectionEnabled(store), false);
});

test('daemon port normalizes and persists', async () => {
  const store = storage();
  assert.equal(typeof await getDaemonPort(store), 'number');
  await setDaemonPort(53001, store);
  assert.equal(await getDaemonPort(store), 53001);
});
