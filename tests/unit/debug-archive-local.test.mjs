import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalDebugArchive } from '../../extension/src/debug/archive.js';

const recording = {
  saved_at: 500,
  run: { id: 'd1', session_id: 's1', state: 'stopped', started_at: 100, stopped_at: 400, requests: 0, coverage: [], dropped_requests: 0, dropped_operations: 0, next_since: 0 },
  operations: [], requests: [], console: [], pages: [], performance: [], rules: [], replays: [],
};

test('LocalDebugArchive falls back to memory without IndexedDB', async () => {
  const archive = new LocalDebugArchive(undefined, () => 500);
  await archive.put(recording);
  assert.deepEqual((await archive.list()).map((run) => run.id), ['d1']);
  assert.equal((await archive.get('d1')).run.id, 'd1');
  assert.deepEqual((await archive.query('d1', { action: 'pages' })).pages, []);
});

test('LocalDebugArchive retains evidence before the first checkpoint', async () => {
  const archive = new LocalDebugArchive(undefined, () => 500);
  await archive.retain(recording.run, [{ id: 'early', started_at: 1, sequence: 1, request_body: { state: 'empty' }, response_body: { state: 'empty' } }]);
  const got = await archive.get('d1');
  assert.equal(got.run.id, 'd1');
  assert.equal(got.requests[0].id, 'early');
});

test('LocalDebugArchive fallback supports retain/pin/delete', async () => {
  const archive = new LocalDebugArchive(undefined, () => 500);
  await archive.put(recording);
  await archive.retain(recording.run, [{ id: 'n1', started_at: 1, sequence: 1, request_body: { state: 'empty' }, response_body: { state: 'empty' } }]);
  await archive.pin('d1', 'n1', true, 2);
  const got = await archive.get('d1');
  assert.equal(got.requests[0].pinned, true);
  await archive.delete('d1');
  assert.equal(await archive.get('d1'), undefined);
});
