// 真实 headless DOM 夹具：关系图 v3 扩展（labels 链 / html-for / tab-controls / 组合控件 /
// invalidates / alt / title）+ 语义上下文 + 压缩 + 查询 + 跨 frame 关系。
// 依赖本机 Edge/Chrome；找不到浏览器时跳过（与其它 DOM 单测同样的处理）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';

const browser = findBrowser();

test('VOM relations：真实 Chromium DOM 上关系 v3/上下文/压缩/查询/跨 frame 全部可复现', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/vom-relations.html', { timeoutMs: 30000 });
  assert.match(
    result.title,
    /^VOM_RELATIONS_OK:\d+$/,
    result.title + (result.stderr ? ' | ' + String(result.stderr).slice(0, 400) : ''),
  );
  const count = Number(result.title.split(':')[1]);
  assert.ok(count >= 50, '断言数过少：' + count);
});
