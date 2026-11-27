import test from 'node:test';
import assert from 'node:assert/strict';
import { staleMetrics, planStaleRecovery } from '../../extension/src/lib/capture-freshness.js';

test('staleMetrics：高度/宽度变化检测', () => {
  const before = { scrollHeight: 15000, scrollWidth: 1241, innerWidth: 1241, innerHeight: 800 };
  assert.equal(staleMetrics(before, { ...before }).stale, false);
  const grew = staleMetrics(before, { ...before, scrollHeight: 15800 });
  assert.equal(grew.stale, true);
  assert.deepEqual(grew.changed.map((item) => item.field), ['scrollHeight']);
  assert.equal(staleMetrics(before, { ...before, scrollWidth: 1250 }).stale, true);
});

test('staleMetrics：容差与缺参', () => {
  const before = { scrollHeight: 15000 };
  assert.equal(staleMetrics(before, { scrollHeight: 15000.5 }, { tolerance: 1 }).stale, false);
  assert.equal(staleMetrics(before, { scrollHeight: 15001.5 }, { tolerance: 1 }).stale, true);
  assert.equal(staleMetrics(null, before).stale, false);
  assert.equal(staleMetrics(before, null).stale, false);
});

test('staleMetrics：非数值字段忽略', () => {
  const result = staleMetrics({ scrollHeight: 1, scrollWidth: 'x' }, { scrollHeight: 3, scrollWidth: 'y' });
  assert.equal(result.stale, true);
  assert.deepEqual(result.changed.map((item) => item.field), ['scrollHeight']);
});

test('planStaleRecovery：只向下增长时补拍新增 tile', () => {
  const plan = planStaleRecovery(
    { scrollHeight: 15000, scrollWidth: 1241 },
    { scrollHeight: 18000, scrollWidth: 1241 },
    { scale: 1, device: { width: 1241, height: 15000 } },
  );
  assert.deepEqual(plan, { action: 'extend', width: 1241, height: 18000, y0: 15000 });
});

test('planStaleRecovery：宽度变化或缩小整页重拍', () => {
  assert.equal(planStaleRecovery(
    { scrollHeight: 15000, scrollWidth: 1241 },
    { scrollHeight: 15000, scrollWidth: 1300 },
    { scale: 1 },
  ).action, 'retry');
  assert.equal(planStaleRecovery(
    { scrollHeight: 15000, scrollWidth: 1241 },
    { scrollHeight: 14000, scrollWidth: 1241 },
    { scale: 1 },
  ).action, 'retry');
});

test('planStaleRecovery：未变化直接接受', () => {
  assert.equal(planStaleRecovery(
    { scrollHeight: 15000, scrollWidth: 1241, revision: 3 },
    { scrollHeight: 15000, scrollWidth: 1241, revision: 3 },
    { scale: 1 },
  ).action, 'accept');
});

test('planStaleRecovery：尺寸不变但 DOM 变了 → 任意区域逐 tile 重写', () => {
  const plan = planStaleRecovery(
    { scrollHeight: 15000, scrollWidth: 1241, revision: 3 },
    { scrollHeight: 15000, scrollWidth: 1241, revision: 9 },
    { scale: 1, device: { width: 1241, height: 15000 } },
  );
  assert.equal(plan.action, 'rewrite');
  assert.equal(plan.width, 1241);
  assert.equal(plan.height, 15000);
});
