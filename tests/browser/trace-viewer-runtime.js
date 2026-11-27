// tests/browser/trace-viewer-runtime.js —— 真实 Chromium 里渲染 Trace Viewer 并操作它。
//
// 目的不是再测一遍字符串拼接，而是证明“真实渲染 + 分页 + 搜索 + 转义”在浏览器里成立：
//   1) 用真实 renderTraceHtml（含 2000+ 字符状态正文、注入串、span 树、因果链）生成 HTML；
//   2) 写进同源 iframe，等 load 后直接操作 DOM：
//      - span 树按 data-depth 缩进、分页只显示第 1 页；
//      - 点击“下一页”后第 2 页可见、第 1 页隐藏；
//      - 搜索框过滤步骤并更新计数；
//      - 页面里的注入串不会执行（window.__pwned 不存在）；
//   3) 统计信息写进页面 JSON，供单测断言。
//
// 成功：document.title = TRACE_VIEWER_RUNTIME_OK:<断言数>；失败：..._FAIL:<message>。
import { renderTraceHtml, renderTraceReport } from '../../lib/trace-viewer.mjs';

let passed = 0;
const expect = (value, message) => {
  if (!value) throw new Error(message);
  passed += 1;
};
const setTitle = (value) => { document.title = value; };

function buildTrace() {
  const spans = Array.from({ length: 60 }, (_, index) => ({
    id: 's' + index,
    name: 'span-' + index,
    cat: index % 3 === 0 ? 'toplevel' : 'devtools.timeline',
    tsMs: index * 10,
    durMs: 100 - index,
    selfMs: Math.max(1, 40 - index),
    depth: index === 0 ? 0 : (index < 8 ? 1 : (index < 20 ? 2 : 3)),
    parentId: index === 0 ? null : 's' + Math.max(0, Math.floor((index - 1) / 3)),
  }));
  const steps = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    at: new Date(Date.UTC(2026, 10, 25, 10, 0, index)).toISOString(),
    op: index % 2 === 0 ? 'click' : 'fill',
    state: 's1',
    result: { state: 's1' },
    target: { name: 'target-' + index, role: 'button' },
    ...(index === 5 ? { value: 'needle-value' } : {}),
    ...(index > 0 ? { causedBy: [index] } : {}),
  }));
  return {
    version: 3,
    purpose: 'runtime <img src=x onerror="window.__pwned=1">',
    started_at: '2026-11-25T10:00:00.000Z',
    recorded_at: '2026-11-25T10:01:00.000Z',
    entry: { start_url: 'https://example.test/?q=<script>window.__pwned=2</script>' },
    states: [
      { id: 's1', url: 'https://example.test/', title: 'Home', body: 'B'.repeat(2400) + '<script>window.__pwned=3</script>' },
    ],
    steps,
    causalChains: [
      { id: 'c1', steps: [1, 2, 3], inferred: false },
      { id: 'c2', steps: [1, 2], inferred: true, reason: 'time-linear <script>window.__pwned=4</script>' },
    ],
    spans,
    spanSummary: {
      spans: spans.length,
      roots: 1,
      unfinished: 0,
      truncated: false,
      dropped: 0,
      selfTotalMs: 300,
      byFrame: [],
      criticalPath: {
        totalMs: 100,
        spanCount: 4,
        metric: 'self',
        framePath: ['F1'],
        path: spans.slice(0, 4).map((span) => ({ name: span.name, cat: span.cat, durMs: span.durMs, selfMs: span.selfMs, frame: { frameId: 'F1' } })),
      },
    },
    frames: [{ frameId: 'F1', depth: 1, url: 'https://example.test/frame', stepCount: 12 }],
    network: Array.from({ length: 12 }, (_, index) => ({
      at: new Date(Date.UTC(2026, 10, 25, 10, 0, index)).toISOString(),
      method: index % 2 ? 'POST' : 'GET',
      url: 'https://example.test/api/' + index + '?q=<script>window.__pwned=5</script>',
      status: 200,
      type: 'xhr',
    })),
    screenshots: [{ label: 'shot <b>', width: 10, height: 10, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
  };
}

function loadIntoIframe(html) {
  const iframe = document.getElementById('viewer');
  return new Promise((resolve, reject) => {
    iframe.onload = () => resolve(iframe);
    iframe.onerror = reject;
    iframe.srcdoc = html;
  });
}

function visibleRows(doc, selector) {
  return Array.from(doc.querySelectorAll(selector)).filter((row) => !row.hidden);
}

async function main() {
  const trace = buildTrace();
  const report = renderTraceReport(trace, { limits: { spanPageSize: 20, networkPageSize: 10, causalPageSize: 2 } });
  expect(report.html.includes('Trace Viewer'), '应生成完整查看器 HTML');
  expect(report.stats.spanPages === 3, '60 个 span、每页 20 → 3 页，实际 ' + report.stats.spanPages);
  expect(report.stats.fallback === false && report.stats.degraded === false, '默认预算下不应降级');
  const iframe = await loadIntoIframe(report.html);
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  expect(doc instanceof win.Document, 'iframe 应加载出真实文档');
  expect(doc.querySelectorAll('article.step').length === 12, '应渲染 12 个步骤卡片');
  expect(doc.querySelectorAll('.span-tree tbody tr').length === 60, 'span 树应有 60 行');
  expect(doc.querySelectorAll('[data-depth="2"]').length > 0, 'span 树应有二级缩进行');
  expect(doc.querySelectorAll('.tree-branch').length > 0, '缩进应渲染 tree-branch');
  const bars = Array.from(doc.querySelectorAll('.cp-bar'));
  expect(bars.length === 4, '关键路径应有 4 个占比条');
  expect(bars.some((bar) => /width:\s*(0|[0-9.]+)%/.test(bar.getAttribute('style') || '')), '占比条宽度应是合法百分比');
  expect(doc.querySelector('.cp-bottleneck') !== null, '关键路径应渲染瓶颈');
  expect(doc.querySelectorAll('.causal > ul > li').length === 2, '因果链应渲染 2 条');
  expect(doc.querySelector('.causal .inferred') !== null, '推断链应标记 inferred');
  expect(doc.querySelectorAll('a.badge-cause').length >= 10, '步骤应渲染 causedBy 回链');
  expect(win.__pwned === undefined, '注入串不应执行（window.__pwned 未定义）');
  expect(doc.title.includes('<img'), false, '标题里的标签应被转义为文本');

  // ---- 分页：span 树初始只显示第 1 页
  const spanRows = () => Array.from(doc.querySelectorAll('.span-tree tbody tr'));
  expect(visibleRows(doc, '.span-tree tbody tr').length === 20, '初始只应显示第 1 页的 20 行');
  expect(spanRows()[0].querySelector('.tree-toggle') !== null, '有子节点的行应有展开标记');
  const spanPager = doc.querySelector('[data-pager="spans"]');
  expect(spanPager !== null && spanPager.getAttribute('data-pages') === '3', 'span 分页器应显示 3 页');
  const next = spanPager.querySelector('[data-page-next]');
  expect(next !== null && next.disabled === false, '“下一页”初始应可点');
  next.click();
  expect(visibleRows(doc, '.span-tree tbody tr').length === 20, '第 2 页仍应显示 20 行');
  expect(spanRows().filter((row) => !row.hidden)[0].getAttribute('data-row-page') === '2', '翻页后可见行应属于第 2 页');
  expect(spanPager.querySelector('[data-page-current]').textContent === '2', '页码应更新为 2');
  next.click();
  next.click();
  expect(spanPager.querySelector('[data-page-next]').disabled === true, '最后一页“下一页”应禁用');
  expect(spanPager.querySelector('[data-page-current]').textContent === '3', '应停在最后一页');

  // ---- 分页：网络与因果链
  const networkPager = doc.querySelector('[data-pager="network"]');
  expect(networkPager !== null && networkPager.getAttribute('data-pages') === '2', '网络请求应分 2 页');
  expect(visibleRows(doc, '.network tbody tr').length === 10, '网络第 1 页应显示 10 条');
  networkPager.querySelector('[data-page-next]').click();
  expect(visibleRows(doc, '.network tbody tr')[0].getAttribute('data-row-page') === '2', '网络翻页应切到第 2 页');
  const causalPager = doc.querySelector('[data-pager="causal"]');
  expect(causalPager === null, '2 条因果链按每页 2 条只有 1 页，不应渲染翻页器');
  expect(doc.querySelectorAll('.causal > ul > li').length === 2, '因果链两条都应可见');

  // ---- 搜索：过滤步骤并更新计数
  const input = doc.getElementById('q');
  const count = doc.getElementById('count');
  expect(input !== null && count !== null, '搜索框与计数应存在');
  input.value = 'needle-value';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  expect(visibleRows(doc, 'article.step').length === 1, '按值搜索应只剩 1 个步骤');
  expect(count.textContent.trim() === '1 / 12', '计数应更新为 1 / 12，实际 ' + count.textContent);
  input.value = '';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  expect(visibleRows(doc, 'article.step').length === 12, '清空搜索应恢复 12 个步骤');

  // ---- 大数据保护：极小字节上限 → 最小摘要页
  const huge = { ...trace, screenshots: [{ label: 'x', dataUrl: 'data:image/png;base64,' + 'A'.repeat(300000) }] };
  const fallback = renderTraceReport(huge, { maxHtmlBytes: 2048 });
  expect(fallback.stats.fallback === true, '超大内容应回落最小摘要页');
  expect(fallback.html.includes('A'.repeat(2000)) === false, '摘要页不应写入超大 data URL');
  expect(renderTraceHtml(huge, { maxHtmlBytes: 2048 }).length < 20000, '最小摘要页体积应很小');

  document.getElementById('viewer-stats-json').textContent = JSON.stringify({
    title: report.stats.criticalPath ? 'ok' : 'missing',
    stats: report.stats,
    fallback: { fallback: fallback.stats.fallback, bytes: fallback.stats.bytes },
  });
  const parsed = JSON.parse(document.getElementById('viewer-stats-json').textContent);
  expect(parsed.stats.spanPages === 3 && parsed.fallback.fallback === true, 'JSON 统计应可解析');
  setTitle('TRACE_VIEWER_RUNTIME_OK:' + passed);
}

main().catch((error) => {
  setTitle('TRACE_VIEWER_RUNTIME_FAIL:' + (error && error.message ? error.message : String(error)));
});
