// tests/unit/video-mux-budget.test.mjs
// 第十一批-E：视频封装预算（lib/video-mux-budget.js）。
// 覆盖：关键帧对齐、容器开销估算、封装规划（分片/尾部合并/预算结论/建议分片）、
//       计划自检、分片索引、wire/describe。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MUX_ACTIONS,
  MUX_BUDGET_VERSION,
  MUX_CODES,
  MUX_DEFAULTS,
  alignKeyframeInterval,
  describeMux,
  estimateMuxOverhead,
  muxBudgetWire,
  muxFragmentIndex,
  planVideoMux,
  validateMuxPlan,
} from '../../extension/src/lib/video-mux-budget.js';

test('常量：版本/动作/默认值形状稳定', () => {
  assert.equal(MUX_BUDGET_VERSION, 1);
  assert.deepEqual([...MUX_ACTIONS], ['ok', 'shrink-fragments', 'reduce-fragments', 'reject']);
  assert.ok(MUX_DEFAULTS.fragmentMs > 0);
  assert.ok(MUX_DEFAULTS.maxFragmentMs > MUX_DEFAULTS.fragmentMs);
  assert.ok(MUX_DEFAULTS.fragmentOverheadBytes > 0);
  assert.match(MUX_CODES.OK, /^video\.mux\./);
});

test('alignKeyframeInterval：对齐到分片整数倍；非整数倍被调整', () => {
  const aligned = alignKeyframeInterval(2000, 2000);
  assert.equal(aligned.keyframeMs, 2000);
  assert.equal(aligned.aligned, true);
  assert.equal(aligned.adjusted, false);
  const adjusted = alignKeyframeInterval(2000, 3000);
  assert.equal(adjusted.keyframeMs, 4000);
  assert.equal(adjusted.aligned, false);
  assert.equal(adjusted.adjusted, true);
  assert.equal(adjusted.fragmentsPerKeyframe, 2);
  const zero = alignKeyframeInterval(2000, 0);
  assert.equal(zero.keyframeMs, 2000);
  assert.equal(zero.aligned, true);
});

test('estimateMuxOverhead：分片数 × 每片开销 + 索引；空输入稳定', () => {
  const overhead = estimateMuxOverhead(5);
  assert.equal(overhead.fragmentCount, 5);
  assert.equal(overhead.bytes, 5 * MUX_DEFAULTS.fragmentOverheadBytes + MUX_DEFAULTS.indexOverheadBytes);
  assert.ok(overhead.perFragmentAverage > 0);
  const custom = estimateMuxOverhead(2, { fragmentOverheadBytes: 100, indexOverheadBytes: 50, payloadBytes: 1000, overheadRatio: 0.1 });
  assert.equal(custom.bytes, 2 * 100 + 50 + 100);
  assert.equal(estimateMuxOverhead(0).bytes, MUX_DEFAULTS.indexOverheadBytes);
  assert.equal(estimateMuxOverhead(null, {}).fragmentCount, 0);
});

test('planVideoMux：10s@2s → 5 片，时间轴连续、末片标记、keyframe 对齐', () => {
  const plan = planVideoMux({ durationMs: 10_000, fps: 30, payloadBytes: 5_000_000 });
  assert.equal(plan.action, 'ok');
  assert.equal(plan.ok, true);
  assert.equal(plan.container, 'mp4');
  assert.equal(plan.fragments.length, 5);
  assert.equal(plan.fragmentCount, 5);
  assert.equal(plan.keyframeMs, 2000);
  const validation = validateMuxPlan(plan);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.coveredMs, 10_000);
  assert.ok(plan.overhead.bytes > 0);
  assert.equal(plan.totalBytes, 5_000_000 + plan.overhead.bytes);
  assert.match(describeMux(plan), /封装计划 ok/);
});

test('planVideoMux：webm 容器 / 尾部过短被合并 / 空时长', () => {
  const webm = planVideoMux({ durationMs: 4000, container: 'webm' });
  assert.equal(webm.container, 'webm');
  const merged = planVideoMux({ durationMs: 4050, fragmentMs: 2000, durationToleranceMs: 500 });
  assert.equal(merged.durationNotes.length, 1);
  assert.equal(merged.durationNotes[0].action, 'merge-tail');
  assert.equal(merged.fragments.length, 2);
  const empty = planVideoMux({});
  assert.equal(empty.fragmentCount, 0);
  assert.equal(empty.overhead.bytes, MUX_DEFAULTS.indexOverheadBytes);
});

test('planVideoMux：分片数超预算 → reduce-fragments 并给建议分片', () => {
  const plan = planVideoMux({ durationMs: 600_000, fps: 30, fragmentMs: 1000, maxFragments: 100 });
  assert.equal(plan.action, 'reduce-fragments');
  assert.equal(plan.ok, true);
  assert.ok(plan.suggestedFragmentMs > plan.fragmentMs);
  assert.equal(plan.code, MUX_CODES.SHRINK);
  const overheadBudget = planVideoMux({ durationMs: 60_000, fragmentMs: 250, maxOverheadBytes: 100 });
  assert.equal(overheadBudget.action, 'shrink-fragments');
});

test('planVideoMux：总字节超预算 → reject', () => {
  const plan = planVideoMux({ durationMs: 10_000, payloadBytes: 10_000_000, maxTotalBytes: 1_000_000 });
  assert.equal(plan.action, 'reject');
  assert.equal(plan.ok, false);
  assert.equal(plan.code, MUX_CODES.REJECT);
});

test('validateMuxPlan：空计划/序号断/时间轴不连续/未标记末片都被点名', () => {
  assert.equal(validateMuxPlan(null).ok, false);
  const empty = validateMuxPlan({ fragments: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.errors[0].code, 'no-fragments');
  const broken = validateMuxPlan({
    durationMs: 4000,
    fragments: [
      { index: 0, startMs: 0, durationMs: 2000, endMs: 2000, isLast: false },
      { index: 2, startMs: 2100, durationMs: 1900, endMs: 4000, isLast: false },
    ],
  });
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((error) => error.code === 'bad-index'));
  assert.ok(broken.errors.some((error) => error.code === 'gap'));
  assert.ok(broken.errors.some((error) => error.code === 'missing-last'));
  const good = validateMuxPlan(planVideoMux({ durationMs: 4000 }));
  assert.equal(good.ok, true);
});

test('muxFragmentIndex：分片索引带估算字节与关键帧标记', () => {
  const plan = planVideoMux({ durationMs: 4000, payloadBytes: 4_000_000, fragmentMs: 2000 });
  const index = muxFragmentIndex(plan);
  assert.equal(index.length, 2);
  assert.equal(index[0].keyframe, true);
  assert.equal(index[1].keyframe, true);
  assert.equal(index[1].last, true);
  assert.ok(index[0].estimateBytes > 0);
  assert.equal(index.reduce((sum, item) => sum + item.estimateBytes, 0) >= 4_000_000, true);
  assert.deepEqual(muxFragmentIndex(null), []);
});

test('muxBudgetWire/describeMux：截断分片列表、文本可读', () => {
  const plan = planVideoMux({ durationMs: 10_000, payloadBytes: 5_000_000 });
  const wire = muxBudgetWire(plan, { maxListed: 2 });
  assert.equal(wire.version, MUX_BUDGET_VERSION);
  assert.equal(wire.fragmentCount, 5);
  assert.equal(wire.fragments.length, 2);
  assert.equal(wire.overheadBytes > 0, true);
  assert.match(wire.text, /封装计划/);
  assert.match(describeMux(plan), /5 片/);
  assert.equal(muxBudgetWire(null).ok, false);
  assert.match(describeMux(null), /无/);
});
