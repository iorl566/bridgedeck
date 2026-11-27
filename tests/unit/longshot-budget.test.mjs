import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LONGSHOT_BUDGET_DEFAULTS,
  normalizeDpr,
  resolveLongshotBudget,
  estimateLongshotBudget,
  chooseTileConcurrency,
  mapWithConcurrency,
  estimateTileCount,
  budgetReport,
  describeBudget,
} from '../../extension/src/lib/longshot-budget.js';

test('normalizeDpr：保留分数 DPR、非法与越界回落', () => {
  assert.equal(normalizeDpr(1.5), 1.5);
  assert.equal(normalizeDpr(1.25), 1.25);
  assert.equal(normalizeDpr(1.3333), 1.333);
  assert.equal(normalizeDpr(0.5), 1);
  assert.equal(normalizeDpr(9), 3);
  assert.equal(normalizeDpr('x'), 1);
  assert.equal(normalizeDpr(null), 1);
  assert.equal(normalizeDpr(-2), 1);
  assert.equal(normalizeDpr(2.5, { min: 2, max: 2.5 }), 2.5);
});

test('resolveLongshotBudget：覆盖项生效，非法覆盖回落默认', () => {
  const merged = resolveLongshotBudget({ maxTotalPixels: 1000, maxConcurrent: 3, minSegmentHeight: 999999 });
  assert.equal(merged.maxTotalPixels, 1000);
  assert.equal(merged.maxConcurrent, 3);
  assert.equal(merged.minSegmentHeight, merged.maxSegmentHeight);
  const fallback = resolveLongshotBudget({ maxTotalPixels: -1, maxConcurrent: 0, maxDpr: 'x' });
  assert.equal(fallback.maxTotalPixels, LONGSHOT_BUDGET_DEFAULTS.maxTotalPixels);
  assert.equal(fallback.maxConcurrent, LONGSHOT_BUDGET_DEFAULTS.maxConcurrent);
  assert.equal(fallback.maxDpr, LONGSHOT_BUDGET_DEFAULTS.maxDpr);
});

test('estimateLongshotBudget：普通页面不降级（1241x15000 @1.5）', () => {
  const plan = estimateLongshotBudget({ scrollWidth: 1241, scrollHeight: 15000, dpr: 1.5 });
  assert.equal(plan.ok, true);
  assert.equal(plan.requestedDpr, 1.5);
  assert.equal(plan.dpr, 1.5);
  assert.equal(plan.fractional, true);
  assert.equal(plan.cssWidth, 1241);
  assert.equal(plan.cssHeight, 15000);
  assert.equal(plan.deviceWidth, 1862);
  assert.equal(plan.deviceHeight, 22500);
  assert.equal(plan.totalPixels, 1862 * 22500);
  assert.equal(plan.memoryBytes, 1862 * 22500 * 4);
  assert.equal(plan.totalSegments, 1);
  assert.equal(plan.degraded, false);
  assert.equal(plan.reason, null);
  assert.equal(plan.truncated, false);
  assert.deepEqual(plan.notes, []);
});

test('estimateLongshotBudget：45000 设备像素高 → 2 段（与 E2E 31e2 同尺寸）', () => {
  const plan = estimateLongshotBudget({ scrollWidth: 1241, scrollHeight: 45000, dpr: 1 });
  assert.equal(plan.segmentHeight, 40000);
  assert.equal(plan.totalSegments, 2);
  assert.equal(plan.deviceHeight, 45000);
  assert.equal(plan.degraded, false);
});

test('estimateLongshotBudget：单段像素上限压低段高（超宽页面）', () => {
  const plan = estimateLongshotBudget({ scrollWidth: 40000, scrollHeight: 1000, dpr: 1 });
  assert.equal(plan.deviceWidth, 40000);
  assert.equal(plan.segmentHeight, Math.floor((64 * 1024 * 1024) / 40000));
  assert.ok(plan.segmentHeight < 40000, '超宽页面必须压低段高');
  assert.equal(plan.totalSegments, 1);
});

test('estimateLongshotBudget：设备像素宽超上限 → 裁剪并标记 degraded=device-width', () => {
  const plan = estimateLongshotBudget({ scrollWidth: 50000, scrollHeight: 1000, dpr: 1 });
  assert.equal(plan.deviceWidth, 40000);
  assert.equal(plan.degraded, true);
  assert.equal(plan.reason, 'device-width');
  assert.match(plan.notes.join('|'), /超过上限/);
});

test('estimateLongshotBudget：总像素超预算且无可用 DPR 档位 → 显式截断', () => {
  const plan = estimateLongshotBudget({ scrollWidth: 8000, scrollHeight: 60000, dpr: 1 });
  assert.equal(plan.degraded, true);
  assert.equal(plan.reason, 'memory-budget');
  assert.equal(plan.truncated, true);
  assert.equal(plan.deviceHeight, Math.floor(LONGSHOT_BUDGET_DEFAULTS.maxTotalPixels / 8000));
  assert.ok(plan.totalPixels <= LONGSHOT_BUDGET_DEFAULTS.maxTotalPixels);
  assert.match(plan.notes.join('|'), /截断/);
});

test('estimateLongshotBudget：总像素超预算时按档位降级 DPR（3 → 1.5）', () => {
  const plan = estimateLongshotBudget({ scrollWidth: 1241, scrollHeight: 100000, dpr: 3 });
  assert.equal(plan.requestedDpr, 3);
  assert.equal(plan.dpr, 1.5);
  assert.equal(plan.degraded, true);
  assert.equal(plan.reason, 'memory-budget');
  assert.ok(plan.totalPixels <= LONGSHOT_BUDGET_DEFAULTS.maxTotalPixels);
  assert.match(plan.notes.join('|'), /DPR 从 3 降级到 1.5/);
});

test('estimateLongshotBudget：总分段数超上限时增大段高', () => {
  const plan = estimateLongshotBudget({
    scrollWidth: 1241,
    scrollHeight: 45000,
    dpr: 1,
    maxSegmentPixels: 1024 * 1024,
    maxSegments: 16,
  });
  assert.equal(plan.totalSegments, 16);
  assert.equal(plan.segmentHeight, Math.ceil(45000 / 16));
  assert.equal(plan.degraded, true);
  assert.equal(plan.reason, 'segment-count');
  assert.match(plan.notes.join('|'), /段数 54 超过上限 16/);
});

test('chooseTileConcurrency：请求值/预算上限/任务数三重取小', () => {
  assert.deepEqual(chooseTileConcurrency({ requested: 5, budget: { maxConcurrent: 2 }, tiles: 100 }), {
    concurrency: 2,
    wanted: 5,
    max: 2,
    reason: 'budget',
  });
  assert.equal(chooseTileConcurrency({ requested: 1, budget: { maxConcurrent: 2 }, tiles: 100 }).concurrency, 1);
  assert.equal(chooseTileConcurrency({ requested: 2, budget: { maxConcurrent: 2 }, tiles: 1 }).concurrency, 1);
  assert.equal(chooseTileConcurrency({ requested: 0 }).concurrency, 1);
  assert.equal(chooseTileConcurrency({ requested: 2, budget: { maxConcurrent: 3 } }).concurrency, 2);
});

test('mapWithConcurrency：保持结果顺序且并发不超过上限', async () => {
  const active = { current: 0, max: 0 };
  const order = [];
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active.current += 1;
    active.max = Math.max(active.max, active.current);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active.current -= 1;
    order.push(value);
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
  assert.equal(active.max, 2);
  assert.equal(order.length, 6);
});

test('mapWithConcurrency：空数组/单任务/invalid worker', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency(['a'], 4, async (value) => value.toUpperCase()), ['A']);
  await assert.rejects(() => mapWithConcurrency([1], 1, null), TypeError);
});

test('mapWithConcurrency：失败后不再调度新任务并抛出第一个错误', async () => {
  const started = [];
  const boom = new Error('boom');
  await assert.rejects(
    () => mapWithConcurrency([0, 1, 2, 3, 4], 1, async (value) => {
      started.push(value);
      if (value === 2) throw boom;
      return value;
    }),
    /boom/,
  );
  assert.deepEqual(started, [0, 1, 2], '失败后不应继续调度：' + started.join(','));
});

test('estimateTileCount：按 tile 尺寸估算行列', () => {
  assert.deepEqual(estimateTileCount({ deviceWidth: 1241, deviceHeight: 15000, tileSize: 512 }), { cols: 3, rows: 30, tiles: 90 });
  assert.deepEqual(estimateTileCount({ deviceWidth: 1, deviceHeight: 1, tileSize: 512 }), { cols: 1, rows: 1, tiles: 1 });
  assert.deepEqual(estimateTileCount({ deviceWidth: 512, deviceHeight: 512, tileSize: 512 }), { cols: 1, rows: 1, tiles: 1 });
});

test('budgetReport：输出 {budget, used, degraded, reason}', () => {
  const plan = estimateLongshotBudget({ scrollWidth: 1241, scrollHeight: 45000, dpr: 1 });
  const report = budgetReport(plan);
  assert.deepEqual(Object.keys(report), ['budget', 'used', 'degraded', 'reason', 'truncated']);
  assert.equal(report.degraded, false);
  assert.equal(report.reason, null);
  assert.equal(report.used.segments, 2);
  assert.equal(report.budget.maxSegmentPixels, LONGSHOT_BUDGET_DEFAULTS.maxSegmentPixels);
  const degraded = budgetReport(estimateLongshotBudget({ scrollWidth: 8000, scrollHeight: 60000, dpr: 1 }));
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.reason, 'memory-budget');
  assert.equal(degraded.truncated, true);
  assert.deepEqual(budgetReport(null).used.segments, undefined);
  assert.equal(budgetReport(null).degraded, false);
});

test('describeBudget：日志包含段数/DPR/降级原因', () => {
  const plan = estimateLongshotBudget({ scrollWidth: 1241, scrollHeight: 100000, dpr: 3 });
  const text = describeBudget(plan);
  assert.match(text, /段/);
  assert.match(text, /dpr=1\.5/);
  assert.match(text, /降级 memory-budget/);
  assert.equal(describeBudget(null), '预算不可用');
});
