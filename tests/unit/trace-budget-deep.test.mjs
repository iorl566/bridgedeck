// tests/unit/trace-budget-deep.test.mjs —— W9-C：trace 采样（结构安全）/ span 导出选择 /
// 导出体积降级（compact/minimal）/ 以及 trace summary、trace v3、viewer 的加法字段接线。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPACT_LEVELS,
  DEFAULT_MAX_EVENTS,
  DEFAULT_MAX_SPANS,
  SAMPLING_STRATEGIES,
  TRACE_BUDGET_VERSION,
  buildTraceEventUnits,
  classifyTraceEvent,
  compactTrace,
  estimateJsonBytes,
  planSpanExport,
  planTraceExport,
  sampleTraceEvents,
  selectSpansForExport,
  summarizeTraceBudget,
  summarizeTraceSampling,
} from '../../lib/trace-budget.mjs';
import { buildSpanTree } from '../../lib/trace-spans.mjs';
import { summarizeTrace, diffTraceSummary } from '../../lib/trace-summary.mjs';
import { buildTraceV3 } from '../../lib/trace-v3.mjs';
import { renderTraceReport } from '../../lib/trace-viewer.mjs';

const BASE_TS = 1_000_000;

function completeEvents(count) {
  const events = [{ ph: 'M', name: 'process_name', pid: 1, args: { name: 'Renderer' } }];
  for (let index = 0; index < count; index += 1) {
    events.push({
      ph: 'X',
      name: 'Task' + (index % 5),
      cat: 'toplevel',
      pid: 1,
      tid: 1,
      ts: BASE_TS + index * 100,
      dur: 10 + (index % 20) * 10,
      args: { data: { frame: index % 3 === 0 ? 'F1' : 'F2' } },
    });
  }
  return events;
}

function pairedEvents() {
  return [
    { ph: 'M', name: 'process_name', pid: 1, args: { name: 'Renderer' } },
    { ph: 'B', name: 'Outer', cat: 'toplevel', pid: 1, tid: 1, ts: BASE_TS },
    { ph: 'B', name: 'Inner', cat: 'script', pid: 1, tid: 1, ts: BASE_TS + 1000 },
    { ph: 'E', name: 'Inner', cat: 'script', pid: 1, tid: 1, ts: BASE_TS + 3000 },
    { ph: 'E', name: 'Outer', cat: 'toplevel', pid: 1, tid: 1, ts: BASE_TS + 9000 },
    { ph: 'S', name: 'Async', cat: 'blink', id: '0x1', pid: 1, tid: 1, ts: BASE_TS + 10000 },
    { ph: 'T', name: 'Async', cat: 'blink', id: '0x1', pid: 1, tid: 1, ts: BASE_TS + 12000 },
    { ph: 'F', name: 'Async', cat: 'blink', id: '0x1', pid: 1, tid: 1, ts: BASE_TS + 20000 },
  ];
}

// ---------------------------------------------------------------------------
// 事件分类与单元构建
// ---------------------------------------------------------------------------

test('classifyTraceEvent：覆盖 X/B/E/S/T/F/b/e/I/M 与非法输入', () => {
  assert.equal(classifyTraceEvent({ ph: 'X' }), 'complete');
  assert.equal(classifyTraceEvent({ ph: 'B' }), 'begin');
  assert.equal(classifyTraceEvent({ ph: 'E' }), 'end');
  assert.equal(classifyTraceEvent({ ph: 'S' }), 'async-begin');
  assert.equal(classifyTraceEvent({ ph: 'T' }), 'async-step');
  assert.equal(classifyTraceEvent({ ph: 'F' }), 'async-end');
  assert.equal(classifyTraceEvent({ ph: 'b' }), 'async-begin');
  assert.equal(classifyTraceEvent({ ph: 'e' }), 'async-end');
  assert.equal(classifyTraceEvent({ ph: 'I' }), 'instant');
  assert.equal(classifyTraceEvent({ ph: 'M' }), 'metadata');
  assert.equal(classifyTraceEvent({ phase: 'X' }), 'complete');
  assert.equal(classifyTraceEvent({ ph: '?' }), 'other');
  assert.equal(classifyTraceEvent({}), 'invalid');
  assert.equal(classifyTraceEvent(null), 'invalid');
  assert.equal(classifyTraceEvent('x'), 'invalid');
});

test('buildTraceEventUnits：B/E 与 S/F 配对成不可拆单元，未配对事件单独保留', () => {
  const events = pairedEvents().concat([
    { ph: 'B', name: 'Unclosed', cat: 'toplevel', pid: 2, tid: 2, ts: BASE_TS + 30000 },
    { ph: 'E', name: 'Stray', cat: 'toplevel', pid: 3, tid: 3, ts: BASE_TS + 31000 },
  ]);
  const built = buildTraceEventUnits(events);
  assert.equal(built.metadata.length, 1);
  assert.equal(built.units.length, 3); // Outer+Inner、Async
  const kinds = built.units.map((unit) => unit.kind);
  assert.deepEqual(kinds, ['begin-end', 'begin-end', 'async']);
  // 外层单元包含 2 个事件，内层 2 个，async 3 个（S/T/F）
  assert.deepEqual(built.units.map((unit) => unit.indices.length), [2, 2, 3]);
  // 单元不重叠（内层嵌套时事件位置仍各自独立成对）
  assert.equal(built.units[0].durUs, 9000);
  assert.equal(built.units[1].durUs, 2000);
  assert.equal(built.units[2].durUs, 10000);
  // 未闭合 / 孤立事件进 unpaired（配对证据）
  assert.equal(built.unpaired.length, 2);
  assert.equal(built.stats.unpaired, 2);
  assert.equal(built.stats.beginEnd, 2);
  assert.equal(built.stats.async, 1);
  assert.equal(built.stats.metadata, 1);
});

test('buildTraceEventUnits：I/X 事件各自成单元，空输入安全', () => {
  const built = buildTraceEventUnits([
    { ph: 'I', name: 'Instant', ts: BASE_TS },
    { ph: 'X', name: 'Dur', ts: BASE_TS, dur: 5 },
  ]);
  assert.equal(built.units.length, 2);
  assert.equal(built.units[0].kind, 'instant');
  assert.equal(built.units[1].kind, 'complete');
  assert.equal(built.units[1].durUs, 5);
  const empty = buildTraceEventUnits([]);
  assert.deepEqual(empty.units, []);
  assert.deepEqual(empty.metadata, []);
  assert.deepEqual(empty.unpaired, []);
  assert.equal(buildTraceEventUnits(null).units.length, 0);
});

// ---------------------------------------------------------------------------
// 采样
// ---------------------------------------------------------------------------

test('sampleTraceEvents：未超限时原样返回（strategy=none），maxEvents<=0 不限制', () => {
  const events = completeEvents(9);
  const sampling = sampleTraceEvents(events, { maxEvents: 100 });
  assert.equal(sampling.strategy, 'none');
  assert.equal(sampling.total, events.length);
  assert.equal(sampling.kept, events.length);
  assert.equal(sampling.dropped, 0);
  assert.equal(sampling.ratio, 1);
  assert.equal(sampling.events.length, events.length);
  assert.deepEqual(sampling.events, events);
  assert.deepEqual(sampling.notes, []);

  const unbounded = sampleTraceEvents(events, { maxEvents: 0 });
  assert.equal(unbounded.strategy, 'none');
  assert.equal(unbounded.kept, events.length);
  assert.equal(unbounded.notes.length, 1);
});

test('sampleTraceEvents：duration-priority 保留最长单元、丢弃计数可解释、确定性', () => {
  const events = completeEvents(100);
  const first = sampleTraceEvents(events, { maxEvents: 20 });
  const second = sampleTraceEvents(events, { maxEvents: 20 });
  assert.equal(first.strategy, 'duration-priority');
  assert.equal(first.total, 101);
  assert.equal(first.kept <= 20, true);
  assert.equal(first.dropped, first.total - first.kept);
  assert.equal(first.ratio < 1, true);
  assert.equal(first.honest, true);
  assert.equal(first.units.metadata, 1);
  assert.equal(first.units.byKind.complete >= 5, true);
  // 确定性：同输入同输出
  assert.deepEqual(second.events, first.events);
  // 元数据事件永远保留（进程/线程名是解释 span 的前提）
  assert.equal(first.events.some((event) => event.ph === 'M'), true);
  // 保留了对应的最长 dur（20*10=190 是最大值；采样保留 Top 区间）
  const maxDur = Math.max(...events.filter((event) => typeof event.dur === 'number').map((event) => event.dur));
  assert.equal(Math.max(...first.events.filter((event) => typeof event.dur === 'number').map((event) => event.dur)), maxDur);
  assert.equal(first.notes.length, 1);
  assert.match(first.notes[0], /duration-priority/);
});

test('sampleTraceEvents：uniform 用确定性哈希，head-tail 保留首尾，none 保留最早', () => {
  const events = completeEvents(60);
  const uniformA = sampleTraceEvents(events, { maxEvents: 15, strategy: 'uniform', seed: 'seed-a', maxTraceEvents: undefined });
  const uniformB = sampleTraceEvents(events, { maxEvents: 15, strategy: 'uniform', seed: 'seed-a' });
  assert.equal(uniformA.strategy, 'uniform');
  assert.deepEqual(uniformA.events, uniformB.events);
  assert.equal(uniformA.kept <= 15, true);
  const otherSeed = sampleTraceEvents(events, { maxEvents: 15, strategy: 'uniform', seed: 'seed-b' });
  // 不同 seed 的抽样集合通常不同；至少索引集合不完全相等
  assert.notDeepEqual(otherSeed.events.map((event) => event.ts), uniformA.events.map((event) => event.ts));

  const headTail = sampleTraceEvents(events, { maxEvents: 12, strategy: 'head-tail' });
  assert.equal(headTail.strategy, 'head-tail');
  const headTailTimed = headTail.events.filter((event) => Number.isFinite(event.ts));
  assert.equal(headTailTimed[0].ts, BASE_TS); // 最早的保留
  assert.equal(headTailTimed[headTailTimed.length - 1].ts, events[events.length - 1].ts); // 最晚的保留

  const none = sampleTraceEvents(events, { maxEvents: 12, strategy: 'none' });
  assert.equal(none.strategy, 'none');
  const noneTimed = none.events.filter((event) => Number.isFinite(event.ts));
  assert.equal(noneTimed[0].ts, BASE_TS);
  assert.equal(none.kept <= 12, true);
  // 未知策略回退默认
  assert.equal(sampleTraceEvents(events, { maxEvents: 12, strategy: 'bogus' }).strategy, 'duration-priority');
});

test('sampleTraceEvents：配对不被拆散（采样后的 B/E、S/F 仍可完整配对）', () => {
  const events = pairedEvents();
  for (const maxEvents of [4, 5, 6, 7, 8]) {
    const sampling = sampleTraceEvents(events, { maxEvents });
    const rebuilt = buildTraceEventUnits(sampling.events);
    // 采样后不应产生新的孤立事件（unpaired 只能来自输入本身的未配对）
    assert.equal(rebuilt.unpaired.length, 0, 'maxEvents=' + maxEvents + ' 采样拆散了配对');
    assert.equal(sampling.kept <= maxEvents || sampling.events.length <= events.length, true);
  }
  // 极端：预算只够放一个 2 事件单元时，不会把 B 和 E 拆开
  const tiny = sampleTraceEvents(events, { maxEvents: 3 });
  assert.equal(tiny.kept, 3);
  const tinyUnits = buildTraceEventUnits(tiny.events);
  assert.equal(tinyUnits.unpaired.length, 0);
});

test('sampleTraceEvents：元数据/孤立事件超过上限时全保留并显式标注', () => {
  const events = [];
  for (let index = 0; index < 10; index += 1) {
    events.push({ ph: 'M', name: 'thread_name', pid: 1, tid: index, args: { name: 'T' + index } });
  }
  events.push({ ph: 'B', name: 'Open', ts: BASE_TS, pid: 9, tid: 9 });
  const sampling = sampleTraceEvents(events, { maxEvents: 3 });
  assert.equal(sampling.kept > 3, true);
  assert.equal(sampling.notes.some((note) => note.includes('超过上限')), true);
  assert.equal(sampling.units.metadata, 10);
  assert.equal(sampling.units.unpaired, 1);
});

test('summarizeTraceSampling：紧凑摘要保留口径与诚实标记', () => {
  const sampling = sampleTraceEvents(completeEvents(50), { maxEvents: 10 });
  const summary = summarizeTraceSampling(sampling);
  assert.equal(summary.version, TRACE_BUDGET_VERSION);
  assert.equal(summary.strategy, 'duration-priority');
  assert.equal(summary.total, 51);
  assert.equal(summary.kept, sampling.kept);
  assert.equal(summary.dropped, sampling.total - sampling.kept);
  assert.equal(summary.honest, true);
  assert.equal(typeof summary.units, 'object');
  assert.equal(Array.isArray(summary.notes), true);
  const empty = summarizeTraceSampling(null);
  assert.equal(empty.total, 0);
  assert.equal(empty.strategy, 'none');
});

// ---------------------------------------------------------------------------
// span 导出选择
// ---------------------------------------------------------------------------

test('selectSpansForExport：小树不裁剪；超限时关键路径/root/未完成/父链闭包优先', () => {
  const tree = buildSpanTree({ traceEvents: pairedEvents() }, { maxSpans: 100 });
  const small = selectSpansForExport(tree, { maxSpans: 100 });
  assert.equal(small.strategy, 'none');
  assert.equal(small.total, tree.spans.length);
  assert.equal(small.dropped, 0);
  assert.deepEqual(small.notes, []);

  const bigTree = buildSpanTree({ traceEvents: completeEvents(100) }, { maxSpans: 200 });
  const selection = selectSpansForExport(bigTree, { maxSpans: 10 });
  assert.equal(selection.strategy, 'priority-tree');
  assert.equal(selection.total, 100);
  assert.equal(selection.keep, 10);
  assert.equal(selection.dropped, 90);
  assert.equal(selection.spans.length, 10);
  assert.equal(selection.notes.length, 1);
  // 关键路径一定在保留集合里
  const ids = new Set(selection.spans.map((span) => span.id));
  for (const id of selection.criticalPath) assert.equal(ids.has(id), true, '缺少关键路径 span ' + id);
  // 每个被保留 span 的父 span 也在集合里（除了 root）
  for (const span of selection.spans) {
    if (span.parentId == null) continue;
    assert.equal(ids.has(span.parentId), true, '父 span 被裁掉，树会断：' + span.id);
  }
  // 保留方向按时间顺序（渲染稳定）
  const order = selection.spans.map((span) => span.tsMs ?? 0);
  assert.deepEqual(order, order.slice().sort((a, b) => a - b));
  // 确定性
  const again = selectSpansForExport(bigTree, { maxSpans: 10 });
  assert.deepEqual(again.ids, selection.ids);
});

test('selectSpansForExport：未完成 span 作为截断证据优先保留', () => {
  const events = completeEvents(40);
  events.push({ ph: 'B', name: 'StillOpen', cat: 'toplevel', pid: 1, tid: 1, ts: BASE_TS + 100000 });
  const tree = buildSpanTree({ traceEvents: events }, { maxSpans: 100 });
  assert.equal(tree.stats.unfinished, 1);
  const selection = selectSpansForExport(tree, { maxSpans: 5 });
  assert.equal(selection.spans.some((span) => span.unfinished === true), true);
});

test('planSpanExport：只给计划（不返回明细），超限时含 criticalPathSpans/closureAdded', () => {
  const tree = buildSpanTree({ traceEvents: completeEvents(40) }, { maxSpans: 100 });
  const plan = planSpanExport(tree, { maxSpans: 8 });
  assert.equal(plan.version, TRACE_BUDGET_VERSION);
  assert.equal(plan.strategy, 'priority-tree');
  assert.equal(plan.total, 40);
  assert.equal(plan.keep, 8);
  assert.equal(plan.dropped, 32);
  assert.equal(plan.maxSpans, 8);
  assert.equal(typeof plan.criticalPathSpans, 'number');
  assert.equal('spans' in plan, false);
  const none = planSpanExport(tree, { maxSpans: DEFAULT_MAX_SPANS });
  assert.equal(none.strategy, 'none');
  assert.equal(none.dropped, 0);
});

// ---------------------------------------------------------------------------
// 导出预算与降级
// ---------------------------------------------------------------------------

test('planTraceExport：体积在预算内 level=full / degraded=false，只给建议', () => {
  const trace = { version: 3, steps: [{ id: 1 }], states: [{ id: 's1', body: 'x'.repeat(5000) }], screenshots: [] };
  const plan = planTraceExport(trace, { maxBytes: 1024 * 1024, maxStateChars: 100 });
  assert.equal(plan.version, TRACE_BUDGET_VERSION);
  assert.equal(plan.level, 'full');
  assert.equal(plan.degraded, false);
  assert.equal(plan.wouldDegrade, true); // 有正文超建议长度，但体积没超
  assert.equal(plan.actions.some((action) => action.kind === 'truncate-state-bodies'), true);
  assert.equal(plan.estimatedBytes > 0, true);
  assert.equal(plan.notes.some((note) => note.includes('体积在上限内')), true);
  // 完全没可裁剪项 → wouldDegrade=false
  const clean = planTraceExport({ version: 3, steps: [], states: [], screenshots: [] });
  assert.equal(clean.wouldDegrade, false);
  assert.equal(clean.actions.length, 0);
});

test('planTraceExport：超体积 degraded=true，动作覆盖 events/spans/steps/screenshots', () => {
  const trace = {
    version: 3,
    steps: Array.from({ length: 20 }, (_, index) => ({ id: index + 1 })),
    states: [],
    screenshots: ['data:image/png;base64,' + 'A'.repeat(20000)],
    traceEvents: completeEvents(3000),
    spans: buildSpanTree({ traceEvents: completeEvents(100) }).spans,
  };
  const plan = planTraceExport(trace, {
    maxBytes: 1024,
    maxEvents: 50,
    maxSpans: 10,
    maxSteps: 5,
    maxScreenshots: 0,
  });
  assert.equal(plan.degraded, true);
  assert.equal(plan.level, 'sampled');
  const kinds = new Set(plan.actions.map((action) => action.kind));
  for (const kind of ['sample-events', 'truncate-spans', 'truncate-steps', 'drop-screenshots']) {
    assert.equal(kinds.has(kind), true, '缺少降级动作 ' + kind);
  }
  assert.equal(plan.notes[0].includes('超过上限'), true);
  assert.equal(COMPACT_LEVELS.includes(plan.level), true);
  assert.equal(SAMPLING_STRATEGIES.includes('duration-priority'), true);
});

test('compactTrace：默认不改写体积内的 trace；force 时按上限裁剪且不修改入参', () => {
  const trace = {
    version: 3,
    steps: Array.from({ length: 12 }, (_, index) => ({ id: index + 1 })),
    states: [{ id: 's1', body: 'y'.repeat(500) }],
    screenshots: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'],
    traceEvents: completeEvents(20),
  };
  const snapshot = JSON.stringify(trace);
  const untouched = compactTrace(trace, { maxBytes: 10 * 1024 * 1024, maxSteps: 5 });
  assert.equal(untouched.trace, trace);
  assert.equal(untouched.plan.level, 'full');
  assert.equal(JSON.stringify(trace), snapshot);

  const forced = compactTrace(trace, {
    force: true,
    maxSteps: 5,
    maxStateChars: 100,
    maxScreenshots: 1,
    maxEvents: 10,
  });
  assert.notEqual(forced.trace, trace);
  assert.equal(forced.plan.degraded, true);
  assert.equal(['compact', 'sampled', 'minimal'].includes(forced.plan.level), true);
  assert.equal(forced.trace.steps.length, 5);
  assert.equal(forced.trace.stepsTruncated.total, 12);
  assert.equal(forced.trace.stepsTruncated.dropped, 7);
  assert.equal(forced.trace.states[0].bodyTruncated, true);
  assert.equal(forced.trace.states[0].body.length < 500, true);
  assert.equal(forced.trace.statesTruncated.states, 1);
  assert.equal(forced.trace.screenshotsTruncated.kept, 1);
  assert.equal(forced.trace.exportBudget.level, forced.plan.level);
  // 输入未被修改
  assert.equal(JSON.stringify(trace), snapshot);
  // 采样证据随 trace 保留
  assert.equal(forced.trace.sampling.total, 21);
  assert.equal(forced.trace.sampling.kept <= 10, true);
});

test('compactTrace：样本内仍超体积时降级到 minimal（保留摘要与计数）', () => {
  const trace = {
    version: 3,
    steps: Array.from({ length: 30 }, (_, index) => ({ id: index + 1, at: new Date(BASE_TS + index).toISOString() })),
    states: Array.from({ length: 30 }, (_, index) => ({ id: 's' + index, body: 'z'.repeat(8000) })),
    screenshots: ['data:image/png;base64,' + 'A'.repeat(60000)],
    spanSummary: { spans: 10, criticalPath: { totalMs: 1, spanCount: 1 } },
    spans: buildSpanTree({ traceEvents: completeEvents(50) }).spans,
  };
  const compacted = compactTrace(trace, { maxBytes: 4096 });
  assert.equal(compacted.plan.level, 'minimal');
  assert.equal(compacted.trace.spans, undefined);
  assert.equal(compacted.trace.traceEvents, undefined);
  assert.equal(compacted.trace.screenshots.length, 0);
  assert.equal(compacted.trace.steps.length <= 50, true);
  assert.equal(compacted.trace.states.length <= 50, true);
  assert.equal(typeof compacted.trace.exportBudget.estimatedBytes, 'number');
  assert.equal(compacted.trace.exportBudget.notes.some((note) => note.includes('minimal')), true);
  // spanSummary 这种摘要信息保留（降级不丢"结论"）
  assert.equal(compacted.trace.spanSummary.spans, 10);
});

test('estimateJsonBytes / summarizeTraceBudget：体积估算与预算摘要', () => {
  assert.equal(estimateJsonBytes(null), 4);
  assert.equal(estimateJsonBytes(undefined), 0);
  assert.equal(estimateJsonBytes({ a: 1 }) > 0, true);
  const summary = summarizeTraceBudget({ version: 3, steps: [], states: [] });
  assert.equal(summary.version, TRACE_BUDGET_VERSION);
  assert.equal(summary.level, 'full');
  assert.equal(summary.degraded, false);
  assert.equal(Array.isArray(summary.actions), true);
  assert.equal(summary.maxBytes > 0, true);
});

// ---------------------------------------------------------------------------
// 运行时接线：trace summary / trace v3 / viewer
// ---------------------------------------------------------------------------

test('summarizeTrace：非空 trace 追加 spanExport/sampling，旧字段保持', () => {
  const summary = summarizeTrace({ traceEvents: completeEvents(30) });
  assert.equal(summary.events, 31);
  assert.equal(typeof summary.spanSummary.criticalPath.totalMs, 'number');
  // 新字段
  assert.equal(summary.spanExport.version, TRACE_BUDGET_VERSION);
  assert.equal(summary.spanExport.strategy, 'none');
  assert.equal(summary.spanExport.total, summary.spanSummary.spans);
  assert.equal(summary.sampling.events, 31);
  assert.equal(summary.sampling.maxEvents, DEFAULT_MAX_EVENTS);
  assert.equal(summary.sampling.exceeds, false);
  assert.equal(summary.sampling.note, '');
  // 可用 options 调低导出 span 上限 → 变成有裁剪计划
  const trimmed = summarizeTrace({ traceEvents: completeEvents(30) }, { maxExportSpans: 3 });
  assert.equal(trimmed.spanExport.strategy, 'priority-tree');
  assert.equal(trimmed.spanExport.keep, 3);
  assert.equal(trimmed.spanExport.dropped > 0, true);
});

test('summarizeTrace：空 trace 保持原有 6 字段精确形状（不新增字段）', () => {
  assert.deepEqual(summarizeTrace(null), {
    events: 0, durationMs: 0, topCategories: [], topNames: [], longTasks: [], longTaskCount: 0,
  });
  assert.deepEqual(summarizeTrace({ traceEvents: [null, 'x'] }), {
    events: 0, durationMs: 0, topCategories: [], topNames: [], longTasks: [], longTaskCount: 0,
  });
});

test('diffTraceSummary：base/head 任一带 spanExport 时给出导出计划差分', () => {
  const base = summarizeTrace({ traceEvents: completeEvents(30) }, { maxExportSpans: 100 });
  const head = summarizeTrace({ traceEvents: completeEvents(30) }, { maxExportSpans: 3 });
  const diff = diffTraceSummary(base, head);
  assert.equal(typeof diff.spanExport, 'object');
  assert.equal(diff.spanExport.base.keep, base.spanExport.keep);
  assert.equal(diff.spanExport.head.keep, 3);
  assert.equal(diff.spanExport.deltaKept, 3 - base.spanExport.keep);
  assert.equal(diff.spanExport.deltaDropped, head.spanExport.dropped - base.spanExport.dropped);
  // 旧字段仍存在
  assert.equal(diff.events.delta, 0);
  assert.equal(typeof diff.criticalPath, 'object');
});

test('buildTraceV3：大 traceEvents 自动结构安全采样并保留证据，小 trace 不采样', () => {
  const recording = {
    url: 'https://a.test/',
    startedAt: 1_700_000_000_000,
    events: [{ kind: 'click', seq: 1, ts: 1_700_000_000_000, tag: 'button', observation: 'button "Go" [@e1]' }],
    traceEvents: completeEvents(200),
  };
  const sampled = buildTraceV3(recording, { maxTraceEvents: 30 });
  assert.equal(sampled.version, 3);
  assert.equal(sampled.sampling.total, 201);
  assert.equal(sampled.sampling.kept <= 30, true);
  assert.equal(sampled.sampling.dropped > 0, true);
  assert.equal(sampled.sampling.honest, true);
  assert.equal(sampled.spanExport.version, TRACE_BUDGET_VERSION);
  assert.equal(typeof sampled.spanExport.total, 'number');
  // span 树来自采样后的事件（span 数 <= 采样数），不伪装成完整
  assert.equal(sampled.spanSummary.spans <= sampled.sampling.kept, true);
  // 导出预算随附（小体积 → full）
  assert.equal(sampled.exportBudget.level, 'full');
  assert.equal(sampled.exportBudget.degraded, false);
  // 旧字段不受影响
  assert.equal(sampled.entry.start_url, 'https://a.test/');
  assert.equal(sampled.steps.length, 1);

  const small = buildTraceV3({
    url: 'https://a.test/',
    events: [],
    traceEvents: completeEvents(3),
  });
  assert.equal(small.sampling.total, 4);
  assert.equal(small.sampling.dropped, 0);
  assert.equal(small.sampling.strategy, 'none');
});

test('buildTraceV3：超 maxExportBytes 时自动降级输出（record export 的运行时路径）', () => {
  const recording = {
    url: 'https://a.test/',
    events: [],
    states: undefined,
    traceEvents: completeEvents(10),
  };
  // 用很小的字节上限强制降级；步骤/状态正文裁剪都记在 exportBudget.actions
  const trace = buildTraceV3(recording, { maxExportBytes: 1024, maxExportSteps: 2 });
  assert.equal(trace.exportBudget.degraded || trace.exportBudget.level !== 'full', true);
  assert.equal(typeof trace.exportBudget.estimatedBytes, 'number');
  assert.equal(Array.isArray(trace.exportBudget.actions), true);
});

test('renderTraceReport：stats 追加 sampling/spanExport/exportBudget，旧字段不变', () => {
  const trace = buildTraceV3({
    url: 'https://a.test/',
    events: [{ kind: 'click', seq: 1, ts: 1_700_000_000_000, tag: 'button' }],
    traceEvents: completeEvents(20),
  }, { maxTraceEvents: 10 });
  const report = renderTraceReport(trace, {});
  assert.equal(typeof report.stats.bytes, 'number');
  assert.equal(report.stats.degraded, false);
  assert.equal(typeof report.stats.sampling, 'object');
  assert.equal(report.stats.sampling.total, trace.sampling.total);
  assert.equal(typeof report.stats.spanExport, 'object');
  assert.equal(report.stats.spanExport.version, TRACE_BUDGET_VERSION);
  assert.equal(typeof report.stats.exportBudget, 'object');
  assert.equal(report.stats.exportBudget.level, trace.exportBudget.level);
  // 没有这些字段的旧 trace：stats 里为 null，不报错
  const legacy = renderTraceReport({ version: 3, steps: [], states: [] });
  assert.equal(legacy.stats.sampling, null);
  assert.equal(legacy.stats.spanExport, null);
  assert.equal(legacy.stats.exportBudget, null);
});
