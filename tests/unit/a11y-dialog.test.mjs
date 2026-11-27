// tests/unit/a11y-dialog.test.mjs —— 真实 Chromium 对话框可访问性测试 + 运行时接线断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';
import {
  DIALOG_TEXT,
  DIALOG_TEXT_KEYS,
  TABBABLE_SELECTOR,
  dialogText,
  isTabbable,
  tabbable,
} from '../../extension/ui/a11y-dialog.js';
import { normalizeHintLang } from '../../extension/ui/error-hints.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const browser = findBrowser();

test('真实 Chromium：对话框焦点陷阱/Escape/aria-live/键盘路径全部通过', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/a11y-dialog.html', { timeoutMs: 20000 });
  assert.match(result.title, /^A11Y_DIALOG_OK:(\d+)$/, result.title);
  assert.ok(Number(/^A11Y_DIALOG_OK:(\d+)$/.exec(result.title)[1]) >= 10, '对话框 a11y 断言数量不足：' + result.title);
});

test('纯函数在 Node 下可导入（模块顶层不碰 document），且标签可归一化', () => {
  assert.equal(typeof tabbable, 'function');
  assert.equal(typeof isTabbable, 'function');
  assert.ok(TABBABLE_SELECTOR.includes('button'));
  assert.equal(normalizeHintLang('zh-TW'), 'zh-TW');
  assert.equal(dialogText('zh').confirm, DIALOG_TEXT.zh.confirm);
  assert.equal(dialogText('de').cancel, DIALOG_TEXT.de.cancel);
  assert.equal(dialogText('unknown-lang').confirm, DIALOG_TEXT.en.confirm);
  assert.equal(DIALOG_TEXT_KEYS.length, 11);
});

test('运行时接线：弹窗与审计页真实调用 openDialog（破坏性操作不再直接执行）', () => {
  const popup = read('extension/ui/popup.js');
  assert.match(popup, /import \{[^}]*openDialog[^}]*\} from '\.\/a11y-dialog\.js'/);
  assert.match(popup, /deviceRevokeAll[\s\S]{0,400}openDialog\(/);
  assert.match(popup, /const outcome = await dialog\.result/);
  assert.match(popup, /outcome\.confirmed/);

  const audit = read('extension/ui/audit.js');
  assert.match(audit, /import \{[^}]*openDialog[^}]*\} from '\.\/a11y-dialog\.js'/);
  assert.match(audit, /clearAuditTitle/);
  assert.match(audit, /await dialog\.result/);

  // 原生 confirm()/alert() 会阻塞页面且不可定制 a11y，禁止在 UI 代码里使用。
  for (const file of fs.readdirSync(path.join(ROOT, 'extension', 'ui')).filter((name) => name.endsWith('.js'))) {
    if (file === 'i18n.js' || file === 'locales.js') continue;
    const source = read('extension/ui/' + file);
    assert.doesNotMatch(source, /(?<![\w.])window\.confirm\(|(?<![\w.])confirm\(\s*['"`]/, file + ' 使用了原生 confirm()');
  }
});

test('对话框模块自身结构：aria-modal/焦点陷阱/aria-live/Escape 都在实现里（而非只写在测试里）', () => {
  const source = read('extension/ui/a11y-dialog.js');
  assert.match(source, /setAttribute\('role', 'dialog'\)/);
  assert.match(source, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(source, /aria-labelledby/);
  assert.match(source, /aria-describedby/);
  assert.match(source, /aria-live/);
  assert.match(source, /createFocusTrap/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /previous\.focus/);
  assert.match(source, /aria-hidden', 'true'/);
  assert.match(source, /\.inert = true/);
});
