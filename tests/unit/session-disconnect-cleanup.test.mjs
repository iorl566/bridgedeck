import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisconnectCleanup } from '../../extension/src/session-manager/disconnect-cleanup.js';

function harness(stopSession) {
  let changed = 0;
  const cleanup = createDisconnectCleanup({
    manager: { list: () => [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }] },
    stopSession,
    onSessionsChanged: () => { changed += 1; },
  });
  return { cleanup, changed: () => changed };
}

test('cleanup reports stopped and failed sessions', async () => {
  const { cleanup, changed } = harness(async (ctx) => {
    if (ctx.sessionId === 's2') return { code: 'cdp_failed', message: 'no' };
    if (ctx.sessionId === 's3') throw new Error('boom');
    return { return_failures: [] };
  });
  const report = await cleanup();
  assert.deepEqual(report.stoppedSessionIds, ['s1']);
  assert.equal(report.failures.length, 2);
  assert.equal(report.failures[0].message, 'no');
  assert.equal(report.failures[1].message, 'boom');
  assert.equal(changed(), 1);
});

test('cleanup records return failures', async () => {
  const { cleanup } = harness(async () => ({ return_failures: [{ message: 'a' }, { message: 'b' }] }));
  const report = await cleanup();
  assert.equal(report.stoppedSessionIds.length, 0);
  assert.equal(report.failures[0].message, 'a; b');
});

test('cleanup coalesces concurrent callers', async () => {
  let calls = 0;
  const { cleanup } = harness(async () => { calls += 1; return {}; });
  const a = cleanup();
  const b = cleanup();
  assert.equal(a, b);
  await a;
  assert.equal(calls, 3);
});
