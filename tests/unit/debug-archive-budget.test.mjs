import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDebugArchive, applyArchiveBudget, DEFAULT_ARCHIVE_BUDGET } from '../../lib/debug-archive.mjs';
import { createArchiveIndex, archiveSummary } from '../../lib/debug-archive-index.mjs';

function snapshot(requests = 5, consoleEntries = 3) {
  return {
    context: { url: 'https://x', title: 't' },
    requests: Array.from({ length: requests }, (_, i) => ({ id: i, method: 'GET', url: 'https://x/' + i, status: 200 })),
    console: Array.from({ length: consoleEntries }, (_, i) => ({ level: 'log', text: 'c' + i })),
  };
}

test('完整归档：coverage.complete=true，无 gaps', () => {
  const archive = buildDebugArchive(snapshot(), { budget: { maxRequests: 10, maxConsole: 10 } });
  assert.equal(archive.coverage.complete, true);
  assert.deepEqual(archive.gaps, []);
  assert.equal(archive.summary.requests, 5);
  assert.ok(archive.summary.bytes > 0);
});

test('按条数裁剪保留最近条目并记录 gaps', () => {
  const archive = buildDebugArchive(snapshot(10, 5), { budget: { maxRequests: 4, maxConsole: 2 } });
  assert.equal(archive.summary.requests, 4);
  assert.equal(archive.summary.console, 2);
  assert.deepEqual(archive.requests.map((item) => item.id), [6, 7, 8, 9]);
  assert.equal(archive.coverage.dropped.requests, 6);
  assert.ok(archive.gaps.some((gap) => gap.reason === 'max-requests'));
  assert.ok(archive.gaps.some((gap) => gap.reason === 'max-console'));
});

test('按字节预算裁剪', () => {
  const archive = applyArchiveBudget(buildDebugArchive(snapshot(20, 0)), { maxBytes: 900, maxRequests: 200, maxConsole: 200 });
  assert.ok(archive.summary.bytes <= 900, 'bytes 超出预算：' + archive.summary.bytes);
  assert.ok(archive.coverage.dropped.requests > 0);
  assert.ok(archive.gaps.some((gap) => gap.reason === 'max-bytes'));
});

test('索引 stats 汇总 bytes 与 summary.complete', () => {
  const index = createArchiveIndex({ maxEntries: 10 });
  index.add(buildDebugArchive(snapshot(2, 1), { id: 'a', budget: { maxRequests: 10 } }));
  index.add(buildDebugArchive(snapshot(2, 1), { id: 'b', budget: { maxRequests: 1 } }));
  const stats = index.stats();
  assert.ok(stats.bytes > 0);
  const summaries = index.list().map(archiveSummary);
  const b = summaries.find((item) => item.id === 'b');
  assert.equal(b.complete, false);
  assert.equal(b.bytes > 0, true);
  assert.equal(DEFAULT_ARCHIVE_BUDGET.maxRequests, 200);
});

test('归档保留调试动作 journal', () => {
  const archive = buildDebugArchive({
    ...snapshot(1, 0),
    journal: [{ at: 1, type: 'start' }, { at: 2, type: 'rule', action: 'add', id: 1 }],
  });
  assert.equal(archive.journal.length, 2);
  assert.equal(archive.summary.journal, 2);
});
