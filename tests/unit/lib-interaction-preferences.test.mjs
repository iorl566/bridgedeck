import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_INTERACTION_PREFERENCES, INTERACTION_STORAGE_KEY, InteractionPreferenceStore, interactionPolicy, normalizeInteractionPreferences } from '../../extension/src/lib/interaction-preferences.js';

function harness(initial = {}) {
  const values = new Map(Object.entries(initial));
  const listeners = [];
  const storage = {
    async get(key) { return { [key]: values.get(key) }; },
    async set(items) { for (const [key, value] of Object.entries(items)) values.set(key, value); },
  };
  const onChanged = { addListener: (fn) => listeners.push(fn) };
  const store = new InteractionPreferenceStore({ storage, onChanged });
  return { store, values, listeners };
}

test('normalize and policy defaults', () => {
  assert.deepEqual(normalizeInteractionPreferences(undefined), DEFAULT_INTERACTION_PREFERENCES);
  assert.deepEqual(normalizeInteractionPreferences({ confirmTabBorrow: false }), { confirmTabBorrow: false, requestHelpEnabled: true });
  assert.deepEqual(interactionPolicy({ confirmTabBorrow: false, requestHelpEnabled: true }), { borrow_confirmation: 'never', request_help: 'enabled' });
});

test('ready loads stored preferences and notifies subscribers', async () => {
  const { store } = harness({ [INTERACTION_STORAGE_KEY]: { confirmTabBorrow: false, requestHelpEnabled: false } });
  const seen = [];
  store.subscribe((value) => seen.push(value));
  await store.ready();
  assert.deepEqual(store.get(), { confirmTabBorrow: false, requestHelpEnabled: false });
  assert.equal(seen.length, 1);
});

test('storage change updates only on real change', async () => {
  const { store, listeners } = harness();
  await store.ready();
  const seen = [];
  store.subscribe((value) => seen.push(value));
  listeners[0]({ [INTERACTION_STORAGE_KEY]: { newValue: { confirmTabBorrow: false } } }, 'local');
  listeners[0]({ [INTERACTION_STORAGE_KEY]: { newValue: { confirmTabBorrow: false } } }, 'local');
  assert.equal(seen.length, 1);
});

test('set writes normalized values', async () => {
  const { store, values } = harness();
  await store.set({ confirmTabBorrow: false, requestHelpEnabled: false });
  assert.deepEqual(values.get(INTERACTION_STORAGE_KEY), { confirmTabBorrow: false, requestHelpEnabled: false });
});
