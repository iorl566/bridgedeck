import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tabs = readFileSync(new URL('../../extension/src/tabs.js', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../../extension/src/overlay-ui.js', import.meta.url), 'utf8');
const suppress = readFileSync(new URL('../../extension/src/overlay-suppress.js', import.meta.url), 'utf8');

test('借用 Toast 有关闭入口、进度条和倒计时', () => {
  assert.match(overlay, /data-close/);
  assert.match(overlay, /data-bar/);
  assert.match(overlay, /data-count/);
});

test('借用模态/Toast 都走统一浮层主题 token', () => {
  assert.match(overlay, /data-bb-overlay/);
  assert.match(overlay, /--bb-surface/);
  assert.match(overlay, /data-bb-theme/);
  assert.match(tabs, /OVERLAY_THEME/);
  const takeover = readFileSync(new URL('../../extension/src/takeover.js', import.meta.url), 'utf8');
  assert.match(takeover, /OVERLAY_THEME/);
});

test('截图/原生输入抑制覆盖借用 Toast', () => {
  assert.match(suppress, /__bb_borrow_toast_host/);
  assert.match(suppress, /__bb_control_hint/);
});

test('借用确认在标签切换时重新分配', () => {
  assert.match(tabs, /export function rehomeBorrowUi/);
  assert.match(tabs, /injectBorrowToast\(req, activeId\)/);
  assert.match(tabs, /injectBorrowModal\(req, \{ focus: false \}\)/);
  const bridge = readFileSync(new URL('../../extension/src/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /rehomeBorrowUi\(info.windowId\)/);
});
