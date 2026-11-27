// tests/unit/trace-spans.test.mjs —— span 树 / 因果链 / 关键路径 / 跨 frame / 查询分页。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpanTree,
  causalChain,
  criticalPath,
  frameOfEvent,
  querySpans,
  summarizeSpans,
} from '../../lib/trace-spans.mjs';

function nestedTrace() {
  return {
    traceEvents: [
      { ph: 'M', name: 'process_name', pid: 1, args: { name: 'Renderer' } },
      { ph: 'M', name: 'thread_name', pid: 1, tid: 10, args: { name: 'CrRendererMain' } },
      { ph: 'B', name: 'Task', cat: 'toplevel', pid: 1, tid: 10, ts: 1000000, args: { data: { frame: 'F1', url: 'https://a.test/' } } },
      { ph: 'B', name: 'Script', cat: 'devtools.timeline', pid: 1, tid: 10, ts: 1010000, args: { data: { frame: 'F1' } } },
      { ph: 'X', name: 'FunctionCall', cat: 'devtools.timeline', pid: 1, tid: 10, ts: 1020000, dur: 5000, args: { data: { frame: 'F1' } } },
      { ph: 'E', name: 'Script', cat: 'devtools.timeline', pid: 1, tid: 10, ts: 1050000 },
      { ph: 'E', name: 'Task', cat: 'toplevel', pid: 1, tid: 10, ts: 1100000 },
      { ph: 'X', name: 'Paint', cat: 'devtools.timeline', pid: 1, tid: 11, ts: 1200000, dur: 2000, args: { data: { frame: 'F2', url: 'https://b.test/' } } },
    ],
  };
}

test('buildSpanTree：B/E 栈配对出嵌套树、depth/selfMs、进程线程名', () => {
  const tree = buildSpanTree(nestedTrace());
  assert.equal(tree.spans.length, 4);
  const byName = new Map(tree.spans.map((span) => [span.name, span]));
  const task = byName.get('Task');
  const script = byName.get('Script');
  const fn = byName.get('FunctionCall');
  assert.equal(task.parentId, null);
  assert.equal(script.parentId, task.id);
  assert.equal(fn.parentId, script.id);
  assert.equal(script.depth, 1);
  assert.equal(fn.depth, 2);
  assert.equal(task.durMs, 100);
  assert.equal(script.durMs, 40);
  assert.equal(fn.durMs, 5);
  assert.equal(fn.selfMs, 5);
  assert.equal(script.selfMs, 35);
  assert.equal(task.selfMs, 60);
  assert.deepEqual(task.thread, 'CrRendererMain');
  assert.deepEqual(task.process, 'Renderer');
  assert.equal(tree.stats.spans, 4);
  assert.equal(tree.roots.length, 2); // Task 与 Paint（不同线程）
  assert.equal(tree.durationMs, 202);
});

test('criticalPath：按 self time 找最长嵌套链且不重复计父子 duration', () => {
  const tree = buildSpanTree(nestedTrace());
  const path = criticalPath(tree);
  assert.equal(path.metric, 'self');
  assert.deepEqual(path.spans.map((span) => span.name), ['Task', 'Script', 'FunctionCall']);
  assert.equal(path.totalMs, 100);
  assert.equal(path.spanCount, 3);
  assert.deepEqual(path.framePath, ['F1']);
  // duration 口径：最长单 span（Paint 2ms vs Task 100ms 含子）
  const byDuration = criticalPath(tree, { metric: 'duration' });
  assert.deepEqual(byDuration.spans.map((span) => span.name), ['Task', 'Script', 'FunctionCall']);
  assert.equal(byDuration.totalMs, 100);
});

test('causalChain：向上祖先、向下后代、frame 链', () => {
  const tree = buildSpanTree(nestedTrace());
  const byName = new Map(tree.spans.map((span) => [span.name, span]));
  const script = byName.get('Script');
  const chain = causalChain(tree, script.id);
  assert.deepEqual(chain.ancestors, [byName.get('Task').id]);
  assert.deepEqual(chain.descendants, [byName.get('FunctionCall').id]);
  assert.deepEqual(chain.path, [byName.get('Task').id, script.id]);
  assert.equal(chain.depth, 1);
  assert.deepEqual(chain.frameIds, ['F1']);
  assert.equal(causalChain(tree, 'missing'), null);
});

test('异步 S/F 配对成 span，未闭合事件保留 unfinished 不伪造成完成', () => {
  const tree = buildSpanTree({
    traceEvents: [
      { ph: 'S', name: 'AsyncWork', cat: 'blink', id: '0x1', pid: 3, tid: 4, ts: 2000000 },
      { ph: 'F', name: 'AsyncWork', cat: 'blink', id: '0x1', pid: 3, tid: 4, ts: 2050000 },
      { ph: 'B', name: 'OpenTask', cat: 'toplevel', pid: 3, tid: 4, ts: 2100000 },
    ],
  });
  const asyncSpan = tree.spans.find((span) => span.name === 'AsyncWork');
  const open = tree.spans.find((span) => span.name === 'OpenTask');
  assert.equal(asyncSpan.durMs, 50);
  assert.equal(asyncSpan.asyncGroup, 'blink:0x1:');
  assert.equal(open.dur, null);
  assert.equal(open.durMs, null);
  assert.equal(tree.stats.unfinished, 1);
  assert.equal(tree.stats.asyncGroups, 1);
});

test('frameOfEvent：兼容 args.data.frame / args.frame / URL 形态', () => {
  assert.deepEqual(frameOfEvent({ args: { data: { frame: 'A', url: 'https://a/' } } }), { frameId: 'A', url: 'https://a/' });
  assert.deepEqual(frameOfEvent({ args: { frame: 'B' } }), { frameId: 'B', url: '' });
  assert.equal(frameOfEvent({ args: {} }), null);
});

test('querySpans：过滤 + 排序 + 分页游标', () => {
  const tree = buildSpanTree(nestedTrace());
  const page = querySpans(tree, { minDurationMs: 1, order: 'duration', limit: 2 });
  assert.equal(page.total, 4);
  assert.equal(page.spans.length, 2);
  assert.equal(page.spans[0].name, 'Task');
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 2);
  const next = querySpans(tree, { minDurationMs: 1, order: 'duration', limit: 2, offset: page.nextOffset });
  assert.equal(next.spans[0].name, 'FunctionCall');
  assert.equal(next.hasMore, false);
  assert.equal(next.nextOffset, null);
  assert.equal(querySpans(tree, { frameId: 'F2' }).total, 1);
  assert.equal(querySpans(tree, { nameIncludes: 'func' }).spans[0].name, 'FunctionCall');
  assert.equal(querySpans(tree, { category: 'devtools.timeline' }).total, 3);
  assert.equal(querySpans(tree, { phase: 'B' }).total, 2);
  assert.equal(querySpans(tree, { order: 'start', limit: 1 }).spans[0].name, 'Task');
});

test('summarizeSpans：分类分布、Top、关键路径、跨 frame 汇总', () => {
  const summary = summarizeSpans(buildSpanTree(nestedTrace()), { top: 5 });
  assert.equal(summary.spans, 4);
  assert.equal(summary.roots, 2);
  assert.equal(summary.durationMs, 202);
  assert.equal(summary.byName.find((item) => item.key === 'Task').count, 1);
  assert.equal(summary.byFrame.find((item) => item.key === 'F1').count, 3);
  assert.equal(summary.byFrame.find((item) => item.key === 'F2').count, 1);
  assert.equal(summary.criticalPath.totalMs, 100);
  assert.deepEqual(summary.criticalPath.path.map((item) => item.name), ['Task', 'Script', 'FunctionCall']);
  assert.equal(summary.topSpans[0].name, 'Task');
  assert.equal(summary.processCount, 1);
  assert.equal(summary.threadCount, 1);
});

test('summarizeTrace 附带 spanSummary（空 trace 形状不变）', async () => {
  const { summarizeTrace, diffTraceSummary } = await import('../../lib/trace-summary.mjs');
  const summary = summarizeTrace(nestedTrace());
  assert.equal(summary.spanSummary.spans, 4);
  assert.equal(summary.spanSummary.criticalPath.totalMs, 100);
  assert.equal(summary.spanSummary.frames[0].key, 'F1');
  // 旧字段仍在
  assert.equal(summary.events, 8);
  assert.equal(summary.longTaskCount, 0);
  const diff = diffTraceSummary(summary, summarizeTrace(nestedTrace()));
  assert.equal(diff.criticalPath.delta, 0);
  assert.equal(diff.spanCount.base, 4);
});
