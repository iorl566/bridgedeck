import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiDir = path.join(ROOT, 'extension', 'ui');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const browser = findBrowser();

test('真实 Chromium：RTL 逻辑布局与图标镜像', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/rtl-dom.html?dir=rtl', { timeoutMs: 15000 });
  assert.match(result.title, /^RTL_DOM_OK:(\d+)$/, result.title);
  assert.ok(Number(/^RTL_DOM_OK:(\d+)$/.exec(result.title)[1]) >= 6, 'RTL 断言数量不足：' + result.title);
});

test('所有扩展页面在样式前同步加载 direction.js', () => {
  const pages = fs.readdirSync(uiDir).filter((file) => file.endsWith('.html'));
  assert.ok(pages.length >= 10, '扩展页面太少：' + pages.length);
  for (const page of pages) {
    const text = fs.readFileSync(path.join(uiDir, page), 'utf8');
    const directionAt = text.indexOf('<script src="direction.js"></script>');
    assert.ok(directionAt >= 0, page + ' 缺 direction.js');
    const stylesheetAt = text.indexOf('<link rel="stylesheet"');
    if (stylesheetAt >= 0) assert.ok(directionAt < stylesheetAt, page + ' 的 direction.js 必须在样式之前');
  }
});

test('direction.js 覆盖 RTL 语言并支持 ?dir 覆盖', () => {
  const source = read('extension/ui/direction.js');
  for (const lang of ['ar', 'he', 'fa', 'ur']) assert.ok(new RegExp("\\\\b" + lang + "\\\\b").test(source) || source.includes(lang), 'direction.js 缺语言 ' + lang);
  assert.match(source, /navigator\.languages/);
  assert.match(source, /URLSearchParams\(location\.search\)/);
  assert.match(source, /'data-bb-dir'/);
  assert.match(source, /'rtl'/);
});

test('UI CSS 使用逻辑属性并显式处理 RTL', () => {
  for (const file of ['extension/ui/popup.css', 'extension/ui/ui.css']) {
    const css = read(file);
    assert.match(css, /inset-inline-start/, file + ' 缺逻辑起点');
    assert.match(css, /inset-inline-end/, file + ' 缺逻辑终点');
    assert.match(css, /\[dir="rtl"\]/, file + ' 缺 RTL 覆盖');
    assert.doesNotMatch(css, /\bright:\s*\d/, file + ' 仍有物理 right 定位');
    assert.doesNotMatch(css, /\bleft:\s*\d/, file + ' 仍有物理 left 定位');
    assert.doesNotMatch(css, /text-align:\s*left/, file + ' 仍有 text-align:left');
  }
});

test('浮层 CSS 按内联方向锚定，并识别 RTL 语言/页面方向', () => {
  const overlay = read('extension/src/overlay-ui.js');
  assert.match(overlay, /inset-inline-end:16px/);
  assert.match(overlay, /inset-inline-end:18px/g);
  assert.doesNotMatch(overlay, /right:16px/);
  assert.doesNotMatch(overlay, /\bright:18px/);
  assert.match(overlay, /\^\(ar\|he\|fa\|ur/);
  assert.match(overlay, /document\.documentElement\.dir === 'rtl'/);
  assert.match(overlay, /:host\(\[dir="rtl"\]\)/);
  assert.match(overlay, /setAttribute\('dir', rtl \? 'rtl' : 'ltr'\)/);
  {
    const record = read('extension/src/record-overlay.js');
    // 录制胶囊已改为底部居中：用逻辑 inset-inline + margin-inline 居中，不允许物理 left。
    assert.match(record, /inset-inline:0/);
    assert.match(record, /margin-inline:auto/);
    assert.match(record, /setAttribute\('dir'/, 'extension/src/record-overlay.js 缺 RTL 方向');
    assert.doesNotMatch(record, /(?<!inset-inline-)left:\s*\d/, 'extension/src/record-overlay.js 仍有物理 left');
  }
  for (const file of ['extension/src/manual-overlay.js']) {
    const source = read(file);
    assert.match(source, /inset-inline-start:18px/, file + ' 缺逻辑起点');
    assert.match(source, /setAttribute\('dir'/, file + ' 缺 RTL 方向');
    assert.doesNotMatch(source, /(?<!inset-inline-)left:\s*\d/, file + ' 仍有物理 left');
  }
});
