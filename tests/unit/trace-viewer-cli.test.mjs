// tests/unit/trace-viewer-cli.test.mjs —— trace 命令的查看器收口：JSON 证据（分页/字节上限）、
// 文本摘要与 summary/diff 的深度字段输出。只做本地文件路径，不触达 daemon。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { traceCommand } from '../../cli/commands/trace.mjs';

class FakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FakeError';
    this.code = code;
  }
}

function viewTrace() {
  return {
    version: 3,
    purpose: 'cli <trace>',
    started_at: '2026-11-25T10:00:00.000Z',
    recorded_at: '2026-11-25T10:00:10.000Z',
    entry: { start_url: 'https://example.test/' },
    states: [{ id: 's1', url: 'https://example.test/', body: 'ok' }],
    steps: [
      { id: 1, at: '2026-11-25T10:00:01.000Z', op: 'click', state: 's1', result: { state: 's1' }, target: { name: 'Go' } },
      { id: 2, at: '2026-11-25T10:00:02.000Z', op: 'fill', state: 's1', result: { state: 's1' }, target: { name: 'q' }, value: 'v', causedBy: [1] },
    ],
    spans: [
      { id: 's1', name: 'Task', cat: 'toplevel', durMs: 10, selfMs: 10, depth: 0, parentId: null },
      { id: 's2', name: 'Paint', cat: 'devtools.timeline', durMs: 5, selfMs: 5, depth: 1, parentId: 's1' },
    ],
    spanSummary: {
      spans: 2,
      roots: 1,
      unfinished: 0,
      truncated: false,
      dropped: 0,
      selfTotalMs: 15,
      byFrame: [],
      criticalPath: { totalMs: 10, spanCount: 1, metric: 'self', framePath: [], path: [{ name: 'Task', cat: 'toplevel', durMs: 10, selfMs: 10, frame: null }] },
    },
    causalChains: [{ id: 'c1', steps: [1, 2], inferred: false }],
  };
}

function sdk(options = {}) {
  const state = { json: false, jsonOut: [], prints: [], dir: fs.mkdtempSync(path.join(os.tmpdir(), 'bb-trace-cli-')) };
  const ctx = {
    callRpc: async () => ({ ok: false, error: { code: 'E_UNEXPECTED', message: '不应调用 daemon' } }),
    withControl: (flags, base) => ({ ...base }),
    timeoutOf: () => 1000,
    outputFailure: (body) => { state.failures = (state.failures || []).concat([body]); return 1; },
    outputJsonBody: (body) => { state.jsonOut.push(body); return 0; },
    print: (line) => state.prints.push(line),
    emitJson: (value) => state.jsonOut.push(value),
    isJson: () => state.json,
    loadTraceSummary: () => import('../../lib/trace-summary.mjs'),
    ...(options.viewerLoader
      ? { loadTraceViewer: options.viewerLoader }
      : (options.omitViewerLoader === true ? {} : { loadTraceViewer: () => import('../../lib/trace-viewer.mjs') })),
    writeFileAtomic: (file, content) => { fs.writeFileSync(file, content); },
    BridgeError: FakeError,
    ArgError: FakeError,
  };
  return { ...state, state, ctx, cmd: (flags, pos) => traceCommand(ctx, flags, pos) };
}

function writeTrace(dir, name, trace) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(trace), 'utf8');
  return file;
}

test('trace view --json：输出查看器深度证据（span 树/分页/关键路径/字节）', async () => {
  const h = sdk();
  const trace = viewTrace();
  trace.steps = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, op: 'click', state: 's1', result: { state: 's1' }, target: { name: 't' + index } }));
  const file = writeTrace(h.dir, 'trace.json', trace);
  const out = path.join(h.dir, 'view.html');
  h.state.json = true;
  const code = await h.cmd({ json: true, out, limit: 2 }, ['trace', 'view', file]);
  assert.equal(code, 0);
  const payload = h.state.jsonOut.at(-1);
  assert.equal(payload.ok, true);
  assert.equal(payload.result.steps, 6);
  assert.equal(payload.result.out, path.resolve(out));
  assert.ok(fs.existsSync(out));
  assert.equal(payload.result.bytes > 0, true);
  const viewer = payload.result.viewer;
  assert.equal(viewer.spanPages, 1);
  assert.equal(viewer.spans.total, 2);
  assert.equal(viewer.steps.total, 6);
  assert.equal(viewer.criticalPath.totalMs, 10);
  assert.equal(viewer.fallback, false);
  assert.equal(typeof viewer.bytes, 'number');
});

test('trace view --json：HTML 字节上限触发最小摘要页并如实报告', async () => {
  const h = sdk();
  const trace = viewTrace();
  trace.states = Array.from({ length: 12 }, (_, index) => ({ id: 's' + index, url: 'https://x/' + index, body: 'B'.repeat(4000) }));
  trace.steps = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, op: 'click', state: 's' + index, result: { state: 's' + index }, target: { name: 't' } }));
  const file = writeTrace(h.dir, 'big.json', trace);
  h.state.json = true;
  const code = await h.cmd({ json: true, 'max-bytes': 1024 }, ['trace', 'view', file]);
  assert.equal(code, 0);
  const viewer = h.state.jsonOut.at(-1).result.viewer;
  assert.equal(viewer.fallback, true);
  assert.equal(viewer.degraded, true);
  assert.ok(viewer.notes.length >= 2);
  const html = fs.readFileSync(h.state.jsonOut.at(-1).result.out, 'utf8');
  assert.match(html, /降级为摘要页/);
});

test('trace view 文本输出：步骤/span/因果链/关键路径摘要', async () => {
  const h = sdk();
  const trace = viewTrace();
  const file = writeTrace(h.dir, 'trace.json', trace);
  const code = await h.cmd({ out: path.join(h.dir, 'view.html') }, ['trace', 'view', file]);
  assert.equal(code, 0);
  const text = h.state.prints.join('\n');
  assert.match(text, /已生成 Trace Viewer/);
  assert.match(text, /步骤 2 · 状态 1/);
  assert.match(text, /span 2（渲染 2 \/ 1 页）/);
  assert.match(text, /因果链 1（渲染 1 \/ 1 页）/);
  assert.match(text, /关键路径 10ms（1 spans）/);
});

test('trace summary 文本输出 spanSummary 深度字段', async () => {
  const h = sdk();
  const trace = {
    traceEvents: [
      { ph: 'X', name: 'Task', cat: 'toplevel', pid: 1, tid: 1, ts: 1_000_000, dur: 30_000 },
      { ph: 'X', name: 'Paint', cat: 'devtools.timeline', pid: 1, tid: 1, ts: 1_010_000, dur: 2_000 },
    ],
  };
  const file = writeTrace(h.dir, 'perf.json', trace);
  const code = await h.cmd({}, ['trace', 'summary', file]);
  assert.equal(code, 0);
  const text = h.state.prints.join('\n');
  assert.match(text, /events=2 duration=10ms/);
  assert.match(text, /span=2 roots=2/);
  assert.match(text, /关键路径=30ms（1 spans，self）/);
  assert.match(text, /Task 30ms（self 30ms）/);
});

test('trace diff 文本输出关键路径与 span 数变化', async () => {
  const h = sdk();
  const base = { traceEvents: [{ ph: 'X', name: 'Task', cat: 'toplevel', pid: 1, tid: 1, ts: 1_000_000, dur: 10_000 }] };
  const head = { traceEvents: [
    { ph: 'X', name: 'Task', cat: 'toplevel', pid: 1, tid: 1, ts: 1_000_000, dur: 20_000 },
    { ph: 'X', name: 'Paint', cat: 'devtools.timeline', pid: 1, tid: 1, ts: 1_005_000, dur: 5_000 },
  ] };
  const baseFile = writeTrace(h.dir, 'base.json', base);
  const headFile = writeTrace(h.dir, 'head.json', head);
  const code = await h.cmd({}, ['trace', 'diff', baseFile, headFile]);
  assert.equal(code, 0);
  const text = h.state.prints.join('\n');
  assert.match(text, /关键路径 10ms → 20ms（\+10ms）/);
  assert.match(text, /路径 span 1 → 1/);
  assert.match(text, /span 1 → 2/);
});

test('trace view：未注入 loadTraceViewer 时回退直接 import（历史接线缺口回归）', async () => {
  const h = sdk({ omitViewerLoader: true });
  const file = writeTrace(h.dir, 'trace.json', viewTrace());
  h.state.json = true;
  const code = await h.cmd({ json: true }, ['trace', 'view', file]);
  assert.equal(code, 0);
  const payload = h.state.jsonOut.at(-1);
  assert.equal(payload.ok, true);
  assert.equal(payload.result.viewer.spans.total, 2);
});

test('trace view：只用旧入口（renderTraceHtml）的注入实现也能渲染', async () => {
  const viewerModule = await import('../../lib/trace-viewer.mjs');
  const h = sdk({ viewerLoader: async () => ({ renderTraceHtml: viewerModule.renderTraceHtml }) });
  const file = writeTrace(h.dir, 'trace.json', viewTrace());
  h.state.json = true;
  const code = await h.cmd({ json: true }, ['trace', 'view', file]);
  assert.equal(code, 0);
  const payload = h.state.jsonOut.at(-1);
  assert.equal(payload.ok, true);
  assert.equal(payload.result.viewer, null, '旧入口没有预算统计');
  const html = fs.readFileSync(payload.result.out, 'utf8');
  assert.match(html, /Trace Viewer/);
  assert.match(html, /因果链/);
});

test('trace view：坏 JSON / 非 v3 明确报错', async () => {
  const h = sdk();
  fs.writeFileSync(path.join(h.dir, 'bad.json'), '{not json', 'utf8');
  await assert.rejects(() => h.cmd({ out: path.join(h.dir, 'x.html') }, ['trace', 'view', path.join(h.dir, 'bad.json')]), (error) => error.code === 'E_BAD_ARG');
  fs.writeFileSync(path.join(h.dir, 'v2.json'), JSON.stringify({ version: 2, steps: [] }), 'utf8');
  await assert.rejects(() => h.cmd({ out: path.join(h.dir, 'x.html') }, ['trace', 'view', path.join(h.dir, 'v2.json')]), /需要 Trace v3/);
});
