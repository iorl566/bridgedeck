// tests/unit/a11y-overlay.test.mjs —— 真实 Chromium 浮层可访问性测试 + 浮层源码结构断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const browser = findBrowser();

test('真实 Chromium：浮层 role/aria-live/焦点/键盘 a11y 全部通过', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/a11y-overlay.html', { timeoutMs: 20000 });
  assert.match(result.title, /^A11Y_OVERLAY_OK:(\d+)$/, result.title);
  assert.ok(Number(/^A11Y_OVERLAY_OK:(\d+)$/.exec(result.title)[1]) >= 7, '浮层 a11y 断言数量不足：' + result.title);
});

test('浮层源码结构：借用模态有 role/aria-modal/aria-label 与 Tab 循环/Escape', () => {
  const source = read('extension/src/overlay-ui.js');
  assert.match(source, /setAttribute\('role', 'dialog'\)/);
  assert.match(source, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(source, /setAttribute\('aria-label', T\.title\)/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /previousFocus\.focus/);
  assert.match(source, /denyBtn\.focus/);
});

test('浮层源码结构：Takeover 状态区 aria-live、Help 折叠 aria-expanded/aria-label', () => {
  const source = read('extension/src/overlay-ui.js');
  assert.match(source, /role="status" aria-live="polite"/);
  assert.match(source, /role="region"/);
  assert.match(source, /setAttribute\('aria-expanded'/);
  assert.match(source, /setAttribute\('aria-label', collapsed \? T\.expand : T\.collapse\)/);
  assert.match(source, /class="note" aria-label=/);
});

test('浮层样式方向：借用/接管/协助用逻辑属性并识别 RTL 宿主', () => {
  const source = read('extension/src/overlay-ui.js');
  assert.match(source, /inset-inline-end:16px/);
  assert.match(source, /document\.documentElement\.dir === 'rtl'/);
  assert.match(source, /setAttribute\('dir', rtl \? 'rtl' : 'ltr'\)/);
  assert.match(source, /:host\(\[dir="rtl"\]\)/);
});

test('浏览器夹具显式覆盖 12 语言中的 RTL（ar）与键盘路径', () => {
  const fixture = read('tests/browser/a11y-overlay.js');
  assert.match(fixture, /overlayTexts\('ar'\)/);
  assert.match(fixture, /getAttribute\('dir'\) === 'rtl'/);
  assert.match(fixture, /key\(deny, 'Tab'\)/);
  assert.match(fixture, /key\(deny, 'Escape'\)/);
});
