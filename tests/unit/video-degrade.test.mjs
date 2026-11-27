import test from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetLogLine,
  applyDegradation,
  degradationRecordFields,
  DEGRADE_ACTIONS,
  estimateThroughput,
  explainDegradation,
  headroomOf,
  mergeDegradationHistory,
  planBudgetDegradation,
  summarizeDegradation,
  VIDEO_DEGRADE_CODES,
} from '../../extension/src/lib/video-degrade.js';
import { normalizeBudget } from '../../extension/src/lib/video-budget.js';

function budgetOf(overrides = {}) {
  return normalizeBudget({
    maxDurationMs: 60_000,
    maxTotalBytes: 100 * 1024 * 1024,
    maxSegmentBytes: 10 * 1024 * 1024,
    maxConcurrent: 1,
    ...overrides,
  }).budget;
}

test('headroomOf：比例/剩余量/并发上限', () => {
  const budget = budgetOf();
  const headroom = headroomOf({ elapsedMs: 30_000, totalBytes: 50 * 1024 * 1024, segmentBytes: 5 * 1024 * 1024 }, budget);
  assert.equal(headroom.maxDurationMs, 60_000);
  assert.equal(headroom.durationRatio, 0.5);
  assert.equal(headroom.sizeRatio, 0.5);
  assert.equal(headroom.segmentRatio, 0.5);
  assert.equal(headroom.remainingMs, 30_000);
  assert.equal(headroom.remainingBytes, 50 * 1024 * 1024);
  assert.equal(headroom.maxConcurrent, 1);
  assert.equal(Number.isFinite(headroom.warnRatio), true);

  const empty = headroomOf({}, budget);
  assert.equal(empty.durationRatio, 0);
  assert.equal(empty.sizeRatio, 0);
  assert.equal(empty.remainingBytes, budget.maxTotalBytes);
});

test('estimateThroughput：实测样本优先，样本不足用码率，都没有返回 0', () => {
  const observed = estimateThroughput({ elapsedMs: 10_000, totalBytes: 5_000_000, bitrate: 8_000_000 });
  assert.equal(observed.basis, 'observed');
  assert.equal(observed.bytesPerMs, 500);
  const fromBitrate = estimateThroughput({ elapsedMs: 100, totalBytes: 100, bitrate: 8_000_000 });
  assert.equal(fromBitrate.basis, 'bitrate');
  assert.equal(fromBitrate.bytesPerMs, 1000);
  const unknown = estimateThroughput({});
  assert.equal(unknown.basis, 'unknown');
  assert.equal(unknown.bytesPerMs, 0);
});

test('planBudgetDegradation：预算内 → continue，无 steps，headroom 正常', () => {
  const plan = planBudgetDegradation({ activeCount: 1, elapsedMs: 1000, totalBytes: 1000, segmentBytes: 1000, bitrate: 8_000_000 }, budgetOf(), { now: 42 });
  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'continue');
  assert.equal(plan.level, 0);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.action_chain, []);
  assert.equal(plan.stop_reason, null);
  assert.equal(plan.at, 42);
  assert.equal(DEGRADE_ACTIONS.includes(plan.action), true);
  assert.equal(plan.evidence.action, 'continue');
  assert.equal(plan.evidence.usage.activeCount, 1);
  const summary = summarizeDegradation(plan);
  assert.equal(summary.action, 'continue');
  assert.equal(summary.steps, 0);
  assert.deepEqual(summary.actions, []);
  assert.ok(summary.headroom.size >= 0);
});

test('planBudgetDegradation：并发超限 → reject，最高优先级', () => {
  const plan = planBudgetDegradation({ activeCount: 2, elapsedMs: 0, totalBytes: 0 }, budgetOf());
  assert.equal(plan.ok, false);
  assert.equal(plan.action, 'reject');
  assert.equal(plan.level, 5);
  const rejectStep = plan.steps.find((item) => item.action === 'reject');
  assert.equal(rejectStep.code, VIDEO_DEGRADE_CODES.CONCURRENCY);
  assert.equal(rejectStep.detail.activeCount, 2);
  assert.equal(rejectStep.detail.maxConcurrent, 1);
  // 即使同时命中时长上限，reject 仍是最终动作
  const both = planBudgetDegradation({ activeCount: 3, elapsedMs: 60_000, totalBytes: 1000 }, budgetOf());
  assert.equal(both.action, 'reject');
});

test('planBudgetDegradation：体积/时长硬上限 → stop 与 stop_reason', () => {
  const sizeStop = planBudgetDegradation({ activeCount: 1, totalBytes: 101 * 1024 * 1024, elapsedMs: 1000 }, budgetOf());
  assert.equal(sizeStop.action, 'stop');
  assert.equal(sizeStop.stop_reason, 'size');
  assert.equal(sizeStop.ok, false);
  assert.equal(sizeStop.steps.some((item) => item.code === VIDEO_DEGRADE_CODES.SIZE_STOP), true);

  const durationStop = planBudgetDegradation({ activeCount: 1, elapsedMs: 60_000, totalBytes: 1000 }, budgetOf());
  assert.equal(durationStop.action, 'stop');
  assert.equal(durationStop.stop_reason, 'duration');
  assert.equal(durationStop.steps.some((item) => item.code === VIDEO_DEGRADE_CODES.DURATION_STOP), true);
});

test('planBudgetDegradation：按实测吞吐收紧时长（cap-duration）', () => {
  const plan = planBudgetDegradation({
    activeCount: 1,
    elapsedMs: 30_000,
    totalBytes: 30 * 1000 * 1000, // 1000 B/ms
    bitrate: 8_000_000,
    segmentBytes: 1000,
  }, budgetOf({ maxDurationMs: 120_000 }), { now: 7 });
  assert.equal(plan.action, 'cap-duration');
  assert.equal(plan.ok, true);
  const cap = plan.steps.find((item) => item.action === 'cap-duration');
  assert.equal(cap.code, VIDEO_DEGRADE_CODES.DURATION_CAP);
  assert.equal(cap.detail.basis, 'observed');
  assert.equal(cap.detail.bytesPerMs, 1000);
  // 剩余 104857600-30000000=74857600B / 1000B/ms ≈ 74857ms，比剩余 90000ms 更紧
  assert.equal(cap.detail.capMs, 74_857);
  assert.equal(cap.detail.cappedDurationMs, 104_857);
  assert.ok(plan.effective.maxDurationMs < plan.headroom.maxDurationMs);
  assert.equal(summarizeDegradation(plan).cap_ms, 74_857);

  // 预算充足时不会收紧
  const relaxed = planBudgetDegradation({ activeCount: 1, elapsedMs: 1000, totalBytes: 1000, bitrate: 8_000_000 }, budgetOf());
  assert.equal(relaxed.action, 'continue');
});

test('planBudgetDegradation：分片轮换 + 码率逐档下调（到 floor 停）', () => {
  const plan = planBudgetDegradation({
    activeCount: 1,
    elapsedMs: 10_000,
    totalBytes: 95 * 1024 * 1024,
    segmentBytes: 9.5 * 1024 * 1024,
    bitrate: 8_000_000,
  }, budgetOf({ maxTotalBytes: 100 * 1024 * 1024, maxSegmentBytes: 10 * 1024 * 1024 }), { now: 1 });
  const actions = plan.steps.map((item) => item.action);
  assert.equal(actions.includes('rotate-segment'), true);
  assert.equal(actions.filter((item) => item === 'downgrade-bitrate').length >= 1, true);
  const rotate = plan.steps.find((item) => item.action === 'rotate-segment');
  assert.equal(rotate.detail.maxSegmentBytes, 10 * 1024 * 1024);
  const bitrates = plan.steps.filter((item) => item.action === 'downgrade-bitrate' && item.code === VIDEO_DEGRADE_CODES.BITRATE_STEP);
  assert.equal(bitrates[0].detail.from, 8_000_000);
  assert.equal(bitrates[0].detail.to, 4_800_000);
  assert.equal(plan.effective.bitrate, bitrates[bitrates.length - 1].detail.to);
  assert.ok(plan.effective.bitrate >= plan.effective.bitrateFloor);
  assert.equal(['rotate-segment', 'cap-duration', 'downgrade-bitrate'].includes(plan.action), true);
  assert.equal(plan.projectedAfterBytes <= plan.projectedBytes, true);

  // 已经低于 floor 时不再降
  const floor = planBudgetDegradation({ activeCount: 1, elapsedMs: 1000, totalBytes: 99.9 * 1024 * 1024, bitrate: 500_000 }, budgetOf());
  assert.equal(floor.steps.some((item) => item.action === 'downgrade-bitrate'), false);
});

test('applyDegradation：只收紧不放松，输出变更清单', () => {
  const budget = budgetOf({ maxDurationMs: 120_000 });
  const plan = planBudgetDegradation({ activeCount: 1, elapsedMs: 30_000, totalBytes: 30 * 1000 * 1000, bitrate: 8_000_000, segmentBytes: 1000 }, budget);
  const applied = applyDegradation(budget, plan);
  assert.equal(applied.unchanged, false);
  assert.equal(applied.budget.maxDurationMs < budget.maxDurationMs, true);
  assert.equal(applied.budget.maxTotalBytes, budget.maxTotalBytes);
  assert.equal(applied.changes[0].field, 'maxDurationMs');
  assert.equal(applied.evidence.code, VIDEO_DEGRADE_CODES.APPLIED);

  const noop = applyDegradation(budget, planBudgetDegradation({ activeCount: 1, elapsedMs: 0, totalBytes: 0 }, budget));
  assert.equal(noop.unchanged, true);
  assert.equal(noop.budget.maxDurationMs, budget.maxDurationMs);

  // 重复应用不会越改越小（第二次计划相同则无变化）
  const second = applyDegradation(applied.budget, plan);
  assert.equal(second.unchanged, true);
});

test('mergeDegradationHistory：同动作+原因去重，最多 keep 条', () => {
  const budget = budgetOf();
  const plan = planBudgetDegradation({ activeCount: 1, elapsedMs: 10_000, totalBytes: 95 * 1024 * 1024, segmentBytes: 9.5 * 1024 * 1024, bitrate: 8_000_000 }, budget);
  const first = mergeDegradationHistory([], plan);
  assert.ok(first.history.length >= 2);
  assert.equal(first.added, first.history.length);
  const second = mergeDegradationHistory(first.history, plan, { keep: 2 });
  assert.equal(second.total <= 2, true);
  assert.ok(second.deduped >= 1);

  const cleaned = mergeDegradationHistory([{ action: 'stop', code: 'X', reason: 'size_limit' }], plan, { keep: 8 });
  assert.equal(cleaned.history.some((item) => item.action === 'stop'), true);
  // 重复动作保留最新一条
  const updated = mergeDegradationHistory([{ action: 'rotate-segment', code: VIDEO_DEGRADE_CODES.SEGMENT_ROTATE, reason: 'old' }], plan);
  const rotate = updated.history.find((item) => item.action === 'rotate-segment');
  assert.equal(rotate.reason, 'segment_limit');
});

test('degradationRecordFields：只在发生降级时补字段', () => {
  const budget = budgetOf();
  const continuePlan = planBudgetDegradation({ activeCount: 1, elapsedMs: 0, totalBytes: 0 }, budget);
  assert.deepEqual(degradationRecordFields(continuePlan), {});
  assert.deepEqual(degradationRecordFields(null), {});

  const plan = planBudgetDegradation({ activeCount: 1, totalBytes: 101 * 1024 * 1024, elapsedMs: 1000 }, budget);
  const fields = degradationRecordFields(plan);
  assert.equal(fields.budget_degradation.action, 'stop');
  assert.equal(fields.budget_degradation.stop_reason, 'size');
  assert.equal(fields.budget_degradation.headroom.sizeRatio > 1, true);
  assert.equal(fields.budget_plan.action, 'stop');
  assert.equal(Array.isArray(fields.budget_degradation.chains), true);
});

test('summarizeDegradation / explainDegradation / budgetLogLine：人读输出稳定', () => {
  const budget = budgetOf();
  const plan = planBudgetDegradation({ activeCount: 1, elapsedMs: 30_000, totalBytes: 30 * 1000 * 1000, bitrate: 8_000_000 }, budgetOf({ maxDurationMs: 120_000 }));
  const lines = explainDegradation(plan);
  assert.ok(lines.length >= 2);
  assert.match(lines[0], /预算/);
  assert.ok(lines.some((line) => line.includes('收紧时长')));
  assert.deepEqual(explainDegradation(null), []);

  const continuePlan = planBudgetDegradation({ activeCount: 1, elapsedMs: 0, totalBytes: 0 }, budget);
  assert.equal(explainDegradation(continuePlan).some((line) => line.includes('continue')), true);
  assert.match(budgetLogLine(budget), /^budget\[dur=/);

  const rejectPlan = planBudgetDegradation({ activeCount: 2 }, budget);
  const rejectLines = explainDegradation(rejectPlan);
  assert.ok(rejectLines.some((line) => line.includes('拒绝启动')));
  assert.equal(summarizeDegradation(null), null);
});
