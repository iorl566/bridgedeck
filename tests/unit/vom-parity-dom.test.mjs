// 真实 headless DOM 夹具：page-lib row facts / 六阶段漏斗 / 统一 gate / token 预算 / 关系图 v3。
// 依赖本机 Edge/Chrome；找不到浏览器时跳过（与其它 DOM 单测同样的处理）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';

const browser = findBrowser();

test('VOM parity：真实 Chromium DOM 上 row facts/漏斗/gate/预算/关系图 v3 全部可复现', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/vom-parity.html', { timeoutMs: 20000 });
  assert.match(
    result.title,
    /^VOM_PARITY_OK:\d+$/,
    result.title + (result.stderr ? ' | ' + String(result.stderr).slice(0, 400) : ''),
  );
  const count = Number(result.title.split(':')[1]);
  assert.ok(count >= 40, '断言数过少：' + count);
});
