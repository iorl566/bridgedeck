// tests/unit/longshot-repaint.test.mjs
// 第十一批-E：长截图帧级重绘计划（lib/longshot-repaint.js）。
// 覆盖：目标归一化、优先级排序、成本估算、预算分批、延后、结果合并、放弃判定、wire/describe。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LONGSHOT_REPAINT_VERSION,
  REPAINT_ACTIONS,
  REPAINT_CODES,
  REPAINT_DEFAULTS,
  describeRepaint,
  estimateRepaintCost,
  mergeRepaintResults,
  normalizeRepairTarget,
  planLongshotRepaint,
  repairPriority,
  repaintWire,
  shouldAbortRepaint,
} from '../../extension/src/lib/longshot-repaint.js';

function target(index, overrides = {}) {
  return {
    index,
    reason: 'missing',
    severity: 'error',
    pageY: index * 100,
    pageHeight: 100,
    ...overrides,
  };
}

test('常量：动作/默认值/问题码形状稳定', () => {
  assert.equal(LONGSHOT_REPAINT_VERSION, 1);
  assert.deepEqual([...REPAINT_ACTIONS], ['skip', 'repaint', 'repaint-partial', 'defer', 'abort']);
  assert.equal(REPAINT_DEFAULTS.maxFramesPerPass > 0, true);
  assert.equal(REPAINT_DEFAULTS.attemptsPerFrame >= 1, true);
  assert.match(REPAINT_CODES.UNRESOLVED, /^longshot\.repaint\./);
});

test('normalizeRepairTarget：非法目标丢弃；reason 归一化；缺省字段兜底', () => {
  assert.equal(normalizeRepairTarget(null), null);
  assert.equal(normalizeRepairTarget({ index: -1 }), null);
  const normalized = normalizeRepairTarget({ index: 2, reason: 'misaligned:pageY', severity: 'warn' });
  assert.equal(normalized.index, 2);
  assert.equal(normalized.reason, 'misaligned');
  assert.deepEqual(normalized.reasons, ['misaligned']);
  assert.equal(normalized.state, 'pending');
  assert.equal(normalized.pageY, 0);
  assert.equal(normalized.pageHeight, 1);
  const unknownReason = normalizeRepairTarget({ index: 0, reason: 'weird-reason' });
  assert.equal(unknownReason.reason, 'weird-reason');
  const multi = normalizeRepairTarget({ index: 0, reasons: ['band:top', 'missing'] });
  assert.deepEqual(multi.reasons, ['band:top', 'missing']);
});

test('repairPriority：error > warn，缺帧高于错位，页面越靠上前', () => {
  const missing = repairPriority(target(0, { reason: 'missing', severity: 'error' }));
  const misaligned = repairPriority(target(0, { reason: 'misaligned', severity: 'warn' }));
  assert.ok(missing > misaligned);
  const top = repairPriority(target(0, { pageY: 0 }));
  const bottom = repairPriority(target(0, { pageY: 5000 }));
  assert.ok(top > bottom);
  const band = repairPriority(target(0, { reason: 'band:top', severity: 'warn' }));
  const stale = repairPriority(target(0, { reason: 'stale', severity: 'warn' }));
  assert.ok(band > stale);
  assert.equal(repairPriority(null), -1);
});

test('estimateRepaintCost：像素/字节/耗时按 dpr 与宽度缩放', () => {
  const cost = estimateRepaintCost([target(0), target(1)], { dpr: 2, width: 800 });
  assert.equal(cost.frames, 2);
  assert.equal(cost.pixels, 2 * 800 * 100 * 4);
  assert.equal(cost.perTarget.length, 2);
  assert.ok(cost.estimateBytes > 0);
  assert.ok(cost.estimateMs >= 0);
  const empty = estimateRepaintCost(null);
  assert.equal(empty.frames, 0);
  assert.equal(empty.pixels, 0);
});

test('planLongshotRepaint：无目标 → skip', () => {
  const plan = planLongshotRepaint(null, {});
  assert.equal(plan.action, 'skip');
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.issues, [REPAINT_CODES.NONE]);
  assert.deepEqual(plan.batches, []);
  assert.match(describeRepaint(plan), /skip/);
});

test('planLongshotRepaint：按预算分批，超预算目标延后（repaint-partial）', () => {
  const targets = [target(0), target(1), target(2), target(3)];
  const plan = planLongshotRepaint({ repairs: targets }, {
    dpr: 1,
    width: 800,
    maxFramesPerPass: 2,
    maxPixels: 800 * 100 * 2,
  });
  assert.equal(plan.action, 'repaint-partial');
  assert.equal(plan.counts.scheduled, 2);
  assert.equal(plan.counts.deferred, 2);
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].targets.length, 2);
  assert.ok(plan.deferred.every((item) => item.deferredReason === 'pixels'));
  assert.ok(plan.issues.includes(REPAINT_CODES.DEFERRED));
});

test('planLongshotRepaint：分批内按页面坐标升序、批与批按优先级', () => {
  const plan = planLongshotRepaint({ repairs: [
    target(0, { severity: 'warn', pageY: 0 }),
    target(1, { severity: 'error', pageY: 100 }),
    target(2, { severity: 'error', pageY: 50 }),
    target(3, { severity: 'error', pageY: 200 }),
  ] }, { dpr: 1, width: 800, maxFramesPerPass: 2, maxPixels: 0, maxBytes: 0 });
  assert.equal(plan.action, 'repaint');
  assert.equal(plan.counts.scheduled, 4);
  assert.equal(plan.batches.length, 2);
  const firstBatchFrames = plan.batches[0].frames;
  assert.deepEqual(firstBatchFrames, [2, 1], '批内按 pageY 升序');
  assert.deepEqual(plan.batches[1].frames, [0, 3], '第二批同样按 pageY 升序');
  assert.equal(plan.counts.requested, 4);
});

test('planLongshotRepaint：接受 repairs 数组 / targets 数组；估算与批像素累计', () => {
  const plan = planLongshotRepaint([target(0), target(1)], { dpr: 1, width: 800, maxPixels: 0 });
  assert.equal(plan.counts.scheduled, 2);
  assert.equal(plan.cost.pixels, 2 * 800 * 100);
  assert.equal(plan.batches[0].pixels, 2 * 800 * 100);
  assert.match(plan.digest, /^[0-9a-f]{16}$/);
  assert.deepEqual(plan.evidence.budget.maxFramesPerPass, REPAINT_DEFAULTS.maxFramesPerPass);
});

test('mergeRepaintResults：成功/可重试失败/超限未解决/延后', () => {
  const plan = planLongshotRepaint({ repairs: [target(0), target(1), target(2)] }, {
    dpr: 1,
    width: 800,
    attemptsPerFrame: 1,
    maxPixels: 800 * 100 * 2,
  });
  assert.equal(plan.counts.scheduled, 2);
  assert.equal(plan.counts.deferred, 1);
  const merged = mergeRepaintResults(plan, [
    { index: 0, ok: true, hash: 'abcdef0123456789', bytes: 42 },
    { index: 1, ok: false, error: 'capture-failed' },
  ], { attemptsPerFrame: 1 });
  assert.equal(merged.ok, false);
  assert.deepEqual(merged.applied.map((item) => item.index), [0]);
  assert.deepEqual(merged.unresolved.map((item) => item.index), [1]);
  assert.equal(merged.deferred.length, 1);
  assert.equal(merged.nextPass, true);
  assert.ok(merged.issues.includes(REPAINT_CODES.APPLIED));
  assert.ok(merged.issues.includes(REPAINT_CODES.UNRESOLVED));
  assert.equal(merged.attempts[1], 1);
});

test('mergeRepaintResults：全部成功 → ok，无下一轮', () => {
  const plan = planLongshotRepaint({ repairs: [target(0)] }, { dpr: 1, width: 800 });
  const merged = mergeRepaintResults(plan, [{ index: 0, ok: true, bytes: 10 }]);
  assert.equal(merged.ok, true);
  assert.equal(merged.nextPass, false);
  assert.equal(merged.counts.applied, 1);
  assert.equal(merged.attempts[0], 1);
  const retryable = mergeRepaintResults(plan, [{ index: 0, ok: false }], { attemptsPerFrame: 2 });
  assert.equal(retryable.failed.length, 1);
  assert.equal(retryable.failed[0].retry, true);
});

test('shouldAbortRepaint：轮次上限 / 无事可做 / 继续', () => {
  const plan = planLongshotRepaint({ repairs: [target(0)] }, { dpr: 1, width: 800, maxPasses: 2 });
  assert.equal(shouldAbortRepaint(0, plan).abort, false);
  const aborted = shouldAbortRepaint(2, plan);
  assert.equal(aborted.abort, true);
  assert.equal(aborted.code, REPAINT_CODES.ABORT);
  const nothing = shouldAbortRepaint(0, planLongshotRepaint(null, {}));
  assert.equal(nothing.abort, true);
  assert.equal(nothing.code, REPAINT_CODES.NONE);
  const nullPlan = shouldAbortRepaint(0, null);
  assert.equal(nullPlan.abort, true, '没有计划就没有可重绘的帧');
  assert.equal(nullPlan.reason, 'nothing-to-repaint');
});

test('repaintWire/describeRepaint：列表截断、文本可读', () => {
  const plan = planLongshotRepaint({ repairs: [target(0), target(1)] }, { dpr: 1, width: 800, maxFramesPerPass: 1 });
  const wire = repaintWire(plan, { maxListed: 4 });
  assert.equal(wire.version, LONGSHOT_REPAINT_VERSION);
  assert.equal(wire.counts.scheduled, 2);
  assert.equal(wire.batches.length, 2);
  assert.equal(wire.batches[0].frames.length, 1);
  assert.match(wire.text, /重绘计划/);
  assert.match(describeRepaint(plan), /帧分/);
  assert.equal(repaintWire(null).action, 'skip');
  assert.match(describeRepaint(null), /无/);
});
