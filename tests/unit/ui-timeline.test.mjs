// tests/unit/ui-timeline.test.mjs —— extension/ui/lib/timeline.js 纯时间线模型单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assignLanes,
  buildSpans,
  buildTicks,
  buildTimelineModel,
  computeDomain,
  layoutSpans,
  nearestSpanIndex,
  niceStep,
  padDomain,
  panDomain,
  sequenceLayout,
  spanAriaParts,
  timelineSummary,
  toSpan,
  zoomDomain,
} from '../../extension/ui/lib/timeline.js';

function spans() {
  return buildSpans([
    { id: 'a', url: '/api/a', ts: 1000, durationMs: 50 },
    { id: 'b', url: '/api/b', ts: 1020, durationMs: 80 },
    { id: 'c', url: '/api/c', ts: 1100, durationMs: 30 },
  ]);
}

test('toSpan / buildSpans：从记录推导 start/end/label', () => {
  const span = toSpan({ url: '/x', ts: 100, durationMs: 25 });
  assert.equal(span.start, 100);
  assert.equal(span.end, 125);
  assert.equal(span.duration, 25);
  assert.equal(span.label, '/x');
  assert.equal(toSpan({ durationMs: 5 }), null, '缺时间戳返回 null');
  assert.equal(toSpan(null), null);

  const fromStart = toSpan({ start: 10, end: 30 }, { id: 'x', label: 'L' });
  assert.equal(fromStart.end, 30);
  assert.equal(fromStart.duration, 20);
  assert.equal(fromStart.id, 'x');
  assert.equal(fromStart.label, 'L');

  const negative = toSpan({ start: 10, end: 5 });
  assert.equal(negative.end, 10, 'end 不允许早于 start');

  const built = spans();
  assert.equal(built.length, 3);
  assert.deepEqual(built.map((item) => item.id), ['a', 'b', 'c']);
  assert.equal(buildSpans([{ ts: 'bad' }, null]).length, 0);
  const custom = buildSpans([{ at: 1, name: 'n' }], { idOf: () => 'k', labelOf: () => 'custom' });
  assert.equal(custom[0].id, 'k');
  assert.equal(custom[0].label, 'custom');
});

test('computeDomain / padDomain', () => {
  assert.deepEqual(computeDomain(spans()), { min: 1000, max: 1130, span: 130 });
  assert.deepEqual(computeDomain([]), { min: 0, max: 0, span: 0 });
  assert.deepEqual(padDomain({ min: 100, max: 260 }, 0.1), { min: 84, max: 276, span: 192 });
  assert.deepEqual(padDomain({ min: 5, max: 5 }), { min: 4, max: 6, span: 2 }, '零宽域扩展到 2ms');
});

test('assignLanes：重叠分轨道、不重叠复用', () => {
  const list = [
    { start: 0, end: 10 },
    { start: 5, end: 15 },
    { start: 12, end: 20 },
    { start: 30, end: 40 },
  ];
  const result = assignLanes(list);
  assert.equal(result.lanes, 2);
  assert.deepEqual(result.spans.map((span) => span.lane), [0, 1, 0, 0]);
  // 不修改入参
  assert.equal(list[0].lane, undefined);
  assert.deepEqual(assignLanes([]), { spans: [], lanes: 0 });
});

test('niceStep / buildTicks', () => {
  assert.equal(niceStep(7), 10);
  assert.equal(niceStep(1), 1);
  assert.equal(niceStep(120), 200);
  assert.equal(niceStep(0.3), 0.5);
  assert.ok(niceStep(0) > 0);

  const ticks = buildTicks({ min: 0, max: 1000 }, { count: 5 });
  assert.deepEqual(ticks.map((tick) => tick.value), [0, 200, 400, 600, 800, 1000]);
  assert.equal(ticks[1].label, '200ms');
  assert.equal(ticks[0].offset, 0);
  assert.equal(ticks[5].offset, 1000);
  assert.deepEqual(buildTicks({ min: 0, max: 0 }), []);
  const custom = buildTicks({ min: 0, max: 1000 }, { count: 2, format: (value) => 'T' + value });
  assert.equal(custom[0].label, 'T0');
});

test('layoutSpans：像素定位与最小宽度', () => {
  const list = [
    { id: 'a', start: 0, end: 50, lane: 0 },
    { id: 'b', start: 50, end: 100, lane: 1 },
  ];
  const layout = layoutSpans(list, { domain: { min: 0, max: 100 }, width: 100, laneHeight: 10, gap: 2, minWidth: 1 });
  assert.equal(layout.placements[0].x, 0);
  assert.equal(layout.placements[0].width, 50);
  assert.equal(layout.placements[1].x, 50);
  assert.equal(layout.placements[1].y, 12);
  assert.equal(layout.placements[1].height, 10);
  assert.equal(layout.lanes, 2);
  assert.equal(layout.totalHeight, 24);
  assert.equal(Math.round(layout.scale), 1);

  const tiny = layoutSpans([{ id: 'x', start: 10, end: 11, lane: 0 }], { domain: { min: 0, max: 10000 }, width: 100, minWidth: 3 });
  assert.equal(tiny.placements[0].width, 3, '极窄区间用 minWidth 保证可见');
  assert.deepEqual(layoutSpans([], {}).placements, []);
});

test('zoomDomain / panDomain', () => {
  assert.deepEqual(zoomDomain({ min: 0, max: 100 }, 0.5), { min: 25, max: 75, span: 50 });
  const clamped = zoomDomain({ min: 0, max: 100 }, 0.5, { dataDomain: { min: 0, max: 100 } });
  assert.equal(clamped.min, 25);
  assert.equal(clamped.max, 75);
  const zoomedOut = zoomDomain({ min: 0, max: 100 }, 2, { dataDomain: { min: 0, max: 100 } });
  assert.ok(zoomedOut.span >= 100);

  assert.deepEqual(panDomain({ min: 0, max: 100 }, 0.5), { min: 50, max: 150, span: 100 });
  assert.deepEqual(panDomain({ min: 0, max: 100 }, -0.5), { min: -50, max: 50, span: 100 });
  const bounded = panDomain({ min: 0, max: 100 }, 5, { dataDomain: { min: 0, max: 100 } });
  assert.equal(bounded.max, 200, '平移不超过数据域 ± 一个域宽');
});

test('sequenceLayout：等宽步骤', () => {
  const layout = sequenceLayout(3, { width: 100, gap: 5 });
  assert.equal(layout.length, 3);
  assert.equal(layout[0].x, 0);
  assert.equal(Math.round(layout[1].x), 35);
  assert.equal(Math.round(layout[2].x), 70);
  assert.equal(layout[0].width, 30);
  assert.deepEqual(sequenceLayout(0), []);
  assert.equal(sequenceLayout(2, { width: 100, gap: 0, start: 10 })[0].index, 10);
});

test('buildTimelineModel：完整视图模型', () => {
  const model = buildTimelineModel({ spans: spans(), width: 300 });
  assert.equal(model.empty, false);
  assert.equal(model.view, 'waterfall');
  assert.equal(model.lanes, 2);
  assert.equal(model.spans.length, 3);
  assert.ok(model.ticks.length > 0);
  assert.equal(model.summary.count, 3);
  assert.equal(model.summary.totalDuration, 160);
  assert.ok(model.domain.min < 1000, '域两端留白');
  assert.equal(Math.round(model.width), 300);

  const empty = buildTimelineModel({ spans: [] });
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.spans, []);

  const zoomed = buildTimelineModel({ spans: spans(), width: 300, zoom: 2 });
  assert.ok(zoomed.domain.span < model.domain.span, 'zoom=2 应看到更窄区间');

  const sequence = buildTimelineModel({ spans: spans(), width: 300, view: 'sequence' });
  assert.equal(sequence.view, 'sequence');
  assert.equal(sequence.sequence.length, 3);
});

test('nearestSpanIndex / spanAriaParts / timelineSummary', () => {
  const list = [{ start: 100, end: 200 }, { start: 300, end: 400 }];
  assert.equal(nearestSpanIndex(list, 150), 0);
  assert.equal(nearestSpanIndex(list, 350), 1);
  assert.equal(nearestSpanIndex(list, 250), 0, '等距时取先出现的一段');
  assert.equal(nearestSpanIndex([], 10), -1);

  const parts = spanAriaParts({ label: 'x', start: 0, duration: 5 });
  assert.equal(parts.label, 'x');
  assert.equal(parts.duration, '5ms');
  assert.deepEqual(spanAriaParts(null), { label: '', start: '?', duration: '?' });

  const summary = timelineSummary(spans());
  assert.equal(summary.count, 3);
  assert.equal(summary.totalDuration, 160);
  assert.ok(summary.span > 0);
  assert.equal(summary.lanes, 2);
  assert.equal(timelineSummary([]).count, 0);
});
