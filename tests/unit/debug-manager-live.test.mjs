import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugManager } from '../../extension/src/debug/manager.js';
import { MemoryDebugArchive } from '../../extension/src/debug/archive.js';

function fakeSessions() {
  const context = {
    sessionId: 's1',
    agentWindowId: 10,
    createdAtMs: 1000,
    agentCreatedTabs: new Set([7, 8]),
    borrowedTabs: new Set(),
    observedTabs: new Set(),
  };
  return {
    context,
    sessions: {
      get: (id) => (id === 's1' ? context : null),
      list: () => [context],
    },
  };
}

function harness() {
  const calls = [];
  const cdp = {
    onEvent() { return { dispose() {} }; },
    async ensureNetworkCapture(tabId) { calls.push(['ensure', tabId]); },
    async sendAttached(_target, method, params) { calls.push([method, params]); return {}; },
  };
  const archive = new MemoryDebugArchive([], () => 1000);
  const { sessions } = fakeSessions();
  const manager = new DebugManager(sessions, cdp, undefined, () => 1000, archive);
  manager.newId = () => 'd-test';
  return { manager, archive, calls };
}

const source = { tabId: 7, sessionId: 'root' };

test('DebugManager start/status keeps one capture per session/tab', async () => {
  const { manager, calls } = harness();
  const run = await manager.start('s1', 7, 'token=secret');
  assert.equal(run.id, 'd-test');
  assert.equal(run.state, 'capturing');
  assert.equal(run.name.includes('secret'), false);
  assert.equal((await manager.status('d-test')).tab_id, 7);
  assert.deepEqual(calls[0], ['ensure', 7]);
  const again = await manager.start('s1', 7);
  assert.equal(again.id, 'd-test');
  await assert.rejects(() => manager.start('s1', 8), /another tab/);
});

test('DebugManager refuses to start without a live session', async () => {
  const { manager } = harness();
  await assert.rejects(() => manager.start('missing', 7), /not owned by this task/);
});

test('DebugManager onEvent fills network store', async () => {
  const { manager } = harness();
  await manager.start('s1', 7);
  await manager.onEvent(source, 'Network.requestWillBeSent', {
    requestId: '1', timestamp: 100, type: 'XHR',
    request: { url: 'https://site.test/api', method: 'GET', headers: {} },
  });
  const run = await manager.status('d-test');
  assert.equal(run.requests, 1);
});

test('DebugManager stop persists run and requests', async () => {
  const { manager, archive } = harness();
  await manager.start('s1', 7);
  await manager.onEvent(source, 'Network.requestWillBeSent', {
    requestId: '1', timestamp: 100, type: 'XHR',
    request: { url: 'https://site.test/api', method: 'GET', headers: {} },
  });
  const stopped = await manager.stop('d-test', 'done');
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.stop_reason, 'done');
  const saved = await archive.get('d-test');
  assert.equal(saved.run.state, 'stopped');
  assert.equal(saved.requests.length, 1);
});
