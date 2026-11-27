import test from 'node:test';
import assert from 'node:assert/strict';
import { diffTraceSummary } from '../../lib/trace-summary.mjs';

test('diffTraceSummary 计算事件/时长/长任务与热点变化', () => {
  const base = { events: 10, durationMs: 100, longTaskCount: 1, topNames: [{ key: 'Paint', count: 5 }, { key: 'RunTask', count: 2 }] };
  const head = { events: 12, durationMs: 130, longTaskCount: 2, topNames: [{ key: 'Paint', count: 7 }, { key: 'Layout', count: 3 }] };
  const diff = diffTraceSummary(base, head);
  assert.deepEqual(diff.events, { base: 10, head: 12, delta: 2 });
  assert.equal(diff.durationMs.delta, 30);
  assert.equal(diff.longTaskCount.delta, 1);
  assert.equal(diff.topChanges[0].key, 'Layout');
  assert.equal(diff.topChanges.find((item) => item.key === 'RunTask').delta, -2);
});

test('diffTraceSummary 空输入安全', () => {
  const diff = diffTraceSummary(null, { events: 3 });
  assert.equal(diff.events.base, 0);
  assert.equal(diff.events.delta, 3);
  assert.deepEqual(diff.topChanges, []);
});
