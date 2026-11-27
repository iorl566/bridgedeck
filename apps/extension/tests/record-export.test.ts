// tests/record-export.test.ts —— Trace v3 导出结构（version/states/steps/frames/因果/截图引用）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCausalChains, buildTraceV3, makeTraceScreenshot, summarizeTrace, traceOpFor, traceStateFiles } from '../src/record/trace.ts';
import type { Recording } from '../src/record/types.ts';

function recordingOf(events: Recording['events'], extra: Partial<Recording> = {}): Recording {
  return {
    id: 'rec-1',
    tabId: 12,
    url: 'https://example.test/form',
    title: 'E2E 夹具页',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_010_000,
    includeAgent: true,
    events,
    ...extra,
  };
}

function clickEvent(seq: number, extra: Record<string, unknown> = {}): Recording['events'][number] {
  return {
    kind: 'click',
    seq,
    ts: 1_700_000_001_000 + seq * 100,
    actor: 'human',
    url: 'https://example.test/form',
    frameId: 0,
    documentId: 'doc-1',
    boundary: { documentId: 'doc-1', frameId: 0, revision: 1 },
    selector: '#submit-btn',
    role: 'button',
    name: '提交',
    ...extra,
  };
}

test('buildTraceV3：version=3、必有初始 state、click 产生 step 与 before/after 引用', () => {
  const trace = buildTraceV3(recordingOf([
    clickEvent(1, { observation: 'button "提交" [@e1]', refs: 12 }),
    clickEvent(2, { selector: '#more-link', op: 'hover' } as Record<string, unknown>),
  ]));
  assert.equal(trace.version, 3);
  assert.match(trace.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(trace.stopped_by, 'cli_stop');
  assert.equal(trace.entry.start_url, 'https://example.test/form');
  assert.equal(trace.recorder.vom, 1);
  assert.ok(trace.states.length >= 1, 'trace 必须有 states（20d2）');
  assert.equal(trace.states[0]?.id, 's1');
  assert.ok(trace.steps.length >= 1, 'trace 必须有 steps（20d2）');
  const first = trace.steps[0];
  assert.ok(first);
  assert.equal(first.op, 'click');
  assert.equal(first.state, 's1');
  assert.equal(first.result.state, trace.states[trace.states.length - 1]?.id, 'click 的 observation 生成 after state');
  assert.equal(first.target?.role, 'button');
  assert.equal(first.target?.name, '提交');
  assert.equal(trace.states[1]?.body, 'button "提交" [@e1]');
  assert.equal(trace.causalChains.length, 1);
  assert.equal(trace.causalChains[0]?.inferred, true, '无显式因果时标注 inferred');
  assert.deepEqual(trace.causalChains[0]?.steps, trace.steps.map((step) => step.id));
});

test('buildTraceV3：input→fill（value/commit/redacted）、select→selection、switch_tab', () => {
  const trace = buildTraceV3(recordingOf([
    { ...clickEvent(1), kind: 'input', selector: '#kw', name: '关键词', value: '桥', commit: 'enter' },
    { ...clickEvent(2), kind: 'select', selector: '#kind', value: 'b', label: '乙' },
    { ...clickEvent(3), kind: 'input', selector: '#pwd', value: '********', sensitive: true },
    { ...clickEvent(4), kind: 'tab-switch', fromTabId: 1, toTabId: 2, fromWindowId: 1, toWindowId: 1 },
  ]));
  const fill = trace.steps.find((step) => step.op === 'fill' && step.value === '桥');
  assert.ok(fill);
  assert.equal(fill.commit, 'enter');
  assert.equal(fill.target?.name, '关键词');
  const select = trace.steps.find((step) => step.op === 'select');
  assert.ok(select);
  assert.deepEqual(select.selection, [{ value: 'b', label: '乙' }]);
  const redacted = trace.steps.find((step) => step.op === 'fill' && step.redacted === true);
  assert.ok(redacted, '脱敏输入的 trace step 必须 redacted');
  const switched = trace.steps.find((step) => step.op === 'switch_tab');
  assert.ok(switched, 'tab/window-switch 要导出成 switch_tab step（20d3/20d5）');
});

test('buildTraceV3：iframe 事件带 frameId → steps[].frame 与 frames 注册表（20d6）', () => {
  const trace = buildTraceV3(recordingOf([
    clickEvent(1, { frameId: 7, documentId: 'doc-frame', url: 'https://example.test/frame.html' }),
  ]));
  const step = trace.steps[0];
  assert.ok(step);
  assert.equal(step.frameId, 7);
  assert.ok(step.frame && step.frame.frameId === 7);
  assert.ok(Array.isArray(trace.frames) && trace.frames.length === 1);
  assert.equal(trace.entry.frames?.length, 1);
  assert.equal(trace.frames?.[0]?.stepCount, 1);
});

test('buildTraceV3：initialObservation/finalObservation 生成首尾 state，截图引用保留', () => {
  const trace = buildTraceV3(recordingOf([
    clickEvent(1, { screenshot: 'data:image/jpeg;base64,AAAA' }),
  ], {
    initialObservation: { text: '初始页面', url: 'https://example.test/form', at: 1_700_000_000_000 },
    finalObservation: { text: '最终页面', url: 'https://example.test/form?done=1', at: 1_700_000_009_000 },
  }));
  assert.equal(trace.states.length, 2, '初始 state + 最终观察 state');
  assert.equal(trace.states[0]?.body, '初始页面');
  assert.equal(trace.states[trace.states.length - 1]?.body, '最终页面');
  assert.match(String(trace.steps[0]?.screenshot), /^data:image\//);
  assert.equal(trace.steps[0]?.result.state, trace.states[trace.states.length - 1]?.id);
});

test('buildTraceV3：state 事件不进 steps，但 observation 参与 before/after 链', () => {
  const trace = buildTraceV3(recordingOf([
    { ...clickEvent(1), kind: 'state', observation: '状态快照' },
    clickEvent(2),
  ]));
  assert.equal(trace.steps.length, 1, 'state 事件不是 step');
  assert.equal(trace.steps[0]?.state, 's1');
});

test('traceStateFiles/summarizeTrace/makeTraceScreenshot：导出投影与摘要', () => {
  const trace = buildTraceV3(recordingOf([clickEvent(1)]));
  const files = traceStateFiles(trace);
  assert.deepEqual(files.map((file) => file.id), trace.states.map((state) => state.id));
  assert.equal(files[0]?.body, '');
  const summary = summarizeTrace(trace);
  assert.equal(summary.traceVersion, 3);
  assert.equal(summary.steps, trace.steps.length);
  assert.equal(summary.states, trace.states.length);
  assert.equal(summary.screenshots, 0);

  const shot = makeTraceScreenshot({ dataUrl: 'data:image/png;base64,BBBB', width: 800, height: 600 });
  assert.equal(shot.id, 'shot-1');
  assert.equal(shot.width, 800);
  assert.equal(shot.height, 600);
  assert.equal(shot.label, '导出时页面');
});

test('traceOpFor/buildCausalChains：op 映射与显式因果链合并', () => {
  assert.equal(traceOpFor('input'), 'fill');
  assert.equal(traceOpFor('tab-switch'), 'switch_tab');
  assert.equal(traceOpFor('window-switch'), 'switch_tab');
  assert.equal(traceOpFor('click'), 'click');
  assert.equal(traceOpFor('state'), null);

  const base = { at: new Date().toISOString(), state: 's1', result: { state: 's1' }, op: 'click' } as const;
  const chains = buildCausalChains([
    { ...base, id: 1 },
    { ...base, id: 2, causedBy: [1] },
    { ...base, id: 3, causedBy: [2] },
  ]);
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0]?.steps, [1, 2, 3]);
  assert.equal(chains[0]?.inferred, false);
  assert.deepEqual(buildCausalChains([]), []);
});
