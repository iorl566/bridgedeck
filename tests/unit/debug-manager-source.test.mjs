import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugManager } from '../../extension/src/debug/manager.js';
import { MemoryDebugArchive } from '../../extension/src/debug/archive.js';

const recording = {
  saved_at: 500,
  run: { id: 'd1', session_id: 's1', tab_id: 7, name: 'n', state: 'stopped', started_at: 100, stopped_at: 400, requests: 1, operations: 0, errors: 0, next_since: 0, coverage: [], dropped_requests: 0, dropped_operations: 0 },
  requests: [], operations: [], console: [], pages: [], performance: [], rules: [], replays: [],
};

function fakeContext(overrides = {}) {
  return {
    sessionId: 's1',
    agentWindowId: 10,
    createdAtMs: 100,
    agentCreatedTabs: new Set([7]),
    borrowedTabs: new Set(),
    observedTabs: new Set(),
    ...overrides,
  };
}

function fakeSessions(contexts = []) {
  return {
    get: (id) => contexts.find((context) => context.sessionId === id) ?? null,
    list: () => contexts,
  };
}

test('DebugManager history/readHistory/deleteHistory', async () => {
  const manager = new DebugManager(fakeSessions([]), undefined, undefined, undefined, new MemoryDebugArchive([recording], () => 500));
  const history = await manager.history();
  assert.deepEqual(history.runs.map((run) => run.id), ['d1']);
  const read = await manager.readHistory({ run_id: 'd1', action: 'pages' });
  assert.deepEqual(read.pages, []);
  await manager.deleteHistory('d1');
  assert.equal((await manager.history()).runs.length, 0);
});

test('DebugManager readHistory validates run id', async () => {
  const manager = new DebugManager(fakeSessions([]), undefined, undefined, undefined, new MemoryDebugArchive());
  await assert.rejects(() => manager.readHistory({ action: 'pages' }), /run_id/);
  await assert.rejects(() => manager.readHistory({ run_id: 'missing', action: 'pages' }), /not found/);
});

test('DebugManager tasks reports one slot per live session', async () => {
  const manager = new DebugManager(fakeSessions([fakeContext()]), undefined, undefined, undefined, new MemoryDebugArchive([recording], () => 500));
  const tasks = await manager.tasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].session_id, 's1');
  assert.equal(tasks[0].created_at, 100);
  assert.equal(tasks[0].run, undefined);
  assert.equal(manager.capabilitiesFor(true).schema_version, 1);
});

test('DebugManager tasks does not report archived runs without live sessions', async () => {
  const manager = new DebugManager(fakeSessions([]), undefined, undefined, undefined, new MemoryDebugArchive([recording], () => 500));
  assert.deepEqual(await manager.tasks(), []);
});
