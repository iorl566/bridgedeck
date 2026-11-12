import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugManager } from '../../extension/src/debug/manager.js';
import { MemoryDebugArchive } from '../../extension/src/debug/archive.js';

function fakeSessions() {
  const context = {
    sessionId: 's1',
    agentWindowId: 10,
    createdAtMs: 1000,
    agentCreatedTabs: new Set([7]),
    borrowedTabs: new Set(),
    observedTabs: new Set(),
  };
  return {
    get: (id) => (id === 's1' ? context : null),
    list: () => [context],
  };
}

function harness() {
  const calls = [];
  const cdp = {
    onEvent() {},
    async ensureNetworkCapture() {},
    async sendAttached() { return {}; },
  };
  const observer = { async call(kind, value) { calls.push([kind, value]); } };
  const manager = new DebugManager(
    fakeSessions(),
    cdp,
    undefined,
    () => 1000,
    new MemoryDebugArchive([], () => 1000),
  );
  manager.newId = () => 'd-test';
  manager.observerFor = () => observer;
  manager.pageFor = async () => ({ state: 'available', fields: [], text: 'page' });
  return { manager, calls, observer };
}

test('before/after records an operation and page snapshot', async () => {
  const { manager, calls, observer } = harness();
  await manager.start('s1', 7);
  manager.runs.get('d-test').observer = observer;
  const ticket = await manager.before({ method: 'tool.click', params: { session_id: 's1', tab_id: 7, selector: '#go' } });
  assert.equal(ticket.operation.method, 'tool.click');
  assert.equal(ticket.operation.target, '#go');
  assert.equal(calls[0][0], 'agent');
  manager.after(ticket);
  assert.equal(ticket.operation.state, 'completed');
  assert.equal(ticket.operation.finished_at, 1000);
  assert.equal(ticket.operation.window_end, 2500);
  assert.equal(calls.at(-1)[1], false);
});

test('before ignores non-actions and missing session', async () => {
  const { manager } = harness();
  await manager.start('s1', 7);
  assert.equal(await manager.before({ method: 'tool.unknown', params: { session_id: 's1' } }), undefined);
  assert.equal(await manager.before({ method: 'tool.click', params: { session_id: 'missing' } }), undefined);
});

test('after records error text', async () => {
  const { manager } = harness();
  await manager.start('s1', 7);
  const ticket = await manager.before({ method: 'tool.fill', params: { session_id: 's1', ref: 'e1' } });
  manager.after(ticket, 'token=secret');
  assert.equal(ticket.operation.state, 'error');
  assert.equal(ticket.operation.error.includes('secret'), false);
});
