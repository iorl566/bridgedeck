// tests/unit/trace-depth.test.mjs —— trace v3 深度：跨 frame 注册表 / 因果链 / span 关键路径 + viewer 渲染。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceV3 } from '../../lib/trace-v3.mjs';
import { renderTraceHtml } from '../../lib/trace-viewer.mjs';

const T0 = 1_700_000_000_000;

function recording(extra = {}) {
  return {
    url: 'https://app.test/',
    title: 'App',
    startedAt: T0,
    endedAt: T0 + 5000,
    frames: [
      { frameId: 1, url: 'https://app.test/' },
      { frameId: 2, parentFrameId: 1, url: 'https://app.test/frame' },
    ],
    events: [
      {
        kind: 'click', seq: 1, ts: T0 + 1000, selector: '#go', tag: 'button', text: 'Go',
        frameId: 2, observation: 'button "Go" [@e1]',
      },
      {
        kind: 'input', seq: 2, ts: T0 + 2000, selector: '#q', tag: 'input', value: 'hello',
        frameId: 2, causedBy: 1, observation: 'textbox "q" [@e2]',
      },
    ],
    traceEvents: [
      { ph: 'M', name: 'process_name', pid: 1, args: { name: 'Renderer' } },
      { ph: 'X', name: 'Task', cat: 'toplevel', pid: 1, tid: 1, ts: 1_000_000, dur: 30_000, args: { data: { frame: '2' } } },
      { ph: 'X', name: 'Paint', cat: 'devtools.timeline', pid: 1, tid: 1, ts: 1_010_000, dur: 2_000, args: { data: { frame: '2' } } },
    ],
    ...extra,
  };
}

test('buildTraceV3：跨 frame 注册表 + step.frame 归属 + depth 推导', () => {
  const trace = buildTraceV3(recording());
  assert.equal(trace.version, 3);
  assert.equal(trace.frames.length, 2);
  const frame2 = trace.frames.find((frame) => frame.frameId === 2);
  assert.equal(frame2.parentFrameId, 1);
  assert.equal(frame2.depth, 1);
  assert.equal(frame2.url, 'https://app.test/frame');
  assert.equal(frame2.stepCount, 2);
  assert.equal(frame2.stateCount, 2);
  assert.equal(trace.steps[0].frame.frameId, 2);
  assert.equal(trace.steps[0].frame.path, undefined);
  assert.equal(trace.steps[0].frame.url, 'https://app.test/frame');
  assert.equal(trace.entry.frames.length, 2);
});

test('buildTraceV3：显式 causedBy 生成因果链，无因果时标 inferred 线性链', () => {
  const trace = buildTraceV3(recording());
  assert.deepEqual(trace.steps[1].causedBy, [1]);
  assert.equal(trace.causalChains.length, 1);
  assert.deepEqual(trace.causalChains[0].steps, [1, 2]);
  assert.equal(trace.causalChains[0].inferred, false);

  const inferred = buildTraceV3({
    url: 'https://app.test/',
    startedAt: T0,
    events: [
      { kind: 'click', seq: 1, ts: T0 + 1, tag: 'button' },
      { kind: 'click', seq: 2, ts: T0 + 2, tag: 'button' },
    ],
  });
  assert.equal(inferred.causalChains.length, 1);
  assert.deepEqual(inferred.causalChains[0].steps, [1, 2]);
  assert.equal(inferred.causalChains[0].inferred, true);
  assert.equal(inferred.causalChains[0].reason, 'no-explicit-causality');
});

test('buildTraceV3：带 traceEvents 时挂 spanSummary/criticalPath/spans', () => {
  const trace = buildTraceV3(recording());
  assert.equal(trace.spanSummary.spans, 2);
  assert.equal(trace.spanSummary.dropped, 0);
  assert.equal(trace.spanSummary.byFrame.length, 1);
  assert.equal(trace.spanSummary.byFrame[0].key, '2');
  assert.equal(trace.criticalPath.totalMs, 30);
  assert.deepEqual(trace.criticalPath.spans.map((span) => span.name), ['Task']);
  assert.equal(trace.spans.length, 2);
  assert.equal(trace.spans[0].name, 'Task');
  assert.equal(trace.spans[0].frame.frameId, '2');
  assert.equal(trace.frames.some((frame) => frame.frameId === 2), true);
});

test('renderTraceHtml：渲染关键路径 / 跨 frame / 因果链 / span 表', () => {
  const trace = buildTraceV3(recording());
  const html = renderTraceHtml(trace);
  assert.match(html, /Span \/ 关键路径/);
  assert.match(html, /关键路径/);
  assert.match(html, /30ms · 1 spans/);
  assert.match(html, /跨 frame 归属/);
  assert.match(html, /https:\/\/app\.test\/frame/);
  assert.match(html, /因果链/);
  assert.match(html, /explicit/);
  assert.match(html, /<code>#1<\/code> → <code>#2<\/code>/);
  assert.match(html, /frame 2/);
});

test('renderTraceHtml：只有 spans 数组或只有 frames 时不报错且尽量展示', () => {
  const spansOnly = renderTraceHtml({
    version: 3,
    steps: [],
    states: [],
    spans: [
      { id: 's1', name: 'Task', cat: 'toplevel', durMs: 12, selfMs: 12, depth: 0, frame: { frameId: 'F1' } },
    ],
  });
  assert.match(spansOnly, /Span \/ 关键路径/);
  assert.match(spansOnly, /Task/);
  assert.match(spansOnly, /跨 frame 归属/);

  const empty = renderTraceHtml({ version: 3, steps: [], states: [] });
  assert.equal(empty.includes('关键路径'), false);
  assert.match(empty, /没有可回放步骤/);
});

test('renderTraceHtml：不可信 span 名称/URL 被转义', () => {
  const html = renderTraceHtml({
    version: 3,
    steps: [],
    states: [],
    frames: [{ frameId: 1, url: 'https://x/?q=<script>alert(1)</script>', depth: 0 }],
    spans: [
      { id: 's1', name: '<script>alert(2)</script>', cat: 'x', durMs: 1, selfMs: 1, depth: 0 },
    ],
    causalChains: [{ id: 'c1', steps: [1, 2], inferred: false }],
  });
  assert.equal(html.includes('<script>alert(2)</script>'), false);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.equal(html.includes('q=<script>'), false);
});
