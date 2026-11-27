// 六阶段捕获漏斗：阶段名/链式计数/丢弃原因/耗时报告，以及页面侧计数到统一阶段的映射。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOM_CAPTURE_STAGES,
  VOM_CAPTURE_VERSION,
  buildCaptureReport,
  captureStagesFromPageStages,
  chainCaptureReports,
  createCaptureTrace,
  pageStagesCaptureReport,
  summarizeCaptureReport,
} from '../../extension/src/lib/vom-capture.js';
import { buildVomPayload } from '../../extension/src/lib/vom-payload.js';

test('阶段名固定为 collect→resolve→filter→enrich→rank→emit', () => {
  assert.deepEqual(VOM_CAPTURE_STAGES, ['collect', 'resolve', 'filter', 'enrich', 'rank', 'emit']);
  assert.equal(VOM_CAPTURE_VERSION, 1);
  const report = buildCaptureReport([]);
  assert.deepEqual(report.stageNames, [...VOM_CAPTURE_STAGES]);
  assert.deepEqual(report.stages.map((stage) => stage.name), [...VOM_CAPTURE_STAGES]);
  assert.equal(report.complete, true);
  assert.equal(report.totals.collected, 0);
  assert.equal(report.totals.emitted, 0);
});

test('buildCaptureReport 链接 input/output，合计与原因可解释', () => {
  const report = buildCaptureReport([
    { name: 'collect', input: 120, output: 120, ms: 5 },
    { name: 'resolve', input: 120, output: 100, dropped: 20, dropReasons: { hidden: 15, 'skipped-tag': 5 }, ms: 2 },
    { name: 'filter', input: 100, output: 70, dropped: 30, dropReasons: [{ reason: 'empty', count: 20 }, { reason: 'deduped', count: 10 }] },
    { name: 'enrich', input: 70, output: 70 },
    { name: 'rank', input: 70, output: 60, dropped: 10, dropReasons: { 'group-compact': 10 } },
    { name: 'emit', input: 60, output: 40, dropped: 20, dropReasons: { 'token-limit': 20 }, ms: 3 },
  ]);
  assert.equal(report.stages.length, 6);
  assert.equal(report.stages[1].output, report.stages[2].input);
  // 理由按固定优先级排序（skipped-tag 先于 hidden），计数保持原样。
  assert.equal(report.stages[1].dropReasons.find((item) => item.reason === 'hidden').count, 15);
  assert.equal(report.stages[1].dropReasons.find((item) => item.reason === 'skipped-tag').count, 5);
  assert.equal(report.stages[2].dropReasons.find((item) => item.reason === 'empty').count, 20);
  assert.equal(report.totals.collected, 120);
  assert.equal(report.totals.emitted, 40);
  assert.equal(report.totals.dropped, 80);
  assert.equal(report.totals.accounted, 80);
  assert.equal(report.totals.keptRate, 0.333);
  assert.equal(report.consistent, true);
  assert.equal(report.complete, true);
  // 未给出的 ms 一律 0，总耗时是各阶段之和。
  assert.equal(report.stages[2].ms, 0);
  assert.equal(report.totals.ms, 10);
});

test('缺失阶段补零，input 沿用上一阶段 output', () => {
  const report = buildCaptureReport([
    { name: 'collect', input: 30, output: 30 },
    { name: 'emit', output: 10 },
  ]);
  assert.equal(report.stages[1].name, 'resolve');
  assert.equal(report.stages[1].input, 30);
  assert.equal(report.stages[1].output, 30);
  // emit 显式 output=10 但 input 缺省沿用 rank.output=30。
  assert.equal(report.stages[5].name, 'emit');
  assert.equal(report.stages[5].input, 30);
  assert.equal(report.stages[5].output, 10);
  assert.equal(report.totals.emitted, 10);
  assert.equal(report.complete, true);
});

test('页面侧计数映射到统一六阶段：hidden/skipped/stealth/empty/deduped/budget', () => {
  const stages = captureStagesFromPageStages({
    collected: 100,
    skippedTag: 10,
    hidden: 20,
    stealth: 5,
    empty: 5,
    deduped: 10,
    emitted: 50,
    tokens: 900,
    truncated: true,
    ms: { walk: 12.34, visibility: 4.2, stealth: 1.1 },
    elapsedMs: 20,
  });
  assert.deepEqual(stages.map((stage) => stage.name), [...VOM_CAPTURE_STAGES]);
  assert.equal(stages[0].input, 100);
  assert.equal(stages[1].output, 65);
  assert.equal(stages[1].dropped, 35);
  assert.deepEqual(stages[1].dropReasons, [
    { reason: 'skipped-tag', count: 10 },
    { reason: 'hidden', count: 20 },
    { reason: 'stealth', count: 5 },
  ]);
  assert.equal(stages[2].input, 65);
  assert.equal(stages[2].output, 50);
  assert.equal(stages[2].dropped, 15);
  assert.equal(stages[5].output, 50);
  assert.equal(stages[5].meta.tokens, 900);
  assert.equal(stages[5].meta.truncated, true);
  // 页面 walk 时间进 collect，可见性/stealth 抽查时间进 resolve，elapsed 余量进 emit。
  assert.equal(stages[0].ms, 12.3);
  assert.equal(stages[1].ms, 5.3);
  assert.equal(stages[5].ms, 7.7);
  const report = buildCaptureReport(stages);
  assert.equal(report.totals.collected, 100);
  assert.equal(report.totals.emitted, 50);
  assert.equal(report.totals.dropped, 50);
  assert.equal(report.consistent, true);
});

test('页面侧未截断但 emit 少于 filter：归因 budget', () => {
  const stages = captureStagesFromPageStages({ collected: 10, emitted: 3, visited: 10 });
  const report = buildCaptureReport(stages);
  assert.equal(report.stages[5].output, 3);
  assert.equal(report.stages[5].dropped, 7);
  assert.equal(report.stages[5].dropReasons[0].reason, 'budget');
  assert.equal(pageStagesCaptureReport({ collected: 10, emitted: 3 }).totals.emitted, 3);
});

test('createCaptureTrace：真实计时（可注入时钟）+ 逐阶段计数 + 拒绝未知阶段', () => {
  let clock = 1000;
  const trace = createCaptureTrace({ now: () => clock, meta: { tabId: 7 } });
  trace.start('collect');
  clock += 12;
  trace.end('collect', { input: 40, output: 28, dropReasons: [{ reason: 'hidden', count: 12 }] });
  trace.start('resolve');
  clock += 3;
  trace.end('resolve', { input: 28, output: 28 });
  trace.record('filter', { input: 28, output: 20, dropped: 8, dropReasons: { 'min-score': 8 } });
  trace.record('enrich', { input: 20, output: 20 });
  trace.record('rank', { input: 20, output: 16, dropped: 4, dropReasons: [{ reason: 'group-compact', count: 4 }] });
  trace.drop('emit', 'token-limit', 2);
  trace.record('emit', { input: 16, output: 14, dropped: 2 });
  const report = trace.report();
  assert.deepEqual(report.stages.map((stage) => stage.name), [...VOM_CAPTURE_STAGES]);
  assert.equal(report.stages[0].ms, 12);
  assert.equal(report.stages[1].ms, 3);
  assert.equal(report.stages[0].output, 28);
  assert.equal(report.stages[5].dropReasons[0].reason, 'token-limit');
  assert.equal(report.meta.tabId, 7);
  assert.equal(report.totals.collected, 40);
  assert.equal(report.totals.emitted, 14);
  assert.equal(report.totals.dropped, 26);
  assert.equal(report.consistent, true);
  assert.throws(() => trace.start('nope'), /未知捕获阶段/);
});

test('summarizeCaptureReport / chainCaptureReports 产出可读诊断', () => {
  const page = buildCaptureReport([
    { name: 'collect', input: 10, output: 10 },
    { name: 'resolve', input: 10, output: 8, dropped: 2, dropReasons: { hidden: 2 } },
    { name: 'emit', output: 8 },
  ]);
  const text = summarizeCaptureReport(page);
  assert.match(text, /collect 10→10/);
  assert.match(text, /resolve 10→8 \(hidden:2\)/);
  const extension = buildCaptureReport([{ name: 'collect', input: 8, output: 8 }, { name: 'emit', output: 6, dropped: 2, dropReasons: { 'node-limit': 2 } }]);
  const chained = chainCaptureReports(page, extension);
  assert.deepEqual(chained.segments, ['page', 'extension']);
  assert.equal(chained.page.collected, 10);
  assert.equal(chained.page.emitted, 8);
  assert.equal(chained.extension.emitted, 6);
  assert.equal(chained.totals.emitted, 6);
  assert.equal(chainCaptureReports(null, extension), extension);
  assert.equal(chainCaptureReports(page, null), page);
});

test('VOM payload 携带 capture 报告（observe 的 emit 阶段单点读取）', () => {
  const capture = buildCaptureReport([
    { name: 'collect', input: 5, output: 5, ms: 1 },
    { name: 'resolve', input: 5, output: 4, dropped: 1, dropReasons: { hidden: 1 }, ms: 1 },
    { name: 'filter', input: 4, output: 3, dropped: 1, dropReasons: { 'min-score': 1 } },
    { name: 'enrich', input: 3, output: 3 },
    { name: 'rank', input: 3, output: 3 },
    { name: 'emit', input: 3, output: 2, dropped: 1, dropReasons: { 'token-limit': 1 }, ms: 2 },
  ]);
  const payload = buildVomPayload({ nodes: [{ ref: '@e1', role: 'button', name: 'ok' }], capture });
  assert.equal(payload.capture.version, 1);
  assert.equal(payload.capture.stages.length, 6);
  assert.deepEqual(payload.capture.stages.map((stage) => stage.name), [...VOM_CAPTURE_STAGES]);
  assert.equal(payload.capture.stages[5].dropReasons[0].reason, 'token-limit');
  // 不传 capture 时 payload 不带该字段，既有形状不变。
  const plain = buildVomPayload({ nodes: [{ ref: '@e1', role: 'button', name: 'ok' }] });
  assert.equal('capture' in plain, false);
});
