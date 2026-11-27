import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tabs = readFileSync(new URL('../../extension/src/tabs.js', import.meta.url), 'utf8');
const tabsBorrow = readFileSync(new URL('../../extension/src/tabs-borrow.js', import.meta.url), 'utf8');
const borrowUi = readFileSync(new URL('../../extension/src/borrow-ui.js', import.meta.url), 'utf8');
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
  assert.match(borrowUi, /OVERLAY_THEME/);
  const takeover = readFileSync(new URL('../../extension/src/takeover.js', import.meta.url), 'utf8');
  assert.match(takeover, /OVERLAY_THEME/);
});

test('截图/原生输入抑制覆盖借用 Toast', () => {
  assert.match(suppress, /__bb_borrow_toast_host/);
  assert.match(suppress, /__bb_control_hint/);
});

test('借用确认在标签切换时重新分配', () => {
  assert.match(borrowUi, /export function rehomeBorrowUi/);
  assert.match(borrowUi, /injectBorrowToast\(req, activeId\)/);
  assert.match(borrowUi, /injectBorrowModal\(req, \{ focus: false \}\)/);
  const bridge = readFileSync(new URL('../../extension/src/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /rehomeBorrowUi\(info\.windowId\)/);
});

test('借用业务主体在 tabs-borrow.js，tabs.js 不重复实现', () => {
  assert.match(tabsBorrow, /export async function tabBorrow/);
  assert.match(tabsBorrow, /export async function tabReturn/);
  assert.match(tabsBorrow, /E_BORROW_CONFLICT/);
  assert.match(tabsBorrow, /injectBorrowModal/);
  assert.doesNotMatch(tabs, /export async function tabBorrow/);
  assert.doesNotMatch(tabs, /export async function tabReturn/);
  assert.doesNotMatch(tabs, /function injectBorrowModal/);
  assert.doesNotMatch(tabs, /export function rehomeBorrowUi/);
  assert.doesNotMatch(tabs, /BORROW_TIMEOUT_MS/);
  const dispatch = readFileSync(new URL('../../extension/src/dispatch.js', import.meta.url), 'utf8');
  assert.match(dispatch, /from '\.\/tabs-borrow\.js'/);
});
