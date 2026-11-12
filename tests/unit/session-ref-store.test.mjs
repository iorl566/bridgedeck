import test from 'node:test';
import assert from 'node:assert/strict';
import { RefStore, normaliseRef } from '../../extension/src/session-manager/ref-store.js';

test('RefStore set/resolve and tab filtering', () => {
  const store = new RefStore();
  store.set('@e1', 42, { tabId: 7, frameId: 'f1' });
  assert.equal(store.resolve('e1'), 42);
  assert.equal(store.resolve('@e1', { tabId: 7 }), 42);
  assert.equal(store.resolve('e1', { tabId: 8 }), null);
  assert.equal(store.resolve('missing'), null);
  assert.equal(normaliseRef('@e3'), 'e3');
  assert.equal(normaliseRef('e3'), 'e3');
});

test('RefStore replace keeps DOM refs when stable and invalidates tab', () => {
  const store = new RefStore();
  store.enableStableRefs();
  store.replace([['e1', { backendNodeId: 1, tabId: 7 }], ['e2', { backendNodeId: 2, tabId: 7 }]]);
  const first = store.observationId;
  store.replace([['e3', { backendNodeId: 3, tabId: 7 }]]);
  assert.equal(store.resolve('e1'), 1);
  assert.equal(store.resolve('e3'), 3);
  assert.notEqual(store.observationId, first);
  store.invalidateTab(7);
  assert.equal(store.resolve('e1'), null);
  assert.equal(store.resolve('e3'), null);
  assert.equal(store.documentRevision(7), 1);
});

test('RefStore allocates stable names and rejects unverified visual refs', () => {
  const store = new RefStore();
  const a = store.allocateRef({ backendNodeId: 5, tabId: 1 });
  const b = store.allocateRef({ backendNodeId: 5, tabId: 1 });
  assert.equal(a, b);
  const c = store.allocateRef({ backendNodeId: 6, tabId: 1 });
  assert.notEqual(a, c);
  assert.equal(store.allocateVisualRef(), 'e3');
  store.set('e9', 1, { tabId: 1 });
  assert.throws(() => store.replace([['e10', { kind: 'visual-region', candidate: {} }]]), /visual ref/);
});
