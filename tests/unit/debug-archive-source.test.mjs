import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_AGE_MS, HISTORY_LIMIT, expiredHistory, interrupted } from '../../extension/src/debug/archive.js';

const now = Date.now();
const run = (id, startedAt, stoppedAt = startedAt + 1, state = 'stopped', bytes = 1) => ({
  bytes, run: { id, started_at: startedAt, stopped_at: stoppedAt, state },
});

test('expiredHistory keeps active and newest runs', () => {
  const values = [
    run('old', now - HISTORY_AGE_MS - 1000),
    run('a', now - 3000, now - 2000),
    run('b', now - 1000, now - 500),
    run('active', now - 5000, null, 'capturing'),
  ];
  const expired = expiredHistory(values, now);
  assert.deepEqual(expired, ['old']);
});

test('expiredHistory enforces count limit', () => {
  const values = Array.from({ length: HISTORY_LIMIT + 2 }, (_, index) => run(String(index), now - index * 1000, now - index * 1000 + 1));
  const expired = expiredHistory(values, now);
  assert.equal(expired.length, 2);
  assert.deepEqual(expired, ['50', '51']);
});

test('interrupted recovers pending capture state', () => {
  const recording = {
    saved_at: now,
    run: { state: 'capturing', active_rules: 2, coverage: [], started_at: 1 },
    rules: [{ state: 'enabled' }],
    replays: [{ state: 'running' }],
    requests: [{ state: 'pending', request_body: { state: 'pending' }, response_body: { state: 'pending' } }],
    performance: [{ state: 'capturing', coverage: [], metrics: { lcp: { state: 'provisional', reasons: [] } } }],
    operations: [{ state: 'running' }],
  };
  interrupted(recording);
  assert.equal(recording.run.state, 'stopped');
  assert.equal(recording.run.stop_reason, 'browser_restarted');
  assert.equal(recording.run.active_rules, 0);
  assert.equal(recording.rules[0].state, 'stopped');
  assert.equal(recording.replays[0].state, 'interrupted');
  assert.equal(recording.requests[0].state, 'interrupted');
  assert.equal(recording.requests[0].request_body.reason, 'browser_restarted');
  assert.equal(recording.performance[0].state, 'interrupted');
  assert.equal(recording.operations[0].state, 'interrupted');
  assert.equal(recording.run.coverage.includes('interrupted_checkpoint'), true);
});
