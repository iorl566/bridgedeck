import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDGET_CODES,
  VIDEO_BUDGET_DEFAULTS,
  budgetReport,
  clampDuration,
  downgradeBitrate,
  evaluateBudget,
  normalizeBudget,
  projectedBytesFor,
  shouldRotateSegment,
  summarizeBudgetEvaluation,
} from '../../extension/src/lib/video-budget.js';

test('normalizeBudget：默认值、非法值回退与边界裁剪', () => {
  const defaults = normalizeBudget();
  assert.equal(defaults.normalized, true);
  assert.equal(defaults.budget.maxDurationMs, 10 * 60 * 1000);
  assert.equal(defaults.budget.maxTotalBytes, 256 * 1024 * 1024);
  assert.equal(defaults.budget.maxConcurrent, 1);

  const invalid = normalizeBudget({ maxDurationMs: -5, maxTotalBytes: 0, maxConcurrent: 0, downgradeRatio: 2, warnRatio: 0.1 });
  assert.equal(invalid.problems.length, 3);
  assert.equal(invalid.budget.maxDurationMs, VIDEO_BUDGET_DEFAULTS.maxDurationMs);
  assert.equal(invalid.budget.maxConcurrent, 1);
  assert.equal(invalid.budget.downgradeRatio <= 0.9, true);
  assert.equal(invalid.budget.warnRatio > invalid.budget.downgradeRatio, true);
  assert.deepEqual(invalid.problems.map((item) => item.code), Array(3).fill(BUDGET_CODES.INVALID));

  const clamped = normalizeBudget({ maxDurationMs: 1, maxTotalBytes: 99999999999999, maxConcurrent: 99, downgradeRatio: 0.0001 });
  assert.equal(clamped.budget.maxDurationMs, VIDEO_BUDGET_DEFAULTS.minDurationMs);
  assert.equal(clamped.budget.maxConcurrent, 8);
  assert.equal(clamped.budget.maxTotalBytes <= 2 * 1024 * 1024 * 1024, true);
  assert.equal(clamped.budget.downgradeRatio, 0.1);

  const strict = normalizeBudget({ mystery: 1 }, { strict: true });
  assert.equal(strict.normalized, false);
  assert.equal(strict.problems[0].field, 'mystery');
});

test('clampDuration：0 表示不限、超限裁剪并给证据', () => {
  const budget = normalizeBudget({ maxDurationMs: 10_000 }).budget;
  assert.deepEqual(clampDuration(undefined, budget), { ok: true, durationMs: 0, requestedMs: 0, maxDurationMs: 10_000, clamped: false, evidence: [] });
  assert.equal(clampDuration(0, budget).durationMs, 0);
  const within = clampDuration(5_000, budget);
  assert.equal(within.durationMs, 5_000);
  assert.equal(within.clamped, false);
  const over = clampDuration(60_000, budget);
  assert.equal(over.durationMs, 10_000);
  assert.equal(over.clamped, true);
  assert.equal(over.requestedMs, 60_000);
  assert.equal(over.evidence[0].code, BUDGET_CODES.DURATION);
  assert.equal(clampDuration(-100, budget).durationMs, 0);
});

test('projectedBytesFor / downgradeBitrate / shouldRotateSegment', () => {
  const budget = normalizeBudget({ maxDurationMs: 60_000, maxTotalBytes: 100 * 1024 * 1024 }).budget;
  // 8Mbps ≈ 1000 bytes/ms；60s 无已用字节 → 约 60MB
  assert.equal(projectedBytesFor({ bitrate: 8_000_000, elapsedMs: 0 }, budget), 60_000_000);
  assert.equal(projectedBytesFor({ bitrate: 8_000_000, elapsedMs: 30_000, totalBytes: 30_000_000 }, budget), 60_000_000);
  assert.equal(projectedBytesFor({ bitrate: 0, elapsedMs: 1000, totalBytes: 500 }, budget), 500);

  assert.equal(downgradeBitrate(4_000_000, budget), 2_400_000);
  const floored = normalizeBudget({ bitrateFloor: 3_000_000 }).budget;
  assert.equal(downgradeBitrate(4_000_000, floored), 3_000_000);
  assert.equal(downgradeBitrate(0, floored), 0);

  assert.deepEqual(shouldRotateSegment(10, budget), { rotate: false, segmentBytes: 10, limit: budget.maxSegmentBytes });
  assert.equal(shouldRotateSegment(budget.maxSegmentBytes, budget).rotate, true);
});

test('evaluateBudget：并发拒绝 / 时长停止 / 体积停止', () => {
  const budget = normalizeBudget({ maxDurationMs: 10_000, maxTotalBytes: 1_000_000 }).budget;
  const concurrent = evaluateBudget({ activeCount: 2 }, budget);
  assert.equal(concurrent.action, 'reject');
  assert.equal(concurrent.ok, false);
  assert.equal(concurrent.code, BUDGET_CODES.CONCURRENT);
  assert.equal(concurrent.evidence.reason, 'concurrent_limit');

  const duration = evaluateBudget({ activeCount: 1, elapsedMs: 10_000 }, budget);
  assert.equal(duration.action, 'stop');
  assert.equal(duration.stop_reason, 'duration');
  assert.equal(duration.code, BUDGET_CODES.DURATION);
  assert.equal(duration.evidence.reason, 'duration_limit');

  const size = evaluateBudget({ activeCount: 1, elapsedMs: 1000, totalBytes: 2_000_000 }, budget);
  assert.equal(size.action, 'stop');
  assert.equal(size.stop_reason, 'size');
  assert.equal(size.code, BUDGET_CODES.SIZE);
});

test('evaluateBudget：单段超限暂停分段 / 预估超限降码率 / 接近阈值 warning', () => {
  const budget = normalizeBudget({ maxDurationMs: 60_000, maxTotalBytes: 50 * 1024 * 1024, maxSegmentBytes: 8 * 1024 * 1024 }).budget;
  const segment = evaluateBudget({ activeCount: 1, elapsedMs: 1000, segmentBytes: 9 * 1024 * 1024 }, budget);
  assert.equal(segment.action, 'pause-segment');
  assert.equal(segment.code, BUDGET_CODES.SEGMENT);
  assert.equal(segment.evidence.reason, 'segment_limit');

  // 8Mbps 录 60s 预估 60MB > 50MB*0.9=45MB → 降码率
  const downgrade = evaluateBudget({ activeCount: 1, elapsedMs: 0, totalBytes: 0, bitrate: 8_000_000 }, budget);
  assert.equal(downgrade.action, 'downgrade-bitrate');
  assert.equal(downgrade.code, BUDGET_CODES.BITRATE);
  assert.equal(downgrade.downgradedBitrate, 4_800_000);
  assert.equal(downgrade.evidence.reason, 'projected_size_limit');

  const nearDuration = evaluateBudget({ activeCount: 1, elapsedMs: 9_500, bitrate: 1_000_000 }, normalizeBudget({ maxDurationMs: 10_000 }).budget);
  assert.equal(nearDuration.action, 'continue');
  assert.equal(nearDuration.ok, true);
  assert.equal(nearDuration.warnings.some((item) => item.code === BUDGET_CODES.DURATION), true);

  const clean = evaluateBudget({ activeCount: 1, elapsedMs: 100, totalBytes: 1000, segmentBytes: 1000, bitrate: 2_000_000 }, budget);
  assert.equal(clean.action, 'continue');
  assert.deepEqual(clean.exceeded, []);
  assert.equal(clean.code, null);
});

test('budgetReport / summarizeBudgetEvaluation 输出稳定字段', () => {
  const report = budgetReport({ maxDurationMs: 5000, extra: 'ignored' });
  assert.equal(report.version, 1);
  assert.equal(report.maxDurationMs, 5000);
  assert.equal(report.extra, undefined);
  const summary = summarizeBudgetEvaluation(evaluateBudget({ activeCount: 1, elapsedMs: 5000, bitrate: 1_000_000 }, normalizeBudget({ maxDurationMs: 5000 }).budget));
  assert.equal(summary.action, 'stop');
  assert.equal(summary.stop_reason, 'duration');
  assert.equal(summarizeBudgetEvaluation(null), null);
});
