// tests/unit/longshot-repaint-deep.test.mjs
// 第十一批-E 深度：重绘批次选择/进度/合并计划/批次日志/预算边界。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeRepaintBatch,
  estimateRepaintCost,
  mergeRepaintPlans,
  mergeRepaintResults,
  planLongshotRepaint,
  repaintProgress,
  selectRepaintBatches,
  shouldAbortRepaint,
} from '../../extension/src/lib/longshot-repaint.js';

const target = (index, overrides = {}) => ({
  index,
  reason: 'missing',
  severity: 'error',
  pageY: index * 100,
  pageHeight: 100,
  ...overrides,
});

test('selectRepaintBatches：按批拉取、默认 1 批、截断标记', () => {
  const plan = planLongshotRepaint({ repairs: [target(0), target(1), target(2)] }, {
    dpr: 1,
    width: 800,
    maxFramesPerPass: 1,
  });
  assert.equal(plan.batches.length, 3);
  const first = selectRepaintBatches(plan);
  assert.equal(first.returned, 1);
  assert.equal(first.truncated, true);
  const two = selectRepaintBatches(plan, { maxBatches: 2 });
  assert.equal(two.returned, 2);
  assert.equal(two.batches[1].pass, 2);
  assert.equal(Array.isArray(two.batches[0].targets), true);
  assert.equal(selectRepaintBatches(null).total, 0);
  assert.equal(selectRepaintBatches({ batches: null }).returned, 0);
});

test('repaintProgress：完成/部分/延后/空计划', () => {
  const plan = planLongshotRepaint({ repairs: [target(0), target(1), target(2)] }, {
    dpr: 1,
    width: 800,
    attemptsPerFrame: 1,
    maxPixels: 800 * 100 * 2,
  });
  assert.equal(plan.counts.scheduled, 2);
  assert.equal(plan.counts.deferred, 1);
  const partial = repaintProgress(plan, { applied: [{ index: 0 }], unresolved: [] });
  assert.equal(partial.applied, 1);
  assert.equal(partial.remaining, 2);
  assert.equal(partial.percent, 33.3);
  assert.equal(partial.done, false);
  const done = repaintProgress(plan, { applied: [{ index: 0 }, { index: 1 }] });
  assert.equal(done.applied, 2);
  assert.equal(done.percent, 66.7);
  assert.equal(done.done, false, '还有延后帧不算完成');
  const empty = repaintProgress(planLongshotRepaint(null, {}), null);
  assert.equal(empty.total, 0);
  assert.equal(empty.percent, 100);
  assert.equal(empty.done, true);
  assert.match(partial.text, /重绘进度/);
});

test('repaintProgress：与 mergeRepaintResults 串联（失败/未解决会计入剩余）', () => {
  const plan = planLongshotRepaint({ repairs: [target(0), target(1)] }, { dpr: 1, width: 800 });
  const merged = mergeRepaintResults(plan, [{ index: 0, ok: true }, { index: 1, ok: false }], { attemptsPerFrame: 1 });
  assert.equal(merged.applied.length, 1);
  assert.equal(merged.unresolved.length, 1);
  const progress = repaintProgress(plan, merged);
  assert.equal(progress.applied, 1);
  assert.equal(progress.unresolved, 1);
  assert.equal(progress.remaining, 0);
  assert.equal(progress.done, true, '未解决帧不再重试，进度按处理完算');
});

test('describeRepaintBatch：形状与缺失字段兜底', () => {
  assert.equal(describeRepaintBatch({ pass: 2, frames: [1, 2], pageRange: [100, 300] }), '第 2 批 2 帧 y=100..300');
  assert.equal(describeRepaintBatch(null), '重绘批次 无');
  assert.equal(describeRepaintBatch({}), '第 0 批 0 帧 y=0..0');
});

test('mergeRepaintPlans：按 index 去重、保留高 severity、合并原因', () => {
  const first = planLongshotRepaint({ repairs: [target(0, { severity: 'warn', reason: 'band:top' })] }, {
    dpr: 1,
    width: 800,
  });
  const second = planLongshotRepaint({ repairs: [target(0, { severity: 'error', reason: 'missing' }), target(1)] }, {
    dpr: 1,
    width: 800,
  });
  const merged = mergeRepaintPlans([first, second], { dpr: 1, width: 800 });
  assert.equal(merged.counts.requested, 2);
  assert.equal(merged.counts.scheduled, 2);
  assert.equal(merged.action, 'repaint');
  const indexZero = merged.batches.flatMap((batch) => batch.targets).find((item) => item.index === 0);
  assert.equal(indexZero.severity, 'error');
  assert.ok(indexZero.reasons.includes('missing'));
  assert.deepEqual(mergeRepaintPlans([], {}).action, 'skip');
  assert.deepEqual(mergeRepaintPlans(null).action, 'skip');
});

test('mergeRepaintPlans：延后目标保留（不丢）', () => {
  const tight = planLongshotRepaint({ repairs: [target(0), target(1)] }, {
    dpr: 1,
    width: 800,
    maxPixels: 800 * 100,
  });
  assert.equal(tight.counts.deferred, 1);
  const merged = mergeRepaintPlans([tight], { dpr: 1, width: 800, maxPixels: 0, maxBytes: 0 });
  assert.equal(merged.counts.requested, 2);
  assert.equal(merged.counts.scheduled, 2);
});

test('成本估算与预算边界：单帧超预算 → 全部延后', () => {
  const plan = planLongshotRepaint({ repairs: [target(0, { pageHeight: 5000 })] }, {
    dpr: 2,
    width: 2000,
    maxPixels: 1000,
  });
  assert.equal(plan.counts.scheduled, 0);
  assert.equal(plan.counts.deferred, 1);
  assert.equal(plan.action, 'repaint-partial');
  assert.equal(plan.ok, false, '一帧都排不进预算时 ok=false（交给下一轮放宽预算）');
  const estimate = estimateRepaintCost([target(0, { pageHeight: 10 })], { dpr: 1, width: 100 });
  assert.equal(estimate.pixels, 100 * 10);
});

test('shouldAbortRepaint：计划计数为 0 但仍有延后帧 → 不放弃（先别 abort）', () => {
  const plan = planLongshotRepaint({ repairs: [target(0)] }, {
    dpr: 1,
    width: 800,
    maxPixels: 1,
    maxPasses: 3,
  });
  assert.equal(plan.counts.scheduled, 0);
  assert.equal(plan.counts.deferred, 1);
  const decision = shouldAbortRepaint(0, plan);
  assert.equal(decision.abort, false, '还有延后帧时应允许下一轮（放宽预算）');
  const maxed = shouldAbortRepaint(3, plan);
  assert.equal(maxed.abort, true);
});
