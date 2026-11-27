// tests/unit/trace-viewer-deep.test.mjs —— W5-B：trace viewer 深度渲染（span 树 / 关键路径 /
// 因果链 / 分页 / HTML 转义 / 大数据保护）。只测行为，不断言实现细节的形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWER_LIMITS,
  buildSpanView,
  escapeHtml,
  paginate,
  planViewerBudget,
  renderTraceHtml,
  renderTraceReport,
  sharePercent,
  truncateText,
} from '../../lib/trace-viewer.mjs';

function span(id, overrides = {}) {
  return {
    id,
    name: 'span-' + id,
    cat: 'devtools.timeline',
    tsMs: 0,
    durMs: 10,
    selfMs: 10,
    depth: 0,
    parentId: null,
    frame: null,
    url: '',
    ...overrides,
  };
}

function treeTrace() {
  return {
    version: 3,
    purpose: 'deep <trace>',
    started_at: '2026-11-25T10:00:00.000Z',
    recorded_at: '2026-11-25T10:00:10.000Z',
    entry: { start_url: 'https://example.test/' },
    states: [{ id: 's1', url: 'https://example.test/', body: 'body <script>alert(1)</script>' }],
    steps: [
      { id: 1, at: '2026-11-25T10:00:01.000Z', op: 'click', state: 's1', result: { state: 's1' }, target: { ref: '@e1', role: 'button', name: 'Go' } },
      { id: 2, at: '2026-11-25T10:00:02.000Z', op: 'fill', state: 's1', result: { state: 's1' }, target: { name: 'q' }, value: 'hello', causedBy: [1] },
    ],
    spans: [
      span('s1', { name: 'Task', tsMs: 0, durMs: 100, selfMs: 20, childCount: 3 }),
      span('s2', { name: 'Paint', parentId: 's1', tsMs: 10, durMs: 30, selfMs: 30, depth: 1, frame: { frameId: 'F1' } }),
      span('s3', { name: 'Layout', parentId: 's1', tsMs: 20, durMs: 20, selfMs: 20, depth: 1 }),
      span('s4', { name: 'Script', parentId: 's1', tsMs: 30, durMs: 50, selfMs: 30, depth: 1 }),
      span('s5', { name: 'Nested', parentId: 's4', tsMs: 35, durMs: 20, selfMs: 20, depth: 2 }),
    ],
    spanSummary: {
      spans: 5,
      roots: 1,
      unfinished: 0,
      truncated: false,
      dropped: 0,
      selfTotalMs: 120,
      byFrame: [{ key: 'F1', count: 1, selfMs: 30 }],
      criticalPath: {
        totalMs: 100,
        spanCount: 3,
        metric: 'self',
        framePath: ['F1'],
        path: [
          { name: 'Task', cat: 'toplevel', durMs: 100, selfMs: 20, frame: null },
          { name: 'Script', cat: 'devtools.timeline', durMs: 50, selfMs: 30, frame: { frameId: 'F1' } },
          { name: 'Nested', cat: 'devtools.timeline', durMs: 20, selfMs: 20, frame: null },
        ],
      },
    },
    frames: [{ frameId: 'F1', depth: 1, url: 'https://example.test/frame', stepCount: 2 }],
    causalChains: [
      { id: 'c1', steps: [1, 2], inferred: false },
      { id: 'c2', steps: [1, 99], inferred: true, reason: 'time-linear <inferred>' },
    ],
    network: [
      { at: '2026-11-25T10:00:01.500Z', method: 'GET', url: 'https://example.test/api?q=<script>x</script>', status: 200, type: 'xhr' },
    ],
  };
}

test('truncateText：保长度证据、超限才截断、非法输入安全', () => {
  assert.equal(truncateText('abc', 10), 'abc');
  const clipped = truncateText('x'.repeat(30), 5);
  assert.equal(clipped.startsWith('xxxxx…'), true);
  assert.match(clipped, /已截断，共 30 字符/);
  assert.equal(truncateText(null, 10), '');
  assert.equal(truncateText({ a: 1 }, 100), '{"a":1}');
  const cyclic = { name: 'cyclic' };
  cyclic.self = cyclic;
  assert.equal(truncateText(cyclic, 100), '', '循环引用不应抛错');
  assert.equal(truncateText('abc', 0), 'abc', '上限 0 视为不截断');
});

test('sharePercent：非法值归零、封顶 100、保留一位小数', () => {
  assert.equal(sharePercent(25, 100), 25);
  assert.equal(sharePercent(1, 3), 33.3);
  assert.equal(sharePercent(-5, 100), 0);
  assert.equal(sharePercent(Number.NaN, 100), 0);
  assert.equal(sharePercent(200, 100), 100);
  assert.equal(sharePercent(10, 0), 0);
});

test('paginate：边界页、切片、页数', () => {
  const items = Array.from({ length: 25 }, (_, index) => index);
  const first = paginate(items, { pageSize: 10 });
  assert.deepEqual(first.items, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(first.pageCount, 3);
  assert.equal(first.hasPrev, false);
  assert.equal(first.hasNext, true);
  const last = paginate(items, { pageSize: 10, page: 99 });
  assert.equal(last.page, 3);
  assert.deepEqual(last.items, [20, 21, 22, 23, 24]);
  assert.equal(last.hasNext, false);
  assert.equal(paginate([], { pageSize: 10 }).pageCount, 1);
  assert.equal(paginate(null).items.length, 0);
});

test('buildSpanView：父子关系还原为深度优先行序（含 frame 归属）', () => {
  const view = buildSpanView(treeTrace().spans);
  assert.equal(view.total, 5);
  assert.deepEqual(view.rows.map((row) => [row.span.id, row.depth]), [
    ['s1', 0], ['s2', 1], ['s3', 1], ['s4', 1], ['s5', 2],
  ]);
  assert.equal(view.rows[0].childCount, 3);
  assert.equal(view.rows[4].span.frame, null);
  const cloned = JSON.parse(JSON.stringify(treeTrace().spans));
  buildSpanView(cloned);
  assert.deepEqual(cloned, treeTrace().spans, 'buildSpanView 不应修改输入');
});

test('buildSpanView：缺失 parent 按 depth 回退、成环与重复 id 不丢不崩', () => {
  const view = buildSpanView([
    span('a', { depth: 2 }),
    span('b', { parentId: 'missing', depth: 1 }),
    span('c', { parentId: 'd' }),
    span('d', { parentId: 'c' }),
    span('a', { name: 'duplicate-a' }),
  ]);
  assert.equal(view.total, 4, '重复 id 只保留第一条');
  assert.ok(view.rows.length >= 4);
  assert.equal(view.rows.find((row) => row.span.id === 'b').depth, 0);
  const cRow = view.rows.find((row) => row.span.id === 'c');
  const dRow = view.rows.find((row) => row.span.id === 'd');
  assert.ok(cRow && dRow, '成环节点也必须渲染');
});

test('planViewerBudget：逐类上限/省略数/页数与截断标记', () => {
  const trace = treeTrace();
  trace.steps = Array.from({ length: 800 }, (_, index) => ({ id: index + 1, op: 'click', target: { name: 'x' } }));
  trace.network = Array.from({ length: 1000 }, (_, index) => ({ method: 'GET', url: 'https://x/' + index }));
  trace.screenshots = Array.from({ length: 40 }, (_, index) => ({ label: 's' + index, dataUrl: 'data:image/png;base64,AAA' }));
  const budget = planViewerBudget(trace, { limits: { steps: 100, network: 50, screenshots: 5, spanRows: 3, spanPageSize: 2 } });
  assert.deepEqual(budget.steps, { total: 800, rendered: 100, omitted: 700 });
  assert.deepEqual(budget.network, { total: 1000, rendered: 50, omitted: 950 });
  assert.deepEqual(budget.screenshots, { total: 40, rendered: 5, omitted: 35 });
  assert.deepEqual(budget.spans, { total: 5, rendered: 3, omitted: 2 });
  assert.equal(budget.spanPages, 2);
  assert.equal(budget.networkPages, 1);
  assert.equal(budget.truncated, true);
});

test('renderTraceHtml：span 树按父子缩进 + 分页属性', () => {
  const trace = treeTrace();
  const html = renderTraceHtml(trace, { limits: { spanPageSize: 2 } });
  assert.match(html, /class="span-tree"/);
  assert.match(html, /data-row-page="1"/);
  assert.match(html, /data-row-page="3"/);
  assert.match(html, /data-pager="spans" data-pages="3"/);
  assert.match(html, /data-depth="1"/);
  assert.match(html, /data-depth="2"/);
  const nestedIndex = html.indexOf('<span class="tree-branch"></span><span class="tree-branch"></span>');
  assert.ok(nestedIndex > 0, '两级缩进应出现两次 tree-branch');
  const rows = [...html.matchAll(/<tr data-row-page="\d+" data-depth="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(rows, [0, 1, 1, 1, 2], '先序：父在子前');
});

test('renderTraceHtml：关键路径占比条与瓶颈，非法数值不产生 NaN', () => {
  const trace = treeTrace();
  const html = renderTraceHtml(trace);
  assert.match(html, /关键路径 <span class="count">100ms · 3 spans<\/span>/);
  assert.match(html, /style="width:20%"/);
  assert.match(html, /style="width:30%"/);
  assert.match(html, /瓶颈：<code>Script<\/code>（self 30ms，占 30%）/);
  assert.equal(html.includes('NaN'), false);

  trace.spanSummary.criticalPath.path = [{ name: 'Bad', durMs: 'x', selfMs: -1, frame: null }];
  trace.spanSummary.criticalPath.totalMs = 0;
  const bad = renderTraceHtml(trace);
  assert.equal(bad.includes('NaN'), false);
  assert.match(bad, /style="width:0%"/);
});

test('renderTraceHtml：因果链 explicit/inferred 分组、节点解析与锚点回链', () => {
  const html = renderTraceHtml(treeTrace());
  assert.match(html, /因果链 <span class="count">2<\/span>/);
  assert.match(html, /explicit 1/);
  assert.match(html, /inferred 1/);
  assert.match(html, /<code>#1<\/code> → <code>#2<\/code>/);
  assert.match(html, /解析步骤/);
  assert.match(html, /click Go/);
  assert.match(html, /trace 里没有该步骤/);
  assert.match(html, /href="#step-1"/);
  assert.match(html, /time-linear &lt;inferred&gt;/, '因果链 reason 必须转义');
  assert.match(html, /href="#step-1"/);
});

test('renderTraceHtml：步骤锚点 + causedBy 回链 + 状态正文转义', () => {
  const html = renderTraceHtml(treeTrace());
  assert.match(html, /id="step-1"/);
  assert.match(html, /id="step-2"/);
  assert.match(html, /href="#step-1" data-cause="1"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('body <script>'), false);
});

test('renderTraceHtml：关键路径/span 名称/URL/标题全部转义', () => {
  const trace = treeTrace();
  trace.purpose = 'purpose <img src=x onerror=alert(1)>';
  trace.spans[0].name = '<script>alert(2)</script>';
  trace.frames[0].url = 'https://x/?q=<script>alert(3)</script>';
  const html = renderTraceHtml(trace);
  assert.equal(html.includes('<script>alert(2)</script>'), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('q=<script>'), false);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});

test('renderTraceHtml：大数据保护（长正文/超长值/超大截图）', () => {
  const trace = treeTrace();
  trace.states[0].body = 'B'.repeat(12000);
  trace.steps[1].value = 'V'.repeat(4000);
  trace.screenshots = [{ label: 'big', dataUrl: 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024) }];
  const report = renderTraceReport(trace, { limits: { stateBodyChars: 1000, stepValueChars: 100 } });
  assert.match(report.html, /已截断，共 12000 字符/);
  assert.match(report.html, /已截断，共 4000 字符/);
  assert.equal(report.html.includes('A'.repeat(1024)), false, '超大截图不应写进 HTML');
  assert.match(report.html, /步骤截图过大|截图过大/);
  assert.equal(report.stats.truncated, false, '行数未超限时 truncated 只表示行数截断');
});

test('renderTraceHtml：行数超限时给出省略提示（步骤/网络/截图/因果链）', () => {
  const trace = treeTrace();
  trace.steps = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, op: 'click', target: { name: 't' + index } }));
  trace.network = Array.from({ length: 20 }, (_, index) => ({ method: 'GET', url: 'https://x/' + index }));
  trace.screenshots = Array.from({ length: 6 }, (_, index) => ({ label: 's' + index, dataUrl: 'data:image/png;base64,AAA' }));
  trace.causalChains = Array.from({ length: 5 }, (_, index) => ({ id: 'c' + index, steps: [1, 2], inferred: true }));
  const html = renderTraceHtml(trace, { limits: { steps: 5, network: 5, screenshots: 2, causalChains: 2, causalPageSize: 1 } });
  assert.match(html, /步骤共 20 步，已渲染前 5 步/);
  assert.match(html, /网络请求共 20 条，已渲染前 5 条/);
  assert.match(html, /截图共 6 张，已渲染前 2 张/);
  assert.match(html, /因果链共 5 条，已渲染前 2 条/);
  assert.match(html, /data-pager="causal" data-pages="2"/);
});

test('renderTraceReport：HTML 字节超限先降级、再超限回落最小页', () => {
  // 大量“已截断但依然很大”的状态正文：默认状态正文上限 4000 字符 × 30 条 ≈ 120KB。
  const trace = treeTrace();
  trace.states = Array.from({ length: 30 }, (_, index) => ({ id: 's' + index, url: 'https://example.test/' + index, body: 'B'.repeat(4000) }));
  trace.steps = Array.from({ length: 30 }, (_, index) => ({ id: index + 1, op: 'click', state: 's' + index, result: { state: 's' + index }, target: { name: 't' + index } }));
  const degraded = renderTraceReport(trace, { maxHtmlBytes: 60000 });
  assert.equal(degraded.stats.degraded, true);
  assert.equal(degraded.stats.fallback, false);
  assert.ok(degraded.stats.bytes <= 60000, '降级后应回到字节上限内');
  assert.match(degraded.html, /已降级渲染/);

  const huge = { ...trace, screenshots: [{ label: 'x', dataUrl: 'data:image/png;base64,' + 'A'.repeat(400000) }] };
  const fallback = renderTraceReport(huge, { maxHtmlBytes: 1024 });
  assert.equal(fallback.stats.fallback, true);
  assert.match(fallback.html, /降级为摘要页/);
  assert.equal(fallback.html.includes('A'.repeat(1024)), false);
  assert.equal(fallback.html.includes('span 树'), false);
});

test('renderTraceReport：stats 是真实渲染证据（分页/关键路径/展开）', () => {
  const trace = treeTrace();
  const report = renderTraceReport(trace, { limits: { spanPageSize: 2 } });
  assert.equal(typeof report.html, 'string');
  assert.equal(report.stats.bytes, Buffer.byteLength(report.html));
  assert.equal(report.stats.spanPages, 3);
  assert.equal(report.stats.spans.total, 5);
  assert.equal(report.stats.steps.total, 2);
  assert.equal(report.stats.criticalPath.totalMs, 100);
  assert.deepEqual(report.stats.criticalPath.framePath, ['F1']);
  assert.equal(report.stats.degraded, false);
  assert.equal(report.stats.fallback, false);
});

test('renderTraceHtml：空 trace 与非法输入', () => {
  const empty = renderTraceHtml({ version: 3, steps: [], states: [] });
  assert.match(empty, /没有可回放步骤/);
  assert.equal(empty.includes('关键路径'), false);
  assert.equal(empty.includes('因果链'), false);
  assert.throws(() => renderTraceHtml(null), /trace 必须是对象/);
  assert.throws(() => renderTraceHtml([]), /trace 必须是对象/);
});

test('renderTraceHtml：输出稳定（同一输入两次渲染完全一致）', () => {
  const trace = treeTrace();
  assert.equal(renderTraceHtml(trace), renderTraceHtml(trace));
});

test('默认上限是不可变常量且覆盖所有受保护类别', () => {
  assert.equal(Object.isFrozen(VIEWER_LIMITS), true);
  for (const key of ['steps', 'network', 'screenshots', 'spanRows', 'spanPageSize', 'causalChains', 'stateBodyChars', 'maxHtmlBytes']) {
    assert.ok(VIEWER_LIMITS[key] > 0, key + ' 必须是正数上限');
  }
  assert.ok(VIEWER_LIMITS.spanRows >= VIEWER_LIMITS.spanPageSize);
});

test('escapeHtml 在属性上下文同样安全（引号/尖括号）', () => {
  const value = escapeHtml('" onmouseover="alert(1)" <x>');
  assert.equal(value.includes('"'), false);
  assert.equal(value.includes('<'), false);
  const html = renderTraceHtml({
    version: 3,
    purpose: value,
    steps: [{ id: 1, op: 'click', target: { name: value } }],
    states: [],
  });
  assert.equal(html.includes('onmouseover="alert(1)"'), false);
});
