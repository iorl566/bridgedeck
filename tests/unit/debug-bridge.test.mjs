import test from 'node:test';
import assert from 'node:assert/strict';
import { attachDebugBridge, DEBUG_MESSAGE, isDebugPage } from '../../extension/src/debug/bridge.js';

function harness({ debugResult = { ok: 1 }, rpcError = false } = {}) {
  let listener;
  const runtime = { id: 'ext', getURL: (path) => `chrome-extension://ext/${path}`, onMessage: { addListener: (fn) => { listener = fn; } } };
  const calls = [];
  const debug = {
    async tasks() { return [{ id: 't1' }]; },
    history() { return { runs: [] }; },
    async deleteHistory(id) { calls.push(['delete', id]); },
    readHistory(params) { calls.push(['readHistory', params]); return { runs: [] }; },
  };
  const deps = {
    runtime,
    validateDebugParams: (params) => (params?.action === 'start' ? null : 'bad params'),
    handleDebug: async (sessions, params) => { calls.push(['handle', params.action]); return rpcError ? { code: 'bad', message: 'rpc failed' } : debugResult; },
    isRpcError: (value) => Boolean(value && value.code),
  };
  attachDebugBridge({}, debug, deps);
  return {
    runtime,
    calls,
    send: (message, sender = { id: 'ext', url: runtime.getURL('debug.html') }) => new Promise((resolve) => { listener(message, sender, resolve); }),
  };
}

test('isDebugPage only allows extension popup/debug pages', () => {
  const runtime = { id: 'ext', getURL: (path) => `chrome-extension://ext/${path}` };
  assert.equal(isDebugPage({ id: 'ext', url: runtime.getURL('debug.html') }, runtime), true);
  assert.equal(isDebugPage({ id: 'ext', url: 'https://evil' }, runtime), false);
});

test('tasks/history and forbidden sender', async () => {
  const h = harness();
  assert.deepEqual(await h.send({ kind: DEBUG_MESSAGE, action: 'tasks' }), { ok: true, data: { tasks: [{ id: 't1' }] } });
  assert.deepEqual(await h.send({ kind: DEBUG_MESSAGE, action: 'history' }), { ok: true, data: { runs: [] } });
  assert.deepEqual(await h.send({ kind: DEBUG_MESSAGE, action: 'tasks' }, { id: 'ext', url: 'https://evil' }), { ok: false, error: 'forbidden' });
});

test('delete validates run id', async () => {
  const h = harness();
  assert.deepEqual(await h.send({ kind: DEBUG_MESSAGE, action: 'delete', run_id: 'bad' }), { ok: false, error: 'invalid recording ID' });
  assert.deepEqual(await h.send({ kind: DEBUG_MESSAGE, action: 'delete', run_id: 'd12' }), { ok: true, data: {} });
  assert.deepEqual(h.calls[0], ['delete', 'd12']);
});

test('debug action validates params and maps rpc errors', async () => {
  const h = harness({ rpcError: true });
  assert.deepEqual(await h.send({ kind: DEBUG_MESSAGE, action: 'debug', params: { action: 'stop' } }), { ok: false, error: 'rpc failed' });
  assert.deepEqual(await h.send({ kind: DEBUG_MESSAGE, action: 'record', params: { action: 'start' } }), { ok: true, data: { runs: [] } });
  assert.deepEqual(await h.send({ kind: DEBUG_MESSAGE, action: 'record', params: { action: 'nope' } }), { ok: false, error: 'bad params' });
});
