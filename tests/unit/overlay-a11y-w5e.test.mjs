// tests/unit/overlay-a11y-w5e.test.mjs —— 浮层 a11y 收口：真实 Chromium 夹具 + 源码结构断言。
//
// 真实 DOM 夹具 tests/browser/overlay-a11y-w5e.{html,js} 覆盖 record/manual/help/takeover/
// borrow/toast 的 role/aria-live/aria-modal、焦点陷阱、Esc、焦点归还与 12 语言渲染；
// 这里再对源码做结构断言，防止“测试通过但实现里没有对应代码”的空转。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';
import {
  A11Y_TEXT_KEYS,
  overlayA11yTexts,
  overlayDynamicText,
  overlayLang,
} from '../../extension/src/overlay-texts.js';
import { DYNAMIC_LANGS, DYNAMIC_TEXT } from '../../extension/src/overlay-dynamic-locales.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const browser = findBrowser();

test('真实 Chromium：浮层 a11y（焦点陷阱/Esc/aria-live/12 语言）全部通过', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/overlay-a11y-w5e.html', { timeoutMs: 30000 });
  assert.match(result.title, /^OVERLAY_A11Y_W5E_OK:(\d+)$/, result.title);
  const passed = Number(/^OVERLAY_A11Y_W5E_OK:(\d+)$/.exec(result.title)[1]);
  assert.ok(passed >= 10, '浮层 a11y 夹具断言数量不足：' + passed);
});

test('源码结构：record 用 status+aria-live、Esc 结束、焦点归还、动态播报', () => {
  const source = read('extension/src/record-overlay.js');
  assert.match(source, /setAttribute\('role', 'status'\)/);
  assert.match(source, /setAttribute\('aria-live', 'polite'\)/);
  assert.match(source, /setAttribute\('aria-keyshortcuts', 'Escape'\)/);
  assert.match(source, /event\.key !== 'Escape'/);
  assert.match(source, /finishRecording/);
  assert.match(source, /previousFocus\.focus/);
  assert.match(source, /data-a11y-live/);
  assert.match(source, /A\.start \|\|/);
  assert.match(source, /overlayA11yTexts\(lang\)/);
});

test('源码结构：manual 用 dialog 语义、Esc 取消、帧数 aria-live、焦点归还', () => {
  const source = read('extension/src/manual-overlay.js');
  assert.match(source, /setAttribute\('role', 'dialog'\)/);
  assert.match(source, /setAttribute\('aria-label', T\.label\)/);
  assert.match(source, /setAttribute\('aria-keyshortcuts', 'Escape'\)/);
  assert.match(source, /event\.key !== 'Escape'/);
  assert.match(source, /data-a11y-live/);
  assert.match(source, /previousFocus\.focus/);
});

test('源码结构：help 是模态 dialog（aria-modal/labelledby/describedby）+ 焦点陷阱 + Esc + 外部移除归还焦点', () => {
  const source = read('extension/src/overlay-ui.js');
  const help = source.slice(source.indexOf('export function helpOverlayFunc'));
  assert.match(help, /role="dialog" aria-modal="true" aria-labelledby="__bb_help_title" aria-describedby="__bb_help_msg"/);
  assert.match(help, /aria-controls="__bb_help_body"/);
  assert.match(help, /event\.key === 'Escape'/);
  assert.match(help, /event\.key !== 'Tab'/);
  assert.match(help, /shadow\.activeElement/);
  assert.match(help, /previousFocus\.focus/);
  assert.match(help, /new MutationObserver/);
  assert.match(help, /close\('skip'/);
  assert.match(help, /data-a11y-live/);
});

test('源码结构：takeover 保留 region/status 语义，新增 Esc 收起/展开与 aria-live 播报', () => {
  const source = read('extension/src/overlay-ui.js');
  const takeover = source.slice(source.indexOf('export function installTakeover'));
  assert.match(takeover, /role="region"/);
  assert.match(takeover, /role="status" aria-live="polite"/);
  assert.match(takeover, /aria-keyshortcuts', 'Escape'/);
  assert.match(takeover, /event\.key !== 'Escape'/);
  assert.match(takeover, /const announce =/);
  assert.match(takeover, /a11yText\('paused'/);
  assert.match(takeover, /a11yText\('escHint'/);
  assert.match(takeover, /data-a11y-live/);
  // 非模态面板不做焦点陷阱（会困住键盘用户）：契约里明确不出现 preventDefault 的 Tab 拦截。
  assert.doesNotMatch(takeover, /event\.key !== 'Tab'/);
});

test('源码结构：borrow 模态有 describedby/keyshortcuts、toast 有 Esc 关闭与状态语义', () => {
  const source = read('extension/src/overlay-ui.js');
  const banner = source.slice(source.indexOf('export function borrowBanner'), source.indexOf('export function borrowToast'));
  assert.match(banner, /setAttribute\('role', 'dialog'\)/);
  assert.match(banner, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(banner, /aria-describedby/);
  assert.match(banner, /aria-keyshortcuts', 'Escape'/);
  assert.match(banner, /A\.countdown/);
  const toast = source.slice(source.indexOf('export function borrowToast'));
  assert.match(toast, /setAttribute\('role', 'region'\)/);
  assert.match(toast, /setAttribute\('aria-keyshortcuts', 'Escape'\)/);
  assert.match(toast, /A\.escHint/);
  assert.match(toast, /finish\(false, false\)/);
});

test('统一查表：A11Y_TEXT_KEYS 全部指向真实词条，且 12 语言都有值', () => {
  for (const [surface, fields] of Object.entries(A11Y_TEXT_KEYS)) {
    for (const [field, key] of Object.entries(fields)) {
      assert.ok(DYNAMIC_TEXT[key], surface + '.' + field + ' 指向不存在的词条 ' + key);
      for (const lang of DYNAMIC_LANGS) {
        assert.equal(typeof DYNAMIC_TEXT[key][lang], 'string');
        assert.ok(DYNAMIC_TEXT[key][lang].trim(), key + '/' + lang + ' 为空');
      }
    }
  }
  const zh = overlayA11yTexts('zh');
  assert.equal(zh.record.start, overlayDynamicText('zh', 'overlay.record.start'));
  assert.equal(zh.takeover.paused, DYNAMIC_TEXT['overlay.takeover.paused'].zh);
  assert.equal(overlayLang('iw'), 'he');
});

test('调用点接线：takeover/record/borrow 都从统一入口取 a11y 文案并注入页面', () => {
  const takeover = read('extension/src/takeover.js');
  assert.match(takeover, /import \{[^}]*overlayA11yTexts[^}]*\} from '\.\/overlay-texts\.js'/);
  assert.match(takeover, /overlayA11yTexts\(lang\)/);
  const record = read('extension/src/record-overlay.js');
  assert.match(record, /overlayA11yTexts\(lang\)/);
  const borrow = read('extension/src/borrow-ui.js');
  assert.match(borrow, /overlayA11yTexts\(req\.lang\)/);
  // Help/手动长截图的注入点在 tabs-help.js / quick.js（不在本波写域）：
  // 它们的 a11y 提示用语言包里已有的动作名组合，所以仍是 12 语言。
  const help = read('extension/src/overlay-ui.js');
  assert.match(help, /hintNode\.textContent = 'Esc · ' \+ T\.cancel/);
  const manual = read('extension/src/manual-overlay.js');
  assert.match(manual, /srHint\.textContent = 'Esc · ' \+ T\.cancel/);
});
