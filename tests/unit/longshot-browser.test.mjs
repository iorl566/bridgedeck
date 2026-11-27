import test from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';

// 真实 headless Chromium：真实 DOM 固定带几何 + 真实 OffscreenCanvas PNG 字节 →
// manifest hash/sealed/refetch、恢复重拼、状态机、预算与并发执行器全链路。
test('真实 Chromium：长截图五件套（段规划/manifest/恢复/状态机/预算）', { skip: !findBrowser() }, async () => {
  const result = await runHeadlessPage('tests/browser/longshot-pipeline.html', { timeoutMs: 45000 });
  assert.match(
    result.title,
    /^LONGSHOT_PIPE_OK:\d+$/,
    result.title + '\n' + String(result.stderr || '').slice(0, 800),
  );
  const assertions = Number(/^LONGSHOT_PIPE_OK:(\d+)$/.exec(result.title)[1]);
  assert.ok(assertions >= 40, '浏览器内断言数过少（' + assertions + '），疑似页面提前结束');
});
