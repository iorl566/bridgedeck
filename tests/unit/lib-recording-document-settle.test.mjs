import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForDocumentSettled } from '../../extension/src/lib/recording/document-settle.js';

function harness({ idleMs = 300, readyState = 'complete', frameContext } = {}) {
  let now = 0;
  const calls = [];
  const send = async (target, method, params) => {
    calls.push([method, params]);
    if (method === 'Page.createIsolatedWorld') return { executionContextId: frameContext };
    return { result: { value: { idleMs, readyState } } };
  };
  return {
    calls,
    deps: { send, now: () => now, sleep: async (ms) => { now += ms; } },
  };
}

test('settles once quiet after the minimum window', async () => {
  const h = harness();
  assert.equal(await waitForDocumentSettled({ tabId: 1 }, { target: { tabId: 1 } }, {}, h.deps), 'quiet');
  assert(h.calls.some(([method]) => method === 'Runtime.evaluate'));
});

test('times out if never quiet', async () => {
  const h = harness({ idleMs: 0 });
  assert.equal(await waitForDocumentSettled({ tabId: 1 }, { target: { tabId: 1 } }, {}, h.deps), 'timeout');
});

test('cancelled signal wins', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await waitForDocumentSettled({ tabId: 1 }, { target: { tabId: 1 } }, { signal: controller.signal }, h.deps), 'cancelled');
});

test('frame scope creates an isolated world', async () => {
  const h = harness({ frameContext: 7 });
  assert.equal(await waitForDocumentSettled({ tabId: 1 }, { target: { tabId: 1 }, frameId: 'f1' }, {}, h.deps), 'quiet');
  assert.deepEqual(h.calls[0][1].worldName, '__bb_record_settle__');
  assert.equal(h.calls[1][1].contextId, 7);
});
