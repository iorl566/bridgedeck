import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDebugEvidence } from '../../lib/debug-evidence.mjs';

test('buildDebugEvidence produces counts and stable hashes', () => {
  const snapshot = {
    context: { url: 'https://example.com/', title: 'Example' },
    requests: [{ id: 1, url: 'https://example.com/api' }],
    console: [{ level: 'warn', text: 'hi' }],
    performance: { metrics: { cls: 0 } },
  };
  const evidence = buildDebugEvidence(snapshot, { session: 's1', generatedAt: 1700000000000 });
  assert.equal(evidence.version, 1);
  assert.equal(evidence.session, 's1');
  assert.equal(evidence.page.url, 'https://example.com/');
  assert.deepEqual(evidence.counts, { requests: 1, console: 1, operations: 0 });
  assert.equal(evidence.integrity.requestsSha256.length, 64);
  assert.equal(evidence.integrity.consoleSha256.length, 64);
  assert.equal(evidence.integrity.operationsSha256.length, 64);
  assert.equal(evidence.generatedAt, new Date(1700000000000).toISOString());
});

test('buildDebugEvidence links operations by commandId', () => {
  const snapshot = {
    requests: [{ id: 1, commandId: 'cmd-1' }, { id: 2, commandId: 'cmd-2' }],
    console: [],
  };
  const evidence = buildDebugEvidence(snapshot, {
    operations: [
      { id: 'op-1', method: 'click', commandId: 'cmd-1', ts: 1000, durationMs: 10, ok: true },
      { id: 'op-2', method: 'fill', commandId: null },
    ],
  });
  assert.equal(evidence.counts.operations, 2);
  assert.deepEqual(evidence.operations[0].requestIds, [1]);
  assert.deepEqual(evidence.operations[1].requestIds, []);
});

test('buildDebugEvidence tolerates empty snapshots', () => {
  const evidence = buildDebugEvidence(null, { session: 's' });
  assert.deepEqual(evidence.counts, { requests: 0, console: 0, operations: 0 });
  assert.equal(evidence.page.url, '');
  assert.equal(evidence.integrity.performanceSha256.length, 64);
});
