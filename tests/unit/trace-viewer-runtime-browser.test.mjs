// tests/unit/trace-viewer-runtime-browser.test.mjs —— 真实 Chromium 渲染 Trace Viewer：
// span 树缩进、分页翻页、搜索过滤、注入串不执行、最小摘要页。
import test from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';

const browser = findBrowser();

function decodeEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

test('真实 Chromium：Trace Viewer 渲染/分页/搜索/转义', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/trace-viewer-runtime.html', { timeoutMs: 30000 });
  assert.match(
    result.title,
    /^TRACE_VIEWER_RUNTIME_OK:\d+$/,
    result.title + '\n' + String(result.stderr || '').slice(0, 800),
  );
  const assertions = Number(/^TRACE_VIEWER_RUNTIME_OK:(\d+)$/.exec(result.title)[1]);
  assert.ok(assertions >= 30, '浏览器内断言数应 >= 30，实际 ' + assertions);

  const match = /<pre id="viewer-stats-json"[^>]*>([\s\S]*?)<\/pre>/.exec(result.stdout);
  assert.ok(match, '页面应输出 viewer-stats-json');
  const payload = JSON.parse(decodeEntities(match[1]));
  assert.equal(payload.stats.spanPages, 3);
  assert.equal(payload.stats.spans.total, 60);
  assert.equal(payload.stats.steps.total, 12);
  assert.equal(payload.stats.causalChains.total, 2);
  assert.equal(payload.stats.networkPages, 2);
  assert.equal(payload.fallback.fallback, true);
  assert.ok(payload.fallback.bytes > 0);
});
