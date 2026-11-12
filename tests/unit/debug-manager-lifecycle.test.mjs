import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugManager } from '../../extension/src/debug/manager.js';

test('releaseTab/releaseSession only stop matching runs', async () => {
  const manager = new DebugManager(
    { get: () => null, list: () => [] },
    undefined,
    undefined,
    undefined,
    { async list() { return []; }, async delete() {}, async remove() {} },
  );
  const calls = [];
  manager.stop = async (id, reason) => { calls.push([id, reason]); };
  manager.runs.set('a', { run: { tab_id: 7, session_id: 's1' } });
  manager.runs.set('b', { run: { tab_id: 8, session_id: 's2' } });
  await manager.releaseTab(7);
  assert.deepEqual(calls, [['a', 'tab_released']]);
  await manager.releaseSession('s2');
  assert.deepEqual(calls.at(-1), ['b', 'session_ended']);
  manager.stop = async () => {};
  await manager.dispose();
});
